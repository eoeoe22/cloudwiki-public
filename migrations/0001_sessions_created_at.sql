-- 마이그레이션: sessions.created_at 컬럼 추가
--
-- 배경:
--   세션 관리 UI(/mypage)에서 각 세션의 로그인 시각을 표시하기 위해
--   sessions 테이블에 created_at 컬럼이 필요하다.
--   기존 schema.sql 의 CREATE TABLE IF NOT EXISTS 는 이미 배포된
--   D1 인스턴스의 테이블을 변경하지 않으므로, 운영 환경에는 반드시
--   이 ALTER 문을 한 번 실행해야 한다.
--
-- 실행 방법 (예):
--   wrangler d1 execute <DB_NAME> --remote --file=migrations/0001_sessions_created_at.sql
--
-- 멱등성:
--   SQLite 의 ALTER TABLE ADD COLUMN 에는 IF NOT EXISTS 가 없다.
--   이미 컬럼이 존재하는 신규 인스턴스에서 이 마이그레이션을 다시
--   실행하면 "duplicate column name" 오류가 발생하므로, 새 환경에서는
--   schema.sql 만으로 충분하며 본 파일은 실행하지 않는다.
--
-- 기존 행 처리:
--   ALTER TABLE 로 추가된 컬럼은 기존 행에 대해 NULL 로 남는다.
--   API (/api/me/sessions) 는 created_at 가 NULL 인 경우
--   expires_at - 7일 로 보정하여 응답하므로 별도 백필은 필요 없다.

ALTER TABLE sessions ADD COLUMN created_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
