// 외부 CDN 라이브러리 버전·URL 단일 소스.
// 서버(src/middleware/ssr.ts)와 클라이언트(src/client/render.ts, iconLib.ts) 양쪽에서 참조한다.
const J = 'https://cdn.jsdelivr.net/npm';
const C = 'https://cdnjs.cloudflare.com/ajax/libs';
const E = 'https://esm.sh';

export const CDN_VERSIONS = {
    bootstrap:        '5.3.3',
    bootstrapIcons:   '1.13.1',
    mdiFont:          '7.4.47',
    sweetalert2:      '11.26.24',
    marked:           '18.0.3',
    dompurify:        '3.4.2',
    jsdiff:           '5.1.0',
    prism:            '1.29.0',
    mermaid:          '11.15.0',
    // CodeMirror / Lezer (esm.sh importmap)
    cmState:          '6.6.0',
    cmView:           '6.41.1',
    cmCommands:       '6.10.3',
    cmLanguage:       '6.12.3',
    cmLangMarkdown:   '6.5.0',
    cmLanguageData:   '6.5.2',
    cmThemeOneDark:   '6.1.3',
    cmSearch:         '6.7.0',
    lezerHighlight:   '1.2.3',
} as const;

export const CDN_URLS = {
    bootstrapCss:         `${J}/bootstrap@${CDN_VERSIONS.bootstrap}/dist/css/bootstrap.min.css`,
    bootstrapJs:          `${J}/bootstrap@${CDN_VERSIONS.bootstrap}/dist/js/bootstrap.bundle.min.js`,
    bootstrapIcons:       `${J}/bootstrap-icons@${CDN_VERSIONS.bootstrapIcons}/font/bootstrap-icons.min.css`,
    bootstrapIconsJson:   `${J}/bootstrap-icons@${CDN_VERSIONS.bootstrapIcons}/font/bootstrap-icons.json`,
    mdiCss:               `${J}/@mdi/font@${CDN_VERSIONS.mdiFont}/css/materialdesignicons.min.css`,
    sweetalert2Css:       `${J}/sweetalert2@${CDN_VERSIONS.sweetalert2}/dist/sweetalert2.min.css`,
    sweetalert2Js:        `${J}/sweetalert2@${CDN_VERSIONS.sweetalert2}`,
    markedJs:             `${J}/marked@${CDN_VERSIONS.marked}/lib/marked.umd.js`,
    dompurifyJs:          `${J}/dompurify@${CDN_VERSIONS.dompurify}/dist/purify.min.js`,
    jsdiffJs:             `${C}/jsdiff/${CDN_VERSIONS.jsdiff}/diff.min.js`,
    turnstileJs:          'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad',
    prismCore:            `${C}/prism/${CDN_VERSIONS.prism}/components/prism-core.min.js`,
    prismAutoloader:      `${C}/prism/${CDN_VERSIONS.prism}/plugins/autoloader/prism-autoloader.min.js`,
    prismComponentsBase:  `${C}/prism/${CDN_VERSIONS.prism}/components/`,
    // Mermaid 는 번들/번들맵에 넣지 않고 render.ts 에서 다이어그램 블록이 있을 때만
    // 동적 import() 로 지연 로드한다(다이어그램 없는 문서는 비용 0).
    // ⚠ esm.sh 의 `/mermaid` 기본 진입점은 package exports 의 `mermaid.core.mjs` 로 해석되는데,
    // 이 빌드는 d3·dompurify·stylis·es-toolkit·ts-dedent 등을 bare import 로 외부화한다.
    // esm.sh 는 그 의존성들을 각각 별도 URL 로 서빙하고 d3 등은 다시 수십 개의 하위 패키지로
    // 전개되므로, 다이어그램 1개를 그리려고 수백 건의 네트워크 요청 워터폴이 발생해 로딩이
    // 매우 느렸다. 대신 mermaid 가 공식 권장하는 **사전 번들된** 브라우저 ESM 빌드
    // (`dist/mermaid.esm.min.mjs`)를 jsdelivr 에서 직접 로드한다 — 모든 의존성이 동일 CDN 의
    // 인접 청크로 번들돼 있어(앞단 8개 정적 + 나머지는 다이어그램 종류별 지연 로드) 요청 수가
    // 적고 워터폴이 사라진다. 상대 경로 청크는 이 URL 기준으로 해석된다.
    mermaidEsm:           `${J}/mermaid@${CDN_VERSIONS.mermaid}/dist/mermaid.esm.min.mjs`,
} as const;

export const FONTS = {
    preconnect: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'] as const,
    // 모든 페이지 공통: Inter + Outfit + Noto Sans KR + Noto Serif KR 슈퍼셋
    // (Noto Serif KR 은 세리프 계열 테마/스킨용 — 예: '문헌(reader)' 스킨의 본문 글꼴)
    ui:   'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Outfit:wght@500;600;700;800;900&family=Noto+Sans+KR:wght@300;400;500;600;700;800;900&family=Noto+Serif+KR:wght@400;500;600;700&display=swap',
    // 코드블럭 전용 폰트 (render.ts에서 동적 주입)
    code: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Nanum+Gothic+Coding:wght@400;700&display=swap',
} as const;

