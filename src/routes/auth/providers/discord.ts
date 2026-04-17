import type { Context } from 'hono';
import type { Env } from '../../../types';
import type { OAuthProvider, OAuthCallbackResult, OAuthStateData } from './base';

export const discordProvider: OAuthProvider = {
    name: 'discord',
    label: 'Discord',

    async handleLogin(c: Context<Env>, stateData?: Partial<OAuthStateData>): Promise<Response> {
        if (!c.env.DISCORD_CLIENT_ID || !c.env.DISCORD_REDIRECT_URI) {
            return c.redirect('/?error=oauth_not_configured&provider=discord');
        }

        const state = crypto.randomUUID();
        const payload: OAuthStateData = {
            provider: 'discord',
            intent: stateData?.intent ?? 'login',
            userId: stateData?.userId,
            expectedUid: stateData?.expectedUid,
        };
        await c.env.KV.put(`oauth_state:${state}`, JSON.stringify(payload), { expirationTtl: 300 });

        const params = new URLSearchParams({
            client_id: c.env.DISCORD_CLIENT_ID,
            redirect_uri: c.env.DISCORD_REDIRECT_URI,
            response_type: 'code',
            scope: 'identify email',
            state,
            prompt: 'consent',
        });
        return c.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
    },

    async handleCallback(c: Context<Env>): Promise<OAuthCallbackResult | Response> {
        const code = c.req.query('code');
        const state = c.req.query('state');

        // CSRF 검증
        if (!state) {
            return c.redirect('/error?reason=' + encodeURIComponent('로그인 요청이 올바르지 않습니다. 다시 시도해주세요.'));
        }
        const storedRaw = await c.env.KV.get(`oauth_state:${state}`);
        if (!storedRaw) {
            return c.redirect('/error?reason=' + encodeURIComponent('로그인 세션이 만료되었거나 유효하지 않습니다. 다시 시도해주세요.'));
        }

        // 구 포맷(단순 'discord' 문자열) 폴백: 배포 전환 시점에 이미 진행 중이던 로그인 호환용
        let stateData: OAuthStateData;
        if (storedRaw === 'discord') {
            stateData = { provider: 'discord', intent: 'login' };
        } else {
            try {
                stateData = JSON.parse(storedRaw) as OAuthStateData;
            } catch {
                await c.env.KV.delete(`oauth_state:${state}`);
                return c.redirect('/error?reason=' + encodeURIComponent('로그인 세션이 올바르지 않습니다. 다시 시도해주세요.'));
            }
        }
        if (stateData.provider !== 'discord') {
            await c.env.KV.delete(`oauth_state:${state}`);
            return c.redirect('/error?reason=' + encodeURIComponent('로그인 세션이 유효하지 않습니다. 다시 시도해주세요.'));
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
            profile: {
                provider: 'discord',
                uid: discordUser.id,
                email: discordUser.email,
                name: discordUser.global_name || discordUser.username,
                picture,
            },
            state: stateData,
        };
    },
};
