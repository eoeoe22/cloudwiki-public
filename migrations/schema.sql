

CREATE TABLE users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  google_id  TEXT NOT NULL UNIQUE,
  email      TEXT NOT NULL,
  name       TEXT NOT NULL,
  picture    TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  role TEXT DEFAULT 'user',
  banned_until INTEGER,
  rate_limit INTEGER DEFAULT 10
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE pages (
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

CREATE INDEX idx_pages_slug ON pages(slug);
CREATE INDEX idx_pages_updated ON pages(updated_at);

CREATE TABLE revisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id    INTEGER NOT NULL,
  content    TEXT NOT NULL,
  summary    TEXT,
  author_id  INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (page_id) REFERENCES pages(id),
  FOREIGN KEY (author_id) REFERENCES users(id)
);

CREATE INDEX idx_revisions_page ON revisions(page_id);



CREATE TABLE media (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  r2_key      TEXT NOT NULL UNIQUE,
  filename    TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size        INTEGER NOT NULL,
  uploader_id INTEGER,
  created_at  INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (uploader_id) REFERENCES users(id)
);

CREATE VIRTUAL TABLE pages_fts
USING fts5(title, content, content=pages, content_rowid=id, tokenize="trigram");

CREATE TRIGGER pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

CREATE TRIGGER pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content);
END;

CREATE TRIGGER pages_au AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content);
  INSERT INTO pages_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

CREATE TABLE admin_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE redirects (
  id INTEGER PRIMARY KEY,
  source_slug TEXT UNIQUE NOT NULL,
  target_page_id INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_redirects_source ON redirects(source_slug);
CREATE INDEX idx_redirects_target ON redirects(target_page_id);

CREATE TABLE rate_limit_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_rate_limit_user_time ON rate_limit_events(user_id, created_at);

-- 토론 스레드 (문서에 종속)
CREATE TABLE discussions (
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
CREATE INDEX idx_discussions_page ON discussions(page_id);

-- 토론 댓글 (답글 포함)
CREATE TABLE discussion_comments (
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
CREATE INDEX idx_dcomments_discussion ON discussion_comments(discussion_id);
