import { safeJSON } from './json';

/**
 * 엣지 캐시(Cache API / `caches.default`) 무효화 헬퍼 단일 소스.
 *
 * 위키 페이지·이미지 문서·역링크·팔레트·최근 변경·리비전 본문 등 모든 엣지 캐시
 * 무효화 로직을 이 모듈에 모은다. (KV 세션 무효화는 범위 밖 — middleware/auth 가 직접 처리.)
 *
 * 모든 함수는 런타임 `caches.default` 와 요청 origin 에 의존하므로 Hono Context(`c`)를
 * `any` 로 받는다(라우트 간 순환 import 회피 + 기존 시그니처 보존).
 */

/**
 * 슬러그에 대응하는 캐시 경로 변형 목록.
 *
 * `encodeURIComponent` 는 ':' 를 %3A 로 인코딩하지만 브라우저는 URL 경로의 ':' 를
 * 인코딩하지 않는 경우도 있다. 두 변형(%3A 인코딩 / ':' 그대로)을 모두 반환해
 * 어느 쪽으로 캐시됐더라도 확실히 무효화할 수 있게 한다.
 */
export function pageCachePaths(slug: string): string[] {
    const encodedPath = encodeURIComponent(slug);
    return slug.includes(':')
        ? [encodedPath, encodedPath.replace(/%3A/g, ':')]
        : [encodedPath];
}

/**
 * 문서의 캐시를 무효화하는 유틸리티 함수.
 * SSR(`/w/:slug`) 및 API(`/api/w/:slug`, `?redirect=no` 포함) 키를 모두 삭제한다.
 */
export function invalidatePageCache(c: any, slug: string) {
    const origin = new URL(c.req.url).origin;
    const cache = caches.default;
    return Promise.allSettled(
        pageCachePaths(slug).flatMap(path => [
            cache.delete(`${origin}/api/w/${path}`),
            cache.delete(`${origin}/api/w/${path}?redirect=no`),
            cache.delete(`${origin}/w/${path}`)
        ])
    );
}

/**
 * 콜론이 포함된 문서(틀, 익스텐션 등)가 변경될 때
 * 해당 문서를 참조하는 모든 문서의 캐시를 무효화
 */
export async function invalidateBacklinkCaches(c: any, slug: string, db: D1Database): Promise<void> {
    if (!slug.includes(':')) return;

    const targetSlugs: string[] = [slug];
    const templatePrefixes = ['틀:', 'template:', '템플릿:'];
    const matchedPrefix = templatePrefixes.find(p => slug.startsWith(p));
    if (matchedPrefix) {
        // extractPageLinks()는 {{Foo}}를 항상 '틀:Foo'로 저장하므로,
        // template:Foo / 템플릿:Foo 문서 편집 시에도 '틀:Foo' 변형을 포함해야 함 (반대도 동일)
        const baseName = slug.substring(matchedPrefix.length);
        for (const prefix of templatePrefixes) {
            const variant = prefix + baseName;
            if (!targetSlugs.includes(variant)) targetSlugs.push(variant);
        }
        // 접두사 없는 이름({{Foo}} 방식으로 저장된 경우)도 포함
        if (!targetSlugs.includes(baseName)) targetSlugs.push(baseName);
    }

    const placeholders = targetSlugs.map(() => '?').join(', ');
    const { results } = await db
        .prepare(`
            SELECT DISTINCT p.slug
            FROM page_links pl
            JOIN pages p ON pl.source_page_id = p.id
            WHERE p.deleted_at IS NULL
              AND pl.blog = 0
              AND pl.source_type = 'page'
              AND pl.link_type IN ('wikilink', 'template', 'extension')
              AND pl.target_slug IN (${placeholders})
        `)
        .bind(...targetSlugs)
        .all<{ slug: string }>();

    if (results.length === 0) return;
    await Promise.allSettled(results.map((row: { slug: string }) => invalidatePageCache(c, row.slug)));
}

/**
 * 최근 변경 캐시를 즉시 새 데이터로 갱신
 * (delete 후 재요청 대기 대신, 직접 put하여 즉시 반영)
 */
