// 통합 단일 슬라이드 편집 컨트롤러 (프레젠테이션 문서 전용).
//
// 워크스페이스 에디터(pages/ws-edit.ts)가 프레젠테이션(`doc_type='presentation'`) 문서를
// 편집할 때, 좌측 CodeMirror 에는 "현재 슬라이드" 마크다운만 두고 우측엔 동기화된
// `renderPresentation` 덱을 렌더한다. 덱의 이전/다음으로 넘기면 에디터 슬라이드도 함께
// 전환된다. 에디터 CM 문서는 단일 슬라이드만 보유하되, getMarkdown() 은 재구성된 전체
// 문서(`\n\n---\n\n` 조인)를 반환해 저장/충돌/프리뷰 경로는 전체 문서를 본다.
//
// 과거 전역 위키 에디터(edit/main.ts)에 인라인으로 있던 슬라이드 편집 경험을 그대로 옮긴
// 단일 소스다(프레젠테이션 모드는 워크스페이스 전용으로 이관됨). 호스트 에디터의 차이는
// 주입 의존성(SlideEditDeps)으로만 흡수한다.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { splitSlides } from '../render/render-presentation';

export interface SlideEditDeps {
    /** CodeMirror6 EditorView (dispatch / state.doc / requestMeasure / focus). */
    getView(): any;
    /** 현재 문서 슬러그(덱 렌더의 트랜스클루전/링크 베이스). */
    getSlug(): string;
    /** 덱 렌더에 넘길 팔레트 정의(없으면 null). */
    getPalettes(): unknown;
    /** 프레젠테이션 모드(체크박스 ON)인지. */
    isPresentationActive(): boolean;
    /** 프리뷰 재렌더(덱/일반 분기는 호스트가 shouldRenderDeck 으로 판정). */
    updatePreview(): void;
    /** 모바일에서 덱을 보이게 프리뷰 패널을 표시(전체보기/전체화면 진입용, 재렌더 없음). */
    revealPreview?: () => void;
    /** 레이아웃 루트 셀렉터(기본 .wiki-editor-layout). slide-edit-active 토글용. */
    layoutSelector?: string;
}

export interface SlideController {
    isActive(): boolean;
    isSuppressing(): boolean;
    /** 통합 편집 중이면 재구성된 전체 문서, 아니면 라이브 CM 텍스트. */
    getMarkdown(): string;
    /** 통합 편집 중이면 전체 문서를 재분할해 현재 슬라이드만 적재(처리됨=true). 아니면 false. */
    setMarkdown(md: string): boolean;
    reconstructFullDoc(): string;
    /** 프리뷰에 슬라이드 덱을 렌더해야 하는지(pcMode: split|edit|preview). */
    shouldRenderDeck(pcMode: string): boolean;
    /** containerId 에 슬라이드 덱을 렌더(덱→에디터 동기화 콜백 포함). */
    renderDeck(containerId: string): Promise<void>;
    refreshNav(): void;
    /** PC 보기 모드 변경 시 통합 슬라이드 편집 진입/이탈 판정. */
    syncToMode(pcMode: string): void;
    /** 프레젠테이션 체크박스 토글 시 진입/이탈 + 프리뷰 갱신. */
    onPresentationToggled(pcMode: string): void;
    /** 추가 존/내비게이션 버튼 핸들러 부착(레이아웃 주입 후 1회). */
    wireControls(): void;
}

// 슬라이드 조인 구분자. 앞뒤 빈 줄로 setext heading 오인을 막고 splitSlides 왕복을 안정화한다.
const SLIDE_JOIN = '\n\n---\n\n';

// 슬라이드 앞뒤의 빈 줄만 제거(첫 줄 들여쓰기·내부 빈 줄은 보존). 정규화의 멱등성을 보장.
function trimSlide(s: string): string {
    return (s || '').replace(/^\n+/, '').replace(/\n+$/, '');
}

// 슬라이드 배열을 정규 전체 문서로 합친다(각 슬라이드 trim + SLIDE_JOIN). 멱등.
function canonicalizeSlides(parts: string[]): string {
    return parts.map(trimSlide).join(SLIDE_JOIN);
}

