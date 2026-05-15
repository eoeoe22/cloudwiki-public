import { Hono } from 'hono';
import type { Env, Discussion, DiscussionComment } from '../types';
import { requireAuth, requireAuthAllowBanned, requirePermission } from '../middleware/session';
import { safeJSON } from '../utils/json';
import { ROLE_CASE_SQL, enrichRoles, enrichRole, RBAC } from '../utils/role';
import { dispatchDiscord } from '../utils/webhook/discord';
import { discussionCreate } from '../utils/webhook/events/discussion';
import { isR2OnlyNamespace } from '../utils/slug';
import { createNotifications } from '../utils/notification';
import { extractImageLinks } from '../utils/extractImageLinks';

/** 토론 댓글 본문에서 이미지 r2 키를 추출해 page_links 에 INSERT.
 *  관리자 미디어 GC 가 토론에서만 쓰이는 이미지를 미사용으로 오인 삭제하지 않도록 보호한다.
 *  실패는 본문 작성 흐름을 막지 않고 콘솔에 로그만 남긴다. */
async function indexCommentImages(db: D1Database, commentId: number, content: string): Promise<void> {
    try {
        const keys = extractImageLinks(content);
        if (keys.length === 0) return;
        const stmts = keys.map(k =>
            db.prepare(
                `INSERT INTO page_links (source_page_id, target_slug, link_type, blog, source_type)
                 VALUES (?, ?, 'image', 0, 'discussion_comment')`
            ).bind(commentId, k)
        );
        await db.batch(stmts);
    } catch (e) {
        console.error('Failed to index discussion comment images:', e);
    }
}

const discussionRoutes = new Hono<Env>();

/**
 * GET /api/me/discussions
 * 현재 유저가 생성한 토론 목록 (최신순)
 */
discussionRoutes.get('/me/discussions', requireAuth, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;
    const offset = Number(c.req.query('offset')) || 0;
    const limit = Number(c.req.query('limit')) || 10;

    const { results } = await db.prepare(`
        SELECT d.id, d.title, d.status, d.created_at, d.updated_at,
               p.slug as page_slug, p.id as page_id,
               (SELECT COUNT(*) FROM discussion_comments dc
                WHERE dc.discussion_id = d.id AND dc.deleted_at IS NULL) as comment_count
        FROM discussions d
        LEFT JOIN pages p ON d.page_id = p.id
        WHERE d.author_id = ? AND d.deleted_at IS NULL
        ORDER BY d.updated_at DESC
        LIMIT ? OFFSET ?
    `).bind(user.id, limit + 1, offset).all();

    const has_more = results.length > limit;
    const discussions = results.slice(0, limit);

    return c.json(safeJSON({ discussions, has_more }));
});

/**
 * GET /api/discussions/:pageId
 * 문서의 토론 목록 (soft deleted 제외)
 */
discussionRoutes.get('/discussions/:pageId', async (c) => {
    const pageId = Number(c.req.param('pageId'));
    const db = c.env.DB;
    const status = c.req.query('status'); // 'open' | 'closed' | undefined (all)

    let query = `
        SELECT d.*, u.name as author_name, u.picture as author_picture,
               ${ROLE_CASE_SQL} as author_role,
               u.email as _author_email,
               (SELECT COUNT(*) FROM discussion_comments dc WHERE dc.discussion_id = d.id AND dc.deleted_at IS NULL) as comment_count
        FROM discussions d
        LEFT JOIN users u ON d.author_id = u.id
        WHERE d.page_id = ? AND d.deleted_at IS NULL
    `;
    const params: any[] = [pageId];

    if (status === 'open' || status === 'closed') {
        query += ' AND d.status = ?';
        params.push(status);
    }

    query += ' ORDER BY d.updated_at DESC';

    const { results } = await db.prepare(query).bind(...params).all();
    enrichRoles(results, 'author_role', '_author_email', c.env);
    return c.json(safeJSON({ discussions: results }));
});

/**
 * POST /api/discussions/:pageId
 * 새 토론 생성 (로그인 필수, 차단되지 않은 사용자)
 */
