// VIA — 뉴모피즘(Neumorphism, 소프트 모노크롬 + 이중 그림자) 디자인 스킨 (WIKI_THEME 키 "via").
//
// 컨셉: 페이지와 표면이 **같은 부드러운 회청색(#ecf0f3)** 위에 "돌출(extruded)" 이중
// 그림자(밝은 하이라이트 + 어두운 그림자)를 얹어 카드·패널·버튼이 배경에서 부드럽게
// 솟아오른 듯 보이게 한다. Montserrat 본문 + 큰 둥근 모서리 + 블러 없는 불투명 표면.
//
// ── 토큰만으로 어디까지 재현되나(설계 한계) ─────────────────────────────────────────
// 테마 엔진은 `:root` 에 CSS 변수만 베이킹하고 새 셀렉터·규칙은 주입하지 못한다. 뉴모피즘의
// 가장 상징적인 "솟아오른 표면"은 사이트의 카드/패널/본문/TOC/헤더/버튼(btn-wiki)이 모두
// `--wiki-shadow-sm/-md/-lg`·`--wiki-shadow` 토큰을 소비하므로 이 토큰을 이중 그림자로
// 덮어 재현된다. 반면 입력 필드(.form-control)의 "오목하게 파인(inset)" 룩과 버튼 눌림
// (:active) inset 은 `box-shadow: none`/`transform` 이 하드코딩이라 토큰만으론 불가하다
// (후속 단계에서 style.css 에 스킨 스코프 inset 규칙을 추가해야 95%+ 재현). 그래서 입력은
// inset 대신 옅은 보더로 식별성을 유지하도록 --wiki-border 를 너무 옅게 두지 않는다.
//
// 라이트·다크 양벌(다크 전용 아님). 뉴모피즘은 본래 라이트 양식이라 라이트가 주력이지만,
// 다크에서도 중간 명도 회색(#2a2e35) 위 어두운/밝은 그림자 쌍으로 같은 입체감을 낸다.
//
// AA 메모(themes.md §3):
//  - 듀얼-롤 primary(채움 배경 + 표면 위 텍스트): 라이트=#3457cf(흰 카드/연회색 표면 위
//    텍스트 ≈5.2:1, 흰 btn-text 채움 위 ≈6:1), 다크=#9bb4f5(어두운 표면 위 텍스트, 어두운
//    btn-text #14213d 채움 위) → 두 역할 모두 AA.
//  - accent(텍스트로도 렌더): 라이트=#2f54cc(연회색 위 ≈5.7:1), 다크=#acc0fb.
//  - text-muted: 라이트 #5f6671(#ecf0f3 위 ≈5:1), 다크 #9aa3af(#2a2e35 위 ≈5.2:1).
//  - primary-rgb·focus-ring·glass·shadow 를 라이트(root)·다크(dark 그룹) 양쪽 동기화.
//    box-shadow 전체 값은 light-dark() 로 감싸면 무효(색/이미지 전용)라 root=라이트, dark
//    그룹=다크로 분리한다(themes.md §3).
//  - 시맨틱색(success/warning/danger/diff/공지/callout)은 베이스 유지(블라스트 반경 최소화).
//
// 새 웹폰트(Montserrat) → src/shared/cdn.ts FONTS.ui 에 동기화함.
//
// 사용자 대면 설명 문서: Cloudwiki/설정/테마/VIA.

