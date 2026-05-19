-- Cloudflare D1 Database Schema


-- 사용자 테이블
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  provider   TEXT NOT NULL,
  uid        TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  picture    TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  role TEXT DEFAULT 'user',  -- 'user', 'discussion_manager', 'admin', 'super_admin', 'banned', 'deleted'
  banned_until INTEGER,
  last_namechange INTEGER,
  UNIQUE(provider, uid)
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
-- slug 가 문서의 고유 식별자이며 모든 호출 경로(위키 링크/트랜스클루전/MCP/URL)의 단일 진실이다.
-- title 은 선택적 표시 전용 대체 제목(NULL = slug 사용). 호출 매칭에는 절대 참여하지 않는다.
CREATE TABLE IF NOT EXISTS pages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slug              TEXT NOT NULL UNIQUE,
  title             TEXT,
  content           TEXT NOT NULL DEFAULT '',
  last_revision_id  INTEGER,
  version           INTEGER DEFAULT 1,
  created_at        INTEGER DEFAULT (unixepoch()),
  updated_at        INTEGER DEFAULT (unixepoch()),
  deleted_at        INTEGER,
  category          TEXT,
  is_private        INTEGER DEFAULT 0,
  redirect_to       TEXT,
  rows              INTEGER,
  characters        INTEGER,
  -- 편집 권한 ACL 정의 (JSON). NULL 또는 flags=[] 면 ACL 비활성, requirePermission('wiki:edit') 만 검사.
  -- 형식: {"flags":["aged","page_editor","any_editor","admin_only"]} (AND 평가 — 모든 플래그 통과 필요).
  -- 'admin_only' 플래그: 해당 문서는 관리자(admin:access)만 편집 가능.
  -- 'admin_only' 가 없는 경우 관리자(admin:access)는 ACL 우회.
  edit_acl          TEXT
);

CREATE INDEX IF NOT EXISTS idx_pages_updated ON pages(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pages_deleted ON pages(deleted_at);
-- title 중복 방지 (NULL 다중 허용). slug 와의 교차 중복은 애플리케이션에서 검증.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pages_title_unique ON pages(title) WHERE title IS NOT NULL;

-- 리비전 테이블
-- content: 본문이 직접 저장되거나, r2_key가 있으면 R2에서 조회.
-- r2_key: R2 버킷 내 파일 경로 (예: revisions/{pageId}/{pageVersion}.md)
-- deleted_at: 리비전 단위 소프트 삭제 시각. NULL = 정상.
-- purged_at:  하드 삭제 시각. NULL = R2 본문 살아있음. 값이 있으면 r2_key/content 가 비워져 있다.
--             감사 가능성 유지를 위해 row 자체와 summary/author_id/page_version/created_at 은 보존한다.
CREATE TABLE IF NOT EXISTS revisions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id      INTEGER NOT NULL,
  page_version INTEGER,
  content      TEXT NOT NULL DEFAULT '',
  r2_key       TEXT,
  summary      TEXT,
  author_id    INTEGER,
  created_at   INTEGER DEFAULT (unixepoch()),
  deleted_at   INTEGER,
  purged_at    INTEGER,
  FOREIGN KEY (page_id) REFERENCES pages(id),
  FOREIGN KEY (author_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_revisions_page_version ON revisions(page_id, page_version DESC);
CREATE INDEX IF NOT EXISTS idx_revisions_author ON revisions(author_id);
CREATE INDEX IF NOT EXISTS idx_revisions_created ON revisions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_revisions_deleted ON revisions(deleted_at);

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
-- 컬럼 0: slug (문서 식별자), 컬럼 1: title (대체 제목), 컬럼 2: content (본문)
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts
USING fts5(slug, title, content, content=pages, content_rowid=id, tokenize="trigram");

-- FTS 트리거
CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, slug, title, content) VALUES (new.id, new.slug, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, slug, title, content) VALUES('delete', old.id, old.slug, old.title, old.content);
END;

CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, slug, title, content) VALUES('delete', old.id, old.slug, old.title, old.content);
  INSERT INTO pages_fts(rowid, slug, title, content) VALUES (new.id, new.slug, new.title, new.content);
END;

