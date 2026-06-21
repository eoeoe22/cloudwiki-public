import { Hono } from 'hono';
import type { Env } from '../types';
import { trackSearch } from '../utils/analytics';
import { fetchMediaTagMap } from '../utils/mediaTags';
import type { RBAC } from '../utils/role';

// 이미지 검색 결과의 본문 미리보기 최대 길이.
// 서버에서 본문을 이 길이로 절단하고 필요 시 '...'을 붙여 응답 크기를 제한한다.
// 클라이언트는 안전장치로만 동일 기준의 재절단을 수행할 수 있다.
const IMAGE_CONTENT_PREVIEW = 200;

const search = new Hono<Env>();

// 페이지네이션 상수: 서버/클라이언트 모두 이 값을 기준으로 계산.
// 변경 시 API 응답의 pageSize 로 프런트에 전달되어 자동 반영된다.
const PAGE_SIZE = 10;

// LIKE fallback 경로(<3글자 트라이그램 미스 또는 FTS5 오류)에서 사용할 스니펫 좌/우 컨텍스트 길이.
// FTS5 snippet()의 num_tokens=40과 유사한 노출 범위를 만들기 위해 좌 20 / 우 60 codepoints로 잡는다.
const LIKE_SNIPPET_LEFT = 20;
const LIKE_SNIPPET_RIGHT = 60;

function escapeForHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * LIKE fallback 경로에서 본문/슬러그로부터 직접 <mark> 하이라이트가 포함된 스니펫을 생성한다.
 * 본문에 매치가 있으면 본문 기준으로, 그렇지 않고 슬러그에 매치가 있으면 슬러그 기준으로 만든다.
 * 둘 다 없으면 빈 문자열을 반환한다.
 *
 * 반환의 `bodyMatch` 는 스니펫이 **본문(content)** 매치로 만들어졌는지를 나타낸다(슬러그 매치는 false).
 * 클라이언트는 이 값으로 "카드 body 클릭 시 문서를 열고 해당 위치로 하이라이트 스크롤"할지,
 * 아니면 "그냥 문서로만 이동"할지를 결정한다. 본문에 검색어가 실제로 존재해야만(=bodyMatch)
 * 문서 페이지의 ?highlight= 스크롤이 의미를 가지므로 슬러그/제목 전용 매치와 구분한다.
 */
function buildLikeSnippet(slug: string, content: string, query: string): { html: string; bodyMatch: boolean } {
    if (!query) return { html: '', bodyMatch: false };
    const q = query.toLowerCase();

    const findAndSlice = (src: string): string | null => {
        if (!src) return null;
        const idx = src.toLowerCase().indexOf(q);
        if (idx < 0) return null;
        const start = Math.max(0, idx - LIKE_SNIPPET_LEFT);
        const end = Math.min(src.length, idx + query.length + LIKE_SNIPPET_RIGHT);
        const before = src.slice(start, idx);
        const match = src.slice(idx, idx + query.length);
        const after = src.slice(idx + query.length, end);
        return (start > 0 ? '...' : '')
            + escapeForHtml(before)
            + '<mark>' + escapeForHtml(match) + '</mark>'
            + escapeForHtml(after)
            + (end < src.length ? '...' : '');
    };

    const fromContent = findAndSlice(content);
    if (fromContent !== null) return { html: fromContent, bodyMatch: true };
    const fromSlug = findAndSlice(slug);
    if (fromSlug !== null) return { html: fromSlug, bodyMatch: false };
    return { html: '', bodyMatch: false };
}

/**
 * 검색 날짜 필터 파싱: 'YYYY-MM-DD' 만 허용하고 UTC 자정 기준 unixepoch(초)로 변환한다.
 * endOfDay=true 면 그날의 마지막 초(+86399)를 반환해 `to` 를 포함 범위(inclusive)로 만든다.
 * 형식이 어긋나거나 롤오버되는 무효 날짜(예: 2026-13-40)는 null 을 반환해 필터를 무시한다.
 * pages.updated_at 은 unixepoch() 초 단위이므로 동일 단위로 비교한다.
 */
function parseDateParam(s: string | undefined, endOfDay: boolean): number | null {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const ms = Date.UTC(year, month - 1, day);
    if (!Number.isFinite(ms)) return null;
    // Date.UTC 는 범위를 벗어난 값을 롤오버하므로 역검증으로 실제 유효 날짜만 통과시킨다.
    const d = new Date(ms);
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
        return null;
    }
    const base = Math.floor(ms / 1000);
    return endOfDay ? base + 86399 : base;
}

