/**
 * `graph:<base>` 가상 문서용 에고 그래프(직접 참조망) 데이터 생성기.
 *
 * - `map:` 패턴(src/utils/mapDocument.ts)을 그대로 복제하되, 출력은 마크다운 트리가 아니라
 *   클라이언트 시각화 모듈(src/client/pages/graph-view.ts)이 force-directed 로 그릴 **JSON**
 *   (`{ nodes, edges }`) 이다.
 * - 노드 = 실제 존재하는 문서(`pages`, `deleted_at IS NULL`). 엣지 = `page_links` 중
 *   `source_type='page'` · `blog=0` · `link_type IN ('wikilink','template')` 이고 **양 끝이
 *   모두 존재하는 문서** 인 직접 참조만. 이미지/익스텐션 링크와 레드링크(존재하지 않는 대상)는 제외.
 * - 범위는 **에고 그래프(N홉 이웃)** 로 한정한다(기본 1홉, 옵션 2홉). 전역 그래프는 미구현이다.
 *   노드 상한(`GRAPH_NODE_CAP`)·엣지 상한(`GRAPH_EDGE_CAP`)으로 항상 경계를 둔다.
 *
 * 틀 접두사(`틀:`/`template:`/`템플릿:`)는 이 코드베이스에서 서로 다른 문서이지(별칭이 아님,
 * wiki.ts 의 이동/역링크 주석 참조) 합쳐지지 않는다. `{{Foo}}` 파서는 항상 `틀:Foo` 로 정규화해
 * 저장하므로, 엣지는 `target_slug = pages.slug` **정확 매칭**만으로 올바르게 해소된다.
 *
 * 반환값에 `hasPrivate` 를 포함해 호출 측이 공유 캐시 가능 여부를 판단하도록 한다(map: 정책 동일).
 */

/** 에고 그래프 노드 상한. 가까운 이웃 우선으로 잘라내고 truncated 플래그로 안내. */
export const GRAPH_NODE_CAP = 300;
/** 엣지 상한(노드 상한과 별개의 안전 가드). */
export const GRAPH_EDGE_CAP = 1500;
/** 홉 상한(에고 그래프는 1~2홉만 지원). */
export const GRAPH_MAX_DEPTH = 2;
/**
 * `graph:` 캐시 max-age (초). `map:` 과 동일 — 이웃 문서가 mutation 돼도 캐시가 자동
 * 무효화되지 않으므로 staleness 윈도우를 짧게 유지.
 */
export const GRAPH_CACHE_MAX_AGE_SECONDS = 300;

/** 그래프 엣지로 인정하는 link_type (직접 참조만). */
const GRAPH_LINK_TYPES = "('wikilink','template')";

/** D1/SQLite 바인드 변수 상한을 넘지 않도록 IN 절을 나눌 청크 크기. */
const IN_CHUNK = 90;

export interface GraphNode {
    /** 문서 식별자(항상 slug 기준) */
    slug: string;
    /** 표시용 대체 제목(없으면 null) */
    title: string | null;
    /** 분류(노드 색 인코딩용). 쉼표 구분 다중 분류면 첫 번째만 시각화에 사용. */
    category: string | null;
    isPrivate: boolean;
    /** 중심(에고) 노드 여부 */
    isCenter: boolean;
    /** 글자수(크기 인코딩 보조). */
    characters: number;
}

export interface GraphEdge {
    /** 출발 문서 slug */
    source: string;
    /** 도착 문서 slug */
    target: string;
    type: 'wikilink' | 'template';
}

export interface GraphData {
    /** 중심 문서 slug */
    center: string;
    /** 중심 문서가 실제로 존재하는지 (없으면 빈 그래프) */
    centerExists: boolean;
    /** 적용된 홉 수 (1 또는 2) */
    depth: number;
    nodes: GraphNode[];
    edges: GraphEdge[];
    /** 노드/엣지 상한으로 일부가 잘렸는지 */
    truncated: boolean;
    /** 결과에 비공개 노드가 포함됐는지 (공유 캐시 게이팅용) */
    hasPrivate: boolean;
}

interface PageNodeRow {
    id: number;
    slug: string;
    title: string | null;
    category: string | null;
    is_private: number;
    characters: number | null;
}

interface BuildGraphOptions {
    db: D1Database;
    baseSlug: string;
    /** 1 또는 2. 범위를 벗어나면 클램프한다. */
    depth: number;
    canSeePrivate: boolean;
}

function chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

