import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { isSuperAdmin } from '../utils/auth';
import type { Env, User } from '../types';

/**
 * 세션 미들웨어: wiki_session 쿠키에서 세션 토큰을 읽고 DB에서 검증한다.
 * 세션이 유효하면 c.set('user', user)로 유저 정보를 주입한다.
 * 세션이 없거나 만료되었으면 user = null로 설정한다.
 */
export const sessionMiddleware = createMiddleware<Env>(async (c, next) => {
    const sessionId = getCookie(c, 'wiki_session');

    if (!sessionId) {
        c.set('user', null);
        return next();
    }

    const db = c.env.DB;
    const now = Math.floor(Date.now() / 1000);

    const row = await db
        .prepare(
            `SELECT u.id, u.google_id, u.email, u.name, u.picture, u.role, u.banned_until, u.last_namechange, u.created_at
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.id = ? AND s.expires_at > ?`
        )
        .bind(sessionId, now)
        .first<User>();

    if (row) {
        // Super Admin 판별
        if (isSuperAdmin(row.email, c.env)) {
            row.role = 'super_admin';
        }
        // Banned 판별
        else if (row.banned_until && row.banned_until > now) {
            row.role = 'banned';
        } else if (row.role === 'banned') {
            // cron이 실행되기 전이라도 기간이 지났으면 롤백
            row.role = 'user';
        }
    }

    c.set('user', row ?? null);
    return next();
});

/**
 * 인증 필수 미들웨어: 로그인하지 않은 사용자의 요청을 차단한다.
 * 차단된(banned) 사용자도 차단한다.
 */
export const requireAuth = createMiddleware<Env>(async (c, next) => {
    const user = c.get('user');
    if (!user) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    if (user.role === 'banned') {
        return c.json({ error: '차단된 계정입니다. 이용하실 수 없습니다.' }, 403);
    }
    return next();
});

/**
 * 관리자 필수 미들웨어: 관리자(admin) 또는 최고 관리자(super_admin)만 접근 가능
 */
export const requireAdmin = createMiddleware<Env>(async (c, next) => {
    const user = c.get('user');
    if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) {
        return c.json({ error: '관리자 권한이 필요합니다.' }, 403);
    }
    return next();
});