discussionRoutes.post('/discussions/:pageId', requireAuth, requirePermission('comment:create'), async (c) => {
    const pageId = Number(c.req.param('pageId'));
    const user = c.get('user')!;
    const db = c.env.DB;
    const { title, content } = await c.req.json<{ title: string; content: string }>();

    if (!title || !title.trim()) {
        return c.json({ error: '토론 제목을 입력해주세요.' }, 400);
    }
    if (!content || !content.trim()) {
        return c.json({ error: '토론 내용을 입력해주세요.' }, 400);
    }

    // 문서 존재 확인 (slug + is_locked 도 가져와서 webhook 필터에 사용)
    const page = await db
        .prepare('SELECT id, slug, is_locked FROM pages WHERE id = ? AND deleted_at IS NULL')
        .bind(pageId)
        .first<{ id: number; slug: string; is_locked: number }>();
    if (!page) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    // 토론 생성
    const discussionResult = await db.prepare(
        'INSERT INTO discussions (page_id, title, author_id) VALUES (?, ?, ?)'
    ).bind(pageId, title.trim(), user.id).run();

    const discussionId = discussionResult.meta.last_row_id;

    // 첫 번째 댓글 자동 생성 (토론 본문)
    const firstCommentResult = await db.prepare(
        'INSERT INTO discussion_comments (discussion_id, author_id, content) VALUES (?, ?, ?)'
    ).bind(discussionId, user.id, content.trim()).run();

    // 본문 이미지를 page_links 에 색인 (미디어 GC 보호)
    await indexCommentImages(db, Number(firstCommentResult.meta.last_row_id), content.trim());

    // Discord community 채널에 신규 토론 알림 (잠금 페이지 / R2 전용 ns 는 제외)
    const enabledExtensions = (c.env.ENABLED_EXTENSIONS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!page.is_locked && !isR2OnlyNamespace(page.slug, enabledExtensions)) {
        dispatchDiscord(c.env, c.executionCtx, discussionCreate({
            page: { slug: page.slug, title: page.slug },
            discussion: { id: Number(discussionId), title: title.trim() },
            actor: { name: user.name, picture: user.picture },
            env: c.env,
        }));
    }

    return c.json(safeJSON({ id: discussionId, title: title.trim() }), 201);
});

/**
 * GET /api/discussions/thread/:id
 * 토론 상세 + 댓글 목록
 */
discussionRoutes.get('/discussions/thread/:id', async (c) => {
    const discussionId = Number(c.req.param('id'));
    const db = c.env.DB;
    const user = c.get('user');

    // 토론 정보
    const discussion = await db.prepare(`
        SELECT d.*, u.name as author_name, u.picture as author_picture,
               ${ROLE_CASE_SQL} as author_role,
               u.email as _author_email
        FROM discussions d
        LEFT JOIN users u ON d.author_id = u.id
        WHERE d.id = ?
    `).bind(discussionId).first();

    if (!discussion) {
        return c.json({ error: '토론을 찾을 수 없습니다.' }, 404);
    }

    const rbac = c.get('rbac') as RBAC;

    // soft delete된 토론은 admin 이상만 볼 수 있음
    if (discussion.deleted_at && (!user || !rbac.can(user.role, 'admin:access'))) {
        return c.json({ error: '삭제된 토론입니다.' }, 404);
    }

    enrichRole(discussion, 'author_role', '_author_email', c.env);

    // 댓글 목록 (soft deleted 포함하되 표시 처리)
    const { results: comments } = await db.prepare(`
        SELECT dc.*, u.name as author_name, u.picture as author_picture,
               CASE
                   WHEN u.banned_until IS NOT NULL AND u.banned_until > unixepoch() THEN 'banned'
                   WHEN u.role = 'banned' AND (u.banned_until IS NULL OR u.banned_until <= unixepoch()) THEN 'user'
                   ELSE u.role END as author_role,
               u.email as _author_email,
               parent.content as quoted_content, pu.name as quoted_author_name,
               CASE
                   WHEN pu.banned_until IS NOT NULL AND pu.banned_until > unixepoch() THEN 'banned'
                   WHEN pu.role = 'banned' AND (pu.banned_until IS NULL OR pu.banned_until <= unixepoch()) THEN 'user'
                   ELSE pu.role END as quoted_author_role,
               pu.email as _quoted_author_email
        FROM discussion_comments dc
        LEFT JOIN users u ON dc.author_id = u.id
        LEFT JOIN discussion_comments parent ON dc.parent_id = parent.id
        LEFT JOIN users pu ON parent.author_id = pu.id
        WHERE dc.discussion_id = ?
        ORDER BY dc.created_at ASC
    `).bind(discussionId).all();

    enrichRoles(comments, 'author_role', '_author_email', c.env);
    enrichRoles(comments, 'quoted_author_role', '_quoted_author_email', c.env);

    return c.json(safeJSON({ discussion, comments }));
});

