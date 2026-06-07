import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env } from '../../types';
import { requireAuth, requireAuthAllowBanned } from '../../middleware/session';
import { getSuperAdmins } from '../../utils/auth';
import type { OAuthProvider, OAuthProfile, OAuthStateData } from './providers/base';
import { googleProvider } from './providers/google';
import { discordProvider } from './providers/discord';
import { handleOAuthLogin } from './common';
import type { RBAC } from '../../utils/role';
import { enrichRole } from '../../utils/role';
import type { AuthProvidersResponse } from '../../shared/api/auth';
import { dispatchDiscord } from '../../utils/webhook/discord';
import { signupPending } from '../../utils/webhook/events/signup';
import { createNotification } from '../../utils/notification';
import { sha256Hex } from '../../utils/oauth';

const auth = new Hono<Env>();

// ── 사용 가능한 공급자 레지스트리 ──
const providerRegistry: Record<string, OAuthProvider> = {
    google: googleProvider,
    discord: discordProvider,
};

/**
 * AUTH_PROVIDERS 환경변수를 파싱하여 활성화된 공급자 목록을 반환
 */
function parseProviders(authProviders: string): string[] {
    return (authProviders || '')
        .split(',')
        .map(p => p.trim().toLowerCase())
        .filter(Boolean);
}

// AUTH_PROVIDERS는 요청 시점에 env에서 가져와야 하므로, 모든 가능한 공급자 라우트를 등록하되
// 활성화 여부를 라우트 핸들러에서 체크한다.
for (const [name, provider] of Object.entries(providerRegistry)) {
    auth.get(`/auth/${name}`, async (c) => {
        const active = parseProviders(c.env.AUTH_PROVIDERS);
        if (!active.includes(name)) {
            return c.json({ error: 'This auth provider is not enabled' }, 404);
        }
        return provider.handleLogin(c);
    });

    auth.get(`/auth/${name}/callback`, async (c) => {
        const active = parseProviders(c.env.AUTH_PROVIDERS);
        if (!active.includes(name)) {
            return c.json({ error: 'This auth provider is not enabled' }, 404);
        }
        const result = await provider.handleCallback(c);
        if (result instanceof Response) return result;

        if (result.state.intent === 'refresh_picture') {
            return handleRefreshPicture(c, result.profile, result.state);
        }
        return handleOAuthLogin(c, result.profile, result.state.redirectUrl);
    });
}

/**
 * GET /auth/refresh-picture
 * 로그인된 사용자의 현재 OAuth 공급자로 재인증을 시작하여 프로필 사진을 갱신.
 * 콜백은 공급자의 기존 /auth/<provider>/callback 을 재사용하며, state에 담긴
 * intent=refresh_picture 값을 통해 분기 처리된다.
 */
auth.get('/auth/refresh-picture', requireAuth, async (c) => {
    const user = c.get('user')!;
    const active = parseProviders(c.env.AUTH_PROVIDERS);

    if (!active.includes(user.provider)) {
        return c.redirect('/mypage?picture_error=provider_not_enabled');
    }
    const provider = providerRegistry[user.provider];
    if (!provider) {
        return c.redirect('/mypage?picture_error=provider_not_supported');
    }

    return provider.handleLogin(c, {
        intent: 'refresh_picture',
        userId: user.id,
        expectedUid: user.uid,
    });
});

/**
 * refresh_picture 의도로 돌아온 OAuth 콜백 처리:
 *  - state에 담긴 userId/expectedUid 와 응답 프로필을 검증
 *  - 동일 계정임이 확인되면 users.picture 를 공급자에서 받은 값으로 갱신
 *  - 세션 KV 캐시 무효화 후 /mypage 로 돌아감
 */
