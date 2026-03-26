import { Hono } from 'hono';
import type { Env } from '../types';

const search = new Hono<Env>();

/**
 * GET /search?q=키워드&mode=content|category
 * mode=content (기본값): FTS5 기반 전문 검색, 정확한 제목 일치 시 redirect 반환
 * mode=category: 카테고리 이름으로 문서 목록 반환
 */
search.get('/search', async (c) => {
    const query = c.req.query('q');
    const mode = c.req.query('mode') || 'content';
    const user = c.get('user');

    if (!query || query.trim().length === 0) {
        return c.json({ results: [] });
    }

    const db = c.env.DB;
    const isAdmin = user && (user.role === 'admin' || user.role === 'super_admin');

    // 카테고리 검색 모드
    if (mode === 'category') {
        let sql = `
            SELECT slug, title, category, deleted_at
            FROM pages
            WHERE category = ?
        `;
        if (!isAdmin) {
            sql += ' AND deleted_at IS NULL AND is_private = 0';
        }
        sql += ' ORDER BY title LIMIT 50';

        const results = await db.prepare(sql).bind(query.trim()).all();
        return c.json({ results: results.results, mode: 'category' });
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
        return c.json({ redirect: `/wiki/${encodeURIComponent((exactMatch as any).slug)}` });
    }

    // 정확 일치 없을 때만 검색 실행
    const trimmedQuery = query.trim();

    // Trigram 토크나이저: 3글자 미만은 FTS5 MATCH에서 매치 불가 → LIKE fallback
    if (trimmedQuery.length < 3) {
        let sql = `
            SELECT slug, title, deleted_at
            FROM pages
            WHERE (title LIKE ? OR content LIKE ?)
        `;
        if (!isAdmin) {
            sql += ' AND deleted_at IS NULL AND is_private = 0';
        }
        sql += ' ORDER BY updated_at DESC LIMIT 30';

        const likePattern = `%${trimmedQuery}%`;
        const results = await db.prepare(sql).bind(likePattern, likePattern).all();

        const safeResults = results.results.map((r: any) => ({
            ...r,
            isDeleted: !!r.deleted_at,
            snippet: '',
        }));

        return c.json({ results: safeResults });
    }

    // FTS5 Trigram 검색 (3글자 이상)
    // 보안을 위해 <mark> 대신 임시 문자열을 사용하고 나중에 치환
    try {
        let sql = `
           SELECT p.slug, p.title, p.deleted_at,
                  snippet(pages_fts, 1, '__MARK_START__', '__MARK_END__', '...', 40) as snippet
           FROM pages_fts
           JOIN pages p ON pages_fts.rowid = p.id
           WHERE pages_fts MATCH ?
        `;

        if (!isAdmin) {
            sql += ' AND p.deleted_at IS NULL AND p.is_private = 0';
        }

        sql += ' ORDER BY rank LIMIT 30';

        // Trigram 토크나이저에서는 따옴표로 감싸면 정확한 substring 매칭
        const safeMatchQuery = '"' + trimmedQuery.replace(/"/g, '""') + '"';

        const results = await db
            .prepare(sql)
            .bind(safeMatchQuery)
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

        return c.json({ results: safeResults });
    } catch (ftsError) {
        // FTS5 쿼리 실패 시 LIKE fallback
        console.error('FTS5 search failed, falling back to LIKE:', ftsError);
        let fallbackSql = `
            SELECT slug, title, deleted_at
            FROM pages
            WHERE (title LIKE ? OR content LIKE ?)
        `;
        if (!isAdmin) {
            fallbackSql += ' AND deleted_at IS NULL AND is_private = 0';
        }
        fallbackSql += ' ORDER BY updated_at DESC LIMIT 30';

        const likePattern = `%${trimmedQuery}%`;
        const fallbackResults = await db.prepare(fallbackSql).bind(likePattern, likePattern).all();

        const safeResults = fallbackResults.results.map((r: any) => ({
            ...r,
            isDeleted: !!r.deleted_at,
            snippet: '',
        }));

        return c.json({ results: safeResults });
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
    const isAdmin = user && (user.role === 'admin' || user.role === 'super_admin');
    const trimmed = query.trim();
    const likePattern = `%${trimmed}%`;

    let sql = `
        SELECT title, slug FROM pages
        WHERE title LIKE ?
    `;
    if (!isAdmin) {
        sql += ' AND deleted_at IS NULL AND is_private = 0';
    }
    sql += ' ORDER BY CASE WHEN title LIKE ? THEN 0 ELSE 1 END, length(title) LIMIT 7';

    const startPattern = `${trimmed}%`;
    const results = await db.prepare(sql).bind(likePattern, startPattern).all();

    return c.json({
        suggestions: results.results.map((r: any) => ({ title: r.title, slug: r.slug })),
    });
});

export default search;
