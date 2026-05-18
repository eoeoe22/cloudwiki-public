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
  is_locked         INTEGER DEFAULT 0,
  is_private        INTEGER DEFAULT 0,
  redirect_to       TEXT,
  rows              INTEGER,
  characters        INTEGER
);


CREATE INDEX IF NOT EXISTS idx_pages_updated ON pages(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pages_deleted ON pages(deleted_at);
-- title 중복 방지 (NULL 다중 허용). slug 와의 교차 중복은 애플리케이션에서 검증.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pages_title_unique ON pages(title) WHERE title IS NOT NULL;

-- 리비전 테이블
-- content: 본문이 직접 저장되거나, r2_key가 있으면 R2에서 조회.
-- r2_key: R2 버킷 내 파일 경로 (예: revisions/{pageId}/{pageVersion}.md)
-- deleted_at: 리비전 단위 소프트 삭제 시각. NULL = 정상.
--             권한 없는 사용자에게 해당 리비전 자체가 존재하지 않는 것처럼 가려진다.
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
  -- 사이트 전역 공지 목록 (JSON 배열, 표시 순서대로 정렬).
  -- 각 항목 스키마: { id, title, announcedTime, url|null, postId|null, icon|null }
  announcements           TEXT DEFAULT '[]',
  -- 마지막 발급된 공지 id + 1. 순서가 바뀌어도 안정적인 식별자를 보장.
  announcement_next_id    INTEGER DEFAULT 1
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
-- submitted_at / submitted_summary: commit_edit(submit_for_approval=true) 로 제출된 draft.
-- submitted_at IS NULL → 작성 중 draft (12시간 TTL).
-- submitted_at IS NOT NULL → OAuth 토큰 소유자의 승인 대기 (30일 TTL, 별도 크론 분기).
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
-- 제출된 draft 만 인덱싱 (mypage 의 본인 제출안 목록 / 카운트 / 배너 쿼리에서 사용).
CREATE INDEX IF NOT EXISTS idx_mcp_drafts_submitted
  ON mcp_drafts(user_id, submitted_at)
  WHERE submitted_at IS NOT NULL;

-- 기존 배포된 DB 를 위한 마이그레이션 (멱등).
-- SQLite 는 IF NOT EXISTS 가 ADD COLUMN 에 없으므로 PRAGMA table_info 로 분기해야 하지만,
-- D1 콘솔에서 한 번만 수동 실행한다는 전제로 schema.sql 에는 정의만 둔다.

-- 문서 간 링크 테이블 (역링크 인덱싱용)
-- 문서 수정 시 content에서 [[링크]]를 파싱하여 이 테이블에 저장
-- source_page_id는 source_type 에 따라 다른 테이블의 id 를 가리킴:
--   'page'              → pages.id
--   'blog'              → blog_posts.id
--   'discussion_comment'→ discussion_comments.id
--   'ticket_comment'    → ticket_comments.id
-- 여러 ID 공간이 겹치므로 외래키는 두지 않는다 (FK 강제 시 INSERT 실패).
-- source_type 필터가 page/blog/discussion_comment/ticket_comment 행을 분리하므로
-- source_page_id 충돌에도 다른 소스 행이 잘못 매칭/삭제되지 않는다.
--
-- 'blog' INTEGER 컬럼은 마이그레이션 전 배포된 admin GC / 블로그 라우트 호환을 위해
-- 역호환 유지 — source_type='blog' 이면 blog=1, 그 외 source_type 은 blog=0.
-- 신규 코드는 모두 source_type 으로 분기한다.
CREATE TABLE IF NOT EXISTS page_links (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_page_id INTEGER NOT NULL,
  target_slug    TEXT NOT NULL,
  link_type      TEXT NOT NULL DEFAULT 'wikilink',  -- 'wikilink', 'template', 'image', 'extension'
  blog          INTEGER NOT NULL DEFAULT 0,         -- 0: 위키 / 토론 / 티켓, 1: 블로그 (legacy 호환)
  source_type   TEXT NOT NULL DEFAULT 'page'        -- 'page' | 'blog' | 'discussion_comment' | 'ticket_comment'
);
CREATE INDEX IF NOT EXISTS idx_page_links_source ON page_links(source_page_id);
CREATE INDEX IF NOT EXISTS idx_page_links_target ON page_links(target_slug);
CREATE INDEX IF NOT EXISTS idx_page_links_source_type ON page_links(source_type, source_page_id);
-- D1 콘솔 1회 수동 마이그레이션 (배포된 DB):
--   ALTER TABLE page_links ADD COLUMN source_type TEXT NOT NULL DEFAULT 'page';
--   UPDATE page_links SET source_type = 'blog' WHERE blog = 1;
--   CREATE INDEX IF NOT EXISTS idx_page_links_source_type ON page_links(source_type, source_page_id);

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
-- page_categories 테이블과 JOIN 하여 알림 fan-out 대상을 결정한다.
CREATE TABLE IF NOT EXISTS category_watches (
    user_id    INTEGER NOT NULL,
    category   TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, category),
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_category_watches_category ON category_watches(category);

-- 슬러그 prefix 별 자동 카테고리 부여 규칙
-- prefix/ 로 시작하는 문서가 새로 생성되거나 이동(rename) 될 때
-- categories(쉼표 구분) 가 기존 카테고리에 합집합으로 적용된다.
-- 관리자만 생성/삭제할 수 있다 (라우트 단의 requireAdmin 미들웨어로 보호).
CREATE TABLE IF NOT EXISTS category_prefix_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    prefix     TEXT NOT NULL UNIQUE,
    categories TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_category_prefix_rules_prefix ON category_prefix_rules(prefix);

-- 슬러그 prefix 별 자동 문서 설정(편집 잠금/비공개) 부여 규칙
-- prefix/ 로 시작하는 문서가 새로 생성될 때 is_locked / is_private 가 강제 적용된다.
-- 한 컬럼이 NULL 이면 그 플래그에 대해서는 규칙 없음(생성자의 값 유지).
-- 관리자만 CRUD (라우트 단의 admin:access RBAC 로 보호).
CREATE TABLE IF NOT EXISTS doc_setting_prefix_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    prefix     TEXT NOT NULL UNIQUE,
    is_locked  INTEGER,                          -- NULL=규칙 없음, 0/1=신규 생성 시 강제값
    is_private INTEGER,                          -- NULL=규칙 없음, 0/1=신규 생성 시 강제값
    created_at INTEGER DEFAULT (unixepoch()),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    CHECK (is_locked IS NOT NULL OR is_private IS NOT NULL)
);