/** slug 목록으로 존재하는 문서 노드 행을 조회(soft-delete 제외, 권한 없으면 비공개 제외). */
async function fetchNodesBySlug(db: D1Database, slugs: string[], canSeePrivate: boolean): Promise<PageNodeRow[]> {
    const privateFilter = canSeePrivate ? '' : ' AND is_private = 0';
    const out: PageNodeRow[] = [];
    const seen = new Set<string>();
    const uniqueSlugs = Array.from(new Set(slugs)).filter(s => s.length > 0);
    for (const part of chunk(uniqueSlugs, IN_CHUNK)) {
        if (part.length === 0) continue;
        const ph = part.map(() => '?').join(',');
        const res = await db.prepare(
            `SELECT id, slug, title, category, is_private, characters FROM pages
             WHERE deleted_at IS NULL${privateFilter} AND slug IN (${ph})`
        ).bind(...part).all<PageNodeRow>();
        for (const r of (res.results || []) as PageNodeRow[]) {
            if (!seen.has(r.slug)) { seen.add(r.slug); out.push(r); }
        }
    }
    return out;
}

/** 키셋 페이지네이션 안전장치 — 한 프런티어 청크당 최대 SQL 패스 수(병적 루프 방지). */
const NEIGHBOR_MAX_PASSES = 6;

/**
 * 프런티어 문서의 한 홉 이웃 중 **아직 발견되지 않은 표시 가능한 노드** 행을 budget 만큼 가져온다.
 *
 * - `direction='out'`: 프런티어가 가리키는 문서(`pl.target_slug = p.slug` 조인).
 * - `direction='in'` : 프런티어를 가리키는 문서(`pl.source_page_id = p.id` 조인).
 *
 * 부하 가드(허브 문서가 수천 행을 materialize 못 하게)와 정합성(이미 아는 노드가 LIMIT 을 소진해
 * 새 이웃을 굶기지 않게)을 **slug 키셋 페이지네이션**으로 동시에 만족한다. `pages` 조인으로
 * 레드링크·삭제·(권한 없으면)비공개를 SQL 에서 걸러내고, `p.slug > ?` 커서로 정렬·전진하며,
 * 이미 아는(`knownSlugs`)·중복 노드는 JS 에서 건너뛰면서 budget 만큼의 **새** 노드를 모은다.
 * 바인드 변수는 (프런티어 청크 ≤IN_CHUNK) + 커서 1 + LIMIT 1 로 항상 D1 한도(≈100) 안.
 * (knownSlugs 를 SQL `NOT IN` 으로 넣으면 수백 개라 바인드 한도를 넘으므로 JS 필터로 처리.)
 */
async function fetchNewNeighbors(opts: {
    db: D1Database;
    direction: 'out' | 'in';
    frontierKeys: (number | string)[];
    knownSlugs: Set<string>;
    canSeePrivate: boolean;
    budget: number;
}): Promise<PageNodeRow[]> {
    const { db, direction, frontierKeys, knownSlugs, canSeePrivate, budget } = opts;
    if (budget <= 0) return [];
    const privateFilter = canSeePrivate ? '' : ' AND p.is_private = 0';
    const join = direction === 'out'
        ? 'JOIN pages p ON pl.target_slug = p.slug'
        : 'JOIN pages p ON pl.source_page_id = p.id';
    const frontierCol = direction === 'out' ? 'pl.source_page_id' : 'pl.target_slug';

    const out: PageNodeRow[] = [];
    const seen = new Set<string>();
    for (const part of chunk(frontierKeys, IN_CHUNK)) {
        if (part.length === 0 || out.length >= budget) break;
        const ph = part.map(() => '?').join(',');
        let cursor = '';
        for (let pass = 0; pass < NEIGHBOR_MAX_PASSES && out.length < budget; pass++) {
            // 남은 예산 + 헤드룸(이미 아는/중복 노드 흡수분). 항상 상한 안에서 한 페이지를 가져온다.
            const pageSize = Math.min((budget - out.length) + IN_CHUNK, GRAPH_NODE_CAP + IN_CHUNK);
            const res = await db.prepare(
                `SELECT DISTINCT p.id, p.slug, p.title, p.category, p.is_private, p.characters
                 FROM page_links pl ${join}
                 WHERE ${frontierCol} IN (${ph}) AND pl.blog = 0 AND pl.source_type = 'page'
                   AND pl.link_type IN ${GRAPH_LINK_TYPES}
                   AND p.deleted_at IS NULL${privateFilter}
                   AND p.slug > ?
                 ORDER BY p.slug ASC LIMIT ?`
            ).bind(...part, cursor, pageSize).all<PageNodeRow>();
            const rows = (res.results || []) as PageNodeRow[];
            for (const r of rows) {
                cursor = r.slug; // 정렬이 slug ASC 이므로 커서 전진
                if (knownSlugs.has(r.slug) || seen.has(r.slug)) continue;
                seen.add(r.slug);
                out.push(r);
                if (out.length >= budget) break;
            }
            if (rows.length < pageSize) break; // 이 청크의 이웃 소진
        }
    }
    return out;
}

