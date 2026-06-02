/**
 * 사용자 멘션(`@[user:123]`) 알림/렌더 지원 서버 헬퍼.
 *
 * 토론·티켓 댓글 본문에 포함된 멘션을 파싱해 알림 수신자를 해석하거나,
 * 렌더용 id→닉네임 맵을 만든다. 멘션 문법 파싱 자체는 `src/shared/mentions.ts` 공용 유틸을 재사용한다.
 */
import type { Env } from '../types';
import { ROLE_CASE_SQL, enrichRoles } from './role';
import { extractMentionIds, stripMarkdownCode } from '../shared/mentions';

export interface MentionRecipient {
    id: number;
    name: string;
    role: string;
}

/** Cloudflare D1 단일 statement 의 바운드 파라미터 제한. */
const D1_BIND_LIMIT = 100;

/** SQL `IN (...)` placeholder 문자열 생성 (`?,?,?`). */
function placeholders(n: number): string {
    return new Array(n).fill('?').join(',');
}

function chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        out.push(arr.slice(i, i + size));
    }
    return out;
}

/**
 * 본문에서 멘션된 사용자 중 알림을 받을 수 있는 유효한 수신자만 해석한다.
 * - 존재하는 사용자
 * - 밴(임시 `banned_until` 포함)/삭제 상태 제외
 * - `excludeUserId`(보통 작성자 본인) 제외
 *
 * 역할은 다른 조회와 동일하게 **유효 역할**(`ROLE_CASE_SQL` 의 `banned_until` 정규화 +
 * `enrichRoles` 의 슈퍼 관리자 이메일 보정)로 반환한다. 그래야 티켓 멘션 필터가
 * 이메일 기반 슈퍼 관리자를 올바르게 통과시키고, 임시 밴 사용자를 알림에서 제외한다.
 *
 * 비공개 문서/티켓 권한 필터는 호출부에서 추가로 적용한다(맥락별 규칙이 다름).
 * 멘션 수가 많아도 D1 의 100 파라미터 제한을 넘지 않도록 청크 단위로 질의한다.
 */
export async function resolveMentionRecipients(
    db: D1Database,
    env: Env['Bindings'],
    content: string,
    excludeUserId: number,
): Promise<MentionRecipient[]> {
    // 코드(펜스/인라인) 안의 멘션은 가짜 핑이므로 추출 전에 제거한다.
    const ids = extractMentionIds(stripMarkdownCode(content)).filter((id) => id !== excludeUserId);
    if (ids.length === 0) return [];
    const out: MentionRecipient[] = [];
    for (const batch of chunk(ids, D1_BIND_LIMIT)) {
        const { results } = await db
            .prepare(
                `SELECT u.id, u.name, u.email, ${ROLE_CASE_SQL} AS role
                 FROM users u
                 WHERE u.id IN (${placeholders(batch.length)})
                   AND u.role != 'deleted'`,
            )
            .bind(...batch)
            .all<MentionRecipient & { email?: string }>();
        const rows = results ?? [];
        // 슈퍼 관리자 이메일 보정 후 email 필드 제거
        enrichRoles(rows as any[], 'role', 'email', env);
        // 유효 역할 기준으로 밴 사용자 제외 (banned_until 임시 밴은 ROLE_CASE_SQL 이 'banned' 로 매핑)
        for (const r of rows) {
            if (r.role === 'banned') continue;
            out.push({ id: r.id, name: r.name, role: r.role });
        }
    }
    return out;
}

/**
 * 댓글 목록 전체에서 멘션된 사용자들의 id→{name} 맵을 만든다(렌더용).
 * 삭제/없는 사용자는 맵에 포함되지 않으며, 프론트에서 fallback 표시한다.
 * 멘션 수가 많아도 D1 의 100 파라미터 제한을 넘지 않도록 청크 단위로 질의한다.
 */
export async function buildMentionUserMap(
    db: D1Database,
    contents: string[],
): Promise<Record<string, { name: string }>> {
    // 코드(펜스/인라인) 안의 멘션은 렌더에서 링크화되지 않으므로 맵에서도 제외한다.
    const idSet = new Set<number>();
    for (const content of contents) {
        for (const id of extractMentionIds(stripMarkdownCode(content))) idSet.add(id);
    }
    const ids = Array.from(idSet);
    if (ids.length === 0) return {};
    const map: Record<string, { name: string }> = {};
    for (const batch of chunk(ids, D1_BIND_LIMIT)) {
        const { results } = await db
            .prepare(`SELECT id, name FROM users WHERE id IN (${placeholders(batch.length)})`)
            .bind(...batch)
            .all<{ id: number; name: string }>();
        for (const row of results ?? []) {
            map[String(row.id)] = { name: row.name };
        }
    }
    return map;
}
