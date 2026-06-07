// 빌드 타임 컬러 테마(스킨) — 엔진 · 토큰 계약 · 레지스트리 (Astro 정적 셸 전용).
//
// 모델: `public/css/style.css` 의 `:root` 가 **기본(default) 테마**이자 모든 색 토큰의
// 베이스 레이어다. 각 스킨은 **`scripts/themes/<이름>.mjs` 한 파일**에 `ThemeDefinition`
// 으로 정의하고, 이 index 의 `THEMES` 에 import 해 등록한다. `wrangler.toml` 의
// `WIKI_THEME` 가 가리키는 스킨을 `BaseLayout.astro` 가 `/css/style.css` 링크 **뒤** 의
// 인라인 `<style>` 로 베이킹하므로(캐스케이드상 나중 선언 우세) 스킨이 베이스를 덮는다.
//
//   WIKI_THEME="default"  → 아무 것도 베이킹하지 않음(= style.css 그대로, 무변화).
//   WIKI_THEME="<skin>"   → 해당 스킨의 토큰 오버라이드를 :root(및 다크 선택자)에 주입.
//
// 새 테마 추가:
//   1) `scripts/themes/<이름>.mjs` 생성 (`scripts/themes/astro.mjs` 가 정식 예시).
//   2) 아래 import 한 줄 + `THEMES` 에 한 줄 등록.
//   3) `wrangler.toml` `WIKI_THEME = "<이름>"` (+ `wrangler example.toml` 더미 동기화).
// 작성 지식·AA 함정·검증 체크리스트는 `agents/rules/themes.md` 참고.
//
// branding.mjs 와 마찬가지로 tsconfig include 밖의 plain .mjs 라 Worker/클라이언트
// 타입체크와 분리되며, astro build 의 프런트매터에서만 import 된다.

import defaultTheme from './default.mjs';
import astro from './astro.mjs';

/**
 * @typedef {Object} ThemeDefinition
 * @property {Record<string, string>} [root] :root 에 적용할 토큰 오버라이드. 값은
 *   `light-dark(L, D)` 또는 단일 색. 지정한 토큰만 덮어쓰고 나머지는 베이스(style.css) 유지.
 * @property {Record<string, string>} [dark] 다크 전용 오버라이드(트리플렛/glass/shadow 등
 *   light-dark 로 표현 불가한 값). style.css 와 동일하게 @media 다크 + html[data-theme=dark]
 *   양쪽에 동일 선언으로 베이킹된다.
 */

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
 * 교체 가능한 컬러 테마(스킨) 레지스트리. 각 값은 `ThemeDefinition | null` 이며
 * 정의는 `scripts/themes/<이름>.mjs` 에서 import 한다(파일 = 테마, 1:1).
 * `default` 는 빌트인(= style.css)을 의미하는 null 센티넬이다.
 *
 * @type {Record<string, ThemeDefinition | null>}
 */
export const THEMES = {
    default: defaultTheme,
    astro,
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
