import type { Env } from '../types';

/**
 * `ENABLED_EXTENSIONS`(쉼표 구분 익스텐션 네임스페이스 목록)를 정규화된 배열로 파싱한다.
 *
 * 과거 약 21곳에서 `(c.env.ENABLED_EXTENSIONS || '').split(',').map(s => s.trim()).filter(Boolean)`
 * 표현식이 동일하게 복붙돼 있었다. 이 헬퍼가 그 단일 소스다.
 *
 * `c` 가 아닌 `env` 를 받으므로 Hono 핸들러(`c.env`)·MCP 디스패처(`c.env`) 양쪽에서 호출 가능.
 * 짧은 문자열 split 이라 비용이 무시할 만하므로 메모이즈하지 않고 순수 함수로 유지한다.
 *
 * 반환값은 보통 `isR2OnlyNamespace(slug, enabledExtensions)`(`src/utils/slug.ts`)로 흘러간다.
 */
export function getEnabledExtensions(env: Pick<Env['Bindings'], 'ENABLED_EXTENSIONS'>): string[] {
    return (env.ENABLED_EXTENSIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
}
