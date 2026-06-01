/**
 * `map:<base>` 가상 문서용 트리 마크다운 생성기.
 *
 * - base 슬러그 자신과 모든 하위 슬러그(`base/...`) 를 한 번에 조회한다.
 * - 출력은 **순수 위키 마크다운 텍스트** — render.ts 의 평소 파이프라인을 그대로 거친다.
 *   라인 구분은 `\n`, marked 의 `breaks: true` 가 단일 newline 을 `<br>` 로 변환해 줄바꿈을 보존한다.
 *   ([[Cloudwiki]]\n├── [[Cloudwiki/...|name]]\n... 형식 — 기존 "문서 구조 보기"
 *   `src/client/pages/index.ts` `renderMarkdown` 과 동일한 패턴.)
 * - 각 자식 문서 아래에 그 문서의 TOC 항목을 `[[slug#N|#N. 제목]]` wikilink 로 한 단계 더 들여써 노출한다.
 *   `#0` 도입부는 위키 본문에 `s-0` 앵커가 실존하지 않아 트리에서 생략한다.
 * - 정렬은 기존 `renderMarkdown` 과 동일: descendant 수 오름차순 → 이름 알파벳순.
 *
 * 반환값에 `hasPrivateChildren` 을 포함해 호출 측이 공유 캐시 가능 여부를 판단하도록 한다.
 */

import { parseEditAcl, type EditAclFlag } from './editAcl';

export const MAP_TREE_LIMIT = 500;
/**
 * `map:` 캐시 max-age (초). 자식 문서가 mutation 되어도 ancestor map 캐시는 자동 무효화되지
 * 않으므로 staleness 윈도우를 짧게 유지.
 */
export const MAP_CACHE_MAX_AGE_SECONDS = 300;

interface PageRow {
    slug: string;
    content: string | null;
    rows: number | null;
    characters: number | null;
    is_private: number;
    edit_acl: string | null;
}

interface BuildMapDocumentOptions {
    db: D1Database;
    baseSlug: string;
    canSeePrivate: boolean;
    /**
     * true 면 각 노드 라벨 옆에 비공개/ACL 태그를 위키 문법으로 덧붙인다.
     * 관리자 전용 토글이며, 호출 측이 isAdmin && ?perms=1 여부로 판정해 전달한다.
     * 비관리자에게 강제로 켜져도 호출 측이 false 로 정규화해야 한다.
     */
    showPerms?: boolean;
}

/**
 * `permissions-modal.ts` 의 ACL_FLAG_LABELS 와 동일 — 트리 태그 텍스트용.
 * 서버 측 단순 복제 (라벨이 바뀔 일이 드물고 클라이언트와 분리 모듈).
 */
const ACL_FLAG_LABELS: Record<EditAclFlag, string> = {
    aged: '가입 N일 이상',
    page_editor: '본 문서 편집 이력',
    any_editor: '임의 문서 편집 이력',
    admin_only: '관리자 전용',
};

export interface MapDocumentResult {
    markdown: string;
    hasPrivateChildren: boolean;
}

/** 그룹 nav 트리용 직렬화 노드 (docs 레이아웃 좌측 사이드바). 마크다운 트리와 동일 구조를 JSON 으로 노출. */
export interface GroupTreeNode {
    /** 마지막 경로 세그먼트 (표시용 이름) */
    name: string;
    /** 전체 슬러그 (식별/링크용 — 항상 slug 기준) */
    slug: string;
    /** 실제 문서 행이 존재하는 노드인지 (false 면 경로상 중간 노드라 링크 없음) */
    hasDoc: boolean;
    children: GroupTreeNode[];
}

export interface BuildGroupTreeResult {
    root: GroupTreeNode;
    hasPrivateChildren: boolean;
    truncated: boolean;
}

/**
 * 위키 링크의 표시 라벨로 안전한 텍스트로 정제한다.
 * `[` `]` `|` 는 `[[…]]` 토큰 경계와 충돌하므로 제거하고, marked 가 raw HTML 로 해석할 수 있는
 * 특수문자(`<`, `>`, `&`)는 escape 한다. TOC 제목처럼 사용자 입력에서 온 라벨에만 적용.
 */
