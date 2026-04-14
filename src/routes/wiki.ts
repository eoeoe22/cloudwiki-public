import { Hono } from 'hono';
import type { Env, Page, Revision } from '../types';
import { requireAuth, requirePermission } from '../middleware/session';
import { normalizeSlug, isR2OnlyNamespace } from '../utils/slug';
import { safeJSON } from '../utils/json';
import { ROLE_CASE_SQL, enrichRoles, RBAC } from '../utils/role';

const wiki = new Hono<Env>();

/**
 * 최근 변경 캐시를 즉시 새 데이터로 갱신
 * (delete 후 재요청 대기 대신, 직접 put하여 즉시 반영)
 */
async function refreshRecentChangesCache(c: any) {
    const db = c.env.DB;
    const origin = new URL(c.req.url).origin;
    const cacheUrl = `${origin}/api/w/recent-changes`;
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
        cache.delete(`${origin}/api/w/${path}`),
        cache.delete(`${origin}/api/w/${path}?redirect=no`),
        cache.delete(`${origin}/w/${path}`)
    ]);
}

/**
 * 콜론이 포함된 문서(틀, 익스텐션 등)가 변경될 때
 * 해당 문서를 참조하는 모든 문서의 캐시를 무효화
 */
async function invalidateBacklinkCaches(c: any, slug: string, db: D1Database): Promise<void> {
    if (!slug.includes(':')) return;

    const targetSlugs: string[] = [slug];
    const templatePrefixes = ['틀:', 'template:', '템플릿:'];
    const matchedPrefix = templatePrefixes.find(p => slug.startsWith(p));
    if (matchedPrefix) {
        // extractLinks()는 {{Foo}}를 항상 '틀:Foo'로 저장하므로,
        // template:Foo / 템플릿:Foo 문서 편집 시에도 '틀:Foo' 변형을 포함해야 함 (반대도 동일)
        const baseName = slug.substring(matchedPrefix.length);
        for (const prefix of templatePrefixes) {
            const variant = prefix + baseName;
            if (!targetSlugs.includes(variant)) targetSlugs.push(variant);
        }
        // 접두사 없는 이름({{Foo}} 방식으로 저장된 경우)도 포함
        if (!targetSlugs.includes(baseName)) targetSlugs.push(baseName);
    }

    const placeholders = targetSlugs.map(() => '?').join(', ');
    const { results } = await db
        .prepare(`
            SELECT DISTINCT p.slug
            FROM page_links pl
            JOIN pages p ON pl.source_page_id = p.id
            WHERE p.deleted_at IS NULL
              AND pl.target_slug IN (${placeholders})
        `)
        .bind(...targetSlugs)
        .all<{ slug: string }>();

    if (results.length === 0) return;
    await Promise.allSettled(results.map((row: { slug: string }) => invalidatePageCache(c, row.slug)));
}

/**
 * 문서 content에서 링크를 파싱하여 { target_slug, link_type } 배열을 반환
 */
function extractLinks(content: string): { target_slug: string; link_type: string }[] {
    const links: { target_slug: string; link_type: string }[] = [];
    const seen = new Set<string>();

    // 코드블럭 내부 제외를 위해 코드블럭을 먼저 제거
    const cleaned = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '');

    // 1) [[위키링크]] / [[위키링크|표시명]] / [[위키링크#섹션]]
    const wikiLinkRegex = /\[\[([^\]]+)\]\]/g;
    for (const m of cleaned.matchAll(wikiLinkRegex)) {
        const raw = m[1].trim();
        // '|' 앞부분만 slug로 사용 (표시명 무시)
        // '#' 앞부분만 slug로 사용 (섹션 앵커 무시) — page_links는 문서간 참조 그래프이므로
        // 페이지 내부 섹션 정보를 인덱스에 저장하지 않음
        const slug = raw.split('|')[0].split('#')[0].trim();
        if (!slug) continue; // '[[#로컬앵커]]'처럼 대상 문서가 없는 링크는 제외
        const key = `wikilink:${slug}`;
        if (!seen.has(key)) {
            seen.add(key);
            links.push({ target_slug: slug, link_type: 'wikilink' });
        }
    }

    // 2) {{틀 트랜스클루전}} 또는 {{익스텐션:문서}}
    const templateRegex = /\{\{([^}]+?)\}\}/g;
    for (const m of cleaned.matchAll(templateRegex)) {
        let slug = m[1].trim();
        // '#' 앞부분만 slug로 사용 — wikilink와 동일한 정규화 정책.
        // 슬러그 자체는 '#'을 포함할 수 없으므로(이동 API 입력검증 참고) 항상 안전하게 제거.
        slug = slug.split('#')[0].trim();
        if (!slug) continue;
        // 익스텐션 패턴: 첫 번째 ':' 앞이 익스텐션 이름 (틀/template/템플릿 접두사가 아닌 경우)
        const colonIdx = slug.indexOf(':');
        if (colonIdx > 0 && !slug.startsWith('틀:') && !slug.startsWith('template:') && !slug.startsWith('템플릿:')) {
            // 익스텐션 링크 (예: freq:AirPods_Pro_2)
            const key = `extension:${slug}`;
            if (!seen.has(key)) {
                seen.add(key);
                links.push({ target_slug: slug, link_type: 'extension' });
            }
        } else {
            if (!slug.startsWith('틀:') && !slug.startsWith('template:') && !slug.startsWith('템플릿:')) {
                slug = '틀:' + slug;
            }
            const key = `template:${slug}`;
            if (!seen.has(key)) {
                seen.add(key);
                links.push({ target_slug: slug, link_type: 'template' });
            }
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

import { uploadRevisionToR2, getRevisionContent } from '../utils/r2';
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
        enableConcurrentEditDetection: c.env.ENABLE_CONCURRENT_EDIT_DETECTION !== 'false',
        turnstileSiteKey: c.env.TURNSTILE_SITE_KEY || '',
        enabledExtensions: (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean),
    });
});

