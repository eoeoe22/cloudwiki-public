/**
 * 표준 로딩 / 빈 상태(empty state) HTML 생성 헬퍼.
 *
 * 프로젝트 전반의 로딩 표시·빈 목록 처리가 페이지마다 제각각이라(인라인 스피너,
 * 셸 토글, 단순 텍스트 등) 시각 일관성이 떨어지는 문제를 해소하기 위한 공통 유틸이다.
 * DESIGN.md "Loading & Empty States" 섹션의 규약을 코드로 구현한다.
 *
 * - 모든 함수는 **HTML 문자열**을 반환한다. 기존 호출부가 전부 `el.innerHTML = '...'`
 *   패턴이라 drop-in 교체가 가능하도록 한 것이다.
 * - 페이지 모듈(@ts-nocheck) 은 common.ts 가 노출한 `window.uiEmptyState` 등으로 호출한다.
 *   common.js 가 항상 먼저 로드되므로 안전하다.
 *
 * 이스케이프 계약(중요): `title` / `text` / `cta.label` 은 **이스케이프하지 않고 그대로**
 * 삽입한다. 호출부는 신뢰 가능한 한국어 리터럴을 넘기는 것을 기본으로 하며, 사용자
 * 입력 등 동적 문자열을 넣을 때는 호출 측에서 먼저 escapeHtml 해야 한다.
 */

export interface EmptyStateCta {
    /** 버튼 라벨 (신뢰 리터럴; 동적이면 호출부에서 이스케이프) */
    label: string;
    /** 링크 href. 지정 시 <a>, 아니면 <button> 으로 렌더 */
    href?: string;
    /** 버튼 클릭 핸들러 (HTML on* 속성 문자열, 예: 'createNewPage()') */
    onclick?: string;
    /** 버튼 앞 아이콘 클래스 (예: 'bi bi-pencil-square') */
    icon?: string;
    /** 버튼 클래스 (기본 'btn btn-wiki btn-sm') */
    btnClass?: string;
}

export interface EmptyStateOptions {
    /** 아이콘 클래스 전체 (예: 'bi bi-inbox', 'mdi mdi-inbox-outline'). 기본 'bi bi-inbox' */
    icon?: string;
    /** 굵은 제목 (필수) */
    title: string;
    /** 보조 안내문 (선택) */
    text?: string;
    /** 행동 유도 버튼 (선택) */
    cta?: EmptyStateCta;
    /** 사이드바·패널·테이블용 축소 패딩 변형 */
    compact?: boolean;
}

export interface InlineLoadingOptions {
    /** 로딩 문구. 기본 '불러오는 중...' */
    text?: string;
    /** 스피너 크기. 기본 'sm' */
    size?: 'sm' | 'md';
    /** 인라인(글자 옆) 대신 한 줄 블록으로 중앙 배치 */
    block?: boolean;
}

/**
 * 빈 상태: 아이콘 + 굵은 제목 + 회색 안내문 + 선택 CTA.
 * 반환은 단일 `<div class="empty-state">` 문자열. 테이블에 넣을 때는 호출부에서
 * `<td colspan="N">` 로 감싼다.
 */
export function emptyState(opts: EmptyStateOptions): string {
    const icon = opts.icon || 'bi bi-inbox';
    const compactClass = opts.compact ? ' empty-state-compact' : '';
    const textHtml = opts.text
        ? `<p class="empty-state-text">${opts.text}</p>`
        : '';
    let ctaHtml = '';
    if (opts.cta) {
        const c = opts.cta;
        const btnClass = c.btnClass || 'btn btn-wiki btn-sm';
        const iconHtml = c.icon ? `<i class="${c.icon}"></i> ` : '';
        const inner = `${iconHtml}${c.label}`;
        const btn = c.href
            ? `<a href="${c.href}" class="${btnClass}">${inner}</a>`
            : `<button type="button" class="${btnClass}"${c.onclick ? ` onclick="${c.onclick}"` : ''}>${inner}</button>`;
        ctaHtml = `<div class="empty-state-cta">${btn}</div>`;
    }
    return `<div class="empty-state${compactClass}">`
        + `<i class="empty-state-icon ${icon}" aria-hidden="true"></i>`
        + `<p class="empty-state-title">${opts.title}</p>`
        + textHtml
        + ctaHtml
        + `</div>`;
}

/**
 * 인라인 스피너 + 텍스트. 버튼·소형 패널·부분 갱신용.
 * 이미 테마가 적용된 부트스트랩 `.spinner-border` 를 재사용한다.
 */
export function inlineLoading(opts: InlineLoadingOptions = {}): string {
    const text = opts.text === undefined ? '불러오는 중...' : opts.text;
    const sizeClass = opts.size === 'md' ? '' : ' spinner-border-sm';
    const blockClass = opts.block ? ' loading-block' : '';
    const label = text ? `<span>${text}</span>` : '';
    return `<span class="loading-inline${blockClass}" role="status" aria-live="polite">`
        + `<span class="spinner-border${sizeClass}" aria-hidden="true"></span>`
        + label
        + `</span>`;
}

/** N 개의 shimmer 스켈레톤 라인. 폭은 마지막 줄만 60% 로 자연스럽게. */
export function skeletonLines(count = 3): string {
    let out = '';
    for (let i = 0; i < count; i++) {
        const w = i === count - 1 ? ' w-60' : '';
        out += `<div class="skeleton skeleton-line${w}"></div>`;
    }
    return out;
}

/** 목록형(최근 변경·편집 이력·검색 결과 등) 스켈레톤 행. */
export function skeletonList(rows = 5): string {
    let out = '';
    for (let i = 0; i < rows; i++) {
        out += `<div class="skeleton-list-row">`
            + `<div class="skeleton skeleton-line w-40"></div>`
            + `<div class="skeleton skeleton-line w-80"></div>`
            + `</div>`;
    }
    return `<div class="skeleton-wrap" aria-busy="true" aria-live="polite">${out}</div>`;
}

/** 카드/그리드형(블로그·미디어 갤러리 등) 스켈레톤 블록. */
export function skeletonCards(count = 3): string {
    let out = '';
    for (let i = 0; i < count; i++) {
        out += `<div class="skeleton skeleton-card"></div>`;
    }
    return `<div class="skeleton-wrap" aria-busy="true" aria-live="polite">${out}</div>`;
}

// common.ts 가 아래 헬퍼들을 window.* 로 노출한다(common.js 가 항상 먼저 로드).
// 타입검사 대상(@ts-nocheck 아님) 클라이언트 모듈에서 window.uiEmptyState 등을
// 안전하게 호출할 수 있도록 전역 Window 를 단일 소스로 augment 한다.
declare global {
    interface Window {
        uiEmptyState: (opts: EmptyStateOptions) => string;
        uiInlineLoading: (opts?: InlineLoadingOptions) => string;
        uiSkeletonLines: (count?: number) => string;
        uiSkeletonList: (rows?: number) => string;
        uiSkeletonCards: (count?: number) => string;
    }
}
