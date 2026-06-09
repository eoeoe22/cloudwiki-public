import { Hono } from 'hono';
import type { Env, BlogPost } from '../types';
import { requireAdmin } from '../middleware/session';
import { safeJSON } from '../utils/json';
import { RBAC } from '../utils/role';
import { loadPalettesForBlogPost } from '../utils/palettes';
import { writeAdminLog } from './admin';
import { dispatchDiscord } from '../utils/webhook/discord';
import { announcementPublish } from '../utils/webhook/events/blog';
import {
    mutateAnnouncements,
    removeAnnouncementByPostId,
    AnnouncementMutationError,
    type Announcement,
} from '../utils/announcements';

const blog = new Hono<Env>();

/** 코드 블록(```/~~~ 펜스) 및 인라인 코드(`...`) 를 제거 — 코드 안 이미지 표기는 본문이 아님. */
function stripCodeBlocks(content: string): string {
    return content
        .replace(/```[\s\S]*?```/g, '')
        .replace(/~~~[\s\S]*?~~~/g, '')
        .replace(/`[^`\n]+`/g, '');
}

/**
 * 블로그 본문에서 이미지 R2 키(`images/...`) 를 추출해 target_slug 목록 반환.
 * 에디터는 마크다운 `![alt](/media/images/...)` 또는 HTML `<img src=".../images/...">`
 * 형태로 이미지를 삽입하므로 위키의 extractLinks() 와 동일한 정규식으로 추적한다.
 * 미디어 사용 여부 판정(admin.ts:702 의 unused media 체크 등)이 이 행에 의존하므로
 * 누락 시 사용 중인 블로그 이미지가 미사용으로 분류되어 삭제될 수 있다.
 */
export function extractBlogImageLinks(content: string): string[] {
    const cleaned = stripCodeBlocks(content);
    const seen = new Set<string>();
    const imageRegex = /images\/[^\s\[\]()<>"'\\?#|^]+?\.\w+/g;
    for (const m of cleaned.matchAll(imageRegex)) {
        seen.add(m[0].trim());
    }
    return [...seen];
}

/**
 * 본문에서 첫 번째 이미지(jpg/png/gif/webp)를 찾아 썸네일 URL 로 반환.
 * 동영상(mp4/webm/ogg) 등은 제외한다. 이미지가 없으면 null.
 */
export function extractFirstThumbnail(content: string): string | null {
    const cleaned = stripCodeBlocks(content);
    const m = cleaned.match(/images\/[^\s\[\]()<>"'\\?#|^]+?\.(?:jpe?g|png|gif|webp)/i);
    return m ? `/media/${m[0]}` : null;
}

/**
 * 블로그 본문에서 {palette:이름} 토큰 이름을 모두 추출. 문서 열람 시
 * loadPalettesForBlogPost 가 이 인덱스를 참고해 사용된 팔레트만 SSR 한다.
 */
export function extractBlogPaletteLinks(content: string): string[] {
    const cleaned = stripCodeBlocks(content);
    const seen = new Set<string>();
    const paletteRegex = /\{palette:\s*([A-Za-z0-9_-]+)\s*\}/g;
    for (const m of cleaned.matchAll(paletteRegex)) {
        seen.add(m[1]);
    }
    return [...seen];
}

/**
 * 블로그 본문에서 {{틀명}} 트랜스클루전 대상 slug 를 추출.
 * loadPalettesForBlogPost 가 page_links(link_type='template') 를 따라가
 * 트랜스클루전된 틀이 참조하는 팔레트도 합집합으로 끌어오기 위함.
 * wiki.ts extractLinks() 의 template 분기와 동일한 정규화 정책(틀:/template:/템플릿: prefix
 * 자동 부착, # 섹션 앵커 제거)을 사용한다.
 */
export function extractBlogTemplateLinks(content: string): string[] {
    const cleaned = stripCodeBlocks(content);
    const seen = new Set<string>();
    const templateRegex = /\{\{([^}]+?)\}\}/g;
    for (const m of cleaned.matchAll(templateRegex)) {
        // '|' 앞부분만 slug로 사용 (파라미터/인자 무시 — {{틀이름|key=값}} 호출).
        let slug = m[1].trim().split('|')[0].split('#')[0].trim();
        if (!slug) continue;
        const colonIdx = slug.indexOf(':');
        // 익스텐션 호출 (`freq:foo` 등) 은 트랜스클루전이 아니므로 제외
        if (colonIdx > 0 && !slug.startsWith('틀:') && !slug.startsWith('template:') && !slug.startsWith('템플릿:')) {
            continue;
        }
        if (!slug.startsWith('틀:') && !slug.startsWith('template:') && !slug.startsWith('템플릿:')) {
            slug = '틀:' + slug;
        }
        seen.add(slug);
    }
    return [...seen];
}

/** 블로그 포스트 저장 후 page_links 테이블의 이미지/팔레트 역링크를 갱신 */
export async function rebuildBlogImageLinks(db: D1Database, blogPostId: number, content: string): Promise<void> {
    const stmts: D1PreparedStatement[] = [
        // blog=1 필터로 분리 — blog=1 은 블로그 INSERT 만 사용하므로 (토론·티켓 댓글 INSERT 는
        // blog=0) 토론·티켓 댓글 역링크와 충돌하지 않는다. 마이그레이션 backfill 이전 legacy
        // 행(source_type='page' + blog=1)도 함께 정리되도록 source_type 필터는 두지 않는다.
        db.prepare('DELETE FROM page_links WHERE source_page_id = ? AND blog = 1').bind(blogPostId),
    ];
    const imageLinks = extractBlogImageLinks(content);
    for (const targetSlug of imageLinks) {
        stmts.push(
            db.prepare(
                "INSERT INTO page_links (source_page_id, target_slug, link_type, blog, source_type) VALUES (?, ?, ?, 1, 'blog')"
            ).bind(blogPostId, targetSlug, 'image')
        );
    }
    const paletteLinks = extractBlogPaletteLinks(content);
    for (const paletteName of paletteLinks) {
        stmts.push(
            db.prepare(
                "INSERT INTO page_links (source_page_id, target_slug, link_type, blog, source_type) VALUES (?, ?, 'palette', 1, 'blog')"
            ).bind(blogPostId, paletteName)
        );
    }
    const templateLinks = extractBlogTemplateLinks(content);
    for (const templateSlug of templateLinks) {
        stmts.push(
            db.prepare(
                "INSERT INTO page_links (source_page_id, target_slug, link_type, blog, source_type) VALUES (?, ?, 'template', 1, 'blog')"
            ).bind(blogPostId, templateSlug)
        );
    }
    // D1 배치 상한(약 50) 고려해 chunk 분할 — wiki.ts 와 동일 정책
    const chunkSize = 40;
    for (let i = 0; i < stmts.length; i += chunkSize) {
        await db.batch(stmts.slice(i, i + chunkSize));
    }
}

/**
 * GET /api/blog
 * 블로그 포스트 목록 (공개, 페이지네이션)
 * Query: limit (default 20, max 50), offset (default 0)
 */
blog.get('/blog', async (c) => {
    const db = c.env.DB;
    const user = c.get('user');
    if (c.env.WIKI_VISIBILITY === 'closed' && !user) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = user && rbac.can(user.role, 'admin:access');

    const limit = Math.min(50, Math.max(1, Number(c.req.query('limit')) || 20));
    const offset = Math.max(0, Number(c.req.query('offset')) || 0);

    const whereClause = isAdmin ? '' : 'WHERE deleted_at IS NULL';

    const [posts, countRow] = await Promise.all([
        db.prepare(
            `SELECT id, title, created_at, updated_at, deleted_at, rows, characters, thumbnail
             FROM blog_posts ${whereClause}
             ORDER BY created_at DESC LIMIT ? OFFSET ?`
        ).bind(limit, offset).all<Omit<BlogPost, 'content'>>(),
        db.prepare(
            `SELECT COUNT(*) as total FROM blog_posts ${whereClause}`
        ).first<{ total: number }>(),
    ]);

    return c.json(safeJSON({
        posts: posts.results,
        total: countRow?.total ?? 0,
        limit,
        offset,
    }));
});

/**
 * GET /api/blog/:id
 * 단건 조회 (공개; 관리자는 soft-delete된 것도 조회)
 */
blog.get('/blog/:id', async (c) => {
    const db = c.env.DB;
    const user = c.get('user');
    if (c.env.WIKI_VISIBILITY === 'closed' && !user) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = user && rbac.can(user.role, 'admin:access');

    const idParam = c.req.param('id');
    if (!/^\d+$/.test(idParam)) return c.json({ error: 'Not Found' }, 404);
    const id = Number(idParam);

    const post = await db
        .prepare('SELECT * FROM blog_posts WHERE id = ?')
        .bind(id)
        .first<BlogPost>();

    if (!post) return c.json({ error: 'Not Found' }, 404);
    if (post.deleted_at && !isAdmin) return c.json({ error: 'Not Found' }, 404);

    // 본문이 참조하는 커스텀 팔레트만 응답에 동봉 (SPA 네비게이션 대응).
    // post.content 도 함께 넘겨 저장 직후 page_links 비동기 갱신 윈도우를 폴백 처리.
    // canSeePrivate: 권한자가 펼쳐볼 수 있는 비공개 틀의 팔레트도 포함시키는 플래그.
    const canSeePrivate = rbac.can(user?.role ?? 'guest', 'wiki:private');
    let usedPalettes: Record<string, unknown> = {};
    try {
        usedPalettes = await loadPalettesForBlogPost(db, id, post.content, canSeePrivate);
    } catch (e) {
        console.error('loadPalettesForBlogPost failed:', e);
    }

    return c.json(safeJSON({ ...post, used_palettes: usedPalettes }));
});

/**
 * POST /api/blog
 * 블로그 포스트 작성 (관리자 전용)
 * Body: { title: string, content: string }
 */
blog.post('/blog', requireAdmin, async (c) => {
    const db = c.env.DB;
    const user = c.get('user')!;

    let body: { title?: unknown; content?: unknown };
    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (body.title !== undefined && typeof body.title !== 'string') {
        return c.json({ error: 'title은 문자열이어야 합니다.' }, 400);
    }
    if (body.content !== undefined && typeof body.content !== 'string') {
        return c.json({ error: 'content는 문자열이어야 합니다.' }, 400);
    }

    const title = (typeof body.title === 'string' ? body.title : '').trim();
    if (!title) return c.json({ error: '제목을 입력해주세요.' }, 400);
    if (title.length > 500) return c.json({ error: '제목은 500자 이내여야 합니다.' }, 400);

    const rawContent = typeof body.content === 'string' ? body.content : '';
    const content = rawContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const rows = content ? content.split('\n').length : 0;
    const characters = content ? content.length : 0;

    const thumbnail = extractFirstThumbnail(content);

    const result = await db
        .prepare(
            'INSERT INTO blog_posts (title, content, rows, characters, thumbnail) VALUES (?, ?, ?, ?, ?)'
        )
        .bind(title, content, rows, characters, thumbnail)
        .run();

    const newId = result.meta?.last_row_id;
    if (!newId) return c.json({ error: '저장 실패' }, 500);

    // 이미지 역링크 갱신
    c.executionCtx.waitUntil(rebuildBlogImageLinks(db, Number(newId), content));

    // admin_log
    c.executionCtx.waitUntil(
        db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
            .bind('blog_create', `블로그 작성: ${title}`, user.id)
            .run()
            .catch((e: any) => console.error('Failed to write admin_log for blog_create:', e))
    );

    return c.json({ id: Number(newId) }, 201);
});

/**
 * PUT /api/blog/:id
 * 블로그 포스트 수정 (관리자 전용)
 * Body: { title?: string, content?: string }
 */
blog.put('/blog/:id', requireAdmin, async (c) => {
    const db = c.env.DB;
    const user = c.get('user')!;

    const idParam = c.req.param('id');
    if (!/^\d+$/.test(idParam)) return c.json({ error: 'Not Found' }, 404);
    const id = Number(idParam);

    const existing = await db
        .prepare('SELECT id, title FROM blog_posts WHERE id = ? AND deleted_at IS NULL')
        .bind(id)
        .first<{ id: number; title: string }>();
    if (!existing) return c.json({ error: 'Not Found' }, 404);

    let body: { title?: unknown; content?: unknown };
    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (body.title !== undefined && typeof body.title !== 'string') {
        return c.json({ error: 'title은 문자열이어야 합니다.' }, 400);
    }
    if (body.content !== undefined && typeof body.content !== 'string') {
        return c.json({ error: 'content는 문자열이어야 합니다.' }, 400);
    }

    const title = typeof body.title === 'string' ? body.title.trim() : existing.title;
    if (!title) return c.json({ error: '제목을 입력해주세요.' }, 400);
    if (title.length > 500) return c.json({ error: '제목은 500자 이내여야 합니다.' }, 400);

    const content = typeof body.content === 'string'
        ? body.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        : undefined;

    if (content !== undefined) {
        const rows = content ? content.split('\n').length : 0;
        const characters = content ? content.length : 0;
        const thumbnail = extractFirstThumbnail(content);

        await db.prepare(
            'UPDATE blog_posts SET title = ?, content = ?, rows = ?, characters = ?, thumbnail = ?, updated_at = unixepoch() WHERE id = ?'
        ).bind(title, content, rows, characters, thumbnail, id).run();

        c.executionCtx.waitUntil(rebuildBlogImageLinks(db, id, content));
    } else {
        await db.prepare(
            'UPDATE blog_posts SET title = ?, updated_at = unixepoch() WHERE id = ?'
        ).bind(title, id).run();
    }

    // admin_log
    c.executionCtx.waitUntil(
        db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
            .bind('blog_update', `블로그 수정: ${title}`, user.id)
            .run()
            .catch((e: any) => console.error('Failed to write admin_log for blog_update:', e))
    );

    return c.json({ id });
});

/**
 * DELETE /api/blog/:id
 * 소프트 삭제 (관리자 전용)
 */
blog.delete('/blog/:id', requireAdmin, async (c) => {
    const db = c.env.DB;
    const user = c.get('user')!;

    const idParam = c.req.param('id');
    if (!/^\d+$/.test(idParam)) return c.json({ error: 'Not Found' }, 404);
    const id = Number(idParam);

    const existing = await db
        .prepare('SELECT id, title, deleted_at FROM blog_posts WHERE id = ?')
        .bind(id)
        .first<{ id: number; title: string; deleted_at: number | null }>();
    if (!existing) return c.json({ error: 'Not Found' }, 404);
    if (existing.deleted_at) return c.json({ error: '이미 삭제된 포스트입니다.' }, 400);

    await db.prepare(
        'UPDATE blog_posts SET deleted_at = unixepoch() WHERE id = ?'
    ).bind(id).run();

    // 역링크 정리 (blog=1 로 분리 — legacy 호환)
    c.executionCtx.waitUntil(
        db.prepare('DELETE FROM page_links WHERE source_page_id = ? AND blog = 1')
            .bind(id)
            .run()
            .catch((e: any) => console.error('Failed to cleanup blog page_links:', e))
    );

    // admin_log
    c.executionCtx.waitUntil(
        db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
            .bind('blog_delete', `블로그 삭제: ${existing.title}`, user.id)
            .run()
            .catch((e: any) => console.error('Failed to write admin_log for blog_delete:', e))
    );

    // 공지로 발행되어 있던 포스트가 삭제되면 해당 공지도 자동 제거
    c.executionCtx.waitUntil(
        removeAnnouncementByPostId(db, id)
            .catch((e: any) => console.error('Failed to clear announcement on delete:', e))
    );

    return c.json({ id });
});

/**
 * POST /api/blog/announcement/cancel
 * Body: { postId?: number }
 *  - postId 가 주어지면 해당 포스트와 연동된 공지 항목만 제거 (블로그 페이지 "공지 취소" 버튼).
 *  - postId 가 없으면 블로그 포스트 연동 공지 전부 제거 (기존 단일 공지 시절 호환).
 *
 * NOTE: `:id` 파라미터 라우트(`/blog/:id`, `/blog/:id/announce`)와의 충돌을 피하기 위해
 *       정적 세그먼트 두 개로 구성된 경로를 사용한다.
 */
blog.post('/blog/announcement/cancel', requireAdmin, async (c) => {
    const body = await c.req.json<{ postId?: number }>().catch(() => ({} as { postId?: number }));
    const db = c.env.DB;
    const filterPostId = typeof body.postId === 'number' && Number.isInteger(body.postId)
        ? body.postId
        : null;
    const logSuffix = filterPostId !== null ? ` (blog#${filterPostId})` : '';
    try {
        await mutateAnnouncements(db, (ctx) => {
            const next: Announcement[] = filterPostId !== null
                ? ctx.list.filter(a => a.postId !== filterPostId)
                : ctx.list.filter(a => a.postId === null);
            if (next.length === ctx.list.length) return null;
            return next;
        });
    } catch (e) {
        if (e instanceof AnnouncementMutationError) return c.json({ error: e.message }, 503);
        throw e;
    }
    writeAdminLog(c, 'announce', `공지 취소${logSuffix}`, c.get('user')!.id);
    return c.json({ success: true });
});

