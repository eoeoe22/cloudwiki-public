/**
 * Slug를 정규화합니다.
 * 앞뒤 공백만 제거하고 원래 대소문자를 유지합니다.
 * 예: "Foo Bar" -> "Foo Bar"
 */
export function normalizeSlug(text: string): string {
    return text.trim();
}
