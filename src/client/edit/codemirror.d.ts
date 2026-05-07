/**
 * CodeMirror 6 / Lezer 모듈 shim.
 *
 * 패키지를 npm 으로 설치하지 않고 브라우저 importmap(esm.sh CDN) 만으로 해석하므로,
 * TypeScript 타입 체크와 Vite/Rollup 번들링 시 모듈 해석 실패를 막기 위한 선언이다.
 *
 * 빌드: vite.config.ts 의 rollupOptions.external 가 동일 패키지를 외부화해
 *       바벨번들에 포함시키지 않으므로 (HTML 의 importmap 으로 해석) 타입은 any 로 충분하다.
 */

declare module "@codemirror/state";
declare module "@codemirror/view";
declare module "@codemirror/commands";
declare module "@codemirror/language";
declare module "@codemirror/lang-markdown";
declare module "@codemirror/language-data";
declare module "@codemirror/theme-one-dark";
declare module "@codemirror/search";
declare module "@lezer/highlight";
