import type { Context } from 'hono';
import type { Env } from '../../../types';
import type { OAuthProvider, OAuthProfile } from './base';

export const discordProvider: OAuthProvider = {
    name: 'discord',
    label: 'Discord',

    async handleLogin(c: Context<Env>): Promise<Response> {
        if (!c.env.DISCORD_CLIENT_ID || !c.env.DISCORD_REDIRECT_URI) {
            return c.redirect('/?error=oauth_not_configured&provider=discord');
        }

        const state = crypto.randomUUID();
        await c.env.KV.put(`oauth_state:${state}`, 'discord', { expirationTtl: 300 });

        const params = new URLSearchParams({
            client_id: c.env.DISCORD_CLIENT_ID,
            redirect_uri: c.env.DISCORD_REDIRECT_URI,
            response_type: 'code',
            scope: 'identify email',
            state,
        });
        return c.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
    },

    async handleCallback(c: Context<Env>): Promise<OAuthProfile | Response> {
        const code = c.req.query('code');
        const state = c.req.query('state');

        // CSRF 검증 (상태 관련 에러는 technical한 공격 지표일 수 있으므로 JSON 403 유지)
        if (!state) {
            return c.json({ error: 'Missing state parameter' }, 403);
        }
        const storedState = await c.env.KV.get(`oauth_state:${state}`);
        if (storedState !== 'discord') {
            return c.json({ error: 'Invalid or expired state parameter' }, 403);
        }
        await c.env.KV.delete(`oauth_state:${state}`);

        if (!code) {
            return c.redirect('/?error=auth_missing_code&provider=discord');
        }

        // 1. code → access_token 교환
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: c.env.DISCORD_CLIENT_ID,
                client_secret: c.env.DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code,
                redirect_uri: c.env.DISCORD_REDIRECT_URI,
            }),
        });

        if (!tokenRes.ok) {
            const err = await tokenRes.text();
            console.error('Discord token exchange failed:', err);
            return c.redirect('/?error=auth_token_exchange_failed&provider=discord');
        }

        const tokenData = (await tokenRes.json()) as { access_token: string };

        // 2. access_token → user info 조회
        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: {
                Authorization: `Bearer ${tokenData.access_token}`,
            },
        });

        if (!userRes.ok) {
            return c.redirect('/?error=auth_user_info_failed&provider=discord');
        }

        const discordUser = (await userRes.json()) as {
            id: string;
            username: string;
            global_name: string | null;
            avatar: string | null;
            email: string | null;
            verified: boolean;
        };

        if (!discordUser.verified || !discordUser.email) {
            return c.redirect('/?error=email_not_verified&provider=discord');
        }

        // Discord 아바타 URL 생성
        let picture: string | undefined;
        if (discordUser.avatar) {
            picture = `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`;
        }

        return {
            provider: 'discord',
            uid: discordUser.id,
            email: discordUser.email,
            name: discordUser.global_name || discordUser.username,
            picture,
        };
    },
};