function escapeWikiLinkLabel(text: string): string {
    return text
        .replace(/[\r\n]+/g, ' ')
        .replace(/[\[\]|]/g, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * map: 트리용 TOC 추출.
 *
 * `aiParser.ts` 의 `extractTOC` 와 달리, **render.ts `numberHeadings()` 와 동일한 번호 체계**
 * 를 사용한다 — 이 트리의 TOC 라인은 결국 `[[slug#N|...]]` wikilink 가 되어 `s-N` 앵커를
 * 가리켜야 하기 때문이다. 두 가지 핵심 차이:
 *
 *  1. h1-h4 헤딩만 포함한다 (numberHeadings 의 selector 와 동일). h5/h6 는 본문에 `s-N`
 *     앵커가 부여되지 않으므로 wikilink 가 깨진다 → 트리에서 생략.
 *  2. 번호는 절대 레벨이 아니라 **그 페이지의 minLevel 기준 상대 레벨** 로 매긴다. 예를
 *     들어 `## Overview` 로 시작하는 페이지의 첫 헤딩은 `1.1` 이 아니라 `1` 이다.
 *
 * 도입부(`#0`) 는 wiki 본문에 `s-0` 앵커가 존재하지 않아 처음부터 생성하지 않는다.
 */
function extractMapTOC(content: string): { num: string; title: string }[] {
    const lines = content.split('\n');
    const headings: { level: number; title: string }[] = [];
    // GFM 코드 펜스 규칙 (CommonMark spec):
    //  - 여는 펜스: 3+ 개의 ` 또는 ~ 뒤에 임의의 info string 허용 (예: ```js).
    //  - 닫는 펜스: 여는 펜스와 **같은 문자 + 길이 ≥ opener 길이** 이고 뒤에 공백만 허용.
    //    info string 이 붙은 라인은 닫는 펜스가 아니다 — 안 그러면 코드 블록 안에
    //    ```js 같은 데모 라인이 가짜 닫힘으로 잡혀 이후 헤딩 번호가 어긋난다.
    let inCodeBlock = false;
    let fenceChar: string | null = null;
    let fenceLength = 0;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!inCodeBlock) {
            const openMatch = trimmed.match(/^(`{3,}|~{3,})/);
            if (openMatch) {
                const fence = openMatch[1];
                inCodeBlock = true;
                fenceChar = fence[0];
                fenceLength = fence.length;
                continue;
            }
        } else {
            // 닫는 펜스는 같은 문자, 길이 ≥ opener, 그리고 뒤에 공백만.
            const closeMatch = trimmed.match(/^(`{3,}|~{3,})\s*$/);
            if (closeMatch) {
                const fence = closeMatch[1];
                if (fence[0] === fenceChar && fence.length >= fenceLength) {
                    inCodeBlock = false;
                    fenceChar = null;
                    fenceLength = 0;
                }
            }
            continue;
        }
        const m = line.match(/^(#{1,4})\s+(.*)$/);
        if (!m) continue;
        headings.push({ level: m[1].length, title: m[2].trim() });
    }
    if (headings.length === 0) return [];

    const minLevel = Math.min(...headings.map(h => h.level));
    const counters = [0, 0, 0, 0, 0, 0];
    const out: { num: string; title: string }[] = [];

    for (const h of headings) {
        const relLevel = h.level - minLevel;
        counters[relLevel]++;
        for (let k = relLevel + 1; k < counters.length; k++) counters[k] = 0;
        const parts: number[] = [];
        for (let k = 0; k <= relLevel; k++) parts.push(counters[k] || 1);
        out.push({ num: parts.join('.'), title: h.title });
    }
    return out;
}

interface TreeNode {
    name: string;
    slug: string;
    row: PageRow | null;
    children: Map<string, TreeNode>;
    descendants: number;
}

type ChildLine =
    | { kind: 'toc'; num: string; title: string }
    | { kind: 'doc'; node: TreeNode };

interface BuildTreeNodesResult {
    root: TreeNode;
    hasPrivateChildren: boolean;
    truncated: boolean;
}

/**
 * base 슬러그와 모든 하위 슬러그(`base/...`)를 한 번에 조회해 in-memory `TreeNode` 트리를 구성한다.
 * `buildMapDocument`(마크다운 트리)와 `buildGroupTree`(JSON nav 트리)가 공유하는 코어.
 * 정렬·descendant 카운트까지 끝낸 트리를 반환한다.
 */
async function buildTreeNodes(opts: BuildMapDocumentOptions): Promise<BuildTreeNodesResult> {
    const { db, baseSlug, canSeePrivate } = opts;
    const privateFilter = canSeePrivate ? '' : ' AND is_private = 0';

    // LIKE 와일드카드(%, _, \) 이스케이프 — wiki.ts:/w/:slug/subdocs 와 동일한 규칙.
    const escaped = baseSlug.replace(/[\\%_]/g, (ch) => '\\' + ch);

    const baseRowQuery = baseSlug
        ? db.prepare(
            `SELECT slug, content, rows, characters, is_private, edit_acl FROM pages
             WHERE deleted_at IS NULL${privateFilter} AND slug = ? LIMIT 1`
        ).bind(baseSlug)
        : null;
    const childrenQuery = db.prepare(
        `SELECT slug, content, rows, characters, is_private, edit_acl FROM pages
         WHERE deleted_at IS NULL${privateFilter}
           AND slug LIKE ? ESCAPE '\\'
         ORDER BY slug ASC
         LIMIT ${MAP_TREE_LIMIT + 1}`
    ).bind((baseSlug ? escaped + '/' : '') + '%');

    const [baseRow, childrenRes] = await Promise.all([
        baseRowQuery ? baseRowQuery.first<PageRow>() : Promise.resolve(null),
        childrenQuery.all<PageRow>(),
    ]);

    const allChildren = (childrenRes.results || []) as PageRow[];
    const childrenOnly = baseSlug
        ? allChildren.filter(r => r.slug !== baseSlug)
        : allChildren;
    const truncated = childrenOnly.length > MAP_TREE_LIMIT;
    const children = truncated ? childrenOnly.slice(0, MAP_TREE_LIMIT) : childrenOnly;

    // SQL privateFilter 가 비권한자에게는 비공개 행을 이미 잘라낸다.
    // 권한자의 결과에 is_private=1 행이 섞이면 공유 캐시 금지.
    const hasPrivateChildren = children.some(r => r.is_private === 1) || (baseRow?.is_private === 1);

    const root: TreeNode = {
        name: baseSlug || '(루트)',
        slug: baseSlug,
        row: baseRow ?? null,
        children: new Map(),
        descendants: 0,
    };

    for (const row of children) {
        const rel = baseSlug ? row.slug.substring(baseSlug.length + 1) : row.slug;
        const segments = rel.split('/');
        let cursor = root;
        let accum = baseSlug;
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            accum = accum ? `${accum}/${seg}` : seg;
            let next = cursor.children.get(seg);
            if (!next) {
                next = { name: seg, slug: accum, row: null, children: new Map(), descendants: 0 };
                cursor.children.set(seg, next);
            }
            if (i === segments.length - 1) next.row = row;
            cursor = next;
        }
    }

    function countDescendants(node: TreeNode): number {
        let total = 0;
        for (const child of node.children.values()) {
            total += 1 + countDescendants(child);
        }
        node.descendants = total;
        return total;
    }
    countDescendants(root);

    return { root, hasPrivateChildren, truncated };
}

/** 정렬: descendant 수 오름차순 → 이름 알파벳순 (renderMarkdown 과 동일). buildMapDocument·buildGroupTree 공유. */
function sortedChildren(node: TreeNode): TreeNode[] {
    return Array.from(node.children.values()).sort((a, b) => {
        if (a.descendants !== b.descendants) return a.descendants - b.descendants;
        return a.name.localeCompare(b.name);
    });
}

/**
 * `map:<base>` 가상 문서용 트리 마크다운 생성기. (트리 구성은 buildTreeNodes 공유)
 */
/**
 * 노드(row 가 있는 경우)의 비공개/ACL 정보를 위키 문법 태그 문자열로 변환.
 * showPerms 가 false 거나 row 가 없으면 빈 문자열 반환.
 * `{tag:...}` 내부에는 `{` `}` `|` 가 들어가면 안 되므로 라벨에 그런 문자가 끼면 제거.
 */
function buildPermTags(row: PageRow | null, showPerms: boolean): string {
    if (!showPerms || !row) return '';
    const parts: string[] = [];
    if (row.is_private === 1) {
        parts.push('{palette:danger}{bi:eye-slash-fill}{tag:비공개}');
    }
    const acl = parseEditAcl(row.edit_acl);
    if (acl && acl.flags.length > 0) {
        const labels = acl.flags
            .map(f => ACL_FLAG_LABELS[f])
            .map(s => s.replace(/[{}|]/g, ''))
            .join(', ');
        parts.push(`{palette:warning}{bi:shield-lock}{tag:${labels}}`);
    }
    return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

export async function buildMapDocument(opts: BuildMapDocumentOptions): Promise<MapDocumentResult> {
    const { baseSlug, showPerms = false } = opts;
    const { root, hasPrivateChildren, truncated } = await buildTreeNodes(opts);

    /** 한 노드의 자식 라인 모음 (TOC 항목 + 하위 문서 노드). 마지막 라인 `└──` 처리를 위해 합쳐서 관리. */
    function gatherChildLines(node: TreeNode): ChildLine[] {
        const out: ChildLine[] = [];
        if (node.row && node.row.content) {
            for (const t of extractMapTOC(node.row.content)) {
                out.push({ kind: 'toc', num: t.num, title: t.title });
            }
        }
        for (const c of sortedChildren(node)) out.push({ kind: 'doc', node: c });
        return out;
    }

    function nodeLineLabel(node: TreeNode): { label: string; meta: string; perms: string } {
        const meta = node.row
            ? `(${node.row.rows ?? 0}줄, ${node.row.characters ?? 0}자)`
            : '(문서 없음)';
        const label = node.row
            ? `[[${node.slug}|${node.name}]]`
            : node.name;
        const perms = buildPermTags(node.row, showPerms);
        return { label, meta, perms };
    }

    const lines: string[] = [];

    // 헤더: base 슬러그 (있다면 wikilink). 페이지가 없어도 `[[…]]` 로 두면 클릭 시 "문서 없음" 안내가 보임.
    {
        const headerMeta = root.row
            ? `(${root.row.rows ?? 0}줄, ${root.row.characters ?? 0}자)`
            : '(문서 없음)';
        const headerPerms = buildPermTags(root.row, showPerms);
        if (baseSlug) {
            lines.push(`[[${baseSlug}]] ${headerMeta}${headerPerms}`);
        } else {
            lines.push(`(루트) ${headerMeta}${headerPerms}`);
        }
    }

    /** node 의 자식 라인을 prefix 기준으로 그리고, 하위 문서는 재귀. */
    function drawChildren(node: TreeNode, prefix: string): void {
        const childLines = gatherChildLines(node);
        for (let i = 0; i < childLines.length; i++) {
            const cl = childLines[i];
            const isLast = i === childLines.length - 1;
            const connector = isLast ? '└── ' : '├── ';
            const extendPrefix = prefix + (isLast ? '    ' : '│   ');

            if (cl.kind === 'toc') {
                const title = escapeWikiLinkLabel(cl.title);
                lines.push(`${prefix}${connector}[[${node.slug}#${cl.num}|#${cl.num}. ${title}]]`);
            } else {
                const { label, meta, perms } = nodeLineLabel(cl.node);
                lines.push(`${prefix}${connector}${label} ${meta}${perms}`);
                drawChildren(cl.node, extendPrefix);
            }
        }
    }

    drawChildren(root, '');

    if (truncated) {
        lines.push('');
        lines.push(`... (하위 문서 ${MAP_TREE_LIMIT}개 초과, 일부 생략됨)`);
    }

    return { markdown: lines.join('\n'), hasPrivateChildren };
}

/**
 * docs 레이아웃 좌측 그룹 nav 사이드바용 구조화 트리(JSON) 생성기.
 * buildMapDocument 와 동일한 트리 구성(buildTreeNodes)을 공유하되, ASCII 마크다운 대신
 * 직렬화 가능한 `GroupTreeNode` 로 변환해 반환한다. TOC 항목은 포함하지 않는다(문서 노드만).
 * 현재 문서 표시(isCurrent)는 캐시 공유를 위해 서버에서 계산하지 않고 클라이언트가 slug 매칭으로 처리.
 */
export async function buildGroupTree(opts: BuildMapDocumentOptions): Promise<BuildGroupTreeResult> {
    const { root, hasPrivateChildren, truncated } = await buildTreeNodes(opts);

    function serialize(node: TreeNode): GroupTreeNode {
        return {
            name: node.name,
            slug: node.slug,
            hasDoc: node.row != null,
            children: sortedChildren(node).map(serialize),
        };
    }

    return { root: serialize(root), hasPrivateChildren, truncated };
}
