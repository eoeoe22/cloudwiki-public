// MCP draft 즉시 적용(apply) 공용 파이프라인.
//
// mcp_drafts 의 편집안을 실제 리비전으로 확정하는 로직의 단일 소스다. 두 진입점이 공유한다:
//   1) HTTP 승인: POST /api/mcp-submissions/:id/approve (mcp-submissions.ts) — 승인 대기(submitted)
//      draft 를 사용자가 마이페이지에서 검토 후 승인.
//   2) MCP 즉시 적용: apply_edit 도구 (mcp.ts) — mcp_instant_apply 를 켠 사용자가 승인 단계를 건너뛰고
//      draft 를 곧바로 리비전으로 확정.
//
// 어느 경로든 충돌/ACL/카테고리/제목 재검증 → commitPageMutation(통합 저장 파이프라인) →
// draft + 관련 알림 정리를 동일하게 수행한다. HTTP 상태 코드를 body 와 함께 반환해 호출자가
// c.json(body, status) 로 그대로 매핑하거나(HTTP), JSON 텍스트로 감싸(도구) 응답할 수 있다.
//
// import 방향 주의: 본 모듈은 routes/admin-mcp, routes/wiki, utils/pagePipeline 를 import 하지만,
// 그 어느 것도 본 모듈을 import 하지 않는다(순환 없음). apply_edit 도구의 dispatch 는 routes/mcp 가
// 호출하며 admin-mcp 는 본 모듈을 참조하지 않는다.

import type { Context } from 'hono';
import type { Env, User } from '../types';
import type { RBAC } from './role';
import { isR2OnlyNamespace } from './slug';
import { getEnabledExtensions } from './extensions';
import { getRevisionContent } from './r2';
import { computeLineDiffStats } from './diff';
import { ensureMcpDraftsMigration } from './mcpDraftsMigration';
import type { ToolResult } from './mcpDispatch';
import {
    buildCommitSummary,
    validateMcpSummaryLength,
    enforceAdminOnlyCategories,
} from '../routes/admin-mcp';
import {
    findConflictingPage,
    applyCreatePrefixRulesAndCategoryAcls,
    splitCategoryString,
    getCategoryDocAutoCategory,
} from '../routes/wiki';
import { commitPageMutation } from './pagePipeline/commit';
import { createNotification } from './notification';
import {
    parseEditAcl,
    evaluateEditAcl,
    getEditAclMinAgeDays,
} from './editAcl';

// applyDraftMutation 이 소비하는 draft 형태(제출 여부와 무관 — 데이터만 필요).
export interface ApplyDraftInput {
    id: number;
    slug: string;
    action: string;
    base_revision_id: number | null;
    base_version: number;
    content: string;
    category: string | null;
    redirect_to: string | null;
    title: string | null;
    has_title_change: number;
}

// { ok, status, body } — status 는 HTTP 매핑용(성공 200). body 는 응답 페이로드.
export type ApplyDraftOutcome =
    | { ok: true; status: number; body: Record<string, unknown> }
    | { ok: false; status: number; body: Record<string, unknown> };

/**
 * draft 를 실제 리비전으로 확정한다. 충돌/ACL/카테고리/제목 재검증을 write 직전(=author 기준)에
 * 다시 수행하고 commitPageMutation 으로 저장한 뒤, draft 와 관련 mcp_submission 알림을 정리한다.
 * finalSummary 는 사용자가 채택한 편집 요약(원문) — 내부에서 diff 마커/[MCP] 접두가 부여된다.
 */
