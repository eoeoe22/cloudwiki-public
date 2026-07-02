import type { Context } from 'hono';
import type { Env } from '../../types';
import type { OAuthProfile } from './providers/base';
import { isEmailDomainAllowed } from '../../utils/auth';
import { dispatchDiscord } from '../../utils/webhook/discord';
import { userJoined } from '../../utils/webhook/events/signup';

/**
 * OAuth 로그인 공통 처리:
 *  1. provider + uid로 기존 유저 조회
 *  2. 없으면 이메일 중복 체크 → 신규 유저 생성 (또는 승인제 처리)
 *  3. 세션 생성 후 쿠키 발급
 */
/**
 * 세션 수명(초).
 *  - REMEMBER: "로그인 유지" 체크 시. 매우 길게(1년) 발급한다.
 *  - DEFAULT : 미체크 시. 6시간 후 만료.
 */
export const SESSION_TTL_REMEMBER = 60 * 60 * 24 * 365; // 1년
export const SESSION_TTL_DEFAULT = 60 * 60 * 6; // 6시간

export async function handleOAuthLogin(c: Context<Env>, profile: OAuthProfile, redirectUrl?: string, remember = false): Promise<Response> {
    const db = c.env.DB;

    let isNewUser = false;

    // 1. 기존 유저 확인 (provider + uid)
    const existingUser = await db
        .prepare('SELECT id, role FROM users WHERE provider = ? AND uid = ?')
        .bind(profile.provider, profile.uid)
        .first<{ id: number; role: string }>();

    if (existingUser && existingUser.role === 'deleted') {
        return c.redirect('/?error=deleted_account');
    }

    if (existingUser) {
        // 기존 유저: 이메일이 다른 계정과 충돌하는지 먼저 확인
        const emailDup = await db
            .prepare('SELECT provider FROM users WHERE email = ? AND (provider != ? OR uid != ?)')
            .bind(profile.email, profile.provider, profile.uid)
            .first<{ provider: string }>();
        if (emailDup) {
            return c.redirect(`/?error=email_already_registered&provider=${encodeURIComponent(emailDup.provider)}`);
        }

        // 기존 유저: 이름은 유지 (수동으로 변경한 이름이 로그인마다 초기화되지 않도록)
        // picture_private=1 인 경우 공급자 사진으로 picture 를 덮어쓰지 않아 비공개 설정을 보존한다.
        try {
            await db
                .prepare('UPDATE users SET email = ?, picture = CASE WHEN picture_private = 1 THEN picture ELSE ? END WHERE provider = ? AND uid = ?')
                .bind(profile.email, profile.picture || null, profile.provider, profile.uid)
                .run();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('UNIQUE constraint failed') || message.includes('users.email')) {
                return c.redirect('/?error=email_already_registered');
            }
            throw error;
        }
    } else {
        isNewUser = true;

        // 이메일 중복 체크 (다른 공급자로 이미 가입된 이메일)
        const emailDup = await db
            .prepare('SELECT provider FROM users WHERE email = ?')
            .bind(profile.email)
            .first<{ provider: string }>();
        if (emailDup) {
            return c.redirect(`/?error=email_already_registered&provider=${encodeURIComponent(emailDup.provider)}`);
        }

        // 이메일 도메인 필터링
        if (!isEmailDomainAllowed(profile.email, c.env.EMAIL_RESTRICTION, c.env.EMAIL_LIST)) {
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
                .prepare('SELECT id, status FROM signup_requests WHERE provider = ? AND uid = ? ORDER BY created_at DESC LIMIT 1')
                .bind(profile.provider, profile.uid)
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
                provider: profile.provider,
                uid: profile.uid,
                email: profile.email,
                name: profile.name,
                picture: profile.picture,
            }), { expirationTtl: 600 });

            return c.redirect(`/setup-profile?mode=approval&token=${signupToken}`);
        }

        // 모두 허용: 바로 유저 생성
        const finalName = await resolveUniqueName(db, profile.name);

        const insertResult = await db
            .prepare('INSERT INTO users (provider, uid, email, name, picture) VALUES (?, ?, ?, ?, ?)')
            .bind(profile.provider, profile.uid, profile.email, finalName, profile.picture || null)
            .run();

        // open 정책 신규 가입 → community 채널 환영 알림
        const newUserId = Number(insertResult.meta?.last_row_id ?? 0);
        if (newUserId > 0) {
            dispatchDiscord(c.env, c.executionCtx, userJoined({
                user: { id: newUserId, name: finalName, picture: profile.picture || null },
                env: c.env,
            }));
        }
    }

    // 2. user id 조회
    const user = await db
        .prepare('SELECT id FROM users WHERE provider = ? AND uid = ?')
        .bind(profile.provider, profile.uid)
        .first<{ id: number }>();

    if (!user) {
        return c.redirect('/error?reason=' + encodeURIComponent('계정 생성에 실패했습니다. 다시 시도해주세요.'));
    }

    // 3. 세션 생성 + 쿠키 발급
    await createSession(c, user.id, remember);

    if (isNewUser) {
        return c.redirect('/setup-profile');
    }

    const safeRedirect = (redirectUrl && redirectUrl.startsWith('/') && !redirectUrl.startsWith('//') && !/[\x00-\x1f\x7f]/.test(redirectUrl))
        ? redirectUrl
        : '/';
    return c.redirect(safeRedirect);
}

/**
 * 세션 생성 + 쿠키 설정
 * @param remember "로그인 유지" 여부. true 면 매우 긴 수명, 아니면 6시간.
 */
export async function createSession(c: Context<Env>, userId: number, remember = false): Promise<void> {
    const sessionId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const maxAge = remember ? SESSION_TTL_REMEMBER : SESSION_TTL_DEFAULT;
    const expiresAt = now + maxAge;
    const userAgent = c.req.header('User-Agent') || null;

    await c.env.DB
        .prepare('INSERT INTO sessions (id, user_id, expires_at, user_agent, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(sessionId, userId, expiresAt, userAgent, now)
        .run();

    c.header(
        'Set-Cookie',
        `wiki_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
    );
}

/**
 * 유저 이름 중복 시 suffix 처리
 */
export async function resolveUniqueName(db: D1Database, baseName: string): Promise<string> {
    let finalName = baseName;
    const nameExists = await db
        .prepare('SELECT COUNT(*) as cnt FROM users WHERE name = ?')
        .bind(finalName)
        .first<{ cnt: number }>();

    if (nameExists && nameExists.cnt > 0) {
        let suffix = 2;
        while (true) {
            const candidateName = `${baseName} ${suffix}`;
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

    return finalName;
}
