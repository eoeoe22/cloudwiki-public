// MCP 도구 정의 + 디스패처 공용 모듈.
//
// 통합 MCP 엔드포인트(/api/mcp) 가 인증된 사용자(일반/관리자) 모두에게 노출하는 읽기
// 도구를 정의한다. 도구 디스패치는 JSON-RPC 외피(jsonrpc/id) 를 포함하지 않고
// result content 만 반환한다 — 호출자가 envelope 을 씌운다.
//
// 일반 사용자 노출 도구는 MCP_TOOL_DEFS_ALL 에 정의하고, 관리자 전용 도구는
// src/routes/admin-mcp.ts 에서 ADMIN_TOOL_DEFS 로 별도 정의되어 호출 시점에 합류된다.
import type { Context } from 'hono';
import type { Env } from '../types';
import { renderForAI, extractTOC, extractSection, findSectionsForQuery, expandTemplates } from './aiParser';
import { normalizeSlug, isR2OnlyNamespace, isMcpReadableSlug } from './slug';
import { getRevisionContent } from './r2';
import type { RBAC } from './role';

// ────────────────────────────────────────────────────────────────
// 공용 헬퍼
// ────────────────────────────────────────────────────────────────

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_CODES = (() => {
    const codes = new Uint8Array(64);
    for (let i = 0; i < 64; i++) codes[i] = BASE64_ALPHABET.charCodeAt(i);
    return codes;
})();
const BASE64_PAD = 0x3d;

export function bytesToBase64(bytes: Uint8Array): string {
    const len = bytes.length;
    const fullTriples = (len / 3) | 0;
    const remainder = len - fullTriples * 3;
    const outLen = fullTriples * 4 + (remainder ? 4 : 0);
    const out = new Uint8Array(outLen);

    let inIdx = 0;
    let outIdx = 0;
    for (let i = 0; i < fullTriples; i++) {
        const b0 = bytes[inIdx++];
        const b1 = bytes[inIdx++];
        const b2 = bytes[inIdx++];
        out[outIdx++] = BASE64_CODES[b0 >> 2];
        out[outIdx++] = BASE64_CODES[((b0 & 0x03) << 4) | (b1 >> 4)];
        out[outIdx++] = BASE64_CODES[((b1 & 0x0f) << 2) | (b2 >> 6)];
        out[outIdx++] = BASE64_CODES[b2 & 0x3f];
    }
    if (remainder === 1) {
        const b0 = bytes[inIdx];
        out[outIdx++] = BASE64_CODES[b0 >> 2];
        out[outIdx++] = BASE64_CODES[(b0 & 0x03) << 4];
        out[outIdx++] = BASE64_PAD;
        out[outIdx++] = BASE64_PAD;
    } else if (remainder === 2) {
        const b0 = bytes[inIdx];
        const b1 = bytes[inIdx + 1];
        out[outIdx++] = BASE64_CODES[b0 >> 2];
        out[outIdx++] = BASE64_CODES[((b0 & 0x03) << 4) | (b1 >> 4)];
        out[outIdx++] = BASE64_CODES[(b1 & 0x0f) << 2];
        out[outIdx++] = BASE64_PAD;
    }
    return new TextDecoder().decode(out);
}

export function formatRelativeTime(unixSec: number | null | undefined, nowSec: number): string {
    if (unixSec === null || unixSec === undefined || !Number.isFinite(unixSec)) return '';
    const diff = Math.max(0, Math.floor(nowSec - unixSec));
    if (diff < 60) return '방금';
    if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
    if (diff < 86400) {
        const hours = Math.floor(diff / 3600);
        const minutes = Math.floor((diff % 3600) / 60);
        return minutes > 0 ? `${hours}시간 ${minutes}분 전` : `${hours}시간 전`;
    }
    const days = Math.floor(diff / 86400);
    if (days < 30) return `${days}일 전`;
    if (days < 365) return `${Math.floor(days / 30)}달 전`;
    return `${Math.floor(days / 365)}년 전`;
}

// ────────────────────────────────────────────────────────────────
// 도구 정의
// ────────────────────────────────────────────────────────────────

export interface McpToolDef {
    name: string;
    description: string;
    inputSchema: any;
}

