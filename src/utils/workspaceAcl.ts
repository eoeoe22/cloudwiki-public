import type { RBAC } from './role';
import type { Workspace } from '../shared/models';

/**
 * 워크스페이스 접근 제어(ACL) 평가 유틸.
 *
 * 접근 매트릭스:
 *   - canManage : owner 또는 super_admin — 멤버/역할/설정 관리, 삭제, 소유권 이전
 *   - canWrite  : owner / editor / super_admin — 워크스페이스 문서·미디어 작성/수정
 *   - canRead   : canWrite / viewer / super_admin — 워크스페이스 내용 열람
 *
 * owner 는 workspaces.owner_id 에서 파생되며 workspace_members 에는 저장되지 않는다
 * (멤버 테이블의 role 은 'editor' | 'viewer' 만 존재).
 * super_admin 판정은 `rbac.can(role, '*')` 단일 기준이다.
 *
 * 주의: 비멤버·게스트는 role=null, 모든 권한 false 로 평가된다.
 * 문서 단위 공개 플래그(workspace_pages.ws_public / workspace_media.ws_public)에 의한
 * 비멤버/게스트의 읽기 허용은 여기서 다루지 않고 **페이지 라우트 레이어**에서 별도로
 * 적용한다 — 이 모듈은 워크스페이스 멤버십 기반 권한만 평가한다.
 *
 * 의존성 최소·순수(캐싱 없음) 유지: D1 조회 외 부수효과 없음.
 */

/** 평가된 워크스페이스 역할. null = 비멤버(또는 게스트). */
export type WorkspaceRole = 'owner' | 'editor' | 'viewer' | null;

/** 워크스페이스 접근 권한 평가 결과. */
export interface WorkspaceAccess {
    role: WorkspaceRole;
    isSuperAdmin: boolean;
    canRead: boolean;
    canWrite: boolean;
    canManage: boolean;
}

/** owner_id·멤버 role 로부터 접근 매트릭스를 계산하는 내부 헬퍼. */
function buildAccess(role: WorkspaceRole, isSuperAdmin: boolean): WorkspaceAccess {
    const canManage = role === 'owner' || isSuperAdmin;
    const canWrite = canManage || role === 'editor';
    const canRead = canWrite || role === 'viewer';
    return { role, isSuperAdmin, canRead, canWrite, canManage };
}

/** 워크스페이스 부재(미존재/삭제) 시의 전부-거부 접근. isSuperAdmin 플래그만 반영한다. */
function deniedAccess(user: { role: string } | null, rbac: RBAC): WorkspaceAccess {
    const isSuperAdmin = !!user && rbac.can(user.role, '*');
    return { role: null, isSuperAdmin, canRead: false, canWrite: false, canManage: false };
}

/** 멤버십 조회 후 접근 평가 (workspace 존재가 이미 확인된 경우의 내부 공용 경로). */
async function resolveAccess(
    db: D1Database,
    workspaceId: number,
    ownerId: number,
    user: { id: number; role: string } | null,
    rbac: RBAC
): Promise<WorkspaceAccess> {
    const isSuperAdmin = !!user && rbac.can(user.role, '*');
    if (!user) return buildAccess(null, false);
    if (ownerId === user.id) return buildAccess('owner', isSuperAdmin);
    const member = await db.prepare(
        'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
    ).bind(workspaceId, user.id).first<{ role: string }>();
    const role: WorkspaceRole =
        member && (member.role === 'editor' || member.role === 'viewer') ? member.role : null;
    return buildAccess(role, isSuperAdmin);
}

/**
 * 워크스페이스 id 기준 접근 평가.
 * 워크스페이스가 없거나 소프트 삭제된 경우 role=null·모든 권한 false 로 평가된다
 * (isSuperAdmin 플래그만 반영). 존재 여부 404 처리는 호출 측(라우트) 책임이며,
 * slug 로 조회하면서 존재 확인까지 겸하려면 `getWorkspaceAccessBySlug` 를 사용한다.
 */
export async function getWorkspaceAccess(
    db: D1Database,
    workspaceId: number,
    user: { id: number; role: string } | null,
    rbac: RBAC
): Promise<WorkspaceAccess> {
    const ws = await db.prepare(
        'SELECT owner_id FROM workspaces WHERE id = ? AND deleted_at IS NULL'
    ).bind(workspaceId).first<{ owner_id: number }>();
    if (!ws) return deniedAccess(user, rbac);
    return resolveAccess(db, workspaceId, ws.owner_id, user, rbac);
}

/**
 * 워크스페이스 slug 기준 조회 + 접근 평가 편의 함수.
 * 워크스페이스가 없거나 소프트 삭제됐으면 `workspace: null` (access 는 role=null·전부
 * false, isSuperAdmin 만 반영) 을 반환한다 — 호출 측은 workspace null 이면 404 처리.
 */
export async function getWorkspaceAccessBySlug(
    db: D1Database,
    wslug: string,
    user: { id: number; role: string } | null,
    rbac: RBAC
): Promise<{ workspace: Workspace | null; access: WorkspaceAccess }> {
    const workspace = await db.prepare(
        'SELECT * FROM workspaces WHERE slug = ? AND deleted_at IS NULL'
    ).bind(wslug).first<Workspace>();
    if (!workspace) {
        return { workspace: null, access: deniedAccess(user, rbac) };
    }
    const access = await resolveAccess(db, workspace.id, workspace.owner_id, user, rbac);
    return { workspace, access };
}
