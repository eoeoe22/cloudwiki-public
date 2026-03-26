import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env } from '../types';
import { requireAuth } from '../middleware/session';
import { isSuperAdmin, getSuperAdmins } from '../utils/auth';
import { getProvider, getEnabledProviders, isProviderEnabled } from '../oauth/registry';

const auth = new Hono<Env>();

/**
 * GET /api/auth/providers
 * 활성화된 OAuth 프로바이더 목록 반환
 */
auth.get('/api/auth/providers', (c) => {
    const env = c.env as unknown as Record<string, string>;
    const providers = getEnabledProviders(env).map((p) => ({
        name: p.name,
        displayName: p.displayName,
        icon: p.icon,
    }));
    return c.json({ providers });
});

/**
 * GET /auth/:provider
 * OAuth 인증 페이지로 리다이렉트
 */
auth.get('/auth/:provider', async (c) => {
    const providerName = c.req.param('provider');
    const provider = getProvider(providerName);
    const env = c.env as unknown as Record<string, string>;

    if (!provider || !isProviderEnabled(providerName, env)) {
        return c.json({ error: 'Unsupported provider' }, 404);
    }

    const state = crypto.randomUUID();
    await c.env.KV.put(
        `oauth_state:${state}`,
        JSON.stringify({ provider: providerName, mode: 'login' }),
        { expirationTtl: 300 }
    );

    const authUrl = provider.getAuthUrl(state, env);
    return c.redirect(authUrl);
});

/**
 * GET /auth/:provider/callback
 * OAuth 콜백 처리 (로그인 및 계정 연동 모두 처리)
 */
