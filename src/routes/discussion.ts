import { Hono } from 'hono';
import type { Env, Discussion, DiscussionComment } from '../types';
import { requireAuth } from '../middleware/session';
import { safeJSON } from '../utils/json';
import { ROLE_CASE_SQL, enrichRoles, enrichRole } from '../utils/role';

const discussionRoutes = new Hono<Env>();

// ── 역할 계층 헬퍼 ──
function roleLevel(role: string): number {
    switch (role) {
        case 'super_admin': return 4;
        case 'admin': return 3;
        case 'discussion_manager': return 2;
        case 'user': return 1;
        default: return 0;
    }
}

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
discussionRoutes.post('/discussions/:pageId', requireAuth, async (c) => {
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

    // 문서 존재 확인
    const page = await db.prepare('SELECT id FROM pages WHERE id = ? AND deleted_at IS NULL').bind(pageId).first();
    if (!page) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    // 토론 생성
    const discussionResult = await db.prepare(
        'INSERT INTO discussions (page_id, title, author_id) VALUES (?, ?, ?)'
    ).bind(pageId, title.trim(), user.id).run();

    const discussionId = discussionResult.meta.last_row_id;

    // 첫 번째 댓글 자동 생성 (토론 본문)
    await db.prepare(
        'INSERT INTO discussion_comments (discussion_id, author_id, content) VALUES (?, ?, ?)'
    ).bind(discussionId, user.id, content.trim()).run();

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

    // soft delete된 토론은 admin 이상만 볼 수 있음
    if (discussion.deleted_at && (!user || roleLevel(user.role) < 3)) {
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
discussionRoutes.post('/discussions/thread/:id/comments', requireAuth, async (c) => {
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

            const link = `/wiki/${encodeURIComponent(discussionInfo.slug)}/discussions/${discussionId}`;
            const notifContent = `'${discussionInfo.title}' 토론에 새 댓글이 달렸습니다.`;

            const batchStmts = participants.map(p => 
                db.prepare('INSERT INTO notifications (user_id, type, content, link) VALUES (?, ?, ?, ?)')
                  .bind(p.author_id, 'discussion_comment', notifContent, link)
            );

            if (batchStmts.length > 0) {
                await db.batch(batchStmts);
            }
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
    const hasManagerRole = roleLevel(user.role) >= 2; // discussion_manager 이상

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
                const link = `/wiki/${encodeURIComponent(info.slug)}/discussions/${discussionId}`;
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
 * 토론 소프트 삭제 (admin 이상)
 */
discussionRoutes.delete('/discussions/thread/:id', requireAuth, async (c) => {
    const discussionId = Number(c.req.param('id'));
    const user = c.get('user')!;
    const db = c.env.DB;

    if (roleLevel(user.role) < 3) { // admin 이상만
        return c.json({ error: '관리자 권한이 필요합니다.' }, 403);
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
            const link = `/wiki/${encodeURIComponent(info.slug)}/discussions/${discussionId}`;
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
    const db = c.env.DB;

    if (user.role !== 'super_admin') {
        return c.json({ error: '최고 관리자만 완전 삭제할 수 있습니다.' }, 403);
    }

    // 삭제 전 알림 링크 확보 (삭제 후에는 조회 불가)
    const discussionPageInfo = await db.prepare(
        'SELECT p.slug FROM discussions d LEFT JOIN pages p ON d.page_id = p.id WHERE d.id = ?'
    ).bind(discussionId).first<{ slug: string | null }>();

    // 댓글 먼저 삭제 후 토론 삭제
    await db.prepare('DELETE FROM discussion_comments WHERE discussion_id = ?').bind(discussionId).run();
    const result = await db.prepare('DELETE FROM discussions WHERE id = ?').bind(discussionId).run();

    if (result.meta.changes === 0) {
        return c.json({ error: '토론을 찾을 수 없습니다.' }, 404);
    }

    // 관련 알림 정리
    if (discussionPageInfo?.slug) {
        try {
            const link = `/wiki/${encodeURIComponent(discussionPageInfo.slug)}/discussions/${discussionId}`;
            await db.prepare("DELETE FROM notifications WHERE link = ? AND type != 'message'").bind(link).run();
        } catch (e) {
            console.error('Failed to clear discussion notifications on hard delete:', e);
        }
    }

    return c.json({ success: true });
});

/**
 * DELETE /api/discussions/comment/:id
 * 댓글 소프트 삭제 (admin 이상)
 */
discussionRoutes.delete('/discussions/comment/:id', requireAuth, async (c) => {
    const commentId = Number(c.req.param('id'));
    const user = c.get('user')!;
    const db = c.env.DB;

    if (roleLevel(user.role) < 3) {
        return c.json({ error: '관리자 권한이 필요합니다.' }, 403);
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
    const db = c.env.DB;

    if (user.role !== 'super_admin') {
        return c.json({ error: '최고 관리자만 완전 삭제할 수 있습니다.' }, 403);
    }

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