export const MCP_TOOL_DEFS_ALL: McpToolDef[] = [
    {
        name: 'search_title',
        description: '위키 문서의 슬러그(=제목)를 검색합니다.',
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: '검색어' } }, required: ['query'] }
    },
    {
        name: 'search_fts',
        description: '위키 문서의 본문을 전문 검색(FTS) 합니다. 검색 결과에는 문서 슬러그와, 검색어가 등장하는 모든 목차의 목록이 포함됩니다. 한 문서에서 여러 섹션에 걸쳐 등장하면 모든 섹션이 반환됩니다.',
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: '검색어' } }, required: ['query'] }
    },
    {
        name: 'get_toc',
        description: '위키 문서의 목차(section)만 불러옵니다. 목차는 계층적 번호(예: "1.", "1.1", "1.1.1")가 붙은 형식으로 반환됩니다. 첫 헤딩 이전에 본문 텍스트가 있는 경우 "0. 도입부" 항목이 맨 앞에 추가되며, read_section 에 "0" 을 지정하면 그 도입부만 읽을 수 있습니다. 긴 문서를 전부 읽기보다 get_toc 도구로 목차를 추출한 뒤 read_section 도구에 번호를 지정해 부분적으로 읽는 것을 권장합니다. raw=true 로 설정하면 {{틀}} 트랜스클루전을 펼치지 않은 원본 기준의 목차 번호가 반환됩니다 — 어드민 MCP 의 edit_section 으로 편집하려면 반드시 raw=true 의 번호를 사용해야 합니다.',
        inputSchema: { type: 'object', properties: { title: { type: 'string', description: '문서 슬러그(=제목)' }, raw: { type: 'boolean', description: 'true 시 트랜스클루전을 펼치지 않고 원본 헤딩만으로 목차 번호 산출 (편집용)' } }, required: ['title'] }
    },
    {
        name: 'read_document',
        description: '위키 문서의 전체 본문을 읽어옵니다. raw=true로 설정 시 위키 꾸미기 문법 변환을 건너뛰고 원본 그대로 반환합니다.',
        inputSchema: { type: 'object', properties: { title: { type: 'string', description: '문서 슬러그(=제목)' }, raw: { type: 'boolean' } }, required: ['title'] }
    },
    {
        name: 'read_section',
        description: '위키 문서에서 특정 목차의 내용만 읽어옵니다. 목차는 get_toc 가 반환하는 계층적 번호(예: "1", "1.1", "1.1.1")로 지정합니다. raw=true 면 트랜스클루전을 펼치지 않은 원본 기준의 번호로 추출하고 위키 꾸미기 문법 변환도 건너뜁니다 — get_toc(raw=true) / edit_section 과 동일한 번호 체계입니다. raw=false (기본) 면 트랜스클루전을 펼친 뒤 추출하고 AI 용 렌더링을 적용합니다 — get_toc(raw=false) 와 동일.',
        inputSchema: { type: 'object', properties: { title: { type: 'string', description: '문서 슬러그(=제목)' }, section_number: { type: 'string', description: 'get_toc 가 반환한 목차 번호 (예: "1", "1.1", "1.1.1"). "0" 은 첫 헤딩 이전 도입부. raw 옵션은 get_toc 호출 시와 동일하게 맞추세요.' }, raw: { type: 'boolean', description: 'true 시 트랜스클루전 미확장 + 원본 그대로 반환 (편집 직전 단계용)' } }, required: ['title', 'section_number'] }
    },
    {
        name: 'get_tree',
        description: '입력한 문서를 루트로 한 하위 문서 트리를 반환합니다. 예를 들어 "A/B/C" 를 입력하면 "A/B/C" 부터 시작하는 하위 트리만 반환됩니다.',
        inputSchema: { type: 'object', properties: { title: { type: 'string', description: '트리의 루트가 될 문서 슬러그(=제목)' } }, required: ['title'] }
    },
    {
        name: 'read_document_batch',
        description: '여러 문서를 한 번에 최대 10개까지 읽어옵니다. 두 가지 모드를 지원합니다. (1) titles: 직접 지정한 문서 슬러그 배열을 한 번에 읽기. (2) parent_title: 지정한 문서의 하위 문서들을 일괄 읽기. parent_title 모드에서 하위 문서가 10개를 초과하면 상위 10개만 읽고, 응답에 읽은/읽지 않은 문서를 표시한 트리와 페이지네이션 정보가 포함됩니다. page 파라미터(1부터 시작)로 다음 페이지를 요청할 수 있습니다. raw=true 설정 시 위키 꾸미기 문법 변환을 건너뜁니다.',
        inputSchema: {
            type: 'object',
            properties: {
                titles: { type: 'array', items: { type: 'string' }, description: '직접 지정할 문서 슬러그 목록 (최대 10개). parent_title 과 함께 지정한 경우 titles 가 우선합니다.' },
                parent_title: { type: 'string', description: '하위 문서를 일괄 읽을 부모 문서 슬러그' },
                page: { type: 'number', description: 'parent_title 모드의 페이지 번호 (1부터 시작, 기본 1)' },
                raw: { type: 'boolean' }
            },
            required: []
        }
    },
    {
        name: 'get_toc_batch',
        description: '여러 문서의 목차(section)를 한 번에 최대 10개까지 불러와, 슬러그 계층을 따라 하나의 트리 텍스트로 반환합니다. 두 가지 모드를 지원합니다. (1) titles: 직접 지정한 문서 슬러그 배열. 슬러그 경로로 트리를 만들 수 있으면 하나의 트리, 최상위 슬러그가 다르면 여러 트리로 분리됩니다. (2) parent_title: 지정한 문서를 루트로 한 하위 문서 트리. 각 문서 노드 아래에 자식 문서들과 함께 해당 문서의 목차 항목이 "#1. 제목", "#1.1. 제목" 형식으로 형제로 표시됩니다. 문서 본문이 없는 경로 노드는 "(문서 없음)" 으로 표시됩니다. parent_title 모드에서 하위 문서가 10개를 초과하면 상위 10개만 목차를 추출하고, 나머지는 "[읽지 않음]" 으로 표시됩니다. page 파라미터(1부터 시작)로 다음 페이지를 요청할 수 있습니다.',
        inputSchema: {
            type: 'object',
            properties: {
                titles: { type: 'array', items: { type: 'string' }, description: '직접 지정할 문서 슬러그 목록 (최대 10개). parent_title 과 함께 지정한 경우 titles 가 우선합니다.' },
                parent_title: { type: 'string', description: '하위 문서의 목차를 일괄 조회할 부모 문서 슬러그' },
                page: { type: 'number', description: 'parent_title 모드의 페이지 번호 (1부터 시작, 기본 1)' }
            },
            required: []
        }
    },
    {
        name: 'search_category',
        description: '카테고리를 이름으로 검색합니다.',
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: '검색할 카테고리 이름 (부분 문자열)' } }, required: ['query'] }
    },
    {
        name: 'get_category_info',
        description: '해당 카테고리에 속한 문서 목록과 카테고리 설명을 반환합니다. raw=true로 설정 시 카테고리 설명의 위키 꾸미기 문법 변환을 건너뛰고 원본 그대로 반환합니다.',
        inputSchema: { type: 'object', properties: { category: { type: 'string', description: '조회할 카테고리 이름' }, raw: { type: 'boolean' } }, required: ['category'] }
    },
    {
        name: 'get_document_category',
        description: '해당 문서가 속한 카테고리 목록을 반환합니다.',
        inputSchema: { type: 'object', properties: { title: { type: 'string', description: '조회할 문서 슬러그(=제목)' } }, required: ['title'] }
    },
    {
        // Deprecated alias kept for backward compatibility (rename of get_document_categoty).
        // Will be removed in a future major version. Use get_document_category instead.
        name: 'get_document_categoty',
        description: '[Deprecated] get_document_category 의 구버전 이름입니다. 새 코드에서는 get_document_category 를 사용하세요.',
        inputSchema: { type: 'object', properties: { title: { type: 'string', description: '조회할 문서 슬러그(=제목)' } }, required: ['title'] }
    },
    {
        name: 'get_backlinks',
        description: '이 문서를 참조하는 역링크(위키링크 [[...]], 틀 트랜스클루전 {{...}}) 문서 목록을 반환합니다.',
        inputSchema: { type: 'object', properties: { title: { type: 'string', description: '역링크를 조회할 문서 슬러그(=제목)' } }, required: ['title'] }
    },
    {
        name: 'get_recent_changes',
        description: '위키 전체에서 최근 수정된 문서 목록을 반환합니다. 응답에는 슬러그, 작성자 이름, 편집 요약, 마지막 리비전 id (revision_id, read_revision/revert_page 와 연계) 가 포함됩니다. 필터 파라미터를 조합해 범위를 좁힐 수 있습니다.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'number', description: '최대 반환 개수 (기본 10, 최대 100)' },
                since: { type: 'string', description: '이 시점 이후 변경분만 (ISO 8601, 예: "2024-01-01" 또는 "2024-01-01T00:00:00Z")' },
                author: { type: 'string', description: '특정 사용자(name 정확 일치)의 마지막 편집만' },
                category: { type: 'string', description: '특정 카테고리에 속한 문서의 변경만' },
                namespace: { type: 'string', description: '특정 네임스페이스(슬러그 접두사) 필터. 예: "틀:" 또는 "분류:". "/" 로 끝나면 하위 트리 매칭.' }
            },
            required: []
        }
    },
    {
        name: 'list_discussions',
        description: '특정 문서에 달린 토론 스레드 목록을 반환합니다. 각 스레드의 id, 제목, 상태(open/closed), 댓글 수, 작성일이 포함됩니다.',
        inputSchema: { type: 'object', properties: { title: { type: 'string', description: '문서 슬러그(=제목)' } }, required: ['title'] }
    },
    {
        name: 'read_discussion',
        description: '특정 토론 스레드의 제목, 상태, 모든 댓글을 읽어옵니다. discussion_id 는 list_discussions 가 반환한 id를 사용합니다.',
        inputSchema: { type: 'object', properties: { discussion_id: { type: 'number', description: 'list_discussions가 반환한 토론 id' } }, required: ['discussion_id'] }
    },
    {
        name: 'view_image',
        description: '위키에 업로드된 이미지를 파일명으로 조회하여 이미지 데이터로 반환합니다. 문서 본문에 ![파일명](https://도메인/media/images/파일명) 형식으로 삽입된 그 파일명(확장자 포함)을 사용합니다.',
        inputSchema: { type: 'object', properties: { filename: { type: 'string', description: '이미지 파일명 (확장자 포함, 예: "example.png")' } }, required: ['filename'] }
    },
    {
        name: 'list_blog_posts',
        description: '블로그(/blog) 포스트 목록을 최신순으로 반환합니다. 한 페이지에 최대 20개 항목이 포함되며, 각 포스트의 id, title, 작성 시점(time_ago), 줄 수, 글자 수가 포함됩니다. 블로그 포스트는 제목이 아닌 정수 id 로 식별합니다. 다음 페이지가 있으면 응답에 next_page 가 포함됩니다.',
        inputSchema: {
            type: 'object',
            properties: {
                page: { type: 'number', description: '페이지 번호 (1부터 시작, 기본 1)' }
            },
            required: []
        }
    },
    {
        name: 'read_blog_post',
        description: '블로그 포스트의 전체 본문을 읽어옵니다. id 는 list_blog_posts 가 반환한 정수 id 를 사용합니다. raw=true 로 설정 시 마크다운/위키 문법 변환을 건너뛰고 원본 그대로 반환합니다.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number', description: '블로그 포스트 id (정수)' },
                raw: { type: 'boolean' }
            },
            required: ['id']
        }
    },
    {
        name: 'get_blog_toc',
        description: '블로그 포스트의 목차(section)만 불러옵니다. 목차는 계층적 번호(예: "1.", "1.1")가 붙은 형식으로 반환됩니다. 첫 헤딩 이전에 본문 텍스트가 있으면 "0. 도입부" 항목이 맨 앞에 추가되며, read_blog_section 에 "0" 을 지정하면 그 도입부만 읽을 수 있습니다.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number', description: '블로그 포스트 id (정수)' }
            },
            required: ['id']
        }
    },
    {
        name: 'read_blog_section',
        description: '블로그 포스트에서 특정 목차의 내용만 읽어옵니다. 목차 번호는 get_blog_toc 가 반환한 계층적 번호(예: "1", "1.1") 로 지정합니다. raw=true 로 설정 시 위키 문법 변환을 건너뛰고 반환합니다.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number', description: '블로그 포스트 id (정수)' },
                section_number: { type: 'string', description: 'get_blog_toc 가 반환한 목차 번호 (예: "1", "1.1"). "0" 은 첫 헤딩 이전 도입부.' },
                raw: { type: 'boolean' }
            },
            required: ['id', 'section_number']
        }
    }
];