auth.get('/auth/:provider/callback', async (c) => {
    const providerName = c.req.param('provider');
    const code = c.req.query('code');
    const stateParam = c.req.query('state');

    // CSRF 검증
    if (!stateParam) {
        return c.json({ error: 'Missing state parameter' }, 403);
    }
    const storedStateRaw = await c.env.KV.get(`oauth_state:${stateParam}`);
    if (!storedStateRaw) {
        return c.json({ error: 'Invalid or expired state parameter' }, 403);
    }
    await c.env.KV.delete(`oauth_state:${stateParam}`);

    const storedState = JSON.parse(storedStateRaw) as {
        provider: string;
        mode: 'login' | 'link';
        user_id?: number;
    };

    // state의 provider와 URL의 provider 일치 여부 확인
    if (storedState.provider !== providerName) {
        return c.json({ error: 'Provider mismatch' }, 403);
    }

    const provider = getProvider(providerName);
    const env = c.env as unknown as Record<string, string>;

    if (!provider || !isProviderEnabled(providerName, env)) {
        return c.json({ error: 'Unsupported provider' }, 404);
    }

    if (!code) {
        return c.json({ error: 'Missing code parameter' }, 400);
    }

    // 1. code → access_token 교환
    let accessToken: string;
    try {
        accessToken = await provider.exchangeCode(code, env);
    } catch {
        return c.json({ error: 'Token exchange failed' }, 500);
    }

    // 2. access_token → userinfo 조회
    let userInfo;
    try {
        userInfo = await provider.getUserInfo(accessToken);
    } catch {
        return c.json({ error: 'Failed to fetch user info' }, 500);
    }

    if (!userInfo.emailVerified) {
        return c.json({ error: `${provider.displayName} email not verified` }, 403);
    }

    const db = c.env.DB;

    // === 계정 연동 모드 ===
    if (storedState.mode === 'link' && storedState.user_id) {
        // 해당 provider_id가 이미 다른 계정에 연결되어 있는지 확인
        const existingOAuth = await db
            .prepare('SELECT user_id FROM user_oauth_accounts WHERE provider = ? AND provider_id = ?')
            .bind(providerName, userInfo.id)
            .first<{ user_id: number }>();

        if (existingOAuth) {
            return c.redirect('/mypage?error=oauth_already_linked');
        }

        // 현재 유저에 이미 같은 프로바이더가 연결되어 있는지 확인
        const existingSameProvider = await db
            .prepare('SELECT id FROM user_oauth_accounts WHERE user_id = ? AND provider = ?')
            .bind(storedState.user_id, providerName)
            .first();

        if (existingSameProvider) {
            return c.redirect('/mypage?error=provider_already_linked');
        }

        // OAuth 계정 연결
        await db
            .prepare('INSERT INTO user_oauth_accounts (user_id, provider, provider_id, email) VALUES (?, ?, ?, ?)')
            .bind(storedState.user_id, providerName, userInfo.id, userInfo.email)
            .run();

        return c.redirect('/mypage?success=oauth_linked');
    }

    // === 로그인 모드 ===
    let isNewUser = false;

    // 3. user_oauth_accounts에서 기존 계정 확인
    const existingOAuth = await db
        .prepare(
            `SELECT oa.user_id, u.id, u.role
             FROM user_oauth_accounts oa
             JOIN users u ON oa.user_id = u.id
             WHERE oa.provider = ? AND oa.provider_id = ?`
        )
        .bind(providerName, userInfo.id)
        .first<{ user_id: number; id: number; role: string }>();

    if (existingOAuth && existingOAuth.role === 'deleted') {
        return c.redirect('/?error=deleted_account');
    }

    if (existingOAuth) {
        // 기존 유저: email, picture만 업데이트
        await db
            .prepare('UPDATE users SET email = ?, picture = ? WHERE id = ?')
            .bind(userInfo.email, userInfo.picture, existingOAuth.id)
            .run();

        // OAuth 계정의 이메일도 업데이트
        await db
            .prepare('UPDATE user_oauth_accounts SET email = ? WHERE provider = ? AND provider_id = ?')
            .bind(userInfo.email, providerName, userInfo.id)
            .run();
    } else {
        isNewUser = true;
        const settingsRow = await db
            .prepare('SELECT signup_policy FROM settings WHERE id = 1')
            .first<{ signup_policy: string }>();
        const signupPolicy = settingsRow?.signup_policy || 'open';

        // 승인제: 신규 유저는 바로 가입하지 않고 가입 신청 절차를 거침
        if (signupPolicy === 'approval') {
            const existingRequest = await db
                .prepare(
                    'SELECT id, status FROM signup_requests WHERE provider = ? AND provider_id = ? ORDER BY created_at DESC LIMIT 1'
                )
                .bind(providerName, userInfo.id)
                .first<{ id: number; status: string }>();

            if (existingRequest) {
                if (existingRequest.status === 'pending') {
                    return c.redirect('/?error=signup_pending');
                }
                if (existingRequest.status === 'blocked') {
                    return c.redirect('/?error=signup_blocked');
                }
            }

            // 임시 토큰 발급하여 KV에 저장 (10분 TTL)
            const signupToken = crypto.randomUUID();
            await c.env.KV.put(
                `signup_token:${signupToken}`,
                JSON.stringify({
                    provider: providerName,
                    provider_id: userInfo.id,
                    email: userInfo.email,
                    name: userInfo.name,
                    picture: userInfo.picture,
                }),
                { expirationTtl: 600 }
            );

            return c.redirect(`/setup-profile?mode=approval&token=${signupToken}`);
        }

        // 모두 허용: 바로 유저 생성
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

        // users 테이블에 유저 생성
        const insertResult = await db
            .prepare('INSERT INTO users (email, name, picture) VALUES (?, ?, ?)')
            .bind(userInfo.email, finalName, userInfo.picture)
            .run();

        const newUserId = insertResult.meta.last_row_id;

        // user_oauth_accounts에 OAuth 계정 연결
        await db
            .prepare('INSERT INTO user_oauth_accounts (user_id, provider, provider_id, email) VALUES (?, ?, ?, ?)')
            .bind(newUserId, providerName, userInfo.id, userInfo.email)
            .run();
    }

    // 4. user_id 조회
    const user = await db
        .prepare(
            `SELECT oa.user_id as id
             FROM user_oauth_accounts oa
             WHERE oa.provider = ? AND oa.provider_id = ?`
        )
        .bind(providerName, userInfo.id)
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

    // 6. 세션 쿠키 발급 + 리다이렉트
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

    const userInfoFromToken = JSON.parse(tokenData) as {
        provider: string;
        provider_id: string;
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
        .prepare("SELECT id FROM signup_requests WHERE provider = ? AND provider_id = ? AND status = 'pending'")
        .bind(userInfoFromToken.provider, userInfoFromToken.provider_id)
        .first();
    if (existingPending) {
        await c.env.KV.delete(`signup_token:${token}`);
        return c.json({ error: '이미 가입 신청이 대기 중입니다.' }, 409);
    }

    // 차단 상태 확인
    const blockedRequest = await db
        .prepare("SELECT id FROM signup_requests WHERE provider = ? AND provider_id = ? AND status = 'blocked'")
        .bind(userInfoFromToken.provider, userInfoFromToken.provider_id)
        .first();
    if (blockedRequest) {
        await c.env.KV.delete(`signup_token:${token}`);
        return c.json({ error: '가입이 차단된 계정입니다.' }, 403);
    }

    // 가입 신청 INSERT
    const result = await db
        .prepare(
            'INSERT INTO signup_requests (provider, provider_id, email, name, picture, message) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .bind(
            userInfoFromToken.provider,
            userInfoFromToken.provider_id,
            userInfoFromToken.email,
            name.trim(),
            userInfoFromToken.picture || null,
            (message || '').trim()
        )
        .run();

    const requestId = result.meta.last_row_id;

    // 모든 관리자에게 알림 발송
    const admins = await db
        .prepare("SELECT id, email FROM users WHERE role = 'admin' AND role != 'deleted'")
        .all<{ id: number; email: string }>();

    const superAdminEmails = getSuperAdmins(c.env);
    const superAdminUsers =
        superAdminEmails.size > 0
            ? await db
                  .prepare(
                      `SELECT id, email FROM users WHERE email IN (${Array.from(superAdminEmails)
                          .map(() => '?')
                          .join(',')}) AND role != 'deleted'`
                  )
                  .bind(...Array.from(superAdminEmails))
                  .all<{ id: number; email: string }>()
            : { results: [] };

    const notifyUserIds = new Set<number>();
    for (const admin of admins.results || []) {
        notifyUserIds.add(admin.id);
    }
    for (const sa of superAdminUsers.results || []) {
        notifyUserIds.add(sa.id);
    }

    for (const userId of notifyUserIds) {
        await db
            .prepare('INSERT INTO notifications (user_id, type, content, link, ref_id) VALUES (?, ?, ?, ?, ?)')
            .bind(userId, 'signup_request', `${name.trim()}님이 가입을 신청했습니다.`, '/admin#signup-requests', requestId)
            .run();
    }

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
 * GET /api/me/oauth-accounts
 * 현재 유저에 연결된 OAuth 계정 목록 반환
 */
auth.get('/api/me/oauth-accounts', requireAuth, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;

    const { results } = await db
        .prepare('SELECT id, provider, provider_id, email, created_at FROM user_oauth_accounts WHERE user_id = ?')
        .bind(user.id)
        .all<{ id: number; provider: string; provider_id: string; email: string; created_at: number }>();

    // 활성화된 프로바이더 목록도 함께 반환
    const env = c.env as unknown as Record<string, string>;
    const enabledProviders = getEnabledProviders(env).map((p) => ({
        name: p.name,
        displayName: p.displayName,
        icon: p.icon,
    }));

    return c.json({ accounts: results, enabledProviders });
});

/**
 * GET /api/auth/link/:provider
 * 계정 연동 시작 (로그인 필수) - OAuth URL로 리다이렉트
 */
auth.get('/api/auth/link/:provider', requireAuth, async (c) => {
    const providerName = c.req.param('provider');
    const provider = getProvider(providerName);
    const env = c.env as unknown as Record<string, string>;
    const user = c.get('user')!;

    if (!provider || !isProviderEnabled(providerName, env)) {
        return c.json({ error: 'Unsupported provider' }, 404);
    }

    // 이미 같은 프로바이더가 연결되어 있는지 확인
    const existing = await c.env.DB.prepare(
        'SELECT id FROM user_oauth_accounts WHERE user_id = ? AND provider = ?'
    )
        .bind(user.id, providerName)
        .first();

    if (existing) {
        return c.json({ error: '이미 연결된 프로바이더입니다.' }, 409);
    }

    const state = crypto.randomUUID();
    await c.env.KV.put(
        `oauth_state:${state}`,
        JSON.stringify({ provider: providerName, mode: 'link', user_id: user.id }),
        { expirationTtl: 300 }
    );

    const authUrl = provider.getAuthUrl(state, env);
    return c.redirect(authUrl);
});

/**
 * DELETE /api/auth/unlink/:provider
 * 계정 연동 해제 (마지막 하나는 해제 불가)
 */
auth.delete('/api/auth/unlink/:provider', requireAuth, async (c) => {
    const providerName = c.req.param('provider');
    const user = c.get('user')!;
    const db = c.env.DB;

    // 연결된 OAuth 계정 수 확인
    const countResult = await db
        .prepare('SELECT COUNT(*) as cnt FROM user_oauth_accounts WHERE user_id = ?')
        .bind(user.id)
        .first<{ cnt: number }>();

    if (!countResult || countResult.cnt <= 1) {
        return c.json({ error: '마지막 로그인 수단은 해제할 수 없습니다.' }, 400);
    }

    // 해당 프로바이더 연결 삭제
    const result = await db
        .prepare('DELETE FROM user_oauth_accounts WHERE user_id = ? AND provider = ?')
        .bind(user.id, providerName)
        .run();

    if (result.meta.changes === 0) {
        return c.json({ error: '연결된 계정을 찾을 수 없습니다.' }, 404);
    }

    return c.json({ success: true });
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

    if (cooldownDays === -1 && user.last_namechange !== null) {
        return c.json({ error: '표시명 변경이 비활성화되어 있습니다.' }, 403);
    }

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
    await db.prepare('UPDATE users SET name = ?, last_namechange = ? WHERE id = ?').bind(trimmedName, now, user.id).run();

    // 4. 세션 KV 캐시 무효화
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

    if (cooldownDays === -1) {
        if (user.last_namechange === null) {
            return c.json({ allowed: true, reason: 'first_change', message: '표시명은 추후 변경이 불가능합니다.' });
        }
        return c.json({ allowed: false, reason: 'disabled', message: '표시명 변경이 비활성화되어 있습니다.' });
    }

    if (cooldownDays === 0) {
        return c.json({ allowed: true, reason: 'unlimited', message: '표시명은 추후 변경이 가능합니다.' });
    }

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
        message: `${remainDays}일 후에 표시명을 변경할 수 있습니다.`,
    });
});