-- 커스텀 컬러 팔레트
-- {palette:이름} 위키 문법에서 사용. 하드코딩 프리셋(primary/secondary/success/info/warning/danger/muted) 위에 머지된다.
-- 관리자만 CUD (라우트 단의 requireAdmin 미들웨어로 보호).
-- 라이트/다크 동일 색을 쓰는 플랫 정의는 light_*=dark_* 로 저장.
CREATE TABLE IF NOT EXISTS palettes (
    name        TEXT PRIMARY KEY,             -- ^[A-Za-z0-9_-]+$, 1~64자
    light_bg    TEXT,
    light_color TEXT,
    dark_bg     TEXT,
    dark_color  TEXT,
    created_at  INTEGER DEFAULT (unixepoch()),
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);
-- D1 콘솔 1회 수동 마이그레이션 (배포된 DB):
--   CREATE TABLE IF NOT EXISTS palettes (
--       name TEXT PRIMARY KEY,
--       light_bg TEXT, light_color TEXT,
--       dark_bg TEXT,  dark_color TEXT,
--       created_at INTEGER DEFAULT (unixepoch()),
--       created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
--   );
--   -- 기존 PALETTES env JSON 시드 예 (필요한 항목만 추려서 실행):
--   INSERT OR IGNORE INTO palettes (name, light_bg, light_color, dark_bg, dark_color) VALUES
--     ('cloudflare', '#F6821F', '#000000', '#F6821F', '#000000'),
--     ('claude',     '#F0EEE6', '#C15F3C', '#F0EEE6', '#C15F3C'),
--     ('typescript', '#3178C6', '#FFFFFF', '#3178C6', '#FFFFFF'),
--     ('reverse',    '#000000', '#000000', '#FFFFFF', '#FFFFFF'),
--     ('Anthropic',  '#F0EEE6', '#000000', '#F0EEE6', '#000000'),
--     ('python',     '#3776AB', '#FFD43B', '#3776AB', '#FFD43B'),
--     ('js',         '#F7DF1E', '#000000', '#F7DF1E', '#000000'),
--     ('discord',    '#5865F2', '#FFFFFF', '#5865F2', '#FFFFFF');
--   -- page_links 에 link_type='palette' 행은 문서 저장 시 자동으로 채워진다.
--   -- 기존 문서의 색인을 일괄 채우려면, 각 문서를 한 번씩 재저장하거나 별도 백필 스크립트를 실행한다.

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
