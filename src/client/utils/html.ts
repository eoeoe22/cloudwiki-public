/**
 * HTML 이스케이프 — 사용자 입력을 innerHTML/template literal에 안전하게 삽입하기 위함.
 *
 * 마이그레이션 노트:
 *   기존 public/js/common.js의 전역 escapeHtml과 동일한 동작.
 *   render.js, edit.html 등에 흩어진 중복 정의는 차후 마이그레이션 단계에서 통합한다.
 *   브리지 패턴이 필요한 페이지(아직 raw script로 동작하는 페이지가 함께 있을 때)는
 *   이 함수를 별도 진입점에서 import 후 (window as any).escapeHtml 에 노출한다.
 */
export function escapeHtml(str: string | number | null | undefined): string {
    if (str === null || str === undefined || str === '') return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
