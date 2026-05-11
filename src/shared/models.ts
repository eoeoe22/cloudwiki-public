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
    content: string;
    category: string | null;
    redirect_to: string | null;
    is_locked: number;
    is_private: number;
    last_revision_id: number | null;
    version: number;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
    rows: number | null;
    characters: number | null;
}

export interface Revision {
    id: number;
    page_id: number;
    page_version: number | null;
    content: string;          // 기존 리비전: 본문 직접 저장. 신규 리비전: '' (r2_key 사용)
    r2_key: string | null;    // R2 저장 경로 (revisions/{pageId}/{pageVersion}.md)
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
}
