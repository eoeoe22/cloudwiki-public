/**
 * 서버·클라이언트 공유 DB 모델 인터페이스.
 *
 * - 이 파일은 D1 테이블의 행(row) 모양을 그대로 표현한다. 응답 DTO 와는 분리해
 *   `src/shared/api/<도메인>.ts` 에서 Pick / Omit / 합성으로 가공해 사용한다.
 * - 기존 코드는 `from '../types'` 로 동일 이름을 import 하고 있으며,
 *   `src/types.ts` 가 이 파일을 그대로 re-export 하므로 import 경로를 바꿀 필요는 없다.
 * - 신규 코드(특히 src/client/* 진입점, src/shared/api/*) 는 가능한 한 이 파일을 직접
 *   참조한다. Env / RolePermissions / AppContext 같은 서버 전용 타입은 src/types.ts 에 남는다.
 */

export interface User {
    id: number;
    provider: string;    // 'google' | 'github' | 'discord' | ...
    uid: string;         // 공급자 측 사용자 ID
    email: string;
    name: string;
    picture: string | null;
    /** 프로필 사진 비공개 여부(1=비공개, picture 가 정적 기본 아바타로 고정됨) */
    picture_private: number;
    role: 'user' | 'discussion_manager' | 'admin' | 'super_admin' | 'banned' | 'deleted';
    banned_until: number | null;
    last_namechange: number | null;
    created_at: number;
}

export interface Redirect {
    id: number;
    source_slug: string;
    target_page_id: number;
    created_at: number;
}

export interface Session {
    id: string;
    user_id: number;
    expires_at: number;
}

export interface Page {
    id: number;
    slug: string;
    title: string | null;
    content: string;
    category: string | null;
    redirect_to: string | null;
    is_private: number;
    last_revision_id: number | null;
    version: number;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
    rows: number | null;
    characters: number | null;
    // 편집 ACL (JSON). NULL=비활성. 형식: {"flags":["aged"|"page_editor"|"any_editor"|"admin_only"]} (AND 평가)
    edit_acl: string | null;
}

export interface Revision {
    id: number;
    page_id: number;
    page_version: number | null;
    content: string;          // 기존 리비전: 본문 직접 저장. 신규 리비전: '' (r2_key 사용)
    r2_key: string | null;    // R2 저장 경로 (revisions/{pageId}/{pageVersion}-{token}.md, 토큰은 동시 저장 충돌 방지용)
    summary: string | null;
    author_id: number | null;
    created_at: number;
}

export interface Media {
    id: number;
    r2_key: string;
    filename: string;
    mime_type: string;
    size: number;
    uploader_id: number | null;
    content: string;
    created_at: number;
}

export interface Discussion {
    id: number;
    page_id: number;
    title: string;
    status: 'open' | 'closed';
    author_id: number | null;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
}

export interface DiscussionComment {
    id: number;
    discussion_id: number;
    author_id: number | null;
    content: string;
    parent_id: number | null;
    created_at: number;
    deleted_at: number | null;
}

export interface Ticket {
    id: number;
    title: string;
    type: 'general' | 'document' | 'discussion' | 'account';
    status: 'open' | 'closed';
    user_id: number;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
}

export interface TicketComment {
    id: number;
    ticket_id: number;
    author_id: number | null;
    content: string;
    parent_id: number | null;
    created_at: number;
    deleted_at: number | null;
}

export interface Notification {
    id: number;
    user_id: number;
    type: 'discussion_comment' | 'banned' | 'message' | 'ticket_comment' | 'ticket_created' | 'signup_request' | 'page_watch';
    content: string;
    link: string | null;
    ref_id: number | null;
    created_at: number;
}

export interface Message {
    id: number;
    sender_id: number;
    receiver_id: number;
    content: string;
    reply_to: number | null;
    created_at: number;
    deleted: number;
}

export interface BlogPost {
    id: number;
    title: string;
    content: string;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
    rows: number | null;
    characters: number | null;
    thumbnail: string | null;
}

export interface Settings {
    id: number;
    namechange_ratelimit: number;
    allow_direct_message: number;
    signup_policy: string;
    // pages.edit_acl 의 'aged' 플래그가 참조하는 전역 임계값(일). 0=비활성.
    edit_acl_min_age_days: number;
}

// ── 워크스페이스 (개인 워크스페이스 기능) ──────────────────────────
// 기존 Page/Revision/Media 와 완전히 분리된 별도 테이블 세트의 row 모델.

// 멤버 역할은 'editor' | 'viewer' 만 저장된다.
// owner 는 workspaces.owner_id 에서 파생되며 workspace_members 에 저장하지 않는다.
export type WorkspaceRole = 'owner' | 'editor' | 'viewer';

export interface Workspace {
    id: number;
    slug: string;
    name: string;
    owner_id: number;
    icon: string | null;
    created_at: number;
    deleted_at: number | null;
}

export interface WorkspaceMember {
    workspace_id: number;
    user_id: number;
    role: 'editor' | 'viewer';
    // 초대-수락 모델: 'pending' = 초대됐으나 수락 전(권한 없음), 'active' = 수락한 정식 멤버.
    status: 'pending' | 'active';
    created_at: number;
}

export interface WorkspacePage {
    id: number;
    workspace_id: number;
    slug: string;
    title: string | null;
    content: string;
    last_revision_id: number | null;
    version: number;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
    redirect_to: string | null;
    rows: number | null;
    characters: number | null;
    // 문서별 본문 표시 유형. NULL = 일반 문서. 'presentation' = 슬라이드 덱(프레젠테이션, 워크스페이스 전용).
    doc_type: string | null;
    // 1 이면 비멤버/게스트에게도 이 문서 읽기 허용 (라우트 레이어에서 적용)
    ws_public: number;
    // 워크스페이스 공용 '상단 고정'(별표). NULL = 미고정, 값(unixepoch) = 고정 시각.
    // 목록에서 고정 문서를 항상 먼저 노출하는 정렬 용도. (canWrite 권한으로 토글)
    pinned_at: number | null;
}

export interface WorkspaceRevision {
    id: number;
    page_id: number;
    page_version: number | null;
    content: string;          // r2_key 가 있으면 '' (전역 Revision 과 동일 시맨틱)
    r2_key: string | null;
    summary: string | null;
    author_id: number | null;
    created_at: number;
    deleted_at: number | null;
    purged_at: number | null;
}

export interface WorkspaceMedia {
    id: number;
    workspace_id: number;
    r2_key: string;
    filename: string;
    mime_type: string;
    size: number;
    uploader_id: number | null;
    // 1 이면 비멤버에게도 노출 허용 (라우트 레이어에서 적용)
    ws_public: number;
    created_at: number;
}

export interface WorkspacePageLink {
    id: number;
    source_page_id: number;
    target_slug: string;
    link_type: string;
    workspace_id: number;
}
