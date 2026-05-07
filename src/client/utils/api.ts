/**
 * 타입 안전한 fetch 헬퍼.
 *
 * 응답 본문을 호출자가 지정한 제너릭 타입으로 그대로 반환한다.
 * 서버가 `c.json<DTO>(...)` 로 명시한 응답을, 클라이언트는 `apiGet<DTO>(...)`
 * 로 받아 한 곳에서 정의된 타입을 양쪽이 공유한다.
 *
 * 비고:
 *   - 인증 쿠키 자동 포함: same-origin 자격 증명 사용.
 *   - 에러 응답(`!res.ok`)은 일반 Error 로 throw — 호출자가 try/catch.
 *     상세 ApiError 클래스는 실제 사용처가 늘어날 때 도입한다.
 */
export async function apiGet<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path, { credentials: 'same-origin', ...init });
    if (!res.ok) {
        throw new Error(`API ${res.status} ${res.statusText} ${path}`);
    }
    return res.json() as Promise<T>;
}