-- slug↔title 교차 중복 방지 트리거.
-- slug-slug 는 컬럼 UNIQUE, title-title 은 idx_pages_title_unique 부분 인덱스가 막는다.
-- slug-title / title-slug 교차 충돌은 단일 UNIQUE 인덱스로 표현할 수 없어 BEFORE 트리거로
-- 원자적으로 강제한다 — 애플리케이션 precheck 만으로는 TOCTOU race 가 남기 때문.
CREATE TRIGGER IF NOT EXISTS pages_title_vs_slug_insert
BEFORE INSERT ON pages
WHEN NEW.title IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: pages.title collides with another page slug')
  FROM pages
  WHERE slug = NEW.title;
END;

CREATE TRIGGER IF NOT EXISTS pages_title_vs_slug_update
BEFORE UPDATE OF title ON pages
WHEN NEW.title IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: pages.title collides with another page slug')
  FROM pages
  WHERE slug = NEW.title AND id != NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS pages_slug_vs_title_insert
BEFORE INSERT ON pages
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: pages.slug collides with another page title')
  FROM pages
  WHERE title IS NOT NULL AND title = NEW.slug;
END;

CREATE TRIGGER IF NOT EXISTS pages_slug_vs_title_update
BEFORE UPDATE OF slug ON pages
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: pages.slug collides with another page title')
  FROM pages
  WHERE title IS NOT NULL AND title = NEW.slug AND id != NEW.id;
END;

-- 관리자 카테고리 (레거시 — category_acl 로 흡수됨)
-- 신규 코드는 category_acl 의 `admin_only` 플래그를 사용한다. 운영 환경 마이그레이션 후 DROP 예정.
CREATE TABLE IF NOT EXISTS admin_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at INTEGER DEFAULT (unixepoch())
);

-- 카테고리 ACL 템플릿
-- 카테고리에 매달린 편집 ACL JSON (pages.edit_acl 과 동일 EditAcl 형식).
-- 카테고리가 문서에 적용되는 시점에 페이지 edit_acl 로 merge/overwrite/ignore 모드로 머지된다.
-- `admin_only` 플래그가 포함된 행은 구 admin_categories 와 동일 효과 — 비관리자가 해당 카테고리를 적용할 수 없다.
CREATE TABLE IF NOT EXISTS category_acl (
    name       TEXT PRIMARY KEY,
    edit_acl   TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
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
  -- 사이트 전역 공지 목록 (JSON 배열, 표시 순서대로 정렬).
  -- 각 항목 스키마: { id, title, announcedTime, url|null, postId|null, icon|null }
  announcements           TEXT DEFAULT '[]',
  -- 마지막 발급된 공지 id + 1. 순서가 바뀌어도 안정적인 식별자를 보장.
  announcement_next_id    INTEGER DEFAULT 1,
  -- pages.edit_acl 의 'aged' 플래그가 참조하는 전역 임계값(일).
  -- 0 이면 가입 즉시 통과 (사실상 'aged' 플래그 비활성).
  edit_acl_min_age_days   INTEGER DEFAULT 15
);

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

