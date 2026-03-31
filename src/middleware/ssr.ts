import { Context, Next } from 'hono';
import { Env } from '../types';
import { escapeHtml } from '../utils/html';

/**
 * 위키 문서 내용에서 SEO 메타 설명을 추출합니다.
 * 1. 위키 특수문법 제거 (aiParser.ts 참고)
 * 2. 첫 문단(빈 줄로 구분) 우선 추출
 * 3. 문단 구조 없으면 처음부터 추출
 */
export function extractMetaDescription(content: string, maxLength = 160): string {
    if (!content) return '';

    let processed = content
        // 펜스 코드블럭 제거
        .replace(/```[\s\S]*?```/g, '')
        // 인라인 코드 제거
        .replace(/`[^`\n]+`/g, '')
        // {{틀 트랜스클루전}} 제거
        .replace(/\{\{[^{}]+?\}\}/g, '')
        // {<}, {>}, {^}, {><} 표 병합 문법 제거
        .replace(/\{[<>^]{1,2}\}/g, '')
        // {#color}, {mdi icon} 등 색상/아이콘 문법 제거
        .replace(/\{[^{}]*\}/g, '')
        // [+접기 제목], [-] 접기 문법 제거
        .replace(/\[\+[^\]]*\]/g, '')
        .replace(/\[-\]/g, '')
        // [[링크|표시텍스트]] -> 표시텍스트
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
        // [[링크]] -> 링크텍스트
        .replace(/\[\[([^\]]+)\]\]/g, '$1')
        // 마크다운 이미지 ![alt](url) 제거
        .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
        // 마크다운 링크 [text](url) -> text
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        // HTML 태그 제거 (태그명이 알파벳으로 시작하는 실제 태그만 제거, 부등호/제네릭 문법 보존)
        .replace(/<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?\/?>/g, '')
        // 마크다운 볼드/이탤릭 (***, **, *, ___, __, _)
        .replace(/(\*{1,3}|_{1,3})([^*_\n]+)\1/g, '$2')
        // 마크다운 취소선 ~~text~~
        .replace(/~~([^~\n]+)~~/g, '$1')
        // 수평선 제거 (--- 또는 === 만 있는 줄)
        .replace(/^[-=]{2,}\s*$/gm, '');

    // 빈 줄로 구분된 문단 블록 추출
    const paragraphs = processed.split(/\n{2,}/);
    let firstParagraph = '';

    for (const para of paragraphs) {
        const trimmed = para.trim();
        if (!trimmed) continue;

        // 블록 내 각 줄에서 구조적 줄(헤딩, 인용, 표 구분선)을 제거한 뒤 남은 텍스트를 확인
        const contentLines = trimmed.split('\n').filter(line => {
            const l = line.trim();
            if (!l) return false;
            if (/^#{1,6}\s/.test(l)) return false;   // 헤딩 줄
            if (/^[|\-:\s]+$/.test(l)) return false;  // 표 구분선/구조 줄
            return true;
        });

        if (contentLines.length === 0) continue;

        // 인용(>) 접두사 제거 후 텍스트 추출
        firstParagraph = contentLines
            .map(l => l.replace(/^>\s*/, ''))
            .join('\n');
        break;
    }

    // 첫 문단이 없으면 전체 텍스트 사용
    if (!firstParagraph) {
        firstParagraph = processed.trim();
    }

    // 리스트 기호(-/*/+/숫자.) 줄 접두사 제거 (헤딩/인용은 이미 위에서 처리됨)
    const plainText = firstParagraph
        .replace(/^[-*+]\s+/gm, '')
        .replace(/^\d+\.\s+/gm, '')
        .replace(/\n/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();

    if (!plainText) return '';

    return plainText.length > maxLength ? plainText.substring(0, maxLength) + '...' : plainText;
}

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
