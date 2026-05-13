// 사이트 전역 공지 (announcements) JSON 컬럼 헬퍼.
// settings.announcements 는 표시 순서대로 정렬된 JSON 배열이며,
// settings.announcement_next_id 는 단조 증가 카운터(아직 사용되지 않은 다음 id)다.
//
// 동시성 보호: D1 은 명시적 트랜잭션이 없어 단일 행의 read-modify-write 를 atomic
// 하게 처리하려면 CAS (compare-and-swap) 패턴이 필요하다. mutateAnnouncements 가
// 현재 announcements + next_id 스냅샷을 읽고, 콜백으로 새 상태를 만든 뒤,
// 스냅샷과 일치할 때만 UPDATE 한다 (WHERE 절로 이전 값을 확인). 일치하지 않으면
// 다시 읽어서 재시도. 두 명의 관리자가 동시에 공지를 발행해도 한쪽이 덮어쓰지 않는다.

export interface Announcement {
    id: number;
    title: string;
    announcedTime: number;
    url: string | null;
    postId: number | null;
    icon: string | null;
}

/** 공지 항목 1개를 검증 + 정규화. 잘못된 값은 null 반환. */
function normalizeAnnouncement(raw: unknown): Announcement | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const id = Number(r.id);
    if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) return null;
    const title = typeof r.title === 'string' ? r.title : '';
    const announcedTime = Number(r.announcedTime) || 0;
    const url = typeof r.url === 'string' && r.url ? r.url : null;
    const postId = Number.isFinite(Number(r.postId)) && Number(r.postId) > 0
        ? Number(r.postId)
        : null;
    const icon = typeof r.icon === 'string' && r.icon ? r.icon : null;
    return { id, title, announcedTime, url, postId, icon };
}

function parseList(raw: string | null): Announcement[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.map(normalizeAnnouncement).filter((x): x is Announcement => x !== null);
    } catch {
        return [];
    }
}

export async function loadAnnouncements(db: D1Database): Promise<Announcement[]> {
    try {
        const row = await db
            .prepare('SELECT announcements FROM settings WHERE id = 1')
            .first<{ announcements: string | null }>();
        return parseList(row?.announcements ?? null);
    } catch (e) {
        console.error('loadAnnouncements failed:', e);
        return [];
    }
}

export class AnnouncementMutationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AnnouncementMutationError';
    }
}

/** 콜백에 전달되는 컨텍스트. */
export interface MutateContext {
    /** 현재 공지 목록 (정규화된 사본). 콜백에서 직접 mutate 해도 되고, 새 배열을 반환해도 된다. */
    list: Announcement[];
    /** 새 공지 ID 를 1개 발급. mutate 가 커밋되면 announcement_next_id 가 그만큼 증가한다.
     *  여러 번 호출하면 연속된 정수를 반환. */
    allocateId: () => number;
}

const MAX_MUTATE_RETRIES = 5;

/** 공지 목록을 read-modify-write 한다. CAS 로 동시 쓰기 충돌을 감지하고 최대 5회 재시도.
 *  콜백이 null 을 반환하면 변경 없이 종료 (no-op).
 *  콜백이 throw 하면 그대로 propagate (재시도 안 함). */
export async function mutateAnnouncements(
    db: D1Database,
    callback: (ctx: MutateContext) => Announcement[] | null | void,
): Promise<Announcement[]> {
    for (let attempt = 0; attempt < MAX_MUTATE_RETRIES; attempt++) {
        const row = await db
            .prepare('SELECT announcements, announcement_next_id FROM settings WHERE id = 1')
            .first<{ announcements: string | null; announcement_next_id: number | null }>();
        const rawOld = row?.announcements ?? null;
        const oldNextId = Math.max(1, Number(row?.announcement_next_id) || 1);

        const current = parseList(rawOld);
        let nextLocal = oldNextId;
        const ctx: MutateContext = {
            list: current,
            allocateId: () => {
                const id = nextLocal;
                nextLocal += 1;
                return id;
            },
        };
        const result = callback(ctx);
        const finalList = result === null ? null : (result === undefined ? ctx.list : result);
        if (finalList === null) return current; // no-op

        const newJson = JSON.stringify(finalList);

        // CAS: 이전 스냅샷과 정확히 일치하는 경우에만 UPDATE.
        // 첫 호출 (settings 행이 비어있던 경우) rawOld === null 처리를 위해 IS 도 함께 사용.
        let res;
        if (rawOld === null) {
            res = await db
                .prepare(
                    `UPDATE settings
                     SET announcements = ?, announcement_next_id = ?
                     WHERE id = 1 AND announcements IS NULL AND announcement_next_id = ?`,
                )
                .bind(newJson, nextLocal, oldNextId)
                .run();
        } else {
            res = await db
                .prepare(
                    `UPDATE settings
                     SET announcements = ?, announcement_next_id = ?
                     WHERE id = 1 AND announcements = ? AND announcement_next_id = ?`,
                )
                .bind(newJson, nextLocal, rawOld, oldNextId)
                .run();
        }
        const changed = Number(res?.meta?.changes || 0);
        if (changed === 1) return finalList;

        // 다른 writer 가 같은 시점에 settings 를 갱신해 CAS 가 실패. 짧게 백오프 후 재시도.
        await new Promise(r => setTimeout(r, 5 + Math.random() * 15));
    }
    throw new AnnouncementMutationError('announcement 갱신 충돌이 반복되어 실패했습니다. 잠시 후 다시 시도해주세요.');
}

/** 블로그 포스트 soft-delete 시 호출. 해당 postId 항목을 모두 제거.
 *  CAS 재시도로 동시 쓰기와 안전하게 합쳐진다. */
export async function removeAnnouncementByPostId(
    db: D1Database,
    postId: number,
): Promise<void> {
    await mutateAnnouncements(db, (ctx) => {
        const next = ctx.list.filter(a => a.postId !== postId);
        if (next.length === ctx.list.length) return null;
        return next;
    });
}

/** 현재 살아있는 공지 목록 — 삭제된 블로그 포스트와 연동된 항목은 제외.
 *  /api/config 응답 합성용. */
export async function loadActiveAnnouncements(db: D1Database): Promise<Announcement[]> {
    const list = await loadAnnouncements(db);
    if (list.length === 0) return [];

    const postIds = list
        .map(a => a.postId)
        .filter((x): x is number => typeof x === 'number');
    if (postIds.length === 0) return list;

    // 삭제된 포스트 ID 집합 조회 (작은 N 가정 — 보통 한 자리 수)
    const placeholders = postIds.map(() => '?').join(',');
    const stmt = db.prepare(
        `SELECT id FROM blog_posts WHERE id IN (${placeholders}) AND deleted_at IS NOT NULL`,
    ).bind(...postIds);
    const result = await stmt.all<{ id: number }>();
    const deletedSet = new Set((result.results || []).map(r => r.id));

    return list.filter(a => a.postId === null || !deletedSet.has(a.postId));
}
