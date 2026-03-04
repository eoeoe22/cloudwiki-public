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
        WIKI_NAME: string;
        WIKI_LOGO_URL: string;
        WIKI_FAVICON_URL: string;
        CUSTOM_HEADER: string;
    };
    Variables: {
        user: User | null;
    };
};

// DB 모델 타입
export interface User {
    id: number;
    google_id: string;
    email: string;
    name: string;
    picture: string | null;
    role: 'user' | 'discussion_manager' | 'admin' | 'super_admin' | 'banned';
    banned_until: number | null;
    rate_limit: number;
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
    content: string;
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

export type AppContext = Context<Env>;
