import { Hono, type Context } from 'hono';
import type { Env } from '../types';
import { requireAuth } from '../middleware/session';
import { RBAC } from '../utils/role';
import { isWorkspacesEnabled, getWorkspaceCreator, getWorkspaceMaxPerUser } from '../utils/workspace';
import { getWorkspaceAccessBySlug } from '../utils/workspaceAcl';
import { SLUG_FORBIDDEN_CHARS } from './wiki';
import type { Workspace } from '../shared/models';

/**
 * 개인 워크스페이스 — 워크스페이스/멤버 관리 라우트 (Stage 2).
 *
 * 워크스페이스 자체의 CRUD(생성 권한·소유 상한 게이팅 포함)와 멤버 관리
 * (초대/역할 변경/추방/소유권 이전)를 담당한다. 워크스페이스 문서/미디어 CRUD 는
 * 각각 workspace-pages.ts / workspace-media.ts 가 담당한다.
 *
 * 모든 라우트는 `isWorkspacesEnabled` 토글이 꺼져 있으면 404 로 응답한다(기능 숨김).
 * 접근 제어는 `getWorkspaceAccessBySlug`(workspaces.owner_id + workspace_members 기반)로
 * 평가한다. owner 는 workspaces.owner_id 단일 소스이며 멤버 테이블에는 editor|viewer 만 둔다.
 */

const workspace = new Hono<Env>();

/** 워크스페이스 slug 검증: 공백/슬래시/콜론/슬러그 금지문자 불허, 1~64자. */
const WS_SLUG_MAX = 64;
function validateWorkspaceSlug(raw: string): { ok: true; value: string } | { ok: false; error: string } {
    const trimmed = (raw || '').trim();
    if (!trimmed) return { ok: false, error: '워크스페이스 제목을 입력해주세요.' };
    if (trimmed.length > WS_SLUG_MAX) return { ok: false, error: `워크스페이스 제목은 최대 ${WS_SLUG_MAX}자까지 가능합니다.` };
    if (/[\s/:]/.test(trimmed)) return { ok: false, error: '워크스페이스 제목에는 공백·슬래시(/)·콜론(:)을 사용할 수 없습니다.' };
    if (SLUG_FORBIDDEN_CHARS.test(trimmed)) return { ok: false, error: '워크스페이스 제목에 사용할 수 없는 문자가 포함되어 있습니다.' };
    return { ok: true, value: trimmed };
}

const WS_NAME_MAX = 100;
function normalizeWorkspaceName(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const t = raw.trim();
    if (!t || t.length > WS_NAME_MAX) return null;
    return t;
}

/** 기능 토글 가드: off 면 404. 라우트 본문 진입 전에 호출. */
function ensureEnabled(c: Context<Env>): Response | null {
    if (!isWorkspacesEnabled(c.env)) {
        return c.json({ error: '워크스페이스 기능이 비활성화되어 있습니다.' }, 404);
    }
    return null;
}

/**
 * GET /api/workspaces — 내가 소유했거나 참가한 워크스페이스 목록.
 */
workspace.get('/api/workspaces', requireAuth, async (c) => {
    const gate = ensureEnabled(c); if (gate) return gate;
    const user = c.get('user')!;
    const db = c.env.DB;

    const owned = await db.prepare(
        `SELECT id, slug, name, owner_id, created_at
         FROM workspaces
         WHERE owner_id = ? AND deleted_at IS NULL
         ORDER BY created_at DESC`
    ).bind(user.id).all<Workspace>();

    const joined = await db.prepare(
        `SELECT w.id, w.slug, w.name, w.owner_id, w.created_at, m.role AS my_role
         FROM workspace_members m
         JOIN workspaces w ON w.id = m.workspace_id
         WHERE m.user_id = ? AND w.deleted_at IS NULL AND w.owner_id != ?
         ORDER BY w.created_at DESC`
    ).bind(user.id, user.id).all<Workspace & { my_role: string }>();

    const creator = getWorkspaceCreator(c.env);
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = rbac.can(user.role, 'admin:access');
    const maxPerUser = getWorkspaceMaxPerUser(c.env);
    const canCreate = (creator === 'admin' ? isAdmin : true) &&
        (isAdmin || (owned.results?.length ?? 0) < maxPerUser);

    return c.json({
        owned: owned.results ?? [],
        joined: joined.results ?? [],
        can_create: canCreate,
        max_per_user: maxPerUser,
    });
});

/**
 * POST /api/workspaces — 워크스페이스 생성.
 * 생성 권한(WORKSPACE_CREATOR)·소유 상한(WORKSPACE_MAX_PER_USER, admin 무제한) 게이팅.
 */
