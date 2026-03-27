import { Hono } from 'hono';
import type { Env, Page, Revision } from '../types';
import { requireAuth } from '../middleware/session';
import { normalizeSlug } from '../utils/slug';
import { safeJSON } from '../utils/json';
import { ROLE_CASE_SQL, enrichRoles } from '../utils/role';

const wiki = new Hono<Env>();

/**
 * 최근 변경 캐시를 즉시 새 데이터로 갱신
 * (delete 후 재요청 대기 대신, 직접 put하여 즉시 반영)
 */
async function refreshRecentChangesCache(c: any) {
    const db = c.env.DB;
    const origin = new URL(c.req.url).origin;
    const cacheUrl = `${origin}/api/wiki/recent-changes`;
    const cache = caches.default;

    const { results } = await db.prepare(`
        SELECT p.slug, p.title, p.updated_at, u.name as author_name
        FROM pages p
        LEFT JOIN users u ON p.author_id = u.id
        WHERE p.deleted_at IS NULL AND p.is_private = 0
        ORDER BY p.updated_at DESC LIMIT 10
    `).all();

    const body = JSON.stringify(safeJSON({ changes: results }));
    const response = new Response(body, {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Cache-Control': 'public, max-age=60',
        },
    });
    await cache.put(cacheUrl, response);
}

/**
 * 문서의 캐시를 무효화하는 유틸리티 함수
 */
function invalidatePageCache(c: any, slug: string) {
    const origin = new URL(c.req.url).origin;
    const cache = caches.default;
    const path = encodeURIComponent(slug);

    return Promise.all([
        cache.delete(`${origin}/api/wiki/${path}`),
        cache.delete(`${origin}/api/wiki/${path}?redirect=no`),
        cache.delete(`${origin}/wiki/${path}`)
    ]);
}

/**
 * 문서 content에서 링크를 파싱하여 { target_slug, link_type } 배열을 반환
 */
function extractLinks(content: string): { target_slug: string; link_type: string }[] {
    const links: { target_slug: string; link_type: string }[] = [];
    const seen = new Set<string>();

    // 코드블럭 내부 제외를 위해 코드블럭을 먼저 제거
    const cleaned = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '');

    // 1) [[위키링크]]
    const wikiLinkRegex = /\[\[([^\]]+)\]\]/g;
    for (const m of cleaned.matchAll(wikiLinkRegex)) {
        const slug = m[1].trim();
        const key = `wikilink:${slug}`;
        if (!seen.has(key)) {
            seen.add(key);
            links.push({ target_slug: slug, link_type: 'wikilink' });
        }
    }

    // 2) {{틀 트랜스클루전}}
    const templateRegex = /\{\{([^}]+?)\}\}/g;
    for (const m of cleaned.matchAll(templateRegex)) {
        let slug = m[1].trim();
        if (!slug.startsWith('틀:') && !slug.startsWith('template:') && !slug.startsWith('템플릿:')) {
            slug = '틀:' + slug;
        }
        const key = `template:${slug}`;
        if (!seen.has(key)) {
            seen.add(key);
            links.push({ target_slug: slug, link_type: 'template' });
        }
    }

    // 3) 이미지 참조: images/로 시작하는 R2 키를 파싱
    // 마크다운 ![alt](/media/images/...) 또는 HTML <img src="...images/..."> 등
    const imageRegex = /images\/[a-zA-Z0-9가-힣\-_(). ]+\.\w+/g;
    for (const m of cleaned.matchAll(imageRegex)) {
        const r2Key = m[0].trim();
        const key = `image:${r2Key}`;
        if (!seen.has(key)) {
            seen.add(key);
            links.push({ target_slug: r2Key, link_type: 'image' });
        }
    }

    return links;
}

/**
 * page_links 및 page_categories 테이블을 갱신하는 D1 배치 문 생성
 */
function buildLinkAndCategoryStatements(
    db: D1Database,
    pageId: number,
    content: string,
    category: string | null
): D1PreparedStatement[] {
    const stmts: D1PreparedStatement[] = [];

    // page_links 갱신: 기존 삭제 후 재삽입
    stmts.push(db.prepare('DELETE FROM page_links WHERE source_page_id = ?').bind(pageId));
    const links = extractLinks(content);
    for (const link of links) {
        stmts.push(
            db.prepare('INSERT INTO page_links (source_page_id, target_slug, link_type) VALUES (?, ?, ?)')
                .bind(pageId, link.target_slug, link.link_type)
        );
    }

    // page_categories 갱신: 기존 삭제 후 재삽입
    stmts.push(db.prepare('DELETE FROM page_categories WHERE page_id = ?').bind(pageId));
    if (category) {
        const cats = category.split(',').map(c => c.trim()).filter(c => c);
        for (const cat of cats) {
            stmts.push(
                db.prepare('INSERT OR IGNORE INTO page_categories (page_id, category) VALUES (?, ?)')
                    .bind(pageId, cat)
            );
        }
    }

    return stmts;
}

/**
 * GET /config
 * 동적 설정 (위키 이름 등) 반환
 */
wiki.get('/config', (c) => {
    return c.json({
        wikiName: c.env.WIKI_NAME || 'CloudWiki',
        wikiLogoUrl: c.env.WIKI_LOGO_URL || '',
        wikiFaviconUrl: c.env.WIKI_FAVICON_URL || '',
        selectedIconsOnly: c.env.SELECTED_ICONS_ONLY === 'true',
        turnstileSiteKey: c.env.TURNSTILE_SITE_KEY || '',
    });
});

/**
 * GET /wiki/search-titles
 * 자동완성용 제목 검색 (최대 5개)
 * Query: q (검색어), type (link | template)
 */