/**
 * GET /w/search-titles
 * 자동완성용 제목 검색 (최대 5개)
 * Query: q (검색어), type (link | template)
 */
wiki.get('/w/search-titles', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const db = c.env.DB;
    const q = c.req.query('q') || '';
    const type = c.req.query('type') || 'link';
    const exclude = c.req.query('exclude') || '';
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = user && rbac.can(user.role, 'admin:access');

    let query = `SELECT title, slug FROM pages WHERE deleted_at IS NULL`;
    const params: any[] = [];

    if (!isAdmin) {
        query += ' AND is_private = 0';
    }

    if (type === 'template') {
        const enabledExtensions = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
        const namespaceLikes = ["slug LIKE '틀:%'", ...enabledExtensions.map(() => "slug LIKE ?")];
        query += ` AND (${namespaceLikes.join(' OR ')})`;
        enabledExtensions.forEach(ext => params.push(`${ext}:%`));
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
 * GET /w/search-categories
 * 카테고리 자동완성용 검색 (최대 8개)
 * Query: q (검색어)
 */
wiki.get('/w/search-categories', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const db = c.env.DB;
    const q = c.req.query('q') || '';

    let rows: { category: string }[];
    if (q.length > 0) {
        const { results } = await db
            .prepare('SELECT DISTINCT category FROM page_categories WHERE category LIKE ? ORDER BY category ASC LIMIT 8')
            .bind(`%${q}%`)
            .all<{ category: string }>();
        rows = results;
    } else {
        const { results } = await db
            .prepare('SELECT DISTINCT category FROM page_categories ORDER BY category ASC LIMIT 8')
            .all<{ category: string }>();
        rows = results;
    }

    return c.json({ results: rows.map(r => r.category) });
});


/**
 * GET /w/recent-changes
 * 위키 전체에서 가장 최근에 수정된 문서 10개
 */
wiki.get('/w/recent-changes', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = user && rbac.can(user.role, 'admin:access');

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
 * GET /w/admin-categories
 * 관리자 전용 카테고리 목록 (공개 - 편집 페이지에서 사용)
 */
wiki.get('/w/admin-categories', async (c) => {
    const db = c.env.DB;
    const { results } = await db
        .prepare('SELECT name FROM admin_categories ORDER BY name ASC')
        .all();
    return c.json({ categories: results.map((r: any) => r.name) });
});

/**
 * GET /w/templates
 * 템플릿 목록 (slug가 '템플릿:'으로 시작하는 문서들만)
 */
wiki.get('/w/templates', async (c) => {
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
 * GET /random
 * 단일 랜덤 문서 반환 (접근 가능한 문서 중)
 */
wiki.get('/w/random', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = user && rbac.can(user.role, 'admin:access');

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
 * GET /w/recent-revisions
 * 위키 전체에서 가장 최근 리비전 내역 (모든 문서 대상)
 * - 비관리자: 공개 + 삭제되지 않은 문서의 리비전만 표시
 * - 관리자: 비공개 문서 포함, 삭제된 문서 제외
 * Query: offset (기본 0), limit (기본 10, 최대 50)
 */
wiki.get('/w/recent-revisions', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = user && rbac.can(user.role, 'admin:access');
    const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10));
    const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '10', 10)));

    let query = `
        SELECT r.id, r.page_id, r.page_version, r.summary, r.created_at,
               p.slug, p.title,
               u.id as author_id, u.name as author_name, u.picture as author_picture,
               ${ROLE_CASE_SQL} as author_role,
               u.email as _author_email
        FROM revisions r
        JOIN pages p ON r.page_id = p.id
        LEFT JOIN users u ON r.author_id = u.id
        WHERE p.deleted_at IS NULL
    `;
    if (!isAdmin) {
        query += ' AND p.is_private = 0';
    }
    query += ` ORDER BY r.created_at DESC LIMIT ? OFFSET ?`;

    const { results } = await db.prepare(query).bind(limit + 1, offset).all();

    let has_more = false;
    if (results.length > limit) {
        has_more = true;
        results.pop();
    }

    enrichRoles(results, 'author_role', '_author_email', c.env);

    return c.json(safeJSON({ revisions: results, has_more }));
});

