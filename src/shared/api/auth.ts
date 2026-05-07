/**
 * /api/auth/* 응답·요청 DTO.
 *
 * 서버 핸들러는 `c.json<DTO>(...)` 로 명시하고, 클라이언트는 `apiGet<DTO>(...)`
 * 또는 `apiPost<Req, Res>(...)` 로 호출하여 양쪽이 동일한 계약을 공유한다.
 */

/** GET /api/auth/providers 응답에 포함되는 단일 OAuth 공급자 항목 */
export interface AuthProviderEntry {
    /** 공급자 식별자 (wrangler.toml AUTH_PROVIDERS 항목과 동일) */
    name: string;
    /** 로그인 버튼 라벨. 서버는 OAuthProvider.label 을 그대로 내려준다. */
    label: string;
}

/** GET /api/auth/providers 응답 */
export interface AuthProvidersResponse {
    providers: AuthProviderEntry[];
}