export async function applyDraftMutation(
    c: Context<Env>,
    user: User,
    rbac: RBAC,
    draft: ApplyDraftInput,
    finalSummary: string | null,
): Promise<ApplyDraftOutcome> {
    const slug = draft.slug;

    if (draft.action === 'update') {
        const page = await c.env.DB.prepare(
            'SELECT id, version, content, category, last_revision_id, title, is_private FROM pages WHERE slug = ? AND deleted_at IS NULL'
        ).bind(slug).first<{ id: number; version: number; content: string; category: string | null; last_revision_id: number | null; title: string | null; is_private: number }>();
        if (!page) {
            return { ok: false, status: 409, body: { error: 'conflict', reason: 'page_missing' } };
        }
        if (page.last_revision_id !== draft.base_revision_id || page.version !== draft.base_version) {
            return {
                ok: false, status: 409, body: {
                    error: 'conflict',
                    reason: 'concurrent_modification',
                    base_revision_id: draft.base_revision_id,
                    base_version: draft.base_version,
                    current_revision_id: page.last_revision_id,
                    current_version: page.version,
                }
            };
        }

        // 페이지의 edit_acl 평가 — 실제 author(적용 시점) 기준으로 재검증. admin_only 가 없으면 관리자는 우회.
        const isAdminApprove = rbac.can(user.role, 'admin:access');
        const pageAclRow = await c.env.DB
            .prepare('SELECT edit_acl FROM pages WHERE id = ?')
            .bind(page.id)
            .first<{ edit_acl: string | null }>();
        const pageAcl = parseEditAcl(pageAclRow?.edit_acl ?? null);
        if (pageAcl && pageAcl.flags.length > 0) {
            const hasAdminOnly = pageAcl.flags.includes('admin_only');
            if (!isAdminApprove || hasAdminOnly) {
                const minAge = await getEditAclMinAgeDays(c.env.DB);
                const ev = await evaluateEditAcl(c.env.DB, pageAcl, user, page.id, minAge, isAdminApprove);
                if (!ev.allowed) {
                    const isAdminOnlyFail = ev.decisive === 'admin_only';
                    return {
                        ok: false, status: 403, body: {
                            error: 'forbidden',
                            reason: isAdminOnlyFail ? 'admin_only' : 'edit_acl',
                            message: isAdminOnlyFail
                                ? '이 문서는 관리자만 편집할 수 있습니다.'
                                : '이 문서를 편집할 권한이 부족합니다.',
                            edit_acl: pageAcl,
                            min_age_days: minAge,
                        }
                    };
                }
            }
        }

        // 관리자 전용 카테고리 재검증 — page.category 대비 새로 추가된 카테고리만 검사(기존 보존 편집 허용).
        {
            const currentCats = new Set(splitCategoryString(page.category));
            const addedCats = splitCategoryString(draft.category).filter(cat => !currentCats.has(cat));
            const catErr = await enforceAdminOnlyCategories(c.env.DB, rbac, user, addedCats.join(','));
            if (catErr) {
                return { ok: false, status: 403, body: { error: 'forbidden', reason: 'admin_only_category', message: catErr } };
            }
        }

        // draft 가 title 변경을 요청한 경우, 적용 시점에 다른 페이지가 같은 문자열을 slug/title 로 가져갔는지 재검증.
        if (draft.has_title_change && draft.title) {
            const titleConflict = await findConflictingPage(c.env.DB, draft.title, page.id);
            if (titleConflict) {
                return {
                    ok: false, status: 409, body: {
                        error: 'conflict',
                        reason: titleConflict.matchedColumn === 'slug' ? 'title_collides_with_slug' : 'title_taken',
                        message: titleConflict.matchedColumn === 'slug'
                            ? `'${draft.title}' 는 이미 다른 문서의 제목입니다.`
                            : `'${draft.title}' 는 이미 다른 문서의 대체 제목입니다.`,
                    }
                };
            }
        }

        // 라인 diff 통계 (CRLF 정규화 후 LCS) — 요약 마커/응답 필드용. 실패해도 저장은 진행.
        const enabledExt = getEnabledExtensions(c.env);
        let diffStats: { added: number; removed: number } | null = null;
        try {
            let prevContent = page.content || '';
            if (isR2OnlyNamespace(slug, enabledExt) && prevContent === '' && page.last_revision_id) {
                const lastRev = await c.env.DB.prepare('SELECT content, r2_key FROM revisions WHERE id = ?')
                    .bind(page.last_revision_id)
                    .first<{ content: string; r2_key: string | null }>();
                if (lastRev) {
                    prevContent = await getRevisionContent(c.env.MEDIA, lastRev, new URL(c.req.url).origin);
                }
            }
            diffStats = computeLineDiffStats(
                prevContent.replace(/\r\n?/g, '\n'),
                draft.content.replace(/\r\n?/g, '\n'),
            );
        } catch (e) {
            console.error('mcpDraftApply update diff stats failed (apply will proceed without marker):', e);
            diffStats = null;
        }
        const summaryWithDiff = diffStats ? buildCommitSummary(finalSummary, diffStats) : finalSummary;

        try {
            const result = await commitPageMutation(c, {
                kind: 'update',
                origin: 'mcp_approve',
                actor: user,
                slug,
                content: draft.content,
                summary: summaryWithDiff,
                category: draft.category,
                redirectTo: draft.redirect_to,
                title: draft.has_title_change ? draft.title : undefined,
                page,
                isPrivate: page.is_private === 1,
                logType: 'page_commit_approved',
                logMessage: `[mcp-submission] approved draft #${draft.id}: ${slug} (v${page.version + 1})`,
                rbac,
            });
            await c.env.DB.batch([
                c.env.DB.prepare("DELETE FROM notifications WHERE type = 'mcp_submission' AND ref_id = ?").bind(draft.id),
                c.env.DB.prepare('DELETE FROM mcp_drafts WHERE id = ?').bind(draft.id),
            ]);
            return {
                ok: true, status: 200, body: {
                    approved: true,
                    slug,
                    version: result.new_version,
                    revision_id: result.revision_id,
                    rows: result.rows,
                    characters: result.characters,
                    ...(diffStats ? { lines_added: diffStats.added, lines_removed: diffStats.removed } : {}),
                }
            };
        } catch (e: any) {
            if (e?.code === 'CONCURRENT_MODIFICATION') {
                return {
                    ok: false, status: 409, body: {
                        error: 'conflict',
                        reason: 'concurrent_modification',
                        base_revision_id: draft.base_revision_id,
                        base_version: draft.base_version,
                    }
                };
            }
            return { ok: false, status: 500, body: { error: 'apply_failed', message: e?.message || String(e) } };
        }
    }

    if (draft.action === 'create') {
        const livePage = await c.env.DB.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL').bind(slug).first();
        if (livePage) return { ok: false, status: 409, body: { error: 'conflict', reason: 'slug_taken' } };
        const deletedConflict = await c.env.DB.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NOT NULL').bind(slug).first();
        if (deletedConflict) {
            return {
                ok: false, status: 409, body: {
                    error: 'conflict',
                    reason: 'slug_soft_deleted',
                    message: '동일 제목의 소프트 삭제된 문서가 존재합니다. 관리자가 먼저 복원/영구삭제 처리해야 합니다.',
                }
            };
        }

        const slugTitleConflict = await findConflictingPage(c.env.DB, slug, null);
        if (slugTitleConflict && slugTitleConflict.matchedColumn === 'title') {
            return {
                ok: false, status: 409, body: {
                    error: 'conflict',
                    reason: 'slug_collides_with_title',
                    message: `'${slug}' 는 다른 문서의 대체 제목과 충돌해 제목으로 사용할 수 없습니다.`,
                }
            };
        }
        if (draft.has_title_change && draft.title) {
            const titleConflict = await findConflictingPage(c.env.DB, draft.title, null);
            if (titleConflict) {
                return {
                    ok: false, status: 409, body: {
                        error: 'conflict',
                        reason: titleConflict.matchedColumn === 'slug' ? 'title_collides_with_slug' : 'title_taken',
                        message: titleConflict.matchedColumn === 'slug'
                            ? `'${draft.title}' 는 이미 다른 문서의 제목입니다.`
                            : `'${draft.title}' 는 이미 다른 문서의 대체 제목입니다.`,
                    }
                };
            }
        }
        // 관리자 전용 카테고리 재검증 — 사용자가 지정한 draft.category + "카테고리:이름" 자동 카테고리.
        {
            const catsToCheck = splitCategoryString(draft.category);
            const autoCat = getCategoryDocAutoCategory(slug);
            if (autoCat && !catsToCheck.includes(autoCat)) catsToCheck.push(autoCat);
            const catErr = await enforceAdminOnlyCategories(c.env.DB, rbac, user, catsToCheck.join(','));
            if (catErr) {
                return { ok: false, status: 403, body: { error: 'forbidden', reason: 'admin_only_category', message: catErr } };
            }
        }

        // 신규 문서 prefix 룰 / 카테고리 ACL 머지 — /api/w/:slug PUT(create) 와 동일한 헬퍼.
        const isAdminCreate = rbac.can(user.role, 'admin:access');
        const mcpCategoryAclChoices: Record<string, string> = {};
        for (const cat of splitCategoryString(draft.category)) {
            mcpCategoryAclChoices[cat] = 'merge';
        }
        const prefixed = await applyCreatePrefixRulesAndCategoryAcls(c.env.DB, slug, {
            category: draft.category,
            isPrivate: 0,
            editAcl: null,
            adminExplicitlySetEditAcl: false,
            categoryAclChoices: mcpCategoryAclChoices,
            isAdmin: isAdminCreate,
        });
        const createEditAclSerialized = prefixed.finalEditAcl;
        const createCategory = prefixed.effectiveCategory;
        const createIsPrivate = prefixed.finalIsPrivate;

        // 적용 시점의 user(=새 페이지 author) 가 최종 머지된 ACL 을 통과하는지 평가. admin_only 없으면 관리자 우회.
        const finalAclForCheck = parseEditAcl(createEditAclSerialized);
        if (finalAclForCheck && finalAclForCheck.flags.length > 0) {
            const hasAdminOnly = finalAclForCheck.flags.includes('admin_only');
            if (!isAdminCreate || hasAdminOnly) {
                const minAge = await getEditAclMinAgeDays(c.env.DB);
                const ev = await evaluateEditAcl(c.env.DB, finalAclForCheck, user, null, minAge, isAdminCreate);
                if (!ev.allowed) {
                    const isAdminOnlyFail = ev.decisive === 'admin_only';
                    return {
                        ok: false, status: 403, body: {
                            error: 'forbidden',
                            reason: isAdminOnlyFail ? 'admin_only' : 'edit_acl',
                            message: isAdminOnlyFail
                                ? '이 슬러그로 시작하는 문서는 관리자만 새로 생성할 수 있습니다.'
                                : '이 슬러그로 시작하는 문서는 ACL 정책상 새로 생성할 수 없습니다.',
                            edit_acl: finalAclForCheck,
                            min_age_days: minAge,
                        }
                    };
                }
            }
        }
        const createDiffStats = computeLineDiffStats('', draft.content.replace(/\r\n?/g, '\n'));
        const createSummaryWithDiff = createDiffStats ? buildCommitSummary(finalSummary, createDiffStats) : finalSummary;

        try {
            const result = await commitPageMutation(c, {
                kind: 'create',
                origin: 'mcp_approve',
                actor: user,
                slug,
                content: draft.content,
                summary: createSummaryWithDiff,
                category: createCategory,
                redirectTo: draft.redirect_to,
                title: draft.has_title_change ? draft.title : null,
                editAcl: createEditAclSerialized,
                isPrivate: createIsPrivate === 1,
                logType: 'page_create_commit_approved',
                logMessage: `[mcp-submission] approved draft #${draft.id} (create): ${slug} (v1)`,
                rbac,
                // 신규 문서 생성은 직접 PUT(create) 경로와 동일하게 주시자 알림을 보내지 않는다.
                notify: false,
            });
            await c.env.DB.batch([
                c.env.DB.prepare("DELETE FROM notifications WHERE type = 'mcp_submission' AND ref_id = ?").bind(draft.id),
                c.env.DB.prepare('DELETE FROM mcp_drafts WHERE id = ?').bind(draft.id),
            ]);
            return {
                ok: true, status: 200, body: {
                    approved: true,
                    slug,
                    version: 1,
                    revision_id: result.revision_id,
                    rows: result.rows,
                    characters: result.characters,
                    ...(createDiffStats ? { lines_added: createDiffStats.added, lines_removed: createDiffStats.removed } : {}),
                    created: true,
                }
            };
        } catch (e: any) {
            if (e?.code === 'SLUG_TAKEN') {
                return { ok: false, status: 409, body: { error: 'conflict', reason: 'slug_taken' } };
            }
            if (e?.code === 'TITLE_TAKEN') {
                return { ok: false, status: 409, body: { error: 'conflict', reason: 'title_taken' } };
            }
            return { ok: false, status: 500, body: { error: 'apply_failed', message: e?.message || String(e) } };
        }
    }

    return { ok: false, status: 400, body: { error: 'unknown_action', action: draft.action } };
}