wiki.get('/wiki/search-titles', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const db = c.env.DB;
    const q = c.req.query('q') || '';
    const type = c.req.query('type') || 'link';
    const exclude = c.req.query('exclude') || '';
    const user = c.get('user');
    const isAdmin = user && (user.role === 'admin' || user.role === 'super_admin');

    let query = `SELECT title, slug FROM pages WHERE deleted_at IS NULL`;
    const params: any[] = [];

    if (!isAdmin) {
        query += ' AND is_private = 0';
    }

    if (type === 'template') {
        query += " AND slug LIKE '틀:%'";
    } else {
        query += " AND slug NOT LIKE '이미지:%'";
    }

    // 틀 자동완성에서 자기 자신 제외
    if (exclude) {
        query += ' AND slug != ?';
        params.push(exclude);
    }

    if (q.length > 0) {
        query += ' AND title LIKE ?';
        params.push(`%${q}%`);
        query += ' ORDER BY title ASC';
    } else {
        // 빈 쿼리: 최근 수정 순 반환
        query += ' ORDER BY updated_at DESC';
    }

    query += ' LIMIT 5';

    const { results } = await db.prepare(query).bind(...params).all();
    return c.json({ results });
});


/**
 * GET /wiki/recent-changes
 * 위키 전체에서 가장 최근에 수정된 문서 10개
 */
wiki.get('/wiki/recent-changes', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const db = c.env.DB;
    const user = c.get('user');
    const isAdmin = user && (user.role === 'admin' || user.role === 'super_admin');

    // 비관리자(공개 결과)는 Cache API로 24시간 캐싱
    if (!isAdmin) {
        const cache = caches.default;
        const cacheKey = c.req.url;
        const cached = await cache.match(cacheKey);
        if (cached) {
            return new Response(cached.body, cached);
        }

        const { results } = await db.prepare(`
            SELECT p.slug, p.title, p.updated_at, u.name as author_name
            FROM pages p
            LEFT JOIN users u ON p.author_id = u.id
            WHERE p.deleted_at IS NULL AND p.is_private = 0
            ORDER BY p.updated_at DESC LIMIT 10
        `).all();

        const body = JSON.stringify(safeJSON({ changes: results }));
        const response = new Response(body, {
            status: 200,
            headers: {
                'Content-Type': 'application/json; charset=UTF-8',
                'Cache-Control': 'public, max-age=60',
            },
        });
        c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
    }

    // 관리자: 비공개 문서 포함, 캐싱 없음
    const { results } = await db.prepare(`
        SELECT p.slug, p.title, p.updated_at, u.name as author_name
        FROM pages p
        LEFT JOIN users u ON p.author_id = u.id
        WHERE p.deleted_at IS NULL
        ORDER BY p.updated_at DESC LIMIT 10
    `).all();

    return c.json(safeJSON({ changes: results }));
});

/**
 * GET /wiki/admin-categories
 * 관리자 전용 카테고리 목록 (공개 - 편집 페이지에서 사용)
 */
wiki.get('/wiki/admin-categories', async (c) => {
    const db = c.env.DB;
    const { results } = await db
        .prepare('SELECT name FROM admin_categories ORDER BY name ASC')
        .all();
    return c.json({ categories: results.map((r: any) => r.name) });
});

/**
 * GET /wiki/templates
 * 템플릿 목록 (slug가 '템플릿:'으로 시작하는 문서들만)
 */
wiki.get('/wiki/templates', async (c) => {
    const db = c.env.DB;
    const q = c.req.query('q');

    if (q) {
        const { results } = await db
            .prepare("SELECT slug, title FROM pages WHERE slug LIKE '템플릿:%' AND title LIKE ? AND deleted_at IS NULL ORDER BY created_at DESC")
            .bind(`%${q}%`)
            .all();
        return c.json({ templates: results });
    } else {
        const { results } = await db
            .prepare("SELECT slug, title FROM pages WHERE slug LIKE '템플릿:%' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10")
            .all();
        return c.json({ templates: results });
    }
});

/**
 * GET /wiki/random
 * 단일 랜덤 문서 반환 (접근 가능한 문서 중)
 */
wiki.get('/wiki/random', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const db = c.env.DB;
    const user = c.get('user');
    const isAdmin = user && (user.role === 'admin' || user.role === 'super_admin');

    let query = `
        SELECT slug, title
        FROM pages
        WHERE deleted_at IS NULL
    `;
    if (!isAdmin) {
        query += ' AND is_private = 0';
    }
    // 관리자 페이지, 틀, 이미지, 카테고리 등 배제
    query += " AND slug NOT LIKE '이미지:%' AND slug NOT LIKE '틀:%' AND slug NOT LIKE 'template:%' AND slug NOT LIKE '템플릿:%' AND slug NOT LIKE '카테고리:%'";
    
    query += ' ORDER BY RANDOM() LIMIT 1';

    const page = await db.prepare(query).first<{ slug: string, title: string }>();

    if (!page) {
        return c.json({ error: '랜덤 문서를 찾을 수 없습니다.' }, 404);
    }

    return c.json(safeJSON({ slug: page.slug, title: page.title }));
});

/**
 * GET /wiki/:slug
 * 문서 조회 (공개)
 * - 리다이렉트 처리: 문서가 없고 리다이렉트가 존재하면 대상 문서 반환 (redirected_from 포함)
 * - 비공개 문서: 관리자만 접근 가능
 */
