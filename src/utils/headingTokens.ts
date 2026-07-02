/**
 * 헤딩 수정자 토큰 처리 (서버측).
 *
 * 헤딩 끝에 붙는 `{collapse}` 토큰은 렌더러(render.ts)가 해당 문단(헤딩 섹션)을 기본 접힘
 * 상태로 렌더하기 위한 마커입니다. 이 토큰은 목차(get_toc)·문서 맵(get_map)·검색 결과 섹션
 * 라벨 등 "제목 표시" 경로에서는 노출되면 안 되므로, 그런 경로에서 헤딩 텍스트를 캡처할 때
 * 이 헬퍼로 토큰을 제거합니다.
 *
 * 규칙(렌더러 render.ts 의 WIKI_COLLAPSE_TOKEN_RE 와 동일):
 *  - 헤딩 끝(트레일링)에 위치할 때만 유효.
 *  - ATX 닫기(예: `## 제목 {collapse} ##`)가 뒤따라도 인식.
 *  - 원본(read_section/edit_section 등 라운드트립) 경로에서는 제거하지 않음 — 소스의 일부로 보존.
 */
const COLLAPSE_TOKEN_RE = /\s*\{\s*collapse\s*\}\s*#*\s*$/;

/** 헤딩 텍스트에서 트레일링 `{collapse}` 토큰을 제거한 표시용 제목을 반환합니다. */
export function stripCollapseToken(headingText: string): string {
    return (headingText || '').replace(COLLAPSE_TOKEN_RE, '');
}