// ────────────────────────────────────────────────────────────────
// apply_edit 도구 (즉시 적용) — mcp_instant_apply 를 켠 사용자에게만 노출.
// ────────────────────────────────────────────────────────────────

export const APPLY_EDIT_TOOL_DEF = {
    name: 'apply_edit',
    description: 'draft 에 누적된 편집을 승인 단계 없이 **즉시** 새 리비전으로 확정합니다 (마이페이지에서 "MCP 편집 즉시반영 허용" 을 켠 경우에만 노출). commit_edit 이 승인 대기로 제출하는 것과 달리, 이 도구는 곧바로 저장합니다.\n\ncommit_edit 와 동일한 충돌 검증을 적용합니다 — base_revision_id 가 그 사이 변경되었거나(다른 사용자가 페이지 수정), 신규 페이지 draft 인데 같은 슬러그가 이미 존재하면 거부합니다. 편집 권한(edit_acl)/관리자 전용 카테고리도 적용 시점에 재검증됩니다.\n\nsummary 는 새 리비전의 편집 요약입니다 (선택, 최대 255자). 저장 시 자동으로 `[MCP] [+N줄 -M줄] ` 접두가 붙습니다. 응답에는 새 revision_id 와 라인 단위 변경량(lines_added / lines_removed)이 포함됩니다.\n\n승인 검토가 필요하면 apply_edit 대신 commit_edit 을 사용하세요.',
    inputSchema: {
        type: 'object',
        properties: {
            draft_id: { type: 'number', description: '즉시 적용할 draft 의 id (편집 도구 응답에서 받은 값)' },
            summary: { type: 'string', description: '편집 요약 (선택, 최대 255자, 저장 시 [MCP] 접두 자동 부여)' },
        },
        required: ['draft_id'],
    },
} as const;

