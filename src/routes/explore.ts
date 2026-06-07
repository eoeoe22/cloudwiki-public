import { Hono } from 'hono';
import type { Env } from '../types';

const exploreRoutes = new Hono<Env>();

// 탐색 포털 집계 쿼리. 전체 공개 페이지이므로 모든 쿼리는 비공개/삭제 문서를 제외한다
// (is_private = 0 AND deleted_at IS NULL). 가상/미디어 네임스페이스(이미지:/map:/카테고리:)도 제외한다.

// 통계: 문서/유저/편집/미디어 수 + 최근 30일 활성 편집자. 스칼라 서브쿼리 1행.
// 편집 수/활성 편집자는 공개·미삭제 페이지의 리비전만 집계(공개 포털 통계라 비공개/삭제
// 문서 활동을 노출하지 않도록 page_count 와 동일 범위로 맞춘다).
const STATS_SQL = `
  SELECT
    (SELECT COUNT(*) FROM pages
       WHERE deleted_at IS NULL AND is_private = 0 AND redirect_to IS NULL
         AND slug NOT LIKE '이미지:%' AND slug NOT LIKE 'map:%' AND slug NOT LIKE '카테고리:%') AS page_count,
    (SELECT COUNT(*) FROM users WHERE role != 'deleted') AS user_count,
    (SELECT COUNT(*) FROM revisions r JOIN pages p ON p.id = r.page_id
       WHERE r.deleted_at IS NULL AND p.deleted_at IS NULL AND p.is_private = 0) AS revision_count,
    (SELECT COUNT(*) FROM media) AS media_count,
    (SELECT COUNT(DISTINCT r.author_id) FROM revisions r JOIN pages p ON p.id = r.page_id
       WHERE r.deleted_at IS NULL AND p.deleted_at IS NULL AND p.is_private = 0
         AND r.created_at >= unixepoch() - 2592000) AS active_editors_30d
`;

// 고아 문서: 다른 문서(page wikilink)에서 참조되지 않는 공개 문서. idx_page_links_target 활용.
// inbound 링크는 공개·미삭제 소스에서 온 것만 유효로 친다(비공개/삭제 소스에서 온 링크는
// 포털 이용자에게 보이지 않으므로 고아 판정에 포함하지 않는다). 자기 자신을 가리키는
// 자기 링크(sp.id = p.id)는 "다른 문서에서의 링크" 가 아니므로 inbound 로 치지 않는다.
const ORPHANS_SQL = `
  SELECT p.slug, p.title, p.updated_at
  FROM pages p
  WHERE p.deleted_at IS NULL AND p.is_private = 0 AND p.redirect_to IS NULL
    AND p.slug NOT LIKE '이미지:%' AND p.slug NOT LIKE 'map:%' AND p.slug NOT LIKE '카테고리:%'
    AND NOT EXISTS (
      SELECT 1 FROM page_links pl
      JOIN pages sp ON sp.id = pl.source_page_id
      WHERE pl.target_slug = p.slug AND pl.source_type = 'page' AND pl.blog = 0
        AND pl.link_type = 'wikilink'
        AND sp.is_private = 0 AND sp.deleted_at IS NULL
        AND sp.id != p.id
    )
  ORDER BY p.updated_at DESC
  LIMIT 20
`;

// 작성 요청(빨간 링크): 문서 본문 wikilink 가 가리키지만 실제로는 없는 슬러그. 참조 수 desc.
// 소스 페이지를 조인해 공개·미삭제 문서에서 나온 링크만 집계한다(공개 캐시되므로 비공개/삭제
// 문서에서만 링크된 슬러그가 외부에 노출되지 않도록).
const WANTED_SQL = `
  SELECT pl.target_slug AS slug, COUNT(*) AS ref_count
  FROM page_links pl
  JOIN pages sp ON sp.id = pl.source_page_id
  WHERE pl.source_type = 'page' AND pl.blog = 0 AND pl.link_type = 'wikilink'
    AND sp.is_private = 0 AND sp.deleted_at IS NULL
    AND pl.target_slug NOT LIKE '이미지:%' AND pl.target_slug NOT LIKE 'map:%' AND pl.target_slug NOT LIKE '카테고리:%'
    AND NOT EXISTS (
      SELECT 1 FROM pages p WHERE p.slug = pl.target_slug AND p.deleted_at IS NULL
    )
  GROUP BY pl.target_slug
  ORDER BY ref_count DESC, pl.target_slug ASC
  LIMIT 20
`;

