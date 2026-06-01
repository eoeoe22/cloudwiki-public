// 빌드 타임 브랜딩 베이킹 유틸리티 (Astro 정적 셸 전용).
//
// 이 모듈은 `astro build` 의 컴포넌트/레이아웃 프런트매터에서만 import 된다.
// tsconfig(server/client) 의 include 밖(plain .mjs)에 두어 Worker/클라이언트 타입체크와
// 분리하고, node:fs 로 wrangler.toml 을 직접 읽는다.
//
// 주의: escapeHtml / sanitizeUrl / buildCustomSidebarHtml / buildCustomFooterHtml 은
// 런타임(src/utils/html.ts, src/index.ts) 의 동일 로직을 빌드 측에서 미러한 것이다.
// 마커 치환 규약을 바꿀 때는 양쪽을 함께 수정한다.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Astro 빌드 시 이 모듈은 .astro-dist/.prerender/chunks/* 로 번들되므로 import.meta.url 기반
// 상대경로가 깨진다. astro build 는 항상 레포 루트(npm 스크립트 실행 위치)에서 돌므로
// process.cwd() 를 기준으로 wrangler.toml 을 찾는다.
const WRANGLER_TOML = resolve(process.cwd(), 'wrangler.toml');

/** HTML 특수문자 이스케이프 (src/utils/html.ts 미러) */
export function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/** URL 안전성 검사 (src/utils/html.ts 미러) */
export function sanitizeUrl(url) {
    if (!url) return '#';
    const trimmed = String(url).trim();
    if (!trimmed) return '#';

    if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
        return escapeHtml(trimmed);
    }

    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            return escapeHtml(trimmed);
        }
    } catch {
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(trimmed)) {
            return '#';
        }
        return escapeHtml(trimmed);
    }

    return '#';
}

/** 커스텀 사이드바 항목 HTML 생성 (src/index.ts buildCustomSidebarHtml 미러) */
export function buildCustomSidebarHtml(configStr) {
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

/** 커스텀 푸터 항목 HTML 생성 (src/index.ts buildCustomFooterHtml 미러) */
export function buildCustomFooterHtml(configStr) {
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

// ── wrangler.toml 브랜딩 변수 파싱 ──
function readSingle(toml, key, fallback) {
    const m = toml.match(new RegExp(`^${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm'));
    return m ? m[1] : fallback;
}

function readTriple(toml, key) {
    const m = toml.match(new RegExp(`^${key}\\s*=\\s*"""([\\s\\S]*?)"""`, 'm'));
    return m ? m[1].trim() : '';
}

let _cached = null;

/**
 * wrangler.toml 에서 빌드 타임에 베이킹할 브랜딩 값을 읽는다.
 * 한 빌드 프로세스 내에서 캐시한다.
 */
export function readBranding() {
    if (_cached) return _cached;
    const toml = readFileSync(WRANGLER_TOML, 'utf8');
    const layoutModeRaw = readSingle(toml, 'LAYOUT_MODE', 'default');
    const layoutMode = (layoutModeRaw === 'left-toc' || layoutModeRaw === 'right-toc' || layoutModeRaw === 'docs' || layoutModeRaw === 'wide') ? layoutModeRaw : 'default';
    _cached = {
        wikiName: readSingle(toml, 'WIKI_NAME', 'CloudWiki'),
        wikiLogoUrl: readSingle(toml, 'WIKI_LOGO_URL', ''),
        wikiFaviconUrl: readSingle(toml, 'WIKI_FAVICON_URL', '/favicon.ico'),
        layoutMode,
        customHeader: readTriple(toml, 'CUSTOM_HEADER'),
        sidebarHtml: buildCustomSidebarHtml(readTriple(toml, 'SIDEBAR') || null),
        footerHtml: buildCustomFooterHtml(readTriple(toml, 'FOOTER') || null),
        // edit.astro 가 #ssr-data 로 베이킹하는 문법 가이드 문서 슬러그(배포타임 고정값).
        wikiSyntax: readSingle(toml, 'WIKI_SYNTAX', ''),
    };
    return _cached;
}

// ── 컴포넌트/셸 HTML 마커 베이킹 ──

const LOGO_IMG = (logoUrl) =>
    `<img src="${escapeHtml(logoUrl)}" alt="Logo" class="brand-logo" style="height: 32px; vertical-align: middle; margin-right: 8px;">`;

/**
 * 컴포넌트/페이지 HTML 의 브랜딩 마커를 빌드 타임에 실제 값으로 치환한다.
 * 런타임 HTMLRewriter(src/middleware/ssr.ts, src/index.ts getRewriter)와 동일한 결과를 만든다.
 *
 * 치환 대상:
 *  - `.app-wiki-name` 요소의 내부 텍스트 CloudWiki/Cloudwiki → wikiName
 *  - `.wiki-logo-container` 요소(span/div)의 내부 → <img> (wikiLogoUrl 있을 때)
 *  - `#custom-sidebar-content` → 빌드된 사이드바 항목 HTML (없으면 마커 제거)
 *  - `#custom-footer-content` 내부 → 빌드된 푸터 항목 HTML (없으면 마커 제거)
 */
export function bakeComponentBranding(html, branding) {
    const { wikiName, wikiLogoUrl, sidebarHtml = '', footerHtml = '' } = branding;
    let out = html;

    // .app-wiki-name 내부 텍스트 치환 (단일 텍스트 노드 가정 — 컴포넌트 마크업이 통제됨)
    out = out.replace(
        /(<[a-z0-9]+[^>]*\bclass="[^"]*\bapp-wiki-name\b[^"]*"[^>]*>)([^<]*)(<\/[a-z0-9]+>)/gi,
        (_m, open, inner, close) => {
            const baked = inner.replace(/CloudWiki/g, wikiName).replace(/Cloudwiki/g, wikiName);
            return `${open}${baked}${close}`;
        }
    );

    // .wiki-logo-container 내부를 <img> 로 치환 (로고 URL 이 있을 때만)
    if (wikiLogoUrl) {
        out = out.replace(
            /(<(span|div)[^>]*\bclass="[^"]*\bwiki-logo-container\b[^"]*"[^>]*>)([\s\S]*?)(<\/\2>)/gi,
            (_m, open, _tag, _inner, close) => `${open}${LOGO_IMG(wikiLogoUrl)}${close}`
        );
    }

    // #custom-sidebar-content → 사이드바 항목 (마커 요소 전체를 항목으로 치환, 없으면 제거)
    out = out.replace(
        /<div[^>]*\bid="custom-sidebar-content"[^>]*>[\s\S]*?<\/div>/i,
        sidebarHtml || ''
    );

    // #custom-footer-content 내부 → 푸터 항목 (없으면 마커 요소 제거)
    if (footerHtml) {
        out = out.replace(
            /(<div[^>]*\bid="custom-footer-content"[^>]*>)([\s\S]*?)(<\/div>)/i,
            (_m, open, _inner, close) => `${open}${footerHtml}${close}`
        );
    } else {
        out = out.replace(
            /<div[^>]*\bid="custom-footer-content"[^>]*>[\s\S]*?<\/div>/i,
            ''
        );
    }

    return out;
}
