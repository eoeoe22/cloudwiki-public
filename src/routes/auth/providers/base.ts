import type { Context } from 'hono';
import type { Env } from '../../../types';

/**
 * OAuth 공급자 인터페이스
 * 모든 OAuth 공급자는 이 인터페이스를 구현해야 한다.
 */
export interface OAuthProvider {
    /** 공급자 식별자 (wrangler.toml AUTH_PROVIDERS 값과 일치) */
    name: string;

    /** 로그인 버튼 표시 텍스트 */
    label: string;

    /** 인증 페이지로 리디렉션 (CSRF state 생성 포함) */
    handleLogin(c: Context<Env>): Promise<Response>;

    /** OAuth 콜백 처리 → OAuthProfile 반환 */
    handleCallback(c: Context<Env>): Promise<OAuthProfile | Response>;
}

/**
 * OAuth 공급자에서 반환하는 사용자 프로필
 */
export interface OAuthProfile {
    provider: string;
    uid: string;
    email: string;
    name: string;
    picture?: string;
}
