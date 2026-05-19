/**
 * 편집 ACL 정의·평가 유틸.
 *
 * pages.edit_acl 컬럼(JSON 문자열) + 전역 settings.edit_acl_min_age_days 로 동작한다.
 * 모든 플래그는 AND 로 평가된다 (mode 키는 제거됨, 호환을 위해 입력에서 무시).
 *   - 'aged'        : unixepoch() - users.created_at >= minAgeDays * 86400
 *   - 'page_editor' : revisions WHERE page_id=? AND author_id=? 에 1행 이상
 *   - 'any_editor'  : revisions WHERE author_id=?            에 1행 이상
 *   - 'admin_only'  : 관리자(admin:access) 만 통과 (구 is_locked 컬럼 대체)
 *
 * 'admin_only' 가 ACL 에 없으면 관리자(admin:access)는 ACL 우회한다 (호출자가 별도 판정).
 * 'admin_only' 가 있으면 evaluate 단계에서 isAdmin 으로 판정한다.
 */

export const EDIT_ACL_FLAGS = ['aged', 'page_editor', 'any_editor', 'admin_only'] as const;
export type EditAclFlag = typeof EDIT_ACL_FLAGS[number];

export interface EditAcl {
    flags: EditAclFlag[];
}

const FLAG_SET = new Set<string>(EDIT_ACL_FLAGS);

/**
 * 원본 문자열을 EditAcl 로 파싱. 빈 flags / 잘못된 JSON / 알 수 없는 키는 null 로 정규화.
 * 과거 {mode,flags,...,'allowlist',...} 행도 안전하게 수용 — mode 는 무시, 알 수 없는 플래그(allowlist 포함) 는 필터.
 */
export function parseEditAcl(raw: string | null | undefined): EditAcl | null {
    if (!raw) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as { flags?: unknown };
    if (!Array.isArray(obj.flags)) return null;
    const flags: EditAclFlag[] = [];
    const seen = new Set<string>();
    for (const f of obj.flags) {
        if (typeof f !== 'string') continue;
        if (!FLAG_SET.has(f)) continue;
        if (seen.has(f)) continue;
        seen.add(f);
        flags.push(f as EditAclFlag);
    }
    if (flags.length === 0) return null;
    return { flags };
}

/**
 * EditAcl → 직렬화. null 또는 빈 flags → null (저장 시 NULL 컬럼).
 */
export function serializeEditAcl(acl: EditAcl | null | undefined): string | null {
    if (!acl) return null;
    if (!Array.isArray(acl.flags) || acl.flags.length === 0) return null;
    const flags: EditAclFlag[] = [];
    const seen = new Set<string>();
    for (const f of acl.flags) {
        if (!FLAG_SET.has(f)) continue;
        if (seen.has(f)) continue;
        seen.add(f);
        flags.push(f);
    }
    if (flags.length === 0) return null;
    return JSON.stringify({ flags });
}

/**
 * 입력 ACL 객체를 받아 정규화 (알려지지 않은 플래그 제거).
 * 라우트 단에서 body 의 edit_acl 을 받아 검증할 때 사용.
 * 과거 호환을 위해 mode 키가 들어와도 silently 무시한다.
 */
export function normalizeEditAcl(input: unknown): { value: EditAcl | null } | { error: string } {
    if (input === null || input === undefined) return { value: null };
    if (typeof input !== 'object' || Array.isArray(input)) {
        return { error: 'edit_acl 은 객체 또는 null 이어야 합니다.' };
    }
    const obj = input as { flags?: unknown };
    if (!Array.isArray(obj.flags)) {
        return { error: 'edit_acl.flags 는 배열이어야 합니다.' };
    }
    const flags: EditAclFlag[] = [];
    const seen = new Set<string>();
    for (const f of obj.flags) {
        if (typeof f !== 'string' || !FLAG_SET.has(f)) {
            return { error: `edit_acl.flags 에 알 수 없는 항목: ${String(f)}` };
        }
        if (seen.has(f)) continue;
        seen.add(f);
        flags.push(f as EditAclFlag);
    }
    if (flags.length === 0) return { value: null };
    return { value: { flags } };
}

/**
 * 단일 플래그 평가. pageId 가 null 이면 page_editor 는 항상 false.
 * admin_only 는 isAdmin 인자로 즉시 판정.
 */
