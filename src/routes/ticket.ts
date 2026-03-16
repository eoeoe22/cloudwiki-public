import { Hono } from 'hono';
import type { Env, Ticket, TicketComment } from '../types';
import { requireAuth } from '../middleware/session';
import { safeJSON } from '../utils/json';
import { ROLE_CASE_SQL, enrichRoles, enrichRole } from '../utils/role';

const ticketRoutes = new Hono<Env>();

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

// ── 타입 라벨 ──
const typeLabels: Record<string, string> = {
    general: '일반',
    document: '문서',
    discussion: '토론',
    account: '계정',
};

// ── 접근 권한 확인 헬퍼 ──
function canAccessTicket(user: { id: number; role: string }, ticket: { user_id: number; type: string; deleted_at: number | null }): boolean {
    // soft deleted → admin 이상만
    if (ticket.deleted_at) {
        return roleLevel(user.role) >= 3;
    }
    // 티켓 작성자
    if (user.id === ticket.user_id) return true;
    // admin/super_admin
    if (roleLevel(user.role) >= 3) return true;
    // type=discussion → discussion_manager도 접근 가능
    if (ticket.type === 'discussion' && roleLevel(user.role) >= 2) return true;
    return false;
}

/**
 * GET /api/tickets
 * 티켓 목록 (일반 유저: 내 티켓만, 관리자: 전체)
 */
ticketRoutes.get('/tickets', requireAuth, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;
    const status = c.req.query('status');
    const type = c.req.query('type');
    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const limit = 20;
    const offset = (page - 1) * limit;

    const isAdmin = roleLevel(user.role) >= 3;
    const isDiscManager = roleLevel(user.role) >= 2;

    let query = `
        SELECT t.*, u.name as user_name, u.picture as user_picture,
               ${ROLE_CASE_SQL} as user_role,
               u.email as _user_email,
               (SELECT COUNT(*) FROM ticket_comments tc WHERE tc.ticket_id = t.id AND tc.deleted_at IS NULL) as comment_count
        FROM tickets t
        LEFT JOIN users u ON t.user_id = u.id
        WHERE 1=1
    `;
    let countQuery = `SELECT COUNT(*) as total FROM tickets t WHERE 1=1`;
    const params: any[] = [];
    const countParams: any[] = [];

    // 접근 범위 제한
    if (isAdmin) {
        // admin은 전체 (soft deleted 포함)
    } else if (isDiscManager) {
        // discussion_manager: 자기 티켓 + type=discussion 티켓 (deleted 제외)
        query += ` AND (t.user_id = ? OR t.type = 'discussion') AND t.deleted_at IS NULL`;
        countQuery += ` AND (t.user_id = ? OR t.type = 'discussion') AND t.deleted_at IS NULL`;
        params.push(user.id);
        countParams.push(user.id);
    } else {
        // 일반 유저: 자기 티켓만 (deleted 제외)
        query += ' AND t.user_id = ? AND t.deleted_at IS NULL';
        countQuery += ' AND t.user_id = ? AND t.deleted_at IS NULL';
        params.push(user.id);
        countParams.push(user.id);
    }

    if (status === 'open' || status === 'closed') {
        query += ' AND t.status = ?';
        countQuery += ' AND t.status = ?';
        params.push(status);
        countParams.push(status);
    }

    if (type && typeLabels[type]) {
        query += ' AND t.type = ?';
        countQuery += ' AND t.type = ?';
        params.push(type);
        countParams.push(type);
    }

    // 총 개수
    const totalRow = await db.prepare(countQuery).bind(...countParams).first<{ total: number }>();
    const total = totalRow?.total || 0;

    query += ' ORDER BY t.updated_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const { results } = await db.prepare(query).bind(...params).all();

    enrichRoles(results, 'user_role', '_user_email', c.env);

    return c.json(safeJSON({
        tickets: results,
        total,
        page,
        totalPages: Math.ceil(total / limit),
        hasMore: page * limit < total
    }));
});

/**
 * POST /api/tickets
 * 새 티켓 생성
 */
