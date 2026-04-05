import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env } from '../types';
import { requireAuth } from '../middleware/session';
import { isSuperAdmin, getSuperAdmins, isEmailDomainAllowed } from '../utils/auth';

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

    let isNewUser = false;

    // 3. 기존 유저 확인
    const existingUser = await db
        .prepare('SELECT id, role FROM users WHERE google_id = ?')
        .bind(userInfo.id)
        .first<{ id: number; role: string }>();

    if (existingUser && existingUser.role === 'deleted') {
        return c.redirect('/?error=deleted_account');
    }

    if (existingUser) {
        // 기존 유저: 이름은 유지 (수동으로 변경한 이름이 로그인마다 초기화되지 않도록)
        await db
            .prepare(
                `UPDATE users SET email = ?, picture = ? WHERE google_id = ?`
            )
            .bind(userInfo.email, userInfo.picture, userInfo.id)
            .run();
    } else {
        isNewUser = true;

        // 이메일 도메인 필터링
        if (!isEmailDomainAllowed(userInfo.email, c.env.EMAIL_RESTRICTION, c.env.EMAIL_LIST)) {
            return c.redirect('/?error=email_domain_not_allowed');
        }

        const settingsRow = await db
            .prepare('SELECT signup_policy FROM settings WHERE id = 1')
            .first<{ signup_policy: string }>();
        const signupPolicy = settingsRow?.signup_policy || 'open';

        // 차단: 신규 유저 가입 완전 차단
        if (signupPolicy === 'blocked') {
            return c.redirect('/?error=signup_blocked');
        }

        // 승인제: 신규 유저는 바로 가입하지 않고 가입 신청 절차를 거침
        if (signupPolicy === 'approval') {
            // 기존 가입 신청 확인
            const existingRequest = await db
                .prepare('SELECT id, status FROM signup_requests WHERE google_id = ? ORDER BY created_at DESC LIMIT 1')
                .bind(userInfo.id)
                .first<{ id: number; status: string }>();

            if (existingRequest) {
                if (existingRequest.status === 'pending') {
                    return c.redirect('/?error=signup_pending');
                }
                if (existingRequest.status === 'blocked') {
                    return c.redirect('/?error=signup_blocked');
                }
                // rejected: 재신청 가능 → 아래로 진행
            }

            // 임시 토큰 발급하여 KV에 저장 (10분 TTL)
            const signupToken = crypto.randomUUID();
            await c.env.KV.put(`signup_token:${signupToken}`, JSON.stringify({
                google_id: userInfo.id,
                email: userInfo.email,
                name: userInfo.name,
                picture: userInfo.picture,
            }), { expirationTtl: 600 });

            return c.redirect(`/setup-profile?mode=approval&token=${signupToken}`);
        }

        // 모두 허용: 기존 로직대로 바로 유저 생성
        let finalName = userInfo.name;
        const nameExists = await db
            .prepare('SELECT COUNT(*) as cnt FROM users WHERE name = ?')
            .bind(finalName)
            .first<{ cnt: number }>();

        if (nameExists && nameExists.cnt > 0) {
            let suffix = 2;
            while (true) {
                const candidateName = `${userInfo.name} ${suffix}`;
                const dupCheck = await db
                    .prepare('SELECT COUNT(*) as cnt FROM users WHERE name = ?')
                    .bind(candidateName)
                    .first<{ cnt: number }>();
                if (!dupCheck || dupCheck.cnt === 0) {
                    finalName = candidateName;
                    break;
                }
                suffix++;
            }
        }

        await db
            .prepare(
                `INSERT INTO users (google_id, email, name, picture) VALUES (?, ?, ?, ?)`
            )
            .bind(userInfo.id, userInfo.email, finalName, userInfo.picture)
            .run();
    }

    // 4. user id 조회
    const user = await db
        .prepare('SELECT id FROM users WHERE google_id = ?')
        .bind(userInfo.id)
        .first<{ id: number }>();

    if (!user) {
        return c.json({ error: 'User creation failed' }, 500);
    }

    // 5. 세션 생성 (User-Agent 기록)
    const sessionId = crypto.randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7; // 7일
    const userAgent = c.req.header('User-Agent') || null;

    await db
        .prepare('INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)')
        .bind(sessionId, user.id, expiresAt, userAgent)
        .run();

    // 6. 세션 쿠키 발급 + 홈으로 리다이렉트
    c.header(
        'Set-Cookie',
        `wiki_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`
    );

    if (isNewUser) {
        return c.redirect('/setup-profile');
    }

    return c.redirect('/');
});

/**
 * POST /api/auth/signup-request
 * 승인제 회원가입 신청 제출 (비인증 상태에서 임시 토큰으로 처리)
 */