/**
 * GET /api/me/contributions
 * 내가 편집한 문서 목록
 */
auth.get('/api/me/contributions', requireAuth, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;

    const { results } = await db
        .prepare(
            `SELECT DISTINCT p.slug, p.title, p.updated_at, p.category
         FROM revisions r
         JOIN pages p ON r.page_id = p.id
         WHERE r.author_id = ? AND p.deleted_at IS NULL
         ORDER BY p.updated_at DESC
         LIMIT 50`
        )
        .bind(user.id)
        .all();

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

    const userExists = await db.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
    if (!userExists) {
        return c.json({ error: '사용자를 찾을 수 없습니다.' }, 404);
    }

    const { results } = await db
        .prepare(
            `SELECT r.id as revision_id, r.summary, r.created_at,
                p.slug, p.title
         FROM revisions r
         JOIN pages p ON r.page_id = p.id
         WHERE r.author_id = ? AND p.deleted_at IS NULL
         ORDER BY r.created_at DESC
         LIMIT ? OFFSET ?`
        )
        .bind(userId, limit, offset)
        .all();

    const countResult = await db
        .prepare(
            `SELECT COUNT(*) as total
         FROM revisions r
         JOIN pages p ON r.page_id = p.id
         WHERE r.author_id = ? AND p.deleted_at IS NULL`
        )
        .bind(userId)
        .first<{ total: number }>();

    return c.json({
        contributions: results,
        total: countResult?.total || 0,
        has_more: offset + limit < (countResult?.total || 0),
    });
});

/**
 * DELETE /api/me/account
 * 회원탈퇴: role을 'deleted'로, 표시명을 '탈퇴한 사용자'로 변경하고 세션 삭제
 * user_oauth_accounts는 유지하여 재가입 차단
 */
auth.delete('/api/me/account', requireAuth, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;

    // 1. role을 'deleted'로, 이름을 '탈퇴한 사용자'로, picture 제거
    await db
        .prepare(`UPDATE users SET role = 'deleted', name = '탈퇴한 사용자', picture = NULL, email = '' WHERE id = ?`)
        .bind(user.id)
        .run();

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
