// 편집 요청(내부 식별자는 pending_edits 유지) 검토 워크플로우.
//
// wrangler.toml `EDIT_REQUEST_ENABLED="true"` 일 때, 신뢰되지 않은 사용자의 PUT /api/w/:slug 편집은
// 즉시 리비전이 되지 않고 pending_edits 에 보관된다(holdPendingEdit, wiki.ts). 본 라우트는
// 그 편집 요청을 **검토자**(관리자 또는 신뢰 사용자) 가 검토·승인·반려하는 HTTP 인터페이스다.
// 검토 UI 는 문서 열람 페이지(편집 버튼 배지/드롭다운)에서 제공된다.
//
// MCP 제출안(mcp-submissions.ts)이 "자기 검토"(작성자=검토자) 인 것과 달리, 편집 요청은
// 반달 대응이 목적이므로 **작성자 본인은 검토에서 제외**되고 검토자는 신뢰 사용자/관리자다.
//
// 검토 권한(reviewable):
//   - 관리자(admin:access): 모든 요청.
//   - aged 사용자(가입 경과 >= edit_acl_min_age_days): 모든 요청(aged 는 문서 무관 상수).
//   - 그 외: 자신이 이전에 편집한 문서(page_editor) 의 요청만.
//   - 단 항상 author_id != 본인.
//
// 승인 시: 리비전 author 는 **원 요청자**로 기록하고, 편집 요약 끝에 승인자 닉네임+id 를 강제 박제한다.
//   승인자가 에디터에서 추가 편집한 경우(approve 본문 content) 리비전 2개를 만든다
//   (rev1=원 요청분/요청자 명의, rev2=추가 편집분/승인자 명의).
//
// 노출 엔드포인트:
//   GET  /api/pending-edits             — 검토 가능한 요청 목록(?slug= 로 문서 한정)
//   GET  /api/pending-edits/count       — (선택) ?slug= 로 문서별 카운트(배지용), 미지정 시 전체
//   GET  /api/pending-edits/:id         — 요청 본문 + 현재/베이스 본문 + diff
//   POST /api/pending-edits/:id/approve — 원 요청자 author 로 새 리비전 생성(+content 시 2-리비전)
//   POST /api/pending-edits/:id/reject  — 요청 + 관련 알림 폐기(+reason 알림)

import { Hono, type Context } from 'hono';
import type { Env, User } from '../types';
import { requireAuth } from '../middleware/session';
import { RBAC } from '../utils/role';
import { isR2OnlyNamespace } from '../utils/slug';
import { getEnabledExtensions } from '../utils/extensions';
import { getRevisionContent } from '../utils/r2';
import { computeLineDiffStats } from '../utils/diff';
import { findConflictingPage, applyCreatePrefixRulesAndCategoryAcls, isEditRequestEnabled } from './wiki';
import { commitPageMutation } from '../utils/pagePipeline/commit';
import { notifyPageWatchers } from '../utils/pagePipeline/notifyWatchers';
import { createNotification } from '../utils/notification';
import {
    parseEditAcl,
    evaluateEditAcl,
    getEditAclMinAgeDays,
    loadDocPrefixPrivacyRules,
    prefixRulesForcePrivate,
    type EditAcl,
    type DocPrefixPrivacyRule,
} from '../utils/editAcl';

const pendingEditsRoutes = new Hono<Env>();

const SUMMARY_MAX_LENGTH = 255;

interface PendingEditRow {
    id: number;
    page_id: number | null;
    slug: string;
    action: string;
    author_id: number;
    base_revision_id: number | null;
    base_version: number;
    content: string;
    category: string | null;
    redirect_to: string | null;
    title: string | null;
    has_title_change: number;
    summary: string | null;
    is_private: number;
    edit_acl: string | null;
    apply_edit_acl: number;
    view_mode: string | null;
    apply_view: number;
    category_acl_choices: string | null;
    created_at: number;
    updated_at: number;
}

function unixToIso(sec: number | null): string | null {
    if (sec === null) return null;
    return new Date(sec * 1000).toISOString();
}

// 편집 요청 승인 시, 요청자 명의 리비전의 요약 끝에 승인자(검토자) 닉네임+숫자 id 를 강제 박제한다.
// 255자 초과 시 작성자 요약만 말줄임표(…)로 잘라 한도를 맞추되, 승인 접미는 항상 보존한다.
function buildApprovalSuffix(authorSummary: string | null, reviewer: { name: string; id: number }): string {
    const suffix = ` (요청 승인 : [${reviewer.name}|${reviewer.id}])`;
    const base = (authorSummary ?? '').trim();
    if (!base) return suffix.trimStart();
    const combined = `${base}${suffix}`;
    if (combined.length <= SUMMARY_MAX_LENGTH) return combined;
    const room = SUMMARY_MAX_LENGTH - suffix.length - 1; // '…' 1자
    if (room <= 0) return suffix.trimStart();
    return `${base.slice(0, room)}…${suffix}`;
}

interface ReviewerCapability {
    isAdmin: boolean;
    reviewsAll: boolean;     // isAdmin || aged → 전 문서 검토 가능
    minAge: number;
    canViewPrivate: boolean; // wiki:private — 비공개 보류본 검토 가능 여부
}

// 현재 사용자의 검토 능력(전 문서 검토 가능 여부 + 비공개 검토 가능 여부)을 1회 계산한다.
//   isAdmin || aged → 전 문서 검토 가능. 그 외 → page_editor 문서만.
//   비공개 보류본(is_private=1)은 wiki:private 권한자만 검토 가능.
async function computeReviewerCapability(
    db: D1Database,
    user: User,
    rbac: RBAC,
): Promise<ReviewerCapability> {
    const isAdmin = rbac.can(user.role, 'admin:access');
    const canViewPrivate = rbac.can(user.role, 'wiki:private');
    const minAge = await getEditAclMinAgeDays(db);
    const aged = minAge <= 0 ? true : (Math.floor(Date.now() / 1000) - user.created_at >= minAge * 86400);
    return { isAdmin, reviewsAll: isAdmin || aged, minAge, canViewPrivate };
}

// pending_edits 테이블이 아직 없는(마이그레이션 미적용) 환경의 에러인지 판별.
// settings 읽기/쓰기 경로와 동일하게, 이 경우는 기능 비활성으로 간주해 빈 결과로 폴백한다.
function isMissingPendingEditsTable(e: unknown): boolean {
    const msg = String((e as { message?: unknown })?.message ?? e ?? '');
    return /no such table/i.test(msg) && /pending_edits/i.test(msg);
}

