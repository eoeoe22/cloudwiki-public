/**
 * URL 스킴 검증 — http/https 프로토콜만 허용한다.
 *
 * SSR 또는 사용자가 입력한 외부 URL을 프로필 사진/로고/링크 등에 사용하기 전에
 * 호출하여 javascript:, data:, file: 등 잠재적으로 위험한 스킴을 차단한다.
 *
 * 마이그레이션 노트:
 *   기존 public/js/common.js의 전역 isSafeUrl과 동일한 동작.
 */
export function isSafeUrl(url: string | null | undefined): boolean {
    if (!url) return false;
    try {
        const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
        const parsed = new URL(url, base);
        return ['http:', 'https:'].includes(parsed.protocol);
    } catch {
        return false;
    }
}
