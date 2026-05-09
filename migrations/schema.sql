-- Cloudflare D1 Database Schema


-- 사용자 테이블
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  provider   TEXT NOT NULL,
  uid        TEXT NOT NULL,              -- 공급자 측 사용자 ID
  email      TEXT NOT NULL UNIQUE,       -- 이메일 중복 체크 (공급자 간 중복 방지)
  name       TEXT NOT NULL,
  picture    TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  role TEXT DEFAULT 'user',  -- 'user', 'discussion_manager', 'admin', 'super_admin', 'banned', 'deleted'
  banned_until INTEGER,
  last_namechange INTEGER,
  UNIQUE(provider, uid)                  -- 같은 공급자+ID 중복 방지
);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at DESC);

-- 세션 테이블
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 문서 테이블
-- slug 가 문서의 고유 식별자이자 표시 이름이다. 별도 title 컬럼은 두지 않는다.
CREATE TABLE IF NOT EXISTS pages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slug              TEXT NOT NULL UNIQUE,
  content           TEXT NOT NULL DEFAULT '',
  last_revision_id  INTEGER,
  version           INTEGER DEFAULT 1,
  created_at        INTEGER DEFAULT (unixepoch()),
  updated_at        INTEGER DEFAULT (unixepoch()),
  deleted_at        INTEGER,
  category          TEXT,
  is_locked         INTEGER DEFAULT 0,
  redirect_to       TEXT,
  rows              INTEGER,
  characters        INTEGER
);


CREATE INDEX IF NOT EXISTS idx_pages_updated ON pages(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pages_deleted ON pages(deleted_at);

-- 리비전 테이블
-- content: 본문이 직접 저장되거나, r2_key가 있으면 R2에서 조회.
-- r2_key: R2 버킷 내 파일 경로 (예: revisions/{pageId}/{pageVersion}.md)
CREATE TABLE IF NOT EXISTS revisions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id      INTEGER NOT NULL,
  page_version INTEGER,
  content      TEXT NOT NULL DEFAULT '',
  r2_key       TEXT,
  summary      TEXT,
  author_id    INTEGER,
  created_at   INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (page_id) REFERENCES pages(id),
  FOREIGN KEY (author_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_revisions_page_version ON revisions(page_id, page_version DESC);
CREATE INDEX IF NOT EXISTS idx_revisions_author ON revisions(author_id);
CREATE INDEX IF NOT EXISTS idx_revisions_created ON revisions(created_at DESC);

-- 미디어 테이블
-- content: 이미지 문서(/w/이미지:파일명) 접근 시 함께 표시되는 일반 텍스트 설명.
--          위키 문법 렌더링 없이 이스케이프하여 그대로 출력하며 리비전을 남기지 않는다.
CREATE TABLE IF NOT EXISTS media (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  r2_key      TEXT NOT NULL UNIQUE,
  filename    TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size        INTEGER NOT NULL,
  uploader_id INTEGER,
  content     TEXT NOT NULL DEFAULT '',
  created_at  INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (uploader_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_media_uploader ON media(uploader_id);
CREATE INDEX IF NOT EXISTS idx_media_filename ON media(filename);

-- 미디어-태그 테이블 (이미지 1개에 태그 N개)
CREATE TABLE IF NOT EXISTS media_tags (
  media_id INTEGER NOT NULL,
  tag      TEXT NOT NULL,
  PRIMARY KEY (media_id, tag),
  FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_media_tags_tag ON media_tags(tag);

-- FTS5 검색 가상 테이블
-- 컬럼 0: slug (문서 식별자/표시 이름), 컬럼 1: content (본문)
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts
USING fts5(slug, content, content=pages, content_rowid=id, tokenize="trigram");

-- FTS 트리거
CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, slug, content) VALUES (new.id, new.slug, new.content);
END;

CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, slug, content) VALUES('delete', old.id, old.slug, old.content);
END;

CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, slug, content) VALUES('delete', old.id, old.slug, old.content);
  INSERT INTO pages_fts(rowid, slug, content) VALUES (new.id, new.slug, new.content);
END;

-- 관리자 카테고리
CREATE TABLE IF NOT EXISTS admin_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at INTEGER DEFAULT (unixepoch())
);

-- 관리자 전용 네임스페이스 (prefix 기반)
-- prefix 로 시작하는 슬러그를 가진 문서는 관리자(admin:access)만 생성/편집/이동/되돌리기 가능
CREATE TABLE IF NOT EXISTS admin_namespaces (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    prefix     TEXT NOT NULL UNIQUE,
    created_at INTEGER DEFAULT (unixepoch())
);

-- 설정 테이블
CREATE TABLE IF NOT EXISTS settings (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  namechange_ratelimit    INTEGER DEFAULT 0,
  allow_direct_message    INTEGER DEFAULT 0,
  signup_policy           TEXT DEFAULT 'open',  -- 'open' (모두 허용), 'approval' (관리자 승인제)
  announce_title          TEXT DEFAULT '',      -- 사이트 전역 공지의 제목 (관리자가 직접 입력)
  announce_post           INTEGER DEFAULT NULL, -- 공지가 가리키는 blog_posts.id (없으면 NULL)
  announced_time          INTEGER DEFAULT 0     -- 공지가 발행/변경된 시각 (unixepoch, 초 단위)
);

-- 설정 초기 데이터 (이미 있는 경우 무시)
INSERT OR IGNORE INTO settings (id) VALUES (1);

-- 알림 테이블
CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  type        TEXT NOT NULL,
  content     TEXT NOT NULL,
  link        TEXT,
  ref_id      INTEGER,
  created_at  INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);

