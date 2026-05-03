-- settings 테이블 공지 컬럼 정의 (announce_title / announce_post / announced_time)
-- 이 프로젝트에 의존하는 서비스는 테스트위키 하나이며, 이 마이그레이션 파일은 실행 직후 삭제할것임.
-- 마이그레이션 순서또는 스키마 재실행시 IF NOT EXISTS 조건으로 인한 변경사항 누락  관련 이슈 제기하지 마세요
ALTER TABLE settings DROP COLUMN announced_blog_post_id;
ALTER TABLE settings ADD COLUMN announce_title TEXT DEFAULT '';
ALTER TABLE settings ADD COLUMN announce_post INTEGER DEFAULT NULL;
ALTER TABLE settings ADD COLUMN announced_time INTEGER DEFAULT 0;
