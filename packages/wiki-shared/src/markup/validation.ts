/**
 * 문서 슬러그/제목 입력 검증 헬퍼.
 *
 * 전역 위키(`routes/wiki.ts`, `routes/admin-mcp.ts`)와 워크스페이스
 * (`routes/workspace.ts`, `routes/workspace-pages.ts`, `routes/ws-mcp.ts`)가 공유하는
 * 순수 검증 상수/함수다. DB/DOM 의존이 없으므로 서버·클라 공용이며, 향후 공유 패키지의
 * `@cloudwiki/wiki-shared/markup/validation` 로 이전될 모듈이다.
 *
 * 주의: `pages.title` 은 표시 전용 대체 제목이다. 슬러그(slug)만이 식별·링크·호출 경로의
 * 기준이며, 이 모듈의 title 검증은 표시 문자열 위생(제어문자/길이)만 담당한다.
 */

/**
 * 슬러그에 사용할 수 없는 금지 문자 패턴.
 * - `{}` / `[]` : 트랜스클루전 `{{...}}` / 위키링크 `[[...]]` 문법과 충돌
 * - `#` : 섹션 앵커 구분자(`[[slug#1.2]]`)
 * - `|` : 위키링크 표시명 / 틀 인자 구분자
 * - `% < > ^` + 제어문자 : URL/HTML/데이터 무결성
 * 일반 괄호 `()` 는 동음이의 분기(예: `수성(행성)`)에 흔히 쓰이고 식별·파싱 경로
 * (위키링크 `[^\]]+`/트랜스클루전 `[^}]+?`/`encodeURIComponent`/리네임 `escapeRe`)
 * 어디에도 끼어들지 않으므로 허용한다. (단, 표준 마크다운 링크 `[..](url)` 에 직접 넣을
 * 때는 닫는 `)` 가 URL 을 조기 종료하므로 내부 링크는 위키링크 `[[...]]` 를 사용한다.)
 */
export const SLUG_FORBIDDEN_CHARS = /[\[\]{}#%|<>^\x00-\x1F\x7F]/;

/** 대체 title 입력 금지 문자 — 제어문자만 차단. 슬러그와 달리 [], {}, # 등 특수문자 허용. */
export const TITLE_FORBIDDEN_CHARS = /[\x00-\x1F\x7F]/;
export const TITLE_MAX_LENGTH = 100;

/**
 * 클라이언트가 보낸 title 입력을 정규화한다.
 * - undefined / null / 빈 문자열(공백 포함) → null
 * - 그 외 → trim 된 문자열
 */
export function normalizeTitleInput(raw: unknown): string | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return trimmed;
}
