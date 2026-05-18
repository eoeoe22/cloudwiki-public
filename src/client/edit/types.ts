/**
 * 에디터(public/edit.html / public/blog-edit.html) 도메인의 src/client/edit/*
 * 모듈들이 공유하는 타입과 전역(window) 프로퍼티 선언.
 *
 * - 여러 모듈이 같은 window 프로퍼티를 다른 shape 으로 선언하면 TypeScript interface
 *   merge 가 충돌하므로 모든 공유 자산은 이 파일이 단일 소스로 가진다.
 * - 모듈 자기 고유의 브리지(예: refreshAutoSummary) 만 해당 모듈에서 자체 declare
 *   global 한다.
 */

import '../utils/swal';

// ─────────────────────────────────────────────────────────────────────────────
// 도메인 인터페이스
// ─────────────────────────────────────────────────────────────────────────────

/**
 * render.js 의 _extractMarkdownSectionRanges 가 반환하는 섹션 엔트리.
 * edit-utils.js 의 sectionRange 상태도 동일한 shape 을 재사용한다.
 */
export interface SectionRange {
    /** 헤딩 라인의 0-based 인덱스 */
    lineIdx: number;
    /** 섹션 종료 라인 (exclusive, 끝 빈 줄 제거 반영) */
    endLine: number;
    /** 헤딩 레벨 (1-6) */
    level: number;
    /** 마크다운 접두사를 제거한 헤딩 텍스트 */
    headingText: string;
    /** 이 헤딩이 transclusion 으로 주입된 것인지 여부 */
    transcluded: boolean;
}

/** edit.js 의 editor 심(shim) 이 반환하는 selection — [[fromLine, fromCol], [toLine, toCol]] (1-based) */
export type CMSelection = [[number, number], [number, number]];

/** CodeMirror6 기반 에디터 래퍼 인터페이스 (edit.js 의 editor = ... 가 만드는 객체) */
export interface CMEditor {
    getMarkdown(): string;
    setMarkdown(text: string): void;
    /** 본문 삽입 (현재 selection 위치에 + 커서 끝 이동) */
    insertText?(text: string): void;
    /** 현재 selection 반환 (1-based 라인/컬럼) — raw textarea fallback 모드에서는 미정의 */
    getSelection?(): CMSelection | null;
    /** selection 설정 (1-based 라인/컬럼) */
    setSelection?(from: [number, number], to: [number, number]): void;
    /** 에디터에 포커스 */
    focus?(): void;
    /** 이벤트 등록 (`change` / `blur` 등) */
    on?(event: string, callback: () => void): void;
    /** 프리뷰 스타일 변경 (CM6 스플릿 뷰에선 no-op) */
    changePreviewStyle?(style: string): void;
    /** 커서 위치 좌표 (CM6 모드에서만 정의) */
    getCursorCoords?(): { left: number; top: number; bottom: number; right: number } | null;
}

/** CodeMirror6 EditorView 의 일부 — 좌표 계산과 selection 접근에 사용 */
export interface CMView {
    coordsAtPos(pos: number): { left: number; bottom: number; top: number; right: number } | null;
    state: {
        selection: { main: { head: number; from?: number; to?: number } };
        doc: { length: number };
    };
    dispatch(spec: {
        changes?: { from: number; to?: number; insert?: string };
        selection?: { anchor: number; head?: number };
    }): void;
    focus(): void;
}

/** 페이지 메타 (originalPageMeta 상태 — 대체 제목 / 카테고리 / 리다이렉트 / 잠금 변경 비교용) */
export interface PageMeta {
    /** 대체 제목 (display title). null/빈 문자열은 "미설정" 으로 동일 취급한다. */
    title?: string | null;
    category?: string | null;
    redirect_to?: string | null;
    is_locked?: number | boolean | null;
    is_private?: number | boolean | null;
}

/** localStorage 에 저장되는 초안 페이로드 */
export interface DraftPayload {
    content: string;
    version: number | string | null;
    base: string | null;
    savedAt: number | null;
    /** 섹션 편집 모드에서만 기록 */
    sectionIndex?: number;
    sectionHeading?: string;
}

/** common.js 의 mountMediaTagInput 가 반환하는 위젯 핸들 */
export interface MediaTagWidget {
    getTags(): string[];
    flush(): void;
    setOnChange(fn: () => void): void;
    destroy(): void;
}

/** common.js 의 mountMediaTagInput 옵션 */
export interface MediaTagInputOptions {
    container: HTMLElement;
    input: HTMLInputElement;
    initial?: string[];
}

/** Bootstrap 5 Modal 인스턴스 (CDN 글로벌 window.bootstrap.Modal) */
export interface BootstrapModalInstance {
    show(): void;
    hide(): void;
}

/** jsdiff (CDN 글로벌 window.Diff) — 사용 메서드만 좁게 정의 */
export interface JsDiffPart {
    value: string;
    added?: boolean;
    removed?: boolean;
}

export interface JsDiffPatchHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
}

export interface JsDiffPatch {
    hunks: JsDiffPatchHunk[];
}

