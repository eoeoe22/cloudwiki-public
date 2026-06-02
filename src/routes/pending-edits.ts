// 사람 편집 보류 리비전(pending changes) 검토 워크플로우.
//
// settings.pending_changes_enabled=1 일 때, 신뢰되지 않은 사용자의 PUT /api/w/:slug 편집은
// 즉시 리비전이 되지 않고 pending_edits 에 보관된다(holdPendingEdit, wiki.ts). 본 라우트는
// 그 보류본을 **검토자**(관리자 또는 신뢰 사용자) 가 검토·승인·반려하는 HTTP 인터페이스다.
//
// MCP 제출안(mcp-submissions.ts)이 "자기 검토"(작성자=검토자) 인 것과 달리, 보류 편집은
// 반달 대응이 목적이므로 **작성자 본인은 검토에서 제외**되고 검토자는 신뢰 사용자/관리자다.
//
// 검토 권한(reviewable):
//   - 관리자(admin:access): 모든 보류본.
//   - aged 사용자(가입 경과 >= edit_acl_min_age_days): 모든 보류본(aged 는 문서 무관 상수).
//   - 그 외: 자신이 이전에 편집한 문서(page_editor) 의 보류본만.
//   - 단 항상 author_id != 본인.
//
// 승인 시: 리비전 author 는 **원 편집자**로 기록하고, 편집 요약 끝에 검토자 닉네임+id 를 강제 박제한다.
//
// 노출 엔드포인트:
//   GET  /api/pending-edits             — 검토 가능한 보류 목록
//   GET  /api/pending-edits/count       — (선택) ?slug= 로 문서별 카운트(배너용), 미지정 시 전체
//   GET  /api/pending-edits/:id         — 보류 본문 + 현재/베이스 본문 + diff
//   POST /api/pending-edits/:id/approve — 원 편집자 author 로 새 리비전 생성
//   POST /api/pending-edits/:id/reject  — 보류본 + 관련 알림 폐기

import { Hono, type Context } from 'hono';
import type { Env, User } from '../types';
import { requireAuth } from '../middleware/session';
import { RBAC } from '../utils/role';
import { isR2OnlyNamespace } from '../utils/slug';
import { getRevisionContent } from '../utils/r2';
import { computeLineDiffStats } from '../utils/diff';
import { applyExistingPageUpdate, applyNewPageInsert } from './admin-mcp';
import { findConflictingPage, applyCreatePrefixRulesAndCategoryAcls } from './wiki';
import { createNotification } from '../utils/notification';
import {
    parseEditAcl,
    evaluateEditAcl,
    getEditAclMinAgeDays,
    loadDocPrefixPrivacyRules,
    prefixRulesForcePrivate,
    type EditAcl,
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
    layout_mode: string | null;
    apply_layout: number;
    category_acl_choices: string | null;
    created_at: number;
    updated_at: number;
}

function unixToIso(sec: number | null): string | null {
    if (sec === null) return null;
    return new Date(sec * 1000).toISOString();
}

