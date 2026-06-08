// 프레젠테이션(슬라이드) 뷰어.
//
// 문서별 view_mode='presentation' 인 문서를 본문 마크다운의 `---` 수평선 기준으로
// 슬라이드 단위로 분할해 표시한다. 슬라이드 본문 렌더링은 기존 window.renderWikiContent
// 를 그대로 재사용해 위키 문법·트랜스클루전·팔레트가 전부 동일하게 동작한다.
//
// 표시 모드:
//   1) 기본 — 일반 위키 레이아웃(헤더/사이드바/푸터) 안에 슬라이드 덱 카드로 인라인 렌더.
//   2) 전체화면 — 컨트롤 바의 "전체화면" 버튼을 누르면 덱 컨테이너에 requestFullscreen()
//      을 걸고 <body class="presentation-fullscreen"> 을 부여해 레이아웃 chrome 을 숨긴다.
//   3) 읽기 모드 — 호출 측(src/client/pages/index.ts)에서 `body.reading-mode` 가 활성이면
//      이 뷰어를 호출하지 않고 일반 `renderWikiContent` 경로로 폴백한다.
//
// 분할 규칙(사용자 확정):
// - `---` 만 슬라이드 분할에 사용. `***`/`___` 등 다른 hr 변형은 무시한다.
// - 라인 전체가 정확히 `---` (앞뒤 공백만 허용) 이어야 한다.
// - 코드 펜스(``` 또는 ~~~) 내부의 `---` 는 분할하지 않는다.
// - 컨테이너 블록(`:::type` … `:::`) 내부의 `---` 는 분할하지 않는다.

// window.renderWikiContent 의 전역 타입은 src/client/edit/types.ts 의 declare global 가 이미 제공.

interface PresentationOptions {
    palettes?: unknown;
    // 덱의 활성 슬라이드가 바뀔 때(컨트롤/해시/키보드) 호출되는 콜백.
    // 에디터 통합 슬라이드 편집에서 덱→에디터 동기화에 사용한다.
    onSlideChange?: (idx: number) => void;
    // 오버뷰(전체 보기) 활성 상태가 바뀔 때 호출되는 콜백. 덱 자체 컨트롤·썸네일 클릭 등
    // 에디터 외부 경로의 토글까지 외부(에디터 내비게이션 버튼)에 전파해 상태를 동기화한다.
    onOverviewChange?: (on: boolean) => void;
    // 빈(공백) 슬라이드를 분할 결과에서 제거하지 않는다. 에디터 통합 편집 시
    // 새로 추가한 빈 슬라이드가 덱에서 누락돼 인덱스가 어긋나는 것을 방지한다.
    keepEmptySlides?: boolean;
}