// create 보류본의 원본 category_acl_choices(JSON) 를 파싱. 없거나 잘못된 형식이면 null
// (헬퍼가 "키 누락 = 적용 안 함" 으로 처리). update 는 edit_acl 로 캡처돼 사용하지 않는다.
function parseReplayChoices(pe: PendingEditRow): Record<string, unknown> | null {
    if (!pe.category_acl_choices) return null;
    try {
        const parsed = JSON.parse(pe.category_acl_choices);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch { /* null 유지 */ }
    return null;
}

// 보류본의 "유효 edit_acl" 을 계산한다 — 검토자(승인/반려)가 이 문서를 편집할 권한이 있는지 판정용.
//   update: 현재 페이지의 edit_acl. slug 는 UNIQUE 라 단일 행이므로 deleted_at 필터를 두지 않는다 —
//           소프트 삭제된 ACL 보호 페이지(page_missing 충돌)라도 보호 ACL 을 유지해, ACL 미통과
//           검토자가 보류 상세를 열어(또는 반려해) proposed_content 를 읽지 못하게 한다.
//   create: prefix+카테고리 ACL 재생 결과(작성자=비관리자 기준 isAdmin=false 로 direct-save 시맨틱 보존)
async function resolveReviewerEditAcl(c: Context<Env>, pe: PendingEditRow): Promise<EditAcl | null> {
    if (pe.action === 'update') {
        const row = await c.env.DB
            .prepare('SELECT edit_acl FROM pages WHERE slug = ?')
            .bind(pe.slug)
            .first<{ edit_acl: string | null }>();
        return parseEditAcl(row?.edit_acl ?? null);
    }
    const prefixed = await applyCreatePrefixRulesAndCategoryAcls(c.env.DB, pe.slug, {
        category: pe.category,
        isPrivate: 0,
        editAcl: null,
        adminExplicitlySetEditAcl: false,
        categoryAclChoices: parseReplayChoices(pe),
        isAdmin: false,
    });
    return parseEditAcl(prefixed.finalEditAcl);
}

// 검토자가 주어진 edit_acl 을 통과하지 못하면 403 응답 객체를, 통과하면 null 을 반환한다.
// 승인·반려 양쪽이 공유해 권한 판정이 갈라지지 않게 한다(admin_only 면 관리자도 ACL 평가 대상).
async function reviewerAclFailResponse(
    db: D1Database,
    acl: EditAcl | null,
    user: User,
    pageId: number | null,
    minAge: number,
    isAdmin: boolean,
): Promise<{ status: 403; body: Record<string, unknown> } | null> {
    if (!acl || acl.flags.length === 0) return null;
    const hasAdminOnly = acl.flags.includes('admin_only');
    if (isAdmin && !hasAdminOnly) return null;
    const ev = await evaluateEditAcl(db, acl, user, pageId, minAge, isAdmin);
    if (ev.allowed) return null;
    const isAdminOnlyFail = ev.decisive === 'admin_only';
    return {
        status: 403,
        body: {
            error: 'forbidden',
            reason: isAdminOnlyFail ? 'admin_only' : 'edit_acl',
            message: isAdminOnlyFail
                ? '이 문서는 관리자만 검토할 수 있습니다.'
                : '이 문서를 검토할 권한이 부족합니다.',
            edit_acl: acl,
            min_age_days: minAge,
        },
    };
}

// 검토자가 특정 보류 행의 문서 ACL 을 통과하는지(=실제로 승인/반려할 수 있는지) 판정한다.
// 목록/카운트/상세 노출을 승인·반려 게이트(reviewerAclFailResponse)와 일치시켜, ACL(admin_only·
// page_editor 등)을 통과하지 못하는 검토자에게는 요청을 보이지도 열지도 못하게 한다.
//   - update: 보류 행에 조인된 현재 페이지 edit_acl(preResolvedAcl)을 우선 사용해 재조회를 피한다.
//             없으면 resolveReviewerEditAcl 로 폴백(slug 로 현재 페이지 ACL 조회).
//   - create: prefix+카테고리 ACL 재생(resolveReviewerEditAcl) 결과로 판정.
// ACL 이 없으면(대부분의 일반 문서) reviewerAclFailResponse 가 즉시 통과시켜 추가 쿼리가 없다.
async function reviewerCanActOnPending(
    c: Context<Env>,
    user: User,
    cap: ReviewerCapability,
    row: { slug: string; action: string; page_id: number | null; category: string | null; category_acl_choices: string | null },
    preResolvedAcl?: EditAcl | null,
): Promise<boolean> {
    const acl = row.action === 'update' && preResolvedAcl !== undefined
        ? preResolvedAcl
        : await resolveReviewerEditAcl(c, row as PendingEditRow);
    const fail = await reviewerAclFailResponse(
        c.env.DB, acl, user, row.action === 'update' ? row.page_id : null, cap.minAge, cap.isAdmin,
    );
    return fail === null;
}

// 보류본 1건을 로드하면서 현재 사용자의 검토 권한까지 검증한다. 권한이 없으면(또는 작성자 본인이면)
// 404 로 위장해 존재 여부 누설을 막는다(mcp-submissions 와 동일 정책).
async function loadReviewablePendingEdit(
    db: D1Database,
    user: User,
    id: number,
    cap: ReviewerCapability,
): Promise<PendingEditRow | null> {
    let row: PendingEditRow | null;
    try {
        row = await db.prepare(
        `SELECT id, page_id, slug, action, author_id, base_revision_id, base_version,
                content, category, redirect_to, title, has_title_change, summary,
                is_private, edit_acl, apply_edit_acl, view_mode, apply_view, category_acl_choices, created_at, updated_at
         FROM pending_edits WHERE id = ?`
    ).bind(id).first<PendingEditRow>();
    } catch (e) {
        if (isMissingPendingEditsTable(e)) return null;
        throw e;
    }
    if (!row) return null;
    if (row.author_id === user.id) return null; // 작성자 본인은 검토 불가
    // 비공개 보류본은 wiki:private 권한자만 검토 가능 — 본문/제목 노출 방지.
    // 제출 시점 스냅샷(row.is_private)은 신뢰하지 않고 **현재 상태**를 재평가한다:
    //   - update: 현재 페이지의 is_private (관리자가 flags/bulk 로 version 무증가 비공개화한 경우 대응)
    //   - create: 현재 prefix 룰이 강제하는 비공개 (제출 후 private prefix 룰이 추가/변경된 경우 대응 —
    //             승인 시 applyCreatePrefixRulesAndCategoryAcls 가 비공개로 생성하므로 사전 게이팅 필요)
    if (!cap.canViewPrivate) {
        let isPrivate = row.is_private === 1;
        if (!isPrivate && row.page_id != null) {
            // slug 는 UNIQUE 이므로 deleted_at 무관하게 단일 행을 조회한다 — 비공개로 만들어진 뒤
            // 소프트 삭제된 페이지(deleted_at IS NOT NULL)도 비공개로 취급해 본문 노출을 막는다.
            const pg = await db
                .prepare('SELECT is_private FROM pages WHERE slug = ?')
                .bind(row.slug)
                .first<{ is_private: number }>();
            if (pg && pg.is_private === 1) isPrivate = true;
        }
        if (!isPrivate && row.page_id == null) {
            const rules = await loadDocPrefixPrivacyRules(db);
            if (prefixRulesForcePrivate(rules, row.slug)) isPrivate = true;
        }
        if (isPrivate) return null;
    }
    if (cap.reviewsAll) return row;
    // 비-aged 비관리자: 이 문서의 이전 편집자만 검토 가능.
    if (row.page_id == null) return null; // create 보류는 page_editor 불가 → 검토 불가
    const editor = await db
        .prepare('SELECT 1 AS ok FROM revisions WHERE page_id = ? AND author_id = ? LIMIT 1')
        .bind(row.page_id, user.id)
        .first<{ ok: number }>();
    return editor ? row : null;
}

/**
 * GET /api/pending-edits
 * 검토 가능한 보류 목록(최신순). 페이지 현재 상태를 조인해 has_conflict 를 미리 계산한다.
 */
pendingEditsRoutes.get('/pending-edits', requireAuth, async (c) => {
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    // 기능 비활성 시(배포 토글 off) 잔여 row 노출을 막기 위해 빈 목록으로 폴백.
    if (!isEditRequestEnabled(c.env)) return c.json({ submissions: [] });
    const cap = await computeReviewerCapability(c.env.DB, user, rbac);
    const slug = c.req.query('slug');

    // 비공개 보류본은 wiki:private 권한자만 볼 수 있다 — 제출 시점 스냅샷(pe.is_private)과
    // 현재 페이지 비공개 상태(소프트 삭제 포함, slug UNIQUE 라 deleted_at 무관 EXISTS) 둘 다 검사.
    const privateFilter = cap.canViewPrivate
        ? ''
        : ' AND pe.is_private = 0 AND NOT EXISTS (SELECT 1 FROM pages pp WHERE pp.slug = pe.slug AND pp.is_private = 1)';
    // 문서 페이지의 "편집 요청 확인하기"용 — slug 한정 필터(선택).
    const slugFilter = slug ? ' AND pe.slug = ?' : '';
    // reviewsAll 이면 author 본인 제외 전체, 아니면 자신이 이전 편집한(page_editor) 문서만.
    const baseSelect = `
        SELECT pe.id, pe.slug, pe.action, pe.author_id, pe.base_revision_id, pe.base_version,
               pe.page_id, pe.category, pe.category_acl_choices,
               pe.summary, pe.updated_at, length(pe.content) AS content_length,
               u.name AS author_name,
               pd.edit_acl AS page_edit_acl,
               p.last_revision_id AS current_revision_id,
               p.version AS current_version,
               EXISTS (SELECT 1 FROM pages WHERE slug = pe.slug AND deleted_at IS NOT NULL) AS has_soft_deleted
        FROM pending_edits pe
        LEFT JOIN pages p ON p.slug = pe.slug AND p.deleted_at IS NULL
        LEFT JOIN pages pd ON pd.slug = pe.slug
        LEFT JOIN users u ON u.id = pe.author_id
        WHERE pe.author_id != ?${privateFilter}${slugFilter}`;
    const reviewerScope = cap.reviewsAll
        ? ''
        : ` AND pe.page_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM revisions r WHERE r.page_id = pe.page_id AND r.author_id = ?)`;
    const pageSql = `${baseSelect}${reviewerScope} ORDER BY pe.updated_at DESC, pe.id DESC LIMIT ? OFFSET ?`;
    // bind 순서: [user.id] (author 제외) → [slug?] (slugFilter) → [user.id?] (page_editor EXISTS) → [limit, offset]
    const whereBinds: (string | number)[] = [user.id];
    if (slug) whereBinds.push(slug);
    if (!cap.reviewsAll) whereBinds.push(user.id);
    type ListRow = {
        id: number; slug: string; action: string; author_id: number;
        page_id: number | null; category: string | null; category_acl_choices: string | null;
        base_revision_id: number | null; base_version: number;
        summary: string | null; updated_at: number; content_length: number;
        author_name: string | null; page_edit_acl: string | null;
        current_revision_id: number | null; current_version: number | null; has_soft_deleted: number;
    };

    // 비공개(create prefix)·문서 ACL 게이트는 SQL LIMIT 뒤 JS 에서 적용되므로, 최신 ACL-보호 요청이
    // 더 오래된 actionable 요청을 굶기지(starve) 못하도록, 원하는 개수(100)를 채우거나 후보가 소진될
    // 때까지(스캔 상한 내) updated_at DESC 로 배치 스캔한다. ACL 없는 행은 추가 쿼리 없이 통과한다.
    const DESIRED = 100;
    const FETCH_BATCH = 100;
    const MAX_SCAN = 1000;
    let prefixRules: DocPrefixPrivacyRule[] | null = null;
    const rows: ListRow[] = [];
    try {
        for (let offset = 0; rows.length < DESIRED && offset < MAX_SCAN; offset += FETCH_BATCH) {
            const { results } = await c.env.DB
                .prepare(pageSql)
                .bind(...whereBinds, FETCH_BATCH, offset)
                .all<ListRow>();
            const batch = results || [];
            if (batch.length === 0) break;
            for (const r of batch) {
                // create 보류본은 pages 행이 없어 SQL 비공개 필터가 닿지 않는다 — 현재 prefix 룰이 비공개를
                // 강제하는 create 행은 wiki:private 없는 검토자에게서 제외한다.
                if (!cap.canViewPrivate && r.action === 'create') {
                    if (prefixRules === null) prefixRules = await loadDocPrefixPrivacyRules(c.env.DB);
                    if (prefixRulesForcePrivate(prefixRules, r.slug)) continue;
                }
                // 문서 ACL 게이트 — 승인/반려 권한과 일치. ACL 없는 행은 추가 쿼리 없이 통과.
                if (await reviewerCanActOnPending(c, user, cap, r, parseEditAcl(r.page_edit_acl))) {
                    rows.push(r);
                    if (rows.length >= DESIRED) break;
                }
            }
            if (batch.length < FETCH_BATCH) break; // 후보 소진
        }
    } catch (e) {
        // 마이그레이션 미적용(pending_edits 테이블 없음) 시 빈 목록으로 폴백 — mypage 가 매번 호출하므로.
        if (isMissingPendingEditsTable(e)) return c.json({ submissions: [] });
        throw e;
    }

    const submissions = rows.map(r => {
        let hasConflict = false;
        let conflictReason: string | null = null;
        if (r.action === 'update') {
            if (r.current_revision_id === null) {
                hasConflict = true;
                conflictReason = 'page_missing';
            } else if (r.current_revision_id !== r.base_revision_id || r.current_version !== r.base_version) {
                hasConflict = true;
                conflictReason = 'concurrent_modification';
            }
        } else if (r.action === 'create') {
            if (r.current_revision_id !== null) {
                hasConflict = true;
                conflictReason = 'slug_taken';
            } else if (r.has_soft_deleted) {
                hasConflict = true;
                conflictReason = 'slug_soft_deleted';
            }
        }
        return {
            id: r.id,
            slug: r.slug,
            action: r.action,
            author_id: r.author_id,
            author_name: r.author_name,
            summary: r.summary,
            updated_at: unixToIso(r.updated_at),
            content_length: r.content_length,
            base_revision_id: r.base_revision_id,
            base_version: r.base_version,
            current_revision_id: r.current_revision_id,
            current_version: r.current_version,
            has_conflict: hasConflict,
            conflict_reason: conflictReason,
        };
    });
    return c.json({ submissions });
});

/**
 * GET /api/pending-edits/count?slug=
 * 검토 가능한 보류 개수. slug 지정 시 해당 문서 한정(문서 배너용).
 */
pendingEditsRoutes.get('/pending-edits/count', requireAuth, async (c) => {
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    if (!isEditRequestEnabled(c.env)) return c.json({ count: 0 });
    const cap = await computeReviewerCapability(c.env.DB, user, rbac);
    const slug = c.req.query('slug');

    const conds: string[] = ['pe.author_id != ?'];
    const binds: (string | number)[] = [user.id];
    if (!cap.canViewPrivate) {
        // 제출 시점 스냅샷 + 현재 페이지 비공개 상태(소프트 삭제 포함, slug UNIQUE 라 deleted_at 무관) 둘 다 제외.
        conds.push("pe.is_private = 0 AND NOT EXISTS (SELECT 1 FROM pages pp WHERE pp.slug = pe.slug AND pp.is_private = 1)");
    }
    if (!cap.reviewsAll) {
        conds.push('pe.page_id IS NOT NULL AND EXISTS (SELECT 1 FROM revisions r WHERE r.page_id = pe.page_id AND r.author_id = ?)');
        binds.push(user.id);
    }
    if (slug) {
        conds.push('pe.slug = ?');
        binds.push(slug);
    }

    // 후보 행을 가져와 JS 에서 (1) create 보류본의 현재 prefix-룰 비공개 제외(wiki:private 없는 검토자),
    // (2) 문서 ACL 게이트(목록/상세/승인·반려와 동일) 를 적용해 센다. SQL 만으로는 longest-match prefix
    // 비공개 판정과 동적 ACL(admin_only·page_editor 등) 평가가 어렵기 때문이다. ACL 필터가 SQL LIMIT 뒤
    // JS 에서 적용되므로, 최신 ACL-보호 요청이 actionable 요청을 굶기지 못하도록 후보가 소진될 때까지
    // (스캔 상한 내) 배치 스캔한다. 상한 도달 시 count 는 하한값(배지 정보용이라 충분).
    // 마이그레이션 미적용(테이블 없음) 시 0 으로 폴백.
    const candidateSql = `SELECT pe.slug, pe.action, pe.page_id, pe.category, pe.category_acl_choices,
                                 p.edit_acl AS page_edit_acl
                          FROM pending_edits pe
                          LEFT JOIN pages p ON p.slug = pe.slug
                          WHERE ${conds.join(' AND ')}
                          ORDER BY pe.updated_at DESC, pe.id DESC LIMIT ? OFFSET ?`;
    const COUNT_BATCH = 500;
    const COUNT_MAX_SCAN = 2000;
    let prefixRules: DocPrefixPrivacyRule[] | null = null;
    try {
        let count = 0;
        for (let offset = 0; offset < COUNT_MAX_SCAN; offset += COUNT_BATCH) {
            const { results } = await c.env.DB
                .prepare(candidateSql)
                .bind(...binds, COUNT_BATCH, offset)
                .all<{ slug: string; action: string; page_id: number | null; category: string | null; category_acl_choices: string | null; page_edit_acl: string | null }>();
            const batch = results || [];
            if (batch.length === 0) break;
            for (const r of batch) {
                if (!cap.canViewPrivate && r.action === 'create') {
                    if (prefixRules === null) prefixRules = await loadDocPrefixPrivacyRules(c.env.DB);
                    if (prefixRulesForcePrivate(prefixRules, r.slug)) continue;
                }
                if (await reviewerCanActOnPending(c, user, cap, r, parseEditAcl(r.page_edit_acl))) count++;
            }
            if (batch.length < COUNT_BATCH) break; // 후보 소진
        }
        return c.json({ count });
    } catch (e) {
        if (isMissingPendingEditsTable(e)) return c.json({ count: 0 });
        throw e;
    }
});

/**
 * GET /api/pending-edits/:id
 * 보류 상세 — proposed_content + 현재 본문(current_content) + 베이스 본문(base_content) + diff.
 */
pendingEditsRoutes.get('/pending-edits/:id', requireAuth, async (c) => {
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    // 기능 비활성(배포 kill switch) 시 잔여 row 도 다루지 못하게 차단 — list/count 와 동일 정책.
    if (!isEditRequestEnabled(c.env)) return c.json({ error: 'not found' }, 404);
    const cap = await computeReviewerCapability(c.env.DB, user, rbac);
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);
    const pe = await loadReviewablePendingEdit(c.env.DB, user, id, cap);
    if (!pe) return c.json({ error: 'not found' }, 404);
    // 문서 ACL 미통과 검토자에게는 본문(proposed/current/base) 노출을 막는다 — 승인/반려 게이트와 동일.
    // 존재 누설을 피하기 위해 403 대신 404 로 위장(loadReviewablePendingEdit 정책과 일관).
    if (!(await reviewerCanActOnPending(c, user, cap, pe))) {
        return c.json({ error: 'not found' }, 404);
    }

    const page = await c.env.DB.prepare(
        `SELECT id, version, is_private, content, last_revision_id, deleted_at,
                category AS current_category, redirect_to AS current_redirect_to
         FROM pages WHERE slug = ?`
    ).bind(pe.slug).first<{
        id: number; version: number; is_private: number;
        content: string; last_revision_id: number | null; deleted_at: number | null;
        current_category: string | null; current_redirect_to: string | null;
    }>();

    let currentContent = '';
    let baseContent = '';
    let hasConflict = false;
    let conflictReason: string | null = null;

    const enabledExt = getEnabledExtensions(c.env);
    const r2Only = isR2OnlyNamespace(pe.slug, enabledExt);

    if (pe.action === 'update') {
        if (!page || page.deleted_at !== null) {
            hasConflict = true;
            conflictReason = 'page_missing';
        } else {
            if (page.last_revision_id !== pe.base_revision_id || page.version !== pe.base_version) {
                hasConflict = true;
                conflictReason = 'concurrent_modification';
            }
            if (r2Only && page.last_revision_id) {
                const lastRev = await c.env.DB.prepare('SELECT content, r2_key FROM revisions WHERE id = ?')
                    .bind(page.last_revision_id)
                    .first<{ content: string; r2_key: string | null }>();
                if (lastRev) {
                    try {
                        currentContent = await getRevisionContent(c.env.MEDIA, lastRev, new URL(c.req.url).origin);
                    } catch {
                        currentContent = page.content || '';
                    }
                }
            } else {
                currentContent = page.content || '';
            }
            if (pe.base_revision_id) {
                if (pe.base_revision_id === page.last_revision_id) {
                    baseContent = currentContent;
                } else {
                    const baseRev = await c.env.DB.prepare('SELECT content, r2_key FROM revisions WHERE id = ?')
                        .bind(pe.base_revision_id)
                        .first<{ content: string; r2_key: string | null }>();
                    if (baseRev) {
                        try {
                            baseContent = await getRevisionContent(c.env.MEDIA, baseRev, new URL(c.req.url).origin);
                        } catch {
                            baseContent = baseRev.content || '';
                        }
                    }
                }
            }
        }
    } else if (pe.action === 'create') {
        if (page) {
            hasConflict = true;
            conflictReason = page.deleted_at === null ? 'slug_taken' : 'slug_soft_deleted';
        }
    }

    const diffStats = computeLineDiffStats(
        currentContent.replace(/\r\n?/g, '\n'),
        pe.content.replace(/\r\n?/g, '\n'),
    );

    const author = await c.env.DB.prepare('SELECT name FROM users WHERE id = ?')
        .bind(pe.author_id).first<{ name: string | null }>();

    return c.json({
        id: pe.id,
        slug: pe.slug,
        action: pe.action,
        status: 'pending_review',
        author_id: pe.author_id,
        author_name: author?.name ?? null,
        submitted_at: unixToIso(pe.updated_at),
        summary: pe.summary,
        base_revision_id: pe.base_revision_id,
        base_version: pe.base_version,
        category: pe.category,
        redirect_to: pe.redirect_to,
        // 요청이 제안한 대체 제목/레이아웃 — 에디터 승인 시 메타 입력칸/프레젠테이션 토글 프리로드용.
        title: pe.title,
        has_title_change: pe.has_title_change === 1,
        view_mode: pe.view_mode,
        apply_view: pe.apply_view === 1,
        proposed_content: pe.content,
        current_content: currentContent,
        base_content: baseContent,
        current_revision_id: page?.last_revision_id ?? null,
        current_version: page?.version ?? null,
        current_is_private: page?.is_private === 1,
        current_category: page?.current_category ?? null,
        has_conflict: hasConflict,
        conflict_reason: conflictReason,
        lines_added: diffStats?.added ?? 0,
        lines_removed: diffStats?.removed ?? 0,
    });
});