export function buildInformationIntro(c: Context<Env>, toolDefs: McpToolDef[] = MCP_TOOL_DEFS_ALL): string {
    const wikiName = c.env.WIKI_NAME;
    const syntaxNote = c.env.WIKI_SYNTAX ? `\n\n문법 가이드 문서: ${c.env.WIKI_SYNTAX}` : '';
    const blogNote = toolDefs.some(t => t.name === 'list_blog_posts')
        ? '\n\n위키 문서 외에도 블로그(/blog) 포스트를 list_blog_posts / read_blog_post / get_blog_toc / read_blog_section 도구로 탐색할 수 있습니다. 블로그 포스트는 제목이 아닌 정수 id 로 식별합니다.'
        : '';
    return `이 도구는 ${wikiName} 의 문서를 탐색할 수 있는 MCP 도구입니다.\n\n이 위키의 문법은 마크다운 기반으로, 기본적으로는 문법 가이드 문서를 읽지 않아도 내용 파악이 가능합니다. 문서를 읽을 때 raw 파라미터를 따로 활성화하지 않으면 마크다운 기반으로 정리된 내용이 반환됩니다. raw 파라미터를 사용하려면 위키 문법 문서를 먼저 읽을 것을 권장합니다.${syntaxNote}${blogNote}`;
}