/**
 * POST /api/blog/:id/announce
 * 해당 블로그 포스트를 사이트 전역 공지로 발행 (관리자 전용)
 * Body: { title: string, icon?: string|null }
 *  - 동일 postId 가 이미 목록에 있으면 409 Conflict.
 *  - 새 공지는 목록 맨 위에 prepend, 새 id 발급, announcedTime = 현재 시각.
 *  - Discord community 채널에 알림 발송.
 */
blog.post('/blog/:id/announce', requireAdmin, async (c) => {
    const idParam = c.req.param('id');
    if (!/^\d+$/.test(idParam)) return c.json({ error: 'Not Found' }, 404);
    const id = Number(idParam);

    const body = await c.req.json<{ title?: unknown; icon?: unknown }>().catch(() => ({} as any));
    if (typeof body.title !== 'string') {
        return c.json({ error: '제목은 문자열이어야 합니다.' }, 400);
    }
    const title = body.title.trim();
    if (!title) return c.json({ error: '제목을 입력하세요.' }, 400);
    if (title.length > 200) return c.json({ error: '제목은 200자 이하여야 합니다.' }, 400);

    let icon: string | null = null;
    if (typeof body.icon === 'string' && body.icon.trim()) {
        if (!/^(mdi mdi-[a-z0-9-]+|bi bi-[a-z0-9-]+)$/.test(body.icon)) {
            return c.json({ error: '아이콘 형식이 올바르지 않습니다.' }, 400);
        }
        icon = body.icon;
    }

    const post = await c.env.DB
        .prepare('SELECT id, title, content, thumbnail, deleted_at FROM blog_posts WHERE id = ?')
        .bind(id)
        .first<{ id: number; title: string; content: string; thumbnail: string | null; deleted_at: number | null }>();
    if (!post || post.deleted_at) return c.json({ error: 'Not Found' }, 404);

    const db = c.env.DB;
    let conflict = false;
    let annId = 0;
    try {
        await mutateAnnouncements(db, (ctx) => {
            if (ctx.list.some(a => a.postId === id)) {
                conflict = true;
                return null;
            }
            annId = ctx.allocateId();
            const now = Math.floor(Date.now() / 1000);
            const newItem: Announcement = { id: annId, title, announcedTime: now, url: null, postId: id, icon };
            return [newItem, ...ctx.list];
        });
    } catch (e) {
        if (e instanceof AnnouncementMutationError) return c.json({ error: e.message }, 503);
        throw e;
    }
    if (conflict) {
        return c.json({ error: '해당 포스트는 이미 공지로 발행되어 있습니다.' }, 409);
    }

    const currentUser = c.get('user')!;
    writeAdminLog(c, 'announce', `공지 발행: blog#${id} "${title}"`, currentUser.id);

    dispatchDiscord(c.env, c.executionCtx, announcementPublish({
        postId: id,
        announceTitle: title,
        postContent: post.content,
        thumbnail: post.thumbnail,
        actorName: currentUser.name,
        env: c.env,
    }));

    return c.json({ success: true, post_id: id, title, id: annId });
});

export default blog;
