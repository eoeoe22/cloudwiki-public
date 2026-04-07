/**
 * Slug를 정규화합니다.
 * 앞뒤 공백만 제거하고 원래 대소문자를 유지합니다.
 * 예: "Foo Bar" -> "Foo Bar"
 */
export function normalizeSlug(text: string): string {
    return text.trim();
}

/**
 * 특정 네임스페이스(틀:, 템플릿: 제외)인 경우 본문을 DB에 저장하지 않고 R2에만 저장할지 여부를 반환합니다.
 */
export function isR2OnlyNamespace(slug: string): boolean {
    const colonIndex = slug.indexOf(':');
    if (colonIndex === -1) return false; // 일반 문서
    const namespace = slug.substring(0, colonIndex);
    if (namespace === '틀' || namespace === '템플릿') return false; // 제외 대상
    return true; // 그 외 네임스페이스
}
