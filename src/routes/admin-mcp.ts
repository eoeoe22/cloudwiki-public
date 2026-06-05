// 추가 MCP 도구 정의 + 디스패처 (일반 유저 편집 도구 + 관리자 전용 도구).
//
// 통합 MCP 엔드포인트 (/api/mcp) 가 호출 시점에 사용자 역할을 보고 이 모듈의 도구를
// 공용 읽기 도구 위에 추가로 노출한다. 별도 라우트(/api/admin-mcp) 를 직접 등록하지 않으며,
// 본 파일은 도구 정의와 디스패처만 export 한다.
//
// 노출 계층:
//   - guest (인증 없음 또는 권한 없는 토큰): MCP_TOOL_DEFS_ALL (mcpDispatch.ts) 만.
//   - 일반 유저 (`wiki:edit`): + USER_TOOL_DEFS
//        - 읽기: list_drafts, read_draft, read_revision
//        - 편집(draft 모델): create_or_update_page, patch_page, edit_section
//             → commit_edit / discard_edit 로 마무리. 도중 단계는 새 리비전을 만들지 않고
//             mcp_drafts 테이블에 사용자별로 누적된다 (같은 슬러그에 대해 1개).
//             commit_edit 가 base_revision_id 와 현재 last_revision_id 를 비교해 충돌 감지.
//             draft 는 마지막 활동 이후 12시간이 지나면 자정 크론이 일괄 삭제.
//        - 편집(즉시 적용): revert_page
//   - 관리자 (`admin:access`): + ADMIN_ONLY_TOOL_DEFS
//        - 읽기: list_deleted_pages
//        - 편집(즉시 적용): delete_page, restore_page, move_page
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
import { computeLineDiffStats } from '../utils/diff';
import { ensureMcpDraftsMigration } from '../utils/mcpDraftsMigration';
import { createNotification } from '../utils/notification';
import {
    SLUG_FORBIDDEN_CHARS,
    TITLE_FORBIDDEN_CHARS,
    TITLE_MAX_LENGTH,
    normalizeTitleInput,
    findConflictingPage,
    computePageMetricsTracked,
    buildLinkAndCategoryStatements,
    rewriteContentForRename,
} from './wiki';
import {
    invalidatePageCache,
    refreshRecentChangesCache,
    invalidateBacklinkCaches,
} from '../utils/cacheInvalidation';
import { extractFirstThumbnail, rebuildBlogImageLinks } from './blog';
import { removeAnnouncementByPostId } from '../utils/announcements';
import {
    parseEditAcl,
    serializeEditAcl,
    evaluateEditAcl,
    getEditAclMinAgeDays,
    findPrefixRuleEditAcl,
} from '../utils/editAcl';

/**
 * MCP 편집 도구용 ACL 게이트.
 *
 * - admin_only 플래그가 없는 ACL 은 관리자가 우회.
 * - admin_only 플래그가 있으면 evaluate 단계에서 isAdmin 으로 판정 (관리자도 평가에 참여).
 * - 기존 페이지면 pages.edit_acl 평가, 신규 생성 케이스(pageId=null)면 prefix 룰 ACL 평가.
 * - 통과면 null, 차단이면 사용자 친화적 에러 문자열을 반환한다.
 */
async function enforceMcpEditAcl(
    db: D1Database,
    user: User,
    rbac: RBAC,
    existingPage: { id: number; edit_acl?: string | null } | null,
    slugForCreate: string | null,
): Promise<string | null> {
    const isAdmin = rbac.can(user.role, 'admin:access');
    const minAge = await getEditAclMinAgeDays(db);
    if (existingPage) {
        let rawAcl: string | null | undefined = existingPage.edit_acl;
        if (rawAcl === undefined) {
            const row = await db
                .prepare('SELECT edit_acl FROM pages WHERE id = ?')
                .bind(existingPage.id)
                .first<{ edit_acl: string | null }>();
            rawAcl = row?.edit_acl ?? null;
        }
        const acl = parseEditAcl(rawAcl);
        if (!acl || acl.flags.length === 0) return null;
        const hasAdminOnly = acl.flags.includes('admin_only');
        if (isAdmin && !hasAdminOnly) return null;
        const ev = await evaluateEditAcl(db, acl, user, existingPage.id, minAge, isAdmin);
        if (ev.allowed) return null;
        if (ev.decisive === 'admin_only') {
            return '이 문서는 관리자만 편집할 수 있습니다.';
        }
        return `이 문서를 편집할 권한이 부족합니다 (edit_acl: ${acl.flags.join(',')}).`;
    }
    if (!slugForCreate) return null;
    const acl = await findPrefixRuleEditAcl(db, slugForCreate);
    if (!acl || acl.flags.length === 0) return null;
    const hasAdminOnly = acl.flags.includes('admin_only');
    if (isAdmin && !hasAdminOnly) return null;
    const ev = await evaluateEditAcl(db, acl, user, null, minAge, isAdmin);
    if (ev.allowed) return null;
    if (ev.decisive === 'admin_only') {
        return '이 슬러그로 시작하는 문서는 관리자만 새로 생성할 수 있습니다.';
    }
    return `이 슬러그로 시작하는 문서는 ACL 정책에 따라 편집할 수 없습니다 (${acl.flags.join(',')}).`;
}

// ────────────────────────────────────────────────────────────────
// 일반 유저(`wiki:edit`) 도 호출 가능한 읽기 도구.
// (draft 흐름·과거 리비전 조회는 편집과 짝을 이루므로 wiki:edit 권한자에게 노출.)
// ────────────────────────────────────────────────────────────────

export const USER_READ_TOOL_DEFS: McpToolDef[] = [
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
// 관리자(`admin:access`) 전용 읽기 도구.
// ────────────────────────────────────────────────────────────────

export const ADMIN_ONLY_READ_TOOL_DEFS: McpToolDef[] = [
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
    }
];

// ────────────────────────────────────────────────────────────────
// 일반 유저(`wiki:edit`) 도 호출 가능한 편집 도구 정의.
// (revert_page 는 본질적으로 새 리비전을 만드는 편집이므로 user 계층에 둔다.)
// ────────────────────────────────────────────────────────────────

const HEADING_RULE_NOTE =
    '\n\n⚠️ 헤딩 작성 규칙: 위키는 헤딩(##, ###, ...)에 자동으로 계층 번호("1.", "1.1." 등)를 부여합니다. ' +
    '헤딩 텍스트에 번호를 직접 적지 마세요 (예: `## 1. 개요` ❌ → `## 개요` ✅). 직접 적으면 렌더링 시 "1. 1. 개요" 처럼 중복 번호가 표시됩니다. ' +
    '목차 내 다른 섹션을 참조할 때는 `[[문서#s-1.2]]` 형식의 섹션 앵커를 사용하세요.';

