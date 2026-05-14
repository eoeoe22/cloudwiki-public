/**
 * 에디터 프리뷰 상태 보존 모듈.
 *
 * `updateCustomPreview()` 가 매 키 입력마다 `window.renderWikiContent` 를 호출하면
 * `containerEl.innerHTML = html` 로 DOM 이 통째로 교체되어 다음 인터랙티브 상태가
 * 사라진다:
 *   - <details class="wiki-fold"> 의 open
 *   - .wiki-section 의 .wiki-section-collapsed
 *   - .accordion-item 의 .accordion-collapse.show
 *   - .wiki-tabs 그룹 내 활성 탭(.nav-link.active / .tab-pane.active)
 *   - 외부 임베드 iframe (YouTube/Spotify/Maps/Nico) — 매 렌더마다 새 노드가
 *     생성되어 외부 서버에 재요청, rate limit 우려.
 *
 * 본 모듈은 render 호출 직전 `snapshotPreviewState()` 로 위 상태와 iframe 노드들을
 * 수집하고, render 호출 직후 `restorePreviewState()` 로 복원한다.
 *
 * - 인터랙티브 노드는 `data-state-key` 속성으로 매 렌더에서 동일한 식별자를 갖는다
 *   (render.ts 의 `_makeStateKey()` 가 콘텐츠 텍스트 + 중복 ordinal 로 생성).
 * - iframe 은 src 가 일치하면 새 노드 대신 캐시된 노드를 in-place 치환한다.
 *   캐시된 iframe 은 detach 되면 browsing context 가 폐기될 수 있으므로,
 *   캡처 즉시 document.body 의 숨겨진 parking 컨테이너로 이동시켜 같은 document
 *   안에 머무르도록 한다.
 */

interface NodeState {
    open?: boolean;
    collapsed?: boolean;
    show?: boolean;
    active?: boolean;
}

export interface PreviewStateSnapshot {
    states: Record<string, NodeState>;
    iframes: Map<string, HTMLIFrameElement>;
    // snapshot 직후 container 의 마지막 자식으로 삽입하는 hidden sentinel.
    // renderWikiContent 가 `containerEl.innerHTML = html` 단계를 통과하면 함께
    // 제거되고, 도달 전에 catch 로 종료하면 그대로 남아 렌더 실패를 감지할 수
    // 있다. (renderWikiContent 가 에러를 throw 하지 않고 swallow 하므로 호출처
    // 의 try/catch 만으로는 성공/실패 구분 불가.)
    sentinel: HTMLElement | null;
}

let _parking: HTMLDivElement | null = null;

function getParkingNode(): HTMLDivElement {
    if (_parking && _parking.isConnected) return _parking;
    const div = document.createElement('div');
    div.id = '__wiki_preview_iframe_parking';
    div.setAttribute('aria-hidden', 'true');
    // visibility:hidden / display:none 은 iframe 의 로딩 동작에 영향을 주므로
    // off-screen 으로만 격리. document 트리 안에 머물러야 browsing context 유지.
    div.style.cssText = [
        'position:absolute',
        'left:-99999px',
        'top:-99999px',
        'width:0',
        'height:0',
        'overflow:hidden',
        'pointer-events:none',
    ].join(';');
    document.body.appendChild(div);
    _parking = div;
    return div;
}

export function snapshotPreviewState(container: HTMLElement): PreviewStateSnapshot {
    const states: Record<string, NodeState> = Object.create(null);
    const iframes = new Map<string, HTMLIFrameElement>();

    container.querySelectorAll<HTMLElement>('[data-state-key]').forEach((el) => {
        const key = el.getAttribute('data-state-key');
        if (!key) return;
        if (el instanceof HTMLDetailsElement) {
            states[key] = { open: el.open };
        } else if (el.classList.contains('wiki-section')) {
            states[key] = { collapsed: el.classList.contains('wiki-section-collapsed') };
        } else if (el.classList.contains('accordion-item')) {
            const collapse = el.querySelector(':scope > .accordion-collapse');
            states[key] = { show: !!(collapse && collapse.classList.contains('show')) };
        } else if (el.classList.contains('nav-link')) {
            states[key] = { active: el.classList.contains('active') };
        } else if (el.classList.contains('tab-pane')) {
            states[key] = { active: el.classList.contains('active') };
        }
    });

    const parking = getParkingNode();
    container.querySelectorAll<HTMLIFrameElement>('iframe[src]').forEach((ifr) => {
        const src = ifr.getAttribute('src');
        if (!src) return;
        // 같은 src 가 여러 번 등장하면 첫 번째 노드만 보존. 나머지는 render 이후
        // 새 iframe 으로 자연스럽게 채워진다.
        if (iframes.has(src)) return;
        iframes.set(src, ifr);
        parking.appendChild(ifr);
    });

    // 캐시된 iframe 이 있을 때만 sentinel 을 둔다 (불필요한 DOM 변경 회피).
    let sentinel: HTMLElement | null = null;
    if (iframes.size > 0) {
        sentinel = document.createElement('span');
        sentinel.setAttribute('data-preview-render-sentinel', '1');
        sentinel.style.display = 'none';
        sentinel.setAttribute('aria-hidden', 'true');
        container.appendChild(sentinel);
    }

    return { states, iframes, sentinel };
}

