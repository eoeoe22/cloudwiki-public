/**
 * 카테고리 ACL 유틸 — category_acl 테이블(JSON edit_acl 컬럼) 조회와 머지.
 *
 * pages.edit_acl 과 동일한 EditAcl JSON 형식을 그대로 재사용한다 (editAcl.ts).
 * 카테고리가 페이지에 적용되는 시점에 이 템플릿을 페이지 edit_acl 로 merge / overwrite / ignore
 * 모드로 머지한다.
 *
 * `admin_only` 플래그가 포함된 카테고리는 구 admin_categories 와 동일하게 비관리자의 적용을 차단한다.
 */

import {
    parseEditAcl,
    serializeEditAcl,
    EDIT_ACL_FLAGS,
    type EditAcl,
    type EditAclFlag,
} from './editAcl';

export type CategoryAclMode = 'overwrite' | 'merge' | 'ignore';

/**
 * 단일 카테고리의 ACL 템플릿 조회. 행이 없거나 edit_acl 이 NULL/잘못된 JSON 이면 null.
 */
export async function getCategoryAcl(
    db: D1Database,
    name: string,
): Promise<EditAcl | null> {
    try {
        const row = await db
            .prepare('SELECT edit_acl FROM category_acl WHERE name = ?')
            .bind(name)
            .first<{ edit_acl: string | null }>();
        if (!row) return null;
        return parseEditAcl(row.edit_acl);
    } catch (e) {
        console.error('getCategoryAcl failed:', e);
        return null;
    }
}

/**
 * 다수 카테고리의 ACL 템플릿을 한 번에 조회. ACL 이 없거나 null 인 카테고리는 결과에 포함되지 않는다.
 *
 * D1 의 100 bound-parameter 제한을 피하기 위해 names 를 100개씩 청크로 SELECT 한다.
 * (이 함수는 다른 binding 을 추가하지 않으므로 100 까지 가능하지만 여유를 두고 100 으로 둠.)
 * 한 청크 SELECT 가 실패하면 그 청크는 건너뛰지만 다른 청크는 계속 처리.
 */
export async function getCategoryAclsBatch(
    db: D1Database,
    names: string[],
): Promise<Map<string, EditAcl>> {
    const out = new Map<string, EditAcl>();
    if (names.length === 0) return out;
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const n of names) {
        if (!n || seen.has(n)) continue;
        seen.add(n);
        deduped.push(n);
    }
    if (deduped.length === 0) return out;
    const CHUNK = 100;
    for (let i = 0; i < deduped.length; i += CHUNK) {
        const chunk = deduped.slice(i, i + CHUNK);
        try {
            const placeholders = chunk.map(() => '?').join(',');
            const { results } = await db
                .prepare(`SELECT name, edit_acl FROM category_acl WHERE name IN (${placeholders})`)
                .bind(...chunk)
                .all<{ name: string; edit_acl: string | null }>();
            for (const r of results || []) {
                const acl = parseEditAcl(r.edit_acl);
                if (acl) out.set(r.name, acl);
            }
        } catch (e) {
            console.error(`getCategoryAclsBatch chunk failed (offset=${i}):`, e);
        }
    }
    return out;
}

/**
 * 카테고리가 admin_only 플래그를 가지고 있는지 — 즉 비관리자의 적용이 차단되는 카테고리인지.
 * 구 admin_categories 화이트리스트 검사 대체.
 *
 * 마이그레이션 호환: category_acl 행 자체가 없으면 레거시 admin_categories 테이블도 조회한다.
 * category_acl 행이 존재하면 그 값을 단일 소스로 사용 — 관리자가 새 UI 에서 admin_only 를 해제했거나
 * ACL 을 비웠을 때 레거시 admin_categories 행이 살아 있어도 잠금이 풀린다.
 * 운영 환경에서 admin_categories → category_acl 흡수 마이그레이션 완료 + admin_categories DROP
 * 후 별도 PR 에서 이 fallback 을 제거할 수 있다.
 *
 * 주의: parseEditAcl 은 "행 없음" 과 "행 있음 + flags=[]" 양쪽에서 null 을 돌려주므로,
 * fallback 분기를 결정할 때는 행 존재 여부를 별도로 조회해야 한다.
 */