/**
 * POST /api/discussions/thread/:id/comments
 * 댓글/답글 작성 (로그인 필수)
 */
discussionRoutes.post('/discussions/thread/:id/comments', requireAuth, requirePermission('comment:create'), async (c) => {
    const discussionId = Number(c.req.param('id'));
    const user = c.get('user')!;
    const db = c.env.DB;
    const { content, parent_id } = await c.req.json<{ content: string; parent_id?: number }>();

    if (!content || !content.trim()) {
        return c.json({ error: '댓글 내용을 입력해주세요.' }, 400);
    }

    // 토론 존재 확인 + open 상태 확인
    const discussion = await db.prepare(
        'SELECT id, status, deleted_at FROM discussions WHERE id = ?'
    ).bind(discussionId).first<Discussion>();

    if (!discussion || discussion.deleted_at) {
        return c.json({ error: '토론을 찾을 수 없습니다.' }, 404);
    }
    if (discussion.status === 'closed') {
        return c.json({ error: '닫힌 토론에는 댓글을 작성할 수 없습니다.' }, 403);
    }

    // parent_id 유효성 확인
    if (parent_id) {
        const parentComment = await db.prepare(
            'SELECT id FROM discussion_comments WHERE id = ? AND discussion_id = ?'
        ).bind(parent_id, discussionId).first();
        if (!parentComment) {
            return c.json({ error: '원본 댓글을 찾을 수 없습니다.' }, 404);
        }
    }

    // 댓글 삽입
    const result = await db.prepare(
        'INSERT INTO discussion_comments (discussion_id, author_id, content, parent_id) VALUES (?, ?, ?, ?)'
    ).bind(discussionId, user.id, content.trim(), parent_id ?? null).run();

    // 댓글 이미지 색인 (미디어 GC 보호)
    await indexCommentImages(db, Number(result.meta.last_row_id), content.trim());

    // 토론 updated_at 갱신
    await db.prepare(
        'UPDATE discussions SET updated_at = unixepoch() WHERE id = ?'
    ).bind(discussionId).run();

    // 토론 참여자에게 알림 생성 (작성자 본인 제외)
    try {
        const discussionInfo = await db.prepare(
            'SELECT d.title, d.page_id, p.slug FROM discussions d LEFT JOIN pages p ON d.page_id = p.id WHERE d.id = ?'
        ).bind(discussionId).first<{ title: string; page_id: number; slug: string }>();

        if (discussionInfo) {
            // 이 토론에 댓글을 달았던 모든 유저 (작성자 + 댓글 작성자, 중복 제거, 본인 제외, 개별 토론 뮤트 유저 제외)
            const { results: participants } = await db.prepare(`
                SELECT DISTINCT p.author_id FROM (
                    SELECT author_id FROM discussions WHERE id = ? AND author_id IS NOT NULL
                    UNION
                    SELECT author_id FROM discussion_comments WHERE discussion_id = ? AND author_id IS NOT NULL AND deleted_at IS NULL
                ) p
                WHERE p.author_id != ?
                  AND p.author_id NOT IN (SELECT user_id FROM discussion_mutes WHERE discussion_id = ?)
            `).bind(discussionId, discussionId, user.id, discussionId).all<{ author_id: number }>();

            const link = `/w/${encodeURIComponent(discussionInfo.slug)}?mode=discussions&id=${discussionId}`;
            const notifContent = `'${discussionInfo.title}' 토론에 새 댓글이 달렸습니다.`;

            await createNotifications(c.env, c.executionCtx, participants.map(p => ({
                userId: p.author_id,
                type: 'discussion_comment',
                content: notifContent,
                link,
                push: {
                    title: discussionInfo.title,
                    body: notifContent,
                    url: link,
                    tag: `discussion:${discussionId}`,
                },
            })));
        }
    } catch (e) {
        console.error('Failed to create discussion notifications:', e);
    }

    return c.json(safeJSON({ id: result.meta.last_row_id }), 201);
});

/**
 * PUT /api/discussions/thread/:id/status
 * 토론 상태 변경 (open ↔ closed)
 * 허용: 토론 생성자 또는 discussion_manager 이상
 */