/**
 * GET /w/all-pages
 * 모든 문서 목록 (정렬 + 페이지네이션)
 * Query: offset (기본 0), limit (기본 20, 최대 50),
 *        sort (title_asc, title_desc, created_asc, created_desc,
 *              updated_asc, updated_desc, category_asc, category_desc)
 */
wiki.get('/w/all-pages', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = user && rbac.can(user.role, 'admin:access');
    const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10));
    const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
    const sort = c.req.query('sort') || 'title_asc';

    const sortMap: Record<string, string> = {
        title_asc: 'p.title COLLATE NOCASE ASC',
        title_desc: 'p.title COLLATE NOCASE DESC',
        created_asc: 'p.created_at ASC',
        created_desc: 'p.created_at DESC',
        updated_asc: 'p.updated_at ASC',
        updated_desc: 'p.updated_at DESC',
        category_asc: 'p.category COLLATE NOCASE ASC, p.title COLLATE NOCASE ASC',
        category_desc: 'p.category COLLATE NOCASE DESC, p.title COLLATE NOCASE ASC',
    };
    const orderBy = sortMap[sort] || sortMap['title_asc'];

    let query = `
        SELECT p.slug, p.title, p.category, p.created_at, p.updated_at
        FROM pages p
        WHERE p.deleted_at IS NULL
    `;
    if (!isAdmin) {
        query += ' AND p.is_private = 0';
    }
    query += ` ORDER BY ${orderBy} LIMIT ? OFFSET ?`;

    const { results } = await db.prepare(query).bind(limit + 1, offset).all();

    let has_more = false;
    if (results.length > limit) {
        has_more = true;
        results.pop();
    }

    return c.json(safeJSON({ pages: results, has_more }));
});

/**
 * GET /w/wiki-stats
 * 위키 통계 (문서 개수, 편집 횟수)
 * sqlite_sequence 테이블의 pages, revisions 데이터 참조
 */
wiki.get('/w/wiki-stats', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const db = c.env.DB;

    const [pageCountRow, revisionCountRow] = await Promise.all([
        db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'pages'`).first<{ seq: number }>(),
        db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'revisions'`).first<{ seq: number }>(),
    ]);

    return c.json({
        page_count: pageCountRow?.seq ?? 0,
        revision_count: revisionCountRow?.seq ?? 0,
    });
});

/**
 * GET /w/:slug
 * 문서 조회 (공개)
 * - 리다이렉트 처리: 문서가 없고 리다이렉트가 존재하면 대상 문서 반환 (redirected_from 포함)
 * - 비공개 문서: 관리자만 접근 가능
 */
