import { isSuperAdmin } from './auth';
import type { Env } from '../types';

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
