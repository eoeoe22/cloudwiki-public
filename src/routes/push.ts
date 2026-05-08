// Web Push 구독/해제 엔드포인트.
// in-app 알림과 동등한 권한(차단된 유저도 구독 가능 — 알림 조회와 동일하게 requireAuthAllowBanned).
// 가입 신청 단계 옵트인은 signup_token 으로 보호된 별도 엔드포인트.

import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuthAllowBanned } from '../middleware/session';
import { isPushEnabled } from '../utils/push';

const pushRoutes = new Hono<Env>();

type SubscribeBody = {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
};

/**
 * GET /api/push/public-key
 * VAPID 공개키 반환. 비밀키가 등록되어 있지 않으면 enabled=false.
 */
pushRoutes.get('/push/public-key', (c) => {
    if (!isPushEnabled(c.env)) {
        return c.json({ enabled: false, public_key: null });
    }
    return c.json({ enabled: true, public_key: c.env.VAPID_PUBLIC_KEY });
});

function validateSubscription(body: SubscribeBody): { endpoint: string; p256dh: string; auth: string } | null {
    const endpoint = body.endpoint?.trim();
    const p256dh = body.keys?.p256dh?.trim();
    const auth = body.keys?.auth?.trim();
    if (!endpoint || !p256dh || !auth) return null;
    // 푸시 서비스 endpoint 는 https URL.
    if (!/^https:\/\//i.test(endpoint)) return null;
    if (endpoint.length > 2048 || p256dh.length > 256 || auth.length > 128) return null;
    return { endpoint, p256dh, auth };
}

/**
 * POST /api/push/subscribe
 * 가입 완료 유저의 구독 등록. endpoint UNIQUE 충돌 시 keys/user_id 갱신.
 */
pushRoutes.post('/push/subscribe', requireAuthAllowBanned, async (c) => {
    if (!isPushEnabled(c.env)) {
        return c.json({ error: 'Web Push 가 비활성화되어 있습니다.' }, 503);
    }
    const user = c.get('user')!;
    const body = await c.req.json<SubscribeBody>().catch(() => null);
    if (!body) return c.json({ error: '잘못된 요청입니다.' }, 400);
    const sub = validateSubscription(body);
    if (!sub) return c.json({ error: '구독 정보가 올바르지 않습니다.' }, 400);

    const ua = c.req.header('User-Agent')?.slice(0, 500) || null;

    // 기존 동일 endpoint 가 있으면 keys/user_id/ua 만 갱신 (재구독·기기 이전).
    await c.env.DB.prepare(
        `INSERT INTO push_subscriptions (user_id, signup_request_id, endpoint, p256dh, auth, ua)
         VALUES (?, NULL, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
            user_id = excluded.user_id,
            signup_request_id = NULL,
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            ua = excluded.ua`
    ).bind(user.id, sub.endpoint, sub.p256dh, sub.auth, ua).run();

    return c.json({ success: true });
});

/**
 * POST /api/push/subscribe-signup
 * 가입 신청 단계(승인제) 옵트인 구독 등록.
 *
 * 인증 없이 호출되므로 신청 소유권을 KV 의 signup_push_token 으로 검증한다.
 * 토큰은 가입 신청 제출 응답에서 발급되며 (TTL 5분), 본 엔드포인트에서 1회 사용 후 즉시 삭제된다.
 *
 * ON CONFLICT 시 동일 endpoint 가 이미 어떤 user_id 로 묶여 있더라도 user_id = NULL 로 재설정한다.
 * 그렇지 않으면 추후 승인/거절 흐름이 무관한 기존 유저의 구독을 재할당하거나 삭제할 수 있다.
 */
pushRoutes.post('/push/subscribe-signup', async (c) => {
    if (!isPushEnabled(c.env)) {
        return c.json({ error: 'Web Push 가 비활성화되어 있습니다.' }, 503);
    }
    const body = await c.req.json<SubscribeBody & { push_token?: string }>().catch(() => null);
    if (!body) return c.json({ error: '잘못된 요청입니다.' }, 400);
    const sub = validateSubscription(body);
    if (!sub) return c.json({ error: '구독 정보가 올바르지 않습니다.' }, 400);

    const pushToken = body.push_token?.trim();
    if (!pushToken || pushToken.length > 64) {
        return c.json({ error: '유효한 push_token 이 필요합니다.' }, 400);
    }

    const tokenKey = `signup_push_token:${pushToken}`;
    const tokenValue = await c.env.KV.get(tokenKey);
    if (!tokenValue) {
        return c.json({ error: '토큰이 만료되었거나 유효하지 않습니다.' }, 401);
    }
    const requestId = Number(tokenValue);
    if (!Number.isFinite(requestId) || requestId <= 0) {
        await c.env.KV.delete(tokenKey);
        return c.json({ error: '토큰이 손상되었습니다.' }, 400);
    }

    // 신청이 여전히 pending 상태인지 한 번 더 확인 (관리자가 그 사이 처리했을 수 있음).
    const row = await c.env.DB
        .prepare("SELECT id FROM signup_requests WHERE id = ? AND status = 'pending'")
        .bind(requestId)
        .first<{ id: number }>();
    if (!row) {
        await c.env.KV.delete(tokenKey);
        return c.json({ error: '대기 중인 가입 신청을 찾을 수 없습니다.' }, 404);
    }

    const ua = c.req.header('User-Agent')?.slice(0, 500) || null;

    await c.env.DB.prepare(
        `INSERT INTO push_subscriptions (user_id, signup_request_id, endpoint, p256dh, auth, ua)
         VALUES (NULL, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
            user_id = NULL,
            signup_request_id = excluded.signup_request_id,
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            ua = excluded.ua`
    ).bind(requestId, sub.endpoint, sub.p256dh, sub.auth, ua).run();

    // 토큰은 1회만 사용
    await c.env.KV.delete(tokenKey);

    return c.json({ success: true });
});

/**
 * DELETE /api/push/subscribe
 * 구독 해제. 본인의 구독만 삭제 가능.
 */
pushRoutes.delete('/push/subscribe', requireAuthAllowBanned, async (c) => {
    const user = c.get('user')!;
    const body = await c.req.json<{ endpoint?: string }>().catch(() => null);
    const endpoint = body?.endpoint?.trim();
    if (!endpoint) return c.json({ error: 'endpoint 가 필요합니다.' }, 400);

    await c.env.DB
        .prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
        .bind(endpoint, user.id)
        .run();

    return c.json({ success: true });
});

export default pushRoutes;
