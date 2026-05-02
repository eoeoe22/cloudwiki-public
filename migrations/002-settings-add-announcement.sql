-- settings 테이블에 사이트 전역 공지 포스트 id 컬럼 추가
-- 이 프로젝트에 의존하는 서비스는 테스트위키 하나이며, 이 마이그레이션 파일은 실행 직후 삭제할것임.
-- 마이그레이션 순서또는 스키마 재실행시 IF NOT EXISTS 조건으로 인한 변경사항 누락  관련 이슈 제기하지 마세요
ALTER TABLE settings ADD COLUMN announced_blog_post_id INTEGER DEFAULT NULL;