workspace.post('/api/workspaces', requireAuth, async (c) => {
    const gate = ensureEnabled(c); if (gate) return gate;
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = rbac.can(user.role, 'admin:access');

    // 생성 권한
    if (getWorkspaceCreator(c.env) === 'admin' && !isAdmin) {
        return c.json({ error: '워크스페이스 생성 권한이 없습니다. (관리자 전용)' }, 403);
    }

    const body = await c.req.json().catch(() => null) as { slug?: string; name?: string } | null;
    if (!body) return c.json({ error: '유효하지 않은 요청입니다.' }, 400);

    const slugV = validateWorkspaceSlug(body.slug || '');
    if (!slugV.ok) return c.json({ error: slugV.error }, 400);
    const name = normalizeWorkspaceName(body.name) ?? slugV.value;

    const db = c.env.DB;
    const max = getWorkspaceMaxPerUser(c.env);

    // slug 중복 사전 검사 — 깔끔한 409 를 위해. 경합은 아래 UNIQUE 제약이 최종 차단한다.
    const dup = await db.prepare('SELECT id FROM workspaces WHERE slug = ?').bind(slugV.value).first();
    if (dup) return c.json({ error: '이미 사용 중인 워크스페이스 제목입니다.' }, 409);

    try {
        // 소유 상한(admin 무제한)은 단일 문장 조건부 INSERT 로 원자 적용한다 —
        // 별도 COUNT 후 INSERT 의 TOCTOU(동시 생성으로 상한 초과)를 차단한다.
        // 비-admin: 현재 소유 수가 max 미만일 때만 INSERT(아니면 0행 → 상한 초과).
        const res = isAdmin
            ? await db.prepare(
                'INSERT INTO workspaces (slug, name, owner_id) VALUES (?, ?, ?)'
            ).bind(slugV.value, name, user.id).run()
            : await db.prepare(
                `INSERT INTO workspaces (slug, name, owner_id)
                 SELECT ?, ?, ?
                 WHERE (SELECT COUNT(*) FROM workspaces WHERE owner_id = ? AND deleted_at IS NULL) < ?`
            ).bind(slugV.value, name, user.id, user.id, max).run();
        if (!res.meta?.changes) {
            // 비-admin 이면서 조건(WHERE)이 거짓 → 상한 초과로 0행 삽입.
            return c.json({ error: `소유할 수 있는 워크스페이스는 최대 ${max}개입니다.` }, 403);
        }
        const id = Number(res.meta?.last_row_id ?? 0);
        return c.json({ ok: true, id, slug: slugV.value, name });
    } catch (e: any) {
        if (String(e?.message || '').includes('UNIQUE')) {
            return c.json({ error: '이미 사용 중인 워크스페이스 제목입니다.' }, 409);
        }
        throw e;
    }
});

/**
 * GET /api/ws/:wslug — 워크스페이스 메타 + 내 권한 + 통계.
 */
workspace.get('/api/ws/:wslug', requireAuth, async (c) => {
    const gate = ensureEnabled(c); if (gate) return gate;
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;
    const { workspace: ws, access } = await getWorkspaceAccessBySlug(db, c.req.param('wslug'), user, rbac);
    if (!ws) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canRead) return c.json({ error: '접근 권한이 없습니다.' }, 403);

    const stats = await db.batch([
        db.prepare('SELECT COUNT(*) AS n FROM workspace_pages WHERE workspace_id = ? AND deleted_at IS NULL').bind(ws.id),
        db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM workspace_media WHERE workspace_id = ?').bind(ws.id),
        db.prepare('SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ?').bind(ws.id),
    ]);
    const pageCount = (stats[0].results?.[0] as any)?.n ?? 0;
    const mediaRow = (stats[1].results?.[0] as any) ?? { n: 0, bytes: 0 };
    const memberCount = (stats[2].results?.[0] as any)?.n ?? 0;

    return c.json({
        workspace: { id: ws.id, slug: ws.slug, name: ws.name, owner_id: ws.owner_id, created_at: ws.created_at },
        access: { role: access.role, canRead: access.canRead, canWrite: access.canWrite, canManage: access.canManage },
        stats: {
            pages: pageCount,
            media: mediaRow.n,
            media_bytes: mediaRow.bytes,
            members: memberCount + 1, // owner 포함
        },
    });
});

/**
 * PUT /api/ws/:wslug — 워크스페이스 이름/주소 변경 (canManage).
 */
