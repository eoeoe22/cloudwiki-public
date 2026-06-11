import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { Env, User } from '../types';
import { RBAC } from '../utils/role';
import { isSuperAdmin } from '../utils/auth';
import { normalizeSlug } from '../utils/slug';
import { getRevisionContent } from '../utils/r2';
import { sha256Hex, OAUTH_ACCEPTED_SCOPES, OAUTH_SCOPE_ADMIN_MCP } from '../utils/oauth';
import { isWorkspacesEnabled } from '../utils/workspace';
import { getWorkspaceAccessBySlug } from '../utils/workspaceAcl';
import type { WorkspaceAccess } from '../utils/workspaceAcl';
import { ensureWorkspaceMembersStatusMigration } from '../utils/workspaceMembersStatusMigration';
import type { Workspace } from '../shared/models';
import { saveWorkspacePage } from '../utils/workspacePagePipeline';
import { syncWorkspaceMediaVisibility } from '../utils/workspaceMedia';
import { SLUG_FORBIDDEN_CHARS } from './wiki';

/**
 * 워크스페이스별 MCP 엔드포인트 (POST /api/ws/:wslug/mcp).
 *
 * 엔드포인트는 워크스페이스마다 고유하다 — URL 의 :wslug 가 워크스페이스 컨텍스트를
 * 제공하므로 도구 인자에 workspace 슬러그를 별도로 지정할 필요가 없다.
 *
 * 전역 MCP(/api/mcp, src/routes/mcp.ts)의 JSON-RPC 외피·Bearer 인증 규약을 그대로
 * 따르되, 노출 도구는 **워크스페이스 스코프 전용**이다. 전역 위키 MCP 와 달리
 * draft/승인 흐름이 없다 — 워크스페이스는 사용자 본인의 공간이므로 편집이 사용자
 * 명의로 즉시 반영된다(saveWorkspacePage 직접 호출).
 *
 * 인증: mcp.ts 의 tryAuthenticateBearer 는 export 되지 않으므로, 동일한 토큰-해시
 * 조회(mcp_api_keys / oauth_tokens)를 이 파일에 복제한다(만료/폐기/scope/banned/
 * super_admin 처리 동일). 다만 전역 MCP 의 "guest 강등" 대신 워크스페이스 MCP 는
 * 인증을 강제한다 — 모든 도구가 워크스페이스 멤버십을 요구하므로 user 없이는 의미가 없다.
 *
 * 모든 도구는 getWorkspaceAccessBySlug 로 워크스페이스를 해석하고 access.canRead/
 * canWrite 로 스코프된다. WORKSPACES_ENABLED 비활성 시 모든 도구가 오류를 반환한다.
 */

const wsMcp = new Hono<Env>();

// CORS — mcp.ts 와 동일 정책.
wsMcp.use('/api/ws/:wslug/mcp', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Hono-CSRF', 'MCP-Protocol-Version'],
    maxAge: 86400,
}));

// ────────────────────────────────────────────────────────────────
// Bearer 토큰 인증 (mcp.ts tryAuthenticateBearer 복제 — workspace MCP 는 인증 필수).
//   - 헤더 없음 → 401 + WWW-Authenticate (워크스페이스 도구는 모두 멤버십 필요).
//   - 토큰 잘못됨 / 만료 / 폐기 / scope 부적합 → 401 + WWW-Authenticate.
//   - 토큰 유효하나 권한 박탈(banned 등) → 401 (전역 MCP 의 guest 강등 대신 거부).
// ────────────────────────────────────────────────────────────────

function unauthorized(c: Context<Env>, description: string): Response {
    const origin = new URL(c.req.url).origin;
    const resourceMetadata = `${origin}/.well-known/oauth-protected-resource`;
    c.header(
        'WWW-Authenticate',
        `Bearer realm="mcp", error="invalid_token", error_description="${description}", resource_metadata="${resourceMetadata}"`,
    );
    return c.json({ error: 'invalid_token', error_description: description }, 401);
}