/** 엣지 키셋 페이지네이션 안전장치 — 한 소스 청크당 최대 SQL 패스 수. */
const EDGE_MAX_PASSES = 8;

/**
 * 노드 집합 내부 문서들 사이의 엣지(직접 참조)만 수집한다.
 *
 * - `target_slug IN <노드 집합>` 을 SQL 에 넣으면 노드가 수백 개일 때 바인드 변수 한도(≈100)를
 *   넘으므로, 도착 노드 필터는 JS(`nodeSlugSet.has`)로 처리한다.
 * - 단순 `LIMIT` 만 쓰면 `ORDER BY source_page_id` 상 첫 소스(허브 문서)가 limit 을 전부
 *   소진해 같은 청크의 다른 노드 엣지가 누락될 수 있다. 따라서 `(source_page_id, target_slug)`
 *   **복합 키셋 페이지네이션**으로 허브를 지나 끝까지 훑되, 내부 엣지 budget(`limit`)을 채우면
 *   중단한다. 바인드는 (소스 청크 ≤IN_CHUNK) + 커서 3 + LIMIT 1 로 한도 안.
 *   (같은 소스·도착에 link_type 이 둘인 희귀 경우 한쪽이 생략될 수 있으나, 엣지 자체는 표시되고
 *    선 스타일만 영향받는 수준이라 무시 가능.)
 */
async function queryEdgesAmong(
    db: D1Database,
    sourceIds: number[],
    nodeSlugSet: Set<string>,
    limit: number,
): Promise<{ source_page_id: number; target_slug: string; link_type: string }[]> {
    const out: { source_page_id: number; target_slug: string; link_type: string }[] = [];
    for (const part of chunk(sourceIds, IN_CHUNK)) {
        if (part.length === 0 || out.length >= limit) break;
        const sourcePh = part.map(() => '?').join(',');
        let curId = 0;
        let curSlug = '';
        for (let pass = 0; pass < EDGE_MAX_PASSES && out.length < limit; pass++) {
            const pageSize = Math.min((limit - out.length) + IN_CHUNK, GRAPH_EDGE_CAP + IN_CHUNK);
            const res = await db.prepare(
                `SELECT source_page_id, target_slug, link_type FROM page_links
                 WHERE source_page_id IN (${sourcePh}) AND blog = 0 AND source_type = 'page'
                   AND link_type IN ${GRAPH_LINK_TYPES}
                   AND (source_page_id > ? OR (source_page_id = ? AND target_slug > ?))
                 ORDER BY source_page_id ASC, target_slug ASC LIMIT ?`
            ).bind(...part, curId, curId, curSlug, pageSize).all<{ source_page_id: number; target_slug: string; link_type: string }>();
            const rows = res.results || [];
            for (const r of rows) {
                curId = r.source_page_id;
                curSlug = r.target_slug;
                if (nodeSlugSet.has(r.target_slug)) {
                    out.push(r);
                    if (out.length >= limit) break;
                }
            }
            if (rows.length < pageSize) break; // 이 소스 청크 소진
        }
    }
    return out;
}