-- MCP 편집용 draft 테이블
-- patch_page / edit_section / create_or_update_page 호출 시 누적 저장, commit_edit 시 리비전 1개 생성.
-- base_revision_id != last_revision_id 이면 충돌로 거부.
-- 기존 페이지: base_revision_id = last_revision_id, base_version = version.
-- 신규 페이지: base_revision_id = NULL, base_version = 0.
-- action: 'create' | 'update'
-- TTL: 12시간 미사용 draft 일괄 삭제 (매일 자정 cron).
-- submitted_at IS NULL → 작성 중 (12시간 TTL).
-- submitted_at IS NOT NULL → 승인 대기 (30일 TTL).
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
  title             TEXT,
  has_title_change  INTEGER NOT NULL DEFAULT 0,
  submitted_at      INTEGER,
  submitted_summary TEXT,
  created_at        INTEGER DEFAULT (unixepoch()),
  updated_at        INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE (user_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_mcp_drafts_user ON mcp_drafts(user_id);
CREATE INDEX IF NOT EXISTS idx_mcp_drafts_updated ON mcp_drafts(updated_at);
CREATE INDEX IF NOT EXISTS idx_mcp_drafts_submitted
  ON mcp_drafts(user_id, submitted_at)
  WHERE submitted_at IS NOT NULL;

-- 문서 간 링크 테이블 (역링크 인덱싱용)
-- source_type: 'page' | 'blog' | 'discussion_comment' | 'ticket_comment'
-- blog 컬럼: source_type='blog' 이면 1, 그 외 0 (legacy 호환).
CREATE TABLE IF NOT EXISTS page_links (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_page_id INTEGER NOT NULL,
  target_slug    TEXT NOT NULL,
  link_type      TEXT NOT NULL DEFAULT 'wikilink',  -- 'wikilink', 'template', 'image', 'extension'
  blog          INTEGER NOT NULL DEFAULT 0,
  source_type   TEXT NOT NULL DEFAULT 'page'
);
CREATE INDEX IF NOT EXISTS idx_page_links_source ON page_links(source_page_id);
CREATE INDEX IF NOT EXISTS idx_page_links_target ON page_links(target_slug);
CREATE INDEX IF NOT EXISTS idx_page_links_source_type ON page_links(source_type, source_page_id);

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
-- scope='this'    : 해당 문서만 구독
-- scope='subtree' : 해당 문서 + 하위 문서( slug LIKE '{watched}/%' )까지 구독
CREATE TABLE IF NOT EXISTS page_watches (
    user_id   INTEGER NOT NULL,
    page_id   INTEGER NOT NULL,
    scope     TEXT NOT NULL DEFAULT 'this',
    created_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, page_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_page_watches_page ON page_watches(page_id);
CREATE INDEX IF NOT EXISTS idx_page_watches_user ON page_watches(user_id);

-- 카테고리 주시 테이블
-- 해당 카테고리에 속한 모든 문서의 편집 알림을 받는다.
CREATE TABLE IF NOT EXISTS category_watches (
    user_id    INTEGER NOT NULL,
    category   TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, category),
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_category_watches_category ON category_watches(category);

-- 슬러그 prefix 별 자동 카테고리 부여 규칙
-- prefix/ 로 시작하는 문서 생성/이동 시 categories(쉼표 구분) 가 합집합으로 적용된다.
CREATE TABLE IF NOT EXISTS category_prefix_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    prefix     TEXT NOT NULL UNIQUE,
    categories TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_category_prefix_rules_prefix ON category_prefix_rules(prefix);

-- 슬러그 prefix 별 자동 문서 설정(비공개/편집 ACL) 부여 규칙
-- prefix/ 로 시작하는 문서 생성 시 is_private / edit_acl 가 강제 적용된다.
-- NULL 컬럼은 해당 설정에 규칙 없음 (생성자의 값 유지).
CREATE TABLE IF NOT EXISTS doc_setting_prefix_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    prefix     TEXT NOT NULL UNIQUE,
    is_private INTEGER,
    edit_acl   TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    CHECK (is_private IS NOT NULL OR edit_acl IS NOT NULL)
);

-- 커스텀 컬러 팔레트
-- {palette:이름} 위키 문법에서 사용. 하드코딩 프리셋 위에 머지된다.
-- 라이트/다크 동일 색을 쓰는 경우 light_*=dark_* 로 저장.
CREATE TABLE IF NOT EXISTS palettes (
    name        TEXT PRIMARY KEY,             -- ^[A-Za-z0-9_-]+$, 1~64자
    light_bg    TEXT,
    light_color TEXT,
    dark_bg     TEXT,
    dark_color  TEXT,
    created_at  INTEGER DEFAULT (unixepoch()),
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- 블로그 포스트 테이블
-- 리비전 없음, 관리자만 작성 가능. URL 식별자는 id.
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
-- user_id: 가입 완료 유저. NULL + signup_request_id: 가입 신청 단계 옵트인.
-- 승인 시 user_id 로 승격, signup_request_id 는 NULL 로 초기화.
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

-- DCR(RFC 7591)로 동적 등록되거나 관리자가 수동 발급한 OAuth 클라이언트.
-- public client (PKCE 사용) 의 경우 client_secret_hash 가 NULL.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id                              INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id                       TEXT NOT NULL UNIQUE,
  client_secret_hash              TEXT,
  client_name                     TEXT,
  redirect_uris                   TEXT NOT NULL,                         -- JSON 배열
  grant_types                     TEXT NOT NULL DEFAULT '["authorization_code","refresh_token"]',
  token_endpoint_auth_method      TEXT NOT NULL DEFAULT 'none',          -- 'none' | 'client_secret_post' | 'client_secret_basic'
  registration_access_token_hash  TEXT,
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
  used_at               INTEGER,                                          -- 1회용 — 재사용 시 토큰 패밀리 폐기
  created_at            INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_codes(expires_at);

-- 액세스 토큰 + 리프레시 토큰. SHA-256 해시 저장.
-- refresh rotation: 사용 시 새 토큰 발급, 기존 row 는 revoked_at 설정.
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