wiki.get('/wiki/:slug', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const slug = c.req.param('slug');
    const db = c.env.DB;
    const user = c.get('user');
    const cache = caches.default;
    const cacheKey = c.req.url;
    const nocache = c.req.query('nocache') === 'true';

    // 캐시 확인
    let response = await cache.match(cacheKey);
    if (response && !nocache) {
        // 캐시된 응답은 불변(immutable)이므로, 전역 미들웨어가 헤더를 수정할 수 있도록 복제하여 반환
        return new Response(response.body, response);
    }

    let page = await db
        .prepare('SELECT * FROM pages WHERE slug = ?')
        .bind(slug)
        .first<Page>();

    const isAdmin = user && (user.role === 'admin' || user.role === 'super_admin');

    if (page && page.deleted_at && !isAdmin) {
        page = null;
    }

    let redirectedFrom: string | null = null;
    const redirectParam = c.req.query('redirect');

    // 문서 내 리다이렉트 설정 확인 (soft redirect)
    if (page && page.redirect_to && redirectParam !== 'no') {
        const targetSlug = page.redirect_to;
        let targetPage = await db
            .prepare('SELECT * FROM pages WHERE slug = ?')
            .bind(targetSlug)
            .first<Page>();

        if (targetPage && targetPage.deleted_at && !isAdmin) {
            targetPage = null;
        }

        if (targetPage) {
            page = targetPage;
            redirectedFrom = slug;
        }
        // 만약 대상 문서가 없으면, 원래 문서를 그대로 보여줍니다.
    }

    // 문서가 없으면 리다이렉트 테이블 확인 (alias)
    if (!page) {
        const redirect = await db
            .prepare('SELECT target_page_id FROM redirects WHERE source_slug = ?')
            .bind(slug)
            .first<{ target_page_id: number }>();

        if (redirect) {
            let targetPage = await db
                .prepare('SELECT * FROM pages WHERE id = ?')
                .bind(redirect.target_page_id)
                .first<Page>();

            if (targetPage && targetPage.deleted_at && !isAdmin) {
                targetPage = null;
            }

            if (targetPage) {
                page = targetPage;
                redirectedFrom = slug;
            }
        }
    }

    if (!page) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    // 비공개 문서 접근 제어
    if (page.is_private) {
        if (!isAdmin) {
            return c.json({ error: '이 문서는 비공개 상태입니다.' }, 403);
        }
    }

    // 작성자 정보도 함께 반환
    const author = page.author_id
        ? await db.prepare('SELECT name, picture FROM users WHERE id = ?').bind(page.author_id).first()
        : null;

    const result = safeJSON({ ...page, author, redirected_from: redirectedFrom });

    // 공개 문서인 경우에만 캐시 저장
    if (!page.is_private && !nocache) {
        response = c.json(result, 200, { 'Cache-Control': 'public, max-age=86400' });
        c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
    } else {
        response = c.json(result);
    }

    return response;
});

/**
 * PUT /wiki/:slug
 * 문서 생성 또는 수정 (로그인 필수)
 * Body: { title, content, summary, expected_version? }
 */
