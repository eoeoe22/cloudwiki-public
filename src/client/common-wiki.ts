// cloudwiki 공통 클라이언트 진입점(wiki 전용 번들).
// Phase 1: 기존 common.ts 를 그대로 실행(동작 보존). Phase 2 에서 @cloudwiki/wiki-shared 의
// common-core + wiki 전용 스택(auth, notifications, push, wiki sidebar)으로 재작성 예정.
import './common';
