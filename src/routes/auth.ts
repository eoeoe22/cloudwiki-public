import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth } from '../middleware/session';

const auth = new Hono<Env>();

/**
 * GET /auth/google
 * Google OAuth 2.0 인증 페이지로 리다이렉트
 */
auth.get('/auth/google', async (c) => {
    // CSRF 방지: 랜덤 state 생성 후 KV에 저장 (TTL 5분)
    const state = crypto.randomUUID();
    await c.env.KV.put(`oauth_state:${state}`, '1', { expirationTtl: 300 });

    const params = new URLSearchParams({
        client_id: c.env.GOOGLE_CLIENT_ID,
        redirect_uri: c.env.GOOGLE_REDIRECT_URI,
        response_type: 'code',
        scope: 'openid email profile',
        access_type: 'offline',
        prompt: 'consent',
        state,
    });
    return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

/**
 * GET /auth/google/callback
 * Google에서 받은 code를 access_token으로 교환하고 유저 정보를 가져온다.
 * users 테이블에 upsert하고 sessions 테이블에 세션을 생성한 뒤 쿠키를 발급한다.
 */
auth.get('/auth/google/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');

    // CSRF 검증: state 파라미터 확인
    if (!state) {
        return c.json({ error: 'Missing state parameter' }, 403);
    }
    const storedState = await c.env.KV.get(`oauth_state:${state}`);
    if (!storedState) {
        return c.json({ error: 'Invalid or expired state parameter' }, 403);
    }
    // 사용한 state 삭제 (replay 방지)
    await c.env.KV.delete(`oauth_state:${state}`);

    if (!code) {
        return c.json({ error: 'Missing code parameter' }, 400);
    }

    // 1. code → access_token 교환
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code,
            client_id: c.env.GOOGLE_CLIENT_ID,
            client_secret: c.env.GOOGLE_CLIENT_SECRET,
            redirect_uri: c.env.GOOGLE_REDIRECT_URI,
            grant_type: 'authorization_code',
        }),
    });

    if (!tokenRes.ok) {
        const err = await tokenRes.text();
        console.error('Token exchange failed:', err);
        return c.json({ error: 'Token exchange failed' }, 500);
    }

    const tokenData = (await tokenRes.json()) as { access_token: string };

    // 2. access_token → userinfo 조회
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userRes.ok) {
        return c.json({ error: 'Failed to fetch user info' }, 500);
    }

    const userInfo = (await userRes.json()) as {
        id: string;
        email: string;
        name: string;
        picture: string;
        verified_email?: boolean;
        email_verified?: boolean;
    };

    if (!userInfo.verified_email && !userInfo.email_verified) {
        return c.json({ error: 'Google email not verified' }, 403);
    }

    const db = c.env.DB;

    // 3. users 테이블 upsert
    await db
        .prepare(
            `INSERT INTO users (google_id, email, name, picture)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(google_id)
       DO UPDATE SET email = excluded.email,
                     name = excluded.name,
                     picture = excluded.picture`
        )
        .bind(userInfo.id, userInfo.email, userInfo.name, userInfo.picture)
        .run();

    // 4. user id 조회
    const user = await db
        .prepare('SELECT id FROM users WHERE google_id = ?')
        .bind(userInfo.id)
        .first<{ id: number }>();

    if (!user) {
        return c.json({ error: 'User creation failed' }, 500);
    }

    // 5. 세션 생성
    const sessionId = crypto.randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7; // 7일

    await db
        .prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
        .bind(sessionId, user.id, expiresAt)
        .run();

    // 6. 세션 쿠키 발급 + 홈으로 리다이렉트
    c.header(
        'Set-Cookie',
        `wiki_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`
    );

    return c.redirect('/');
});

/**
 * GET /auth/logout
 * 세션 삭제 + 쿠키 제거
 */
