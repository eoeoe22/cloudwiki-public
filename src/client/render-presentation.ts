// 프레젠테이션(슬라이드) 뷰어.
//
// 문서별 layout_mode='presentation' 인 문서를 본문 마크다운의 `---` 수평선 기준으로
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
// 활성 슬라이드 변경 콜백(에디터 통합 편집 동기화용). renderPresentation 진입 시 세팅,
// teardownPresentation 에서 정리한다.
let _onSlideChange: ((idx: number) => void) | null = null;
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
            // 브라우저가 ESC 로 풀스크린을 풀면 fullscreenchange 핸들러가 body 클래스를 정리.
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

export function teardownPresentation(): void {
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
    if (_fullscreenHandler) {
        document.removeEventListener('fullscreenchange', _fullscreenHandler);
        _fullscreenHandler = null;
    }
    // 풀스크린이 켜진 상태로 떠나는 경우 정리.
    if (document.body.classList.contains('presentation-fullscreen')) {
        document.body.classList.remove('presentation-fullscreen');
        if (isFullscreenActive()) {
            document.exitFullscreen?.().catch(() => { /* noop */ });
        }
    }
    _activeDeckEl = null;
    _activeSlideIdx = 0;
    _slideCount = 0;
    _onSlideChange = null;
}

export async function renderPresentation(
    content: string,
    slug: string,
    mountId: string,
    options: PresentationOptions = {}
): Promise<void> {
    const mount = document.getElementById(mountId);
    if (!mount) return;

    // 이전 렌더 잔재 정리.
    teardownPresentation();

    // 이 호출의 세대 기록 — await 이후 더 새로운 호출이 시작됐는지 판별하는 데 쓴다.
    const myGen = ++_renderGeneration;

    // 활성 슬라이드 변경 콜백 등록(에디터 통합 편집 동기화). teardown 이 이미 null 로 정리함.
    _onSlideChange = options.onSlideChange ?? null;

    // keepEmptySlides: 에디터 통합 편집 시 빈 슬라이드도 유지해 덱 인덱스를 slideCtl 과 1:1 정렬.
    // 그 외(조회 화면)에는 공백-only 슬라이드를 제거한다.
    const rawSlides = splitSlides(content || '');
    const slides = options.keepEmptySlides ? rawSlides : rawSlides.filter((s) => s.trim() !== '');
    const effective = slides.length > 0 ? slides : [''];
    _slideCount = effective.length;

    // 본문 컨테이너에 슬라이드 덱 마크업 삽입. 기본은 인라인(레이아웃 보존) — 풀스크린 진입 시
    // body.presentation-fullscreen 이 부여돼 CSS 가 fixed 풀-뷰포트로 전환한다.
    mount.innerHTML = `
        <div class="slide-deck" role="region" aria-label="프레젠테이션 슬라이드">
            <div class="slide-deck-stage">
                ${effective.map((_, i) => `<section class="slide" data-slide-index="${i}"><div class="wiki-content slide-content" id="slideContent-${i}"></div></section>`).join('')}
            </div>
            <div class="slide-deck-progress" aria-hidden="true">
                <div class="slide-deck-progress-fill"></div>
            </div>
            <div class="slide-deck-controls" role="toolbar" aria-label="슬라이드 컨트롤">
                <button type="button" class="slide-deck-btn" data-slide-act="prev" aria-label="이전 슬라이드"><i class="bi bi-chevron-left"></i></button>
                <span class="slide-deck-indicator" aria-live="polite">1 / ${_slideCount}</span>
                <button type="button" class="slide-deck-btn" data-slide-act="next" aria-label="다음 슬라이드"><i class="bi bi-chevron-right"></i></button>
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
        });
    });

    // 좌/우 클릭 영역 — 전체화면 모드에서만 활성. 인라인에서는 본문 내부의 텍스트 선택/링크 클릭을 보호.
    _activeDeckEl?.addEventListener('click', (e) => {
        if (!document.body.classList.contains('presentation-fullscreen')) return;
        const target = e.target as HTMLElement | null;
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
}

declare global {
    interface Window {
        renderPresentation?: typeof renderPresentation;
        teardownPresentation?: typeof teardownPresentation;
    }
}

window.renderPresentation = renderPresentation;
window.teardownPresentation = teardownPresentation;
