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

    /**
     * 인증 페이지로 리디렉션 (CSRF state 생성 포함).
     * stateData로 의도(intent)와 부가 정보를 state KV에 함께 저장할 수 있다.
     */
    handleLogin(c: Context<Env>, stateData?: Partial<OAuthStateData>): Promise<Response>;

    /** OAuth 콜백 처리 → 프로필 + state 데이터 반환 */
    handleCallback(c: Context<Env>): Promise<OAuthCallbackResult | Response>;
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

/**
 * OAuth state KV에 저장되는 의도/컨텍스트 데이터
 * - login: 일반 로그인 흐름
 * - refresh_picture: 로그인 상태에서 프로필 사진만 갱신
 */
export interface OAuthStateData {
    provider: string;
    intent: 'login' | 'refresh_picture';
    /** refresh_picture 의도일 때 갱신 대상 유저 id */
    userId?: number;
    /** refresh_picture 의도일 때 기대되는 공급자 측 uid */
    expectedUid?: string;
}

/**
 * handleCallback의 성공 결과: 프로필과 state 데이터를 함께 반환
 */
export interface OAuthCallbackResult {
    profile: OAuthProfile;
    state: OAuthStateData;
}
