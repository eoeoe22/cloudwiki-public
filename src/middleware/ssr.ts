import { Context, Next } from 'hono';
import { Env } from '../types';
import { escapeHtml } from '../utils/html';

/**
 * SSR 미들웨어: HTML 응답에 위키 브랜딩(이름, 로고, 파비콘) 치환
 */
export const ssrMiddleware = async (c: Context<Env>, next: Next) => {
    await next();

    const res = c.res;
    const contentType = res.headers.get('Content-Type') || '';

    // HTML 응답에만 SSR(브랜딩 치환) 적용
    if (contentType.includes('text/html')) {
        const wikiName = c.env?.WIKI_NAME || 'CloudWiki';
        const wikiLogoUrl = c.env?.WIKI_LOGO_URL || '';
        const wikiFaviconUrl = c.env?.WIKI_FAVICON_URL || '/favicon.ico';

        const rewriter = new HTMLRewriter()
            .on('.app-wiki-name', {
                text(text) {
                    // 내부 텍스트에 CloudWiki 또는 Cloudwiki가 포함되어 있으면 환경변수로 교체
                    if (text.text.includes('CloudWiki')) {
                        text.replace(text.text.replace('CloudWiki', wikiName));
                    } else if (text.text.includes('Cloudwiki')) {
                        text.replace(text.text.replace('Cloudwiki', wikiName));
                    }
                }
            })
            .on('#wiki-favicon', {
                element(element) {
                    if (wikiFaviconUrl) {
                        element.setAttribute('href', wikiFaviconUrl);
                    }
                }
            })
            .on('.wiki-logo-container', {
                element(element) {
                    if (wikiLogoUrl) {
                        element.setInnerContent(`<img src="${escapeHtml(wikiLogoUrl)}" alt="Logo" class="brand-logo" style="height: 32px; vertical-align: middle; margin-right: 8px;">`, { html: true });
                    }
                }
            });

        if (c.env?.CUSTOM_HEADER) {
            rewriter.on('body', {
                element(element) {
                    element.append(c.env.CUSTOM_HEADER as string, { html: true });
                }
            });
        }

        // HTMLRewriter.transform()은 기존 헤더(Set-Cookie 등)를 유지하는 새 Response 객체를 반환함
        c.res = rewriter.transform(res);
    }
};

/**
 * 위키 문서 페이지 전용 SSR: 문서 데이터를 HTML에 인라인 주입
 * index.html의 <script id="ssr-data"> 에 JSON으로 주입하여
 * 클라이언트에서 추가 API 호출 없이 즉시 렌더링 가능
 */
export function applyPageSSR(response: Response, pageData: Record<string, any>, env: { WIKI_NAME?: string; WIKI_LOGO_URL?: string; WIKI_FAVICON_URL?: string; CUSTOM_HEADER?: string }, headerHtml: string = '', sidebarHtml: string = '', footerHtml: string = ''): Response {
    const wikiName = env.WIKI_NAME || 'CloudWiki';
    const wikiLogoUrl = env.WIKI_LOGO_URL || '';
    const wikiFaviconUrl = env.WIKI_FAVICON_URL || '/favicon.ico';
    const customHeader = env.CUSTOM_HEADER || '';

    // JSON을 HTML 내에 안전하게 삽입 (script 태그 내 특수문자 및 줄바꿈 이스케이프)
    const jsonStr = JSON.stringify(pageData)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');

    const rewriter = new HTMLRewriter()
        .on('.app-wiki-name', {
            text(text) {
                if (text.text.includes('CloudWiki')) {
                    text.replace(text.text.replace('CloudWiki', wikiName));
                } else if (text.text.includes('Cloudwiki')) {
                    text.replace(text.text.replace('Cloudwiki', wikiName));
                }
            }
        })
        .on('#wiki-favicon', {
            element(element) {
                if (wikiFaviconUrl) {
                    element.setAttribute('href', wikiFaviconUrl);
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
        .on('title.app-wiki-name', {
            text(text) {
                // <title> 태그의 텍스트를 문서 제목으로 교체
                if (pageData._ssrTitle && text.text.includes(wikiName)) {
                    text.replace(pageData._ssrTitle);
                }
            }
        })
        .on('meta[name="description"]', {
            element(element) {
                element.setAttribute('content', pageData._ssrDescription || wikiName);
            }
        })
        .on('meta[property="og:description"]', {
            element(element) {
                element.setAttribute('content', pageData._ssrDescription || wikiName);
            }
        })
        .on('meta[property="og:title"]', {
            element(element) {
                element.setAttribute('content', pageData._ssrTitle || wikiName);
            }
        })
        .on('meta[property="og:site_name"]', {
            element(element) {
                if (wikiName) {
                    element.setAttribute('content', wikiName);
                }
            }
        })
        .on('head', {
            element(element) {
                // SSR 데이터를 head 끝에 주입
                element.append(`<script id="ssr-data" type="application/json">${jsonStr}</script>`, { html: true });
            }
        })
        .on('body', {
            element(element) {
                // 커스텀 헤더 주입 (body 끝에 삽입하여 페이지 라이브러리 사용 가능)
                if (customHeader) {
                    element.append(customHeader, { html: true });
                }
            }
        })
        .on('#app-header-placeholder', {
            element(element) {
                if (headerHtml) {
                    element.replace(headerHtml, { html: true });
                }
            }
        })
        .on('#app-sidebar-placeholder', {
            element(element) {
                if (sidebarHtml) {
                    element.replace(sidebarHtml, { html: true });
                }
            }
        })
        .on('#app-footer-placeholder', {
            element(element) {
                if (footerHtml) {
                    element.replace(footerHtml, { html: true });
                }
            }
        });

    return rewriter.transform(response);
}