// 보류본 + 관련 알림 정리 + admin_log 기록 (승인/반려 공통 후처리).
async function cleanupPendingEdit(
    c: Context<Env>,
    pe: PendingEditRow,
    reviewer: User,
    logType: string,
    logMessage: string,
): Promise<void> {
    await c.env.DB.batch([
        c.env.DB.prepare("DELETE FROM notifications WHERE type = 'pending_edit' AND ref_id = ?").bind(pe.id),
        c.env.DB.prepare('DELETE FROM pending_edits WHERE id = ?').bind(pe.id),
    ]);
    c.executionCtx.waitUntil(
        c.env.DB.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
            .bind(logType, logMessage, reviewer.id)
            .run().catch(() => {})
    );
}

/**
 * POST /api/pending-edits/:id/approve
 * 보류 편집을 새 리비전으로 커밋. 리비전 author 는 **원 편집자**, 요약 끝에 검토자 닉네임+id 박제.
 * 승인 시점에 충돌/ACL 을 재검증한다(검토자 기준 ACL 평가).
 */
pendingEditsRoutes.post('/pending-edits/:id/approve', requireAuth, async (c) => {
    const user = c.get('user')!; // 검토자
    const rbac = c.get('rbac') as RBAC;
    // 기능 비활성(배포 kill switch) 시 잔여 row 의 승인·게시도 차단.
    if (!isEditRequestEnabled(c.env)) return c.json({ error: 'not found' }, 404);
    if (!rbac.can(user.role, 'wiki:edit')) {
        return c.json({ error: 'forbidden', message: 'wiki:edit 권한이 필요합니다.' }, 403);
    }
    const cap = await computeReviewerCapability(c.env.DB, user, rbac);
    const isAdmin = cap.isAdmin;
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);
    const pe = await loadReviewablePendingEdit(c.env.DB, user, id, cap);
    if (!pe) return c.json({ error: 'not found' }, 404);

    // 원 편집자 User 로드 — applyExistingPageUpdate/applyNewPageInsert 의 author 인자로 전달.
    const author = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
        .bind(pe.author_id).first<User>();
    if (!author) return c.json({ error: 'author_missing', message: '원 편집자 계정을 찾을 수 없습니다.' }, 409);

    // 검토자가 모달에서 요약을 수정해 보낸 경우 그 값을 사용하고, 키가 없으면 제출 시점 요약(pe.summary)으로 폴백.
    // (mcp-submissions approve 와 동일 정책: 명시적 빈 문자열은 빈 요약 의사로 보존.)
    // body.content 가 있으면 = 승인자가 에디터에서 추가 편집한 최종 본문 → 2-리비전 경로
    //   (rev1: 원 요청분=요청자 명의, rev2: 추가 편집분=승인자 명의). 없으면 현행 단일 리비전.
    const body = await c.req.json<{
        summary?: string; content?: string; expected_version?: number;
        category?: string; redirect_to?: string; title?: string | null; view_mode?: string | null;
    }>().catch(() => ({} as {
        summary?: string; content?: string; expected_version?: number;
        category?: string; redirect_to?: string; title?: string | null; view_mode?: string | null;
    }));
    const hasApproverContent = typeof body.content === 'string';
    const approverContent = hasApproverContent ? (body.content as string) : '';
    // 에디터 승인 경로가 로드/머지한 시점의 페이지 버전. 저장 직전 다른 편집이 끼어들었는지 검증한다.
    const expectedVersion = (typeof body.expected_version === 'number' && Number.isFinite(body.expected_version))
        ? body.expected_version
        : null;
    // 승인자가 에디터에서 바꾼 메타데이터를 rev2 에 반영(미전송 시 요청 메타로 폴백). rev1 은 항상 요청 메타.
    // (에디터는 content 모드에서 title/view_mode 를 string|null 로 명시 전송 — undefined 면 요청값 유지.)
    const rev2Category = (typeof body.category === 'string') ? body.category : pe.category;
    const rev2Redirect = (typeof body.redirect_to === 'string') ? body.redirect_to : pe.redirect_to;
    const rev2Title = (body.title !== undefined) ? body.title : (pe.has_title_change ? pe.title : undefined);
    const rev2View = (body.view_mode !== undefined) ? body.view_mode : (pe.apply_view ? pe.view_mode : undefined);
    const baseSummary = (typeof body.summary === 'string') ? body.summary : (pe.summary ?? '');
    // 요청자 명의 리비전(단일 승인=baseSummary, 2-리비전 rev1=원 요청 요약)의 요약 끝에 승인자 박제.
    // 2-리비전에서 baseSummary(body.summary)는 승인자의 추가 편집 요약(rev2)이므로, rev1 은 pe.summary 를 쓴다.
    const requesterSummary = buildApprovalSuffix(
        hasApproverContent ? (pe.summary ?? '') : baseSummary,
        { name: user.name, id: user.id },
    );
    const slug = pe.slug;

    // 원 편집자에게 보내는 승인 알림(단일/2-리비전/부분 공용).
    const notifyApproved = (content: string) => c.executionCtx.waitUntil(createNotification(c.env, c.executionCtx, {
        userId: pe.author_id,
        type: 'pending_edit_result',
        content,
        link: `/w/${encodeURIComponent(slug)}`,
    }).catch(() => {}));

    if (pe.action === 'update') {
        const page = await c.env.DB.prepare(
            'SELECT id, version, content, category, last_revision_id, title, edit_acl, redirect_to, view_mode, is_private FROM pages WHERE slug = ? AND deleted_at IS NULL'
        ).bind(slug).first<{ id: number; version: number; content: string; category: string | null; last_revision_id: number | null; title: string | null; edit_acl: string | null; redirect_to: string | null; view_mode: string | null; is_private: number }>();
        if (!page) return c.json({ error: 'conflict', reason: 'page_missing' }, 409);
        // 충돌 사전체크:
        //  - 단일 승인(no content): 제출 시점 base 와 현재가 동일해야 한다(pe.base_version).
        //  - 에디터 승인(content): 승인자가 **로드/머지한 버전**(expected_version)과 현재가 동일해야 한다.
        //    제출 base 와 달라도 승인자가 그 위에서 머지했으므로, base 가 아닌 로드 버전 기준으로 본다.
        //    그 사이 다른 편집이 끼어들면(page.version 상승) 머지본이 그 편집을 덮어쓰므로 409 로 막고
        //    에디터가 재머지하도록 유도한다. (expected_version 누락 시 base 기준으로 보수적 폴백.)
        const conflictDetected = hasApproverContent
            ? (expectedVersion !== null
                ? page.version !== expectedVersion
                : (page.last_revision_id !== pe.base_revision_id || page.version !== pe.base_version))
            : (page.last_revision_id !== pe.base_revision_id || page.version !== pe.base_version);
        if (conflictDetected) {
            return c.json({
                error: 'conflict',
                reason: 'concurrent_modification',
                base_revision_id: pe.base_revision_id,
                base_version: pe.base_version,
                expected_version: expectedVersion,
                current_revision_id: page.last_revision_id,
                current_version: page.version,
            }, 409);
        }

        // 페이지 edit_acl 을 **검토자** 기준으로 재평가 — 검토자는 이 문서를 편집(=승인)할 권한이 있어야 한다.
        const aclFail = await reviewerAclFailResponse(c.env.DB, parseEditAcl(page.edit_acl), user, page.id, cap.minAge, isAdmin);
        if (aclFail) return c.json(aclFail.body, aclFail.status);

        // 충돌 검사는 **최종 반영될** 대체 제목 기준. 2-리비전이면 rev2(승인자) 제목, 단일이면 요청 제목.
        const finalTitleForCheck = hasApproverContent
            ? (typeof rev2Title === 'string' && rev2Title.trim() ? rev2Title : null)
            : (pe.has_title_change && pe.title ? pe.title : null);
        if (finalTitleForCheck) {
            const titleConflict = await findConflictingPage(c.env.DB, finalTitleForCheck, page.id);
            if (titleConflict) {
                return c.json({
                    error: 'conflict',
                    reason: titleConflict.matchedColumn === 'slug' ? 'title_collides_with_slug' : 'title_taken',
                    message: titleConflict.matchedColumn === 'slug'
                        ? `'${finalTitleForCheck}' 는 이미 다른 문서의 제목입니다.`
                        : `'${finalTitleForCheck}' 는 이미 다른 문서의 대체 제목입니다.`,
                }, 409);
            }
        }

        // 충돌(stale-base) 머지 판정 — 요청 base 가 현재와 다른 채 승인자 머지본을 올리는 경우.
        // 이때 rev1(요청자 옛 본문)이 공개로 남은 채 rev2 가 실패하면 그 사이 편집이 유실되므로,
        // rev2 실패 시 rev1 을 보상 리비전으로 되돌리기 위해 승인 직전 본문/메타를 미리 캡처한다.
        const isStaleBaseMerge = hasApproverContent
            && (page.last_revision_id !== pe.base_revision_id || page.version !== pe.base_version);
        let preApproval: {
            content: string; category: string | null; title: string | null;
            redirectTo: string | null; viewMode: string | null; editAcl: string | null;
        } | null = null;
        if (isStaleBaseMerge) {
            const enabledExt = getEnabledExtensions(c.env);
            const r2Only = isR2OnlyNamespace(slug, enabledExt);
            let preContent = page.content || '';
            if (r2Only && page.last_revision_id) {
                const lastRev = await c.env.DB.prepare('SELECT content, r2_key FROM revisions WHERE id = ?')
                    .bind(page.last_revision_id).first<{ content: string; r2_key: string | null }>();
                if (lastRev) {
                    try { preContent = await getRevisionContent(c.env.MEDIA, lastRev, new URL(c.req.url).origin); }
                    catch { preContent = page.content || ''; }
                }
            }
            preApproval = {
                content: preContent, category: page.category, title: page.title,
                redirectTo: page.redirect_to, viewMode: page.view_mode, editAcl: page.edit_acl,
            };
        }

        try {
            // rev1: 원 요청분을 요청자 명의로 반영(요약 끝에 승인자 박제).
            // editAcl/viewMode/title/category/redirect 적용은 단일 승인 경로와 1:1 동일해야 한다
            // (카테고리 ACL 머지·presentation 토글 등 누락 방지). 변경 시 양쪽을 함께 수정할 것.
            const rev1 = await commitPageMutation(c, {
                kind: 'update',
                origin: 'pending_approve',
                actor: author,
                slug,
                content: pe.content,
                summary: requesterSummary,
                summaryRaw: true,
                category: pe.category,
                redirectTo: pe.redirect_to,
                // 2-리비전이면 rev1 에도 **최종(승인자) 제목**을 적용한다. 요청의 stale 한 제목을 중간에
                // 쓰면 그 제목이 그새 다른 문서에 점거됐을 때 rev1 write 가 UNIQUE 로 실패해, 승인자가
                // 제목을 고쳤는데도 승인이 막힌다(검사는 위에서 최종 제목 기준으로 이미 통과).
                title: hasApproverContent ? rev2Title : (pe.has_title_change ? pe.title : undefined),
                editAcl: pe.apply_edit_acl ? pe.edit_acl : undefined,
                viewMode: pe.apply_view ? pe.view_mode : undefined,
                page,
                isPrivate: page.is_private === 1,
                // 2-리비전이면 rev1 재색인을 await 해 rev2(최종 본문) 재색인보다 먼저 끝나도록 한다.
                awaitLinkCategoryIndex: hasApproverContent,
                rbac,
                // 단일 승인이면 이 리비전이 최종 → 주시자 알림. 2-리비전이면 rev1 은 중간 리비전이라
                // 억제하고 rev2(최종 본문)에서만 1회 알림한다(중복 알림 방지).
                notify: !hasApproverContent,
            });

            if (!hasApproverContent) {
                // 단일 리비전 — 기존 동작.
                await cleanupPendingEdit(c, pe, user, 'pending_edit_approve',
                    `[pending-edit] approved #${pe.id}: ${slug} (v${rev1.new_version}) author=${pe.author_id} reviewer=${user.id}`);
                notifyApproved(`"${slug}" 편집 요청이 승인되어 반영되었습니다.`);
                return c.json({
                    approved: true,
                    slug,
                    version: rev1.new_version,
                    revision_id: rev1.revision_id,
                    rows: rev1.rows,
                    characters: rev1.characters,
                });
            }

            // rev2: 승인자의 추가 편집을 승인자 명의로 반영(rev1 직후 버전에 CAS). 메타데이터는 승인자가
            // 에디터에서 바꾼 값(rev2*)을 적용한다(미전송 시 요청 메타로 폴백). editAcl 은 생략해 rev1 설정 유지.
            const pageAfterRev1 = {
                id: page.id,
                version: rev1.new_version,
                category: rev2Category ?? page.category,
                title: (rev2Title !== undefined) ? rev2Title : (pe.has_title_change ? pe.title : page.title),
            };
            let rev2;
            try {
                rev2 = await commitPageMutation(c, {
                    kind: 'update',
                    origin: 'pending_approve',
                    actor: user,
                    slug,
                    content: approverContent,
                    summary: baseSummary,
                    summaryRaw: true,
                    category: rev2Category,
                    redirectTo: rev2Redirect,
                    title: rev2Title,
                    viewMode: rev2View,
                    page: pageAfterRev1,
                    isPrivate: page.is_private === 1,
                    rbac,
                    // 최종 리비전 → 주시자 알림 1회(notify 기본 true).
                });
            } catch (e2: any) {
                // 충돌(stale-base) 머지에서 rev2 가 실패하면, rev1(요청자 옛 본문)을 공개로 남길 경우 그
                // 사이 편집이 유실된다. 이 경우 부분 승인으로 마감하지 않고 **보상 롤백** 후 요청을 유지(retryable)한다.
                if (isStaleBaseMerge && preApproval) {
                    // 동시 수정으로 실패(CONCURRENT_MODIFICATION)면 페이지가 rev1 이후 다른 편집으로 advance 돼
                    // rev1 본문은 이미 그 편집으로 덮여 비공개 → 롤백 불필요. 그 외(제목 UNIQUE·R2/D1)는 페이지가
                    // 아직 rev1 상태이므로 보상 리비전으로 승인 직전 본문/메타를 복원한다.
                    let rolledBack = false;
                    if (e2?.code !== 'CONCURRENT_MODIFICATION') {
                        try {
                            await commitPageMutation(c, {
                                kind: 'update',
                                origin: 'pending_approve',
                                actor: user,
                                slug,
                                content: preApproval.content,
                                page: { id: page.id, version: rev1.new_version, category: preApproval.category, title: preApproval.title },
                                summary: `편집 요청 승인 롤백: 추가 편집 반영 실패 (검토:${user.name}#${user.id})`,
                                summaryRaw: true,
                                category: preApproval.category,
                                redirectTo: preApproval.redirectTo,
                                title: preApproval.title ?? null,
                                editAcl: preApproval.editAcl,
                                viewMode: preApproval.viewMode,
                                isPrivate: page.is_private === 1,
                                rbac,
                                logType: 'pending_edit_rollback',
                                logMessage: `[pending-edit] rev2 failed, rolled back rev1 #${pe.id}: ${slug} rev1=${rev1.revision_id} err=${e2?.code || e2?.message || 'unknown'}`,
                                // 보상(롤백) 리비전 → 주시자 알림 억제.
                                notify: false,
                            });
                            rolledBack = true;
                        } catch (e3) {
                            console.error('pending-edit rollback failed:', e3);
                        }
                    }
                    // 요청은 cleanup 하지 않고 유지 → 검토자가 최신 본문 기준으로 다시 머지/승인할 수 있다.
                    return c.json({
                        error: 'conflict',
                        reason: 'rev2_failed',
                        rolled_back: rolledBack,
                        message: rolledBack
                            ? '추가 편집 반영에 실패해 문서를 승인 직전 상태로 되돌렸습니다. 다시 시도해 주세요.'
                            : '그 사이 다른 편집이 반영되어 승인을 완료하지 못했습니다. 최신 본문 기준으로 다시 시도해 주세요.',
                    }, 409);
                }
                // 비충돌(clean) 머지: rev1 = 요청 본문(base==current, 유실 없음) → 부분 승인으로 정리(요청 stuck 방지).
                const reasonNote = (e2?.code === 'CONCURRENT_MODIFICATION') ? '동시 수정 충돌' : '오류';
                await cleanupPendingEdit(c, pe, user, 'pending_edit_approve',
                    `[pending-edit] approved(partial) #${pe.id}: ${slug} rev1=${rev1.revision_id} rev2_failed=${e2?.code || e2?.message || 'unknown'} author=${pe.author_id} reviewer=${user.id}`);
                // rev1 은 부분 승인으로 **최종 공개 리비전**이 된다(rev2 미반영). 2-리비전 경로에서
                // rev1 알림을 억제했으므로(rev2 가 낼 예정이었음), 여기서 rev1(원 요청자 명의)에 대해
                // 주시자 알림을 1회 발송해야 update 승인의 알림 누락이 다시 생기지 않는다.
                notifyPageWatchers(c, {
                    pageId: page.id,
                    slug,
                    editorId: author.id,
                    editorName: author.name,
                    categories: (pe.category || '').split(',').map(s => s.trim()).filter(s => s.length > 0),
                    isPrivate: page.is_private === 1,
                    revisionId: rev1.revision_id,
                    summary: requesterSummary,
                    rbac,
                });
                notifyApproved(`"${slug}" 편집 요청이 승인되었습니다. (승인자 추가 편집은 ${reasonNote}로 미반영)`);
                return c.json({
                    approved: true,
                    partial: true,
                    slug,
                    version: rev1.new_version,
                    revision_id: rev1.revision_id,
                    rev1_revision_id: rev1.revision_id,
                });
            }
            await cleanupPendingEdit(c, pe, user, 'pending_edit_approve',
                `[pending-edit] approved(2-rev) #${pe.id}: ${slug} rev1=${rev1.revision_id}(author=${pe.author_id}) rev2=${rev2.revision_id}(reviewer=${user.id})`);
            notifyApproved(`"${slug}" 편집 요청이 승인·반영되었습니다. (승인자 추가 편집 포함)`);
            return c.json({
                approved: true,
                two_revisions: true,
                slug,
                version: rev2.new_version,
                revision_id: rev2.revision_id,
                rev1_revision_id: rev1.revision_id,
                rows: rev2.rows,
                characters: rev2.characters,
            });
        } catch (e: any) {
            if (e?.code === 'CONCURRENT_MODIFICATION') {
                return c.json({
                    error: 'conflict',
                    reason: 'concurrent_modification',
                    base_revision_id: pe.base_revision_id,
                    base_version: pe.base_version,
                }, 409);
            }
            return c.json({ error: 'apply_failed', message: e?.message || String(e) }, 500);
        }
    }

    if (pe.action === 'create') {
        const livePage = await c.env.DB.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL').bind(slug).first();
        if (livePage) return c.json({ error: 'conflict', reason: 'slug_taken' }, 409);
        const deletedConflict = await c.env.DB.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NOT NULL').bind(slug).first();
        if (deletedConflict) {
            return c.json({
                error: 'conflict',
                reason: 'slug_soft_deleted',
                message: '동일 제목의 소프트 삭제된 문서가 존재합니다. 관리자가 먼저 복원/영구삭제 처리해야 합니다.',
            }, 409);
        }
        const slugTitleConflict = await findConflictingPage(c.env.DB, slug, null);
        if (slugTitleConflict && slugTitleConflict.matchedColumn === 'title') {
            return c.json({
                error: 'conflict',
                reason: 'slug_collides_with_title',
                message: `'${slug}' 는 다른 문서의 대체 제목과 충돌해 제목으로 사용할 수 없습니다.`,
            }, 409);
        }
        // 충돌 검사는 **최종 반영될** 대체 제목 기준(2-리비전이면 rev2 승인자 제목, 단일이면 요청 제목).
        const createFinalTitle = hasApproverContent
            ? (typeof rev2Title === 'string' && rev2Title.trim() ? rev2Title : null)
            : (pe.has_title_change && pe.title ? pe.title : null);
        if (createFinalTitle) {
            const titleConflict = await findConflictingPage(c.env.DB, createFinalTitle, null);
            if (titleConflict) {
                return c.json({
                    error: 'conflict',
                    reason: titleConflict.matchedColumn === 'slug' ? 'title_collides_with_slug' : 'title_taken',
                    message: titleConflict.matchedColumn === 'slug'
                        ? `'${createFinalTitle}' 는 이미 다른 문서의 제목입니다.`
                        : `'${createFinalTitle}' 는 이미 다른 문서의 대체 제목입니다.`,
                }, 409);
            }
        }

        // 신규 문서 prefix 룰 / 카테고리 ACL 머지 — /api/w/:slug PUT(create) 와 동일 헬퍼.
        // direct-save 시맨틱을 보존하기 위해 **원본 author 의 category_acl_choices 를 그대로 재생**한다
        // (ignore/merge 등). 보류 작성자는 정의상 항상 비관리자(isTrustedEditor 가 admin 을 신뢰 처리)이므로,
        // 'overwrite'→'merge' 다운그레이드도 author 기준(isAdmin=false)으로 적용해야 direct-save 와 동일하다.
        const prefixed = await applyCreatePrefixRulesAndCategoryAcls(c.env.DB, slug, {
            category: pe.category,
            isPrivate: 0,
            editAcl: null,
            adminExplicitlySetEditAcl: false,
            categoryAclChoices: parseReplayChoices(pe),
            isAdmin: false,
        });
        const createEditAclSerialized = prefixed.finalEditAcl;
        const createCategory = prefixed.effectiveCategory;
        const createIsPrivate = prefixed.finalIsPrivate;

        // 최종 머지된 ACL 을 **검토자** 가 통과하는지 평가(승인=신규 생성 권한 필요).
        const createAclFail = await reviewerAclFailResponse(c.env.DB, parseEditAcl(createEditAclSerialized), user, null, cap.minAge, isAdmin);
        if (createAclFail) return c.json(createAclFail.body, createAclFail.status);

        try {
            // rev1: 요청자 명의로 신규 문서 생성(요약 끝에 승인자 박제).
            const rev1 = await commitPageMutation(c, {
                kind: 'create',
                origin: 'pending_approve',
                actor: author,
                slug,
                content: pe.content,
                summary: requesterSummary,
                summaryRaw: true,
                category: createCategory,
                redirectTo: pe.redirect_to,
                // 2-리비전이면 rev1(신규 생성)도 최종(승인자) 제목을 적용 — stale 한 요청 제목으로 인한
                // 중간 TITLE_TAKEN 을 피한다(검사는 위에서 최종 제목 기준으로 이미 통과).
                title: hasApproverContent ? (rev2Title ?? null) : (pe.has_title_change ? pe.title : null),
                editAcl: createEditAclSerialized,
                isPrivate: createIsPrivate === 1,
                viewMode: pe.apply_view ? pe.view_mode : null,
                // 2-리비전이면 rev1 재색인을 await 해 rev2(최종 본문) 재색인보다 먼저 끝나도록 한다.
                awaitLinkCategoryIndex: hasApproverContent,
                rbac,
                // 신규 문서 생성은 직접 PUT(create) 경로와 동일하게 주시자 알림을 보내지 않는다.
                notify: false,
            });

            if (!hasApproverContent) {
                await cleanupPendingEdit(c, pe, user, 'pending_edit_approve',
                    `[pending-edit] approved #${pe.id} (create): ${slug} (v1) author=${pe.author_id} reviewer=${user.id}`);
                notifyApproved(`"${slug}" 새 문서 편집 요청이 승인되어 게시되었습니다.`);
                return c.json({
                    approved: true,
                    slug,
                    version: 1,
                    revision_id: rev1.revision_id,
                    rows: rev1.rows,
                    characters: rev1.characters,
                    created: true,
                });
            }

            // rev2: 승인자의 추가 편집을 승인자 명의로 반영(방금 생성된 v1 페이지에 CAS → v2).
            // 카테고리는 createCategory(프리픽스 룰 머지 결과)를 유지해 신규 생성 ACL/머지를 보존한다
            // (신규 문서에서 승인자의 카테고리 변경은 무시 — 필요 시 게시 후 일반 편집으로 조정).
            // redirect/title/layout 은 승인자 값(rev2*)을 반영한다. editAcl 은 rev1 설정 유지(생략).
            const createdPage = {
                id: rev1.page_id,
                version: 1,
                category: createCategory,
                title: (rev2Title !== undefined) ? rev2Title : (pe.has_title_change ? pe.title : null),
            };
            let rev2;
            try {
                rev2 = await commitPageMutation(c, {
                    kind: 'update',
                    origin: 'pending_approve',
                    actor: user,
                    slug,
                    content: approverContent,
                    summary: baseSummary,
                    summaryRaw: true,
                    category: createCategory,
                    redirectTo: rev2Redirect,
                    title: rev2Title,
                    viewMode: rev2View,
                    page: createdPage,
                    isPrivate: createIsPrivate === 1,
                    rbac,
                    // 신규 문서 생성 흐름(2-리비전 create)의 rev2 → 직접 PUT(create) 와 동일하게 알림 억제.
                    notify: false,
                });
            } catch (e2: any) {
                // rev1(신규 문서)은 이미 생성·공개됨. 사유 무관하게 요청을 정리하고 부분 승인으로 알린다
                // (정리하지 않으면 slug 가 점거된 채 재시도가 slug_taken 으로 막혀 요청이 stuck 된다).
                const reasonNote = (e2?.code === 'CONCURRENT_MODIFICATION') ? '동시 수정 충돌' : '오류';
                await cleanupPendingEdit(c, pe, user, 'pending_edit_approve',
                    `[pending-edit] approved(partial create) #${pe.id}: ${slug} rev1=${rev1.revision_id} rev2_failed=${e2?.code || e2?.message || 'unknown'} author=${pe.author_id} reviewer=${user.id}`);
                notifyApproved(`"${slug}" 새 문서 편집 요청이 승인되어 게시되었습니다. (승인자 추가 편집은 ${reasonNote}로 미반영)`);
                return c.json({
                    approved: true,
                    partial: true,
                    slug,
                    version: 1,
                    revision_id: rev1.revision_id,
                    rev1_revision_id: rev1.revision_id,
                    created: true,
                });
            }
            await cleanupPendingEdit(c, pe, user, 'pending_edit_approve',
                `[pending-edit] approved(2-rev create) #${pe.id}: ${slug} rev1=${rev1.revision_id}(author=${pe.author_id}) rev2=${rev2.revision_id}(reviewer=${user.id})`);
            notifyApproved(`"${slug}" 새 문서 편집 요청이 승인·게시되었습니다. (승인자 추가 편집 포함)`);
            return c.json({
                approved: true,
                two_revisions: true,
                slug,
                version: rev2.new_version,
                revision_id: rev2.revision_id,
                rev1_revision_id: rev1.revision_id,
                rows: rev2.rows,
                characters: rev2.characters,
                created: true,
            });
        } catch (e: any) {
            if (e?.code === 'SLUG_TAKEN') return c.json({ error: 'conflict', reason: 'slug_taken' }, 409);
            if (e?.code === 'TITLE_TAKEN') return c.json({ error: 'conflict', reason: 'title_taken' }, 409);
            return c.json({ error: 'apply_failed', message: e?.message || String(e) }, 500);
        }
    }

    return c.json({ error: 'unknown_action', action: pe.action }, 400);
});