ticketRoutes.post('/tickets', requireAuth, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;
    const { title, content, type } = await c.req.json<{ title: string; content: string; type: string }>();

    if (!title || !title.trim()) {
        return c.json({ error: '티켓 제목을 입력해주세요.' }, 400);
    }
    if (!content || !content.trim()) {
        return c.json({ error: '문의 내용을 입력해주세요.' }, 400);
    }
    if (!type || !typeLabels[type]) {
        return c.json({ error: '올바른 문의 유형을 선택해주세요.' }, 400);
    }

    // 티켓 생성
    const ticketResult = await db.prepare(
        'INSERT INTO tickets (title, type, user_id) VALUES (?, ?, ?)'
    ).bind(title.trim(), type, user.id).run();

    const ticketId = ticketResult.meta.last_row_id;

    // 첫 번째 댓글 자동 생성 (문의 본문)
    await db.prepare(
        'INSERT INTO ticket_comments (ticket_id, author_id, content) VALUES (?, ?, ?)'
    ).bind(ticketId, user.id, content.trim()).run();

    // 해당하는 관리자에게 알림 발송
    try {
        let adminQuery = `SELECT id FROM users WHERE role IN ('admin', 'super_admin')`;
        if (type === 'discussion') {
            adminQuery = `SELECT id FROM users WHERE role IN ('admin', 'super_admin', 'discussion_manager')`;
        }
        const { results: admins } = await db.prepare(adminQuery).all<{ id: number }>();

        const link = `/tickets/${ticketId}`;
        const notifContent = `새 티켓 문의 [#${ticketId}] ${typeLabels[type]}: '${title.trim()}'`;

        const batchStmts = admins
            .filter(a => a.id !== user.id)
            .map(a =>
                db.prepare('INSERT INTO notifications (user_id, type, content, link) VALUES (?, ?, ?, ?)')
                    .bind(a.id, 'ticket_created', notifContent, link)
            );

        if (batchStmts.length > 0) {
            await db.batch(batchStmts);
        }
    } catch (e) {
        console.error('Failed to create ticket notifications:', e);
    }

    return c.json(safeJSON({ id: ticketId, title: title.trim() }), 201);
});

/**
 * GET /api/tickets/:id
 * 티켓 상세 + 댓글 목록
 */
ticketRoutes.get('/tickets/:id', requireAuth, async (c) => {
    const ticketId = Number(c.req.param('id'));
    const user = c.get('user')!;
    const db = c.env.DB;

    const ticket = await db.prepare(`
        SELECT t.*, u.name as user_name, u.picture as user_picture,
               ${ROLE_CASE_SQL} as user_role,
               u.email as _user_email
        FROM tickets t
        LEFT JOIN users u ON t.user_id = u.id
        WHERE t.id = ?
    `).bind(ticketId).first();

    if (!ticket) {
        return c.json({ error: '티켓을 찾을 수 없습니다.' }, 404);
    }

    // 접근 권한 확인
    if (!canAccessTicket(user, ticket as any)) {
        return c.json({ error: '접근 권한이 없습니다.' }, 403);
    }

    enrichRole(ticket, 'user_role', '_user_email', c.env);

    // 댓글 목록
    const { results: comments } = await db.prepare(`
        SELECT tc.*, u.name as author_name, u.picture as author_picture,
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
        FROM ticket_comments tc
        LEFT JOIN users u ON tc.author_id = u.id
        LEFT JOIN ticket_comments parent ON tc.parent_id = parent.id
        LEFT JOIN users pu ON parent.author_id = pu.id
        WHERE tc.ticket_id = ?
        ORDER BY tc.created_at ASC
    `).bind(ticketId).all();

    enrichRoles(comments, 'author_role', '_author_email', c.env);
    enrichRoles(comments, 'quoted_author_role', '_quoted_author_email', c.env);

    return c.json(safeJSON({ ticket, comments }));
});

/**
 * POST /api/tickets/:id/comments
 * 댓글 작성
 */