discussionRoutes.put('/discussions/thread/:id/status', requireAuth, async (c) => {
    const discussionId = Number(c.req.param('id'));
    const user = c.get('user')!;
    const db = c.env.DB;
    const { status } = await c.req.json<{ status: 'open' | 'closed' }>();

    if (status !== 'open' && status !== 'closed') {
        return c.json({ error: '올바른 상태값이 아닙니다.' }, 400);
    }

    const discussion = await db.prepare(
        'SELECT id, author_id, deleted_at FROM discussions WHERE id = ?'
    ).bind(discussionId).first<Discussion>();

    if (!discussion || discussion.deleted_at) {
        return c.json({ error: '토론을 찾을 수 없습니다.' }, 404);
    }

    // 권한 확인: 토론 생성자 또는 discussion_manager 이상
    const isAuthor = discussion.author_id === user.id;
    const rbac = c.get('rbac') as RBAC;
    const hasManagerRole = rbac.can(user.role, 'discussion:manage');

    if (!isAuthor && !hasManagerRole) {
        return c.json({ error: '토론 상태를 변경할 권한이 없습니다.' }, 403);
    }

    await db.prepare(
        'UPDATE discussions SET status = ?, updated_at = unixepoch() WHERE id = ?'
    ).bind(status, discussionId).run();

    // 토론 닫힐 때 관련 알림 정리
    if (status === 'closed') {
        try {
            const info = await db.prepare(
                'SELECT p.slug FROM discussions d LEFT JOIN pages p ON d.page_id = p.id WHERE d.id = ?'
            ).bind(discussionId).first<{ slug: string | null }>();
            if (info?.slug) {
                const link = `/w/${encodeURIComponent(info.slug)}?mode=discussions&id=${discussionId}`;
                await db.prepare("DELETE FROM notifications WHERE link = ? AND type != 'message'").bind(link).run();
            }
        } catch (e) {
            console.error('Failed to clear discussion notifications on close:', e);
        }
    }

    return c.json({ success: true, status });
});

/**
 * DELETE /api/discussions/thread/:id
 * 토론 소프트 삭제 (discussion:manage 권한 필요)
 */
discussionRoutes.delete('/discussions/thread/:id', requireAuth, async (c) => {
    const discussionId = Number(c.req.param('id'));
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;

    if (!rbac.can(user.role, 'discussion:manage')) {
        return c.json({ error: '권한이 부족합니다.' }, 403);
    }

    const discussion = await db.prepare(
        'SELECT id, deleted_at FROM discussions WHERE id = ?'
    ).bind(discussionId).first<Discussion>();

    if (!discussion) {
        return c.json({ error: '토론을 찾을 수 없습니다.' }, 404);
    }

    if (discussion.deleted_at) {
        return c.json({ error: '이미 삭제된 토론입니다.' }, 400);
    }

    await db.prepare(
        'UPDATE discussions SET deleted_at = unixepoch() WHERE id = ?'
    ).bind(discussionId).run();

    // 토론 삭제 시 관련 알림 정리
    try {
        const info = await db.prepare(
            'SELECT p.slug FROM discussions d LEFT JOIN pages p ON d.page_id = p.id WHERE d.id = ?'
        ).bind(discussionId).first<{ slug: string | null }>();
        if (info?.slug) {
            const link = `/w/${encodeURIComponent(info.slug)}?mode=discussions&id=${discussionId}`;
            await db.prepare("DELETE FROM notifications WHERE link = ? AND type != 'message'").bind(link).run();
        }
    } catch (e) {
        console.error('Failed to clear discussion notifications on delete:', e);
    }

    return c.json({ success: true });
});

/**
 * DELETE /api/discussions/thread/:id/hard
 * 토론 완전 삭제 (super_admin만)
 */
discussionRoutes.delete('/discussions/thread/:id/hard', requireAuth, async (c) => {
    const discussionId = Number(c.req.param('id'));
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;

    if (!rbac.can(user.role, '*')) {
        return c.json({ error: '최고 관리자만 완전 삭제할 수 있습니다.' }, 403);
    }

    // 삭제 전 알림 링크 확보 (삭제 후에는 조회 불가)
    const discussionPageInfo = await db.prepare(
        'SELECT p.slug FROM discussions d LEFT JOIN pages p ON d.page_id = p.id WHERE d.id = ?'
    ).bind(discussionId).first<{ slug: string | null }>();

    // 이 토론의 모든 댓글에 매달린 page_links 를 먼저 정리한다 (이미지 역링크).
    // discussion_comments DELETE 전에 수행해야 source_page_id 매칭이 가능.
    await db.prepare(
        `DELETE FROM page_links
         WHERE source_type = 'discussion_comment'
           AND source_page_id IN (SELECT id FROM discussion_comments WHERE discussion_id = ?)`
    ).bind(discussionId).run();

    // 댓글 먼저 삭제 후 토론 삭제
    await db.prepare('DELETE FROM discussion_comments WHERE discussion_id = ?').bind(discussionId).run();
    const result = await db.prepare('DELETE FROM discussions WHERE id = ?').bind(discussionId).run();

    if (result.meta.changes === 0) {
        return c.json({ error: '토론을 찾을 수 없습니다.' }, 404);
    }

    // 관련 알림 정리
    if (discussionPageInfo?.slug) {
        try {
            const link = `/w/${encodeURIComponent(discussionPageInfo.slug)}?mode=discussions&id=${discussionId}`;
            await db.prepare("DELETE FROM notifications WHERE link = ? AND type != 'message'").bind(link).run();
        } catch (e) {
            console.error('Failed to clear discussion notifications on hard delete:', e);
        }
    }

    return c.json({ success: true });
});

