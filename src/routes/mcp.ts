import { Hono, Context } from 'hono';
import { cors } from 'hono/cors';
import type { Env, User } from '../types';
import { RBAC } from '../utils/role';
import { renderForAI, extractTOC, extractSection, expandTemplates } from '../utils/aiParser';
import { normalizeSlug, isR2OnlyNamespace, isMcpReadableSlug } from '../utils/slug';
import { getEnabledExtensions } from '../utils/extensions';
import { getRevisionContent } from '../utils/r2';
import { resolveBearerAuth } from '../utils/mcpAuth';
import {
    MCP_TOOL_DEFS_ALL,
    buildInformationIntro,
    dispatchReadTool,
    formatRelativeTime,
} from '../utils/mcpDispatch';
import {
    USER_TOOL_DEFS,
    ADMIN_ONLY_TOOL_DEFS,
    buildUserEditInformationSuffix,
    buildAdminOnlyInformationSuffix,
    dispatchAdminReadTool,
    dispatchAdminEditTool,
} from './admin-mcp';

const mcpRoutes = new Hono<Env>();

// formatRelativeTime / bytesToBase64 / MCP_TOOL_DEFS / buildInformationIntro 는
// src/utils/mcpDispatch.ts 로 이동했다. 본 파일은 통합 MCP 엔드포인트(/api/mcp) 의
// JSON-RPC 라우팅을 담당하며, 다음 3계층으로 도구를 노출한다 (admin-mcp.ts 에서 합류):
//   1) guest (Authorization 헤더 없음 또는 토큰은 유효하지만 권한이 박탈된 사용자)
//      → MCP_TOOL_DEFS_ALL 의 읽기 도구만.
//   2) 일반 유저(`wiki:edit`) → 1) + USER_TOOL_DEFS (draft 편집 + revert + 보조 읽기).
//   3) 관리자(`admin:access`) → 1) + 2) + ADMIN_ONLY_TOOL_DEFS (삭제/복원/이동 + 삭제 목록).
//
// WIKI_VISIBILITY=closed 환경에서는 guest 진입을 401 로 막아 OAuth 흐름 트리거.
// 토큰이 invalid/expired/revoked 면 (역시 401) 클라이언트 재인증 유도.

// CORS 미들웨어 적용
mcpRoutes.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Hono-CSRF', 'MCP-Protocol-Version'],
    maxAge: 86400,
}));

// 인증 및 모드 체크 미들웨어
mcpRoutes.use('*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return await next();

    const mcpMode = c.env.MCP_MODE || 'disabled';

    if (mcpMode === 'disabled') {
        return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'MCP is disabled by administrator.' }, id: null }, 403);
    }

    await next();
});

// ────────────────────────────────────────────────────────────────
// Bearer 토큰 인증 (선택적) — OAuth 2.1 액세스 토큰을 받아 user 객체를 반환한다.
//   - 헤더 없음 → guest 모드 (user=null) 로 통과.
//   - 토큰이 잘못됨 / 만료 / 폐기 / scope 부적합 → 401 + WWW-Authenticate (재인증 유도).
//   - 토큰은 유효하지만 사용자 권한이 모두 박탈됨(banned 등) → guest 로 강등.
// 도구 가시성은 mcp.ts 의 handleJsonRpc 에서 RBAC.can() 으로 분기한다.
// ────────────────────────────────────────────────────────────────

interface McpAuthContext {
    user: User | null;
    tokenId: number | null;
    scope: string | null;
}

function unauthorized(c: Context<Env>, description: string): Response {
    const origin = new URL(c.req.url).origin;
    const resourceMetadata = `${origin}/.well-known/oauth-protected-resource`;
    c.header(
        'WWW-Authenticate',
        `Bearer realm="mcp", error="invalid_token", error_description="${description}", resource_metadata="${resourceMetadata}"`,
    );
    return c.json({ error: 'invalid_token', error_description: description }, 401);
}

const GUEST_AUTH: McpAuthContext = { user: null, tokenId: null, scope: null };

