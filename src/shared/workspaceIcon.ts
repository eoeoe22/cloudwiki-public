// 워크스페이스 표시 아이콘 헬퍼 (서버·클라이언트 공용, 순수 문자열).
//
// 아이콘은 범용 아이콘 피커(iconPicker.ts `openIconPicker`)가 돌려주는 class 문자열
// 형식("bi bi-folder-fill" / "mdi mdi-bullhorn")으로 저장한다. NULL/미설정/형식 위반은
// 기본 아이콘으로 폴백한다. class 속성에 그대로 들어가므로 화이트리스트 패턴으로만
// 허용해 속성 탈출(주입)을 원천 차단한다.

export const DEFAULT_WORKSPACE_ICON = 'bi bi-folder-fill';

// "bi bi-<name>" 또는 "mdi mdi-<name>" 만 허용. name 은 영소문자/숫자/하이픈.
const WORKSPACE_ICON_RE = /^(bi bi-[a-z0-9-]{1,40}|mdi mdi-[a-z0-9-]{1,40})$/;

/**
 * 저장용 정규화. 유효한 아이콘 class 문자열이면 그 값을, 아니면 null 을 반환한다
 * (null = 기본 아이콘 사용). 서버에서 워크스페이스 생성/수정 시 사용.
 */
export function normalizeWorkspaceIcon(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const t = raw.trim();
    if (!t) return null;
    return WORKSPACE_ICON_RE.test(t) ? t : null;
}

/**
 * 렌더용. 저장된 icon 이 유효하면 그 class 를, 아니면 기본 아이콘 class 를 반환한다.
 * 클라이언트가 `<i class="...">` 로 표시할 때 사용(저장값이 신뢰되더라도 방어적으로 재검증).
 */
export function workspaceIconClass(icon: string | null | undefined): string {
    return icon && WORKSPACE_ICON_RE.test(icon) ? icon : DEFAULT_WORKSPACE_ICON;
}