-- 쪽지 테이블
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id   INTEGER NOT NULL,
  receiver_id INTEGER NOT NULL,
  content     TEXT NOT NULL,
  reply_to    INTEGER,
  created_at  INTEGER DEFAULT (unixepoch()),
  deleted     INTEGER DEFAULT 0,
  FOREIGN KEY (sender_id) REFERENCES users(id),
  FOREIGN KEY (receiver_id) REFERENCES users(id),
  FOREIGN KEY (reply_to) REFERENCES messages(id)
);
CREATE INDEX IF NOT EXISTS idx_messages_receiver_created ON messages(receiver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);

-- 토론 스레드
CREATE TABLE IF NOT EXISTS discussions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id     INTEGER NOT NULL,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  author_id   INTEGER,
  created_at  INTEGER DEFAULT (unixepoch()),
  updated_at  INTEGER DEFAULT (unixepoch()),
  deleted_at  INTEGER,
  FOREIGN KEY (page_id) REFERENCES pages(id),
  FOREIGN KEY (author_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_discussions_page_updated ON discussions(page_id, updated_at DESC);

-- 토론 댓글
CREATE TABLE IF NOT EXISTS discussion_comments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  discussion_id   INTEGER NOT NULL,
  author_id       INTEGER,
  content         TEXT NOT NULL,
  parent_id       INTEGER,
  created_at      INTEGER DEFAULT (unixepoch()),
  deleted_at      INTEGER,
  FOREIGN KEY (discussion_id) REFERENCES discussions(id),
  FOREIGN KEY (author_id) REFERENCES users(id),
  FOREIGN KEY (parent_id) REFERENCES discussion_comments(id)
);
CREATE INDEX IF NOT EXISTS idx_dcomments_discussion_created ON discussion_comments(discussion_id, created_at ASC);

-- 티켓 문의
CREATE TABLE IF NOT EXISTS tickets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'general',
  status      TEXT NOT NULL DEFAULT 'open',
  user_id     INTEGER NOT NULL,
  created_at  INTEGER DEFAULT (unixepoch()),
  updated_at  INTEGER DEFAULT (unixepoch()),
  deleted_at  INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);

-- 티켓 댓글
CREATE TABLE IF NOT EXISTS ticket_comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   INTEGER NOT NULL,
  author_id   INTEGER,
  content     TEXT NOT NULL,
  parent_id   INTEGER,
  created_at  INTEGER DEFAULT (unixepoch()),
  deleted_at  INTEGER,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  FOREIGN KEY (author_id) REFERENCES users(id),
  FOREIGN KEY (parent_id) REFERENCES ticket_comments(id)
);
CREATE INDEX IF NOT EXISTS idx_tcomments_ticket ON ticket_comments(ticket_id);

-- 관리자 로그 테이블
CREATE TABLE IF NOT EXISTS admin_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  log        TEXT NOT NULL,
  user       INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_admin_log_user_created ON admin_log(user, created_at DESC);

