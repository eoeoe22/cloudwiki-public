// 벡터(Vector) — MediaWiki Vector 2022 스킨 모방 (WIKI_THEME 키 "vector").
//
// 컨셉: Wikipedia 의 Vector 2022 룩을 **토큰만으로** 재현한다 — 회색 페이지(#f8f9fa) 위
// 흰 본문 카드, 클래식 MediaWiki 링크 블루(#3366cc), **세리프 제목 + 산세 본문**(위키백과
// 의 상징적 타이포), **각진 모서리**(둥근 표면 대신 2px), 흰/플랫 헤더(컬러 바 대신),
// 그리고 다소 압축된 백과사전 밀도. 구조 CSS(셀렉터)는 건드리지 않으므로 픽셀-퍼펙트가
// 아니라 "한눈에 Vector" 인 **플레이버**다. 본문 렌더 베이스(render.css)가 이미 h2 밑줄
// (border-bottom)·세리프 가능한 --wiki-font-heading·--wiki-measure 를 토큰화해 둬서 가장
// 상징적인 단서(밑줄 친 세리프 섹션 제목)는 색·글꼴 토큰 교체만으로 그대로 살아난다.
//
// 다크 전용이 아니라 라이트·다크 양벌(Vector 2022 의 night 모드 대응). 색값은 MediaWiki
// 디자인 토큰(WikimediaUI Base)을 그대로 차용했다.
//
// 글꼴: 본문 산세는 시스템 스택 + 이미 로드된 'Noto Sans KR'(한글), 제목 세리프는 위키백과
// 가 쓰는 'Linux Libertine'(미설치 시 'Georgia') + 이미 로드된 'Noto Serif KR'(한글) 폴백.
// → src/shared/cdn.ts 무변경(필요한 두 한글 패밀리가 이미 FONTS.ui 에 로드됨).
//
// AA 메모(themes.md §4):
//  - 듀얼-롤 primary: 라이트=링크 블루 #3366cc(흰 카드 위 5.4:1, 흰 btn-text 채움 위 5.4:1),
//    다크=소프트 블루 #88a3e8(다크 카드 #1b1f24 위 6.8:1, 어두운 btn-text #101418 채움 위
//    7.3:1) → 채움/텍스트 두 역할 모두 AA.
//  - accent(텍스트로도 렌더): 라이트=딥 블루 #2a4b8d(흰 위 8.6:1), 다크=라이트 블루 #aabdf0
//    (다크 카드 위 9:1↑).
//  - text-muted: 라이트 #54595d(흰 위 7.1:1) — MediaWiki 의 표준 보조 텍스트색.
//  - primary-rgb·focus-ring·btn-text 를 라이트(root)·다크(dark 그룹) 양쪽 동기화.
//  - 시맨틱색(success/warning/danger/diff/공지/callout)은 베이스 유지(블라스트 반경 최소화).
//
// 사용자 대면 설명 문서: Cloudwiki/설정/테마/벡터.