async function tryAuthenticateBearer(c: Context<Env>): Promise<McpAuthContext | Response> {
    const res = await resolveBearerAuth(c);
    // 헤더가 아예 없으면 guest 모드 — OAuth 흐름을 시작하지 않은 호출자에게 읽기 도구를 허용.
    if (res.kind === 'none') return GUEST_AUTH;
    if (res.kind === 'error') return res.response;

    // 토큰 발급 후 권한이 강등되어 wiki:read 도 admin:access 도 없는 역할로 떨어졌거나
    // banned/deleted 인 경우 — guest 모드로 강등해 읽기 도구만 허용한다.
    // RBAC.can() 으로 매 요청 재검증해 OAuth 토큰만으로 RBAC 변경을 우회하지 못하도록 한다.
    const rbac = c.get('rbac') as RBAC;
    if (
        res.effectiveRole === 'banned' ||
        res.effectiveRole === 'deleted' ||
        (!rbac.can(res.effectiveRole, 'wiki:read') && !rbac.can(res.effectiveRole, 'admin:access'))
    ) {
        return GUEST_AUTH;
    }

    c.set('user', res.user);
    return { user: res.user, tokenId: res.tokenId, scope: res.scope };
}

// GET /api/mcp - 기본 정보 (엔드포인트 메타데이터)
async function handleMcpGet(c: Context<Env>): Promise<Response> {
    const origin = new URL(c.req.url).origin;
    return c.json({
        mcp: true,
        version: '1.0.0',
        transport: 'http',
        endpoint: `${origin}/api/mcp`
    });
}

mcpRoutes.get('/', (c) => handleMcpGet(c));

