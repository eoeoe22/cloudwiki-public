/**
 * 관리자 전용 네임스페이스(prefix) 검사 유틸.
 * admin_namespaces 테이블에 등록된 prefix 로 시작하는 슬러그는 관리자만 사용 가능.
 */

/**
 * 주어진 slug 가 등록된 관리자 전용 prefix 로 시작하는지 확인하고,
 * 일치하는 prefix 문자열을 반환한다. 일치하는 prefix 가 없으면 null.
 *
 * 비교는 대소문자 구분(case-sensitive) 한다 — slug 자체가 표시 이름이며
 * 대소문자를 보존하기 때문이다.
 */
export async function matchAdminNamespace(db: D1Database, slug: string): Promise<string | null> {
    if (!slug) return null;
    const { results } = await db
        .prepare('SELECT prefix FROM admin_namespaces')
        .all<{ prefix: string }>();
    if (!results || results.length === 0) return null;
    for (const row of results) {
        if (row.prefix && slug.startsWith(row.prefix)) {
            return row.prefix;
        }
    }
    return null;
}
