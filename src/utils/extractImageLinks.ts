/**
 * 본문(마크다운/HTML)에서 R2 미디어 키(`images/...`)를 추출한다.
 *
 * `src/shared/links.ts` 의 `extractPageLinks()` image 분기와 동일한 정규식을
 * 사용한다. 토론·티켓 댓글에서도 동일한 규칙으로 미디어 참조를 인덱싱해
 * 관리자 미디어 GC(`/admin/media/gc`)가 토론·티켓에서만 사용 중인 이미지를
 * 미사용으로 오인 삭제하지 않도록 보호한다.
 *
 * 반환: 중복이 제거된 r2 키 배열. 호출자가 `page_links` 테이블에
 * `link_type='image'`, `target_slug=r2_key` 로 INSERT 한다.
 */
export function extractImageLinks(content: string): string[] {
    const seen = new Set<string>();

    // 코드블럭 내부는 제외 (실제 임베드가 아니라 인용/설명일 가능성).
    const cleaned = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '');

    // 마크다운 ![alt](/media/images/...) 또는 HTML <img src="...images/..."> 등
    // 업로더(media.ts FILENAME_FORBIDDEN)는 한글/영숫자뿐 아니라 일본어/한자/악센트
    // 라틴 등 임의 유니코드를 허용하므로, 화이트리스트 대신 URL/마크다운/HTML 경계를
    // 끊는 문자만 블랙리스트로 제외한다. 비탐욕(`+?`)으로 첫 `.확장자`에서 종료.
    const imageRegex = /images\/[^\s\[\]()<>"'\\?#|^]+?\.\w+/g;
    for (const m of cleaned.matchAll(imageRegex)) {
        const r2Key = m[0].trim();
        if (!seen.has(r2Key)) seen.add(r2Key);
    }

    return Array.from(seen);
}
