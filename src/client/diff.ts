// 위키 본문 두 버전을 비교해 raw line diff / rendered block diff 두 종류로
// 표시하는 클라이언트 유틸. 원래 public/revisions.html 의 inline classic
// script 에서 사용하던 함수들을 ESM 모듈로 옮긴 것이며, 같은 함수를 mypage 의
// MCP 편집 승인 모달에서도 재사용한다.
//
// classic 호환: 모듈 평가 시점에 window 에 같은 이름들을 매달아 두므로 기존
// revisions.html 의 raw script 가 bare reference (예: computeLineDiff(...)) 로
// 그대로 호출할 수 있다. revisions.html 자체의 raw 정의는 본 모듈로 일원화된 뒤
// 삭제했다 (CLAUDE.md "브리지 패턴" 참고).
//
// 외부 의존성:
//   - window.renderWikiContent (src/client/render.ts) — 있으면 rich diff 가 위키
//     렌더 결과를 비교한다. 없으면 marked + DOMPurify 폴백, 그것도 없으면 escape 한 <pre>.
//   - window.escapeHtml — common.ts 가 노출한 전역. 모듈 내부에서도 동일한 동작의
//     로컬 escape 를 사용해, 모듈 단독 로드 (common.js 없는 페이지) 환경에서도 안전.
// @ts-nocheck — 1차 포팅 한정. 호출자(raw script) 의 느슨한 타입을 그대로 받기 위해 적용.

const escape = (s: any): string =>
    s === null || s === undefined || s === ''
        ? ''
        : String(s)
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#039;');

// diff 보기 모드: 'rendered'(렌더링 비교, 기본) | 'raw'(텍스트 줄 단위 비교)
// localStorage 키는 revisions.html 과 동일하게 유지 — 사용자가 한 곳에서 설정한
// 기본 모드를 다른 곳(mypage)에서도 그대로 따른다.
export function getDiffViewMode(): 'rendered' | 'raw' {
    try {
        const v = localStorage.getItem('revisionDiffMode');
        return v === 'raw' ? 'raw' : 'rendered';
    } catch {
        return 'rendered';
    }
}

export function setDiffViewMode(mode: 'rendered' | 'raw'): void {
    try {
        localStorage.setItem('revisionDiffMode', mode);
    } catch {
        /* ignore */
    }
}

// ── 라인 단위 LCS diff 연산 (raw/rendered 공통) ──
// 변경된 줄과 동일한 줄을 시간순으로 나열한 ops 배열을 반환한다.
export function _lcsLineOps(oldText: string, newText: string) {
    const oldLines = (oldText || '').split('\n');
    const newLines = (newText || '').split('\n');
    const m = oldLines.length;
    const n = newLines.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldLines[i - 1] === newLines[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }
    const ops: Array<{ type: 'same' | 'add' | 'del'; text: string }> = [];
    let i = m;
    let j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
            ops.unshift({ type: 'same', text: oldLines[i - 1] });
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            ops.unshift({ type: 'add', text: newLines[j - 1] });
            j--;
        } else {
            ops.unshift({ type: 'del', text: oldLines[i - 1] });
            i--;
        }
    }
    return ops;
}

// ── 렌더링(rich) diff: GitHub 의 마크다운 rich diff 와 유사하게,
// OLD/NEW 본문을 각각 한 번씩만 위키 렌더 파이프라인(renderWikiContent)에
// 통과시킨 뒤, 결과 DOM 의 최상위 블록(자식 요소)을 LCS 로 정렬해
// 추가/삭제/유지 블록을 색상 라인으로 나열한다. 트랜스클루전·푸트노트·
// 팔레트·색 토큰·타임스탬프 등 위키 자체 문법이 그대로 적용된다.
//
// 각 그룹마다 renderWikiContent 를 호출하지 않는 이유:
//   1) renderWikiContent 는 컨테이너 ID 별로 setInterval(타이머 익스텐션)
//      을 등록하므로, 일회성 ID 를 매번 새로 만들면 detached 노드를 가진
//      orphan interval 이 누적된다. 호출 종료 시 같은 ID 로 빈 본문을 다시
//      렌더해 _initTimers 가 직전 setInterval 을 clearInterval 하도록 한다.
//   2) resolveTransclusions 는 호출마다 신규 캐시를 만들어 같은 틀을
//      반복 fetch 한다. 호출 횟수를 그룹 수(N) 가 아닌 2 회로 줄인다.
let _rdiffSeq = 0;

