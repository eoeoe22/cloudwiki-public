import { Hono, Context } from 'hono';
import robotsTxtBase from './robots-txt';
import { csrf } from 'hono/csrf';
import { secureHeaders } from 'hono/secure-headers';
import type { Env, Page } from './types';
import { sessionMiddleware } from './middleware/session';
import { applyPageSSR, extractMetaDescription } from './middleware/ssr';
import { safeJSON } from './utils/json';
import { escapeHtml, sanitizeUrl } from './utils/html';
import authRoutes from './routes/auth';
import wikiRoutes from './routes/wiki';
import searchRoutes from './routes/search';
import mediaRoutes from './routes/media';
import adminRoutes from './routes/admin';
import discussionRoutes from './routes/discussion';
import notificationRoutes from './routes/notification';
import ticketRoutes from './routes/ticket';
import mcpRoutes from './routes/mcp';
import analyticsRoutes from './routes/analytics';
import { trackPageView, trackError, queryAnalytics } from './utils/analytics';

const app = new Hono<Env>();

//
// ── 미들웨어 ──
// Secure Headers
app.use('*', secureHeaders());

// CSRF 보호 (GET/HEAD/OPTIONS 제외)
// MCP API 경로는 외부 서비스(Claude 등)에서 호출하므로 CSRF 제외
app.use('*', (c, next) => {
    if (c.req.path === '/api/mcp' || c.req.path.startsWith('/api/mcp/')) {
        return next();
    }
    return csrf()(c, next);
});

// 세션 미들웨어 (모든 요청에서 유저 정보를 주입)
app.use('*', sessionMiddleware);