// `---` 분할기. 컨테이너 깊이·코드 펜스 상태를 추적해 본문 hr 만 경계로 인식.
export function splitSlides(markdown: string): string[] {
    const lines = (markdown || '').split('\n');
    const slides: string[] = [];
    let buf: string[] = [];
    let fence: string | null = null;
    let containerDepth = 0;
    for (const line of lines) {
        const trimmedStart = line.replace(/^\s+/, '');

        if (fence === null) {
            const fenceMatch = /^([`~]{3,})/.exec(trimmedStart);
            if (fenceMatch) {
                fence = fenceMatch[1][0];
                buf.push(line);
                continue;
            }
        } else {
            // 펜스 안에 있는 동안에는 컨테이너/구분선 모두 무시.
            if (new RegExp(`^${fence}{3,}\\s*$`).test(trimmedStart)) {
                fence = null;
            }
            buf.push(line);
            continue;
        }

        // 주석의 규칙대로 앞뒤 공백을 허용하기 위해 leading whitespace 가 제거된 trimmedStart 로 검사.
        if (containerDepth === 0 && /^---\s*$/.test(trimmedStart)) {
            slides.push(buf.join('\n'));
            buf = [];
            continue;
        }

        if (/^:::/.test(trimmedStart)) {
            const isClose = /^:::\s*$/.test(trimmedStart);
            if (isClose) {
                if (containerDepth > 0) containerDepth--;
            } else {
                containerDepth++;
            }
        }
        buf.push(line);
    }
    slides.push(buf.join('\n'));
    return slides;
}

let _keydownHandler: ((e: KeyboardEvent) => void) | null = null;
let _hashHandler: (() => void) | null = null;
let _fullscreenHandler: (() => void) | null = null;
let _activeDeckEl: HTMLElement | null = null;
let _activeSlideIdx = 0;
let _slideCount = 0;
// 전체 보기(그리드) 모드 — 모든 슬라이드를 작은 썸네일 그리드로 배치. 썸네일 클릭 시 해당
// 슬라이드로 이동하며 단일 뷰로 복귀한다.
let _overviewActive = false;
// 활성 슬라이드 변경 콜백(에디터 통합 편집 동기화용). renderPresentation 진입 시 세팅,
// teardownPresentation 에서 정리한다.
let _onSlideChange: ((idx: number) => void) | null = null;
// 오버뷰 활성 상태 변경 통지 콜백(외부 버튼 동기화용). renderPresentation 진입 시 세팅,
// teardownPresentation 에서 정리. setOverview 가 상태 변경 시 호출한다.
let _onOverviewChange: ((on: boolean) => void) | null = null;
// 콘텐츠 라이브 재렌더가 실제 풀스크린 element 를 분리시켜 발생하는 단 한 번의
// fullscreenchange 를 무시하기 위한 가드(시뮬레이션 풀스크린 유지). onFullscreenChange 가 소비.
let _skipFullscreenSync = false;
// 렌더 세대 토큰. renderPresentation 은 per-slide renderWikiContent 를 await 하므로,
// (에디터 프리뷰처럼) 빠른 연속 호출 시 이전 호출이 await 에서 풀려 컨트롤/핸들러를
// 최신 덱에 중복 바인딩할 수 있다(클릭 1회에 슬라이드 2칸 이동 등). 각 호출은 자신의
// 세대를 기록하고 await 직후 최신 세대와 다르면 바인딩 전에 즉시 중단한다.
let _renderGeneration = 0;

function applyActiveSlide(idx: number): void {
    if (!_activeDeckEl) return;
    const clamped = Math.max(0, Math.min(idx, _slideCount - 1));
    const changed = clamped !== _activeSlideIdx;
    _activeSlideIdx = clamped;
    _activeDeckEl.querySelectorAll<HTMLElement>('.slide').forEach((el, i) => {
        el.classList.toggle('is-active', i === clamped);
    });
    const indicator = _activeDeckEl.querySelector<HTMLElement>('.slide-deck-indicator');
    if (indicator) indicator.textContent = `${clamped + 1} / ${_slideCount}`;
    const progress = _activeDeckEl.querySelector<HTMLElement>('.slide-deck-progress-fill');
    if (progress) {
        const pct = _slideCount > 1 ? (clamped / (_slideCount - 1)) * 100 : 100;
        progress.style.width = `${pct}%`;
    }
    const expectedHash = `#/${clamped + 1}`;
    if (window.location.hash !== expectedHash) {
        // replaceState 로 히스토리 폭주 방지 (← / → 키를 자주 눌러도 뒤로가기 스택이 부풀지 않게).
        history.replaceState(history.state, '', expectedHash);
    }
    // 인덱스가 실제로 바뀐 경우에만 통지(에디터 통합 편집의 무한 루프 방지 1차 가드).
    if (changed && _onSlideChange) _onSlideChange(clamped);
}

function gotoSlide(delta: number): void {
    applyActiveSlide(_activeSlideIdx + delta);
}

function setOverview(on: boolean): void {
    _overviewActive = on;
    if (_activeDeckEl) _activeDeckEl.classList.toggle('is-overview', on);
    const btn = _activeDeckEl?.querySelector<HTMLElement>('[data-slide-act="overview"]');
    if (btn) {
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    // 덱 자체 컨트롤/썸네일 클릭 등 모든 경로의 오버뷰 변경을 외부(에디터 버튼)에 전파.
    if (_onOverviewChange) _onOverviewChange(on);
}

function toggleOverview(): void {
    setOverview(!_overviewActive);
}

function isFullscreenActive(): boolean {
    return !!document.fullscreenElement;
}

function enterFullscreen(): void {
    if (!_activeDeckEl) return;
    document.body.classList.add('presentation-fullscreen');
    _activeDeckEl.requestFullscreen?.().catch(() => {
        // 사용자 제스처 외 호출 등으로 실패하면 클래스만 유지(시뮬레이션 fullscreen).
    });
}

function exitFullscreen(): void {
    document.body.classList.remove('presentation-fullscreen');
    if (isFullscreenActive()) {
        document.exitFullscreen?.().catch(() => { /* noop */ });
    }
}

function toggleFullscreen(): void {
    if (document.body.classList.contains('presentation-fullscreen')) {
        exitFullscreen();
    } else {
        enterFullscreen();
    }
}

function onFullscreenChange(): void {
    // 콘텐츠 라이브 재렌더 중에는 덱 element 가 innerHTML 교체로 분리되며 브라우저가
    // 실제 풀스크린을 자동 종료(fullscreenchange 발생)한다. 이때 body 클래스를 벗기면
    // 시뮬레이션 풀스크린까지 사라지므로, renderPresentation 이 세운 가드로 그 1회만 무시한다.
    if (_skipFullscreenSync) {
        _skipFullscreenSync = false;
        return;
    }
    // 브라우저가 ESC/F11 등으로 풀스크린을 빠져나가면 body 클래스도 동기화.
    if (!isFullscreenActive()) {
        document.body.classList.remove('presentation-fullscreen');
    }
}

function onKeydown(e: KeyboardEvent): void {
    // 입력 위젯에 포커스가 있으면 키 가로채지 않는다.
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

    // 전체화면 모드일 때만 전역 키 내비게이션. 인라인 모드에서는 페이지 스크롤·단축키를 보호하기 위해 비활성.
    const fs = document.body.classList.contains('presentation-fullscreen');

    switch (e.key) {
        case 'ArrowRight':
        case 'PageDown':
            if (!fs) return;
            e.preventDefault();
            gotoSlide(1);
            return;
        case ' ':
            // Space 는 인라인 모드에선 페이지 스크롤을 위해 양보. 전체화면에서만 슬라이드 진행.
            if (!fs) return;
            e.preventDefault();
            gotoSlide(1);
            return;
        case 'ArrowLeft':
        case 'PageUp':
            if (!fs) return;
            e.preventDefault();
            gotoSlide(-1);
            return;
        case 'Home':
            if (!fs) return;
            e.preventDefault();
            applyActiveSlide(0);
            return;
        case 'End':
            if (!fs) return;
            e.preventDefault();
            applyActiveSlide(_slideCount - 1);
            return;
        case 'f':
        case 'F':
            // F 는 어디서든 풀스크린 토글(입력 가드는 위에서 처리).
            e.preventDefault();
            toggleFullscreen();
            return;
        case 'Escape':
            // 실제 풀스크린은 브라우저가 ESC 로 빠져나가며 fullscreenchange 핸들러가 body 클래스를 정리한다.
            // 다만 라이브 재렌더로 덱 element 가 분리돼 "시뮬레이션 풀스크린"(body 클래스만 남고 실제
            // 풀스크린 element 없음)이 된 경우엔 fullscreenchange 가 발생하지 않으므로 ESC 로 직접 종료한다.
            if (document.body.classList.contains('presentation-fullscreen') && !isFullscreenActive()) {
                e.preventDefault();
                exitFullscreen();
            }
            return;
    }
}

function onHashChange(): void {
    if (!_activeDeckEl) return;
    const m = /^#\/(\d+)$/.exec(window.location.hash);
    if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n)) applyActiveSlide(n - 1);
    }
}

export function teardownPresentation(opts: { preserveViewState?: boolean } = {}): void {
    // 세대 토큰을 올려, 아직 await 중인 in-flight renderPresentation 호출이 깨어났을 때
    // 컨트롤/전역 핸들러를 (이미 교체됐을 수 있는) 덱에 다시 바인딩하지 않고 중단하게 한다.
    // 덱 모드를 떠나며 호출되는 경로(에디터 일반/ diff 복귀, 페이지 이동 등)에서 stale
    // 덱 렌더가 핸들러를 누수시키는 것을 막는다.
    _renderGeneration++;
    if (_keydownHandler) {
        document.removeEventListener('keydown', _keydownHandler);
        _keydownHandler = null;
    }
    if (_hashHandler) {
        window.removeEventListener('hashchange', _hashHandler);
        _hashHandler = null;
    }
    // 콘텐츠 라이브 재렌더(preserveViewState)에서는 fullscreenchange 핸들러를 떼지 않고 유지한다.
    // mount.innerHTML 교체로 실제 풀스크린 element 가 분리되면 브라우저가 단 1회 fullscreenchange
    // (자동 종료)를 발생시키는데, 핸들러가 계속 붙어 있어야 그 이벤트를 _skipFullscreenSync 가드로
    // 확실히 소비(무시)할 수 있다. 핸들러를 떼면 분리 이벤트가 누락돼 가드가 해제되지 않거나
    // 타이머로 일찍 풀려 다음 입력 시 풀스크린이 의도치 않게 종료되는 레이스가 생긴다.
    // (renderPresentation 이 끝에서 동일 참조를 다시 add 하므로 dedupe 되어 중복 등록되지 않는다.)
    if (_fullscreenHandler && !opts.preserveViewState) {
        document.removeEventListener('fullscreenchange', _fullscreenHandler);
        _fullscreenHandler = null;
    }
    // preserveViewState: 같은 mount 의 콘텐츠 라이브 재렌더(에디터 프리뷰 debounce 등)에서는
    // 사용자가 연 오버뷰/풀스크린 같은 일시적 뷰 상태를 보존한다(renderPresentation 이 빌드 후 재적용).
    // 그 외(덱 모드 이탈/페이지 이동)에서는 기존대로 풀스크린/오버뷰를 정리한다.
    if (!opts.preserveViewState) {
        if (document.body.classList.contains('presentation-fullscreen')) {
            document.body.classList.remove('presentation-fullscreen');
            if (isFullscreenActive()) {
                document.exitFullscreen?.().catch(() => { /* noop */ });
            }
        }
        _overviewActive = false;
    }
    _activeDeckEl = null;
    _activeSlideIdx = 0;
    _slideCount = 0;
    _onSlideChange = null;
    _onOverviewChange = null;
}

export async function renderPresentation(
    content: string,
    slug: string,
    mountId: string,
    options: PresentationOptions = {}
): Promise<void> {
    const mount = document.getElementById(mountId);
    if (!mount) return;

    // 콘텐츠 라이브 재렌더 간 일시적 뷰 상태(오버뷰/풀스크린)를 보존해, 에디터 프리뷰의
    // debounce 재렌더가 사용자가 방금 연 그리드/풀스크린을 닫지 않게 한다. 오버뷰는 빌드 후
    // 현재 _overviewActive 로 재적용하고(아래), 풀스크린 body 클래스는 teardown(preserveViewState)
    // 이 유지하므로 별도 캡처가 필요 없다.
    // 실제 풀스크린이면 곧 덱 element 가 분리되어 단 한 번의 fullscreenchange(자동 종료)가
    // 발생한다 — onFullscreenChange 가 body 클래스를 벗기지 않도록 그 1회를 무시하게 가드를 세운다.
    // teardown(preserveViewState)이 fullscreenchange 핸들러를 유지하므로 이 분리 이벤트는 반드시
    // 핸들러에 도달해 가드를 소비(해제)한다. 타이머로 미리 풀면 분리 이벤트보다 먼저 해제돼
    // 클래스가 벗겨질 수 있어, 타이머 없이 "이벤트 소비 시 1회 해제" 방식만 사용한다.
    if (isFullscreenActive()) _skipFullscreenSync = true;

    // 이전 렌더 잔재 정리(뷰 상태는 보존).
    teardownPresentation({ preserveViewState: true });

    // 이 호출의 세대 기록 — await 이후 더 새로운 호출이 시작됐는지 판별하는 데 쓴다.
    const myGen = ++_renderGeneration;

    // 활성 슬라이드/오버뷰 변경 콜백 등록(에디터 동기화). teardown 이 이미 null 로 정리함.
    _onSlideChange = options.onSlideChange ?? null;
    _onOverviewChange = options.onOverviewChange ?? null;

    // keepEmptySlides: 에디터 통합 편집 시 빈 슬라이드도 유지해 덱 인덱스를 slideCtl 과 1:1 정렬.
    // 그 외(조회 화면)에는 공백-only 슬라이드를 제거한다.
    const rawSlides = splitSlides(content || '');
    const slides = options.keepEmptySlides ? rawSlides : rawSlides.filter((s) => s.trim() !== '');
    const effective = slides.length > 0 ? slides : [''];
    _slideCount = effective.length;

    // 직전 컨테이너(이전 덱 슬라이드 또는 익스텐션 보유 문서)의 익스텐션 정리 훅을 먼저 실행한다.
    // renderWikiContent 경로 밖에서 mount 를 직접 교체하므로, 여기서 명시적으로 정리하지 않으면
    // Chart/TradingView 인스턴스 누수·진행 중 비동기 렌더의 분리된 요소 타게팅이 발생한다.
    if (typeof window._teardownExtensions === 'function') window._teardownExtensions(mount);

    // 본문 컨테이너에 슬라이드 덱 마크업 삽입. 기본은 인라인(레이아웃 보존) — 풀스크린 진입 시
    // body.presentation-fullscreen 이 부여돼 CSS 가 fixed 풀-뷰포트로 전환한다.
    mount.innerHTML = `
        <div class="slide-deck" role="region" aria-label="프레젠테이션 슬라이드">
            <div class="slide-deck-stage">
                ${effective.map((_, i) => `<section class="slide" data-slide-index="${i}"><div class="wiki-content slide-content" id="slideContent-${i}"></div><span class="slide-overview-num" aria-hidden="true">${i + 1}</span></section>`).join('')}
            </div>
            <div class="slide-deck-progress" aria-hidden="true">
                <div class="slide-deck-progress-fill"></div>
            </div>
            <div class="slide-deck-controls" role="toolbar" aria-label="슬라이드 컨트롤">
                <button type="button" class="slide-deck-btn" data-slide-act="prev" aria-label="이전 슬라이드"><i class="bi bi-chevron-left"></i></button>
                <span class="slide-deck-indicator" aria-live="polite">1 / ${_slideCount}</span>
                <button type="button" class="slide-deck-btn" data-slide-act="next" aria-label="다음 슬라이드"><i class="bi bi-chevron-right"></i></button>
                <button type="button" class="slide-deck-btn slide-deck-btn-overview" data-slide-act="overview" title="전체 보기 (그리드)" aria-label="전체 슬라이드 그리드 보기" aria-pressed="false"><i class="bi bi-grid-3x3-gap"></i></button>
                <button type="button" class="slide-deck-btn slide-deck-btn-fullscreen" data-slide-act="fullscreen" title="전체 화면 (F)" aria-label="전체 화면 전환"><i class="bi bi-arrows-fullscreen"></i></button>
            </div>
        </div>
    `;

    _activeDeckEl = mount.querySelector<HTMLElement>('.slide-deck');

    // 각 슬라이드 본문 렌더링 — 기존 wiki 렌더러 재사용. 슬라이드 단위라 TOC/섹션편집 등은 비활성.
    if (typeof window.renderWikiContent === 'function') {
        for (let i = 0; i < effective.length; i++) {
            await window.renderWikiContent(effective[i], slug, `slideContent-${i}`, {
                showCategory: false,
                inlineTocLayout: false,
                collapsibleSections: false,
                enableSectionEdit: false,
                palettes: options.palettes ?? null,
            });
            // await 사이에 더 새로운 렌더가 시작됐다면(최신 세대가 아님) 이 호출은
            // 컨트롤/전역 핸들러를 바인딩하지 않고 즉시 중단한다 — 최신 호출이 끝까지 책임진다.
            if (myGen !== _renderGeneration) return;
        }
    }

    // renderWikiContent 미존재 등으로 위 루프가 가드를 거치지 못한 경우의 최종 방어.
    if (myGen !== _renderGeneration) return;

    // 컨트롤 바인딩.
    _activeDeckEl?.querySelectorAll<HTMLButtonElement>('[data-slide-act]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const act = btn.dataset.slideAct;
            if (act === 'prev') gotoSlide(-1);
            else if (act === 'next') gotoSlide(1);
            else if (act === 'fullscreen') toggleFullscreen();
            else if (act === 'overview') toggleOverview();
        });
    });

    _activeDeckEl?.addEventListener('click', (e) => {
        const target = e.target as HTMLElement | null;
        // 전체 보기(그리드) 모드: 컨트롤이 아닌 썸네일을 클릭하면 해당 슬라이드로 이동하고
        // 단일 뷰로 복귀한다. 썸네일 본문은 pointer-events:none(CSS)이라 내부 링크는 안 눌린다.
        if (_overviewActive) {
            if (target?.closest('.slide-deck-controls')) return;
            const slideEl = target?.closest<HTMLElement>('.slide');
            if (slideEl) {
                const idx = parseInt(slideEl.getAttribute('data-slide-index') || '0', 10);
                setOverview(false);
                applyActiveSlide(Number.isFinite(idx) ? idx : 0);
            }
            return;
        }
        // 좌/우 클릭 영역 — 전체화면 모드에서만 활성. 인라인에서는 본문 내부의 텍스트 선택/링크 클릭을 보호.
        if (!document.body.classList.contains('presentation-fullscreen')) return;
        if (target?.closest('.slide-deck-controls') || target?.closest('a, button, input, textarea, select, label, summary')) return;
        const rect = _activeDeckEl!.getBoundingClientRect();
        const x = (e as MouseEvent).clientX - rect.left;
        if (x < rect.width * 0.25) gotoSlide(-1);
        else if (x > rect.width * 0.75) gotoSlide(1);
    });

    _keydownHandler = onKeydown;
    document.addEventListener('keydown', _keydownHandler);
    _hashHandler = onHashChange;
    window.addEventListener('hashchange', _hashHandler);
    _fullscreenHandler = onFullscreenChange;
    document.addEventListener('fullscreenchange', _fullscreenHandler);

    // 초기 슬라이드: 해시 우선, 없으면 첫 슬라이드.
    const m = /^#\/(\d+)$/.exec(window.location.hash);
    const initial = m ? Math.max(0, parseInt(m[1], 10) - 1) : 0;
    applyActiveSlide(initial);

    // 오버뷰 상태를 새 덱 DOM 에 재적용한다(innerHTML 재구성으로 is-overview 클래스가 사라지므로).
    // 캡처 시점의 prevOverview 가 아니라 "현재" _overviewActive 를 적용해, 비동기 렌더 도중
    // 사용자가 (에디터 내비게이션으로) 오버뷰를 토글한 경우 그 최신 의도를 덮어쓰지 않는다.
    // (_overviewActive 는 teardown 의 preserveViewState 로 보존되고 토글이 갱신한다.)
    setOverview(_overviewActive);
    // 풀스크린 body 클래스는 <body> 에 있어 덱 innerHTML 교체와 무관하게 그대로 유지되므로
    // 별도 재적용이 불필요하다(재적용하면 렌더 도중의 사용자 종료를 되돌릴 수 있어 하지 않는다).
    // 실제 풀스크린은 element 분리로 종료되어 시뮬레이션 풀스크린(body 클래스)으로 이어진다.
}