async function evaluateFlag(
    db: D1Database,
    flag: EditAclFlag,
    user: { id: number; created_at: number },
    pageId: number | null,
    minAgeDays: number,
    isAdmin: boolean,
): Promise<boolean> {
    switch (flag) {
        case 'aged': {
            if (minAgeDays <= 0) return true;
            const now = Math.floor(Date.now() / 1000);
            return now - user.created_at >= minAgeDays * 86400;
        }
        case 'page_editor': {
            if (pageId == null) return false;
            const row = await db
                .prepare('SELECT 1 AS ok FROM revisions WHERE page_id = ? AND author_id = ? LIMIT 1')
                .bind(pageId, user.id)
                .first<{ ok: number }>();
            return !!row;
        }
        case 'any_editor': {
            const row = await db
                .prepare('SELECT 1 AS ok FROM revisions WHERE author_id = ? LIMIT 1')
                .bind(user.id)
                .first<{ ok: number }>();
            return !!row;
        }
        case 'admin_only': {
            return isAdmin;
        }
    }
}

export interface EditAclEvaluation {
    /** 최종 통과 여부. */
    allowed: boolean;
    /** 첫 실패 플래그(AND). UX 안내용. */
    decisive?: EditAclFlag;
}

/**
 * ACL 평가 (AND). 첫 실패 시 short-circuit.
 * pageId 가 null 이면 신규 문서 생성 케이스 — page_editor 는 항상 false 로 동작.
 *
 * isAdmin: 호출자가 관리자(admin:access) 인지. 'admin_only' 플래그가 ACL 에 없으면 호출자가
 * 이미 admin 우회로 결정해 evaluate 호출 자체를 건너뛰어야 하지만, 안전을 위해 인자로 받는다.
 */
export async function evaluateEditAcl(
    db: D1Database,
    acl: EditAcl,
    user: { id: number; created_at: number },
    pageId: number | null,
    minAgeDays: number,
    isAdmin: boolean,
): Promise<EditAclEvaluation> {
    if (acl.flags.length === 0) return { allowed: true };
    for (const f of acl.flags) {
        if (!(await evaluateFlag(db, f, user, pageId, minAgeDays, isAdmin))) {
            return { allowed: false, decisive: f };
        }
    }
    return { allowed: true };
}

/**
 * settings.edit_acl_min_age_days 조회. 행이 없으면 0.
 */
export async function getEditAclMinAgeDays(db: D1Database): Promise<number> {
    try {
        const row = await db
            .prepare('SELECT edit_acl_min_age_days AS v FROM settings WHERE id = 1')
            .first<{ v: number | null }>();
        const v = row?.v;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
        return Math.floor(v);
    } catch {
        return 0;
    }
}

/**
 * slug 에 적용될 prefix 룰의 edit_acl 을 가장 긴 일치 prefix 로 조회.
 * 신규 문서 생성 / 진입 사전 검사 양쪽에서 사용.
 *
 * 가장 긴 일치 prefix 를 먼저 고르고, 그 룰의 edit_acl 만 읽는다 (wiki.ts 의 create 분기와 동일 정책).
 * edit_acl IS NOT NULL 로 사전 필터하면 private 만 가진 더 긴 자식 룰 대신 ACL 을 가진
 * 짧은 부모 룰이 잘못 선택돼 false denial 이 발생하므로 WHERE 절에서 필터하지 않는다.
 */
export async function findPrefixRuleEditAcl(
    db: D1Database,
    slug: string,
): Promise<EditAcl | null> {
    try {
        const { results } = await db
            .prepare('SELECT prefix, edit_acl FROM doc_setting_prefix_rules')
            .all<{ prefix: string; edit_acl: string | null }>();
        let bestLen = -1;
        let bestRaw: string | null = null;
        for (const r of results || []) {
            if (!slug.startsWith(r.prefix + '/')) continue;
            if (r.prefix.length > bestLen) {
                bestLen = r.prefix.length;
                bestRaw = r.edit_acl;
            }
        }
        return parseEditAcl(bestRaw);
    } catch (e) {
        console.error('findPrefixRuleEditAcl failed:', e);
        return null;
    }
}
