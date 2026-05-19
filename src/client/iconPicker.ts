// 재사용 가능한 아이콘 선택 모달 — admin.html 과 blog.html 에서 사용.
//
// 에디터(edit.html / blog-edit.html) 의 picker 는 별도로 edit/modals.ts 에 있다.
// 이쪽은 Promise 로 결과를 돌려주는 standalone API 가 필요한 페이지용.
//
// HTML 마크업은 호출 페이지가 #iconPickerModal / #iconPickerTitle / #iconPickerTypeIcon /
// #iconSearchInput / #iconLoadingSpinner / #iconPickerGrid / #iconPickerEmpty /
// #iconPickerTabBi / #iconPickerTabMdi / #iconPickerNoneBtn 노드를 가지고 있어야 한다.
//
// 결과: "mdi mdi-bullhorn" 같은 class 문자열, 또는 null (취소/없음).

import { loadBiIcons, loadMdiIcons, filterIcons } from './iconLib';

interface BootstrapModalInstance {
    show: () => void;
    hide: () => void;
}

declare global {
    interface Window {
        bootstrap?: {
            Modal: {
                new (el: HTMLElement | string): BootstrapModalInstance;
                getOrCreateInstance(el: HTMLElement | string): BootstrapModalInstance;
            };
        };
        pickWikiIcon?: typeof openIconPicker;
    }
}

let pickerToken = 0;
let pendingResolve: ((value: string | null) => void) | null = null;

/** 아이콘 피커를 띄우고, 사용자가 고른 아이콘 class 문자열을 resolve 한다.
 *  '아이콘 없음' / X / 취소 / 모달 외부 클릭 모두 null 로 resolve.
 */
