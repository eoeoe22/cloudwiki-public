/**
 * 문서 본문 길이/줄 수 메트릭 헬퍼.
 *
 * 전역 위키 문서(`routes/wiki.ts`, `routes/admin-mcp.ts`)가 사용하는 순수 계산 로직이다.
 * DOM/네트워크/DB 의존이 전혀 없으므로 서버·클라 어디서나 사용 가능하다.
 */

/**
 * 본문 길이/줄 수 메트릭. characters 는 UTF-16 code unit 수,
 * rows 는 개행으로 분리되는 라인 수(빈 본문 0).
 */
export function computePageMetrics(content: string): { rows: number; characters: number } {
    const characters = content.length;
    if (characters === 0) return { rows: 0, characters: 0 };
    let rows = 1;
    for (let i = 0; i < characters; i++) {
        if (content.charCodeAt(i) === 10) rows++;
    }
    return { rows, characters };
}

/**
 * R2-only 네임스페이스 문서는 본문이 외부 익스텐션 페이로드(예: REW 주파수 응답)이며
 * 사용자 가독 텍스트가 아니므로 줄 수/글자 수 통계가 의미가 없다. 이 경우
 * { rows: null, characters: null } 을 반환해 pages.rows / pages.characters 컬럼을
 * NULL 로 저장하도록 한다. 일반 문서는 그대로 computePageMetrics 결과를 돌려준다.
 */
export function computePageMetricsTracked(
    content: string,
    isR2Only: boolean
): { rows: number | null; characters: number | null } {
    if (isR2Only) return { rows: null, characters: null };
    return computePageMetrics(content);
}