auth.post('/api/auth/signup-request', async (c) => {
    const db = c.env.DB;
    const { token, name, message } = await c.req.json<{
        token: string;
        name: string;
        message?: string;
    }>();

    if (!token) {
        return c.json({ error: '유효하지 않은 요청입니다.' }, 400);
    }
    if (!name || name.trim().length === 0) {
        return c.json({ error: '표시명을 입력해주세요.' }, 400);
    }
    if (name.trim().length > 20) {
        return c.json({ error: '표시명은 20자 이내로 입력해주세요.' }, 400);
    }

    // 토큰 검증
    const tokenData = await c.env.KV.get(`signup_token:${token}`);
    if (!tokenData) {
        return c.json({ error: '토큰이 만료되었거나 유효하지 않습니다. 다시 로그인해주세요.' }, 400);
    }

    const userInfo = JSON.parse(tokenData) as {
        google_id: string;
        email: string;
        name: string;
        picture: string;
    };

    // 중복 이름 확인
    const dupCheck = await db
        .prepare('SELECT COUNT(*) as cnt FROM users WHERE name = ?')
        .bind(name.trim())
        .first<{ cnt: number }>();
    if (dupCheck && dupCheck.cnt > 0) {
        return c.json({ error: '이미 사용 중인 표시명입니다. 다른 이름을 입력해주세요.' }, 409);
    }

    // 이미 pending 신청이 있는지 확인
    const existingPending = await db
        .prepare("SELECT id FROM signup_requests WHERE google_id = ? AND status = 'pending'")
        .bind(userInfo.google_id)
        .first();
    if (existingPending) {
        await c.env.KV.delete(`signup_token:${token}`);
        return c.json({ error: '이미 가입 신청이 대기 중입니다.' }, 409);
    }

    // 차단 상태 확인
    const blockedRequest = await db
        .prepare("SELECT id FROM signup_requests WHERE google_id = ? AND status = 'blocked'")
        .bind(userInfo.google_id)
        .first();
    if (blockedRequest) {
        await c.env.KV.delete(`signup_token:${token}`);
        return c.json({ error: '가입이 차단된 계정입니다.' }, 403);
    }

    // 가입 신청 INSERT
    const result = await db.prepare(
        'INSERT INTO signup_requests (google_id, email, name, picture, message) VALUES (?, ?, ?, ?, ?)'
    ).bind(
        userInfo.google_id,
        userInfo.email,
        name.trim(),
        userInfo.picture || null,
        (message || '').trim()
    ).run();

    const requestId = result.meta.last_row_id;

    // 모든 관리자에게 알림 발송
    const admins = await db.prepare(
        "SELECT id, email FROM users WHERE role = 'admin' AND role != 'deleted'"
    ).all<{ id: number; email: string }>();

    const superAdminEmails = getSuperAdmins(c.env);
    const superAdminUsers = superAdminEmails.size > 0
        ? await db.prepare(
            `SELECT id, email FROM users WHERE email IN (${Array.from(superAdminEmails).map(() => '?').join(',')}) AND role != 'deleted'`
        ).bind(...Array.from(superAdminEmails)).all<{ id: number; email: string }>()
        : { results: [] };

    // 중복 제거하여 알림 대상 수집
    const notifyUserIds = new Set<number>();
    for (const admin of admins.results || []) {
        notifyUserIds.add(admin.id);
    }
    for (const sa of superAdminUsers.results || []) {
        notifyUserIds.add(sa.id);
    }

    // 알림 발송
    for (const userId of notifyUserIds) {
        await db.prepare(
            'INSERT INTO notifications (user_id, type, content, link, ref_id) VALUES (?, ?, ?, ?, ?)'
        ).bind(
            userId,
            'signup_request',
            `${name.trim()}님이 가입을 신청했습니다.`,
            '/admin#signup-requests',
            requestId
        ).run();
    }

    // 토큰 삭제
    await c.env.KV.delete(`signup_token:${token}`);

    return c.json({ success: true, message: '가입 신청이 접수되었습니다.' });
});

/**
 * GET /api/auth/signup-policy
 * 현재 회원가입 정책 반환 (비인증 상태에서도 접근 가능)
 */