auth.get('/auth/logout', async (c) => {
    const cookie = c.req.header('Cookie');
    const match = cookie?.match(/(?:^|;\s*)wiki_session=([^;]*)/);
    const sessionId = match ? decodeURIComponent(match[1]) : null;

    if (sessionId) {
        await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
    }

    c.header('Set-Cookie', 'wiki_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    return c.redirect('/');
});

/**
 * GET /api/me
 * 현재 로그인한 유저 정보 반환 (차단된 사용자도 자신의 정보는 조회 가능)
 */
auth.get('/api/me', (c) => {
    const user = c.get('user');
    if (!user) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    return c.json({
        id: user.id,
        name: user.name,
        email: user.email,
        picture: user.picture,
        role: user.role,
        created_at: user.created_at,
    });
});

/**
 * PUT /api/me/profile
 * 유저 표시 이름 변경
 */
auth.put('/api/me/profile', requireAuth, async (c) => {
    const user = c.get('user')!;
    const { name } = await c.req.json<{ name: string }>();

    if (!name || name.trim().length === 0) {
        return c.json({ error: '이름을 입력해주세요.' }, 400);
    }
    if (name.trim().length > 50) {
        return c.json({ error: '이름은 50자 이내로 입력해주세요.' }, 400);
    }

    await c.env.DB.prepare('UPDATE users SET name = ? WHERE id = ?')
        .bind(name.trim(), user.id)
        .run();

    return c.json({ success: true, name: name.trim() });
});

/**
 * GET /api/me/contributions
 * 내가 편집한 문서 목록
 */
auth.get('/api/me/contributions', requireAuth, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;

    const { results } = await db.prepare(
        `SELECT DISTINCT p.slug, p.title, p.updated_at, p.category
         FROM revisions r
         JOIN pages p ON r.page_id = p.id
         WHERE r.author_id = ? AND p.deleted_at IS NULL
         ORDER BY p.updated_at DESC
         LIMIT 50`
    ).bind(user.id).all();

    return c.json({ contributions: results });
});

/**
 * GET /api/users/:id/profile
 * 특정 유저의 공개 프로필 정보 반환
 */
auth.get('/api/users/:id/profile', async (c) => {
    const userId = parseInt(c.req.param('id'));
    if (isNaN(userId)) {
        return c.json({ error: '유효하지 않은 사용자 ID입니다.' }, 400);
    }

    const db = c.env.DB;
    const user = await db
        .prepare('SELECT id, name, picture, created_at FROM users WHERE id = ?')
        .bind(userId)
        .first<{ id: number; name: string; picture: string; created_at: number }>();

    if (!user) {
        return c.json({ error: '사용자를 찾을 수 없습니다.' }, 404);
    }

    return c.json({
        id: user.id,
        name: user.name,
        picture: user.picture,
        created_at: user.created_at,
    });
});

/**
 * GET /api/users/:id/contributions
 * 특정 유저의 편집(리비전) 내역 반환 (페이징: offset/limit)
 */
auth.get('/api/users/:id/contributions', async (c) => {
    const userId = parseInt(c.req.param('id'));
    if (isNaN(userId)) {
        return c.json({ error: '유효하지 않은 사용자 ID입니다.' }, 400);
    }

    const db = c.env.DB;
    const offset = parseInt(c.req.query('offset') || '0');
    const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50);

    // 유저 존재 여부 확인
    const userExists = await db
        .prepare('SELECT id FROM users WHERE id = ?')
        .bind(userId)
        .first();
    if (!userExists) {
        return c.json({ error: '사용자를 찾을 수 없습니다.' }, 404);
    }

    const { results } = await db.prepare(
        `SELECT r.id as revision_id, r.summary, r.created_at,
                p.slug, p.title
         FROM revisions r
         JOIN pages p ON r.page_id = p.id
         WHERE r.author_id = ? AND p.deleted_at IS NULL
         ORDER BY r.created_at DESC
         LIMIT ? OFFSET ?`
    ).bind(userId, limit, offset).all();

    // 다음 페이지 존재 여부 확인
    const countResult = await db.prepare(
        `SELECT COUNT(*) as total
         FROM revisions r
         JOIN pages p ON r.page_id = p.id
         WHERE r.author_id = ? AND p.deleted_at IS NULL`
    ).bind(userId).first<{ total: number }>();

    return c.json({
        contributions: results,
        total: countResult?.total || 0,
        has_more: offset + limit < (countResult?.total || 0),
    });
});

export default auth;
