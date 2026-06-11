// 부트스트랩 (Bootstrap) 테마 — Bootstrap 5 프레임워크 룩앤필 (WIKI_THEME 키 "bootstrap").
//
// 컨셉: Bootstrap 5 의 기본 색상, 타이포그래피, 둥근 모서리 및 컴포넌트 스타일을 재현한다.
// 시스템 폰트 스택을 사용하고, 익숙한 부트스트랩의 primary 블루(#0d6efd)와 회색톤을 쓴다.
//
// 사용자 대면 설명 문서: Cloudwiki/설정/테마/Bootstrap.

/** @type {import('./index.mjs').ThemeDefinition} */
export default {
    root: {
        // 배경 & 텍스트
        '--wiki-bg': 'light-dark(#f8f9fa, #212529)',
        '--wiki-card-bg': 'light-dark(#ffffff, #2b3035)',
        '--wiki-text': 'light-dark(#212529, #dee2e6)',
        '--wiki-text-muted': 'light-dark(#6c757d, #adb5bd)',
        '--wiki-border': 'light-dark(#dee2e6, #495057)',
        '--wiki-border-focus': 'light-dark(#86b7fe, #3d8bfd)',
        '--wiki-hr-color': 'light-dark(#dee2e6, #495057)',

        // 브랜드 컬러
        // primary: 라이트 #0d6efd (btn-primary), 다크 #9ec5fe (btn-primary in dark mode)
        '--wiki-primary': 'light-dark(#0d6efd, #9ec5fe)',
        '--wiki-primary-hover': 'light-dark(#0b5ed7, #b6d4fe)',
        // accent: 라이트는 더 진한 블루, 다크는 더 밝은 블루 (텍스트 대비를 위해)
        '--wiki-accent': 'light-dark(#0a58ca, #6ea8fe)',

        // 표면 & 기타
        '--wiki-bg-alt': 'light-dark(#e9ecef, #343a40)',
        '--wiki-code-bg': 'light-dark(#f8f9fa, #2b3035)',
        '--wiki-toc-bg': 'light-dark(rgba(248, 249, 250, 0.8), rgba(33, 37, 41, 0.8))',

        // 채움 위 글자색 (버튼 텍스트)
        // 라이트에서는 #0d6efd 위에 흰색, 다크에서는 #9ec5fe 위에 검은색
        '--wiki-btn-text': 'light-dark(#ffffff, #000000)',

        // Primary RGB (라이트)
        '--wiki-primary-rgb': '13, 110, 253',

        // 포커스 링
        '--wiki-focus-ring-color': 'rgba(13, 110, 253, 0.25)',

        // 글래스 표면 (라이트)
        '--wiki-glass-bg': 'light-dark(rgba(255, 255, 255, 0.85), rgba(33, 37, 41, 0.85))',
        '--wiki-glass-border': 'light-dark(rgba(0, 0, 0, 0.175), rgba(255, 255, 255, 0.15))',
        '--wiki-shadow-lg': 'light-dark(0 0.5rem 1rem rgba(0, 0, 0, 0.15), 0 0.5rem 1rem rgba(0, 0, 0, 0.5))',

        // 글꼴 & 밀도 & 모서리
        // 부트스트랩 시스템 폰트 스택
        '--wiki-font-body': 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", "Liberation Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"',
        '--wiki-font-heading': 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", "Liberation Sans", Arial, sans-serif',

        // 부트스트랩 기본 모서리
        '--wiki-radius-xs': '0.125rem', // 2px
        '--wiki-radius-sm': '0.25rem',  // 4px
        '--wiki-radius-md': '0.375rem', // 6px
        '--wiki-radius-base': '0.375rem', // 6px
        '--wiki-radius-lg': '0.5rem',   // 8px
        '--wiki-radius-xl': '0.75rem',  // 12px
        '--wiki-radius-2xl': '1rem',    // 16px

        // 밀도
        '--wiki-lh-loose': '1.5',
        '--wiki-lh-spacious': '1.5',

        // 헤더
        '--wiki-header-bg': 'light-dark(#f8f9fa, #212529)',
        '--wiki-header-shadow': 'light-dark(0 0.125rem 0.25rem rgba(0, 0, 0, 0.075), 0 0.125rem 0.25rem rgba(0, 0, 0, 0.5))',
        '--wiki-header-border': 'light-dark(rgba(0, 0, 0, 0.175), rgba(255, 255, 255, 0.15))',
        '--wiki-header-text': 'light-dark(#212529, #f8f9fa)',
        '--wiki-header-brand': 'light-dark(#212529, #f8f9fa)',

        // 부트스트랩 시맨틱 컬러 오버라이드
        '--wiki-success': '#198754',
        '--wiki-warning': '#ffc107',
        '--wiki-danger': '#dc3545',
        '--wiki-palette-info-bg': 'light-dark(#0dcaf0, #087990)',
        '--wiki-palette-info-text': 'light-dark(#000000, #ffffff)',
    },
    dark: {
        // 다크 Primary RGB (#9ec5fe)
        '--wiki-primary-rgb': '158, 197, 254',

        // 다크 포커스 링
        '--wiki-focus-ring-color': 'rgba(158, 197, 254, 0.25)',

        // 다크 글래스 표면
        '--wiki-glass-bg': 'rgba(43, 48, 53, 0.85)',
        '--wiki-glass-border': 'rgba(255, 255, 255, 0.15)',
        '--wiki-shadow-lg': '0 0.5rem 1rem rgba(0, 0, 0, 0.5), 0 0.25rem 0.5rem rgba(0, 0, 0, 0.25)',

        // 헤더 다크
        '--wiki-header-bg': '#212529',
        '--wiki-header-shadow': '0 0.125rem 0.25rem rgba(0, 0, 0, 0.5)',
    },
};