// 외부(에디터 하단 내비게이션 바)에서 현재 활성 덱의 전체화면/전체보기를 토글하기 위한 진입점.
// 활성 덱(_activeDeckEl)이 없으면 no-op 이다.
export function presentationToggleFullscreen(): void {
    if (!_activeDeckEl) return;
    toggleFullscreen();
}
// 토글 후의 오버뷰 활성 상태를 반환한다(에디터 측 외부 버튼의 pressed/active 동기화용).
export function presentationToggleOverview(): boolean {
    if (!_activeDeckEl) return _overviewActive;
    toggleOverview();
    return _overviewActive;
}
// 현재 오버뷰 활성 여부(외부 버튼 상태 동기화용 — 덱 재렌더 후 보존된 상태 반영).
export function presentationIsOverview(): boolean {
    return _overviewActive;
}

declare global {
    interface Window {
        renderPresentation?: typeof renderPresentation;
        teardownPresentation?: typeof teardownPresentation;
        presentationToggleFullscreen?: typeof presentationToggleFullscreen;
        presentationToggleOverview?: typeof presentationToggleOverview;
        presentationIsOverview?: typeof presentationIsOverview;
    }
}

window.renderPresentation = renderPresentation;
window.teardownPresentation = teardownPresentation;
window.presentationToggleFullscreen = presentationToggleFullscreen;
window.presentationToggleOverview = presentationToggleOverview;
window.presentationIsOverview = presentationIsOverview;
