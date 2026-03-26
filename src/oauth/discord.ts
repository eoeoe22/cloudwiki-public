import type { OAuthProvider, OAuthUserInfo } from './types';

export const discordProvider: OAuthProvider = {
    name: 'discord',
    displayName: 'Discord',
    icon: 'mdi-message-text',

    getAuthUrl(state: string, env: Record<string, string>): string {
        const params = new URLSearchParams({
            client_id: env.DISCORD_CLIENT_ID,
            redirect_uri: env.DISCORD_REDIRECT_URI,
            response_type: 'code',
            scope: 'identify email',
            state,
        });
        return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
    },

    async exchangeCode(code: string, env: Record<string, string>): Promise<string> {
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: env.DISCORD_CLIENT_ID,
                client_secret: env.DISCORD_CLIENT_SECRET,
                redirect_uri: env.DISCORD_REDIRECT_URI,
                grant_type: 'authorization_code',
            }),
        });

        if (!tokenRes.ok) {
            const err = await tokenRes.text();
            console.error('Discord token exchange failed:', err);
            throw new Error('Token exchange failed');
        }

        const tokenData = (await tokenRes.json()) as { access_token: string };
        return tokenData.access_token;
    },

    async getUserInfo(accessToken: string): Promise<OAuthUserInfo> {
        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!userRes.ok) {
            throw new Error('Failed to fetch Discord user info');
        }

        const userInfo = (await userRes.json()) as {
            id: string;
            email: string;
            username: string;
            global_name: string | null;
            avatar: string | null;
            verified: boolean;
        };

        const picture = userInfo.avatar
            ? `https://cdn.discordapp.com/avatars/${userInfo.id}/${userInfo.avatar}.png`
            : null;

        return {
            id: userInfo.id,
            email: userInfo.email,
            name: userInfo.global_name || userInfo.username,
            picture,
            emailVerified: userInfo.verified,
        };
    },
};
