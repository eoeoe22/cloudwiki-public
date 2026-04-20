/**
 * media_tags 테이블 조회 유틸리티.
 * 이미지 문서 API/SSR/목록 응답에서 태그를 읽을 때 공용으로 사용한다.
 * 정렬 규칙(ORDER BY tag ASC) 및 빈 입력 처리를 일관되게 유지하기 위해 집중화한다.
 */

/**
 * 단일 이미지의 태그 목록을 오름차순으로 조회한다.
 * 태그가 없으면 빈 배열을 반환한다.
 */
export async function fetchMediaTags(db: D1Database, mediaId: number): Promise<string[]> {
    const { results } = await db
        .prepare('SELECT tag FROM media_tags WHERE media_id = ? ORDER BY tag ASC')
        .bind(mediaId)
        .all<{ tag: string }>();
    return (results || []).map(r => r.tag);
}

/**
 * 여러 이미지의 태그를 한 번에 조회해 media_id → string[] 맵으로 돌려준다.
 * 목록 응답에서 N+1 쿼리를 방지하기 위해 사용한다.
 */
export async function fetchMediaTagMap(db: D1Database, mediaIds: number[]): Promise<Map<number, string[]>> {
    const map = new Map<number, string[]>();
    if (mediaIds.length === 0) return map;
    const placeholders = mediaIds.map(() => '?').join(',');
    const { results } = await db
        .prepare(`SELECT media_id, tag FROM media_tags WHERE media_id IN (${placeholders}) ORDER BY tag ASC`)
        .bind(...mediaIds)
        .all<{ media_id: number; tag: string }>();
    for (const row of results || []) {
        const arr = map.get(row.media_id);
        if (arr) arr.push(row.tag);
        else map.set(row.media_id, [row.tag]);
    }
    return map;
}

/**
 * media_id의 태그 집합을 입력 배열로 완전 교체한다.
 * 이미 trim/중복 제거/검증된 태그 배열을 기대한다.
 */
export async function replaceMediaTags(db: D1Database, mediaId: number, tags: string[]): Promise<void> {
    const stmts = [db.prepare('DELETE FROM media_tags WHERE media_id = ?').bind(mediaId)];
    for (const tag of tags) {
        stmts.push(db.prepare('INSERT OR IGNORE INTO media_tags (media_id, tag) VALUES (?, ?)').bind(mediaId, tag));
    }
    await db.batch(stmts);
}