function _normalizeBlockKey(el: Element): string {
    // 비교용 키: 순서/카운터에 따라 변하는 동적 속성을 정규화한다.
    // 정규화 대상:
    //   - heading 섹션 앵커: id="s-1.2", 별도 anchor span
    //   - footnote: render.ts 의 processFootnotes 가 호출별 uniqueId 를
    //     섞어 id="fn-${i}-${uniqueId}" / "fn-ref-${i}-${uniqueId}" 를
    //     생성하므로, OLD/NEW 가 같은 내용이라도 id 가 달라진다. 두 prefix
    //     를 모두 정규화.
    //   - TOC: id="toc-*"
    //   - 위키 :::tabs / :::accordion (render.ts 의 _nextWikiBsId): 모듈 전역
    //     카운터로 매 호출마다 wiki-tabs-N / wiki-acc-N 이 증가하므로 OLD/NEW
    //     렌더에서 ID 가 달라 같은 내용이 false-positive 변경으로 잡힌다.
    //     id / aria-controls / aria-labelledby / data-bs-target /
    //     data-bs-parent / href 의 매칭 값을 모두 제거해 비교에서 무시.
    const DYNAMIC_ID_RE = /^(s-[\d.]+|fn-|fnref-|toc-|wiki-tabs-|wiki-acc-)/;
    const stripCrossRef = (n: Element, attr: string) => {
        const v = n.getAttribute(attr);
        if (!v) return;
        const id = v.replace(/^#/, '');
        if (DYNAMIC_ID_RE.test(id)) n.removeAttribute(attr);
    };

    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll('.wiki-section-anchor').forEach((n) => n.remove());

    // querySelectorAll 은 root 를 포함하지 않으므로 root + descendants 양쪽
    // 모두 순회해야 한다. (예: 최상위 블록이 <h2 id="s-1.2"> 인 경우)
    const all = [clone, ...Array.from(clone.querySelectorAll('*'))];
    for (const n of all) {
        const id = n.getAttribute && n.getAttribute('id');
        if (id && DYNAMIC_ID_RE.test(id)) n.removeAttribute('id');
    }
    clone.querySelectorAll('[aria-controls]').forEach((n) => stripCrossRef(n, 'aria-controls'));
    if (clone.hasAttribute && clone.hasAttribute('aria-controls')) stripCrossRef(clone, 'aria-controls');
    clone.querySelectorAll('[aria-labelledby]').forEach((n) => stripCrossRef(n, 'aria-labelledby'));
    if (clone.hasAttribute && clone.hasAttribute('aria-labelledby')) stripCrossRef(clone, 'aria-labelledby');
    clone.querySelectorAll('[data-bs-target]').forEach((n) => stripCrossRef(n, 'data-bs-target'));
    if (clone.hasAttribute && clone.hasAttribute('data-bs-target')) stripCrossRef(clone, 'data-bs-target');
    clone.querySelectorAll('[data-bs-parent]').forEach((n) => stripCrossRef(n, 'data-bs-parent'));
    if (clone.hasAttribute && clone.hasAttribute('data-bs-parent')) stripCrossRef(clone, 'data-bs-parent');
    // 푸트노트/탭/아코디언 anchor href 도 매칭 시 제거 (root 가 <a> 인 케이스 포함)
    clone.querySelectorAll('a[href^="#"]').forEach((n) => stripCrossRef(n, 'href'));
    if (clone.tagName === 'A' && (clone.getAttribute('href') || '').startsWith('#')) {
        stripCrossRef(clone, 'href');
    }

    return clone.outerHTML;
}

function _lcsBlockOps(oldKeys: string[], newKeys: string[], oldHtmls: string[], newHtmls: string[]) {
    const m = oldKeys.length;
    const n = newKeys.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldKeys[i - 1] === newKeys[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
            else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }
    const ops: Array<{ type: 'same' | 'add' | 'del'; html: string }> = [];
    let i = m;
    let j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldKeys[i - 1] === newKeys[j - 1]) {
            ops.unshift({ type: 'same', html: newHtmls[j - 1] });
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            ops.unshift({ type: 'add', html: newHtmls[j - 1] });
            j--;
        } else {
            ops.unshift({ type: 'del', html: oldHtmls[i - 1] });
            i--;
        }
    }
    return ops;
}

