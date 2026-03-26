import type { OAuthProvider, OAuthUserInfo } from './types';

export const googleProvider: OAuthProvider = {
    name: 'google',
    displayName: 'Google',
    icon: 'mdi-google',

    getAuthUrl(state: string, env: Record<string, string>): string {
        const params = new URLSearchParams({
            client_id: env.GOOGLE_CLIENT_ID,
            redirect_uri: env.GOOGLE_REDIRECT_URI,
            response_type: 'code',
            scope: 'openid email profile',
            access_type: 'offline',
            prompt: 'consent',
            state,
        });
        return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    },

    async exchangeCode(code: string, env: Record<string, string>): Promise<string> {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: env.GOOGLE_CLIENT_ID,
                client_secret: env.GOOGLE_CLIENT_SECRET,
                redirect_uri: env.GOOGLE_REDIRECT_URI,
                grant_type: 'authorization_code',
            }),
        });

        if (!tokenRes.ok) {
            const err = await tokenRes.text();
            console.error('Google token exchange failed:', err);
            throw new Error('Token exchange failed');
        }

        const tokenData = (await tokenRes.json()) as { access_token: string };
        return tokenData.access_token;
    },

    async getUserInfo(accessToken: string): Promise<OAuthUserInfo> {
        const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!userRes.ok) {
            throw new Error('Failed to fetch Google user info');
        }

        const userInfo = (await userRes.json()) as {
            id: string;
            email: string;
            name: string;
            picture: string;
            verified_email?: boolean;
            email_verified?: boolean;
        };

        return {
            id: userInfo.id,
            email: userInfo.email,
            name: userInfo.name,
            picture: userInfo.picture || null,
            emailVerified: !!(userInfo.verified_email || userInfo.email_verified),
        };
    },
};
