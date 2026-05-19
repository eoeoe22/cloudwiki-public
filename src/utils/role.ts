import { isSuperAdmin } from './auth';
import type { Env, RolePermissions } from '../types';

/**
 * RBAC (역할 기반 접근 제어) 관리 클래스.
 *
 * 권한 정의는 getDefaultPermissions() 단일 소스로 고정한다.
 * 과거에는 wrangler.toml 의 ROLE_PERMISSIONS_JSON 환경변수로 오버라이드했으나,
 * 운영 중 손볼 일이 거의 없고 잘못 수정하면 전 사이트 권한이 망가지므로 폐기했다.
 */
export class RBAC {
    private permissions: RolePermissions;

    constructor() {
        this.permissions = RBAC.getDefaultPermissions();
    }

    /**
     * 특정 역할이 권한을 가지고 있는지 확인 (상속 관계 포함)
     */
    can(role: string, permission: string): boolean {
        return this._can(role, permission, new Set<string>());
    }

    private _can(role: string, permission: string, visited: Set<string>): boolean {
        // 순환 상속 방지: 이미 방문한 역할은 건너뜀
        if (visited.has(role)) return false;
        visited.add(role);

        const roleData = this.permissions.roles[role];
        if (!roleData) return false;

        // permissions가 배열이 아닌 경우(잘못된 설정) 빈 배열로 정규화
        const perms = Array.isArray(roleData.permissions) ? roleData.permissions : [];

        // 1. 직접적인 권한 확인
        if (perms.includes(permission) || perms.includes('*')) {
            return true;
        }

        // 2. 상속된 권한 확인 (재귀)
        if (Array.isArray(roleData.inherits)) {
            for (const parentRole of roleData.inherits) {
                if (this._can(parentRole, permission, visited)) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * 기본 권한 설정 생성 (기존 하드코딩된 로직 대응용)
     */
    static getDefaultPermissions(): RolePermissions {
        return {
            roles: {
                guest: {
                    permissions: ['wiki:read'],
                    inherits: []
                },
                user: {
                    permissions: ['wiki:read', 'wiki:edit', 'comment:create', 'ticket:create', 'media:upload'],
                    inherits: []
                },
                discussion_manager: {
                    permissions: ['discussion:manage'],
                    inherits: ['user']
                },
                admin: {
                    permissions: ['admin:access', 'wiki:delete', 'wiki:lock', 'wiki:private', 'user:manage', 'ticket:manage'],
                    inherits: ['discussion_manager']
                },
                super_admin: {
                    permissions: ['*'],
                    inherits: ['admin']
                },
                banned: {
                    permissions: [],
                    inherits: []
                },
                deleted: {
                    permissions: [],
                    inherits: []
                }
            }
        };
    }
}

/**
 * SQL CASE 표현식: banned_until 기반으로 role을 동적으로 계산
 * u 테이블 alias를 사용하는 쿼리에서 사용
 */
export const ROLE_CASE_SQL = `CASE
    WHEN u.banned_until IS NOT NULL AND u.banned_until > unixepoch() THEN 'banned'
    WHEN u.role = 'banned' AND (u.banned_until IS NULL OR u.banned_until <= unixepoch()) THEN 'user'
    ELSE u.role END`;

/**
 * 결과 배열에서 super_admin 이메일 기반으로 역할을 보정하고, 이메일 필드를 제거
 */
export function enrichRoles(
    results: any[],
    roleField: string,
    emailField: string,
    env: Env['Bindings']
): void {
    for (const item of results) {
        if (item[emailField] && isSuperAdmin(item[emailField], env)) {
            item[roleField] = 'super_admin';
        }
        delete item[emailField];
    }
}

/**
 * 단일 객체에 대해 super_admin 역할 보정 및 이메일 필드 제거
 */
export function enrichRole(
    item: any,
    roleField: string,
    emailField: string,
    env: Env['Bindings']
): void {
    if (item && item[emailField] && isSuperAdmin(item[emailField], env)) {
        item[roleField] = 'super_admin';
    }
    if (item) {
        delete item[emailField];
    }
}
