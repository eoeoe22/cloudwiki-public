import { Hono, Context } from 'hono';
import robotsTxtBase from './robots-txt';
import { csrf } from 'hono/csrf';
import { secureHeaders } from 'hono/secure-headers';
import type { Env, Page } from './types';
import { sessionMiddleware, rbacMiddleware, requireAdmin } from './middleware/session';
import { RBAC } from './utils/role';
import { applyPageSSR, extractMetaDescription } from './middleware/ssr';
import { PAGE_BUNDLES, BundleName } from './shared/cdn';
import { safeJSON } from './utils/json';
import { escapeHtml } from './utils/html';
import { fetchMediaTags } from './utils/mediaTags';
import { loadPalettesForPage, loadPalettesForBlogPost } from './utils/palettes';
import authRoutes from './routes/auth/index';
import wikiRoutes from './routes/wiki';
import searchRoutes from './routes/search';
import mediaRoutes from './routes/media';
import adminRoutes from './routes/admin';
import discussionRoutes from './routes/discussion';
import notificationRoutes from './routes/notification';
import pushRoutes from './routes/push';
import ticketRoutes from './routes/ticket';
import mcpRoutes from './routes/mcp';
import mcpSubmissionsRoutes from './routes/mcp-submissions';
import pendingEditsRoutes from './routes/pending-edits';
import oauthRoutes from './routes/oauth';
import analyticsRoutes from './routes/analytics';
import blogRoutes from './routes/blog';
import exploreRoutes from './routes/explore';
import { trackPageView, trackError, queryAnalytics } from './utils/analytics';
import { isR2OnlyNamespace, isMapNamespace, normalizeSlug } from './utils/slug';
import { getEnabledExtensions } from './utils/extensions';
import { getRevisionContent } from './utils/r2';
import { renderForAI } from './utils/aiParser';
import { buildMapDocument, MAP_CACHE_MAX_AGE_SECONDS } from './utils/mapDocument';
import { ensureMcpDraftsMigration } from './utils/mcpDraftsMigration';
import { ensureNotificationsMigration } from './utils/notificationsMigration';

const app = new Hono<Env>();

//
// ── 미들웨어 ──
// Secure Headers
app.use('*', secureHeaders());

// CSRF 보호 (GET/HEAD/OPTIONS 제외)
// MCP / OAuth 토큰 엔드포인트는 외부 서비스(Claude 등)에서 호출하므로 CSRF 제외.
// /oauth/authorize 는 위키 도메인의 동의 폼에서 POST 되므로 CSRF 적용 (Origin 자동 검증).
app.use('*', (c, next) => {
    const path = c.req.path;
    if (path === '/api/mcp' || path.startsWith('/api/mcp/')) return next();
    if (path === '/oauth/token' || path === '/oauth/register' || path === '/oauth/revoke') return next();
    return csrf()(c, next);
});

// RBAC 초기화 및 세션 미들웨어 (모든 요청에서 유저 정보를 주입)
app.use('*', rbacMiddleware);
app.use('*', sessionMiddleware);

// ── closed 위키에서 banned 유저의 접근 제한 ──
// WIKI_VISIBILITY=closed 인 환경의 banned 사용자는 다음 세 슬러그(=wrangler.toml 환경변수)
// 와 인증·정적 자산 경로만 허용한다 — 차단된 사용자가 위키 본 콘텐츠를 우회 열람하지 못하도록.
//   - WIKI_HOME_PAGE (프론트페이지), TERMS_OF_SERVICE, PRIVACY_POLICY
// 그 외 SSR 페이지는 '/' 로 리다이렉트, API 는 403 으로 차단한다.
function bannedAllowedSlugSet(env: Env['Bindings']): Set<string> {
    const slugs: string[] = [];
    if (env.WIKI_HOME_PAGE) slugs.push(env.WIKI_HOME_PAGE);
    if (env.TERMS_OF_SERVICE) slugs.push(env.TERMS_OF_SERVICE);
    if (env.PRIVACY_POLICY) slugs.push(env.PRIVACY_POLICY);
    return new Set(slugs.map(s => normalizeSlug(s)).filter(s => s.length > 0));
}

function decodeSlugFromPath(path: string, prefixLen: number): string {
    const raw = path.substring(prefixLen);
    try { return normalizeSlug(decodeURIComponent(raw)); }
    catch { return normalizeSlug(raw); }
}

function isBannedAllowedRequest(c: Context<Env>): boolean {
    const path = c.req.path;
    const method = c.req.method;
    // 1) 정적 자산 / 서비스워커 / robots / sitemap / favicon / 로고 / 컴포넌트 / 아이콘
    if (
        path.startsWith('/dist/') || path.startsWith('/css/') || path.startsWith('/components/') ||
        path === '/sw.js' || path === '/robots.txt' || path === '/sitemap.xml' ||
        path === '/icons.json' || path === '/favicon.ico' || path === '/favicon.jpg' ||
        path === '/favicon.png' || path === '/favicon.svg' || path === '/logo.svg'
    ) return true;
    // 2) OAuth / discovery — banned 유저가 굳이 호출할 필요는 없지만 차단할 이유도 없다.
    if (path.startsWith('/.well-known/') || path.startsWith('/oauth/')) return true;
    // 2-1) 미디어 객체(R2) GET — 허용 페이지에 삽입된 이미지가 깨지지 않도록.
    if (path.startsWith('/media/') && method === 'GET') return true;
    // 3) 인증 chrome 에 필요한 엔드포인트 — 헤더의 사용자 식별 + 로그아웃 + 사이트 설정.
    //    /api/me 는 routes/auth/index.ts, /auth/logout 도 같은 라우터 (/api 아님), /api/config 는
    //    routes/wiki.ts (/api 마운트), /api/auth/providers 는 routes/auth/index.ts.
    if (
        path === '/api/me' || path === '/auth/logout' ||
        path === '/api/auth/providers' || path === '/api/config'
    ) return true;
    // 4) 루트 / 로그인 페이지 / 에러 페이지
    if (path === '/' || path === '/login' || path === '/error') return true;

    // 5) 허용 슬러그의 SSR 위키 페이지 (/w/{slug})
    //    revisions / discussions 서브 라우트는 본문 외 메타 정보를 노출하므로 제외.
    const allowed = bannedAllowedSlugSet(c.env);
    if (allowed.size === 0) return false;
    if (path.startsWith('/w/')) {
        if (path.includes('/revisions') || path.includes('/discussions')) return false;
        const slug = decodeSlugFromPath(path, 3);
        return allowed.has(slug);
    }
    // 6) 허용 슬러그의 wiki API GET 만 허용 (편집 차단)
    //    wiki 라우트는 /w/:slug 로 선언되어 /api 에 마운트되므로 실제 경로는 /api/w/{slug}.
    if (path.startsWith('/api/w/') && method === 'GET') {
        const slug = decodeSlugFromPath(path, '/api/w/'.length);
        return allowed.has(slug);
    }
    return false;
}

app.use('*', async (c, next) => {
    const user = c.get('user');
    // 본 가드는 banned 역할 자체를 식별해야 하므로 user.role 문자열 비교가 불가피하다 (banned
    // 권한은 빈 배열이라 RBAC.can() 으로 표현할 수 없다). sessionMiddleware 가 이미
    // banned_until 만료 시 'user' 로 보정한 뒤이다.
    if (!user || user.role !== 'banned') return next();
    if (c.env.WIKI_VISIBILITY !== 'closed') return next();
    if (isBannedAllowedRequest(c)) return next();

    if (c.req.path.startsWith('/api/')) {
        return c.json({ error: '차단된 계정은 이 리소스에 접근할 수 없습니다.' }, 403);
    }
    return c.redirect('/');
});