wiki.get('/w/:slug', async (c) => {
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

    const rbac = c.get("rbac") as RBAC;
    const isAdmin = user && rbac.can(user.role, 'admin:access');

    if (page && page.deleted_at && !isAdmin) {
        return c.json({ error: '삭제된 문서입니다.', is_deleted: true }, 410);
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

    // R2-only 네임스페이스인 경우, 본문이 비어있다면 최신 리비전에서 본문을 가져옵니다.
    const origin = new URL(c.req.url).origin;
    const enabledExtensionsRead = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
    if (isR2OnlyNamespace(page.slug, enabledExtensionsRead) && (!page.content || page.content === '')) {
        if (page.last_revision_id) {
            const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(page.last_revision_id).first<{ content: string, r2_key: string | null }>();
            if (lastRev) {
                page.content = await getRevisionContent(c.env.MEDIA, lastRev, origin);
            }
        }
    }

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
 * PUT /w/:slug
 * 문서 생성 또는 수정 (로그인 필수)
 * Body: { title, content, summary, expected_version? }
 */
wiki.put('/w/:slug', requireAuth, requirePermission('wiki:edit'), async (c) => {
    const slug = c.req.param('slug');
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
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

    const isAdmin = rbac.can(user.role, 'admin:access');
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
    if (body.is_private !== undefined && !rbac.can(user.role, 'wiki:private')) {
        return c.json({ error: '비공개 설정은 관리자만 변경할 수 있습니다.' }, 403);
    }

    if (!body.title || body.content === undefined) {
        return c.json({ error: 'title과 content는 필수입니다.' }, 400);
    }

    // 보안: 문서 제목 금지 문자 점검
    if (/[\[\]()#%|<>^\x00-\x1F\x7F]/.test(body.title)) {
        return c.json({ error: '문서 제목에 사용할 수 없는 특수문자가 포함되어 있습니다.' }, 400);
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
        if (existing.is_locked === 1 && !rbac.can(user.role, 'wiki:lock')) {
            return c.json({ error: '이 문서는 관리자만 편집할 수 있습니다.' }, 403);
        }

        // 비공개 문서 편집 권한 체크
        if (existing.is_private === 1 && !rbac.can(user.role, 'wiki:private')) {
            return c.json({ error: '비공개 문서는 관리자만 편집할 수 있습니다.' }, 403);
        }

        // 권한에 따른 잠금/비공개 상태 결정
        finalIsLocked = rbac.can(user.role, 'wiki:lock') ? (body.is_locked ?? existing.is_locked) : existing.is_locked;
        finalIsPrivate = rbac.can(user.role, 'wiki:private') ? (body.is_private ?? existing.is_private) : existing.is_private;

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

        // R2-only 네임스페이스 여부 확인
        const enabledExtensionsEdit = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
        const isR2Only = isR2OnlyNamespace(slug, enabledExtensionsEdit);

        // Optimistic Locking 체크 시, R2-only 문서인 경우 R2에서 실제 본문을 가져와 비교
        if (body.expected_version !== undefined && body.expected_version !== existing.version) {
            let currentActualContent = existing.content;
            if (isR2Only && (!currentActualContent || currentActualContent === '')) {
                if (existing.id) {
                    const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE page_id = ? AND page_version = ?').bind(existing.id, existing.version).first<{ content: string, r2_key: string | null }>();
                    if (lastRev) {
                        currentActualContent = await getRevisionContent(c.env.MEDIA, lastRev, new URL(c.req.url).origin);
                    }
                }
            }

            // 내용이 완전히 동일하면 충돌로 보지 않고 진행 (Idempotent)
            if (body.content !== currentActualContent) {
                return c.json(
                    {
                        error: '편집 충돌이 발생했습니다. 다른 사용자가 문서를 수정했습니다.',
                        current_version: existing.version,
                        content: currentActualContent
                    },
                    409
                );
            }
        }

        // 1. 리비전 본문을 R2에 먼저 업로드
        let r2Key: string;
        try {
            r2Key = await uploadRevisionToR2(c.env.MEDIA, existing.id, newVersion, body.content);
        } catch (e) {
            console.error('R2 revision upload failed:', e);
            return c.json({ error: '리비전 저장에 실패했습니다. 잠시 후 다시 시도해주세요.' }, 500);
        }

        // 2. D1에 리비전 메타데이터 삽입 (content는 빈 문자열, r2_key 저장)
        let revisionId: number;
        try {
            const revResult = await db
                .prepare(
                    'INSERT INTO revisions (page_id, page_version, content, r2_key, summary, author_id) VALUES (?, ?, ?, ?, ?, ?)'
                )
                .bind(existing.id, newVersion, '', r2Key, body.summary ?? null, user.id)
                .run();
            revisionId = revResult.meta.last_row_id;
        } catch (e) {
            // D1 실패 시 업로드한 R2 파일 롤백
            await c.env.MEDIA.delete(r2Key).catch(() => {});
            console.error('D1 revision insert failed:', e);
            return c.json({ error: '리비전 저장에 실패했습니다. 잠시 후 다시 시도해주세요.' }, 500);
        }

        // 3. 페이지 업데이트 (pages.content는 R2-only가 아닐 때만 최신 본문 유지)
        const contentToStore = isR2Only ? '' : body.content;
        await db
            .prepare(
                `UPDATE pages
         SET title = ?, content = ?, category = ?, is_locked = ?, is_private = ?, redirect_to = ?, author_id = ?, last_revision_id = ?,
             version = ?, updated_at = unixepoch()
         WHERE id = ?`
            )
            .bind(body.title, contentToStore, body.category || null, finalIsLocked, finalIsPrivate, body.redirect_to || null, user.id, revisionId, newVersion, existing.id)
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
                            .bind(w.user_id, 'page_watch', `${user.name}님이 "${body.title}" 문서를 편집했습니다.`, `/w/${slug}`)
                    );
                    return db.batch(stmts);
                })
                .catch(e => console.error('Failed to notify watchers:', e))
        );

        // 캐시 무효화 (API + SSR) + 최근 변경 즉시 갱신
        // 콜론이 포함된 문서(틀, 익스텐션 등)인 경우 역링크 문서 캐시도 함께 무효화
        c.executionCtx.waitUntil(Promise.all([
            invalidatePageCache(c, slug),
            refreshRecentChangesCache(c),
            invalidateBacklinkCaches(c, slug, db),
        ]));

        return c.json(safeJSON({ slug, version: newVersion, revision_id: revisionId }));
    } else {
        finalIsLocked = rbac.can(user.role, 'wiki:lock') ? (body.is_locked ?? 0) : 0;
        finalIsPrivate = rbac.can(user.role, 'wiki:private') ? (body.is_private ?? 0) : 0;

        // ── 새 문서 생성 ──
        const enabledExtensionsCreate = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
        const isR2Only = isR2OnlyNamespace(slug, enabledExtensionsCreate);
        const contentToStore = isR2Only ? '' : body.content;

        const pageResult = await db
            .prepare(
                'INSERT INTO pages (slug, title, content, category, is_locked, is_private, redirect_to, author_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            )
            .bind(slug, body.title, contentToStore, body.category || null, finalIsLocked, finalIsPrivate, body.redirect_to || null, user.id)
            .run();

        const pageId = pageResult.meta.last_row_id;

        // 첫 리비전 생성
        // 1. R2 업로드
        let firstR2Key: string;
        try {
            firstR2Key = await uploadRevisionToR2(c.env.MEDIA, pageId, 1, body.content);
        } catch (e) {
            // R2 실패 시 방금 생성한 페이지 롤백
            await db.prepare('DELETE FROM pages WHERE id = ?').bind(pageId).run().catch(() => {});
            console.error('R2 first revision upload failed:', e);
            return c.json({ error: '리비전 저장에 실패했습니다. 잠시 후 다시 시도해주세요.' }, 500);
        }

        // 2. D1 리비전 삽입
        let revisionId: number;
        try {
            const revResult = await db
                .prepare(
                    'INSERT INTO revisions (page_id, page_version, content, r2_key, summary, author_id) VALUES (?, ?, ?, ?, ?, ?)'
                )
                .bind(pageId, 1, '', firstR2Key, body.summary ?? '문서 생성', user.id)
                .run();
            revisionId = revResult.meta.last_row_id;
        } catch (e) {
            await c.env.MEDIA.delete(firstR2Key).catch(() => {});
            await db.prepare('DELETE FROM pages WHERE id = ?').bind(pageId).run().catch(() => {});
            console.error('D1 first revision insert failed:', e);
            return c.json({ error: '리비전 저장에 실패했습니다. 잠시 후 다시 시도해주세요.' }, 500);
        }

        // last_revision_id 업데이트
        await db
            .prepare('UPDATE pages SET last_revision_id = ? WHERE id = ?')
            .bind(revisionId, pageId)
            .run();

        // page_links, page_categories 갱신 (비동기)
        const linkCatStmts = buildLinkAndCategoryStatements(db, pageId, body.content, body.category || null);
        c.executionCtx.waitUntil(db.batch(linkCatStmts).catch(e => console.error('Failed to update links/categories:', e)));

        // 캐시 무효화 (API + SSR) + 최근 변경 즉시 갱신
        // 콜론이 포함된 문서(틀, 익스텐션 등)인 경우 역링크 문서 캐시도 함께 무효화
        c.executionCtx.waitUntil(Promise.all([
            invalidatePageCache(c, slug),
            refreshRecentChangesCache(c),
            invalidateBacklinkCaches(c, slug, db),
        ]));

        return c.json(safeJSON({ slug, version: 1, revision_id: revisionId }), 201);
    }
});

/**
 * GET /w/category/:category
 * 카테고리별 문서 목록 (page_categories 테이블 기반)
 */
wiki.get('/w/category/:category', async (c) => {
    const category = c.req.param('category');
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = user && rbac.can(user.role, 'admin:access');

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
 * GET /w/:slug/revisions
 * 리비전 목록
 */
wiki.get('/w/:slug/revisions', async (c) => {
    const slug = c.req.param('slug');
    const offset = parseInt(c.req.query('offset') || '0', 10);
    const limit = 10;
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = user && rbac.can(user.role, 'admin:access');

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
            `SELECT r.id, r.page_version, r.summary, r.created_at, u.id as author_id, u.name as author_name, u.picture as author_picture,
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
 * GET /w/:slug/revisions/:id
 * 특정 리비전 내용
 */
wiki.get('/w/:slug/revisions/:id', async (c) => {
    const revId = parseInt(c.req.param('id'));
    const slug = c.req.param('slug');
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = user && rbac.can(user.role, 'admin:access');

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
            `SELECT r.id, r.page_id, r.page_version, r.content, r.r2_key, r.summary, r.author_id, r.created_at,
                    u.name as author_name
       FROM revisions r
       LEFT JOIN users u ON r.author_id = u.id
       WHERE r.id = ? AND r.page_id = ?`
        )
        .bind(revId, page.id)
        .first<{ id: number; page_id: number; page_version: number | null; content: string; r2_key: string | null; summary: string | null; author_id: number | null; created_at: number; author_name: string | null }>();

    if (!revision) {
        return c.json({ error: '리비전을 찾을 수 없습니다.' }, 404);
    }

    // r2_key가 있으면 R2에서 본문 조회
    const origin = new URL(c.req.url).origin;
    const content = await getRevisionContent(c.env.MEDIA, revision, origin);

    return c.json(safeJSON({ ...revision, content }));
});

/**
 * GET /w/:slug/revisions/:id/diff
 * 특정 리비전과 이전 리비전의 내용을 비교용으로 반환
 */
wiki.get('/w/:slug/revisions/:id/diff', async (c) => {
    const revId = parseInt(c.req.param('id'));
    const slug = c.req.param('slug');
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = user && rbac.can(user.role, 'admin:access');

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
            `SELECT id, page_version, content, r2_key, page_id, created_at
       FROM revisions
       WHERE id = ? AND page_id = ?`
        )
        .bind(revId, page.id)
        .first<{ id: number; page_version: number | null; content: string; r2_key: string | null; page_id: number; created_at: number }>();

    if (!revision) {
        return c.json({ error: '리비전을 찾을 수 없습니다.' }, 404);
    }

    // 바로 이전 리비전 조회
    const prevRevision = await db
        .prepare(
            `SELECT id, page_version, content, r2_key FROM revisions
       WHERE page_id = ? AND id < ?
       ORDER BY id DESC LIMIT 1`
        )
        .bind(revision.page_id, revId)
        .first<{ id: number; page_version: number | null; content: string; r2_key: string | null }>();

    // R2 or D1에서 본문 조회
    const origin = new URL(c.req.url).origin;
    const [newContent, oldContent] = await Promise.all([
        getRevisionContent(c.env.MEDIA, revision, origin),
        prevRevision ? getRevisionContent(c.env.MEDIA, prevRevision, origin) : Promise.resolve(''),
    ]);

    return c.json(safeJSON({
        old_content: oldContent,
        new_content: newContent,
        old_revision_id: prevRevision?.id ?? null,
        new_revision_id: revision.id,
        old_page_version: prevRevision?.page_version ?? null,
        new_page_version: revision.page_version ?? null,
    }));
});

/**
 * GET /w/:slug/subdocs
 * 하위 문서 목록 (제목이 '{slug}/'로 시작하는 문서들)
 */
wiki.get('/w/:slug/subdocs', async (c) => {
    const slug = c.req.param('slug');
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = user && rbac.can(user.role, 'admin:access');

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
 * GET /w/:slug/backlinks
 * 이 문서를 참조하는 문서 목록 (page_links 테이블 기반)
 * - 문서 링크: [[slug]] → link_type = 'wikilink'
 * - 틀 트랜스클루전: {{slug}} → link_type = 'template'
 */
wiki.get('/w/:slug/backlinks', async (c) => {
    const slug = c.req.param('slug');
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = user && rbac.can(user.role, 'admin:access');

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
    // page_links.target_slug는 extractLinks()가 '#섹션'을 제거한 뒤 저장하므로
    // 단순 IN 매칭만으로 섹션 앵커를 포함한 모든 위키링크가 포착됨
    // 관리자: soft delete된 문서도 is_deleted 플래그와 함께 반환
    // 일반 사용자: soft delete된 문서 제외 (접근 불가 + 메타데이터 노출 방지)
    let query = `
        SELECT DISTINCT p.slug, p.title, p.updated_at, p.is_locked,
            CASE WHEN p.deleted_at IS NOT NULL THEN 1 ELSE 0 END AS is_deleted
        FROM page_links pl
        JOIN pages p ON pl.source_page_id = p.id
        WHERE p.slug != ?
          AND pl.target_slug IN (${placeholders})
    `;
    if (!isAdmin) {
        query += ' AND p.is_private = 0 AND p.deleted_at IS NULL';
    }
    query += ' ORDER BY p.updated_at DESC LIMIT 100';

    const backlinks = await db
        .prepare(query)
        .bind(slug, ...targetSlugs)
        .all();

    return c.json(safeJSON({ backlinks: backlinks.results }));
});

/**
 * DELETE /w/:slug
 * 문서 삭제 (관리자 전용)
 * - super_admin: ?hard=true 시 영구 삭제 (문서, 리비전, 리다이렉트)
 * - admin/super_admin: Soft Delete
 * - 이미지: 접두사 문서의 경우 R2 파일 및 media 레코드도 함께 삭제
 */
wiki.delete('/w/:slug', requireAuth, async (c) => {
    const slug = c.req.param('slug');
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;
    const hard = c.req.query('hard') === 'true';

    const isAdmin = rbac.can(user.role, 'admin:access');

    // Fetch page first to check permissions
    const page = await db.prepare('SELECT id, is_locked, is_private FROM pages WHERE slug = ? AND deleted_at IS NULL')
        .bind(slug).first<{ id: number; is_locked: number; is_private: number }>();

    if (!page) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    if (hard) {
        if (!rbac.can(user.role, '*')) {
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

        // 리비전 R2 파일 삭제
        const revisionKeys = await db.prepare('SELECT r2_key FROM revisions WHERE page_id = ? AND r2_key IS NOT NULL')
            .bind(page.id).all<{ r2_key: string }>();
        if (revisionKeys.results.length > 0) {
            await Promise.all(revisionKeys.results.map(r => c.env.MEDIA.delete(r.r2_key)));
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
        // 틀: 등 콜론 포함 문서인 경우 역링크 문서 캐시도 함께 무효화
        c.executionCtx.waitUntil(Promise.all([
            invalidatePageCache(c, slug),
            refreshRecentChangesCache(c),
            invalidateBacklinkCaches(c, slug, db),
        ]));

        // 관리자 로그 기록
        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind('hard_delete', `문서 영구 삭제: ${slug}`, user.id)
                .run().catch((e: any) => console.error('Failed to write admin log:', e))
        );

        return c.json({ message: '문서가 영구 삭제되었습니다.' });
    } else {
        // Soft delete requires wiki:delete permission
        if (!rbac.can(user.role, 'wiki:delete')) {
            return c.json({ error: '문서 삭제 권한이 없습니다.' }, 403);
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
        // 틀: 등 콜론 포함 문서인 경우 역링크 문서 캐시도 함께 무효화
        c.executionCtx.waitUntil(Promise.all([
            invalidatePageCache(c, slug),
            refreshRecentChangesCache(c),
            invalidateBacklinkCaches(c, slug, db),
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
 * POST /w/:slug/restore
 * 문서 복원 (관리자 전용)
 * - Soft Delete된 문서를 복구
 */
wiki.post('/w/:slug/restore', requireAuth, async (c) => {
    const slug = c.req.param('slug');
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;

    if (!rbac.can(user.role, 'wiki:delete')) {
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
    // 틀: 등 콜론 포함 문서인 경우 역링크 문서 캐시도 함께 무효화
    c.executionCtx.waitUntil(Promise.all([
        invalidatePageCache(c, slug),
        refreshRecentChangesCache(c),
        invalidateBacklinkCaches(c, slug, db),
    ]));

    return c.json({ message: '문서가 복원되었습니다.' });
});

/**
 * POST /w/:slug/move
 * 문서 이동 (이름 변경)
 * - 기존 문서 이름(slug)을 새로운 이름으로 변경
 * - 기존 문서에 리디렉션을 생성하지 않음
 * - Backlinks FROM this page are updated to reflect the new source slug
 */
wiki.post('/w/:slug/move', requireAuth, async (c) => {
    const currentSlug = c.req.param('slug');
    const { new_slug } = await c.req.json<{ new_slug: string }>();
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;

    if (!new_slug || new_slug.trim().length === 0) {
        return c.json({ error: '새 문서 이름을 입력해주세요.' }, 400);
    }

    const trimmedNewSlug = new_slug.trim();

    // 보안: 문서 제목 금지 문자 점검
    if (/[\[\]()#%|<>^\x00-\x1F\x7F]/.test(trimmedNewSlug)) {
        return c.json({ error: '문서 제목에 사용할 수 없는 특수문자가 포함되어 있습니다.' }, 400);
    }

    // 네임스페이스 이동 제한: 콜론이 포함된 문서는 다른 네임스페이스로 이동 불가
    const isNamespaceDocument = currentSlug.includes(':');
    const currentNamespace = isNamespaceDocument ? currentSlug.split(':')[0] : '';
    const newNamespace = trimmedNewSlug.includes(':') ? trimmedNewSlug.split(':')[0] : '';
    if (isNamespaceDocument && currentNamespace !== newNamespace) {
        return c.json({ error: '네임스페이스가 있는 문서는 다른 네임스페이스로 이동할 수 없습니다.' }, 400);
    }

    // new_slug validation logic same as create (e.g. valid chars) - skip for brevity or assume client sends valid slug
    // Check if target exists
    const targetExists = await db.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL').bind(trimmedNewSlug).first();
    if (targetExists) {
        return c.json({ error: '이미 존재하는 문서 이름입니다.' }, 409);
    }

    // Check if target is a redirect source
    const redirectExists = await db.prepare('SELECT id FROM redirects WHERE source_slug = ?').bind(trimmedNewSlug).first();
    if (redirectExists) {
        return c.json({ error: '해당 이름은 다른 문서로의 넘겨주기(Redirect)로 사용되고 있어 이동할 수 없습니다.' }, 409);
    }

    const page = await db.prepare('SELECT id, title, is_locked, is_private FROM pages WHERE slug = ? AND deleted_at IS NULL').bind(currentSlug).first<{ id: number, title: string, is_locked: number, is_private: number }>();
    if (!page) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    const isAdmin = rbac.can(user.role, 'admin:access');
    if (page.is_locked === 1 && !rbac.can(user.role, 'wiki:lock')) {
        return c.json({ error: '잠긴 문서는 관리자만 이동할 수 있습니다.' }, 403);
    }
    if (page.is_private === 1 && !rbac.can(user.role, 'wiki:private')) {
        return c.json({ error: '비공개 문서는 관리자만 이동할 수 있습니다.' }, 403);
    }

    // Update Page Slug and Title
    await db.prepare('UPDATE pages SET slug = ?, title = ? WHERE id = ?')
        .bind(trimmedNewSlug, trimmedNewSlug, page.id)
        .run();

    // 관리자 로그 기록
    c.executionCtx.waitUntil(
        db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
            .bind('doc_move', `문서 이름변경: ${currentSlug} → ${trimmedNewSlug}`, user.id)
            .run().catch((e: any) => console.error('Failed to write admin log:', e))
    );

    // 캐시 무효화 (API + SSR) + 최근 변경 즉시 갱신
    // 틀: 등 콜론 포함 문서인 경우 이동 전 슬러그의 역링크 문서 캐시도 함께 무효화
    c.executionCtx.waitUntil(Promise.all([
        invalidatePageCache(c, currentSlug),
        invalidatePageCache(c, trimmedNewSlug),
        refreshRecentChangesCache(c),
        invalidateBacklinkCaches(c, currentSlug, db),
    ]));

    return c.json({ message: '문서가 이동되었습니다.', new_slug: trimmedNewSlug });
});

/**
 * POST /w/:slug/revert
 * 문서 되돌리기
 */
wiki.post('/w/:slug/revert', requireAuth, async (c) => {
    const slug = c.req.param('slug');
    const { revision_id } = await c.req.json<{ revision_id: number }>();
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;

    const page = await db.prepare('SELECT id, version, is_locked FROM pages WHERE slug = ? AND deleted_at IS NULL')
        .bind(slug).first<{ id: number, version: number, is_locked: number }>();

    if (!page) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    if (page.is_locked === 1 && !rbac.can(user.role, 'wiki:lock')) {
        return c.json({ error: '잠긴 문서는 관리자만 되돌릴 수 있습니다.' }, 403);
    }

    const targetRevision = await db.prepare('SELECT content, r2_key, page_version FROM revisions WHERE id = ? AND page_id = ?')
        .bind(revision_id, page.id).first<{ content: string; r2_key: string | null; page_version: number | null }>();

    if (!targetRevision) {
        return c.json({ error: '해당 리비전을 찾을 수 없습니다.' }, 404);
    }

    // 되돌릴 리비전의 본문을 R2 또는 D1에서 조회
    const origin = new URL(c.req.url).origin;
    let revertContent: string;
    try {
        revertContent = await getRevisionContent(c.env.MEDIA, targetRevision, origin);
    } catch (e) {
        console.error('Failed to fetch revert target content:', e);
        return c.json({ error: '리비전 본문을 불러오지 못했습니다.' }, 500);
    }

    // 새 리비전 생성 (리비전 이력은 선형으로 계속 쌓임)
    const newVersion = page.version + 1;
    const targetVersionLabel = targetRevision.page_version != null ? `v${targetRevision.page_version}` : `#${revision_id}`;
    const summary = `${targetVersionLabel}으로 되돌리기`;

    // 1. R2에 새 리비전 본문 업로드
    let newR2Key: string;
    try {
        newR2Key = await uploadRevisionToR2(c.env.MEDIA, page.id, newVersion, revertContent);
    } catch (e) {
        console.error('R2 revert upload failed:', e);
        return c.json({ error: '리비전 저장에 실패했습니다. 잠시 후 다시 시도해주세요.' }, 500);
    }

    // 2. D1에 새 리비전 레코드 삽입
    let newRevId: number;
    try {
        const revResult = await db.prepare('INSERT INTO revisions (page_id, page_version, content, r2_key, summary, author_id) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(page.id, newVersion, '', newR2Key, summary, user.id)
            .run();
        newRevId = revResult.meta.last_row_id;
    } catch (e) {
        await c.env.MEDIA.delete(newR2Key).catch(() => {});
        console.error('D1 revert revision insert failed:', e);
        return c.json({ error: '리비전 저장에 실패했습니다. 잠시 후 다시 시도해주세요.' }, 500);
    }

    const enabledExtensionsRevert = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
    const contentToStore = isR2OnlyNamespace(slug, enabledExtensionsRevert) ? '' : revertContent;
    await db.prepare('UPDATE pages SET content = ?, last_revision_id = ?, version = ?, updated_at = unixepoch() WHERE id = ?')
        .bind(contentToStore, newRevId, newVersion, page.id)
        .run();

    // 캐시 무효화 (API + SSR) + 최근 변경 즉시 갱신
    c.executionCtx.waitUntil(Promise.all([
        invalidatePageCache(c, slug),
        refreshRecentChangesCache(c),
    ]));

    return c.json({ message: '문서가 되돌려졌습니다.', version: newVersion });
});

/**
 * GET /w/:slug/redirects
 * 해당 문서로 연결된 넘겨주기 목록
 */
wiki.get('/w/:slug/redirects', async (c) => {
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
 * POST /w/:slug/redirects
 * 넘겨주기 추가
 */
wiki.post('/w/:slug/redirects', requireAuth, async (c) => {
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
 * DELETE /w/:slug/redirects
 * 넘겨주기 삭제
 */
wiki.delete('/w/:slug/redirects', requireAuth, async (c) => {
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
 * GET /w/:slug/watch
 * 현재 유저의 주시 상태 조회
 */
wiki.get('/w/:slug/watch', requireAuth, async (c) => {
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
 * POST /w/:slug/watch
 * 문서 주시 토글 (로그인 필수)
 */
wiki.post('/w/:slug/watch', requireAuth, async (c) => {
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
 * POST /w/:slug/editing
 * 편집 하트비트 전송 (로그인 필수)
 * - KV에 편집 중 상태를 기록 (TTL 80초)
 */
wiki.post('/w/:slug/editing', requireAuth, async (c) => {
    if (c.env.ENABLE_CONCURRENT_EDIT_DETECTION === 'false') {
        return c.json({ ok: true, disabled: true });
    }
    const slug = c.req.param('slug');
    const user = c.get('user')!;
    const kv = c.env.KV;

    const key = `editing:${slug}:${user.id}`;
    const value = JSON.stringify({ name: user.name, picture: user.picture || '' });

    // 하트비트 주기가 50초이므로, TTL은 80초 정도로 설정하여 여유를 둠
    await kv.put(key, value, { expirationTtl: 80 });

    return c.json({ ok: true });
});

/**
 * GET /w/:slug/editors
 * 현재 편집 중인 사용자 목록 (로그인 필수)
 * - 자기 자신은 제외
 */
wiki.get('/w/:slug/editors', requireAuth, async (c) => {
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