export const USER_EDIT_TOOL_DEFS: McpToolDef[] = [
    {
        name: 'create_or_update_page',
        description: '위키 문서 전체 본문을 새로 만들거나 통째로 교체할 draft 를 생성합니다. ⚠️ 즉시 저장하지 않고 draft 에 누적되며, 완료 후 commit_edit(draft_id, summary) 를 호출해야 새 리비전이 생성됩니다. 이미 본인의 draft 가 같은 슬러그로 있으면 그 draft 의 본문이 이 호출의 content 로 교체됩니다. create_only=true 면 페이지가 이미 존재할 때 오류를 반환합니다 (실수 덮어쓰기 방지).\n\n응답에 draft_id 가 포함되며, 이 id 로 read_draft / commit_edit / discard_edit 를 호출합니다. draft 는 마지막 활동 이후 12시간이 지나면 자동 삭제됩니다.' + HEADING_RULE_NOTE,
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: '문서 슬러그 (호출/식별자)' },
                content: { type: 'string', description: '문서 전체 본문 (마크다운/위키 문법)' },
                category: { type: 'string', description: '쉼표로 구분된 카테고리 (선택, 한글/영숫자/공백/쉼표만 허용)' },
                redirect_to: { type: 'string', description: '리다이렉트 대상 슬러그 (선택)' },
                create_only: { type: 'boolean', description: 'true 시 슬러그가 이미 존재하면 오류 반환 (기본 false)' },
                display_title: { type: ['string', 'null'], description: '표시 전용 대체 제목 (선택). 슬러그와 달리 모든 특수문자 허용. null/빈 문자열이면 제거. 호출 매칭에는 사용되지 않으며 위키 링크/트랜스클루전/MCP 인자는 항상 슬러그(title 파라미터)를 사용합니다.' }
            },
            required: ['title', 'content']
        }
    },
    {
        name: 'patch_page',
        description: '문서의 특정 텍스트를 찾아 교체하는 부분 편집입니다 (Claude Code Edit 도구와 같은 방식). ⚠️ 즉시 저장하지 않고 draft 에 누적되며, commit_edit 호출 시 비로소 새 리비전이 생성됩니다. 같은 슬러그로 이미 본인 draft 가 있으면 그 draft 의 본문에 대해 치환을 수행합니다 (없으면 페이지 현재 본문을 자동 스냅샷해 draft 시작). old_string 은 대상 본문(=draft 또는 페이지 현재 본문)에서 정확히 한 번만 등장해야 하며, 겹치는 매치 포함 2회 이상이면 오류입니다 — 앞뒤 맥락을 더 포함해 고유하게 만드세요. new_string 이 빈 문자열이면 해당 부분이 삭제됩니다.\n\n응답에 draft_id 가 포함됩니다. 섹션 단위는 edit_section, 전체 본문 교체는 create_or_update_page 를 사용하세요.' + HEADING_RULE_NOTE,
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
        description: '문서의 특정 섹션 본문을 새 내용으로 통째로 교체합니다. ⚠️ 즉시 저장하지 않고 draft 에 누적되며, commit_edit 호출 시 비로소 새 리비전이 생성됩니다. 같은 슬러그로 이미 본인 draft 가 있으면 draft 본문에 대해 섹션 치환을 수행합니다 (없으면 페이지 현재 본문을 자동 스냅샷). section_number 는 get_toc(raw=true) 또는 read_draft 의 본문에서 산출한 원본 기준 번호("1", "1.1", "0" 등) 입니다. new_content 는 read_section(raw=true) 으로 받은 형식 그대로(헤딩 라인 포함) 보내는 것을 권장합니다. 교체 범위는 지정 헤딩부터 같은 레벨 이상의 다음 헤딩 직전까지입니다 ("0" 은 첫 헤딩 이전 도입부).\n\n응답에 draft_id 가 포함됩니다.' + HEADING_RULE_NOTE,
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
        description: 'draft 에 누적된 편집을 승인 대기로 제출합니다. base_revision_id 가 그 사이 변경되었으면(=다른 사용자가 페이지를 수정) 거부합니다 — 그 경우 discard_edit 후 read_document 로 최신 상태를 다시 읽고 편집을 재구성해야 합니다. 신규 페이지 draft 인데 commit 시점에 이미 같은 슬러그가 존재하면 같은 사유로 거부합니다. summary 는 새 리비전의 편집 요약입니다 (선택, 최대 255자). 저장 시 자동으로 `[MCP] [+N줄 -M줄] ` 접두가 붙어 사람 편집과 구분되며 변경 규모를 한눈에 보여줍니다 (예: `[MCP] [+5줄 -2줄] 오타 수정`).\n\n응답에도 이전 본문 대비 라인 단위 변경량(`lines_added` / `lines_removed`)이 포함됩니다 — git diff --stat 의 +N/-M 와 동일한 의미입니다 (CRLF 정규화 후 LCS 기반으로 산출).\n\n**항상 승인 대기로 제출**됩니다. draft 는 즉시 리비전이 되지 않고 OAuth 토큰 소유자(=이 MCP 를 연결한 본인) 에게 승인 대기로 제출됩니다. 본인이 마이페이지 / 알림 / 문서 배너에서 검토 후 승인해야 비로소 리비전이 만들어집니다. 거부 시 draft 는 폐기됩니다.',
        inputSchema: {
            type: 'object',
            properties: {
                draft_id: { type: 'number', description: '커밋할 draft 의 id (편집 도구 응답에서 받은 값)' },
                summary: { type: 'string', description: '편집 요약 (선택, 최대 255자, 저장 시 [MCP] 접두 자동 부여)' },
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
    }
];

// ────────────────────────────────────────────────────────────────
// 관리자(`admin:access`) 전용 편집 도구 정의 (즉시 적용 — draft 모델 미사용).
// ────────────────────────────────────────────────────────────────

export const ADMIN_ONLY_EDIT_TOOL_DEFS: McpToolDef[] = [
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
    },
    {
        name: 'create_blog_post',
        description: '블로그(/blog) 포스트를 새로 작성합니다 (즉시 적용 — draft 모델 미사용). 응답에 새 포스트 id 가 포함됩니다. 본문에서 첫 이미지가 자동으로 썸네일로 추출되며, 이미지 역링크(page_links) 도 자동 갱신됩니다.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: '포스트 제목 (1-500자)' },
                content: { type: 'string', description: '포스트 본문 (마크다운/위키 문법)' }
            },
            required: ['title', 'content']
        }
    },
    {
        name: 'update_blog_post',
        description: '블로그 포스트의 제목 / 본문을 수정합니다 (즉시 적용 — draft 모델 미사용). title 과 content 모두 선택적이며, 적어도 하나는 지정해야 합니다. content 를 지정하면 본문이 통째로 교체되고 썸네일·이미지 역링크가 재계산됩니다. 소프트 삭제된 포스트는 수정할 수 없습니다 (먼저 restore_blog_post 로 복원하세요).',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number', description: '수정할 블로그 포스트 id (정수)' },
                title: { type: 'string', description: '새 제목 (선택, 1-500자)' },
                content: { type: 'string', description: '새 본문 (선택, 지정 시 통째로 교체)' }
            },
            required: ['id']
        }
    },
    {
        name: 'delete_blog_post',
        description: '블로그 포스트를 소프트 삭제합니다 (즉시 적용 — draft 모델 미사용). 영구 삭제는 지원하지 않으며, restore_blog_post 로 복원할 수 있습니다. 삭제된 포스트가 사이트 공지로 발행되어 있던 경우 공지도 자동으로 취소됩니다. 본 포스트가 참조하던 이미지 역링크(page_links) 도 정리됩니다.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number', description: '삭제할 블로그 포스트 id (정수)' }
            },
            required: ['id']
        }
    },
    {
        name: 'restore_blog_post',
        description: '소프트 삭제된 블로그 포스트를 복원합니다 (즉시 적용 — draft 모델 미사용). 복원 후 이미지 역링크(page_links) 가 본문을 기준으로 재구성됩니다.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number', description: '복원할 블로그 포스트 id (정수)' }
            },
            required: ['id']
        }
    },
    {
        name: 'set_page_status',
        description: '문서 본문은 건드리지 않고 카테고리만 변경합니다 (즉시 적용 — draft 모델 미사용, 새 리비전 생성 없음). 본문을 읽거나 수정할 필요 없이 메타데이터만 갱신할 때 사용합니다.\n\n- category: 쉼표로 구분된 카테고리 (한글/영숫자/공백/쉼표만 허용). 빈 문자열을 보내면 모든 카테고리가 제거됩니다.\n\n변경은 admin_log 에 기록되지만 리비전 이력에는 남지 않습니다 (편집 요약/저자 등록 없음).\n\n비공개 설정·편집 잠금/관리자 전용 ACL 은 별도 API 또는 권한 관리 모달에서 설정합니다.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: '대상 문서 슬러그' },
                category: { type: 'string', description: '쉼표로 구분된 카테고리 (빈 문자열이면 카테고리 모두 제거)' }
            },
            required: ['title', 'category']
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
export const MCP_SUMMARY_PREFIX = '[MCP]';
export const MCP_SUMMARY_MAX_LENGTH = 255;
export function withMcpPrefix(summary: string | null | undefined): string {
    const trimmed = (summary ?? '').trim();
    if (!trimmed) return MCP_SUMMARY_PREFIX;
    if (trimmed.startsWith(MCP_SUMMARY_PREFIX)) return trimmed;
    return `${MCP_SUMMARY_PREFIX} ${trimmed}`;
}
// 입력 summary 가 [MCP] 접두 부여 후에도 255자 한도(MCP_SUMMARY_MAX_LENGTH) 를 넘지 않는지 검증.
// 도구 스키마/문서가 명시한 contract 가 무너지지 않도록 raw 입력이 아니라 저장될 최종 문자열을 기준으로 한다.
export function validateMcpSummaryLength(summary: string | null | undefined): string | null {
    const finalLength = withMcpPrefix(summary).length;
    if (finalLength > MCP_SUMMARY_MAX_LENGTH) {
        return `Error: summary 는 [MCP] 접두 포함 최대 ${MCP_SUMMARY_MAX_LENGTH}자입니다 (현재 ${finalLength}자).`;
    }
    return null;
}

// commit_edit 의 리비전 summary 앞에 자동 부여되는 diff 마커.
// "[+N줄 -M줄]" 형식이며 [MCP] 접두 뒤, 사용자 summary 앞에 위치한다.
// 예) `[MCP] [+5줄 -2줄] 오타 수정`
export function formatDiffMarker(stats: { added: number; removed: number }): string {
    return `[+${stats.added}줄 -${stats.removed}줄]`;
}

// 사용자 summary 와 diff 마커를 결합한 최종 summary 본문(=[MCP] 접두 부여 전) 을 만든다.
// 결합 후 [MCP] 접두까지 포함한 길이가 255자를 넘으면 사용자 summary 를 말줄임표(…)로 잘라
// 한도를 맞춘다 — 마커는 항상 보존된다.
export function buildCommitSummary(userSummary: string | null, stats: { added: number; removed: number }): string {
    const marker = formatDiffMarker(stats);
    const trimmedUser = (userSummary ?? '').trim();
    const combined = trimmedUser ? `${marker} ${trimmedUser}` : marker;
    if (withMcpPrefix(combined).length <= MCP_SUMMARY_MAX_LENGTH) return combined;

    // 한도 초과 — 사용자 summary 만 잘라낸다.
    // 최종 형태는 "[MCP] {marker} {truncatedUser}…" 이므로 다음 4가지 고정 비용을 모두 예산에 포함해야 한다.
    // (withMcpPrefix 가 .trim() 하므로 marker 뒤 공백 1 자가 누락되지 않도록 명시적으로 계산.)
    const fixedOverhead =
        MCP_SUMMARY_PREFIX.length /* "[MCP]" */
        + 1 /* "[MCP]" 와 marker 사이 공백 */
        + marker.length
        + 1 /* marker 와 user 사이 공백 */
        + 1 /* 말줄임표 '…' */;
    const room = MCP_SUMMARY_MAX_LENGTH - fixedOverhead;
    if (room <= 0) return marker;
    return `${marker} ${trimmedUser.slice(0, room)}…`;
}

function unixToIso(unix: number | null | undefined): string | null {
    if (unix === null || unix === undefined || !Number.isFinite(unix)) return null;
    return new Date(unix * 1000).toISOString();
}