// ── 라우트 등록 ──
app.route('/', authRoutes);
app.route('/api', wikiRoutes);
app.route('/api', searchRoutes);
app.route('/', mediaRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api', discussionRoutes);
app.route('/api', notificationRoutes);
app.route('/api', ticketRoutes);
app.route('/api/mcp', mcpRoutes);
app.route('/api/admin/analytics', analyticsRoutes);

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

app.get('/api/analytics/page-views/:slug', async (c) => {
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

// ── 컴포넌트 HTML 메모리 캐시 (Worker 인스턴스 수명 동안 유지) ──
let componentCache: { header: string; sidebar: string; footer: string; timestamp: number } | null = null;
const COMPONENT_CACHE_TTL = 1_800_000; // 30분

// ── 헬퍼: 사이드바/푸터 커스텀 HTML 생성 ──
function buildCustomSidebarHtml(configStr: string | null): string {
    if (!configStr) return '';
    try {
        const config = JSON.parse(configStr);
        if (!Array.isArray(config)) return '';
        let html = '';
        for (const item of config) {
            if (item.type === 'header') {
                html += `<li class="nav-item mt-3 mb-1 px-3 fw-bold text-muted small">${escapeHtml(item.text)}</li>`;
            } else if (item.type === 'link') {
                const iconHtml = item.icon ? `<i class="${escapeHtml(item.icon)} me-2"></i>` : '';
                const safeUrl = sanitizeUrl(item.url);
                const target = item.url?.startsWith('/') ? '' : ' target="_blank" rel="noopener noreferrer"';
                html += `<li class="nav-item mb-1"><a class="nav-link px-3 py-2 rounded text-body" href="${safeUrl}"${target}>${iconHtml}${escapeHtml(item.text)}</a></li>`;
            } else if (item.type === 'text') {
                const iconHtml = item.icon ? `<i class="${escapeHtml(item.icon)} me-2"></i>` : '';
                html += `<li class="nav-item mb-1 px-3 py-2 text-body small">${iconHtml}${escapeHtml(item.text)}</li>`;
            } else if (item.type === 'divider') {
                html += `<li><hr class="w-100 my-2" style="border-color: var(--wiki-border); opacity: 1;"></li>`;
            }
        }
        return html;
    } catch {
        return '';
    }
}

function buildCustomFooterHtml(configStr: string | null): string {
    if (!configStr) return '';
    try {
        const config = JSON.parse(configStr);
        if (!Array.isArray(config)) return '';
        let html = '';
        for (const item of config) {
            if (item.type === 'link') {
                const iconHtml = item.icon ? `<i class="${escapeHtml(item.icon)} me-1"></i>` : '';
                const safeUrl = sanitizeUrl(item.url);
                const target = item.url?.startsWith('/') ? '' : ' target="_blank" rel="noopener noreferrer"';
                html += `<a class="footer-link" href="${safeUrl}"${target}>${iconHtml}${escapeHtml(item.text)}</a>`;
            } else if (item.type === 'text') {
                const iconHtml = item.icon ? `<i class="${escapeHtml(item.icon)} me-1"></i>` : '';
                html += `<span class="footer-text">${iconHtml}${escapeHtml(item.text)}</span>`;
            } else if (item.type === 'divider') {
                html += `<span class="footer-divider">|</span>`;
            }
        }
        return html;
    } catch {
        return '';
    }
}

// ── 헬퍼: 공통 컴포넌트를 주입하여 HTML 렌더링 ──
async function renderHtml(c: Context<Env>, targetHtmlPath: string, pageData: Record<string, any> = {}): Promise<Response> {
    const htmlResponse = await fetchAssetHtml(c, targetHtmlPath);

    const wikiName = c.env.WIKI_NAME || 'CloudWiki';
    const wikiLogoUrl = c.env.WIKI_LOGO_URL || '';
    const wikiFaviconUrl = c.env.WIKI_FAVICON_URL || '/favicon.ico';

    // 사이드바/푸터 커스텀 HTML 및 컴포넌트를 병렬로 로드
    const now = Date.now();
    const cacheValid = componentCache && (now - componentCache.timestamp < COMPONENT_CACHE_TTL);

    // wrangler.toml vars에서 커스텀 사이드바/푸터 설정을 로드
    const customSidebarHtml = buildCustomSidebarHtml(c.env.SIDEBAR || null);
    const customFooterHtml = buildCustomFooterHtml(c.env.FOOTER || null);

    const getRewriter = () => new HTMLRewriter()
        .on('.app-wiki-name', {
            text(text) {
                if (text.text.includes('CloudWiki')) {
                    text.replace(text.text.replace('CloudWiki', wikiName));
                } else if (text.text.includes('Cloudwiki')) {
                    text.replace(text.text.replace('Cloudwiki', wikiName));
                }
            }
        })
        .on('.wiki-logo-container', {
            element(element) {
                if (wikiLogoUrl) {
                    element.setInnerContent(`<img src="${escapeHtml(wikiLogoUrl)}" alt="Logo" class="brand-logo" style="height: 32px; vertical-align: middle; margin-right: 8px;">`, { html: true });
                }
            }
        })
        .on('#custom-sidebar-content', {
            element(element) {
                if (customSidebarHtml) {
                    element.replace(customSidebarHtml, { html: true });
                } else {
                    element.remove();
                }
            }
        })
        .on('#custom-footer-content', {
            element(element) {
                if (customFooterHtml) {
                    element.setInnerContent(customFooterHtml, { html: true });
                } else {
                    element.remove();
                }
            }
        })
        .on('#error-reason', {
            element(element) {
                if (pageData._ssrReason) {
                    element.setInnerContent(pageData._ssrReason, { html: false });
                }
            }
        });

    let headerHtml = '';
    let sidebarHtml = '';
    let footerHtml = '';

    if (cacheValid) {
        // 캐시된 컴포넌트 HTML 사용
        headerHtml = componentCache!.header;
        sidebarHtml = componentCache!.sidebar;
        footerHtml = componentCache!.footer;
    } else {
        // 3개 컴포넌트를 병렬로 로드 및 브랜딩 적용
        const [headerRes, sidebarRes, footerRes] = await Promise.all([
            fetchAssetHtml(c, '/components/header.html').catch(() => null),
            fetchAssetHtml(c, '/components/sidebar.html').catch(() => null),
            fetchAssetHtml(c, '/components/footer.html').catch(() => null),
        ]);

        const [h, s, f] = await Promise.all([
            headerRes?.ok ? getRewriter().transform(headerRes).text() : Promise.resolve(''),
            sidebarRes?.ok ? getRewriter().transform(sidebarRes).text() : Promise.resolve(''),
            footerRes?.ok ? getRewriter().transform(footerRes).text() : Promise.resolve(''),
        ]);

        headerHtml = h;
        sidebarHtml = s;
        footerHtml = f;

        // 메모리 캐시 업데이트
        componentCache = { header: headerHtml, sidebar: sidebarHtml, footer: footerHtml, timestamp: now };
    }

    return applyPageSSR(htmlResponse, pageData, {
        WIKI_NAME: wikiName,
        WIKI_LOGO_URL: wikiLogoUrl,
        WIKI_FAVICON_URL: wikiFaviconUrl,
        CUSTOM_HEADER: c.env.CUSTOM_HEADER || '',
    }, headerHtml, sidebarHtml, footerHtml);
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
    return renderHtml(c, '/tickets.html');
});

// /tickets → tickets.html 서빙 (SSR 브랜딩 적용)
app.get('/tickets', async (c) => {
    return renderHtml(c, '/tickets.html');
});

// /w/:slug/discussions/* → discussions.html 서빙 (SSR 브랜딩 적용)
app.get('/w/:slug/discussions/:id', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.redirect('/login');
    }
    return renderHtml(c, '/discussions.html');
});

