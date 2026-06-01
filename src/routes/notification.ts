import { Hono } from 'hono';
import type { Env, Message } from '../types';
import { requireAuth, requireAuthAllowBanned } from '../middleware/session';
import { safeJSON } from '../utils/json';
import { isSuperAdmin } from '../utils/auth';
import { RBAC } from '../utils/role';
import { createNotification } from '../utils/notification';
import { ensureNotificationsMigration } from '../utils/notificationsMigration';

const notificationRoutes = new Hono<Env>();

/**
 * GET /api/notifications
 * 현재 유저의 알림 목록 (최신순)
 * 쪽지 알림은 deleted=0인 것만 포함
 */
notificationRoutes.get('/notifications', requireAuthAllowBanned, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;
    await ensureNotificationsMigration(db);
    const offset = Number(c.req.query('offset')) || 0;
    const limit = Number(c.req.query('limit')) || 10;

    const { results } = await db.prepare(`
        SELECT n.*
        FROM notifications n
        LEFT JOIN messages m ON n.type = 'message' AND n.ref_id = m.id
        WHERE n.user_id = ?
          AND (n.type != 'message' OR (m.id IS NOT NULL AND m.deleted = 0))
        ORDER BY n.created_at DESC
        LIMIT ? OFFSET ?
    `).bind(user.id, limit + 1, offset).all();

    const has_more = results.length > limit;
    const notifications = results.slice(0, limit);

    return c.json(safeJSON({ notifications, has_more }));
});

/**
 * GET /api/notifications/count
 * 읽지 않은(read_at IS NULL) 알림 수 — 배지 표시용
 * 쪽지 알림은 deleted=0인 것만 카운트
 */
notificationRoutes.get('/notifications/count', requireAuthAllowBanned, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;
    await ensureNotificationsMigration(db);

    const row = await db.prepare(`
        SELECT COUNT(*) as count
        FROM notifications n
        LEFT JOIN messages m ON n.type = 'message' AND n.ref_id = m.id
        WHERE n.user_id = ?
          AND n.read_at IS NULL
          AND (n.type != 'message' OR (m.id IS NOT NULL AND m.deleted = 0))
    `).bind(user.id).first<{ count: number }>();

    return c.json({ count: row?.count || 0 });
});

/**
 * POST /api/notifications/read-all
 * 현재 유저의 안 읽은 알림을 모두 읽음 처리
 */
notificationRoutes.post('/notifications/read-all', requireAuthAllowBanned, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;
    await ensureNotificationsMigration(db);
    const now = Math.floor(Date.now() / 1000);
    const result = await db.prepare(
        'UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL'
    ).bind(now, user.id).run();
    return c.json({ success: true, updated: result.meta.changes });
});

/**
 * POST /api/notifications/read/by-link
 * 특정 link와 일치하는 알림을 일괄 읽음 처리 (쪽지 제외)
 * 토론/티켓 페이지 접속 시 해당 문서 관련 알림을 모두 읽음 처리하기 위해 사용.
 * 90일 보존 모델에서는 삭제 대신 읽음 처리해 보관함에 기록을 남긴다.
 */
notificationRoutes.post('/notifications/read/by-link', requireAuthAllowBanned, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;
    await ensureNotificationsMigration(db);
    const { link } = await c.req.json<{ link: string }>();

    if (!link || !link.trim()) {
        return c.json({ error: 'link 파라미터가 필요합니다.' }, 400);
    }

    const now = Math.floor(Date.now() / 1000);
    const result = await db.prepare(
        "UPDATE notifications SET read_at = ? WHERE user_id = ? AND link = ? AND type != 'message' AND read_at IS NULL"
    ).bind(now, user.id, link.trim()).run();

    return c.json({ success: true, updated: result.meta.changes });
});

/**
 * POST /api/notifications/:id/read
 * 단일 알림 읽음 처리 (이미 읽은 경우 무해)
 */
notificationRoutes.post('/notifications/:id/read', requireAuthAllowBanned, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;
    await ensureNotificationsMigration(db);
    const notifId = Number(c.req.param('id'));
    if (!Number.isInteger(notifId)) {
        return c.json({ error: '잘못된 알림 ID 입니다.' }, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    const result = await db.prepare(
        'UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL'
    ).bind(now, notifId, user.id).run();
    return c.json({ success: true, updated: result.meta.changes });
});

/**
 * DELETE /api/notifications
 * 현재 유저의 모든 알림 일괄 삭제 (쪽지 알림 포함)
 */
notificationRoutes.delete('/notifications', requireAuthAllowBanned, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;
    const result = await db.prepare(
        'DELETE FROM notifications WHERE user_id = ?'
    ).bind(user.id).run();
    return c.json({ success: true, deleted: result.meta.changes });
});

