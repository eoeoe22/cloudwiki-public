/**
 * Slug를 정규화합니다.
 * 앞뒤 공백만 제거하고 원래 대소문자를 유지합니다.
 * 예: "Foo Bar" -> "Foo Bar"
 */
export function normalizeSlug(text: string): string {
    return text.trim();
}

/**
 * ENABLED_EXTENSIONS에 등록된 네임스페이스인 경우에만 본문을 DB에 저장하지 않고 R2에만 저장할지 여부를 반환합니다.
 * @param slug 문서 슬러그
 * @param enabledExtensions 활성화된 익스텐션(네임스페이스) 목록
 */
export function isR2OnlyNamespace(slug: string, enabledExtensions: string[]): boolean {
    if (enabledExtensions.length === 0) return false;
    const colonIndex = slug.indexOf(':');
    if (colonIndex === -1) return false; // 일반 문서
    const namespace = slug.substring(0, colonIndex);
    return enabledExtensions.includes(namespace);
}

/** MCP raw 읽기 허용 네임스페이스 목록 */
const MCP_READABLE_NAMESPACES = ['틀', '템플릿', '유저'];

/**
 * MCP 도구(get_toc/read_document/read_section)에서 해당 slug의 raw 데이터를
 * 읽을 수 있는지 여부를 반환합니다.
 * 콜론이 없는 일반 문서는 허용, 허용 네임스페이스(틀/템플릿/유저)도 허용,
 * 그 외 네임스페이스는 차단합니다.
 */
export function isMcpReadableSlug(slug: string): boolean {
    const colonIndex = slug.indexOf(':');
    if (colonIndex === -1) return true; // 일반 문서는 허용
    const namespace = slug.substring(0, colonIndex);
    return MCP_READABLE_NAMESPACES.includes(namespace);
}