ticketRoutes.post('/tickets/:id/comments', requireAuth, async (c) => {
    const ticketId = Number(c.req.param('id'));
    const user = c.get('user')!;
    const db = c.env.DB;
    const { content, parent_id } = await c.req.json<{ content: string; parent_id?: number }>();

    if (!content || !content.trim()) {
        return c.json({ error: '댓글 내용을 입력해주세요.' }, 400);
    }

    const ticket = await db.prepare(
        'SELECT id, status, deleted_at, user_id, type, title FROM tickets WHERE id = ?'
    ).bind(ticketId).first<Ticket & { title: string }>();

    if (!ticket || ticket.deleted_at) {
        return c.json({ error: '티켓을 찾을 수 없습니다.' }, 404);
    }

    // 접근 권한 확인
    if (!canAccessTicket(user, ticket)) {
        return c.json({ error: '접근 권한이 없습니다.' }, 403);
    }

    if (ticket.status === 'closed') {
        return c.json({ error: '닫힌 티켓에는 댓글을 작성할 수 없습니다.' }, 403);
    }

    // parent_id 유효성 확인
    if (parent_id) {
        const parentComment = await db.prepare(
            'SELECT id FROM ticket_comments WHERE id = ? AND ticket_id = ?'
        ).bind(parent_id, ticketId).first();
        if (!parentComment) {
            return c.json({ error: '원본 댓글을 찾을 수 없습니다.' }, 404);
        }
    }

    // 댓글 삽입
    const result = await db.prepare(
        'INSERT INTO ticket_comments (ticket_id, author_id, content, parent_id) VALUES (?, ?, ?, ?)'
    ).bind(ticketId, user.id, content.trim(), parent_id ?? null).run();

    // 티켓 updated_at 갱신
    await db.prepare(
        'UPDATE tickets SET updated_at = unixepoch() WHERE id = ?'
    ).bind(ticketId).run();

    // 참여자에게 알림 생성
    try {
        const { results: participants } = await db.prepare(`
            SELECT DISTINCT author_id FROM (
                SELECT user_id as author_id FROM tickets WHERE id = ? AND user_id IS NOT NULL
                UNION
                SELECT author_id FROM ticket_comments WHERE ticket_id = ? AND author_id IS NOT NULL AND deleted_at IS NULL
            ) WHERE author_id != ?
        `).bind(ticketId, ticketId, user.id).all<{ author_id: number }>();

        // 참여자만 알림 (티켓 작성자 + 댓글 작성자)
        // 참여하지 않은 관리자는 티켓 생성 시 받은 알림만 수신
        const allRecipients = new Set<number>();
        participants.forEach(p => allRecipients.add(p.author_id));

        const link = `/tickets/${ticketId}`;
        const notifContent = `티켓 [#${ticketId}] '${ticket.title}'에 새 댓글이 달렸습니다.`;

        const batchStmts = Array.from(allRecipients).map(recipientId =>
            db.prepare('INSERT INTO notifications (user_id, type, content, link) VALUES (?, ?, ?, ?)')
                .bind(recipientId, 'ticket_comment', notifContent, link)
        );

        if (batchStmts.length > 0) {
            await db.batch(batchStmts);
        }
    } catch (e) {
        console.error('Failed to create ticket comment notifications:', e);
    }

    return c.json(safeJSON({ id: result.meta.last_row_id }), 201);
});

/**
 * PUT /api/tickets/:id/status
 * 티켓 상태 변경 (open ↔ closed)
 */
ticketRoutes.put('/tickets/:id/status', requireAuth, async (c) => {
    const ticketId = Number(c.req.param('id'));
    const user = c.get('user')!;
    const db = c.env.DB;
    const { status } = await c.req.json<{ status: 'open' | 'closed' }>();

    if (status !== 'open' && status !== 'closed') {
        return c.json({ error: '올바른 상태값이 아닙니다.' }, 400);
    }

    const ticket = await db.prepare(
        'SELECT id, user_id, deleted_at, type FROM tickets WHERE id = ?'
    ).bind(ticketId).first<Ticket>();

    if (!ticket || ticket.deleted_at) {
        return c.json({ error: '티켓을 찾을 수 없습니다.' }, 404);
    }

    // 권한: 티켓 작성자 또는 admin 이상
    const isAuthor = ticket.user_id === user.id;
    const isAdmin = roleLevel(user.role) >= 3;

    if (!isAuthor && !isAdmin) {
        return c.json({ error: '티켓 상태를 변경할 권한이 없습니다.' }, 403);
    }

    await db.prepare(
        'UPDATE tickets SET status = ?, updated_at = unixepoch() WHERE id = ?'
    ).bind(status, ticketId).run();

    // 티켓 닫힐 때 관련 알림 정리
    if (status === 'closed') {
        try {
            await db.prepare("DELETE FROM notifications WHERE link = ? AND type != 'message'")
                .bind(`/tickets/${ticketId}`).run();
        } catch (e) {
            console.error('Failed to clear ticket notifications on close:', e);
        }
    }

    return c.json({ success: true, status });
});

