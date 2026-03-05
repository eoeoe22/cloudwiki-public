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
    const key = `rl:${user.id}`;
    const limit = 10;

    // 4. KV에서 현재 카운트 조회
    const current = parseInt(await kv.get(key) || '0', 10);

    if (current >= limit) {
        return c.json({ error: '요청 횟수가 너무 많습니다. 잠시 후 다시 시도해주세요.' }, 429);
    }

    // 5. 카운트 증가 (TTL 60초로 자동 만료)
    await kv.put(key, String(current + 1), { expirationTtl: 60 });

    return next();
});
