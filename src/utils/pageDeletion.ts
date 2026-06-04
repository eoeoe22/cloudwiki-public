import { cleanupOrphanDiscussionMutes } from './pageAccessCleanup';

/** Cloudflare D1 단일 statement 의 바운드 파라미터 제한. */
const D1_BIND_LIMIT = 100;

function chunk<T>(arr: T[], size: number): T[][] {
    if (size <= 0) return [arr];
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        out.push(arr.slice(i, i + size));
    }
    return out;
}

/**
 * 주어진 페이지 id 들의 R2 리비전 키(r2_key)를 모두 수집한다.
 * 하드 삭제 전에 R2 본문 파일을 정리하기 위해 사용한다.
 * D1 의 100 파라미터 제한을 피하기 위해 90개씩 청크로 질의한다.
 */
export async function collectRevisionR2Keys(
    db: D1Database,
    pageIds: number[],
): Promise<string[]> {
    if (pageIds.length === 0) return [];
    const keys: string[] = [];
    for (const batch of chunk(pageIds, D1_BIND_LIMIT - 10)) {
        const ph = batch.map(() => '?').join(',');
        const rows = await db
            .prepare(
                `SELECT r2_key FROM revisions WHERE page_id IN (${ph}) AND r2_key IS NOT NULL`,
            )
            .bind(...batch)
            .all<{ r2_key: string }>();
        for (const r of rows.results) {
            if (r.r2_key) keys.push(r.r2_key);
        }
    }
    return keys;
}

/**
 * 한 페이지를 완전 하드 삭제하기 위한 정렬된 D1 statement 배열을 반환한다.
 * (실행은 호출 측이 db.batch 로 수행 — 여러 페이지의 statement 를 한데 모아 청크 배치 가능)
 *
 * D1 은 외래 키 제약을 강제하므로 자식 → 부모 순서로 삭제해야 batch 가 중단되지 않는다.
 *   - discussions.page_id, revisions.page_id 는 ON DELETE 미지정 → 명시 삭제 필요.
 *   - discussion_comments / discussion_mutes 는 discussions 를 참조 → discussions 보다 먼저 삭제.
 *   - page_categories / page_watches 는 ON DELETE CASCADE 라 자동이지만 명시해도 무해.
 *   - page_links.source_page_id / pending_edits.page_id 는 FK 미선언(plain) → orphan 정리.
 *
 * 또한 토론 알림(notifications)은 users 만 FK 로 참조하고 토론 링크를 평문으로 저장하므로,
 * 토론이 삭제되면 `/w/<slug>?mode=discussions&id=<id>` 를 가리키는 stale 알림이 남는다.
 * discussion.ts 의 토론 삭제/하드삭제 경로(`DELETE FROM notifications WHERE link=? AND type!='message'`)
 * 와 동일하게, discussions row 가 제거되기 전에 해당 토론 알림을 먼저 정리한다. 헬퍼는 pageId 만
 * 알므로 (slug URL 인코딩에 비의존적인) 전역 유일 discussion id 로 매칭한다 — 링크 끝의 `&id=`
 * 뒤 토큰을 잘라 d.id 와 정확히(정수) 비교하므로 `id=12` 가 `id=123` 에 prefix 로 잘못 매칭되지
 * 않는다. `type='message'`(쪽지)는 제외.
 *
 * page_links 는 source_type='page' + blog=0 양쪽 필터로 같은 id 의 블로그 행을 오삭제하지 않는다
 * (wiki.ts 단건 하드 삭제와 동일 시맨틱).
 */
export function buildHardDeleteStatements(
    db: D1Database,
    pageId: number,
): D1PreparedStatement[] {
    return [
        // 토론 알림 정리 (discussions row 가 살아있는 동안 먼저 실행).
        db
            .prepare(
                `DELETE FROM notifications
                  WHERE type != 'message'
                    AND instr(link, '?mode=discussions&id=') > 0
                    AND EXISTS (
                      SELECT 1 FROM discussions d
                       WHERE d.page_id = ?
                         AND substr(
                               notifications.link,
                               instr(notifications.link, '?mode=discussions&id=') + length('?mode=discussions&id=')
                             ) = CAST(d.id AS TEXT)
                    )`,
            )
            .bind(pageId),
        // 토론 댓글이 남긴 page_links(source_type='discussion_comment') orphan 정리.
        // discussion_comments DELETE 전에 수행해야 source_page_id 매칭이 가능
        // (discussion.ts 토론 하드삭제 경로와 동일 — page_links 는 FK 미선언이라 자동 정리 안 됨).
        db
            .prepare(
                `DELETE FROM page_links
                  WHERE source_type = 'discussion_comment'
                    AND source_page_id IN (
                      SELECT id FROM discussion_comments
                       WHERE discussion_id IN (SELECT id FROM discussions WHERE page_id = ?)
                    )`,
            )
            .bind(pageId),
        db
            .prepare(
                'DELETE FROM discussion_comments WHERE discussion_id IN (SELECT id FROM discussions WHERE page_id = ?)',
            )
            .bind(pageId),
        cleanupOrphanDiscussionMutes(db, pageId),
        db.prepare('DELETE FROM discussions WHERE page_id = ?').bind(pageId),
        db
            .prepare(
                "DELETE FROM page_links WHERE source_page_id = ? AND source_type = 'page' AND blog = 0",
            )
            .bind(pageId),
        db.prepare('DELETE FROM page_categories WHERE page_id = ?').bind(pageId),
        db.prepare('DELETE FROM page_watches WHERE page_id = ?').bind(pageId),
        db.prepare('DELETE FROM pending_edits WHERE page_id = ?').bind(pageId),
        db.prepare('DELETE FROM revisions WHERE page_id = ?').bind(pageId),
        db.prepare('DELETE FROM pages WHERE id = ?').bind(pageId),
    ];
}