/**
 * DELETE /api/notifications/:id
 * 알림 삭제 — 알림 레코드만 삭제 (쪽지는 받은 쪽지함에서 별도로 삭제)
 */
notificationRoutes.delete('/notifications/:id', requireAuthAllowBanned, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;
    const notifId = Number(c.req.param('id'));

    // 알림 조회 및 권한 확인
    const notif = await db.prepare(
        'SELECT * FROM notifications WHERE id = ? AND user_id = ?'
    ).bind(notifId, user.id).first<{ id: number; type: string; ref_id: number | null }>();

    if (!notif) {
        return c.json({ error: '알림을 찾을 수 없습니다.' }, 404);
    }

    // 알림 레코드 삭제 (쪽지는 받은 쪽지함에 그대로 남음)
    await db.prepare('DELETE FROM notifications WHERE id = ?').bind(notifId).run();

    return c.json({ success: true });
});

/**
 * GET /api/settings/dm
 * DM 허용 여부 공개 조회 (비로그인 포함)
 */
notificationRoutes.get('/settings/dm', async (c) => {
    const db = c.env.DB;
    const row = await db.prepare('SELECT allow_direct_message FROM settings WHERE id = 1')
        .first<{ allow_direct_message: number }>();
    return c.json({ allow_direct_message: row?.allow_direct_message || 0 });
});

/**
 * POST /api/messages
 * 쪽지 발송
 */
notificationRoutes.post('/messages', requireAuth, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;
    const { receiver_id, content, reply_to } = await c.req.json<{
        receiver_id: number;
        content: string;
        reply_to?: number;
    }>();

    if (!content || !content.trim()) {
        return c.json({ error: '쪽지 내용을 입력해주세요.' }, 400);
    }
    if (!receiver_id) {
        return c.json({ error: '수신자를 지정해주세요.' }, 400);
    }
    if (receiver_id === user.id) {
        return c.json({ error: '자기 자신에게 쪽지를 보낼 수 없습니다.' }, 400);
    }

    // 수신자 존재 확인
    const receiver = await db.prepare('SELECT id, name, role FROM users WHERE id = ?')
        .bind(receiver_id).first<{ id: number; name: string; role: string }>();
    if (!receiver) {
        return c.json({ error: '수신자를 찾을 수 없습니다.' }, 404);
    }
    if (receiver.role === 'deleted') {
        return c.json({ error: '탈퇴한 사용자에게는 쪽지를 보낼 수 없습니다.' }, 400);
    }

    // DM 권한 확인
    const settings = await db.prepare('SELECT allow_direct_message FROM settings WHERE id = 1')
        .first<{ allow_direct_message: number }>();
    const dmAllowed = settings?.allow_direct_message === 1;
    const rbac = c.get('rbac') as RBAC;
    // 관리자(admin:access) 또는 토론 관리자(discussion:manage)는 DM 비활성 상태에서도 발송 가능
    const canBypassDmGate = rbac.can(user.role, 'admin:access') || rbac.can(user.role, 'discussion:manage');

    if (!dmAllowed && !canBypassDmGate) {
        // 비활성화 상태에서 일반 유저는 관리자/토론관리자 쪽지에 대한 답장만 가능
        if (!reply_to) {
            return c.json({ error: '개인 쪽지가 비활성화 상태입니다.' }, 403);
        }

        // reply_to가 관리자가 나에게 보낸 쪽지인지 확인
        const originalMsg = await db.prepare(
            'SELECT sender_id, receiver_id FROM messages WHERE id = ?'
        ).bind(reply_to).first<{ sender_id: number; receiver_id: number }>();

        if (!originalMsg || originalMsg.receiver_id !== user.id) {
            return c.json({ error: '답장 권한이 없습니다.' }, 403);
        }

        // 원본 발신자의 역할 확인 (관리자/토론관리자가 보낸 쪽지여야 답장 가능)
        // super_admin은 DB role 컬럼에 저장되지 않을 수 있으므로 이메일 기반으로도 확인
        const originalSender = await db.prepare('SELECT role, email FROM users WHERE id = ?')
            .bind(originalMsg.sender_id).first<{ role: string; email: string }>();
        const senderCanBypass = originalSender && (
            rbac.can(originalSender.role, 'admin:access') ||
            rbac.can(originalSender.role, 'discussion:manage') ||
            isSuperAdmin(originalSender.email, c.env)
        );
        if (!senderCanBypass) {
            return c.json({ error: '개인 쪽지가 비활성화 상태입니다.' }, 403);
        }
    }

    // 쪽지 삽입
    const result = await db.prepare(
        'INSERT INTO messages (sender_id, receiver_id, content, reply_to) VALUES (?, ?, ?, ?)'
    ).bind(user.id, receiver_id, content.trim(), reply_to ?? null).run();

    const messageId = result.meta.last_row_id;

    // 수신자에게 알림 생성 (+ 푸시)
    await createNotification(c.env, c.executionCtx, {
        userId: receiver_id,
        type: 'message',
        content: `${user.name}님이 쪽지를 보냈습니다.`,
        refId: Number(messageId),
        push: {
            title: `${user.name}님의 쪽지`,
            body: content.trim().slice(0, 120),
            url: '/mypage#messages',
            tag: `message:${messageId}`,
        },
    });

    return c.json(safeJSON({ id: messageId }), 201);
});