app.get('/w/:slug/discussions', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.redirect('/login');
    }
    return renderHtml(c, '/discussions.html');
});

// /w/:slug/revisions → revisions.html 서빙 (SSR 브랜딩 적용)
app.get('/w/:slug/revisions', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.redirect('/login');
    }
    return renderHtml(c, '/revisions.html');
});

// /w/:slug → index.html + SSR (문서 데이터 주입)
app.get('/w/:slug', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.redirect('/login');
    }

    const slug = c.req.param('slug');
    const db = c.env.DB;
    const user = c.get('user');
    const redirectParam = c.req.query('redirect');
    const isAdmin = user && (user.role === 'admin' || user.role === 'super_admin');
    const startTime = Date.now();

    // ── 캐시 확인 (비관리자 + redirect=no가 아닌 일반 요청만) ──
    const cache = caches.default;
    // 쿼리 파라미터를 제거한 정규화된 URL을 캐시 키로 사용
    const ssrCacheUrl = new URL(c.req.url);
    ssrCacheUrl.search = '';
    const ssrCacheKey = new Request(ssrCacheUrl.toString(), { method: 'GET' });
    const canUseCache = !isAdmin && redirectParam !== 'no';

    if (canUseCache) {
        const cached = await cache.match(ssrCacheKey);
        if (cached) {
            trackPageView(c, slug, Date.now() - startTime);
            return new Response(cached.body, cached);
        }
    }

    // 1) DB에서 문서 데이터 조회
    let page = await db
        .prepare('SELECT * FROM pages WHERE slug = ?')
        .bind(slug)
        .first<Page>();

    if (page && page.deleted_at && !isAdmin) {
        // SSR에서도 삭제된 문서 처리
        const deletedSsrData: Record<string, any> = {
            _ssrSlug: slug,
            _ssrNotFound: true,
            _ssrDeleted: true,
            _ssrTitle: `삭제된 문서 - ${c.env.WIKI_NAME || 'CloudWiki'}`
        };
        // 삭제된 문서는 리다이렉트나 본문 조회를 하지 않도록 처리
        const response = await renderHtml(c, '/', deletedSsrData);
        return new Response(response.body, { status: 410, headers: response.headers });
    }

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

        if (targetPage) {
            redirectedFrom = slug;
            page = targetPage;
        }
    }

    // 문서가 없으면 리다이렉트 테이블 확인 (alias)
    if (!page) {
        const redirect = await db
            .prepare('SELECT target_page_id FROM redirects WHERE source_slug = ?')
            .bind(slug)
            .first<{ target_page_id: number }>();

        if (redirect) {
            let targetPage = await db
                .prepare('SELECT * FROM pages WHERE id = ?')
                .bind(redirect.target_page_id)
                .first<Page>();

            if (targetPage && targetPage.deleted_at && !isAdmin) {
                targetPage = null;
            }

            if (targetPage) {
                page = targetPage;
                redirectedFrom = slug;
            }
        }
    }

    // 2) SSR 데이터 구성
    let ssrData: Record<string, any> = {
        _ssrSlug: slug,
        _ssrNotFound: false,
    };

    // 캐싱 가능 여부 (공개 문서가 정상 존재하는 경우만)
    let shouldCache = canUseCache;

    if (!page) {
        ssrData._ssrNotFound = true;
        ssrData._ssrTitle = `문서 없음 - ${c.env.WIKI_NAME || 'CloudWiki'}`;
        shouldCache = false; // 미존재 문서는 캐싱하지 않음
    } else {
        // 비공개 문서 접근 제어
        if (page.is_private && !isAdmin) {
            ssrData._ssrNotFound = true;
            ssrData._ssrForbidden = true;
            ssrData._ssrTitle = `비공개 문서 - ${c.env.WIKI_NAME || 'CloudWiki'}`;
            shouldCache = false; // 비공개 문서는 캐싱하지 않음
        } else {
            // 작성자 정보
            const author = page.author_id
                ? await db.prepare('SELECT name, picture FROM users WHERE id = ?').bind(page.author_id).first()
                : null;

            // 본문 내용 기반 설명글(Description) 생성
            let desc = `${page.title} - ${c.env.WIKI_NAME || 'CloudWiki'}`;
            if (page.content) {
                const extracted = extractMetaDescription(page.content);
                if (extracted) {
                    desc = extracted;
                }
            }

            ssrData = {
                ...safeJSON({ ...page, author, redirected_from: redirectedFrom }),
                _ssrSlug: slug,
                _ssrNotFound: false,
                _ssrTitle: `${page.title} - ${c.env.WIKI_NAME || 'CloudWiki'}`,
                _ssrDescription: desc,
            };

            // 비공개 문서는 캐싱하지 않음
            if (page.is_private) shouldCache = false;
        }
    }

    // 3) HTMLRewriter로 SSR 데이터 주입 + 브랜딩 및 컴포넌트 치환
    const response = await renderHtml(c, '/', ssrData);

    // Analytics: 문서 조회 추적 (존재하는 문서만)
    if (!ssrData._ssrNotFound) {
        trackPageView(c, ssrData.slug || slug, Date.now() - startTime);
    }

    // 4) 공개 문서이면 Edge 캐시에 24시간 저장
    if (shouldCache) {
        const cachedResponse = new Response(response.body, response);
        cachedResponse.headers.set('Cache-Control', 'public, max-age=86400');
        c.executionCtx.waitUntil(cache.put(ssrCacheKey, cachedResponse.clone()));
        return cachedResponse;
    }

    return response;
});

