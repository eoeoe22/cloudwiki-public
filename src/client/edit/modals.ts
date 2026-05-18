/**
 * 에디터(public/edit.html / public/blog-edit.html) 의 다양한 삽입 모달 UI.
 *
 * - 표/CSV/특수문자/타임스탬프/구글 지도/카드/팔레트색상/배지/하위문서/템플릿 등.
 * - 아이콘 피커(라이브러리 그리드)도 함께 담당.
 *
 * 외부 의존성:
 *   - window.editor / window._cmView (edit.js 가 만드는 CodeMirror6 래퍼와 EditorView)
 *   - window.Swal (sweetalert2 CDN)
 *   - window.bootstrap (Bootstrap 5 Modal CDN)
 *   - window.selectedIconsOnly (edit.js 가 노출 — appConfig.selectedIconsOnly 반영)
 *   - window._processTimestampsInHtml / window._processInlineLayoutTokens (render.js)
 *   - window._isSafeCssColor (render.js)
 *   - window.getAllPalettesForEditor (edit/autocomplete.ts)
 *   - window.hsvToHex / window.hexToHsv (edit/utils.ts)
 *   - window.scrollToBottom (edit.js 의 미리보기 스크롤)
 *
 * 노출 글로벌(window.*):
 *   - 아이콘 목록 로더 4종 (loadBiIcons, loadMdiIcons, loadSelectedIcons, filterIcons)
 *     → edit/autocomplete.ts 에서 호출.
 *   - 모달 진입점 (openSelectedIconsPicker, openIconPicker, openTimestampInsertModal,
 *     openSubdocInsertModal, openCardInsertModal, openPaletteColorModal,
 *     openBadgeInsertModal, openGoogleMapsEmbedModal, openTemplateModal,
 *     setupTableInsertPopover, setupSpecialCharPicker)
 *     → edit.js 의 toolbar 가 클릭 핸들러에서 호출.
 *   - 아이콘 피커 결과 상태 (window.pendingIconInsertion / window.iconPickerSavedSelection)
 *     → edit.js 의 hidden.bs.modal 리스너가 읽어 본문에 삽입.
 *
 * 아이콘 ※ 아이콘 관련 기능을 수정할 때는 반드시 SELECTED_ICONS_ONLY 설정을 확인할 것.
 *    selectedIconsOnly=true  → icons.json 기반 (icon 문법만 사용)
 *    selectedIconsOnly=false → 라이브러리 직접 검색 (bi, mdi 문법 사용)
 */

import './types';
import { escapeHtml } from '../utils/html';
import type { CMSelection } from './types';
import {
    loadBiIcons,
    loadMdiIcons,
    loadSelectedIcons,
    filterIcons,
} from '../iconLib';

// ─────────────────────────────────────────────────────────────────────────────
// 모듈 고유 window 증강 (공유 자산은 types.ts 에 있음)
// ─────────────────────────────────────────────────────────────────────────────

declare global {
    interface Window {
        // edit.js 의 toolbar 핸들러에서 호출되는 모달 진입점
        openSelectedIconsPicker?: () => Promise<void>;
        openIconPicker?: (type: 'bi' | 'mdi') => Promise<void>;
        setupTableInsertPopover?: (tableBtn: HTMLElement) => void;
        setupSpecialCharPicker?: (triggerBtn: HTMLElement) => void;
        openTimestampInsertModal?: () => void;
        openSubdocInsertModal?: () => Promise<void>;
        openCardInsertModal?: () => void;
        openPaletteColorModal?: () => void;
        openBadgeInsertModal?: () => void;
        openComponentInsertModal?: () => void;
        openStructureBlockInsertModal?: () => void;
        openGoogleMapsEmbedModal?: () => void;
        openTemplateModal?: () => Promise<void>;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 모듈 로컬 상태 (단일 모듈 내부에서만 사용)
// ─────────────────────────────────────────────────────────────────────────────

let iconPickerToken = 0;

// ─────────────────────────────────────────────────────────────────────────────
// 크로스-스크립트 상태 — edit.js 의 hidden.bs.modal 리스너가 읽어감
// ─────────────────────────────────────────────────────────────────────────────

window.pendingIconInsertion = null;
window.iconPickerSavedSelection = null;

// 아이콘 목록 로더와 filterIcons 는 src/client/iconLib.ts 에서 import 한다.
// (edit/blog-edit 의 아이콘 피커와 admin/blog 의 standalone iconPicker 가 공유.)

// ─────────────────────────────────────────────────────────────────────────────
// 아이콘 피커 모달
// ─────────────────────────────────────────────────────────────────────────────

async function openSelectedIconsPicker(): Promise<void> {
    const editor = window.editor;
    if (editor) {
        window.iconPickerSavedSelection = editor.getSelection?.() ?? null;
    }
    window.pendingIconInsertion = null;
    const myToken = ++iconPickerToken;

    const titleEl = document.getElementById('iconPickerTitle');
    const typeIconEl = document.getElementById('iconPickerTypeIcon');
    const gridEl = document.getElementById('iconPickerGrid');
    const spinner = document.getElementById('iconLoadingSpinner');
    const searchInput = document.getElementById('iconSearchInput') as HTMLInputElement | null;
    const emptyEl = document.getElementById('iconPickerEmpty');
    if (!titleEl || !typeIconEl || !gridEl || !spinner || !searchInput || !emptyEl) return;

    titleEl.textContent = '아이콘 선택';
    typeIconEl.className = 'mdi mdi-vector-square me-2';

    const modalEl = document.getElementById('iconPickerModal');
    if (!modalEl) return;
    const modal = window.bootstrap?.Modal.getOrCreateInstance(modalEl);
    modal?.show();

    searchInput.value = '';
    gridEl.innerHTML = '';
    emptyEl.style.display = 'none';
    spinner.style.display = 'block';

    const allIcons = await loadSelectedIcons();
    if (myToken !== iconPickerToken) return;
    spinner.style.display = 'none';
    renderMixedIconGrid(gridEl, emptyEl, allIcons, '');

    let searchTimer: number | undefined;
    searchInput.oninput = () => {
        clearTimeout(searchTimer);
        searchTimer = window.setTimeout(() => {
            renderMixedIconGrid(gridEl, emptyEl, allIcons, searchInput.value);
        }, 200);
    };
    searchInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            renderMixedIconGrid(gridEl, emptyEl, allIcons, searchInput.value);
        }
    };

    setTimeout(() => searchInput.focus(), 300);
}

function renderMixedIconGrid(
    gridEl: HTMLElement,
    emptyEl: HTMLElement,
    iconList: string[],
    query: string,
): void {
    const filtered = filterIcons(iconList, query);
    gridEl.innerHTML = '';

    if (filtered.length === 0) {
        emptyEl.style.display = 'block';
        return;
    }
    emptyEl.style.display = 'none';

    let renderIndex = 0;
    const batchSize = 200;

    function appendItems() {
        const end = Math.min(renderIndex + batchSize, filtered.length);
        const slice = filtered.slice(renderIndex, end);
        slice.forEach(fullName => {
            let cssClass: string, type: string, iconName: string;
            if (fullName.startsWith('bi-')) {
                type = 'bi';
                iconName = fullName.slice(3);
                cssClass = 'bi bi-' + iconName;
            } else if (fullName.startsWith('mdi-')) {
                type = 'mdi';
                iconName = fullName.slice(4);
                cssClass = 'mdi mdi-' + iconName;
            } else {
                return;
            }
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'icon-grid-modal-item';
            item.title = fullName;
            item.innerHTML = `<i class="${cssClass}"></i><span>${escapeHtml(fullName)}</span>`;
            item.addEventListener('click', () => {
                const onlyIcons = window.selectedIconsOnly ?? false;
                window.pendingIconInsertion = onlyIcons ? `{icon:${fullName}}` : `{${type}:${iconName}}`;
                const m = document.getElementById('iconPickerModal');
                if (m) window.bootstrap?.Modal.getOrCreateInstance(m).hide();
            });
            gridEl.appendChild(item);
        });
        renderIndex = end;
    }

    gridEl.onscroll = () => {
        if (gridEl.scrollTop + gridEl.clientHeight >= gridEl.scrollHeight - 50) {
            if (renderIndex < filtered.length) {
                appendItems();
            }
        }
    };

    appendItems();
}

async function openIconPicker(type: 'bi' | 'mdi'): Promise<void> {
    const editor = window.editor;
    if (editor) {
        window.iconPickerSavedSelection = editor.getSelection?.() ?? null;
    }
    window.pendingIconInsertion = null;
    const myToken = ++iconPickerToken;

    const titleEl = document.getElementById('iconPickerTitle');
    const typeIconEl = document.getElementById('iconPickerTypeIcon');
    const gridEl = document.getElementById('iconPickerGrid');
    const spinner = document.getElementById('iconLoadingSpinner');
    const searchInput = document.getElementById('iconSearchInput') as HTMLInputElement | null;
    const emptyEl = document.getElementById('iconPickerEmpty');
    if (!titleEl || !typeIconEl || !gridEl || !spinner || !searchInput || !emptyEl) return;

    if (type === 'bi') {
        titleEl.textContent = 'Bootstrap Icons 선택';
        typeIconEl.className = 'bi bi-bootstrap me-2';
    } else {
        titleEl.textContent = 'Material Design Icons 선택';
        typeIconEl.className = 'mdi mdi-material-design me-2';
    }

    const modalEl = document.getElementById('iconPickerModal');
    if (!modalEl) return;
    const modal = window.bootstrap?.Modal.getOrCreateInstance(modalEl);
    modal?.show();

    searchInput.value = '';
    gridEl.innerHTML = '';
    emptyEl.style.display = 'none';
    spinner.style.display = 'block';

    let icons: string[];
    const onlyIcons = window.selectedIconsOnly ?? false;
    if (onlyIcons) {
        const all = await loadSelectedIcons();
        const prefix = type === 'bi' ? 'bi-' : 'mdi-';
        icons = all.filter(n => n.startsWith(prefix)).map(n => n.slice(prefix.length));
    } else {
        icons = type === 'bi' ? await loadBiIcons() : await loadMdiIcons();
    }
    if (myToken !== iconPickerToken) return;
    spinner.style.display = 'none';
    renderIconPickerGrid(gridEl, emptyEl, icons, '', type);

    let searchTimer: number | undefined;
    searchInput.oninput = () => {
        clearTimeout(searchTimer);
        searchTimer = window.setTimeout(() => {
            renderIconPickerGrid(gridEl, emptyEl, icons, searchInput.value, type);
        }, 200);
    };
    searchInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            renderIconPickerGrid(gridEl, emptyEl, icons, searchInput.value, type);
        }
    };

    setTimeout(() => searchInput.focus(), 300);
}

function renderIconPickerGrid(
    gridEl: HTMLElement,
    emptyEl: HTMLElement,
    iconList: string[],
    query: string,
    type: 'bi' | 'mdi',
): void {
    const filtered = filterIcons(iconList, query);
    gridEl.innerHTML = '';

    if (filtered.length === 0) {
        emptyEl.style.display = 'block';
        return;
    }
    emptyEl.style.display = 'none';

    const prefix = type === 'bi' ? 'bi bi-' : 'mdi mdi-';
    let renderIndex = 0;
    const batchSize = 200;

    function appendItems() {
        const end = Math.min(renderIndex + batchSize, filtered.length);
        const slice = filtered.slice(renderIndex, end);
        slice.forEach(iconName => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'icon-grid-modal-item';
            item.title = iconName;
            item.innerHTML = `<i class="${prefix}${iconName}"></i><span>${escapeHtml(iconName)}</span>`;
            item.addEventListener('click', () => {
                const onlyIcons = window.selectedIconsOnly ?? false;
                window.pendingIconInsertion = onlyIcons ? `{icon:${type}-${iconName}}` : `{${type}:${iconName}}`;
                const m = document.getElementById('iconPickerModal');
                if (m) window.bootstrap?.Modal.getOrCreateInstance(m).hide();
            });
            gridEl.appendChild(item);
        });
        renderIndex = end;
    }

    gridEl.onscroll = () => {
        if (gridEl.scrollTop + gridEl.clientHeight >= gridEl.scrollHeight - 50) {
            if (renderIndex < filtered.length) {
                appendItems();
            }
        }
    };

    appendItems();
}

// ─────────────────────────────────────────────────────────────────────────────
// 표 삽입 팝오버 (그리드 + CSV)
// ─────────────────────────────────────────────────────────────────────────────