export function createSlideController(deps: SlideEditDeps): SlideController {
    const w = window as any;
    const layoutSelector = deps.layoutSelector || '.wiki-editor-layout';

    // ── 통합 단일 슬라이드 편집 상태 ──
    //  - slides:  전체 문서를 `---` 로 분할한 정규 슬라이드 배열(빈 슬라이드 유지)
    //  - idx:     현재 편집 중인 슬라이드 인덱스
    //  - suppressChange: 프로그램적 에디터 스왑 중 change 핸들러를 무력화하는 가드
    //  - enterDoc/enterCanonical: 진입 시점 원본 전체 문서와 그 정규화 형태. 슬라이드 내용이
    //    진입 시점과 동일하면(구분자 공백 차이뿐) 원본을 그대로 반환해 불필요한 화이트스페이스
    //    변경·거짓 미저장 경고를 막는다.
    const state = {
        active: false,
        slides: [] as string[],
        idx: 0,
        suppressChange: false,
        enterDoc: '',
        enterCanonical: '',
    };

    function view() { return deps.getView(); }

    function reconstructFullDoc(): string {
        const v = view();
        const parts = state.slides.slice();
        parts[state.idx] = v.state.doc.toString();
        const rebuilt = canonicalizeSlides(parts);
        if (rebuilt === state.enterCanonical) return state.enterDoc;
        return rebuilt;
    }

    // 전체 문서를 재분할해 slides 를 정규화(액티브 영역에 `---` 가 들어가 늘어난 경우 반영).
    function reconcileSlidesFromEditor() {
        const parts = splitSlides(reconstructFullDoc());
        state.slides = parts.length ? parts : [''];
        state.idx = Math.max(0, Math.min(state.idx, state.slides.length - 1));
    }

    // change 핸들러를 무력화한 채 CM 문서를 통째로 교체(프로그램적 슬라이드 스왑).
    function setEditorDocSuppressed(text: string) {
        const v = view();
        state.suppressChange = true;
        try {
            v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
        } finally {
            state.suppressChange = false;
        }
        v.requestMeasure?.();
    }

    function loadActiveSlideIntoEditor() {
        setEditorDocSuppressed(trimSlide(state.slides[state.idx] ?? ''));
    }

    function syncHashToActive() {
        const expected = `#/${state.idx + 1}`;
        if (window.location.hash !== expected) history.replaceState(history.state, '', expected);
    }

    function toggleSlideAddZones(show: boolean) {
        const top = document.getElementById('slideAddZoneTop');
        const bottom = document.getElementById('slideAddZoneBottom');
        if (top) (top as HTMLElement).hidden = !show;
        if (bottom) (bottom as HTMLElement).hidden = !show;
        const nav = document.getElementById('slideEditNav');
        if (nav) (nav as HTMLElement).hidden = !show;
        const layoutEl = document.querySelector(layoutSelector);
        if (layoutEl) layoutEl.classList.toggle('slide-edit-active', !!show);
        if (show) refreshNav();
    }

    function enterSlideEditing() {
        if (state.active) return;
        const full = view().state.doc.toString();
        const parts = splitSlides(full);
        state.slides = parts.length ? parts : [''];
        state.enterDoc = full;
        state.enterCanonical = canonicalizeSlides(state.slides);
        const m = /^#\/(\d+)$/.exec(window.location.hash);
        state.idx = m ? Math.max(0, Math.min(parseInt(m[1], 10) - 1, state.slides.length - 1)) : 0;
        state.active = true;
        loadActiveSlideIntoEditor();
        toggleSlideAddZones(true);
    }

    function leaveSlideEditing() {
        if (!state.active) return;
        const full = reconstructFullDoc();
        state.active = false;
        setEditorDocSuppressed(full);
        toggleSlideAddZones(false);
    }

    function onDeckSlideChanged(deckIdx: number) {
        if (!state.active) return;
        if (deckIdx === state.idx) return; // 같은 슬라이드 → no-op(편집 중 재렌더 루프 차단)
        reconcileSlidesFromEditor();
        state.idx = Math.max(0, Math.min(deckIdx, state.slides.length - 1));
        loadActiveSlideIntoEditor();
        refreshNav();
    }

    function insertSlide(where: 'before' | 'after') {
        if (!state.active) return;
        reconcileSlidesFromEditor();
        const at = where === 'before' ? state.idx : state.idx + 1;
        state.slides.splice(at, 0, '');
        state.idx = at;
        loadActiveSlideIntoEditor();
        syncHashToActive();
        deps.updatePreview();
        refreshNav();
        view().focus?.();
    }

    // ── 에디터 하단 슬라이드 내비게이션 바 ──
    function navEl() { return document.getElementById('slideEditNav'); }
    function overviewBtn() { return navEl()?.querySelector('[data-slide-nav="overview"]') as HTMLElement | null; }

    function syncOverviewBtn() {
        const btn = overviewBtn();
        if (!btn) return;
        const on = !!w.presentationIsOverview?.();
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    function refreshNav() {
        const nav = navEl();
        if (!nav || (nav as HTMLElement).hidden) return;
        const indicator = document.getElementById('slideEditNavIndicator');
        const prevBtn = nav.querySelector('[data-slide-nav="prev"]') as HTMLButtonElement | null;
        const nextBtn = nav.querySelector('[data-slide-nav="next"]') as HTMLButtonElement | null;
        const total = state.active ? Math.max(1, splitSlides(reconstructFullDoc()).length) : 1;
        const cur = Math.min(state.idx, total - 1);
        if (indicator) indicator.textContent = `${cur + 1} / ${total}`;
        if (prevBtn) prevBtn.disabled = cur <= 0;
        if (nextBtn) nextBtn.disabled = cur >= total - 1;
        syncOverviewBtn();
    }

    function gotoEditorSlide(delta: number) {
        if (!state.active) return;
        reconcileSlidesFromEditor();
        const target = Math.max(0, Math.min(state.idx + delta, state.slides.length - 1));
        if (target === state.idx) { refreshNav(); return; }
        state.idx = target;
        loadActiveSlideIntoEditor();
        syncHashToActive();
        deps.updatePreview();
        refreshNav();
        view().focus?.();
    }

    // 전체보기/전체화면은 덱(render-presentation)에 위임. 모바일에서는 덱이 보이도록 프리뷰 패널 표시.
    function runDeckAction(act: string) {
        if (window.innerWidth <= 768) deps.revealPreview?.();
        if (act === 'overview') {
            w.presentationToggleOverview?.();
            syncOverviewBtn();
        } else if (act === 'fullscreen') {
            w.presentationToggleFullscreen?.();
        }
    }

    function wireControls() {
        document.getElementById('slideAddZoneTop')?.addEventListener('click', () => insertSlide('before'));
        document.getElementById('slideAddZoneBottom')?.addEventListener('click', () => insertSlide('after'));
        navEl()?.querySelectorAll('[data-slide-nav]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const act = (btn as HTMLElement).dataset.slideNav;
                if (act === 'prev') gotoEditorSlide(-1);
                else if (act === 'next') gotoEditorSlide(1);
                else if (act) runDeckAction(act);
            });
        });
    }

    function shouldRenderDeck(pcMode: string): boolean {
        if (!deps.isPresentationActive()) return false;
        if (pcMode === 'split') return state.active;
        return pcMode === 'preview';
    }

    async function renderDeck(containerId: string) {
        const el = document.getElementById(containerId);
        if (!el || typeof w.renderPresentation !== 'function') return;
        el.classList.remove('preview-diff-text', 'preview-diff-rendered', 'wrap-mode', 'wiki-content');
        el.classList.add('preview-slide-deck');
        await w.renderPresentation(getMarkdown(), deps.getSlug() || '', containerId, {
            palettes: deps.getPalettes(),
            // 통합 편집 중에는 빈 슬라이드도 유지해 덱 인덱스를 slides 와 1:1 정렬한다.
            keepEmptySlides: state.active,
            onSlideChange: (i: number) => onDeckSlideChanged(i),
            onOverviewChange: () => refreshNav(),
        });
        refreshNav();
    }

    function getMarkdown(): string {
        return state.active ? reconstructFullDoc() : view().state.doc.toString();
    }

    function setMarkdown(md: string): boolean {
        if (!state.active) return false;
        const parts = splitSlides(md || '');
        state.slides = parts.length ? parts : [''];
        state.enterDoc = md || '';
        state.enterCanonical = canonicalizeSlides(state.slides);
        state.idx = Math.max(0, Math.min(state.idx, state.slides.length - 1));
        loadActiveSlideIntoEditor();
        syncHashToActive();
        deps.updatePreview();
        return true;
    }

    function syncToMode(pcMode: string) {
        const want = deps.isPresentationActive() && pcMode === 'split';
        if (want && !state.active) enterSlideEditing();
        else if (!want && state.active) leaveSlideEditing();
    }

    function onPresentationToggled(pcMode: string) {
        if (pcMode === 'split') {
            if (deps.isPresentationActive()) {
                if (!state.active) enterSlideEditing();
            } else if (state.active) {
                leaveSlideEditing();
            }
        }
        if (pcMode !== 'edit') deps.updatePreview();
    }

    return {
        isActive: () => state.active,
        isSuppressing: () => state.suppressChange,
        getMarkdown,
        setMarkdown,
        reconstructFullDoc,
        shouldRenderDeck,
        renderDeck,
        refreshNav,
        syncToMode,
        onPresentationToggled,
        wireControls,
    };
}