wiki.put('/wiki/:slug', requireAuth, async (c) => {
    const slug = c.req.param('slug');
    const user = c.get('user')!;
    const body = await c.req.json<{
        title: string;
        content: string;
        summary?: string;
        category?: string;
        is_locked?: number;
        is_private?: number;
        redirect_to?: string;
        expected_version?: number;
        turnstileToken?: string;
    }>();

    // Turnstile 검증
    if (c.env.TURNSTILE_SECRET_KEY) {
        const token = body.turnstileToken;
        if (!token) {
            return c.json({ error: 'Turnstile 검증이 필요합니다.' }, 403);
        }
        const formData = new FormData();
        formData.append('secret', c.env.TURNSTILE_SECRET_KEY);
        formData.append('response', token);
        formData.append('remoteip', c.req.header('cf-connecting-ip') || '');
        const tsRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            body: formData,
        });
        const tsData = await tsRes.json<{ success: boolean }>();
        if (!tsData.success) {
            return c.json({ error: 'Turnstile 검증에 실패했습니다. 다시 시도해주세요.' }, 403);
        }
    }

    const isAdmin = user.role === 'admin' || user.role === 'super_admin';
    const db = c.env.DB;

    if (body.title) {
        body.title = body.title.trim();
    }

    // 메인 문서는 관리자만 편집 가능
    const mainSlug = normalizeSlug(c.env.WIKI_NAME || 'CloudWiki').toLowerCase();
    if (normalizeSlug(slug).toLowerCase() === mainSlug || normalizeSlug(body.title).toLowerCase() === mainSlug) {
        if (!isAdmin) {
            return c.json({ error: '메인 문서는 관리자만 편집할 수 있습니다.' }, 403);
        }
    }

    // "이미지:" 접두사 문서는 시스템이 자동 생성하므로 사용자 직접 생성/편집 차단
    if (slug.startsWith('이미지:') || body.title.startsWith('이미지:')) {
        return c.json({ error: '"이미지:" 접두사는 이미지 업로드 시 자동으로 생성되는 문서 전용입니다.' }, 403);
    }

    // 관리자 전용 카테고리 검증 (쉼표 구분 지원)
    if (body.category && !isAdmin) {
        const cats = body.category.split(',').map(c => c.trim()).filter(c => c);
        for (const cat of cats) {
            const adminCat = await db
                .prepare('SELECT id FROM admin_categories WHERE name = ?')
                .bind(cat)
                .first();
            if (adminCat) {
                return c.json({ error: `"${cat}" 카테고리는 관리자만 적용할 수 있습니다.` }, 403);
            }
        }
    }

    // 비공개 설정 검증
    if (body.is_private !== undefined && !isAdmin) {
        return c.json({ error: '비공개 설정은 관리자만 변경할 수 있습니다.' }, 403);
    }

    if (!body.title || body.content === undefined) {
        return c.json({ error: 'title과 content는 필수입니다.' }, 400);
    }

    // 보안: 문서 제목 최대 30자 제한
    if (body.title.length > 30) {
        return c.json({ error: '문서 제목은 최대 30자까지 입력할 수 있습니다.' }, 400);
    }

    // 보안: 카테고리 특수문자 금지 (한글, 영문, 숫자, 공백, 쉼표만 허용)
    if (body.category) {
        const categoryPattern = /^[가-힣a-zA-Z0-9\s,]+$/;
        if (!categoryPattern.test(body.category)) {
            return c.json({ error: '카테고리에는 특수문자를 사용할 수 없습니다.' }, 400);
        }
    }

    // 보안: 편집 요약 최대 50자 제한
    if (body.summary && body.summary.length > 50) {
        return c.json({ error: '편집 요약은 최대 50자까지 입력할 수 있습니다.' }, 400);
    }

    // 문서 생성/수정 전, 해당 slug가 리다이렉트 소스로 사용되고 있는지 확인 (생성 시)
    const existing = await db
        .prepare('SELECT id, version, is_locked, is_private, redirect_to, content FROM pages WHERE slug = ? AND deleted_at IS NULL')
        .bind(slug)
        .first<{ id: number; version: number; is_locked: number; is_private: number; redirect_to: string | null; content: string }>();

    if (!existing) {
        // 새 문서 생성 시: 리다이렉트 충돌 확인
        const redirect = await db
            .prepare('SELECT id FROM redirects WHERE source_slug = ?')
            .bind(slug)
            .first();
        if (redirect) {
            return c.json({ error: `"${slug}" 이름은 이미 다른 문서로의 넘겨주기(Redirect)로 사용되고 있어 생성할 수 없습니다.` }, 409);
        }
    }

    let finalIsLocked = 0;
    let finalIsPrivate = 0;

    if (existing) {
        // 기존 문서가 잠겨있을 경우
        if (existing.is_locked === 1 && !isAdmin) {
            return c.json({ error: '이 문서는 관리자만 편집할 수 있습니다.' }, 403);
        }

        // 비공개 문서 편집 권한 체크
        if (existing.is_private === 1 && !isAdmin) {
            return c.json({ error: '비공개 문서는 관리자만 편집할 수 있습니다.' }, 403);
        }

        // 권한에 따른 잠금/비공개 상태 결정
        finalIsLocked = isAdmin ? (body.is_locked ?? existing.is_locked) : existing.is_locked;
        finalIsPrivate = isAdmin ? (body.is_private ?? existing.is_private) : existing.is_private;

        // ── 기존 문서 수정 ──
        // Optimistic Locking 체크
        if (body.expected_version !== undefined && body.expected_version !== existing.version) {
            // 내용이 완전히 동일하면 충돌로 보지 않고 진행 (Idempotent)
            if (body.content !== existing.content) {
                return c.json(
                    {
                        error: '편집 충돌이 발생했습니다. 다른 사용자가 문서를 수정했습니다.',
                        current_version: existing.version,
                        content: existing.content
                    },
                    409
                );
            }
        }

        const newVersion = existing.version + 1;

        // 리비전 생성
        const revResult = await db
            .prepare(
                'INSERT INTO revisions (page_id, content, summary, author_id) VALUES (?, ?, ?, ?)'
            )
            .bind(existing.id, body.content, body.summary ?? null, user.id)
            .run();

        const revisionId = revResult.meta.last_row_id;

        // 페이지 업데이트
        await db
            .prepare(
                `UPDATE pages
         SET title = ?, content = ?, category = ?, is_locked = ?, is_private = ?, redirect_to = ?, author_id = ?, last_revision_id = ?,
             version = ?, updated_at = unixepoch()
         WHERE id = ?`
            )
            .bind(body.title, body.content, body.category || null, finalIsLocked, finalIsPrivate, body.redirect_to || null, user.id, revisionId, newVersion, existing.id)
            .run();

        // page_links, page_categories 갱신 (비동기)
        const linkCatStmts = buildLinkAndCategoryStatements(db, existing.id, body.content, body.category || null);
        c.executionCtx.waitUntil(db.batch(linkCatStmts).catch(e => console.error('Failed to update links/categories:', e)));

        // 주시자에게 알림 발송 (비동기)
        c.executionCtx.waitUntil(
            db.prepare('SELECT user_id FROM page_watches WHERE page_id = ? AND user_id != ?')
                .bind(existing.id, user.id).all()
                .then(({ results: watchers }) => {
                    if (watchers.length === 0) return;
                    const stmts = watchers.map((w: any) =>
                        db.prepare('INSERT INTO notifications (user_id, type, content, link) VALUES (?, ?, ?, ?)')
                            .bind(w.user_id, 'page_watch', `${user.name}님이 "${body.title}" 문서를 편집했습니다.`, `/wiki/${slug}`)
                    );
                    return db.batch(stmts);
                })
                .catch(e => console.error('Failed to notify watchers:', e))
        );

        // 캐시 무효화 (API + SSR) + 최근 변경 즉시 갱신
        c.executionCtx.waitUntil(Promise.all([
            invalidatePageCache(c, slug),
            refreshRecentChangesCache(c),
        ]));

        return c.json(safeJSON({ slug, version: newVersion, revision_id: revisionId }));
    } else {
        finalIsLocked = isAdmin ? (body.is_locked ?? 0) : 0;
        finalIsPrivate = isAdmin ? (body.is_private ?? 0) : 0;

        // ── 새 문서 생성 ──
        const pageResult = await db
            .prepare(
                'INSERT INTO pages (slug, title, content, category, is_locked, is_private, redirect_to, author_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            )
            .bind(slug, body.title, body.content, body.category || null, finalIsLocked, finalIsPrivate, body.redirect_to || null, user.id)
            .run();

        const pageId = pageResult.meta.last_row_id;

        // 첫 리비전 생성
        const revResult = await db
            .prepare(
                'INSERT INTO revisions (page_id, content, summary, author_id) VALUES (?, ?, ?, ?)'
            )
            .bind(pageId, body.content, body.summary ?? '문서 생성', user.id)
            .run();

        const revisionId = revResult.meta.last_row_id;

        // last_revision_id 업데이트
        await db
            .prepare('UPDATE pages SET last_revision_id = ? WHERE id = ?')
            .bind(revisionId, pageId)
            .run();

        // page_links, page_categories 갱신 (비동기)
        const linkCatStmts = buildLinkAndCategoryStatements(db, pageId, body.content, body.category || null);
        c.executionCtx.waitUntil(db.batch(linkCatStmts).catch(e => console.error('Failed to update links/categories:', e)));

        // 캐시 무효화 (API + SSR) + 최근 변경 즉시 갱신
        c.executionCtx.waitUntil(Promise.all([
            invalidatePageCache(c, slug),
            refreshRecentChangesCache(c),
        ]));

        return c.json(safeJSON({ slug, version: 1, revision_id: revisionId }), 201);
    }
});

/**
 * GET /wiki/category/:category
 * 카테고리별 문서 목록 (page_categories 테이블 기반)
 */
