import type { Context } from 'hono';
import type { Env, User } from '../types';
import { isSuperAdmin } from './auth';
import { sha256Hex, OAUTH_ACCEPTED_SCOPES, OAUTH_SCOPE_ADMIN_MCP } from './oauth';
import { ensureMcpInstantApplyMigration } from './mcpInstantApplyMigration';

/**
 * MCP Bearer 토큰 인증 공용 로직.
 *
 * 전역 위키 MCP(`routes/mcp.ts`)와 워크스페이스 MCP(`routes/ws-mcp.ts`)가 동일한
 * 토큰-해시 조회(mcp_api_keys / oauth_tokens), 만료/폐기/scope 검증, super_admin 보정,
 * ban 처리, User 객체 구성을 공유한다. (이전에는 ws-mcp.ts 에 mcp.ts 의 비공개
 * tryAuthenticateBearer 가 ~115줄 복제되어 있었다.)
 *
 * 두 호출자가 갈리는 정책 — Authorization 헤더 부재 처리(전역 MCP 는 guest 통과, 워크스페이스
 * MCP 는 401)와 권한 부족 처리(전역 MCP 는 guest 강등, 워크스페이스 MCP 는 401) — 는
 * 이 함수가 결정하지 않는다. 본 함수는 토큰을 해석해 판별 가능한 결과만 돌려주고,
 * 각 라우트가 자기 정책에 맞춰 분기한다(아래 BearerAuthResult).
 *
 * 향후 공유 패키지의 `@cloudwiki/wiki-shared/server/bearerAuth` 로 이전될 모듈이며,
 * 그때는 각 앱이 자체 DB(mcp_api_keys/oauth_tokens)를 주입하는 형태가 된다.
 */

/** MCP 401 응답(WWW-Authenticate + resource metadata). 재인증 흐름을 트리거한다. */
export function mcpUnauthorized(c: Context<Env>, description: string): Response {
    const origin = new URL(c.req.url).origin;
    const resourceMetadata = `${origin}/.well-known/oauth-protected-resource`;
    c.header(
        'WWW-Authenticate',
        `Bearer realm="mcp", error="invalid_token", error_description="${description}", resource_metadata="${resourceMetadata}"`,
    );
    return c.json({ error: 'invalid_token', error_description: description }, 401);
}

/**
 * resolveBearerAuth 결과.
 *  - `none`          : Authorization 헤더 없음 (호출자가 guest/401 결정).
 *  - `error`         : 헤더 형식 오류 / 토큰 invalid·expired·revoked·scope 부적합 → 동봉된 401 응답.
 *  - `authenticated` : 토큰 해석 성공. user 는 effectiveRole(super_admin 보정/ban 반영)이 적용된 상태.
 *                      banned/deleted 거부 또는 권한 강등은 호출자가 effectiveRole 로 판단한다.
 */
export type BearerAuthResult =
    | { kind: 'none' }
    | { kind: 'error'; response: Response }
    | { kind: 'authenticated'; user: User; effectiveRole: User['role']; tokenId: number | null; scope: string | null };

