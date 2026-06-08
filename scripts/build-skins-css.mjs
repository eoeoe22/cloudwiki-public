// 멀티 스킨 색 테마 CSS 를 외부 정적 파일로 빌드한다(astro build 보다 먼저 실행).
//
// 배경: 멀티 스킨 모드(WIKI_THEMES ≥ 2)에서는 과거 BaseLayout 이 등록된 *모든* 스킨의
// 토큰 오버라이드 CSS 를 매 HTML 셸에 인라인 <style> 로 베이킹했다. 스킨 수가 늘수록 모든
// 페이지 응답 바이트가 커지고, HTML 은 길게 캐시할 수 없어 페이지 이동마다 재전송됐다.
//
// 대신 스코프 CSS 를 콘텐츠 해시 파일(`public/css/skins-<hash>.css`)로 한 번 기록하고
// BaseLayout 이 <link> 로 참조한다. 콘텐츠가 바뀌면 해시(파일명)도 바뀌므로 `_headers` 의
// `immutable` 영구 캐시가 안전하다(자동 캐시 버스팅). 파일명 해시는 BaseLayout 과 동일한
// `skinsCssHref` 헬퍼로 도출하므로 양쪽이 항상 같은 경로를 가리킨다.
//
// branding.mjs / themes/*.mjs 와 마찬가지로 tsconfig include 밖의 plain .mjs 라 Worker/
// 클라이언트 타입체크와 분리되며 node:fs 로 직접 파일을 다룬다.

import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readBranding } from './branding.mjs';
import { filterRegisteredThemes, resolveThemesCss, skinsCssHref } from './themes/index.mjs';

const cssDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'css');

// 이전 빌드의 해시 산출물을 모두 제거(스킨/색이 바뀌면 새 해시 파일만 남도록).
function cleanStaleSkinsCss() {
    for (const name of readdirSync(cssDir)) {
        if (/^skins-[0-9a-f]+\.css$/.test(name)) rmSync(join(cssDir, name));
    }
}

const branding = readBranding();
const skinList = filterRegisteredThemes(branding.themes || []);
const multiSkin = skinList.length >= 2;
const css = multiSkin ? resolveThemesCss(skinList) : '';
const href = skinsCssHref(css);

cleanStaleSkinsCss();

if (href) {
    // href = '/css/skins-<hash>.css' → 파일명만 떼어 public/css 아래 기록.
    writeFileSync(join(cssDir, href.replace('/css/', '')), css, 'utf8');
    console.log(`[skins-css] ${href} (${css.length} bytes, ${skinList.length} skins)`);
} else {
    console.log('[skins-css] 단일 스킨 모드 — 외부 스킨 CSS 없음(인라인 베이킹 유지).');
}
