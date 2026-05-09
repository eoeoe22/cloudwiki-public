// OAuth 2.1 Authorization Server (관리자 MCP 서버 인증 전용)
//
// 외부 클라이언트(Claude 등)가 RFC 8414 / RFC 9728 메타데이터를 통해 자동 발견 → DCR(RFC 7591)
// 으로 자기 자신을 등록 → PKCE Authorization Code 흐름으로 액세스/리프레시 토큰을 발급받는다.
//
// 본 서버는 위키의 wiki_session 쿠키를 인가 단계의 사용자 인증 수단으로 재사용하므로,
// 외부 IdP 통합 없이도 OAuth 표준 흐름을 그대로 만족시킨다.
//
// 발급된 토큰은 통합 MCP 엔드포인트 /api/mcp 에서만 사용된다(scope=mcp).
// 토큰 자체는 일반 사용자/관리자를 구분하지 않으며, /api/mcp 가 호출 시점에 역할로 도구
// 목록과 호출 가능 여부를 분기한다.
import { Hono, Context } from 'hono';
import type { Env } from '../types';
import { RBAC } from '../utils/role';
import { escapeHtml } from '../utils/html';
import {
    generateOpaqueToken,
    sha256Hex,
    verifyPkce,
    timingSafeEqual,
    isValidRedirectUri,
    OAUTH_SCOPE_MCP,
    OAUTH_ACCEPTED_SCOPES,
    ACCESS_TOKEN_TTL_SEC,
    REFRESH_TOKEN_TTL_SEC,
    AUTH_CODE_TTL_SEC,
} from '../utils/oauth';

const oauth = new Hono<Env>();

function originOf(c: Context<Env>): string {
    return new URL(c.req.url).origin;
}

function badRequest(c: Context<Env>, error: string, description?: string, status: 400 | 401 | 403 = 400) {
    return c.json({ error, error_description: description }, status);
}

// ────────────────────────────────────────────────────────────────
// Discovery: RFC 9728 (Protected Resource) + RFC 8414 (Auth Server)
// ────────────────────────────────────────────────────────────────

oauth.get('/.well-known/oauth-protected-resource', (c) => {
    const origin = originOf(c);
    return c.json({
        resource: `${origin}/api/mcp`,
        authorization_servers: [origin],
        scopes_supported: [OAUTH_SCOPE_MCP],
        bearer_methods_supported: ['header'],
        resource_documentation: `${origin}/`,
    });
});

// 일부 클라이언트는 리소스 경로를 붙여 조회한다 (RFC 9728 §3.1).
oauth.get('/.well-known/oauth-protected-resource/api/mcp', (c) => {
    const origin = originOf(c);
    return c.json({
        resource: `${origin}/api/mcp`,
        authorization_servers: [origin],
        scopes_supported: [OAUTH_SCOPE_MCP],
        bearer_methods_supported: ['header'],
    });
});

// 구 /api/admin-mcp 엔드포인트는 통합 폐기. 해당 경로용 oauth-protected-resource 메타는
// RFC 9728 의 resource = metadata-URL 정합성을 만족시킬 방법이 없으므로 별도 핸들러를 두지
// 않는다. 기존 클라이언트는 /.well-known/oauth-protected-resource (또는 /api/mcp 부착형)
// 으로 재디스커버리해 /api/mcp 에 다시 연결해야 한다.

oauth.get('/.well-known/oauth-authorization-server', (c) => {
    const origin = originOf(c);
    return c.json({
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        scopes_supported: [OAUTH_SCOPE_MCP],
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
        revocation_endpoint: `${origin}/oauth/revoke`,
    });
});

// ────────────────────────────────────────────────────────────────
// Dynamic Client Registration (RFC 7591)
// ────────────────────────────────────────────────────────────────