/** @type {import('./index.mjs').ThemeDefinition} */
export default {
    root: {
        // ── 팔레트(소프트 모노크롬 — 페이지와 카드가 같은 색) ──
        '--wiki-bg': 'light-dark(#ecf0f3, #2a2e35)',
        '--wiki-bg-alt': 'light-dark(#e3e9ef, #23272e)',
        // 카드 = 배경과 동일색(뉴모피즘 전제). 채움이 아니라 이중 그림자로 솟아오른다.
        '--wiki-card-bg': 'light-dark(#ecf0f3, #2a2e35)',
        '--wiki-text': 'light-dark(#45494f, #d7dce3)',
        '--wiki-text-muted': 'light-dark(#5f6671, #9aa3af)',
        // 보더는 거의 사라지되 입력 필드 식별을 위해 완전 투명까진 두지 않는다(inset 불가 대비).
        '--wiki-border': 'light-dark(#c9d2dc, #3a3f48)',
        '--wiki-border-focus': 'light-dark(#3457cf, #9bb4f5)',
        '--wiki-hr-color': 'light-dark(#d0d7df, #3a3f48)',
        '--wiki-primary': 'light-dark(#3457cf, #9bb4f5)',
        '--wiki-primary-hover': 'light-dark(#2742b5, #bcccf9)',
        '--wiki-accent': 'light-dark(#2f54cc, #acc0fb)',
        // 채움 위 글자색: 라이트=흰색(#3457cf 위) / 다크=짙은 남색(밝은 #9bb4f5 위).
        '--wiki-btn-text': 'light-dark(#ffffff, #14213d)',
        // 라이트 primary 트리플렛(= #3457cf). 다크는 dark 그룹에서 재정의.
        '--wiki-primary-rgb': '52, 87, 207',
        '--wiki-focus-ring-color': 'rgba(52, 87, 207, 0.25)',

        // ── 표면(블러 없는 불투명 — 프로스트 글래스 대신 솔리드 뉴모 표면) ──
        '--wiki-code-bg': 'light-dark(#e6ecf2, #23272e)',
        '--wiki-toc-bg': 'light-dark(#ecf0f3, #2a2e35)',
        '--wiki-glass-bg': 'light-dark(#ecf0f3, #2a2e35)',
        '--wiki-glass-border': 'light-dark(#d8dee5, #3a3f48)',
        '--wiki-glass-blur': 'blur(0px)',

        // ── 이중 그림자(뉴모피즘의 핵심) ──
        // box-shadow 전체 값이라 light-dark() 불가 → root 에 라이트값(양 모드 적용), dark
        // 그룹에서 다크값으로 재정의. sm/shadow/md/lg 가 사이트 전역 카드·패널·버튼에 쓰인다.
        '--wiki-shadow-sm': '3px 3px 6px #d1d9e6, -3px -3px 6px #f9fbff',
        '--wiki-shadow': '5px 5px 10px #ccd4e0, -5px -5px 10px #fafdff',
        '--wiki-shadow-md': '6px 6px 14px #d1d9e6, -6px -6px 14px #f9fbff',
        '--wiki-shadow-lg': '10px 10px 22px #ccd4e0, -10px -10px 22px #fafdff',

        // ── 헤더(navbar) — 페이지와 같은 색 + 솟아오른 이중 그림자(컬러 바 대신 플러시 바) ──
        // bg/border/text/brand 는 색이라 light-dark() OK. shadow 는 전체 box-shadow 라
        // root(라이트) + dark 그룹(다크).
        '--wiki-header-bg': 'light-dark(#ecf0f3, #2a2e35)',
        '--wiki-header-border': 'light-dark(#dfe5ec, #33373f)',
        '--wiki-header-shadow': '4px 4px 12px #d1d9e6, -4px -4px 12px #f9fbff',
        '--wiki-header-text': 'light-dark(#45494f, #d7dce3)',
        '--wiki-header-brand': 'light-dark(#3457cf, #9bb4f5)',

        // ── 비-색 토큰: Montserrat 본문/제목 + 큰 둥근 모서리(푹신한 느낌) ──
        '--wiki-font-body': "'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans KR', sans-serif",
        '--wiki-font-heading': "'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans KR', sans-serif",
        // 둥근 모서리 — 셸(style.css)과 본문(render.css)이 같은 스케일을 공유하므로 전 스케일
        // 을 키워야 모서리가 섞이지 않는다(--wiki-radius-full=9999 알약은 유지).
        '--wiki-radius-xs': '6px',
        '--wiki-radius-sm': '8px',
        '--wiki-radius-md': '10px',
        '--wiki-radius-base': '10px',
        '--wiki-radius-lg': '14px',
        '--wiki-radius-xl': '18px',
        '--wiki-radius-2xl': '22px',
    },
    dark: {
        // 다크 트리플렛(= #9bb4f5).
        '--wiki-primary-rgb': '155, 180, 245',
        // 어두운 표면 위 키보드 포커스 링(밝은 블루 45%).
        '--wiki-focus-ring-color': 'rgba(155, 180, 245, 0.45)',
        // 다크 이중 그림자(중간 명도 #2a2e35 위 어두운/밝은 쌍).
        '--wiki-shadow-sm': '3px 3px 6px #1f2228, -3px -3px 6px #353b44',
        '--wiki-shadow': '5px 5px 10px #1d2026, -5px -5px 10px #373d47',
        '--wiki-shadow-md': '6px 6px 14px #1f2228, -6px -6px 14px #353b44',
        '--wiki-shadow-lg': '10px 10px 22px #1d2026, -10px -10px 22px #373d47',
        // 헤더 다크 그림자.
        '--wiki-header-shadow': '4px 4px 12px #1f2228, -4px -4px 12px #353b44',
    },
};