wiki.get('/wiki/category/:category', async (c) => {
    const category = c.req.param('category');
    const db = c.env.DB;
    const user = c.get('user');
    const isAdmin = user && (user.role === 'admin' || user.role === 'super_admin');

    let query = `
        SELECT p.slug, p.title, p.is_locked, p.updated_at
        FROM page_categories pc
        JOIN pages p ON pc.page_id = p.id
        WHERE p.deleted_at IS NULL
          AND pc.category = ?
    `;
    if (!isAdmin) {
        query += ' AND p.is_private = 0';
    }
    query += ' ORDER BY p.updated_at DESC';

    const { results } = await db
        .prepare(query)
        .bind(category)
        .all();

    return c.json(safeJSON({ pages: results }));
});

/**
 * GET /wiki/:slug/revisions
 * 리비전 목록
 */
wiki.get('/wiki/:slug/revisions', async (c) => {
    const slug = c.req.param('slug');
    const offset = parseInt(c.req.query('offset') || '0', 10);
    const limit = 10;
    const db = c.env.DB;
    const user = c.get('user');
    const isAdmin = user && (user.role === 'admin' || user.role === 'super_admin');

    const page = await db
        .prepare('SELECT id, is_private, deleted_at FROM pages WHERE slug = ?')
        .bind(slug)
        .first<{ id: number; is_private: number; deleted_at: number | null }>();

    if (!page || (page.deleted_at && !isAdmin)) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }
    
    if (page.is_private && !isAdmin) {
        return c.json({ error: '비공개 문서입니다.' }, 403);
    }

    const revisions = await db
        .prepare(
            `SELECT r.id, r.summary, r.created_at, u.id as author_id, u.name as author_name, u.picture as author_picture,
                    ${ROLE_CASE_SQL} as author_role,
                    u.email as _author_email
       FROM revisions r
       LEFT JOIN users u ON r.author_id = u.id
       WHERE r.page_id = ?
       ORDER BY r.created_at DESC
       LIMIT ? OFFSET ?`
        )
        .bind(page.id, limit + 1, offset)
        .all();

    let has_more = false;
    if (revisions.results.length > limit) {
        has_more = true;
        revisions.results.pop();
    }

    enrichRoles(revisions.results, 'author_role', '_author_email', c.env);

    return c.json(safeJSON({ revisions: revisions.results, has_more }));
});

/**
 * GET /wiki/:slug/revisions/:id
 * 특정 리비전 내용
 */
wiki.get('/wiki/:slug/revisions/:id', async (c) => {
    const revId = parseInt(c.req.param('id'));
    const slug = c.req.param('slug');
    const db = c.env.DB;
    const user = c.get('user');
    const isAdmin = user && (user.role === 'admin' || user.role === 'super_admin');

    const page = await db
        .prepare('SELECT id, is_private, deleted_at FROM pages WHERE slug = ?')
        .bind(slug)
        .first<{ id: number; is_private: number; deleted_at: number | null }>();

    if (!page || (page.deleted_at && !isAdmin)) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    if (page.is_private && !isAdmin) {
        return c.json({ error: '비공개 문서입니다.' }, 403);
    }

    const revision = await db
        .prepare(
            `SELECT r.*, u.name as author_name
       FROM revisions r
       LEFT JOIN users u ON r.author_id = u.id
       WHERE r.id = ? AND r.page_id = ?`
        )
        .bind(revId, page.id)
        .first();

    if (!revision) {
        return c.json({ error: '리비전을 찾을 수 없습니다.' }, 404);
    }

    return c.json(safeJSON(revision));
});

/**
 * GET /wiki/:slug/revisions/:id/diff
 * 특정 리비전과 이전 리비전의 내용을 비교용으로 반환
 */
wiki.get('/wiki/:slug/revisions/:id/diff', async (c) => {
    const revId = parseInt(c.req.param('id'));
    const slug = c.req.param('slug');
    const db = c.env.DB;
    const user = c.get('user');
    const isAdmin = user && (user.role === 'admin' || user.role === 'super_admin');

    const page = await db
        .prepare('SELECT id, is_private, deleted_at FROM pages WHERE slug = ?')
        .bind(slug)
        .first<{ id: number; is_private: number; deleted_at: number | null }>();

    if (!page || (page.deleted_at && !isAdmin)) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    if (page.is_private && !isAdmin) {
        return c.json({ error: '비공개 문서입니다.' }, 403);
    }

    // 해당 리비전 조회
    const revision = await db
        .prepare(
            `SELECT id, content, page_id, created_at
       FROM revisions
       WHERE id = ? AND page_id = ?`
        )
        .bind(revId, page.id)
        .first<{ id: number; content: string; page_id: number; created_at: number }>();

    if (!revision) {
        return c.json({ error: '리비전을 찾을 수 없습니다.' }, 404);
    }

    // 바로 이전 리비전 조회 (같은 page_id, created_at이 더 이전인 것 중 가장 최신)
    const prevRevision = await db
        .prepare(
            `SELECT id, content FROM revisions
       WHERE page_id = ? AND id < ?
       ORDER BY id DESC LIMIT 1`
        )
        .bind(revision.page_id, revId)
        .first<{ id: number; content: string }>();

    return c.json(safeJSON({
        old_content: prevRevision?.content ?? '',
        new_content: revision.content,
        old_revision_id: prevRevision?.id ?? null,
        new_revision_id: revision.id
    }));
});

/**
 * GET /wiki/:slug/subdocs
 * 하위 문서 목록 (제목이 '{slug}/'로 시작하는 문서들)
 */
wiki.get('/wiki/:slug/subdocs', async (c) => {
    const slug = c.req.param('slug');
    const db = c.env.DB;
    const user = c.get('user');
    const isAdmin = user && (user.role === 'admin' || user.role === 'super_admin');

    let query = `
        SELECT slug, title, updated_at
        FROM pages
        WHERE deleted_at IS NULL
          AND slug LIKE ?
    `;
    if (!isAdmin) {
        query += ' AND is_private = 0';
    }
    query += ' ORDER BY slug ASC LIMIT 200';

    const { results } = await db
        .prepare(query)
        .bind(slug + '/%')
        .all();

    return c.json(safeJSON({ subdocs: results }));
});