/**
 * POST /api/pending-edits/:id/reject
 * 보류본 폐기. 보류본 + 알림 삭제, admin_log 기록, 원 편집자에게 반려 알림.
 */
pendingEditsRoutes.post('/pending-edits/:id/reject', requireAuth, async (c) => {
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    // 기능 비활성(배포 kill switch) 시 잔여 row 의 반려 처리도 차단 — 토글 off 면 워크플로우 전체 정지.
    if (!isEditRequestEnabled(c.env)) return c.json({ error: 'not found' }, 404);
    if (!rbac.can(user.role, 'wiki:edit')) {
        return c.json({ error: 'forbidden', message: 'wiki:edit 권한이 필요합니다.' }, 403);
    }
    const cap = await computeReviewerCapability(c.env.DB, user, rbac);
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);
    const pe = await loadReviewablePendingEdit(c.env.DB, user, id, cap);
    if (!pe) return c.json({ error: 'not found' }, 404);

    // 승인과 동일한 edit_acl 게이트를 반려에도 적용 — admin_only/aged 등으로 보호된 문서의 보류본을,
    // 그 문서를 편집할 수 없는 검토자가 임의로 폐기하지 못하게 한다(승인 경로와 권한 판정 일치).
    const aclFail = await reviewerAclFailResponse(
        c.env.DB,
        await resolveReviewerEditAcl(c, pe),
        user,
        pe.action === 'update' ? pe.page_id : null,
        cap.minAge,
        cap.isAdmin,
    );
    if (aclFail) return c.json(aclFail.body, aclFail.status);

    const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
    const reason = (typeof body.reason === 'string' && body.reason.trim()) ? ` (${body.reason.trim().slice(0, 100)})` : '';

    await cleanupPendingEdit(c, pe, user, 'pending_edit_reject',
        `[pending-edit] rejected #${pe.id}: ${pe.slug} author=${pe.author_id} reviewer=${user.id}`);
    c.executionCtx.waitUntil(createNotification(c.env, c.executionCtx, {
        userId: pe.author_id,
        type: 'pending_edit_result',
        content: `"${pe.slug}" 편집 요청이 반려되었습니다.${reason}`,
        link: `/w/${encodeURIComponent(pe.slug)}`,
    }).catch(() => {}));
    return c.json({ rejected: true, id: pe.id, slug: pe.slug });
});

export default pendingEditsRoutes;
