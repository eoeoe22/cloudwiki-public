// 위키 본문 정규화 유틸 — 서버 저장 경로(src/routes/wiki.ts·blog.ts)와 클라이언트
// 에디터(src/client/edit/main.ts)가 공유한다. src/shared/normalize.ts 는 이 파일의
// 동일 미러(transclusion.ts 와 같은 패턴)이며, 수정 시 양쪽을 함께 갱신한다.

/**
 * 줄 시작의 제로폭 문자(U+200B ZWSP / U+FEFF BOM)를 제거한다.
 *
 * 모바일 IME·외부 앱 붙여넣기로 유입되면 눈에 보이지 않으면서 헤딩(#)/목록/인용 등
 * 줄 시작 문법의 렌더링·에디터 하이라이팅을 깨뜨린다.
 *
 * - 코드펜스(``` / ~~~) **본문** 줄은 사용자 데이터이므로 보존한다.
 * - 펜스 구분자 줄(여는/닫는 줄) 자체의 접두 제로폭 문자는 문법 오염이므로 제거한다
 *   (제거해야 marked·에디터가 펜스로 인식한다).
 * - 줄 중간의 제로폭 문자는 의도적 문법 이스케이프일 수 있어 건드리지 않는다.
 *
 * 펜스 판정은 render.ts 코드 보호 정규식과 동일 규약: 구분자는 컬럼 0(제로폭 접두 제외),
 * 백틱 펜스 오프너의 info string 에는 백틱 불가(CommonMark), 닫는 펜스는 같은 문자·
 * 같거나 긴 길이·뒤에 공백/탭만.
 */
export function stripLineLeadingZeroWidth(text: string): string {
    if (!text || (text.indexOf('\u200B') === -1 && text.indexOf('\uFEFF') === -1)) return text;
    const lines = text.split('\n');
    let fenceChar: string | null = null;
    let fenceLen = 0;
    for (let i = 0; i < lines.length; i++) {
        const stripped = lines[i].replace(/^[\u200B\uFEFF]+/, '');
        if (fenceChar === null) {
            const fm = stripped.match(/^(`{3,}|~{3,})(.*)$/);
            if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) {
                fenceChar = fm[1][0];
                fenceLen = fm[1].length;
            }
            lines[i] = stripped;
        } else {
            const closeM = stripped.match(/^(`{3,}|~{3,})[ \t]*$/);
            if (closeM && closeM[1][0] === fenceChar && closeM[1].length >= fenceLen) {
                fenceChar = null;
                fenceLen = 0;
                lines[i] = stripped;
            }
            // 펜스 본문: 제로폭 문자 포함 그대로 보존
        }
    }
    return lines.join('\n');
}