/**
 * GET /wiki/:slug/backlinks
 * 이 문서를 참조하는 문서 목록 (page_links 테이블 기반)
 * - 문서 링크: [[slug]] → link_type = 'wikilink'
 * - 틀 트랜스클루전: {{slug}} → link_type = 'template'
 */
wiki.get('/wiki/:slug/backlinks', async (c) => {
    const slug = c.req.param('slug');
    const db = c.env.DB;
    const user = c.get('user');
    const isAdmin = user && (user.role === 'admin' || user.role === 'super_admin');

    // page_links 테이블에서 target_slug로 검색
    const targetSlugs: string[] = [slug];

    // 틀 접두사인 경우 접두사 없는 이름으로도 검색
    const templatePrefixes = ['틀:', 'template:', '템플릿:'];
    for (const prefix of templatePrefixes) {
        if (slug.startsWith(prefix)) {
            const templateName = slug.substring(prefix.length);
            targetSlugs.push(templateName);
            break;
        }
    }

    const placeholders = targetSlugs.map(() => '?').join(', ');
    let query = `
        SELECT DISTINCT p.slug, p.title, p.updated_at, p.is_locked
        FROM page_links pl
        JOIN pages p ON pl.source_page_id = p.id
        WHERE p.deleted_at IS NULL
          AND p.slug != ?
          AND pl.target_slug IN (${placeholders})
    `;
    if (!isAdmin) {
        query += ' AND p.is_private = 0';
    }
    query += ' ORDER BY p.updated_at DESC LIMIT 100';

    const backlinks = await db
        .prepare(query)
        .bind(slug, ...targetSlugs)
        .all();

    return c.json(safeJSON({ backlinks: backlinks.results }));
});

/**
 * DELETE /wiki/:slug
 * 문서 삭제 (로그인 필수)
 * - 관리자: ?hard=true 시 영구 삭제 (문서, 리비전, 리다이렉트)
 * - 일반: Soft Delete
 * - 이미지: 접두사 문서의 경우 R2 파일 및 media 레코드도 함께 삭제
 */
wiki.delete('/wiki/:slug', requireAuth, async (c) => {
    const slug = c.req.param('slug');
    const user = c.get('user')!;
    const db = c.env.DB;
    const hard = c.req.query('hard') === 'true';

    const isAdmin = user.role === 'admin' || user.role === 'super_admin';

    // Fetch page first to check permissions
    const page = await db.prepare('SELECT id, is_locked, is_private FROM pages WHERE slug = ? AND deleted_at IS NULL')
        .bind(slug).first<{ id: number; is_locked: number; is_private: number }>();

    if (!page) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    if (hard) {
        if (user.role !== 'super_admin') {
            return c.json({ error: '영구 삭제는 최고 관리자만 가능합니다.' }, 403);
        }

        // 이미지: 접두사 문서인 경우, R2 파일과 media 레코드도 함께 삭제
        if (slug.startsWith('이미지:')) {
            const pageContent = await db.prepare('SELECT content FROM pages WHERE id = ?')
                .bind(page.id).first<{ content: string }>();
            if (pageContent?.content) {
                // R2 키 추출: content에서 images/yyyy/mm/uuid.ext 패턴 검색
                const r2KeyMatch = pageContent.content.match(/images\/\d{4}\/\d{2}\/[a-f0-9-]+\.\w+/);
                if (r2KeyMatch) {
                    const r2Key = r2KeyMatch[0];
                    // R2 파일 삭제
                    await c.env.MEDIA.delete(r2Key);
                    // media 테이블 레코드 삭제
                    await db.prepare('DELETE FROM media WHERE r2_key = ?').bind(r2Key).run();
                }
            }
        }

        // Hard Delete Transaction
        const batch = [
            db.prepare('DELETE FROM page_links WHERE source_page_id = ?').bind(page.id),
            db.prepare('DELETE FROM page_categories WHERE page_id = ?').bind(page.id),
            db.prepare('DELETE FROM revisions WHERE page_id = ?').bind(page.id),
            db.prepare('DELETE FROM redirects WHERE target_page_id = ?').bind(page.id),
            db.prepare('DELETE FROM pages WHERE id = ?').bind(page.id)
        ];
        await db.batch(batch);

        // 캐시 무효화 (API + SSR) + 최근 변경 즉시 갱신
        c.executionCtx.waitUntil(Promise.all([
            invalidatePageCache(c, slug),
            refreshRecentChangesCache(c),
        ]));

        // 관리자 로그 기록
        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind('hard_delete', `문서 영구 삭제: ${slug}`, user.id)
                .run().catch((e: any) => console.error('Failed to write admin log:', e))
        );

        return c.json({ message: '문서가 영구 삭제되었습니다.' });
    } else {
        // Check permissions for soft delete
        if ((page.is_locked === 1 || page.is_private === 1) && !isAdmin) {
            return c.json({ error: '권한이 없습니다.' }, 403);
        }

        // 이미지: 접두사 문서의 soft delete 시에도 R2 파일과 media 레코드 삭제
        if (slug.startsWith('이미지:')) {
            const pageContent = await db.prepare('SELECT content FROM pages WHERE id = ?')
                .bind(page.id).first<{ content: string }>();
            if (pageContent?.content) {
                const r2KeyMatch = pageContent.content.match(/images\/\d{4}\/\d{2}\/[a-f0-9-]+\.\w+/);
                if (r2KeyMatch) {
                    const r2Key = r2KeyMatch[0];
                    await c.env.MEDIA.delete(r2Key);
                    await db.prepare('DELETE FROM media WHERE r2_key = ?').bind(r2Key).run();
                }
            }
        }

        // Soft Delete
        await db.prepare('UPDATE pages SET deleted_at = unixepoch() WHERE id = ?')
            .bind(page.id)
            .run();

        // 캐시 무효화 (API + SSR) + 최근 변경 즉시 갱신
        c.executionCtx.waitUntil(Promise.all([
            invalidatePageCache(c, slug),
            refreshRecentChangesCache(c),
        ]));

        // 관리자 로그 기록
        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind('soft_delete', `문서 삭제: ${slug}`, user.id)
                .run().catch((e: any) => console.error('Failed to write admin log:', e))
        );

        return c.json({ message: '문서가 삭제되었습니다.' });
    }
});

