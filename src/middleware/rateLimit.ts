import { createMiddleware } from 'hono/factory';
import type { Env } from '../types';

export const rateLimitMiddleware = createMiddleware<Env>(async (c, next) => {
    // 1. Check user
    const user = c.get('user');

    // Only logged in users are checked here. Guests are blocked by requireAuth for sensitive actions anyway.
    // If guest, we skip rate limiting here (or apply IP based if needed, but requirement says "Normal users").
    if (!user) {
        return next();
    }

    // 2. Admins and discussion managers are exempt
    if (user.role === 'admin' || user.role === 'super_admin' || user.role === 'discussion_manager') {
        return next();
    }

    // 3. Check Method: Only limit mutating actions (POST, PUT, DELETE)
    // The requirement says "10 actions". Usually reads are much higher volume.
    // If the user meant "page loads", 10/min is too low. I assume "edit/move/delete".
    if (!['POST', 'PUT', 'DELETE'].includes(c.req.method)) {
        return next();
    }

    const db = c.env.DB;
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - 60; // 1 minute window

    // 4. Count events
    const countResult = await db
        .prepare('SELECT count(*) as count FROM rate_limit_events WHERE user_id = ? AND created_at > ?')
        .bind(user.id, windowStart)
        .first<{ count: number }>();

    const count = countResult?.count ?? 0;
    const limit = user.rate_limit ?? 10; // Default 10 if null

    if (count >= limit) {
        return c.json({ error: '요청 횟수가 너무 많습니다. 잠시 후 다시 시도해주세요.' }, 429);
    }

    // 5. Insert event
    // We do this asynchronously to not block the request? No, D1 is fast enough, and we need to ensure it's recorded.
    // However, to keep it fast, we can use `c.executionCtx.waitUntil` if available, but for correctness of the *next* request, we should await.
    // Since this is the *current* request being counted towards the limit, strictly speaking if we are at 9/10, this one is the 10th.
    // It is allowed. The NEXT one will be 11/10 and blocked.
    // So we record it now.

    await db.prepare('INSERT INTO rate_limit_events (user_id, created_at) VALUES (?, ?)')
        .bind(user.id, now)
        .run();

    // 6. Cleanup old events (Probabilistic, 10% chance)
    if (Math.random() < 0.1 && c.executionCtx) {
        c.executionCtx.waitUntil(
            db.prepare('DELETE FROM rate_limit_events WHERE created_at <= ?')
                .bind(windowStart) // Delete older than window
                .run()
        );
    }

    return next();
});
