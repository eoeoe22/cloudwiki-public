// 관리자 전용 MCP 도구 정의 + 디스패처.
//
// 통합 MCP 엔드포인트 (/api/mcp) 가 호출 시점에 사용자 역할을 보고 이 모듈의 도구를
// 일반 사용자 도구 위에 추가로 노출한다. 별도 라우트(/api/admin-mcp) 를 직접 등록하지 않으며,
// 본 파일은 도구 정의와 디스패처만 export 한다.
//
// 노출 도구:
//   - 읽기: 어드민 전용 읽기 (list_deleted_pages, read_revision, list_drafts, read_draft)
//   - 편집(draft 모델): create_or_update_page, patch_page, edit_section
//          → commit_edit / discard_edit 로 마무리. 도중 단계는 새 리비전을 만들지 않고
//          mcp_drafts 테이블에 사용자별로 누적된다 (같은 슬러그에 대해 1개).
//          commit_edit 가 base_revision_id 와 현재 last_revision_id 를 비교해 충돌 감지.
//          draft 는 마지막 활동 이후 12시간이 지나면 자정 크론이 일괄 삭제.
//   - 편집(즉시 적용): delete_page, restore_page, move_page, revert_page
//
// 편집 도구는 wiki.ts 의 PUT /w/:slug, DELETE /w/:slug, POST /w/:slug/restore,
// POST /w/:slug/move 와 동일한 동작을 수행한다 — 동일한 헬퍼(buildLinkAndCategoryStatements,
// invalidatePageCache 등)를 재사용해 FTS 트리거, 역링크 인덱스, 캐시 무효화가 일관되게
// 적용되도록 한다.
import { Context } from 'hono';
import type { Env, User } from '../types';
import { RBAC } from '../utils/role';
import { uploadRevisionToR2, getRevisionContent } from '../utils/r2';
import { replaceSection } from '../utils/aiParser';
import { isR2OnlyNamespace } from '../utils/slug';
import { normalizeSlug } from '../utils/slug';
import {
    type McpToolDef,
    type ToolResult,
} from '../utils/mcpDispatch';
import {
    SLUG_FORBIDDEN_CHARS,
    computePageMetrics,
    buildLinkAndCategoryStatements,
    rewriteContentForRename,
    invalidatePageCache,
    refreshRecentChangesCache,
    invalidateBacklinkCaches,
} from './wiki';

// ────────────────────────────────────────────────────────────────
// 어드민 전용 읽기 도구 (일반 사용자 MCP 에는 노출하지 않음)
// ────────────────────────────────────────────────────────────────

export const ADMIN_READ_ONLY_TOOL_DEFS: McpToolDef[] = [
    {
        name: 'list_deleted_pages',
        description: '소프트 삭제된 문서 목록을 최신 삭제순으로 반환합니다. restore_page 와 함께 사용하세요. 응답에는 슬러그, 삭제 시각(deleted_at, ISO 8601), 마지막 편집자(last_editor), 마지막 편집 요약(last_summary) 이 포함됩니다.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'number', description: '반환할 최대 개수 (기본 20, 최대 100)' },
                since: { type: 'string', description: '이 시점 이후에 삭제된 문서만 (ISO 8601)' }
            },
            required: []
        }
    },
    {
        name: 'read_revision',
        description: '특정 리비전의 본문을 읽어옵니다. revision_id 는 get_recent_changes 응답에 포함된 정수 id 이며, title 은 그 리비전이 속한 문서 슬러그입니다. raw=true 로 설정하면 위키 문법 변환을 건너뜁니다 (기본은 위키 문법 그대로 반환). 응답에는 본문, 작성자, 생성 시각이 포함됩니다.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: '리비전이 속한 문서 슬러그' },
                revision_id: { type: 'number', description: '리비전 id (정수)' }
            },
            required: ['title', 'revision_id']
        }
    },
    {
        name: 'list_drafts',
        description: '본인이 보유한 진행 중 draft 목록을 반환합니다. 각 항목에는 draft_id, slug, action(create/update), base_revision_id, base_version, content_length, updated_at(ISO 8601) 이 포함됩니다. draft 는 마지막 활동 이후 12시간이 지나면 자동 삭제됩니다.',
        inputSchema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'read_draft',
        description: '진행 중 draft 의 전체 본문을 조회합니다. commit 직전 최종 확인 용도입니다. title 로 본인의 draft 를 찾아 반환합니다.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'draft 가 속한 문서 슬러그' }
            },
            required: ['title']
        }
    }
];

// ────────────────────────────────────────────────────────────────
// 어드민 편집 도구 정의
// ────────────────────────────────────────────────────────────────

export const ADMIN_EDIT_TOOL_DEFS: McpToolDef[] = [
    {
        name: 'create_or_update_page',
        description: '위키 문서 전체 본문을 새로 만들거나 통째로 교체할 draft 를 생성합니다. ⚠️ 즉시 저장하지 않고 draft 에 누적되며, 완료 후 commit_edit(draft_id, summary) 를 호출해야 새 리비전이 생성됩니다. 이미 본인의 draft 가 같은 슬러그로 있으면 그 draft 의 본문이 이 호출의 content 로 교체됩니다. create_only=true 면 페이지가 이미 존재할 때 오류를 반환합니다 (실수 덮어쓰기 방지).\n\n응답에 draft_id 가 포함되며, 이 id 로 read_draft / commit_edit / discard_edit 를 호출합니다. draft 는 마지막 활동 이후 12시간이 지나면 자동 삭제됩니다.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: '문서 슬러그(=제목)' },
                content: { type: 'string', description: '문서 전체 본문 (마크다운/위키 문법)' },
                category: { type: 'string', description: '쉼표로 구분된 카테고리 (선택, 한글/영숫자/공백/쉼표만 허용)' },
                is_locked: { type: 'boolean', description: '관리자 전용 잠금 여부 (선택)' },
                redirect_to: { type: 'string', description: '리다이렉트 대상 슬러그 (선택)' },
                create_only: { type: 'boolean', description: 'true 시 슬러그가 이미 존재하면 오류 반환 (기본 false)' }
            },
            required: ['title', 'content']
        }
    },
    {
        name: 'patch_page',
        description: '문서의 특정 텍스트를 찾아 교체하는 부분 편집입니다 (Claude Code Edit 도구와 같은 방식). ⚠️ 즉시 저장하지 않고 draft 에 누적되며, commit_edit 호출 시 비로소 새 리비전이 생성됩니다. 같은 슬러그로 이미 본인 draft 가 있으면 그 draft 의 본문에 대해 치환을 수행합니다 (없으면 페이지 현재 본문을 자동 스냅샷해 draft 시작). old_string 은 대상 본문(=draft 또는 페이지 현재 본문)에서 정확히 한 번만 등장해야 하며, 겹치는 매치 포함 2회 이상이면 오류입니다 — 앞뒤 맥락을 더 포함해 고유하게 만드세요. new_string 이 빈 문자열이면 해당 부분이 삭제됩니다.\n\n응답에 draft_id 가 포함됩니다. 섹션 단위는 edit_section, 전체 본문 교체는 create_or_update_page 를 사용하세요.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: '편집할 문서 슬러그' },
                old_string: { type: 'string', description: '대상 본문에서 찾을 기존 텍스트 (유일해야 함)' },
                new_string: { type: 'string', description: 'old_string 을 대체할 새 텍스트 (빈 문자열이면 해당 부분 삭제)' }
            },
            required: ['title', 'old_string', 'new_string']
        }
    },
    {
        name: 'edit_section',
        description: '문서의 특정 섹션 본문을 새 내용으로 통째로 교체합니다. ⚠️ 즉시 저장하지 않고 draft 에 누적되며, commit_edit 호출 시 비로소 새 리비전이 생성됩니다. 같은 슬러그로 이미 본인 draft 가 있으면 draft 본문에 대해 섹션 치환을 수행합니다 (없으면 페이지 현재 본문을 자동 스냅샷). section_number 는 get_toc(raw=true) 또는 read_draft 의 본문에서 산출한 원본 기준 번호("1", "1.1", "0" 등) 입니다. new_content 는 read_section(raw=true) 으로 받은 형식 그대로(헤딩 라인 포함) 보내는 것을 권장합니다. 교체 범위는 지정 헤딩부터 같은 레벨 이상의 다음 헤딩 직전까지입니다 ("0" 은 첫 헤딩 이전 도입부).\n\n응답에 draft_id 가 포함됩니다.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: '편집할 문서 슬러그' },
                section_number: { type: 'string', description: 'get_toc(raw=true) 가 반환한 섹션 번호 (예: "1", "1.1", "0")' },
                new_content: { type: 'string', description: '해당 섹션을 대체할 새 본문 (헤딩 라인 포함 권장)' }
            },
            required: ['title', 'section_number', 'new_content']
        }
    },
    {
        name: 'commit_edit',
        description: 'draft 에 누적된 편집을 1개 리비전으로 커밋합니다. base_revision_id 가 그 사이 변경되었으면(=다른 사용자가 페이지를 수정) 거부합니다 — 그 경우 discard_edit 후 read_document 로 최신 상태를 다시 읽고 편집을 재구성해야 합니다. 신규 페이지 draft 인데 commit 시점에 이미 같은 슬러그가 존재하면 같은 사유로 거부합니다. summary 는 새 리비전의 편집 요약입니다 (선택, 최대 255자). 저장 시 자동으로 [MCP] 접두가 붙어 사람 편집과 구분됩니다.',
        inputSchema: {
            type: 'object',
            properties: {
                draft_id: { type: 'number', description: '커밋할 draft 의 id (편집 도구 응답에서 받은 값)' },
                summary: { type: 'string', description: '편집 요약 (선택, 최대 255자, 저장 시 [MCP] 접두 자동 부여)' }
            },
            required: ['draft_id']
        }
    },
    {
        name: 'discard_edit',
        description: 'draft 를 폐기합니다. 누적된 편집은 모두 사라지며 페이지에는 어떤 영향도 없습니다.',
        inputSchema: {
            type: 'object',
            properties: {
                draft_id: { type: 'number', description: '폐기할 draft 의 id' }
            },
            required: ['draft_id']
        }
    },
    {
        name: 'delete_page',
        description: '위키 문서를 삭제합니다 (즉시 적용 — draft 모델 미사용). 기본은 소프트 삭제(deleted_at 설정)로, restore_page 로 복원 가능합니다. hard=true 일 때만 D1/R2 에서 영구 삭제하며, 이 경우 최고 관리자(super_admin) 권한이 필요합니다.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: '삭제할 문서 슬러그' },
                hard: { type: 'boolean', description: 'true 시 영구 삭제 (super_admin 만 가능)' }
            },
            required: ['title']
        }
    },
    {
        name: 'restore_page',
        description: '소프트 삭제된 문서를 복원합니다 (즉시 적용 — draft 모델 미사용).',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: '복원할 문서 슬러그' }
            },
            required: ['title']
        }
    },
    {
        name: 'revert_page',
        description: '문서를 특정 과거 리비전으로 되돌립니다 (즉시 적용 — draft 모델 미사용). revision_id 는 read_revision 또는 get_recent_changes 응답에서 얻은 정수 id 입니다. 되돌리기는 새 리비전을 만들어 원래 본문 그대로 다시 저장하는 방식이며, 과거 리비전 자체를 삭제하지 않습니다.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: '되돌릴 대상 문서 슬러그' },
                revision_id: { type: 'number', description: '되돌릴 기준 리비전 id (정수)' },
                summary: { type: 'string', description: '편집 요약 (선택, 기본 "reverted to revision #N", 저장 시 [MCP] 접두 자동 부여)' }
            },
            required: ['title', 'revision_id']
        }
    },
    {
        name: 'move_page',
        description: '문서 슬러그를 변경합니다 (이동, 즉시 적용 — draft 모델 미사용). 이 문서가 가진 위키링크/틀 참조는 새 슬러그 기준으로 재작성되며, 새 리비전이 추가됩니다. update_backlinks=true (기본) 면 이 문서를 가리키던 다른 문서들의 본문도 일괄 재작성됩니다 (각 문서마다 새 리비전 생성). 백링크가 매우 많은 경우 성능상 이유로 끄려면 false 를 명시하세요.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: '현재 문서 슬러그' },
                new_title: { type: 'string', description: '새 문서 슬러그' },
                update_backlinks: { type: 'boolean', description: '역링크 문서 본문도 함께 재작성할지 (선택, 기본 true — 이동 시 백링크 자동 갱신. 끄려면 false 명시)' }
            },
            required: ['title', 'new_title']
        }
    }
];