function toolError(text: string): ToolResult {
    return { content: [{ type: 'text', text }], isError: true };
}

/**
 * 즉시반영(apply_edit)으로 새 리비전이 확정된 뒤, 편집을 유발한 토큰 소유자 본인에게
 * "즉시반영 완료" 알림(+푸시)을 남긴다.
 *
 * commit_edit(승인 대기)은 사용자가 마이페이지에서 직접 승인하므로 편집 시점을 스스로 인지하지만,
 * apply_edit 은 승인 단계 없이 AI 가 곧바로 리비전을 만들어 저장하므로 사용자가 개입하지 않는다.
 * 따라서 본인이 사후에 무엇이 반영됐는지 확인할 수 있도록 알림으로 리비전 diff 링크를 제공한다.
 *
 * best-effort — 저장은 이미 성공했으므로 알림 실패가 응답을 막거나 apply 를 되돌리지 않도록
 * waitUntil 로 분리하고 에러는 로깅 후 삼킨다. (푸시 자체도 createNotification 내부에서 best-effort)
 */
function notifyInstantApply(
    c: Context<Env>,
    user: User,
    slug: string,
    body: Record<string, unknown>,
): void {
    const isCreate = body.created === true;
    const version = typeof body.version === 'number' ? body.version : null;
    const revisionId = typeof body.revision_id === 'number' ? body.revision_id : null;
    const notifContent = isCreate
        ? `MCP 즉시반영으로 "${slug}" 문서가 생성되었습니다.`
        : `MCP 즉시반영으로 "${slug}" 문서가 편집되었습니다.${version !== null ? ` (v${version})` : ''}`;
    // 생성은 비교할 이전 리비전이 없으므로 문서 자체로, 수정은 방금 만든 리비전 diff 로 링크한다.
    const link = (isCreate || revisionId === null)
        ? `/w/${encodeURIComponent(slug)}`
        : `/w/${encodeURIComponent(slug)}?mode=revisions&diff=${revisionId}`;
    c.executionCtx.waitUntil(
        createNotification(c.env, c.executionCtx, {
            userId: user.id,
            type: 'mcp_instant_apply',
            content: notifContent,
            link,
            refId: revisionId,
            push: {
                title: 'MCP 즉시반영',
                body: notifContent,
                url: link,
                // 태그는 문서 단위로 둔다 — AI 가 한 문서를 연속 즉시반영할 때 OS 푸시가 최신 1건으로
                // 합쳐져 알림 폭주를 막는다(in-app 목록에는 리비전별로 개별 기록이 남는다).
                tag: `mcp_instant_apply:${slug}`,
            },
        }).catch(e => console.error('mcp instant apply notification failed:', e)),
    );
}

