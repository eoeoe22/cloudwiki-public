import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { isSuperAdmin } from '../utils/auth';
import type { Env, User } from '../types';

/**
 * 세션 미들웨어: wiki_session 쿠키에서 세션 토큰을 읽고 DB에서 검증한다.
 * 세션이 유효하면 c.set('user', user)로 유저 정보를 주입한다.
 * 세션이 없거나 만료되었으면 user = null로 설정한다.
 *
 * 성능 최적화: KV에 세션 정보를 캐싱하여 D1 쿼리 횟수를 최소화한다.
 */
const SESSION_CACHE_TTL = 1800; // KV 캐시 TTL: 30분

export const sessionMiddleware = createMiddleware<Env>(async (c, next) => {
    const sessionId = getCookie(c, 'wiki_session');

    if (!sessionId) {
        c.set('user', null);
        return next();
    }

    const kv = c.env.KV;
    const db = c.env.DB;
    const now = Math.floor(Date.now() / 1000);
    const cacheKey = `session:${sessionId}`;

    const requestUserAgent = c.req.header('User-Agent') || null;

    // 1) KV 캐시에서 먼저 확인
    let row: User | null = null;
    const cached = await kv.get(cacheKey);

    if (cached) {
        try {
            const parsed = JSON.parse(cached) as { user: User; expires_at: number; user_agent: string | null };
            if (parsed.expires_at > now) {
                // User-Agent 불일치 시 세션 무효화
                if (parsed.user_agent && parsed.user_agent !== requestUserAgent) {
                    c.set('user', null);
                    return next();
                }
                row = parsed.user;
            }
        } catch {
            // 캐시 파싱 실패 시 DB에서 조회
        }
    }

    // 2) 캐시 미스 시 DB에서 조회 후 KV에 캐싱
    if (!row) {
        const dbRow = await db
            .prepare(
                `SELECT u.id, u.email, u.name, u.picture, u.role, u.banned_until, u.last_namechange, u.created_at, s.expires_at, s.user_agent
           FROM sessions s
           JOIN users u ON s.user_id = u.id
           WHERE s.id = ? AND s.expires_at > ?`
            )
            .bind(sessionId, now)
            .first<User & { expires_at: number; user_agent: string | null }>();

        if (dbRow) {
            // User-Agent 불일치 시 세션 무효화
            if (dbRow.user_agent && dbRow.user_agent !== requestUserAgent) {
                c.set('user', null);
                return next();
            }

            const expiresAt = dbRow.expires_at;
            const sessionUserAgent = dbRow.user_agent;
            const { expires_at: _, user_agent: __, ...userData } = dbRow;
            row = userData as User;

            // KV에 캐싱 (세션 만료 시각 또는 TTL 중 짧은 것을 사용)
            const ttl = Math.min(SESSION_CACHE_TTL, expiresAt - now);
            if (ttl > 60) {
                c.executionCtx.waitUntil(
                    kv.put(cacheKey, JSON.stringify({ user: row, expires_at: expiresAt, user_agent: sessionUserAgent }), { expirationTtl: ttl })
                );
            }
        }
    }

    if (row) {
        // 탈퇴한 유저는 세션 무효화
        if (row.role === 'deleted') {
            c.set('user', null);
            return next();
        }
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
 * 인증 필수 미들웨어 (차단된 사용자 허용): 로그인만 확인하고 차단 여부는 확인하지 않음
 * 차단된 사용자도 알림 조회 등 일부 기능은 사용할 수 있도록 허용
 */
export const requireAuthAllowBanned = createMiddleware<Env>(async (c, next) => {
    const user = c.get('user');
    if (!user) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
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
