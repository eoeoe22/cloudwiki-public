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
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 문서 테이블
CREATE TABLE IF NOT EXISTS pages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slug              TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  content           TEXT NOT NULL DEFAULT '',
  author_id         INTEGER,
  last_revision_id  INTEGER,
  version           INTEGER DEFAULT 1,
  created_at        INTEGER DEFAULT (unixepoch()),
  updated_at        INTEGER DEFAULT (unixepoch()),
  deleted_at        INTEGER,
  category          TEXT,
  is_locked         INTEGER DEFAULT 0,
  is_private        INTEGER DEFAULT 0,
  redirect_to       TEXT,
  FOREIGN KEY (author_id) REFERENCES users(id)
);


CREATE INDEX IF NOT EXISTS idx_pages_updated ON pages(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pages_author ON pages(author_id);

-- 리비전 테이블
-- content: 기존 리비전은 본문이 직접 저장됨. 신규 리비전은 r2_key를 통해 R2에서 조회.
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
CREATE TABLE IF NOT EXISTS media (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  r2_key      TEXT NOT NULL UNIQUE,
  filename    TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size        INTEGER NOT NULL,
  uploader_id INTEGER,
  created_at  INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (uploader_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_media_uploader ON media(uploader_id);

-- FTS5 검색 가상 테이블
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts
USING fts5(title, content, content=pages, content_rowid=id, tokenize="trigram");

-- FTS 트리거
CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content);
END;

CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content);
  INSERT INTO pages_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

-- 관리자 카테고리
CREATE TABLE IF NOT EXISTS admin_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at INTEGER DEFAULT (unixepoch())
);

-- 리다이렉트 테이블
CREATE TABLE IF NOT EXISTS redirects (
  id INTEGER PRIMARY KEY,
  source_slug TEXT UNIQUE NOT NULL,
  target_page_id INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);


CREATE INDEX IF NOT EXISTS idx_redirects_target ON redirects(target_page_id);

-- 설정 테이블
CREATE TABLE IF NOT EXISTS settings (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  namechange_ratelimit  INTEGER DEFAULT 0,
  allow_direct_message  INTEGER DEFAULT 0,
  signup_policy         TEXT DEFAULT 'open'  -- 'open' (모두 허용), 'approval' (관리자 승인제)
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

-- 문서 간 링크 테이블 (역링크 인덱싱용)
-- 문서 수정 시 content에서 [[링크]]를 파싱하여 이 테이블에 저장
CREATE TABLE IF NOT EXISTS page_links (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_page_id INTEGER NOT NULL,
  target_slug    TEXT NOT NULL,
  link_type      TEXT NOT NULL DEFAULT 'wikilink',  -- 'wikilink', 'template', 'image'
  FOREIGN KEY (source_page_id) REFERENCES pages(id) ON DELETE CASCADE
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

-- 기존 google_id 컬럼에서 provider + uid로 업그레이드하는 마이그레이션은
-- migrations/migrate_google_to_provider.sql 을 참고하세요.
-- 새로 설치한 경우 이 schema.sql만 실행하면 됩니다.