oauth.post('/oauth/register', async (c) => {
    let body: any;
    try {
        body = await c.req.json();
    } catch {
        return badRequest(c, 'invalid_client_metadata', 'Body must be JSON');
    }

    const redirectUris: unknown = body?.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
        return badRequest(c, 'invalid_redirect_uri', 'redirect_uris is required and must be a non-empty array');
    }
    for (const uri of redirectUris) {
        if (typeof uri !== 'string' || !isValidRedirectUri(uri)) {
            return badRequest(c, 'invalid_redirect_uri', `Invalid redirect_uri: ${uri}`);
        }
    }
    if (redirectUris.length > 5) {
        return badRequest(c, 'invalid_redirect_uri', 'Too many redirect_uris (max 5)');
    }

    const requestedAuthMethod = typeof body?.token_endpoint_auth_method === 'string'
        ? body.token_endpoint_auth_method
        : 'none';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(requestedAuthMethod)) {
        return badRequest(c, 'invalid_client_metadata', `Unsupported token_endpoint_auth_method: ${requestedAuthMethod}`);
    }

    const grantTypes: string[] = Array.isArray(body?.grant_types) && body.grant_types.length
        ? body.grant_types.filter((g: unknown) => typeof g === 'string')
        : ['authorization_code', 'refresh_token'];
    for (const g of grantTypes) {
        if (!['authorization_code', 'refresh_token'].includes(g)) {
            return badRequest(c, 'invalid_client_metadata', `Unsupported grant_type: ${g}`);
        }
    }

    const clientId = generateOpaqueToken(24);
    const isPublic = requestedAuthMethod === 'none';
    const clientSecret = isPublic ? null : generateOpaqueToken(32);
    const clientSecretHash = clientSecret ? await sha256Hex(clientSecret) : null;
    const registrationAccessToken = generateOpaqueToken(24);
    const registrationAccessTokenHash = await sha256Hex(registrationAccessToken);

    const clientName = typeof body?.client_name === 'string' ? body.client_name.slice(0, 200) : null;

    await c.env.DB
        .prepare(
            `INSERT INTO oauth_clients
             (client_id, client_secret_hash, client_name, redirect_uris, grant_types,
              token_endpoint_auth_method, registration_access_token_hash, created_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
            clientId,
            clientSecretHash,
            clientName,
            JSON.stringify(redirectUris),
            JSON.stringify(grantTypes),
            requestedAuthMethod,
            registrationAccessTokenHash,
            null
        )
        .run();

    const origin = originOf(c);
    const response: Record<string, unknown> = {
        client_id: clientId,
        redirect_uris: redirectUris,
        grant_types: grantTypes,
        token_endpoint_auth_method: requestedAuthMethod,
        registration_client_uri: `${origin}/oauth/register/${clientId}`,
        registration_access_token: registrationAccessToken,
    };
    if (clientName) response.client_name = clientName;
    if (clientSecret) response.client_secret = clientSecret;

    return c.json(response, 201);
});

// ────────────────────────────────────────────────────────────────
// Authorization Endpoint
// ────────────────────────────────────────────────────────────────

interface AuthorizeQuery {
    response_type: string;
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    code_challenge_method: string;
    scope?: string;
    state?: string;
}

async function loadClient(c: Context<Env>, clientId: string) {
    return await c.env.DB
        .prepare('SELECT client_id, redirect_uris, token_endpoint_auth_method FROM oauth_clients WHERE client_id = ?')
        .bind(clientId)
        .first<{ client_id: string; redirect_uris: string; token_endpoint_auth_method: string }>();
}

function parseRedirectUris(json: string): string[] {
    try {
        const arr = JSON.parse(json);
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

function buildAuthErrorRedirect(redirectUri: string, error: string, description: string, state?: string): string {
    const u = new URL(redirectUri);
    u.searchParams.set('error', error);
    u.searchParams.set('error_description', description);
    if (state) u.searchParams.set('state', state);
    return u.toString();
}

oauth.get('/oauth/authorize', async (c) => {
    const q = c.req.query() as Partial<AuthorizeQuery>;

    if (q.response_type !== 'code') {
        return badRequest(c, 'unsupported_response_type', 'Only response_type=code is supported');
    }
    if (!q.client_id) return badRequest(c, 'invalid_request', 'client_id is required');
    if (!q.redirect_uri) return badRequest(c, 'invalid_request', 'redirect_uri is required');
    if (!q.code_challenge) return badRequest(c, 'invalid_request', 'code_challenge is required (PKCE)');
    if (q.code_challenge_method && q.code_challenge_method !== 'S256') {
        return badRequest(c, 'invalid_request', 'Only S256 code_challenge_method is supported');
    }

    const client = await loadClient(c, q.client_id);
    if (!client) return badRequest(c, 'invalid_client', 'Unknown client_id', 401);

    const allowed = parseRedirectUris(client.redirect_uris);
    if (!allowed.includes(q.redirect_uri)) {
        return badRequest(c, 'invalid_request', 'redirect_uri does not match registered values');
    }

    // 통합 MCP 엔드포인트는 mcp / admin-mcp 두 스코프 라벨 모두 받는다 — 어느 쪽이든 토큰
    // 자체에는 권한 차이가 없고, /api/mcp 가 호출 시점에 사용자 역할로 도구 가시성을 분기한다.
    const requestedScope = (q.scope || OAUTH_SCOPE_MCP).trim();
    const requestedScopeTokens = requestedScope.split(/\s+/).filter(Boolean);
    const hasAcceptedScope = requestedScopeTokens.some(s => OAUTH_ACCEPTED_SCOPES.has(s));
    if (!hasAcceptedScope) {
        return c.redirect(buildAuthErrorRedirect(
            q.redirect_uri,
            'invalid_scope',
            `Scope must include ${OAUTH_SCOPE_MCP}`,
            q.state,
        ));
    }

    const user = c.get('user');
    if (!user) {
        // 로그인 페이지로 리다이렉트 후 다시 동일한 authorize 호출로 복귀
        const returnTo = '/oauth/authorize?' + new URL(c.req.url).search.replace(/^\?/, '');
        return c.redirect(`/login?return_to=${encodeURIComponent(returnTo)}`);
    }
    // 차단된 사용자는 어떤 도구도 사용할 수 없으므로 동의 단계에서 컷.
    // 일반 사용자(user 역할 등) 는 읽기 도구만 노출되며, 관리자는 추가로 편집/관리 도구가 노출된다.
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = rbac.can(user.role, 'admin:access');
    if (!rbac.can(user.role, 'wiki:read') && !isAdmin) {
        return c.html(consentDeniedHtml(user.name, c.env.WIKI_NAME), 403);
    }

    return c.html(consentHtml({
        wikiName: c.env.WIKI_NAME || 'CloudWiki',
        userName: user.name,
        userIsAdmin: isAdmin,
        clientId: q.client_id,
        redirectUri: q.redirect_uri,
        codeChallenge: q.code_challenge,
        codeChallengeMethod: 'S256',
        scope: requestedScope,
        state: q.state || '',
    }));
});

oauth.post('/oauth/authorize', async (c) => {
    const form = await c.req.formData();
    const action = String(form.get('action') || '');
    const clientId = String(form.get('client_id') || '');
    const redirectUri = String(form.get('redirect_uri') || '');
    const codeChallenge = String(form.get('code_challenge') || '');
    const codeChallengeMethod = String(form.get('code_challenge_method') || 'S256');
    const scope = String(form.get('scope') || OAUTH_SCOPE_MCP);
    const state = form.get('state') ? String(form.get('state')) : undefined;

    if (!clientId || !redirectUri || !codeChallenge) {
        return badRequest(c, 'invalid_request', 'Missing required parameters');
    }

    const client = await loadClient(c, clientId);
    if (!client) return badRequest(c, 'invalid_client', 'Unknown client_id', 401);
    const allowed = parseRedirectUris(client.redirect_uris);
    if (!allowed.includes(redirectUri)) {
        return badRequest(c, 'invalid_request', 'redirect_uri mismatch');
    }

    if (action !== 'approve') {
        return c.redirect(buildAuthErrorRedirect(redirectUri, 'access_denied', 'User denied authorization', state));
    }

    const user = c.get('user');
    if (!user) return badRequest(c, 'access_denied', 'Not authenticated', 401);
    const rbac = c.get('rbac') as RBAC;
    // 차단/추방된 역할이 동의를 우회하지 못하도록 한 번 더 가드. 일반 사용자도 wiki:read 권한이
    // 없는 역할이면 거부 (RBAC 가 wiki:read 를 떼어 둔 환경 대비).
    const isAdmin = rbac.can(user.role, 'admin:access');
    if (!rbac.can(user.role, 'wiki:read') && !isAdmin) {
        return c.redirect(buildAuthErrorRedirect(redirectUri, 'access_denied', 'Insufficient permission', state));
    }

    const code = generateOpaqueToken(32);
    const codeHash = await sha256Hex(code);
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + AUTH_CODE_TTL_SEC;

    await c.env.DB
        .prepare(
            `INSERT INTO oauth_codes
             (code_hash, client_id, user_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(codeHash, clientId, user.id, redirectUri, codeChallenge, codeChallengeMethod, scope, expiresAt)
        .run();

    const u = new URL(redirectUri);
    u.searchParams.set('code', code);
    if (state) u.searchParams.set('state', state);
    return c.redirect(u.toString());
});