// CodeMirror 6 + Lezer importmap (슈퍼셋 — 9개 항목, 모든 에디터 페이지에서 공유)
export const CODEMIRROR_IMPORTMAP: Record<string, string> = {
    '@codemirror/state':          `${E}/@codemirror/state@${CDN_VERSIONS.cmState}`,
    '@codemirror/view':           `${E}/@codemirror/view@${CDN_VERSIONS.cmView}`,
    '@codemirror/commands':       `${E}/@codemirror/commands@${CDN_VERSIONS.cmCommands}`,
    '@codemirror/language':       `${E}/@codemirror/language@${CDN_VERSIONS.cmLanguage}`,
    '@codemirror/lang-markdown':  `${E}/@codemirror/lang-markdown@${CDN_VERSIONS.cmLangMarkdown}`,
    '@codemirror/language-data':  `${E}/@codemirror/language-data@${CDN_VERSIONS.cmLanguageData}`,
    '@codemirror/theme-one-dark': `${E}/@codemirror/theme-one-dark@${CDN_VERSIONS.cmThemeOneDark}`,
    '@codemirror/search':         `${E}/@codemirror/search@${CDN_VERSIONS.cmSearch}`,
    '@lezer/highlight':           `${E}/@lezer/highlight@${CDN_VERSIONS.lezerHighlight}`,
};

export type BundleName = 'base' | 'markdown' | 'editor' | 'turnstile' | 'diff';

// 페이지별 번들 맵 (key = fetchAssetHtml에 전달되는 경로)
export const PAGE_BUNDLES: Record<string, BundleName[]> = {
    '/index.html':          ['base', 'markdown'],
    '/blog.html':           ['base', 'markdown'],
    '/mypage.html':         ['base', 'markdown'],
    '/revisions.html':      ['base', 'markdown'],
    '/discussions.html':    ['base', 'markdown', 'editor'],
    '/tickets.html':        ['base', 'markdown', 'editor'],
    '/edit.html':           ['base', 'markdown', 'editor', 'turnstile', 'diff'],
    '/blog-edit.html':      ['base', 'markdown', 'editor', 'turnstile'],
    '/admin.html':          ['base'],
    '/admin-media.html':    ['base'],
    '/admin-bulk-manage.html': ['base'],
    '/explore.html':        ['base'],
    '/search.html':         ['base'],
    '/setup-profile.html':  ['base'],
    '/user-profile.html':   ['base'],
    '/login.html':          ['base'],
    '/error.html':          ['base'],
    // 개인 워크스페이스
    '/workspaces.html':     ['base'],
    '/ws-dashboard.html':   ['base', 'markdown'],
    '/ws-todo.html':        ['base'],
    '/ws-settings.html':    ['base'],
    '/ws-files.html':       ['base'],
    '/ws-media.html':       ['base'],
    '/ws-doc.html':         ['base', 'markdown'],
    '/ws-edit.html':        ['base', 'markdown', 'editor'],
    '/ws-revisions.html':   ['base', 'markdown'],
};

/**
 * SSR 시 <head>에 주입할 태그를 반환한다.
 * - prepend: CSS/폰트. 로컬 스타일시트보다 먼저 로드돼야 로컬 CSS가 Bootstrap을
 *   정상 덮어쓴다(캐스케이드 순서). HTMLRewriter로 <head> 맨 앞에 주입한다.
 * - append: importmap / Turnstile 스크립트. <head> 끝에 주입한다. 특히 Turnstile
 *   api.js(?onload=onTurnstileLoad)는 onTurnstileLoad stub 인라인 스크립트 뒤에 와야
 *   콜백 정의 전 실행되는 레이스를 피한다.
 */
export function renderHeadTags(bundles: BundleName[]): { prepend: string; append: string } {
    const set = new Set(bundles);
    let prepend = '';
    let append = '';

    if (set.has('base')) {
        prepend += `<link rel="preconnect" href="${FONTS.preconnect[0]}">`;
        prepend += `<link rel="preconnect" href="${FONTS.preconnect[1]}" crossorigin>`;
        prepend += `<link rel="stylesheet" href="${FONTS.ui}">`;
        prepend += `<link rel="stylesheet" href="${CDN_URLS.bootstrapCss}">`;
        prepend += `<link rel="stylesheet" href="${CDN_URLS.bootstrapIcons}">`;
        prepend += `<link rel="stylesheet" href="${CDN_URLS.mdiCss}">`;
        prepend += `<link rel="stylesheet" href="${CDN_URLS.sweetalert2Css}">`;
    }

    if (set.has('editor')) {
        const importmap = JSON.stringify({ imports: CODEMIRROR_IMPORTMAP });
        append += `<script type="importmap">${importmap}</script>`;
    }

    if (set.has('turnstile')) {
        append += `<script src="${CDN_URLS.turnstileJs}" async defer></script>`;
    }

    return { prepend, append };
}

/** SSR 시 </body> 직전에 주입할 스크립트 태그 문자열을 반환한다. */
export function renderBodyScripts(bundles: BundleName[]): string {
    const set = new Set(bundles);
    let html = '';

    if (set.has('base')) {
        html += `<script src="${CDN_URLS.bootstrapJs}"></script>`;
        html += `<script src="${CDN_URLS.sweetalert2Js}"></script>`;
    }

    if (set.has('markdown')) {
        html += `<script src="${CDN_URLS.markedJs}"></script>`;
        html += `<script src="${CDN_URLS.dompurifyJs}"></script>`;
    }

    if (set.has('diff')) {
        html += `<script src="${CDN_URLS.jsdiffJs}"></script>`;
    }

    return html;
}