function setupTableInsertPopover(tableBtn: HTMLElement): void {
    const MAX_ROWS = 8;
    const MAX_COLS = 10;

    const popup = document.createElement('div');
    popup.className = 'table-insert-popup';

    let activeRow = 1;
    let activeCol = 1;
    let gridHTML = '<div class="table-insert-grid" role="grid" aria-label="표 크기 선택">';
    for (let r = 1; r <= MAX_ROWS; r++) {
        for (let c = 1; c <= MAX_COLS; c++) {
            const tabIndex = (r === 1 && c === 1) ? '0' : '-1';
            gridHTML += `<button type="button" class="table-insert-cell" role="gridcell" data-row="${r}" data-col="${c}" tabindex="${tabIndex}" aria-label="${r}행 ${c}열 표 삽입"></button>`;
        }
    }
    gridHTML += '</div>';

    popup.innerHTML = `
                <div class="table-insert-label"><span class="table-insert-label-text">크기 선택</span></div>
                ${gridHTML}
                <button type="button" class="table-insert-csv-btn">
                    <i class="mdi mdi-file-delimited-outline"></i>
                    <span>CSV로 삽입</span>
                </button>
            `;
    document.body.appendChild(popup);

    const grid = popup.querySelector<HTMLElement>('.table-insert-grid')!;
    const cells = popup.querySelectorAll<HTMLElement>('.table-insert-cell');
    const labelText = popup.querySelector<HTMLElement>('.table-insert-label-text')!;
    const csvBtn = popup.querySelector<HTMLElement>('.table-insert-csv-btn')!;

    function getCell(rows: number, cols: number): HTMLElement | null {
        return popup.querySelector<HTMLElement>(`.table-insert-cell[data-row="${rows}"][data-col="${cols}"]`);
    }

    function setActiveCell(rows: number, cols: number, shouldFocus: boolean) {
        activeRow = Math.min(MAX_ROWS, Math.max(1, rows));
        activeCol = Math.min(MAX_COLS, Math.max(1, cols));
        cells.forEach(cell => {
            const isActive = parseInt(cell.dataset.row || '', 10) === activeRow && parseInt(cell.dataset.col || '', 10) === activeCol;
            cell.tabIndex = isActive ? 0 : -1;
        });
        const activeCell = getCell(activeRow, activeCol);
        if (shouldFocus && activeCell) {
            activeCell.focus();
        }
    }

    function highlight(rows: number, cols: number) {
        cells.forEach(cell => {
            const r = parseInt(cell.dataset.row || '', 10);
            const c = parseInt(cell.dataset.col || '', 10);
            cell.classList.toggle('highlighted', r <= rows && c <= cols);
        });
        labelText.textContent = `${rows} × ${cols}`;
    }

    function clearHighlight() {
        cells.forEach(cell => cell.classList.remove('highlighted'));
        labelText.textContent = '크기 선택';
    }

    function insertSelectedTable(rows: number, cols: number) {
        insertMarkdownTable(rows, cols);
        popup.classList.remove('active');
        tableBtn.focus();
    }

    cells.forEach(cell => {
        cell.addEventListener('mouseenter', () => {
            const r = parseInt(cell.dataset.row || '', 10);
            const c = parseInt(cell.dataset.col || '', 10);
            setActiveCell(r, c, false);
            highlight(r, c);
        });

        cell.addEventListener('focus', () => {
            const r = parseInt(cell.dataset.row || '', 10);
            const c = parseInt(cell.dataset.col || '', 10);
            setActiveCell(r, c, false);
            highlight(r, c);
        });

        cell.addEventListener('click', () => {
            const rows = parseInt(cell.dataset.row || '', 10);
            const cols = parseInt(cell.dataset.col || '', 10);
            insertSelectedTable(rows, cols);
        });

        cell.addEventListener('keydown', (e) => {
            const row = parseInt(cell.dataset.row || '', 10);
            const col = parseInt(cell.dataset.col || '', 10);

            switch (e.key) {
                case 'ArrowRight':
                    e.preventDefault();
                    setActiveCell(row, col + 1, true);
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    setActiveCell(row, col - 1, true);
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    setActiveCell(row + 1, col, true);
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    setActiveCell(row - 1, col, true);
                    break;
                case 'Home':
                    e.preventDefault();
                    setActiveCell(row, 1, true);
                    break;
                case 'End':
                    e.preventDefault();
                    setActiveCell(row, MAX_COLS, true);
                    break;
                case 'Enter':
                case ' ':
                    e.preventDefault();
                    insertSelectedTable(row, col);
                    break;
                case 'Escape':
                    e.preventDefault();
                    popup.classList.remove('active');
                    tableBtn.focus();
                    break;
            }
        });
    });

    grid.addEventListener('mouseleave', clearHighlight);

    grid.addEventListener('mousedown', (e) => { e.preventDefault(); });

    tableBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isActive = popup.classList.contains('active');
        popup.classList.toggle('active');
        if (!isActive) {
            clearHighlight();
            setActiveCell(1, 1, false);
            const rect = tableBtn.getBoundingClientRect();
            popup.style.top = (rect.bottom + window.scrollY + 6) + 'px';
            popup.style.left = Math.max(8, rect.left + window.scrollX - 40) + 'px';
            const firstCell = getCell(1, 1);
            if (firstCell) {
                firstCell.focus();
            }
        }
    });

    document.addEventListener('click', (e) => {
        const target = e.target as Node;
        if (!popup.contains(target) && !tableBtn.contains(target)) {
            popup.classList.remove('active');
        }
    });

    csvBtn.addEventListener('click', () => {
        popup.classList.remove('active');
        openCsvTableModal();
    });

    // suppress unused-warning: activeRow/activeCol are state vars used inside setActiveCell.
    void activeRow; void activeCol;
}

// ─────────────────────────────────────────────────────────────────────────────
// 특수문자 삽입 팝오버
// ─────────────────────────────────────────────────────────────────────────────

interface SpecialCharGroup {
    name: string;
    chars: string[];
}

const SPECIAL_CHAR_GROUPS: SpecialCharGroup[] = [
    {
        name: '그리스 문자',
        chars: [
            'α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ', 'ι', 'κ', 'λ', 'μ',
            'ν', 'ξ', 'ο', 'π', 'ρ', 'σ', 'τ', 'υ', 'φ', 'χ', 'ψ', 'ω',
            'Α', 'Β', 'Γ', 'Δ', 'Ε', 'Ζ', 'Η', 'Θ', 'Ι', 'Κ', 'Λ', 'Μ',
            'Ν', 'Ξ', 'Ο', 'Π', 'Ρ', 'Σ', 'Τ', 'Υ', 'Φ', 'Χ', 'Ψ', 'Ω'
        ]
    },
    {
        name: '수학 기호',
        chars: ['±', '×', '÷', '∓', '⋅', '∘', '≠', '≈', '≃', '≅', '≡', '≤', '≥', '≪', '≫',
                '∞', '∝', '∑', '∏', '∫', '∮', '√', '∛', '∂', '∇', '∆', 'π', '∅',
                '∈', '∉', '∋', '⊂', '⊃', '⊆', '⊇', '∪', '∩', '∖', '∀', '∃', '∄',
                '∧', '∨', '¬', '⊕', '⊗', '⊥', '∥', 'ℝ', 'ℕ', 'ℤ', 'ℚ', 'ℂ']
    },
    {
        name: '화살표',
        chars: ['←', '→', '↑', '↓', '↔', '↕', '↖', '↗', '↘', '↙',
                '⇐', '⇒', '⇑', '⇓', '⇔', '⇕', '⟵', '⟶', '⟷', '⟹', '⟺',
                '↩', '↪', '⤴', '⤵', '↺', '↻', '➜', '➤', '➥', '➦']
    },
    {
        name: '통화',
        chars: ['₩', '€', '£', '¥', '¢', '$', '₿', '₽', '₹', '₺', '₪', '₫', '฿', '₱', '₴', '₦', '₡', '₲', '₵']
    },
    {
        name: '문장 부호',
        chars: ['§', '¶', '†', '‡', '•', '·', '…', '–', '—', '‒', '⁓',
                '“', '”', '‘', '’', '«', '»', '‹', '›', '„', '‚',
                '『', '』', '「', '」', '〔', '〕', '【', '】', '《', '》',
                '¡', '¿', '©', '®', '™', '℠', '№', '⁂', '⁕', '※']
    },
    {
        name: '숫자/단위',
        chars: ['½', '⅓', '⅔', '¼', '¾', '⅕', '⅖', '⅗', '⅘', '⅙', '⅚', '⅛', '⅜', '⅝', '⅞',
                '⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹', 'ⁿ',
                '₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉',
                '°', '′', '″', '‰', '‱', '℃', '℉', 'Å', 'Ω', 'µ', 'ℓ']
    },
    {
        name: '도형/기타',
        chars: ['★', '☆', '✦', '✧', '✪', '✯', '♥', '♡', '♦', '♢', '♣', '♠', '♪', '♫', '♬',
                '✓', '✔', '✗', '✘', '☑', '☒', '☐',
                '▲', '△', '▶', '▷', '▼', '▽', '◀', '◁',
                '◆', '◇', '●', '○', '◎', '◉', '■', '□', '▪', '▫',
                '☀', '☁', '☂', '☃', '☎', '☞', '☜', '☝', '☟', '⌘', '⌥', '⏎', '␣']
    }
];

function setupSpecialCharPicker(triggerBtn: HTMLElement): void {
    const popup = document.createElement('div');
    popup.className = 'special-char-popup';

    const tabsHtml = SPECIAL_CHAR_GROUPS.map((g, i) => {
        const active = i === 0 ? ' active' : '';
        return `<button type="button" class="special-char-tab${active}" data-group="${i}">${escapeHtml(g.name)}</button>`;
    }).join('');

    popup.innerHTML = `
        <div class="special-char-header">
            <span class="special-char-title"><span class="special-char-omega">Ω</span> 특수문자</span>
        </div>
        <div class="special-char-tabs">${tabsHtml}</div>
        <div class="special-char-grid" id="specialCharGrid"></div>
    `;
    document.body.appendChild(popup);

    const grid = popup.querySelector<HTMLElement>('#specialCharGrid')!;
    const tabs = popup.querySelectorAll<HTMLElement>('.special-char-tab');

    function renderGroup(idx: number) {
        const group = SPECIAL_CHAR_GROUPS[idx] || SPECIAL_CHAR_GROUPS[0];
        grid.innerHTML = group.chars.map(ch => {
            return `<button type="button" class="special-char-cell" data-char="${escapeHtml(ch)}" title="${escapeHtml(ch)} (U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')})">${escapeHtml(ch)}</button>`;
        }).join('');
    }

    renderGroup(0);

    tabs.forEach(tab => {
        tab.addEventListener('click', (e) => {
            e.stopPropagation();
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            renderGroup(parseInt(tab.dataset.group || '0', 10));
        });
    });

    grid.addEventListener('mousedown', (e) => {
        e.preventDefault();
    });
    grid.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const cell = target.closest<HTMLElement>('.special-char-cell');
        if (!cell) return;
        e.stopPropagation();
        const ch = cell.dataset.char;
        const editor = window.editor;
        if (editor && typeof editor.insertText === 'function' && ch) {
            editor.insertText(ch);
        }
    });

    function positionPopup() {
        const rect = triggerBtn.getBoundingClientRect();
        const popupW = popup.offsetWidth || 340;
        const popupH = popup.offsetHeight || 320;
        const viewportW = document.documentElement.clientWidth;
        const viewportH = document.documentElement.clientHeight;
        const margin = 8;
        const triggerCenterX = rect.left + (rect.width / 2);

        let left = triggerCenterX - (popupW / 2);
        left = Math.max(margin, Math.min(left, viewportW - popupW - margin));

        let top = rect.bottom + 6;
        if (top + popupH + margin > viewportH && rect.top - popupH - 6 >= margin) {
            top = rect.top - popupH - 6;
        }
        top = Math.max(margin, Math.min(top, viewportH - popupH - margin));

        popup.style.left = (left + window.scrollX) + 'px';
        popup.style.top = (top + window.scrollY) + 'px';
    }

    triggerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isActive = popup.classList.contains('active');
        if (isActive) {
            popup.classList.remove('active');
        } else {
            popup.classList.add('active');
            positionPopup();
        }
    });

    document.addEventListener('click', (e) => {
        if (!popup.classList.contains('active')) return;
        const target = e.target as Node;
        if (popup.contains(target) || triggerBtn.contains(target)) return;
        popup.classList.remove('active');
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && popup.classList.contains('active')) {
            popup.classList.remove('active');
        }
    });

    window.addEventListener('resize', () => {
        if (popup.classList.contains('active')) positionPopup();
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 타임스탬프 삽입 모달
// ─────────────────────────────────────────────────────────────────────────────

function openTimestampInsertModal(): void {
    const Swal = window.Swal;
    if (!Swal) return;

    interface TimestampType { id: string; label: string; desc: string; icon: string; }
    const TYPES: TimestampType[] = [
        { id: 'dday', label: 'D-Day', desc: '남은/지난 날짜', icon: 'mdi mdi-calendar-clock' },
        { id: 'age', label: '만 나이', desc: '생년월일 기준', icon: 'mdi mdi-cake-variant-outline' },
        { id: 'time', label: '표시 시간', desc: '고정 시각 표시', icon: 'mdi mdi-clock-outline' },
        { id: 'timer', label: '타이머', desc: '남은/지난 시간', icon: 'mdi mdi-timer-outline' },
        { id: 'calendar', label: '캘린더', desc: '날짜를 달력으로', icon: 'mdi mdi-calendar-month' },
    ];

    const state = {
        type: 'dday',
        date: '',
        omitYear: false,
        datetime: '',
    };

    function typeTabsHtml() {
        return TYPES.map(t => {
            const active = state.type === t.id ? ' active' : '';
            return `<button type="button" class="timestamp-insert-type-tab${active}" data-type="${t.id}" title="${escapeHtml(t.desc)}">
                <i class="${t.icon}"></i>
                <span>${t.label}</span>
            </button>`;
        }).join('');
    }

    function fieldsHtml() {
        const inputStyle = 'background:var(--wiki-bg);color:var(--wiki-text);border-color:var(--wiki-border);';
        if (state.type === 'time' || state.type === 'timer') {
            const help = state.type === 'time'
                ? '선택한 시각이 고정된 날짜/시간 문자열로 표시됩니다.'
                : '선택한 시각까지 남은/지난 시간이 실시간으로 표시됩니다.';
            return `
                <div class="timestamp-insert-field">
                    <label class="form-label" for="timestampInsertDatetime">날짜 및 시각</label>
                    <input type="datetime-local" id="timestampInsertDatetime" class="form-control form-control-sm"
                        step="1" value="${escapeHtml(state.datetime)}" style="${inputStyle}">
                    <div class="timestamp-insert-help">${help}</div>
                </div>`;
        }
        const supportsOmitYear = (state.type === 'dday' || state.type === 'calendar');
        const label = state.type === 'age' ? '생년월일' : '날짜';
        const help = state.type === 'age'
            ? '오늘 기준의 만 나이를 표시합니다.'
            : state.type === 'dday'
                ? '입력한 날짜까지 남은/지난 일수를 표시합니다. 연도를 생략하면 매년 반복됩니다.'
                : '입력한 날짜를 달력 모양으로 표시합니다. 연도를 생략하면 연도가 표시되지 않습니다.';
        return `
            <div class="timestamp-insert-field">
                <label class="form-label" for="timestampInsertDate">${label}</label>
                <input type="date" id="timestampInsertDate" class="form-control form-control-sm"
                    value="${escapeHtml(state.date)}" style="${inputStyle}">
                ${supportsOmitYear ? `
                <div class="form-check timestamp-insert-checkbox">
                    <input type="checkbox" id="timestampInsertOmitYear" class="form-check-input" ${state.omitYear ? 'checked' : ''}>
                    <label class="form-check-label" for="timestampInsertOmitYear">연도 생략 (MM-DD)</label>
                </div>` : ''}
                <div class="timestamp-insert-help">${help}</div>
            </div>`;
    }

    function buildToken(): string {
        if (state.type === 'time' || state.type === 'timer') {
            if (!state.datetime) return '';
            const t = Date.parse(state.datetime);
            if (isNaN(t)) return '';
            const unix = Math.floor(t / 1000);
            return `{${state.type}:${unix}}`;
        }
        if (!state.date) return '';
        const parts = state.date.split('-');
        if (parts.length !== 3) return '';
        if ((state.type === 'dday' || state.type === 'calendar') && state.omitYear) {
            return `{${state.type}:${parts[1]}-${parts[2]}}`;
        }
        return `{${state.type}:${state.date}}`;
    }

    function updatePreview() {
        const preview = document.getElementById('timestampInsertPreview');
        if (!preview) return;
        const token = buildToken();
        if (!token) {
            preview.innerHTML = `<span class="timestamp-insert-preview-empty">필수 입력을 채우면 미리보기가 표시됩니다.</span>`;
            return;
        }
        try {
            const proc = window._processTimestampsInHtml;
            if (typeof proc === 'function') {
                const rendered = proc(token);
                if (rendered === token) {
                    preview.innerHTML = `<span class="timestamp-insert-preview-empty">입력 값이 올바르지 않습니다.</span>`;
                } else {
                    preview.innerHTML = rendered;
                }
            } else {
                preview.textContent = token;
            }
        } catch (e) {
            preview.textContent = token;
        }
    }

    function validate(): boolean {
        const err = document.getElementById('timestampInsertValidation');
        let message = '';
        if (state.type === 'time' || state.type === 'timer') {
            if (!state.datetime) message = '날짜와 시각을 입력해주세요.';
            else if (isNaN(Date.parse(state.datetime))) message = '올바른 날짜/시각을 입력해주세요.';
        } else {
            if (!state.date) message = '날짜를 입력해주세요.';
        }
        if (err) err.textContent = message;
        return message === '';
    }

    function render() {
        const root = document.getElementById('timestampInsertRoot');
        if (!root) return;
        root.innerHTML = `
            <div class="timestamp-insert-form text-start">
                <div class="mb-3">
                    <label class="form-label">종류</label>
                    <div class="timestamp-insert-type-tabs">${typeTabsHtml()}</div>
                </div>
                <div id="timestampInsertFields" class="mb-3">${fieldsHtml()}</div>
                <div class="mb-2">
                    <label class="form-label">미리보기</label>
                    <div id="timestampInsertPreview" class="timestamp-insert-preview"></div>
                </div>
                <div id="timestampInsertValidation" class="timestamp-insert-validation"></div>
            </div>
        `;

        root.querySelectorAll<HTMLElement>('.timestamp-insert-type-tab').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const newType = btn.dataset.type || 'dday';
                if (newType === state.type) return;
                state.type = newType;
                render();
            });
        });

        const dateInput = document.getElementById('timestampInsertDate') as HTMLInputElement | null;
        if (dateInput) {
            dateInput.addEventListener('input', () => {
                state.date = dateInput.value;
                updatePreview();
                validate();
            });
        }
        const omitYearCb = document.getElementById('timestampInsertOmitYear') as HTMLInputElement | null;
        if (omitYearCb) {
            omitYearCb.addEventListener('change', () => {
                state.omitYear = omitYearCb.checked;
                updatePreview();
                validate();
            });
        }
        const datetimeInput = document.getElementById('timestampInsertDatetime') as HTMLInputElement | null;
        if (datetimeInput) {
            datetimeInput.addEventListener('input', () => {
                state.datetime = datetimeInput.value;
                updatePreview();
                validate();
            });
        }

        updatePreview();
        validate();

        const firstInput = dateInput || datetimeInput;
        if (firstInput) setTimeout(() => firstInput.focus(), 0);
    }

    Swal.fire<string>({
        title: '<i class="mdi mdi-calendar-clock me-2"></i>타임스탬프 삽입',
        width: 560,
        html: '<div id="timestampInsertRoot"></div>',
        showCancelButton: true,
        confirmButtonText: '삽입',
        cancelButtonText: '취소',
        focusConfirm: false,
        didOpen: () => {
            render();
        },
        preConfirm: () => {
            if (!validate()) return false;
            const token = buildToken();
            if (!token) {
                const err = document.getElementById('timestampInsertValidation');
                if (err) err.textContent = '필수 입력을 채워주세요.';
                return false;
            }
            return token;
        }
    }).then(result => {
        if (!result.isConfirmed || !result.value) return;
        const editor = window.editor;
        if (editor) {
            editor.insertText?.(result.value);
            window._cmView?.focus();
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 마크다운 표 삽입 / CSV 변환 / CSV 모달
// ─────────────────────────────────────────────────────────────────────────────

function insertMarkdownTable(rows: number, cols: number): void {
    const headerCells = Array.from({ length: cols }, (_, i) => `제목${i + 1}`);
    const headerLine = '| ' + headerCells.join(' | ') + ' |';
    const sepLine = '|' + ' --- |'.repeat(cols);
    const bodyLines: string[] = [];
    const bodyRows = Math.max(0, rows - 1);
    for (let r = 0; r < bodyRows; r++) {
        const rowCells = Array.from({ length: cols }, (_, i) => `내용${i + 1}`);
        bodyLines.push('| ' + rowCells.join(' | ') + ' |');
    }
    const table = '\n' + [headerLine, sepLine, ...bodyLines].join('\n') + '\n';
    window.editor?.insertText?.(table);
}

function parseCsvRecords(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    cell += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                cell += ch;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                row.push(cell);
                cell = '';
            } else if (ch === '\n') {
                row.push(cell);
                if (row.some(value => String(value).trim() !== '')) rows.push(row);
                row = [];
                cell = '';
            } else {
                cell += ch;
            }
        }
    }

    row.push(cell);
    if (row.some(value => String(value).trim() !== '')) rows.push(row);
    return rows;
}

