import { Hono, Context } from 'hono';
import { csrf } from 'hono/csrf';
import { secureHeaders } from 'hono/secure-headers';
import type { Env, Page } from './types';
import { sessionMiddleware } from './middleware/session';
import { rateLimitMiddleware } from './middleware/rateLimit';
import { applyPageSSR } from './middleware/ssr';
import { safeJSON } from './utils/json';
import authRoutes from './routes/auth';
import wikiRoutes from './routes/wiki';
import searchRoutes from './routes/search';
import mediaRoutes from './routes/media';
import adminRoutes from './routes/admin';
import discussionRoutes from './routes/discussion';
import notificationRoutes from './routes/notification';
import mcpRoutes from './routes/mcp';

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

// 레이트 리밋 미들웨어 (일반 사용자의 과도한 요청 제한)
app.use('*', rateLimitMiddleware);

// ── 라우트 등록 ──
app.route('/', authRoutes);
app.route('/api', wikiRoutes);
app.route('/api', searchRoutes);
app.route('/', mediaRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api', discussionRoutes);
app.route('/api', notificationRoutes);
app.route('/api/mcp', mcpRoutes);

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

// ── 헬퍼: HTML 특수문자 이스케이프 (서버사이드) ──
function escapeHtml(str: string | undefined | null): string {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ── 헬퍼: 사이드바/푸터 URL 안전성 검사 (javascript: 스킴 차단) ──
function sanitizeSidebarUrl(url: string | undefined | null): string {
    if (!url) return '#';
    if (/^javascript:/i.test(url.trim())) return '#';
    return escapeHtml(url);
}

// ── 헬퍼: 공통 컴포넌트를 주입하여 HTML 렌더링 ──
async function renderHtml(c: Context<Env>, targetHtmlPath: string, pageData: Record<string, any> = {}): Promise<Response> {
    const htmlResponse = await fetchAssetHtml(c, targetHtmlPath);

    const wikiName = c.env.WIKI_NAME || 'CloudWiki';
    const wikiLogoUrl = c.env.WIKI_LOGO_URL || '';
    const wikiFaviconUrl = c.env.WIKI_FAVICON_URL || '/favicon.ico';

    let customSidebarHtml = '';
    try {
        const configStr = await c.env.KV.get('sidebar_config');
        if (configStr) {
            const config = JSON.parse(configStr);
            if (Array.isArray(config)) {
                for (const item of config) {
                    if (item.type === 'header') {
                        customSidebarHtml += `<li class="nav-item mt-3 mb-1 px-3 fw-bold text-muted small">${escapeHtml(item.text)}</li>`;
                    } else if (item.type === 'link') {
                        const iconHtml = item.icon ? `<i class="${escapeHtml(item.icon)} me-2"></i>` : '';
                        const safeUrl = sanitizeSidebarUrl(item.url);
                        const target = item.url?.startsWith('/') ? '' : ' target="_blank" rel="noopener noreferrer"';
                        customSidebarHtml += `<li class="nav-item mb-1"><a class="nav-link px-3 py-2 rounded text-dark" href="${safeUrl}"${target}>${iconHtml}${escapeHtml(item.text)}</a></li>`;
                    } else if (item.type === 'text') {
                        const iconHtml = item.icon ? `<i class="${escapeHtml(item.icon)} me-2"></i>` : '';
                        customSidebarHtml += `<li class="nav-item mb-1 px-3 py-2 text-body small">${iconHtml}${escapeHtml(item.text)}</li>`;
                    } else if (item.type === 'divider') {
                        customSidebarHtml += `<li><hr class="w-100 my-2" style="border-color: var(--wiki-border); opacity: 1;"></li>`;
                    }
                }
            }
        }
    } catch (e) {
        console.error('Failed to load sidebar config:', e);
    }

    let customFooterHtml = '';
    try {
        const footerConfigStr = await c.env.KV.get('footer_config');
        if (footerConfigStr) {
            const footerConfig = JSON.parse(footerConfigStr);
            if (Array.isArray(footerConfig)) {
                for (const item of footerConfig) {
                    if (item.type === 'link') {
                        const iconHtml = item.icon ? `<i class="${escapeHtml(item.icon)} me-1"></i>` : '';
                        const safeUrl = sanitizeSidebarUrl(item.url);
                        const target = item.url?.startsWith('/') ? '' : ' target="_blank" rel="noopener noreferrer"';
                        customFooterHtml += `<a class="footer-link" href="${safeUrl}"${target}>${iconHtml}${escapeHtml(item.text)}</a>`;
                    } else if (item.type === 'text') {
                        const iconHtml = item.icon ? `<i class="${escapeHtml(item.icon)} me-1"></i>` : '';
                        customFooterHtml += `<span class="footer-text">${iconHtml}${escapeHtml(item.text)}</span>`;
                    } else if (item.type === 'divider') {
                        customFooterHtml += `<span class="footer-divider">|</span>`;
                    }
                }
            }
        }
    } catch (e) {
        console.error('Failed to load footer config:', e);
    }

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

    // Header, Sidebar, Footer HTML 로드 및 브랜딩 적용
    let headerHtml = '';
    let sidebarHtml = '';
    let footerHtml = '';

    try {
        const headerRes = await fetchAssetHtml(c, '/components/header.html');
        if (headerRes.ok) headerHtml = await getRewriter().transform(headerRes).text();
    } catch (e) {
        console.error('Failed to load header component:', e);
    }

    try {
        const sidebarRes = await fetchAssetHtml(c, '/components/sidebar.html');
        if (sidebarRes.ok) sidebarHtml = await getRewriter().transform(sidebarRes).text();
    } catch (e) {
        console.error('Failed to load sidebar component:', e);
    }

    try {
        const footerRes = await fetchAssetHtml(c, '/components/footer.html');
        if (footerRes.ok) footerHtml = await getRewriter().transform(footerRes).text();
    } catch (e) {
        console.error('Failed to load footer component:', e);
    }

    return applyPageSSR(htmlResponse, pageData, {
        WIKI_NAME: wikiName,
        WIKI_LOGO_URL: wikiLogoUrl,
        WIKI_FAVICON_URL: wikiFaviconUrl,
        CUSTOM_HEADER: c.env.CUSTOM_HEADER || '',
    }, headerHtml, sidebarHtml, footerHtml);
}

// ── 프론트엔드 라우팅 ──

// /wiki/:slug/discussions/* → discussions.html 서빙 (SSR 브랜딩 적용)
app.get('/wiki/:slug/discussions/:id', async (c) => {
    return renderHtml(c, '/discussions.html');
});

app.get('/wiki/:slug/discussions', async (c) => {
    return renderHtml(c, '/discussions.html');
});

// /wiki/:slug/revisions → revisions.html 서빙 (SSR 브랜딩 적용)
app.get('/wiki/:slug/revisions', async (c) => {
    return renderHtml(c, '/revisions.html');
});

// /wiki/:slug → index.html + SSR (문서 데이터 주입)
app.get('/wiki/:slug', async (c) => {
    const slug = c.req.param('slug');
    const db = c.env.DB;
    const user = c.get('user');
    const redirectParam = c.req.query('redirect');

    // 1) DB에서 문서 데이터 조회
    let page = await db
        .prepare('SELECT * FROM pages WHERE slug = ?')
        .bind(slug)
        .first<Page>();

    // 관리자가 아닌데 삭제된 문서라면 문서가 없는 것으로 처리
    const isAdmin = user && (user.role === 'admin' || user.role === 'super_admin');
    if (page && page.deleted_at && !isAdmin) {
        page = null;
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

    if (!page) {
        ssrData._ssrNotFound = true;
        ssrData._ssrTitle = `문서 없음 - ${c.env.WIKI_NAME || 'CloudWiki'}`;
    } else {
        // 비공개 문서 접근 제어
        if (page.is_private && !isAdmin) {
            ssrData._ssrNotFound = true;
            ssrData._ssrForbidden = true;
            ssrData._ssrTitle = `비공개 문서 - ${c.env.WIKI_NAME || 'CloudWiki'}`;
        } else {
            // 작성자 정보
            const author = page.author_id
                ? await db.prepare('SELECT name, picture FROM users WHERE id = ?').bind(page.author_id).first()
                : null;

            // 본문 내용 기반 설명글(Description) 생성 (마크다운 태그, 특수문자 기본 제거)
            let desc = `${page.title} - ${c.env.WIKI_NAME || 'CloudWiki'}`;
            if (page.content) {
                let plainText = page.content
                    .replace(/\[\+.*?\]/g, '')     // 접기 문법 태그 제거
                    .replace(/\[-\]/g, '')         // 접기 종료 문법 제거
                    .replace(/\[\[.*?\]\]/g, (match) => match.replace(/[\[\]]/g, '')) // 위키 링크를 일반 텍스트로
                    .replace(/```[\s\S]*?```/g, '') // 코드 블록 제거
                    .replace(/[#>*\-_~=`]+/g, '')  // 마크다운 특수기호 제거
                    .replace(/\n/g, ' ')           // 줄바꿈을 공백으로
                    .replace(/\s{2,}/g, ' ')       // 연속된 공백 줄이기
                    .trim();

                if (plainText.length > 0) {
                    desc = plainText.length > 150 ? plainText.substring(0, 150) + '...' : plainText;
                }
            }

            ssrData = {
                ...safeJSON({ ...page, author, redirected_from: redirectedFrom }),
                _ssrSlug: slug,
                _ssrNotFound: false,
                _ssrTitle: `${page.title} - ${c.env.WIKI_NAME || 'CloudWiki'}`,
                _ssrDescription: desc,
            };
        }
    }

    // 3) HTMLRewriter로 SSR 데이터 주입 + 브랜딩 및 컴포넌트 치환
    return renderHtml(c, '/', ssrData);
});

// / (루트) 접근 시 index.html 서빙 (SSR 브랜딩 적용)
app.get('/', async (c) => {
    return renderHtml(c, '/');
});

// /search 접근 시 search.html 서빙 (SSR 브랜딩 적용)
app.get('/search', async (c) => {
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
        xml += `    <loc>${baseUrl}/wiki/${encodeURIComponent(page.slug)}</loc>\n`;
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
    const baseUrl = new URL(c.req.url).origin;

    const robotsTxt = [
        'User-agent: Googlebot',
        'Allow: /',
        '',
        'User-agent: ClaudeBot',
        'Allow: /',
        '',
        'User-agent: GPTBot',
        'Allow: /',
        '',
        'User-agent: Grok',
        'Allow: /',
        '',
        'User-agent: *',
        'Disallow: /',
        '',
        `Sitemap: ${baseUrl}/sitemap.xml`,
    ].join('\n');

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
