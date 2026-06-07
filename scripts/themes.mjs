// 빌드 타임 컬러 테마(스킨) 레지스트리 (Astro 정적 셸 전용).
//
// 모델: `public/css/style.css` 의 `:root` 가 **기본(default) 테마**이자 모든 색 토큰의
// 베이스 레이어다. 이 모듈은 그 위에 얹는 **교체 가능한 스킨**들을 정의하고,
// `wrangler.toml` 의 `WIKI_THEME` 가 가리키는 스킨을 빌드 타임에 CSS 로 직렬화한다.
// `BaseLayout.astro` 가 그 CSS 를 `/css/style.css` 링크 **뒤** 의 인라인 `<style>` 로
// 베이킹하므로(캐스케이드상 나중 선언이 우세), 스킨이 베이스 토큰을 덮어쓴다.
//
//   WIKI_THEME="default"  → 아무 것도 베이킹하지 않음(= style.css 그대로, 무변화).
//   WIKI_THEME="<skin>"   → 해당 스킨의 토큰 오버라이드를 :root(및 다크 선택자)에 주입.
//
// 새 테마 추가 = 이 파일 `THEMES` 에 항목 하나 추가(아래 템플릿 참고) + wrangler.toml
// `WIKI_THEME` 변경. 다른 파일 수정 불필요(모듈식 확장점).
//
// branding.mjs 와 마찬가지로 tsconfig include 밖의 plain .mjs 라 Worker/클라이언트
// 타입체크와 분리되며, astro build 의 프런트매터에서만 import 된다.

/**
 * 테마가 오버라이드할 수 있는 토큰 계약(contract).
 * 키 = `public/css/style.css :root` 의 CSS 변수명, 값 = 기본(default) 테마의 현재 값.
 * 여기 적힌 값은 **참고용 미러**이며 실제 기본값은 style.css 가 보유한다(이 모듈은
 * default 를 베이킹하지 않으므로 드리프트가 시각에 영향 주지 않음). 스킨을 만들 때
 * 어떤 토큰을 바꿀 수 있는지 한눈에 보기 위한 문서/자동완성 보조용이다.
 *
 * 두 그룹으로 나뉜다:
 *  - `root`  : `light-dark(L, D)` 한 줄로 라이트/다크가 분기되는 토큰(라이트/다크가 같은
 *              플랫 색도 포함).
 *  - `dark`  : 트리플렛/그라데이션 등 `light-dark()` 로 표현 불가해 다크 선택자에서
 *              별도로 재정의해야 하는 토큰(style.css 의 @media + html[data-theme=dark] 미러).
 *
 * 이 목록은 **표준 팔레트 토큰** 집합이다. `buildThemeCss` 는 키를 제한하지 않으므로,
 * 여기 없는 다른 `--wiki-*` 토큰(예: 의도적 중립색이라 제외한 `--wiki-scrollbar-thumb`
 * /`-hover`)도 스킨의 `root`/`dark` 에 넣으면 그대로 오버라이드된다.
 */
