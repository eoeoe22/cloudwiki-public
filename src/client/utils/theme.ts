/**
 * 사용자 테마 환경설정(localStorage `themeMode`)을 <html data-theme> 로 즉시 반영.
 *
 * 호출 시점:
 *   FOUC 방지를 위해 가능한 한 빨리 실행해야 한다. 현재 대부분의 페이지는
 *   <head> 의 인라인 동기 스크립트로 동일 작업을 먼저 수행한 뒤, common.js IIFE 가
 *   본문 파싱 시점에 한 번 더 fallback 으로 적용한다. ESM 마이그레이션 단계에서는
 *   이 함수를 import 한 페이지가 동일한 fallback 또는 토글 후 재적용에 사용한다.
 *
 * 마이그레이션 노트:
 *   기존 public/js/common.js:7-14 의 IIFE 와 모든 HTML <head> 의 인라인 스크립트가
 *   참고하는 동일 로직. 인라인 head 스크립트는 deferred 모듈로 대체할 수 없으므로
 *   당분간 그대로 유지하고, 본 함수는 모듈 측 fallback 으로만 사용한다.
 */
export function applyStoredTheme(): void {
    try {
        const saved = localStorage.getItem('themeMode') || 'auto';
        if (saved === 'light' || saved === 'dark') {
            document.documentElement.setAttribute('data-theme', saved);
        }
    } catch {
        /* 스토리지 접근 불가(예: 시크릿 모드 일부) 시 auto 테마 유지 */
    }
}
