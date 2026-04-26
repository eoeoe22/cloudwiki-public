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
 * LIKE fallback 경로에서 본문/제목으로부터 직접 <mark> 하이라이트가 포함된 스니펫을 생성한다.
 * 본문에 매치가 있으면 본문 기준으로, 그렇지 않고 제목에 매치가 있으면 제목 기준으로 만든다.
 * 둘 다 없으면 빈 문자열을 반환한다.
 */
function buildLikeSnippet(title: string, content: string, query: string): string {
    if (!query) return '';
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

    return findAndSlice(content) ?? findAndSlice(title) ?? '';
}

/**
 * GET /search?q=키워드&mode=content|category
 * mode=content (기본값): FTS5 기반 전문 검색, 정확한 제목 일치 시 redirect 반환
 * mode=category: 카테고리 이름으로 문서 목록 반환
 *
 * 이미지 문서 검색: 쿼리가 "이미지:"로 시작하면 media 테이블에서 filename/content를 검색한다.
 * 일반 문서 검색 결과에는 이미지 문서가 포함되지 않는다.
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

        // "이미지:파일명" 정확 일치 시 해당 이미지 문서로 리다이렉트
        if (imageQuery.length > 0) {
            const exactImage = await db
                .prepare('SELECT filename FROM media WHERE filename = ? LIMIT 1')
                .bind(imageQuery)
                .first<{ filename: string }>();
            if (exactImage) {
                if (shouldTrack) trackSearch(c, query.trim(), 1, Date.now() - searchStartTime);
                return c.json({ redirect: `/w/${encodeURIComponent('이미지:' + exactImage.filename)}` });
            }
        }

        // filename 또는 content에 LIKE 매치
        const likePattern = imageQuery.length > 0 ? `%${imageQuery}%` : '%';

        const totalRow = await db
            .prepare('SELECT COUNT(*) as total FROM media WHERE filename LIKE ? OR content LIKE ?')
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
                     WHERE filename LIKE ? OR content LIKE ?
                     ORDER BY (CASE WHEN filename LIKE ? THEN 0 ELSE 1 END), created_at DESC
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
                    title: slug,
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

    // 카테고리 검색 모드
    if (mode === 'category') {
        const visibility = isAdmin ? '' : ' AND deleted_at IS NULL AND is_private = 0';

        const totalRow = await db
            .prepare(`SELECT COUNT(*) as total FROM pages WHERE category = ?${visibility}`)
            .bind(query.trim())
            .first<{ total: number }>();
        const total = totalRow?.total ?? 0;
        const { page, offset } = clampPage(total);

        const sql = `
            SELECT slug, title, category, deleted_at
            FROM pages
            WHERE category = ?${visibility}
            ORDER BY title LIMIT ? OFFSET ?
        `;
        const results = await db.prepare(sql).bind(query.trim(), PAGE_SIZE, offset).all();
        if (shouldTrack) trackSearch(c, query.trim(), total, Date.now() - searchStartTime);
        return c.json({ results: results.results, mode: 'category', total, page, pageSize: PAGE_SIZE });
    }

    // 제목+내용 검색 모드 (FTS5)
    // FTS 쿼리 전에 먼저 정확한 제목 일치 여부를 확인
    let exactSql = `
        SELECT slug FROM pages
        WHERE title = ?
    `;
    if (!isAdmin) {
        exactSql += ' AND deleted_at IS NULL AND is_private = 0';
    }
    exactSql += ' LIMIT 1';

    const exactMatch = await db.prepare(exactSql).bind(query.trim()).first();
    if (exactMatch) {
        if (shouldTrack) trackSearch(c, query.trim(), 1, Date.now() - searchStartTime);
        return c.json({ redirect: `/w/${encodeURIComponent((exactMatch as any).slug)}` });
    }

    // 정확 일치 없을 때만 검색 실행
    const trimmedQuery = query.trim();

    // Trigram 토크나이저: 3 codepoint 미만은 FTS5 MATCH에서 매치 불가 → LIKE fallback.
    // String.length 는 UTF-16 code unit 기준이라 비-BMP 문자(이모지 등)에서 codepoint 수와
    // 어긋난다. trigram 은 codepoint 단위로 토크나이즈하므로 [...]로 codepoint 수를 센다.
    const queryCodepointLength = [...trimmedQuery].length;
    if (queryCodepointLength < 3) {
        const visibility = isAdmin ? '' : ' AND deleted_at IS NULL AND is_private = 0';
        // LIKE 메타문자(%, _, \)를 escape 해 사용자가 입력한 문자열 그대로만 매치한다.
        const likeEscaped = trimmedQuery.replace(/[\\%_]/g, '\\$&');
        const likePattern = `%${likeEscaped}%`;

        const totalRow = await db
            .prepare(`SELECT COUNT(*) as total FROM pages WHERE (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')${visibility}`)
            .bind(likePattern, likePattern)
            .first<{ total: number }>();
        const total = totalRow?.total ?? 0;
        const { page, offset } = clampPage(total);

        // 제목 LIKE 매치를 본문 매치보다 우선해 정렬한다.
        // 스니펫을 직접 만들기 위해 content도 함께 가져온다(<3글자 fallback이라 호출 빈도가 낮다).
        const sql = `
            SELECT slug, title, content, deleted_at
            FROM pages
            WHERE (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')${visibility}
            ORDER BY (CASE WHEN title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END), updated_at DESC
            LIMIT ? OFFSET ?
        `;
        const results = await db.prepare(sql).bind(likePattern, likePattern, likePattern, PAGE_SIZE, offset).all<{ slug: string; title: string; content: string; deleted_at: number | null }>();

        const safeResults = results.results.map((r) => ({
            slug: r.slug,
            title: r.title,
            deleted_at: r.deleted_at,
            isDeleted: !!r.deleted_at,
            snippet: buildLikeSnippet(r.title, r.content, trimmedQuery),
        }));

        if (shouldTrack) trackSearch(c, trimmedQuery, total, Date.now() - searchStartTime);
        return c.json({ results: safeResults, total, page, pageSize: PAGE_SIZE });
    }

    // FTS5 Trigram 검색 (3글자 이상)
    // 보안을 위해 <mark> 대신 임시 문자열을 사용하고 나중에 치환
    try {
        const visibility = isAdmin ? '' : ' AND p.deleted_at IS NULL AND p.is_private = 0';

        // Trigram 토크나이저에서는 따옴표로 감싸면 정확한 substring 매칭
        const safeMatchQuery = '"' + trimmedQuery.replace(/"/g, '""') + '"';

        const totalRow = await db
            .prepare(
                `SELECT COUNT(*) as total
                 FROM pages_fts
                 JOIN pages p ON pages_fts.rowid = p.id
                 WHERE pages_fts MATCH ?${visibility}`
            )
            .bind(safeMatchQuery)
            .first<{ total: number }>();
        const total = totalRow?.total ?? 0;
        const { page, offset } = clampPage(total);

        // 제목 LIKE 매치를 FTS rank보다 우선해 정렬한다.
        // (FTS5 trigram도 부분 일치를 잡지만 제목 일치를 항상 상단에 노출하기 위함)
        const titleLikePattern = `%${trimmedQuery}%`;
        const sql = `
           SELECT p.slug, p.title, p.deleted_at,
                  snippet(pages_fts, 1, '__MARK_START__', '__MARK_END__', '...', 40) as snippet
           FROM pages_fts
           JOIN pages p ON pages_fts.rowid = p.id
           WHERE pages_fts MATCH ?${visibility}
           ORDER BY (CASE WHEN p.title LIKE ? THEN 0 ELSE 1 END), rank
           LIMIT ? OFFSET ?
        `;

        const results = await db
            .prepare(sql)
            .bind(safeMatchQuery, titleLikePattern, PAGE_SIZE, offset)
            .all();

        // XSS 방지를 위해 스니펫의 HTML 특수문자를 이스케이프 처리한 뒤 임시 문자열을 <mark> 태그로 치환
        const safeResults = results.results.map((r: any) => {
            let finalR = { ...r, isDeleted: !!r.deleted_at };
            if (typeof r.snippet === 'string') {
                let safeSnippet = r.snippet
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&#039;');

                safeSnippet = safeSnippet
                    .replace(/__MARK_START__/g, '<mark>')
                    .replace(/__MARK_END__/g, '</mark>');

                return { ...finalR, snippet: safeSnippet };
            }
            return finalR;
        });

        if (shouldTrack) trackSearch(c, trimmedQuery, total, Date.now() - searchStartTime);
        return c.json({ results: safeResults, total, page, pageSize: PAGE_SIZE });
    } catch (ftsError) {
        // FTS5 쿼리 실패 시 LIKE fallback
        console.error('FTS5 search failed, falling back to LIKE:', ftsError);
        const visibility = isAdmin ? '' : ' AND deleted_at IS NULL AND is_private = 0';
        // LIKE 메타문자(%, _, \)를 escape 해 사용자가 입력한 문자열 그대로만 매치한다.
        const likeEscaped = trimmedQuery.replace(/[\\%_]/g, '\\$&');
        const likePattern = `%${likeEscaped}%`;

        const totalRow = await db
            .prepare(`SELECT COUNT(*) as total FROM pages WHERE (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')${visibility}`)
            .bind(likePattern, likePattern)
            .first<{ total: number }>();
        const total = totalRow?.total ?? 0;
        const { page, offset } = clampPage(total);

        // 제목 LIKE 매치를 본문 매치보다 우선해 정렬한다.
        const fallbackSql = `
            SELECT slug, title, content, deleted_at
            FROM pages
            WHERE (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')${visibility}
            ORDER BY (CASE WHEN title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END), updated_at DESC
            LIMIT ? OFFSET ?
        `;
        const fallbackResults = await db.prepare(fallbackSql).bind(likePattern, likePattern, likePattern, PAGE_SIZE, offset).all<{ slug: string; title: string; content: string; deleted_at: number | null }>();

        const safeResults = fallbackResults.results.map((r) => ({
            slug: r.slug,
            title: r.title,
            deleted_at: r.deleted_at,
            isDeleted: !!r.deleted_at,
            snippet: buildLikeSnippet(r.title, r.content, trimmedQuery),
        }));

        if (shouldTrack) trackSearch(c, trimmedQuery, total, Date.now() - searchStartTime);
        return c.json({ results: safeResults, total, page, pageSize: PAGE_SIZE });
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
    const trimmed = query.trim();
    const likePattern = `%${trimmed}%`;
    const startPattern = `${trimmed}%`;

    // 1. 카테고리 검색
    const catSql = `
        SELECT DISTINCT category FROM page_categories
        WHERE category LIKE ?
        ORDER BY CASE WHEN category LIKE ? THEN 0 ELSE 1 END, length(category)
        LIMIT 7
    `;
    const catResults = await db.prepare(catSql).bind(likePattern, startPattern).all();

    // 2. 문서 검색
    let pageSql = `
        SELECT title, slug FROM pages
        WHERE title LIKE ?
    `;
    if (!isAdmin) {
        pageSql += ' AND deleted_at IS NULL AND is_private = 0';
    }
    pageSql += ' ORDER BY CASE WHEN title LIKE ? THEN 0 ELSE 1 END, length(title) LIMIT 7';

    const pageResults = await db.prepare(pageSql).bind(likePattern, startPattern).all();

    const suggestions: { title: string, slug: string }[] = [];
    const seenSlugs = new Set<string>();

    // 카테고리 결과를 먼저 추가 (형식: 카테고리:제목)
    for (const r of catResults.results) {
        const catName = r.category as string;
        const slug = `카테고리:${catName}`;
        if (!seenSlugs.has(slug)) {
            suggestions.push({ title: slug, slug: slug });
            seenSlugs.add(slug);
        }
    }

    // 문서 결과를 추가 (중복 방지)
    for (const r of pageResults.results) {
        if (!seenSlugs.has(r.slug as string)) {
            suggestions.push({ title: r.title as string, slug: r.slug as string });
            seenSlugs.add(r.slug as string);
        }
    }

    // 최종 결과 7개로 제한
    const finalSuggestions = suggestions.slice(0, 7);

    return c.json({
        suggestions: finalSuggestions,
    });
});

export default search;