// /login 접근 시 로그인 페이지 서빙
app.get('/login', async (c) => {
    if (c.get('user')) {
        return c.redirect('/');
    }
    return renderHtml(c, '/login.html', {
        _ssrTitle: '로그인 - ' + (c.env.WIKI_NAME || 'Cloudwiki'),
        closedWikiMessage: c.env.CLOSED_WIKI_MESSAGE || '비공개 위키입니다. 로그인 후 이용해주세요.',
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
    return renderHtml(c, '/search.html');
});

// /admin 접근 시 서버사이드 권한 체크 후 admin.html 서빙
app.get('/admin', async (c) => {
    const user = c.get('user');
    if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) {
        return c.redirect('/');
    }
    return renderHtml(c, '/admin.html');
});

// /admin-media 접근 시 서버사이드 권한 체크 후 admin-media.html 서빙
app.get('/admin-media', async (c) => {
    const user = c.get('user');
    if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) {
        return c.redirect('/');
    }
    return renderHtml(c, '/admin-media.html');
});

// /mypage 접근 시 mypage.html 서빙 (SSR 브랜딩)
app.get('/mypage', async (c) => {
    return renderHtml(c, '/mypage.html');
});

// /edit/:slug → edit.html 서빙 (SSR 브랜딩)
app.get('/edit/:slug', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.redirect('/login');
    }
    return renderHtml(c, '/edit.html');
});

// /edit → edit.html 서빙 (SSR 브랜딩)
app.get('/edit', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.redirect('/login');
    }
    return renderHtml(c, '/edit.html');
});

// /setup-profile 접근 시 서빙
app.get('/setup-profile', async (c) => {
    return renderHtml(c, '/setup-profile.html');
});

// /profile/:id 접근 시 user-profile.html 서빙 (SSR 브랜딩)
app.get('/profile/:id', async (c) => {
    return renderHtml(c, '/user-profile.html');
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

    const { results: pages } = await db
        .prepare('SELECT slug, updated_at FROM pages WHERE deleted_at IS NULL AND is_private = 0 AND redirect_to IS NULL')
        .all<{ slug: string; updated_at: number }>();

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
    }
};