// 최근 토론 활동: 공개·미삭제 문서에 달린 최신 토론 댓글.
const RECENT_DISCUSSIONS_SQL = `
  SELECT dc.id, dc.created_at, dc.author_id, u.name AS author_name,
         d.id AS discussion_id, d.title AS discussion_title, p.slug AS page_slug
  FROM discussion_comments dc
  JOIN discussions d ON d.id = dc.discussion_id
  JOIN pages p ON p.id = d.page_id
  LEFT JOIN users u ON u.id = dc.author_id
  WHERE dc.deleted_at IS NULL AND d.deleted_at IS NULL
    AND p.deleted_at IS NULL AND p.is_private = 0
  ORDER BY dc.created_at DESC
  LIMIT 10
`;

/**
 * GET /api/explore/summary
 * 탐색 포털용 집계: 통계 / 고아 문서 / 작성 요청(빨간 링크) / 최근 토론 활동.
 * 트렌딩·최근 변경·무작위 문서·편집 요청 카운트는 기존 공개 엔드포인트를 클라이언트가 직접 호출한다.
 * 비공개/삭제 문서는 절대 노출하지 않으므로 뷰어 권한과 무관하게 공개 캐시(60초)한다.
 */
exploreRoutes.get('/explore/summary', async (c) => {
    // 비공개 위키(WIKI_VISIBILITY=closed)에서는 비로그인 요청이 캐시를 읽기 전에 차단해
    // 문서 slug/title·토론·통계가 외부로 새지 않도록 한다(/explore 페이지 가드와 동일 정책).
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }

    // 비공개 위키 응답은 세션 쿠키에 따라 달라지므로 공개 캐시 금지(로그아웃 후 브라우저/중간
    // 캐시가 인증 가드를 우회해 재사용하는 것을 막는다). 공개 위키 응답만 공개·엣지 캐시한다.
    const isClosed = c.env.WIKI_VISIBILITY === 'closed';
    const cache = caches.default;
    // 쿼리 파라미터를 쓰지 않으므로 고정 canonical 키를 사용한다. c.req.url 전체를 키로 쓰면
    // ?x=1 같은 변형마다 별도 캐시가 생겨, refreshRecentChangesCache 의 무효화(쿼리 없는 키
    // 삭제)가 변형 캐시를 비우지 못해 stale 노출이 남는다(무효화 키와 동일하게 맞춘다).
    const cacheKey = `${new URL(c.req.url).origin}/api/explore/summary`;

    if (!isClosed) {
        const cached = await cache.match(cacheKey);
        if (cached) return new Response(cached.body, cached);
    }

    try {
        const [statsRes, orphansRes, wantedRes, discRes] = await c.env.DB.batch([
            c.env.DB.prepare(STATS_SQL),
            c.env.DB.prepare(ORPHANS_SQL),
            c.env.DB.prepare(WANTED_SQL),
            c.env.DB.prepare(RECENT_DISCUSSIONS_SQL),
        ]);

        const stats = (statsRes.results?.[0] as Record<string, number>) || {
            page_count: 0, user_count: 0, revision_count: 0, media_count: 0, active_editors_30d: 0,
        };

        const response = c.json({
            stats,
            orphans: orphansRes.results || [],
            wanted: wantedRes.results || [],
            recent_discussions: discRes.results || [],
        }, 200, { 'Cache-Control': isClosed ? 'private, no-store' : 'public, max-age=60' });

        if (!isClosed) c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
    } catch (e) {
        // 마이그레이션 미적용 등 예외 시 빈 페이로드로 폴백(포털이 깨지지 않도록).
        return c.json({
            stats: { page_count: 0, user_count: 0, revision_count: 0, media_count: 0, active_editors_30d: 0 },
            orphans: [], wanted: [], recent_discussions: [],
        });
    }
});

export default exploreRoutes;