async function authenticateBearer(c: Context<Env>): Promise<User | Response> {
    const authHeader = c.req.header('Authorization') || '';
    if (!authHeader) return unauthorized(c, 'Bearer token required');
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
        return unauthorized(c, 'Bearer token required');
    }
    const token = authHeader.slice(7).trim();
    if (!token) return unauthorized(c, 'Empty bearer token');

    const tokenHash = await sha256Hex(token);
    const now = Math.floor(Date.now() / 1000);

    let userRow: {
        uid: number; provider: string; provider_uid: string; email: string;
        name: string; picture: string | null; picture_private: number; role: string; banned_until: number | null;
        last_namechange: number | null; created_at: number;
    } | null = null;

    let isApiKeyAuth = token.startsWith('mcp_');

    if (isApiKeyAuth) {
        try {
            const row = await c.env.DB
                .prepare(
                    `SELECT k.user_id, k.expires_at,
                            u.id AS uid, u.provider, u.uid AS provider_uid, u.email, u.name, u.picture, u.picture_private, u.role, u.banned_until, u.last_namechange, u.created_at
                     FROM mcp_api_keys k
                     JOIN users u ON k.user_id = u.id
                     WHERE k.key_hash = ?`
                )
                .bind(tokenHash)
                .first<{
                    user_id: number; expires_at: number;
                    uid: number; provider: string; provider_uid: string; email: string; name: string; picture: string | null; picture_private: number;
                    role: string; banned_until: number | null; last_namechange: number | null; created_at: number;
                }>();
            if (row) {
                if (row.expires_at < now) return unauthorized(c, 'Token expired');
                userRow = row;
            } else {
                isApiKeyAuth = false;
            }
        } catch {
            isApiKeyAuth = false;
        }
    }

    if (!isApiKeyAuth) {
        const row = await c.env.DB
            .prepare(
                `SELECT t.id, t.user_id, t.scope, t.access_expires_at, t.revoked_at,
                        u.id AS uid, u.provider, u.uid AS provider_uid, u.email, u.name, u.picture, u.picture_private, u.role, u.banned_until, u.last_namechange, u.created_at
                 FROM oauth_tokens t
                 JOIN users u ON t.user_id = u.id
                 WHERE t.access_token_hash = ?`
            )
            .bind(tokenHash)
            .first<{
                id: number; user_id: number; scope: string | null; access_expires_at: number; revoked_at: number | null;
                uid: number; provider: string; provider_uid: string; email: string; name: string; picture: string | null; picture_private: number;
                role: string; banned_until: number | null; last_namechange: number | null; created_at: number;
            }>();

        if (!row) return unauthorized(c, 'Token not found');
        if (row.revoked_at) return unauthorized(c, 'Token revoked');
        if (row.access_expires_at < now) return unauthorized(c, 'Token expired');

        const scopeVal = row.scope || OAUTH_SCOPE_ADMIN_MCP;
        const scopeTokens = scopeVal.split(/\s+/).filter(Boolean);
        if (!scopeTokens.some(s => OAUTH_ACCEPTED_SCOPES.has(s))) {
            return unauthorized(c, 'Token scope does not permit MCP access');
        }

        userRow = row;

        c.executionCtx.waitUntil(
            c.env.DB.prepare('UPDATE oauth_tokens SET last_used_at = unixepoch() WHERE id = ?')
                .bind(row.id).run().catch(() => {})
        );
    }

    if (!userRow) return unauthorized(c, 'Token not found');

    // 권한 재검증: super_admin 보정 + ban 처리 (mcp.ts 와 동일).
    let effectiveRole = userRow.role;
    if (isSuperAdmin(userRow.email, c.env)) {
        effectiveRole = 'super_admin';
    } else if (userRow.banned_until && userRow.banned_until > now) {
        effectiveRole = 'banned';
    } else if (userRow.role === 'banned') {
        effectiveRole = 'user';
    }

    // 워크스페이스 MCP 는 guest 강등이 무의미하므로(모든 도구가 멤버십 필요) banned/deleted
    // 는 401 로 거부한다.
    if (effectiveRole === 'banned' || effectiveRole === 'deleted') {
        return unauthorized(c, 'Account is not permitted to use MCP');
    }

    const user: User = {
        id: userRow.uid,
        provider: userRow.provider,
        uid: userRow.provider_uid,
        email: userRow.email,
        name: userRow.name,
        picture: userRow.picture,
        picture_private: userRow.picture_private,
        role: effectiveRole as User['role'],
        banned_until: userRow.banned_until,
        last_namechange: userRow.last_namechange,
        created_at: userRow.created_at,
    };
    c.set('user', user);
    return user;
}

// ────────────────────────────────────────────────────────────────
// 도구 정의 (mcp.ts McpToolDef 형태)
// ────────────────────────────────────────────────────────────────

interface WsMcpToolDef {
    name: string;
    description: string;
    inputSchema: any;
}

