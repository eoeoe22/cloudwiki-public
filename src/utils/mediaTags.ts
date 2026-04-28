/**
 * media_tags 테이블 조회 유틸리티.
 * 이미지 문서 API/SSR/목록 응답에서 태그를 읽을 때 공용으로 사용한다.
 * 정렬 규칙(ORDER BY tag ASC) 및 빈 입력 처리를 일관되게 유지하기 위해 집중화한다.
 */

/**
 * 태그 문자열 규칙: 카테고리와 동일 (한글/영숫자/공백/_/./-).
 * 최대 20개, 각 50자 이내. trim, 중복 제거, 정규식 통과 항목만 유효.
 * 입력은 배열 / JSON 배열 문자열 / 쉼표구분 문자열을 모두 허용한다.
 */
const TAG_VALID_RE = /^[가-힣a-zA-Z0-9 _.-]+$/;
const TAG_MAX_COUNT = 20;
const TAG_MAX_LENGTH = 50;

export function sanitizeTags(input: unknown): string[] {
    let raw: unknown[] = [];
    if (Array.isArray(input)) {
        raw = input;
    } else if (typeof input === 'string') {
        const s = input.trim();
        if (!s) return [];
        if (s.startsWith('[')) {
            try {
                const parsed = JSON.parse(s);
                if (Array.isArray(parsed)) raw = parsed;
            } catch { /* fallthrough to comma split */ }
        }
        if (raw.length === 0) {
            raw = s.split(',');
        }
    } else {
        return [];
    }

    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of raw) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim();
        if (!trimmed || trimmed.length > TAG_MAX_LENGTH) continue;
        if (!TAG_VALID_RE.test(trimmed)) continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
        if (out.length >= TAG_MAX_COUNT) break;
    }
    return out;
}

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