export async function buildGraphData(opts: BuildGraphOptions): Promise<GraphData> {
    const { db, baseSlug, canSeePrivate } = opts;
    const depth = Math.min(Math.max(Math.trunc(opts.depth) || 1, 1), GRAPH_MAX_DEPTH);

    // 중심 노드. 존재하지 않으면(레드링크/비공개 차단) 빈 그래프.
    const centerRows = await fetchNodesBySlug(db, [baseSlug], canSeePrivate);
    if (centerRows.length === 0) {
        return { center: baseSlug, centerExists: false, depth, nodes: [], edges: [], truncated: false, hasPrivate: false };
    }

    const nodesBySlug = new Map<string, PageNodeRow>();
    nodesBySlug.set(centerRows[0].slug, centerRows[0]);

    let truncated = false;
    let frontier: PageNodeRow[] = [centerRows[0]];

    // 홉별 BFS 확장 — 아웃링크(이 문서가 가리키는 문서) + 인링크(이 문서를 가리키는 문서) 양방향.
    for (let hop = 0; hop < depth; hop++) {
        if (frontier.length === 0 || nodesBySlug.size >= GRAPH_NODE_CAP) break;
        const frontierIds = frontier.map(r => r.id);
        const frontierSlugs = frontier.map(r => r.slug);

        // 남은 노드 예산(+여유 1). 이미 아는 노드는 fetchNewNeighbors 가 제외하므로 이 예산은
        // 온전히 **새** 노드에만 적용된다(이미 발견된 이웃이 budget 을 소진해 새 이웃을 굶기지 않음).
        const remainingBudget = GRAPH_NODE_CAP - nodesBySlug.size + 1;
        const knownSlugs = new Set(nodesBySlug.keys());

        // 아웃/인 양방향에서 아직 모르는 표시 가능한 이웃만 예산만큼 가져온다.
        const [outPages, inSources] = await Promise.all([
            fetchNewNeighbors({ db, direction: 'out', frontierKeys: frontierIds, knownSlugs, canSeePrivate, budget: remainingBudget }),
            fetchNewNeighbors({ db, direction: 'in', frontierKeys: frontierSlugs, knownSlugs, canSeePrivate, budget: remainingBudget }),
        ]);

        // 후보(새 노드) 수집 — slug 기준 dedup, 결정적 순서를 위해 정렬.
        // (fetchNewNeighbors 가 이미 knownSlugs 를 제외하지만, out/in 이 같은 노드를 반환할 수 있어 dedup.)
        const candidatesBySlug = new Map<string, PageNodeRow>();
        for (const r of inSources) if (!nodesBySlug.has(r.slug)) candidatesBySlug.set(r.slug, r);
        for (const r of outPages) if (!nodesBySlug.has(r.slug)) candidatesBySlug.set(r.slug, r);
        const candidates = Array.from(candidatesBySlug.values()).sort((a, b) => a.slug.localeCompare(b.slug));

        const nextFrontier: PageNodeRow[] = [];
        for (const r of candidates) {
            if (nodesBySlug.size >= GRAPH_NODE_CAP) { truncated = true; break; }
            nodesBySlug.set(r.slug, r);
            nextFrontier.push(r);
        }
        frontier = nextFrontier;
    }

    // 노드 집합 내부의 모든 엣지를 한 번에 수집한 뒤, 양 끝이 모두 노드인 것만 남긴다.
    // (2홉 외곽 노드 사이의 엣지까지 포착하기 위해 BFS 와 분리한 최종 패스.)
    const nodeRows = Array.from(nodesBySlug.values());
    const idToSlug = new Map<number, string>(nodeRows.map(r => [r.id, r.slug]));
    const nodeSlugSet = new Set(nodesBySlug.keys());
    // 엣지 예산 + 여유: 방향별 dedup·mutual 병합 전 raw 엣지라, 캡보다 약간 넉넉히 가져와
    // 손실을 줄이되 항상 경계 안에 둔다.
    const rawEdges = await queryEdgesAmong(db, nodeRows.map(r => r.id), nodeSlugSet, GRAPH_EDGE_CAP + 1);
    // SQL LIMIT 에 걸려 일부 엣지가 잘렸다면 사용자에게 알린다(아래 dedup 후엔 mutual 병합으로
    // edges.length 가 캡 밑일 수 있어 이 단계에서 판정).
    if (rawEdges.length > GRAPH_EDGE_CAP) truncated = true;

    const edges: GraphEdge[] = [];
    const edgeSeen = new Set<string>();
    for (const e of rawEdges) {
        const src = idToSlug.get(e.source_page_id);
        if (!src) continue;
        if (!nodeSlugSet.has(e.target_slug)) continue;
        if (src === e.target_slug) continue; // 자기참조 제외
        const key = `${src}\u0000${e.target_slug}\u0000${e.link_type}`;
        if (edgeSeen.has(key)) continue;
        edgeSeen.add(key);
        edges.push({ source: src, target: e.target_slug, type: e.link_type as GraphEdge['type'] });
        if (edges.length >= GRAPH_EDGE_CAP) { truncated = true; break; }
    }

    const nodes: GraphNode[] = nodeRows.map(r => ({
        slug: r.slug,
        title: r.title,
        category: r.category,
        isPrivate: r.is_private === 1,
        isCenter: r.slug === baseSlug,
        characters: r.characters ?? 0,
    }));
    const hasPrivate = nodes.some(n => n.isPrivate);

    return { center: baseSlug, centerExists: true, depth, nodes, edges, truncated, hasPrivate };
}