export const THEMEABLE_TOKENS = {
    root: {
        // 팔레트
        '--wiki-bg': 'light-dark(#F8F9FF, #000000)',
        '--wiki-card-bg': 'light-dark(#FFFFFF, #111111)',
        '--wiki-text': 'light-dark(#1f2937, #f4f4f5)',
        '--wiki-text-muted': 'light-dark(#6b7280, #a1a1aa)',
        '--wiki-border': 'light-dark(#E2E8F0, #27272A)',
        '--wiki-border-focus': 'light-dark(#0ea5e9, #38bdf8)',
        '--wiki-hr-color': 'light-dark(#cbd5e1, #3f3f46)',
        '--wiki-primary': 'light-dark(#006591, #38BDF8)',
        '--wiki-primary-hover': 'light-dark(#004c6e, #7dd3fc)',
        '--wiki-accent': '#8B5CF6',
        '--wiki-success': '#10B981',
        '--wiki-warning': '#F59E0B',
        '--wiki-danger': '#EF4444',
        // 표면/보조
        '--wiki-code-bg': 'light-dark(#f8fafc, #000000)',
        '--wiki-toc-bg': 'light-dark(rgba(255, 255, 255, 0.6), rgba(255, 255, 255, 0.08))',
        '--wiki-bg-alt': 'light-dark(#f1f5f9, #0a0a0a)',
        '--wiki-btn-text': 'light-dark(#ffffff, #000000)',
        '--wiki-border-muted': 'light-dark(rgba(0, 0, 0, 0.05), rgba(255, 255, 255, 0.04))',
        // 포커스 링 색(사이트 전역 input/button/pagination/admin 컨트롤이 --wiki-focus-ring
        // 으로 참조). --wiki-primary-rgb 와 독립된 플랫 색이라, 팔레트를 바꾸면 여기도 함께
        // 지정해야 포커스 링이 새 색을 따른다.
        '--wiki-focus-ring-color': 'rgba(14, 165, 233, 0.15)',
        // diff
        '--wiki-diff-add-bg': 'light-dark(#dcfce7, rgba(16, 185, 129, 0.2))',
        '--wiki-diff-add-text': 'light-dark(#166534, #a7f3d0)',
        '--wiki-diff-del-bg': 'light-dark(#fee2e2, rgba(239, 68, 68, 0.2))',
        '--wiki-diff-del-text': 'light-dark(#991b1b, #fecaca)',
        // 공지 배너
        '--wiki-announce-bg': 'light-dark(#fff8db, #3a3520)',
        '--wiki-announce-text': 'light-dark(#5a4500, #fff8db)',
        '--wiki-announce-icon': 'light-dark(#b58900, #ffd34d)',
        // callout accent (info/tip/note — success/warning/danger 는 위 시맨틱 재사용)
        '--wiki-callout-info': '#0ea5e9',
        '--wiki-callout-tip': '#14b8a6',
        '--wiki-callout-note': '#6b7280',
        // 코드 표면
        '--code-render-bg': 'light-dark(#ffffff, #000000)',
        '--code-render-fg': 'light-dark(#000000, #d4d4d4)',
        '--code-editor-inline-bg': 'light-dark(#f6f8fa, #2d2d2d)',
        '--code-editor-inline-fg': 'light-dark(#24292f, #e0e0e0)',
        '--code-editor-block-bg': 'light-dark(#f6f8fa, #111111)',
        '--code-editor-block-fg': 'light-dark(#24292f, #e0e0e0)',
        // primary 트리플렛(라이트 기본값 — 다크는 아래 dark 그룹에서 재정의)
        '--wiki-primary-rgb': '0, 101, 145',
        // glass/shadow(라이트 기본값 — 다크는 아래 dark 그룹에서 재정의)
        '--wiki-glass-bg': 'light-dark(rgba(255, 255, 255, 0.75), rgba(0, 0, 0, 0.75))',
        '--wiki-glass-border': 'light-dark(rgba(255, 255, 255, 0.5), rgba(255, 255, 255, 0.05))',
        '--wiki-shadow-lg': 'light-dark(0 20px 25px -5px rgba(0, 0, 0, 0.05), 0 20px 25px -5px rgba(0, 0, 0, 0.5))',
    },
    dark: {
        // style.css @media(prefers-color-scheme:dark):root:not([data-theme=light]) +
        // html[data-theme=dark] 가 재정의하는 다크 전용 값(트리플렛/glass/shadow).
        '--wiki-primary-rgb': '56, 189, 248',
        '--wiki-glass-bg': 'rgba(10, 10, 10, 0.6)',
        '--wiki-glass-border': 'rgba(255, 255, 255, 0.08)',
        '--wiki-shadow-lg': '0 20px 25px -5px rgba(0, 0, 0, 0.7), 0 8px 10px -6px rgba(56, 189, 248, 0.15)',
    },
};

/**
 * @typedef {Object} ThemeDefinition
 * @property {Record<string, string>} [root] :root 에 적용할 토큰 오버라이드. 값은
 *   `light-dark(L, D)` 또는 단일 색. 지정한 토큰만 덮어쓰고 나머지는 베이스(style.css) 유지.
 * @property {Record<string, string>} [dark] 다크 전용 오버라이드(트리플렛/glass/shadow 등
 *   light-dark 로 표현 불가한 값). style.css 와 동일하게 @media 다크 + html[data-theme=dark]
 *   양쪽에 동일 선언으로 베이킹된다.
 */

