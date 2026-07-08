// MCP 편집 승인 대기 (mcp-submission) 사용자 워크플로우.
//
// AI 가 /api/mcp 의 commit_edit 로 제출한 draft 는
// 즉시 새 리비전이 되지 않고 mcp_drafts.submitted_at 에 타임스탬프가 찍힌다.
// 본 라우트는 그 제출안을 OAuth 토큰 소유자(=user_id) 가 검토하고 승인 또는 거부하는
// HTTP 인터페이스를 제공한다. 모든 라우트는 본인의 제출안만 보고 조작할 수 있다 —
// MCP_MODE 가 disabled 인 환경에서도 동작한다 (이미 제출된 결과물 처리는 별개의 사이클).
//
// 노출 엔드포인트:
//   GET  /api/mcp-submissions             — 본인 제출안 목록
//   GET  /api/mcp-submissions/count       — (선택) ?slug= 로 문서별 카운트, 미지정 시 전체
//   GET  /api/mcp-submissions/:id         — 제출 본문 + 페이지 현재 본문(비교용)
//   POST /api/mcp-submissions/:id/approve — 새 리비전 생성 (공용 applyDraftMutation 위임)
//   POST /api/mcp-submissions/:id/reject  — draft + 관련 알림 폐기
//
// 승인 시점에 페이지가 잠겼거나, 다른 사용자가 그 사이 페이지를 수정해 base_revision_id 가
// 변했거나, 페이지가 삭제되었으면 409 Conflict 와 함께 거부한다 — 같은 정책을 MCP 즉시 적용
// (apply_edit) 과 공유한다. 실제 확정 로직은 utils/mcpDraftApply.ts 의 applyDraftMutation 단일 소스.

import { Hono } from 'hono';
import type { Env, User } from '../types';
import { requireAuth } from '../middleware/session';
import { RBAC } from '../utils/role';
import { isR2OnlyNamespace } from '../utils/slug';
import { getEnabledExtensions } from '../utils/extensions';
import { getRevisionContent } from '../utils/r2';
import { computeLineDiffStats } from '../utils/diff';
import { ensureMcpDraftsMigration } from '../utils/mcpDraftsMigration';
import { validateMcpSummaryLength } from './admin-mcp';
import { applyDraftMutation } from '../utils/mcpDraftApply';

const mcpSubmissionsRoutes = new Hono<Env>();

// 본 라우터의 모든 핸들러는 mcp_drafts.submitted_at/submitted_summary 컬럼을 사용하므로
// 진입 시 idempotent 마이그레이션을 보장한다 — isolate 당 한 번만 실행된다.
mcpSubmissionsRoutes.use('/mcp-submissions/*', async (c, next) => {
    await ensureMcpDraftsMigration(c.env.DB);
    await next();
});

interface DraftRow {
    id: number;
    user_id: number;
    slug: string;
    action: string;
    base_revision_id: number | null;
    base_version: number;
    content: string;
    category: string | null;
    redirect_to: string | null;
    title: string | null;
    has_title_change: number;
    submitted_at: number | null;
    submitted_summary: string | null;
    updated_at: number;
}

function unixToIso(sec: number | null): string | null {
    if (sec === null) return null;
    return new Date(sec * 1000).toISOString();
}

// 본인 제출안 한 건을 로드하면서 소유 검증까지 한 번에 수행. 다른 유저의 draft 든 작성 중
// (submitted_at IS NULL) 이든 모두 404 로 위장해 존재 여부 누설을 막는다.
async function loadSubmittedDraftForUser(
    env: Env['Bindings'],
    user: User,
    draftId: number,
): Promise<DraftRow | null> {
    const row = await env.DB.prepare(
        `SELECT id, user_id, slug, action, base_revision_id, base_version,
                content, category, redirect_to, title, has_title_change,
                submitted_at, submitted_summary, updated_at
         FROM mcp_drafts WHERE id = ? AND user_id = ? AND submitted_at IS NOT NULL`
    ).bind(draftId, user.id).first<DraftRow>();
    return row ?? null;
}

