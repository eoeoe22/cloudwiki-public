// 관리자 MCP 서버용 OAuth 2.1 (RFC 6749/8414/9728/7591/7636) 공통 유틸리티.
// - 토큰: 32 bytes 무작위 → base64url. DB 에는 SHA-256 hex 만 저장.
// - PKCE: S256 (SHA-256(verifier) → base64url == code_challenge).

const TEXT_ENCODER = new TextEncoder();

export function base64urlEncode(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin);
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateOpaqueToken(byteLength: number = 32): string {
    const buf = new Uint8Array(byteLength);
    crypto.getRandomValues(buf);
    return base64urlEncode(buf);
}

export async function sha256Hex(input: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', TEXT_ENCODER.encode(input));
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
}

export async function sha256Base64Url(input: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', TEXT_ENCODER.encode(input));
    return base64urlEncode(new Uint8Array(digest));
}

// PKCE S256: BASE64URL(SHA256(code_verifier)) == code_challenge
export async function verifyPkce(codeVerifier: string, codeChallenge: string, method: string): Promise<boolean> {
    if (method !== 'S256') return false;
    if (!codeVerifier || codeVerifier.length < 43 || codeVerifier.length > 128) return false;
    const computed = await sha256Base64Url(codeVerifier);
    return timingSafeEqual(computed, codeChallenge);
}

export function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

export function isValidRedirectUri(uri: string): boolean {
    try {
        const u = new URL(uri);
        // localhost / 127.0.0.1 (any port, http 허용 — Claude Desktop 등 native client 콜백)
        if ((u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')
            && (u.protocol === 'http:' || u.protocol === 'https:')) {
            return true;
        }
        // 그 외에는 https 만 허용
        return u.protocol === 'https:';
    } catch {
        return false;
    }
}

// 통합 MCP 엔드포인트(/api/mcp) 의 단일 스코프. 일반 사용자도 OAuth 로 인증해 읽기 도구를
// 호출할 수 있으며, 도구 목록은 토큰 사용자의 역할(admin:access 여부) 에 따라 서버 측에서
// 분기된다. 별도의 admin 전용 스코프를 두지 않는다 — 권한 상승은 RBAC 가 일임한다.
export const OAUTH_SCOPE_MCP = 'mcp';
// 구버전 호환: admin-mcp 스코프로 발급된 기존 토큰 / 클라이언트 등록도 그대로 받아준다.
// 스코프 문자열은 단순 라벨로 취급하고, 실제 도구 호출 시점에 역할로 권한을 검증한다.
export const OAUTH_SCOPE_ADMIN_MCP = 'admin-mcp';
export const OAUTH_ACCEPTED_SCOPES = new Set<string>([OAUTH_SCOPE_MCP, OAUTH_SCOPE_ADMIN_MCP]);
export const ACCESS_TOKEN_TTL_SEC = 60 * 60;             // 1h
export const REFRESH_TOKEN_TTL_SEC = 60 * 60 * 24 * 30;  // 30d
export const AUTH_CODE_TTL_SEC = 60;                      // 60s