/**
 * apply_edit 도구 디스패처. mcp.ts 가 mcp_instant_apply 사용자에 한해 호출한다.
 * draft 소유/미제출 검증 후 applyDraftMutation 으로 즉시 확정한다.
 */
export async function dispatchApplyEditTool(
    c: Context<Env>,
    user: User,
    rbac: RBAC,
    args: any,
): Promise<ToolResult> {
    const db = c.env.DB;
    await ensureMcpDraftsMigration(db);

    if (!rbac.can(user.role, 'wiki:edit')) {
        return toolError('Error: wiki:edit 권한이 필요합니다.');
    }
    // 방어선: 도구 노출은 mcp.ts 에서 게이팅하지만 디스패처에서도 설정을 재확인한다.
    if (!user.mcp_instant_apply) {
        return toolError('Error: MCP 편집 즉시반영이 비활성화되어 있습니다. 마이페이지 설정에서 활성화한 뒤 사용하거나, commit_edit 으로 승인 대기 제출하세요.');
    }

    const draftId = Number(args.draft_id);
    if (!Number.isFinite(draftId) || draftId <= 0) {
        return toolError('Error: draft_id 는 양의 정수여야 합니다.');
    }
    const summary = (typeof args.summary === 'string' && args.summary.length > 0) ? args.summary : null;
    const summaryLengthError = validateMcpSummaryLength(summary);
    if (summaryLengthError) {
        return toolError(summaryLengthError);
    }

    const draft = await db.prepare(
        `SELECT id, user_id, slug, action, base_revision_id, base_version,
                content, category, redirect_to, title, has_title_change, submitted_at
         FROM mcp_drafts WHERE id = ?`
    ).bind(draftId).first<ApplyDraftInput & { user_id: number; submitted_at: number | null }>();
    if (!draft) {
        return toolError('Error: draft 를 찾을 수 없습니다 (이미 commit/discard 됐거나 12시간 TTL 만료).');
    }
    if (draft.user_id !== user.id) {
        return toolError('Error: 다른 사용자의 draft 는 적용할 수 없습니다.');
    }
    if (draft.submitted_at !== null) {
        return toolError('Error: 이 draft 는 이미 승인 대기로 제출된 상태입니다. 마이페이지에서 승인하거나 discard_edit 후 다시 시도하세요.');
    }

    const outcome = await applyDraftMutation(c, user, rbac, draft, summary);
    if (outcome.ok) {
        // 즉시반영은 승인 단계를 건너뛰므로 토큰 소유자 본인에게 사후 확인용 알림을 남긴다.
        notifyInstantApply(c, user, draft.slug, outcome.body);
    }
    const body = outcome.ok
        ? { ...outcome.body, applied: true, notice: '즉시 반영되어 새 리비전이 생성되었습니다.' }
        : outcome.body;
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: !outcome.ok };
}