const WS_MCP_TOOL_DEFS: WsMcpToolDef[] = [
    {
        name: 'ws_list_workspaces',
        description: '현재 사용자가 소유하거나 멤버로 참여 중인 워크스페이스 목록을 반환합니다. 각 항목에 slug/name/role 이 포함됩니다.',
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
        name: 'ws_list_pages',
        description: '워크스페이스의 비삭제 문서 목록을 반환합니다(최근 수정 순). prefix 를 주면 해당 슬러그의 하위 문서만 반환합니다.',
        inputSchema: { type: 'object', properties: { prefix: { type: 'string', description: '하위 문서 필터용 슬러그 prefix (선택)' } }, required: [] },
    },
    {
        name: 'ws_read_page',
        description: '워크스페이스 문서 한 건의 본문을 읽어옵니다(title/version/ws_public/redirect_to 포함).',
        inputSchema: { type: 'object', properties: { slug: { type: 'string', description: '문서 슬러그' } }, required: ['slug'] },
    },
    {
        name: 'ws_list_revisions',
        description: '워크스페이스 문서의 최근 리비전 목록(최대 30개)을 반환합니다.',
        inputSchema: { type: 'object', properties: { slug: { type: 'string', description: '문서 슬러그' } }, required: ['slug'] },
    },
    {
        name: 'ws_read_revision',
        description: '워크스페이스 리비전 한 건의 본문을 읽어옵니다. 리비전이 이 워크스페이스 소속이 아니면 오류를 반환합니다.',
        inputSchema: { type: 'object', properties: { revision_id: { type: 'number', description: '리비전 ID' } }, required: ['revision_id'] },
    },
    {
        name: 'ws_get_backlinks',
        description: '워크스페이스 안에서 지정 문서를 참조(링크)하는 문서 목록을 반환합니다.',
        inputSchema: { type: 'object', properties: { slug: { type: 'string', description: '대상 문서 슬러그' } }, required: ['slug'] },
    },
    {
        name: 'ws_list_media',
        description: '워크스페이스의 미디어 목록을 반환합니다(filename/mime_type/size/ws_public/url).',
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
        name: 'ws_list_members',
        description: '워크스페이스의 소유자와 멤버 목록을 반환합니다(name/role). 읽기 전용입니다.',
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
        name: 'ws_create_or_update_page',
        description: '워크스페이스 문서를 생성하거나 수정합니다(사용자 명의로 즉시 반영, 승인 흐름 없음). title/ws_public 은 키를 생략하면 기존 값을 유지합니다.',
        inputSchema: {
            type: 'object',
            properties: {
                slug: { type: 'string', description: '문서 슬러그 (콜론 사용 불가)' },
                content: { type: 'string', description: '문서 본문' },
                title: { type: 'string', description: '표시 전용 대체 제목 (선택)' },
                summary: { type: 'string', description: '편집 요약 (선택)' },
                ws_public: { type: 'number', description: '0 또는 1 — 비멤버 공개 여부 (선택)' },
            },
            required: ['slug', 'content'],
        },
    },
    {
        name: 'ws_delete_page',
        description: '워크스페이스 문서를 소프트 삭제합니다(리비전/링크는 보존). 승인 흐름 없이 즉시 반영됩니다.',
        inputSchema: { type: 'object', properties: { slug: { type: 'string', description: '문서 슬러그' } }, required: ['slug'] },
    },
    {
        name: 'ws_move_page',
        description: '워크스페이스 문서의 슬러그를 변경합니다(행 이름 변경, 리비전 생성 안 함). 대상 슬러그가 이미 사용 중이면 오류를 반환합니다.',
        inputSchema: { type: 'object', properties: { slug: { type: 'string', description: '현재 슬러그' }, new_slug: { type: 'string', description: '새 슬러그 (콜론 사용 불가)' } }, required: ['slug', 'new_slug'] },
    },
    // ── Todo 도구 ──
    {
        name: 'ws_list_todos',
        description: '워크스페이스 TODO 목록을 반환합니다. archived 가 true 면 보관된 항목만, 생략/false 면 보관되지 않은 항목만 반환합니다. sort 로 생성순(기본 created_asc), filter 로 체크 상태를 거를 수 있습니다.',
        inputSchema: {
            type: 'object',
            properties: {
                archived: { type: 'boolean', description: 'true 면 보관된 항목만, 생략 시 비보관 항목만 (선택)' },
                sort: { type: 'string', enum: ['created_asc', 'created_desc'], description: '정렬 순서 (선택, 기본 created_asc)' },
                filter: { type: 'string', enum: ['checked', 'unchecked'], description: '체크 상태 필터 (선택)' },
            },
            required: [],
        },
    },
    {
        name: 'ws_create_todo',
        description: '워크스페이스에 TODO 항목을 추가합니다.',
        inputSchema: {
            type: 'object',
            properties: { content: { type: 'string', description: 'TODO 내용 (최대 2000자)' } },
            required: ['content'],
        },
    },
    {
        name: 'ws_update_todo',
        description: 'TODO 항목을 수정합니다. checked/content/archived 중 제공된 필드만 변경합니다.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number', description: 'TODO ID' },
                checked: { type: 'boolean', description: '체크 여부 (선택)' },
                content: { type: 'string', description: '내용 (선택, 최대 2000자)' },
                archived: { type: 'boolean', description: '보관 여부 (선택)' },
            },
            required: ['id'],
        },
    },
    {
        name: 'ws_delete_todo',
        description: 'TODO 항목을 소프트 삭제합니다.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'number', description: 'TODO ID' } },
            required: ['id'],
        },
    },
    // ── 게시판 도구 ──
    {
        name: 'ws_list_board_posts',
        description: '워크스페이스 게시판의 게시글 목록을 페이지 단위(페이지당 20개, 최신순)로 반환합니다. 각 글에 댓글 수(comment_count)가 포함됩니다.',
        inputSchema: {
            type: 'object',
            properties: { page: { type: 'number', description: '페이지 번호 (1-based, 선택, 기본 1)' } },
            required: [],
        },
    },
    {
        name: 'ws_read_board_post',
        description: '게시글 한 건의 본문과 댓글 목록을 함께 반환합니다.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'number', description: '게시글 ID' } },
            required: ['id'],
        },
    },
    {
        name: 'ws_create_board_post',
        description: '워크스페이스 게시판에 게시글을 작성합니다.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: '제목 (최대 200자)' },
                content: { type: 'string', description: '본문 (선택, 최대 50000자)' },
            },
            required: ['title'],
        },
    },
    {
        name: 'ws_delete_board_post',
        description: '게시글을 소프트 삭제합니다(작성자 본인 또는 관리 권한 필요).',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'number', description: '게시글 ID' } },
            required: ['id'],
        },
    },
    {
        name: 'ws_create_board_comment',
        description: '게시글에 댓글을 작성합니다.',
        inputSchema: {
            type: 'object',
            properties: {
                post_id: { type: 'number', description: '게시글 ID' },
                content: { type: 'string', description: '댓글 내용 (최대 5000자)' },
            },
            required: ['post_id', 'content'],
        },
    },
];

const INFORMATION_TOOL: WsMcpToolDef = {
    name: 'information',
    description: `Cloudwiki 워크스페이스 MCP — 엔드포인트가 /api/ws/{wslug}/mcp 형식으로 워크스페이스마다 고유합니다. 사용자가 소유/참여 중인 개인 워크스페이스의 문서·미디어·리비전·TODO·게시판을 다룹니다. 전역 위키 MCP(/api/mcp)와 달리 편집은 승인 절차 없이 사용자 명의로 즉시 반영됩니다. 워크스페이스 컨텍스트는 URL 에서 자동으로 결정되므로 도구 인자에 workspace 를 별도 지정하지 않습니다. 접근 가능한 다른 워크스페이스를 보려면 ws_list_workspaces 를 사용하세요. 사용 가능한 도구: ${WS_MCP_TOOL_DEFS.map(t => t.name).join(', ')}.`,
    inputSchema: { type: 'object', properties: {}, required: [] },
};

// ────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────

/** 텍스트 content 결과 (성공). */
function textResult(text: string) {
    return { content: [{ type: 'text', text }] };
}