function convertCsvToMarkdownTable(csv: string): string {
    let text = csv.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    text = text.replace(/^\s+|\s+$/g, '');
    if (!text) throw new Error('내용이 비어있습니다');
    if (text.indexOf(',') === -1) throw new Error('쉼표 구분자를 찾을 수 없습니다');

    const parsed = parseCsvRecords(text);
    if (parsed.length === 0) throw new Error('유효한 행이 없습니다');

    const colCount = parsed[0].length;
    if (colCount < 2) throw new Error('열이 2개 이상이어야 합니다');

    const mismatchIdx = parsed.findIndex(r => r.length !== colCount);
    if (mismatchIdx !== -1) {
        throw new Error(`${mismatchIdx + 1}번째 행의 열 개수(${parsed[mismatchIdx].length})가 헤더(${colCount})와 다릅니다`);
    }

    const escapeCell = (s: string | null | undefined) => (s == null ? '' : String(s))
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, ' ')
        .trim();

    const toRow = (row: string[]) => '| ' + row.map(escapeCell).join(' | ') + ' |';

    const headerLine = toRow(parsed[0]);
    const sepLine = '|' + ' --- |'.repeat(colCount);
    const bodyLines = parsed.slice(1).map(toRow);
    return [headerLine, sepLine, ...bodyLines].join('\n');
}

