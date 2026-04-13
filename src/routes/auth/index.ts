import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env } from '../../types';
import { requireAuth } from '../../middleware/session';
import { getSuperAdmins } from '../../utils/auth';
import type { OAuthProvider } from './providers/base';
import { googleProvider } from './providers/google';
import { discordProvider } from './providers/discord';
import { handleOAuthLogin } from './common';

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
        return handleOAuthLogin(c, result);
    });
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
    return c.json({ providers });
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

export default auth;