// ────────────────────────────────────────────────────────────────
// 편집 도구 디스패처
// ────────────────────────────────────────────────────────────────

function asTextResult(text: string, isError = false): ToolResult {
    return { content: [{ type: 'text', text }], isError };
}

// MCP 경로에서 만들어지는 모든 리비전 summary 에 [MCP] 접두를 보장한다.
// 편집 자체는 OAuth 로 인증된 사용자(에이전트가 연결된 계정) 의 작업으로 기록되며,
// 이 접두만 추가해 사람이 직접 편집한 리비전과 구분할 수 있게 한다.
// 사용자가 직접 [MCP] 로 시작하는 summary 를 넘기면 중복 접두를 만들지 않는다.
const MCP_SUMMARY_PREFIX = '[MCP]';
const MCP_SUMMARY_MAX_LENGTH = 255;
function withMcpPrefix(summary: string | null | undefined): string {
    const trimmed = (summary ?? '').trim();
    if (!trimmed) return MCP_SUMMARY_PREFIX;
    if (trimmed.startsWith(MCP_SUMMARY_PREFIX)) return trimmed;
    return `${MCP_SUMMARY_PREFIX} ${trimmed}`;
}
// 입력 summary 가 [MCP] 접두 부여 후에도 255자 한도(MCP_SUMMARY_MAX_LENGTH) 를 넘지 않는지 검증.
// 도구 스키마/문서가 명시한 contract 가 무너지지 않도록 raw 입력이 아니라 저장될 최종 문자열을 기준으로 한다.
function validateMcpSummaryLength(summary: string | null | undefined): string | null {
    const finalLength = withMcpPrefix(summary).length;
    if (finalLength > MCP_SUMMARY_MAX_LENGTH) {
        return `Error: summary 는 [MCP] 접두 포함 최대 ${MCP_SUMMARY_MAX_LENGTH}자입니다 (현재 ${finalLength}자).`;
    }
    return null;
}

function unixToIso(unix: number | null | undefined): string | null {
    if (unix === null || unix === undefined || !Number.isFinite(unix)) return null;
    return new Date(unix * 1000).toISOString();
}

// 어드민 전용 읽기 도구 디스패처. 공개 MCP 에는 노출되지 않으므로 mcpDispatch.ts 가 아닌
// 여기에 둔다. user 가 필요한 도구(list_drafts, read_draft) 는 별도 시그니처를 받는다.
export async function dispatchAdminReadTool(c: Context<Env>, user: User, toolName: string, args: any): Promise<ToolResult | null> {
    const db = c.env.DB;

    if (toolName === 'list_drafts') {
        const { results } = await db.prepare(`
            SELECT id, slug, action, base_revision_id, base_version,
                   length(content) AS content_length, updated_at
            FROM mcp_drafts WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100
        `).bind(user.id).all<{
            id: number; slug: string; action: string; base_revision_id: number | null;
            base_version: number; content_length: number; updated_at: number;
        }>();
        const formatted = results.map(r => ({
            draft_id: r.id,
            slug: r.slug,
            action: r.action,
            base_revision_id: r.base_revision_id,
            base_version: r.base_version,
            content_length: r.content_length,
            updated_at: unixToIso(r.updated_at),
        }));
        return asTextResult(JSON.stringify(formatted, null, 2));
    }

    if (toolName === 'read_draft') {
        const slug = String(args.title || '').trim();
        if (!slug) return asTextResult('Error: title 이 필요합니다.', true);
        const draft = await db.prepare(`
            SELECT id, slug, action, base_revision_id, base_version, content,
                   category, redirect_to, requested_lock, updated_at
            FROM mcp_drafts WHERE user_id = ? AND slug = ?
        `).bind(user.id, slug).first<{
            id: number; slug: string; action: string; base_revision_id: number | null;
            base_version: number; content: string; category: string | null;
            redirect_to: string | null; requested_lock: number | null; updated_at: number;
        }>();
        if (!draft) return asTextResult('Error: 해당 슬러그의 draft 를 찾을 수 없습니다.', true);
        return asTextResult(JSON.stringify({
            draft_id: draft.id,
            slug: draft.slug,
            action: draft.action,
            base_revision_id: draft.base_revision_id,
            base_version: draft.base_version,
            category: draft.category,
            redirect_to: draft.redirect_to,
            requested_lock: draft.requested_lock,
            updated_at: unixToIso(draft.updated_at),
            content: draft.content,
        }, null, 2));
    }

    if (toolName === 'list_deleted_pages') {
        const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
        const wheres: string[] = ['p.deleted_at IS NOT NULL'];
        const binds: any[] = [];
        if (args.since && typeof args.since === 'string') {
            const parsed = Date.parse(args.since);
            if (Number.isNaN(parsed)) {
                return asTextResult(`Error: since 가 유효한 ISO 8601 날짜가 아닙니다: ${args.since}`, true);
            }
            wheres.push('p.deleted_at >= ?');
            binds.push(Math.floor(parsed / 1000));
        }
        binds.push(limit);
        const sql = `
            SELECT p.slug, p.deleted_at, p.last_revision_id,
                   u.name AS last_editor, r.summary AS last_summary
            FROM pages p
            LEFT JOIN revisions r ON p.last_revision_id = r.id
            LEFT JOIN users u ON r.author_id = u.id
            WHERE ${wheres.join(' AND ')}
            ORDER BY p.deleted_at DESC LIMIT ?
        `;
        const { results } = await db.prepare(sql).bind(...binds).all<{
            slug: string; deleted_at: number | null; last_revision_id: number | null;
            last_editor: string | null; last_summary: string | null;
        }>();
        const formatted = results.map(r => ({
            slug: r.slug,
            deleted_at: unixToIso(r.deleted_at),
            last_editor: r.last_editor,
            last_summary: r.last_summary,
            last_revision_id: r.last_revision_id,
        }));
        return asTextResult(JSON.stringify(formatted, null, 2));
    }

    if (toolName === 'read_revision') {
        const slug = normalizeSlug(args.title || '');
        const revisionId = Number(args.revision_id);
        if (!slug) return asTextResult('Error: title 이 필요합니다.', true);
        if (!Number.isFinite(revisionId) || revisionId <= 0) {
            return asTextResult('Error: revision_id 는 양의 정수여야 합니다.', true);
        }
        const page = await db.prepare('SELECT id, slug FROM pages WHERE slug = ?').bind(slug).first<{ id: number; slug: string }>();
        if (!page) return asTextResult('Error: 문서를 찾을 수 없습니다.', true);

        const rev = await db.prepare(`
            SELECT r.id, r.page_id, r.page_version, r.content, r.r2_key, r.summary, r.created_at,
                   u.name AS author_name
            FROM revisions r
            LEFT JOIN users u ON r.author_id = u.id
            WHERE r.id = ?
        `).bind(revisionId).first<{
            id: number; page_id: number; page_version: number | null;
            content: string; r2_key: string | null; summary: string | null;
            created_at: number; author_name: string | null;
        }>();
        if (!rev) return asTextResult('Error: 리비전을 찾을 수 없습니다.', true);
        if (rev.page_id !== page.id) {
            return asTextResult('Error: 지정한 리비전이 이 문서의 것이 아닙니다.', true);
        }
        const origin = new URL(c.req.url).origin;
        const content = await getRevisionContent(c.env.MEDIA, { content: rev.content, r2_key: rev.r2_key }, origin);
        const payload = {
            revision_id: rev.id,
            slug: page.slug,
            page_version: rev.page_version,
            author_name: rev.author_name,
            summary: rev.summary,
            created_at: unixToIso(rev.created_at),
            content,
        };
        return asTextResult(JSON.stringify(payload, null, 2));
    }

    return null;
}

