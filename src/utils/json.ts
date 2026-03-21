/**
 * 객체를 JSON-직렬화 가능한 구조로 안전하게 변환합니다.
 * BigInt 값을 문자열로 변환하여 "TypeError: Do not know how to serialize a BigInt" 방지합니다.
 * @param data 직렬화할 데이터
 * @returns JSON 직렬화 가능한 데이터의 복사본
 */
export function safeJSON(data: any): any {
    return JSON.parse(JSON.stringify(data, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value
    ));
}