/**
 * POST /wiki/:slug/restore
 * 문서 복원 (관리자 전용)
 * - Soft Delete된 문서를 복구
 */
wiki.post('/wiki/:slug/restore', requireAuth, async (c) => {
    const slug = c.req.param('slug');
    const user = c.get('user')!;
    const db = c.env.DB;

    const isAdmin = user.role === 'admin' || user.role === 'super_admin';
    if (!isAdmin) {
        return c.json({ error: '권한이 없습니다.' }, 403);
    }

    const page = await db.prepare('SELECT id, deleted_at FROM pages WHERE slug = ?').bind(slug).first<{ id: number; deleted_at: number | null }>();

    if (!page) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    if (!page.deleted_at) {
        return c.json({ error: '문서가 삭제된 상태가 아닙니다.' }, 400);
    }

    // 복원 (deleted_at 해제)
    await db.prepare('UPDATE pages SET deleted_at = NULL WHERE id = ?').bind(page.id).run();

    // 관리자 로그 기록
    c.executionCtx.waitUntil(
        db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
            .bind('restore', `문서 복원: ${slug}`, user.id)
            .run().catch((e: any) => console.error('Failed to write admin log:', e))
    );

    // 캐시 무효화 (API + SSR) + 최근 변경 즉시 갱신
    c.executionCtx.waitUntil(Promise.all([
        invalidatePageCache(c, slug),
        refreshRecentChangesCache(c),
    ]));

    return c.json({ message: '문서가 복원되었습니다.' });
});

/**
 * POST /wiki/:slug/move
 * 문서 이동 (이름 변경)
 * - 기존 문서 이름(slug)을 새로운 이름으로 변경
 * - 기존 문서에 리디렉션을 생성하지 않음
 * - Backlinks FROM this page are updated to reflect the new source slug
 */
wiki.post('/wiki/:slug/move', requireAuth, async (c) => {
    const currentSlug = c.req.param('slug');
    const { new_slug } = await c.req.json<{ new_slug: string }>();
    const user = c.get('user')!;
    const db = c.env.DB;

    if (!new_slug || new_slug.trim().length === 0) {
        return c.json({ error: '새 문서 이름을 입력해주세요.' }, 400);
    }

    // new_slug validation logic same as create (e.g. valid chars) - skip for brevity or assume client sends valid slug
    // Check if target exists
    const targetExists = await db.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL').bind(new_slug).first();
    if (targetExists) {
        return c.json({ error: '이미 존재하는 문서 이름입니다.' }, 409);
    }

    // Check if target is a redirect source
    const redirectExists = await db.prepare('SELECT id FROM redirects WHERE source_slug = ?').bind(new_slug).first();
    if (redirectExists) {
        return c.json({ error: '해당 이름은 다른 문서로의 넘겨주기(Redirect)로 사용되고 있어 이동할 수 없습니다.' }, 409);
    }

    const page = await db.prepare('SELECT id, title, is_locked, is_private FROM pages WHERE slug = ? AND deleted_at IS NULL').bind(currentSlug).first<{ id: number, title: string, is_locked: number, is_private: number }>();
    if (!page) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    const isAdmin = user.role === 'admin' || user.role === 'super_admin';
    if ((page.is_locked === 1 || page.is_private === 1) && !isAdmin) {
        return c.json({ error: '이동 권한이 없습니다.' }, 403);
    }

    // Update Page Slug and Title
    await db.prepare('UPDATE pages SET slug = ?, title = ? WHERE id = ?')
        .bind(new_slug, new_slug, page.id)
        .run();

    // 관리자 로그 기록
    c.executionCtx.waitUntil(
        db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
            .bind('doc_move', `문서 이름변경: ${currentSlug} → ${new_slug}`, user.id)
            .run().catch((e: any) => console.error('Failed to write admin log:', e))
    );

    // 캐시 무효화 (API + SSR) + 최근 변경 즉시 갱신
    c.executionCtx.waitUntil(Promise.all([
        invalidatePageCache(c, currentSlug),
        invalidatePageCache(c, new_slug),
        refreshRecentChangesCache(c),
    ]));

    return c.json({ message: '문서가 이동되었습니다.', new_slug });
});

/**
 * POST /wiki/:slug/revert
 * 문서 되돌리기
 */
wiki.post('/wiki/:slug/revert', requireAuth, async (c) => {
    const slug = c.req.param('slug');
    const { revision_id } = await c.req.json<{ revision_id: number }>();
    const user = c.get('user')!;
    const db = c.env.DB;

    const page = await db.prepare('SELECT id, version, is_locked FROM pages WHERE slug = ? AND deleted_at IS NULL')
        .bind(slug).first<{ id: number, version: number, is_locked: number }>();

    if (!page) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    if (page.is_locked === 1 && user.role !== 'admin' && user.role !== 'super_admin') {
        return c.json({ error: '잠긴 문서는 관리자만 되돌릴 수 있습니다.' }, 403);
    }

    const targetRevision = await db.prepare('SELECT content FROM revisions WHERE id = ? AND page_id = ?')
        .bind(revision_id, page.id).first<{ content: string }>();

    if (!targetRevision) {
        return c.json({ error: '해당 리비전을 찾을 수 없습니다.' }, 404);
    }

    // Create new revision with old content
    const newVersion = page.version + 1;
    const summary = `리비전 #${revision_id}로 되돌리기`;

    const revResult = await db.prepare('INSERT INTO revisions (page_id, content, summary, author_id) VALUES (?, ?, ?, ?)')
        .bind(page.id, targetRevision.content, summary, user.id)
        .run();

    const newRevId = revResult.meta.last_row_id;

    await db.prepare('UPDATE pages SET content = ?, last_revision_id = ?, version = ?, updated_at = unixepoch() WHERE id = ?')
        .bind(targetRevision.content, newRevId, newVersion, page.id)
        .run();

    // 캐시 무효화 (API + SSR) + 최근 변경 즉시 갱신
    c.executionCtx.waitUntil(Promise.all([
        invalidatePageCache(c, slug),
        refreshRecentChangesCache(c),
    ]));

    return c.json({ message: '문서가 되돌려졌습니다.', version: newVersion });
});

