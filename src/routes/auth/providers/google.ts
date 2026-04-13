import type { Context } from 'hono';
import type { Env } from '../../../types';
import type { OAuthProvider, OAuthProfile } from './base';

export const googleProvider: OAuthProvider = {
    name: 'google',
    label: 'Google',

    async handleLogin(c: Context<Env>): Promise<Response> {
        if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_REDIRECT_URI) {
            return c.redirect('/?error=oauth_not_configured&provider=google');
        }

        const state = crypto.randomUUID();
        await c.env.KV.put(`oauth_state:${state}`, 'google', { expirationTtl: 300 });

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
    },

    async handleCallback(c: Context<Env>): Promise<OAuthProfile | Response> {
        const code = c.req.query('code');
        const state = c.req.query('state');

        // CSRF 검증
        if (!state) {
            return c.redirect('/error?reason=' + encodeURIComponent('로그인 요청이 올바르지 않습니다. 다시 시도해주세요.'));
        }
        const storedState = await c.env.KV.get(`oauth_state:${state}`);
        if (storedState !== 'google') {
            return c.redirect('/error?reason=' + encodeURIComponent('로그인 세션이 만료되었거나 유효하지 않습니다. 다시 시도해주세요.'));
        }
        await c.env.KV.delete(`oauth_state:${state}`);

        if (!code) {
            return c.redirect('/?error=auth_missing_code&provider=google');
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
            console.error('Google token exchange failed:', err);
            return c.redirect('/?error=auth_token_exchange_failed&provider=google');
        }

        const tokenData = (await tokenRes.json()) as { access_token: string };

        // 2. access_token → userinfo 조회
        const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });

        if (!userRes.ok) {
            return c.redirect('/?error=auth_user_info_failed&provider=google');
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
            return c.redirect('/?error=email_not_verified&provider=google');
        }

        return {
            provider: 'google',
            uid: userInfo.id,
            email: userInfo.email,
            name: userInfo.name,
            picture: userInfo.picture,
        };
    },
};