export interface JsDiffApi {
    diffLines(oldStr: string, newStr: string): JsDiffPart[];
    structuredPatch(
        oldFileName: string,
        newFileName: string,
        oldStr: string,
        newStr: string,
        oldHeader: string,
        newHeader: string,
        options?: { context?: number },
    ): JsDiffPatch;
}

/** 충돌 해결 UI(편집 충돌 모달) 가 마운트하는 textarea 래퍼 */
export interface ConflictEditor {
    getMarkdown(): string;
    setMarkdown(md: string): void;
    _textarea: HTMLTextAreaElement;
}

/** 충돌 해결 UI 의 서버 본문 미리보기 래퍼 */
export interface ServerViewer {
    setMarkdown(md: string): void;
}

/** common.js 의 appConfig — 일부 필드만 명시. 신규 필드는 자유롭게 read 가능. */
export interface AppConfig {
    wikiName?: string;
    enableConcurrentEditDetection?: boolean;
    selectedIconsOnly?: boolean;
    palettes?: Record<string, PaletteDefinition>;
    announcements?: Array<{
        id: number;
        title: string;
        announcedTime: number;
        url: string | null;
        icon: string | null;
        postId: number | null;
    }>;
    [key: string]: unknown;
}

/** 팔레트 한 항목의 light/dark 변형 */
export interface PaletteVariant {
    bg?: string;
    color?: string;
}

/** render.js 의 WIKI_HARDCODED_PALETTES 와 appConfig.palettes 의 단일 엔트리 */
export interface PaletteDefinition {
    light?: PaletteVariant;
    dark?: PaletteVariant;
}

/** edit-autocomplete 가 합성해 반환하는 팔레트 정보 (edit-modals 도 사용) */
export interface PaletteInfo {
    name: string;
    source: 'preset' | 'custom' | 'override';
    variant: PaletteVariant;
}

/** 동시 편집 감지 응답: /api/w/:slug/editors */
export interface ConcurrentEditor {
    name: string;
    picture?: string | null;
}

