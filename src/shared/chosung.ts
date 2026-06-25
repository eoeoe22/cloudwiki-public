// 첫 글자 기준 초성/문자 그룹 분류 유틸.
//
// 카테고리 목록 페이지(src/client/render.ts 의 _wikiCategoryGroupOf)와 동일한 분류 규칙을
// 순수 함수로 분리한 단일 소스. /all(모든 문서 보기) 페이지가 네임스페이스 문서의 ":" 이후
// 글자를 넘겨 초성을 추출하는 등 다양한 입력에 재사용할 수 있도록 한다.
//
// - 한글 음절(가-힣): 초성 추출 후 19 초성 → 14 자음 정규화(쌍자음 ㄲ ㄸ ㅃ ㅆ ㅉ 을 평음에 병합).
// - 한글 호환 자모(ㄱ-ㅎ): 자모 자체를 평음 그룹으로 매핑.
// - 가타카나: 동일 음 히라가나로 정규화한 뒤 50음도 행(あ か さ …)으로 분류.
// - 라틴 알파벳: 대문자 A-Z.
// - 숫자: '0-9' 그룹.
// - 그 외: '#'.
//
// 반환 order 는 한글('1xx') → 일본어('2xx') → 라틴('3X') → 숫자('40') → 기타('9999') 순으로
// 정렬되도록 접두사를 부여한 정렬 키다. label 은 사람이 보는 그룹 헤더 문자다.

export interface InitialGroup {
    /** 정렬 키(스크립트 그룹 + 인덱스). 사전식 비교로 한글→일본어→라틴→숫자→기타 순. */
    order: string;
    /** 그룹 헤더로 표시할 라벨(예: 'ㄱ', 'あ', 'A', '0-9', '#'). */
    label: string;
}

export function wikiInitialGroupOf(name: string): InitialGroup {
    if (!name) return { order: '9999', label: '#' };
    const ch = name.charAt(0);
    const code = ch.charCodeAt(0);

    // 한글 음절 (가-힣)
    if (code >= 0xac00 && code <= 0xd7a3) {
        const chosung = Math.floor((code - 0xac00) / 588);
        // 19 초성 → 14 자음으로 정규화 (쌍자음 병합)
        const normLabel = ['ㄱ', 'ㄱ', 'ㄴ', 'ㄷ', 'ㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅂ', 'ㅅ', 'ㅅ', 'ㅇ', 'ㅈ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
        const normIdx = [0, 0, 1, 2, 2, 3, 4, 5, 5, 6, 6, 7, 8, 8, 9, 10, 11, 12, 13];
        return { order: '1' + String(normIdx[chosung]).padStart(2, '0'), label: normLabel[chosung] };
    }
    // 한글 자모 (호환 자모 영역: ㄱ-ㅎ)
    if (code >= 0x3131 && code <= 0x314e) {
        const jamoMap: Record<string, [number, string]> = {
            'ㄱ': [0, 'ㄱ'], 'ㄲ': [0, 'ㄱ'], 'ㄳ': [0, 'ㄱ'],
            'ㄴ': [1, 'ㄴ'], 'ㄵ': [1, 'ㄴ'], 'ㄶ': [1, 'ㄴ'],
            'ㄷ': [2, 'ㄷ'], 'ㄸ': [2, 'ㄷ'],
            'ㄹ': [3, 'ㄹ'], 'ㄺ': [3, 'ㄹ'], 'ㄻ': [3, 'ㄹ'], 'ㄼ': [3, 'ㄹ'], 'ㄽ': [3, 'ㄹ'], 'ㄾ': [3, 'ㄹ'], 'ㄿ': [3, 'ㄹ'], 'ㅀ': [3, 'ㄹ'],
            'ㅁ': [4, 'ㅁ'],
            'ㅂ': [5, 'ㅂ'], 'ㅃ': [5, 'ㅂ'], 'ㅄ': [5, 'ㅂ'],
            'ㅅ': [6, 'ㅅ'], 'ㅆ': [6, 'ㅅ'],
            'ㅇ': [7, 'ㅇ'],
            'ㅈ': [8, 'ㅈ'], 'ㅉ': [8, 'ㅈ'],
            'ㅊ': [9, 'ㅊ'], 'ㅋ': [10, 'ㅋ'], 'ㅌ': [11, 'ㅌ'], 'ㅍ': [12, 'ㅍ'], 'ㅎ': [13, 'ㅎ'],
        };
        const m = jamoMap[ch];
        if (m) return { order: '1' + String(m[0]).padStart(2, '0'), label: m[1] };
    }
    // 가타카나 → 히라가나 정규화
    let hira = ch;
    if (code >= 0x30a1 && code <= 0x30f6) {
        hira = String.fromCharCode(code - 0x60);
    }
    const hcode = hira.charCodeAt(0);
    if (hcode >= 0x3041 && hcode <= 0x3096) {
        // 50음도 행별 분류
        const rows = [
            { label: 'あ', start: 0x3041, end: 0x304a },
            { label: 'か', start: 0x304b, end: 0x3054 },
            { label: 'さ', start: 0x3055, end: 0x305e },
            { label: 'た', start: 0x305f, end: 0x3069 },
            { label: 'な', start: 0x306a, end: 0x306e },
            { label: 'は', start: 0x306f, end: 0x307d },
            { label: 'ま', start: 0x307e, end: 0x3082 },
            { label: 'や', start: 0x3083, end: 0x3088 },
            { label: 'ら', start: 0x3089, end: 0x308d },
            { label: 'わ', start: 0x308e, end: 0x3093 },
        ];
        for (let i = 0; i < rows.length; i++) {
            if (hcode >= rows[i].start && hcode <= rows[i].end) {
                return { order: '2' + String(i).padStart(2, '0'), label: rows[i].label };
            }
        }
    }
    // 알파벳
    if (/[A-Za-z]/.test(ch)) {
        const u = ch.toUpperCase();
        return { order: '3' + u, label: u };
    }
    // 숫자
    if (/[0-9]/.test(ch)) {
        return { order: '40', label: '0-9' };
    }
    return { order: '9999', label: '#' };
}
