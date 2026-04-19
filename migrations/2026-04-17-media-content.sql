-- 기존 배포에 적용: media 테이블에 content 컬럼 추가 및 filename 인덱스 생성
-- 이미지 문서(/w/이미지:파일명) 본문 저장용. 위키 문법 렌더링 없이 이스케이프하여 표시.

ALTER TABLE media ADD COLUMN content TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_media_filename ON media(filename);