// 추가 읽기 도구 디스패처 — guest 에게는 노출하지 않으며, 일반 유저(`wiki:edit`) /
// 관리자(`admin:access`) 에게 단계적으로 노출된다. 진입 시 visible-tools 검사로 차단되지만
// 디스패처 자체에서도 권한을 다시 확인해 방어선을 둔다.
export async function dispatchAdminReadTool(c: Context<Env>, user: User, toolName: string, args: any): Promise<ToolResult | null> {
    const db = c.env.DB;
    const rbac = c.get('rbac') as RBAC;
    // mcp_drafts 의 새 컬럼(submitted_at / submitted_summary) 을 사용하기 전에 기존 D1 에서
    // 컬럼이 빠져 있는 환경을 위해 idempotent 런타임 마이그레이션을 적용한다.
    await ensureMcpDraftsMigration(db);

    if (toolName === 'list_drafts') {
        if (!rbac.can(user.role, 'wiki:edit')) {
            return asTextResult('Error: wiki:edit 권한이 필요합니다.', true);
        }
        const { results } = await db.prepare(`
            SELECT id, slug, action, base_revision_id, base_version,
                   length(content) AS content_length, updated_at, submitted_at, submitted_summary
            FROM mcp_drafts WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100
        `).bind(user.id).all<{
            id: number; slug: string; action: string; base_revision_id: number | null;
            base_version: number; content_length: number; updated_at: number;
            submitted_at: number | null; submitted_summary: string | null;
        }>();
        const formatted = results.map(r => ({
            draft_id: r.id,
            slug: r.slug,
            action: r.action,
            // 'pending_approval' = commit_edit 로 제출됨, 유저 검토 대기.
            // 'draft' = AI 가 계속 편집 가능한 작성 중 상태 (기본).
            status: r.submitted_at !== null ? 'pending_approval' : 'draft',
            base_revision_id: r.base_revision_id,
            base_version: r.base_version,
            content_length: r.content_length,
            updated_at: unixToIso(r.updated_at),
            submitted_at: unixToIso(r.submitted_at),
            submitted_summary: r.submitted_summary,
        }));
        return asTextResult(JSON.stringify(formatted, null, 2));
    }

    if (toolName === 'read_draft') {
        if (!rbac.can(user.role, 'wiki:edit')) {
            return asTextResult('Error: wiki:edit 권한이 필요합니다.', true);
        }
        const slug = String(args.title || '').trim();
        if (!slug) return asTextResult('Error: title 이 필요합니다.', true);
        const draft = await db.prepare(`
            SELECT id, slug, action, base_revision_id, base_version, content,
                   category, redirect_to, updated_at, submitted_at, submitted_summary
            FROM mcp_drafts WHERE user_id = ? AND slug = ?
        `).bind(user.id, slug).first<{
            id: number; slug: string; action: string; base_revision_id: number | null;
            base_version: number; content: string; category: string | null;
            redirect_to: string | null; updated_at: number;
            submitted_at: number | null; submitted_summary: string | null;
        }>();
        if (!draft) return asTextResult('Error: 해당 슬러그의 draft 를 찾을 수 없습니다.', true);
        return asTextResult(JSON.stringify({
            draft_id: draft.id,
            slug: draft.slug,
            action: draft.action,
            status: draft.submitted_at !== null ? 'pending_approval' : 'draft',
            base_revision_id: draft.base_revision_id,
            base_version: draft.base_version,
            category: draft.category,
            redirect_to: draft.redirect_to,
            updated_at: unixToIso(draft.updated_at),
            submitted_at: unixToIso(draft.submitted_at),
            submitted_summary: draft.submitted_summary,
            content: draft.content,
        }, null, 2));
    }

    if (toolName === 'list_deleted_pages') {
        if (!rbac.can(user.role, 'admin:access')) {
            return asTextResult('Error: admin:access 권한이 필요합니다.', true);
        }
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
        if (!rbac.can(user.role, 'wiki:edit')) {
            return asTextResult('Error: wiki:edit 권한이 필요합니다.', true);
        }
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
                   r.deleted_at, r.purged_at,
                   u.name AS author_name
            FROM revisions r
            LEFT JOIN users u ON r.author_id = u.id
            WHERE r.id = ?
        `).bind(revisionId).first<{
            id: number; page_id: number; page_version: number | null;
            content: string; r2_key: string | null; summary: string | null;
            created_at: number; deleted_at: number | null; purged_at: number | null;
            author_name: string | null;
        }>();
        if (!rev) return asTextResult('Error: 리비전을 찾을 수 없습니다.', true);
        if (rev.page_id !== page.id) {
            return asTextResult('Error: 지정한 리비전이 이 문서의 것이 아닙니다.', true);
        }
        // 비관리자 호출자에게는 삭제된 리비전이 존재하지 않는 것처럼 가린다.
        const isAdmin = rbac.can(user.role, 'admin:access');
        if (rev.deleted_at && !isAdmin) {
            return asTextResult('Error: 리비전을 찾을 수 없습니다.', true);
        }
        // 하드 삭제된 리비전은 R2 본문이 없으므로 빈 본문으로 반환 (관리자 전용 경로).
        const origin = new URL(c.req.url).origin;
        const content = rev.purged_at
            ? ''
            : await getRevisionContent(c.env.MEDIA, { content: rev.content, r2_key: rev.r2_key }, origin);
        const payload: Record<string, unknown> = {
            revision_id: rev.id,
            slug: page.slug,
            page_version: rev.page_version,
            author_name: rev.author_name,
            summary: rev.summary,
            created_at: unixToIso(rev.created_at),
            content,
        };
        if (isAdmin && rev.deleted_at) {
            payload.deleted_at = unixToIso(rev.deleted_at);
            if (rev.purged_at) {
                payload.purged_at = unixToIso(rev.purged_at);
                payload.purged = true;
            }
        }
        return asTextResult(JSON.stringify(payload, null, 2));
    }

    return null;
}

// 기존 문서를 새 리비전으로 갱신하는 공용 헬퍼.
// create_or_update_page 의 update 경로, patch_page, revert_page 가 공유한다.
// 호출자는 페이지 존재/슬러그 검증을 이미 마쳤다고 가정한다.
export async function applyExistingPageUpdate(
    c: Context<Env>,
    user: User,
    page: { id: number; version: number; category: string | null; title?: string | null },
    content: string,
    opts: {
        summary: string | null;
        category?: string | null;     // undefined → 기존 유지, null/string → 덮어쓰기
        redirectTo?: string | null;   // undefined → 기존 유지, null/string → 덮어쓰기
        title?: string | null;        // undefined → 기존 유지, null → 제거, string → 설정. 호출자가 사전 충돌 검증을 마쳤다고 가정.
        slug: string;
        editAcl?: string | null;      // undefined → 기존 유지(MCP 기본), null/string → 덮어쓰기 (사람 편집 보류 승인의 카테고리 ACL 머지 적용용).
        layoutMode?: string | null;   // undefined → 기존 유지(MCP 기본), null/string → 덮어쓰기 (사람 편집 보류 승인의 layout_mode 적용용).
        summaryRaw?: boolean;         // true 면 withMcpPrefix() 를 건너뛰고 opts.summary 를 그대로 저장 (사람 편집 보류 승인 경로). 기본 false → [MCP] 접두.
        logType?: string;             // admin_log type (예: page_update / page_patch / page_revert) — 생략 시 로그 없음
        logMessage?: string;
        awaitLinkCategoryIndex?: boolean; // true 면 page_links/page_categories 재색인을 waitUntil 대신 await — 같은 페이지에 연속 리비전을 만드는 2-리비전 승인에서 rev1 의 재색인이 rev2 의 것과 경합/역전돼 중간 리비전 인덱스가 남는 것을 막는다(rev1 에만 사용).
    }
): Promise<{ revision_id: number; new_version: number; rows: number; characters: number }> {
    const db = c.env.DB;
    const enabledExt = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
    const isR2Only = isR2OnlyNamespace(opts.slug, enabledExt);
    const metrics = computePageMetricsTracked(content, isR2Only);
    const newVersion = page.version + 1;
    const revisionSummary = opts.summaryRaw ? (opts.summary ?? null) : withMcpPrefix(opts.summary);

    const r2Key = await uploadRevisionToR2(c.env.MEDIA, page.id, newVersion, content);
    let revisionId: number;
    try {
        const revResult = await db
            .prepare('INSERT INTO revisions (page_id, page_version, content, r2_key, summary, author_id) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(page.id, newVersion, '', r2Key, revisionSummary, user.id)
            .run();
        revisionId = revResult.meta.last_row_id;
    } catch (e) {
        await c.env.MEDIA.delete(r2Key).catch(() => {});
        throw e;
    }

    const contentToStore = isR2Only ? '' : content;
    const categoryValue = opts.category === undefined ? page.category : opts.category;
    // title: opts.title 가 누락되면 기존 값을 그대로 유지해야 한다. page 인자에 title 이 포함되지 않은
    // 호출자(예: revert_page) 도 안전하도록 SET 절 자체를 조건부로 구성한다 — page.title 을
    // 비신뢰적으로 (undefined → null) 폴백하면 매 revert 마다 대체 제목이 조용히 지워진다.
    const setClauses: string[] = ['content = ?', 'category = ?'];
    const bindings: unknown[] = [contentToStore, categoryValue];
    if (opts.title !== undefined) {
        setClauses.push('title = ?');
        bindings.push(opts.title);
    }
    if (opts.redirectTo !== undefined) {
        setClauses.push('redirect_to = ?');
        bindings.push(opts.redirectTo);
    }
    // editAcl: undefined → 기존 유지(MCP 경로 기본). null/string → 덮어쓰기.
    // 사람 편집 보류 승인(update)에서 카테고리 ACL 머지 결과를 적용할 때 사용.
    if (opts.editAcl !== undefined) {
        setClauses.push('edit_acl = ?');
        bindings.push(opts.editAcl);
    }
    // layoutMode: undefined → 기존 유지(MCP 경로 기본). null/string → 덮어쓰기 (보류 승인의 presentation 토글 등 적용).
    if (opts.layoutMode !== undefined) {
        setClauses.push('layout_mode = ?');
        bindings.push(opts.layoutMode);
    }
    setClauses.push('last_revision_id = ?', 'version = ?', 'rows = ?', 'characters = ?', 'updated_at = unixepoch()');
    bindings.push(revisionId, newVersion, metrics.rows, metrics.characters);
    bindings.push(page.id, page.version);

    // 옵티미스틱 락(CAS): 호출자가 SELECT 한 시점의 version 과 일치할 때만 UPDATE.
    // 이 사이 다른 커밋이 들어와 version 이 올라갔으면 0행 변경되며, 우리는 막 만든
    // revision 과 R2 객체를 정리하고 CONCURRENT_MODIFICATION 으로 던진다 — 호출자가
    // 충돌 응답으로 변환한다. wiki.ts 의 PUT /w/:slug 도 동일하게 version-CAS 를 사용.
    // UPDATE 자체가 throw 하는 경우(예: title 의 idx_pages_title_unique race) 도 동일하게
    // 막 만든 리비전 / R2 객체를 청소한 뒤 에러를 재던져 호출자가 적절한 응답으로 매핑하게 한다.
    let updResult: D1Result;
    try {
        updResult = await db
            .prepare(`UPDATE pages SET ${setClauses.join(', ')} WHERE id = ? AND version = ?`)
            .bind(...bindings)
            .run();
    } catch (e) {
        await db.prepare('DELETE FROM revisions WHERE id = ?').bind(revisionId).run().catch(() => {});
        await c.env.MEDIA.delete(r2Key).catch(() => {});
        throw e;
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
    // 2-리비전 승인의 rev1 은 재색인을 await 해, 곧이어 만들 rev2(최종 본문)의 재색인보다 먼저
    // 끝나도록 강제한다 — waitUntil 두 개가 경합하면 rev1 의 page_links/page_categories 가 나중에
    // 끝나 중간(요청자) 리비전 기준 인덱스가 남을 수 있다.
    if (opts.awaitLinkCategoryIndex) {
        await c.env.DB.batch(linkCatStmts).catch(e => console.error('admin-mcp link/cat batch failed:', e));
    } else {
        c.executionCtx.waitUntil(c.env.DB.batch(linkCatStmts).catch(e => console.error('admin-mcp link/cat batch failed:', e)));
    }
    c.executionCtx.waitUntil(Promise.allSettled([
        invalidatePageCache(c, opts.slug),
        refreshRecentChangesCache(c),
        invalidateBacklinkCaches(c, opts.slug, c.env.DB),
    ]));
    if (opts.logType && opts.logMessage) {
        c.executionCtx.waitUntil(
            c.env.DB.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind(opts.logType, opts.logMessage, user.id)
                .run().catch((e: any) => console.error('admin-mcp admin_log write failed:', e))
        );
    }

    return { revision_id: revisionId, new_version: newVersion, rows: metrics.rows ?? 0, characters: metrics.characters ?? 0 };
}

// 신규 페이지를 INSERT 하고 첫 리비전을 생성하는 공용 헬퍼.
// commit_edit (action='create') 가 사용한다. 호출자는 슬러그 충돌(soft-deleted 포함) 검사를
// 이미 마쳤다고 가정한다.
export async function applyNewPageInsert(
    c: Context<Env>,
    user: User,
    slug: string,
    content: string,
    opts: {
        summary: string | null;
        category: string | null;
        redirectTo: string | null;
        editAcl?: string | null;       // serialize 된 JSON. 호출자가 prefix 룰을 평가해 주입.
        isPrivate?: number;            // 호출자가 doc_setting_prefix_rules longest-match 로 산출. 누락 시 0.
        title?: string | null;        // 호출자가 사전 충돌 검증을 마쳤다고 가정. 누락 시 NULL.
        layoutMode?: string | null;   // 신규 페이지 layout_mode. 누락 시 NULL(자동). 사람 편집 보류 승인(create)의 presentation 토글 적용용.
        summaryRaw?: boolean;         // true 면 withMcpPrefix() 를 건너뛰고 opts.summary 를 그대로 저장 (사람 편집 보류 승인 경로). 기본 false → [MCP] 접두.
        logType?: string;
        logMessage?: string;
        awaitLinkCategoryIndex?: boolean; // true 면 page_links/page_categories 재색인을 await — 2-리비전 승인의 rev1(신규 생성)에서 rev2 재색인과의 경합/역전을 막는다.
    }
): Promise<{ page_id: number; revision_id: number; rows: number; characters: number }> {
    const db = c.env.DB;
    const enabledExt = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
    const isR2Only = isR2OnlyNamespace(slug, enabledExt);
    const metrics = computePageMetricsTracked(content, isR2Only);
    const contentToStore = isR2Only ? '' : content;

    let pageResult;
    try {
        pageResult = await db
            .prepare('INSERT INTO pages (slug, title, content, category, is_private, edit_acl, redirect_to, rows, characters, layout_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(slug, opts.title ?? null, contentToStore, opts.category, opts.isPrivate ?? 0, opts.editAcl ?? null, opts.redirectTo, metrics.rows, metrics.characters, opts.layoutMode ?? null)
            .run();
    } catch (e: any) {
        // UNIQUE race: precheck ~ INSERT 사이에 다른 요청이 같은 slug/title 을 점유.
        // 호출자(commit_edit / submission approve) 가 409 형태로 매핑하도록 code 태깅.
        const msg = String(e?.message || e);
        if (/UNIQUE|constraint/i.test(msg)) {
            const err: any = new Error(/title/i.test(msg) ? 'TITLE_TAKEN' : 'SLUG_TAKEN');
            err.code = /title/i.test(msg) ? 'TITLE_TAKEN' : 'SLUG_TAKEN';
            err.dbMessage = msg;
            throw err;
        }
        throw e;
    }
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
            .bind(pageId, 1, '', firstR2Key, opts.summaryRaw ? (opts.summary ?? null) : withMcpPrefix(opts.summary), user.id)
            .run();
        revisionId = revResult.meta.last_row_id;
    } catch (e) {
        await c.env.MEDIA.delete(firstR2Key).catch(() => {});
        await db.prepare('DELETE FROM pages WHERE id = ?').bind(pageId).run().catch(() => {});
        throw e;
    }
    await db.prepare('UPDATE pages SET last_revision_id = ? WHERE id = ?').bind(revisionId, pageId).run();

    const linkCatStmts = buildLinkAndCategoryStatements(db, pageId, content, opts.category);
    // 2-리비전 승인의 rev1(신규 생성)은 재색인을 await 해 rev2(최종 본문) 재색인보다 먼저 끝나도록 한다.
    if (opts.awaitLinkCategoryIndex) {
        await db.batch(linkCatStmts).catch(e => console.error('admin-mcp link/cat batch failed:', e));
    } else {
        c.executionCtx.waitUntil(db.batch(linkCatStmts).catch(e => console.error('admin-mcp link/cat batch failed:', e)));
    }
    c.executionCtx.waitUntil(Promise.allSettled([
        invalidatePageCache(c, slug),
        refreshRecentChangesCache(c),
        invalidateBacklinkCaches(c, slug, db),
    ]));
    if (opts.logType && opts.logMessage) {
        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind(opts.logType, opts.logMessage, user.id)
                .run().catch((e: any) => console.error('admin-mcp admin_log write failed:', e))
        );
    }

    return { page_id: pageId, revision_id: revisionId, rows: metrics.rows ?? 0, characters: metrics.characters ?? 0 };
}

// 새로 발급된 draft 응답에 포함하는 라이프사이클 가이드.
// 같은 draft 가 이어서 갱신될 때는 더 짧은 안내(DRAFT_UPDATE_NOTE)만 보낸다.
const DRAFT_FIRST_ISSUE_NOTE =
    'draft 가 발급되었습니다.\n\n' +
    '사용법:\n' +
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
    type: 'draft' | 'seeded' | 'not_found' | 'submitted';
    draftId?: number;
    content: string;
    page?: { id: number; version: number; last_revision_id: number | null; category: string | null; redirect_to: string | null; edit_acl: string | null };
}> {
    const db = c.env.DB;
    // action 무관하게 본인의 (slug) draft 가 있으면 그 위에서 편집을 누적한다.
    // create 액션 draft (= 아직 commit 되지 않은 신규 페이지) 도 patch_page / edit_section
    // 으로 점진적으로 다듬을 수 있어야 한다.
    // submitted_at IS NOT NULL → 승인 대기 상태이므로 AI 가 더 이상 수정할 수 없다.
    // 호출자가 별도로 거부 처리해야 한다 (호출 측에서 type='submitted' 처리).
    const draft = await db.prepare(
        'SELECT id, content, submitted_at FROM mcp_drafts WHERE user_id = ? AND slug = ?'
    ).bind(user.id, slug).first<{ id: number; content: string; submitted_at: number | null }>();
    if (draft) {
        if (draft.submitted_at !== null) {
            return { type: 'submitted', draftId: draft.id, content: draft.content };
        }
        return { type: 'draft', draftId: draft.id, content: draft.content };
    }

    const page = await db.prepare(
        'SELECT id, version, content, last_revision_id, category, redirect_to, edit_acl FROM pages WHERE slug = ? AND deleted_at IS NULL'
    ).bind(slug).first<{
        id: number; version: number; content: string;
        last_revision_id: number | null; category: string | null; redirect_to: string | null;
        edit_acl: string | null;
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
        page: { id: page.id, version: page.version, last_revision_id: page.last_revision_id, category: page.category, redirect_to: page.redirect_to, edit_acl: page.edit_acl },
    };
}

// commit_edit(submit_for_approval=true) 가 호출된 draft 를 "승인 대기" 로 마크하고
// OAuth 토큰 소유자(=draft.user_id) 에게 알림을 발송한다.
// 알림 link 는 /mypage#mcp-submissions 로, ref_id 는 draft.id 로 둔다 — 승인/거부 시 같은
// ref_id 로 알림을 정리할 수 있도록 정렬한다. submitted_summary 에는 AI 가 제안한 요약을 저장하고,
// 승인 시점에 유저가 그대로 채택하거나 본인이 다시 작성할 수 있다.
//
// 동시성: UPDATE 를 `WHERE submitted_at IS NULL` 조건으로 묶어 두 개의 commit_edit 호출이
// 같은 draft 에 대해 호출 직전 체크를 동시에 통과하더라도 둘 중 하나만 실제 전환되도록 한다.
// UPDATE 가 changes=0 이면 다른 요청이 먼저 전환을 끝낸 것이므로 알림 INSERT 도 하지 않는다.
// 그 경우 호출자는 'already submitted' 응답을 반환하도록 null 을 받게 된다.
async function markDraftSubmittedAndNotify(
    c: Context<Env>,
    draftId: number,
    slug: string,
    aiSummary: string | null,
): Promise<{ iso: string } | null> {
    const db = c.env.DB;
    const submittedAtSec = Math.floor(Date.now() / 1000);
    const updateRes = await db
        .prepare(
            'UPDATE mcp_drafts SET submitted_at = ?, submitted_summary = ?, updated_at = ? WHERE id = ? AND submitted_at IS NULL'
        )
        .bind(submittedAtSec, aiSummary, submittedAtSec, draftId)
        .run();
    if (!updateRes.meta.changes) {
        // 동시 호출이 이미 전환을 끝냄 — 알림 중복 INSERT 방지.
        return null;
    }
    // draft 소유자(=OAuth 토큰 유저) 에게 in-app 알림 + 푸시.
    const ownerRow = await db
        .prepare('SELECT user_id FROM mcp_drafts WHERE id = ?')
        .bind(draftId)
        .first<{ user_id: number | null }>();
    if (ownerRow?.user_id) {
        const notifContent = `MCP 서버로 제출된 "${slug}" 문서 편집안이 존재합니다.`;
        await createNotification(c.env, c.executionCtx, {
            userId: ownerRow.user_id,
            type: 'mcp_submission',
            content: notifContent,
            link: '/mypage#mcp-submissions',
            refId: draftId,
            push: {
                title: 'MCP 편집안 제출',
                body: notifContent,
                url: '/mypage#mcp-submissions',
                tag: `mcp_submission:${draftId}`,
            },
        });
    }
    return { iso: new Date(submittedAtSec * 1000).toISOString() };
}

export async function dispatchAdminEditTool(c: Context<Env>, user: User, toolName: string, args: any): Promise<ToolResult | null> {
    const db = c.env.DB;
    const rbac = c.get('rbac') as RBAC;
    // 같은 이유 — 모든 편집 도구가 mcp_drafts 의 새 컬럼을 직간접적으로 사용하므로 진입 시 보장.
    await ensureMcpDraftsMigration(db);

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
        if (slug.startsWith('map:')) return asTextResult('Error: "map:" 네임스페이스는 가상 트리 뷰 전용이므로 편집할 수 없습니다.', true);        if (typeof args.content !== 'string') return asTextResult('Error: content 는 문자열이어야 합니다.', true);
        if (args.category && typeof args.category === 'string') {
            if (!/^[가-힣a-zA-Z0-9\s,]+$/.test(args.category)) {
                return asTextResult('Error: category 에는 특수문자를 사용할 수 없습니다.', true);
            }
        }

        const content = args.content.replace(/\r\n?/g, '\n');
        const category = (args.category && typeof args.category === 'string') ? args.category : null;
        const redirectTo = (args.redirect_to && typeof args.redirect_to === 'string') ? args.redirect_to : null;
        const createOnly = args.create_only === true;

        // 대체 표시 제목(display_title): args 에 키가 명시되어 있을 때만 변경 의도로 해석. (undefined = 기존 유지)
        // MCP 컨벤션 상 args.title 은 슬러그를 가리키므로, 표시용 대체 제목은 별도의 display_title 키로 받는다.
        // 잘못된 타입은 string|null 외 모두 거부 — 조용한 데이터 손실(null 로 정규화 후 삭제) 방지.
        const hasTitleChange = Object.prototype.hasOwnProperty.call(args, 'display_title');
        if (hasTitleChange && args.display_title !== null && typeof args.display_title !== 'string') {
            return asTextResult('Error: display_title 은 문자열 또는 null 이어야 합니다.', true);
        }
        const requestedTitle = hasTitleChange ? normalizeTitleInput(args.display_title) : null;
        if (hasTitleChange && requestedTitle !== null) {
            if (TITLE_FORBIDDEN_CHARS.test(requestedTitle)) {
                return asTextResult('Error: 대체 제목에 제어문자는 사용할 수 없습니다.', true);
            }
            if (requestedTitle.length > TITLE_MAX_LENGTH) {
                return asTextResult(`Error: 대체 제목은 ${TITLE_MAX_LENGTH}자 이하여야 합니다.`, true);
            }
        }

        const existing = await db
            .prepare('SELECT id, version, last_revision_id, category, title FROM pages WHERE slug = ? AND deleted_at IS NULL')
            .bind(slug)
            .first<{ id: number; version: number; last_revision_id: number | null; category: string | null; title: string | null }>();

        // 신규 title 이 다른 페이지의 slug 또는 title 과 충돌하면 거부. 소프트 삭제 행도 포함.
        if (hasTitleChange && requestedTitle) {
            const selfId = existing?.id ?? null;
            const conflict = await findConflictingPage(db, requestedTitle, selfId);
            if (conflict) {
                const deletedSuffix = conflict.isDeleted ? ' (소프트 삭제 상태 — 관리자 복원 또는 영구 삭제 필요)' : '';
                const msg = conflict.matchedColumn === 'slug'
                    ? `Error: '${requestedTitle}' 는 이미 다른 문서의 슬러그로 사용 중입니다.${deletedSuffix}`
                    : `Error: '${requestedTitle}' 는 이미 다른 문서의 대체 제목으로 사용 중입니다.${deletedSuffix}`;
                return asTextResult(msg, true);
            }
        }

        // 신규 슬러그가 다른 문서의 title 과 충돌하는지 검사 (생성 흐름 한정).
        if (!existing) {
            const slugTitleConflict = await findConflictingPage(db, slug, null);
            if (slugTitleConflict && slugTitleConflict.matchedColumn === 'title') {
                const deletedSuffix = slugTitleConflict.isDeleted ? ' (소프트 삭제 상태)' : '';
                return asTextResult(`Error: '${slug}' 는 이미 다른 문서의 대체 제목과 같아 슬러그로 사용할 수 없습니다.${deletedSuffix}`, true);
            }
        }

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
        // edit_acl 검사 — admin_only 가 없으면 관리자 우회. admin_only 가 있으면 evaluate 단계에서 관리자도 통과/거부 판정.
        // 기존 페이지는 page.edit_acl, 신규는 prefix 룰 ACL.
        {
            const aclErr = await enforceMcpEditAcl(db, user, rbac, existing ? { id: existing.id } : null, existing ? null : slug);
            if (aclErr) return asTextResult('Error: ' + aclErr, true);
        }

        const action = existing ? 'update' : 'create';
        const baseRevisionId = existing ? existing.last_revision_id : null;
        const baseVersion = existing ? existing.version : 0;

        // 본인의 같은 슬러그 draft 가 이미 있으면 본문/메타데이터를 통째로 교체한다.
        // base_revision_id / base_version 은 보존 — 처음 begin 한 시점의 페이지 상태로 충돌
        // 검증을 해야 의미 있다. 이 호출이 page 가 그 사이 바뀌었는지를 다시 캡처하면
        // 충돌 감지가 무력화된다.
        // 단 submitted_at IS NOT NULL → 이미 승인 대기로 제출된 상태이므로 본문 교체 불가.
        const existingDraft = await db.prepare(
            'SELECT id, action, base_revision_id, base_version, submitted_at FROM mcp_drafts WHERE user_id = ? AND slug = ?'
        ).bind(user.id, slug).first<{ id: number; action: string; base_revision_id: number | null; base_version: number; submitted_at: number | null }>();
        if (existingDraft && existingDraft.submitted_at !== null) {
            return asTextResult('Error: 이 draft 는 이미 승인 대기로 제출된 상태입니다. 사용자가 mypage 에서 승인/거부할 때까지 수정할 수 없습니다. 폐기하려면 discard_edit 를 사용하세요.', true);
        }

        // draft 단계의 title 저장: hasTitleChange 가 true 일 때만 적용. (false 면 commit 시점에 페이지 기존 title 유지)
        // 기존 draft 갱신 시 display_title 키가 누락된 호출은 이전에 스테이지된 title 변경을 그대로
        // 보존해야 한다 — 후속 patch/edit 호출에서 title 의도가 조용히 지워지는 문제를 막는다.
        const draftHasTitleChange = hasTitleChange ? 1 : 0;
        const draftTitleValue = hasTitleChange ? requestedTitle : null;

        let draftId: number;
        if (existingDraft) {
            if (hasTitleChange) {
                await db.prepare(
                    `UPDATE mcp_drafts
                     SET content = ?, category = ?, redirect_to = ?,
                         title = ?, has_title_change = ?, updated_at = unixepoch()
                     WHERE id = ?`
                ).bind(content, category, redirectTo, draftTitleValue, draftHasTitleChange, existingDraft.id).run();
            } else {
                // display_title 미지정: 기존 draft 의 title / has_title_change 그대로 유지.
                await db.prepare(
                    `UPDATE mcp_drafts
                     SET content = ?, category = ?, redirect_to = ?, updated_at = unixepoch()
                     WHERE id = ?`
                ).bind(content, category, redirectTo, existingDraft.id).run();
            }
            draftId = existingDraft.id;
        } else {
            const ins = await db.prepare(
                `INSERT INTO mcp_drafts (user_id, slug, action, base_revision_id, base_version, content, category, redirect_to, title, has_title_change)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(user.id, slug, action, baseRevisionId, baseVersion, content, category, redirectTo, draftTitleValue, draftHasTitleChange).run();
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
        if (slug.startsWith('map:')) return asTextResult('Error: "map:" 네임스페이스는 가상 트리 뷰 전용이므로 편집할 수 없습니다.', true);        if (typeof args.old_string !== 'string' || args.old_string.length === 0) {
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
        if (loaded.type === 'submitted') {
            return asTextResult('Error: 이 draft 는 이미 승인 대기로 제출된 상태입니다. 사용자가 mypage 에서 승인/거부할 때까지 수정할 수 없습니다. 폐기하려면 discard_edit 를 사용하세요.', true);
        }
        // edit_acl 검사 — 기존 페이지가 있을 때만. draft 만 있는 케이스도 일치하는 페이지를 다시 조회한다.
        {
            const pageRow = loaded.page
                ? { id: loaded.page.id }
                : await db.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL')
                    .bind(slug)
                    .first<{ id: number }>();
            if (pageRow) {
                const aclErr = await enforceMcpEditAcl(db, user, rbac, pageRow, null);
                if (aclErr) return asTextResult('Error: ' + aclErr, true);
            }
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
                `INSERT INTO mcp_drafts (user_id, slug, action, base_revision_id, base_version, content, category, redirect_to)
                 VALUES (?, ?, 'update', ?, ?, ?, ?, ?)`
            ).bind(
                user.id, slug, loaded.page!.last_revision_id, loaded.page!.version,
                newContent, loaded.page!.category, loaded.page!.redirect_to
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
        if (slug.startsWith('map:')) return asTextResult('Error: "map:" 네임스페이스는 가상 트리 뷰 전용이므로 편집할 수 없습니다.', true);        const sectionNumber = String(args.section_number || '').trim();
        if (!sectionNumber) return asTextResult('Error: section_number 가 필요합니다.', true);
        if (typeof args.new_content !== 'string') {
            return asTextResult('Error: new_content 는 문자열이어야 합니다.', true);
        }

        const newSectionContent = (args.new_content as string).replace(/\r\n?/g, '\n');

        const loaded = await loadDraftOrSeedFromPage(c, user, slug);
        if (loaded.type === 'not_found') {
            return asTextResult('Error: 문서를 찾을 수 없거나 삭제된 상태입니다. 새 페이지는 create_or_update_page 로 시작하세요.', true);
        }
        if (loaded.type === 'submitted') {
            return asTextResult('Error: 이 draft 는 이미 승인 대기로 제출된 상태입니다. 사용자가 mypage 에서 승인/거부할 때까지 수정할 수 없습니다. 폐기하려면 discard_edit 를 사용하세요.', true);
        }
        // edit_acl 검사 — 기존 페이지가 있을 때만 (draft 만 있는 케이스도 일치 페이지 재조회).
        {
            const pageRow = loaded.page
                ? { id: loaded.page.id }
                : await db.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL')
                    .bind(slug)
                    .first<{ id: number }>();
            if (pageRow) {
                const aclErr = await enforceMcpEditAcl(db, user, rbac, pageRow, null);
                if (aclErr) return asTextResult('Error: ' + aclErr, true);
            }
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
                `INSERT INTO mcp_drafts (user_id, slug, action, base_revision_id, base_version, content, category, redirect_to)
                 VALUES (?, ?, 'update', ?, ?, ?, ?, ?)`
            ).bind(
                user.id, slug, loaded.page!.last_revision_id, loaded.page!.version,
                newContent, loaded.page!.category, loaded.page!.redirect_to
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
                    content, category, redirect_to, title, has_title_change, submitted_at
             FROM mcp_drafts WHERE id = ?`
        ).bind(draftId).first<{
            id: number; user_id: number; slug: string; action: string;
            base_revision_id: number | null; base_version: number; content: string;
            category: string | null; redirect_to: string | null;
            title: string | null; has_title_change: number;
            submitted_at: number | null;
        }>();
        if (!draft) return asTextResult('Error: draft 를 찾을 수 없습니다 (이미 commit/discard 됐거나 12시간 TTL 만료).', true);
        if (draft.user_id !== user.id) return asTextResult('Error: 다른 사용자의 draft 는 commit 할 수 없습니다.', true);
        // 이미 승인 대기로 제출된 draft 는 사람이 검토 중이므로 AI 가 재제출/재커밋 불가.
        // 다시 편집하려면 사람이 거부(reject) 하거나 AI 가 discard_edit 후 새로 시작.
        if (draft.submitted_at !== null) {
            return asTextResult(
                'Error: 이 draft 는 이미 승인 대기로 제출된 상태입니다. 사용자가 mypage 에서 승인/거부할 때까지 변경할 수 없습니다. 폐기하려면 discard_edit 를 사용하세요.',
                true
            );
        }

        const slug = draft.slug;

        if (draft.action === 'update') {
            const page = await db.prepare(
                'SELECT id, version, content, category, last_revision_id, title FROM pages WHERE slug = ? AND deleted_at IS NULL'
            ).bind(slug).first<{ id: number; version: number; content: string; category: string | null; last_revision_id: number | null; title: string | null }>();
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

            // edit_acl 최종 검사 (commit 시점 — race 안전망, admin_only 포함).
            {
                const aclErr = await enforceMcpEditAcl(db, user, rbac, { id: page.id }, null);
                if (aclErr) return asTextResult('Error: ' + aclErr, true);
            }

            // draft 가 title 변경을 요청한 경우, 즉시 커밋 시점에 다른 페이지가 그 title 을
            // 이미 가져갔는지 재검증 — idx_pages_title_unique UNIQUE 위반으로 R2/revision 쓰기 후
            // 무특정 실패가 나는 것을 방지.
            if (draft.has_title_change && draft.title) {
                const titleConflict = await findConflictingPage(db, draft.title, page.id);
                if (titleConflict) {
                    const deletedSuffix = titleConflict.isDeleted ? ' (소프트 삭제 상태)' : '';
                    return asTextResult(
                        titleConflict.matchedColumn === 'slug'
                            ? `Error: '${draft.title}' 는 이미 다른 문서의 슬러그입니다.${deletedSuffix}`
                            : `Error: '${draft.title}' 는 이미 다른 문서의 대체 제목입니다.${deletedSuffix}`,
                        true,
                    );
                }
            }

            // commit 직후 diff 통계(+추가/-삭제 라인)를 응답에 포함하기 위해 이전 본문을 로드한다.
            // R2 전용 네임스페이스 페이지는 pages.content 가 빈 문자열로 저장되므로, 마지막 리비전을 R2 에서 읽어온다.
            // CRLF→LF 정규화 후 비교해 줄바꿈 형식 차이로 인한 가짜 변경을 제거한다.
            // ⚠️ 이전 본문 로드(D1/R2)가 실패하더라도 본 commit 자체는 막지 않는다 — 새 본문은 이미 검증되어
            // 저장 가능한 상태이며, diff 통계는 부수 정보일 뿐이다. 실패 시 마커/응답 필드만 생략한다.
            const enabledExtForDiff = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
            let diffStats: { added: number; removed: number } | null = null;
            try {
                let prevContent = page.content || '';
                if (isR2OnlyNamespace(slug, enabledExtForDiff) && prevContent === '' && page.last_revision_id) {
                    const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?')
                        .bind(page.last_revision_id)
                        .first<{ content: string; r2_key: string | null }>();
                    if (lastRev) {
                        prevContent = await getRevisionContent(c.env.MEDIA, lastRev, new URL(c.req.url).origin);
                    }
                }
                diffStats = computeLineDiffStats(
                    prevContent.replace(/\r\n?/g, '\n'),
                    draft.content.replace(/\r\n?/g, '\n')
                );
            } catch (e) {
                console.error('admin-mcp commit_edit diff stats failed (commit will proceed without marker):', e);
                diffStats = null;
            }
            // 즉시 리비전을 만들지 않고 본인(OAuth 토큰 소유자) 의 승인 대기로 제출한다.
            // 잠금/충돌 검증은 이미 통과한 상태이므로 같은 정책으로 mypage 에서 다시 확인된다.
            const submittedAtRow = await markDraftSubmittedAndNotify(c, draft.id, slug, summary);
            if (!submittedAtRow) {
                return asTextResult(
                    'Error: 이 draft 는 이미 승인 대기로 제출된 상태입니다 (동시 호출 race).',
                    true
                );
            }
            return asTextResult(JSON.stringify({
                slug,
                submitted: true,
                submitted_at: submittedAtRow.iso,
                draft_id: draft.id,
                action: 'update',
                base_revision_id: draft.base_revision_id,
                base_version: draft.base_version,
                ...(diffStats ? { lines_added: diffStats.added, lines_removed: diffStats.removed } : {}),
                notice: '승인 대기로 제출되었습니다. /mypage#mcp-submissions 에서 검토 후 승인하면 비로소 리비전이 생성됩니다.',
            }, null, 2));
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

            // 신규 슬러그 자체 또는 draft 가 변경 요청한 title 이 다른 페이지와 충돌하는지 재검증.
            // (draft 작성 시점 검사만으로는 race 를 막을 수 없고 UNIQUE 위반으로 무특정 500 이 나올 수 있다.)
            const slugTitleConflict = await findConflictingPage(db, slug, null);
            if (slugTitleConflict && slugTitleConflict.matchedColumn === 'title') {
                return asTextResult(
                    `Error: '${slug}' 는 다른 문서의 대체 제목과 충돌해 슬러그로 사용할 수 없습니다.`,
                    true,
                );
            }
            if (draft.has_title_change && draft.title) {
                const titleConflict = await findConflictingPage(db, draft.title, null);
                if (titleConflict) {
                    return asTextResult(
                        titleConflict.matchedColumn === 'slug'
                            ? `Error: '${draft.title}' 는 이미 다른 문서의 슬러그입니다.`
                            : `Error: '${draft.title}' 는 이미 다른 문서의 대체 제목입니다.`,
                        true,
                    );
                }
            }

            // edit_acl 최종 검사 — 신규 문서: prefix 룰 ACL.
            // 평가 통과한 ACL 은 새 페이지에 그대로 기록해, 생성 이후 편집도 같은 정책을 적용한다.
            // (관리자: enforceMcpEditAcl 가 즉시 통과시키지만, prefix 룰은 관리자 생성 페이지에도
            // 동일하게 자동 적용되는 것이 /api/w/:slug 흐름과 일관된다.)
            let createEditAclSerialized: string | null = null;
            {
                const aclErr = await enforceMcpEditAcl(db, user, rbac, null, slug);
                if (aclErr) return asTextResult('Error: ' + aclErr, true);
                const prefixAcl = await findPrefixRuleEditAcl(db, slug);
                if (prefixAcl && prefixAcl.flags.length > 0) {
                    createEditAclSerialized = serializeEditAcl(prefixAcl);
                }
            }

            // 신규 페이지는 이전 본문이 없으므로 모든 라인이 추가로 카운트된다.
            // 빈 본문 입력에서는 computeLineDiffStats 가 DP 를 거치지 않고 즉시 반환하지만,
            // 시그니처상 null 가능성이 있으므로 동일하게 fallback 처리한다.
            const createDiffStats = computeLineDiffStats('', draft.content.replace(/\r\n?/g, '\n'));

            const submittedAtRow = await markDraftSubmittedAndNotify(c, draft.id, slug, summary);
            if (!submittedAtRow) {
                return asTextResult(
                    'Error: 이 draft 는 이미 승인 대기로 제출된 상태입니다 (동시 호출 race).',
                    true
                );
            }
            return asTextResult(JSON.stringify({
                slug,
                submitted: true,
                submitted_at: submittedAtRow.iso,
                draft_id: draft.id,
                action: 'create',
                ...(createDiffStats ? { lines_added: createDiffStats.added, lines_removed: createDiffStats.removed } : {}),
                notice: '승인 대기로 제출되었습니다. /mypage#mcp-submissions 에서 검토 후 승인하면 비로소 새 페이지가 생성됩니다.',
            }, null, 2));
        }

        return asTextResult(`Error: 알 수 없는 draft action: ${draft.action}`, true);
    }

    if (toolName === 'discard_edit') {
        const draftId = Number(args.draft_id);
        if (!Number.isFinite(draftId) || draftId <= 0) {
            return asTextResult('Error: draft_id 는 양의 정수여야 합니다.', true);
        }
        const draft = await db.prepare('SELECT id, user_id, slug, submitted_at FROM mcp_drafts WHERE id = ?')
            .bind(draftId).first<{ id: number; user_id: number; slug: string; submitted_at: number | null }>();
        if (!draft) return asTextResult('Error: draft 를 찾을 수 없습니다 (이미 commit/discard 됐거나 TTL 만료).', true);
        if (draft.user_id !== user.id) return asTextResult('Error: 다른 사용자의 draft 는 discard 할 수 없습니다.', true);
        // 승인 대기 상태였다면 알림도 같이 정리한다 — mypage 목록에서 사라지므로 알림만 남으면 dead link 가 된다.
        await db.batch([
            db.prepare("DELETE FROM notifications WHERE type = 'mcp_submission' AND ref_id = ?").bind(draftId),
            db.prepare('DELETE FROM mcp_drafts WHERE id = ?').bind(draftId),
        ]);
        return asTextResult(JSON.stringify({
            draft_id: draftId,
            slug: draft.slug,
            discarded: true,
            was_submitted: draft.submitted_at !== null,
        }, null, 2));
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
            .prepare('SELECT id, version, content, category FROM pages WHERE slug = ? AND deleted_at IS NULL')
            .bind(slug)
            .first<{ id: number; version: number; content: string; category: string | null }>();
        if (!page) return asTextResult('Error: 문서를 찾을 수 없거나 삭제된 상태입니다.', true);

        // edit_acl 검사 — 되돌리기도 편집의 일종. admin_only 가 있으면 비관리자 차단.
        {
            const aclErr = await enforceMcpEditAcl(db, user, rbac, { id: page.id }, null);
            if (aclErr) return asTextResult('Error: ' + aclErr, true);
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
                slug,
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
                // source_type='page' + blog=0 양쪽 — legacy 블로그 행 (source_type='page' + blog=1)
                // 이 같은 id 일 때 잘못 삭제되지 않도록.
                db.prepare(
                    "DELETE FROM page_links WHERE source_page_id = ? AND source_type = 'page' AND blog = 0"
                ).bind(page.id),
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
        if (slug.startsWith('이미지:')) return asTextResult('Error: "이미지:" 네임스페이스는 일반 문서로 복원할 수 없습니다.', true);
        if (slug.startsWith('map:')) return asTextResult('Error: "map:" 네임스페이스는 가상 트리 뷰 전용이므로 복원할 수 없습니다.', true);

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
        if (oldSlug.startsWith('map:') || newSlug.startsWith('map:')) {
            return asTextResult('Error: "map:" 네임스페이스는 가상 트리 뷰 전용이므로 이동 대상이 될 수 없습니다.', true);
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
            .prepare('SELECT id, version, content, category, last_revision_id, edit_acl FROM pages WHERE slug = ? AND deleted_at IS NULL')
            .bind(oldSlug)
            .first<{ id: number; version: number; content: string; category: string | null; last_revision_id: number | null; edit_acl: string | null }>();
        if (!page) return asTextResult('Error: 문서를 찾을 수 없거나 삭제된 상태입니다.', true);

        // admin_only ACL 문서 이동은 관리자만 가능 (구 wiki:lock 검사 대체).
        const movePageIsAdmin = rbac.can(user.role, 'admin:access');
        if (!movePageIsAdmin) {
            const aclMove = parseEditAcl(page.edit_acl);
            if (aclMove && aclMove.flags.includes('admin_only')) {
                return asTextResult('Error: 관리자 전용 문서는 관리자만 이동할 수 있습니다.', true);
            }
        }

        // 새 슬러그가 다른 문서의 slug 또는 title 과 충돌하는지 검사. 소프트 삭제 행도 포함.
        const moveConflict = await findConflictingPage(db, newSlug, page.id);
        if (moveConflict) {
            const deletedSuffix = moveConflict.isDeleted ? ' (소프트 삭제 상태)' : '';
            const msg = moveConflict.matchedColumn === 'slug'
                ? `Error: 새 슬러그가 이미 존재합니다.${deletedSuffix}`
                : `Error: '${newSlug}' 는 이미 다른 문서의 대체 제목과 같아 사용할 수 없습니다.${deletedSuffix}`;
            return asTextResult(msg, true);
        }

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

        try {
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
                const metrics = computePageMetricsTracked(rewritten, newIsR2Only);
                try {
                    await db
                        .prepare('UPDATE pages SET slug = ?, content = ?, last_revision_id = ?, version = ?, rows = ?, characters = ?, updated_at = unixepoch() WHERE id = ?')
                        .bind(newSlug, contentToStore, newRevisionId, newVersion, metrics.rows, metrics.characters, page.id)
                        .run();
                } catch (e) {
                    // 트리거/UNIQUE 위반 시 막 만든 리비전 + R2 객체 정리.
                    await db.prepare('DELETE FROM revisions WHERE id = ?').bind(newRevisionId).run().catch(() => {});
                    await c.env.MEDIA.delete(r2Key).catch(() => {});
                    throw e;
                }
                const linkCatStmts = buildLinkAndCategoryStatements(db, page.id, rewritten, page.category);
                c.executionCtx.waitUntil(db.batch(linkCatStmts).catch(e => console.error('admin-mcp move link/cat batch failed:', e)));
            } else {
                await db.prepare('UPDATE pages SET slug = ?, updated_at = unixepoch() WHERE id = ?').bind(newSlug, page.id).run();
            }
        } catch (e: any) {
            const msg = String(e?.message || e);
            if (/UNIQUE|constraint/i.test(msg)) {
                return asTextResult('Error: 새 슬러그가 다른 문서와 충돌합니다. 다시 시도해주세요.', true);
            }
            throw e;
        }

        const updatedSlugs: string[] = [];
        const skippedLockedSlugs: string[] = [];
        if (updateBacklinks) {
            const { results: backlinks } = await db
                .prepare(`
                    SELECT DISTINCT p.id, p.slug, p.version, p.content, p.category, p.last_revision_id, p.edit_acl
                    FROM page_links pl
                    JOIN pages p ON pl.source_page_id = p.id
                    WHERE pl.blog = 0 AND pl.source_type = 'page'
                      AND pl.link_type IN ('wikilink', 'template', 'extension')
                      AND pl.target_slug = ? AND p.deleted_at IS NULL AND p.id != ?
                `)
                .bind(oldSlug, page.id)
                .all<{ id: number; slug: string; version: number; content: string; category: string | null; last_revision_id: number | null; edit_acl: string | null }>();

            for (const bl of backlinks) {
                // admin_only ACL 역링크 문서는 관리자만 재작성 가능 (구 wiki:lock 검사 대체).
                if (!movePageIsAdmin) {
                    const blAcl = parseEditAcl(bl.edit_acl);
                    if (blAcl && blAcl.flags.includes('admin_only')) {
                        skippedLockedSlugs.push(bl.slug);
                        continue;
                    }
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
                const blMetrics = computePageMetricsTracked(blRewritten, blIsR2);
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

    // ────────────────────────────────────────────────────────────────
    // 블로그 CRUD (admin 전용, 즉시 적용 — draft 모델 미사용).
    // routes/blog.ts 의 POST/PUT/DELETE /api/blog 엔드포인트와 동일한 동작을 수행한다.
    // ────────────────────────────────────────────────────────────────

    if (toolName === 'create_blog_post' || toolName === 'update_blog_post'
        || toolName === 'delete_blog_post' || toolName === 'restore_blog_post') {
        if (!rbac.can(user.role, 'admin:access')) {
            return asTextResult('Error: admin:access 권한이 필요합니다.', true);
        }
    }

    if (toolName === 'create_blog_post') {
        if (typeof args.title !== 'string') return asTextResult('Error: title 은 문자열이어야 합니다.', true);
        if (typeof args.content !== 'string') return asTextResult('Error: content 는 문자열이어야 합니다.', true);
        const title = args.title.trim();
        if (!title) return asTextResult('Error: 제목을 입력해주세요.', true);
        if (title.length > 500) return asTextResult('Error: 제목은 500자 이내여야 합니다.', true);

        // routes/blog.ts 와 동일하게 CRLF → LF 정규화. 줄 수/글자 수도 동일 기준으로 계산.
        const content = (args.content as string).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const rows = content ? content.split('\n').length : 0;
        const characters = content ? content.length : 0;
        const thumbnail = extractFirstThumbnail(content);

        const result = await db
            .prepare('INSERT INTO blog_posts (title, content, rows, characters, thumbnail) VALUES (?, ?, ?, ?, ?)')
            .bind(title, content, rows, characters, thumbnail)
            .run();
        const newId = Number(result.meta?.last_row_id || 0);
        if (!newId) return asTextResult('Error: 저장 실패', true);

        c.executionCtx.waitUntil(rebuildBlogImageLinks(db, newId, content));
        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind('blog_create', `[admin-mcp] 블로그 작성: ${title}`, user.id)
                .run().catch((e: any) => console.error('admin-mcp blog_create admin_log write failed:', e))
        );

        return asTextResult(JSON.stringify({
            id: newId,
            title,
            rows,
            characters,
            thumbnail,
            created: true,
        }, null, 2));
    }

    if (toolName === 'update_blog_post') {
        const id = Number(args.id);
        if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
            return asTextResult('Error: id 는 양의 정수여야 합니다.', true);
        }
        const wantsTitle = args.title !== undefined;
        const wantsContent = args.content !== undefined;
        if (!wantsTitle && !wantsContent) {
            return asTextResult('Error: title 또는 content 중 하나 이상을 지정해야 합니다.', true);
        }
        if (wantsTitle && typeof args.title !== 'string') {
            return asTextResult('Error: title 은 문자열이어야 합니다.', true);
        }
        if (wantsContent && typeof args.content !== 'string') {
            return asTextResult('Error: content 는 문자열이어야 합니다.', true);
        }

        const existing = await db
            .prepare('SELECT id, title FROM blog_posts WHERE id = ? AND deleted_at IS NULL')
            .bind(id)
            .first<{ id: number; title: string }>();
        if (!existing) return asTextResult('Error: 블로그 포스트를 찾을 수 없거나 삭제된 상태입니다.', true);

        const newTitle = wantsTitle ? (args.title as string).trim() : existing.title;
        if (!newTitle) return asTextResult('Error: 제목을 입력해주세요.', true);
        if (newTitle.length > 500) return asTextResult('Error: 제목은 500자 이내여야 합니다.', true);

        if (wantsContent) {
            const content = (args.content as string).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            const rows = content ? content.split('\n').length : 0;
            const characters = content ? content.length : 0;
            const thumbnail = extractFirstThumbnail(content);

            await db.prepare(
                'UPDATE blog_posts SET title = ?, content = ?, rows = ?, characters = ?, thumbnail = ?, updated_at = unixepoch() WHERE id = ?'
            ).bind(newTitle, content, rows, characters, thumbnail, id).run();
            c.executionCtx.waitUntil(rebuildBlogImageLinks(db, id, content));

            c.executionCtx.waitUntil(
                db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                    .bind('blog_update', `[admin-mcp] 블로그 수정: ${newTitle}`, user.id)
                    .run().catch((e: any) => console.error('admin-mcp blog_update admin_log write failed:', e))
            );

            return asTextResult(JSON.stringify({
                id, title: newTitle, rows, characters, thumbnail,
                content_updated: true,
            }, null, 2));
        }

        // title 만 변경.
        await db.prepare(
            'UPDATE blog_posts SET title = ?, updated_at = unixepoch() WHERE id = ?'
        ).bind(newTitle, id).run();
        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind('blog_update', `[admin-mcp] 블로그 수정: ${newTitle}`, user.id)
                .run().catch((e: any) => console.error('admin-mcp blog_update admin_log write failed:', e))
        );
        return asTextResult(JSON.stringify({
            id, title: newTitle, content_updated: false,
        }, null, 2));
    }

    if (toolName === 'delete_blog_post') {
        const id = Number(args.id);
        if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
            return asTextResult('Error: id 는 양의 정수여야 합니다.', true);
        }
        const existing = await db
            .prepare('SELECT id, title, deleted_at FROM blog_posts WHERE id = ?')
            .bind(id)
            .first<{ id: number; title: string; deleted_at: number | null }>();
        if (!existing) return asTextResult('Error: 블로그 포스트를 찾을 수 없습니다.', true);
        if (existing.deleted_at) return asTextResult('Error: 이미 삭제된 포스트입니다.', true);

        await db.prepare('UPDATE blog_posts SET deleted_at = unixepoch() WHERE id = ?').bind(id).run();

        // 역링크 정리 — routes/blog.ts 의 DELETE /api/blog/:id 와 동일 (blog=1 로 legacy 호환).
        c.executionCtx.waitUntil(
            db.prepare('DELETE FROM page_links WHERE source_page_id = ? AND blog = 1')
                .bind(id).run()
                .catch((e: any) => console.error('admin-mcp blog page_links cleanup failed:', e))
        );

        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind('blog_delete', `[admin-mcp] 블로그 삭제: ${existing.title}`, user.id)
                .run().catch((e: any) => console.error('admin-mcp blog_delete admin_log write failed:', e))
        );

        // 공지로 발행되어 있던 포스트가 삭제되면 해당 공지도 자동 제거. routes/blog.ts 와 동일.
        c.executionCtx.waitUntil(
            removeAnnouncementByPostId(db, id)
                .catch((e: any) => console.error('admin-mcp blog announcement clear failed:', e))
        );

        return asTextResult(JSON.stringify({ id, title: existing.title, deleted: true }, null, 2));
    }

    if (toolName === 'restore_blog_post') {
        const id = Number(args.id);
        if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
            return asTextResult('Error: id 는 양의 정수여야 합니다.', true);
        }
        const existing = await db
            .prepare('SELECT id, title, content, deleted_at FROM blog_posts WHERE id = ?')
            .bind(id)
            .first<{ id: number; title: string; content: string; deleted_at: number | null }>();
        if (!existing) return asTextResult('Error: 블로그 포스트를 찾을 수 없습니다.', true);
        if (!existing.deleted_at) return asTextResult('Error: 삭제 상태가 아닌 포스트입니다.', true);

        await db.prepare('UPDATE blog_posts SET deleted_at = NULL, updated_at = unixepoch() WHERE id = ?').bind(id).run();

        // delete_blog_post 가 page_links 를 비웠으므로 본문 기준으로 다시 채워둔다.
        c.executionCtx.waitUntil(rebuildBlogImageLinks(db, id, existing.content || ''));

        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind('blog_restore', `[admin-mcp] 블로그 복원: ${existing.title}`, user.id)
                .run().catch((e: any) => console.error('admin-mcp blog_restore admin_log write failed:', e))
        );

        return asTextResult(JSON.stringify({ id, title: existing.title, restored: true }, null, 2));
    }

    if (toolName === 'set_page_status') {
        const slug = String(args.title || '').trim();
        if (!slug) return asTextResult('Error: title 이 필요합니다.', true);

        if (typeof args.category !== 'string') {
            return asTextResult('Error: category 를 지정해야 합니다.', true);
        }

        // 이미지 네임스페이스는 별도 미디어 문서이므로 admin-mcp 메타 변경에서도 제외한다.
        if (slug.startsWith('이미지:')) {
            return asTextResult('Error: "이미지:" 네임스페이스는 admin-mcp 로 상태를 변경할 수 없습니다.', true);
        }
        // map 네임스페이스는 가상 트리 뷰 전용이므로 메타 변경 대상이 아니다.
        if (slug.startsWith('map:')) {
            return asTextResult('Error: "map:" 네임스페이스는 가상 트리 뷰 전용이므로 상태를 변경할 수 없습니다.', true);
        }

        const trimmedCategory = (args.category as string).trim();
        const newCategory = trimmedCategory ? trimmedCategory : null;
        if (newCategory && !/^[가-힣a-zA-Z0-9\s,]+$/.test(newCategory)) {
            return asTextResult('Error: category 에는 특수문자를 사용할 수 없습니다.', true);
        }

        const page = await db
            .prepare('SELECT id, category, edit_acl FROM pages WHERE slug = ? AND deleted_at IS NULL')
            .bind(slug)
            .first<{ id: number; category: string | null; edit_acl: string | null }>();
        if (!page) return asTextResult('Error: 문서를 찾을 수 없거나 삭제된 상태입니다.', true);

        // admin_only ACL 문서의 메타데이터 변경은 관리자만 가능 (구 wiki:lock 검사 대체).
        if (!rbac.can(user.role, 'admin:access')) {
            const aclSet = parseEditAcl(page.edit_acl);
            if (aclSet && aclSet.flags.includes('admin_only')) {
                return asTextResult('Error: 관리자 전용 문서의 상태는 관리자만 변경할 수 있습니다.', true);
            }
        }

        const finalCategory = newCategory;
        const categoryChanged = (finalCategory ?? null) !== (page.category ?? null);

        if (!categoryChanged) {
            return asTextResult(JSON.stringify({ slug, changed: false, note: '요청된 카테고리가 이미 현재 값과 동일합니다.', category: finalCategory }, null, 2));
        }

        // pages.category 와 page_categories 인덱스를 한 batch 로 묶어 트랜잭션으로 적용한다.
        // 분리해서 쓰면 두 번째 쓰기가 실패할 때 메타데이터와 카테고리 인덱스가 불일치하게 된다.
        // 본문은 손대지 않으므로 page_links 는 재구성하지 않는다 (링크 추출은 본문에서만 이루어짐).
        const txStmts: D1PreparedStatement[] = [
            db.prepare('UPDATE pages SET category = ?, updated_at = unixepoch() WHERE id = ?').bind(finalCategory, page.id),
            db.prepare('DELETE FROM page_categories WHERE page_id = ?').bind(page.id),
        ];
        if (finalCategory) {
            const cats = finalCategory.split(',').map(s => s.trim()).filter(Boolean);
            for (const cat of cats) {
                txStmts.push(
                    db.prepare('INSERT OR IGNORE INTO page_categories (page_id, category) VALUES (?, ?)')
                        .bind(page.id, cat)
                );
            }
        }
        await db.batch(txStmts);

        const changeDesc = `category: ${page.category ?? '(없음)'} → ${finalCategory ?? '(없음)'}`;

        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind('page_status', `[admin-mcp] 문서 상태 변경: ${slug} (${changeDesc})`, user.id)
                .run().catch((e: any) => console.error('admin-mcp set_page_status admin_log write failed:', e))
        );

        c.executionCtx.waitUntil(Promise.allSettled([
            invalidatePageCache(c, slug),
            refreshRecentChangesCache(c),
            invalidateBacklinkCaches(c, slug, db),
        ]));

        return asTextResult(JSON.stringify({ slug, changed: true, changes: [changeDesc], category: finalCategory }, null, 2));
    }

    return null;
}

// 일반 유저(`wiki:edit`) 에게 추가로 노출되는 도구 묶음 (읽기 + draft 편집 + revert).
export const USER_TOOL_DEFS: McpToolDef[] = [
    ...USER_READ_TOOL_DEFS,
    ...USER_EDIT_TOOL_DEFS,
];

// 관리자(`admin:access`) 에게만 추가 노출되는 도구 묶음.
export const ADMIN_ONLY_TOOL_DEFS: McpToolDef[] = [
    ...ADMIN_ONLY_READ_TOOL_DEFS,
    ...ADMIN_ONLY_EDIT_TOOL_DEFS,
];

// /api/mcp 의 information 도구가 일반 유저(`wiki:edit`) 에게 추가로 덧붙여 보여줄 가이드.
// 관리자에게도 동일하게 노출된다.
export function buildUserEditInformationSuffix(userName: string): string {
    const readIntro = `\n\n## 편집 보조 읽기 도구 (현재 인증된 사용자: ${userName})\n${USER_READ_TOOL_DEFS.map(t => `- ${t.name}`).join('\n')}`;
    const editIntro = `\n\n## 편집 도구\n\n` +
        `**stateful draft 모델**: create_or_update_page / patch_page / edit_section 은 즉시 저장하지 않고 \`mcp_drafts\` 에 누적합니다 ` +
        `(같은 슬러그에 대해 사용자별 1개). 응답으로 \`draft_id\` 를 받고, 편집이 끝나면 commit_edit(draft_id, summary) 를 호출해 ` +
        `승인 대기로 제출합니다 — 사용자가 /mypage#mcp-submissions 에서 승인해야 비로소 리비전이 생성됩니다. 시작 시점 이후 다른 사용자가 페이지를 수정했으면 commit_edit 가 충돌로 거부합니다 ` +
        `(이 경우 discard_edit 후 read_document 로 최신 상태를 다시 읽고 편집을 재구성). draft 는 마지막 활동 이후 12시간이 지나면 자동 삭제됩니다.\n\n` +
        `**⚠️ 헤딩 작성 규칙**: 위키는 헤딩(##, ###, ...)에 자동으로 계층 번호("1.", "1.1." 등)를 부여합니다. ` +
        `헤딩 텍스트에 번호를 직접 적지 마세요 (예: \`## 1. 개요\` ❌ → \`## 개요\` ✅). 직접 적으면 렌더링 시 "1. 1. 개요" 처럼 중복 번호가 표시됩니다. ` +
        `목차 내 다른 섹션을 참조할 때는 \`[[문서#s-1.2]]\` 형식의 섹션 앵커를 사용하세요.\n\n` +
        `**항상 승인 대기로 제출**: commit_edit 를 호출하면 draft 는 즉시 리비전이 되지 않고 OAuth 토큰 소유자(=이 MCP 를 연결한 본인) 에게 승인 대기로 제출됩니다. ` +
        `본인이 마이페이지 / 알림 / 문서 배너에서 검토 후 승인해야 비로소 리비전이 만들어집니다. 거부 시 draft 는 폐기됩니다. ` +
        `승인 대기 상태 draft 는 list_drafts / read_draft 의 \`status\` 필드가 \`pending_approval\` 로 표시되며, AI 측에서는 더 이상 수정할 수 없습니다 (discard_edit 로 폐기만 가능).\n\n` +
        `**즉시 적용** (draft 모델 미사용): revert_page.\n\n` +
        USER_EDIT_TOOL_DEFS.map(t => `- ${t.name}`).join('\n') +
        `\n\n리비전 summary 에 [MCP] 접두가 붙습니다 (draft 단계는 기록 없음).`;
    return `${readIntro}${editIntro}`;
}

// /api/mcp 의 information 도구가 관리자에게만 추가로 덧붙여 보여줄 가이드.
export function buildAdminOnlyInformationSuffix(userName: string): string {
    const readIntro = `\n\n## 관리자 전용 읽기 도구 (현재 인증된 관리자: ${userName})\n${ADMIN_ONLY_READ_TOOL_DEFS.map(t => `- ${t.name}`).join('\n')}`;
    const editIntro = `\n\n## 관리자 전용 편집 도구 (즉시 적용)\n` +
        ADMIN_ONLY_EDIT_TOOL_DEFS.map(t => `- ${t.name}`).join('\n');
    return `${readIntro}${editIntro}`;
}
