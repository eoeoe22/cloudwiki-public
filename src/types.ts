import type { Context } from 'hono';
import type { User } from './shared/models';
import type { RagAiBinding } from './utils/rag';

// DB 모델 인터페이스(User, Page, Revision, ...) 는 src/shared/models 로 분리되어 있고,
// 기존 코드의 `import type { User } from '../types'` 같은 경로 호환을 위해 그대로 re-export 한다.
// 새 코드는 가능한 한 src/shared/models 를 직접 참조하는 것을 권장한다.
export * from './shared/models';

// Cloudflare Workers 바인딩 타입 (서버 전용)
export type Env = {
    Bindings: {
        DB: D1Database;
        MEDIA: R2Bucket;
        KV: KVNamespace;
        ASSETS: Fetcher;
        // === RAG(AI Search) 보조 검색 플러그인 ===
        // RAG_BUCKET: 문서 본문 미러링 전용 R2 버킷. AI: Workers AI 바인딩(AutoRAG 질의).
        // 두 바인딩 모두 선택적 — 미구성 시 RAG 기능은 자동 비활성(isRagEnabled=false).
        RAG_BUCKET?: R2Bucket;
        AI?: RagAiBinding;
        RAG_SEARCH_ENABLED?: string;   // "true" 면 RAG 플러그인 활성화
        RAG_AUTORAG_NAME?: string;     // AI Search(AutoRAG) 인스턴스 이름
        ANALYTICS?: AnalyticsEngineDataset;
        // AdminJobDO 잡 러너 (역링크 재인덱싱/대량 이동/대량 삭제). 바인딩 없으면 잡 API 는 503.
        ADMIN_JOB_DO?: DurableObjectNamespace;
        // AdminJobDO alarm 틱당 서브리퀘스트 예산 (유료 950 / 무료 40 권장, 미설정 시 40)
        JOB_SUBREQUEST_BUDGET?: string;
        AUTH_PROVIDERS: string;            // "google,discord"
        GOOGLE_CLIENT_ID: string;
        GOOGLE_CLIENT_SECRET: string;
        GOOGLE_REDIRECT_URI: string;
        DISCORD_CLIENT_ID: string;
        DISCORD_CLIENT_SECRET: string;
        DISCORD_REDIRECT_URI: string;
        MEDIA_PUBLIC_URL: string;
        MAX_UPLOAD_SIZE: string;
        SUPER_ADMIN_EMAILS: string;
        WIKI_HOME_PAGE: string;
        WIKI_NAME: string;
        ENABLE_CONCURRENT_EDIT_DETECTION: string;
        EDIT_REQUEST_ENABLED: string;
        WIKI_LOGO_URL: string;
        WIKI_FAVICON_URL: string;
        CUSTOM_HEADER: string;
        SIDEBAR: string;
        FOOTER: string;
        SELECTED_ICONS_ONLY: string;
        MCP_MODE: 'disabled' | 'open';
        ALLOW_CRAWL: string;
        WIKI_VISIBILITY: 'open' | 'closed';
        LAYOUT_MODE: 'default' | 'left-toc' | 'right-toc' | 'docs' | 'wide';
        LOGIN_MESSAGE: string;
        TURNSTILE_SITE_KEY: string;
        TURNSTILE_SECRET_KEY: string;
        CF_ACCOUNT_ID?: string;
        CF_API_TOKEN?: string;
        EMAIL_RESTRICTION: string;
        EMAIL_LIST: string;
        ENABLED_EXTENSIONS: string;
        TERMS_OF_SERVICE: string;
        PRIVACY_POLICY: string;
        WIKI_SYNTAX?: string;
        // === Discord Webhook (Secret 으로 등록) ===
        DISCORD_ADMIN_WEBHOOK_URL?: string;
        DISCORD_COMMUNITY_WEBHOOK_URL?: string;
        // === Discord Webhook 이벤트 화이트리스트 (vars) ===
        DISCORD_ADMIN_EVENTS?: string;
        DISCORD_COMMUNITY_EVENTS?: string;
        // === 절대 URL 보정용 (avatar_url, 임베드 링크) ===
        WIKI_PUBLIC_BASE_URL?: string;
        // === Web Push (VAPID) ===
        // 공개키는 클라이언트에 노출되므로 [vars] 또는 평문 변수.
        // 비밀키와 subject(mailto: 또는 https://) 는 wrangler secret 으로 등록.
        VAPID_PUBLIC_KEY?: string;
        VAPID_PRIVATE_KEY?: string;
        VAPID_SUBJECT?: string;
    };
    Variables: {
        user: User | null;
        rbac?: any; // To be defined or used as a helper
    };
};

export interface RolePermissions {
    roles: {
        [role: string]: {
            permissions: string[];
            inherits?: string[];
        };
    };
}

export type AppContext = Context<Env>;