/** 오류 content 결과 (MCP tool error — mcp.ts 의 isError 관례와 동일). */
function errorResult(message: string) {
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/** JSON 직렬화 텍스트 결과. */
function jsonResult(obj: unknown) {
    return textResult(JSON.stringify(obj, null, 2));
}

/**
 * 워크스페이스 슬러그 검증 (workspace-pages.ts validatePageSlug 와 동일 규칙).
 * 전역 금지문자 + ':' 금지.
 */
function validatePageSlug(raw: unknown): { ok: true; slug: string } | { ok: false; error: string } {
    if (typeof raw !== 'string') return { ok: false, error: '문서 슬러그가 필요합니다.' };
    const slug = normalizeSlug(raw);
    if (!slug) return { ok: false, error: '문서 슬러그를 입력해주세요.' };
    if (SLUG_FORBIDDEN_CHARS.test(slug)) {
        return { ok: false, error: '문서 슬러그에 사용할 수 없는 문자가 포함되어 있습니다. ([ ] { } # % | < > ^ 등)' };
    }
    if (slug.includes(':')) {
        return { ok: false, error: "워크스페이스 문서 슬러그에는 ':' 를 사용할 수 없습니다." };
    }
    return { ok: true, slug };
}

/**
 * URL 의 :wslug 파라미터로 워크스페이스와 접근 권한을 해석한다.
 * 반환:
 *   - error: 도구 오류 결과(워크스페이스 미존재 또는 권한 부족) — 호출 측은 그대로 반환.
 *   - workspace/access: 정상 해석.
 */
async function resolveScope(
    c: Context<Env>,
    user: User,
    need: 'read' | 'write'
): Promise<{ error: ReturnType<typeof errorResult> } | { workspace: Workspace; access: WorkspaceAccess }> {
    const param = c.req.param('wslug');
    const wslug = typeof param === 'string' ? param.trim() : '';
    if (!wslug) return { error: errorResult('URL 에 워크스페이스 슬러그가 없습니다.') };
    const rbac = c.get('rbac') as RBAC;
    const { workspace, access } = await getWorkspaceAccessBySlug(c.env.DB, wslug, user, rbac);
    if (!workspace) return { error: errorResult('workspace not found') };
    if (need === 'read' && !access.canRead) return { error: errorResult('권한이 없습니다.') };
    if (need === 'write' && !access.canWrite) return { error: errorResult('권한이 없습니다.') };
    return { workspace, access };
}

/** (workspace_id, slug) 의 비삭제 문서 조회. */
async function findPage(db: D1Database, workspaceId: number, slug: string) {
    return db
        .prepare('SELECT * FROM workspace_pages WHERE workspace_id = ? AND slug = ? AND deleted_at IS NULL')
        .bind(workspaceId, slug)
        .first<{
            id: number; slug: string; title: string | null; content: string; version: number;
            ws_public: number; redirect_to: string | null; last_revision_id: number | null;
            rows: number | null; characters: number | null;
        }>();
}

/** LIKE 패턴 이스케이프. */
function escapeLike(s: string): string {
    return s.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

// ────────────────────────────────────────────────────────────────
// 도구 디스패치
// ────────────────────────────────────────────────────────────────

async function dispatchTool(c: Context<Env>, user: User, toolName: string, args: any) {
    const db = c.env.DB;
    const origin = new URL(c.req.url).origin;

    // ── ws_list_workspaces (워크스페이스 무관) ──
    if (toolName === 'ws_list_workspaces') {
        // 이 경로는 resolveScope(=ACL)를 거치지 않으므로 status 컬럼을 직접 보장한다.
        await ensureWorkspaceMembersStatusMigration(db);
        const owned = await db.prepare(
            `SELECT slug, name FROM workspaces WHERE owner_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`
        ).bind(user.id).all<{ slug: string; name: string }>();
        // 참가(수락 완료)한 워크스페이스만 노출한다 — 대기중(pending) 초대는 멤버가 아니다.
        const joined = await db.prepare(
            `SELECT w.slug, w.name, m.role AS role
             FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
             WHERE m.user_id = ? AND m.status = 'active' AND w.deleted_at IS NULL AND w.owner_id != ?
             ORDER BY w.created_at DESC`
        ).bind(user.id, user.id).all<{ slug: string; name: string; role: string }>();
        const list = [
            ...(owned.results || []).map(r => ({ slug: r.slug, name: r.name, role: 'owner' })),
            ...(joined.results || []).map(r => ({ slug: r.slug, name: r.name, role: r.role })),
        ];
        return jsonResult({ workspaces: list });
    }

    // ── 읽기 도구 ──
    if (toolName === 'ws_list_pages') {
        const scope = await resolveScope(c, user, 'read');
        if ('error' in scope) return scope.error;
        const conds: string[] = ['workspace_id = ?', 'deleted_at IS NULL'];
        const binds: unknown[] = [scope.workspace.id];
        if (typeof args?.prefix === 'string' && args.prefix.trim()) {
            const prefix = normalizeSlug(args.prefix);
            if (prefix) {
                conds.push("slug LIKE ? ESCAPE '\\'");
                binds.push(escapeLike(prefix) + '/%');
            }
        }
        const rows = await db.prepare(
            `SELECT slug, title, updated_at, version, ws_public
             FROM workspace_pages WHERE ${conds.join(' AND ')}
             ORDER BY updated_at DESC LIMIT 500`
        ).bind(...binds).all();
        return jsonResult({ pages: rows.results || [] });
    }

    if (toolName === 'ws_read_page') {
        const scope = await resolveScope(c, user, 'read');
        if ('error' in scope) return scope.error;
        const slug = normalizeSlug(String(args?.slug || ''));
        if (!slug) return errorResult('slug 가 필요합니다.');
        const page = await findPage(db, scope.workspace.id, slug);
        if (!page) return errorResult('문서를 찾을 수 없습니다.');
        return jsonResult({
            slug: page.slug,
            title: page.title,
            version: page.version,
            ws_public: page.ws_public,
            redirect_to: page.redirect_to,
            content: page.content,
        });
    }

    if (toolName === 'ws_list_revisions') {
        const scope = await resolveScope(c, user, 'read');
        if ('error' in scope) return scope.error;
        const slug = normalizeSlug(String(args?.slug || ''));
        if (!slug) return errorResult('slug 가 필요합니다.');
        const page = await findPage(db, scope.workspace.id, slug);
        if (!page) return errorResult('문서를 찾을 수 없습니다.');
        const rows = await db.prepare(
            `SELECT r.id, r.page_version, r.summary, r.author_id, u.name AS author_name, r.created_at
             FROM workspace_revisions r
             LEFT JOIN users u ON u.id = r.author_id
             WHERE r.page_id = ? AND r.deleted_at IS NULL
             ORDER BY r.page_version DESC, r.id DESC
             LIMIT 30`
        ).bind(page.id).all();
        return jsonResult({ slug: page.slug, version: page.version, revisions: rows.results || [] });
    }

    if (toolName === 'ws_read_revision') {
        const scope = await resolveScope(c, user, 'read');
        if ('error' in scope) return scope.error;
        const revisionId = Number(args?.revision_id);
        if (!Number.isInteger(revisionId) || revisionId <= 0) {
            return errorResult('revision_id 는 양의 정수여야 합니다.');
        }
        const rev = await db.prepare(
            `SELECT r.id, r.page_id, r.page_version, r.content, r.r2_key, r.summary, r.author_id, r.created_at,
                    r.deleted_at, r.purged_at, p.workspace_id, p.slug
             FROM workspace_revisions r
             JOIN workspace_pages p ON p.id = r.page_id
             WHERE r.id = ?`
        ).bind(revisionId).first<{
            id: number; page_id: number; page_version: number | null; content: string; r2_key: string | null;
            summary: string | null; author_id: number | null; created_at: number;
            deleted_at: number | null; purged_at: number | null; workspace_id: number; slug: string;
        }>();
        // 다른 워크스페이스의 리비전은 존재하지 않는 것처럼 거부 (id 열거로 격리 우회 차단).
        if (!rev || rev.workspace_id !== scope.workspace.id || rev.deleted_at) {
            return errorResult('리비전을 찾을 수 없습니다.');
        }
        const content = rev.purged_at
            ? ''
            : await getRevisionContent(c.env.MEDIA, { content: rev.content, r2_key: rev.r2_key }, origin);
        return jsonResult({
            id: rev.id,
            slug: rev.slug,
            page_version: rev.page_version,
            summary: rev.summary,
            author_id: rev.author_id,
            created_at: rev.created_at,
            purged: !!rev.purged_at,
            content,
        });
    }

    if (toolName === 'ws_get_backlinks') {
        const scope = await resolveScope(c, user, 'read');
        if ('error' in scope) return scope.error;
        const slug = normalizeSlug(String(args?.slug || ''));
        if (!slug) return errorResult('slug 가 필요합니다.');
        const rows = await db.prepare(
            `SELECT DISTINCT p.slug, p.title
             FROM workspace_page_links l
             JOIN workspace_pages p ON p.id = l.source_page_id AND p.deleted_at IS NULL
             WHERE l.workspace_id = ? AND l.target_slug = ?
             ORDER BY p.slug ASC`
        ).bind(scope.workspace.id, slug).all();
        return jsonResult({ slug, backlinks: rows.results || [] });
    }

    if (toolName === 'ws_list_media') {
        const scope = await resolveScope(c, user, 'read');
        if ('error' in scope) return scope.error;
        const rows = await db.prepare(
            `SELECT filename, mime_type, size, ws_public
             FROM workspace_media WHERE workspace_id = ? ORDER BY id DESC LIMIT 500`
        ).bind(scope.workspace.id).all<{ filename: string; mime_type: string; size: number; ws_public: number }>();
        const media = (rows.results || []).map(m => ({
            filename: m.filename,
            mime_type: m.mime_type,
            size: m.size,
            ws_public: m.ws_public,
            url: `/wsmedia/${scope.workspace.id}/${m.filename}`,
        }));
        return jsonResult({ media });
    }

    if (toolName === 'ws_list_members') {
        const scope = await resolveScope(c, user, 'read');
        if ('error' in scope) return scope.error;
        const owner = await db.prepare('SELECT name FROM users WHERE id = ?')
            .bind(scope.workspace.owner_id).first<{ name: string }>();
        // 대기중(pending) 초대는 관리 정보이므로 canManage 에게만 노출하고(web /members 와 대칭),
        // 일반 reader 에게는 active 멤버만 보여준다.
        const members = await db.prepare(
            scope.access.canManage
                ? `SELECT u.name, m.role, m.status
                   FROM workspace_members m JOIN users u ON u.id = m.user_id
                   WHERE m.workspace_id = ? ORDER BY m.status DESC, m.created_at ASC`
                : `SELECT u.name, m.role, m.status
                   FROM workspace_members m JOIN users u ON u.id = m.user_id
                   WHERE m.workspace_id = ? AND m.status = 'active' ORDER BY m.created_at ASC`
        ).bind(scope.workspace.id).all<{ name: string; role: string; status: string }>();
        const list = [
            { name: owner?.name ?? '(unknown)', role: 'owner', status: 'active' },
            ...(members.results || []).map(m => ({ name: m.name, role: m.role, status: m.status })),
        ];
        return jsonResult({ members: list });
    }

    // ── 쓰기 도구 ──
    if (toolName === 'ws_create_or_update_page') {
        const scope = await resolveScope(c, user, 'write');
        if ('error' in scope) return scope.error;
        const validated = validatePageSlug(args?.slug);
        if (!validated.ok) return errorResult(validated.error);
        if (typeof args?.content !== 'string') return errorResult('content 가 필요합니다.');
        const content = args.content.replace(/\r\n?/g, '\n');

        const summary = typeof args?.summary === 'string' && args.summary.trim() ? args.summary.trim() : null;

        let title: string | null | undefined = undefined;
        if (args && 'title' in args) {
            if (args.title === null || args.title === '' || args.title === undefined) {
                title = null;
            } else if (typeof args.title === 'string') {
                title = args.title;
            } else {
                return errorResult('title 형식이 올바르지 않습니다.');
            }
        }

        let wsPublic: number | undefined = undefined;
        if (args && 'ws_public' in args && args.ws_public !== null && args.ws_public !== undefined) {
            if (args.ws_public !== 0 && args.ws_public !== 1) {
                return errorResult('ws_public 은 0 또는 1 이어야 합니다.');
            }
            wsPublic = args.ws_public;
        }

        try {
            const result = await saveWorkspacePage(c, {
                workspaceId: scope.workspace.id,
                slug: validated.slug,
                content,
                authorId: user.id,
                summary,
                title,
                wsPublic,
            });
            return jsonResult({ ok: true, created: result.created, version: result.new_version });
        } catch (e: any) {
            if (e?.code === 'CONCURRENT_MODIFICATION') {
                return errorResult('다른 사용자가 동시에 문서를 수정했습니다. 다시 시도해주세요.');
            }
            if (e?.code === 'SLUG_TAKEN') {
                return errorResult('이미 사용 중인 슬러그입니다. (삭제된 문서가 점유 중일 수 있습니다)');
            }
            return errorResult(String(e?.message || e));
        }
    }

    if (toolName === 'ws_delete_page') {
        const scope = await resolveScope(c, user, 'write');
        if ('error' in scope) return scope.error;
        const slug = normalizeSlug(String(args?.slug || ''));
        if (!slug) return errorResult('slug 가 필요합니다.');
        const result = await db.prepare(
            'UPDATE workspace_pages SET deleted_at = unixepoch() WHERE workspace_id = ? AND slug = ? AND deleted_at IS NULL'
        ).bind(scope.workspace.id, slug).run();
        if (!result.meta.changes) return errorResult('문서를 찾을 수 없습니다.');
        try {
            await syncWorkspaceMediaVisibility(db, scope.workspace.id);
        } catch (e) {
            console.error('workspace media visibility sync failed:', e);
        }
        return jsonResult({ ok: true });
    }

    if (toolName === 'ws_move_page') {
        const scope = await resolveScope(c, user, 'write');
        if ('error' in scope) return scope.error;
        const slug = normalizeSlug(String(args?.slug || ''));
        if (!slug) return errorResult('slug 가 필요합니다.');
        const validated = validatePageSlug(args?.new_slug);
        if (!validated.ok) return errorResult(validated.error);
        const newSlug = validated.slug;

        const page = await findPage(db, scope.workspace.id, slug);
        if (!page) return errorResult('문서를 찾을 수 없습니다.');
        if (newSlug === page.slug) return errorResult('현재 슬러그와 동일합니다.');

        const taken = await findPage(db, scope.workspace.id, newSlug);
        if (taken) return errorResult('이미 사용 중인 슬러그입니다.');

        try {
            await db.prepare(
                'UPDATE workspace_pages SET slug = ?, updated_at = unixepoch() WHERE id = ? AND deleted_at IS NULL'
            ).bind(newSlug, page.id).run();
        } catch (e: any) {
            const msg = String(e?.message || e);
            if (/UNIQUE|constraint/i.test(msg)) {
                return errorResult('이미 사용 중인 슬러그입니다.');
            }
            return errorResult(msg);
        }
        return jsonResult({ ok: true, slug: newSlug });
    }

    // ── Todo 도구 ──
    // (제약값은 workspace-todos.ts 와 동일)
    const TODO_MAX_LENGTH = 2000;

    if (toolName === 'ws_list_todos') {
        const scope = await resolveScope(c, user, 'read');
        if ('error' in scope) return scope.error;

        const conds: string[] = ['workspace_id = ?', 'deleted_at IS NULL'];
        const binds: unknown[] = [scope.workspace.id];

        // archived: true → 보관된 항목만, 그 외(생략/false) → 비보관 항목만.
        if (args?.archived === true) {
            conds.push('archived_at IS NOT NULL');
        } else {
            conds.push('archived_at IS NULL');
        }

        if (args?.filter === 'checked') conds.push('checked = 1');
        else if (args?.filter === 'unchecked') conds.push('checked = 0');

        const order = args?.sort === 'created_desc'
            ? 't.created_at DESC, t.id DESC'
            : 't.created_at ASC, t.id ASC';

        const rows = await db.prepare(
            `SELECT t.id, t.content, t.checked, t.archived_at, t.created_by, t.created_at, t.updated_at, u.name AS created_by_name
             FROM workspace_todos t
             LEFT JOIN users u ON u.id = t.created_by
             WHERE ${conds.join(' AND ')}
             ORDER BY ${order}
             LIMIT 1000`
        ).bind(...binds).all();
        const todos = rows.results || [];
        return jsonResult({ todos, has_more: todos.length === 1000 });
    }

    if (toolName === 'ws_create_todo') {
        const scope = await resolveScope(c, user, 'write');
        if ('error' in scope) return scope.error;
        const content = typeof args?.content === 'string' ? args.content.trim() : '';
        if (!content) return errorResult('content 가 필요합니다.');
        if (content.length > TODO_MAX_LENGTH) {
            return errorResult(`내용은 최대 ${TODO_MAX_LENGTH}자까지 입력할 수 있습니다.`);
        }
        const res = await db.prepare(
            'INSERT INTO workspace_todos (workspace_id, content, checked, created_by) VALUES (?, ?, 0, ?)'
        ).bind(scope.workspace.id, content, user.id).run();
        return jsonResult({ ok: true, id: Number(res.meta.last_row_id) });
    }

    if (toolName === 'ws_update_todo') {
        const scope = await resolveScope(c, user, 'write');
        if ('error' in scope) return scope.error;
        const id = Number(args?.id);
        if (!Number.isInteger(id) || id <= 0) return errorResult('id 는 양의 정수여야 합니다.');

        const sets: string[] = [];
        const binds: unknown[] = [];

        if ('checked' in (args || {}) && args.checked !== undefined) {
            if (typeof args.checked !== 'boolean') return errorResult('checked 는 true/false 여야 합니다.');
            sets.push('checked = ?');
            binds.push(args.checked ? 1 : 0);
        }
        if ('content' in (args || {}) && args.content !== undefined) {
            const content = typeof args.content === 'string' ? args.content.trim() : '';
            if (!content) return errorResult('content 를 입력해주세요.');
            if (content.length > TODO_MAX_LENGTH) {
                return errorResult(`내용은 최대 ${TODO_MAX_LENGTH}자까지 입력할 수 있습니다.`);
            }
            sets.push('content = ?');
            binds.push(content);
        }
        if ('archived' in (args || {}) && args.archived !== undefined) {
            if (typeof args.archived !== 'boolean') return errorResult('archived 는 true/false 여야 합니다.');
            sets.push('archived_at = ?');
            binds.push(args.archived ? Math.floor(Date.now() / 1000) : null);
        }
        if (!sets.length) return errorResult('변경할 내용이 없습니다.');

        sets.push('updated_at = unixepoch()');
        binds.push(id, scope.workspace.id);

        const res = await db.prepare(
            `UPDATE workspace_todos SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
        ).bind(...binds).run();
        if (!res.meta.changes) return errorResult('항목을 찾을 수 없습니다.');
        return jsonResult({ ok: true });
    }

    if (toolName === 'ws_delete_todo') {
        const scope = await resolveScope(c, user, 'write');
        if ('error' in scope) return scope.error;
        const id = Number(args?.id);
        if (!Number.isInteger(id) || id <= 0) return errorResult('id 는 양의 정수여야 합니다.');
        const res = await db.prepare(
            'UPDATE workspace_todos SET deleted_at = unixepoch() WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL'
        ).bind(id, scope.workspace.id).run();
        if (!res.meta.changes) return errorResult('항목을 찾을 수 없습니다.');
        return jsonResult({ ok: true });
    }

    // ── 게시판 도구 ──
    // (제약값은 workspace-board.ts 와 동일)
    const BOARD_PAGE_SIZE = 20;
    const TITLE_MAX_LENGTH = 200;
    const CONTENT_MAX_LENGTH = 50000;
    const COMMENT_MAX_LENGTH = 5000;

    if (toolName === 'ws_list_board_posts') {
        const scope = await resolveScope(c, user, 'read');
        if ('error' in scope) return scope.error;

        let page = Number(args?.page) || 1;
        if (!Number.isInteger(page) || page < 1) page = 1;
        const offset = (page - 1) * BOARD_PAGE_SIZE;

        const countRow = await db.prepare(
            'SELECT COUNT(*) AS n FROM workspace_board_posts WHERE workspace_id = ? AND deleted_at IS NULL'
        ).bind(scope.workspace.id).first<{ n: number }>();
        const total = Number(countRow?.n || 0);

        const rows = await db.prepare(
            `SELECT p.id, p.title, p.author_id, p.created_at, p.updated_at,
                    u.name AS author_name,
                    (SELECT COUNT(*) FROM workspace_board_comments cm
                       WHERE cm.post_id = p.id AND cm.deleted_at IS NULL) AS comment_count
             FROM workspace_board_posts p
             LEFT JOIN users u ON u.id = p.author_id
             WHERE p.workspace_id = ? AND p.deleted_at IS NULL
             ORDER BY p.created_at DESC, p.id DESC
             LIMIT ? OFFSET ?`
        ).bind(scope.workspace.id, BOARD_PAGE_SIZE, offset).all();

        return jsonResult({ posts: rows.results || [], total, page, pageSize: BOARD_PAGE_SIZE });
    }

    if (toolName === 'ws_read_board_post') {
        const scope = await resolveScope(c, user, 'read');
        if ('error' in scope) return scope.error;
        const postId = Number(args?.id);
        if (!Number.isInteger(postId) || postId <= 0) return errorResult('id 는 양의 정수여야 합니다.');

        const post = await db.prepare(
            `SELECT p.id, p.title, p.content, p.author_id, p.created_at, p.updated_at, u.name AS author_name
             FROM workspace_board_posts p
             LEFT JOIN users u ON u.id = p.author_id
             WHERE p.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL`
        ).bind(postId, scope.workspace.id).first();
        if (!post) return errorResult('게시글을 찾을 수 없습니다.');

        const comments = await db.prepare(
            `SELECT cm.id, cm.post_id, cm.author_id, cm.content, cm.created_at, u.name AS author_name
             FROM workspace_board_comments cm
             JOIN workspace_board_posts p ON p.id = cm.post_id
             LEFT JOIN users u ON u.id = cm.author_id
             WHERE cm.post_id = ? AND p.workspace_id = ? AND cm.deleted_at IS NULL
             ORDER BY cm.created_at ASC, cm.id ASC`
        ).bind(postId, scope.workspace.id).all();

        return jsonResult({ post, comments: comments.results || [] });
    }

    if (toolName === 'ws_create_board_post') {
        const scope = await resolveScope(c, user, 'write');
        if ('error' in scope) return scope.error;
        const title = typeof args?.title === 'string' ? args.title.trim() : '';
        if (!title) return errorResult('title 이 필요합니다.');
        if (title.length > TITLE_MAX_LENGTH) {
            return errorResult(`제목은 최대 ${TITLE_MAX_LENGTH}자까지 입력할 수 있습니다.`);
        }
        if ('content' in (args || {}) && args.content != null && typeof args.content !== 'string') {
            return errorResult('content 형식이 올바르지 않습니다.');
        }
        const content = typeof args?.content === 'string' ? args.content.replace(/\r\n?/g, '\n') : '';
        if (content.length > CONTENT_MAX_LENGTH) {
            return errorResult(`본문은 최대 ${CONTENT_MAX_LENGTH}자까지 입력할 수 있습니다.`);
        }
        const res = await db.prepare(
            'INSERT INTO workspace_board_posts (workspace_id, title, content, author_id) VALUES (?, ?, ?, ?)'
        ).bind(scope.workspace.id, title, content, user.id).run();
        return jsonResult({ ok: true, id: Number(res.meta.last_row_id) });
    }

    if (toolName === 'ws_delete_board_post') {
        const scope = await resolveScope(c, user, 'write');
        if ('error' in scope) return scope.error;
        const postId = Number(args?.id);
        if (!Number.isInteger(postId) || postId <= 0) return errorResult('id 는 양의 정수여야 합니다.');

        const post = await db.prepare(
            'SELECT id, author_id FROM workspace_board_posts WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL'
        ).bind(postId, scope.workspace.id).first<{ id: number; author_id: number | null }>();
        if (!post) return errorResult('게시글을 찾을 수 없습니다.');
        // 작성자 본인 또는 관리 권한(owner/super_admin)만 삭제 가능.
        if (post.author_id !== user.id && !scope.access.canManage) {
            return errorResult('이 게시글을 삭제할 권한이 없습니다.');
        }
        await db.prepare(
            'UPDATE workspace_board_posts SET deleted_at = unixepoch() WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL'
        ).bind(postId, scope.workspace.id).run();
        return jsonResult({ ok: true });
    }

    if (toolName === 'ws_create_board_comment') {
        const scope = await resolveScope(c, user, 'write');
        if ('error' in scope) return scope.error;
        const postId = Number(args?.post_id);
        if (!Number.isInteger(postId) || postId <= 0) return errorResult('post_id 는 양의 정수여야 합니다.');

        const post = await db.prepare(
            'SELECT id FROM workspace_board_posts WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL'
        ).bind(postId, scope.workspace.id).first<{ id: number }>();
        if (!post) return errorResult('게시글을 찾을 수 없습니다.');

        const content = typeof args?.content === 'string' ? args.content.replace(/\r\n?/g, '\n').trim() : '';
        if (!content) return errorResult('content 가 필요합니다.');
        if (content.length > COMMENT_MAX_LENGTH) {
            return errorResult(`댓글은 최대 ${COMMENT_MAX_LENGTH}자까지 입력할 수 있습니다.`);
        }
        const res = await db.prepare(
            'INSERT INTO workspace_board_comments (post_id, author_id, content) VALUES (?, ?, ?)'
        ).bind(postId, user.id, content).run();
        return jsonResult({ ok: true, id: Number(res.meta.last_row_id) });
    }

    return null; // 호출 측에서 Tool not found 처리
}

// ────────────────────────────────────────────────────────────────
// JSON-RPC 처리
// ────────────────────────────────────────────────────────────────

async function handleJsonRpc(c: Context<Env>, body: any, user: User) {
    const { jsonrpc, method, params, id } = body || {};
    if (jsonrpc !== '2.0') {
        return { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: id ?? null };
    }

    if (method === 'initialize') {
        return {
            jsonrpc: '2.0',
            id,
            result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {}, logging: {} },
                serverInfo: { name: 'cloudwiki-workspace', version: '1.0.0' },
            },
        };
    }

    if (method === 'notifications/initialized') {
        return null;
    }

    if (method === 'tools/list') {
        return {
            jsonrpc: '2.0', id,
            result: { tools: [INFORMATION_TOOL, ...WS_MCP_TOOL_DEFS] },
        };
    }

    if (method === 'tools/call') {
        const toolName = params?.name;
        const args = params?.arguments || {};
        try {
            if (toolName === 'information') {
                return { jsonrpc: '2.0', id, result: textResult(INFORMATION_TOOL.description) };
            }
            const result = await dispatchTool(c, user, toolName, args);
            if (result) return { jsonrpc: '2.0', id, result };
            return { jsonrpc: '2.0', error: { code: -32601, message: `Tool not found: ${toolName}` }, id };
        } catch (e: any) {
            return { jsonrpc: '2.0', error: { code: -32000, message: e.message }, id };
        }
    }

    return { jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id };
}

// ────────────────────────────────────────────────────────────────
// 라우트 (/api/ws/:wslug/mcp)
// ────────────────────────────────────────────────────────────────

// GET — 디스커버리 JSON.
wsMcp.get('/api/ws/:wslug/mcp', (c) => {
    if (!isWorkspacesEnabled(c.env)) {
        return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Workspaces are disabled by administrator.' }, id: null }, 403);
    }
    const origin = new URL(c.req.url).origin;
    const wslug = c.req.param('wslug');
    return c.json({ mcp: true, scope: 'workspace', workspace: wslug, version: '1.0.0', transport: 'http', endpoint: `${origin}/api/ws/${wslug}/mcp` });
});

// POST — JSON-RPC 엔드포인트 (Bearer 인증 필수).
wsMcp.post('/api/ws/:wslug/mcp', async (c) => {
    if (!isWorkspacesEnabled(c.env)) {
        return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Workspaces are disabled by administrator.' }, id: null }, 403);
    }
    const auth = await authenticateBearer(c);
    if (auth instanceof Response) return auth;

    const body = await c.req.json().catch(() => null);
    if (body === null) {
        return c.json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }, 400);
    }
    const response = await handleJsonRpc(c, body, auth);
    if (response === null) return c.body(null, 204);
    return c.json(response);
});

export default wsMcp;