export async function buildRichDiffHtml(oldText: string, newText: string, slug: string): Promise<string> {
    if ((oldText || '') === (newText || '')) {
        return '<div class="diff-empty">변경된 내용이 없습니다.</div>';
    }

    const canRenderWiki = typeof (window as any).renderWikiContent === 'function';
    const canSanitize = !!((window as any).DOMPurify && typeof (window as any).DOMPurify.sanitize === 'function');

    // 호출별 unique ID — 모달 빠른 닫힘/재열림으로 두 buildRichDiffHtml 가
    // 겹쳐도 동일 id 의 div 가 DOM 에 공존하지 않도록 한다 (getElementById
    // 가 다른 호출의 staging 노드를 잘못 매칭하는 race 방지).
    const seq = ++_rdiffSeq;
    const oldId = `__rdiff_stage_old_${seq}__`;
    const newId = `__rdiff_stage_new_${seq}__`;

    const stage = document.createElement('div');
    stage.setAttribute('aria-hidden', 'true');
    stage.style.cssText = 'position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden;';
    document.body.appendChild(stage);

    const oldDiv = document.createElement('div');
    oldDiv.id = oldId;
    oldDiv.className = 'wiki-content';
    const newDiv = document.createElement('div');
    newDiv.id = newId;
    newDiv.className = 'wiki-content';
    stage.appendChild(oldDiv);
    stage.appendChild(newDiv);

    try {
        if (canRenderWiki) {
            // 위키 렌더 파이프라인을 OLD/NEW 각 1회씩만 통과 — 트랜스클루전 캐시
            // 중복과 그룹별 setInterval 누적 문제를 회피.
            //
            // 두 호출을 직렬화하는 이유: render.ts 의 _wikiExtensionData 는 모듈
            // 전역으로, resolveTransclusions 가 호출 시점에 [] 로 리셋하고 진행
            // 중 push 한다. Promise.all 로 동시에 돌리면 두 호출의 ext 데이터가
            // 인터리브되어 placeholder-index 가 어긋나 익스텐션 출력이 깨질 수
            // 있다 (스냅샷은 resolveTransclusions 완료 직후에만 안전).
            if ((oldText || '').trim()) {
                try {
                    await (window as any).renderWikiContent(oldText || '', slug, oldId);
                } catch {
                    /* noop */
                }
            }
            if ((newText || '').trim()) {
                try {
                    await (window as any).renderWikiContent(newText || '', slug, newId);
                } catch {
                    /* noop */
                }
            }

            // 익스텐션 렌더는 _processExtensions 가 setTimeout 폴링으로 늦게
            // 완료될 수 있다. 양쪽 컨테이너에 미완료 .wiki-ext 가 있으면 잠깐
            // 대기 (cap 500ms) — 익스텐션이 없는 문서는 즉시 통과해 비용 없음.
            const SETTLE_CAP_MS = 500;
            const SETTLE_POLL_MS = 50;
            const pendingExt = () =>
                oldDiv.querySelectorAll('.wiki-ext:not([data-ext-rendered="1"])').length +
                newDiv.querySelectorAll('.wiki-ext:not([data-ext-rendered="1"])').length;
            const settleStart = Date.now();
            while (pendingExt() > 0 && Date.now() - settleStart < SETTLE_CAP_MS) {
                await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
            }
        } else if (canSanitize && (window as any).marked && typeof (window as any).marked.parse === 'function') {
            try {
                oldDiv.innerHTML = (window as any).DOMPurify.sanitize((window as any).marked.parse(oldText || ''));
            } catch {
                oldDiv.innerHTML = `<pre>${escape(oldText || '')}</pre>`;
            }
            try {
                newDiv.innerHTML = (window as any).DOMPurify.sanitize((window as any).marked.parse(newText || ''));
            } catch {
                newDiv.innerHTML = `<pre>${escape(newText || '')}</pre>`;
            }
        } else {
            // DOMPurify 미정의: raw marked 출력 주입 금지 → escape 한 평문 폴백
            oldDiv.innerHTML = `<pre>${escape(oldText || '')}</pre>`;
            newDiv.innerHTML = `<pre>${escape(newText || '')}</pre>`;
        }

        const oldEls = Array.from(oldDiv.children);
        const newEls = Array.from(newDiv.children);
        const oldHtmls = oldEls.map((el) => (el as HTMLElement).outerHTML);
        const newHtmls = newEls.map((el) => (el as HTMLElement).outerHTML);
        const oldKeys = oldEls.map((el) => _normalizeBlockKey(el));
        const newKeys = newEls.map((el) => _normalizeBlockKey(el));

        const ops = _lcsBlockOps(oldKeys, newKeys, oldHtmls, newHtmls);
        if (ops.length === 0 || !ops.some((o) => o.type !== 'same')) {
            return '<div class="diff-empty">변경된 내용이 없습니다.</div>';
        }

        const parts: string[] = [];
        for (const op of ops) {
            parts.push(`<div class="rich-diff-block rich-diff-${op.type}">${op.html}</div>`);
        }
        return parts.join('');
    } finally {
        // 타이머 정리: 동일 ID 로 빈 본문을 한 번 더 렌더하면 _initTimers 가
        // 직전 setInterval 을 clearInterval 한다 (render.ts 의 _initTimers 참고).
        // unique ID 라 다음 호출에서 자동 정리되지 않으므로 명시적으로 호출.
        if (canRenderWiki) {
            try {
                await (window as any).renderWikiContent('', slug, oldId);
            } catch {
                /* noop */
            }
            try {
                await (window as any).renderWikiContent('', slug, newId);
            } catch {
                /* noop */
            }
        }
        stage.remove();
    }
}