export interface ConcurrentEditorsResponse {
    editors?: ConcurrentEditor[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Window 증강 — 외부 글로벌 + 에디터 상태 + 외부 함수 의존성
// ─────────────────────────────────────────────────────────────────────────────

declare global {
    interface Window {
        // ── 외부(다른 raw script) 가 정의한 글로벌 ──
        /** render.js 의 헤딩/섹션 범위 추출기 (function 선언이라 자동 window 노출) */
        _extractMarkdownSectionRanges?: (text: string) => SectionRange[];
        /** edit/main.ts 가 만든 CodeMirror6 EditorView (좌표/selection 접근용) */
        _cmView?: CMView;
        /** edit/main.ts 가 노출하는 CodeMirror6 view 모듈 (edit.html 인라인 TOC 가 사용) */
        CodeMirrorView?: unknown;
        /** edit/main.ts 의 함수: 미리보기 영역 끝으로 스크롤 */
        scrollToBottom?: () => void;
        /** edit-conflict.js 의 함수: 동시 편집 충돌 해결 모달 표시 */
        showConflictModal?: (data: { current_version: number | string | null; content: string }) => void;
        /** edit/autocomplete.ts 가 초기화하는 카테고리 태그 배열 — edit.js (raw) 가 read/write */
        categoryTags?: string[];
        /** common.js 의 함수: 미디어 태그 입력 위젯을 컨테이너에 마운트 */
        mountMediaTagInput?: (opts: MediaTagInputOptions) => MediaTagWidget;
        /** CDN/외부 라이브러리 글로벌 — Swal 은 src/client/utils/swal.ts 가 별도 declare */
        currentUser?: {
            name?: string;
            picture?: string | null;
            role?: string;
        };
        marked?: unknown;
        DOMPurify?: unknown;
        /** Cloudflare Turnstile CDN 글로벌 (edit/main.ts 만 사용) */
        turnstile?: {
            render(el: HTMLElement, opts: Record<string, unknown>): string;
            reset(id: string): void;
            remove(id: string): void;
        };
        /** common.js 가 정의 / 호출하는 함수들 */
        loadConfig?: () => Promise<unknown> | void;
        getMergedWikiPalettes?: () => Record<string, PaletteDefinition>;
        /** render.js 가 정의 (function 선언으로 자동 window 노출) */
        resolveTransclusions?: (content: string, slug: string) => Promise<string>;
        /** edit/summary.ts 가 노출 */
        refreshAutoSummary?: () => void;
        /**
         * edit/main.ts 의 scroll sync 캐시 무효화 / 레이아웃 관찰 헬퍼.
         * render.js 등 외부 스크립트가 프리뷰 재렌더 시 호출.
         */
        _invalidateScrollSyncGuides?: () => void;
        _observePreviewLayoutShifts?: () => void;
        /** edit.html 의 인라인 floating TOC 핸들러 */
        toggleEditorFloatingToc?: () => void;
        /**
         * 위키 문법 자동완성·인라인 표 툴바 활성화 플래그.
         * edit/main.ts 가 localStorage(editor_syntax_autocomplete) 기준으로 초기화하고
         * 설정 패널 체크박스가 토글한다. autocomplete.ts / table-toolbar.ts 가 매
         * 트리거마다 lazy 하게 읽어 비활성 시 동작을 건너뛴다.
         */
        wikiSyntaxAutocompleteEnabled?: boolean;
        // ── 다음 글로벌은 각자의 ESM 모듈이 단독 declare 하므로 여기서 다시 선언하지 않는다 ──
        // showColorAutocomplete / showPaletteAutocomplete / hideAutocomplete /
        // hideIconAutocomplete / hideColorAutocomplete / paletteAc / renderCategoryTags
        // → src/client/edit/autocomplete.ts
        // openExistingImageSearch / handleImageUpload → src/client/edit/image.ts
        // checkConcurrentEditors / startEditingHeartbeat → src/client/edit/conflict.ts
        // updateEditorTextCounter* / findSectionRange / computeSectionNumber /
        // mergeSectionIntoFull / getIsDarkMode / checkDraft / checkSectionDrafts /
        // purgeLegacyAutosaveKeys → src/client/edit/utils.ts
        // openSelectedIconsPicker / openIconPicker / openCardInsertModal /
        // openPaletteColorModal / openBadgeInsertModal / openGoogleMapsEmbedModal /
        // openTemplateModal / openSubdocInsertModal / openTimestampInsertModal /
        // setupTableInsertPopover / setupSpecialCharPicker → src/client/edit/modals.ts
        /** Bootstrap 5 CDN 글로벌 (Modal 만 사용) */
        bootstrap?: {
            Modal: {
                new (el: HTMLElement | string): BootstrapModalInstance;
                getOrCreateInstance(el: HTMLElement | string): BootstrapModalInstance;
            };
        };
        /** jsdiff CDN 글로벌 (edit.html 만 로드 — blog-edit.html 에는 없음) */
        Diff?: JsDiffApi;
        /** common.js 의 전역 설정 */
        appConfig?: AppConfig;
        /** render.js 의 위키 본문 렌더 함수 */
        renderWikiContent?: (
            content: string,
            slug: string | null | undefined,
            containerId: string,
            options?: Record<string, unknown>,
        ) => Promise<void> | void;
        /** edit.js 의 var 글로벌 — SELECTED_ICONS_ONLY 환경변수 반영 */
        selectedIconsOnly?: boolean;
        /** render.js 의 하드코딩 팔레트 프리셋 */
        WIKI_HARDCODED_PALETTES?: Record<string, PaletteDefinition>;
        /** render.js 의 internal helpers (typeof 가드로 호출됨) */
        _findParamRefs?: (text: string) => Array<{ raw: string }>;
        _isExtensionCall?: (name: string) => boolean;
        _isSafeCssColor?: (value: string) => boolean;
        /** edit/modals.ts 가 노출하는 아이콘 목록 로더 (지연 로딩) */
        loadBiIcons?: () => Promise<string[]>;
        loadMdiIcons?: () => Promise<string[]>;
        loadSelectedIcons?: () => Promise<string[]>;
        filterIcons?: (iconList: string[], query: string) => string[];
        /** edit/modals.ts 가 관리하는 아이콘 피커 크로스-스크립트 상태 */
        pendingIconInsertion?: string | null;
        iconPickerSavedSelection?: CMSelection | null;
        /** render.js 의 인라인 토큰 처리 헬퍼 (typeof 가드로 호출됨) */
        _processTimestampsInHtml?: (token: string) => string;
        _processInlineLayoutTokens?: (token: string) => string;

        // ── 에디터 상태 (src/client/edit/utils.ts 모듈이 초기화 + 다른 raw script 가 read/write) ──
        slug?: string | null;
        pageVersion?: number | string | null;
        DRAFT_KEY?: string;
        originalContent?: string;
        editor?: CMEditor | null;
        conflictEditor?: ConflictEditor | null;
        serverViewMode?: string;
        serverViewer?: ServerViewer | null;
        cachedDiffData?: unknown;
        diffViewMode?: string;
        pageLeft?: boolean;
        isExtensionData?: boolean;
        sectionMode?: boolean;
        sectionIndex?: number;
        sectionHeadingParam?: string;
        fullOriginalContent?: string;
        sectionRange?: SectionRange | null;
        originalPageMeta?: PageMeta | null;
        /**
         * checkDraft 의 section→full-edit promotion 시 원래 section 초안 키를
         * 보관. savePage 성공 경로에서 함께 정리해 다음 페이지 진입 때 stale
         * 초안이 재프롬프트되지 않도록 한다.
         */
        promotedFromDraftKey?: string | null;
        /**
         * 섹션 편집 모드에서 "하위 문서로 분리" 가 성공한 직후 기록되는 정보.
         * summary.ts 가 자동 편집 요약 prefix 를 "분리" 형태로 덮어쓰는 데 사용한다.
         * - originalHeading: 분리 시점의 섹션 헤딩 텍스트
         * - newTitle: 새로 생성된 하위 문서 슬러그
         */
        splitSubdocInfo?: { originalHeading: string; newTitle: string } | null;
    }
}

export {};