function openCsvTableModal(): void {
    const Swal = window.Swal;
    if (!Swal) return;
    Swal.fire<string>({
        title: '<i class="mdi mdi-file-delimited-outline me-2"></i>CSV 표 삽입',
        width: 620,
        html: `
                    <div class="text-start">
                        <p style="font-size:0.85rem;color:var(--wiki-text-muted);margin-bottom:8px;">
                            CSV 데이터를 붙여넣으세요. 첫 번째 행이 표 헤더로 사용됩니다.
                        </p>
                        <textarea id="swal-csv-input" class="form-control"
                            placeholder="제목1,제목2,제목3&#10;내용1,내용2,내용3"
                            style="font-size:0.85rem;height:220px;font-family:monospace;resize:vertical;width:100%;box-sizing:border-box;background:var(--wiki-bg);color:var(--wiki-text);border-color:var(--wiki-border);"></textarea>
                    </div>
                `,
        showCancelButton: true,
        confirmButtonText: '삽입',
        cancelButtonText: '취소',
        didOpen: () => {
            const el = document.getElementById('swal-csv-input') as HTMLTextAreaElement | null;
            if (el) el.focus();
        },
        preConfirm: () => {
            const inputEl = document.getElementById('swal-csv-input') as HTMLTextAreaElement | null;
            const input = inputEl?.value ?? '';
            if (!input || !input.trim()) {
                Swal.showValidationMessage('CSV 데이터를 입력해주세요.');
                return false;
            }
            try {
                return convertCsvToMarkdownTable(input);
            } catch (err) {
                const msg = err instanceof Error ? err.message : '알 수 없는 오류';
                Swal.showValidationMessage('CSV 형식이 아닙니다: ' + msg);
                return false;
            }
        }
    }).then(result => {
        if (result.isConfirmed && result.value) {
            window.editor?.insertText?.('\n' + result.value + '\n');
            window._cmView?.focus();
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 구글 지도 퍼가기 모달
// ─────────────────────────────────────────────────────────────────────────────

function openGoogleMapsEmbedModal(): void {
    const Swal = window.Swal;
    if (!Swal) return;
    Swal.fire<string>({
        title: '<i class="mdi mdi-google-maps me-2"></i>구글 지도 삽입',
        width: 580,
        html: `
                    <div class="text-start">
                        <p style="font-size:0.85rem;color:var(--wiki-text-muted);margin-bottom:12px;">
                            구글 지도 → 공유 → <b>지도 퍼가기</b>에서 복사한 HTML을 붙여넣으세요.
                        </p>
                        <textarea id="swal-maps-input" class="form-control"
                            placeholder='&lt;iframe src="https://www.google.com/maps/embed?pb=..." ...&gt;&lt;/iframe&gt;'
                            style="font-size:0.82rem;height:160px;font-family:monospace;resize:vertical;width:100%;box-sizing:border-box;background:var(--wiki-bg);color:var(--wiki-text);border-color:var(--wiki-border);"></textarea>
                    </div>
                `,
        showCancelButton: true,
        confirmButtonText: '삽입',
        cancelButtonText: '취소',
        didOpen: () => {
            (document.getElementById('swal-maps-input') as HTMLTextAreaElement | null)?.focus();
        },
        preConfirm: () => {
            const inputEl = document.getElementById('swal-maps-input') as HTMLTextAreaElement | null;
            const input = (inputEl?.value ?? '').trim();
            if (!input) {
                Swal.showValidationMessage('iframe HTML을 입력해주세요.');
                return false;
            }
            const match = input.match(/src=["']([^"']+)["']/);
            if (!match) {
                Swal.showValidationMessage('유효한 iframe 코드가 아닙니다.');
                return false;
            }
            const src = match[1];
            try {
                const srcUrl = new URL(src);
                const h = srcUrl.hostname;
                const validHost = (h === 'www.google.com' || h === 'google.com' || h === 'maps.google.com') && srcUrl.pathname.startsWith('/maps');
                if (!validHost) {
                    Swal.showValidationMessage('구글 지도 URL이 아닙니다.');
                    return false;
                }
            } catch (e) {
                Swal.showValidationMessage('유효하지 않은 URL입니다.');
                return false;
            }
            return src;
        }
    }).then(result => {
        if (result.isConfirmed && result.value) {
            window.editor?.insertText?.(result.value + '\n');
            window._cmView?.focus();
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 카드 / 임베드 / 콜아웃 블록 삽입 모달
// ─────────────────────────────────────────────────────────────────────────────

interface CardInsertResult {
    type: string;
    title: string;
    titlePalette: string;
    bodyPalette: string;
    calloutType: string;
    body: string;
}

function openCardInsertModal(): void {
    const Swal = window.Swal;
    if (!Swal) return;
    const palettes = window.getAllPalettesForEditor?.() ?? [];

    function paletteSwatchHtml(containerId: string): string {
        let html = `<div id="${containerId}" class="card-insert-palette-swatches">`;
        html += `<button type="button" class="card-insert-palette-swatch" data-palette="" title="선택 안 함">
                    <span class="card-insert-palette-swatch-none">없음</span>
                </button>`;
        for (const p of palettes) {
            const bg = window._isSafeCssColor?.(p.variant.bg || '') ? p.variant.bg! : 'transparent';
            const color = window._isSafeCssColor?.(p.variant.color || '') ? p.variant.color! : 'inherit';
            html += `<button type="button" class="card-insert-palette-swatch" data-palette="${escapeHtml(p.name)}" title="${escapeHtml(p.name)}" style="background:${bg};color:${color};">${escapeHtml(p.name)}</button>`;
        }
        html += `</div>`;
        return html;
    }

    const CALLOUT_TYPES = [
        { id: 'info',    label: '정보', icon: 'mdi mdi-information-outline' },
        { id: 'tip',     label: '팁',   icon: 'mdi mdi-lightbulb-on-outline' },
        { id: 'success', label: '성공', icon: 'mdi mdi-check-circle-outline' },
        { id: 'warning', label: '주의', icon: 'mdi mdi-alert-outline' },
        { id: 'danger',  label: '위험', icon: 'mdi mdi-alert-octagon-outline' },
        { id: 'note',    label: '노트', icon: 'mdi mdi-note-text-outline' }
    ];
    const calloutChipsHtml = CALLOUT_TYPES.map((c, i) => `
        <button type="button" class="card-insert-callout-chip${i === 0 ? ' active' : ''}" data-callout="${c.id}">
            <i class="${c.icon}"></i>
            <span>${c.label}</span>
        </button>`).join('');

    Swal.fire<CardInsertResult>({
        title: '<i class="bi bi-card-heading me-2"></i>카드 / 임베드 / 콜아웃 블록 삽입',
        width: 560,
        html: `
                    <div class="text-start card-insert-form">
                        <div class="mb-3">
                            <label class="form-label">블록 종류</label>
                            <input type="hidden" id="cardInsertType" value="card">
                            <div class="btn-group w-100" role="group" id="cardInsertTypeToggle">
                                <button type="button" class="btn btn-outline-primary active" data-type="card">카드</button>
                                <button type="button" class="btn btn-outline-primary" data-type="embed">임베드</button>
                                <button type="button" class="btn btn-outline-primary" data-type="callout">콜아웃</button>
                            </div>
                        </div>
                        <div class="mb-3" id="cardInsertCalloutTypeGroup" style="display:none;">
                            <label class="form-label">콜아웃 타입</label>
                            <input type="hidden" id="cardInsertCalloutType" value="info">
                            <div class="card-insert-callout-chips" id="cardInsertCalloutChips">
                                ${calloutChipsHtml}
                            </div>
                        </div>
                        <div class="mb-3">
                            <label class="form-label" for="cardInsertTitle" id="cardInsertTitleLabel">제목</label>
                            <input type="text" id="cardInsertTitle" class="form-control"
                                placeholder="제목" autocomplete="off"
                                style="background:var(--wiki-bg);color:var(--wiki-text);border-color:var(--wiki-border);">
                        </div>
                        <div class="mb-3" id="cardInsertTitlePaletteGroup">
                            <label class="form-label" id="cardInsertTitlePaletteLabel">제목 팔레트</label>
                            <input type="hidden" id="cardInsertTitlePalette" value="">
                            ${paletteSwatchHtml('cardInsertTitleSwatches')}
                        </div>
                        <div class="mb-2" id="cardInsertBodyPaletteGroup">
                            <label class="form-label">내용 팔레트</label>
                            <input type="hidden" id="cardInsertBodyPalette" value="">
                            ${paletteSwatchHtml('cardInsertBodySwatches')}
                        </div>
                        <div class="mb-2">
                            <label class="form-label" for="cardInsertBody">내용</label>
                            <textarea id="cardInsertBody" class="form-control"
                                placeholder="비워두면 '내용'이 자리표시자로 들어갑니다."
                                rows="5"
                                style="font-size:0.88rem;font-family:inherit;resize:vertical;background:var(--wiki-bg);color:var(--wiki-text);border-color:var(--wiki-border);"></textarea>
                        </div>
                    </div>
                `,
        showCancelButton: true,
        confirmButtonText: '삽입',
        cancelButtonText: '취소',
        didOpen: () => {
            const titleInput = document.getElementById('cardInsertTitle') as HTMLInputElement | null;
            if (titleInput) titleInput.focus();

            function wireSwatches(containerId: string, hiddenId: string) {
                const container = document.getElementById(containerId);
                const hidden = document.getElementById(hiddenId) as HTMLInputElement | null;
                if (!container || !hidden) return;
                const swatches = container.querySelectorAll<HTMLElement>('.card-insert-palette-swatch');
                function setActive(val: string) {
                    hidden!.value = val || '';
                    swatches.forEach(sw => {
                        sw.classList.toggle('active', (sw.dataset.palette || '') === (val || ''));
                    });
                }
                setActive('');
                swatches.forEach(sw => {
                    sw.addEventListener('click', (e) => {
                        e.preventDefault();
                        setActive(sw.dataset.palette || '');
                    });
                });
            }
            wireSwatches('cardInsertTitleSwatches', 'cardInsertTitlePalette');
            wireSwatches('cardInsertBodySwatches', 'cardInsertBodyPalette');

            const typeHidden = document.getElementById('cardInsertType') as HTMLInputElement;
            const typeButtons = document.querySelectorAll<HTMLElement>('#cardInsertTypeToggle button[data-type]');
            const bodyGroup = document.getElementById('cardInsertBodyPaletteGroup');
            const titlePaletteGroup = document.getElementById('cardInsertTitlePaletteGroup');
            const titlePaletteLabel = document.getElementById('cardInsertTitlePaletteLabel');
            const titleLabel = document.getElementById('cardInsertTitleLabel');
            const titleInputEl = document.getElementById('cardInsertTitle') as HTMLInputElement | null;
            const calloutGroup = document.getElementById('cardInsertCalloutTypeGroup');

            function applyType(t: string) {
                typeHidden.value = t;
                typeButtons.forEach(b => b.classList.toggle('active', b.dataset.type === t));
                if (t === 'embed') {
                    if (bodyGroup) bodyGroup.style.display = 'none';
                    if (titlePaletteGroup) titlePaletteGroup.style.display = '';
                    if (calloutGroup) calloutGroup.style.display = 'none';
                    if (titlePaletteLabel) titlePaletteLabel.textContent = '왼쪽 테두리 팔레트';
                    if (titleLabel) titleLabel.textContent = '제목 (선택)';
                    if (titleInputEl) titleInputEl.placeholder = '임베드 제목';
                } else if (t === 'callout') {
                    if (bodyGroup) bodyGroup.style.display = 'none';
                    if (titlePaletteGroup) titlePaletteGroup.style.display = 'none';
                    if (calloutGroup) calloutGroup.style.display = '';
                    if (titleLabel) titleLabel.textContent = '제목 (선택, 비우면 기본 제목)';
                    if (titleInputEl) titleInputEl.placeholder = '예: 백업 필수';
                } else {
                    if (bodyGroup) bodyGroup.style.display = '';
                    if (titlePaletteGroup) titlePaletteGroup.style.display = '';
                    if (calloutGroup) calloutGroup.style.display = 'none';
                    if (titlePaletteLabel) titlePaletteLabel.textContent = '제목 팔레트';
                    if (titleLabel) titleLabel.textContent = '제목';
                    if (titleInputEl) titleInputEl.placeholder = '카드 제목';
                }
            }
            applyType('card');
            typeButtons.forEach(b => b.addEventListener('click', (e) => {
                e.preventDefault();
                applyType(b.dataset.type || 'card');
            }));

            const calloutTypeHidden = document.getElementById('cardInsertCalloutType') as HTMLInputElement | null;
            const calloutChips = document.querySelectorAll<HTMLElement>('#cardInsertCalloutChips .card-insert-callout-chip');
            calloutChips.forEach(chip => {
                chip.addEventListener('click', (e) => {
                    e.preventDefault();
                    const val = chip.dataset.callout || '';
                    if (calloutTypeHidden) calloutTypeHidden.value = val;
                    calloutChips.forEach(c => c.classList.toggle('active', c.dataset.callout === val));
                });
            });
        },
        preConfirm: (): CardInsertResult | false => {
            const type = ((document.getElementById('cardInsertType') as HTMLInputElement | null)?.value || 'card').trim();
            const title = ((document.getElementById('cardInsertTitle') as HTMLInputElement | null)?.value || '')
                .replace(/[\r\n]+/g, ' ')
                .trim();
            const titlePalette = ((document.getElementById('cardInsertTitlePalette') as HTMLInputElement | null)?.value || '').trim();
            const bodyPalette = ((document.getElementById('cardInsertBodyPalette') as HTMLInputElement | null)?.value || '').trim();
            const calloutType = ((document.getElementById('cardInsertCalloutType') as HTMLInputElement | null)?.value || 'info').trim();
            const bodyRaw = ((document.getElementById('cardInsertBody') as HTMLTextAreaElement | null)?.value || '')
                .replace(/\r\n/g, '\n')
                .replace(/\r/g, '\n');
            if (bodyRaw.split('\n').some(l => /^\s*:::/.test(l))) {
                Swal.showValidationMessage('본문에 :::로 시작하는 줄은 블록을 닫아버려 사용할 수 없습니다.');
                return false;
            }
            const body = bodyRaw.replace(/^\n+|\n+$/g, '');
            return { type, title, titlePalette, bodyPalette, calloutType, body };
        }
    }).then(result => {
        if (!result.isConfirmed || !result.value) return;
        const { type, title, titlePalette, bodyPalette, calloutType, body: bodyContent } = result.value;

        let blockType: string;
        if (type === 'embed') blockType = 'embed';
        else if (type === 'callout') blockType = calloutType;
        else blockType = 'card';

        const useTitlePalette = type !== 'callout' && titlePalette;
        const useBodyPalette = type !== 'callout' && type !== 'embed' && bodyPalette;

        const titleTokens = useTitlePalette ? `{palette:${titlePalette}}` : '';
        const titlePart = titleTokens && title ? `${titleTokens} ${title}` : (titleTokens || title);
        const header = titlePart ? `:::${blockType} ${titlePart}` : `:::${blockType}`;

        const bodyText = bodyContent || '내용';
        let body: string;
        if (useBodyPalette) {
            const lines = bodyText.split('\n');
            lines[0] = `{palette:${bodyPalette}}${lines[0]}`;
            body = lines.join('\n');
        } else {
            body = bodyText;
        }

        window.editor?.insertText?.(`${header}\n${body}\n:::`);
        window._cmView?.focus();
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 색상 팔레트 / 커스텀 색상 삽입 모달
// ─────────────────────────────────────────────────────────────────────────────

function openPaletteColorModal(): void {
    const Swal = window.Swal;
    if (!Swal) return;
    const palettes = window.getAllPalettesForEditor?.() ?? [];

    let paletteHtml = `<div class="d-flex flex-wrap gap-2 mb-3">`;
    for (const p of palettes) {
        const bg = window._isSafeCssColor?.(p.variant.bg || '') ? p.variant.bg! : 'transparent';
        const color = window._isSafeCssColor?.(p.variant.color || '') ? p.variant.color! : 'inherit';
        paletteHtml += `<button type="button" class="btn btn-sm palette-insert-btn" data-name="${escapeHtml(p.name)}" style="background:${bg};color:${color};border:1px solid var(--wiki-border);">${escapeHtml(p.name)}</button>`;
    }
    paletteHtml += `</div>`;

    const customHtml = `
                <div class="d-flex gap-3 text-start">
                    <div class="flex-grow-1" style="width: 50%;">
                        <label class="form-label fw-bold">배경색</label>
                        <div id="modalBgSwatches" class="color-modal-swatches mb-2"></div>
                        <canvas id="modalBgCanvas" width="220" height="120" class="color-palette-canvas mt-1" style="width:100%; border:1px solid var(--wiki-border); border-radius:4px;"></canvas>
                        <canvas id="modalBgHue" width="220" height="16" class="color-hue-slider mt-2" style="width:100%; border-radius:4px;"></canvas>
                        <input type="text" id="modalBgHex" class="form-control form-control-sm mt-2" maxlength="7" value="#000000" style="background:var(--wiki-bg);color:var(--wiki-text);border-color:var(--wiki-border);">
                    </div>
                    <div class="flex-grow-1" style="width: 50%;">
                        <div class="d-flex align-items-center justify-content-between mb-1 flex-wrap gap-1">
                            <label class="form-label fw-bold mb-0">글자색</label>
                            <div class="form-check form-switch mb-0" style="font-size:0.8rem;">
                                <input class="form-check-input" type="checkbox" id="modalAutoContrast" checked>
                                <label class="form-check-label" for="modalAutoContrast" style="cursor:pointer;">자동 대비</label>
                            </div>
                        </div>
                        <div id="modalColorSwatches" class="color-modal-swatches mb-2"></div>
                        <canvas id="modalColorCanvas" width="220" height="120" class="color-palette-canvas mt-1" style="width:100%; border:1px solid var(--wiki-border); border-radius:4px;"></canvas>
                        <canvas id="modalColorHue" width="220" height="16" class="color-hue-slider mt-2" style="width:100%; border-radius:4px;"></canvas>
                        <input type="text" id="modalColorHex" class="form-control form-control-sm mt-2" maxlength="7" value="#FFFFFF" style="background:var(--wiki-bg);color:var(--wiki-text);border-color:var(--wiki-border);">
                    </div>
                </div>
                <div class="mt-4 text-center">
                    <div id="modalColorPreview" style="display:inline-block; padding: 12px 24px; font-size: 1.2rem; font-weight: bold; border-radius: 4px; border: 1px solid var(--wiki-border); background-color: #000000; color: #FFFFFF; transition: all 0.2s;">ABC</div>
                </div>
            `;

    const modalHtml = `
                <ul class="nav nav-tabs" id="colorModalTabs" role="tablist">
                    <li class="nav-item" role="presentation">
                        <button class="nav-link active" id="palette-tab" data-bs-toggle="tab" data-bs-target="#palette-pane" type="button" role="tab">팔레트 선택</button>
                    </li>
                    <li class="nav-item" role="presentation">
                        <button class="nav-link" id="custom-tab" data-bs-toggle="tab" data-bs-target="#custom-pane" type="button" role="tab">커스텀 색상</button>
                    </li>
                </ul>
                <div class="tab-content mt-3" id="colorModalTabsContent">
                    <div class="tab-pane fade show active text-start" id="palette-pane" role="tabpanel">
                        <p class="text-muted mb-3" style="font-size: 0.85rem;">원하는 팔레트를 클릭하면 에디터에 삽입됩니다.</p>
                        ${paletteHtml}
                    </div>
                    <div class="tab-pane fade" id="custom-pane" role="tabpanel">
                        ${customHtml}
                    </div>
                </div>
            `;

    interface ColorState { hue: number; saturation: number; brightness: number; hex: string; dragging: string | null; }
    const modalColorState: { bg: ColorState; color: ColorState } = {
        bg: { hue: 0, saturation: 0, brightness: 0, hex: '#000000', dragging: null },
        color: { hue: 0, saturation: 0, brightness: 1, hex: '#FFFFFF', dragging: null }
    };

    const updatePreview = () => {
        const previewBox = document.getElementById('modalColorPreview');
        if (previewBox) {
            previewBox.style.backgroundColor = modalColorState.bg.hex;
            previewBox.style.color = modalColorState.color.hex;
        }
    };

    const drawPalette = (canvasId: string, state: ColorState) => {
        const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const w = canvas.width, h = canvas.height;
        const hsv = window.hsvToHex;
        for (let x = 0; x < w; x++) {
            const s = x / w;
            for (let y = 0; y < h; y++) {
                const v = 1 - y / h;
                ctx.fillStyle = hsv ? hsv(state.hue, s, v) : '#000';
                ctx.fillRect(x, y, 1, 1);
            }
        }
        const cx = state.saturation * w;
        const cy = (1 - state.brightness) * h;
        ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
    };

    const drawHue = (canvasId: string, state: ColorState) => {
        const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const w = canvas.width, h = canvas.height;
        const hsv = window.hsvToHex;
        const gradient = ctx.createLinearGradient(0, 0, w, 0);
        for (let i = 0; i <= 6; i++) gradient.addColorStop(i / 6, hsv ? hsv(i * 60, 1, 1) : '#000');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, w, h);
        const cx = (state.hue / 360) * w;
        ctx.beginPath(); ctx.rect(cx - 3, 0, 6, h); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath(); ctx.rect(cx - 4, -1, 8, h + 2); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
    };

    const wcagContrastHex = (hex: string): string => {
        const h = hex.replace('#', '');
        const toLinear = (c: number): number => {
            c = c / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        };
        const r = toLinear(parseInt(h.substring(0, 2), 16));
        const g = toLinear(parseInt(h.substring(2, 4), 16));
        const b = toLinear(parseInt(h.substring(4, 6), 16));
        const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        return L > 0.179 ? '#000000' : '#FFFFFF';
    };

    const isAutoContrastOn = (): boolean => {
        const cb = document.getElementById('modalAutoContrast') as HTMLInputElement | null;
        return cb ? cb.checked : false;
    };

    const applyAutoContrast = () => {
        const contrastHex = wcagContrastHex(modalColorState.bg.hex);
        const hsv = window.hexToHsv ? window.hexToHsv(contrastHex) : { h: 0, s: 0, v: contrastHex === '#FFFFFF' ? 1 : 0 };
        modalColorState.color.hue = hsv.h;
        modalColorState.color.saturation = hsv.s;
        modalColorState.color.brightness = hsv.v;
        updateUI('color');
    };

    const updateUI = (type: 'bg' | 'color') => {
        const state = modalColorState[type];
        const hsv = window.hsvToHex;
        state.hex = (hsv ? hsv(state.hue, state.saturation, state.brightness) : '#000000').toUpperCase();
        drawPalette(`modal${type === 'bg' ? 'Bg' : 'Color'}Canvas`, state);
        drawHue(`modal${type === 'bg' ? 'Bg' : 'Color'}Hue`, state);
        const hexInput = document.getElementById(`modal${type === 'bg' ? 'Bg' : 'Color'}Hex`) as HTMLInputElement | null;
        if (hexInput) hexInput.value = state.hex;
        updatePreview();
        if (type === 'bg' && isAutoContrastOn()) applyAutoContrast();
    };

    const setColorControlsDisabled = (disabled: boolean) => {
        ['modalColorSwatches', 'modalColorCanvas', 'modalColorHue'].forEach(id => {
            const el = document.getElementById(id) as HTMLElement | null;
            if (!el) return;
            el.style.pointerEvents = disabled ? 'none' : '';
            el.style.opacity = disabled ? '0.5' : '';
        });
        const hexInput = document.getElementById('modalColorHex') as HTMLInputElement | null;
        if (hexInput) {
            hexInput.disabled = disabled;
            hexInput.style.opacity = disabled ? '0.5' : '';
        }
    };

    const SWATCHES = [
        '#000000', '#FFFFFF', '#FF0000', '#FF8000', '#FFFF00',
        '#00FF00', '#00FFFF', '#0080FF', '#0000FF', '#8000FF',
        '#FF00FF', '#FF0080', '#808080', '#C0C0C0'
    ];

    Swal.fire<string>({
        title: '<i class="mdi mdi-palette-outline me-2"></i>색상 삽입',
        width: 650,
        html: modalHtml,
        showCancelButton: true,
        confirmButtonText: '삽입',
        cancelButtonText: '취소',
        didOpen: () => {
            const confirmBtn = Swal.getConfirmButton();
            if (confirmBtn) confirmBtn.style.display = 'none';

            const tabElements = document.querySelectorAll<HTMLElement>('#colorModalTabs button[data-bs-toggle="tab"]');
            tabElements.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    tabElements.forEach(b => {
                        b.classList.remove('active');
                        const targetSel = b.dataset.bsTarget;
                        if (targetSel) {
                            const target = document.querySelector(targetSel);
                            if (target) target.classList.remove('show', 'active');
                        }
                    });
                    btn.classList.add('active');
                    const activeTargetSel = btn.dataset.bsTarget;
                    if (activeTargetSel) {
                        const activeTarget = document.querySelector(activeTargetSel);
                        if (activeTarget) activeTarget.classList.add('show', 'active');
                    }

                    if (confirmBtn) {
                        confirmBtn.style.display = btn.id === 'palette-tab' ? 'none' : 'inline-block';
                    }
                });
            });

            document.querySelectorAll<HTMLElement>('.palette-insert-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const paletteName = btn.dataset.name || '';
                    Swal.close();
                    const editor = window.editor;
                    if (editor) {
                        editor.insertText?.(`{palette:${paletteName}}`);
                        window._cmView?.focus();
                    }
                });
            });

            (['bg', 'color'] as const).forEach(type => {
                const prefix = type === 'bg' ? 'Bg' : 'Color';
                const paletteCanvas = document.getElementById(`modal${prefix}Canvas`) as HTMLCanvasElement | null;
                const hueCanvas = document.getElementById(`modal${prefix}Hue`) as HTMLCanvasElement | null;
                const hexInput = document.getElementById(`modal${prefix}Hex`) as HTMLInputElement | null;
                const swatchContainer = document.getElementById(`modal${prefix}Swatches`);
                const state = modalColorState[type];

                if (swatchContainer) {
                    swatchContainer.innerHTML = SWATCHES.map(color =>
                        `<div class="color-modal-swatch" style="background:${color};" title="${color}" data-color="${color}"></div>`
                    ).join('');
                    swatchContainer.querySelectorAll<HTMLElement>('.color-modal-swatch').forEach(sw => {
                        sw.addEventListener('click', (e) => {
                            e.preventDefault();
                            const hsv = window.hexToHsv ? window.hexToHsv(sw.dataset.color || '#000000') : { h: 0, s: 0, v: 0 };
                            state.hue = hsv.h;
                            state.saturation = hsv.s;
                            state.brightness = hsv.v;
                            updateUI(type);
                        });
                    });
                }

                function getPos(canvas: HTMLCanvasElement, e: MouseEvent | TouchEvent) {
                    const rect = canvas.getBoundingClientRect();
                    let cx: number, cy: number;
                    const touchEvent = e as TouchEvent;
                    if (touchEvent.touches && touchEvent.touches.length > 0) {
                        cx = touchEvent.touches[0].clientX;
                        cy = touchEvent.touches[0].clientY;
                    } else {
                        const mouseEvent = e as MouseEvent;
                        cx = mouseEvent.clientX;
                        cy = mouseEvent.clientY;
                    }
                    return {
                        x: Math.max(0, Math.min(1, (cx - rect.left) / rect.width)),
                        y: Math.max(0, Math.min(1, (cy - rect.top) / rect.height))
                    };
                }

                const handlePalette = (e: MouseEvent | TouchEvent) => {
                    if (!paletteCanvas) return;
                    const pos = getPos(paletteCanvas, e);
                    state.saturation = pos.x;
                    state.brightness = 1 - pos.y;
                    updateUI(type);
                };

                const handleHue = (e: MouseEvent | TouchEvent) => {
                    if (!hueCanvas) return;
                    const pos = getPos(hueCanvas, e);
                    state.hue = pos.x * 360;
                    updateUI(type);
                };

                if (paletteCanvas) {
                    paletteCanvas.addEventListener('mousedown', (e) => { e.preventDefault(); state.dragging = 'palette'; handlePalette(e); });
                    paletteCanvas.addEventListener('touchstart', (e) => { e.preventDefault(); state.dragging = 'palette'; handlePalette(e); }, { passive: false });
                }
                if (hueCanvas) {
                    hueCanvas.addEventListener('mousedown', (e) => { e.preventDefault(); state.dragging = 'hue'; handleHue(e); });
                    hueCanvas.addEventListener('touchstart', (e) => { e.preventDefault(); state.dragging = 'hue'; handleHue(e); }, { passive: false });
                }

                document.addEventListener('mousemove', (e) => {
                    if (state.dragging === 'palette') handlePalette(e);
                    else if (state.dragging === 'hue') handleHue(e);
                });
                document.addEventListener('touchmove', (e) => {
                    if (state.dragging === 'palette') { e.preventDefault(); handlePalette(e); }
                    else if (state.dragging === 'hue') { e.preventDefault(); handleHue(e); }
                }, { passive: false });

                document.addEventListener('mouseup', () => { state.dragging = null; });
                document.addEventListener('touchend', () => { state.dragging = null; });

                if (hexInput) {
                    hexInput.addEventListener('input', () => {
                        const val = hexInput.value.trim();
                        if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
                            const hsv = window.hexToHsv ? window.hexToHsv(val) : { h: 0, s: 0, v: 0 };
                            state.hue = hsv.h;
                            state.saturation = hsv.s;
                            state.brightness = hsv.v;
                            updateUI(type);
                        }
                    });
                }

                updateUI(type);
            });

            const autoContrastCb = document.getElementById('modalAutoContrast') as HTMLInputElement | null;
            if (autoContrastCb) {
                autoContrastCb.addEventListener('change', () => {
                    setColorControlsDisabled(autoContrastCb.checked);
                    if (autoContrastCb.checked) applyAutoContrast();
                });
                setColorControlsDisabled(autoContrastCb.checked);
                if (autoContrastCb.checked) applyAutoContrast();
            }
        },
        preConfirm: () => {
            const activeTab = document.querySelector('#colorModalTabs button.active');
            if (activeTab && activeTab.id === 'palette-tab') {
                return false;
            }

            const bgHex = ((document.getElementById('modalBgHex') as HTMLInputElement | null)?.value || '').trim();
            const colorHex = ((document.getElementById('modalColorHex') as HTMLInputElement | null)?.value || '').trim();

            if (!/^#[0-9A-Fa-f]{6}$/.test(bgHex) || !/^#[0-9A-Fa-f]{6}$/.test(colorHex)) {
                Swal.showValidationMessage('유효한 색상 코드(Hex)를 입력하세요.');
                return false;
            }

            return `{bg:${bgHex.toUpperCase()}}{color:${colorHex.toUpperCase()}}`;
        }
    }).then(result => {
        if (result.isConfirmed && result.value) {
            const editor = window.editor;
            if (editor) {
                editor.insertText?.(result.value);
                window._cmView?.focus();
            }
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 배지 / 태그 / 스탯 / 버튼 삽입 모달
// ─────────────────────────────────────────────────────────────────────────────

function openBadgeInsertModal(): void {
    openComponentInsertModal();
}

interface BadgeIcon { type: 'bi' | 'mdi'; name: string; }
interface BadgeState {
    type: 'badge' | 'tag' | 'stat' | 'button';
    palette: string;
    text: string;
    label: string;
    url: string;
    icon: BadgeIcon | null;
    iconType: 'bi' | 'mdi' | null;
    iconQuery: string;
    iconList: string[] | null;
}

function openComponentInsertModal(): void {
    const Swal = window.Swal;
    if (!Swal) return;
    const palettes = window.getAllPalettesForEditor?.() ?? [];

    const state: BadgeState = {
        type: 'badge',
        palette: '',
        text: '',
        label: '',
        url: '',
        icon: null,
        iconType: null,
        iconQuery: '',
        iconList: null,
    };

    const TYPE_META: Record<string, { label: string; icon: string }> = {
        badge: { label: '배지', icon: 'mdi mdi-label-outline' },
        tag: { label: '태그', icon: 'mdi mdi-tag-outline' },
        stat: { label: '스탯', icon: 'mdi mdi-chart-box-outline' },
        button: { label: '버튼', icon: 'mdi mdi-gesture-tap-button' },
    };

    function paletteSwatchesHtml(): string {
        let html = `<button type="button" class="badge-insert-palette-swatch" data-palette="" title="선택 안 함">
                    <span class="badge-insert-palette-swatch-none">없음</span>
                </button>`;
        for (const p of palettes) {
            const bg = window._isSafeCssColor?.(p.variant.bg || '') ? p.variant.bg! : 'transparent';
            const color = window._isSafeCssColor?.(p.variant.color || '') ? p.variant.color! : 'inherit';
            html += `<button type="button" class="badge-insert-palette-swatch" data-palette="${escapeHtml(p.name)}" title="${escapeHtml(p.name)}" style="background:${bg};color:${color};">${escapeHtml(p.name)}</button>`;
        }
        return html;
    }

    function typeTabsHtml(): string {
        return Object.entries(TYPE_META).map(([key, m]) => {
            const active = state.type === key ? ' active' : '';
            return `<button type="button" class="badge-insert-type-tab${active}" data-type="${key}">
                        <i class="${m.icon}"></i>
                        <span>${m.label}</span>
                    </button>`;
        }).join('');
    }

    function iconFieldHtml(): string {
        const hasIcon = !!state.icon;
        const iconPreview = hasIcon && state.icon
            ? (state.icon.type === 'bi'
                ? `<i class="bi bi-${escapeHtml(state.icon.name)}"></i>`
                : `<span class="mdi mdi-${escapeHtml(state.icon.name)}"></span>`)
            : `<span class="badge-insert-icon-placeholder">없음</span>`;
        const iconLabel = hasIcon && state.icon ? `${state.icon.type}:${state.icon.name}` : '아이콘 선택 안 함';
        return `
                        <div class="badge-insert-field">
                            <label class="form-label">아이콘</label>
                            <div class="badge-insert-icon-row">
                                <div class="badge-insert-icon-preview" aria-hidden="true">${iconPreview}</div>
                                <div class="badge-insert-icon-label">${escapeHtml(iconLabel)}</div>
                                <button type="button" id="badgeInsertIconPickBtn" class="badge-insert-icon-btn">
                                    <i class="mdi mdi-vector-square"></i>
                                    <span>${hasIcon ? '변경' : '선택'}</span>
                                </button>
                                ${hasIcon ? `<button type="button" id="badgeInsertIconClearBtn" class="badge-insert-icon-btn badge-insert-icon-btn-ghost" title="아이콘 제거">
                                    <i class="mdi mdi-close"></i>
                                </button>` : ''}
                            </div>
                        </div>`;
    }

    function fieldsHtml(): string {
        if (state.type === 'stat') {
            return `
                        <div class="badge-insert-field-row">
                            <div class="badge-insert-field">
                                <label class="form-label" for="badgeInsertText">값</label>
                                <input type="text" id="badgeInsertText" class="form-control form-control-sm"
                                    placeholder="예: 42" autocomplete="off" value="${escapeHtml(state.text)}"
                                    style="background:var(--wiki-bg);color:var(--wiki-text);border-color:var(--wiki-border);">
                            </div>
                            <div class="badge-insert-field">
                                <label class="form-label" for="badgeInsertLabel">라벨</label>
                                <input type="text" id="badgeInsertLabel" class="form-control form-control-sm"
                                    placeholder="예: 완료" autocomplete="off" value="${escapeHtml(state.label)}"
                                    style="background:var(--wiki-bg);color:var(--wiki-text);border-color:var(--wiki-border);">
                            </div>
                        </div>
                        ${iconFieldHtml()}`;
        }
        if (state.type === 'button') {
            return `
                        <div class="badge-insert-field">
                            <label class="form-label" for="badgeInsertText">제목</label>
                            <input type="text" id="badgeInsertText" class="form-control form-control-sm"
                                placeholder="버튼 제목" autocomplete="off" value="${escapeHtml(state.text)}"
                                style="background:var(--wiki-bg);color:var(--wiki-text);border-color:var(--wiki-border);">
                        </div>
                        <div class="badge-insert-field">
                            <label class="form-label" for="badgeInsertUrl">링크</label>
                            <input type="text" id="badgeInsertUrl" class="form-control form-control-sm"
                                placeholder="https://example.com 또는 /w/문서이름" autocomplete="off" value="${escapeHtml(state.url)}"
                                style="background:var(--wiki-bg);color:var(--wiki-text);border-color:var(--wiki-border);">
                        </div>
                        ${iconFieldHtml()}`;
        }
        const placeholder = state.type === 'tag' ? '예: Beta' : '예: NEW';
        return `
                    <div class="badge-insert-field">
                        <label class="form-label" for="badgeInsertText">텍스트</label>
                        <input type="text" id="badgeInsertText" class="form-control form-control-sm"
                            placeholder="${placeholder}" autocomplete="off" value="${escapeHtml(state.text)}"
                            style="background:var(--wiki-bg);color:var(--wiki-text);border-color:var(--wiki-border);">
                    </div>
                    ${iconFieldHtml()}`;
    }

    function buildToken(): string {
        const onlyIcons = window.selectedIconsOnly ?? false;
        const palettePrefix = state.palette ? `{palette:${state.palette}}` : '';
        const iconPrefix = state.icon ? (onlyIcons ? `{icon:${state.icon.type}-${state.icon.name}}` : `{${state.icon.type}:${state.icon.name}}`) : '';
        const text = (state.text || '').trim();
        if (state.type === 'badge') {
            if (!text) return '';
            return `${palettePrefix}${iconPrefix}{badge:${text}}`;
        }
        if (state.type === 'tag') {
            if (!text) return '';
            return `${palettePrefix}${iconPrefix}{tag:${text}}`;
        }
        if (state.type === 'stat') {
            if (!text) return '';
            const lbl = (state.label || '').trim();
            const payload = lbl ? `${text}|${lbl}` : text;
            return `${palettePrefix}${iconPrefix}{stat:${payload}}`;
        }
        if (state.type === 'button') {
            const url = (state.url || '').trim();
            if (!text || !url) return '';
            return `${palettePrefix}${iconPrefix}{button:${text}|${url}}`;
        }
        return '';
    }

    function updatePreview() {
        const preview = document.getElementById('badgeInsertPreview');
        if (!preview) return;
        const token = buildToken();
        if (!token) {
            preview.innerHTML = `<span class="badge-insert-preview-empty">필수 입력을 채우면 미리보기가 표시됩니다.</span>`;
            return;
        }
        try {
            const proc = window._processInlineLayoutTokens;
            if (typeof proc === 'function') {
                preview.innerHTML = proc(token);
            } else {
                preview.textContent = token;
            }
        } catch (e) {
            preview.textContent = token;
        }
    }

    function validate(): boolean {
        const err = document.getElementById('badgeInsertValidation');
        const text = (state.text || '').trim();
        const invalidChars = /[|\}\{\r\n]/;
        let message = '';

        if (state.type === 'badge' || state.type === 'tag') {
            if (!text) message = '텍스트를 입력해주세요.';
            else if (invalidChars.test(text)) message = '텍스트에 {, }, |, 줄바꿈 문자를 사용할 수 없습니다.';
        } else if (state.type === 'stat') {
            const lbl = (state.label || '').trim();
            if (!text) message = '값을 입력해주세요.';
            else if (invalidChars.test(text) || invalidChars.test(lbl)) message = '값/라벨에 {, }, |, 줄바꿈 문자를 사용할 수 없습니다.';
        } else if (state.type === 'button') {
            const url = (state.url || '').trim();
            if (!text) message = '제목을 입력해주세요.';
            else if (!url) message = '링크를 입력해주세요.';
            else if (invalidChars.test(text)) message = '제목에 {, }, |, 줄바꿈 문자를 사용할 수 없습니다.';
            else if (invalidChars.test(url)) message = '링크에 {, }, |, 줄바꿈 문자를 사용할 수 없습니다. (|는 %7C로 URL 인코딩하세요)';
        }

        if (err) err.textContent = message;
        return message === '';
    }

    function renderFormView() {
        const root = document.getElementById('badgeInsertRoot');
        if (!root) return;
        root.innerHTML = `
                    <div class="badge-insert-form text-start">
                        <div class="mb-3">
                            <label class="form-label">종류</label>
                            <div class="badge-insert-type-tabs">${typeTabsHtml()}</div>
                        </div>
                        <div class="mb-3">
                            <label class="form-label">팔레트</label>
                            <div id="badgeInsertPaletteSwatches" class="badge-insert-palette-swatches"></div>
                        </div>
                        <div id="badgeInsertFields" class="mb-3">${fieldsHtml()}</div>
                        <div class="mb-2">
                            <label class="form-label">미리보기</label>
                            <div id="badgeInsertPreview" class="badge-insert-preview"></div>
                        </div>
                        <div id="badgeInsertValidation" class="badge-insert-validation"></div>
                    </div>
                `;

        root.querySelectorAll<HTMLElement>('.badge-insert-type-tab').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const newType = btn.dataset.type as BadgeState['type'] | undefined;
                if (!newType || newType === state.type) return;
                state.type = newType;
                renderFormView();
            });
        });

        const swatchesEl = document.getElementById('badgeInsertPaletteSwatches');
        if (swatchesEl) {
            swatchesEl.innerHTML = paletteSwatchesHtml();
            swatchesEl.querySelectorAll<HTMLElement>('.badge-insert-palette-swatch').forEach(sw => {
                if ((sw.dataset.palette || '') === (state.palette || '')) {
                    sw.classList.add('active');
                }
                sw.addEventListener('click', (e) => {
                    e.preventDefault();
                    state.palette = sw.dataset.palette || '';
                    swatchesEl.querySelectorAll<HTMLElement>('.badge-insert-palette-swatch').forEach(s => {
                        s.classList.toggle('active', (s.dataset.palette || '') === state.palette);
                    });
                    updatePreview();
                });
            });
        }

        const textInput = document.getElementById('badgeInsertText') as HTMLInputElement | null;
        if (textInput) {
            textInput.addEventListener('input', () => {
                state.text = textInput.value;
                updatePreview();
                validate();
            });
        }
        const labelInput = document.getElementById('badgeInsertLabel') as HTMLInputElement | null;
        if (labelInput) {
            labelInput.addEventListener('input', () => {
                state.label = labelInput.value;
                updatePreview();
                validate();
            });
        }
        const urlInput = document.getElementById('badgeInsertUrl') as HTMLInputElement | null;
        if (urlInput) {
            urlInput.addEventListener('input', () => {
                state.url = urlInput.value;
                updatePreview();
                validate();
            });
        }

        const iconPickBtn = document.getElementById('badgeInsertIconPickBtn');
        if (iconPickBtn) {
            iconPickBtn.addEventListener('click', (e) => {
                e.preventDefault();
                renderIconView();
            });
        }
        const iconClearBtn = document.getElementById('badgeInsertIconClearBtn');
        if (iconClearBtn) {
            iconClearBtn.addEventListener('click', (e) => {
                e.preventDefault();
                state.icon = null;
                renderFormView();
            });
        }

        updatePreview();
        validate();
        if (textInput && !state.text) {
            setTimeout(() => textInput.focus(), 0);
        }
    }

    async function ensureIconList(): Promise<string[]> {
        const onlyIcons = window.selectedIconsOnly ?? false;
        if (onlyIcons) {
            if (state.iconList) return state.iconList;
            try {
                state.iconList = await loadSelectedIcons();
            } catch (e) {
                state.iconList = [];
            }
            return state.iconList;
        } else {
            if (state.iconType === 'bi') {
                try {
                    const list = await loadBiIcons();
                    state.iconList = list.map(n => 'bi-' + n);
                } catch (e) { state.iconList = []; }
            } else if (state.iconType === 'mdi') {
                try {
                    const list = await loadMdiIcons();
                    state.iconList = list.map(n => 'mdi-' + n);
                } catch (e) { state.iconList = []; }
            } else {
                state.iconList = [];
            }
            return state.iconList;
        }
    }

    function renderIconGrid() {
        const gridEl = document.getElementById('badgeInsertIconGrid');
        const emptyEl = document.getElementById('badgeInsertIconEmpty');
        if (!gridEl || !emptyEl) return;
        const filtered = filterIcons(state.iconList || [], state.iconQuery);
        gridEl.innerHTML = '';
        if (filtered.length === 0) {
            emptyEl.style.display = 'block';
            return;
        }
        emptyEl.style.display = 'none';

        let renderIndex = 0;
        const batchSize = 200;

        function appendItems() {
            const end = Math.min(renderIndex + batchSize, filtered.length);
            const slice = filtered.slice(renderIndex, end);
            const SAFE_ICON_NAME = /^[\w-]+$/;
            slice.forEach(fullName => {
                let type: 'bi' | 'mdi', iconName: string;
                if (fullName.startsWith('bi-')) {
                    type = 'bi';
                    iconName = fullName.slice(3);
                } else if (fullName.startsWith('mdi-')) {
                    type = 'mdi';
                    iconName = fullName.slice(4);
                } else {
                    return;
                }
                if (!SAFE_ICON_NAME.test(iconName)) return;
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'icon-grid-modal-item';
                item.title = fullName;
                const iconEl = document.createElement('i');
                iconEl.classList.add(type, `${type}-${iconName}`);
                const labelEl = document.createElement('span');
                labelEl.textContent = fullName;
                item.appendChild(iconEl);
                item.appendChild(labelEl);
                item.addEventListener('click', () => {
                    state.icon = { type, name: iconName };
                    renderFormView();
                });
                gridEl!.appendChild(item);
            });
            renderIndex = end;
        }

        gridEl.onscroll = () => {
            if (gridEl.scrollTop + gridEl.clientHeight >= gridEl.scrollHeight - 50) {
                if (renderIndex < filtered.length) {
                    appendItems();
                }
            }
        };

        appendItems();
    }

    async function renderIconView() {
        const root = document.getElementById('badgeInsertRoot');
        if (!root) return;
        const onlyIcons = window.selectedIconsOnly ?? false;

        if (!onlyIcons && !state.iconType) {
            root.innerHTML = `
                        <div class="badge-insert-icon-view text-start">
                            <div class="badge-insert-icon-toolbar" style="margin-bottom: 24px;">
                                <button type="button" id="badgeInsertIconBackType" class="badge-insert-back-btn">
                                    <i class="mdi mdi-arrow-left"></i>
                                    <span>돌아가기</span>
                                </button>
                            </div>
                            <h5 class="text-center mb-4" style="color:var(--wiki-text);">아이콘 라이브러리 선택</h5>
                            <div class="d-flex gap-3 justify-content-center pb-4">
                                <button type="button" class="btn btn-outline-secondary d-flex flex-column align-items-center p-4 badge-insert-type-select-btn" data-type="mdi" style="width:160px; border-color:var(--wiki-border); color:var(--wiki-text); background:var(--wiki-bg);">
                                    <i class="mdi mdi-material-design" style="font-size:2.5rem; margin-bottom:8px;"></i>
                                    <span>MDI 아이콘</span>
                                </button>
                                <button type="button" class="btn btn-outline-secondary d-flex flex-column align-items-center p-4 badge-insert-type-select-btn" data-type="bi" style="width:160px; border-color:var(--wiki-border); color:var(--wiki-text); background:var(--wiki-bg);">
                                    <i class="bi bi-bootstrap-fill" style="font-size:2.5rem; margin-bottom:8px;"></i>
                                    <span>Bootstrap 아이콘</span>
                                </button>
                            </div>
                        </div>
                    `;
            document.getElementById('badgeInsertIconBackType')?.addEventListener('click', (e) => {
                e.preventDefault();
                renderFormView();
            });
            root.querySelectorAll<HTMLElement>('.badge-insert-type-select-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    state.iconType = (btn.dataset.type as 'bi' | 'mdi') || null;
                    state.iconList = null;
                    renderIconView();
                });
            });
            return;
        }

        root.innerHTML = `
                    <div class="badge-insert-icon-view text-start">
                        <div class="badge-insert-icon-toolbar">
                            <button type="button" id="badgeInsertIconBack" class="badge-insert-back-btn">
                                <i class="mdi mdi-arrow-left"></i>
                                <span>${!onlyIcons ? '라이브러리 변경' : '돌아가기'}</span>
                            </button>
                            <input type="text" id="badgeInsertIconSearch" class="form-control form-control-sm"
                                placeholder="아이콘 이름 검색..." value="${escapeHtml(state.iconQuery)}"
                                style="background:var(--wiki-bg);color:var(--wiki-text);border-color:var(--wiki-border);">
                        </div>
                        <div id="badgeInsertIconLoading" class="text-center py-4" style="display:none;">
                            <span class="spinner-border spinner-border-sm text-primary" role="status"></span>
                            <p class="mt-2 text-muted small mb-0">아이콘 목록 로딩 중...</p>
                        </div>
                        <div id="badgeInsertIconGrid" class="icon-grid-modal badge-insert-icon-grid"></div>
                        <div id="badgeInsertIconEmpty" class="text-center text-muted py-3" style="display:none;">
                            <i class="mdi mdi-magnify-close" style="font-size:1.6rem;"></i>
                            <p class="mt-1 mb-0 small">검색 결과가 없습니다.</p>
                        </div>
                    </div>
                `;

        const backBtn = document.getElementById('badgeInsertIconBack');
        if (backBtn) {
            backBtn.addEventListener('click', (e) => {
                e.preventDefault();
                if (!onlyIcons) {
                    state.iconType = null;
                    state.iconQuery = '';
                    renderIconView();
                } else {
                    renderFormView();
                }
            });
        }
        const searchInput = document.getElementById('badgeInsertIconSearch') as HTMLInputElement | null;
        const loadingEl = document.getElementById('badgeInsertIconLoading');
        let searchTimer: number | undefined;
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                clearTimeout(searchTimer);
                searchTimer = window.setTimeout(() => {
                    state.iconQuery = searchInput.value;
                    renderIconGrid();
                }, 150);
            });
            setTimeout(() => searchInput.focus(), 0);
        }

        if (!state.iconList) {
            if (loadingEl) loadingEl.style.display = 'block';
            await ensureIconList();
            if (!document.getElementById('badgeInsertIconGrid')) return;
            if (loadingEl) loadingEl.style.display = 'none';
        }
        renderIconGrid();
    }

    Swal.fire<string>({
        title: '<i class="mdi mdi-label-multiple-outline me-2"></i>배지 삽입',
        width: 640,
        html: '<div id="badgeInsertRoot"></div>',
        showCancelButton: true,
        confirmButtonText: '삽입',
        cancelButtonText: '취소',
        focusConfirm: false,
        didOpen: () => {
            renderFormView();
        },
        preConfirm: () => {
            if (!validate()) return false;
            const token = buildToken();
            if (!token) {
                const err = document.getElementById('badgeInsertValidation');
                if (err) err.textContent = '필수 입력을 채워주세요.';
                return false;
            }
            return token;
        }
    }).then(result => {
        if (!result.isConfirmed || !result.value) return;
        const editor = window.editor;
        if (editor) {
            editor.insertText?.(result.value);
            window._cmView?.focus();
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 하위 문서 구조 삽입 모달
// ─────────────────────────────────────────────────────────────────────────────

interface SubdocSuggestion { slug: string; }
interface SubdocItem { slug: string; }
interface SubdocTreeNode {
    _children: Record<string, SubdocTreeNode>;
    _doc: SubdocItem | null;
    _descendants?: number;
}

async function openSubdocInsertModal(): Promise<void> {
    const Swal = window.Swal;
    if (!Swal) return;
    let subdocSelectedSlug: string | null = null;
    let subdocPreviewText = '';
    let subdocDebounceTimer: number | undefined;
    let subdocActiveIdx = -1;

    const result = await Swal.fire<string>({
        title: '<i class="bi bi-diagram-3-fill me-2"></i>하위 문서 구조 삽입',
        html: `
                <div class="text-start">
                    <label class="form-label">문서 검색</label>
                    <input type="text" id="subdocSearchInput" class="form-control"
                        placeholder="문서 제목 입력..." autocomplete="off">
                    <ul id="subdocSuggestions" class="list-unstyled mt-1 mb-0 border rounded"
                        style="display:none; padding:4px 0; max-height:none; background: var(--wiki-card-bg); border-color: var(--wiki-border) !important;"></ul>
                    <div id="subdocPreview" class="mt-3" style="display:none;">
                        <label class="form-label text-muted small">미리보기</label>
                        <pre id="subdocPreviewContent"
                            class="border rounded p-2 small"
                            style="max-height:200px;overflow-y:auto;font-size:0.85rem;margin:0;text-align:left; background: var(--wiki-code-bg); border-color: var(--wiki-border) !important; color: var(--wiki-text);"></pre>
                        </div>
                        </div>
                        `,
        width: 600,
        showCancelButton: true,
        cancelButtonText: '취소',
        confirmButtonText: '삽입',
        didOpen: () => {
            const confirmBtn = Swal.getConfirmButton();
            if (confirmBtn) confirmBtn.disabled = true;

            const input = document.getElementById('subdocSearchInput') as HTMLInputElement | null;
            const sugBox = document.getElementById('subdocSuggestions') as HTMLElement | null;
            if (!input || !sugBox) return;

            input.addEventListener('input', function () {
                clearTimeout(subdocDebounceTimer);
                const q = this.value.trim();
                if (q.length < 2) {
                    sugBox.style.display = 'none';
                    sugBox.innerHTML = '';
                    return;
                }
                subdocDebounceTimer = window.setTimeout(() => fetchSubdocSuggestions(q), 250);
            });

            async function fetchSubdocSuggestions(q: string) {
                try {
                    const res = await fetch('/api/search/suggest?q=' + encodeURIComponent(q));
                    if (!res.ok) return;
                    const data = await res.json() as { suggestions?: SubdocSuggestion[] };
                    renderSubdocSuggestions(data.suggestions || []);
                } catch (e) { /* ignore */ }
            }

            function renderSubdocSuggestions(items: SubdocSuggestion[]) {
                subdocActiveIdx = -1;
                const filtered = items.filter(item => !item.slug.includes(':'));
                if (!filtered.length) {
                    sugBox!.style.display = 'none';
                    sugBox!.innerHTML = '';
                    return;
                }
                sugBox!.innerHTML = filtered.map((item) =>
                    '<li class="search-suggestion-item" data-slug="' + escapeHtml(item.slug) +
                    '" data-title="' + escapeHtml(item.slug) + '">' +
                    '<i class="mdi mdi-file-document-outline"></i> ' +
                    escapeHtml(item.slug) + '</li>'
                ).join('');
                sugBox!.style.display = 'block';
                sugBox!.querySelectorAll<HTMLElement>('.search-suggestion-item').forEach(el => {
                    el.addEventListener('mousedown', function (e) {
                        e.preventDefault();
                        selectSubdocItem(el.dataset.slug || '', el.dataset.title || '');
                    });
                });
            }

            function selectSubdocItem(slug: string, title: string) {
                subdocSelectedSlug = slug;
                input!.value = title;
                sugBox!.style.display = 'none';
                sugBox!.innerHTML = '';
                loadSubdocPreview(slug);
            }

            input.addEventListener('keydown', function (e) {
                const items = sugBox!.querySelectorAll<HTMLElement>('.search-suggestion-item');
                if (sugBox!.style.display !== 'none' && items.length) {
                    if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        subdocActiveIdx = Math.min(subdocActiveIdx + 1, items.length - 1);
                        items.forEach((el, i) => el.classList.toggle('active', i === subdocActiveIdx));
                    } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        subdocActiveIdx = Math.max(subdocActiveIdx - 1, -1);
                        items.forEach((el, i) => el.classList.toggle('active', i === subdocActiveIdx));
                    } else if (e.key === 'Enter' && subdocActiveIdx >= 0) {
                        e.preventDefault();
                        const el = items[subdocActiveIdx];
                        selectSubdocItem(el.dataset.slug || '', el.dataset.title || '');
                    } else if (e.key === 'Escape') {
                        sugBox!.style.display = 'none';
                    }
                }
            });

            input.addEventListener('blur', function () {
                setTimeout(() => { sugBox!.style.display = 'none'; }, 150);
            });

            input.focus();

            async function loadSubdocPreview(slug: string) {
                try {
                    const res = await fetch('/api/w/' + encodeURIComponent(slug) + '/subdocs');
                    const data = await res.json() as { subdocs?: SubdocItem[] };
                    const subdocs = data.subdocs || [];

                    const tree: Record<string, SubdocTreeNode> = {};
                    for (const doc of subdocs) {
                        const relative = doc.slug.substring(slug.length + 1);
                        const parts = relative.split('/');
                        let node: Record<string, SubdocTreeNode> = tree;
                        for (const part of parts) {
                            if (!node[part]) node[part] = { _children: {}, _doc: null };
                            node = node[part]._children;
                        }
                        let target: Record<string, SubdocTreeNode> = tree;
                        for (let i = 0; i < parts.length; i++) {
                            if (i === parts.length - 1) {
                                target[parts[i]]._doc = doc;
                            } else {
                                target = target[parts[i]]._children;
                            }
                        }
                    }

                    function annotateDescendants(children: Record<string, SubdocTreeNode>): number {
                        let total = 0;
                        for (const key of Object.keys(children)) {
                            const sub = annotateDescendants(children[key]._children);
                            children[key]._descendants = sub;
                            total += 1 + sub;
                        }
                        return total;
                    }
                    annotateDescendants(tree);

                    function renderTree(nodes: Record<string, SubdocTreeNode>, parentPrefix: string): string {
                        const entries = Object.keys(nodes).sort((a, b) => {
                            const ca = nodes[a]._descendants ?? 0;
                            const cb = nodes[b]._descendants ?? 0;
                            if (ca !== cb) return ca - cb;
                            return a.localeCompare(b);
                        });
                        let text = '';
                        entries.forEach((key, idx) => {
                            const node = nodes[key];
                            const isLast = idx === entries.length - 1;
                            const connector = isLast ? '└── ' : '├── ';
                            const childPrefix = parentPrefix + (isLast ? '    ' : '│   ');
                            if (node._doc) {
                                text += parentPrefix + connector + '[[' + node._doc.slug + '|' + key + ']]\n';
                            } else {
                                text += parentPrefix + connector + key + '\n';
                            }
                            if (Object.keys(node._children).length > 0) {
                                text += renderTree(node._children, childPrefix);
                            }
                        });
                        return text;
                    }

                    subdocPreviewText = '[[' + slug + ']]\n' + renderTree(tree, '');

                    const previewEl = document.getElementById('subdocPreview');
                    const previewContent = document.getElementById('subdocPreviewContent');
                    if (previewEl && previewContent) {
                        previewContent.textContent = subdocPreviewText;
                        previewEl.style.display = '';
                    }
                    const cb = window.Swal?.getConfirmButton();
                    if (cb) cb.disabled = false;
                } catch (e) {
                    console.error(e);
                }
            }
        },
        preConfirm: () => {
            if (!subdocPreviewText) return false;
            return subdocPreviewText;
        }
    });

    // suppress unused-warning: subdocSelectedSlug is set inside selectSubdocItem.
    void subdocSelectedSlug;

    if (result.isConfirmed && result.value) {
        const editor = window.editor;
        if (editor) {
            editor.insertText?.(result.value);
            editor.focus?.();
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 템플릿 모달
// ─────────────────────────────────────────────────────────────────────────────

interface TemplateItem { slug: string; }

async function openTemplateModal(): Promise<void> {
    const Swal = window.Swal;
    if (!Swal) return;
    try {
        Swal.fire({
            title: '템플릿 불러오기',
            html: `
                <div class="input-group mb-3">
                    <input type="text" id="templateSearchInput" class="form-control" placeholder="템플릿 검색어 입력">
                    <button class="btn btn-primary" id="templateSearchBtn" type="button"><i class="mdi mdi-magnify"></i> 검색</button>
                </div>
                <div id="templateList" class="list-group text-start" style="max-height: 300px; overflow-y: auto;">
                    <!-- Templates will be rendered here -->
                </div>
            `,
            showConfirmButton: false,
            didOpen: async () => {
                const searchInput = document.getElementById('templateSearchInput') as HTMLInputElement | null;
                const searchBtn = document.getElementById('templateSearchBtn');
                const listContainer = document.getElementById('templateList');
                if (!searchInput || !searchBtn || !listContainer) return;

                const renderTemplates = (templates: TemplateItem[] | undefined) => {
                    listContainer.innerHTML = '';
                    if (!templates || templates.length === 0) {
                        listContainer.innerHTML = '<div class="p-3 text-center text-muted">검색 결과가 없습니다.</div>';
                        return;
                    }

                    templates.forEach(t => {
                        const displayTitle = t.slug.replace(/^(틀|template|템플릿):/i, '');
                        const btn = document.createElement('button');
                        btn.className = 'list-group-item list-group-item-action';
                        btn.textContent = displayTitle;
                        btn.onclick = async () => {
                            Swal.close();
                            await applyTemplate(t.slug);
                        };
                        listContainer.appendChild(btn);
                    });
                };

                const fetchTemplates = async (query: string = '') => {
                    listContainer.innerHTML = '<div class="p-3 text-center"><span class="spinner-border spinner-border-sm text-primary" role="status"></span> 불러오는 중...</div>';
                    try {
                        const res = await fetch(`/api/w/templates${query ? `?q=${encodeURIComponent(query)}` : ''}`);
                        if (!res.ok) throw new Error('템플릿 목록을 불러올 수 없습니다.');
                        const data = await res.json() as { templates?: TemplateItem[] };
                        renderTemplates(data.templates);
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : '오류';
                        listContainer.innerHTML = `<div class="p-3 text-center text-danger">${escapeHtml(msg)}</div>`;
                    }
                };

                await fetchTemplates();

                searchBtn.onclick = () => fetchTemplates(searchInput.value.trim());
                searchInput.onkeypress = (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        fetchTemplates(searchInput.value.trim());
                    }
                };
            }
        });

        async function applyTemplate(selectedSlug: string) {
            const Swal = window.Swal;
            if (!Swal) return;
            try {
                const tRes = await fetch(`/api/w/${encodeURIComponent(selectedSlug)}`);
                if (!tRes.ok) throw new Error('템플릿 내용을 불러올 수 없습니다.');
                const tPage = await tRes.json() as { content?: string };

                const editor = window.editor;
                if (editor && (editor.getMarkdown?.() ?? '').trim()) {
                    const confirm = await Swal.fire({
                        title: '내용 덮어쓰기',
                        text: '현재 작성 중인 내용이 사라집니다. 계속하시겠습니까?',
                        icon: 'warning',
                        showCancelButton: true,
                        confirmButtonText: '예, 덮어씁니다',
                        cancelButtonText: '아니오'
                    });
                    if (!confirm.isConfirmed) return;
                }

                let tContent = tPage.content || '';
                if (!tContent.endsWith('\n')) {
                    tContent += '\n\n';
                } else if (!tContent.endsWith('\n\n')) {
                    tContent += '\n';
                }
                if (editor) {
                    editor.setMarkdown?.(tContent);
                }
                window.scrollToBottom?.();
                Swal.fire('완료', '템플릿을 불러왔습니다.', 'success');
            } catch (err) {
                const msg = err instanceof Error ? err.message : '오류';
                Swal.fire('오류', msg, 'error');
            }
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : '오류';
        Swal.fire('오류', msg, 'error');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 구조 컴포넌트(탭/아코디언/진행상황) 삽입 모달
// ─────────────────────────────────────────────────────────────────────────────

type StructureType = 'tabs' | 'accordion' | 'progress';
type ProgressMode = 'steps' | 'bar';
type StepStatus = 'todo' | 'current' | 'done';

interface StructureItem {
    title: string;
    body: string;
    open: boolean;
    status: StepStatus;
}

function _makeEmptyStructureItem(): StructureItem {
    return { title: '', body: '', open: false, status: 'todo' };
}

function openStructureBlockInsertModal(): void {
    const Swal = window.Swal;
    if (!Swal) return;
    const palettes = window.getAllPalettesForEditor?.() ?? [];

    const TYPE_META: Record<StructureType, { label: string; icon: string }> = {
        tabs:      { label: '탭',         icon: 'mdi mdi-tab' },
        accordion: { label: '아코디언',   icon: 'mdi mdi-format-list-group' },
        progress:  { label: '진행상황',   icon: 'mdi mdi-progress-check' },
    };

    const STATUS_META: Record<StepStatus, { label: string; icon: string }> = {
        todo:    { label: '대기', icon: 'bi bi-circle' },
        current: { label: '진행', icon: 'bi bi-circle-fill' },
        done:    { label: '완료', icon: 'bi bi-check-circle-fill' },
    };

    const state = {
        type: 'tabs' as StructureType,
        progressMode: 'steps' as ProgressMode,
        accordionMultiple: false,
        items: [_makeEmptyStructureItem(), _makeEmptyStructureItem()] as StructureItem[],
        // 진행 바({progress:X}) 전용 상태
        barValue: '50',
        barLabel: '',
        barPalette: '',
    };

    function typeTabsHtml(): string {
        return (Object.keys(TYPE_META) as StructureType[]).map(key => {
            const m = TYPE_META[key];
            const active = state.type === key ? ' active' : '';
            return `<button type="button" class="structure-insert-type-tab${active}" data-type="${key}">
                        <i class="${m.icon}"></i>
                        <span>${m.label}</span>
                    </button>`;
        }).join('');
    }

    function progressModeHtml(): string {
        const stepsActive = state.progressMode === 'steps' ? ' active' : '';
        const barActive   = state.progressMode === 'bar' ? ' active' : '';
        return `
            <div class="btn-group w-100" role="group" id="structureInsertProgressMode">
                <button type="button" class="btn btn-outline-primary${stepsActive}" data-mode="steps">
                    <i class="mdi mdi-stairs"></i> 단계별 진행
                </button>
                <button type="button" class="btn btn-outline-primary${barActive}" data-mode="bar">
                    <i class="mdi mdi-progress-helper"></i> 진행 바
                </button>
            </div>`;
    }

    function paletteSwatchHtml(containerId: string, hiddenId: string, current: string): string {
        let html = `<div id="${containerId}" class="card-insert-palette-swatches">`;
        html += `<button type="button" class="card-insert-palette-swatch${!current ? ' active' : ''}" data-palette="" title="선택 안 함">
                    <span class="card-insert-palette-swatch-none">없음</span>
                </button>`;
        for (const p of palettes) {
            const bg = window._isSafeCssColor?.(p.variant.bg || '') ? p.variant.bg! : 'transparent';
            const color = window._isSafeCssColor?.(p.variant.color || '') ? p.variant.color! : 'inherit';
            const active = current === p.name ? ' active' : '';
            html += `<button type="button" class="card-insert-palette-swatch${active}" data-palette="${escapeHtml(p.name)}" title="${escapeHtml(p.name)}" style="background:${bg};color:${color};">${escapeHtml(p.name)}</button>`;
        }
        html += `</div><input type="hidden" id="${hiddenId}" value="${escapeHtml(current)}">`;
        return html;
    }

    function statusChipsHtml(idx: number, current: StepStatus): string {
        return (Object.keys(STATUS_META) as StepStatus[]).map(s => {
            const m = STATUS_META[s];
            const active = s === current ? ' active' : '';
            return `<button type="button" class="structure-insert-status-chip${active}"
                        data-row="${idx}" data-status="${s}">
                        <i class="${m.icon}"></i>
                        <span>${m.label}</span>
                    </button>`;
        }).join('');
    }

    function itemRowHtml(idx: number, item: StructureItem): string {
        const isAccordion = state.type === 'accordion';
        const isSteps = state.type === 'progress' && state.progressMode === 'steps';
        const titleLabel = isSteps ? `${idx + 1}단계 제목` : `항목 ${idx + 1} 제목`;
        const titlePlaceholder = state.type === 'tabs'
            ? `예: 탭 ${idx + 1}`
            : isSteps
                ? `예: ${idx + 1}단계`
                : `예: 항목 ${idx + 1}`;

        const accordionOpen = isAccordion
            ? `<label class="structure-insert-row-flag">
                    <input type="checkbox" data-row="${idx}" class="structure-insert-row-open" ${item.open ? 'checked' : ''}>
                    <span>기본 펼침</span>
                </label>`
            : '';

        const stepsStatus = isSteps
            ? `<div class="structure-insert-status-chips" data-row="${idx}">${statusChipsHtml(idx, item.status)}</div>`
            : '';

        return `
            <div class="structure-insert-row" data-row="${idx}">
                <div class="structure-insert-row-head">
                    <span class="structure-insert-row-num">${idx + 1}</span>
                    <input type="text" class="form-control form-control-sm structure-insert-row-title"
                        data-row="${idx}"
                        placeholder="${titlePlaceholder}"
                        value="${escapeHtml(item.title)}"
                        aria-label="${titleLabel}"
                        style="background:var(--wiki-bg);color:var(--wiki-text);border-color:var(--wiki-border);">
                    <button type="button" class="structure-insert-row-remove" data-row="${idx}" title="이 항목 삭제" aria-label="이 항목 삭제">
                        <i class="mdi mdi-close"></i>
                    </button>
                </div>
                ${accordionOpen || stepsStatus
                    ? `<div class="structure-insert-row-meta">${accordionOpen}${stepsStatus}</div>`
                    : ''}
                <textarea class="form-control structure-insert-row-body"
                    data-row="${idx}"
                    rows="3"
                    placeholder="비워두면 '내용'이 자리표시자로 들어갑니다."
                    style="font-size:0.86rem;font-family:inherit;resize:vertical;background:var(--wiki-bg);color:var(--wiki-text);border-color:var(--wiki-border);">${escapeHtml(item.body)}</textarea>
            </div>`;
    }

    function topOptionsHtml(): string {
        if (state.type === 'accordion') {
            return `
                <div class="mb-3">
                    <label class="structure-insert-row-flag">
                        <input type="checkbox" id="structureInsertAccordionMultiple" ${state.accordionMultiple ? 'checked' : ''}>
                        <span>동시 다중 펼침 허용</span>
                    </label>
                </div>`;
        }
        return '';
    }

    function progressBarFormHtml(): string {
        return `
            <div class="mb-3">
                <label class="form-label" for="structureInsertBarValue">값</label>
                <input type="text" id="structureInsertBarValue" class="form-control"
                    placeholder="예: 50  /  3/10  /  75%"
                    value="${escapeHtml(state.barValue)}" autocomplete="off"
                    style="background:var(--wiki-bg);color:var(--wiki-text);border-color:var(--wiki-border);">
                <div class="form-text" style="font-size:0.78rem;">0–100 사이의 숫자, 또는 a/b 형태(b ≥ a) 분수.</div>
            </div>
            <div class="mb-3">
                <label class="form-label" for="structureInsertBarLabel">라벨 (선택)</label>
                <input type="text" id="structureInsertBarLabel" class="form-control"
                    placeholder="예: 다운로드"
                    value="${escapeHtml(state.barLabel)}" autocomplete="off"
                    style="background:var(--wiki-bg);color:var(--wiki-text);border-color:var(--wiki-border);">
            </div>
            <div class="mb-2">
                <label class="form-label">팔레트 (선택)</label>
                ${paletteSwatchHtml('structureInsertBarPaletteSwatches', 'structureInsertBarPalette', state.barPalette)}
            </div>`;
    }

    function itemsListHtml(): string {
        const rows = state.items.map((it, i) => itemRowHtml(i, it)).join('');
        return `
            <div class="structure-insert-items" id="structureInsertItems">${rows}</div>
            <button type="button" class="structure-insert-add-row" id="structureInsertAddRow">
                <i class="mdi mdi-plus"></i> 항목 추가
            </button>`;
    }

    function bodyHtml(): string {
        const isProgressBar = state.type === 'progress' && state.progressMode === 'bar';
        return `
            <div class="text-start structure-insert-form">
                <div class="mb-3">
                    <label class="form-label">컴포넌트 종류</label>
                    <div class="structure-insert-type-tabs" id="structureInsertTypeTabs">${typeTabsHtml()}</div>
                </div>
                ${state.type === 'progress' ? `<div class="mb-3" id="structureInsertProgressModeWrap">${progressModeHtml()}</div>` : ''}
                ${topOptionsHtml()}
                ${isProgressBar ? progressBarFormHtml() : itemsListHtml()}
            </div>`;
    }

    function snapshotInputs(): void {
        if (state.type === 'progress' && state.progressMode === 'bar') {
            const v = (document.getElementById('structureInsertBarValue') as HTMLInputElement | null)?.value;
            const l = (document.getElementById('structureInsertBarLabel') as HTMLInputElement | null)?.value;
            const p = (document.getElementById('structureInsertBarPalette') as HTMLInputElement | null)?.value;
            if (v != null) state.barValue = v;
            if (l != null) state.barLabel = l;
            if (p != null) state.barPalette = p;
            return;
        }
        const titleInputs = document.querySelectorAll<HTMLInputElement>('.structure-insert-row-title');
        const bodyInputs = document.querySelectorAll<HTMLTextAreaElement>('.structure-insert-row-body');
        titleInputs.forEach(el => {
            const i = parseInt(el.dataset.row || '-1', 10);
            if (i >= 0 && state.items[i]) state.items[i].title = el.value;
        });
        bodyInputs.forEach(el => {
            const i = parseInt(el.dataset.row || '-1', 10);
            if (i >= 0 && state.items[i]) state.items[i].body = el.value;
        });
        if (state.type === 'accordion') {
            document.querySelectorAll<HTMLInputElement>('.structure-insert-row-open').forEach(el => {
                const i = parseInt(el.dataset.row || '-1', 10);
                if (i >= 0 && state.items[i]) state.items[i].open = el.checked;
            });
            const m = document.getElementById('structureInsertAccordionMultiple') as HTMLInputElement | null;
            if (m) state.accordionMultiple = m.checked;
        }
        if (state.type === 'progress' && state.progressMode === 'steps') {
            // status 는 chip 클릭 핸들러에서 즉시 state 에 반영됨
        }
    }

    function repaintBody(): void {
        const container = document.querySelector<HTMLElement>('.swal2-html-container');
        if (!container) return;
        container.innerHTML = bodyHtml();
        wireBody();
    }

    function wirePalette(containerId: string, hiddenId: string, onChange: (val: string) => void): void {
        const container = document.getElementById(containerId);
        const hidden = document.getElementById(hiddenId) as HTMLInputElement | null;
        if (!container || !hidden) return;
        container.querySelectorAll<HTMLElement>('.card-insert-palette-swatch').forEach(sw => {
            sw.addEventListener('click', (e) => {
                e.preventDefault();
                const val = sw.dataset.palette || '';
                hidden.value = val;
                onChange(val);
                container.querySelectorAll<HTMLElement>('.card-insert-palette-swatch').forEach(s => {
                    s.classList.toggle('active', (s.dataset.palette || '') === val);
                });
            });
        });
    }

    function wireBody(): void {
        // 타입 토글
        document.querySelectorAll<HTMLElement>('#structureInsertTypeTabs .structure-insert-type-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                e.preventDefault();
                const t = tab.dataset.type as StructureType | undefined;
                if (!t || t === state.type) return;
                snapshotInputs();
                state.type = t;
                repaintBody();
            });
        });

        // 진행상황 모드 토글
        document.querySelectorAll<HTMLElement>('#structureInsertProgressMode button[data-mode]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const mode = btn.dataset.mode as ProgressMode | undefined;
                if (!mode || mode === state.progressMode) return;
                snapshotInputs();
                state.progressMode = mode;
                repaintBody();
            });
        });

        // 항목 삭제 / 상태 chip / open 체크박스 — items 리스트 위임
        const itemsRoot = document.getElementById('structureInsertItems');
        if (itemsRoot) {
            itemsRoot.addEventListener('click', (e) => {
                const target = e.target as HTMLElement | null;
                if (!target) return;
                const removeBtn = target.closest<HTMLElement>('.structure-insert-row-remove');
                if (removeBtn) {
                    e.preventDefault();
                    const i = parseInt(removeBtn.dataset.row || '-1', 10);
                    if (i < 0 || state.items.length <= 1) return;
                    snapshotInputs();
                    state.items.splice(i, 1);
                    repaintBody();
                    return;
                }
                const chip = target.closest<HTMLElement>('.structure-insert-status-chip');
                if (chip) {
                    e.preventDefault();
                    const i = parseInt(chip.dataset.row || '-1', 10);
                    const s = chip.dataset.status as StepStatus | undefined;
                    if (i < 0 || !s || !state.items[i]) return;
                    state.items[i].status = s;
                    const group = chip.parentElement;
                    if (group) {
                        group.querySelectorAll<HTMLElement>('.structure-insert-status-chip').forEach(c => {
                            c.classList.toggle('active', c.dataset.status === s);
                        });
                    }
                    return;
                }
            });
        }

        // 항목 추가
        const addBtn = document.getElementById('structureInsertAddRow');
        if (addBtn) {
            addBtn.addEventListener('click', (e) => {
                e.preventDefault();
                snapshotInputs();
                state.items.push(_makeEmptyStructureItem());
                repaintBody();
            });
        }

        // 진행 바 팔레트
        if (state.type === 'progress' && state.progressMode === 'bar') {
            wirePalette('structureInsertBarPaletteSwatches', 'structureInsertBarPalette', (v) => { state.barPalette = v; });
        }
    }

    Swal.fire({
        title: '<i class="mdi mdi-view-dashboard-outline me-2"></i>구조 컴포넌트 삽입',
        width: 640,
        html: bodyHtml(),
        showCancelButton: true,
        confirmButtonText: '삽입',
        cancelButtonText: '취소',
        didOpen: () => {
            wireBody();
        },
        preConfirm: (): string | false => {
            snapshotInputs();
            return buildStructureBlockOutput(state);
        }
    }).then(result => {
        if (!result.isConfirmed || !result.value) return;
        window.editor?.insertText?.(result.value as string);
        window._cmView?.focus();
    });
}