// ────────────────────────────────────────────────────────────────
// Token Endpoint
// ────────────────────────────────────────────────────────────────

interface ClientCredentials {
    clientId: string;
    clientSecret: string | null;
}

async function authenticateClient(c: Context<Env>, formClientId?: string, formClientSecret?: string): Promise<{
    ok: true; client: { client_id: string; redirect_uris: string; token_endpoint_auth_method: string };
} | { ok: false; error: string; description: string }> {
    let credentials: ClientCredentials | null = null;
    const authHeader = c.req.header('Authorization') || '';
    if (authHeader.startsWith('Basic ')) {
        try {
            const decoded = atob(authHeader.slice(6));
            const idx = decoded.indexOf(':');
            if (idx > 0) {
                credentials = {
                    clientId: decodeURIComponent(decoded.slice(0, idx)),
                    clientSecret: decodeURIComponent(decoded.slice(idx + 1)),
                };
            }
        } catch {
            return { ok: false, error: 'invalid_client', description: 'Malformed Basic auth header' };
        }
    } else if (formClientId) {
        credentials = { clientId: formClientId, clientSecret: formClientSecret || null };
    }
    if (!credentials) return { ok: false, error: 'invalid_client', description: 'client_id is required' };

    const row = await c.env.DB
        .prepare('SELECT client_id, client_secret_hash, redirect_uris, token_endpoint_auth_method FROM oauth_clients WHERE client_id = ?')
        .bind(credentials.clientId)
        .first<{ client_id: string; client_secret_hash: string | null; redirect_uris: string; token_endpoint_auth_method: string }>();
    if (!row) return { ok: false, error: 'invalid_client', description: 'Unknown client_id' };

    if (row.token_endpoint_auth_method === 'none') {
        // Public client — secret 무시
        return { ok: true, client: row };
    }
    if (!credentials.clientSecret || !row.client_secret_hash) {
        return { ok: false, error: 'invalid_client', description: 'client_secret required' };
    }
    const provided = await sha256Hex(credentials.clientSecret);
    if (!timingSafeEqual(provided, row.client_secret_hash)) {
        return { ok: false, error: 'invalid_client', description: 'Bad client_secret' };
    }
    return { ok: true, client: row };
}

