import type { Env } from '../types';

/**
 * 워크스페이스(개인 워크스페이스) 기능의 wrangler.toml 환경변수 파싱 단일 소스.
 *
 * `getEnabledExtensions`(src/utils/extensions.ts)와 동일하게 `c` 가 아닌 `env` 를 받는
 * 순수 함수로 유지한다 — Hono 핸들러(`c.env`)·MCP 디스패처 양쪽에서 호출 가능.
 * 전부 배포 타임 고정값이므로 메모이즈하지 않는다.
 */

/**
 * 워크스페이스 기능 전역 토글(`WORKSPACES_ENABLED`) 조회. "true" 일 때만 활성.
 */
export function isWorkspacesEnabled(env: Pick<Env['Bindings'], 'WORKSPACES_ENABLED'>): boolean {
    return env.WORKSPACES_ENABLED === 'true';
}

/**
 * 워크스페이스 생성 가능 주체(`WORKSPACE_CREATOR`) 조회.
 * "admin" 이면 관리자만 생성 가능, 그 외(미설정 포함)는 일반 사용자도 생성 가능("user" 기본).
 */
export function getWorkspaceCreator(env: Pick<Env['Bindings'], 'WORKSPACE_CREATOR'>): 'user' | 'admin' {
    return env.WORKSPACE_CREATOR === 'admin' ? 'admin' : 'user';
}

/**
 * 사용자당 소유 가능한 워크스페이스 상한(`WORKSPACE_MAX_PER_USER`) 조회.
 * 숫자 문자열을 파싱하며, 미설정/비숫자/1 미만은 모두 기본값 1 로 정규화한다.
 */
export function getWorkspaceMaxPerUser(env: Pick<Env['Bindings'], 'WORKSPACE_MAX_PER_USER'>): number {
    const n = parseInt(env.WORKSPACE_MAX_PER_USER || '', 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return n;
}