export function openIconPicker(): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
        const modalEl = document.getElementById('iconPickerModal');
        if (!modalEl) { resolve(null); return; }

        // 이전에 열려있던 picker 가 있으면 그쪽 promise 는 null 로 정리.
        if (pendingResolve) pendingResolve(null);
        pendingResolve = resolve;
        const myToken = ++pickerToken;

        const titleEl = document.getElementById('iconPickerTitle');
        const typeIconEl = document.getElementById('iconPickerTypeIcon');
        const gridEl = document.getElementById('iconPickerGrid');
        const spinner = document.getElementById('iconLoadingSpinner');
        const searchInput = document.getElementById('iconSearchInput') as HTMLInputElement | null;
        const emptyEl = document.getElementById('iconPickerEmpty');
        const tabBi = document.getElementById('iconPickerTabBi');
        const tabMdi = document.getElementById('iconPickerTabMdi');
        const noneBtn = document.getElementById('iconPickerNoneBtn');

        if (!titleEl || !typeIconEl || !gridEl || !spinner || !searchInput || !emptyEl || !tabBi || !tabMdi) {
            resolve(null);
            pendingResolve = null;
            return;
        }

        let currentType: 'bi' | 'mdi' = 'mdi';
        let icons: string[] = [];

        function settle(value: string | null) {
            if (pendingResolve !== resolve) return; // 이미 다른 picker 가 인계함
            pendingResolve = null;
            resolve(value);
            const m = window.bootstrap?.Modal.getOrCreateInstance(modalEl!);
            m?.hide();
        }

        async function switchType(type: 'bi' | 'mdi') {
            if (myToken !== pickerToken) return;
            currentType = type;
            tabBi!.classList.toggle('active', type === 'bi');
            tabMdi!.classList.toggle('active', type === 'mdi');
            tabBi!.setAttribute('aria-selected', String(type === 'bi'));
            tabMdi!.setAttribute('aria-selected', String(type === 'mdi'));
            if (type === 'bi') {
                titleEl!.textContent = 'Bootstrap Icons 선택';
                typeIconEl!.className = 'bi bi-bootstrap me-2';
            } else {
                titleEl!.textContent = 'Material Design Icons 선택';
                typeIconEl!.className = 'mdi mdi-material-design me-2';
            }

            gridEl!.innerHTML = '';
            emptyEl!.style.display = 'none';
            spinner!.style.display = 'block';
            icons = type === 'bi' ? await loadBiIcons() : await loadMdiIcons();
            if (myToken !== pickerToken) return;
            spinner!.style.display = 'none';
            renderGrid(searchInput!.value);
        }

        function renderGrid(query: string) {
            const filtered = filterIcons(icons, query);
            gridEl!.innerHTML = '';
            if (filtered.length === 0) {
                emptyEl!.style.display = 'block';
                return;
            }
            emptyEl!.style.display = 'none';

            const prefix = currentType === 'bi' ? 'bi bi-' : 'mdi mdi-';
            let renderIndex = 0;
            const batchSize = 200;

            const appendItems = () => {
                const end = Math.min(renderIndex + batchSize, filtered.length);
                const slice = filtered.slice(renderIndex, end);
                slice.forEach(iconName => {
                    const item = document.createElement('button');
                    item.type = 'button';
                    item.className = 'icon-grid-modal-item';
                    item.title = iconName;
                    const cls = prefix + iconName;
                    const safeName = iconName.replace(/[&<>"']/g, c => ({
                        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
                    } as Record<string, string>)[c]);
                    item.innerHTML = `<i class="${cls}"></i><span>${safeName}</span>`;
                    item.addEventListener('click', () => {
                        settle(cls);
                    });
                    gridEl!.appendChild(item);
                });
                renderIndex = end;
            };

            gridEl!.onscroll = () => {
                if (gridEl!.scrollTop + gridEl!.clientHeight >= gridEl!.scrollHeight - 50) {
                    if (renderIndex < filtered.length) appendItems();
                }
            };
            appendItems();
        }

        // 이벤트 바인딩 — 모달이 다시 열릴 때마다 onclick 으로 덮어쓰면 충돌 없음.
        tabBi.onclick = () => switchType('bi');
        tabMdi.onclick = () => switchType('mdi');
        if (noneBtn) noneBtn.onclick = () => settle(null);

        let searchTimer: number | undefined;
        searchInput.value = '';
        searchInput.oninput = () => {
            clearTimeout(searchTimer);
            searchTimer = window.setTimeout(() => renderGrid(searchInput.value), 200);
        };
        searchInput.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                renderGrid(searchInput.value);
            }
        };

        // 모달 닫힘 (X / 백드롭 / Esc) 처리 — Bootstrap 의 hidden 이벤트 한 번만 listen.
        const onHidden = () => {
            modalEl.removeEventListener('hidden.bs.modal', onHidden);
            // 부모 컨텍스트(다른 Bootstrap 모달 / SweetAlert2) 가 살아 있으면
            // Bootstrap 이 body 의 .modal-open 클래스와 padding-right 를 제거해버려
            // 스크롤이 풀려버린다. 부모 모달이 여전히 열려 있다면 .modal-open 을 복원.
            if (document.querySelector('.modal.show')) {
                document.body.classList.add('modal-open');
            }
            if (pendingResolve === resolve) {
                pendingResolve = null;
                resolve(null);
            }
        };
        modalEl.addEventListener('hidden.bs.modal', onHidden);

        const modal = window.bootstrap?.Modal.getOrCreateInstance(modalEl);
        modal?.show();
        // Bootstrap 은 backdrop 을 동적으로 body 에 append 한다. 우리 모달의 backdrop 만
        // 식별해 z-index 를 SweetAlert2(~1060) 위로 올리기 위해 클래스를 부여한다.
        // (CSS: .modal-backdrop.icon-picker-backdrop { z-index: 2069 })
        const tagBackdrop = () => {
            const backdrops = document.querySelectorAll('.modal-backdrop');
            const last = backdrops[backdrops.length - 1] as HTMLElement | undefined;
            if (last) last.classList.add('icon-picker-backdrop');
        };
        // show() 가 비동기로 backdrop 을 삽입하므로 한 프레임 뒤에 클래스 부여.
        requestAnimationFrame(tagBackdrop);
        switchType('mdi');
        setTimeout(() => searchInput.focus(), 300);
    });
}

// admin.html / blog.html 의 인라인 스크립트에서 호출 가능하도록 노출.
window.pickWikiIcon = openIconPicker;