// ────────────────────────────────────────────────────────────────
// 디스패처
// ────────────────────────────────────────────────────────────────

export type ToolResult = { content: any[]; isError?: boolean };

export async function dispatchReadTool(
    c: Context<Env>,
    toolName: string,
    args: any,
    toolDefs: McpToolDef[] = MCP_TOOL_DEFS_ALL
): Promise<ToolResult | null> {
    const db = c.env.DB;
    const rbac = c.get('rbac') as RBAC | undefined;
    const user = c.get('user') as { role: string } | undefined;
    const role = user ? user.role : 'guest';
    const canSeePrivate = rbac ? rbac.can(role, 'wiki:private') : false;
    const privateFilter = canSeePrivate ? '' : ' AND is_private = 0';
    const pPrivateFilter = canSeePrivate ? '' : ' AND p.is_private = 0';

    if (toolName === 'information') {
        const intro = buildInformationIntro(c, toolDefs);
        const toolDetails = toolDefs.map(t => `## ${t.name}\n${t.description}`).join('\n\n');
        const text = `${intro}\n\n## 사용 가능한 도구 목록\n\n${toolDetails}`;
        return { content: [{ type: 'text', text }] };
    }

    if (toolName === 'search_title') {
        const results = await db.prepare(`SELECT slug, rows, characters FROM pages WHERE slug LIKE ? AND deleted_at IS NULL${privateFilter} LIMIT 15`)
            .bind(`%${args.query}%`).all();
        return { content: [{ type: 'text', text: JSON.stringify(results.results, null, 2) }] };
    }

    if (toolName === 'search_fts') {
        const rawQuery = String(args.query || '').trim();
        if (!rawQuery) return { content: [{ type: 'text', text: '[]' }] };

        let rows: { slug: string; content: string; last_revision_id: number | null; rows: number | null; characters: number | null }[] = [];
        if ([...rawQuery].length < 3) {
            const likeEscaped = rawQuery.replace(/[\\%_]/g, '\\$&');
            const likePattern = `%${likeEscaped}%`;
            const fbSql = `SELECT p.slug, p.content, p.last_revision_id, p.rows, p.characters FROM pages p WHERE (p.slug LIKE ? ESCAPE '\\' OR p.content LIKE ? ESCAPE '\\') AND p.deleted_at IS NULL${pPrivateFilter} ORDER BY (CASE WHEN p.slug LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END), p.updated_at DESC LIMIT 10`;
            const fbRes = await db.prepare(fbSql).bind(likePattern, likePattern, likePattern).all<{ slug: string; content: string; last_revision_id: number | null; rows: number | null; characters: number | null }>();
            rows = fbRes.results;
        } else {
            const safeMatchQuery = '"' + rawQuery.replace(/"/g, '""') + '"';
            try {
                const ftsSql = `SELECT slug, content, last_revision_id, rows, characters
                                FROM pages
                                WHERE id IN (SELECT rowid FROM pages_fts WHERE pages_fts MATCH ?)
                                  AND deleted_at IS NULL${privateFilter}
                                LIMIT 10`;
                const ftsRes = await db.prepare(ftsSql).bind(safeMatchQuery).all<{ slug: string; content: string; last_revision_id: number | null; rows: number | null; characters: number | null }>();
                rows = ftsRes.results;
            } catch (ftsErr: any) {
                const msg = String(ftsErr?.message || '');
                if (!/fts5.*(syntax|parse)/i.test(msg)) throw ftsErr;
                const likeEscaped = rawQuery.replace(/[\\%_]/g, '\\$&');
                const likePattern = `%${likeEscaped}%`;
                const fbSql = `SELECT p.slug, p.content, p.last_revision_id, p.rows, p.characters FROM pages p WHERE (p.slug LIKE ? ESCAPE '\\' OR p.content LIKE ? ESCAPE '\\') AND p.deleted_at IS NULL${pPrivateFilter} ORDER BY (CASE WHEN p.slug LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END), p.updated_at DESC LIMIT 10`;
                const fbRes = await db.prepare(fbSql).bind(likePattern, likePattern, likePattern).all<{ slug: string; content: string; last_revision_id: number | null; rows: number | null; characters: number | null }>();
                rows = fbRes.results;
            }
        }

        const origin = new URL(c.req.url).origin;
        const enabledExt = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
        const output = await Promise.all(rows.map(async (row) => {
            let actualContent = row.content;
            if (isR2OnlyNamespace(row.slug, enabledExt) && (!actualContent || actualContent === '')) {
                if (row.last_revision_id) {
                    const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(row.last_revision_id).first<{ content: string, r2_key: string | null }>();
                    if (lastRev) actualContent = await getRevisionContent(c.env.MEDIA, lastRev, origin);
                }
            }
            return {
                title: row.slug,
                rows: row.rows,
                characters: row.characters,
                sections: findSectionsForQuery(actualContent, rawQuery),
            };
        }));
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    }

    if (toolName === 'get_toc' || toolName === 'read_document' || toolName === 'read_section') {
        const slug = normalizeSlug(args.title || '');
        if (!isMcpReadableSlug(slug)) {
            return { content: [{ type: 'text', text: 'raw 데이터는 읽을 수 없습니다.' }], isError: true };
        }
        const page = await db.prepare(`SELECT slug, content, last_revision_id FROM pages WHERE slug = ? AND deleted_at IS NULL${privateFilter}`).bind(slug).first<{ slug: string, content: string, last_revision_id: number | null }>();
        if (!page) return { content: [{ type: 'text', text: 'Error: 문서를 찾을 수 없거나 비공개/삭제 상태입니다.' }], isError: true };

        let actualContent = page.content;
        const origin = new URL(c.req.url).origin;
        const enabledExt = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
        if (isR2OnlyNamespace(page.slug, enabledExt) && (!actualContent || actualContent === '')) {
            if (page.last_revision_id) {
                const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(page.last_revision_id).first<{ content: string, r2_key: string | null }>();
                if (lastRev) actualContent = await getRevisionContent(c.env.MEDIA, lastRev, origin);
            }
        }

        if (toolName === 'get_toc') {
            // raw=true: 트랜스클루전을 펼치지 않은 원본 기준 — edit_section 의 번호와 일치.
            const sourceForToc = args.raw === true
                ? actualContent
                : await expandTemplates(actualContent, db, 0, slug);
            const tocText = (extractTOC(sourceForToc) || '')
                .split('\n')
                .map(line => line.replace(/\{[^}]*\}/g, '').replace(/[ \t]+/g, ' ').trimEnd())
                .join('\n');
            return { content: [{ type: 'text', text: tocText || '목차가 존재하지 않습니다.' }] };
        }
        if (toolName === 'read_document') {
            const text = args.raw === true ? actualContent : await renderForAI(actualContent, db, 0, slug);
            return { content: [{ type: 'text', text: text || '문서 내용이 존재하지 않습니다.' }] };
        }
        // read_section
        // raw=true: 트랜스클루전을 펼치지 않은 원본 기준의 섹션 번호를 사용해 추출. get_toc(raw=true)
        // 및 edit_section 의 번호 체계와 일치한다. 템플릿이 헤딩을 추가하는 페이지에서 raw=false 와
        // 같은 번호로 다른 섹션을 가리키지 않도록 한다.
        // raw=false: 기존 동작 — 트랜스클루전을 펼친 뒤 추출, AI 용 렌더링까지 적용.
        const sourceForSection = args.raw === true
            ? actualContent
            : await expandTemplates(actualContent, db, 0, slug);
        const sectionContent = extractSection(sourceForSection, args.section_number || '');
        const text = args.raw === true ? sectionContent : await renderForAI(sectionContent, db, 0, slug);
        return { content: [{ type: 'text', text: text || '해당 목차를 찾을 수 없습니다.' }] };
    }

    if (toolName === 'get_tree') {
        const rootSlug = normalizeSlug(args.title || '');
        if (!rootSlug) {
            return { content: [{ type: 'text', text: 'Error: title이 필요합니다.' }], isError: true };
        }
        const prefixLower = rootSlug + '/';
        const prefixUpper = rootSlug + '0';

        const [subdocs, rootPage] = await Promise.all([
            db.prepare(`SELECT slug, rows, characters FROM pages WHERE deleted_at IS NULL${privateFilter} AND slug > ? AND slug < ? ORDER BY slug ASC LIMIT 200`).bind(prefixLower, prefixUpper).all<{ slug: string; rows: number | null; characters: number | null }>(),
            db.prepare(`SELECT slug, rows, characters FROM pages WHERE slug = ? AND deleted_at IS NULL${privateFilter}`).bind(rootSlug).first<{ slug: string; rows: number | null; characters: number | null }>()
        ]);

        const formatStats = (r: number | null, ch: number | null) => ` (${r ?? 0}줄, ${ch ?? 0}자)`;

        if (subdocs.results.length === 0) {
            const rootMarker = rootPage ? formatStats(rootPage.rows, rootPage.characters) : ' (문서 없음)';
            return { content: [{ type: 'text', text: `${rootSlug}${rootMarker}\n하위 문서가 없습니다.` }] };
        }

        const tree: any = {};
        for (const doc of subdocs.results) {
            const relative = doc.slug.substring(rootSlug.length + 1);
            const parts = relative.split('/');
            let node = tree;
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                if (!node[part]) node[part] = { _children: {}, _exists: false, _rows: null, _characters: null };
                if (i === parts.length - 1) {
                    node[part]._exists = true;
                    node[part]._rows = doc.rows;
                    node[part]._characters = doc.characters;
                }
                node = node[part]._children;
            }
        }

        const missingDocs: string[] = [];
        if (!rootPage) missingDocs.push(rootSlug);

        function annotateDescendants(children: any): number {
            let total = 0;
            for (const key of Object.keys(children)) {
                const sub = annotateDescendants(children[key]._children);
                children[key]._descendants = sub;
                total += 1 + sub;
            }
            return total;
        }
        annotateDescendants(tree);

        function renderTree(nodes: any, parentPrefix: string, slugPrefix: string): string {
            const entries = Object.keys(nodes).sort((a, b) => {
                const ca = nodes[a]._descendants;
                const cb = nodes[b]._descendants;
                if (ca !== cb) return ca - cb;
                return a.localeCompare(b);
            });
            let text = '';
            entries.forEach((key, idx) => {
                const node = nodes[key];
                const isLast = idx === entries.length - 1;
                const hasChildren = Object.keys(node._children).length > 0;
                const connector = isLast ? '└── ' : '├── ';
                const childPrefix = parentPrefix + (isLast ? '    ' : '│   ');
                const fullSlug = `${slugPrefix}/${key}`;
                const marker = node._exists ? formatStats(node._rows, node._characters) : ' (문서 없음)';
                if (!node._exists) missingDocs.push(fullSlug);

                text += `${parentPrefix}${connector}${key}${marker}\n`;
                if (hasChildren) text += renderTree(node._children, childPrefix, fullSlug);
            });
            return text;
        }

        const rootMarker = rootPage ? formatStats(rootPage.rows, rootPage.characters) : ' (문서 없음)';
        const treeText = `${rootSlug}${rootMarker}\n` + renderTree(tree, '', rootSlug);
        const missingSection = missingDocs.length > 0
            ? `\n문서가 없는 항목 (${missingDocs.length}):\n${missingDocs.map(s => `- ${s}`).join('\n')}\n`
            : '';
        return { content: [{ type: 'text', text: treeText + missingSection }] };
    }

    if (toolName === 'search_category') {
        const results = await db.prepare('SELECT DISTINCT category FROM page_categories WHERE category LIKE ? ORDER BY category ASC LIMIT 15')
            .bind(`%${args.query}%`).all<{ category: string }>();
        return { content: [{ type: 'text', text: JSON.stringify(results.results.map(r => r.category), null, 2) }] };
    }

    if (toolName === 'get_category_info') {
        const docs = await db.prepare(`SELECT p.slug, p.rows, p.characters FROM page_categories pc JOIN pages p ON pc.page_id = p.id WHERE pc.category = ? AND p.deleted_at IS NULL${pPrivateFilter} ORDER BY p.slug ASC LIMIT 50`)
            .bind(args.category).all<{ slug: string; rows: number | null; characters: number | null }>();

        const catSlug = normalizeSlug(`카테고리:${args.category}`);
        const catPage = await db.prepare(`SELECT slug, content, last_revision_id FROM pages WHERE slug = ? AND deleted_at IS NULL${privateFilter}`).bind(catSlug).first<{ slug: string, content: string, last_revision_id: number | null }>();

        let renderedCatContent = '카테고리 문서가 존재하지 않습니다.';
        if (catPage) {
            let actualContent = catPage.content;
            const origin = new URL(c.req.url).origin;
            const enabledExt = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
            if (isR2OnlyNamespace(catPage.slug, enabledExt) && (!actualContent || actualContent === '')) {
                if (catPage.last_revision_id) {
                    const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(catPage.last_revision_id).first<{ content: string, r2_key: string | null }>();
                    if (lastRev) actualContent = await getRevisionContent(c.env.MEDIA, lastRev, origin);
                }
            }
            const categoryText = args.raw === true
                ? actualContent
                : await renderForAI(actualContent, db, 0, catSlug);
            renderedCatContent = categoryText || '문서 내용이 존재하지 않습니다.';
        }

        const output = {
            documents: docs.results.map(r => ({ slug: r.slug, rows: r.rows, characters: r.characters })),
            categoryContent: renderedCatContent
        };
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    }

    if (toolName === 'get_document_category' || toolName === 'get_document_categoty') {
        const slug = normalizeSlug(args.title || '');
        const cats = await db.prepare(`SELECT pc.category FROM page_categories pc JOIN pages p ON pc.page_id = p.id WHERE p.slug = ? AND p.deleted_at IS NULL${pPrivateFilter} ORDER BY pc.category ASC`)
            .bind(slug).all<{ category: string }>();
        return { content: [{ type: 'text', text: JSON.stringify(cats.results.map(r => r.category), null, 2) }] };
    }

    if (toolName === 'get_backlinks') {
        const slug = normalizeSlug(args.title || '');
        const targetSlugs: string[] = [slug];
        const templatePrefixes = ['틀:', 'template:', '템플릿:'];
        for (const prefix of templatePrefixes) {
            if (slug.startsWith(prefix)) {
                targetSlugs.push(slug.substring(prefix.length));
                break;
            }
        }
        const placeholders = targetSlugs.map(() => '?').join(', ');
        const query = `
            SELECT DISTINCT p.slug, p.rows, p.characters, p.updated_at
            FROM page_links pl
            JOIN pages p ON pl.source_page_id = p.id
            WHERE p.slug != ?
              AND pl.blog = 0
              AND pl.target_slug IN (${placeholders})
              AND p.deleted_at IS NULL${pPrivateFilter}
            ORDER BY p.updated_at DESC LIMIT 100
        `;
        const backlinks = await db.prepare(query).bind(slug, ...targetSlugs).all<{ slug: string; rows: number | null; characters: number | null }>();
        return { content: [{ type: 'text', text: JSON.stringify(backlinks.results.map(r => ({ slug: r.slug, rows: r.rows, characters: r.characters })), null, 2) }] };
    }

    if (toolName === 'get_recent_changes') {
        const limit = Math.min(100, Math.max(1, Number(args.limit) || 10));
        const wheres: string[] = ['p.deleted_at IS NULL'];
        if (!canSeePrivate) wheres.push('p.is_private = 0');
        const binds: any[] = [];

        if (args.since && typeof args.since === 'string') {
            // ISO 8601 date or datetime → unix epoch seconds. 잘못된 입력은 명시적 오류.
            const parsed = Date.parse(args.since);
            if (Number.isNaN(parsed)) {
                return { content: [{ type: 'text', text: `Error: since 가 유효한 ISO 8601 날짜가 아닙니다: ${args.since}` }], isError: true };
            }
            wheres.push('p.updated_at >= ?');
            binds.push(Math.floor(parsed / 1000));
        }
        if (args.author && typeof args.author === 'string') {
            wheres.push('u.name = ?');
            binds.push(args.author);
        }
        if (args.namespace && typeof args.namespace === 'string') {
            // LIKE 패턴 안전화 — % 와 _ 를 이스케이프.
            const ns = args.namespace.replace(/[\\%_]/g, '\\$&');
            wheres.push("p.slug LIKE ? ESCAPE '\\'");
            binds.push(`${ns}%`);
        }
        if (args.category && typeof args.category === 'string') {
            wheres.push('p.id IN (SELECT page_id FROM page_categories WHERE category = ?)');
            binds.push(args.category);
        }

        const sql = `
            SELECT p.slug, p.updated_at, p.last_revision_id, u.name as author_name, r.summary
            FROM pages p
            LEFT JOIN revisions r ON p.last_revision_id = r.id
            LEFT JOIN users u ON r.author_id = u.id
            WHERE ${wheres.join(' AND ')}
            ORDER BY p.updated_at DESC LIMIT ?
        `;
        binds.push(limit);
        const { results } = await db.prepare(sql).bind(...binds).all<{ slug: string; updated_at: number | null; last_revision_id: number | null; author_name: string | null; summary: string | null }>();
        const nowSec = Math.floor(Date.now() / 1000);
        const formatted = results.map(r => ({
            slug: r.slug,
            time_ago: formatRelativeTime(r.updated_at, nowSec),
            author_name: r.author_name,
            summary: r.summary,
            revision_id: r.last_revision_id,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }] };
    }

    if (toolName === 'list_discussions') {
        const slug = normalizeSlug(args.title || '');
        const page = await db.prepare(`SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL${privateFilter}`).bind(slug).first<{ id: number }>();
        if (!page) return { content: [{ type: 'text', text: 'Error: 문서를 찾을 수 없거나 비공개/삭제 상태입니다.' }], isError: true };
        const { results } = await db.prepare(`
            SELECT d.id, d.title, d.status, d.created_at, d.updated_at,
                   u.name as author_name,
                   (SELECT COUNT(*) FROM discussion_comments dc WHERE dc.discussion_id = d.id AND dc.deleted_at IS NULL) as comment_count
            FROM discussions d
            LEFT JOIN users u ON d.author_id = u.id
            WHERE d.page_id = ? AND d.deleted_at IS NULL
            ORDER BY d.updated_at DESC LIMIT 50
        `).bind(page.id).all();
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }

    if (toolName === 'read_discussion') {
        const dId = Number(args.discussion_id);
        if (!Number.isFinite(dId)) {
            return { content: [{ type: 'text', text: 'Error: discussion_id가 유효하지 않습니다.' }], isError: true };
        }
        const discussion = await db.prepare(`
            SELECT d.id, d.title, d.status, d.created_at, d.updated_at,
                   u.name as author_name,
                   p.slug as page_title
            FROM discussions d
            LEFT JOIN users u ON d.author_id = u.id
            JOIN pages p ON d.page_id = p.id
            WHERE d.id = ? AND d.deleted_at IS NULL AND p.deleted_at IS NULL${pPrivateFilter}
        `).bind(dId).first();
        if (!discussion) return { content: [{ type: 'text', text: 'Error: 토론을 찾을 수 없거나 비공개/삭제 상태입니다.' }], isError: true };
        const { results: comments } = await db.prepare(`
            SELECT dc.id, dc.content, dc.parent_id, dc.created_at, dc.deleted_at,
                   u.name as author_name
            FROM discussion_comments dc
            LEFT JOIN users u ON dc.author_id = u.id
            WHERE dc.discussion_id = ?
            ORDER BY dc.created_at ASC
        `).bind(dId).all<{ id: number; content: string; parent_id: number | null; created_at: number; deleted_at: number | null; author_name: string | null }>();
        const cleanedComments = comments.map(dc => ({
            id: dc.id,
            author_name: dc.deleted_at ? null : dc.author_name,
            content: dc.deleted_at ? '(삭제된 댓글)' : dc.content,
            parent_id: dc.parent_id,
            created_at: dc.created_at
        }));
        return { content: [{ type: 'text', text: JSON.stringify({ discussion, comments: cleanedComments }, null, 2) }] };
    }

    if (toolName === 'view_image') {
        const filename = String(args.filename || '').trim();
        if (!filename) {
            return { content: [{ type: 'text', text: 'Error: filename이 필요합니다.' }], isError: true };
        }

        let row = await db.prepare(
            `SELECT r2_key, filename, mime_type, size FROM media WHERE filename = ? AND mime_type LIKE 'image/%' LIMIT 1`
        ).bind(filename).first<{ r2_key: string; filename: string; mime_type: string; size: number }>();

        if (!row) {
            const escapedFilename = filename.replace(/[\\%_]/g, '\\$&');
            const matches = await db.prepare(
                `SELECT r2_key, filename, mime_type, size FROM media WHERE filename LIKE ? ESCAPE '\\' AND mime_type LIKE 'image/%' ORDER BY filename ASC LIMIT 10`
            ).bind(`%${escapedFilename}%`).all<{ r2_key: string; filename: string; mime_type: string; size: number }>();

            if (matches.results.length === 0) {
                return { content: [{ type: 'text', text: `Error: '${filename}' 와 일치하는 이미지를 찾을 수 없습니다.` }], isError: true };
            }
            if (matches.results.length > 1) {
                const list = matches.results.map(r => r.filename).join(', ');
                return { content: [{ type: 'text', text: `Error: 여러 이미지가 일치합니다. 정확한 파일명을 지정해 주세요: ${list}` }], isError: true };
            }
            row = matches.results[0];
        }

        const MAX_IMAGE_RESPONSE_SIZE = 5 * 1024 * 1024;
        if (row.size > MAX_IMAGE_RESPONSE_SIZE) {
            return { content: [{ type: 'text', text: `Error: 이미지 파일이 너무 큽니다 (${(row.size / 1024 / 1024).toFixed(1)}MB). 5MB 이하 이미지만 조회할 수 있습니다.` }], isError: true };
        }

        const obj = await c.env.MEDIA.get(row.r2_key);
        if (!obj) {
            return { content: [{ type: 'text', text: 'Error: 이미지 파일이 스토리지에 존재하지 않습니다.' }], isError: true };
        }

        const buffer = await obj.arrayBuffer();
        const base64 = bytesToBase64(new Uint8Array(buffer));
        const mimeType = obj.httpMetadata?.contentType || row.mime_type || 'image/png';

        return { content: [{ type: 'image', data: base64, mimeType }] };
    }

    return null;
}
