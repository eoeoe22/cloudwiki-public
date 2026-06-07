// 기본(빌트인) 테마 — WIKI_THEME 키 "default", 위키 표시 이름 "VIA".
//
// `public/css/style.css` 의 `:root` 가 라이트/다크 색 토큰의 단일 소스이며, 이 테마는
// 그 위에 덮어쓸 오버라이드가 없다 → **null 센티넬**. `resolveThemeCss('default')` 는
// 빈 문자열로 해소돼 빌드 타임에 아무 것도 베이킹하지 않는다(출력 바이트 동일·무오버헤드).
//
// 즉 "기본 테마의 색을 바꾸려면" 스킨 파일이 아니라 style.css :root 를 직접 고친다.
// 사용자 대면 설명 문서: Cloudwiki/설정/테마/VIA.
//
// @type {import('./index.mjs').ThemeDefinition | null}
export default null;
