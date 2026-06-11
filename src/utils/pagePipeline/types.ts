// 통합 문서 저장 파이프라인(commitPageMutation)의 입력/출력 계약 및 브랜드 타입.
//
// 설계 의도: "문서 한 건의 상태 전이"의 후처리(리비전 저장 → ACL 해소 → 재색인 →
// 캐시 무효화 → 주시자 알림)를 호출자가 손으로 나열하지 않도록 단일 함수로 흡수한다.
// 특히 "주시자 알림" 같이 잊기 쉬운 사이드이펙트를 파이프라인 안에서 항상 실행한다.
//
// 브랜드 타입(AclResolvedState)으로 "ACL 해소 단계를 건너뛴 채 리비전을 쓰는" 실수를
// 컴파일 에러로 만든다 — write 단계는 AclResolvedState 만 받고, 그 브랜드는 resolveAcl
// 단계만 발급할 수 있다(types 모듈 밖에서 구성 불가능한 unique symbol 브랜드).

import type { RBAC } from '../role';
import type { User } from '../../types';

export type MutationKind = 'create' | 'update';

// 저장 진입점 출처. origin 별 정책(로그/알림 등)을 분기할 때 exhaustive switch 의 기준이 된다.
// 1~2단계 범위: 직접 PUT(http_put)·편집요청 승인(pending_approve)·MCP 제출 승인(mcp_approve).
// revert/move 는 3~4단계에서 추가한다.
export type MutationOrigin = 'http_put' | 'pending_approve' | 'mcp_approve';

interface CommonMutationInput {
    origin: MutationOrigin;
    actor: User;                  // 리비전 author 로 기록될 주체 (승인 경로의 rev1 은 원 요청자)
    slug: string;
    content: string;              // LF 정규화된 최종 본문
    summary: string | null;
    summaryRaw?: boolean;         // true 면 withMcpPrefix() 생략(승인 경로 박제 요약)
    redirectTo?: string | null;   // undefined → 기존 유지
    title?: string | null;        // undefined → 기존 유지, null → 제거, string → 설정
    logType?: string;
    logMessage?: string;
    awaitLinkCategoryIndex?: boolean; // 2-리비전 rev1 의 재색인을 await 해 rev2 와의 경합 방지
    rbac: RBAC;                   // 주시자 비공개 게이팅에 필요
    // 주시자 알림 발송 여부. 기본 true. false = 중간(intermediate) 리비전 → 알림 억제.
    // 2-리비전 승인의 rev1·보상 롤백처럼 "하나의 논리적 편집"이 물리 리비전 2개로 쪼개지는
    // 경우, 최종 리비전에서만 1회 알림하도록 호출자가 데이터로 지정한다(호출자 불리언이 아닌
    // 이 필드로만 제어 — 일반 단일 저장은 기본 true 라 끌 수 없음).
    notify?: boolean;
    // 주시자 알림 비공개 게이팅용. update 본 저장은 is_private 을 바꾸지 않으므로 현재값,
    // create 는 prefix 룰 머지 결과(0/1)를 boolean 으로 전달.
    isPrivate: boolean;
}

export interface UpdatePageMutationInput extends CommonMutationInput {
    kind: 'update';
    page: { id: number; version: number; category: string | null; title?: string | null };
    category?: string | null;     // undefined → 기존 유지
    editAcl?: string | null;      // undefined → 기존 유지 (승인 경로의 apply_edit_acl 일 때만 지정)
    // is_private 컬럼 쓰기 값. undefined → 컬럼을 손대지 않음(승인/MCP 경로 — 본 저장이 비공개를
    // 바꾸지 않는다). 직접 PUT 은 wiki:private 권한자가 저장과 함께 비공개를 토글할 수 있으므로
    // 최종값(0/1)을 전달해 컬럼을 갱신한다.
    isPrivateWrite?: number;
}

export interface CreatePageMutationInput extends CommonMutationInput {
    kind: 'create';
    // 신규 문서의 ACL/카테고리/비공개는 호출자가 applyCreatePrefixRulesAndCategoryAcls 로
    // 사전 머지(preResolved)해 전달한다. resolveAcl 단계는 이 값을 그대로 브랜딩한다.
    category: string | null;
    editAcl: string | null;
}

export type CommitPageMutationInput = UpdatePageMutationInput | CreatePageMutationInput;

export interface PageMutationResult {
    page_id: number;
    revision_id: number;
    new_version: number;
    rows: number;
    characters: number;
    created: boolean;
}

// ── 브랜드 타입(단계 게이트) ──
// stateBrand 는 export 하지 않으므로 이 모듈 밖에서는 AclResolvedState 를 구성할 수 없다.
declare const stateBrand: unique symbol;

export type AclResolvedState = {
    readonly input: CommitPageMutationInput;
    // resolveAcl 가 확정한 최종 저장 값.
    readonly category: string | null | undefined; // update: undefined=기존 유지
    readonly editAcl: string | null | undefined;  // update: undefined=기존 유지
    readonly isPrivateNum: number;                 // create 용(0/1)
    readonly [stateBrand]: 'AclResolved';
};

// resolveAcl 단계 전용 브랜드 발급기. commit.ts 의 resolveAcl 만 호출하도록 의도된다.
export function brandAclResolved(state: Omit<AclResolvedState, typeof stateBrand>): AclResolvedState {
    return state as AclResolvedState;
}
