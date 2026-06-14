// 편집 요약 병합 규칙(서버 단일 소스).
//
// 편집 요약은 "<사용자입력> / <자동요약>" 두 부분으로 구성된다.
//   - 사용자입력: 에디터 요약 입력칸의 값. 길이 제한(SUMMARY_USER_MAX, 255자)이 적용된다.
//   - 자동요약: 클라이언트가 백그라운드에서 본문/메타 변경을 분석해 만든 문자열. 길이 제한이 없다
//     (요청 사양 — 자동요약 길이 때문에 정상 편집이 거부되어서는 안 된다).
//
// 클라이언트는 두 부분을 분리해 전송(summary / auto_summary)하고, 병합은 서버가 수행한다.
// 이렇게 하면 편집 요청(pending_edits)은 사용자입력분만 별도로 보관할 수 있어, 승인 편집기가
// 자동요약을 사용자 입력으로 오인해 다시 합치는 중복을 피할 수 있다.

/** 사용자 입력 요약 길이 제한(자동요약분에는 적용하지 않는다). */
export const SUMMARY_USER_MAX = 255;

/**
 * 편집 요약 DB 저장 상한(오·남용 방지용). 자동요약분은 길이 제한이 없으나, 병합 결과가
 * 무한히 길어지지 않도록 이 상한에서 잘라낸다. 병합 형식상 앞쪽 사용자 입력분이 보존된다.
 */
export const SUMMARY_DB_MAX = 1000;

/** 사용자 입력 요약을 트림하고 SUMMARY_USER_MAX 로 제한한다. 빈 값이면 null. */
export function capUserSummary(userSummary: string | null | undefined): string | null {
    const trimmed = (userSummary ?? '').trim();
    if (!trimmed) return null;
    return trimmed.length > SUMMARY_USER_MAX ? trimmed.slice(0, SUMMARY_USER_MAX) : trimmed;
}

/**
 * 사용자 입력분과 자동요약분을 "<사용자입력> / <자동요약>" 으로 병합한다.
 * 사용자 입력분은 SUMMARY_USER_MAX 로, 최종 병합 결과는 SUMMARY_DB_MAX 로 제한한다.
 * 둘 다 비어 있으면 null.
 */
export function mergeEditSummary(
    userSummary: string | null | undefined,
    autoSummary: string | null | undefined,
): string | null {
    const user = capUserSummary(userSummary) ?? '';
    const auto = (autoSummary ?? '').trim();
    let merged: string;
    if (user && auto) merged = `${user} / ${auto}`;
    else merged = user || auto;
    if (!merged) return null;
    return merged.length > SUMMARY_DB_MAX ? merged.slice(0, SUMMARY_DB_MAX) : merged;
}
