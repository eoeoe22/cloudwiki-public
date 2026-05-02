import { Hono } from 'hono';
import type { Env, BlogPost } from '../types';
import { requireAdmin } from '../middleware/session';
import { safeJSON } from '../utils/json';
import { RBAC } from '../utils/role';
import { writeAdminLog } from './admin';

const blog = new Hono<Env>();

/**
 * 블로그 본문에서 이미지 R2 키(`images/...`) 를 추출해 target_slug 목록 반환.
 * 에디터는 마크다운 `![alt](/media/images/...)` 또는 HTML `<img src=".../images/...">`
 * 형태로 이미지를 삽입하므로 위키의 extractLinks() 와 동일한 정규식으로 추적한다.
 * 미디어 사용 여부 판정(admin.ts:702 의 unused media 체크 등)이 이 행에 의존하므로
 * 누락 시 사용 중인 블로그 이미지가 미사용으로 분류되어 삭제될 수 있다.
 */
function extractBlogImageLinks(content: string): string[] {
    const cleaned = content
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`\n]+`/g, '');

    const seen = new Set<string>();
    const imageRegex = /images\/[^\s\[\]()<>"'\\?#|^]+?\.\w+/g;
    for (const m of cleaned.matchAll(imageRegex)) {
        seen.add(m[0].trim());
    }
    return [...seen];
}

/** 블로그 포스트 저장 후 page_links 테이블의 이미지 역링크를 갱신 */
async function rebuildBlogImageLinks(db: D1Database, blogPostId: number, content: string): Promise<void> {
    const stmts: D1PreparedStatement[] = [
        db.prepare('DELETE FROM page_links WHERE source_page_id = ? AND blog = 1').bind(blogPostId),
    ];
    const imageLinks = extractBlogImageLinks(content);
    for (const targetSlug of imageLinks) {
        stmts.push(
            db.prepare(
                'INSERT INTO page_links (source_page_id, target_slug, link_type, blog) VALUES (?, ?, ?, 1)'
            ).bind(blogPostId, targetSlug, 'image')
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
            `SELECT id, title, created_at, updated_at, deleted_at, rows, characters
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

    return c.json(safeJSON(post));
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

    const result = await db
        .prepare(
            'INSERT INTO blog_posts (title, content, rows, characters) VALUES (?, ?, ?, ?)'
        )
        .bind(title, content, rows, characters)
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

        await db.prepare(
            'UPDATE blog_posts SET title = ?, content = ?, rows = ?, characters = ?, updated_at = unixepoch() WHERE id = ?'
        ).bind(title, content, rows, characters, id).run();

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

    // 역링크 정리
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

    // 공지로 발행되어 있던 포스트가 삭제되면 공지도 자동 해제
    c.executionCtx.waitUntil(
        db.prepare('UPDATE settings SET announced_blog_post_id = NULL WHERE id = 1 AND announced_blog_post_id = ?')
            .bind(id)
            .run()
            .catch((e: any) => console.error('Failed to clear announcement on delete:', e))
    );

    return c.json({ id });
});

/**
 * POST /api/blog/announcement/cancel
 * 현재 사이트 전역 공지 발행을 취소 (관리자 전용)
 *
 * NOTE: `:id` 파라미터 라우트(`/blog/:id`, `/blog/:id/announce`)와의 충돌을 피하기 위해
 *       정적 세그먼트 두 개로 구성된 경로를 사용한다.
 */
blog.post('/blog/announcement/cancel', requireAdmin, async (c) => {
    await c.env.DB.prepare('UPDATE settings SET announced_blog_post_id = NULL WHERE id = 1').run();
    writeAdminLog(c, 'announce', '공지 취소', c.get('user')!.id);
    return c.json({ success: true });
});

/**
 * POST /api/blog/:id/announce
 * 해당 블로그 포스트를 사이트 전역 공지로 발행 (관리자 전용)
 * 단일 행 settings 에 id를 기록하므로 이전 공지는 자동으로 대체된다.
 */
blog.post('/blog/:id/announce', requireAdmin, async (c) => {
    const idParam = c.req.param('id');
    if (!/^\d+$/.test(idParam)) return c.json({ error: 'Not Found' }, 404);
    const id = Number(idParam);

    const post = await c.env.DB
        .prepare('SELECT id, title, deleted_at FROM blog_posts WHERE id = ?')
        .bind(id)
        .first<{ id: number; title: string; deleted_at: number | null }>();
    if (!post || post.deleted_at) return c.json({ error: 'Not Found' }, 404);

    await c.env.DB
        .prepare('UPDATE settings SET announced_blog_post_id = ? WHERE id = 1')
        .bind(id)
        .run();
    writeAdminLog(c, 'announce', `공지 발행: blog#${id} (${post.title})`, c.get('user')!.id);
    return c.json({ success: true, post_id: id, title: post.title });
});

export default blog;
