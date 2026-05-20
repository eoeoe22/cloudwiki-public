import type { Env } from '../types';
import { ROLE_CASE_SQL, enrichRoles, RBAC } from './role';

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
 * 주어진 user_id 들의 (banned 보정·super_admin 격상 적용된) role 을 조회한다.
 * D1 의 100 파라미터 제한을 피하기 위해 청크 단위로 분할 질의한다.
 */
async function fetchRolesForUsers(
    db: D1Database,
    env: Env['Bindings'],
    userIds: number[],
): Promise<Array<{ id: number; role: string }>> {
    if (userIds.length === 0) return [];
    const out: Array<{ id: number; role: string }> = [];
    for (const batch of chunk(userIds, D1_BIND_LIMIT)) {
        const placeholders = batch.map(() => '?').join(',');
        const rows = await db
            .prepare(
                `SELECT u.id, u.email, ${ROLE_CASE_SQL} AS role
                 FROM users u
                 WHERE u.id IN (${placeholders})`,
            )
            .bind(...batch)
            .all<{ id: number; email: string; role: string }>();
        enrichRoles(rows.results as any[], 'role', 'email', env);
        for (const r of rows.results) out.push({ id: r.id, role: r.role });
    }
    return out;
}

/**
 * 페이지가 비공개 또는 소프트삭제될 때, 해당 페이지를 더 이상 열람할 수 없는 유저의
 * page_watches / discussion_mutes row 를 일회성으로 제거한다.
 *
 * mode === 'private'  : 'wiki:private' 권한 보유자만 유지
 * mode === 'deleted'  : 'admin:access' 권한 보유자만 유지
 *
 * 정리는 단방향이다 — 비공개 해제·복원되어도 자동 복구되지 않으며 유저가 다시 설정해야 한다.
 */
export async function cleanupUnauthorizedSubscriptions(
    db: D1Database,
    env: Env['Bindings'],
    rbac: RBAC,
    pageId: number,
    mode: 'private' | 'deleted',
): Promise<void> {
    const permission = mode === 'private' ? 'wiki:private' : 'admin:access';

    try {
        const watchUsers = await db
            .prepare('SELECT user_id FROM page_watches WHERE page_id = ?')
            .bind(pageId)
            .all<{ user_id: number }>();
        const muteUsers = await db
            .prepare(
                `SELECT DISTINCT dm.user_id
                 FROM discussion_mutes dm
                 JOIN discussions d ON dm.discussion_id = d.id
                 WHERE d.page_id = ?`,
            )
            .bind(pageId)
            .all<{ user_id: number }>();

        const userIds = new Set<number>();
        for (const r of watchUsers.results) userIds.add(r.user_id);
        for (const r of muteUsers.results) userIds.add(r.user_id);
        if (userIds.size === 0) return;

        const roleRows = await fetchRolesForUsers(db, env, Array.from(userIds));
        const unauthorized = roleRows
            .filter(r => !rbac.can(r.role, permission))
            .map(r => r.id);
        if (unauthorized.length === 0) return;

        // DELETE 한 statement 당 `pageId` 1개 + user_id 목록을 함께 바인드하므로
        // user_id 청크 크기는 D1_BIND_LIMIT - 1 로 둔다.
        const stmts: D1PreparedStatement[] = [];
        for (const batch of chunk(unauthorized, D1_BIND_LIMIT - 1)) {
            const ph = batch.map(() => '?').join(',');
            stmts.push(
                db
                    .prepare(
                        `DELETE FROM page_watches WHERE page_id = ? AND user_id IN (${ph})`,
                    )
                    .bind(pageId, ...batch),
            );
            stmts.push(
                db
                    .prepare(
                        `DELETE FROM discussion_mutes
                         WHERE user_id IN (${ph})
                           AND discussion_id IN (SELECT id FROM discussions WHERE page_id = ?)`,
                    )
                    .bind(...batch, pageId),
            );
        }
        await db.batch(stmts);
    } catch (e) {
        console.error('cleanupUnauthorizedSubscriptions failed:', e);
    }
}

/**
 * hard delete 시 사용. pages 가 삭제되면 page_watches 는 FK ON DELETE CASCADE 로
 * 자동 정리되지만, discussion_mutes 는 discussions 를 참조하고 hard delete 가
 * discussions 를 정리하지 않으므로 orphan row 가 남는다. 이 statement 를 hard
 * delete batch 에 합류시켜 명시적으로 정리한다.
 *
 * 주의: hard delete 가 discussions 자체를 정리하지 않는 한, 이론적으로 orphan
 * discussion 에 댓글이 추가될 수 있다. discussion.ts dispatch 가 LEFT JOIN 결과
 * 의 slug 가 NULL 일 때 알림 발송을 생략하도록 가드되어 있어, mute 가 지워진 유저가
 * 알림을 받는 회귀는 발생하지 않는다.
 */
export function cleanupOrphanDiscussionMutes(
    db: D1Database,
    pageId: number,
): D1PreparedStatement {
    return db
        .prepare(
            'DELETE FROM discussion_mutes WHERE discussion_id IN (SELECT id FROM discussions WHERE page_id = ?)',
        )
        .bind(pageId);
}

/**
 * 주어진 user_id 집합에서 페이지에 대한 열람 권한이 있는 유저만 반환한다.
 * 토론 댓글 알림 dispatch 단계에서 비공개·삭제 페이지의 권한 없는 수신자를
 * 걸러내기 위해 사용한다.
 */
export async function filterAuthorizedUserIds(
    db: D1Database,
    env: Env['Bindings'],
    rbac: RBAC,
    userIds: number[],
    permission: string,
): Promise<number[]> {
    if (userIds.length === 0) return [];
    try {
        const roleRows = await fetchRolesForUsers(db, env, userIds);
        return roleRows.filter(r => rbac.can(r.role, permission)).map(r => r.id);
    } catch (e) {
        console.error('filterAuthorizedUserIds failed:', e);
        // 안전 기본값: 권한 확인 실패 시 알림 발송하지 않음.
        return [];
    }
}