function _structureItemHasInvalidBody(body: string): boolean {
    return body.split('\n').some(l => /^\s*:::/.test(l));
}

function buildStructureBlockOutput(state: {
    type: StructureType;
    progressMode: ProgressMode;
    accordionMultiple: boolean;
    items: StructureItem[];
    barValue: string;
    barLabel: string;
    barPalette: string;
}): string | false {
    const Swal = window.Swal;

    if (state.type === 'progress' && state.progressMode === 'bar') {
        const raw = (state.barValue || '').trim();
        const fracMatch = raw.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
        const numMatch = raw.replace(/%$/, '').match(/^\d+(?:\.\d+)?$/);
        let valid = false;
        let valueToken = '';
        if (fracMatch) {
            const a = parseFloat(fracMatch[1]);
            const b = parseFloat(fracMatch[2]);
            if (b > 0 && a >= 0 && a <= b) {
                valid = true;
                valueToken = `${fracMatch[1]}/${fracMatch[2]}`;
            }
        } else if (numMatch) {
            const n = parseFloat(numMatch[0]);
            if (n >= 0 && n <= 100) {
                valid = true;
                valueToken = `${n}`;
            }
        }
        if (!valid) {
            Swal?.showValidationMessage?.('값은 0–100 숫자 또는 a/b(b ≥ a) 분수여야 합니다.');
            return false;
        }
        // {progress:...} 의 정규식이 `}` / `<` / 개행으로 토큰을 끊으므로 라벨에서 제거.
        // `|` 는 값과 라벨을 구분하는 separator 라 함께 제거한다.
        const label = (state.barLabel || '').replace(/[\r\n|}<]+/g, ' ').trim();
        const inner = label ? `${valueToken}|${label}` : valueToken;
        const palettePrefix = state.barPalette ? `{palette:${state.barPalette}}` : '';
        return `\n${palettePrefix}{progress:${inner}}\n`;
    }

    const items = state.items;
    if (items.length === 0) {
        Swal?.showValidationMessage?.('최소 1개 이상의 항목이 필요합니다.');
        return false;
    }
    for (const it of items) {
        if (_structureItemHasInvalidBody(it.body)) {
            Swal?.showValidationMessage?.("항목 본문에 ':::'로 시작하는 줄은 블록을 닫아버려 사용할 수 없습니다.");
            return false;
        }
    }

    if (state.type === 'tabs') {
        const inner = items.map((it, i) => {
            const title = (it.title || '').replace(/[\r\n]+/g, ' ').trim() || `탭 ${i + 1}`;
            const body = (it.body || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\n+|\n+$/g, '') || '내용';
            return `:::tab ${title}\n${body}\n:::`;
        }).join('\n');
        return `\n:::tabs\n${inner}\n:::\n`;
    }

    if (state.type === 'accordion') {
        const head = state.accordionMultiple ? `:::accordion {multiple}` : `:::accordion`;
        const inner = items.map((it, i) => {
            const titleRaw = (it.title || '').replace(/[\r\n]+/g, ' ').trim() || `항목 ${i + 1}`;
            const flag = it.open ? ' {open}' : '';
            const body = (it.body || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\n+|\n+$/g, '') || '내용';
            return `:::item ${titleRaw}${flag}\n${body}\n:::`;
        }).join('\n');
        return `\n${head}\n${inner}\n:::\n`;
    }

    // type === 'progress' && progressMode === 'steps'
    const head = `:::steps`;
    const inner = items.map((it, i) => {
        const titleRaw = (it.title || '').replace(/[\r\n]+/g, ' ').trim() || `${i + 1}단계`;
        const statusToken = ` {status:${it.status}}`;
        const body = (it.body || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\n+|\n+$/g, '') || '내용';
        return `:::step ${titleRaw}${statusToken}\n${body}\n:::`;
    }).join('\n');
    return `\n${head}\n${inner}\n:::\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Window 브리지 — edit.js (raw) / autocomplete.ts 에서 호출
// ─────────────────────────────────────────────────────────────────────────────

// 아이콘 목록 로더 — autocomplete.ts 가 호출
window.loadBiIcons        = loadBiIcons;
window.loadMdiIcons       = loadMdiIcons;
window.loadSelectedIcons  = loadSelectedIcons;
window.filterIcons        = filterIcons;

// edit.js 의 toolbar 핸들러에서 호출
window.openSelectedIconsPicker = openSelectedIconsPicker;
window.openIconPicker          = openIconPicker;
window.setupTableInsertPopover = setupTableInsertPopover;
window.setupSpecialCharPicker  = setupSpecialCharPicker;
window.openTimestampInsertModal = openTimestampInsertModal;
window.openSubdocInsertModal   = openSubdocInsertModal;
window.openCardInsertModal     = openCardInsertModal;
window.openPaletteColorModal   = openPaletteColorModal;
window.openBadgeInsertModal    = openBadgeInsertModal;
window.openComponentInsertModal = openComponentInsertModal;
window.openStructureBlockInsertModal = openStructureBlockInsertModal;
window.openGoogleMapsEmbedModal = openGoogleMapsEmbedModal;
window.openTemplateModal       = openTemplateModal;

console.log('[edit/modals] module loaded');

// 사용 흐름상 export 하지 않아도 무방한 타입 — CMSelection import 가 lint 미사용으로 트리쉐이킹 되지 않게 사용 표시.
export type { CMSelection };