export async function resolveBearerAuth(c: Context<Env>): Promise<BearerAuthResult> {
    const authHeader = c.req.header('Authorization') || '';
    if (!authHeader) return { kind: 'none' };
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
        return { kind: 'error', response: mcpUnauthorized(c, 'Bearer token required') };
    }
    const token = authHeader.slice(7).trim();
    if (!token) return { kind: 'error', response: mcpUnauthorized(c, 'Empty bearer token') };

    const tokenHash = await sha256Hex(token);
    const now = Math.floor(Date.now() / 1000);

    // 레거시 D1(mcp_instant_apply 컬럼 부재) 대비 idempotent 마이그레이션 보장 후 SELECT.
    await ensureMcpInstantApplyMigration(c.env.DB);

    let userRow: {
        uid: number; provider: string; provider_uid: string; email: string;
        name: string; picture: string | null; picture_private: number; mcp_instant_apply: number; role: string; banned_until: number | null;
        last_namechange: number | null; created_at: number;
    } | null = null;
    let tokenId: number | null = null;
    let scope: string | null = null;

    let isApiKeyAuth = token.startsWith('mcp_');

    if (isApiKeyAuth) {
        // API 키 인증
        try {
            const row = await c.env.DB
                .prepare(
                    `SELECT k.user_id, k.expires_at,
                            u.id AS uid, u.provider, u.uid AS provider_uid, u.email, u.name, u.picture, u.picture_private, u.mcp_instant_apply, u.role, u.banned_until, u.last_namechange, u.created_at
                     FROM mcp_api_keys k
                     JOIN users u ON k.user_id = u.id
                     WHERE k.key_hash = ?`
                )
                .bind(tokenHash)
                .first<{
                    user_id: number; expires_at: number;
                    uid: number; provider: string; provider_uid: string; email: string; name: string; picture: string | null; picture_private: number; mcp_instant_apply: number;
                    role: string; banned_until: number | null; last_namechange: number | null; created_at: number;
                }>();

            if (row) {
                if (row.expires_at < now) return { kind: 'error', response: mcpUnauthorized(c, 'Token expired') };
                userRow = row;
                scope = 'mcp admin-mcp';
            } else {
                isApiKeyAuth = false;
            }
        } catch {
            // 테이블이 없는 등의 DB 에러 발생 시 OAuth 토큰 인증으로 Fallback
            isApiKeyAuth = false;
        }
    }

    if (!isApiKeyAuth) {
        // OAuth 토큰 인증
        const row = await c.env.DB
            .prepare(
                `SELECT t.id, t.user_id, t.scope, t.access_expires_at, t.revoked_at,
                        u.id AS uid, u.provider, u.uid AS provider_uid, u.email, u.name, u.picture, u.picture_private, u.mcp_instant_apply, u.role, u.banned_until, u.last_namechange, u.created_at
                 FROM oauth_tokens t
                 JOIN users u ON t.user_id = u.id
                 WHERE t.access_token_hash = ?`
            )
            .bind(tokenHash)
            .first<{
                id: number; user_id: number; scope: string | null; access_expires_at: number; revoked_at: number | null;
                uid: number; provider: string; provider_uid: string; email: string; name: string; picture: string | null; picture_private: number; mcp_instant_apply: number;
                role: string; banned_until: number | null; last_namechange: number | null; created_at: number;
            }>();

        if (!row) return { kind: 'error', response: mcpUnauthorized(c, 'Token not found') };
        if (row.revoked_at) return { kind: 'error', response: mcpUnauthorized(c, 'Token revoked') };
        if (row.access_expires_at < now) return { kind: 'error', response: mcpUnauthorized(c, 'Token expired') };

        const scopeVal = row.scope || OAUTH_SCOPE_ADMIN_MCP;
        const scopeTokens = scopeVal.split(/\s+/).filter(Boolean);
        if (!scopeTokens.some(s => OAUTH_ACCEPTED_SCOPES.has(s))) {
            return { kind: 'error', response: mcpUnauthorized(c, 'Token scope does not permit MCP access') };
        }

        userRow = row;
        tokenId = row.id;
        scope = scopeVal;

        // OAuth 토큰의 경우 사용 시각 갱신
        c.executionCtx.waitUntil(
            c.env.DB.prepare('UPDATE oauth_tokens SET last_used_at = unixepoch() WHERE id = ?')
                .bind(row.id).run().catch(() => {})
        );
    }

    if (!userRow) {
        return { kind: 'error', response: mcpUnauthorized(c, 'Token not found') };
    }

    // 권한 재검증: super_admin 보정 + ban 처리
    let effectiveRole = userRow.role;
    if (isSuperAdmin(userRow.email, c.env)) {
        effectiveRole = 'super_admin';
    } else if (userRow.banned_until && userRow.banned_until > now) {
        effectiveRole = 'banned';
    } else if (userRow.role === 'banned') {
        effectiveRole = 'user';
    }

    const user: User = {
        id: userRow.uid,
        provider: userRow.provider,
        uid: userRow.provider_uid,
        email: userRow.email,
        name: userRow.name,
        picture: userRow.picture,
        picture_private: userRow.picture_private,
        mcp_instant_apply: userRow.mcp_instant_apply,
        role: effectiveRole as User['role'],
        banned_until: userRow.banned_until,
        last_namechange: userRow.last_namechange,
        created_at: userRow.created_at,
    };

    return { kind: 'authenticated', user, effectiveRole: effectiveRole as User['role'], tokenId, scope };
}