workspace.put('/api/ws/:wslug', requireAuth, async (c) => {
    const gate = ensureEnabled(c); if (gate) return gate;
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;
    const { workspace: ws, access } = await getWorkspaceAccessBySlug(db, c.req.param('wslug'), user, rbac);
    if (!ws) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canManage) return c.json({ error: '관리 권한이 없습니다.' }, 403);

    const body = await c.req.json().catch(() => null) as { slug?: string; name?: string } | null;
    if (!body) return c.json({ error: '유효하지 않은 요청입니다.' }, 400);

    let newSlug = ws.slug;
    if (typeof body.slug === 'string' && body.slug.trim() !== ws.slug) {
        const v = validateWorkspaceSlug(body.slug);
        if (!v.ok) return c.json({ error: v.error }, 400);
        const dup = await db.prepare('SELECT id FROM workspaces WHERE slug = ? AND id != ?').bind(v.value, ws.id).first();
        if (dup) return c.json({ error: '이미 사용 중인 워크스페이스 제목입니다.' }, 409);
        newSlug = v.value;
    }
    let newName = ws.name;
    if (body.name !== undefined) {
        const n = normalizeWorkspaceName(body.name);
        if (!n) return c.json({ error: '워크스페이스 대체 제목이 유효하지 않습니다.' }, 400);
        newName = n;
    }

    await db.prepare('UPDATE workspaces SET slug = ?, name = ? WHERE id = ?')
        .bind(newSlug, newName, ws.id).run();
    return c.json({ ok: true, slug: newSlug, name: newName });
});

/**
 * DELETE /api/ws/:wslug — 워크스페이스 소프트 삭제 (canManage).
 * 소속 문서/미디어는 workspaces.deleted_at 로 접근이 차단되므로 cascade 없이 동작한다.
 */
workspace.delete('/api/ws/:wslug', requireAuth, async (c) => {
    const gate = ensureEnabled(c); if (gate) return gate;
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;
    const { workspace: ws, access } = await getWorkspaceAccessBySlug(db, c.req.param('wslug'), user, rbac);
    if (!ws) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canManage) return c.json({ error: '관리 권한이 없습니다.' }, 403);

    await db.prepare('UPDATE workspaces SET deleted_at = unixepoch() WHERE id = ?').bind(ws.id).run();
    return c.json({ ok: true });
});

// ===== 멤버 관리 =====

/**
 * GET /api/ws/:wslug/members — owner + 멤버 목록 (canRead).
 */
workspace.get('/api/ws/:wslug/members', requireAuth, async (c) => {
    const gate = ensureEnabled(c); if (gate) return gate;
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;
    const { workspace: ws, access } = await getWorkspaceAccessBySlug(db, c.req.param('wslug'), user, rbac);
    if (!ws) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canRead) return c.json({ error: '접근 권한이 없습니다.' }, 403);

    const owner = await db.prepare('SELECT id, name, picture FROM users WHERE id = ?').bind(ws.owner_id).first<{ id: number; name: string; picture: string | null }>();
    const members = await db.prepare(
        `SELECT m.user_id AS id, u.name, u.picture, m.role, m.created_at
         FROM workspace_members m JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = ?
         ORDER BY m.created_at ASC`
    ).bind(ws.id).all<{ id: number; name: string; picture: string | null; role: string; created_at: number }>();

    return c.json({
        owner: owner ? { ...owner, role: 'owner' } : null,
        members: members.results ?? [],
        can_manage: access.canManage,
    });
});

/**
 * GET /api/ws/:wslug/members/search?q= — 초대 대상 사용자 검색 (canManage).
 */
workspace.get('/api/ws/:wslug/members/search', requireAuth, async (c) => {
    const gate = ensureEnabled(c); if (gate) return gate;
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;
    const { workspace: ws, access } = await getWorkspaceAccessBySlug(db, c.req.param('wslug'), user, rbac);
    if (!ws) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canManage) return c.json({ error: '관리 권한이 없습니다.' }, 403);

    const q = (c.req.query('q') || '').trim();
    if (q.length < 1) return c.json({ results: [] });
    const rows = await db.prepare(
        `SELECT id, name, picture FROM users
         WHERE name LIKE ? AND role NOT IN ('banned','deleted') AND id != ?
         LIMIT 10`
    ).bind(`%${q}%`, ws.owner_id).all<{ id: number; name: string; picture: string | null }>();
    return c.json({ results: rows.results ?? [] });
});

/**
 * POST /api/ws/:wslug/members — 멤버 추가/초대 (canManage). body {user_id, role}.
 */
