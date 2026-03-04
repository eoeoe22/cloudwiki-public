import type { Env } from '../types';

/**
 * Parses the SUPER_ADMIN_EMAILS environment variable and returns a Set of super admin emails.
 * @param env The environment bindings containing SUPER_ADMIN_EMAILS.
 * @returns A Set of super admin emails.
 */
export function getSuperAdmins(env: Env['Bindings']): Set<string> {
    const emails = (env.SUPER_ADMIN_EMAILS || '').split(',').map(e => e.trim()).filter(e => e.length > 0);
    return new Set(emails);
}

/**
 * Checks if the given email is a super admin based on the environment configuration.
 * @param email The user's email address.
 * @param env The environment bindings containing SUPER_ADMIN_EMAILS.
 * @returns true if the email is in the super admin list, false otherwise.
 */
export function isSuperAdmin(email: string, env: Env['Bindings']): boolean {
    return getSuperAdmins(env).has(email);
}