auth.get('/api/auth/signup-policy', async (c) => {
    const db = c.env.DB;
    const settingsRow = await db
        .prepare('SELECT signup_policy FROM settings WHERE id = 1')
        .first<{ signup_policy: string }>();
    return c.json({ policy: settingsRow?.signup_policy || 'open' });
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
    if (name.trim().length > 20) {
        return c.json({ error: '이름은 20자 이내로 입력해주세요.' }, 400);
    }

    const trimmedName = name.trim();
    const db = c.env.DB;

    // 1. 중복 이름 확인 (본인 제외)
    const dupCheck = await db
        .prepare('SELECT COUNT(*) as cnt FROM users WHERE name = ? AND id != ?')
        .bind(trimmedName, user.id)
        .first<{ cnt: number }>();

    if (dupCheck && dupCheck.cnt > 0) {
        return c.json({ error: '이미 사용 중인 이름입니다. 다른 이름을 입력해주세요.' }, 409);
    }

    // 2. 쿨다운 확인
    const settingsRow = await db
        .prepare('SELECT namechange_ratelimit FROM settings WHERE id = 1')
        .first<{ namechange_ratelimit: number }>();

    const cooldownDays = settingsRow?.namechange_ratelimit ?? 0;

    // -1 이면 변경 완전 불허 (최초 변경인 경우에만 예외 허용)
    if (cooldownDays === -1 && user.last_namechange !== null) {
        return c.json({ error: '표시명 변경이 비활성화되어 있습니다.' }, 403);
    }

    // 양수인 경우 쿨다운 적용 (단, last_namechange가 NULL이면 최초 변경이므로 면제)
    if (cooldownDays > 0 && user.last_namechange !== null) {
        const now = Math.floor(Date.now() / 1000);
        const cooldownSeconds = cooldownDays * 86400;
        const nextChangeAt = user.last_namechange + cooldownSeconds;

        if (now < nextChangeAt) {
            const remainDays = Math.ceil((nextChangeAt - now) / 86400);
            return c.json({ error: `표시명 변경 쿨다운 중입니다. ${remainDays}일 후에 다시 시도해주세요.` }, 429);
        }
    }

    // 3. 이름과 last_namechange 업데이트
    const now = Math.floor(Date.now() / 1000);
    await db.prepare('UPDATE users SET name = ?, last_namechange = ? WHERE id = ?')
        .bind(trimmedName, now, user.id)
        .run();

    // 4. 세션 KV 캐시 무효화 (사용자 정보가 변경되었으므로)
    const sessionId = getCookie(c, 'wiki_session');
    if (sessionId) {
        c.executionCtx.waitUntil(c.env.KV.delete(`session:${sessionId}`));
    }

    return c.json({ success: true, name: trimmedName });
});

/**
 * GET /api/me/namechange-status
 * 표시명 변경 가능 여부 및 남은 쿨다운 반환
 */
auth.get('/api/me/namechange-status', requireAuth, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;

    const settingsRow = await db
        .prepare('SELECT namechange_ratelimit FROM settings WHERE id = 1')
        .first<{ namechange_ratelimit: number }>();

    const cooldownDays = settingsRow?.namechange_ratelimit ?? 0;

    // -1: 변경 완전 불허
    if (cooldownDays === -1) {
        if (user.last_namechange === null) {
            return c.json({ allowed: true, reason: 'first_change', message: '표시명은 추후 변경이 불가능합니다.' });
        }
        return c.json({ allowed: false, reason: 'disabled', message: '표시명 변경이 비활성화되어 있습니다.' });
    }

    // 0: 무제한 허용
    if (cooldownDays === 0) {
        return c.json({ allowed: true, reason: 'unlimited', message: '표시명은 추후 변경이 가능합니다.' });
    }

    // 양수: 쿨다운 확인
    // last_namechange가 NULL이면 최초 변경 → 면제
    if (user.last_namechange === null) {
        return c.json({ allowed: true, reason: 'first_change', message: '표시명은 추후 변경이 가능합니다.' });
    }

    const now = Math.floor(Date.now() / 1000);
    const cooldownSeconds = cooldownDays * 86400;
    const nextChangeAt = user.last_namechange + cooldownSeconds;

    if (now >= nextChangeAt) {
        return c.json({ allowed: true, reason: 'cooldown_passed' });
    }

    const remainSeconds = nextChangeAt - now;
    const remainDays = Math.ceil(remainSeconds / 86400);

    return c.json({
        allowed: false,
        reason: 'cooldown',
        remain_seconds: remainSeconds,
        remain_days: remainDays,
        next_change_at: nextChangeAt,
        message: `${remainDays}일 후에 표시명을 변경할 수 있습니다.`
    });
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
        .prepare('SELECT id, name, picture, role, created_at FROM users WHERE id = ?')
        .bind(userId)
        .first<{ id: number; name: string; picture: string; role: string; created_at: number }>();

    if (!user || user.role === 'deleted') {
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

/**
 * DELETE /api/me/account
 * 회원탈퇴: role을 'deleted'로, 표시명을 '탈퇴한 사용자'로 변경하고 세션 삭제
 * google_id는 유지하여 재가입 차단
 */
auth.delete('/api/me/account', requireAuth, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;

    // 1. role을 'deleted'로, 이름을 '탈퇴한 사용자'로, picture 제거
    await db.prepare(
        `UPDATE users SET role = 'deleted', name = '탈퇴한 사용자', picture = NULL, email = '' WHERE id = ?`
    ).bind(user.id).run();

    // 2. 해당 유저의 모든 세션 삭제
    await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();

    // 3. KV 세션 캐시 무효화 (현재 세션)
    const sessionId = getCookie(c, 'wiki_session');
    if (sessionId) {
        await c.env.KV.delete(`session:${sessionId}`);
    }

    // 4. 쿠키 제거
    c.header('Set-Cookie', 'wiki_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');

    return c.json({ success: true });
});

export default auth;