// 기존 문서를 새 리비전으로 갱신하는 공용 헬퍼.
// create_or_update_page 의 update 경로, patch_page, revert_page 가 공유한다.
// 호출자는 페이지 존재/잠금/슬러그 검증을 이미 마쳤다고 가정한다.
async function applyExistingPageUpdate(
    c: Context<Env>,
    user: User,
    page: { id: number; version: number; is_locked: number; category: string | null },
    content: string,
    opts: {
        summary: string | null;
        category?: string | null;     // undefined → 기존 유지, null/string → 덮어쓰기
        redirectTo?: string | null;   // undefined → 기존 유지, null/string → 덮어쓰기
        finalIsLocked: number;
        slug: string;
        logType: string;              // admin_log type (예: page_update / page_patch / page_revert)
        logMessage: string;
    }
): Promise<{ revision_id: number; new_version: number; rows: number; characters: number }> {
    const db = c.env.DB;
    const enabledExt = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
    const isR2Only = isR2OnlyNamespace(opts.slug, enabledExt);
    const metrics = computePageMetrics(content);
    const newVersion = page.version + 1;

    const r2Key = await uploadRevisionToR2(c.env.MEDIA, page.id, newVersion, content);
    let revisionId: number;
    try {
        const revResult = await db
            .prepare('INSERT INTO revisions (page_id, page_version, content, r2_key, summary, author_id) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(page.id, newVersion, '', r2Key, withMcpPrefix(opts.summary), user.id)
            .run();
        revisionId = revResult.meta.last_row_id;
    } catch (e) {
        await c.env.MEDIA.delete(r2Key).catch(() => {});
        throw e;
    }

    const contentToStore = isR2Only ? '' : content;
    const categoryValue = opts.category === undefined ? page.category : opts.category;
    // 옵티미스틱 락(CAS): 호출자가 SELECT 한 시점의 version 과 일치할 때만 UPDATE.
    // 이 사이 다른 커밋이 들어와 version 이 올라갔으면 0행 변경되며, 우리는 막 만든
    // revision 과 R2 객체를 정리하고 CONCURRENT_MODIFICATION 으로 던진다 — 호출자가
    // 충돌 응답으로 변환한다. wiki.ts 의 PUT /w/:slug 도 동일하게 version-CAS 를 사용.
    let updResult: D1Result;
    if (opts.redirectTo === undefined) {
        updResult = await db
            .prepare(
                `UPDATE pages
                 SET content = ?, category = ?, is_locked = ?, last_revision_id = ?,
                     version = ?, rows = ?, characters = ?, updated_at = unixepoch()
                 WHERE id = ? AND version = ?`
            )
            .bind(contentToStore, categoryValue, opts.finalIsLocked, revisionId, newVersion, metrics.rows, metrics.characters, page.id, page.version)
            .run();
    } else {
        updResult = await db
            .prepare(
                `UPDATE pages
                 SET content = ?, category = ?, is_locked = ?, redirect_to = ?, last_revision_id = ?,
                     version = ?, rows = ?, characters = ?, updated_at = unixepoch()
                 WHERE id = ? AND version = ?`
            )
            .bind(contentToStore, categoryValue, opts.finalIsLocked, opts.redirectTo, revisionId, newVersion, metrics.rows, metrics.characters, page.id, page.version)
            .run();
    }
    if (!updResult.meta.changes) {
        // 동시 수정으로 CAS 실패 — 막 만든 리비전과 R2 객체를 청소.
        await db.prepare('DELETE FROM revisions WHERE id = ?').bind(revisionId).run().catch(() => {});
        await c.env.MEDIA.delete(r2Key).catch(() => {});
        const err: any = new Error('CONCURRENT_MODIFICATION');
        err.code = 'CONCURRENT_MODIFICATION';
        throw err;
    }

    const linkCatStmts = buildLinkAndCategoryStatements(c.env.DB, page.id, content, categoryValue ?? null);
    c.executionCtx.waitUntil(c.env.DB.batch(linkCatStmts).catch(e => console.error('admin-mcp link/cat batch failed:', e)));
    c.executionCtx.waitUntil(Promise.allSettled([
        invalidatePageCache(c, opts.slug),
        refreshRecentChangesCache(c),
        invalidateBacklinkCaches(c, opts.slug, c.env.DB),
    ]));
    c.executionCtx.waitUntil(
        c.env.DB.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
            .bind(opts.logType, opts.logMessage, user.id)
            .run().catch((e: any) => console.error('admin-mcp admin_log write failed:', e))
    );

    return { revision_id: revisionId, new_version: newVersion, rows: metrics.rows, characters: metrics.characters };
}

// 신규 페이지를 INSERT 하고 첫 리비전을 생성하는 공용 헬퍼.
// commit_edit (action='create') 가 사용한다. 호출자는 슬러그 충돌(soft-deleted 포함) 검사를
// 이미 마쳤다고 가정한다.
async function applyNewPageInsert(
    c: Context<Env>,
    user: User,
    slug: string,
    content: string,
    opts: {
        summary: string | null;
        category: string | null;
        redirectTo: string | null;
        finalIsLocked: number;
        logType: string;
        logMessage: string;
    }
): Promise<{ page_id: number; revision_id: number; rows: number; characters: number }> {
    const db = c.env.DB;
    const enabledExt = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
    const isR2Only = isR2OnlyNamespace(slug, enabledExt);
    const metrics = computePageMetrics(content);
    const contentToStore = isR2Only ? '' : content;

    const pageResult = await db
        .prepare('INSERT INTO pages (slug, content, category, is_locked, redirect_to, rows, characters) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(slug, contentToStore, opts.category, opts.finalIsLocked, opts.redirectTo, metrics.rows, metrics.characters)
        .run();
    const pageId = pageResult.meta.last_row_id;

    let firstR2Key: string;
    try {
        firstR2Key = await uploadRevisionToR2(c.env.MEDIA, pageId, 1, content);
    } catch (e) {
        await db.prepare('DELETE FROM pages WHERE id = ?').bind(pageId).run().catch(() => {});
        throw e;
    }
    let revisionId: number;
    try {
        const revResult = await db
            .prepare('INSERT INTO revisions (page_id, page_version, content, r2_key, summary, author_id) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(pageId, 1, '', firstR2Key, withMcpPrefix(opts.summary), user.id)
            .run();
        revisionId = revResult.meta.last_row_id;
    } catch (e) {
        await c.env.MEDIA.delete(firstR2Key).catch(() => {});
        await db.prepare('DELETE FROM pages WHERE id = ?').bind(pageId).run().catch(() => {});
        throw e;
    }
    await db.prepare('UPDATE pages SET last_revision_id = ? WHERE id = ?').bind(revisionId, pageId).run();

    const linkCatStmts = buildLinkAndCategoryStatements(db, pageId, content, opts.category);
    c.executionCtx.waitUntil(db.batch(linkCatStmts).catch(e => console.error('admin-mcp link/cat batch failed:', e)));
    c.executionCtx.waitUntil(Promise.allSettled([
        invalidatePageCache(c, slug),
        refreshRecentChangesCache(c),
        invalidateBacklinkCaches(c, slug, db),
    ]));
    c.executionCtx.waitUntil(
        db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
            .bind(opts.logType, opts.logMessage, user.id)
            .run().catch((e: any) => console.error('admin-mcp admin_log write failed:', e))
    );

    return { page_id: pageId, revision_id: revisionId, rows: metrics.rows, characters: metrics.characters };
}

// 새로 발급된 draft 응답에 포함하는 라이프사이클 가이드.
// 같은 draft 가 이어서 갱신될 때는 더 짧은 안내(DRAFT_UPDATE_NOTE)만 보낸다.
const DRAFT_FIRST_ISSUE_NOTE =
    'draft 가 발급되었습니다. 사용법:\n' +
    '  1) 이어서 같은 title 로 patch_page / edit_section / create_or_update_page 를 호출하면 이 draft 에 누적됩니다 (사용자×슬러그당 1개).\n' +
    '  2) read_draft(title) 로 진행 중 본문 확인.\n' +
    '  3) 편집이 끝나면 commit_edit(draft_id, summary) 로 1개 리비전을 만들어 저장하세요.\n' +
    '  4) 폐기하려면 discard_edit(draft_id).\n' +
    '  5) 마지막 활동 이후 12시간이 지나면 자정 크론이 자동 삭제합니다.\n' +
    '  6) commit 시점에 base_revision_id 가 변하면(=다른 사용자가 페이지 수정) conflict 로 거부됩니다 — discard 후 read_document 로 최신을 다시 읽어 재구성하세요.';

const DRAFT_UPDATE_NOTE =
    'draft 가 갱신되었습니다. commit_edit(draft_id, summary) 로 저장하거나 discard_edit(draft_id) 로 폐기하세요.';

// (user_id, slug) 의 draft 를 조회하고, 없으면 페이지에서 현재 본문을 스냅샷해 새 draft 를 생성한다.
// 호출자는 slug 가 admin-mcp 로 편집 가능한지(이미지: 네임스페이스 거부 등)를 이미 확인했다고 가정한다.
async function loadDraftOrSeedFromPage(
    c: Context<Env>,
    user: User,
    slug: string
): Promise<{
    type: 'draft' | 'seeded' | 'not_found';
    draftId?: number;
    content: string;
    page?: { id: number; version: number; is_locked: number; last_revision_id: number | null; category: string | null; redirect_to: string | null };
}> {
    const db = c.env.DB;
    // action 무관하게 본인의 (slug) draft 가 있으면 그 위에서 편집을 누적한다.
    // create 액션 draft (= 아직 commit 되지 않은 신규 페이지) 도 patch_page / edit_section
    // 으로 점진적으로 다듬을 수 있어야 한다.
    const draft = await db.prepare(
        'SELECT id, content FROM mcp_drafts WHERE user_id = ? AND slug = ?'
    ).bind(user.id, slug).first<{ id: number; content: string }>();
    if (draft) {
        return { type: 'draft', draftId: draft.id, content: draft.content };
    }

    const page = await db.prepare(
        'SELECT id, version, is_locked, content, last_revision_id, category, redirect_to FROM pages WHERE slug = ? AND deleted_at IS NULL'
    ).bind(slug).first<{
        id: number; version: number; is_locked: number; content: string;
        last_revision_id: number | null; category: string | null; redirect_to: string | null;
    }>();
    if (!page) return { type: 'not_found', content: '' };

    const enabledExt = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
    const isR2Only = isR2OnlyNamespace(slug, enabledExt);
    let body = page.content;
    if (isR2Only && (!body || body === '') && page.last_revision_id) {
        const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(page.last_revision_id).first<{ content: string; r2_key: string | null }>();
        if (lastRev) body = await getRevisionContent(c.env.MEDIA, lastRev, new URL(c.req.url).origin);
    }
    return {
        type: 'seeded',
        content: body.replace(/\r\n?/g, '\n'),
        page: { id: page.id, version: page.version, is_locked: page.is_locked, last_revision_id: page.last_revision_id, category: page.category, redirect_to: page.redirect_to },
    };
}

export async function dispatchAdminEditTool(c: Context<Env>, user: User, toolName: string, args: any): Promise<ToolResult | null> {
    const db = c.env.DB;
    const rbac = c.get('rbac') as RBAC;

    if (toolName === 'create_or_update_page') {
        // 위임 admin 역할이 wiki:edit 없이 admin:access 만 가진 케이스에서도
        // wiki PUT /w/:slug 와 동일하게 wiki:edit 권한을 요구한다 (기본 역할에서는 admin
        // 이 user 를 상속하므로 자동으로 통과되지만, ROLE_PERMISSIONS_JSON 으로 권한이
        // 분리된 환경에서 우회를 막는다). 비록 draft 단계라도 같은 정책 유지.
        if (!rbac.can(user.role, 'wiki:edit')) {
            return asTextResult('Error: wiki:edit 권한이 필요합니다.', true);
        }
        const slug = String(args.title || '').trim();
        if (!slug) return asTextResult('Error: title 이 필요합니다.', true);
        if (SLUG_FORBIDDEN_CHARS.test(slug)) return asTextResult('Error: 슬러그에 사용할 수 없는 특수문자가 포함되어 있습니다.', true);
        if (slug.startsWith('이미지:')) return asTextResult('Error: "이미지:" 네임스페이스는 admin-mcp 로 편집할 수 없습니다 (이미지 문서 전용).', true);
        if (typeof args.content !== 'string') return asTextResult('Error: content 는 문자열이어야 합니다.', true);
        if (args.category && typeof args.category === 'string') {
            if (!/^[가-힣a-zA-Z0-9\s,]+$/.test(args.category)) {
                return asTextResult('Error: category 에는 특수문자를 사용할 수 없습니다.', true);
            }
        }

        const content = args.content.replace(/\r\n?/g, '\n');
        const category = (args.category && typeof args.category === 'string') ? args.category : null;
        const redirectTo = (args.redirect_to && typeof args.redirect_to === 'string') ? args.redirect_to : null;
        const requestedLock = typeof args.is_locked === 'boolean' ? (args.is_locked ? 1 : 0) : null;
        const createOnly = args.create_only === true;

        const existing = await db
            .prepare('SELECT id, version, is_locked, last_revision_id, category FROM pages WHERE slug = ? AND deleted_at IS NULL')
            .bind(slug)
            .first<{ id: number; version: number; is_locked: number; last_revision_id: number | null; category: string | null }>();

        if (existing && createOnly) {
            return asTextResult('Error: 이미 존재하는 문서입니다. 수정하려면 create_only 를 false 로 설정하거나 patch_page 를 사용하세요.', true);
        }
        // create 경로 (페이지 미존재) 에서 소프트 삭제된 동일 슬러그가 있으면 commit 시점에
        // INSERT 가 SQLite UNIQUE 제약으로 실패한다. draft 시작 단계에서 미리 감지해
        // restore/hard 삭제 안내.
        if (!existing) {
            const deletedConflict = await db
                .prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NOT NULL')
                .bind(slug)
                .first<{ id: number }>();
            if (deletedConflict) {
                return asTextResult(
                    'Error: 동일 슬러그의 소프트 삭제된 문서가 존재합니다. ' +
                    'restore_page 로 복원해서 편집하거나 delete_page (hard=true) 로 영구 삭제 후 다시 생성하세요.',
                    true
                );
            }
        }
        // 잠긴 문서는 wiki:lock 권한자(=admin 이상)만 draft 를 만들 수 있다.
        if (existing && existing.is_locked === 1 && !rbac.can(user.role, 'wiki:lock')) {
            return asTextResult('Error: 잠긴 문서는 wiki:lock 권한이 있어야 편집할 수 있습니다.', true);
        }

        const action = existing ? 'update' : 'create';
        const baseRevisionId = existing ? existing.last_revision_id : null;
        const baseVersion = existing ? existing.version : 0;

        // 본인의 같은 슬러그 draft 가 이미 있으면 본문/메타데이터를 통째로 교체한다.
        // base_revision_id / base_version 은 보존 — 처음 begin 한 시점의 페이지 상태로 충돌
        // 검증을 해야 의미 있다. 이 호출이 page 가 그 사이 바뀌었는지를 다시 캡처하면
        // 충돌 감지가 무력화된다.
        const existingDraft = await db.prepare(
            'SELECT id, action, base_revision_id, base_version FROM mcp_drafts WHERE user_id = ? AND slug = ?'
        ).bind(user.id, slug).first<{ id: number; action: string; base_revision_id: number | null; base_version: number }>();

        let draftId: number;
        if (existingDraft) {
            await db.prepare(
                `UPDATE mcp_drafts
                 SET content = ?, category = ?, redirect_to = ?, requested_lock = ?, updated_at = unixepoch()
                 WHERE id = ?`
            ).bind(content, category, redirectTo, requestedLock, existingDraft.id).run();
            draftId = existingDraft.id;
        } else {
            const ins = await db.prepare(
                `INSERT INTO mcp_drafts (user_id, slug, action, base_revision_id, base_version, content, category, redirect_to, requested_lock)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(user.id, slug, action, baseRevisionId, baseVersion, content, category, redirectTo, requestedLock).run();
            draftId = ins.meta.last_row_id;
        }

        return asTextResult(JSON.stringify({
            draft_id: draftId,
            slug,
            action: existingDraft ? existingDraft.action : action,
            base_revision_id: existingDraft ? existingDraft.base_revision_id : baseRevisionId,
            base_version: existingDraft ? existingDraft.base_version : baseVersion,
            content_length: content.length,
            replaced_existing_draft: !!existingDraft,
            note: existingDraft ? DRAFT_UPDATE_NOTE : DRAFT_FIRST_ISSUE_NOTE,
        }, null, 2));
    }

    if (toolName === 'patch_page') {
        if (!rbac.can(user.role, 'wiki:edit')) {
            return asTextResult('Error: wiki:edit 권한이 필요합니다.', true);
        }
        const slug = String(args.title || '').trim();
        if (!slug) return asTextResult('Error: title 이 필요합니다.', true);
        if (slug.startsWith('이미지:')) return asTextResult('Error: "이미지:" 네임스페이스는 admin-mcp 로 편집할 수 없습니다.', true);
        if (typeof args.old_string !== 'string' || args.old_string.length === 0) {
            return asTextResult('Error: old_string 은 비어있지 않은 문자열이어야 합니다.', true);
        }
        if (typeof args.new_string !== 'string') {
            return asTextResult('Error: new_string 은 문자열이어야 합니다.', true);
        }

        const oldStr = (args.old_string as string).replace(/\r\n?/g, '\n');
        const newStr = (args.new_string as string).replace(/\r\n?/g, '\n');

        // draft 가 있으면 draft.content 위에서, 없으면 페이지 현재 본문을 LF 정규화한 뒤
        // 자동으로 새 draft 를 시작한다.
        const loaded = await loadDraftOrSeedFromPage(c, user, slug);
        if (loaded.type === 'not_found') {
            return asTextResult('Error: 문서를 찾을 수 없거나 삭제된 상태입니다. 새 페이지는 create_or_update_page 로 시작하세요.', true);
        }
        if (loaded.type === 'seeded' && loaded.page!.is_locked === 1 && !rbac.can(user.role, 'wiki:lock')) {
            return asTextResult('Error: 잠긴 문서는 wiki:lock 권한이 있어야 편집할 수 있습니다.', true);
        }
        const currentContent = loaded.content;

        // 등장 횟수 검사 — 겹치는 매치 포함 0회 또는 2회 이상이면 거부.
        let occurrences = 0;
        let searchFrom = 0;
        while (true) {
            const idx = currentContent.indexOf(oldStr, searchFrom);
            if (idx < 0) break;
            occurrences++;
            searchFrom = idx + 1;
            if (occurrences > 1) break;
        }
        if (occurrences === 0) {
            return asTextResult('Error: old_string 을 (draft 가 있으면 draft 본문, 없으면 페이지 본문) 에서 찾을 수 없습니다.', true);
        }
        if (occurrences > 1) {
            let total = 0;
            let from = 0;
            while (true) {
                const idx = currentContent.indexOf(oldStr, from);
                if (idx < 0) break;
                total++;
                from = idx + 1;
            }
            return asTextResult(
                `Error: old_string 이 본문 내에서 ${total}번 발견되었습니다 (겹치는 매치 포함). ` +
                `고유하게 특정할 수 있도록 앞뒤 맥락(앞/뒤 줄)을 더 포함해 주세요.`,
                true
            );
        }

        // 함수형 replacer 로 newStr 을 리터럴로 삽입한다. 두 번째 인자가 문자열이면 JS 가
        // $&, $1, $$, $`, $' 같은 시퀀스를 특수 토큰으로 해석하므로 셸 변수, 정규식 스니펫,
        // 템플릿 문법(${var}) 같은 합법 본문이 조용히 다른 내용으로 바뀔 수 있다.
        const newContent = currentContent.replace(oldStr, () => newStr);

        // 기존 draft 면 본문만 갱신, 없으면 INSERT 로 새 draft 생성.
        let draftId: number;
        let baseRevisionId: number | null;
        let baseVersion: number;
        if (loaded.type === 'draft') {
            await db.prepare('UPDATE mcp_drafts SET content = ?, updated_at = unixepoch() WHERE id = ?')
                .bind(newContent, loaded.draftId!).run();
            draftId = loaded.draftId!;
            const meta = await db.prepare('SELECT base_revision_id, base_version FROM mcp_drafts WHERE id = ?')
                .bind(draftId).first<{ base_revision_id: number | null; base_version: number }>();
            baseRevisionId = meta!.base_revision_id;
            baseVersion = meta!.base_version;
        } else {
            // type === 'seeded' — 페이지 메타로부터 draft seed
            const ins = await db.prepare(
                `INSERT INTO mcp_drafts (user_id, slug, action, base_revision_id, base_version, content, category, redirect_to, requested_lock)
                 VALUES (?, ?, 'update', ?, ?, ?, ?, ?, ?)`
            ).bind(
                user.id, slug, loaded.page!.last_revision_id, loaded.page!.version,
                newContent, loaded.page!.category, loaded.page!.redirect_to, null
            ).run();
            draftId = ins.meta.last_row_id;
            baseRevisionId = loaded.page!.last_revision_id;
            baseVersion = loaded.page!.version;
        }

        return asTextResult(JSON.stringify({
            draft_id: draftId,
            slug,
            replaced: 1,
            base_revision_id: baseRevisionId,
            base_version: baseVersion,
            content_length: newContent.length,
            note: loaded.type === 'seeded' ? DRAFT_FIRST_ISSUE_NOTE : DRAFT_UPDATE_NOTE,
        }, null, 2));
    }

    if (toolName === 'edit_section') {
        if (!rbac.can(user.role, 'wiki:edit')) {
            return asTextResult('Error: wiki:edit 권한이 필요합니다.', true);
        }
        const slug = String(args.title || '').trim();
        if (!slug) return asTextResult('Error: title 이 필요합니다.', true);
        if (slug.startsWith('이미지:')) return asTextResult('Error: "이미지:" 네임스페이스는 admin-mcp 로 편집할 수 없습니다.', true);
        const sectionNumber = String(args.section_number || '').trim();
        if (!sectionNumber) return asTextResult('Error: section_number 가 필요합니다.', true);
        if (typeof args.new_content !== 'string') {
            return asTextResult('Error: new_content 는 문자열이어야 합니다.', true);
        }

        const newSectionContent = (args.new_content as string).replace(/\r\n?/g, '\n');

        const loaded = await loadDraftOrSeedFromPage(c, user, slug);
        if (loaded.type === 'not_found') {
            return asTextResult('Error: 문서를 찾을 수 없거나 삭제된 상태입니다. 새 페이지는 create_or_update_page 로 시작하세요.', true);
        }
        if (loaded.type === 'seeded' && loaded.page!.is_locked === 1 && !rbac.can(user.role, 'wiki:lock')) {
            return asTextResult('Error: 잠긴 문서는 wiki:lock 권한이 있어야 편집할 수 있습니다.', true);
        }
        const currentContent = loaded.content;

        const newContent = replaceSection(currentContent, sectionNumber, newSectionContent);
        if (newContent === null) {
            return asTextResult(
                `Error: 섹션 번호 "${sectionNumber}" 를 본문에서 찾을 수 없습니다. ` +
                `read_draft 또는 get_toc(raw=true) 로 정확한 번호를 확인하세요.`,
                true
            );
        }
        if (newContent === currentContent) {
            return asTextResult('Error: 변경 사항이 없습니다 (new_content 가 기존 섹션과 동일).', true);
        }

        let draftId: number;
        let baseRevisionId: number | null;
        let baseVersion: number;
        if (loaded.type === 'draft') {
            await db.prepare('UPDATE mcp_drafts SET content = ?, updated_at = unixepoch() WHERE id = ?')
                .bind(newContent, loaded.draftId!).run();
            draftId = loaded.draftId!;
            const meta = await db.prepare('SELECT base_revision_id, base_version FROM mcp_drafts WHERE id = ?')
                .bind(draftId).first<{ base_revision_id: number | null; base_version: number }>();
            baseRevisionId = meta!.base_revision_id;
            baseVersion = meta!.base_version;
        } else {
            const ins = await db.prepare(
                `INSERT INTO mcp_drafts (user_id, slug, action, base_revision_id, base_version, content, category, redirect_to, requested_lock)
                 VALUES (?, ?, 'update', ?, ?, ?, ?, ?, ?)`
            ).bind(
                user.id, slug, loaded.page!.last_revision_id, loaded.page!.version,
                newContent, loaded.page!.category, loaded.page!.redirect_to, null
            ).run();
            draftId = ins.meta.last_row_id;
            baseRevisionId = loaded.page!.last_revision_id;
            baseVersion = loaded.page!.version;
        }

        return asTextResult(JSON.stringify({
            draft_id: draftId,
            slug,
            section_number: sectionNumber,
            base_revision_id: baseRevisionId,
            base_version: baseVersion,
            content_length: newContent.length,
            note: loaded.type === 'seeded' ? DRAFT_FIRST_ISSUE_NOTE : DRAFT_UPDATE_NOTE,
        }, null, 2));
    }

    if (toolName === 'commit_edit') {
        if (!rbac.can(user.role, 'wiki:edit')) {
            return asTextResult('Error: wiki:edit 권한이 필요합니다.', true);
        }
        const draftId = Number(args.draft_id);
        if (!Number.isFinite(draftId) || draftId <= 0) {
            return asTextResult('Error: draft_id 는 양의 정수여야 합니다.', true);
        }
        const summary = (typeof args.summary === 'string' && args.summary.length > 0) ? args.summary : null;
        const summaryLengthError = validateMcpSummaryLength(summary);
        if (summaryLengthError) {
            return asTextResult(summaryLengthError, true);
        }

        const draft = await db.prepare(
            `SELECT id, user_id, slug, action, base_revision_id, base_version,
                    content, category, redirect_to, requested_lock
             FROM mcp_drafts WHERE id = ?`
        ).bind(draftId).first<{
            id: number; user_id: number; slug: string; action: string;
            base_revision_id: number | null; base_version: number; content: string;
            category: string | null; redirect_to: string | null; requested_lock: number | null;
        }>();
        if (!draft) return asTextResult('Error: draft 를 찾을 수 없습니다 (이미 commit/discard 됐거나 12시간 TTL 만료).', true);
        if (draft.user_id !== user.id) return asTextResult('Error: 다른 사용자의 draft 는 commit 할 수 없습니다.', true);

        const slug = draft.slug;

        if (draft.action === 'update') {
            const page = await db.prepare(
                'SELECT id, version, is_locked, content, category, last_revision_id FROM pages WHERE slug = ? AND deleted_at IS NULL'
            ).bind(slug).first<{ id: number; version: number; is_locked: number; content: string; category: string | null; last_revision_id: number | null }>();
            if (!page) {
                return asTextResult(JSON.stringify({
                    error: 'conflict',
                    reason: 'page_missing',
                    message: '페이지가 존재하지 않거나 그 사이 삭제되었습니다. discard_edit 후 상태를 확인하세요.',
                }, null, 2), true);
            }
            if (page.last_revision_id !== draft.base_revision_id || page.version !== draft.base_version) {
                return asTextResult(JSON.stringify({
                    error: 'conflict',
                    reason: 'concurrent_modification',
                    message: 'draft 가 시작된 시점 이후 다른 사용자가 페이지를 수정했습니다. discard_edit 후 read_document 로 최신 상태를 다시 읽고 편집을 재구성하세요.',
                    base_revision_id: draft.base_revision_id,
                    base_version: draft.base_version,
                    current_revision_id: page.last_revision_id,
                    current_version: page.version,
                }, null, 2), true);
            }
            if (page.is_locked === 1 && !rbac.can(user.role, 'wiki:lock')) {
                return asTextResult('Error: 잠긴 문서는 wiki:lock 권한이 있어야 편집할 수 있습니다.', true);
            }

            const finalIsLocked = draft.requested_lock !== null
                ? (rbac.can(user.role, 'wiki:lock') ? draft.requested_lock : page.is_locked)
                : page.is_locked;

            try {
                const result = await applyExistingPageUpdate(c, user, page, draft.content, {
                    summary,
                    category: draft.category,
                    redirectTo: draft.redirect_to,
                    finalIsLocked,
                    slug,
                    logType: 'page_commit',
                    logMessage: `[admin-mcp] draft #${draft.id} commit: ${slug} (v${page.version + 1})`,
                });
                await db.prepare('DELETE FROM mcp_drafts WHERE id = ?').bind(draft.id).run();
                return asTextResult(JSON.stringify({
                    slug,
                    version: result.new_version,
                    revision_id: result.revision_id,
                    rows: result.rows,
                    characters: result.characters,
                    is_locked: finalIsLocked === 1,
                    draft_id: draft.id,
                }, null, 2));
            } catch (e: any) {
                // SELECT 직후 ~ UPDATE 사이의 race 로 CAS 가 실패한 경우. draft 는 보존해두므로
                // 재시도(또는 discard 후 새 draft 시작) 가 가능하다.
                if (e?.code === 'CONCURRENT_MODIFICATION') {
                    return asTextResult(JSON.stringify({
                        error: 'conflict',
                        reason: 'concurrent_modification',
                        message: 'commit 도중 다른 사용자가 페이지를 수정했습니다. discard_edit 후 read_document 로 최신 상태를 다시 읽고 편집을 재구성하세요.',
                        base_revision_id: draft.base_revision_id,
                        base_version: draft.base_version,
                    }, null, 2), true);
                }
                return asTextResult(`Error: 리비전 저장 실패 (${e?.message || e})`, true);
            }
        }

        if (draft.action === 'create') {
            const livePage = await db.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL').bind(slug).first();
            if (livePage) {
                return asTextResult(JSON.stringify({
                    error: 'conflict',
                    reason: 'slug_taken',
                    message: 'draft 가 시작된 시점 이후 다른 사용자가 같은 슬러그로 페이지를 생성했습니다. discard_edit 후 read_document 로 확인하세요.',
                }, null, 2), true);
            }
            const deletedConflict = await db.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NOT NULL').bind(slug).first();
            if (deletedConflict) {
                return asTextResult(
                    'Error: 동일 슬러그의 소프트 삭제된 문서가 존재합니다. ' +
                    'restore_page 로 복원해서 편집하거나 delete_page (hard=true) 후 다시 생성하세요.',
                    true
                );
            }

            const finalIsLocked = (draft.requested_lock !== null && rbac.can(user.role, 'wiki:lock'))
                ? draft.requested_lock : 0;

            try {
                const result = await applyNewPageInsert(c, user, slug, draft.content, {
                    summary,
                    category: draft.category,
                    redirectTo: draft.redirect_to,
                    finalIsLocked,
                    logType: 'page_create_commit',
                    logMessage: `[admin-mcp] draft #${draft.id} commit (create): ${slug} (v1)`,
                });
                await db.prepare('DELETE FROM mcp_drafts WHERE id = ?').bind(draft.id).run();
                return asTextResult(JSON.stringify({
                    slug,
                    version: 1,
                    revision_id: result.revision_id,
                    rows: result.rows,
                    characters: result.characters,
                    is_locked: finalIsLocked === 1,
                    created: true,
                    draft_id: draft.id,
                }, null, 2));
            } catch (e: any) {
                return asTextResult(`Error: 신규 페이지 저장 실패 (${e?.message || e})`, true);
            }
        }

        return asTextResult(`Error: 알 수 없는 draft action: ${draft.action}`, true);
    }

    if (toolName === 'discard_edit') {
        const draftId = Number(args.draft_id);
        if (!Number.isFinite(draftId) || draftId <= 0) {
            return asTextResult('Error: draft_id 는 양의 정수여야 합니다.', true);
        }
        const draft = await db.prepare('SELECT id, user_id, slug FROM mcp_drafts WHERE id = ?')
            .bind(draftId).first<{ id: number; user_id: number; slug: string }>();
        if (!draft) return asTextResult('Error: draft 를 찾을 수 없습니다 (이미 commit/discard 됐거나 TTL 만료).', true);
        if (draft.user_id !== user.id) return asTextResult('Error: 다른 사용자의 draft 는 discard 할 수 없습니다.', true);
        await db.prepare('DELETE FROM mcp_drafts WHERE id = ?').bind(draftId).run();
        return asTextResult(JSON.stringify({ draft_id: draftId, slug: draft.slug, discarded: true }, null, 2));
    }

    if (toolName === 'revert_page') {
        if (!rbac.can(user.role, 'wiki:edit')) {
            return asTextResult('Error: wiki:edit 권한이 필요합니다.', true);
        }
        const slug = String(args.title || '').trim();
        const revisionId = Number(args.revision_id);
        if (!slug) return asTextResult('Error: title 이 필요합니다.', true);
        if (!Number.isFinite(revisionId) || revisionId <= 0) {
            return asTextResult('Error: revision_id 는 양의 정수여야 합니다.', true);
        }

        const page = await db
            .prepare('SELECT id, version, is_locked, content, category FROM pages WHERE slug = ? AND deleted_at IS NULL')
            .bind(slug)
            .first<{ id: number; version: number; is_locked: number; content: string; category: string | null }>();
        if (!page) return asTextResult('Error: 문서를 찾을 수 없거나 삭제된 상태입니다.', true);
        if (page.is_locked === 1 && !rbac.can(user.role, 'wiki:lock')) {
            return asTextResult('Error: 잠긴 문서는 wiki:lock 권한이 있어야 되돌릴 수 있습니다.', true);
        }

        // 리비전이 정말로 이 페이지에 속하는지 검증 — 다른 페이지 리비전 id 를 입력해
        // 본문을 끌어오는 것을 막는다.
        const rev = await db
            .prepare('SELECT id, page_id, page_version, content, r2_key FROM revisions WHERE id = ?')
            .bind(revisionId)
            .first<{ id: number; page_id: number; page_version: number | null; content: string; r2_key: string | null }>();
        if (!rev) return asTextResult('Error: 리비전을 찾을 수 없습니다.', true);
        if (rev.page_id !== page.id) {
            return asTextResult('Error: 지정한 리비전이 이 문서의 것이 아닙니다.', true);
        }

        const origin = new URL(c.req.url).origin;
        // wiki.ts 의 POST /w/:slug/revert 와 동일하게 CRLF→LF 정규화 후 저장한다.
        // 레거시 리비전이 CRLF 로 남아 있을 수 있어 정규화하지 않으면 새 리비전에 혼합 라인엔딩이
        // 다시 들어가 다운스트림 파싱/편집이 어긋난다.
        const revContent = (await getRevisionContent(c.env.MEDIA, { content: rev.content, r2_key: rev.r2_key }, origin))
            .replace(/\r\n?/g, '\n');

        const summary = (typeof args.summary === 'string' && args.summary.length > 0)
            ? args.summary
            : `reverted to revision #${revisionId}`;
        const summaryLengthError = validateMcpSummaryLength(summary);
        if (summaryLengthError) return asTextResult(summaryLengthError, true);

        try {
            const result = await applyExistingPageUpdate(c, user, page, revContent, {
                summary,
                finalIsLocked: page.is_locked,
                slug,
                logType: 'page_revert',
                logMessage: `[admin-mcp] 문서 되돌리기: ${slug} → 리비전 #${revisionId} (v${page.version + 1})`,
            });
            return asTextResult(JSON.stringify({
                slug,
                version: result.new_version,
                revision_id: result.revision_id,
                reverted_to: revisionId,
                rows: result.rows,
                characters: result.characters,
            }, null, 2));
        } catch (e: any) {
            if (e?.code === 'CONCURRENT_MODIFICATION') {
                return asTextResult(JSON.stringify({
                    error: 'conflict',
                    reason: 'concurrent_modification',
                    message: 'revert 도중 다른 사용자가 페이지를 수정했습니다. 다시 시도하세요 (revert_page 는 호출 시점의 페이지 버전을 기준으로 CAS 적용).',
                }, null, 2), true);
            }
            return asTextResult(`Error: 리비전 저장 실패 (${e?.message || e})`, true);
        }
    }

    if (toolName === 'delete_page') {
        const slug = String(args.title || '').trim();
        if (!slug) return asTextResult('Error: title 이 필요합니다.', true);
        const hard = args.hard === true;

        const page = await db
            .prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL')
            .bind(slug)
            .first<{ id: number }>();
        if (!page) return asTextResult('Error: 문서를 찾을 수 없거나 이미 삭제된 상태입니다.', true);

        if (hard) {
            if (!rbac.can(user.role, '*')) return asTextResult('Error: 영구 삭제는 super_admin 만 가능합니다.', true);
            const revisionKeys = await db.prepare('SELECT r2_key FROM revisions WHERE page_id = ? AND r2_key IS NOT NULL').bind(page.id).all<{ r2_key: string }>();
            if (revisionKeys.results.length > 0) {
                await Promise.all(revisionKeys.results.map(r => c.env.MEDIA.delete(r.r2_key)));
            }
            await db.batch([
                db.prepare('DELETE FROM page_links WHERE source_page_id = ? AND blog = 0').bind(page.id),
                db.prepare('DELETE FROM page_categories WHERE page_id = ?').bind(page.id),
                db.prepare('DELETE FROM revisions WHERE page_id = ?').bind(page.id),
                db.prepare('DELETE FROM pages WHERE id = ?').bind(page.id),
            ]);
            c.executionCtx.waitUntil(
                db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                    .bind('hard_delete', `[admin-mcp] 문서 영구 삭제: ${slug}`, user.id)
                    .run().catch(() => {})
            );
        } else {
            if (!rbac.can(user.role, 'wiki:delete')) return asTextResult('Error: 문서 삭제 권한이 없습니다.', true);
            await db.prepare('UPDATE pages SET deleted_at = unixepoch() WHERE id = ?').bind(page.id).run();
            c.executionCtx.waitUntil(
                db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                    .bind('soft_delete', `[admin-mcp] 문서 삭제: ${slug}`, user.id)
                    .run().catch(() => {})
            );
        }
        c.executionCtx.waitUntil(Promise.allSettled([
            invalidatePageCache(c, slug),
            refreshRecentChangesCache(c),
            invalidateBacklinkCaches(c, slug, db),
        ]));
        return asTextResult(JSON.stringify({ slug, deleted: true, hard }, null, 2));
    }

    if (toolName === 'restore_page') {
        const slug = String(args.title || '').trim();
        if (!slug) return asTextResult('Error: title 이 필요합니다.', true);
        if (!rbac.can(user.role, 'wiki:delete')) return asTextResult('Error: 복원 권한이 없습니다.', true);

        const page = await db.prepare('SELECT id, deleted_at FROM pages WHERE slug = ?').bind(slug).first<{ id: number; deleted_at: number | null }>();
        if (!page) return asTextResult('Error: 문서를 찾을 수 없습니다.', true);
        if (!page.deleted_at) return asTextResult('Error: 문서가 삭제 상태가 아닙니다.', true);

        await db.prepare('UPDATE pages SET deleted_at = NULL WHERE id = ?').bind(page.id).run();
        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind('restore', `[admin-mcp] 문서 복원: ${slug}`, user.id)
                .run().catch(() => {})
        );
        c.executionCtx.waitUntil(Promise.allSettled([
            invalidatePageCache(c, slug),
            refreshRecentChangesCache(c),
            invalidateBacklinkCaches(c, slug, db),
        ]));
        return asTextResult(JSON.stringify({ slug, restored: true }, null, 2));
    }

    if (toolName === 'move_page') {
        const oldSlug = String(args.title || '').trim();
        const newSlug = String(args.new_title || '').trim();
        if (!oldSlug || !newSlug) return asTextResult('Error: title 과 new_title 이 모두 필요합니다.', true);
        if (oldSlug === newSlug) return asTextResult('Error: 동일한 슬러그로는 이동할 수 없습니다.', true);
        if (SLUG_FORBIDDEN_CHARS.test(newSlug)) return asTextResult('Error: 새 슬러그에 사용할 수 없는 특수문자가 포함되어 있습니다.', true);
        if (oldSlug.startsWith('이미지:') || newSlug.startsWith('이미지:')) {
            return asTextResult('Error: "이미지:" 네임스페이스는 이동 대상이 될 수 없습니다.', true);
        }

        // 네임스페이스 이동 제한: 콜론이 포함된 문서(틀:, template:, 카테고리: 등)는
        // 동일 네임스페이스 내에서만 이동할 수 있다. wiki.ts 의 POST /w/:slug/move 와 동일 정책.
        const isNamespaceDocument = oldSlug.includes(':');
        const currentNamespace = isNamespaceDocument ? oldSlug.split(':')[0] : '';
        const newNamespace = newSlug.includes(':') ? newSlug.split(':')[0] : '';
        if (isNamespaceDocument && currentNamespace !== newNamespace) {
            return asTextResult('Error: 네임스페이스가 있는 문서는 다른 네임스페이스로 이동할 수 없습니다.', true);
        }

        // 기본값 true — 명시적으로 false 가 지정된 경우에만 백링크 갱신을 건너뛴다.
        // (boolean 이외의 값은 무시하고 기본 true 로 처리.)
        const updateBacklinks = args.update_backlinks !== false;

        const page = await db
            .prepare('SELECT id, version, content, category, last_revision_id, is_locked FROM pages WHERE slug = ? AND deleted_at IS NULL')
            .bind(oldSlug)
            .first<{ id: number; version: number; content: string; category: string | null; last_revision_id: number | null; is_locked: number }>();
        if (!page) return asTextResult('Error: 문서를 찾을 수 없거나 삭제된 상태입니다.', true);

        // 잠긴 문서 이동은 wiki:lock 권한 필요. wiki.ts 의 POST /w/:slug/move 와 동일.
        if (page.is_locked === 1 && !rbac.can(user.role, 'wiki:lock')) {
            return asTextResult('Error: 잠긴 문서는 wiki:lock 권한이 있어야 이동할 수 있습니다.', true);
        }

        const conflict = await db.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL').bind(newSlug).first();
        if (conflict) return asTextResult('Error: 새 슬러그가 이미 존재합니다.', true);

        const enabledExt = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
        const isR2Only = isR2OnlyNamespace(oldSlug, enabledExt);
        let currentContent = page.content;
        if (isR2Only && (!currentContent || currentContent === '') && page.last_revision_id) {
            const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(page.last_revision_id).first<{ content: string; r2_key: string | null }>();
            if (lastRev) currentContent = await getRevisionContent(c.env.MEDIA, lastRev, new URL(c.req.url).origin);
        }

        const rewritten = rewriteContentForRename(currentContent, oldSlug, newSlug);
        const contentChanged = rewritten !== currentContent;
        // 본문 재작성이 필요할 때만 새 리비전을 만들고 version 을 올린다. 자기 자신을 참조하지
        // 않는 문서는 슬러그만 바뀌므로 version/last_revision_id 가 그대로 유지되며,
        // 응답에서도 보고된 version 이 실제 저장 상태와 일치해야 optimistic locking 이 깨지지 않는다.
        let newVersion = page.version;
        let newRevisionId = page.last_revision_id;

        if (contentChanged) {
            newVersion = page.version + 1;
            const r2Key = await uploadRevisionToR2(c.env.MEDIA, page.id, newVersion, rewritten);
            const revResult = await db
                .prepare('INSERT INTO revisions (page_id, page_version, content, r2_key, summary, author_id) VALUES (?, ?, ?, ?, ?, ?)')
                .bind(page.id, newVersion, '', r2Key, withMcpPrefix(`[move] ${oldSlug} → ${newSlug}`), user.id)
                .run();
            newRevisionId = revResult.meta.last_row_id;
            const newIsR2Only = isR2OnlyNamespace(newSlug, enabledExt);
            const contentToStore = newIsR2Only ? '' : rewritten;
            const metrics = computePageMetrics(rewritten);
            await db
                .prepare('UPDATE pages SET slug = ?, content = ?, last_revision_id = ?, version = ?, rows = ?, characters = ?, updated_at = unixepoch() WHERE id = ?')
                .bind(newSlug, contentToStore, newRevisionId, newVersion, metrics.rows, metrics.characters, page.id)
                .run();
            const linkCatStmts = buildLinkAndCategoryStatements(db, page.id, rewritten, page.category);
            c.executionCtx.waitUntil(db.batch(linkCatStmts).catch(e => console.error('admin-mcp move link/cat batch failed:', e)));
        } else {
            await db.prepare('UPDATE pages SET slug = ?, updated_at = unixepoch() WHERE id = ?').bind(newSlug, page.id).run();
        }

        const updatedSlugs: string[] = [];
        const skippedLockedSlugs: string[] = [];
        if (updateBacklinks) {
            const { results: backlinks } = await db
                .prepare(`
                    SELECT DISTINCT p.id, p.slug, p.version, p.content, p.category, p.last_revision_id, p.is_locked
                    FROM page_links pl
                    JOIN pages p ON pl.source_page_id = p.id
                    WHERE pl.blog = 0 AND pl.target_slug = ? AND p.deleted_at IS NULL AND p.id != ?
                `)
                .bind(oldSlug, page.id)
                .all<{ id: number; slug: string; version: number; content: string; category: string | null; last_revision_id: number | null; is_locked: number }>();

            const canEditLocked = rbac.can(user.role, 'wiki:lock');
            for (const bl of backlinks) {
                // 잠긴 역링크 문서는 wiki:lock 보유자만 재작성 가능. wiki.ts 의
                // rewriteBacklinksForRename 과 동일한 정책으로, 잠금 우회를 통한 간접 편집을 차단.
                if (bl.is_locked === 1 && !canEditLocked) {
                    skippedLockedSlugs.push(bl.slug);
                    continue;
                }
                const blIsR2 = isR2OnlyNamespace(bl.slug, enabledExt);
                let blContent = bl.content;
                if (blIsR2 && (!blContent || blContent === '') && bl.last_revision_id) {
                    const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(bl.last_revision_id).first<{ content: string; r2_key: string | null }>();
                    if (lastRev) blContent = await getRevisionContent(c.env.MEDIA, lastRev, new URL(c.req.url).origin);
                }
                const blRewritten = rewriteContentForRename(blContent, oldSlug, newSlug);
                if (blRewritten === blContent) continue;
                const blNewVer = bl.version + 1;
                const blR2Key = await uploadRevisionToR2(c.env.MEDIA, bl.id, blNewVer, blRewritten);
                const blRev = await db
                    .prepare('INSERT INTO revisions (page_id, page_version, content, r2_key, summary, author_id) VALUES (?, ?, ?, ?, ?, ?)')
                    .bind(bl.id, blNewVer, '', blR2Key, withMcpPrefix(`[move-backlink] ${oldSlug} → ${newSlug}`), user.id)
                    .run();
                const blMetrics = computePageMetrics(blRewritten);
                const blContentToStore = blIsR2 ? '' : blRewritten;
                await db
                    .prepare('UPDATE pages SET content = ?, last_revision_id = ?, version = ?, rows = ?, characters = ?, updated_at = unixepoch() WHERE id = ?')
                    .bind(blContentToStore, blRev.meta.last_row_id, blNewVer, blMetrics.rows, blMetrics.characters, bl.id)
                    .run();
                const stmts = buildLinkAndCategoryStatements(db, bl.id, blRewritten, bl.category);
                c.executionCtx.waitUntil(db.batch(stmts).catch(e => console.error('admin-mcp move backlink batch failed:', e)));
                updatedSlugs.push(bl.slug);
            }
        }

        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind('move', `[admin-mcp] 문서 이동: ${oldSlug} → ${newSlug}${updateBacklinks ? ` (역링크 ${updatedSlugs.length}개 갱신)` : ''}`, user.id)
                .run().catch(() => {})
        );
        c.executionCtx.waitUntil(Promise.allSettled([
            invalidatePageCache(c, oldSlug),
            invalidatePageCache(c, newSlug),
            refreshRecentChangesCache(c),
            invalidateBacklinkCaches(c, oldSlug, db),
            invalidateBacklinkCaches(c, newSlug, db),
            ...updatedSlugs.map(s => invalidatePageCache(c, s)),
        ]));

        return asTextResult(JSON.stringify({
            old_slug: oldSlug,
            new_slug: newSlug,
            content_rewritten: contentChanged,
            new_version: newVersion,
            updated_backlinks: updatedSlugs.length,
            updated_backlink_slugs: updatedSlugs,
            skipped_locked_backlinks: skippedLockedSlugs,
        }, null, 2));
    }

    return null;
}

// 관리자에게 노출되는 전체 도구 목록 (어드민 전용 읽기 + 편집).
// /api/mcp 가 일반 MCP_TOOL_DEFS_ALL 위에 이 배열을 합쳐 admin 사용자에게 보여준다.
export const ADMIN_TOOL_DEFS: McpToolDef[] = [
    ...ADMIN_READ_ONLY_TOOL_DEFS,
    ...ADMIN_EDIT_TOOL_DEFS,
];

// /api/mcp 의 information 도구가 admin 사용자에게 추가로 덧붙여 보여줄 가이드 문구.
// 통합 information 본문 끝에 합쳐 사용한다.
export function buildAdminInformationSuffix(userName: string): string {
    const adminReadIntro = `\n\n## 관리자 전용 읽기 도구\n${ADMIN_READ_ONLY_TOOL_DEFS.map(t => `- ${t.name}`).join('\n')}`;
    const editIntro = `\n\n## 관리자 편집 도구 (현재 인증된 관리자: ${userName})\n\n` +
        `**stateful draft 모델**: create_or_update_page / patch_page / edit_section 은 즉시 저장하지 않고 \`mcp_drafts\` 에 누적합니다 ` +
        `(같은 슬러그에 대해 사용자별 1개). 응답으로 \`draft_id\` 를 받고, 편집이 끝나면 commit_edit(draft_id, summary) 를 호출해 ` +
        `1개 리비전으로 저장합니다. 시작 시점 이후 다른 사용자가 페이지를 수정했으면 commit_edit 가 충돌로 거부합니다 ` +
        `(이 경우 discard_edit 후 read_document 로 최신 상태를 다시 읽고 편집을 재구성). draft 는 마지막 활동 이후 12시간이 지나면 자동 삭제됩니다.\n\n` +
        `**즉시 적용** (draft 모델 미사용): delete_page, restore_page, move_page, revert_page.\n\n` +
        ADMIN_EDIT_TOOL_DEFS.map(t => `- ${t.name}`).join('\n') +
        `\n\n모든 commit / 즉시 적용 동작은 admin_log 에 [admin-mcp] 접두로 기록됩니다 (draft 단계는 기록 없음).`;
    return `${adminReadIntro}${editIntro}`;
}