workspace.post('/api/ws/:wslug/members', requireAuth, async (c) => {
    const gate = ensureEnabled(c); if (gate) return gate;
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;
    const { workspace: ws, access } = await getWorkspaceAccessBySlug(db, c.req.param('wslug'), user, rbac);
    if (!ws) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canManage) return c.json({ error: '관리 권한이 없습니다.' }, 403);

    const body = await c.req.json().catch(() => null) as { user_id?: number; role?: string } | null;
    const targetId = Number(body?.user_id);
    const role = body?.role === 'editor' ? 'editor' : 'viewer';
    if (!Number.isInteger(targetId) || targetId <= 0) return c.json({ error: '대상 사용자가 유효하지 않습니다.' }, 400);
    if (targetId === ws.owner_id) return c.json({ error: '소유자는 멤버로 추가할 수 없습니다.' }, 400);

    const target = await db.prepare("SELECT id FROM users WHERE id = ? AND role NOT IN ('banned','deleted')").bind(targetId).first();
    if (!target) return c.json({ error: '대상 사용자를 찾을 수 없습니다.' }, 404);

    await db.prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)
         ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`
    ).bind(ws.id, targetId, role).run();
    return c.json({ ok: true, user_id: targetId, role });
});

/**
 * PATCH /api/ws/:wslug/members/:userId — 역할 변경 (canManage).
 */
workspace.patch('/api/ws/:wslug/members/:userId', requireAuth, async (c) => {
    const gate = ensureEnabled(c); if (gate) return gate;
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;
    const { workspace: ws, access } = await getWorkspaceAccessBySlug(db, c.req.param('wslug'), user, rbac);
    if (!ws) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canManage) return c.json({ error: '관리 권한이 없습니다.' }, 403);

    const targetId = Number(c.req.param('userId'));
    const body = await c.req.json().catch(() => null) as { role?: string } | null;
    const role = body?.role === 'editor' ? 'editor' : body?.role === 'viewer' ? 'viewer' : null;
    if (!role) return c.json({ error: '역할은 editor 또는 viewer 여야 합니다.' }, 400);

    const res = await db.prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?')
        .bind(role, ws.id, targetId).run();
    if (!res.meta?.changes) return c.json({ error: '멤버를 찾을 수 없습니다.' }, 404);
    return c.json({ ok: true, user_id: targetId, role });
});

/**
 * DELETE /api/ws/:wslug/members/:userId — 멤버 추방 (canManage) 또는 본인 탈퇴(self-leave).
 */
workspace.delete('/api/ws/:wslug/members/:userId', requireAuth, async (c) => {
    const gate = ensureEnabled(c); if (gate) return gate;
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;
    const { workspace: ws, access } = await getWorkspaceAccessBySlug(db, c.req.param('wslug'), user, rbac);
    if (!ws) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);

    const targetId = Number(c.req.param('userId'));
    const isSelfLeave = targetId === user.id;
    if (!access.canManage && !isSelfLeave) return c.json({ error: '관리 권한이 없습니다.' }, 403);
    if (targetId === ws.owner_id) return c.json({ error: '소유자는 멤버 목록에서 제거할 수 없습니다. 소유권을 먼저 이전하세요.' }, 400);

    await db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').bind(ws.id, targetId).run();
    return c.json({ ok: true });
});

/**
 * POST /api/ws/:wslug/transfer — 소유권 이전 (owner 또는 super_admin).
 * 새 소유자는 기존 멤버여야 하며, 이전 후 멤버 테이블에서 새 소유자 행을 제거하고
 * 기존 소유자를 editor 멤버로 강등(편의)한다.
 */
workspace.post('/api/ws/:wslug/transfer', requireAuth, async (c) => {
    const gate = ensureEnabled(c); if (gate) return gate;
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;
    const { workspace: ws, access } = await getWorkspaceAccessBySlug(db, c.req.param('wslug'), user, rbac);
    if (!ws) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canManage) return c.json({ error: '소유권 이전 권한이 없습니다.' }, 403);

    const body = await c.req.json().catch(() => null) as { user_id?: number } | null;
    const newOwnerId = Number(body?.user_id);
    if (!Number.isInteger(newOwnerId) || newOwnerId <= 0) return c.json({ error: '대상 사용자가 유효하지 않습니다.' }, 400);
    if (newOwnerId === ws.owner_id) return c.json({ error: '이미 소유자입니다.' }, 400);

    const member = await db.prepare('SELECT user_id FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
        .bind(ws.id, newOwnerId).first();
    if (!member) return c.json({ error: '새 소유자는 먼저 멤버로 추가되어 있어야 합니다.' }, 400);

    const prevOwnerId = ws.owner_id;
    await db.batch([
        db.prepare('UPDATE workspaces SET owner_id = ? WHERE id = ?').bind(newOwnerId, ws.id),
        db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').bind(ws.id, newOwnerId),
        db.prepare(
            `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'editor')
             ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = 'editor'`
        ).bind(ws.id, prevOwnerId),
    ]);
    return c.json({ ok: true, owner_id: newOwnerId });
});

export default workspace;