export async function isAdminOnlyCategory(
    db: D1Database,
    name: string,
): Promise<boolean> {
    let row: { edit_acl: string | null } | null = null;
    try {
        row = await db
            .prepare('SELECT edit_acl FROM category_acl WHERE name = ?')
            .bind(name)
            .first<{ edit_acl: string | null }>();
    } catch (e) {
        console.error('isAdminOnlyCategory category_acl lookup failed:', e);
        return false;
    }
    if (row) {
        // 새 테이블의 행이 단일 소스 — admin_only 플래그가 있을 때만 true.
        const acl = parseEditAcl(row.edit_acl);
        return !!(acl && acl.flags.includes('admin_only'));
    }
    // 새 테이블에 행이 없을 때만 레거시 admin_categories 폴백.
    try {
        const legacy = await db
            .prepare('SELECT 1 AS ok FROM admin_categories WHERE name = ? LIMIT 1')
            .bind(name)
            .first<{ ok: number }>();
        return !!legacy;
    } catch (e) {
        // admin_categories 가 이미 DROP 된 환경이면 단순히 false 로 진행.
        return false;
    }
}

/**
 * 두 EditAcl 의 flag 배열을 합집합으로 머지. EDIT_ACL_FLAGS 정렬 순서를 따른다.
 * a / b 중 하나가 null 이면 다른 쪽 반환. 둘 다 null 이면 null.
 */
export function mergeEditAclFlags(
    a: EditAcl | null,
    b: EditAcl | null,
): EditAcl | null {
    if (!a) return b ? { flags: [...b.flags] } : null;
    if (!b) return { flags: [...a.flags] };
    const present = new Set<EditAclFlag>([...a.flags, ...b.flags]);
    // EDIT_ACL_FLAGS 정렬 순서로 직렬화해 합집합 결과의 플래그 순서를 안정화한다(중복 제거 포함).
    const out = EDIT_ACL_FLAGS.filter(f => present.has(f));
    if (out.length === 0) return null;
    return { flags: out };
}

/**
 * 카테고리 ACL 템플릿을 페이지 ACL 에 적용한 결과 반환 (페이지 ACL 자체는 변경하지 않음, 호출자가 결과를 쓴다).
 *  - overwrite : 페이지 ACL 을 카테고리 ACL 로 통째로 교체. 카테고리 ACL 이 null 이면 페이지 ACL 도 null.
 *  - merge     : 두 ACL 의 flag 합집합 (AND 평가 이므로 결과는 더 엄격).
 *  - ignore    : 페이지 ACL 그대로.
 */
export function applyCategoryAclToPage(
    pageAcl: EditAcl | null,
    catAcl: EditAcl | null,
    mode: CategoryAclMode,
): EditAcl | null {
    switch (mode) {
        case 'overwrite':
            return catAcl ? { flags: [...catAcl.flags] } : null;
        case 'merge':
            return mergeEditAclFlags(pageAcl, catAcl);
        case 'ignore':
        default:
            return pageAcl;
    }
}

/**
 * 직렬화 헬퍼 — 페이지 ACL UPDATE 시 사용.
 */
export function serializeCategoryAclResult(acl: EditAcl | null): string | null {
    return serializeEditAcl(acl);
}

/**
 * 입력 모드 문자열 검증. 알 수 없는 값은 fallback 반환.
 */
export function normalizeCategoryAclMode(
    raw: unknown,
    fallback: CategoryAclMode = 'merge',
): CategoryAclMode {
    if (raw === 'overwrite' || raw === 'merge' || raw === 'ignore') return raw;
    return fallback;
}