// ── 라우트 등록 ──
app.route('/', authRoutes);
app.route('/api', wikiRoutes);
app.route('/api', searchRoutes);
app.route('/', mediaRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api', discussionRoutes);
app.route('/api', notificationRoutes);
app.route('/api', pushRoutes);
app.route('/api', ticketRoutes);
app.route('/api/mcp', mcpRoutes);
app.route('/api', mcpSubmissionsRoutes);
app.route('/api', pendingEditsRoutes);
app.route('/', oauthRoutes); // /.well-known/* + /oauth/*
app.route('/api/admin/analytics', analyticsRoutes);
app.route('/api', blogRoutes);
app.route('/api', exploreRoutes);

// ── Service Worker (/sw.js) ──
// Vite 빌드 산출물을 /dist/sw.js 로 두고, 루트 스코프 부여를 위해 /sw.js 로 위임한다.
// Service-Worker-Allowed: / 헤더와 짧은 캐시를 함께 부여.
app.get('/sw.js', async (c) => {
    const url = new URL(c.req.url);
    url.pathname = '/dist/sw.js';
    const inner = await c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
    if (!inner.ok) return inner;
    const headers = new Headers(inner.headers);
    headers.set('Service-Worker-Allowed', '/');
    headers.set('Content-Type', 'application/javascript; charset=utf-8');
    headers.set('Cache-Control', 'no-cache');
    return new Response(inner.body, { status: inner.status, headers });
});

// ── 공개 Analytics API (인기 문서, 문서별 조회수) ──
app.get('/api/analytics/trending', async (c) => {
    const cache = caches.default;
    const cacheKey = c.req.url;

    // 캐시 확인
    const cached = await cache.match(cacheKey);
    if (cached) {
        return new Response(cached.body, cached);
    }

    const accountId = c.env.CF_ACCOUNT_ID;
    const apiToken = c.env.CF_API_TOKEN;
    if (!accountId || !apiToken) return c.json({ trending: [] });

    const hours = Math.min(72, Math.max(1, Number(c.req.query('hours')) || 24));
    const limit = Math.min(20, Math.max(1, Number(c.req.query('limit')) || 10));

    try {
        const result = await queryAnalytics(accountId, apiToken, `
            SELECT blob2 as slug, sum(_sample_interval) as views
            FROM cloudwiki
            WHERE blob1 = 'pageview' AND blob2 != ''
              AND timestamp >= now() - toIntervalHour(${hours})
            GROUP BY slug ORDER BY views DESC LIMIT ${limit}
            FORMAT JSON
        `);

        const response = c.json({ trending: result?.data || [] }, 200, {
            'Cache-Control': 'public, max-age=60'
        });

        c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
    } catch {
        return c.json({ trending: [] });
    }
});

app.get('/api/analytics/page-views/:slug', requireAdmin, async (c) => {
    const accountId = c.env.CF_ACCOUNT_ID;
    const apiToken = c.env.CF_API_TOKEN;
    if (!accountId || !apiToken) return c.json({ total: 0, recent: 0 });

    const slug = c.req.param('slug');
    const safeSlug = slug.replace(/'/g, "\\'");

    try {
        const [totalResult, recentResult] = await Promise.all([
            queryAnalytics(accountId, apiToken, `
                SELECT sum(_sample_interval) as views
                FROM cloudwiki
                WHERE blob1 = 'pageview' AND blob2 = '${safeSlug}'
                FORMAT JSON
            `),
            queryAnalytics(accountId, apiToken, `
                SELECT sum(_sample_interval) as views
                FROM cloudwiki
                WHERE blob1 = 'pageview' AND blob2 = '${safeSlug}'
                  AND timestamp >= now() - toIntervalDay(7)
                FORMAT JSON
            `),
        ]);
        return c.json({
            total: totalResult?.data?.[0]?.views || 0,
            recent: recentResult?.data?.[0]?.views || 0,
        });
    } catch {
        return c.json({ total: 0, recent: 0 });
    }
});

// ── 크롤러 감지 / 크롤러용 미니멀 HTML 렌더링 ──
// ALLOW_CRAWL=true일 때, 크롤러 User-Agent로 들어온 /w/* 요청은
// JS 실행이 없는 상태에서도 본문이 보이도록 정적 HTML 페이지로 응답한다.
// (일반 사용자 브라우저는 그대로 SPA UI를 받는다)
// WhatsApp 인앱 브라우저 UA에도 "WhatsApp/x.y" 토큰이 포함되므로 일반 사용자가
// 크롤러 페이지를 받지 않도록 의도적으로 제외한다. 동일한 이유로 검사 토큰은
// 실 봇 시그니처가 명확한 것만 유지한다.
const CRAWLER_UA_REGEX = /Claude-User|ClaudeBot|anthropic-ai|GPTBot|OAI-SearchBot|ChatGPT-User|Googlebot|Google-Extended|AdsBot-Google|Mediapartners-Google|bingbot|BingPreview|Applebot|PerplexityBot|YouBot|Amazonbot|facebookexternalhit|Twitterbot|LinkedInBot|Discordbot|TelegramBot|DuckDuckBot|Baiduspider|YandexBot|Slurp|DotBot|MJ12bot|AhrefsBot|SemrushBot|\bbot\b|crawler|spider/i;

function isCrawlerUA(ua: string | null | undefined): boolean {
    if (!ua) return false;
    return CRAWLER_UA_REGEX.test(ua);
}

function shouldServeCrawler(c: Context<Env>): boolean {
    if (c.env?.ALLOW_CRAWL !== 'true') return false;
    return isCrawlerUA(c.req.header('user-agent'));
}

interface CrawlerPageOpts {
    title: string;
    description: string;
    bodyHtml: string;
    canonicalUrl?: string;
    status?: number;
    cacheControl?: string;
}

function buildCrawlerPage(c: Context<Env>, opts: CrawlerPageOpts): Response {
    const wikiName = c.env?.WIKI_NAME || 'CloudWiki';
    const wikiFavicon = c.env?.WIKI_FAVICON_URL || '/favicon.ico';
    const status = opts.status ?? 200;
    // 같은 URL이 UA에 따라 SPA HTML 또는 크롤러 HTML 두 가지로 나뉘므로
    // 공유 캐시(다운스트림 CDN, 브라우저 공유 캐시)가 잘못된 변형을 재사용하지 않도록
    // 크롤러 응답은 기본적으로 private 캐시만 허용하고 Vary: User-Agent를 명시한다.
    const cacheControl = opts.cacheControl ?? 'private, max-age=300';

    const title = opts.title || wikiName;
    const description = opts.description || wikiName;

    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="index, follow">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:site_name" content="${escapeHtml(wikiName)}">
<meta property="og:type" content="article">
${opts.canonicalUrl ? `<link rel="canonical" href="${escapeHtml(opts.canonicalUrl)}">\n` : ''}<link rel="icon" href="${escapeHtml(wikiFavicon)}">
</head>
<body>
<header><a href="/">${escapeHtml(wikiName)}</a></header>
<main>
${opts.bodyHtml}
</main>
</body>
</html>`;

    return new Response(html, {
        status,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': cacheControl,
            'Vary': 'User-Agent',
            'X-Crawler-Render': '1',
        },
    });
}

// ── 헬퍼: ASSETS에서 HTML 가져오기 ──
async function fetchAssetHtml(c: any, htmlPath: string): Promise<Response> {
    const url = new URL(c.req.url);
    url.pathname = htmlPath;

    if (c.env?.ASSETS) {
        const assetResponse = await c.env.ASSETS.fetch(new Request(url));
        if (assetResponse.status === 200) {
            return new Response(assetResponse.body, assetResponse);
        }
    }

    const fallbackResponse = await fetch(new Request(url, c.req.raw));
    return new Response(fallbackResponse.body, fallbackResponse);
}

// Astro 빌드로 셸이 자체 완결된(컴포넌트·브랜딩·CDN 번들이 모두 빌드 타임에 인라인된) 페이지.
// 모든 페이지 셸이 Astro 화되어 런타임 컴포넌트 주입은 더 이상 쓰이지 않는다.
// 대부분의 셸(search·recent-changes·revisions·discussions·tickets·mypage·user-profile·
// setup-profile·admin-media·admin·edit·blog-edit)은 요청별 가변값이 없어 라우트에서
// fetchAssetHtml 로 정적 서빙하며 renderHtml 을 거치지 않는다.
// error/login/index/blog 만 요청별 데이터(_ssrReason·로그인 메시지/약관·문서별 _ssrTitle/og/
// _usedPalettes·CUSTOM_HEADER)를 #ssr-data·메타로 주입해야 하므로 renderHtml→applyPageSSR 을
// 거치되, 컴포넌트와 CDN 번들은 이미 빌드 타임에 베이킹됐으므로 런타임 주입을 건너뛴다(bundles=[]).
// '/' 는 ASSETS 가 index.html 로 서빙하므로 '/index.html' 로 정규화한 뒤 이 집합과 대조한다.
const ASTRO_SHELL_PAGES = new Set(['/error.html', '/login.html', '/index.html', '/blog.html']);

// ── 헬퍼: 요청별 SSR 데이터/브랜딩을 주입하여 HTML 렌더링 ──
// 모든 페이지 셸이 Astro 화되어 header/sidebar/footer 컴포넌트와 CDN 번들은 빌드 타임에
// 인라인(베이킹)된다. 따라서 런타임 컴포넌트 fetch/주입은 더 이상 하지 않으며, renderHtml 을
// 거치는 페이지(error/login/index/blog)는 전부 ASTRO_SHELL_PAGES 라 bundles=[] 로 호출한다.
// applyPageSSR 는 여전히 #ssr-data·문서별 _ssrTitle/og·CUSTOM_HEADER 같은 요청별 값을 주입한다.
async function renderHtml(c: Context<Env>, targetHtmlPath: string, pageData: Record<string, any> = {}): Promise<Response> {
    const htmlResponse = await fetchAssetHtml(c, targetHtmlPath);

    const wikiName = c.env.WIKI_NAME || 'CloudWiki';
    const wikiLogoUrl = c.env.WIKI_LOGO_URL || '';
    const wikiFaviconUrl = c.env.WIKI_FAVICON_URL || '/favicon.ico';

    // '/' 는 ASSETS 가 index.html 로 서빙하므로 셸 판정/번들 조회 키를 '/index.html' 로 정규화.
    const normalizedPath = targetHtmlPath === '/' ? '/index.html' : targetHtmlPath;

    // CUSTOM_HEADER는 /w/* (문서 열람, 리비전, 토론), /blog/* 페이지에 삽입
    const shouldInjectCustomHeader = c.req.path.startsWith('/w/') || c.req.path.startsWith('/blog');

    // Astro 셸은 CDN 번들이 이미 빌드 타임에 인라인됐으므로 런타임 주입을 건너뛴다(이중 로드 방지).
    const bundles: BundleName[] = ASTRO_SHELL_PAGES.has(normalizedPath) ? [] : (PAGE_BUNDLES[normalizedPath] ?? ['base']);

    return applyPageSSR(htmlResponse, pageData, {
        WIKI_NAME: wikiName,
        WIKI_LOGO_URL: wikiLogoUrl,
        WIKI_FAVICON_URL: wikiFaviconUrl,
        CUSTOM_HEADER: shouldInjectCustomHeader ? (c.env.CUSTOM_HEADER || '') : '',
        LAYOUT_MODE: c.env.LAYOUT_MODE,
    }, bundles);
}

// ── 프론트엔드 라우팅 ──

// 레거시 /wiki 하위 경로 영구 리다이렉트 (301)
app.get('/wiki/*', async (c) => {
    const relativePath = c.req.path.substring('/wiki/'.length);
    const searchParams = new URL(c.req.url).search;
    return c.redirect(`/w/${relativePath}${searchParams}`, 301);
});

// /tickets/:id → tickets.html 서빙 (SSR 브랜딩 적용)
app.get('/tickets/:id', async (c) => {
    return fetchAssetHtml(c, '/tickets.html');
});

// /tickets → tickets.html 서빙 (SSR 브랜딩 적용)
app.get('/tickets', async (c) => {
    return fetchAssetHtml(c, '/tickets.html');
});

// 레거시 리다이렉트: /w/:slug/revisions → /w/:slug?mode=revisions (하위 호환)
app.get('/w/:slug/revisions', (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.redirect('/login');
    }
    const slug = c.req.param('slug');
    return c.redirect(`/w/${encodeURIComponent(slug)}?mode=revisions`, 301);
});
app.get('/w/:slug/discussions/:id', (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.redirect('/login');
    }
    const slug = c.req.param('slug');
    const id = c.req.param('id');
    if (!/^[1-9]\d*$/.test(id)) {
        return c.notFound();
    }
    return c.redirect(`/w/${encodeURIComponent(slug)}?mode=discussions&id=${encodeURIComponent(id)}`, 301);
});
app.get('/w/:slug/discussions', (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.redirect('/login');
    }
    const slug = c.req.param('slug');
    return c.redirect(`/w/${encodeURIComponent(slug)}?mode=discussions`, 301);
});

// /recent-changes → /explore 통합. 최근 수정 내역/모든 문서 목록 탭이 explore 로 흡수돼
// 별도 페이지는 제거됐다. 기존 링크/북마크 호환을 위해 영구 리다이렉트한다.
app.get('/recent-changes', (c) => c.redirect('/explore#docActivity', 301));

// /explore → explore.html 서빙 (탐색 포털, 전체 공개)
app.get('/explore', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.redirect('/login');
    }
    return fetchAssetHtml(c, '/explore.html');
});

// /w/* → 와일드카드 라우트: 슬래시 포함 슬러그를 지원하기 위해 경로 전체를 슬러그로 처리
// 하위 페이지(revisions, discussions)는 ?mode= 쿼리 파라미터로 구분
app.get('/w/*', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.redirect('/login');
    }

    const mode = c.req.query('mode');

    // mode=revisions → revisions.html 서빙
    if (mode === 'revisions') {
        return fetchAssetHtml(c, '/revisions.html');
    }

    // mode=discussions → discussions.html 서빙
    if (mode === 'discussions') {
        return fetchAssetHtml(c, '/discussions.html');
    }

    // 슬러그 추출: /w/ 이후 경로 전체를 슬러그로 사용
    const rawPath = c.req.path.substring(3); // "/w/" 이후
    let slug: string;
    try {
        slug = decodeURIComponent(rawPath);
    } catch {
        slug = rawPath;
    }

    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const redirectParam = c.req.query('redirect');
    const isAdmin = user && rbac.can(user.role, 'admin:access');
    const startTime = Date.now();
    const crawlEnabled = c.env.ALLOW_CRAWL === 'true';
    const isCrawler = shouldServeCrawler(c);
    const wikiName = c.env.WIKI_NAME || 'CloudWiki';
    const canonicalUrl = new URL(c.req.url).origin + `/w/${encodeURIComponent(slug)}`;

    // ── 캐시 확인 (비관리자 + redirect=no가 아닌 일반 요청만) ──
    // 크롤러용 응답은 일반 SPA HTML과 형태가 달라 같은 캐시 키를 공유하면 안 되므로 캐시 우회
    const cache = caches.default;
    // 쿼리 파라미터를 제거한 정규화된 URL을 캐시 키로 사용
    const ssrCacheUrl = new URL(c.req.url);
    ssrCacheUrl.search = '';
    const ssrCacheKey = new Request(ssrCacheUrl.toString(), { method: 'GET' });
    const canUseCache = !isAdmin && !isCrawler && redirectParam !== 'no';

    // 일반 문서 캐시 매치 (map: 슬러그는 권한 차이에 따라 트리가 달라지므로 글로벌 매치를 건너뛰고
    // 아래 map: 분기 안에서 `!user` 조건으로만 매치한다 — 권한자가 anonymous 캐시에 갇히지 않도록.)
    if (canUseCache && !isMapNamespace(slug)) {
        const cached = await cache.match(ssrCacheKey);
        if (cached) {
            trackPageView(c, slug, Date.now() - startTime);
            return new Response(cached.body, cached);
        }
    }

    // "map:<base>" 슬러그는 실제 문서가 아니라 <base> 를 루트로 한 하위 문서 트리 뷰를
    // 합성해 보여주는 가상 페이지다. DB 조회 전에 가로채 트리 마크다운을 만들고 SSR 한다.
    if (isMapNamespace(slug)) {
        // 관리자 토글: ?perms=1 이면 각 노드 옆에 비공개/ACL 태그를 표시. 비관리자가 강제로 켜도 무시.
        const permsQueryRaw = c.req.query('perms');
        const showPerms = !!isAdmin && permsQueryRaw === '1';
        // 비로그인 요청에 한해 글로벌 캐시 매치 (anonymous 응답만 캐시에 들어가므로 안전).
        // 비로그인 사용자가 `?perms=1` 로 캐시를 오염시키지 못하도록 쿼리 없는 응답만 매치한다.
        if (!user && canUseCache && permsQueryRaw == null) {
            const cached = await cache.match(ssrCacheKey);
            if (cached) {
                trackPageView(c, slug, Date.now() - startTime);
                return new Response(cached.body, cached);
            }
        }
        const baseSlug = slug.substring('map:'.length);
        const canSeePrivate = rbac.can(user?.role ?? 'guest', 'wiki:private');
        const mapResult = await buildMapDocument({ db, baseSlug, canSeePrivate, showPerms });
        const titleStr = `${slug} - ${wikiName}`;
        const description = `${baseSlug || '(루트)'} 의 하위 문서 구조`;
        const ssrData: Record<string, any> = {
            _ssrSlug: slug,
            _ssrNotFound: false,
            is_map_doc: true,
            _ssrShowPerms: showPerms,
            slug,
            title: slug,
            content: mapResult.markdown,
            created_at: 0,
            updated_at: 0,
            _ssrTitle: titleStr,
            _ssrDescription: description,
        };
        const response = await renderHtml(c, '/', ssrData);
        // 권한자 응답(비공개 자식 포함 가능) 또는 로그인 사용자, ?perms=1(관리자 전용) 응답은 캐시 우회.
        // 비로그인 + 비공개 자식이 없는 트리만 공유 캐시 허용.
        const safeForSharedCache = !user && !mapResult.hasPrivateChildren && !showPerms;
        if (safeForSharedCache && canUseCache) {
            const cachedResponse = new Response(response.body, response);
            // map: 캐시는 자식 mutation 시 자동 무효화되지 않으므로 staleness 윈도우를 짧게 유지.
            cachedResponse.headers.set('Cache-Control', `public, max-age=${MAP_CACHE_MAX_AGE_SECONDS}`);
            if (crawlEnabled) cachedResponse.headers.set('Vary', 'User-Agent');
            c.executionCtx.waitUntil(cache.put(ssrCacheKey, cachedResponse.clone()));
            return cachedResponse;
        }
        response.headers.set('Cache-Control', 'private, no-store');
        if (crawlEnabled) response.headers.set('Vary', 'User-Agent');
        return response;
    }

    // "이미지:파일명" 슬러그는 media 테이블을 먼저 조회해 이미지 문서로 렌더링한다.
    // 대응되는 미디어가 없으면 레거시 pages 엔트리가 존재할 수 있으므로 일반 문서 렌더링으로 폴스루한다.
    if (slug.startsWith('이미지:')) {
        const filename = slug.substring('이미지:'.length);
        const mediaRow = await db.prepare(
            `SELECT m.id, m.r2_key, m.filename, m.mime_type, m.size, m.content, m.created_at,
                    u.name as uploader_name
             FROM media m LEFT JOIN users u ON m.uploader_id = u.id
             WHERE m.filename = ? LIMIT 1`
        ).bind(filename).first<{
            id: number; r2_key: string; filename: string; mime_type: string;
            size: number; content: string; created_at: number; uploader_name: string | null;
        }>();

        if (mediaRow) {
            const tags = await fetchMediaTags(db, mediaRow.id);

            const description = mediaRow.content
                ? extractMetaDescription(mediaRow.content) || mediaRow.content.slice(0, 160)
                : `${mediaRow.filename} - 이미지 문서`;
            const titleStr = `${slug} - ${wikiName}`;

            if (isCrawler) {
                const mediaUrl = `/media/${mediaRow.r2_key}`;
                const tagListHtml = (tags && tags.length)
                    ? `<p><strong>태그:</strong> ${tags.map(t => escapeHtml(String(t))).join(', ')}</p>`
                    : '';
                const aiText = mediaRow.content ? await renderForAI(mediaRow.content, db, 0, slug) : '';
                const contentBlock = aiText ? `<pre>${escapeHtml(aiText)}</pre>` : '';
                const body = `<article>
<h1>${escapeHtml(slug)}</h1>
<figure>
<img src="${escapeHtml(mediaUrl)}" alt="${escapeHtml(mediaRow.filename)}">
<figcaption>${escapeHtml(mediaRow.filename)}</figcaption>
</figure>
${tagListHtml}
${contentBlock}
</article>`;
                // 인증된 요청은 공유/개인 캐시 모두 차단 (cross-user 누출 방지)
                const crawlerCacheControl = user ? 'private, no-store' : 'public, max-age=300';
                return buildCrawlerPage(c, { title: titleStr, description, bodyHtml: body, canonicalUrl, cacheControl: crawlerCacheControl });
            }

            const ssrData: Record<string, any> = {
                _ssrSlug: slug,
                _ssrNotFound: false,
                is_image_doc: true,
                slug,
                media: {
                    id: mediaRow.id,
                    r2_key: mediaRow.r2_key,
                    filename: mediaRow.filename,
                    mime_type: mediaRow.mime_type,
                    size: mediaRow.size,
                    uploader_name: mediaRow.uploader_name,
                    url: `/media/${mediaRow.r2_key}`,
                    tags,
                },
                content: mediaRow.content || '',
                created_at: mediaRow.created_at,
                updated_at: mediaRow.created_at,
                _ssrTitle: titleStr,
                _ssrDescription: description,
            };

            const response = await renderHtml(c, '/', ssrData);

            if (canUseCache) {
                const cachedResponse = new Response(response.body, response);
                cachedResponse.headers.set('Cache-Control', 'public, max-age=86400');
                // ALLOW_CRAWL=true 일 때만 같은 URL이 UA에 따라 두 변형(SPA / 크롤러)으로
                // 분기되므로, 그 경우에만 Vary를 추가해 공유 캐시 단편화를 최소화한다.
                if (crawlEnabled) cachedResponse.headers.set('Vary', 'User-Agent');
                c.executionCtx.waitUntil(cache.put(ssrCacheKey, cachedResponse.clone()));
                return cachedResponse;
            }
            if (crawlEnabled) response.headers.set('Vary', 'User-Agent');
            return response;
        }
        // mediaRow 부재 시 아래 일반 pages 조회로 폴스루 (legacy 이미지: 슬러그 호환)
    }

    // 1) DB에서 문서 데이터 조회
    let page = await db
        .prepare('SELECT * FROM pages WHERE slug = ?')
        .bind(slug)
        .first<Page>();

    const canSeePrivate = rbac.can(user?.role ?? 'guest', 'wiki:private');

    // 비공개 문서: 권한이 없으면 본문/메타데이터를 노출하지 않고 "비공개 문서" 안내 화면을 SSR 한다.
    // (삭제 분기보다 먼저 평가해 "비공개·삭제" 동시 상태에서 비공개 사실이 우선 노출되도록 함)
    if (page && page.is_private === 1 && !canSeePrivate) {
        if (isCrawler) {
            const title = `비공개 문서 - ${wikiName}`;
            const body = `<article>
<h1>${escapeHtml(slug)}</h1>
<p>이 문서는 비공개 상태입니다.</p>
</article>`;
            return buildCrawlerPage(c, {
                title,
                description: `${slug} 문서는 비공개 상태입니다.`,
                bodyHtml: body,
                canonicalUrl,
                status: 403,
                cacheControl: 'private, no-store',
            });
        }
        const privateSsrData: Record<string, any> = {
            _ssrSlug: slug,
            _ssrNotFound: true,
            _ssrPrivate: true,
            _ssrTitle: `비공개 문서 - ${wikiName}`,
        };
        const response = await renderHtml(c, '/', privateSsrData);
        const forbiddenResponse = new Response(response.body, { status: 403, headers: response.headers });
        forbiddenResponse.headers.set('Cache-Control', 'private, no-store');
        if (crawlEnabled) forbiddenResponse.headers.set('Vary', 'User-Agent');
        return forbiddenResponse;
    }

    if (page && page.deleted_at && !isAdmin) {
        if (isCrawler) {
            const title = `삭제된 문서 - ${wikiName}`;
            const body = `<article>
<h1>${escapeHtml(slug)}</h1>
<p>이 문서는 삭제되었습니다.</p>
</article>`;
            return buildCrawlerPage(c, {
                title,
                description: `${slug} 문서는 삭제되었습니다.`,
                bodyHtml: body,
                canonicalUrl,
                status: 410,
                cacheControl: 'no-store, must-revalidate',
            });
        }
        // SSR에서도 삭제된 문서 처리
        const deletedSsrData: Record<string, any> = {
            _ssrSlug: slug,
            _ssrNotFound: true,
            _ssrDeleted: true,
            _ssrTitle: `삭제된 문서 - ${wikiName}`
        };
        // 삭제된 문서는 리다이렉트나 본문 조회를 하지 않도록 처리
        const response = await renderHtml(c, '/', deletedSsrData);
        const goneResponse = new Response(response.body, { status: 410, headers: response.headers });
        goneResponse.headers.set('Cache-Control', 'no-store, must-revalidate');
        if (crawlEnabled) goneResponse.headers.set('Vary', 'User-Agent');
        return goneResponse;
    }

    // 원본(리다이렉트 이전) 슬러그의 비공개 여부 기록.
    // 비공개 슬러그가 public 으로 리다이렉트되어 page 가 public 으로 교체되면 shouldCache 검사에서
    // is_private = 0 으로 보이지만, 캐시 키(URL = 원본 슬러그) 에 200 응답이 저장돼
    // 권한 없는 후속 요청이 캐시 히트로 200 을 받아 "비공개 슬러그가 존재함" 이 누출된다.
    const sourceWasPrivate = !!(page && page.is_private === 1);

    let redirectedFrom: string | null = null;

    // 문서 내 리다이렉트 설정 확인 (soft redirect)
    if (page && page.redirect_to && redirectParam !== 'no') {
        let targetPage = await db
            .prepare('SELECT * FROM pages WHERE slug = ?')
            .bind(page.redirect_to)
            .first<Page>();

        if (targetPage && targetPage.deleted_at && !isAdmin) {
            targetPage = null;
        }

        if (targetPage && targetPage.is_private === 1 && !canSeePrivate) {
            targetPage = null;
        }

        if (targetPage) {
            redirectedFrom = slug;
            page = targetPage;
        }
    }

    // 2) SSR 데이터 구성
    let ssrData: Record<string, any> = {
        _ssrSlug: slug,
        _ssrNotFound: false,
    };

    // 캐싱 가능 여부 (공개 문서가 정상 존재하는 경우만)
    // 비공개 페이지는 권한 보유자(wiki:private)에게만 노출되므로 공유 캐시에 저장하면 안 된다.
    // (canUseCache 는 isAdmin 만 배제하므로, wiki:private 만 가진 커스텀 역할의 응답이 캐시되는 누출 경로를 차단)
    // sourceWasPrivate 도 함께 배제 — 비공개 슬러그가 public 으로 리다이렉트된 경우에도 캐시 키(원본 슬러그)에 저장 금지.
    let shouldCache = canUseCache && !sourceWasPrivate && !(page && page.is_private === 1);

    if (!page) {
        // 크롤러: 문서 없음을 404로 응답
        if (isCrawler) {
            const title = `문서 없음 - ${wikiName}`;
            const body = `<article>
<h1>${escapeHtml(slug)}</h1>
<p>요청하신 문서가 존재하지 않습니다.</p>
</article>`;
            return buildCrawlerPage(c, {
                title,
                description: `${slug} 문서를 찾을 수 없습니다.`,
                bodyHtml: body,
                canonicalUrl,
                status: 404,
                cacheControl: 'no-store, must-revalidate',
            });
        }
        ssrData._ssrNotFound = true;
        ssrData._ssrTitle = `문서 없음 - ${wikiName}`;
        shouldCache = false; // 미존재 문서는 캐싱하지 않음
    } else {
        // R2-only 네임스페이스인 경우, 본문이 비어있다면 최신 리비전에서 본문을 가져옵니다.
        const origin = new URL(c.req.url).origin;
        const enabledExtSSR = getEnabledExtensions(c.env);
        if (isR2OnlyNamespace(page.slug, enabledExtSSR) && (!page.content || page.content === '')) {
            if (page.last_revision_id) {
                const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(page.last_revision_id).first<{ content: string, r2_key: string | null }>();
                if (lastRev) {
                    page.content = await getRevisionContent(c.env.MEDIA, lastRev, origin);
                }
            }
        }

        // 본문 내용 기반 설명글(Description) 생성
        let desc = `${page.slug} - ${wikiName}`;
        if (page.content) {
            const extracted = extractMetaDescription(page.content);
            if (extracted) {
                desc = extracted;
            }
        }

        // 크롤러: 본문(마크다운)이 보이는 미니멀 HTML로 응답
        // renderForAI 결과는 그대로 마크다운이므로 escape 후 <pre>에 넣어 전달한다.
        if (isCrawler) {
            // 관리자 열람 전용 비공개 문서는 Analytics Engine 통계에서 완전히 제외
            // (sourceWasPrivate: 비공개 슬러그가 public 으로 redirect 된 진입 경로도 함께 차단)
            if (page.is_private !== 1 && !sourceWasPrivate) {
                trackPageView(c, page.slug, Date.now() - startTime);
            }
            // 표시 이름은 title 우선, 호출/공식 식별자는 slug. 둘 다 크롤러에 노출해 검색 색인성 유지.
            const displayName = page.title || page.slug;
            const title = `${displayName} - ${wikiName}`;
            const aiText = page.content ? await renderForAI(page.content, db, 0, page.slug) : '';
            const redirectedNote = redirectedFrom
                ? `<p><em>${escapeHtml(redirectedFrom)} 에서 자동으로 넘어왔습니다.</em></p>`
                : '';
            const slugLine = page.title
                ? `<p><small>제목: <code>${escapeHtml(page.slug)}</code></small></p>`
                : '';
            const contentBlock = aiText
                ? `<pre>${escapeHtml(aiText)}</pre>`
                : '<p><em>본문이 비어있습니다.</em></p>';
            const body = `<article>
<h1>${escapeHtml(displayName)}</h1>
${slugLine}
${redirectedNote}
${contentBlock}
</article>`;
            // 인증된 요청은 공유/개인 캐시 모두 차단해
            // Vary: User-Agent만으로는 막을 수 없는 cross-user 누출을 차단한다.
            const isSensitive = !!user;
            const crawlerCacheControl = isSensitive ? 'private, no-store' : 'public, max-age=300';
            return buildCrawlerPage(c, {
                title,
                description: desc,
                bodyHtml: body,
                canonicalUrl: new URL(c.req.url).origin + `/w/${encodeURIComponent(page.slug)}`,
                cacheControl: crawlerCacheControl,
            });
        }

        // 본문이 참조하는 커스텀 팔레트만 로드해 SSR 페이로드 최소화.
        // 트랜스클루전된 틀이 자체 본문에서 참조하는 팔레트도 합집합으로 포함.
        let usedPalettes: Record<string, unknown> = {};
        try {
            // canSeePrivate: 비공개 틀 본문은 권한자에게만 렌더러가 펼치므로,
            // 그 경우에만 비공개 틀이 참조하는 팔레트도 _usedPalettes 에 포함한다.
            // 단, 응답이 공유 캐시에 저장될 경우 사용자 권한에 따른 차이가 다른 사용자에게
            // 누출되므로 — 캐시 가능 응답에서는 항상 false 로 강제 (private 페이지 / admin
            // / 크롤러 경로는 shouldCache=false 라 영향 없음, wiki:private 권한이 있어도
            // 공개 페이지를 볼 땐 공개 팔레트만 받음).
            const palettePerm = canSeePrivate && !shouldCache;
            usedPalettes = await loadPalettesForPage(db, page.id, page.content, palettePerm);
        } catch (e) {
            // palettes 테이블 미마이그레이션 환경에서도 본문 자체는 정상 렌더돼야 함
            console.error('loadPalettesForPage failed:', e);
        }

        ssrData = {
            ...safeJSON({ ...page, redirected_from: redirectedFrom }),
            _ssrSlug: slug,
            _ssrNotFound: false,
            // title 이 있으면 표시용 제목으로 사용. 호출 식별자(URL, og:url 등)는 슬러그.
            _ssrTitle: `${page.title || page.slug} - ${wikiName}`,
            _ssrDescription: desc,
            _usedPalettes: usedPalettes,
            // 문서별 본문 보기 모드 — 클라이언트가 'presentation' 등 본문 렌더 모드를 판정하는 데 사용.
            _ssrViewMode: page.view_mode ?? null,
        };
    }

    // 3) HTMLRewriter로 SSR 데이터 주입 + 브랜딩 및 컴포넌트 치환
    const response = await renderHtml(c, '/', ssrData);

    // Analytics: 문서 조회 추적 (존재하는 문서만)
    // 관리자 열람 전용 비공개 문서는 Analytics Engine 통계에서 완전히 제외
    // (sourceWasPrivate: 비공개 슬러그가 public 으로 redirect 된 진입 경로도 함께 차단)
    if (!ssrData._ssrNotFound && ssrData.is_private !== 1 && !sourceWasPrivate) {
        trackPageView(c, ssrData.slug || slug, Date.now() - startTime);
    }

    // 4) 공개 문서이면 Edge 캐시에 24시간 저장
    if (shouldCache) {
        const cachedResponse = new Response(response.body, response);
        cachedResponse.headers.set('Cache-Control', 'public, max-age=86400');
        // ALLOW_CRAWL=true일 때만 UA에 따라 응답 변형이 갈리므로 그 경우에만 Vary 추가
        if (crawlEnabled) cachedResponse.headers.set('Vary', 'User-Agent');
        c.executionCtx.waitUntil(cache.put(ssrCacheKey, cachedResponse.clone()));
        return cachedResponse;
    }

    // 비공개 페이지는 권한 있는 사용자에게만 노출되므로, 공유/브라우저 캐시에 저장되지 않도록 강제한다.
    // sourceWasPrivate 도 함께 — 비공개 슬러그가 public 으로 리다이렉트된 응답도 캐시 누출 차단.
    if (sourceWasPrivate || (page && page.is_private === 1)) {
        response.headers.set('Cache-Control', 'private, no-store');
    }

    if (crawlEnabled) response.headers.set('Vary', 'User-Agent');
    return response;
});

// /login 접근 시 로그인 페이지 서빙
app.get('/login', async (c) => {
    if (c.get('user')) {
        return c.redirect('/');
    }
    const db = c.env.DB;
    const tosSlug = c.env.TERMS_OF_SERVICE || '';
    const ppSlug = c.env.PRIVACY_POLICY || '';
    const [tosPage, ppPage] = await Promise.all([
        tosSlug ? db.prepare('SELECT content FROM pages WHERE slug = ? AND deleted_at IS NULL LIMIT 1').bind(tosSlug).first<{ content: string }>() : Promise.resolve(null),
        ppSlug ? db.prepare('SELECT content FROM pages WHERE slug = ? AND deleted_at IS NULL LIMIT 1').bind(ppSlug).first<{ content: string }>() : Promise.resolve(null),
    ]);
    return renderHtml(c, '/login.html', {
        _ssrTitle: '로그인 - ' + (c.env.WIKI_NAME || 'Cloudwiki'),
        loginMessage: c.env.LOGIN_MESSAGE || '비공개 위키입니다. 로그인 후 이용해주세요.',
        termsOfService: tosPage?.content || '',
        privacyPolicy: ppPage?.content || '',
    });
});

// / (루트) 접근 시 index.html 서빙 (SSR 브랜딩 적용)
app.get('/', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.redirect('/login');
    }
    if (c.env.WIKI_HOME_PAGE) {
        return c.redirect(`/w/${encodeURIComponent(c.env.WIKI_HOME_PAGE)}`);
    }
    return renderHtml(c, '/');
});

// /search 접근 시 search.html 서빙 (SSR 브랜딩 적용)
app.get('/search', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.redirect('/login');
    }
    return fetchAssetHtml(c, '/search.html');
});

// /admin 접근 시 서버사이드 권한 체크 후 admin.html 서빙
// (Astro 셸로 브랜딩·컴포넌트·CDN 번들이 빌드 타임에 베이킹돼 요청별 데이터가 없으므로 정적 서빙)
app.get('/admin', async (c) => {
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    if (!user || !rbac.can(user.role, 'admin:access')) {
        return c.redirect('/');
    }
    return fetchAssetHtml(c, '/admin.html');
});

// /admin-media 접근 시 서버사이드 권한 체크 후 admin-media.html 서빙
app.get('/admin-media', async (c) => {
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    if (!user || !rbac.can(user.role, 'admin:access')) {
        return c.redirect('/');
    }
    return fetchAssetHtml(c, '/admin-media.html');
});

// /admin-bulk-manage 접근 시 서버사이드 권한 체크 후 admin-bulk-manage.html 서빙
// (문서 대량 관리 — 대량 삭제·이동은 최고 관리자 전용 — admin:access 가 아닌 '*' 권한 필요)
app.get('/admin-bulk-manage', async (c) => {
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    if (!user || !rbac.can(user.role, '*')) {
        return c.redirect('/');
    }
    return fetchAssetHtml(c, '/admin-bulk-manage.html');
});

// /mypage 접근 시 mypage.html 서빙 (SSR 브랜딩)
app.get('/mypage', async (c) => {
    return fetchAssetHtml(c, '/mypage.html');
});

// /blog-edit → blog-edit.html 서빙 (관리자 전용)
// (Astro 셸로 베이킹돼 요청별 데이터가 없으므로(BLOG_MODE 인라인 플래그만) 정적 서빙)
app.get('/blog-edit', async (c) => {
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    if (!user || !rbac.can(user.role, 'admin:access')) {
        return c.redirect('/');
    }
    return fetchAssetHtml(c, '/blog-edit.html');
});

// /blog/:id → blog.html 서빙 (공개, closed wiki는 로그인 필요)
app.get('/blog/:id', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.redirect('/login');
    }
    // 본문이 참조하는 커스텀 팔레트만 SSR 주입. blog.html 의 클라이언트 렌더링 시점에
    // window._ssrData._usedPalettes 가 사용된다.
    // soft-delete 된 포스트의 page_links 가 남아있을 수 있으므로, 비관리자에게
    // 노출되는 SSR 응답에 그 데이터가 새지 않도록 가시성 체크 후에만 로드.
    const idNum = Number(c.req.param('id'));
    let usedPalettes: Record<string, unknown> = {};
    if (Number.isFinite(idNum) && idNum > 0) {
        const user = c.get('user');
        const rbac = c.get('rbac') as RBAC | undefined;
        const isAdmin = !!(user && rbac && rbac.can(user.role, 'admin:access'));
        // 블로그 본문도 트랜스클루전 시 /api/w/:slug 로 틀을 가져오므로, 비공개 틀의
        // 팔레트는 wiki:private 권한자에게만 SSR 페이로드에 포함시킨다.
        const canSeePrivate = !!(rbac && rbac.can(user?.role ?? 'guest', 'wiki:private'));
        try {
            const post = await c.env.DB
                .prepare('SELECT deleted_at FROM blog_posts WHERE id = ?')
                .bind(idNum)
                .first<{ deleted_at: number | null }>();
            if (post && (!post.deleted_at || isAdmin)) {
                usedPalettes = await loadPalettesForBlogPost(c.env.DB, idNum, undefined, canSeePrivate);
            }
        } catch (e) {
            console.error('loadPalettesForBlogPost failed:', e);
        }
    }
    return renderHtml(c, '/blog.html', { _usedPalettes: usedPalettes });
});

// /blog → blog.html 서빙 (목록, 공개)
app.get('/blog', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.redirect('/login');
    }
    return renderHtml(c, '/blog.html');
});

// /edit/:slug → edit.html 서빙
// (Astro 셸로 베이킹: _wikiSyntax 는 빌드 타임에 #ssr-data 로 인라인되므로 런타임 주입 불필요 → 정적 서빙)
app.get('/edit/:slug', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.redirect('/login');
    }
    return fetchAssetHtml(c, '/edit.html');
});

// /edit → edit.html 서빙 (Astro 셸 정적 서빙)
app.get('/edit', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.redirect('/login');
    }
    return fetchAssetHtml(c, '/edit.html');
});

// /setup-profile 접근 시 서빙
app.get('/setup-profile', async (c) => {
    return fetchAssetHtml(c, '/setup-profile.html');
});

// /error 접근 시 error.html 서빙 (SSR 브랜딩 + reason 쿼리 파라미터 주입)
app.get('/error', async (c) => {
    const reason = c.req.query('reason') || '알 수 없는 오류가 발생했습니다.';
    const res = await renderHtml(c, '/error.html', {
        _ssrTitle: '오류가 발생했습니다 - ' + (c.env.WIKI_NAME || 'CloudWiki'),
        _ssrReason: reason,
    });
    return new Response(res.body, { status: 400, headers: res.headers });
});

// /profile/:id 접근 시 user-profile.html 서빙 (SSR 브랜딩)
app.get('/profile/:id', async (c) => {
    return fetchAssetHtml(c, '/user-profile.html');
});

// ── 사이트맵 ──
app.get('/sitemap.xml', async (c) => {
    // ALLOW_CRAWL이 true가 아니면 빈 사이트맵 반환
    if (c.env.ALLOW_CRAWL !== 'true') {
        const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>';
        return new Response(xml, {
            headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        });
    }

    const db = c.env.DB;
    const baseUrl = new URL(c.req.url).origin;

    const [{ results: pages }, { results: blogPosts }] = await Promise.all([
        db
            .prepare('SELECT slug, updated_at FROM pages WHERE deleted_at IS NULL AND redirect_to IS NULL AND is_private = 0')
            .all<{ slug: string; updated_at: number }>(),
        db
            .prepare('SELECT id, updated_at FROM blog_posts WHERE deleted_at IS NULL ORDER BY created_at DESC')
            .all<{ id: number; updated_at: number }>(),
    ]);

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    // 메인 페이지
    xml += '  <url>\n';
    xml += `    <loc>${baseUrl}/</loc>\n`;
    xml += '    <changefreq>daily</changefreq>\n';
    xml += '    <priority>1.0</priority>\n';
    xml += '  </url>\n';

    for (const page of pages || []) {
        const lastmod = new Date(page.updated_at * 1000).toISOString().split('T')[0];
        xml += '  <url>\n';
        xml += `    <loc>${baseUrl}/w/${encodeURIComponent(page.slug)}</loc>\n`;
        xml += `    <lastmod>${lastmod}</lastmod>\n`;
        xml += '    <changefreq>weekly</changefreq>\n';
        xml += '    <priority>0.8</priority>\n';
        xml += '  </url>\n';
    }

    // 블로그 목록 페이지
    xml += '  <url>\n';
    xml += `    <loc>${baseUrl}/blog</loc>\n`;
    xml += '    <changefreq>daily</changefreq>\n';
    xml += '    <priority>0.8</priority>\n';
    xml += '  </url>\n';

    for (const post of blogPosts || []) {
        const lastmod = new Date(post.updated_at * 1000).toISOString().split('T')[0];
        xml += '  <url>\n';
        xml += `    <loc>${baseUrl}/blog/${post.id}</loc>\n`;
        xml += `    <lastmod>${lastmod}</lastmod>\n`;
        xml += '    <changefreq>weekly</changefreq>\n';
        xml += '    <priority>0.7</priority>\n';
        xml += '  </url>\n';
    }

    xml += '</urlset>';

    return new Response(xml, {
        headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    });
});

// ── Robots.txt ──
app.get('/robots.txt', (c) => {
    // ALLOW_CRAWL이 true가 아니면 전체 차단
    if (c.env.ALLOW_CRAWL !== 'true') {
        const robotsTxt = 'User-agent: *\nDisallow: /';
        return new Response(robotsTxt, {
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
    }

    const baseUrl = new URL(c.req.url).origin;
    const robotsTxt = `${robotsTxtBase}\nSitemap: ${baseUrl}/sitemap.xml`;

    return new Response(robotsTxt, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
});

// ── MCP / API Discovery 대응 ──
// Claude 등이 .well-known 을 조회할 때 HTML 대신 JSON 404를 반환하도록 함
app.get('/.well-known/*', (c) => {
    return c.json({ error: 'Discovery not implemented' }, 404);
});

app.post('/register', (c) => {
    return c.json({ error: 'Dynamic registration not supported' }, 404);
});

// ── 알 수 없는 경로 → 위키 슬러그 리다이렉트 ──
// 위의 어떤 라우트에도 매칭되지 않은 경로는 위키 문서 슬러그로 간주해 /w/로 영구 리디렉션
app.get('*', (c) => {
    const path = c.req.path;
    if (path.startsWith('/api/') || path.startsWith('/assets/')) {
        return c.json({ error: 'Not Found' }, 404);
    }
    const slug = path.slice(1); // 앞의 / 제거
    const searchParams = new URL(c.req.url).search;
    return c.redirect(`/w/${slug}${searchParams}`, 301);
});

// ── 404 핸들러 ──
app.notFound(async (c) => {
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/assets/')) {
        return c.json({ error: 'Not Found' }, 404);
    }
    const res = await renderHtml(c, '/error.html', { 
        _ssrTitle: '페이지를 찾을 수 없습니다 - ' + (c.env?.WIKI_NAME || 'CloudWiki'),
        _ssrReason: '요청하신 페이지를 찾을 수 없습니다 (404 Not Found)'
    });
    return new Response(res.body, { status: 404, headers: res.headers });
});

// ── 에러 핸들러 ──
app.onError(async (err, c) => {
    console.error('Unhandled error:', err);
    trackError(c, c.req.path, 500, err.message || 'Internal Server Error');
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/assets/')) {
        return c.json({ error: 'Internal Server Error' }, 500);
    }
    const res = await renderHtml(c, '/error.html', { 
        _ssrTitle: '오류가 발생했습니다 - ' + (c.env?.WIKI_NAME || 'CloudWiki'),
        _ssrReason: '서버 내부 오류가 발생했습니다 (500 Internal Server Error)'
    });
    return new Response(res.body, { status: 500, headers: res.headers });
});

export default {
    fetch: app.fetch,
    async scheduled(event: ScheduledEvent, env: Env['Bindings'], ctx: ExecutionContext) {
        // 매일 자정 실행되어 차단 기간이 끝난 유저들의 banned_until을 초기화하고 role을 기본으로 복구
        const now = Math.floor(Date.now() / 1000);
        ctx.waitUntil(
            env.DB.prepare(`
                UPDATE users
                SET banned_until = NULL, role = 'user'
                WHERE banned_until IS NOT NULL AND banned_until <= ?
            `).bind(now).run()
        );
        // admin-mcp draft TTL:
        //   - 작성 중 draft (submitted_at IS NULL): 마지막 활동 이후 12시간(43200초) 후 삭제.
        //   - 승인 대기 제출안 (submitted_at IS NOT NULL): 제출 후 30일(2592000초) 후 삭제.
        //     유저가 검토하지 않은 채 무한 누적되지 않도록 별도 TTL 을 둔다.
        //     이 때 mcp_submission 알림도 함께 삭제해 유저의 미확인 알림이 dead link 로 남지 않게 한다.
        // 크론 주기(매일 자정) 때문에 실제 만료 시점은 약간 늦어질 수 있다.
        // submitted_at 컬럼이 누락된 레거시 환경을 위해 먼저 idempotent 마이그레이션 보장.
        ctx.waitUntil((async () => {
            await ensureMcpDraftsMigration(env.DB);
            const draftTtl = now - 43200;
            const submissionTtl = now - 2592000;
            // 알림 → draft 순으로 삭제. 반대 순서면 draft 가 먼저 사라져 SELECT IN 이 매칭하지 못한다.
            await env.DB.batch([
                env.DB.prepare(
                    "DELETE FROM notifications WHERE type = 'mcp_submission' AND ref_id IN " +
                    "(SELECT id FROM mcp_drafts WHERE submitted_at IS NOT NULL AND submitted_at < ?)"
                ).bind(submissionTtl),
                env.DB.prepare(
                    'DELETE FROM mcp_drafts WHERE submitted_at IS NULL AND updated_at < ?'
                ).bind(draftTtl),
                env.DB.prepare(
                    'DELETE FROM mcp_drafts WHERE submitted_at IS NOT NULL AND submitted_at < ?'
                ).bind(submissionTtl),
            ]);
        })());
        // 알림 보존 정책: 읽음 여부와 무관하게 생성 후 90일(7776000초)이 지난 알림을 정리.
        // 읽음·보관 모델에서 알림은 클릭 시 삭제 대신 읽음 처리되어 보관함(마이페이지)에
        // 쌓이므로, 무한 누적을 막기 위한 상한선으로 90일 TTL 을 둔다.
        // 크론 주기(매일 자정) 때문에 실제 만료 시점은 약간 늦어질 수 있다.
        ctx.waitUntil((async () => {
            await ensureNotificationsMigration(env.DB);
            await env.DB.prepare(
                'DELETE FROM notifications WHERE created_at < ?'
            ).bind(now - 7776000).run();
        })());
        // OAuth 인가 코드: TTL 60초이므로 1시간(3600초) 이상 지난 코드는 모두 만료 상태.
        ctx.waitUntil(
            env.DB.prepare(
                'DELETE FROM oauth_codes WHERE expires_at < ?'
            ).bind(now - 3600).run()
        );
        // OAuth 토큰 보관 정책: 사용 종료(revoked) 또는 리프레시 만료 후 7일이 지나면 삭제.
        // COALESCE(revoked_at, refresh_expires_at, access_expires_at) 가 토큰의 "수명 종료
        // 시각"을 의미하며, 그 시각이 7일(604800초) 이상 지난 행은 인증 단계에서 어차피
        // 거절되므로 보관 가치가 없음. 마이페이지의 노출 윈도우와 동일하게 맞춘다.
        ctx.waitUntil(
            env.DB.prepare(
                `DELETE FROM oauth_tokens
                 WHERE COALESCE(revoked_at, refresh_expires_at, access_expires_at) < ?`
            ).bind(now - 604800).run()
        );
    }
};