// ── Line-by-line Diff 알고리즘 (LCS 기반, 컨텍스트 축소) ──
export function computeLineDiff(oldText: string, newText: string): string {
    const result = _lcsLineOps(oldText, newText);

    if (result.length === 0) {
        return '<div class="diff-empty">변경된 내용이 없습니다.</div>';
    }

    const hasChange = result.some((r) => r.type !== 'same');
    if (!hasChange) {
        return '<div class="diff-empty">변경된 내용이 없습니다.</div>';
    }

    // 변경된 줄 주변 CONTEXT_LINES만 표시, 나머지는 생략
    const CONTEXT = 3;
    const visible = new Set<number>();
    result.forEach((r, idx) => {
        if (r.type !== 'same') {
            for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(result.length - 1, idx + CONTEXT); k++) {
                visible.add(k);
            }
        }
    });

    let rows = '';
    let skipStart = -1;
    for (let idx = 0; idx < result.length; idx++) {
        if (visible.has(idx)) {
            if (skipStart !== -1) {
                const skipCount = idx - skipStart;
                rows += `<tr class="diff-skip"><td class="diff-prefix">⋯</td><td class="diff-line diff-skip-label">${skipCount}줄 생략됨</td></tr>`;
                skipStart = -1;
            }
            const r = result[idx];
            const cls = r.type === 'add' ? 'diff-add' : r.type === 'del' ? 'diff-del' : 'diff-same';
            const prefix = r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ';
            rows += `<tr class="${cls}"><td class="diff-prefix">${prefix}</td><td class="diff-line">${escape(r.text || '')}</td></tr>`;
        } else {
            if (skipStart === -1) skipStart = idx;
        }
    }
    if (skipStart !== -1) {
        const skipCount = result.length - skipStart;
        rows += `<tr class="diff-skip"><td class="diff-prefix">⋯</td><td class="diff-line diff-skip-label">${skipCount}줄 생략됨</td></tr>`;
    }

    return '<table class="diff-table">' + rows + '</table>';
}

