-- blog_posts 테이블에 썸네일 URL 캐시 컬럼 추가
-- 본문 첫 이미지(/media/images/...)를 INSERT/UPDATE 시점에 산출하여 저장한다.
-- 목록 조회에서 content 를 읽지 않고 thumbnail 만으로 카드 렌더링이 가능하다.
-- 기존 포스트는 NULL 로 남고 다음 편집 시 채워진다 (수동 백필이 필요하면 별도 처리).
-- 이 프로젝트에 의존하는 서비스는 테스트위키 하나이며, 이 마이그레이션 파일은 실행 직후 삭제할것임.
ALTER TABLE blog_posts ADD COLUMN thumbnail TEXT;