// 공통 JSON-RPC 처리 함수
async function handleJsonRpc(c: Context<Env>, body: any, user: User | null) {
    const { jsonrpc, method, params, id } = body;
    if (jsonrpc !== '2.0') return { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: id || null };

    const db = c.env.DB;
    const rbac = c.get('rbac') as RBAC;
    // 비인증 호출자는 'guest' 역할로 취급. RBAC.getDefaultPermissions() 의 guest 항목이
    // wiki:read 만 가지므로 자연스럽게 읽기 도구만 노출된다.
    const role = user ? user.role : 'guest';
    const canEdit = rbac.can(role, 'wiki:edit');
    const isAdmin = rbac.can(role, 'admin:access');
    const canSeePrivate = rbac.can(role, 'wiki:private');
    const privateFilter = canSeePrivate ? '' : ' AND is_private = 0';
    // 단계적으로 노출 도구를 합성한다 — guest 는 read 도구만, wiki:edit 는 + USER_TOOL_DEFS,
    // admin:access 는 + ADMIN_ONLY_TOOL_DEFS.
    const visibleToolDefs = [
        ...MCP_TOOL_DEFS_ALL,
        ...(canEdit ? USER_TOOL_DEFS : []),
        ...(isAdmin ? ADMIN_ONLY_TOOL_DEFS : []),
    ];
    const visibleToolNames = new Set(visibleToolDefs.map(t => t.name));

    // 1. 핸드셰이크: initialize
    if (method === 'initialize') {
        return {
            jsonrpc: '2.0',
            id,
            result: {
                protocolVersion: '2024-11-05',
                capabilities: {
                    tools: {},
                    logging: {}
                },
                serverInfo: {
                    name: 'cloudwiki-mcp',
                    version: '1.0.0'
                }
            }
        };
    }

    // 2. 핸드셰이크: initialized 알림 (응답 필요 없음)
    if (method === 'notifications/initialized') {
        return null;
    }

    // 3. 도구 목록 반환
    if (method === 'tools/list') {
        const intro = buildInformationIntro(c, MCP_TOOL_DEFS_ALL);
        const userName = user?.name || '';
        const userSuffix = canEdit ? buildUserEditInformationSuffix(userName) : '';
        const adminSuffix = isAdmin ? buildAdminOnlyInformationSuffix(userName) : '';
        const toolNames = visibleToolDefs.map(t => t.name).join(', ');
        const informationDescription = `${intro}${userSuffix}${adminSuffix}\n\n사용 가능한 MCP 도구: ${toolNames}. 각 도구의 세부 설명은 information 도구를 호출하여 확인할 수 있습니다.`;
        return {
            jsonrpc: '2.0', id,
            result: {
                tools: [
                    {
                        name: 'information',
                        description: informationDescription,
                        inputSchema: { type: 'object', properties: {}, required: [] }
                    },
                    ...visibleToolDefs,
                ]
            }
        };
    }

    if (method === 'tools/call') {
        const toolName = params?.name;
        const args = params?.arguments || {};
        try {
            // 가시 도구 목록에 없는 호출은 모두 Tool not found 로 일관 차단한다.
            // (information 은 visibleToolDefs 와 별개로 모든 호출자에게 허용된 메타 도구.)
            if (toolName !== 'information' && !visibleToolNames.has(toolName)) {
                return {
                    jsonrpc: '2.0',
                    error: { code: -32601, message: `Tool not found: ${toolName}` },
                    id,
                };
            }

            const shared = await dispatchReadTool(c, toolName, args, MCP_TOOL_DEFS_ALL);
            if (shared) return { jsonrpc: '2.0', id, result: shared };

            // user 디스패처는 USER_TOOL_DEFS / ADMIN_ONLY_TOOL_DEFS 내부 도구를 처리한다.
            // visibleToolNames 검사로 이미 권한 없는 호출은 차단된 상태이므로 user!=null 이 보장된다.
            if (user && (canEdit || isAdmin)) {
                const adminReadResult = await dispatchAdminReadTool(c, user, toolName, args);
                if (adminReadResult) return { jsonrpc: '2.0', id, result: adminReadResult };

                const adminEditResult = await dispatchAdminEditTool(c, user, toolName, args);
                if (adminEditResult) return { jsonrpc: '2.0', id, result: adminEditResult };
            }

            if (toolName === 'read_document_batch' || toolName === 'get_map') {
                const isTocMode = toolName === 'get_map';
                const BATCH_LIMIT = 10;
                const TREE_DISPLAY_CAP = 500;
                const raw = args.raw === true;
                const origin = new URL(c.req.url).origin;
                const enabledExt = getEnabledExtensions(c.env);

                let mode: 'titles' | 'parent';
                let targetSlugs: string[] = [];
                let allCandidateSlugs: string[] = [];
                let parentSlug = '';
                let pageNum = 1;
                let totalCount = 0;
                const statsMap = new Map<string, { rows: number | null; characters: number | null }>();
                const formatBatchStats = (r: number | null | undefined, ch: number | null | undefined) => ` (${r ?? 0}줄, ${ch ?? 0}자)`;

                if (Array.isArray(args.titles) && args.titles.length > 0) {
                    mode = 'titles';
                    const normalized = (args.titles as any[])
                        .map(t => normalizeSlug(String(t || '')))
                        .filter((s: string) => s.length > 0);
                    if (normalized.length === 0) {
                        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: titles 배열이 비어있습니다.' }], isError: true } };
                    }
                    if (normalized.length > BATCH_LIMIT) {
                        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: 한 번에 최대 ${BATCH_LIMIT}개까지만 읽을 수 있습니다.` }], isError: true } };
                    }
                    // 중복 제거하되 입력 순서 유지
                    const seen = new Set<string>();
                    targetSlugs = normalized.filter((s: string) => {
                        if (seen.has(s)) return false;
                        seen.add(s);
                        return true;
                    });
                    allCandidateSlugs = targetSlugs;
                    totalCount = targetSlugs.length;
                } else if (args.parent_title) {
                    mode = 'parent';
                    parentSlug = normalizeSlug(String(args.parent_title || ''));
                    if (!parentSlug) {
                        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: parent_title이 비어있습니다.' }], isError: true } };
                    }
                    pageNum = Math.max(1, Math.floor(Number(args.page) || 1));
                    const offset = (pageNum - 1) * BATCH_LIMIT;
                    // D1 의 LIKE 패턴은 50바이트 한도가 있어 긴 슬러그에서 쿼리가 실패할 수 있다.
                    // 대신 prefix 범위 비교(slug > 'parent/' AND slug < 'parent0')로 하위 문서를 찾는다.
                    // '/' (0x2F) 의 바로 다음 코드포인트가 '0' (0x30) 이므로 'parent/' 로 시작하는 모든
                    // 슬러그는 ['parent/', 'parent0') 범위에 정확히 들어간다. UTF-8 의 codepoint 순서가
                    // 바이트 사전순과 일치해 비-ASCII 슬러그에서도 안전하다.
                    const prefixLower = parentSlug + '/';
                    const prefixUpper = parentSlug + '0';

                    // total 은 트리 표시용 캡(500)과 무관하게 COUNT(*) 로 정확히 구해야 한다.
                    // 그렇지 않으면 500을 초과한 시점부터 has_next_page 가 거짓이 되어
                    // 클라이언트가 페이지네이션으로 나머지 문서에 접근할 수 없다.
                    const totalRow = await db.prepare(`SELECT COUNT(*) AS cnt FROM pages WHERE deleted_at IS NULL${privateFilter} AND slug > ? AND slug < ?`).bind(prefixLower, prefixUpper).first<{ cnt: number }>();
                    totalCount = totalRow?.cnt ?? 0;
                    if (totalCount === 0) {
                        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `'${parentSlug}' 의 하위 문서가 없습니다.` }] } };
                    }

                    // 실제 읽을 페이지는 SQL LIMIT/OFFSET 으로 직접 잘라서 가져온다.
                    // 트리 표시용 후보(allCandidateSlugs)와 별개로 처리해야 어떤 페이지 번호든 안정적으로 도달 가능하다.
                    const pageRows = await db.prepare(`SELECT slug FROM pages WHERE deleted_at IS NULL${privateFilter} AND slug > ? AND slug < ? ORDER BY slug ASC LIMIT ? OFFSET ?`).bind(prefixLower, prefixUpper, BATCH_LIMIT, offset).all<{ slug: string }>();
                    targetSlugs = pageRows.results.map(r => r.slug);
                    if (targetSlugs.length === 0) {
                        const totalPages = Math.ceil(totalCount / BATCH_LIMIT);
                        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: page ${pageNum} 에 해당하는 문서가 없습니다. (총 ${totalCount}개, ${totalPages}페이지)` }], isError: true } };
                    }

                    // 트리 표시는 응답 크기 보호를 위해 500개로 제한한다.
                    // 500을 초과해도 페이지네이션은 total/COUNT(*) 기준으로 동작하므로 도달 가능성을 잃지 않는다.
                    const treeRows = await db.prepare(`SELECT slug, rows, characters FROM pages WHERE deleted_at IS NULL${privateFilter} AND slug > ? AND slug < ? ORDER BY slug ASC LIMIT ?`).bind(prefixLower, prefixUpper, TREE_DISPLAY_CAP).all<{ slug: string; rows: number | null; characters: number | null }>();
                    allCandidateSlugs = treeRows.results.map(r => r.slug);
                    for (const r of treeRows.results) {
                        statsMap.set(r.slug, { rows: r.rows, characters: r.characters });
                    }
                    // 현재 페이지 슬러그가 트리 캡(500) 이후에 위치한 경우에도 [읽음] 표시가 보이도록 합쳐둔다.
                    if (offset + targetSlugs.length > allCandidateSlugs.length) {
                        const merged = new Set(allCandidateSlugs);
                        for (const s of targetSlugs) merged.add(s);
                        allCandidateSlugs = Array.from(merged).sort();
                    }
                } else {
                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: titles 또는 parent_title 중 하나를 지정해야 합니다.' }], isError: true } };
                }

                // 각 문서를 병렬로 읽는다. 핫패스에서 D1 쿼리 latency가 누적되지 않도록 Promise.all 사용.
                const documents = await Promise.all(targetSlugs.map(async (slug) => {
                    if (!isMcpReadableSlug(slug)) {
                        return { title: slug, error: 'raw 데이터는 읽을 수 없습니다.' };
                    }
                    const pageRow = await db.prepare(`SELECT slug, content, last_revision_id, rows, characters FROM pages WHERE slug = ? AND deleted_at IS NULL${privateFilter}`).bind(slug).first<{ slug: string, content: string, last_revision_id: number | null, rows: number | null, characters: number | null }>();
                    if (!pageRow) {
                        return { title: slug, error: '문서를 찾을 수 없거나 비공개/삭제 상태입니다.' };
                    }
                    statsMap.set(pageRow.slug, { rows: pageRow.rows, characters: pageRow.characters });
                    let actualContent = pageRow.content;
                    if (isR2OnlyNamespace(pageRow.slug, enabledExt) && (!actualContent || actualContent === '')) {
                        if (pageRow.last_revision_id) {
                            const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(pageRow.last_revision_id).first<{ content: string, r2_key: string | null }>();
                            if (lastRev) {
                                actualContent = await getRevisionContent(c.env.MEDIA, lastRev, origin);
                            }
                        }
                    }
                    if (isTocMode) {
                        const expanded = await expandTemplates(actualContent, db, 0, slug);
                        const tocText = (extractTOC(expanded) || '')
                            .split('\n')
                            .map(line => line.replace(/\{[^}]*\}/g, '').replace(/[ \t]+/g, ' ').trimEnd())
                            .join('\n');
                        return { title: slug, rows: pageRow.rows, characters: pageRow.characters, toc: tocText || '목차가 존재하지 않습니다.' };
                    }
                    const text = raw ? actualContent : await renderForAI(actualContent, db, 0, slug);
                    return { title: slug, rows: pageRow.rows, characters: pageRow.characters, content: text || '문서 내용이 존재하지 않습니다.' };
                }));

                const readSet = new Set(targetSlugs);

                if (isTocMode) {
                    // 읽은 문서들의 TOC 라인을 슬러그별로 모은다.
                    const tocBySlug = new Map<string, string[]>();
                    // 읽기 시도했지만 실패한 슬러그(권한/접근 불가, 문서 미존재 등)의 사유를 기록한다.
                    // 트리 표시 시 "(문서 없음)" 과 구분하기 위함.
                    const errorBySlug = new Map<string, string>();
                    for (const doc of documents as any[]) {
                        if (typeof doc.toc === 'string' && doc.toc !== '목차가 존재하지 않습니다.') {
                            const lines = doc.toc.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);
                            tocBySlug.set(doc.title, lines);
                        }
                        if (typeof doc.error === 'string') {
                            errorBySlug.set(doc.title, doc.error);
                        }
                    }

                    // parent 모드에서는 parent 문서 자체의 stats/TOC도 트리 루트에 표시되도록 별도 조회한다.
                    // 디스크립턴츠 페이지네이션과 무관하게 매 페이지마다 루트 정보를 표시하기 위함.
                    // 직접 조회한 슬러그는 confirmedAbsentSlugs 집합에 누적해 "확실한 미존재" 만 단정한다.
                    const confirmedAbsentSlugs = new Set<string>();
                    if (mode === 'parent' && parentSlug && !readSet.has(parentSlug)) {
                        if (!isMcpReadableSlug(parentSlug)) {
                            errorBySlug.set(parentSlug, 'raw 데이터는 읽을 수 없습니다.');
                        } else {
                            const parentRow = await db.prepare(`SELECT slug, content, last_revision_id, rows, characters FROM pages WHERE slug = ? AND deleted_at IS NULL${privateFilter}`).bind(parentSlug).first<{ slug: string, content: string, last_revision_id: number | null, rows: number | null, characters: number | null }>();
                            if (parentRow) {
                                statsMap.set(parentRow.slug, { rows: parentRow.rows, characters: parentRow.characters });
                                let actualContent = parentRow.content;
                                if (isR2OnlyNamespace(parentRow.slug, enabledExt) && (!actualContent || actualContent === '')) {
                                    if (parentRow.last_revision_id) {
                                        const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(parentRow.last_revision_id).first<{ content: string, r2_key: string | null }>();
                                        if (lastRev) {
                                            actualContent = await getRevisionContent(c.env.MEDIA, lastRev, origin);
                                        }
                                    }
                                }
                                const expanded = await expandTemplates(actualContent, db, 0, parentSlug);
                                const tocText = (extractTOC(expanded) || '')
                                    .split('\n')
                                    .map(line => line.replace(/\{[^}]*\}/g, '').replace(/[ \t]+/g, ' ').trimEnd())
                                    .join('\n');
                                const lines = tocText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                                if (lines.length > 0) tocBySlug.set(parentSlug, lines);
                                // parent는 페이지 단위로 매번 읽으므로 [읽지 않음] 마커가 붙지 않도록 readSet에 추가한다.
                                readSet.add(parentSlug);
                            } else {
                                // parent 슬러그는 직접 조회했고 결과가 없었으므로 미존재가 확실하다.
                                confirmedAbsentSlugs.add(parentSlug);
                            }
                        }
                    }

                    // parent 모드에서 totalCount 가 트리 표시 캡(500) 이내라면 treeRows 가 부모의
                    // 모든 후손을 포괄적으로 조회한 셈이므로, 통계 맵에 없는 후손 합성 노드는 미존재가 확실하다.
                    // 캡을 초과하거나 titles 모드에서는 합성된 조상 노드의 실제 존재 여부를 확인할 방법이 없으므로
                    // 이 플래그가 거짓일 때는 "(문서 없음)" 단정 표시를 하지 않는다.
                    const subtreeCoveredByQuery = mode === 'parent' && totalCount <= TREE_DISPLAY_CAP;

                    type TocTreeNode = { children: Map<string, TocTreeNode>; slug: string };
                    const makeNode = (slug: string): TocTreeNode => ({ children: new Map(), slug });

                    // 트리 루트별로 후보 슬러그들을 분류한다.
                    // parent 모드: 루트는 parentSlug. titles 모드: 슬러그의 첫 세그먼트별로 분리.
                    const treeRoots: { rootSlug: string; allSlugs: string[] }[] = [];
                    if (mode === 'parent') {
                        treeRoots.push({ rootSlug: parentSlug, allSlugs: allCandidateSlugs });
                    } else {
                        const groups = new Map<string, string[]>();
                        for (const s of allCandidateSlugs) {
                            const root = s.split('/')[0];
                            if (!groups.has(root)) groups.set(root, []);
                            groups.get(root)!.push(s);
                        }
                        for (const root of Array.from(groups.keys()).sort()) {
                            treeRoots.push({ rootSlug: root, allSlugs: groups.get(root)! });
                        }
                    }

                    const missingDocs: string[] = [];

                    function buildTocTree(rootSlug: string, slugs: string[]): TocTreeNode {
                        const root = makeNode(rootSlug);
                        for (const slug of slugs) {
                            if (slug === rootSlug) continue;
                            if (!slug.startsWith(rootSlug + '/')) continue;
                            const relative = slug.substring(rootSlug.length + 1);
                            const parts = relative.split('/');
                            let node = root;
                            let pathSoFar = rootSlug;
                            for (const part of parts) {
                                pathSoFar += '/' + part;
                                let child = node.children.get(part);
                                if (!child) {
                                    child = makeNode(pathSoFar);
                                    node.children.set(part, child);
                                }
                                node = child;
                            }
                        }
                        return root;
                    }

                    function renderTocNode(displayName: string, node: TocTreeNode, prefix: string, isRoot: boolean, isLast: boolean): string {
                        const slug = node.slug;
                        const stats = statsMap.get(slug);
                        const wasRead = readSet.has(slug);
                        const readError = errorBySlug.get(slug);

                        let line: string;
                        let childPrefix: string;
                        if (isRoot) {
                            line = displayName;
                            childPrefix = '';
                        } else {
                            const connector = isLast ? '└── ' : '├── ';
                            line = `${prefix}${connector}${displayName}`;
                            childPrefix = prefix + (isLast ? '    ' : '│   ');
                        }
                        // 우선순위:
                        // 1) 통계 맵에 있으면 정상 노드(읽기 성공 또는 트리 후보)
                        // 2) 직접 조회 후 실패한 슬러그는 "(읽기 실패)" — 경로상 미존재와 구분
                        // 3) 직접 조회로 미존재가 확정된 슬러그(parent 자체) 또는
                        //    parent 모드에서 부모 후손 전체가 한 번의 쿼리로 포괄된 경우의 합성 후손 슬러그는
                        //    "(문서 없음)" 으로 단정 표시
                        // 4) 그 외(titles 모드의 합성 조상, 트리 캡을 초과한 parent 모드 등)는
                        //    실제 존재 여부를 확인하지 않았으므로 어떤 단정도 하지 않는다.
                        if (stats) {
                            line += formatBatchStats(stats.rows, stats.characters);
                            if (mode === 'parent' && !wasRead) line += ' [읽지 않음]';
                        } else if (readError) {
                            line += ` (읽기 실패: ${readError})`;
                        } else if (
                            confirmedAbsentSlugs.has(slug) ||
                            (subtreeCoveredByQuery && slug !== parentSlug && slug.startsWith(parentSlug + '/'))
                        ) {
                            line += ' (문서 없음)';
                            missingDocs.push(slug);
                        }

                        let text = line + '\n';
                        const childKeys = Array.from(node.children.keys()).sort();
                        const tocLines = tocBySlug.get(slug) || [];
                        const total = childKeys.length + tocLines.length;
                        let i = 0;
                        for (const key of childKeys) {
                            const childIsLast = i === total - 1;
                            text += renderTocNode(key, node.children.get(key)!, childPrefix, false, childIsLast);
                            i++;
                        }
                        for (const tocLine of tocLines) {
                            const childIsLast = i === total - 1;
                            const conn = childIsLast ? '└── ' : '├── ';
                            text += `${childPrefix}${conn}#${tocLine}\n`;
                            i++;
                        }
                        return text;
                    }

                    const treeChunks: string[] = [];
                    for (const t of treeRoots) {
                        const subtree = buildTocTree(t.rootSlug, t.allSlugs);
                        treeChunks.push(renderTocNode(t.rootSlug, subtree, '', true, true).trimEnd());
                    }
                    let outputText = treeChunks.join('\n\n');

                    if (missingDocs.length > 0) {
                        const uniqueMissing = Array.from(new Set(missingDocs));
                        outputText += `\n\n문서가 없는 항목 (${uniqueMissing.length}):\n${uniqueMissing.map(s => `- ${s}`).join('\n')}`;
                    }

                    // 읽기 실패(error) 가 있는 항목도 별도로 표기한다.
                    // documents 외에 parent 모드의 루트 자체 읽기 실패도 errorBySlug 에 누적되어 있으므로
                    // 통합 맵을 단일 정보원으로 사용한다.
                    if (errorBySlug.size > 0) {
                        const erroredEntries = Array.from(errorBySlug.entries());
                        outputText += `\n\n읽지 못한 문서 (${erroredEntries.length}):\n` + erroredEntries.map(([slug, msg]) => `- ${slug}: ${msg}`).join('\n');
                    }

                    if (mode === 'parent') {
                        const totalPages = Math.ceil(totalCount / BATCH_LIMIT);
                        outputText += `\n\n페이지: ${pageNum}/${totalPages} (총 ${totalCount}개, 페이지 크기 ${BATCH_LIMIT})`;
                        if (pageNum < totalPages) outputText += ` — 다음 페이지: page=${pageNum + 1}`;
                        if (totalCount > TREE_DISPLAY_CAP) {
                            outputText += `\n주의: 하위 문서가 총 ${totalCount}개로 응답 트리 표시 한도(${TREE_DISPLAY_CAP}개)를 초과합니다. 트리에는 일부만 표시되지만, page 파라미터로 모든 문서에 도달할 수 있습니다.`;
                        }
                    }

                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: outputText }] } };
                }

                // 읽은 문서/읽지 않은 문서를 트리 또는 목록 형태로 표시 (read_document_batch 전용)
                let treeText = '';
                if (mode === 'parent') {
                    const tree: any = {};
                    for (const slug of allCandidateSlugs) {
                        const relative = slug.substring(parentSlug.length + 1);
                        const parts = relative.split('/');
                        let node = tree;
                        for (let i = 0; i < parts.length; i++) {
                            const part = parts[i];
                            if (!node[part]) node[part] = { _children: {}, _slug: '' };
                            if (i === parts.length - 1) node[part]._slug = slug;
                            node = node[part]._children;
                        }
                    }
                    function renderBatchTree(nodes: any, parentPrefix: string): string {
                        const entries = Object.keys(nodes).sort();
                        let text = '';
                        entries.forEach((key, idx) => {
                            const node = nodes[key];
                            const isLast = idx === entries.length - 1;
                            const hasChildren = Object.keys(node._children).length > 0;
                            const connector = isLast ? '└── ' : '├── ';
                            const childPrefix = parentPrefix + (isLast ? '    ' : '│   ');
                            let marker = '';
                            if (node._slug) {
                                const stats = statsMap.get(node._slug);
                                const statsText = stats ? formatBatchStats(stats.rows, stats.characters) : '';
                                marker = (readSet.has(node._slug) ? ' [읽음]' : ' [읽지 않음]') + statsText;
                            }
                            text += `${parentPrefix}${connector}${key}${marker}\n`;
                            if (hasChildren) text += renderBatchTree(node._children, childPrefix);
                        });
                        return text;
                    }
                    treeText = `${parentSlug}\n` + renderBatchTree(tree, '');
                } else {
                    treeText = allCandidateSlugs
                        .map(s => {
                            const stats = statsMap.get(s);
                            const statsText = stats ? formatBatchStats(stats.rows, stats.characters) : '';
                            return `- ${s} ${readSet.has(s) ? '[읽음]' : '[읽지 않음]'}${statsText}`;
                        })
                        .join('\n');
                }

                const output: any = {
                    mode,
                    documents,
                    tree: treeText,
                };
                if (mode === 'parent') {
                    const totalPages = Math.ceil(totalCount / BATCH_LIMIT);
                    output.parent = parentSlug;
                    output.page = pageNum;
                    output.page_size = BATCH_LIMIT;
                    output.total = totalCount;
                    output.total_pages = totalPages;
                    output.has_next_page = pageNum < totalPages;
                    if (output.has_next_page) {
                        output.next_page = pageNum + 1;
                    }
                    if (totalCount > TREE_DISPLAY_CAP) {
                        output.tree_truncated = true;
                        output.tree_display_cap = TREE_DISPLAY_CAP;
                        output.notice = `하위 문서가 총 ${totalCount}개로 응답 트리 표시 한도(${TREE_DISPLAY_CAP}개)를 초과합니다. 트리에는 일부만 표시되지만, page 파라미터로 모든 문서를 페이지네이션으로 조회할 수 있습니다.`;
                    }
                }
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] } };
            }
            if (toolName === 'list_blog_posts') {
                const BLOG_PAGE_SIZE = 20;
                const pageNum = Math.max(1, Math.floor(Number(args.page) || 1));
                const offset = (pageNum - 1) * BLOG_PAGE_SIZE;

                const [postsRes, totalRow] = await Promise.all([
                    db.prepare('SELECT id, title, created_at, updated_at, rows, characters FROM blog_posts WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?')
                        .bind(BLOG_PAGE_SIZE, offset)
                        .all<{ id: number; title: string; created_at: number | null; updated_at: number | null; rows: number | null; characters: number | null }>(),
                    db.prepare('SELECT COUNT(*) AS cnt FROM blog_posts WHERE deleted_at IS NULL').first<{ cnt: number }>()
                ]);

                const total = totalRow?.cnt ?? 0;
                const totalPages = total === 0 ? 0 : Math.ceil(total / BLOG_PAGE_SIZE);
                const nowSec = Math.floor(Date.now() / 1000);

                if (postsRes.results.length === 0 && total > 0) {
                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: page ${pageNum} 에 해당하는 블로그 포스트가 없습니다. (총 ${total}개, ${totalPages}페이지)` }], isError: true } };
                }

                const output: any = {
                    page: pageNum,
                    page_size: BLOG_PAGE_SIZE,
                    total,
                    total_pages: totalPages,
                    has_next_page: pageNum < totalPages,
                    posts: postsRes.results.map(p => ({
                        id: p.id,
                        title: p.title,
                        time_ago: formatRelativeTime(p.created_at, nowSec),
                        rows: p.rows,
                        characters: p.characters,
                    })),
                };
                if (output.has_next_page) output.next_page = pageNum + 1;
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] } };
            }
            if (toolName === 'read_blog_post' || toolName === 'get_blog_toc' || toolName === 'read_blog_section') {
                const blogId = Number(args.id);
                if (!Number.isFinite(blogId) || !Number.isInteger(blogId) || blogId <= 0) {
                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: id 는 양의 정수여야 합니다.' }], isError: true } };
                }
                const post = await db.prepare('SELECT id, title, content, rows, characters FROM blog_posts WHERE id = ? AND deleted_at IS NULL')
                    .bind(blogId)
                    .first<{ id: number; title: string; content: string; rows: number | null; characters: number | null }>();
                if (!post) {
                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: 블로그 포스트를 찾을 수 없거나 삭제되었습니다.' }], isError: true } };
                }
                const blogSlug = `blog:${post.id}`;

                if (toolName === 'get_blog_toc') {
                    const expanded = await expandTemplates(post.content, db, 0, blogSlug);
                    const tocText = (extractTOC(expanded) || '')
                        .split('\n')
                        .map(line => line.replace(/\{[^}]*\}/g, '').replace(/[ \t]+/g, ' ').trimEnd())
                        .join('\n');
                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: tocText || '목차가 존재하지 않습니다.' }] } };
                }
                if (toolName === 'read_blog_post') {
                    const text = args.raw === true ? post.content : await renderForAI(post.content, db, 0, blogSlug);
                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: text || '포스트 내용이 존재하지 않습니다.' }] } };
                }
                // read_blog_section
                const expanded = await expandTemplates(post.content, db, 0, blogSlug);
                const sectionContent = extractSection(expanded, args.section_number || '');
                const text = args.raw === true ? sectionContent : await renderForAI(sectionContent, db, 0, blogSlug);
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: text || '해당 목차를 찾을 수 없습니다.' }] } };
            }
            return { jsonrpc: '2.0', error: { code: -32601, message: `Tool not found: ${toolName}` }, id };
        } catch (e: any) {
            return { jsonrpc: '2.0', error: { code: -32000, message: e.message }, id };
        }
    }
    return { jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id };
}

// POST /api/mcp - HTTP 방식 JSON-RPC 엔드포인트 (하이브리드 인증).
//   - 인증 없음 → guest 모드 (읽기 도구만). 단, WIKI_VISIBILITY=closed 면 401 로 인증 강제.
//   - 권한 없는 토큰(banned 등) → guest 모드로 강등.
//   - 정상 토큰 → 사용자 역할에 따라 USER_TOOL_DEFS / ADMIN_ONLY_TOOL_DEFS 추가 노출.
mcpRoutes.post('/', async (c) => {
    const auth = await tryAuthenticateBearer(c);
    if (auth instanceof Response) return auth;

    if (!auth.user && c.env.WIKI_VISIBILITY === 'closed') {
        return unauthorized(c, 'Authentication required for closed wiki');
    }

    const body = await c.req.json();
    const response = await handleJsonRpc(c, body, auth.user);
    if (response === null) return c.body(null, 204);
    return c.json(response);
});

// 과거 /api/mcp/full 엔드포인트(lite/full 분리 시기 잔재) 는 통합 폐기. 통합 metadata 의
// resource 가 /api/mcp 로만 매칭되므로 /full 별칭을 두면 RFC 9728 정합성이 깨진다 — 클라이언트는
// /api/mcp 로 재설정해야 한다.

export default mcpRoutes;