/**
 * GET /api/messages/sent
 * 현재 유저가 보낸 쪽지 목록 (최신순)
 */
notificationRoutes.get('/messages/sent', requireAuthAllowBanned, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;
    const offset = Number(c.req.query('offset')) || 0;
    const limit = Number(c.req.query('limit')) || 10;

    const { results } = await db.prepare(`
        SELECT m.*, u.name as receiver_name, u.picture as receiver_picture
        FROM messages m
        LEFT JOIN users u ON m.receiver_id = u.id
        WHERE m.sender_id = ?
        ORDER BY m.created_at DESC
        LIMIT ? OFFSET ?
    `).bind(user.id, limit + 1, offset).all();

    const has_more = results.length > limit;
    const messages = results.slice(0, limit);

    return c.json(safeJSON({ messages, has_more }));
});

/**
 * GET /api/messages
 * 현재 유저가 받은 쪽지 목록 (최신순)
 */
notificationRoutes.get('/messages', requireAuthAllowBanned, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;
    const offset = Number(c.req.query('offset')) || 0;
    const limit = Number(c.req.query('limit')) || 20;

    const { results } = await db.prepare(`
        SELECT m.*, su.name as sender_name, su.picture as sender_picture
        FROM messages m
        LEFT JOIN users su ON m.sender_id = su.id
        WHERE m.receiver_id = ? AND m.deleted = 0
        ORDER BY m.created_at DESC
        LIMIT ? OFFSET ?
    `).bind(user.id, limit + 1, offset).all();

    const has_more = results.length > limit;
    const messages = results.slice(0, limit);

    return c.json(safeJSON({ messages, has_more }));
});

/**
 * DELETE /api/messages/:id
 * 받은 쪽지 삭제 (Soft Delete)
 */
notificationRoutes.delete('/messages/:id', requireAuthAllowBanned, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;
    const messageId = Number(c.req.param('id'));

    // 수신자인지 확인
    const msg = await db.prepare('SELECT receiver_id FROM messages WHERE id = ?')
        .bind(messageId).first<{ receiver_id: number }>();

    if (!msg || msg.receiver_id !== user.id) {
        return c.json({ error: '권한이 없거나 쪽지를 찾을 수 없습니다.' }, 403);
    }

    // 쪽지 Soft Delete 처리
    await db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').bind(messageId).run();

    // 혹시 이 쪽지에 대한 알림이 아직 남아있다면 삭제 (선택적 연결성 제거)
    await db.prepare('DELETE FROM notifications WHERE type = ? AND ref_id = ? AND user_id = ?')
        .bind('message', messageId, user.id).run();

    return c.json({ success: true });
});

/**
 * GET /api/messages/:id
 * 쪽지 상세 조회
 */
notificationRoutes.get('/messages/:id', requireAuthAllowBanned, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;
    const messageId = Number(c.req.param('id'));

    const msg = await db.prepare(`
        SELECT m.*,
               su.name as sender_name, su.picture as sender_picture, su.role as sender_role, su.email as sender_email,
               ru.name as receiver_name, ru.picture as receiver_picture
        FROM messages m
        LEFT JOIN users su ON m.sender_id = su.id
        LEFT JOIN users ru ON m.receiver_id = ru.id
        WHERE m.id = ?
    `).bind(messageId).first();

    if (!msg) {
        return c.json({ error: '쪽지를 찾을 수 없습니다.' }, 404);
    }

    // 발신자 또는 수신자만 조회 가능
    if (msg.sender_id !== user.id && msg.receiver_id !== user.id) {
        return c.json({ error: '권한이 없습니다.' }, 403);
    }

    return c.json(safeJSON(msg));
});

export default notificationRoutes;
