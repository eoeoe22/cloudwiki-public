export interface OAuthUserInfo {
    id: string;
    email: string;
    name: string;
    picture: string | null;
    emailVerified: boolean;
}

export interface OAuthProvider {
    name: string;
    displayName: string;
    icon: string;
    getAuthUrl(state: string, env: Record<string, string>): string;
    exchangeCode(code: string, env: Record<string, string>): Promise<string>;
    getUserInfo(accessToken: string): Promise<OAuthUserInfo>;
}