function _restoreNodeStates(container: HTMLElement, snap: PreviewStateSnapshot): void {
    container.querySelectorAll<HTMLElement>('[data-state-key]').forEach((el) => {
        const key = el.getAttribute('data-state-key');
        if (!key) return;
        const s = snap.states[key];
        if (!s) return;
        if (el instanceof HTMLDetailsElement) {
            if (typeof s.open === 'boolean') el.open = s.open;
        } else if (el.classList.contains('wiki-section')) {
            if (typeof s.collapsed === 'boolean') {
                el.classList.toggle('wiki-section-collapsed', s.collapsed);
            }
        } else if (el.classList.contains('accordion-item')) {
            if (typeof s.show !== 'boolean') return;
            const collapse = el.querySelector<HTMLElement>(':scope > .accordion-collapse');
            const button = el.querySelector<HTMLElement>(':scope > .accordion-header > .accordion-button');
            if (collapse) collapse.classList.toggle('show', s.show);
            if (button) {
                button.classList.toggle('collapsed', !s.show);
                button.setAttribute('aria-expanded', s.show ? 'true' : 'false');
            }
        }
        // tab 은 그룹 단위 exclusivity 가 있어 _restoreTabs 에서 처리.
    });
}

function _restoreTabs(container: HTMLElement, snap: PreviewStateSnapshot): void {
    container.querySelectorAll<HTMLElement>('.wiki-tabs').forEach((group) => {
        const buttons = Array.from(group.querySelectorAll<HTMLElement>('button.nav-link[data-state-key]'));
        if (buttons.length === 0) return;
        let activeKey: string | null = null;
        for (const btn of buttons) {
            const k = btn.getAttribute('data-state-key');
            if (!k) continue;
            const s = snap.states[k];
            if (s && s.active) {
                activeKey = k;
                break;
            }
        }
        if (!activeKey) return; // 기록된 활성 탭이 이 그룹에 없으면 기본값(첫 탭) 유지.
        buttons.forEach((btn) => {
            const k = btn.getAttribute('data-state-key');
            const isActive = k === activeKey;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        group.querySelectorAll<HTMLElement>('.tab-pane[data-state-key]').forEach((pane) => {
            const k = pane.getAttribute('data-state-key');
            const isActive = k === activeKey;
            pane.classList.toggle('active', isActive);
            pane.classList.toggle('show', isActive);
        });
    });
}

function _swapIframes(container: HTMLElement, snap: PreviewStateSnapshot): void {
    if (snap.iframes.size === 0) return;

    // sentinel 이 container 에 남아있다면 renderWikiContent 가 `innerHTML = html`
    // 단계에 도달하지 못한 것 (= 내부 catch 로 일찍 종료). 이 경우 캐시된
    // iframe 들은 새 DOM 과 매칭할 짝이 없으므로 container 끝에 그대로 다시
    // append 해서, 사용자가 보던 임베드가 시각적으로 사라지지 않도록 한다.
    // (원래 위치는 복원할 수 없지만 다음 성공 렌더 시점에 정상 자리로 매칭됨.)
    if (snap.sentinel && container.contains(snap.sentinel)) {
        try { snap.sentinel.remove(); } catch (_) { /* noop */ }
        snap.iframes.forEach((ifr) => {
            try { container.appendChild(ifr); } catch (_) { /* noop */ }
        });
        snap.iframes.clear();
        return;
    }

    container.querySelectorAll<HTMLIFrameElement>('iframe[src]').forEach((newIfr) => {
        const src = newIfr.getAttribute('src');
        if (!src) return;
        const cached = snap.iframes.get(src);
        if (!cached) return;
        snap.iframes.delete(src);
        newIfr.replaceWith(cached);
    });
    // 정상 렌더 (sentinel 사라짐) 경로: 매칭되지 않은 캐시는 사용자가 본문에서
    // 임베드를 제거했거나 URL 을 바꾼 케이스이므로 parking 에서 즉시 정리해
    // 백그라운드 리소스 소비(네트워크/CPU/오디오) 누수를 막는다.
    snap.iframes.forEach((ifr) => {
        try { ifr.remove(); } catch (_) { /* noop */ }
    });
    snap.iframes.clear();
}

export function restorePreviewState(container: HTMLElement, snap: PreviewStateSnapshot): void {
    _restoreNodeStates(container, snap);
    _restoreTabs(container, snap);
    _swapIframes(container, snap);
}
