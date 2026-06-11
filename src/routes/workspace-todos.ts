import { Hono, type Context } from 'hono';
import type { Env } from '../types';
import type { RBAC } from '../utils/role';
import { requireAuth } from '../middleware/session';
import { safeJSON } from '../utils/json';
import { isWorkspacesEnabled } from '../utils/workspace';
import { getWorkspaceAccessBySlug } from '../utils/workspaceAcl';
import type { WorkspaceAccess } from '../utils/workspaceAcl';
import type { Workspace } from '../shared/models';

/**
 * 워크스페이스 TODO 리스트 API (/api/ws/:wslug/todos...).
 *
 * 설계 제약 (워크스페이스 격리):
 *   - workspace_todos 테이블만 사용. 전역 데이터를 건드리지 않는다.
 *   - 리비전·링크 인덱싱·주시자 알림·캐시 무효화 없음(편집기 없는 단순 목록).
 *   - 모든 응답은 `private, no-store` — 비공개 데이터.
 *   - PATCH 로 checked/content/archived 부분 업데이트.
 */

const wsTodos = new Hono<Env>();

const TODO_MAX_LENGTH = 2000;
const BULK_MAX_IDS = 200;

// 기능 토글 가드 + 공통 응답 캐시 정책. 비활성 시 모든 경로가 404.
wsTodos.use('/api/ws/:wslug/todos', async (c, next) => {
    if (!isWorkspacesEnabled(c.env)) {
        return c.json({ error: '워크스페이스 기능이 비활성화되어 있습니다.' }, 404);
    }
    await next();
    c.header('Cache-Control', 'private, no-store');
});
wsTodos.use('/api/ws/:wslug/todos/*', async (c, next) => {
    if (!isWorkspacesEnabled(c.env)) {
        return c.json({ error: '워크스페이스 기능이 비활성화되어 있습니다.' }, 404);
    }
    await next();
    c.header('Cache-Control', 'private, no-store');
});

/** :wslug 로 워크스페이스 + 접근 권한 해석. workspace null 이면 호출 측에서 404. */
async function resolveWs(c: Context<Env>): Promise<{ workspace: Workspace | null; access: WorkspaceAccess }> {
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    return getWorkspaceAccessBySlug(c.env.DB, c.req.param('wslug') || '', user, rbac);
}

/** 읽기 거부 응답 — 게스트는 401, 로그인 사용자는 403. */
function denyRead(c: Context<Env>) {
    if (!c.get('user')) return c.json({ error: '로그인이 필요합니다.' }, 401);
    return c.json({ error: '이 워크스페이스를 열람할 권한이 없습니다.' }, 403);
}

// ============================================================
// 목록
// ============================================================

/**
 * GET /api/ws/:wslug/todos — TODO 목록.
 * 쿼리 파라미터:
 *   archived=1  : 보관된 항목만 (기본: 활성 항목만)
 *   sort=created_asc|created_desc  : 정렬 순서 (기본: created_asc)
 *   filter=checked|unchecked  : 완료 상태 필터
 */
wsTodos.get('/api/ws/:wslug/todos', requireAuth, async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canRead) return denyRead(c);

    const archived = c.req.query('archived') === '1';
    const sort = c.req.query('sort');
    const filter = c.req.query('filter');

    const sortDir = sort === 'created_desc' ? 'DESC' : 'ASC';

    const conditions: string[] = ['t.workspace_id = ?', 't.deleted_at IS NULL'];
    const binds: unknown[] = [workspace.id];

    if (archived) {
        conditions.push('t.archived_at IS NOT NULL');
    } else {
        conditions.push('t.archived_at IS NULL');
    }

    if (filter === 'checked') {
        conditions.push('t.checked = 1');
    } else if (filter === 'unchecked') {
        conditions.push('t.checked = 0');
    }

    const rows = await c.env.DB
        .prepare(
            `SELECT t.id, t.content, t.checked, t.archived_at, t.created_by, t.created_at, t.updated_at,
                    u.name AS created_by_name
             FROM workspace_todos t
             LEFT JOIN users u ON u.id = t.created_by
             WHERE ${conditions.join(' AND ')}
             ORDER BY t.created_at ${sortDir}, t.id ${sortDir}
             LIMIT 1000`
        )
        .bind(...binds)
        .all();
    return c.json(safeJSON({ todos: rows.results || [], can_write: access.canWrite }));
});

// ============================================================
// 생성
// ============================================================

/**
 * POST /api/ws/:wslug/todos — TODO 추가 (canWrite).
 * body: { content: string }
 */
wsTodos.post('/api/ws/:wslug/todos', requireAuth, async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canWrite) return c.json({ error: '이 워크스페이스에 항목을 추가할 권한이 없습니다.' }, 403);
    const user = c.get('user')!;

    const body = await c.req.json().catch(() => null) as { content?: unknown } | null;
    const content = typeof body?.content === 'string' ? body.content.trim() : '';
    if (!content) return c.json({ error: '내용을 입력해주세요.' }, 400);
    if (content.length > TODO_MAX_LENGTH) {
        return c.json({ error: `내용은 최대 ${TODO_MAX_LENGTH}자까지 입력할 수 있습니다.` }, 400);
    }

    const res = await c.env.DB
        .prepare('INSERT INTO workspace_todos (workspace_id, content, checked, created_by) VALUES (?, ?, 0, ?)')
        .bind(workspace.id, content, user.id)
        .run();
    return c.json(safeJSON({ ok: true, id: res.meta.last_row_id }));
});