/**
 * DELETE /api/tickets/:id
 * 티켓 소프트 삭제 (admin 이상)
 */
ticketRoutes.delete('/tickets/:id', requireAuth, async (c) => {
    const ticketId = Number(c.req.param('id'));
    const user = c.get('user')!;
    const db = c.env.DB;

    if (roleLevel(user.role) < 3) {
        return c.json({ error: '관리자 권한이 필요합니다.' }, 403);
    }

    const ticket = await db.prepare(
        'SELECT id, deleted_at FROM tickets WHERE id = ?'
    ).bind(ticketId).first<Ticket>();

    if (!ticket) {
        return c.json({ error: '티켓을 찾을 수 없습니다.' }, 404);
    }

    if (ticket.deleted_at) {
        return c.json({ error: '이미 삭제된 티켓입니다.' }, 400);
    }

    await db.prepare(
        'UPDATE tickets SET deleted_at = unixepoch() WHERE id = ?'
    ).bind(ticketId).run();

    // 티켓 삭제 시 관련 알림 정리
    try {
        await db.prepare("DELETE FROM notifications WHERE link = ? AND type != 'message'")
            .bind(`/tickets/${ticketId}`).run();
    } catch (e) {
        console.error('Failed to clear ticket notifications on delete:', e);
    }

    return c.json({ success: true });
});

/**
 * DELETE /api/tickets/:id/hard
 * 티켓 완전 삭제 (super_admin만)
 */
ticketRoutes.delete('/tickets/:id/hard', requireAuth, async (c) => {
    const ticketId = Number(c.req.param('id'));
    const user = c.get('user')!;
    const db = c.env.DB;

    if (user.role !== 'super_admin') {
        return c.json({ error: '최고 관리자만 완전 삭제할 수 있습니다.' }, 403);
    }

    await db.prepare('DELETE FROM ticket_comments WHERE ticket_id = ?').bind(ticketId).run();
    const result = await db.prepare('DELETE FROM tickets WHERE id = ?').bind(ticketId).run();

    if (result.meta.changes === 0) {
        return c.json({ error: '티켓을 찾을 수 없습니다.' }, 404);
    }

    // 관련 알림 정리
    try {
        await db.prepare("DELETE FROM notifications WHERE link = ? AND type != 'message'")
            .bind(`/tickets/${ticketId}`).run();
    } catch (e) {
        console.error('Failed to clear ticket notifications on hard delete:', e);
    }

    return c.json({ success: true });
});

/**
 * DELETE /api/tickets/comment/:id
 * 댓글 소프트 삭제 (admin 이상)
 */
ticketRoutes.delete('/tickets/comment/:id', requireAuth, async (c) => {
    const commentId = Number(c.req.param('id'));
    const user = c.get('user')!;
    const db = c.env.DB;

    if (roleLevel(user.role) < 3) {
        return c.json({ error: '관리자 권한이 필요합니다.' }, 403);
    }

    const comment = await db.prepare(
        'SELECT id, deleted_at FROM ticket_comments WHERE id = ?'
    ).bind(commentId).first<TicketComment>();

    if (!comment) {
        return c.json({ error: '댓글을 찾을 수 없습니다.' }, 404);
    }

    if (comment.deleted_at) {
        return c.json({ error: '이미 삭제된 댓글입니다.' }, 400);
    }

    await db.prepare(
        'UPDATE ticket_comments SET deleted_at = unixepoch() WHERE id = ?'
    ).bind(commentId).run();

    return c.json({ success: true });
});

/**
 * DELETE /api/tickets/comment/:id/hard
 * 댓글 완전 삭제 (super_admin만)
 */
ticketRoutes.delete('/tickets/comment/:id/hard', requireAuth, async (c) => {
    const commentId = Number(c.req.param('id'));
    const user = c.get('user')!;
    const db = c.env.DB;

    if (user.role !== 'super_admin') {
        return c.json({ error: '최고 관리자만 완전 삭제할 수 있습니다.' }, 403);
    }

    const result = await db.prepare('DELETE FROM ticket_comments WHERE id = ?').bind(commentId).run();

    if (result.meta.changes === 0) {
        return c.json({ error: '댓글을 찾을 수 없습니다.' }, 404);
    }

    return c.json({ success: true });
});

export default ticketRoutes;
