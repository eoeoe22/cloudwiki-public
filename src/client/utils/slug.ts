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