/**
 * GET /api/mcp-submissions
 * 본인 제출안 목록 (최신순). 페이지별 현재 last_revision_id / version 도 함께 조인해
 * has_conflict 를 미리 계산한다 — mypage 에서 충돌 경고를 노출하기 위함.
 */
mcpSubmissionsRoutes.get('/mcp-submissions', requireAuth, async (c) => {
    const user = c.get('user')!;
    // LEFT JOIN 은 live 페이지만 매칭하고, soft-deleted 슬러그는 EXISTS 서브쿼리로 별도 감지한다.
    // create 액션 제출이 그 사이 슬러그가 소프트 삭제된 동일 슬러그와 충돌하는 경우 approve 가 거부하므로
    // 목록/배지에도 미리 충돌로 표시해 사용자에게 일관된 신호를 준다.
    const { results } = await c.env.DB.prepare(`
        SELECT d.id, d.slug, d.action, d.base_revision_id, d.base_version,
               d.submitted_at, d.submitted_summary, d.updated_at,
               length(d.content) AS content_length,
               p.last_revision_id AS current_revision_id,
               p.version AS current_version,
               p.deleted_at AS current_deleted_at,
               EXISTS (SELECT 1 FROM pages WHERE slug = d.slug AND deleted_at IS NOT NULL) AS has_soft_deleted
        FROM mcp_drafts d
        LEFT JOIN pages p ON p.slug = d.slug AND p.deleted_at IS NULL
        WHERE d.user_id = ? AND d.submitted_at IS NOT NULL
        ORDER BY d.submitted_at DESC
        LIMIT 100
    `).bind(user.id).all<{
        id: number; slug: string; action: string; base_revision_id: number | null; base_version: number;
        submitted_at: number; submitted_summary: string | null; updated_at: number; content_length: number;
        current_revision_id: number | null; current_version: number | null;
        current_deleted_at: number | null; has_soft_deleted: number;
    }>();

    const submissions = results.map(r => {
        // action='update' 인데 현재 페이지가 없으면 (=삭제됨) 충돌. 있으면 base 와 현재 비교.
        // action='create' 인데 현재 페이지가 있으면 슬러그 점거 충돌.
        //   추가로 소프트 삭제된 동일 슬러그 페이지가 있으면 approve 단계에서 거부되므로 미리 표시한다.
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
            submitted_at: unixToIso(r.submitted_at),
            submitted_summary: r.submitted_summary,
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
 * GET /api/mcp-submissions/count?slug=
 * 현재 유저의 제출안 개수. slug 지정 시 해당 문서로 한정 (문서 페이지 배너용).
 * 미지정 시 전체 (사이드바/뱃지용).
 */
mcpSubmissionsRoutes.get('/mcp-submissions/count', requireAuth, async (c) => {
    const user = c.get('user')!;
    const slug = c.req.query('slug');
    const sql = slug
        ? 'SELECT COUNT(*) AS cnt FROM mcp_drafts WHERE user_id = ? AND submitted_at IS NOT NULL AND slug = ?'
        : 'SELECT COUNT(*) AS cnt FROM mcp_drafts WHERE user_id = ? AND submitted_at IS NOT NULL';
    const stmt = slug
        ? c.env.DB.prepare(sql).bind(user.id, slug)
        : c.env.DB.prepare(sql).bind(user.id);
    const row = await stmt.first<{ cnt: number }>();
    return c.json({ count: row?.cnt ?? 0 });
});

/**
 * GET /api/mcp-submissions/:id
 * 제출 상세 — proposed_content + 페이지 현재 본문(current_content) + 메타.
 * R2 전용 네임스페이스면 현재 본문은 마지막 리비전 R2 키에서 읽는다.
 */
mcpSubmissionsRoutes.get('/mcp-submissions/:id', requireAuth, async (c) => {
    const user = c.get('user')!;
    const draftId = Number(c.req.param('id'));
    if (!Number.isFinite(draftId) || draftId <= 0) {
        return c.json({ error: 'invalid id' }, 400);
    }
    const draft = await loadSubmittedDraftForUser(c.env, user, draftId);
    if (!draft) return c.json({ error: 'not found' }, 404);

    const page = await c.env.DB.prepare(
        `SELECT id, version, is_private, content, last_revision_id, deleted_at,
                category AS current_category, redirect_to AS current_redirect_to
         FROM pages WHERE slug = ?`
    ).bind(draft.slug).first<{
        id: number; version: number; is_private: number;
        content: string; last_revision_id: number | null; deleted_at: number | null;
        current_category: string | null; current_redirect_to: string | null;
    }>();

    let currentContent = '';
    let baseContent = '';
    let hasConflict = false;
    let conflictReason: string | null = null;

    if (draft.action === 'update') {
        if (!page || page.deleted_at !== null) {
            hasConflict = true;
            conflictReason = 'page_missing';
        } else {
            if (page.last_revision_id !== draft.base_revision_id || page.version !== draft.base_version) {
                hasConflict = true;
                conflictReason = 'concurrent_modification';
            }
            const enabledExt = getEnabledExtensions(c.env);
            const r2Only = isR2OnlyNamespace(draft.slug, enabledExt);
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
            // base_content = AI 가 draft 를 시작했을 때 본 본문 (= base_revision_id 리비전).
            // 3-way merge (base / ours=proposed / theirs=current) 를 에디터에서 열려면 필요하다.
            // 충돌이 없으면 base == current 라 굳이 별도 fetch 가 필요 없지만, 충돌 케이스에서만
            // 분기하면 응답 스키마가 들쭉날쭉해지므로 항상 채운다.
            if (draft.base_revision_id) {
                if (draft.base_revision_id === page.last_revision_id) {
                    baseContent = currentContent;
                } else {
                    const baseRev = await c.env.DB.prepare('SELECT content, r2_key FROM revisions WHERE id = ?')
                        .bind(draft.base_revision_id)
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
    } else if (draft.action === 'create') {
        if (page) {
            // approve 단계에서 live 슬러그는 'slug_taken' 으로, 소프트 삭제 슬러그는
            // 'slug_soft_deleted' 로 거부된다 — 상세 응답도 그 구분을 유지해 UI 가 정확히 안내할 수 있게 한다.
            hasConflict = true;
            conflictReason = page.deleted_at === null ? 'slug_taken' : 'slug_soft_deleted';
        }
    }

    // 라인 단위 diff 통계 (CRLF 정규화 후 LCS) — 마이페이지/모달에 표시.
    const diffStats = computeLineDiffStats(
        currentContent.replace(/\r\n?/g, '\n'),
        draft.content.replace(/\r\n?/g, '\n'),
    );

    return c.json({
        id: draft.id,
        slug: draft.slug,
        action: draft.action,
        status: 'pending_approval',
        submitted_at: unixToIso(draft.submitted_at),
        submitted_summary: draft.submitted_summary,
        base_revision_id: draft.base_revision_id,
        base_version: draft.base_version,
        category: draft.category,
        redirect_to: draft.redirect_to,
        proposed_content: draft.content,
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

/**
 * POST /api/mcp-submissions/:id/approve
 * 본인 제출안을 새 리비전으로 커밋. body 의 summary 가 있으면 그것을, 없으면
 * submitted_summary (AI 가 제안한 요약) 를 사용. 둘 다 비었으면 빈 요약 → [MCP] 접두만 남음.
 * 충돌/ACL/카테고리 재검증 + 실제 저장은 공용 applyDraftMutation 에 위임한다(즉시 적용 apply_edit 과 동일 소스).
 */
mcpSubmissionsRoutes.post('/mcp-submissions/:id/approve', requireAuth, async (c) => {
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    // 제출 시점 이후 사용자의 권한이 박탈되었을 가능성 — commit_edit 와 동일하게 wiki:edit
    // 권한을 재검증해 권한 변경이 곧바로 반영되도록 한다 (제출 자체는 통과했더라도 승인 시점에 차단).
    if (!rbac.can(user.role, 'wiki:edit')) {
        return c.json({ error: 'forbidden', message: 'wiki:edit 권한이 필요합니다.' }, 403);
    }
    const draftId = Number(c.req.param('id'));
    if (!Number.isFinite(draftId) || draftId <= 0) return c.json({ error: 'invalid id' }, 400);

    const body = await c.req.json<{ summary?: string }>().catch(() => ({} as { summary?: string }));
    // 유저가 명시적으로 빈 문자열을 보내면 AI summary 도 적용하지 않는다 ('' !== undefined).
    // 키 자체가 누락된 경우에만 AI summary 로 폴백 — 의도적인 빈 요약 의사를 보존하기 위함.
    const draft = await loadSubmittedDraftForUser(c.env, user, draftId);
    if (!draft) return c.json({ error: 'not found' }, 404);

    const finalSummaryRaw = (typeof body.summary === 'string')
        ? body.summary
        : (draft.submitted_summary ?? '');
    const finalSummary = finalSummaryRaw.length > 0 ? finalSummaryRaw : null;
    const summaryLengthError = validateMcpSummaryLength(finalSummary);
    if (summaryLengthError) return c.json({ error: summaryLengthError }, 400);

    const outcome = await applyDraftMutation(c, user, rbac, draft, finalSummary);
    if (!outcome.ok) {
        return c.json(outcome.body, outcome.status as 400 | 403 | 409 | 500);
    }
    return c.json(outcome.body);
});

/**
 * POST /api/mcp-submissions/:id/resolve
 * 사용자가 에디터에서 충돌을 직접 병합해 저장(=새 리비전 생성)한 뒤 호출한다.
 * draft + 관련 알림을 정리하고, /reject 와 구분되는 admin_log 타입('mcp_submission_resolve') 을 남긴다.
 * 새 리비전 생성 자체는 /api/w/:slug PUT 이 처리하므로 본 핸들러는 후처리(정리)만 담당한다.
 */
mcpSubmissionsRoutes.post('/mcp-submissions/:id/resolve', requireAuth, async (c) => {
    const user = c.get('user')!;
    const draftId = Number(c.req.param('id'));
    if (!Number.isFinite(draftId) || draftId <= 0) return c.json({ error: 'invalid id' }, 400);
    const draft = await loadSubmittedDraftForUser(c.env, user, draftId);
    if (!draft) return c.json({ error: 'not found' }, 404);

    await c.env.DB.batch([
        c.env.DB.prepare("DELETE FROM notifications WHERE type = 'mcp_submission' AND ref_id = ?").bind(draft.id),
        c.env.DB.prepare('DELETE FROM mcp_drafts WHERE id = ?').bind(draft.id),
    ]);
    c.executionCtx.waitUntil(
        c.env.DB.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
            .bind('mcp_submission_resolve', `[mcp-submission] resolved via editor draft #${draft.id}: ${draft.slug}`, user.id)
            .run().catch(() => {})
    );
    return c.json({ resolved: true, id: draft.id, slug: draft.slug });
});

/**
 * POST /api/mcp-submissions/:id/reject
 * 본인 제출안 폐기. draft + 알림 삭제, admin_log 에 기록.
 */
mcpSubmissionsRoutes.post('/mcp-submissions/:id/reject', requireAuth, async (c) => {
    const user = c.get('user')!;
    const draftId = Number(c.req.param('id'));
    if (!Number.isFinite(draftId) || draftId <= 0) return c.json({ error: 'invalid id' }, 400);
    const draft = await loadSubmittedDraftForUser(c.env, user, draftId);
    if (!draft) return c.json({ error: 'not found' }, 404);

    await c.env.DB.batch([
        c.env.DB.prepare("DELETE FROM notifications WHERE type = 'mcp_submission' AND ref_id = ?").bind(draft.id),
        c.env.DB.prepare('DELETE FROM mcp_drafts WHERE id = ?').bind(draft.id),
    ]);
    c.executionCtx.waitUntil(
        c.env.DB.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
            .bind('mcp_submission_reject', `[mcp-submission] rejected draft #${draft.id}: ${draft.slug}`, user.id)
            .run().catch(() => {})
    );
    return c.json({ rejected: true, id: draft.id, slug: draft.slug });
});

export default mcpSubmissionsRoutes;