async function handleRefreshPicture(
    c: Context<Env>,
    profile: OAuthProfile,
    stateData: OAuthStateData
): Promise<Response> {
    if (!stateData.userId || !stateData.expectedUid) {
        return c.redirect('/mypage?picture_error=invalid_state');
    }

    // 현재 로그인 세션과 state의 userId가 일치해야 함
    const currentUser = c.get('user');
    if (!currentUser || currentUser.id !== stateData.userId) {
        return c.redirect('/mypage?picture_error=session_mismatch');
    }

    // 재인증 결과의 uid가 기존 계정과 일치해야 함 (다른 계정으로 갱신 방지)
    if (profile.uid !== stateData.expectedUid || profile.provider !== currentUser.provider) {
        return c.redirect('/mypage?picture_error=account_mismatch');
    }

    const db = c.env.DB;
    const userRow = await db
        .prepare('SELECT id, provider, uid, role FROM users WHERE id = ?')
        .bind(stateData.userId)
        .first<{ id: number; provider: string; uid: string; role: string }>();

    if (!userRow || userRow.role === 'deleted') {
        return c.redirect('/mypage?picture_error=user_not_found');
    }
    if (userRow.provider !== profile.provider || userRow.uid !== profile.uid) {
        return c.redirect('/mypage?picture_error=account_mismatch');
    }

    await db
        .prepare('UPDATE users SET picture = ? WHERE id = ?')
        .bind(profile.picture || null, stateData.userId)
        .run();

    // 세션 KV 캐시 무효화 (변경된 picture 반영).
    // 리다이렉트 직후 /mypage가 재조회되므로 동기 삭제로 이전 picture 노출을 방지한다.
    const sessionId = getCookie(c, 'wiki_session');
    if (sessionId) {
        await c.env.KV.delete(`session:${sessionId}`);
    }

    return c.redirect('/mypage?picture_updated=1');
}

/**
 * GET /api/auth/providers
 * 활성화된 공급자 목록 반환 (login.html 동적 렌더링용)
 */