-- admin-mcp 의 stateful 편집을 위한 draft 테이블
-- 에이전트가 patch_page / edit_section / create_or_update_page 를 호출하면
-- 즉시 새 리비전을 만들지 않고 여기에 누적 저장한다. commit_edit 호출 시
-- base_revision_id 가 현재 페이지의 last_revision_id 와 같으면 한 번에 리비전 1개를
-- 생성하고, 다르면 충돌로 거부한다 (다른 사용자가 그 사이 페이지를 수정).
-- 기존 페이지 편집: base_revision_id = 그 시점 last_revision_id, base_version = 그 시점 version.
-- 신규 페이지 편집: base_revision_id = NULL, base_version = 0 (commit 시 페이지가 이미 있으면 충돌).
-- action: 'create' 면 새 페이지 생성, 'update' 면 기존 페이지 갱신.
-- requested_lock: NULL = 페이지 기존 상태 유지, 0/1 = 명시적 변경.
-- TTL: 매일 자정 cron 이 updated_at < now-43200 (12시간) 인 draft 를 일괄 삭제.
CREATE TABLE IF NOT EXISTS mcp_drafts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL,
  slug              TEXT NOT NULL,
  action            TEXT NOT NULL,
  base_revision_id  INTEGER,
  base_version      INTEGER NOT NULL DEFAULT 0,
  content           TEXT NOT NULL DEFAULT '',
  category          TEXT,
  redirect_to       TEXT,
  requested_lock    INTEGER,
  created_at        INTEGER DEFAULT (unixepoch()),
  updated_at        INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE (user_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_mcp_drafts_user ON mcp_drafts(user_id);
CREATE INDEX IF NOT EXISTS idx_mcp_drafts_updated ON mcp_drafts(updated_at);

-- 문서 간 링크 테이블 (역링크 인덱싱용)
-- 문서 수정 시 content에서 [[링크]]를 파싱하여 이 테이블에 저장
-- source_page_id는 blog=0 일 때 pages.id, blog=1 일 때 blog_posts.id 를 가리킴.
-- 두 ID 공간이 겹치므로 pages(id) 외래키는 두지 않는다 (FK 강제 시 블로그 INSERT 실패).
CREATE TABLE IF NOT EXISTS page_links (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_page_id INTEGER NOT NULL,
  target_slug    TEXT NOT NULL,
  link_type      TEXT NOT NULL DEFAULT 'wikilink',  -- 'wikilink', 'template', 'image'
  blog          INTEGER NOT NULL DEFAULT 0          -- 0: 위키 페이지 링크, 1: 블로그 포스트 링크
);
CREATE INDEX IF NOT EXISTS idx_page_links_source ON page_links(source_page_id);
CREATE INDEX IF NOT EXISTS idx_page_links_target ON page_links(target_slug);

-- 문서-카테고리 관계 테이블 (다대다 정규화)
CREATE TABLE IF NOT EXISTS page_categories (
  page_id     INTEGER NOT NULL,
  category    TEXT NOT NULL,
  PRIMARY KEY (page_id, category),
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_page_categories_category ON page_categories(category);

-- 가입 신청 테이블 (승인제 회원가입용)
CREATE TABLE IF NOT EXISTS signup_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider    TEXT NOT NULL DEFAULT 'google',  -- 'google' | 'github' | 'discord' | ...
  uid         TEXT NOT NULL,
  email       TEXT NOT NULL,
  name        TEXT NOT NULL,
  picture     TEXT,
  message     TEXT DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'approved', 'rejected', 'blocked'
  reviewed_by INTEGER,
  created_at  INTEGER DEFAULT (unixepoch()),
  reviewed_at INTEGER,
  FOREIGN KEY (reviewed_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_signup_requests_status ON signup_requests(status);
CREATE INDEX IF NOT EXISTS idx_signup_requests_provider_uid ON signup_requests(provider, uid);
CREATE INDEX IF NOT EXISTS idx_signup_requests_created ON signup_requests(created_at DESC);

-- 개별 토론 알림 뮤트 테이블
CREATE TABLE IF NOT EXISTS discussion_mutes (
    user_id       INTEGER NOT NULL,
    discussion_id INTEGER NOT NULL,
    created_at    INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, discussion_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (discussion_id) REFERENCES discussions(id)
);
CREATE INDEX IF NOT EXISTS idx_discussion_mutes_discussion ON discussion_mutes(discussion_id);

-- 문서 주시 테이블
CREATE TABLE IF NOT EXISTS page_watches (
    user_id   INTEGER NOT NULL,
    page_id   INTEGER NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, page_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_page_watches_page ON page_watches(page_id);

-- 블로그 포스트 테이블
-- 위키 문서와 독립된 블로그 기능. 리비전 없음, 관리자만 작성 가능.
-- URL 식별자는 id (정수), title이 표시 제목 겸 식별자.
CREATE TABLE IF NOT EXISTS blog_posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  deleted_at INTEGER,
  rows       INTEGER,
  characters INTEGER,
  thumbnail  TEXT  -- 본문 첫 이미지 캐시 (/media/images/...). 없으면 NULL
);
CREATE INDEX IF NOT EXISTS idx_blog_posts_created ON blog_posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_posts_deleted ON blog_posts(deleted_at);


-- Web Push 구독 테이블
-- user_id 가 있는 행: 가입 완료 유저용 (일반 알림 푸시 fan-out 대상)
-- user_id 가 NULL 이고 signup_request_id 가 있는 행: 가입 신청 단계 옵트인 푸시
--   (승인 시 user_id 로 승격되고 signup_request_id 는 NULL 로 초기화)
-- endpoint 는 push service 가 발급하는 고유 URL — UNIQUE.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER,
  signup_request_id INTEGER,
  endpoint          TEXT NOT NULL UNIQUE,
  p256dh            TEXT NOT NULL,
  auth              TEXT NOT NULL,
  ua                TEXT,
  created_at        INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (signup_request_id) REFERENCES signup_requests(id)
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_push_signup ON push_subscriptions(signup_request_id);

-- ──────────────────────────────────────────────────────────────────
-- OAuth 2.1 (관리자 MCP 서버 인증용)
-- ──────────────────────────────────────────────────────────────────
-- DCR(RFC 7591)로 동적으로 등록되거나, 관리자가 수동 발급한 OAuth 클라이언트.
-- public client (Claude Desktop 등 PKCE 사용) 의 경우 client_secret_hash 가 NULL.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id                              INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id                       TEXT NOT NULL UNIQUE,
  client_secret_hash              TEXT,                                  -- SHA-256 hex; public client는 NULL
  client_name                     TEXT,
  redirect_uris                   TEXT NOT NULL,                         -- JSON 배열
  grant_types                     TEXT NOT NULL DEFAULT '["authorization_code","refresh_token"]',
  token_endpoint_auth_method      TEXT NOT NULL DEFAULT 'none',          -- 'none' | 'client_secret_post' | 'client_secret_basic'
  registration_access_token_hash  TEXT,                                  -- DCR 발급 시 클라이언트 메타 조회용
  created_at                      INTEGER DEFAULT (unixepoch()),
  created_by_user_id              INTEGER                                 -- DCR (anonymous) 인 경우 NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_clients_created ON oauth_clients(created_at DESC);

-- 일회용 인가 코드. PKCE code_challenge 와 함께 저장하고 토큰 교환 시 검증.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash             TEXT PRIMARY KEY,                                 -- SHA-256 hex
  client_id             TEXT NOT NULL,
  user_id               INTEGER NOT NULL,
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  scope                 TEXT,
  expires_at            INTEGER NOT NULL,
  used_at               INTEGER,                                          -- 1회용 — 두 번째 교환 시도 시 토큰 패밀리 폐기
  created_at            INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_codes(expires_at);

-- 액세스 토큰 + 리프레시 토큰. 두 토큰 모두 SHA-256 으로 해시 저장.
-- refresh rotation: refresh_token 사용 시 새 access+refresh 발급하고 기존 row 는 revoked_at 설정.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  access_token_hash   TEXT NOT NULL UNIQUE,
  refresh_token_hash  TEXT UNIQUE,
  client_id           TEXT NOT NULL,
  user_id             INTEGER NOT NULL,
  scope               TEXT,
  access_expires_at   INTEGER NOT NULL,
  refresh_expires_at  INTEGER,
  revoked_at          INTEGER,
  created_at          INTEGER DEFAULT (unixepoch()),
  last_used_at        INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh ON oauth_tokens(refresh_token_hash);