// ============================================================
// 수정 (checked 토글 또는 content 변경 또는 archived 토글)
// ============================================================

/**
 * PATCH /api/ws/:wslug/todos/:id — TODO 수정 (canWrite).
 * body: { checked?: boolean, content?: string, archived?: boolean }
 */
wsTodos.patch('/api/ws/:wslug/todos/:id', requireAuth, async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canWrite) return c.json({ error: '이 워크스페이스의 항목을 수정할 권한이 없습니다.' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: '항목을 찾을 수 없습니다.' }, 404);

    const body = await c.req.json().catch(() => null) as { checked?: unknown; content?: unknown; archived?: unknown } | null;
    if (!body || typeof body !== 'object') return c.json({ error: '유효하지 않은 요청입니다.' }, 400);

    const sets: string[] = [];
    const binds: unknown[] = [];

    if ('checked' in body) {
        if (typeof body.checked !== 'boolean') {
            return c.json({ error: 'checked 는 true/false 여야 합니다.' }, 400);
        }
        sets.push('checked = ?');
        binds.push(body.checked ? 1 : 0);
    }
    if ('content' in body) {
        const content = typeof body.content === 'string' ? body.content.trim() : '';
        if (!content) return c.json({ error: '내용을 입력해주세요.' }, 400);
        if (content.length > TODO_MAX_LENGTH) {
            return c.json({ error: `내용은 최대 ${TODO_MAX_LENGTH}자까지 입력할 수 있습니다.` }, 400);
        }
        sets.push('content = ?');
        binds.push(content);
    }
    if ('archived' in body) {
        if (typeof body.archived !== 'boolean') {
            return c.json({ error: 'archived 는 true/false 여야 합니다.' }, 400);
        }
        sets.push('archived_at = CASE WHEN ? THEN unixepoch() ELSE NULL END');
        binds.push(body.archived ? 1 : 0);
    }
    if (!sets.length) return c.json({ error: '변경할 내용이 없습니다.' }, 400);

    sets.push('updated_at = unixepoch()');
    binds.push(id, workspace.id);

    const res = await c.env.DB
        .prepare(`UPDATE workspace_todos SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`)
        .bind(...binds)
        .run();
    if (!res.meta.changes) return c.json({ error: '항목을 찾을 수 없습니다.' }, 404);
    return c.json({ ok: true });
});

// ============================================================
// 일괄 처리
// ============================================================

/**
 * POST /api/ws/:wslug/todos/bulk — 일괄 보관/복원/삭제 (canWrite).
 * body: { ids: number[], action: 'archive' | 'unarchive' | 'delete' }
 */
wsTodos.post('/api/ws/:wslug/todos/bulk', requireAuth, async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canWrite) return c.json({ error: '이 워크스페이스의 항목을 수정할 권한이 없습니다.' }, 403);

    const body = await c.req.json().catch(() => null) as { ids?: unknown; action?: unknown } | null;
    if (!body || typeof body !== 'object') return c.json({ error: '유효하지 않은 요청입니다.' }, 400);

    if (!Array.isArray(body.ids) || body.ids.length === 0) {
        return c.json({ error: '처리할 항목을 선택해주세요.' }, 400);
    }
    if (body.ids.length > BULK_MAX_IDS) {
        return c.json({ error: `한 번에 최대 ${BULK_MAX_IDS}개까지 처리할 수 있습니다.` }, 400);
    }
    const ids = (body.ids as unknown[]).map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (ids.length === 0) return c.json({ error: '유효한 항목 ID가 없습니다.' }, 400);

    const action = body.action;
    if (action !== 'archive' && action !== 'unarchive' && action !== 'delete') {
        return c.json({ error: '유효하지 않은 action 입니다.' }, 400);
    }

    const placeholders = ids.map(() => '?').join(', ');

    let sql: string;
    let binds: unknown[];
    if (action === 'archive') {
        sql = `UPDATE workspace_todos SET archived_at = unixepoch(), updated_at = unixepoch() WHERE id IN (${placeholders}) AND workspace_id = ? AND deleted_at IS NULL`;
        binds = [...ids, workspace.id];
    } else if (action === 'unarchive') {
        sql = `UPDATE workspace_todos SET archived_at = NULL, updated_at = unixepoch() WHERE id IN (${placeholders}) AND workspace_id = ? AND deleted_at IS NULL`;
        binds = [...ids, workspace.id];
    } else {
        sql = `UPDATE workspace_todos SET deleted_at = unixepoch() WHERE id IN (${placeholders}) AND workspace_id = ? AND deleted_at IS NULL`;
        binds = [...ids, workspace.id];
    }

    const res = await c.env.DB.prepare(sql).bind(...binds).run();
    return c.json({ ok: true, changes: res.meta.changes });
});

// ============================================================
// 삭제 (소프트)
// ============================================================

/**
 * DELETE /api/ws/:wslug/todos/:id — TODO 소프트 삭제 (canWrite).
 */
wsTodos.delete('/api/ws/:wslug/todos/:id', requireAuth, async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canWrite) return c.json({ error: '이 워크스페이스의 항목을 삭제할 권한이 없습니다.' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: '항목을 찾을 수 없습니다.' }, 404);

    const res = await c.env.DB
        .prepare('UPDATE workspace_todos SET deleted_at = unixepoch() WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL')
        .bind(id, workspace.id)
        .run();
    if (!res.meta.changes) return c.json({ error: '항목을 찾을 수 없습니다.' }, 404);
    return c.json({ ok: true });
});

export default wsTodos;