// computeLineDiff 가 만든 표와 동일한 가시 영역(변경 줄 + 컨텍스트, 생략 라벨 포함)
// 을 plain text 로 복사하기 위한 헬퍼. Raw 비교 모드의 "복사하기" 버튼이 사용한다.
export function buildLineDiffText(oldText: string, newText: string): string {
    const result = _lcsLineOps(oldText, newText);
    if (result.length === 0 || !result.some((r) => r.type !== 'same')) return '';

    const CONTEXT = 3;
    const visible = new Set<number>();
    result.forEach((r, idx) => {
        if (r.type !== 'same') {
            for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(result.length - 1, idx + CONTEXT); k++) {
                visible.add(k);
            }
        }
    });

    const lines: string[] = [];
    let skipStart = -1;
    for (let idx = 0; idx < result.length; idx++) {
        if (visible.has(idx)) {
            if (skipStart !== -1) {
                lines.push(`... ${idx - skipStart}줄 생략됨`);
                skipStart = -1;
            }
            const r = result[idx];
            const prefix = r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ';
            lines.push(prefix + (r.text || ''));
        } else if (skipStart === -1) {
            skipStart = idx;
        }
    }
    if (skipStart !== -1) lines.push(`... ${result.length - skipStart}줄 생략됨`);
    return lines.join('\n');
}

// ── 두 본문에 대해 raw / rendered 토글을 가진 SweetAlert2 모달을 띄우는 헬퍼.
// mypage 의 MCP 편집 승인 모달이 이 함수를 호출하고, revisions.html 의 showDiff 와
// 동일한 사용자 경험을 제공한다. 호출자가 모달 상단/하단에 추가 UI 를 끼우고 싶을 때를
// 위해 `extraTopHtml` / 버튼 텍스트 등을 옵션으로 받는다.
export interface DiffModalOptions {
    title: string;
    oldText: string;
    newText: string;
    slug: string;
    // 확장 데이터 슬러그 (freq:* 등) 처럼 마크다운 렌더가 의미 없는 본문은 raw 만 사용.
    forceRaw?: boolean;
    width?: string;
    // 모달 본문 상단에 끼울 추가 HTML (예: 충돌 경고 / 메타 정보 / summary 입력)
    extraTopHtml?: string;
    // Swal options to merge / override (예: confirm/deny/cancel 버튼)
    swalOptions?: Record<string, unknown>;
    // 모달이 열린 직후 추가 DOM 작업이 필요한 경우 (예: summary input 이벤트 바인딩)
    onOpen?: (popup: HTMLElement) => void;
}

