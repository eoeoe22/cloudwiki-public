import { createMiddleware } from 'hono/factory';
import type { Env } from '../types';

export const rateLimitMiddleware = createMiddleware<Env>(async (c, next) => {
    // 1. Check user
    const user = c.get('user');

    // Only logged in users are checked here.
    if (!user) {
        return next();
    }

    // 2. Admins and discussion managers are exempt
    if (user.role === 'admin' || user.role === 'super_admin' || user.role === 'discussion_manager') {
        return next();
    }

    // 3. Check Method: Only limit mutating actions (POST, PUT, DELETE)
    if (!['POST', 'PUT', 'DELETE'].includes(c.req.method)) {
        return next();
    }

    const kv = c.env.KV;
    const limit = 10;

    // 시간 버킷 기반 레이트 리밋 (60초 윈도우)
    // 같은 버킷 키를 사용하여 경쟁 상태 영향을 최소화
    const bucket = Math.floor(Date.now() / 60_000);
    const key = `rl:${user.id}:${bucket}`;

    // 4. KV에서 현재 카운트 조회
    const current = parseInt(await kv.get(key) || '0', 10);

    if (current >= limit) {
        return c.json({ error: '요청 횟수가 너무 많습니다. 잠시 후 다시 시도해주세요.' }, 429);
    }

    // 5. 카운트 증가 (TTL 120초로 자동 만료 - 버킷 전환 후에도 안전하게 정리)
    // waitUntil로 비동기 처리하여 응답 지연을 줄임
    c.executionCtx.waitUntil(
        kv.put(key, String(current + 1), { expirationTtl: 120 })
    );

    return next();
});