/**
 * GET /search?q=키워드&mode=content|category
 * mode=content (기본값): FTS5 기반 전문 검색
 * mode=category: 카테고리 이름으로 문서 목록 반환
 *
 * 이미지 문서 검색: 쿼리가 "이미지:"로 시작하면 media 테이블에서 filename/content를 검색한다.
 * 카테고리 검색: 쿼리가 "카테고리:"로 시작하면 page_categories 에서 매치하는 카테고리를
 *                가상 문서로 취급해 노출한다(설명 문서가 없는 카테고리도 포함).
 * 일반 문서 검색 결과에는 이미지/카테고리 가상 문서가 포함되지 않는다.
 */
search.get('/search', async (c) => {
    const query = c.req.query('q');
    const mode = c.req.query('mode') || 'content';
    const user = c.get('user');

    if (!query || query.trim().length === 0) {
        return c.json({ results: [], total: 0, page: 1, pageSize: PAGE_SIZE });
    }

    const db = c.env.DB;
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = user && rbac.can(user.role, 'admin:access');
    const canSeePrivate = rbac.can(user?.role ?? 'guest', 'wiki:private');
    const privateFilter = canSeePrivate ? '' : ' AND is_private = 0';

    // ── 일반 문서 검색 필터(보고서 기반): 정렬/필드/카테고리/날짜/비공개 토글 ──
    // 이 필터들은 일반 문서 검색(FTS5 + LIKE fallback) 경로에만 적용한다.
    // 이미지(이미지:)·카테고리 가상(카테고리:)·mode=category·exact_match 경로에는 적용하지 않는다.
    const SORTS = new Set(['relevance', 'recent', 'title']);
    const sortParam = c.req.query('sort') ?? '';
    const sort = SORTS.has(sortParam) ? sortParam : 'relevance';
    const FIELDS = new Set(['all', 'title', 'body']);
    const fieldParam = c.req.query('field') ?? '';
    const field = FIELDS.has(fieldParam) ? fieldParam : 'all';
    const categoryFilter = (c.req.query('category') || '').trim();
    const fromTs = parseDateParam(c.req.query('from'), false);
    const toTs = parseDateParam(c.req.query('to'), true);
    // 비공개 포함 토글: wiki:private 보유자만 끌 수 있다(기본 포함). 권한 미달이면 무시(강제 제외 유지).
    const includePrivate = c.req.query('include_private') !== '0';
    const effectiveSeePrivate = canSeePrivate && includePrivate;

    // category(정확 일치) + 날짜 범위 추가필터 SQL 조각 빌더.
    // FTS 경로는 별칭 'p', LIKE 경로는 별칭 없이('') 호출해 동일 조건을 재사용한다.
    const buildExtraFilters = (alias: string): { sql: string; binds: unknown[] } => {
        const a = alias ? alias + '.' : '';
        const parts: string[] = [];
        const binds: unknown[] = [];
        if (categoryFilter) {
            parts.push(`AND EXISTS (SELECT 1 FROM page_categories pc WHERE pc.page_id = ${a}id AND pc.category = ?)`);
            binds.push(categoryFilter);
        }
        if (fromTs !== null) { parts.push(`AND ${a}updated_at >= ?`); binds.push(fromTs); }
        if (toTs !== null) { parts.push(`AND ${a}updated_at <= ?`); binds.push(toTs); }
        return { sql: parts.length ? ' ' + parts.join(' ') : '', binds };
    };

    const searchStartTime = Date.now();

    // 서버 사이드 페이지네이션: 페이지당 PAGE_SIZE 건, LIMIT/OFFSET 으로 DB 부하 최소화.
    // 분석(trackSearch)은 첫 페이지에서만 기록해 동일 세션의 페이지 이동이 중복 집계되지 않도록 한다.
    const pageParam = parseInt(c.req.query('page') || '1', 10);
    const requestedPage = Number.isFinite(pageParam) && pageParam >= 1 ? pageParam : 1;
    const shouldTrack = requestedPage === 1;

    // total 을 알고 난 뒤 호출: 요청된 페이지가 마지막 페이지를 넘어가면 마지막 페이지로 클램프해
    // total>0 인데 results=[] 가 되는 상황을 방지한다. 응답의 page 필드는 실제 반환된 페이지다.
    const clampPage = (total: number) => {
        if (total <= 0) return { page: 1, offset: 0 };
        const totalPages = Math.ceil(total / PAGE_SIZE);
        const p = Math.min(requestedPage, totalPages);
        return { page: p, offset: (p - 1) * PAGE_SIZE };
    };

    // 이미지 문서 검색 모드: "이미지:키워드"로 시작하면 media 테이블에서 검색한다.
    // 매치가 전혀 없으면 legacy pages.slug의 '이미지:' 네임스페이스 호환을 위해
    // 아래 일반 검색 경로로 폴스루한다(wiki.get('/w/:slug')의 폴스루와 일관 유지).
    if (mode === 'content' && query.trim().startsWith('이미지:')) {
        if (c.env.WIKI_VISIBILITY === 'closed' && !user) {
            return c.json({ error: '로그인이 필요합니다.' }, 401);
        }
        const imageQuery = query.trim().substring('이미지:'.length).trim();

        // filename 또는 content에 LIKE 매치
        // LIKE 메타문자(%, _, \)를 escape 해 사용자가 입력한 문자열 그대로만 매치한다(와일드카드 주입 방지).
        const imageLikeEscaped = imageQuery.replace(/[\\%_]/g, '\\$&');
        const likePattern = imageQuery.length > 0 ? `%${imageLikeEscaped}%` : '%';

        const totalRow = await db
            .prepare("SELECT COUNT(*) as total FROM media WHERE filename LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'")
            .bind(likePattern, likePattern)
            .first<{ total: number }>();
        const total = totalRow?.total ?? 0;

        if (total > 0) {
            const { page, offset } = clampPage(total);
            // 파일명 LIKE 매치를 content 매치보다 우선하기 위해 정렬 키에 CASE를 추가한다.
            const { results } = await db
                .prepare(
                    `SELECT id, r2_key, filename, mime_type, content
                     FROM media
                     WHERE filename LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
                     ORDER BY (CASE WHEN filename LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END), created_at DESC
                     LIMIT ? OFFSET ?`
                )
                .bind(likePattern, likePattern, likePattern, PAGE_SIZE, offset)
                .all<{ id: number; r2_key: string; filename: string; mime_type: string; content: string }>();

            const tagMap = await fetchMediaTagMap(db, results.map(r => r.id));

            const imageResults = results.map((r) => {
                const slug = `이미지:${r.filename}`;
                let snippet = '';
                if (imageQuery && r.content) {
                    const idx = r.content.toLowerCase().indexOf(imageQuery.toLowerCase());
                    if (idx >= 0) {
                        const start = Math.max(0, idx - 20);
                        const end = Math.min(r.content.length, idx + imageQuery.length + 40);
                        const raw = (start > 0 ? '…' : '') + r.content.slice(start, end) + (end < r.content.length ? '…' : '');
                        snippet = raw
                            .replace(/&/g, '&amp;')
                            .replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;')
                            .replace(/"/g, '&quot;')
                            .replace(/'/g, '&#039;');
                    }
                }
                const rawContent = (r.content || '').trim();
                const contentPreview = rawContent.length > IMAGE_CONTENT_PREVIEW
                    ? rawContent.slice(0, IMAGE_CONTENT_PREVIEW) + '...'
                    : rawContent;
                return {
                    slug,
                    isDeleted: false,
                    is_image_doc: true,
                    r2_key: r.r2_key,
                    mime_type: r.mime_type,
                    snippet,
                    tags: tagMap.get(r.id) || [],
                    content: contentPreview,
                };
            });

            if (shouldTrack) trackSearch(c, query.trim(), total, Date.now() - searchStartTime);
            return c.json({ results: imageResults, image_mode: true, total, page, pageSize: PAGE_SIZE, contentPreviewLength: IMAGE_CONTENT_PREVIEW });
        }
        // media에서 결과가 없으면 아래 일반 pages 검색으로 폴스루
    }

    // 카테고리 가상 문서 검색 모드: "카테고리:키워드"로 시작하면 page_categories 에서 매치하는
    // 카테고리를 가상 문서로 취급해 노출한다. 설명 문서('카테고리:이름' 페이지)가 존재하지 않는
    // 카테고리도 결과에 포함된다.
    // 매치가 전혀 없으면 (예: 사용자가 카테고리 설명 문서 자체를 찾고 있는 경우) 아래
    // 일반 pages 검색으로 폴스루한다(이미지: 네임스페이스 분기와 동일한 fallthrough 패턴).
    if (mode === 'content' && query.trim().startsWith('카테고리:')) {
        if (c.env.WIKI_VISIBILITY === 'closed' && !user) {
            return c.json({ error: '로그인이 필요합니다.' }, 401);
        }
        const catQuery = query.trim().substring('카테고리:'.length).trim();
        // LIKE 메타문자 escape — 사용자가 입력한 문자열 그대로만 매치한다.
        const likeEscaped = catQuery.replace(/[\\%_]/g, '\\$&');
        const likePattern = catQuery.length > 0 ? `%${likeEscaped}%` : '%';
        const startPattern = catQuery.length > 0 ? `${likeEscaped}%` : '%';

        // page_categories 의 카테고리는 pages 와 join 해 사용자 권한에 맞는 가시 문서만 카운트.
        const visibility = (isAdmin ? '' : ' AND p.deleted_at IS NULL') + (canSeePrivate ? '' : ' AND p.is_private = 0');

        const totalRow = await db
            .prepare(
                `SELECT COUNT(DISTINCT pc.category) as total
                 FROM page_categories pc
                 JOIN pages p ON p.id = pc.page_id
                 WHERE pc.category LIKE ? ESCAPE '\\'${visibility}`
            )
            .bind(likePattern)
            .first<{ total: number }>();
        const total = totalRow?.total ?? 0;

        if (total > 0) {
            const { page, offset } = clampPage(total);
            // prefix(시작) 매치를 substring 매치보다 우선해 정렬. 동률은 카테고리 이름 오름차순.
            const sql = `
                SELECT pc.category AS name, COUNT(DISTINCT pc.page_id) AS page_count
                FROM page_categories pc
                JOIN pages p ON p.id = pc.page_id
                WHERE pc.category LIKE ? ESCAPE '\\'${visibility}
                GROUP BY pc.category
                ORDER BY (CASE WHEN pc.category LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END), pc.category
                LIMIT ? OFFSET ?
            `;
            const results = await db
                .prepare(sql)
                .bind(likePattern, startPattern, PAGE_SIZE, offset)
                .all<{ name: string; page_count: number }>();

            // 페이지된 카테고리에 대해 설명 문서('카테고리:이름' 페이지) 존재 여부 일괄 조회.
            const catSlugs = results.results.map((r) => `카테고리:${r.name}`);
            let existingDocs = new Set<string>();
            if (catSlugs.length > 0) {
                const placeholders = catSlugs.map(() => '?').join(',');
                const docVisibility = (isAdmin ? '' : ' AND deleted_at IS NULL') + privateFilter;
                const docRows = await db
                    .prepare(`SELECT slug FROM pages WHERE slug IN (${placeholders})${docVisibility}`)
                    .bind(...catSlugs)
                    .all<{ slug: string }>();
                existingDocs = new Set(docRows.results.map((r) => r.slug));
            }

            const categoryResults = results.results.map((r) => {
                const slug = `카테고리:${r.name}`;
                return {
                    slug,
                    isDeleted: false,
                    is_category_doc: true,
                    page_count: r.page_count,
                    has_description: existingDocs.has(slug),
                };
            });

            if (shouldTrack) trackSearch(c, query.trim(), total, Date.now() - searchStartTime);
            return c.json({ results: categoryResults, category_mode: true, total, page, pageSize: PAGE_SIZE });
        }
        // page_categories 매치가 없으면 아래 일반 pages 검색으로 폴스루(설명 문서 검색 가능).
    }

    const trimmedQuery = query.trim();

    // 페이지네이션 결과만으로는 정확 일치 여부를 확정할 수 없으므로(슬러그가 페이지 2 이후로
    // 밀려나는 경우 가능) 별도로 정확 일치 존재 여부를 조회해 응답에 포함시킨다. 클라이언트는
    // 이 플래그로 "새 문서 만들기" CTA 노출 여부를 결정한다. category 모드에서도 동일한
    // CTA 가 노출될 수 있으므로 mode 분기 이전에 한 번만 계산해 모든 응답에 포함시킨다.
    // pages.slug 의 UNIQUE 인덱스를 활용하기 위해 case-sensitive 동등 비교를 사용한다.
    // case-insensitive 대조는 클라이언트가 결과 페이지 슬러그를 toLowerCase() 로 보조 검사한다.
    const exactMatchVisibility = (isAdmin ? '' : ' AND deleted_at IS NULL') + privateFilter;
    // 정확 일치는 슬러그 OR 대체 제목 양쪽에서 검사한다. title 만 일치하는 경우에도 "새 문서 만들기"
    // CTA 가 노출되면 사용자가 클릭해도 서버가 409(slug↔title 충돌) 로 거부하므로 일관성 깨짐.
    // 정확 일치 문서의 slug·title 을 함께 가져와, 클라이언트가 "제목이 일치하는 문서" 카드를
    // 결과 최상단에 별도로 노출할 수 있게 한다(이동 경로는 항상 slug). 슬러그 일치를 제목
    // 일치보다 우선하고(같은 쿼리가 한 문서의 slug 와 다른 문서의 title 에 동시 매치하는 경우),
    // 표시명은 클라이언트가 title 우선·없으면 slug 로 결정한다.
    const exactMatchRow = await db
        .prepare(`SELECT slug, title FROM pages WHERE (slug = ?1 OR title = ?1)${exactMatchVisibility} ORDER BY (CASE WHEN slug = ?1 THEN 0 ELSE 1 END) LIMIT 1`)
        .bind(trimmedQuery)
        .first<{ slug: string; title: string | null }>();
    const exactMatch = !!exactMatchRow;
    const exactMatchPage = exactMatchRow
        ? { slug: exactMatchRow.slug, title: exactMatchRow.title }
        : null;

    // 카테고리 검색 모드
    if (mode === 'category') {
        const visibility = (isAdmin ? '' : ' AND deleted_at IS NULL') + privateFilter;

        const totalRow = await db
            .prepare(`SELECT COUNT(*) as total FROM pages WHERE category = ?${visibility}`)
            .bind(trimmedQuery)
            .first<{ total: number }>();
        const total = totalRow?.total ?? 0;
        const { page, offset } = clampPage(total);

        const sql = `
            SELECT slug, category, deleted_at
            FROM pages
            WHERE category = ?${visibility}
            ORDER BY slug LIMIT ? OFFSET ?
        `;
        const results = await db.prepare(sql).bind(trimmedQuery, PAGE_SIZE, offset).all();
        if (shouldTrack) trackSearch(c, trimmedQuery, total, Date.now() - searchStartTime);
        return c.json({ results: results.results, mode: 'category', total, page, pageSize: PAGE_SIZE, exact_match: exactMatch, exact_match_page: exactMatchPage });
    }

    // 제목(=slug)+내용 검색 모드 (FTS5)

    // Trigram 토크나이저: 3 codepoint 미만은 FTS5 MATCH에서 매치 불가 → LIKE fallback.
    // String.length 는 UTF-16 code unit 기준이라 비-BMP 문자(이모지 등)에서 codepoint 수와
    // 어긋난다. trigram 은 codepoint 단위로 토크나이즈하므로 [...]로 codepoint 수를 센다.
    const queryCodepointLength = [...trimmedQuery].length;

    // LIKE 기반 검색(짧은 쿼리 / field=title / FTS5 오류 fallback 공용 경로).
    // field 에 따라 매칭 컬럼(슬러그·제목·본문)을 좁히고, sort/카테고리/날짜/비공개 필터를 함께 반영한다.
    const runLikeSearch = async () => {
        const visibility = (isAdmin ? '' : ' AND deleted_at IS NULL') + (effectiveSeePrivate ? '' : ' AND is_private = 0');
        // LIKE 메타문자(%, _, \)를 escape 해 사용자가 입력한 문자열 그대로만 매치한다.
        const likeEscaped = trimmedQuery.replace(/[\\%_]/g, '\\$&');
        const likePattern = `%${likeEscaped}%`;
        const extra = buildExtraFilters('');

        // field 별 매칭 컬럼 집합: title=슬러그/제목, body=본문, all=셋 다.
        let whereCols: string;
        const whereBinds: unknown[] = [];
        if (field === 'title') {
            whereCols = `(slug LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')`;
            whereBinds.push(likePattern, likePattern);
        } else if (field === 'body') {
            whereCols = `(content LIKE ? ESCAPE '\\')`;
            whereBinds.push(likePattern);
        } else {
            whereCols = `(slug LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')`;
            whereBinds.push(likePattern, likePattern, likePattern);
        }
        const whereSql = `WHERE ${whereCols}${visibility}${extra.sql}`;

        const totalRow = await db
            .prepare(`SELECT COUNT(*) as total FROM pages ${whereSql}`)
            .bind(...whereBinds, ...extra.binds)
            .first<{ total: number }>();
        const total = totalRow?.total ?? 0;
        const { page, offset } = clampPage(total);

        // sort 별 정렬. relevance 는 슬러그>제목>본문 우선 후 updated_at DESC.
        let orderSql: string;
        const orderBinds: unknown[] = [];
        // 모든 정렬에 고유 slug 를 최종 타이브레이커로 붙여 페이지네이션을 결정적으로 만든다(FTS 경로와 동일).
        if (sort === 'recent') {
            orderSql = 'ORDER BY updated_at DESC, slug ASC';
        } else if (sort === 'title') {
            // 결과 카드는 표시 제목(title 우선, 없으면 slug)을 렌더하므로 동일 키로 정렬한다.
            orderSql = 'ORDER BY COALESCE(title, slug) ASC, slug ASC';
        } else {
            orderSql = `ORDER BY (CASE WHEN slug LIKE ? ESCAPE '\\' THEN 0
                          WHEN title LIKE ? ESCAPE '\\' THEN 1
                          ELSE 2 END), updated_at DESC, slug ASC`;
            orderBinds.push(likePattern, likePattern);
        }

        // 스니펫을 직접 만들기 위해 content도 함께 가져온다.
        const sql = `
            SELECT slug, title, content, deleted_at
            FROM pages
            ${whereSql}
            ${orderSql}
            LIMIT ? OFFSET ?
        `;
        const results = await db.prepare(sql)
            .bind(...whereBinds, ...extra.binds, ...orderBinds, PAGE_SIZE, offset)
            .all<{ slug: string; title: string | null; content: string; deleted_at: number | null }>();

        const safeResults = results.results.map((r) => {
            const snip = buildLikeSnippet(r.slug, r.content, trimmedQuery);
            return {
                slug: r.slug,
                title: r.title,
                deleted_at: r.deleted_at,
                isDeleted: !!r.deleted_at,
                snippet: snip.html,
                bodyMatch: snip.bodyMatch,
            };
        });

        if (shouldTrack) trackSearch(c, trimmedQuery, total, Date.now() - searchStartTime);
        return c.json({ results: safeResults, total, page, pageSize: PAGE_SIZE, exact_match: exactMatch, exact_match_page: exactMatchPage, applied: { sort, field } });
    };

    // 트라이그램 미스(<3 codepoint) 또는 제목 전용 검색(field=title)은 FTS 를 건너뛰고 LIKE 로 처리한다.
    if (queryCodepointLength < 3 || field === 'title') {
        return await runLikeSearch();
    }

    // FTS5 Trigram 검색 (3글자 이상, field=all|body)
    //
    // 하이라이트 스니펫은 FTS5 의 snippet() 보조함수를 쓰지 않고 본문에서 직접 만든다.
    // pages_fts 는 trigram 토크나이저 + 외부 콘텐츠(content=pages) 테이블이라, snippet()
    // 이 계산하는 <mark> 오프셋이 멀티바이트(한글) 본문에서 토큰 경계와 어긋나 "전혀 다른
    // 부분"을 하이라이트하는 경우가 있었다. 따옴표로 감싼 phrase MATCH 는 사실상 substring
    // 매칭이므로, 매치된 행의 본문에는 검색어가 그대로 존재한다 → buildLikeSnippet 으로
    // 리터럴 substring 위치에 정확히 <mark> 를 단다(다른 fallback 경로와 동일한 방식).
    // FTS5 는 행 선별/랭킹용으로만 사용한다.
    try {
        const visibility = (isAdmin ? '' : ' AND p.deleted_at IS NULL') + (effectiveSeePrivate ? '' : ' AND p.is_private = 0');

        // Trigram 토크나이저에서는 따옴표로 감싸면 정확한 substring 매칭
        const safeMatchQuery = '"' + trimmedQuery.replace(/"/g, '""') + '"';

        // 슬러그/title LIKE 패턴 (정렬 키 + title 보조 매칭용).
        // pages_fts 가 (slug, title, content) 3컬럼 trigram 인덱싱이므로 FTS MATCH 만으로도
        // title 매치가 포함되어야 하지만, 과거 스키마에서 마이그레이션된 인덱스에 title 컬럼이
        // 누락된 경우에도 title 만 일치한 문서를 결과에 포함시키기 위해 OR p.title LIKE ? 를
        // 명시적으로 추가한다. CLAUDE.md 규칙(검색 디스커버리는 title 도 LIKE 매칭 대상)에 일치.
        // 사용자 입력 그대로만 매치되도록 LIKE 메타문자(%, _, \)를 escape 한 후 ESCAPE '\' 사용.
        // (예: 검색어 "100%"가 모든 행에 매치되어 결과가 부풀려지는 현상 방지)
        const likeEscaped = trimmedQuery.replace(/[\\%_]/g, '\\$&');
        const likePattern = `%${likeEscaped}%`;
        const extra = buildExtraFilters('p');

        // field 별 WHERE: all=(FTS OR 제목 LIKE), body=(FTS AND 본문 LIKE).
        // (field=title 은 위에서 LIKE 경로로 분기되어 여기 도달하지 않는다.)
        // 두 경우 모두 FTS subquery 의 MATCH 바인드 1개 + 컬럼 LIKE 바인드 1개로 동일하다.
        const whereCols = field === 'body'
            ? `(fts.rowid IS NOT NULL AND p.content LIKE ? ESCAPE '\\')`
            : `(fts.rowid IS NOT NULL OR p.title LIKE ? ESCAPE '\\')`;
        const whereSql = `WHERE ${whereCols}${visibility}${extra.sql}`;

        const totalRow = await db
            .prepare(
                `SELECT COUNT(*) as total
                 FROM pages p
                 LEFT JOIN (SELECT rowid FROM pages_fts WHERE pages_fts MATCH ?) AS fts
                   ON fts.rowid = p.id
                 ${whereSql}`
            )
            .bind(safeMatchQuery, likePattern, ...extra.binds)
            .first<{ total: number }>();
        const total = totalRow?.total ?? 0;
        const { page, offset } = clampPage(total);

        // sort 별 정렬. relevance 는 슬러그/title LIKE 매치를 FTS rank 보다 우선한다.
        // FTS 는 행 선별/랭킹용으로만 사용하고, 스니펫(<mark>)은 아래에서 본문 기준으로 직접 만든다.
        let orderSql: string;
        const orderBinds: unknown[] = [];
        // 모든 정렬에 고유 slug 를 최종 타이브레이커로 붙여 LIMIT/OFFSET 페이지네이션을 결정적으로 만든다
        // (updated_at 은 초 단위라 동률이 흔하고, 동률 시 SQLite 의 행 순서는 미정의).
        if (sort === 'recent') {
            orderSql = 'ORDER BY p.updated_at DESC, p.slug ASC';
        } else if (sort === 'title') {
            // 결과 카드는 표시 제목(title 우선, 없으면 slug)을 렌더하므로 동일 키로 정렬한다.
            orderSql = 'ORDER BY COALESCE(p.title, p.slug) ASC, p.slug ASC';
        } else {
            orderSql = `ORDER BY (CASE WHEN p.slug LIKE ? ESCAPE '\\' THEN 0
                          WHEN p.title LIKE ? ESCAPE '\\' THEN 1
                          ELSE 2 END),
                    CASE WHEN fts.rank IS NULL THEN 1 ELSE 0 END,
                    fts.rank, p.slug ASC`;
            orderBinds.push(likePattern, likePattern);
        }

        const sql = `
           SELECT p.slug, p.title, p.content, p.deleted_at,
                  fts.rank as rank
           FROM pages p
           LEFT JOIN (
               SELECT rowid, rank
               FROM pages_fts
               WHERE pages_fts MATCH ?
           ) AS fts ON fts.rowid = p.id
           ${whereSql}
           ${orderSql}
           LIMIT ? OFFSET ?
        `;

        const results = await db
            .prepare(sql)
            .bind(safeMatchQuery, likePattern, ...extra.binds, ...orderBinds, PAGE_SIZE, offset)
            .all<{ slug: string; title: string | null; content: string; deleted_at: number | null; rank: number | null }>();

        // 스니펫은 본문에서 리터럴 substring 위치를 찾아 직접 <mark> 를 단다(escape 포함).
        // title 로만 매치된 행은 본문에 검색어가 없을 수 있으나, buildLikeSnippet 이 본문→슬러그
        // 순으로 탐색해 매치가 없으면 빈 문자열을 반환한다(표시명은 title 이 노출됨).
        // bodyMatch 는 스니펫이 본문 매치로 만들어졌는지를 알려, 클라이언트가 카드 body 클릭 시
        // ?highlight= 로 해당 위치까지 스크롤할지(본문 매치) 단순 이동할지(제목/슬러그 매치)를 가른다.
        const safeResults = results.results.map((r) => {
            const snip = buildLikeSnippet(r.slug, r.content || '', trimmedQuery);
            return {
                slug: r.slug,
                title: r.title,
                deleted_at: r.deleted_at,
                isDeleted: !!r.deleted_at,
                snippet: snip.html,
                bodyMatch: snip.bodyMatch,
            };
        });

        if (shouldTrack) trackSearch(c, trimmedQuery, total, Date.now() - searchStartTime);
        return c.json({ results: safeResults, total, page, pageSize: PAGE_SIZE, exact_match: exactMatch, exact_match_page: exactMatchPage, applied: { sort, field } });
    } catch (ftsError) {
        // FTS5 쿼리 실패 시 LIKE fallback (필터/정렬/필드 동작은 LIKE 경로가 동일하게 처리)
        console.error('FTS5 search failed, falling back to LIKE:', ftsError);
        return await runLikeSearch();
    }
});

/**
 * GET /search/suggest?q=키워드
 * 검색어 2글자 이상일 때 제목이 일치하는 문서 목록 반환 (연관검색어)
 */
search.get('/search/suggest', async (c) => {
    const query = c.req.query('q');
    if (!query || query.trim().length < 2) {
        return c.json({ suggestions: [] });
    }

    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = user && rbac.can(user.role, 'admin:access');
    // public_only=1 → 열람 권한과 무관하게 비공개 문서를 항상 제외한다.
    // (예: 에디터의 "하위 문서 구조 삽입" 루트 문서 선택은 공개 문서만 허용)
    const publicOnly = c.req.query('public_only') === '1';
    const canSeePrivate = !publicOnly && rbac.can(user?.role ?? 'guest', 'wiki:private');
    // exclude_categories=1 → 카테고리 결과를 아예 제외한다. (예: 헤더의 map: 프리픽스 자동완성은
    // 가상 문서를 일반 page 슬러그 기준으로만 매핑하므로, 카테고리가 7개 한도를 잠식하면 안 된다.)
    const excludeCategories = c.req.query('exclude_categories') === '1';
    const trimmed = query.trim();
    const likePattern = `%${trimmed}%`;
    const startPattern = `${trimmed}%`;

    // 1. 카테고리 검색 (exclude_categories=1 이면 건너뛴다)
    const catResults = excludeCategories
        ? { results: [] as Record<string, unknown>[] }
        : await db.prepare(`
            SELECT DISTINCT category FROM page_categories
            WHERE category LIKE ?
            ORDER BY CASE WHEN category LIKE ? THEN 0 ELSE 1 END, length(category)
            LIMIT 7
        `).bind(likePattern, startPattern).all();

    // 2. 문서 검색 — slug 와 대체 title 양쪽에서 매칭. 호출용 식별자는 항상 slug, title 은 표시용.
    let pageSql = `
        SELECT slug, title FROM pages
        WHERE (slug LIKE ? OR title LIKE ?)
    `;
    if (!isAdmin) {
        pageSql += ' AND deleted_at IS NULL';
    }
    if (!canSeePrivate) {
        pageSql += ' AND is_private = 0';
    }
    pageSql += ` ORDER BY (CASE WHEN slug LIKE ? THEN 0
                                WHEN title LIKE ? THEN 1
                                ELSE 2 END),
                          length(slug) LIMIT 7`;

    const pageResults = await db.prepare(pageSql)
        .bind(likePattern, likePattern, startPattern, startPattern)
        .all<{ slug: string; title: string | null }>();

    const suggestions: { slug: string; title?: string | null }[] = [];
    const seenSlugs = new Set<string>();

    // 카테고리 결과를 먼저 추가 (형식: 카테고리:이름)
    for (const r of catResults.results) {
        const catName = r.category as string;
        const slug = `카테고리:${catName}`;
        if (!seenSlugs.has(slug)) {
            suggestions.push({ slug });
            seenSlugs.add(slug);
        }
    }

    // 문서 결과를 추가 (중복 방지)
    for (const r of pageResults.results) {
        if (!seenSlugs.has(r.slug)) {
            suggestions.push({ slug: r.slug, title: r.title });
            seenSlugs.add(r.slug);
        }
    }

    // 최종 결과 7개로 제한
    const finalSuggestions = suggestions.slice(0, 7);

    return c.json({
        suggestions: finalSuggestions,
    });
});

export default search;
