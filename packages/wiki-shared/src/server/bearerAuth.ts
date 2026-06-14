/**
 * MCP Bearer 토큰 인증 공용 로직 — 앱 독립 버전.
 *
 * cloudwiki(`src/utils/mcpAuth.ts`)와 cloudspace 양쪽에서 공유하는 단일 소스.
 * 각 앱의 Cloudflare D1 DB 바인딩을 직접 주입받아 mcp_api_keys / oauth_tokens
 * 테이블을 조회한다.
 *
 * 두 호출자가 갈리는 정책 (Authorization 헤더 부재 처리 / 권한 부족 처리) 은
 * 이 함수가 결정하지 않는다. 토큰을 해석해 판별 가능한 결과만 돌려주고,
 * 각 라우트가 자기 정책에 맞춰 분기한다.
 */

/** MCP OAuth 스코프 상수 (두 앱 공용). */
export const OAUTH_SCOPE_MCP       = 'mcp';
export const OAUTH_SCOPE_ADMIN_MCP = 'admin-mcp';
export const OAUTH_ACCEPTED_SCOPES = new Set<string>([OAUTH_SCOPE_MCP, OAUTH_SCOPE_ADMIN_MCP]);

/** SHA-256 헥스 다이제스트 (Web Crypto, Workers/Node 양쪽 지원). */
export async function sha256Hex(input: string): Promise<string> {
    const data = new TextEncoder().encode(input);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/** 공통 사용자 행 shape (mcp_api_keys / oauth_tokens JOIN users 결과). */
export interface BearerUserRow {
    uid: number;
    provider: string;
    provider_uid: string;
    email: string;
    name: string;
    picture: string | null;
    picture_private: number;
    role: string;
    banned_until: number | null;
    last_namechange: number | null;
    created_at: number;
}

/**
 * resolveBearerAuth 결과.
 *  - `none`          : Authorization 헤더 없음.
 *  - `error`         : 토큰 invalid·expired·revoked·scope 부적합 → error 메시지 동봉.
 *  - `authenticated` : 토큰 해석 성공. effectiveRole 은 banned_until / isSuperAdmin 보정 전 raw role.
 *                      호출자가 isSuperAdmin 로직을 적용한 뒤 effectiveRole 을 최종 결정한다.
 */
export type BearerAuthResult =
    | { kind: 'none' }
    | { kind: 'error'; message: string }
    | { kind: 'authenticated'; user: BearerUserRow; tokenId: number | null; scope: string | null };

/**
 * D1 Database 바인딩의 최소 인터페이스 (Cloudflare Workers D1).
 * 실제 타입은 `@cloudflare/workers-types` 의 `D1Database` 와 호환된다.
 */
export interface D1DatabaseLike {
    prepare(query: string): {
        bind(...values: unknown[]): {
            first<T = unknown>(): Promise<T | null>;
            run(): Promise<unknown>;
        };
    };
}

/**
 * executionCtx.waitUntil 과 호환되는 미니멀 인터페이스.
 * last_used_at 업데이트를 비동기 백그라운드로 처리하기 위해 사용한다.
 */
export interface ExecutionContextLike {
    waitUntil(promise: Promise<unknown>): void;
}

/**
 * Bearer 토큰 인증을 수행한다.
 *
 * @param authHeader  요청의 Authorization 헤더 값 (없으면 빈 문자열)
 * @param db          D1 DB 바인딩
 * @param ctx         executionCtx (last_used_at 갱신용 waitUntil). null 이면 갱신 생략.
 */
export async function resolveBearerAuth(
    authHeader: string,
    db: D1DatabaseLike,
    ctx: ExecutionContextLike | null,
): Promise<BearerAuthResult> {
    if (!authHeader) return { kind: 'none' };
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
        return { kind: 'error', message: 'Bearer token required' };
    }
    const token = authHeader.slice(7).trim();
    if (!token) return { kind: 'error', message: 'Empty bearer token' };

    const tokenHash = await sha256Hex(token);
    const now = Math.floor(Date.now() / 1000);

    let userRow: BearerUserRow | null = null;
    let tokenId: number | null = null;
    let scope: string | null = null;

    let isApiKeyAuth = token.startsWith('mcp_');

    if (isApiKeyAuth) {
        try {
            const row = await db
                .prepare(
                    `SELECT k.user_id, k.expires_at,
                            u.id AS uid, u.provider, u.uid AS provider_uid, u.email, u.name,
                            u.picture, u.picture_private, u.role, u.banned_until,
                            u.last_namechange, u.created_at
                     FROM mcp_api_keys k
                     JOIN users u ON k.user_id = u.id
                     WHERE k.key_hash = ?`
                )
                .bind(tokenHash)
                .first<BearerUserRow & { expires_at: number }>();

            if (row) {
                if (row.expires_at < now) return { kind: 'error', message: 'Token expired' };
                userRow = row;
                scope = 'mcp admin-mcp';
            } else {
                isApiKeyAuth = false;
            }
        } catch {
            isApiKeyAuth = false;
        }
    }

    if (!isApiKeyAuth) {
        const row = await db
            .prepare(
                `SELECT t.id, t.user_id, t.scope, t.access_expires_at, t.revoked_at,
                        u.id AS uid, u.provider, u.uid AS provider_uid, u.email, u.name,
                        u.picture, u.picture_private, u.role, u.banned_until,
                        u.last_namechange, u.created_at
                 FROM oauth_tokens t
                 JOIN users u ON t.user_id = u.id
                 WHERE t.access_token_hash = ?`
            )
            .bind(tokenHash)
            .first<BearerUserRow & { id: number; scope: string | null; access_expires_at: number; revoked_at: number | null }>();

        if (!row) return { kind: 'error', message: 'Token not found' };
        if (row.revoked_at) return { kind: 'error', message: 'Token revoked' };
        if (row.access_expires_at < now) return { kind: 'error', message: 'Token expired' };

        const scopeVal = row.scope || OAUTH_SCOPE_ADMIN_MCP;
        const scopeTokens = scopeVal.split(/\s+/).filter(Boolean);
        if (!scopeTokens.some(s => OAUTH_ACCEPTED_SCOPES.has(s))) {
            return { kind: 'error', message: 'Token scope does not permit MCP access' };
        }

        userRow = row;
        tokenId = row.id;
        scope = scopeVal;

        if (ctx) {
            ctx.waitUntil(
                db.prepare('UPDATE oauth_tokens SET last_used_at = unixepoch() WHERE id = ?')
                    .bind(row.id).run().catch(() => {}) as Promise<unknown>
            );
        }
    }

    if (!userRow) {
        return { kind: 'error', message: 'Token not found' };
    }

    return { kind: 'authenticated', user: userRow, tokenId, scope };
}