/**
 * 교체 가능한 컬러 테마(스킨) 레지스트리.
 *
 * `default` 는 빌드타임에 아무 것도 베이킹하지 않는 빌트인(= style.css)을 의미하는
 * 센티넬(null)이다. 새 스킨은 아래에 `ThemeDefinition` 항목으로 추가한다.
 *
 * ── 새 테마 추가 템플릿 ──────────────────────────────────────────────
 * // THEMEABLE_TOKENS 에서 바꿀 토큰만 골라 root/dark 에 넣는다. 지정 안 한 토큰은
 * // 베이스(style.css) 값을 그대로 따른다.
 *
 * //   sepia: {
 * //       root: {
 * //           '--wiki-bg': 'light-dark(#f4ecd8, #2b2620)',
 * //           '--wiki-card-bg': 'light-dark(#fbf6e9, #353029)',
 * //           '--wiki-primary': 'light-dark(#9a6a3a, #d8a36a)',
 * //           '--wiki-primary-hover': 'light-dark(#7c5430, #e8bd8e)',
 * //           // 라이트 트리플렛(= #9a6a3a). rgba(var(--wiki-primary-rgb), …) 배경이
 * //           // 라이트에서도 새 primary 를 따르도록 root 에 반드시 함께 지정.
 * //           '--wiki-primary-rgb': '154, 106, 58',
 * //           // 전역 포커스 링도 새 색으로(미지정 시 기본 시안으로 남음).
 * //           '--wiki-focus-ring-color': 'rgba(154, 106, 58, 0.18)',
 * //       },
 * //       dark: {
 * //           // 다크 트리플렛(= #d8a36a). 라이트/다크 트리플렛이 다르면 여기서 다크값 재정의.
 * //           '--wiki-primary-rgb': '216, 163, 106',
 * //       },
 * //   },
 *
 * 추가 후 wrangler.toml `WIKI_THEME = "sepia"` 로 활성화. 끝.
 * ────────────────────────────────────────────────────────────────────
 *
 * @type {Record<string, ThemeDefinition | null>}
 */
export const THEMES = {
    default: null,

    // AstroShell — 딥 스페이스 글래스모피즘 디자인 시스템(첫 추가 스킨).
    // 컨셉: "보이드" 다크 배경 + 네뷸라 퍼플 강조 + 글래스 표면 + 퍼플 글로우.
    // 본 위키는 라이트/다크 양 모드를 가지므로, 원본(다크 전용)을 다음과 같이 적응한다:
    //   - 다크 모드 = 진짜 AstroShell 보이드(Space Black #0D0F14 / Void Gray #1B1E26,
    //                 on-surface #e2e2e9, primary #d8b9ff(MCU primary), 퍼플 글로우).
    // primary 는 "채워진 버튼 배경"과 "링크/탭 텍스트" 두 역할을 겸하는데, 다크에서 단일
    // 색으로 두 역할 모두 WCAG AA 를 만족하려면: primary 를 텍스트 안전한 밝은 톤(#d8b9ff,
    // 다크 카드 대비 9.8:1)으로 두고, 채움색 위 글자는 --wiki-btn-text(다크=#450086 on-primary)
    // 를 쓰면 양립한다. 이를 위해 위키 CSS 소비자에서 primary 채움 위에 흰색을 하드코딩하던
    // 곳들을 --wiki-btn-text 로 정렬했다(이 PR 의 CSS 리팩터, 기본 테마에도 동일 적용=개선).
    //   - 라이트 모드 = 동일 브랜드를 유지한 "네뷸라 라이트"(연보라 표면 + 퍼플 primary
    //                  #7c31d5). 라이트 사용자가 보이드로 강제되지 않게 한 톤 다운 해석.
    // 시맨틱색(success/warning/danger/diff/공지/callout)은 베이스 유지(블라스트 반경 최소화).
    astro: {
        root: {
            '--wiki-bg': 'light-dark(#f6f3fc, #0D0F14)',
            '--wiki-card-bg': 'light-dark(#ffffff, #1B1E26)',
            '--wiki-text': 'light-dark(#1e1b2e, #e2e2e9)',
            '--wiki-text-muted': 'light-dark(#6b6580, #cec2d6)',
            '--wiki-border': 'light-dark(#e6e0f0, #33353a)',
            '--wiki-border-focus': 'light-dark(#7c31d5, #d8b9ff)',
            '--wiki-hr-color': 'light-dark(#ddd3ec, #4b4454)',
            '--wiki-primary': 'light-dark(#7c31d5, #d8b9ff)',
            '--wiki-primary-hover': 'light-dark(#6200bc, #eddcff)',
            // 네뷸라 핑크/퍼플 강조. accent 는 비교 버튼·각주 링크 등에서 "텍스트"로 쓰여
            // 표면 대비 AA 가 필요하므로 모드별 분기: 라이트=짙은 마젠타(#a21caf, 흰 배경
            // 6.3:1), 다크=밝은 네뷸라 핑크(#e0a3ff, 보이드 카드 8.6:1).
            '--wiki-accent': 'light-dark(#a21caf, #e0a3ff)',
            '--wiki-bg-alt': 'light-dark(#efe9f7, #0c0e13)',
            '--wiki-code-bg': 'light-dark(#f4f0fa, #0c0e13)',
            '--wiki-toc-bg': 'light-dark(rgba(255, 255, 255, 0.6), rgba(216, 185, 255, 0.06))',
            // primary 채움 위 글자색: 라이트=흰색(어두운 #7c31d5 위) / 다크=진보라
            // #450086(on-primary, 밝은 #d8b9ff 위 8.8:1). 위 리팩터로 모든 primary 채움
            // 소비자가 이 토큰을 따르므로 채움/텍스트 두 역할이 모두 AA.
            '--wiki-btn-text': 'light-dark(#ffffff, #450086)',
            // 라이트 primary 트리플렛(= #7c31d5). 다크는 dark 그룹에서 재정의.
            '--wiki-primary-rgb': '124, 49, 213',
            // 전역 포커스 링도 퍼플로.
            '--wiki-focus-ring-color': 'rgba(124, 49, 213, 0.22)',
            // 글래스 표면(다크 슬롯은 dark 그룹에서 최종 재정의).
            '--wiki-glass-bg': 'light-dark(rgba(255, 255, 255, 0.75), rgba(27, 30, 38, 0.7))',
            '--wiki-glass-border': 'light-dark(rgba(124, 49, 213, 0.14), rgba(255, 255, 255, 0.1))',
            '--wiki-shadow-lg': 'light-dark(0 20px 25px -5px rgba(124, 49, 213, 0.12), 0 20px 25px -5px rgba(0, 0, 0, 0.7))',
        },
        dark: {
            // 다크 트리플렛(= #d8b9ff).
            '--wiki-primary-rgb': '216, 185, 255',
            // 보이드 위에서 보이는 키보드 포커스 링(라이트 22% 퍼플은 다크에서 거의 안 보임 →
            // 라벤더 50% 로 상향). outline 제거 후 --wiki-focus-ring 만 노출하는 컨트롤 대응.
            '--wiki-focus-ring-color': 'rgba(216, 185, 255, 0.5)',
            // 보이드 글래스 + 퍼플 글로우(30px 블러, rgba(141,70,231,…)).
            '--wiki-glass-bg': 'rgba(27, 30, 38, 0.7)',
            '--wiki-glass-border': 'rgba(255, 255, 255, 0.1)',
            '--wiki-shadow-lg': '0 20px 25px -5px rgba(0, 0, 0, 0.7), 0 8px 30px -6px rgba(141, 70, 231, 0.35)',
        },
    },
};