// 편집 요약 끝에 검토자 닉네임+숫자 id 를 강제 박제한다. 255자 초과 시 작성자 요약만 말줄임표(…)로
// 잘라 한도를 맞추되, 검토자 접미는 항상 보존한다.
function buildReviewerSuffix(authorSummary: string | null, reviewer: { name: string; id: number }): string {
    const suffix = ` (검토:${reviewer.name}#${reviewer.id})`;
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
//   update: 현재 페이지의 edit_acl (slug UNIQUE, 라이브 페이지 기준)
//   create: prefix+카테고리 ACL 재생 결과(작성자=비관리자 기준 isAdmin=false 로 direct-save 시맨틱 보존)
async function resolveReviewerEditAcl(c: Context<Env>, pe: PendingEditRow): Promise<EditAcl | null> {
    if (pe.action === 'update') {
        const row = await c.env.DB
            .prepare('SELECT edit_acl FROM pages WHERE slug = ? AND deleted_at IS NULL')
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
                is_private, edit_acl, apply_edit_acl, layout_mode, apply_layout, category_acl_choices, created_at, updated_at
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
    const cap = await computeReviewerCapability(c.env.DB, user, rbac);

    // 비공개 보류본은 wiki:private 권한자만 볼 수 있다 — 제출 시점 스냅샷(pe.is_private)과
    // 현재 페이지 비공개 상태(소프트 삭제 포함, slug UNIQUE 라 deleted_at 무관 EXISTS) 둘 다 검사.
    const privateFilter = cap.canViewPrivate
        ? ''
        : ' AND pe.is_private = 0 AND NOT EXISTS (SELECT 1 FROM pages pp WHERE pp.slug = pe.slug AND pp.is_private = 1)';
    // reviewsAll 이면 author 본인 제외 전체, 아니면 자신이 이전 편집한(page_editor) 문서만.
    const baseSelect = `
        SELECT pe.id, pe.slug, pe.action, pe.author_id, pe.base_revision_id, pe.base_version,
               pe.summary, pe.updated_at, length(pe.content) AS content_length,
               u.name AS author_name,
               p.last_revision_id AS current_revision_id,
               p.version AS current_version,
               EXISTS (SELECT 1 FROM pages WHERE slug = pe.slug AND deleted_at IS NOT NULL) AS has_soft_deleted
        FROM pending_edits pe
        LEFT JOIN pages p ON p.slug = pe.slug AND p.deleted_at IS NULL
        LEFT JOIN users u ON u.id = pe.author_id
        WHERE pe.author_id != ?${privateFilter}`;
    const sql = cap.reviewsAll
        ? `${baseSelect} ORDER BY pe.updated_at DESC LIMIT 100`
        : `${baseSelect} AND pe.page_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM revisions r WHERE r.page_id = pe.page_id AND r.author_id = ?)
           ORDER BY pe.updated_at DESC LIMIT 100`;
    const stmt = cap.reviewsAll
        ? c.env.DB.prepare(sql).bind(user.id)
        : c.env.DB.prepare(sql).bind(user.id, user.id);
    type ListRow = {
        id: number; slug: string; action: string; author_id: number;
        base_revision_id: number | null; base_version: number;
        summary: string | null; updated_at: number; content_length: number;
        author_name: string | null;
        current_revision_id: number | null; current_version: number | null; has_soft_deleted: number;
    };
    let results: ListRow[];
    try {
        ({ results } = await stmt.all<ListRow>());
    } catch (e) {
        // 마이그레이션 미적용(pending_edits 테이블 없음) 시 빈 목록으로 폴백 — mypage 가 매번 호출하므로.
        if (isMissingPendingEditsTable(e)) return c.json({ submissions: [] });
        throw e;
    }

    // create 보류본은 pages 행이 없어 위 SQL 의 현재-페이지 비공개 필터가 닿지 않는다.
    // 현재 prefix 룰이 비공개를 강제하는 create 행은 wiki:private 없는 검토자에게서 제외한다.
    let rows = results || [];
    if (!cap.canViewPrivate && rows.some(r => r.action === 'create')) {
        const prefixRules = await loadDocPrefixPrivacyRules(c.env.DB);
        rows = rows.filter(r => !(r.action === 'create' && prefixRulesForcePrivate(prefixRules, r.slug)));
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

    // create 보류본의 현재 prefix-룰 비공개는 SQL 로 longest-match 판정이 어려우므로,
    // wiki:private 없는 검토자에 한해 후보 행(slug/action)을 가져와 JS 에서 제외한 뒤 센다.
    // (목록/상세 게이팅과 동일한 prefixRulesForcePrivate 정책 — 배지와 목록 일관성 유지.)
    // 마이그레이션 미적용(테이블 없음) 시 0 으로 폴백.
    try {
        if (!cap.canViewPrivate) {
            const { results } = await c.env.DB
                .prepare(`SELECT pe.slug, pe.action FROM pending_edits pe WHERE ${conds.join(' AND ')} LIMIT 500`)
                .bind(...binds)
                .all<{ slug: string; action: string }>();
            const candidates = results || [];
            const hasCreate = candidates.some(r => r.action === 'create');
            const prefixRules = hasCreate ? await loadDocPrefixPrivacyRules(c.env.DB) : [];
            const count = candidates.filter(r => !(r.action === 'create' && prefixRulesForcePrivate(prefixRules, r.slug))).length;
            return c.json({ count });
        }

        const row = await c.env.DB
            .prepare(`SELECT COUNT(*) AS cnt FROM pending_edits pe WHERE ${conds.join(' AND ')}`)
            .bind(...binds)
            .first<{ cnt: number }>();
        return c.json({ count: row?.cnt ?? 0 });
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
    const cap = await computeReviewerCapability(c.env.DB, user, rbac);
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);
    const pe = await loadReviewablePendingEdit(c.env.DB, user, id, cap);
    if (!pe) return c.json({ error: 'not found' }, 404);

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

    const enabledExt = (c.env.ENABLED_EXTENSIONS || '').split(',').map(s => s.trim()).filter(Boolean);
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
    const body = await c.req.json<{ summary?: string }>().catch(() => ({} as { summary?: string }));
    const baseSummary = (typeof body.summary === 'string') ? body.summary : (pe.summary ?? '');
    const finalSummary = buildReviewerSuffix(baseSummary, { name: user.name, id: user.id });
    const slug = pe.slug;

    if (pe.action === 'update') {
        const page = await c.env.DB.prepare(
            'SELECT id, version, content, category, last_revision_id, title, edit_acl FROM pages WHERE slug = ? AND deleted_at IS NULL'
        ).bind(slug).first<{ id: number; version: number; content: string; category: string | null; last_revision_id: number | null; title: string | null; edit_acl: string | null }>();
        if (!page) return c.json({ error: 'conflict', reason: 'page_missing' }, 409);
        if (page.last_revision_id !== pe.base_revision_id || page.version !== pe.base_version) {
            return c.json({
                error: 'conflict',
                reason: 'concurrent_modification',
                base_revision_id: pe.base_revision_id,
                base_version: pe.base_version,
                current_revision_id: page.last_revision_id,
                current_version: page.version,
            }, 409);
        }

        // 페이지 edit_acl 을 **검토자** 기준으로 재평가 — 검토자는 이 문서를 편집(=승인)할 권한이 있어야 한다.
        const aclFail = await reviewerAclFailResponse(c.env.DB, parseEditAcl(page.edit_acl), user, page.id, cap.minAge, isAdmin);
        if (aclFail) return c.json(aclFail.body, aclFail.status);

        if (pe.has_title_change && pe.title) {
            const titleConflict = await findConflictingPage(c.env.DB, pe.title, page.id);
            if (titleConflict) {
                return c.json({
                    error: 'conflict',
                    reason: titleConflict.matchedColumn === 'slug' ? 'title_collides_with_slug' : 'title_taken',
                    message: titleConflict.matchedColumn === 'slug'
                        ? `'${pe.title}' 는 이미 다른 문서의 제목입니다.`
                        : `'${pe.title}' 는 이미 다른 문서의 대체 제목입니다.`,
                }, 409);
            }
        }

        try {
            const result = await applyExistingPageUpdate(c, author, page, pe.content, {
                summary: finalSummary,
                summaryRaw: true,
                category: pe.category,
                redirectTo: pe.redirect_to,
                title: pe.has_title_change ? pe.title : undefined,
                // 이 편집이 edit_acl 을 바꾸려던 경우(카테고리 ACL 머지 등)만 적용 — direct-save 의 willUpdateEditAcl 과 동일.
                // apply_edit_acl=0 이면 undefined 로 두어 기존 ACL 을 그대로 유지(out-of-band ACL 변경 클로버 방지).
                editAcl: pe.apply_edit_acl ? pe.edit_acl : undefined,
                // layout_mode 도 편집이 지정한 경우만 적용(apply_layout=0 이면 기존 유지).
                layoutMode: pe.apply_layout ? pe.layout_mode : undefined,
                slug,
            });
            await cleanupPendingEdit(c, pe, user, 'pending_edit_approve',
                `[pending-edit] approved #${pe.id}: ${slug} (v${page.version + 1}) author=${pe.author_id} reviewer=${user.id}`);
            // 원 편집자에게 승인 알림.
            c.executionCtx.waitUntil(createNotification(c.env, c.executionCtx, {
                userId: pe.author_id,
                type: 'pending_edit_result',
                content: `"${slug}" 편집이 승인되어 반영되었습니다.`,
                link: `/w/${encodeURIComponent(slug)}`,
            }).catch(() => {}));
            return c.json({
                approved: true,
                slug,
                version: result.new_version,
                revision_id: result.revision_id,
                rows: result.rows,
                characters: result.characters,
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
        if (pe.has_title_change && pe.title) {
            const titleConflict = await findConflictingPage(c.env.DB, pe.title, null);
            if (titleConflict) {
                return c.json({
                    error: 'conflict',
                    reason: titleConflict.matchedColumn === 'slug' ? 'title_collides_with_slug' : 'title_taken',
                    message: titleConflict.matchedColumn === 'slug'
                        ? `'${pe.title}' 는 이미 다른 문서의 제목입니다.`
                        : `'${pe.title}' 는 이미 다른 문서의 대체 제목입니다.`,
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
            const result = await applyNewPageInsert(c, author, slug, pe.content, {
                summary: finalSummary,
                summaryRaw: true,
                category: createCategory,
                redirectTo: pe.redirect_to,
                title: pe.has_title_change ? pe.title : null,
                editAcl: createEditAclSerialized,
                isPrivate: createIsPrivate,
                layoutMode: pe.apply_layout ? pe.layout_mode : null,
            });
            await cleanupPendingEdit(c, pe, user, 'pending_edit_approve',
                `[pending-edit] approved #${pe.id} (create): ${slug} (v1) author=${pe.author_id} reviewer=${user.id}`);
            c.executionCtx.waitUntil(createNotification(c.env, c.executionCtx, {
                userId: pe.author_id,
                type: 'pending_edit_result',
                content: `"${slug}" 새 문서 생성이 승인되어 게시되었습니다.`,
                link: `/w/${encodeURIComponent(slug)}`,
            }).catch(() => {}));
            return c.json({
                approved: true,
                slug,
                version: 1,
                revision_id: result.revision_id,
                rows: result.rows,
                characters: result.characters,
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
        content: `"${pe.slug}" 편집이 반려되었습니다.${reason}`,
        link: `/w/${encodeURIComponent(pe.slug)}`,
    }).catch(() => {}));
    return c.json({ rejected: true, id: pe.id, slug: pe.slug });
});

export default pendingEditsRoutes;