/** @type {import('./index.mjs').ThemeDefinition} */
export default {
    root: {
        // ── 팔레트(WikimediaUI — 회색 페이지 / 흰 본문 / 링크 블루) ──
        '--wiki-bg': 'light-dark(#f8f9fa, #101418)',
        '--wiki-bg-alt': 'light-dark(#eaecf0, #1b1f24)',
        '--wiki-card-bg': 'light-dark(#ffffff, #1b1f24)',
        '--wiki-text': 'light-dark(#202122, #eaecf0)',
        '--wiki-text-muted': 'light-dark(#54595d, #a2a9b1)',
        '--wiki-border': 'light-dark(#a2a9b1, #54595d)',
        '--wiki-border-focus': 'light-dark(#3366cc, #88a3e8)',
        '--wiki-hr-color': 'light-dark(#c8ccd1, #43484e)',
        '--wiki-primary': 'light-dark(#3366cc, #88a3e8)',
        '--wiki-primary-hover': 'light-dark(#2a4b8d, #aabdf0)',
        // accent — primary 와 같은 블루 계열(플랫). 라이트=딥 블루(흰 위 8.6:1), 다크=라이트 블루.
        '--wiki-accent': 'light-dark(#2a4b8d, #aabdf0)',
        '--wiki-code-bg': 'light-dark(#f8f9fa, #101418)',
        '--wiki-toc-bg': 'light-dark(rgba(248, 249, 250, 0.7), rgba(255, 255, 255, 0.04))',
        // primary 채움 위 글자색: 라이트=흰색(블루 위) / 다크=near-black(라이트 블루 위).
        '--wiki-btn-text': 'light-dark(#ffffff, #101418)',
        // 라이트 primary 트리플렛(= #3366cc). 다크는 dark 그룹에서 재정의.
        '--wiki-primary-rgb': '51, 102, 204',
        '--wiki-focus-ring-color': 'rgba(51, 102, 204, 0.25)',
        // 글래스/그림자 — Vector 는 플랫. 거의 불투명한 표면 + 약한 그림자.
        // glass-bg/border 는 단색이라 light-dark() OK. 그러나 --wiki-shadow-lg 는 **완전한
        // box-shadow 값**이라 light-dark()(색/이미지 전용)로 감싸면 소비처(box-shadow)에서
        // 무효가 돼 라이트 모드 그림자가 사라진다 → root 에 라이트값, dark 그룹에 다크값을
        // 따로 둔다(themes.md §3).
        '--wiki-glass-bg': 'light-dark(rgba(255, 255, 255, 0.9), rgba(27, 31, 36, 0.9))',
        '--wiki-glass-border': 'light-dark(#a2a9b1, rgba(255, 255, 255, 0.08))',
        '--wiki-shadow-lg': '0 1px 4px rgba(0, 0, 0, 0.1)',
        // ── 헤더(navbar) — 컬러 그라데이션 바 대신 Vector 의 흰/플랫 헤더 + 얇은 하단 룰.
        // 모두 단색이라 light-dark() 로 라이트/다크 분기(그라데이션 아님 → dark 그룹 불요).
        // 그림자는 색만 light-dark 인 var(--wiki-border) 를 써 모드별로 자동 적응(얇은 밑줄).
        '--wiki-header-bg': 'light-dark(#ffffff, #1b1f24)',
        '--wiki-header-border': 'light-dark(#a2a9b1, #54595d)',
        '--wiki-header-shadow': '0 1px 0 var(--wiki-border)',
        '--wiki-header-text': 'light-dark(#202122, #eaecf0)',
        // 브랜드(위키 이름)는 .navbar-brand 가 --wiki-font-heading(세리프)를 쓰므로 위키백과
        // 워드마크처럼 검은 세리프로 렌더된다.
        '--wiki-header-brand': 'light-dark(#202122, #f8f9fa)',

        // ── 비-색 토큰: 세리프 제목 + 산세 본문 + 압축 밀도 + 각진 모서리 ──
        // (아래 토큰은 모두 실제 소비처가 있다 — measure=산문 max-width, lh-loose=body,
        //  lh-spacious=.wiki-content p, article-padding=.wiki-article, radius=전역.)
        // 본문: 시스템 산세 + Noto Sans KR. 제목: Linux Libertine→Georgia 세리프 + Noto Serif KR.
        '--wiki-font-body': "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans KR', sans-serif",
        '--wiki-font-heading': "'Linux Libertine', 'Georgia', 'Noto Serif KR', 'Times New Roman', serif",
        // 넉넉한 측정폭 + 다소 압축된 백과사전 행간(본문 1.7→1.6, 산문 문단 1.8→1.65).
        '--wiki-measure': '76ch',
        '--wiki-lh-loose': '1.6',
        '--wiki-lh-spacious': '1.65',
        // 본문 컨테이너 패딩 살짝 압축(2.5rem→2rem).
        '--wiki-article-padding': '2rem',
        // 각진 표면 — Vector 의 거의 직각 모서리(둥근 6/8/10px → 2px). 셸(style.css)뿐
        // 아니라 본문 렌더(render.css)도 같은 토큰을 소비하므로, 본문이 쓰는 xs/md/2xl 까지
        // **반경 스케일 전체**를 덮어야 한다. 일부만 덮으면 셸 카드(lg=2px 각짐)와 본문 요소
        // (blockquote·헤딩 버튼 md=5px, .wiki-badge 2xl=20px 등)의 모서리가 섞여 보인다.
        // (--wiki-radius 는 --wiki-radius-sm 을, --wiki-radius-none 은 0 이라 자동 추종.)
        '--wiki-radius-xs': '2px',
        '--wiki-radius-sm': '2px',
        '--wiki-radius-md': '2px',
        '--wiki-radius-base': '2px',
        '--wiki-radius-lg': '2px',
        '--wiki-radius-xl': '3px',
        // .wiki-badge(본문 배지)는 2xl(20px 알약)을 쓴다 → Vector 의 각진 칩으로(3px).
        '--wiki-radius-2xl': '3px',
        // --wiki-radius-full(9999px)은 원형 아바타/진행 바 끝처럼 의도된 알약이라 유지.
        // 플랫(프로스트 글래스 제거) — 거의 불투명한 glass-bg 와 결합해 솔리드 헤더.
        '--wiki-glass-blur': 'blur(0px)',
    },
    dark: {
        // 다크 트리플렛(= #88a3e8).
        '--wiki-primary-rgb': '136, 163, 232',
        // 다크 표면 위 키보드 포커스 링(소프트 블루 45%).
        '--wiki-focus-ring-color': 'rgba(136, 163, 232, 0.45)',
        // 다크 플랫 표면 + 약한 그림자.
        '--wiki-glass-bg': 'rgba(27, 31, 36, 0.9)',
        '--wiki-glass-border': 'rgba(255, 255, 255, 0.08)',
        '--wiki-shadow-lg': '0 1px 4px rgba(0, 0, 0, 0.6)',
    },
};
