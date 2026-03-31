import type { Context } from 'hono';

// Cloudflare Workers 바인딩 타입
export type Env = {
    Bindings: {
        DB: D1Database;
        MEDIA: R2Bucket;
        KV: KVNamespace;
        ASSETS: Fetcher;
        GOOGLE_CLIENT_ID: string;
        GOOGLE_CLIENT_SECRET: string;
        GOOGLE_REDIRECT_URI: string;
        MEDIA_PUBLIC_URL: string;
        MAX_UPLOAD_SIZE: string;
        SUPER_ADMIN_EMAILS: string;
        WIKI_HOME_PAGE: string;
        WIKI_NAME: string;
        WIKI_LOGO_URL: string;
        WIKI_FAVICON_URL: string;
        CUSTOM_HEADER: string;
        SELECTED_ICONS_ONLY: string;
        MCP_MODE: 'disabled' | 'open';
        ALLOW_CRAWL: string;
        WIKI_VISIBILITY: 'open' | 'closed';
        CLOSED_WIKI_MESSAGE: string;
        TURNSTILE_SITE_KEY: string;
        TURNSTILE_SECRET_KEY: string;
    };
    Variables: {
        user: User | null;
    };
};

export interface Settings {
    id: number;
    namechange_ratelimit: number;
    allow_direct_message: number;
    signup_policy: string;
}

// DB 모델 타입
export interface User {
    id: number;
    google_id: string;
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
    title: string;
    content: string;
    category: string | null;
    redirect_to: string | null;
    is_locked: number;
    is_private: number;
    author_id: number | null;
    last_revision_id: number | null;
    version: number;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
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

export type AppContext = Context<Env>;
