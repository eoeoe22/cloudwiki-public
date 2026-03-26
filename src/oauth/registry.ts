import { googleProvider } from './google';
import { discordProvider } from './discord';
import type { OAuthProvider } from './types';

const allProviders: Record<string, OAuthProvider> = {
    google: googleProvider,
    discord: discordProvider,
};

/**
 * 환경변수에 {PROVIDER}_CLIENT_ID가 존재하는 프로바이더만 활성화 (자동 감지)
 */
export function getEnabledProviders(env: Record<string, string>): OAuthProvider[] {
    return Object.values(allProviders).filter((p) => {
        const clientIdKey = `${p.name.toUpperCase()}_CLIENT_ID`;
        return !!(env as Record<string, string>)[clientIdKey];
    });
}

export function getProvider(name: string): OAuthProvider | undefined {
    return allProviders[name];
}

export function isProviderEnabled(name: string, env: Record<string, string>): boolean {
    const provider = allProviders[name];
    if (!provider) return false;
    const clientIdKey = `${provider.name.toUpperCase()}_CLIENT_ID`;
    return !!(env as Record<string, string>)[clientIdKey];
}