auth.get('/api/auth/providers', (c) => {
    const active = parseProviders(c.env.AUTH_PROVIDERS);
    const providers = active
        .filter(name => providerRegistry[name])
        .map(name => ({
            name,
            label: providerRegistry[name].label,
        }));
    return c.json<AuthProvidersResponse>({ providers });
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
        provider: string;
        uid: string;
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
        .prepare("SELECT id FROM signup_requests WHERE provider = ? AND uid = ? AND status = 'pending'")
        .bind(userInfo.provider, userInfo.uid)
        .first();
    if (existingPending) {
        await c.env.KV.delete(`signup_token:${token}`);
        return c.json({ error: '이미 가입 신청이 대기 중입니다.' }, 409);
    }

    // 차단 상태 확인
    const blockedRequest = await db
        .prepare("SELECT id FROM signup_requests WHERE provider = ? AND uid = ? AND status = 'blocked'")
        .bind(userInfo.provider, userInfo.uid)
        .first();
    if (blockedRequest) {
        await c.env.KV.delete(`signup_token:${token}`);
        return c.json({ error: '가입이 차단된 계정입니다.' }, 403);
    }

    // 가입 신청 INSERT
    const result = await db.prepare(
        'INSERT INTO signup_requests (provider, uid, email, name, picture, message) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(
        userInfo.provider,
        userInfo.uid,
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
    const notifContent = `${name.trim()}님이 가입을 신청했습니다.`;
    const adminLink = '/admin#signup-requests';
    for (const userId of notifyUserIds) {
        await createNotification(c.env, c.executionCtx, {
            userId,
            type: 'signup_request',
            content: notifContent,
            link: adminLink,
            refId: Number(requestId),
            push: {
                title: '새 가입 신청',
                body: notifContent,
                url: adminLink,
                tag: `signup_request:${requestId}`,
            },
        });
    }

    // 토큰 삭제
    await c.env.KV.delete(`signup_token:${token}`);

    // Discord admin 채널에 가입 신청 알림
    dispatchDiscord(c.env, c.executionCtx, signupPending({
        requestId: Number(requestId),
        name: name.trim(),
        email: userInfo.email,
        provider: userInfo.provider,
        env: c.env,
    }));

    // 가입 신청자가 결과 푸시를 옵트인할 때 사용할 단발성 토큰을 KV 에 발급한다.
    // 인증되지 않은 /api/push/subscribe-signup 엔드포인트가 이 토큰으로 신청 소유권을 검증한다.
    const pushToken = crypto.randomUUID();
    await c.env.KV.put(
        `signup_push_token:${pushToken}`,
        String(requestId),
        { expirationTtl: 300 }, // 5분
    );

    return c.json({
        success: true,
        message: '가입 신청이 접수되었습니다.',
        request_id: Number(requestId),
        push_token: pushToken,
    });
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
 * 세션 삭제 + KV 캐시 무효화 + 쿠키 제거
 */
auth.get('/auth/logout', async (c) => {
    const sessionId = getCookie(c, 'wiki_session');

    if (sessionId) {
        await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
        // KV 세션 캐시 무효화 (캐시된 세션으로 인한 로그아웃 지연 방지)
        await c.env.KV.delete(`session:${sessionId}`);
    }

    c.header('Set-Cookie', 'wiki_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    return c.redirect('/');
});

/**
 * GET /api/me
 * 현재 로그인한 유저 정보 반환 (차단된 사용자도 자신의 정보는 조회 가능)
 * permissions: 프런트엔드가 서버 RBAC와 동일하게 액션 버튼을 게이팅할 수 있도록
 * 주요 권한의 허용 여부를 불리언 맵으로 포함시킨다.
 */
auth.get('/api/me', (c) => {
    const user = c.get('user');
    if (!user) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const rbac = c.get('rbac') as RBAC;
    const permissionKeys = [
        'wiki:read', 'wiki:edit', 'wiki:delete', 'wiki:private',
        'comment:create', 'ticket:create', 'ticket:manage',
        'media:upload', 'discussion:manage', 'admin:access', 'user:manage',
    ] as const;
    const permissions: Record<string, boolean> = {};
    for (const key of permissionKeys) {
        permissions[key] = rbac.can(user.role, key);
    }
    return c.json({
        id: user.id,
        name: user.name,
        email: user.email,
        picture: user.picture,
        role: user.role,
        created_at: user.created_at,
        permissions,
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
        `SELECT DISTINCT p.slug, p.updated_at, p.category
         FROM revisions r
         JOIN pages p ON r.page_id = p.id
         WHERE r.author_id = ? AND p.deleted_at IS NULL
         ORDER BY p.updated_at DESC
         LIMIT 50`
    ).bind(user.id).all();

    return c.json({ contributions: results });
});

/**
 * GET /api/me/watches
 * 내가 주시 중인 문서·카테고리 목록
 *
 * 응답:
 *  {
 *    pages:      [{ slug, scope: 'this'|'subtree', created_at, updated_at, category }],
 *    categories: [{ category, created_at, page_count }]
 *  }
 *
 * 비공개 문서는 `wiki:private` 권한이 없는 사용자에게는 목록에서 숨긴다.
 * 주시 레코드 자체는 보존하므로 권한이 다시 부여되면 자동으로 다시 보인다.
 */
auth.get('/api/me/watches', requireAuth, async (c) => {
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;
    const canSeePrivate = rbac.can(user.role, 'wiki:private');
    const privateFilter = canSeePrivate ? '' : ' AND p.is_private = 0';

    const pagesQuery = await db.prepare(
        `SELECT p.slug, pw.scope, pw.created_at, p.updated_at, p.category
         FROM page_watches pw
         JOIN pages p ON p.id = pw.page_id
         WHERE pw.user_id = ? AND p.deleted_at IS NULL${privateFilter}
         ORDER BY p.updated_at DESC`
    ).bind(user.id).all();

    const categoriesQuery = await db.prepare(
        `SELECT cw.category,
                cw.created_at,
                (SELECT COUNT(*) FROM page_categories pc
                 JOIN pages p ON p.id = pc.page_id
                 WHERE pc.category = cw.category
                   AND p.deleted_at IS NULL${privateFilter}) AS page_count
         FROM category_watches cw
         WHERE cw.user_id = ?
         ORDER BY cw.created_at DESC`
    ).bind(user.id).all();

    return c.json({
        pages: pagesQuery.results || [],
        categories: categoriesQuery.results || [],
    });
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
    const rbac = c.get('rbac') as RBAC;
    const viewer = c.get('user');

    // 관리자인 경우 역할·차단 정보 포함 응답
    if (viewer && rbac.can(viewer.role, 'admin:access')) {
        const adminUser = await db
            .prepare('SELECT id, name, picture, role, banned_until, email, created_at FROM users WHERE id = ?')
            .bind(userId)
            .first<{ id: number; name: string; picture: string; role: string; banned_until: number | null; email: string; created_at: number }>();
        if (!adminUser || adminUser.role === 'deleted') {
            return c.json({ error: '사용자를 찾을 수 없습니다.' }, 404);
        }
        enrichRole(adminUser, 'role', 'email', c.env);
        // banned_until 만료 시 role 보정 (super_admin 보정 이후에 수행)
        if (adminUser.role !== 'super_admin') {
            const now = Math.floor(Date.now() / 1000);
            if (adminUser.role === 'banned' && (!adminUser.banned_until || adminUser.banned_until <= now)) {
                adminUser.role = 'user';
            }
        }
        return c.json({
            id: adminUser.id,
            name: adminUser.name,
            picture: adminUser.picture,
            created_at: adminUser.created_at,
            role: adminUser.role,
            banned_until: adminUser.banned_until,
        });
    }

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
                p.slug
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
 * GET /api/me/sessions
 * 현재 로그인 유저의 활성 세션 목록 (User-Agent 포함, 만료된 세션 제외)
 * 차단된 사용자도 자신의 세션을 관리할 수 있도록 허용
 */
auth.get('/api/me/sessions', requireAuthAllowBanned, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;
    const now = Math.floor(Date.now() / 1000);
    const currentSessionId = getCookie(c, 'wiki_session') || null;

    const { results } = await db.prepare(
        `SELECT id, expires_at, user_agent, created_at
         FROM sessions
         WHERE user_id = ? AND expires_at > ?
         ORDER BY COALESCE(created_at, expires_at - 604800) DESC`
    ).bind(user.id, now).all<{
        id: string;
        expires_at: number;
        user_agent: string | null;
        created_at: number | null;
    }>();

    const sessions = (results || []).map(s => ({
        id: s.id,
        expires_at: s.expires_at,
        // created_at 컬럼이 없는 기존 세션은 expires_at에서 7일을 빼서 추정
        created_at: s.created_at ?? (s.expires_at - 60 * 60 * 24 * 7),
        user_agent: s.user_agent,
        current: s.id === currentSessionId,
    }));

    return c.json({ sessions });
});

/**
 * DELETE /api/me/sessions/:id
 * 본인 소유의 특정 세션 종료 (현재 세션은 /auth/logout 사용)
 */
auth.delete('/api/me/sessions/:id', requireAuthAllowBanned, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;
    const sessionId = c.req.param('id');
    const currentSessionId = getCookie(c, 'wiki_session') || null;

    if (sessionId === currentSessionId) {
        return c.json({ error: '현재 세션은 로그아웃 메뉴로 종료해주세요.' }, 400);
    }

    const result = await db.prepare(
        'DELETE FROM sessions WHERE id = ? AND user_id = ?'
    ).bind(sessionId, user.id).run();

    if (!result.meta.changes) {
        return c.json({ error: '세션을 찾을 수 없습니다.' }, 404);
    }

    await c.env.KV.delete(`session:${sessionId}`);
    return c.json({ success: true });
});

/**
 * DELETE /api/me/sessions
 * 현재 세션을 제외한 본인의 모든 활성 세션 일괄 종료
 */
auth.delete('/api/me/sessions', requireAuthAllowBanned, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;
    const now = Math.floor(Date.now() / 1000);
    const currentSessionId = getCookie(c, 'wiki_session') || '';

    const { results } = await db.prepare(
        'SELECT id FROM sessions WHERE user_id = ? AND expires_at > ? AND id != ?'
    ).bind(user.id, now, currentSessionId).all<{ id: string }>();

    const sessionIds = (results || []).map(s => s.id);

    if (sessionIds.length > 0) {
        await db.prepare(
            'DELETE FROM sessions WHERE user_id = ? AND id != ?'
        ).bind(user.id, currentSessionId).run();

        await Promise.all(sessionIds.map(id => c.env.KV.delete(`session:${id}`)));
    }

    return c.json({ success: true, count: sessionIds.length });
});

/**
 * GET /api/me/mcp-clients
 * 현재 로그인 유저가 OAuth 동의를 통해 연결한 MCP 클라이언트 목록.
 * oauth_tokens 를 client_id 별로 집계하여 "어떤 클라이언트가 내 계정에 접근 권한을
 * 갖고 있는가" 를 보여준다. 개별 토큰(refresh rotation 시마다 새 row 가 생성됨) 단위의
 * 노출은 사용자 입장에서 의미가 없기 때문에 클라이언트 단위로만 노출한다.
 * - status='active': 현재 비폐기 + 미만료 토큰이 1개 이상 존재
 * - status='inactive': 최근 7일 이내 폐기/만료된 토큰만 존재 (정자정 크론이 7일 후 삭제)
 * 토큰 평문/해시는 절대 노출하지 않는다.
 */
auth.get('/api/me/mcp-clients', requireAuthAllowBanned, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;
    const now = Math.floor(Date.now() / 1000);
    const since = now - 60 * 60 * 24 * 7;

    const { results } = await db.prepare(
        `SELECT t.client_id,
                MAX(c.client_name) AS client_name,
                MAX(t.last_used_at) AS last_used_at,
                MAX(t.revoked_at) AS last_revoked_at,
                GROUP_CONCAT(t.scope, ' ') AS scopes,
                GROUP_CONCAT(CASE
                        WHEN t.revoked_at IS NULL
                         AND COALESCE(t.refresh_expires_at, t.access_expires_at) > ?
                        THEN t.scope
                    END, ' ') AS active_scopes,
                SUM(CASE
                        WHEN t.revoked_at IS NULL
                         AND COALESCE(t.refresh_expires_at, t.access_expires_at) > ?
                        THEN 1 ELSE 0
                    END) AS active_tokens
         FROM oauth_tokens t
         LEFT JOIN oauth_clients c ON c.client_id = t.client_id
         WHERE t.user_id = ?
           AND COALESCE(t.revoked_at, t.refresh_expires_at, t.access_expires_at) >= ?
         GROUP BY t.client_id
         ORDER BY (SUM(CASE
                          WHEN t.revoked_at IS NULL
                           AND COALESCE(t.refresh_expires_at, t.access_expires_at) > ?
                          THEN 1 ELSE 0
                      END) > 0) DESC,
                  COALESCE(MAX(t.last_used_at), MAX(t.created_at), 0) DESC`
    ).bind(now, now, user.id, since, now).all<{
        client_id: string;
        client_name: string | null;
        last_used_at: number | null;
        last_revoked_at: number | null;
        scopes: string | null;
        active_scopes: string | null;
        active_tokens: number;
    }>();

    const splitScopes = (raw: string | null): string[] => {
        if (!raw) return [];
        // OAuth scope-token 은 공백만 금지(RFC 6749 §3.3) — 따라서 row 간 결합은
        // GROUP_CONCAT(scope, ' ') 로 공백 구분, 토큰 분리는 공백 split 만 사용한다.
        // 콤마 등 다른 문자는 scope-token 내부 값으로 유효하므로 split 대상이 아님.
        const set = new Set<string>();
        for (const s of raw.split(/\s+/)) {
            if (s) set.add(s);
        }
        return [...set].sort();
    };

    const clients = (results || []).map(r => {
        const isActive = r.active_tokens > 0;
        // 활성 토큰이 있으면 현재 부여된 권한(active_scopes), 없으면 최근 7일 내 토큰의 scope 합집합.
        const scopes = isActive ? splitScopes(r.active_scopes) : splitScopes(r.scopes);
        return {
            client_id: r.client_id,
            client_name: r.client_name,
            scopes,
            status: isActive ? 'active' as const : 'inactive' as const,
            active_tokens: r.active_tokens,
            last_used_at: r.last_used_at,
            last_revoked_at: isActive ? null : r.last_revoked_at,
        };
    });

    return c.json({ clients });
});

/**
 * DELETE /api/me/mcp-clients/:client_id
 * 본인 계정과 연결된 특정 MCP 클라이언트의 모든 활성 토큰을 일괄 폐기.
 * oauth_clients 행 자체는 다른 유저도 같은 client_id 를 사용할 수 있으므로 건드리지 않는다.
 */
auth.delete('/api/me/mcp-clients/:client_id', requireAuthAllowBanned, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;
    const clientId = c.req.param('client_id');
    if (!clientId) {
        return c.json({ error: '잘못된 client_id 입니다.' }, 400);
    }

    const result = await db.prepare(
        `UPDATE oauth_tokens SET revoked_at = unixepoch()
         WHERE user_id = ? AND client_id = ?
           AND revoked_at IS NULL
           AND COALESCE(refresh_expires_at, access_expires_at) > unixepoch()`
    ).bind(user.id, clientId).run();

    if (!result.meta.changes) {
        return c.json({ error: '연결된 활성 토큰이 없습니다.' }, 404);
    }
    return c.json({ success: true, count: result.meta.changes });
});

/**
 * DELETE /api/me/mcp-clients
 * 본인의 모든 활성 MCP 토큰 일괄 폐기 (모든 클라이언트 연결 해제).
 */
auth.delete('/api/me/mcp-clients', requireAuthAllowBanned, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;

    const result = await db.prepare(
        `UPDATE oauth_tokens SET revoked_at = unixepoch()
         WHERE user_id = ?
           AND revoked_at IS NULL
           AND COALESCE(refresh_expires_at, access_expires_at) > unixepoch()`
    ).bind(user.id).run();

    return c.json({ success: true, count: result.meta.changes ?? 0 });
});

/**
 * DELETE /api/me/account
 * 회원탈퇴: role을 'deleted'로, 표시명을 '탈퇴한 사용자'로 변경하고 세션 삭제
 * provider + uid는 유지하여 재가입 차단
 */
auth.delete('/api/me/account', requireAuth, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;

    // 1. role을 'deleted'로, 이름을 '탈퇴한 사용자'로, picture 제거
    //    email은 UNIQUE 제약이 있으므로 id 기반의 유일한 placeholder로 설정
    //    (다수 유저 탈퇴 시 UNIQUE 충돌 방지)
    await db.prepare(
        `UPDATE users SET role = 'deleted', name = '탈퇴한 사용자', picture = NULL, email = 'deleted:' || id WHERE id = ?`
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

/**
 * GET /api/me/mcp-api-key
 * 현재 로그인한 사용자의 MCP API 키 정보 조회
 */
auth.get('/api/me/mcp-api-key', requireAuth, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;
    try {
        const row = await db
            .prepare('SELECT masked_key, expires_at, created_at FROM mcp_api_keys WHERE user_id = ?')
            .bind(user.id)
            .first<{ masked_key: string; expires_at: number; created_at: number }>();

        return c.json({ apiKey: row || null });
    } catch {
        // DB 마이그레이션 전 등으로 테이블이 없는 경우 조용히 null 반환하여 UI 먹통 방지
        return c.json({ apiKey: null });
    }
});

/**
 * POST /api/me/mcp-api-key
 * MCP API 키 생성 또는 갱신 (30일 고정 수명)
 */
auth.post('/api/me/mcp-api-key', requireAuth, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;

    // 32바이트 보안 랜덤 바이트 생성
    const rawBytes = new Uint8Array(32);
    crypto.getRandomValues(rawBytes);
    const keyString = 'mcp_' + Array.from(rawBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    const keyHash = await sha256Hex(keyString);
    const maskedKey = keyString.slice(0, 8) + '...' + keyString.slice(-4);
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30일 고정

    try {
        await db
            .prepare(
                `INSERT OR REPLACE INTO mcp_api_keys (user_id, key_hash, masked_key, expires_at, created_at)
                 VALUES (?, ?, ?, ?, unixepoch())`
            )
            .bind(user.id, keyHash, maskedKey, expiresAt)
            .run();

        return c.json({
            rawKey: keyString,
            maskedKey,
            expiresAt,
        });
    } catch (err: any) {
        if (err?.message?.includes('no such table')) {
            return c.json({ error: 'DB에 mcp_api_keys 테이블이 존재하지 않습니다. 마이데이터 마이그레이션을 먼저 적용해주십시오.' }, 500);
        }
        return c.json({ error: err.message || 'API 키 발급 중 오류가 발생했습니다.' }, 500);
    }
});

/**
 * DELETE /api/me/mcp-api-key
 * MCP API 키 삭제
 */
auth.delete('/api/me/mcp-api-key', requireAuth, async (c) => {
    const user = c.get('user')!;
    const db = c.env.DB;

    try {
        await db.prepare('DELETE FROM mcp_api_keys WHERE user_id = ?').bind(user.id).run();
        return c.json({ success: true });
    } catch (err: any) {
        if (err?.message?.includes('no such table')) {
            return c.json({ error: 'DB에 mcp_api_keys 테이블이 존재하지 않습니다.' }, 500);
        }
        return c.json({ error: err.message || 'API 키 삭제 중 오류가 발생했습니다.' }, 500);
    }
});


export default auth;