/**
 * DELETE /api/discussions/comment/:id
 * 댓글 소프트 삭제 (discussion:manage 권한 필요)
 */
discussionRoutes.delete('/discussions/comment/:id', requireAuth, async (c) => {
    const commentId = Number(c.req.param('id'));
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;

    if (!rbac.can(user.role, 'discussion:manage')) {
        return c.json({ error: '권한이 부족합니다.' }, 403);
    }

    const comment = await db.prepare(
        'SELECT id, deleted_at FROM discussion_comments WHERE id = ?'
    ).bind(commentId).first<DiscussionComment>();

    if (!comment) {
        return c.json({ error: '댓글을 찾을 수 없습니다.' }, 404);
    }

    if (comment.deleted_at) {
        return c.json({ error: '이미 삭제된 댓글입니다.' }, 400);
    }

    await db.prepare(
        'UPDATE discussion_comments SET deleted_at = unixepoch() WHERE id = ?'
    ).bind(commentId).run();

    return c.json({ success: true });
});

/**
 * DELETE /api/discussions/comment/:id/hard
 * 댓글 완전 삭제 (super_admin만)
 */
discussionRoutes.delete('/discussions/comment/:id/hard', requireAuth, async (c) => {
    const commentId = Number(c.req.param('id'));
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;

    if (!rbac.can(user.role, '*')) {
        return c.json({ error: '최고 관리자만 완전 삭제할 수 있습니다.' }, 403);
    }

    // 이 댓글에 매달린 page_links 정리 (이미지 역링크)
    await db.prepare(
        "DELETE FROM page_links WHERE source_type = 'discussion_comment' AND source_page_id = ?"
    ).bind(commentId).run();

    const result = await db.prepare('DELETE FROM discussion_comments WHERE id = ?').bind(commentId).run();

    if (result.meta.changes === 0) {
        return c.json({ error: '댓글을 찾을 수 없습니다.' }, 404);
    }

    return c.json({ success: true });
});

/**
 * GET /api/discussions/thread/:id/mute
 * 현재 유저의 해당 토론 알림 뮤트 상태 조회
 */
discussionRoutes.get('/discussions/thread/:id/mute', requireAuth, async (c) => {
    const discussionId = Number(c.req.param('id'));
    const user = c.get('user')!;
    const db = c.env.DB;

    const row = await db.prepare(
        'SELECT 1 FROM discussion_mutes WHERE user_id = ? AND discussion_id = ?'
    ).bind(user.id, discussionId).first();

    return c.json({ muted: !!row });
});

/**
 * POST /api/discussions/thread/:id/mute
 * 해당 토론의 알림 뮤트 토글
 */
discussionRoutes.post('/discussions/thread/:id/mute', requireAuth, async (c) => {
    const discussionId = Number(c.req.param('id'));
    const user = c.get('user')!;
    const db = c.env.DB;

    const existing = await db.prepare(
        'SELECT 1 FROM discussion_mutes WHERE user_id = ? AND discussion_id = ?'
    ).bind(user.id, discussionId).first();

    if (existing) {
        await db.prepare(
            'DELETE FROM discussion_mutes WHERE user_id = ? AND discussion_id = ?'
        ).bind(user.id, discussionId).run();
        return c.json({ muted: false });
    } else {
        await db.prepare(
            'INSERT INTO discussion_mutes (user_id, discussion_id) VALUES (?, ?)'
        ).bind(user.id, discussionId).run();
        return c.json({ muted: true });
    }
});

export default discussionRoutes;
