// 통합 문서 저장 파이프라인의 단일 공개 진입점.
//
// 모든 본문 저장 경로는 자기 입력을 CommitPageMutationInput 으로 정규화해 이 함수에 넘긴다.
// 후처리는 고정 순서로 실행된다:
//   1) resolveAcl   — ACL/카테고리 확정(현재는 호출자 preResolved 값을 브랜딩) → AclResolvedState
//   2) writeRevision — 기존 공용 헬퍼(applyExistingPageUpdate / applyNewPageInsert)에 위임
//                      (R2 업로드·리비전 INSERT·낙관적 락 CAS·재색인·캐시 무효화·admin_log)
//   3) notifyWatchers — 모든 origin 공통, notify!==false 면 항상 실행
//
// 브랜드 타입(AclResolvedState)으로 writeRevision 은 resolveAcl 를 거친 state 만 받는다 —
// ACL 해소를 건너뛴 채 리비전을 쓰는 실수가 컴파일 단계에서 막힌다.
//
// 채택 범위: 직접 PUT(wiki.ts PUT /api/w/:slug)의 update·create 와 승인 경로(pending/mcp)가
// 모두 본 함수를 경유한다 — 과거 직접 PUT 에 인라인 중복돼 있던 코어 라이터를 제거하고
// 주시자 알림 누락을 구조적으로 해소했다. 직접 PUT 의 revert·move 이행은 후속 과제다.

import type { Context } from 'hono';
import type { Env } from '../../types';
import { applyExistingPageUpdate, applyNewPageInsert } from '../../routes/admin-mcp';
import { notifyPageWatchers } from './notifyWatchers';
import {
    brandAclResolved,
    type AclResolvedState,
    type CommitPageMutationInput,
    type PageMutationResult,
} from './types';

/** 카테고리 문자열을 알림 fan-out 용 배열로 정규화(직접 PUT 과 동일 규칙). */
function splitCategories(category: string | null | undefined): string[] {
    return (category || '')
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0);
}

/**
 * ACL/카테고리 확정 단계. AclResolvedState 브랜드를 발급하는 유일한 함수.
 * 1~2단계에서는 호출자가 prefix 룰/카테고리 ACL 머지를 이미 끝낸 값(preResolved)을
 * 그대로 브랜딩한다(실제 머지 흡수는 3단계). update 는 undefined=기존 유지 시맨틱 보존.
 */
function resolveAcl(input: CommitPageMutationInput): AclResolvedState {
    if (input.kind === 'create') {
        return brandAclResolved({
            input,
            category: input.category,
            editAcl: input.editAcl,
            isPrivateNum: input.isPrivate ? 1 : 0,
        });
    }
    return brandAclResolved({
        input,
        category: input.category,   // undefined → 기존 유지
        editAcl: input.editAcl,     // undefined → 기존 유지
        isPrivateNum: input.isPrivate ? 1 : 0,
    });
}

/**
 * 리비전 저장 단계. AclResolvedState 만 받는다(브랜드 게이트).
 * 기존 공용 헬퍼에 위임하므로 CAS 충돌·UNIQUE race 는 헬퍼가 던지는 coded error
 * (CONCURRENT_MODIFICATION / SLUG_TAKEN / TITLE_TAKEN)를 그대로 전파한다 — 호출 어댑터가
 * 기존과 동일하게 catch 해 409/500 으로 매핑한다.
 */
async function writeRevision(
    c: Context<Env>,
    state: AclResolvedState,
): Promise<PageMutationResult> {
    const { input } = state;
    if (input.kind === 'update') {
        const res = await applyExistingPageUpdate(c, input.actor, input.page, input.content, {
            summary: input.summary,
            summaryRaw: input.summaryRaw,
            category: state.category,
            redirectTo: input.redirectTo,
            title: input.title,
            editAcl: state.editAcl,
            viewMode: input.viewMode,
            isPrivate: input.isPrivateWrite,
            slug: input.slug,
            logType: input.logType,
            logMessage: input.logMessage,
            awaitLinkCategoryIndex: input.awaitLinkCategoryIndex,
        });
        return {
            page_id: input.page.id,
            revision_id: res.revision_id,
            new_version: res.new_version,
            rows: res.rows,
            characters: res.characters,
            created: false,
        };
    }
    const res = await applyNewPageInsert(c, input.actor, input.slug, input.content, {
        summary: input.summary,
        summaryRaw: input.summaryRaw,
        category: state.category ?? null,
        redirectTo: input.redirectTo ?? null,
        editAcl: state.editAcl ?? null,
        isPrivate: state.isPrivateNum,
        title: input.title ?? null,
        viewMode: input.viewMode ?? null,
        logType: input.logType,
        logMessage: input.logMessage,
        awaitLinkCategoryIndex: input.awaitLinkCategoryIndex,
    });
    return {
        page_id: res.page_id,
        revision_id: res.revision_id,
        new_version: 1,
        rows: res.rows,
        characters: res.characters,
        created: true,
    };
}

/**
 * 문서 한 건의 상태 전이(생성/수정)를 수행하는 단일 파이프라인.
 * 성공 시 notify!==false 면 주시자 알림을 항상 발송한다(끌 수 없는 사이드이펙트).
 */
export async function commitPageMutation(
    c: Context<Env>,
    input: CommitPageMutationInput,
): Promise<PageMutationResult> {
    const state = resolveAcl(input);
    const result = await writeRevision(c, state);

    if (input.notify !== false) {
        const categories = splitCategories(
            input.kind === 'create'
                ? input.category
                : (input.category !== undefined ? input.category : input.page.category),
        );
        notifyPageWatchers(c, {
            pageId: result.page_id,
            slug: input.slug,
            editorId: input.actor.id,
            editorName: input.actor.name,
            categories,
            isPrivate: input.isPrivate,
            revisionId: result.revision_id,
            summary: input.summary,
            rbac: input.rbac,
        });
    }

    return result;
}
