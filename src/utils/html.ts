/**
 * HTML 특수문자 이스케이프 (XSS 방지)
 */
export function escapeHtml(str: string | undefined | null): string {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * URL 안전성 검사 (화이트리스트 기반)
 * 허용: http:, https:, /, 상대경로
 * 차단: javascript:, data:, vbscript: 등
 */
export function sanitizeUrl(url: string | undefined | null): string {
    if (!url) return '#';
    const trimmed = url.trim();
    if (!trimmed) return '#';

    // 상대경로 허용 (/, ./, ../ 시작)
    if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
        return escapeHtml(trimmed);
    }

    // 프로토콜이 있는 경우 화이트리스트 검사
    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            return escapeHtml(trimmed);
        }
    } catch {
        // URL 파싱 실패 시 상대 경로로 간주하되, 위험한 스킴 차단
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(trimmed)) {
            return '#';
        }
        return escapeHtml(trimmed);
    }

    return '#';
}
