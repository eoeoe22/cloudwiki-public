/**
 * 클라이언트용 슬러그 정규화 — 서버 src/utils/slug.ts 의 normalizeSlug 와 동일한 정책.
 * 앞뒤 공백을 제거하고, 결과의 맨 앞/뒤에 붙은 '/' 슬래시를 모두 제거한다.
 * (슬래시는 하위 문서 구분자로만 의미가 있으므로 시작/끝 위치에서는 무효 문자로 취급)
 *
 * 서버가 PUT 시 동일하게 정규화하므로, 클라이언트도 같은 정책으로 정규화해야
 * 저장 후 redirect URL (`/w/<slug>`) 가 실제 저장된 문서 키와 일치한다.
 */
export function normalizeSlug(text: string | null | undefined): string {
    if (!text) return '';
    return text.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * 슬러그에 사용할 수 없는 문자 집합 — 서버 src/routes/wiki.ts 의 SLUG_FORBIDDEN_CHARS 와 동일.
 * 새 문자/심볼 차단 정책을 바꿀 때 양쪽을 함께 수정해야 한다.
 */
export const SLUG_FORBIDDEN_CHARS = /[\[\]{}#%|<>^\x00-\x1F\x7F]/;

/** 슬러그에 금지 문자가 포함되어 있는지 검사 (서버 SLUG_FORBIDDEN_CHARS 와 동일 정책) */
export function hasSlugForbiddenChars(slug: string): boolean {
    return SLUG_FORBIDDEN_CHARS.test(slug);
}
