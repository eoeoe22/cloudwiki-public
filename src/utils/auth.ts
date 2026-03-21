import type { Env } from '../types';

/**
 * SUPER_ADMIN_EMAILS 환경변수를 파싱하여 최고 관리자 이메일 Set을 반환합니다.
 * @param env SUPER_ADMIN_EMAILS를 포함하는 환경 바인딩
 * @returns 최고 관리자 이메일 Set
 */
export function getSuperAdmins(env: Env['Bindings']): Set<string> {
    const emails = (env.SUPER_ADMIN_EMAILS || '').split(',').map(e => e.trim()).filter(e => e.length > 0);
    return new Set(emails);
}

/**
 * 주어진 이메일이 최고 관리자인지 확인합니다.
 * @param email 사용자의 이메일 주소
 * @param env SUPER_ADMIN_EMAILS를 포함하는 환경 바인딩
 * @returns 이메일이 최고 관리자 목록에 있으면 true, 아니면 false
 */
export function isSuperAdmin(email: string, env: Env['Bindings']): boolean {
    return getSuperAdmins(env).has(email);
}