/**
 * GET /wiki/:slug/redirects
 * 해당 문서로 연결된 넘겨주기 목록
 */
wiki.get('/wiki/:slug/redirects', async (c) => {
    const slug = c.req.param('slug');
    const db = c.env.DB;

    const page = await db.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL').bind(slug).first<{ id: number }>();
    if (!page) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    const { results } = await db.prepare('SELECT source_slug, created_at FROM redirects WHERE target_page_id = ? ORDER BY source_slug ASC')
        .bind(page.id)
        .all();

    return c.json({ redirects: results });
});

/**
 * POST /wiki/:slug/redirects
 * 넘겨주기 추가
 */
wiki.post('/wiki/:slug/redirects', requireAuth, async (c) => {
    const slug = c.req.param('slug');
    const { source_slug } = await c.req.json<{ source_slug: string }>();
    const db = c.env.DB;

    if (!source_slug || source_slug.trim().length === 0) {
        return c.json({ error: '넘겨줄 이름을 입력해주세요.' }, 400);
    }

    const page = await db.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL').bind(slug).first<{ id: number }>();
    if (!page) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    // Check conflict: source_slug cannot be an existing page
    const pageConflict = await db.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL').bind(source_slug).first();
    if (pageConflict) {
        return c.json({ error: '이미 존재하는 문서 이름입니다.' }, 409);
    }

    // Check conflict: source_slug cannot be an existing redirect
    try {
        await db.prepare('INSERT INTO redirects (source_slug, target_page_id) VALUES (?, ?)')
            .bind(source_slug, page.id)
            .run();
    } catch (e: any) {
        if (e.message?.includes('UNIQUE')) {
            return c.json({ error: '이미 존재하는 넘겨주기 이름입니다.' }, 409);
        }
        throw e;
    }

    return c.json({ success: true });
});

/**
 * DELETE /wiki/:slug/redirects
 * 넘겨주기 삭제
 */
wiki.delete('/wiki/:slug/redirects', requireAuth, async (c) => {
    const slug = c.req.param('slug'); // The target page slug (context)
    const source_slug = c.req.query('source');
    const db = c.env.DB;

    if (!source_slug) {
        return c.json({ error: '삭제할 넘겨주기 이름을 지정해주세요.' }, 400);
    }

    // Verify ownership? Or just delete by source_slug?
    // Usually anyone can edit redirects, or match permissions.
    // I'll allow it if logged in.

    const result = await db.prepare('DELETE FROM redirects WHERE source_slug = ?')
        .bind(source_slug)
        .run();

    if (result.meta.changes === 0) {
        return c.json({ error: '넘겨주기를 찾을 수 없습니다.' }, 404);
    }

    return c.json({ success: true });
});


/**
 * GET /wiki/:slug/watch
 * 현재 유저의 주시 상태 조회
 */
wiki.get('/wiki/:slug/watch', requireAuth, async (c) => {
    const slug = c.req.param('slug');
    const user = c.get('user')!;
    const db = c.env.DB;

    const page = await db.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL')
        .bind(slug).first<{ id: number }>();
    if (!page) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    const watch = await db.prepare('SELECT 1 FROM page_watches WHERE user_id = ? AND page_id = ?')
        .bind(user.id, page.id).first();

    return c.json({ watching: !!watch });
});

/**
 * POST /wiki/:slug/watch
 * 문서 주시 토글 (로그인 필수)
 */
wiki.post('/wiki/:slug/watch', requireAuth, async (c) => {
    const slug = c.req.param('slug');
    const user = c.get('user')!;
    const db = c.env.DB;

    const page = await db.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL')
        .bind(slug).first<{ id: number }>();
    if (!page) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    const existing = await db.prepare('SELECT 1 FROM page_watches WHERE user_id = ? AND page_id = ?')
        .bind(user.id, page.id).first();

    if (existing) {
        await db.prepare('DELETE FROM page_watches WHERE user_id = ? AND page_id = ?')
            .bind(user.id, page.id).run();
        return c.json({ watching: false });
    } else {
        await db.prepare('INSERT INTO page_watches (user_id, page_id) VALUES (?, ?)')
            .bind(user.id, page.id).run();
        return c.json({ watching: true });
    }
});

/**
 * POST /wiki/:slug/editing
 * 편집 하트비트 전송 (로그인 필수)
 * - KV에 편집 중 상태를 기록 (TTL 60초)
 */
wiki.post('/wiki/:slug/editing', requireAuth, async (c) => {
    const slug = c.req.param('slug');
    const user = c.get('user')!;
    const kv = c.env.KV;

    const key = `editing:${slug}:${user.id}`;
    const value = JSON.stringify({ name: user.name, picture: user.picture || '' });

    await kv.put(key, value, { expirationTtl: 60 });

    return c.json({ ok: true });
});

/**
 * GET /wiki/:slug/editors
 * 현재 편집 중인 사용자 목록 (로그인 필수)
 * - 자기 자신은 제외
 */
wiki.get('/wiki/:slug/editors', requireAuth, async (c) => {
    const slug = c.req.param('slug');
    const user = c.get('user')!;
    const kv = c.env.KV;

    const prefix = `editing:${slug}:`;
    const list = await kv.list({ prefix });

    const editors: { name: string; picture: string }[] = [];

    for (const key of list.keys) {
        // 자기 자신 제외
        const userId = key.name.replace(prefix, '');
        if (userId === String(user.id)) continue;

        const value = await kv.get(key.name);
        if (value) {
            try {
                editors.push(JSON.parse(value));
            } catch { }
        }
    }

    return c.json({ editors });
});


export default wiki;
