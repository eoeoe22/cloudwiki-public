/**
 * 일반 유저 문서 편집 ACL 정의·평가 유틸.
 *
 * pages.edit_acl 컬럼(JSON 문자열) + 전역 settings.edit_acl_min_age_days 로 동작한다.
 * 4가지 조건을 mode(AND/OR) 로 조합한다:
 *   - 'aged'        : unixepoch() - users.created_at >= minAgeDays * 86400
 *   - 'allowlist'   : page_edit_allowlist(page_id, user_id) 에 본인 행
 *   - 'page_editor' : revisions WHERE page_id=? AND author_id=? 에 1행 이상
 *   - 'any_editor'  : revisions WHERE author_id=?            에 1행 이상
 *
 * 관리자(admin:access)는 호출자(라우트)에서 우회시킨다. 본 모듈은 evaluate 만 책임.
 */

export const EDIT_ACL_FLAGS = ['aged', 'allowlist', 'page_editor', 'any_editor'] as const;
export type EditAclFlag = typeof EDIT_ACL_FLAGS[number];

export interface EditAcl {
    mode: 'or' | 'and';
    flags: EditAclFlag[];
}

const FLAG_SET = new Set<string>(EDIT_ACL_FLAGS);

/**
 * 원본 문자열을 EditAcl 로 파싱. 빈 flags / 잘못된 JSON / 알 수 없는 키는 null 로 정규화.
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
    const obj = parsed as { mode?: unknown; flags?: unknown };
    const mode: 'or' | 'and' = obj.mode === 'and' ? 'and' : 'or';
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
    return { mode, flags };
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
    const mode: 'or' | 'and' = acl.mode === 'and' ? 'and' : 'or';
    return JSON.stringify({ mode, flags });
}

/**
 * 입력 ACL 객체를 받아 정규화 (모드 강제, 알려지지 않은 플래그 제거).
 * 라우트 단에서 body 의 edit_acl 을 받아 검증할 때 사용.
 */
export function normalizeEditAcl(input: unknown): { value: EditAcl | null } | { error: string } {
    if (input === null || input === undefined) return { value: null };
    if (typeof input !== 'object' || Array.isArray(input)) {
        return { error: 'edit_acl 은 객체 또는 null 이어야 합니다.' };
    }
    const obj = input as { mode?: unknown; flags?: unknown };
    if (obj.mode !== undefined && obj.mode !== 'or' && obj.mode !== 'and') {
        return { error: "edit_acl.mode 는 'or' 또는 'and' 여야 합니다." };
    }
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
    return { value: { mode: obj.mode === 'and' ? 'and' : 'or', flags } };
}

/**
 * 단일 플래그 평가. pageId 가 null 이면 page_editor 는 항상 false.
 */
async function evaluateFlag(
    db: D1Database,
    flag: EditAclFlag,
    user: { id: number; created_at: number },
    pageId: number | null,
    minAgeDays: number,
): Promise<boolean> {
    switch (flag) {
        case 'aged': {
            if (minAgeDays <= 0) return true;
            const now = Math.floor(Date.now() / 1000);
            return now - user.created_at >= minAgeDays * 86400;
        }
        case 'allowlist': {
            if (pageId == null) return false;
            const row = await db
                .prepare('SELECT 1 AS ok FROM page_edit_allowlist WHERE page_id = ? AND user_id = ? LIMIT 1')
                .bind(pageId, user.id)
                .first<{ ok: number }>();
            return !!row;
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
    }
}

export interface EditAclEvaluation {
    /** 최종 통과 여부. */
    allowed: boolean;
    /** 첫 실패(AND) 또는 첫 통과(OR) 의 플래그 식별자. UX 안내용. */
    decisive?: EditAclFlag;
}

/**
 * ACL 평가. mode='or' 이면 첫 통과 시 short-circuit, 'and' 이면 첫 실패 시 short-circuit.
 * pageId 가 null 이면 신규 문서 생성 케이스 — page_editor / allowlist 는 항상 false 로 동작.
 */
export async function evaluateEditAcl(
    db: D1Database,
    acl: EditAcl,
    user: { id: number; created_at: number },
    pageId: number | null,
    minAgeDays: number,
): Promise<EditAclEvaluation> {
    if (acl.flags.length === 0) return { allowed: true };
    if (acl.mode === 'or') {
        for (const f of acl.flags) {
            if (await evaluateFlag(db, f, user, pageId, minAgeDays)) {
                return { allowed: true, decisive: f };
            }
        }
        return { allowed: false };
    }
    // AND
    for (const f of acl.flags) {
        if (!(await evaluateFlag(db, f, user, pageId, minAgeDays))) {
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
 * edit_acl IS NOT NULL 로 사전 필터하면 lock/private 만 가진 더 긴 자식 룰 대신 ACL 을 가진
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