export async function refreshRecentChangesCache(c: any) {
    const db = c.env.DB;
    const origin = new URL(c.req.url).origin;
    const cacheUrl = `${origin}/api/w/recent-changes`;
    const cache = caches.default;

    // 캐시는 비공개 페이지 열람 권한이 없는 익명/일반 응답에만 저장된다.
    // author_name 도출은 GET /api/w/recent-changes(src/routes/wiki.ts) 와 동일하게
    // '가장 최근 리비전(가상 포함, created_at 기준)'의 작성자를 사용한다 — last_revision_id 는
    // 가상 리비전(ACL 변경·이동 등)에서 갱신되지 않아 오귀속이 생기기 때문.
    const { results } = await db.prepare(`
        SELECT p.slug, p.updated_at, u.name as author_name
        FROM pages p
        LEFT JOIN revisions r ON r.id = (
            SELECT id FROM revisions
            WHERE page_id = p.id AND deleted_at IS NULL AND purged_at IS NULL
            ORDER BY created_at DESC, id DESC LIMIT 1
        )
        LEFT JOIN users u ON r.author_id = u.id
        WHERE p.deleted_at IS NULL AND p.is_private = 0
        ORDER BY p.updated_at DESC LIMIT 10
    `).all();

    const body = JSON.stringify(safeJSON({ changes: results }));
    const response = new Response(body, {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Cache-Control': 'public, max-age=60',
        },
    });
    await cache.put(cacheUrl, response);

    // 탐색 포털 집계(/api/explore/summary)도 같은 변경 시점에 무효화한다.
    // 공개 위키에서 엣지 캐시된 summary 에 비공개 전환·삭제된 문서의 slug/title·토론
    // 제목이 stale 로 남아 노출되지 않도록, recent-changes 와 동일한 무효화 지점에 묶는다.
    await cache.delete(`${origin}/api/explore/summary`);
}

/**
 * 팔레트 변경/삭제 후, 해당 팔레트를 참조하는 페이지/블로그의 캐시를 무효화.
 *   1) 본문에서 직접 {palette:NAME} 참조 (page_links link_type='palette')
 *   2) 그런 팔레트를 사용하는 틀을 트랜스클루전한 페이지 (link_type='template' → 1단계)
 * /api/w/:slug 응답이 used_palettes 를 본문에 포함해 max-age 86400 캐시되므로,
 * 색상 변경 후 사용자가 다시 열어도 stale 색상이 보일 수 있어 능동적으로 비운다.
 * 깊은 트랜스클루전 체인은 잡지 않는다 — 일반 위키 사용에서 1단계 폴백으로 충분.
 */
export async function invalidatePaletteUsers(c: any, name: string): Promise<void> {
    const db = c.env.DB as D1Database;
    try {
        // template_users CTE: 팔레트를 본문에서 직접 참조하는 틀(t1) 의 slug,
        //   그리고 t1 로 redirect 되는 다른 틀(tr) 의 slug 까지 포함. loadPalettesForPage 가
        //   redirect_to 1단계를 따라 팔레트를 수집하므로, 색상 변경 시 redirect 시작
        //   슬러그를 트랜스클루전한 페이지의 캐시도 함께 비워야 stale 색상이 남지 않는다.
        const { results } = await db
            .prepare(`
                WITH template_users AS (
                    SELECT pt.slug AS slug
                    FROM page_links plp
                    JOIN pages pt ON pt.id = plp.source_page_id
                    WHERE plp.source_type = 'page'
                      AND plp.link_type = 'palette'
                      AND plp.target_slug = ?1
                    UNION
                    SELECT tr.slug AS slug
                    FROM pages tr
                    JOIN pages t1 ON t1.slug = tr.redirect_to
                    JOIN page_links plp ON plp.source_page_id = t1.id
                    WHERE plp.source_type = 'page'
                      AND plp.link_type = 'palette'
                      AND plp.target_slug = ?1
                )
                SELECT DISTINCT p.slug FROM pages p
                JOIN page_links pl ON pl.source_page_id = p.id
                WHERE pl.source_type = 'page'
                  AND (
                    (pl.link_type = 'palette' AND pl.target_slug = ?1)
                    OR (pl.link_type = 'template' AND pl.target_slug IN (SELECT slug FROM template_users))
                  )
            `)
            .bind(name)
            .all();

        const slugs = ((results ?? []) as Array<{ slug: string }>).map(r => r.slug);
        if (slugs.length > 0) {
            c.executionCtx.waitUntil(
                Promise.allSettled(slugs.map((s: string) => invalidatePageCache(c, s)))
            );
        }
    } catch (e) {
        console.error('invalidatePaletteUsers failed:', e);
    }
}

/**
 * 리비전 본문(R2) 엣지 캐시 키를 무효화한다.
 * 리비전 본문은 `max-age=31536000, immutable` 로 캐시되므로 영구 삭제(하드 삭제) 시에만 비운다.
 */
export function invalidateRevisionContentCache(c: any, r2Key: string) {
    const origin = new URL(c.req.url).origin;
    return caches.default.delete(`${origin}/__r2_revision__/${r2Key}`);
}
