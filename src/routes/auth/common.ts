import type { Context } from 'hono';
import type { Env } from '../../types';
import type { OAuthProfile } from './providers/base';
import { isEmailDomainAllowed } from '../../utils/auth';

/**
 * OAuth 로그인 공통 처리:
 *  1. provider + uid로 기존 유저 조회
 *  2. 없으면 이메일 중복 체크 → 신규 유저 생성 (또는 승인제 처리)
 *  3. 세션 생성 후 쿠키 발급
 */
export async function handleOAuthLogin(c: Context<Env>, profile: OAuthProfile): Promise<Response> {
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
        try {
            await db
                .prepare('UPDATE users SET email = ?, picture = ? WHERE provider = ? AND uid = ?')
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

        await db
            .prepare('INSERT INTO users (provider, uid, email, name, picture) VALUES (?, ?, ?, ?, ?)')
            .bind(profile.provider, profile.uid, profile.email, finalName, profile.picture || null)
            .run();
    }

    // 2. user id 조회
    const user = await db
        .prepare('SELECT id FROM users WHERE provider = ? AND uid = ?')
        .bind(profile.provider, profile.uid)
        .first<{ id: number }>();

    if (!user) {
        return c.json({ error: 'User creation failed' }, 500);
    }

    // 3. 세션 생성 + 쿠키 발급
    await createSession(c, user.id);

    if (isNewUser) {
        return c.redirect('/setup-profile');
    }

    return c.redirect('/');
}

/**
 * 세션 생성 + 쿠키 설정
 */
export async function createSession(c: Context<Env>, userId: number): Promise<void> {
    const sessionId = crypto.randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7; // 7일
    const userAgent = c.req.header('User-Agent') || null;

    await c.env.DB
        .prepare('INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)')
        .bind(sessionId, userId, expiresAt, userAgent)
        .run();

    c.header(
        'Set-Cookie',
        `wiki_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`
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