export function showDiffModal(opts: DiffModalOptions) {
    const Swal: any = (window as any).Swal;
    if (!Swal) throw new Error('SweetAlert2 (Swal) 가 로드되지 않았습니다.');

    const { title, oldText, newText, slug, forceRaw, width = '1100px', extraTopHtml = '', swalOptions = {}, onOpen } = opts;

    let mode: 'rendered' | 'raw' = forceRaw ? 'raw' : getDiffViewMode();
    let renderedCache: string | null = null;
    let renderToken = 0;
    let renderChain: Promise<void> = Promise.resolve();

    const toolbarHtml = (m: 'rendered' | 'raw') => {
        const toggleGroup = forceRaw
            ? ''
            : `<div class="diff-mode-toggle btn-group btn-group-sm" role="group" aria-label="diff 모드">
            <button type="button" class="btn ${m === 'rendered' ? 'btn-primary' : 'btn-outline-secondary'}" data-diff-mode="rendered">
              <i class="bi bi-eye"></i> 렌더링 비교
            </button>
            <button type="button" class="btn ${m === 'raw' ? 'btn-primary' : 'btn-outline-secondary'}" data-diff-mode="raw">
              <i class="bi bi-code"></i> Raw 비교
            </button>
          </div>`;
        const copyHidden = m !== 'raw' ? ' style="display:none;"' : '';
        const copyBtn = `<button type="button" class="btn btn-sm btn-outline-secondary diff-copy-btn" data-diff-copy${copyHidden}>
            <i class="bi bi-clipboard"></i> 복사하기
          </button>`;
        return `<div class="diff-toolbar">${toggleGroup}${copyBtn}</div>`;
    };

    const loadingHtml = '<div class="text-center text-muted py-4"><div class="spinner-border spinner-border-sm me-2"></div>렌더링 중...</div>';

    return Swal.fire({
        title,
        html: `${extraTopHtml}${toolbarHtml(mode)}<div id="diffBodyContainer">${loadingHtml}</div>`,
        width,
        showCloseButton: true,
        ...swalOptions,
        didOpen: async (popup: HTMLElement) => {
            const renderInto = (target: 'rendered' | 'raw') => {
                const token = ++renderToken;
                const body = popup.querySelector('#diffBodyContainer') as HTMLElement | null;
                if (!body) return;

                if (target === 'raw') {
                    body.innerHTML = `<div class="diff-container">${computeLineDiff(oldText, newText)}</div>`;
                    return;
                }
                if (renderedCache !== null) {
                    body.innerHTML = renderedCache;
                    return;
                }

                body.innerHTML = loadingHtml;
                renderChain = renderChain.catch(() => {}).then(async () => {
                    if (token !== renderToken) return;
                    const built = await buildRichDiffHtml(oldText, newText, slug);
                    if (token !== renderToken) return;
                    renderedCache = `<div class="rich-diff-container wiki-content">${built}</div>`;
                    const body2 = popup.querySelector('#diffBodyContainer') as HTMLElement | null;
                    if (body2) body2.innerHTML = renderedCache;
                });
            };

            const updateCopyBtnVisibility = () => {
                const copyBtn = popup.querySelector('[data-diff-copy]') as HTMLElement | null;
                if (copyBtn) copyBtn.style.display = mode === 'raw' ? '' : 'none';
            };

            popup.querySelectorAll('.diff-mode-toggle [data-diff-mode]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const next = btn.getAttribute('data-diff-mode') as 'rendered' | 'raw' | null;
                    if (!next || next === mode) return;
                    mode = next;
                    setDiffViewMode(mode);
                    popup.querySelectorAll('.diff-mode-toggle [data-diff-mode]').forEach((b) => {
                        const isActive = b.getAttribute('data-diff-mode') === mode;
                        b.classList.toggle('btn-primary', isActive);
                        b.classList.toggle('btn-outline-secondary', !isActive);
                    });
                    updateCopyBtnVisibility();
                    renderInto(mode);
                });
            });

            const copyBtn = popup.querySelector('[data-diff-copy]') as HTMLButtonElement | null;
            if (copyBtn) {
                // baseline 라벨은 첫 바인딩 시점에 한 번만 캡처한다. 클릭마다 캡처하면
                // 1.5초 피드백 윈도우 안의 재클릭이 transient 라벨을 "원본"으로 저장해
                // 버튼이 "복사됨"/"복사 실패" 에 머무는 버그가 생긴다. 같은 이유로 직전
                // 복원 타이머가 남아있으면 취소하고 새 타이머만 활성화한다.
                const originalHtml = copyBtn.innerHTML;
                let restoreTimer: ReturnType<typeof setTimeout> | null = null;
                copyBtn.addEventListener('click', async () => {
                    const text = buildLineDiffText(oldText, newText);
                    if (!text) return;
                    try {
                        await navigator.clipboard.writeText(text);
                        copyBtn.innerHTML = '<i class="bi bi-check2"></i> 복사됨';
                    } catch {
                        copyBtn.innerHTML = '<i class="bi bi-x-lg"></i> 복사 실패';
                    }
                    if (restoreTimer !== null) clearTimeout(restoreTimer);
                    restoreTimer = setTimeout(() => {
                        copyBtn.innerHTML = originalHtml;
                        restoreTimer = null;
                    }, 1500);
                });
            }

            if (onOpen) {
                try {
                    onOpen(popup);
                } catch (e) {
                    console.error('showDiffModal onOpen failed:', e);
                }
            }

            renderInto(mode);
        },
    });
}

// classic <script> 호환 — revisions.html 등이 raw script 에서 bare 식별자로 호출.
(window as any)._lcsLineOps = _lcsLineOps;
(window as any).buildRichDiffHtml = buildRichDiffHtml;
(window as any).computeLineDiff = computeLineDiff;
(window as any).buildLineDiffText = buildLineDiffText;
(window as any).getDiffViewMode = getDiffViewMode;
(window as any).setDiffViewMode = setDiffViewMode;
(window as any).showDiffModal = showDiffModal;