/** 객체 토큰 맵을 `--k: v;` 선언 문자열로 직렬화 */
function declarations(map) {
    if (!map) return '';
    return Object.entries(map)
        .map(([k, v]) => `${k}:${v};`)
        .join('');
}

/**
 * 테마 정의를 CSS 문자열로 직렬화한다(베이스 위에 얹는 오버라이드).
 * - root  → `:root { ... }`
 * - dark  → `@media(prefers-color-scheme:dark):root:not([data-theme="light"]){...}`
 *           + `html[data-theme="dark"]{...}` (style.css 의 다크 분기 구조와 동일)
 * null/빈 정의면 빈 문자열(= 베이킹 없음).
 *
 * @param {ThemeDefinition | null | undefined} theme
 * @returns {string}
 */
export function buildThemeCss(theme) {
    if (!theme) return '';
    let css = '';
    const root = declarations(theme.root);
    if (root) css += `:root{${root}}`;
    const dark = declarations(theme.dark);
    if (dark) {
        css += `@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){${dark}}}`;
        css += `html[data-theme="dark"]{${dark}}`;
    }
    return css;
}

/**
 * `WIKI_THEME` 값으로 베이킹할 테마 CSS 를 해소한다.
 * - "default"(또는 미지정) → '' (베이킹 없음, style.css 그대로)
 * - 등록된 스킨명 → 해당 스킨 CSS
 * - 미등록명 → '' 로 폴백하고 경고(오타로 깨진 배포 방지)
 *
 * @param {string | undefined | null} name
 * @returns {string}
 */
export function resolveThemeCss(name) {
    const key = (name || 'default').trim();
    if (!(key in THEMES)) {
        console.warn(`[themes] 알 수 없는 WIKI_THEME "${key}" — 기본 테마로 폴백합니다.`);
        return '';
    }
    return buildThemeCss(THEMES[key]);
}