async function issueTokenPair(c: Context<Env>, clientId: string, userId: number, scope: string) {
    const accessToken = generateOpaqueToken(32);
    const refreshToken = generateOpaqueToken(32);
    const accessHash = await sha256Hex(accessToken);
    const refreshHash = await sha256Hex(refreshToken);
    const now = Math.floor(Date.now() / 1000);
    const accessExp = now + ACCESS_TOKEN_TTL_SEC;
    const refreshExp = now + REFRESH_TOKEN_TTL_SEC;

    await c.env.DB
        .prepare(
            `INSERT INTO oauth_tokens
             (access_token_hash, refresh_token_hash, client_id, user_id, scope, access_expires_at, refresh_expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(accessHash, refreshHash, clientId, userId, scope, accessExp, refreshExp)
        .run();

    return {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SEC,
        refresh_token: refreshToken,
        scope,
    };
}

oauth.post('/oauth/token', async (c) => {
    const form = await c.req.formData();
    const grantType = String(form.get('grant_type') || '');
    const formClientId = form.get('client_id') ? String(form.get('client_id')) : undefined;
    const formClientSecret = form.get('client_secret') ? String(form.get('client_secret')) : undefined;

    const auth = await authenticateClient(c, formClientId, formClientSecret);
    if (!auth.ok) return badRequest(c, auth.error, auth.description, 401);
    const client = auth.client;

    if (grantType === 'authorization_code') {
        const code = form.get('code') ? String(form.get('code')) : '';
        const redirectUri = form.get('redirect_uri') ? String(form.get('redirect_uri')) : '';
        const codeVerifier = form.get('code_verifier') ? String(form.get('code_verifier')) : '';

        if (!code || !redirectUri || !codeVerifier) {
            return badRequest(c, 'invalid_request', 'code, redirect_uri, code_verifier are required');
        }

        const codeHash = await sha256Hex(code);
        const row = await c.env.DB
            .prepare(
                `SELECT client_id, user_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at, used_at
                 FROM oauth_codes WHERE code_hash = ?`
            )
            .bind(codeHash)
            .first<{
                client_id: string; user_id: number; redirect_uri: string;
                code_challenge: string; code_challenge_method: string; scope: string | null;
                expires_at: number; used_at: number | null;
            }>();
        if (!row) return badRequest(c, 'invalid_grant', 'Authorization code not found');
        const now = Math.floor(Date.now() / 1000);
        if (row.expires_at < now) return badRequest(c, 'invalid_grant', 'Authorization code expired');
        if (row.client_id !== client.client_id) return badRequest(c, 'invalid_grant', 'Code does not belong to this client');
        if (row.redirect_uri !== redirectUri) return badRequest(c, 'invalid_grant', 'redirect_uri mismatch');
        if (row.used_at) {
            // 코드 재사용 — 해당 사용자의 모든 토큰 패밀리 폐기
            await c.env.DB
                .prepare('UPDATE oauth_tokens SET revoked_at = unixepoch() WHERE client_id = ? AND user_id = ? AND revoked_at IS NULL')
                .bind(client.client_id, row.user_id)
                .run();
            return badRequest(c, 'invalid_grant', 'Authorization code already used');
        }

        const pkceOk = await verifyPkce(codeVerifier, row.code_challenge, row.code_challenge_method);
        if (!pkceOk) return badRequest(c, 'invalid_grant', 'PKCE verification failed');

        // 원자적 1회용 마킹: 동시 요청에서 정확히 한 쪽만 used_at 설정에 성공한다.
        // SELECT 와 UPDATE 가 분리되어 있어도 이 조건부 UPDATE 가 성공한 행 수로
        // race 를 안전하게 차단한다.
        const claim = await c.env.DB
            .prepare('UPDATE oauth_codes SET used_at = unixepoch() WHERE code_hash = ? AND used_at IS NULL')
            .bind(codeHash)
            .run();
        if (!claim.meta || claim.meta.changes !== 1) {
            // 이미 다른 요청이 코드를 소비했다 — 재사용으로 간주하고 토큰 패밀리 폐기.
            await c.env.DB
                .prepare('UPDATE oauth_tokens SET revoked_at = unixepoch() WHERE client_id = ? AND user_id = ? AND revoked_at IS NULL')
                .bind(client.client_id, row.user_id)
                .run();
            return badRequest(c, 'invalid_grant', 'Authorization code already used');
        }

        const tokens = await issueTokenPair(c, client.client_id, row.user_id, row.scope || OAUTH_SCOPE_MCP);
        return c.json(tokens, 200, { 'Cache-Control': 'no-store' });
    }

    if (grantType === 'refresh_token') {
        const refreshToken = form.get('refresh_token') ? String(form.get('refresh_token')) : '';
        if (!refreshToken) return badRequest(c, 'invalid_request', 'refresh_token is required');
        const refreshHash = await sha256Hex(refreshToken);

        const row = await c.env.DB
            .prepare(
                `SELECT id, client_id, user_id, scope, refresh_expires_at, revoked_at
                 FROM oauth_tokens WHERE refresh_token_hash = ?`
            )
            .bind(refreshHash)
            .first<{ id: number; client_id: string; user_id: number; scope: string | null; refresh_expires_at: number | null; revoked_at: number | null }>();
        if (!row) return badRequest(c, 'invalid_grant', 'Refresh token not found');
        if (row.client_id !== client.client_id) return badRequest(c, 'invalid_grant', 'Token does not belong to this client');
        const now = Math.floor(Date.now() / 1000);
        if (row.revoked_at) {
            // 폐기된 리프레시 재사용 — 해당 사용자의 모든 활성 토큰 패밀리 폐기 (세션 보호).
            await c.env.DB
                .prepare('UPDATE oauth_tokens SET revoked_at = unixepoch() WHERE client_id = ? AND user_id = ? AND revoked_at IS NULL')
                .bind(client.client_id, row.user_id)
                .run();
            return badRequest(c, 'invalid_grant', 'Refresh token revoked');
        }
        if (row.refresh_expires_at && row.refresh_expires_at < now) {
            return badRequest(c, 'invalid_grant', 'Refresh token expired');
        }

        // 차단/삭제된 사용자만 거부 — 일반 사용자도 통합 MCP 의 읽기 도구를 사용할 수 있으므로
        // admin 권한 상실 자체로는 토큰을 폐기하지 않는다 (도구 가시성은 /api/mcp 가 호출 시점에
        // 역할 기반으로 다시 분기). banned/deleted 만 토큰 패밀리 폐기.
        const userRow = await c.env.DB
            .prepare('SELECT id, role, banned_until FROM users WHERE id = ?')
            .bind(row.user_id)
            .first<{ id: number; role: string; banned_until: number | null }>();
        if (!userRow) return badRequest(c, 'invalid_grant', 'User not found');
        const isBanned = userRow.role === 'banned' || (userRow.banned_until && userRow.banned_until > now);
        const isDeleted = userRow.role === 'deleted';
        if (isBanned || isDeleted) {
            await c.env.DB
                .prepare('UPDATE oauth_tokens SET revoked_at = unixepoch() WHERE user_id = ? AND revoked_at IS NULL')
                .bind(row.user_id)
                .run();
            return badRequest(c, 'invalid_grant', 'User account is restricted', 403);
        }

        // 회전: 정확히 한 요청만 활성 토큰을 폐기하도록 조건부 UPDATE 로 잠금.
        // 동시 refresh 가 두 번 통과하지 않도록 changes === 1 일 때만 새 페어를 발급한다.
        const rotate = await c.env.DB
            .prepare('UPDATE oauth_tokens SET revoked_at = unixepoch() WHERE id = ? AND revoked_at IS NULL')
            .bind(row.id)
            .run();
        if (!rotate.meta || rotate.meta.changes !== 1) {
            // 다른 요청이 먼저 회전을 소진했다 — 재사용 시도이므로 패밀리 전체 폐기.
            await c.env.DB
                .prepare('UPDATE oauth_tokens SET revoked_at = unixepoch() WHERE client_id = ? AND user_id = ? AND revoked_at IS NULL')
                .bind(client.client_id, row.user_id)
                .run();
            return badRequest(c, 'invalid_grant', 'Refresh token already rotated');
        }

        const tokens = await issueTokenPair(c, client.client_id, row.user_id, row.scope || OAUTH_SCOPE_MCP);
        return c.json(tokens, 200, { 'Cache-Control': 'no-store' });
    }

    return badRequest(c, 'unsupported_grant_type', `grant_type=${grantType}`);
});

// ────────────────────────────────────────────────────────────────
// Revocation (RFC 7009 — minimal)
// ────────────────────────────────────────────────────────────────

oauth.post('/oauth/revoke', async (c) => {
    const form = await c.req.formData();
    const token = form.get('token') ? String(form.get('token')) : '';
    if (!token) return c.body(null, 200);
    const hash = await sha256Hex(token);
    await c.env.DB
        .prepare('UPDATE oauth_tokens SET revoked_at = unixepoch() WHERE (access_token_hash = ? OR refresh_token_hash = ?) AND revoked_at IS NULL')
        .bind(hash, hash)
        .run();
    return c.body(null, 200);
});

// ────────────────────────────────────────────────────────────────
// Consent HTML
// ────────────────────────────────────────────────────────────────

function consentHtml(p: {
    wikiName: string; userName: string; userIsAdmin: boolean;
    clientId: string; redirectUri: string;
    codeChallenge: string; codeChallengeMethod: string; scope: string; state: string;
}): string {
    const safeWiki = escapeHtml(p.wikiName);
    const safeUser = escapeHtml(p.userName);
    const safeClient = escapeHtml(p.clientId);
    const safeRedirect = escapeHtml(p.redirectUri);
    const safeChallenge = escapeHtml(p.codeChallenge);
    const safeMethod = escapeHtml(p.codeChallengeMethod);
    const safeScope = escapeHtml(p.scope);
    const safeState = escapeHtml(p.state);
    const accessSummary = p.userIsAdmin
        ? '문서 읽기/검색에 더해, <strong>관리자 권한</strong>으로 위키 문서의 편집·이동·삭제·복원·되돌리기까지 자동 수행할 수 있습니다.'
        : '위키 문서의 읽기·검색·목차 조회 등 읽기 전용 도구만 사용할 수 있습니다.';
    const warningHtml = p.userIsAdmin
        ? '<p class="warning">승인하면 이 클라이언트는 당신의 관리자 권한으로 위키 문서를 자동 편집/삭제할 수 있습니다. 신뢰하는 클라이언트만 승인하세요.</p>'
        : '';
    return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>MCP 접근 승인 — ${safeWiki}</title>
<style>body{font-family:'Segoe UI',system-ui,sans-serif;background:#f5f5f5;color:#1a1a1a;margin:0;padding:2rem;display:flex;justify-content:center;align-items:flex-start;min-height:100vh}.card{background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.10);padding:2rem;max-width:480px;width:100%}h1{font-size:1.4rem;margin:0 0 1rem}p{line-height:1.6;color:#444}.meta{background:#f0f7ff;border:1px solid #c2daf7;border-radius:8px;padding:0.9rem 1.2rem;font-size:0.85rem;color:#1d4ed8;margin:1.2rem 0}.meta dt{font-weight:600;margin-top:0.4rem}.meta dd{margin:0 0 0 0;word-break:break-all;font-family:ui-monospace,Consolas,monospace}.warning{background:#fff4e5;border:1px solid #ffb866;border-radius:8px;padding:0.9rem 1.2rem;font-size:0.85rem;color:#a04500;margin:1.2rem 0}.actions{display:flex;gap:0.8rem;margin-top:1.6rem}button{flex:1;padding:0.8rem;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer}.approve{background:#2563eb;color:#fff}.deny{background:#e5e7eb;color:#374151}</style>
</head><body><div class="card">
<h1>MCP 접근 승인</h1>
<p><strong>${safeUser}</strong> 님, 외부 클라이언트가 <strong>${safeWiki}</strong> 의 MCP 서버에 접근하려고 합니다. ${accessSummary}</p>
<dl class="meta">
  <dt>클라이언트 ID</dt><dd>${safeClient}</dd>
  <dt>리다이렉트 URI</dt><dd>${safeRedirect}</dd>
  <dt>요청 권한</dt><dd>${safeScope}</dd>
</dl>
${warningHtml}
<form method="POST" action="/oauth/authorize" class="actions">
  <input type="hidden" name="client_id" value="${safeClient}">
  <input type="hidden" name="redirect_uri" value="${safeRedirect}">
  <input type="hidden" name="code_challenge" value="${safeChallenge}">
  <input type="hidden" name="code_challenge_method" value="${safeMethod}">
  <input type="hidden" name="scope" value="${safeScope}">
  <input type="hidden" name="state" value="${safeState}">
  <button class="deny" type="submit" name="action" value="deny">거부</button>
  <button class="approve" type="submit" name="action" value="approve">승인</button>
</form>
</div></body></html>`;
}

function consentDeniedHtml(userName: string, wikiName: string | undefined): string {
    const safeUser = escapeHtml(userName);
    const safeWiki = escapeHtml(wikiName || 'CloudWiki');
    return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>권한 없음 — ${safeWiki}</title>
<style>body{font-family:'Segoe UI',system-ui,sans-serif;background:#f5f5f5;color:#1a1a1a;margin:0;padding:2rem;display:flex;justify-content:center;align-items:flex-start;min-height:100vh}.card{background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.10);padding:2rem;max-width:480px;width:100%}h1{font-size:1.4rem;margin:0 0 1rem;color:#b91c1c}p{line-height:1.6;color:#444}</style>
</head><body><div class="card"><h1>접근 권한이 없습니다</h1><p><strong>${safeUser}</strong> 님은 MCP 서버에 접근할 권한이 없습니다. 권한이 있는 계정으로 로그인한 뒤 다시 시도해주세요.</p></div></body></html>`;
}

export default oauth;
