// AstroShell — 딥 스페이스 글래스모피즘 디자인 시스템 (WIKI_THEME 키 "astro").
//
// 컨셉: "보이드" 다크 배경 + 네뷸라 퍼플 강조 + 글래스 표면 + 퍼플 글로우.
// 본 테마는 **다크 모드 전용**(`darkOnly: true`)이다 — 원본 AstroShell 의 보이드 미감은
// 다크에서만 성립하므로, 이 스킨이 활성인 동안 사이트는 사용자 밝기 선호와 무관하게 항상
// 다크로 고정된다(BaseLayout 이 `data-theme="dark"` 강제 → `light-dark()` 가 다크로 해소).
// 아래 `light-dark(L, D)` 쌍의 라이트값(L)은 강제 다크 하에서 사용되지 않는(inert) 잔여이며,
// 다크값(D)·dark 그룹만 실제로 렌더된다(쌍을 남겨도 플랫 다크값으로 줄여도 결과는 동일).
//   - 다크 모드 = 진짜 AstroShell 보이드(Space Black #0D0F14 / Void Gray #1B1E26,
//                 on-surface #e2e2e9, primary #d8b9ff(MCU primary), 퍼플 글로우).
// primary 는 "채워진 버튼 배경"과 "링크/탭 텍스트" 두 역할을 겸하는데, 다크에서 단일
// 색으로 두 역할 모두 WCAG AA 를 만족하려면: primary 를 텍스트 안전한 밝은 톤(#d8b9ff,
// 다크 카드 대비 9.8:1)으로 두고, 채움색 위 글자는 --wiki-btn-text(다크=#450086 on-primary)
// 를 쓰면 양립한다. 이를 위해 위키 CSS 소비자에서 primary 채움 위에 흰색을 하드코딩하던
// 곳들을 --wiki-btn-text 로 정렬했다(PR #877 의 CSS 리팩터, 기본 테마에도 동일 적용=개선).
//   - 라이트 모드 = 동일 브랜드를 유지한 "네뷸라 라이트"(연보라 표면 + 퍼플 primary
//                  #7c31d5). 라이트 사용자가 보이드로 강제되지 않게 한 톤 다운 해석.
// 시맨틱색(success/warning/danger/diff/공지/callout)은 베이스 유지(블라스트 반경 최소화).
//
// 사용자 대면 설명 문서: Cloudwiki/설정/테마/Astro.

/** @type {import('./index.mjs').ThemeDefinition} */
export default {
    darkOnly: true,
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
        // ── 헤더(navbar) — 테마 전환이 한눈에 보이도록 네뷸라 그라데이션 컬러 바로 교체.
        // bg/shadow 는 그라데이션/그림자라 light-dark() 불가 → root 에 라이트값, dark 그룹에
        // 다크값. text/brand/border 는 색이라 light-dark() 로 모드 분기.
        // 라이트: 퍼플→마젠타 그라데이션(가장 밝은 stop #a23fd8 L≈0.16, 흰 전경 4.9:1↑).
        '--wiki-header-bg': 'linear-gradient(100deg, #6a1fb8 0%, #8e2fd0 55%, #a23fd8 100%)',
        '--wiki-header-shadow': '0 6px 24px -8px rgba(124, 49, 213, 0.55)',
        '--wiki-header-border': 'light-dark(rgba(255, 255, 255, 0.18), rgba(216, 185, 255, 0.16))',
        // 전경: 라이트=흰 텍스트/연핑크 브랜드 아이콘, 다크=라벤더 화이트/라벤더 브랜드.
        '--wiki-header-text': 'light-dark(#ffffff, #f3e8ff)',
        '--wiki-header-brand': 'light-dark(#f3d9ff, #d8b9ff)',
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
        // 헤더 다크: 딥 보이드 퍼플 바 + 퍼플 글로우(라이트값은 root, 여기는 다크 전용).
        '--wiki-header-bg': 'linear-gradient(100deg, #1b1230 0%, #241640 55%, #2e1a4d 100%)',
        '--wiki-header-shadow': '0 6px 28px -8px rgba(141, 70, 231, 0.5)',
    },
};
