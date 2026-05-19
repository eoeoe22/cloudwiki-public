/**
 * edit-autocomplete.js → ESM 이전 (Phase 4-5)
 *
 * 에디터 인라인 자동완성 통합 모듈:
 *   - 이미지 크기 ({size:…})
 *   - 코드/커맨드 ({bg:, {icon:, …})
 *   - 블록 컴포넌트 (:::card 등)
 *   - 아이콘 ({bi:, {mdi:, {icon:})
 *   - 색상 피커 ({bg:, {color:})
 *   - 타임스탬프 달력 ({dday:, {age:, …})
 *   - 팔레트 ({palette:})
 *   - 카테고리 태그 UI
 *   - 위키 링크 ([[…]]) / 틀 ({{…}}) 제목 자동완성
 *
 * 브리지 노출 (window.*):
 *   선택 핸들러 — selectImgSizeAutocomplete, selectCodeAutocomplete,
 *                 selectBlockAutocomplete, selectIconAutocomplete,
 *                 selectAutocomplete, selectCategoryAcByIndex, removeCategoryTag
 *   외부 호출  — showColorAutocomplete, showPaletteAutocomplete,
 *                hideAutocomplete, hideIconAutocomplete, hideColorAutocomplete,
 *                getAllPalettesForEditor, renderCategoryTags
 *   상태 공유  — paletteAc (edit.js 가 .replaceRange 를 직접 기록)
 *                categoryTags (edit.js 가 read/write)
 */

import './types';
import { escapeHtml } from '../utils/html';
import type { PaletteInfo } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Window 브리지 선언 (autocomplete 고유)
// ─────────────────────────────────────────────────────────────────────────────
declare global {
    interface Window {
        // 인라인 onclick 핸들러
        selectImgSizeAutocomplete?: (index: number) => void;
        selectCodeAutocomplete?: (index: number) => void;
        selectBlockAutocomplete?: (index: number) => void;
        selectIconAutocomplete?: (index: number) => void;
        selectAutocomplete?: (index: number) => void;
        selectCategoryAcByIndex?: (index: number) => void;
        removeCategoryTag?: (index: number) => void;
        // edit.js / edit-modals.js 에서 호출
        showColorAutocomplete?: (query: string, type: 'bg' | 'color') => void;
        showPaletteAutocomplete?: (query: string, opts?: { showAll?: boolean }) => void;
        hideAutocomplete?: () => void;
        hideIconAutocomplete?: () => void;
        hideColorAutocomplete?: () => void;
        hideImgSizeAutocomplete?: () => void;
        hideTimestampAutocomplete?: () => void;
        getAllPalettesForEditor?: () => PaletteInfo[];
        renderCategoryTags?: () => void;
        // edit.js 가 .replaceRange 를 직접 기록하는 상태 객체
        paletteAc?: PaletteAcState;
        // edit-main.ts 가 editor shim 초기화 직후 명시 호출해 자동완성 부착을 보장
        ensureAutocompleteAttached?: () => void;
        /**
         * 자동완성 드롭다운 9종을 한 번에 닫으면서 내부 visible/index/query
         * 상태까지 초기화한다. 단순 DOM display 조작만으로는 visible 플래그가
         * 남아 키보드 네비게이션이 계속 가로채일 수 있으므로, "문법 자동완성"
         * 설정 토글 등 외부에서 호출할 진입점으로 노출한다.
         */
        hideAllSyntaxAutocompletes?: () => void;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 내부 상태 타입
// ─────────────────────────────────────────────────────────────────────────────

interface ImgSizeOption {
    id: string;
    label: string;
    icon: string;
}

interface CodeOption {
    id: string;
    label: string;
    icon: string;
    insert: string;
    iconMode?: 'selected' | 'library';
}

interface BlockOption {
    id: string;
    label: string;
    desc: string;
    icon: string;
}

interface WikiResult {
    slug: string;
}

interface PaletteAcState {
    visible: boolean;
    results: PaletteInfo[];
    selectedIndex: number;
    query: string;
    div: HTMLElement | null;
    replaceRange: { from: number; to: number } | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 이미지 크기 자동완성
// ─────────────────────────────────────────────────────────────────────────────

const imgSizeAc = {
    visible: false,
    selectedIndex: -1,
    div: document.getElementById('imgsize-autocomplete'),
    options: [
        { id: 'icon',   label: '아이콘',      icon: 'mdi-square-medium-outline' },
        { id: 'small',  label: '작게',        icon: 'mdi-arrow-collapse' },
        { id: 'medium', label: '중간',        icon: 'mdi-square-outline' },
        { id: 'full',   label: '크게(기본)',  icon: 'mdi-arrow-expand-all' },
    ] as ImgSizeOption[],
};

function hideImgSizeAutocomplete(): void {
    imgSizeAc.visible = false;
    imgSizeAc.selectedIndex = -1;
    if (imgSizeAc.div) imgSizeAc.div.style.display = 'none';
}

function showImgSizeAutocomplete(): void {
    imgSizeAc.visible = true;
    window.positionDropdownAtCursor?.(imgSizeAc.div, 200);
    renderImgSizeAcResults();
}

function renderImgSizeAcResults(): void {
    const gridEl = document.getElementById('imgsizeAcGrid');
    if (!gridEl) return;

    gridEl.innerHTML = imgSizeAc.options.map((opt, index) => `
        <div class="list-group-item autocomplete-item" data-index="${index}" onclick="selectImgSizeAutocomplete(${index})" style="cursor:pointer; padding:8px 10px;">
            <i class="mdi ${escapeHtml(opt.icon)}"></i>
            <span>${escapeHtml(opt.label)}</span>
            <span class="text-muted" style="font-size:0.8em; margin-left:4px;">${escapeHtml(opt.id)}</span>
        </div>
    `).join('');

    imgSizeAc.selectedIndex = 0;
    highlightImgSizeAcItem();
}

function highlightImgSizeAcItem(): void {
    if (!imgSizeAc.div) return;
    imgSizeAc.div.querySelectorAll('.autocomplete-item').forEach((item, idx) => {
        item.classList.toggle('active', idx === imgSizeAc.selectedIndex);
        if (idx === imgSizeAc.selectedIndex) item.scrollIntoView({ block: 'nearest' });
    });
}

function selectImgSizeAutocomplete(index: number): void {
    const opt = imgSizeAc.options[index];
    const editor = window.editor;
    if (!opt || !editor) return;

    const selection = editor.getSelection?.();
    if (!selection) { hideImgSizeAutocomplete(); return; }

    const [from] = selection;
    const line = from[0];
    const col = from[1];

    const lines = editor.getMarkdown().split('\n');
    const textBefore = (lines[line - 1] || '').substring(0, col - 1);
    const match = textBefore.match(/!\[[^\]]*\]\([^)]+\)$/);

    if (match && opt.id !== 'full') {
        editor.insertText?.(`{size:${opt.id}}`);
    }
    hideImgSizeAutocomplete();
    editor.focus?.();
}

// ─────────────────────────────────────────────────────────────────────────────
// 코드 템플릿 자동완성
// ─────────────────────────────────────────────────────────────────────────────

const codeAc = {
    visible: false,
    selectedIndex: -1,
    query: '',
    div: document.getElementById('code-autocomplete'),
    options: [
        { id: 'icon',     label: '아이콘',       icon: 'mdi mdi-emoticon-outline',          insert: 'icon:',     iconMode: 'selected' },
        { id: 'bi',       label: 'Bootstrap Icons', icon: 'bi bi-bootstrap',                insert: 'bi:',       iconMode: 'library'  },
        { id: 'mdi',      label: 'Material Design', icon: 'mdi mdi-material-design',         insert: 'mdi:',      iconMode: 'library'  },
        { id: 'bg',       label: '배경색',        icon: 'mdi mdi-format-color-fill',         insert: 'bg:'        },
        { id: 'color',    label: '글자색',        icon: 'mdi mdi-format-color-text',         insert: 'color:'     },
        { id: 'palette',  label: '팔레트 색상',   icon: 'mdi mdi-palette-swatch',            insert: 'palette:'   },
        { id: 'dday',     label: 'D-Day',         icon: 'mdi mdi-calendar-clock',            insert: 'dday:'      },
        { id: 'time',     label: '표시 시간',     icon: 'mdi mdi-clock-outline',             insert: 'time:'      },
        { id: 'timer',    label: '타이머',        icon: 'mdi mdi-timer-outline',             insert: 'timer:'     },
        { id: 'age',      label: '만 나이',       icon: 'mdi mdi-cake-variant-outline',      insert: 'age:'       },
        { id: 'calendar', label: '캘린더 날짜',   icon: 'mdi mdi-calendar-month',            insert: 'calendar:'  },
        { id: 'kbd',      label: '키보드 키',     icon: 'mdi mdi-keyboard-outline',          insert: 'kbd:'       },
        { id: 'progress', label: '진행도 바',     icon: 'mdi mdi-progress-helper',           insert: 'progress:'  },
        { id: 'size',     label: '이미지 크기',   icon: 'mdi mdi-image-size-select-large',   insert: 'size:'      },
    ] as CodeOption[],
    filtered: [] as CodeOption[],
};

function hideCodeAutocomplete(): void {
    codeAc.visible = false;
    codeAc.selectedIndex = -1;
    if (codeAc.div) codeAc.div.style.display = 'none';
}

function showCodeAutocomplete(query: string): void {
    codeAc.query = query.toLowerCase();
    const selectedIconsOnly = window.selectedIconsOnly ?? false;
    codeAc.filtered = codeAc.options.filter(o => {
        if (o.iconMode === 'selected' && !selectedIconsOnly) return false;
        if (o.iconMode === 'library' && selectedIconsOnly) return false;
        return o.id.toLowerCase().includes(codeAc.query) || o.label.toLowerCase().includes(codeAc.query);
    });

    if (codeAc.filtered.length === 0) { hideCodeAutocomplete(); return; }

    codeAc.visible = true;
    window.positionDropdownAtCursor?.(codeAc.div, 240);
    renderCodeAcResults();
}

function renderCodeAcResults(): void {
    const gridEl = document.getElementById('codeAcGrid');
    if (!gridEl) return;

    gridEl.innerHTML = codeAc.filtered.map((opt, index) => `
        <div class="list-group-item autocomplete-item" data-index="${index}" onclick="selectCodeAutocomplete(${index})" style="cursor:pointer; padding:6px 10px; display:flex; align-items:center;">
            <i class="${escapeHtml(opt.icon)}" style="font-size:1.1rem; width:24px; text-align:center; margin-right:8px; color:var(--wiki-link-color);"></i>
            <span style="flex:1; font-size:0.9rem;">${escapeHtml(opt.label)}</span>
            <span class="text-muted" style="font-size:0.75rem; font-family:monospace;">{${escapeHtml(opt.id)}:...}</span>
        </div>
    `).join('');

    codeAc.selectedIndex = 0;
    highlightCodeAcItem();
}

function highlightCodeAcItem(): void {
    if (!codeAc.div) return;
    codeAc.div.querySelectorAll('.autocomplete-item').forEach((item, idx) => {
        item.classList.toggle('active', idx === codeAc.selectedIndex);
        if (idx === codeAc.selectedIndex) item.scrollIntoView({ block: 'nearest' });
    });
}

function selectCodeAutocomplete(index: number): void {
    const opt = codeAc.filtered[index];
    const editor = window.editor;
    if (!opt || !editor) return;

    const selection = editor.getSelection?.();
    if (!selection) { hideCodeAutocomplete(); return; }

    const [from] = selection;
    const line = from[0];
    const col = from[1];

    const lines = editor.getMarkdown().split('\n');
    const textBefore = (lines[line - 1] || '').substring(0, col - 1);
    const match = textBefore.match(/(?<!\{)\{([a-zA-Z]*)$/);

    if (match) {
        const replaceStartCol = col - match[1].length;
        editor.setSelection?.([line, replaceStartCol], [line, col]);
        editor.insertText?.(opt.insert);
    }

    hideCodeAutocomplete();
    editor.focus?.();
}

// ─────────────────────────────────────────────────────────────────────────────
// 블록 컴포넌트 자동완성 (:::)
// ─────────────────────────────────────────────────────────────────────────────

const blockAc = {
    visible: false,
    selectedIndex: -1,
    query: '',
    div: document.getElementById('block-autocomplete'),
    options: [
        { id: 'card',      label: '카드',      desc: '제목 + 본문 박스',           icon: 'mdi mdi-card-text-outline'       },
        { id: 'grid',      label: '그리드',    desc: '카드 그리드 레이아웃',       icon: 'mdi mdi-grid'                    },
        { id: 'row',       label: '가로 정렬', desc: '자식을 가로로 배치',         icon: 'mdi mdi-view-column-outline'     },
        { id: 'embed',     label: '임베드',    desc: '왼쪽 강조선 인용',           icon: 'mdi mdi-format-quote-close'      },
        { id: 'tabs',      label: '탭',        desc: '탭 컨테이너 (자식 :::tab)',  icon: 'mdi mdi-tab'                     },
        { id: 'accordion', label: '아코디언',  desc: '아코디언 (자식 :::item)',    icon: 'mdi mdi-format-list-bulleted-square' },
        { id: 'steps',     label: '스텝퍼',    desc: '진행 단계 (자식 :::step)',   icon: 'mdi mdi-stairs'                  },
        { id: 'info',      label: '정보',      desc: '정보 콜아웃',                icon: 'mdi mdi-information-outline'     },
        { id: 'tip',       label: '팁',        desc: '팁 콜아웃',                  icon: 'mdi mdi-lightbulb-on-outline'    },
        { id: 'success',   label: '성공',      desc: '성공 콜아웃',                icon: 'mdi mdi-check-circle-outline'    },
        { id: 'warning',   label: '주의',      desc: '주의 콜아웃',                icon: 'mdi mdi-alert-outline'           },
        { id: 'danger',    label: '위험',      desc: '위험 콜아웃',                icon: 'mdi mdi-alert-octagon-outline'   },
        { id: 'note',      label: '노트',      desc: '노트 콜아웃',                icon: 'mdi mdi-note-text-outline'       },
    ] as BlockOption[],
    filtered: [] as BlockOption[],
};

function hideBlockAutocomplete(): void {
    blockAc.visible = false;
    blockAc.selectedIndex = -1;
    if (blockAc.div) blockAc.div.style.display = 'none';
}

// 현재 라인 직전까지 열려 있고 아직 닫히지 않은 ::: 블록이 있는지 검사.
// 열린 블록 안에서 입력하는 단독 `:::` 는 여는 쪽이 아니라 닫는 쪽일 가능성이
// 높으므로 자동완성을 띄우지 않는다.
// 펜스드 코드 블록(```/~~~) 내부의 `:::` 는 디렉티브가 아니므로 깊이 계산에서 제외.
function hasUnclosedBlockBefore(lines: string[], currentLineNum: number): boolean {
    let depth = 0;
    let inFencedCode = false;
    let fenceChar = '';
    let fenceLen = 0;
    for (let i = 0; i < currentLineNum - 1; i++) {
        const line = lines[i] || '';
        if (!inFencedCode) {
            // CommonMark 는 펜스 오프너 앞에 공백 0~3칸 들여쓰기를 허용한다 (4칸 이상은 들여쓰기 코드블록).
            const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
            if (fenceMatch) {
                const opener = fenceMatch[1];
                const rest = fenceMatch[2];
                const ch = opener[0];
                // CommonMark: 백틱 펜스의 info string 에는 백틱이 들어갈 수 없다.
                const isValidFence = ch !== '`' || !rest.includes('`');
                if (isValidFence) {
                    inFencedCode = true;
                    fenceChar = ch;
                    fenceLen = opener.length;
                    continue;
                }
            }
            // render.ts 의 openRe / closeRe 와 동일하게 컬럼 1 에서만 디렉티브로 인식.
            // 들여쓰기된 `  :::card` 같은 라인은 본문 텍스트로 간주.
            if (/^:::([a-zA-Z][a-zA-Z0-9_-]*)(?:[ \t]+.*)?[ \t]*$/.test(line)) depth++;
            else if (/^:::[ \t]*$/.test(line) && depth > 0) depth--;
        } else {
            // CommonMark 닫는 펜스는 들여쓰기 0~3칸, 오프너와 동일한 문자만 사용,
            // 오프너 이상 길이여야 한다. 혼합 시퀀스(예: ```~) 는 코드 라인.
            const closeRe = new RegExp('^ {0,3}(' + (fenceChar === '`' ? '`' : '~') + '+)[ \\t]*$');
            const closeMatch = line.match(closeRe);
            if (closeMatch && closeMatch[1].length >= fenceLen) {
                inFencedCode = false;
            }
        }
    }
    return depth > 0;
}

function showBlockAutocomplete(query: string): void {
    blockAc.query = (query || '').toLowerCase();
    blockAc.filtered = blockAc.options.filter(o => {
        if (!blockAc.query) return true;
        return o.id.toLowerCase().includes(blockAc.query) || o.label.toLowerCase().includes(blockAc.query);
    });

    if (blockAc.filtered.length === 0) { hideBlockAutocomplete(); return; }

    blockAc.visible = true;
    window.positionDropdownAtCursor?.(blockAc.div, 280);
    renderBlockAcResults();
}

function renderBlockAcResults(): void {
    const gridEl = document.getElementById('blockAcGrid');
    if (!gridEl) return;

    gridEl.innerHTML = blockAc.filtered.map((opt, index) => `
        <div class="list-group-item autocomplete-item" data-index="${index}" onclick="selectBlockAutocomplete(${index})" style="cursor:pointer; padding:6px 10px; display:flex; align-items:center;">
            <i class="${escapeHtml(opt.icon)}" style="font-size:1.1rem; width:24px; text-align:center; margin-right:8px; color:var(--wiki-link-color);"></i>
            <div style="flex:1; min-width:0;">
                <div style="font-size:0.9rem; line-height:1.2;">${escapeHtml(opt.label)} <span class="text-muted" style="font-family:monospace; font-size:0.8em;">:::${escapeHtml(opt.id)}</span></div>
                <div class="text-muted" style="font-size:0.75rem; line-height:1.2;">${escapeHtml(opt.desc)}</div>
            </div>
        </div>
    `).join('');

    blockAc.selectedIndex = 0;
    highlightBlockAcItem();
}

function highlightBlockAcItem(): void {
    if (!blockAc.div) return;
    blockAc.div.querySelectorAll('.autocomplete-item').forEach((item, idx) => {
        item.classList.toggle('active', idx === blockAc.selectedIndex);
        if (idx === blockAc.selectedIndex) item.scrollIntoView({ block: 'nearest' });
    });
}

function selectBlockAutocomplete(index: number): void {
    const opt = blockAc.filtered[index];
    const editor = window.editor;
    if (!opt || !editor) return;

    const selection = editor.getSelection?.();
    if (!selection) { hideBlockAutocomplete(); return; }

    const [from] = selection;
    const line = from[0];
    const col = from[1];

    const lines = editor.getMarkdown().split('\n');
    const textBefore = (lines[line - 1] || '').substring(0, col - 1);

    if (!/^:::([a-zA-Z][a-zA-Z0-9_-]*)?$/.test(textBefore)) {
        hideBlockAutocomplete();
        return;
    }

    editor.setSelection?.([line, 1], [line, col]);
    editor.insertText?.(`:::${opt.id} `);

    const targetCol = 5 + opt.id.length;
    editor.setSelection?.([line, targetCol], [line, targetCol]);

    hideBlockAutocomplete();
    editor.focus?.();
}

// ─────────────────────────────────────────────────────────────────────────────
// 아이콘 자동완성
// ─────────────────────────────────────────────────────────────────────────────

const iconAc = {
    visible: false,
    type: 'bi' as 'bi' | 'mdi' | 'icon',
    query: '',
    results: [] as string[],
    selectedIndex: -1,
    lastKey: null as string | null,
    debounceTimer: null as ReturnType<typeof setTimeout> | null,
    div: document.getElementById('icon-autocomplete'),
    COLS: 5,
};

function hideIconAutocomplete(): void {
    iconAc.visible = false;
    iconAc.results = [];
    iconAc.selectedIndex = -1;
    iconAc.lastKey = null;
    if (iconAc.div) iconAc.div.style.display = 'none';
}

function showIconAutocomplete(query: string, type: 'bi' | 'mdi' | 'icon'): void {
    iconAc.query = query;
    iconAc.type = type;
    iconAc.visible = true;

    const typeIconEl = document.getElementById('iconAc.typeIcon');
    const typeLabelEl = document.getElementById('iconAc.typeLabel');
    if (typeIconEl) {
        typeIconEl.className = type === 'icon' ? 'bi bi-search'
            : type === 'bi' ? 'bi bi-bootstrap'
            : 'mdi mdi-material-design';
    }
    if (typeLabelEl) {
        typeLabelEl.textContent = type === 'icon' ? '아이콘 검색'
            : type === 'bi' ? 'Bootstrap Icons'
            : 'Material Design Icons';
    }

    window.positionDropdownAtCursor?.(iconAc.div, 330);

    const iconAcKey = `${type}:${query}`;
    if (iconAcKey === iconAc.lastKey) return;
    iconAc.lastKey = iconAcKey;

    const gridEl = document.getElementById('iconAcGrid');
    const emptyEl = document.getElementById('iconAcEmpty');
    const loadingEl = document.getElementById('iconAcLoading');
    if (gridEl) gridEl.innerHTML = '';
    if (emptyEl) emptyEl.style.display = 'none';
    if (loadingEl) loadingEl.style.display = 'block';

    if (iconAc.debounceTimer !== null) clearTimeout(iconAc.debounceTimer);
    iconAc.debounceTimer = setTimeout(async () => {
        const requestedType = type;
        const requestedQuery = query;
        if (!iconAc.visible) return;

        const selectedIconsOnly = window.selectedIconsOnly ?? false;
        let icons: string[];
        if (requestedType === 'icon') {
            icons = await (window.loadSelectedIcons?.() ?? []);
        } else if (selectedIconsOnly) {
            const all = await (window.loadSelectedIcons?.() ?? []);
            const prefix = requestedType === 'bi' ? 'bi-' : 'mdi-';
            icons = all.filter(n => n.startsWith(prefix)).map(n => n.slice(prefix.length));
        } else {
            icons = requestedType === 'bi'
                ? await (window.loadBiIcons?.() ?? [])
                : await (window.loadMdiIcons?.() ?? []);
        }

        if (!iconAc.visible) return;
        if (iconAc.type !== requestedType || iconAc.query !== requestedQuery) return;
        if (loadingEl) loadingEl.style.display = 'none';
        iconAc.results = window.filterIcons?.(icons, requestedQuery) ?? [];
        renderIconAcResults();
    }, 150);
}

function renderIconAcResults(): void {
    const gridEl = document.getElementById('iconAcGrid');
    const emptyEl = document.getElementById('iconAcEmpty');
    if (!gridEl) return;

    if (iconAc.results.length === 0) {
        gridEl.innerHTML = '';
        if (emptyEl) emptyEl.style.display = 'block';
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    const getIconClass = (iconName: string): string => {
        if (iconAc.type === 'icon') {
            if (iconName.startsWith('bi-')) return `bi ${iconName}`;
            if (iconName.startsWith('mdi-')) return `mdi ${iconName}`;
            return iconName;
        }
        return iconAc.type === 'bi' ? `bi bi-${iconName}` : `mdi mdi-${iconName}`;
    };

    gridEl.innerHTML = iconAc.results.map((iconName, index) => `
        <div class="icon-ac-item" data-index="${index}" onclick="selectIconAutocomplete(${index})">
            <i class="${getIconClass(escapeHtml(iconName))}"></i>
            <span>${escapeHtml(iconName)}</span>
        </div>
    `).join('');

    iconAc.selectedIndex = 0;
    highlightIconAcItem();
}

function highlightIconAcItem(): void {
    if (!iconAc.div) return;
    iconAc.div.querySelectorAll('.icon-ac-item').forEach((item, idx) => {
        item.classList.toggle('active', idx === iconAc.selectedIndex);
        if (idx === iconAc.selectedIndex) item.scrollIntoView({ block: 'nearest' });
    });
}

function selectIconAutocomplete(index: number): void {
    const iconName = iconAc.results[index];
    const editor = window.editor;
    if (!iconName || !editor) return;

    const selection = editor.getSelection?.();
    if (!selection) { hideIconAutocomplete(); return; }

    const [from] = selection;
    const line = from[0];
    const col = from[1];

    const lines = editor.getMarkdown().split('\n');
    const textBefore = (lines[line - 1] || '').substring(0, col - 1);

    const selectedIconsOnly = window.selectedIconsOnly ?? false;
    const insertionPrefix = selectedIconsOnly ? '{icon:'
        : (iconAc.type === 'icon' ? '{icon:' : (iconAc.type === 'bi' ? '{bi:' : '{mdi:'));
    const triggerPrefix = iconAc.type === 'icon' ? '{icon:'
        : (iconAc.type === 'bi' ? '{bi:' : '{mdi:');
    const lastTriggerIndex = textBefore.lastIndexOf(triggerPrefix);

    if (lastTriggerIndex !== -1) {
        editor.setSelection?.([line, lastTriggerIndex + 1], [line, col]);
        const finalIconName = (selectedIconsOnly && iconAc.type !== 'icon')
            ? `${iconAc.type}-${iconName}` : iconName;
        editor.insertText?.(`${insertionPrefix}${finalIconName}}`);
    }

    hideIconAutocomplete();
    editor.focus?.();
}

// ─────────────────────────────────────────────────────────────────────────────
// 색상 피커 자동완성
// ─────────────────────────────────────────────────────────────────────────────

const colorAc = {
    visible: false,
    trigger: 'bg' as 'bg' | 'color',
    hue: 0,
    saturation: 1,
    brightness: 1,
    selectedSwatchIndex: -1,
    dragging: null as 'palette' | 'hue' | null,
    div: document.getElementById('color-autocomplete'),
};

const COLOR_SWATCHES = [
    '#000000', '#FFFFFF', '#FF0000', '#FF8000', '#FFFF00',
    '#00FF00', '#00FFFF', '#0080FF', '#0000FF', '#8000FF',
    '#FF00FF', '#FF0080', '#808080', '#C0C0C0', '#800000',
    '#808000', '#008000', '#008080', '#000080', '#800080',
];

function drawColorPalette(): void {
    const canvas = document.getElementById('colorPaletteCanvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;

    for (let x = 0; x < w; x++) {
        const s = x / w;
        for (let y = 0; y < h; y++) {
            const v = 1 - y / h;
            ctx.fillStyle = window.hsvToHex?.(colorAc.hue, s, v) ?? '#000';
            ctx.fillRect(x, y, 1, 1);
        }
    }

    const cx = colorAc.saturation * w;
    const cy = (1 - colorAc.brightness) * h;
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.stroke();
}

function drawHueSlider(): void {
    const canvas = document.getElementById('colorHueSlider') as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;

    const gradient = ctx.createLinearGradient(0, 0, w, 0);
    for (let i = 0; i <= 6; i++) {
        gradient.addColorStop(i / 6, window.hsvToHex?.(i * 60, 1, 1) ?? '#000');
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);

    const cx = (colorAc.hue / 360) * w;
    ctx.beginPath();
    ctx.rect(cx - 3, 0, 6, h);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.rect(cx - 4, -1, 8, h + 2);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.stroke();
}

function updateColorPreview(): void {
    const hex = window.hsvToHex?.(colorAc.hue, colorAc.saturation, colorAc.brightness) ?? '#000000';
    const previewBox = document.getElementById('colorPreviewBox');
    const hexInput = document.getElementById('colorHexInput') as HTMLInputElement | null;
    if (previewBox) previewBox.style.backgroundColor = hex;
    if (hexInput) hexInput.value = hex.toUpperCase();
}

function renderColorSwatches(): void {
    const container = document.getElementById('colorAcSwatches');
    if (!container) return;
    container.innerHTML = COLOR_SWATCHES.map((color, i) =>
        `<div class="color-swatch${i === colorAc.selectedSwatchIndex ? ' active' : ''}" data-index="${i}" style="background:${color};" title="${color}"></div>`
    ).join('');

    container.querySelectorAll('.color-swatch').forEach(el => {
        const htmlEl = el as HTMLElement;
        const handler = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            const idx = parseInt(htmlEl.dataset.index ?? '0');
            selectColorSwatch(idx);
            applyColorAutocomplete();
        };
        htmlEl.addEventListener('click', handler);
        htmlEl.addEventListener('touchend', handler);
    });
}

function selectColorSwatch(index: number): void {
    colorAc.selectedSwatchIndex = index;
    const hex = COLOR_SWATCHES[index];
    const hsv = window.hexToHsv?.(hex) ?? { h: 0, s: 0, v: 0 };
    colorAc.hue = hsv.h;
    colorAc.saturation = hsv.s;
    colorAc.brightness = hsv.v;
    drawColorPalette();
    drawHueSlider();
    updateColorPreview();
    renderColorSwatches();
}

function getCanvasPos(canvas: HTMLCanvasElement, e: MouseEvent | TouchEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    let clientX: number, clientY: number;
    if ('touches' in e && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    } else {
        clientX = (e as MouseEvent).clientX;
        clientY = (e as MouseEvent).clientY;
    }
    return {
        x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
    };
}

function initColorPickerCanvasEvents(): void {
    const paletteCanvas = document.getElementById('colorPaletteCanvas') as HTMLCanvasElement | null;
    const hueCanvas = document.getElementById('colorHueSlider') as HTMLCanvasElement | null;
    if (!paletteCanvas || !hueCanvas) return;

    function handlePaletteInteraction(e: MouseEvent | TouchEvent): void {
        const pos = getCanvasPos(paletteCanvas!, e);
        colorAc.saturation = pos.x;
        colorAc.brightness = 1 - pos.y;
        colorAc.selectedSwatchIndex = -1;
        drawColorPalette();
        updateColorPreview();
        renderColorSwatches();
    }

    function handleHueInteraction(e: MouseEvent | TouchEvent): void {
        const pos = getCanvasPos(hueCanvas!, e);
        colorAc.hue = pos.x * 360;
        colorAc.selectedSwatchIndex = -1;
        drawColorPalette();
        drawHueSlider();
        updateColorPreview();
        renderColorSwatches();
    }

    paletteCanvas.addEventListener('mousedown', (e) => { e.preventDefault(); colorAc.dragging = 'palette'; handlePaletteInteraction(e); });
    hueCanvas.addEventListener('mousedown', (e) => { e.preventDefault(); colorAc.dragging = 'hue'; handleHueInteraction(e); });
    document.addEventListener('mousemove', (e) => {
        if (colorAc.dragging === 'palette') handlePaletteInteraction(e);
        else if (colorAc.dragging === 'hue') handleHueInteraction(e);
    });
    document.addEventListener('mouseup', () => { colorAc.dragging = null; });

    paletteCanvas.addEventListener('touchstart', (e) => { e.preventDefault(); colorAc.dragging = 'palette'; handlePaletteInteraction(e); }, { passive: false });
    hueCanvas.addEventListener('touchstart', (e) => { e.preventDefault(); colorAc.dragging = 'hue'; handleHueInteraction(e); }, { passive: false });
    document.addEventListener('touchmove', (e) => {
        if (colorAc.dragging === 'palette') { e.preventDefault(); handlePaletteInteraction(e); }
        else if (colorAc.dragging === 'hue') { e.preventDefault(); handleHueInteraction(e); }
    }, { passive: false });
    document.addEventListener('touchend', () => { colorAc.dragging = null; });

    const hexInput = document.getElementById('colorHexInput') as HTMLInputElement | null;
    if (hexInput) {
        hexInput.addEventListener('input', () => {
            const val = hexInput.value.trim();
            if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
                const hsv = window.hexToHsv?.(val) ?? { h: 0, s: 0, v: 0 };
                colorAc.hue = hsv.h;
                colorAc.saturation = hsv.s;
                colorAc.brightness = hsv.v;
                colorAc.selectedSwatchIndex = -1;
                drawColorPalette();
                drawHueSlider();
                updateColorPreview();
                renderColorSwatches();
            }
        });
        hexInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); applyColorAutocomplete(); }
        });
    }

    const applyBtn = document.getElementById('colorApplyBtn');
    if (applyBtn) {
        applyBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); applyColorAutocomplete(); });
    }
}

function hideColorAutocomplete(): void {
    colorAc.visible = false;
    colorAc.dragging = null;
    colorAc.selectedSwatchIndex = -1;
    if (colorAc.div) colorAc.div.style.display = 'none';
}

function showColorAutocomplete(query: string, type: 'bg' | 'color'): void {
    colorAc.trigger = type;
    colorAc.visible = true;

    const typeLabelEl = document.getElementById('colorAcTypeLabel');
    if (typeLabelEl) typeLabelEl.textContent = type === 'bg' ? '배경색 선택' : '글자색 선택';

    window.positionDropdownAtCursor?.(colorAc.div, 280);

    if (query && /^#[0-9A-Fa-f]{6}$/.test(query.trim())) {
        const hsv = window.hexToHsv?.(query.trim()) ?? { h: 0, s: 0, v: 0 };
        colorAc.hue = hsv.h;
        colorAc.saturation = hsv.s;
        colorAc.brightness = hsv.v;
        colorAc.selectedSwatchIndex = -1;
    }

    renderColorSwatches();
    drawColorPalette();
    drawHueSlider();
    updateColorPreview();
}

function applyColorAutocomplete(): void {
    const editor = window.editor;
    if (!editor) { hideColorAutocomplete(); return; }

    const hex = (window.hsvToHex?.(colorAc.hue, colorAc.saturation, colorAc.brightness) ?? '#000000').toUpperCase();
    const selection = editor.getSelection?.();
    if (!selection) { hideColorAutocomplete(); return; }

    const [from] = selection;
    const line = from[0];
    const col = from[1];

    const lines = editor.getMarkdown().split('\n');
    const textBefore = (lines[line - 1] || '').substring(0, col - 1);
    const prefix = colorAc.trigger === 'bg' ? '{bg:' : '{color:';
    const lastTriggerIndex = textBefore.lastIndexOf(prefix);

    if (lastTriggerIndex !== -1) {
        editor.setSelection?.([line, lastTriggerIndex + 1], [line, col]);
        editor.insertText?.(`${prefix}${hex}}`);
    }

    hideColorAutocomplete();
    editor.focus?.();
}

initColorPickerCanvasEvents();

// ─────────────────────────────────────────────────────────────────────────────
// 타임스탬프 / 달력 자동완성
// ─────────────────────────────────────────────────────────────────────────────

const timestampAc = {
    visible: false,
    trigger: 'dday' as string,
    div: document.getElementById('timestamp-autocomplete'),
};

const cal = {
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
    selectedDate: null as string | null,
    yearPanelBase: Math.floor(new Date().getFullYear() / 12) * 12,
    showingYearPanel: false,
};

function _calPad(n: number): string { return String(n).padStart(2, '0'); }

function _renderCalendar(): void {
    const grid = document.getElementById('tsCalGrid');
    const ymBtn = document.getElementById('tsCalYearMonth');
    const yearRangeEl = document.getElementById('tsCalYearRange');
    const yearGrid = document.getElementById('tsCalYearGrid');
    const calSection = document.getElementById('tsCalSection');
    const yearPanel = document.getElementById('tsCalYearPanel');
    if (!grid || !ymBtn) return;

    ymBtn.textContent = `${cal.year}년 ${_calPad(cal.month)}월`;

    if (cal.showingYearPanel) {
        if (calSection) calSection.style.display = 'none';
        if (yearPanel) yearPanel.style.display = 'block';
        const base = cal.yearPanelBase;
        if (yearRangeEl) yearRangeEl.textContent = `${base} – ${base + 11}`;
        if (yearGrid) {
            yearGrid.innerHTML = '';
            for (let y = base; y < base + 12; y++) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'ts-cal-year-btn' + (y === cal.year ? ' selected' : '');
                btn.textContent = String(y);
                btn.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    cal.year = y;
                    cal.showingYearPanel = false;
                    _renderCalendar();
                });
                yearGrid.appendChild(btn);
            }
        }
        return;
    }

    if (calSection) calSection.style.display = 'block';
    if (yearPanel) yearPanel.style.display = 'none';

    const firstDay = new Date(cal.year, cal.month - 1, 1).getDay();
    const daysInMonth = new Date(cal.year, cal.month, 0).getDate();
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${_calPad(today.getMonth() + 1)}-${_calPad(today.getDate())}`;

    grid.innerHTML = '';
    for (let i = 0; i < firstDay; i++) {
        const empty = document.createElement('div');
        empty.className = 'ts-cal-cell empty';
        grid.appendChild(empty);
    }
    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${cal.year}-${_calPad(cal.month)}-${_calPad(d)}`;
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'ts-cal-cell';
        if (dateStr === todayStr) cell.classList.add('today');
        if (dateStr === cal.selectedDate) cell.classList.add('selected');
        cell.textContent = String(d);
        cell.addEventListener('mousedown', (e) => {
            e.preventDefault();
            cal.selectedDate = dateStr;
            const inputEl = document.getElementById('tsAcInput') as HTMLInputElement | null;
            if (inputEl) inputEl.value = dateStr;
            applyTimestampAutocomplete();
        });
        grid.appendChild(cell);
    }
}

function _initCalendarEvents(): void {
    document.getElementById('tsCalPrev')?.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (cal.showingYearPanel) { cal.yearPanelBase -= 12; }
        else { cal.month--; if (cal.month < 1) { cal.month = 12; cal.year--; } }
        _renderCalendar();
    });
    document.getElementById('tsCalNext')?.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (cal.showingYearPanel) { cal.yearPanelBase += 12; }
        else { cal.month++; if (cal.month > 12) { cal.month = 1; cal.year++; } }
        _renderCalendar();
    });
    document.getElementById('tsCalYearMonth')?.addEventListener('mousedown', (e) => {
        e.preventDefault();
        cal.yearPanelBase = Math.floor(cal.year / 12) * 12;
        cal.showingYearPanel = !cal.showingYearPanel;
        _renderCalendar();
    });
    document.getElementById('tsCalYearPrev')?.addEventListener('mousedown', (e) => {
        e.preventDefault();
        cal.yearPanelBase -= 12;
        _renderCalendar();
    });
    document.getElementById('tsCalYearNext')?.addEventListener('mousedown', (e) => {
        e.preventDefault();
        cal.yearPanelBase += 12;
        _renderCalendar();
    });
}
_initCalendarEvents();

function hideTimestampAutocomplete(): void {
    timestampAc.visible = false;
    if (timestampAc.div) timestampAc.div.style.display = 'none';
}

function showTimestampAutocomplete(trigger: string): void {
    timestampAc.trigger = trigger;
    timestampAc.visible = true;

    const iconEl = document.getElementById('tsAcIcon');
    const labelEl = document.getElementById('tsAcTypeLabel');
    const inputEl = document.getElementById('tsAcInput') as HTMLInputElement | null;
    const presetsEl = document.getElementById('tsAcPresets');
    const calSec = document.getElementById('tsCalSection');
    const yearPanel = document.getElementById('tsCalYearPanel');

    const isDate = trigger === 'age' || trigger === 'dday' || trigger === 'calendar';

    if (calSec) calSec.style.display = isDate ? 'block' : 'none';
    if (yearPanel) yearPanel.style.display = 'none';
    if (presetsEl) presetsEl.style.display = isDate ? 'none' : 'flex';

    const today = new Date();
    function _localDateStr(d: Date): string {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    function _offsetDate(days: number): string {
        const d = new Date(today);
        d.setDate(d.getDate() + days);
        return _localDateStr(d);
    }
    function _offsetYear(years: number): string {
        const d = new Date(today);
        d.setFullYear(d.getFullYear() + years);
        return _localDateStr(d);
    }

    if (trigger === 'age') {
        if (iconEl) iconEl.className = 'mdi mdi-cake-variant-outline';
        if (labelEl) labelEl.textContent = '만 나이 생년월일';
        if (inputEl) { inputEl.type = 'text'; inputEl.placeholder = 'YYYY-MM-DD'; inputEl.readOnly = true; }
        const initDate = _offsetYear(-20);
        cal.year = parseInt(initDate.slice(0, 4), 10);
        cal.month = parseInt(initDate.slice(5, 7), 10);
        cal.selectedDate = initDate;
        cal.showingYearPanel = false;
        if (inputEl) inputEl.value = initDate;
    } else if (trigger === 'dday') {
        if (iconEl) iconEl.className = 'mdi mdi-calendar';
        if (labelEl) labelEl.textContent = 'D-Day 날짜 선택';
        if (inputEl) { inputEl.type = 'text'; inputEl.placeholder = 'YYYY-MM-DD'; inputEl.readOnly = true; }
        const initDate = _offsetDate(0);
        cal.year = parseInt(initDate.slice(0, 4), 10);
        cal.month = parseInt(initDate.slice(5, 7), 10);
        cal.selectedDate = initDate;
        cal.showingYearPanel = false;
        if (inputEl) inputEl.value = initDate;
    } else if (trigger === 'calendar') {
        if (iconEl) iconEl.className = 'mdi mdi-calendar-month';
        if (labelEl) labelEl.textContent = '캘린더 날짜 선택';
        if (inputEl) { inputEl.type = 'text'; inputEl.placeholder = 'YYYY-MM-DD'; inputEl.readOnly = true; }
        const initDate = _offsetDate(0);
        cal.year = parseInt(initDate.slice(0, 4), 10);
        cal.month = parseInt(initDate.slice(5, 7), 10);
        cal.selectedDate = initDate;
        cal.showingYearPanel = false;
        if (inputEl) inputEl.value = initDate;
    } else {
        if (iconEl) iconEl.className = trigger === 'timer' ? 'mdi mdi-timer-outline' : 'mdi mdi-clock-outline';
        if (labelEl) labelEl.textContent = trigger === 'timer' ? '타이머 시간 선택' : '표시 시간 선택';
        if (inputEl) { inputEl.type = 'text'; inputEl.placeholder = 'Unix 타임스탬프 (초)'; inputEl.readOnly = false; }
        const now = Math.floor(Date.now() / 1000);
        const presets = [
            { label: '지금',   value: now },
            { label: '+1시간', value: now + 3600 },
            { label: '+1일',   value: now + 86400 },
            { label: '+1주',   value: now + 7 * 86400 },
            { label: '+1달',   value: now + 30 * 86400 },
            { label: '+1년',   value: now + 365 * 86400 },
        ];
        if (presetsEl) {
            presetsEl.innerHTML = presets.map(p =>
                `<button type="button" class="ts-ac-preset-btn" data-value="${p.value}">${escapeHtml(p.label)}</button>`
            ).join('');
            presetsEl.querySelectorAll('.ts-ac-preset-btn').forEach(btn => {
                btn.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    if (inputEl) inputEl.value = (btn as HTMLElement).dataset.value ?? '';
                    applyTimestampAutocomplete();
                });
            });
        }
        if (inputEl) inputEl.value = String(now);
    }

    if (isDate) _renderCalendar();
    window.positionDropdownAtCursor?.(timestampAc.div, 294);
}

function applyTimestampAutocomplete(): void {
    const editor = window.editor;
    if (!editor) { hideTimestampAutocomplete(); return; }

    const inputEl = document.getElementById('tsAcInput') as HTMLInputElement | null;
    if (!inputEl) { hideTimestampAutocomplete(); return; }
    const val = inputEl.value.trim();
    if (!val) { hideTimestampAutocomplete(); return; }

    const selection = editor.getSelection?.();
    if (!selection) { hideTimestampAutocomplete(); return; }

    const [from] = selection;
    const line = from[0];
    const col = from[1];

    const lines = editor.getMarkdown().split('\n');
    const textBefore = (lines[line - 1] || '').substring(0, col - 1);
    const prefix = `{${timestampAc.trigger}:`;
    const lastTriggerIndex = textBefore.lastIndexOf(prefix);
    if (lastTriggerIndex !== -1) {
        editor.setSelection?.([line, lastTriggerIndex + 1], [line, col]);
        editor.insertText?.(`${prefix}${val}}`);
    }

    hideTimestampAutocomplete();
    editor.focus?.();
}

// 적용 버튼 / 입력창 키보드
(function (): void {
    const applyBtn = document.getElementById('tsAcApplyBtn');
    if (applyBtn) {
        applyBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); applyTimestampAutocomplete(); });
    }
    const inputEl = document.getElementById('tsAcInput') as HTMLInputElement | null;
    if (inputEl) {
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault(); e.stopPropagation(); applyTimestampAutocomplete();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                hideTimestampAutocomplete();
                window.editor?.focus?.();
            }
        });
    }
})();

// ─────────────────────────────────────────────────────────────────────────────
// 팔레트 자동완성
// ─────────────────────────────────────────────────────────────────────────────

const paletteAc: PaletteAcState = {
    visible: false,
    results: [],
    selectedIndex: -1,
    query: '',
    div: document.getElementById('palette-autocomplete'),
    replaceRange: null,
};

function getAllPalettesForEditor(): PaletteInfo[] {
    const isDark = window.getIsDarkMode?.() ??
        !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const hardcoded = window.WIKI_HARDCODED_PALETTES ?? {};
    const custom = (window.appConfig?.palettes && typeof window.appConfig.palettes === 'object')
        ? window.appConfig.palettes as Record<string, unknown>
        : {};
    const merged: Record<string, { source: 'preset' | 'custom' | 'override'; entry: unknown }> = {};
    for (const [name, entry] of Object.entries(hardcoded)) {
        merged[name] = { source: 'preset', entry };
    }
    for (const [name, entry] of Object.entries(custom)) {
        if (!entry || typeof entry !== 'object') continue;
        merged[name] = { source: merged[name] ? 'override' : 'custom', entry };
    }
    return Object.entries(merged).map(([name, info]) => {
        const e = info.entry as { light?: { bg?: string; color?: string }; dark?: { bg?: string; color?: string } };
        const variant = isDark ? (e.dark || e.light) : (e.light || e.dark);
        return { name, source: info.source as 'preset' | 'custom' | 'override', variant: variant || {} };
    });
}

function hidePaletteAutocomplete(): void {
    paletteAc.visible = false;
    paletteAc.results = [];
    paletteAc.selectedIndex = -1;
    paletteAc.replaceRange = null;
    if (paletteAc.div) paletteAc.div.style.display = 'none';
}

function showPaletteAutocomplete(query: string, opts?: { showAll?: boolean }): void {
    const showAll = !!(opts?.showAll);
    paletteAc.query = showAll ? '' : (query || '').toLowerCase();
    paletteAc.visible = true;

    window.positionDropdownAtCursor?.(paletteAc.div, 280);

    const all = getAllPalettesForEditor();
    const q = paletteAc.query;
    let results: PaletteInfo[];
    if (!q) {
        results = all;
    } else {
        const exact  = all.filter(p => p.name.toLowerCase() === q);
        const starts = all.filter(p => p.name.toLowerCase() !== q && p.name.toLowerCase().startsWith(q));
        const inc    = all.filter(p => !p.name.toLowerCase().startsWith(q) && p.name.toLowerCase().includes(q));
        results = [...exact, ...starts, ...inc];
    }
    paletteAc.results = results;
    paletteAc.selectedIndex = results.length > 0 ? 0 : -1;
    renderPaletteAcResults();
}

function renderPaletteAcResults(): void {
    const listEl = document.getElementById('paletteAcList');
    const emptyEl = document.getElementById('paletteAcEmpty');
    if (!listEl) return;
    if (paletteAc.results.length === 0) {
        listEl.innerHTML = '';
        if (emptyEl) emptyEl.style.display = 'block';
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    listEl.innerHTML = '';

    paletteAc.results.forEach((p, i) => {
        const rawBg    = p.variant.bg    || 'transparent';
        const rawColor = p.variant.color || 'inherit';
        const bg    = window._isSafeCssColor?.(rawBg)    ? rawBg    : 'transparent';
        const color = window._isSafeCssColor?.(rawColor) ? rawColor : 'inherit';
        const tag = p.source === 'preset' ? '기본' : p.source === 'override' ? '오버라이드' : '커스텀';

        const itemEl  = document.createElement('div');
        itemEl.className = `palette-ac-item${i === paletteAc.selectedIndex ? ' active' : ''}`;
        itemEl.dataset.index = String(i);

        const badgeEl = document.createElement('span');
        badgeEl.className = 'palette-ac-badge';
        badgeEl.textContent = p.name;
        badgeEl.style.backgroundColor = bg;
        badgeEl.style.color = color;

        const nameEl = document.createElement('span');
        nameEl.className = 'palette-ac-name';
        nameEl.textContent = p.name;

        const tagEl = document.createElement('span');
        tagEl.className = 'palette-ac-tag';
        tagEl.textContent = tag;

        itemEl.appendChild(badgeEl);
        itemEl.appendChild(nameEl);
        itemEl.appendChild(tagEl);

        itemEl.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            selectPaletteAutocomplete(parseInt(itemEl.dataset.index ?? '0'));
        });

        listEl.appendChild(itemEl);
    });
}

function highlightPaletteAcItem(): void {
    if (!paletteAc.div) return;
    paletteAc.div.querySelectorAll('.palette-ac-item').forEach((item, idx) => {
        item.classList.toggle('active', idx === paletteAc.selectedIndex);
        if (idx === paletteAc.selectedIndex) item.scrollIntoView({ block: 'nearest' });
    });
}

function selectPaletteAutocomplete(index: number): void {
    const item = paletteAc.results[index];
    const editor = window.editor;
    if (!item || !editor) return;

    if (paletteAc.replaceRange && window._cmView) {
        const view = window._cmView;
        const { from, to } = paletteAc.replaceRange;
        const insert = `{palette:${item.name}}`;
        const docLen = view.state.doc.length;
        const safeFrom = Math.max(0, Math.min(from, docLen));
        const safeTo   = Math.max(safeFrom, Math.min(to, docLen));
        view.dispatch({ changes: { from: safeFrom, to: safeTo, insert }, selection: { anchor: safeFrom + insert.length } });
        hidePaletteAutocomplete();
        view.focus();
        return;
    }

    const selection = editor.getSelection?.();
    if (!selection) { hidePaletteAutocomplete(); return; }

    const [from] = selection;
    const line = from[0];
    const col  = from[1];

    const lines = editor.getMarkdown().split('\n');
    const textBefore = (lines[line - 1] || '').substring(0, col - 1);
    const prefix = '{palette:';
    const lastTriggerIndex = textBefore.lastIndexOf(prefix);

    if (lastTriggerIndex !== -1) {
        editor.setSelection?.([line, lastTriggerIndex + 1], [line, col]);
        editor.insertText?.(`${prefix}${item.name}}`);
    }

    hidePaletteAutocomplete();
    editor.focus?.();
}

// ─────────────────────────────────────────────────────────────────────────────
// 카테고리 태그 UI
// ─────────────────────────────────────────────────────────────────────────────

const categoryInputHidden = document.getElementById('categoryInput') as HTMLInputElement | null;
const categoryTagContainer = document.getElementById('categoryTagContainer');
const categoryTagInput = document.getElementById('categoryTagInput') as HTMLInputElement | null;

// edit.js(raw) / edit-summary.ts(ESM) 가 window.categoryTags 로 읽으므로 초기화
window.categoryTags = [];

// 사용자가 chip 추가 시 카테고리 ACL 템플릿 적용 모드를 선택한 결과.
// key: 카테고리명, value: 'overwrite' | 'merge' | 'ignore'.
// 빈 객체로 초기화해 서버가 "모던 클라이언트" 로 인식하도록 만든다 (레거시 클라이언트는 키 누락).
window.categoryAclChoices = {};

type EditAclFlag = 'aged' | 'page_editor' | 'any_editor' | 'admin_only';
interface EditAcl { flags: EditAclFlag[]; }
type CategoryAclMode = 'overwrite' | 'merge' | 'ignore';

const CHECK_CATEGORY_FLAG_LABELS: Record<EditAclFlag, string> = {
    aged: '가입 N일 이상',
    page_editor: '본 문서 편집 이력',
    any_editor: '임의 문서 편집 이력',
    admin_only: '관리자 전용',
};

function formatAclFlags(acl: EditAcl): string {
    return acl.flags.map(f => CHECK_CATEGORY_FLAG_LABELS[f] ?? f).join(' 그리고 ');
}

async function checkCategoryWithServer(name: string): Promise<{ ok: boolean; reason?: string; edit_acl?: EditAcl | null }> {
    try {
        const res = await fetch('/api/w/check-category', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ category: name }),
        });
        if (!res.ok) {
            return { ok: true };
        }
        return await res.json() as { ok: boolean; reason?: string; edit_acl?: EditAcl | null };
    } catch (e) {
        console.warn('check-category 실패 (네트워크) — 클라이언트 검증으로만 진행:', e);
        return { ok: true };
    }
}

async function promptCategoryAclMode(name: string, acl: EditAcl): Promise<CategoryAclMode | null> {
    if (!window.Swal) {
        return 'merge';
    }
    const flagsText = formatAclFlags(acl);
    const html = `
        <div style="text-align: left; font-size: 0.92em;">
            <div style="margin-bottom: 8px;">카테고리 <b>${escapeHtml(name)}</b> 에 다음 편집 ACL 템플릿이 설정되어 있습니다.</div>
            <div style="margin-bottom: 14px; padding: 8px 10px; background: var(--bs-tertiary-bg, #f4f4f6); border-radius: 6px;"><i class="mdi mdi-shield-account"></i> ${escapeHtml(flagsText)} <span class="text-muted">(모두 충족 — AND)</span></div>
            <div style="margin-bottom: 6px;">이 카테고리를 문서에 적용하면서 카테고리 ACL 을 어떻게 반영할까요?</div>
            <div style="display: flex; flex-direction: column; gap: 6px;">
                <label><input type="radio" name="catAclMode" value="merge" checked> 합치기 — 기존 문서 ACL 의 조건과 카테고리 조건을 합쳐 더 엄격하게 적용</label>
                <label><input type="radio" name="catAclMode" value="overwrite"> 덮어쓰기 — 기존 문서 ACL 을 카테고리 ACL 로 통째 교체</label>
                <label><input type="radio" name="catAclMode" value="ignore"> 무시 — 문서 ACL 을 그대로 유지 (이번에는 적용하지 않음)</label>
            </div>
        </div>
    `;
    const result = await window.Swal.fire({
        title: '카테고리 ACL 적용',
        html,
        icon: 'question',
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: '적용',
        cancelButtonText: '취소 (이 카테고리 추가 안 함)',
        preConfirm: () => {
            const el = document.querySelector('input[name="catAclMode"]:checked') as HTMLInputElement | null;
            return (el?.value ?? 'merge') as CategoryAclMode;
        },
    });
    if (!result.isConfirmed) return null;
    const v = (result.value as CategoryAclMode) ?? 'merge';
    return v;
}

const categoryAc = {
    visible: false,
    results: [] as string[],
    selectedIndex: -1,
    query: '',
    lastQuery: null as string | null,
    debounceTimer: null as ReturnType<typeof setTimeout> | null,
    div: document.getElementById('category-autocomplete'),
};

function hideCategoryAutocomplete(): void {
    categoryAc.visible = false;
    categoryAc.results = [];
    categoryAc.selectedIndex = -1;
    categoryAc.lastQuery = null;
    if (categoryAc.div) categoryAc.div.style.display = 'none';
}

function showCategoryAutocomplete(query: string): void {
    categoryAc.query = query;
    categoryAc.visible = true;

    if (categoryAc.div && categoryTagContainer) {
        const rect = categoryTagContainer.getBoundingClientRect();
        categoryAc.div.style.left  = rect.left + 'px';
        categoryAc.div.style.top   = (rect.bottom + 2) + 'px';
        categoryAc.div.style.width = rect.width + 'px';
        categoryAc.div.style.display = 'block';
    }

    if (categoryAc.query === categoryAc.lastQuery) return;
    categoryAc.lastQuery = categoryAc.query;

    if (categoryAc.debounceTimer !== null) clearTimeout(categoryAc.debounceTimer);
    categoryAc.debounceTimer = setTimeout(async () => {
        if (!categoryAc.visible) return;
        try {
            const res = await fetch(`/api/w/search-categories?q=${encodeURIComponent(categoryAc.query)}`);
            if (!res.ok) return;
            const data = await res.json() as { results?: string[] };
            categoryAc.results = data.results || [];
            renderCategoryAcResults();
        } catch (e) {
            console.error('Category autocomplete fetch error:', e);
        }
    }, 200);
}

function renderCategoryAcResults(): void {
    if (!categoryAc.div) return;
    if (categoryAc.results.length === 0) { hideCategoryAutocomplete(); return; }
    categoryAc.div.innerHTML = categoryAc.results.map((item, index) => `
        <div class="list-group-item cat-ac-item" data-index="${index}" onmousedown="selectCategoryAcByIndex(${index})">
            <i class="mdi mdi-tag-outline"></i>
            <span>${escapeHtml(item)}</span>
        </div>
    `).join('');
    categoryAc.selectedIndex = -1;
    highlightCategoryAcItem();
}

function highlightCategoryAcItem(): void {
    if (!categoryAc.div) return;
    categoryAc.div.querySelectorAll('.cat-ac-item').forEach((item, idx) => {
        item.classList.toggle('active', idx === categoryAc.selectedIndex);
        if (idx === categoryAc.selectedIndex) item.scrollIntoView({ block: 'nearest' });
    });
}

function selectCategoryAc(index: number): void {
    const item = categoryAc.results[index];
    if (!item) return;
    addCategoryTag(item);
    if (categoryTagInput) categoryTagInput.value = '';
    hideCategoryAutocomplete();
    categoryTagInput?.focus();
}

function getAutoCategory(): string | null {
    const s = window.slug;
    if (!s) return null;
    const prefix = '카테고리:';
    if (!s.startsWith(prefix)) return null;
    const name = s.slice(prefix.length).trim();
    return name || null;
}

function renderCategoryTags(): void {
    if (!categoryTagContainer) return;
    categoryTagContainer.querySelectorAll('.category-tag').forEach(tag => tag.remove());

    const autoCategory = getAutoCategory();
    (window.categoryTags ?? []).forEach((tagText, index) => {
        const tagEl = document.createElement('span');
        tagEl.className = 'category-tag';
        if (autoCategory && tagText === autoCategory) {
            tagEl.innerHTML = `<span>${escapeHtml(tagText)}</span> <i class="mdi mdi-lock" title="이 카테고리는 자동 적용되며 제거할 수 없습니다." style="cursor:default;opacity:.6;"></i>`;
        } else {
            tagEl.innerHTML = `<span>${escapeHtml(tagText)}</span> <i class="mdi mdi-close" onclick="removeCategoryTag(${index})"></i>`;
        }
        if (categoryTagInput) {
            categoryTagContainer.insertBefore(tagEl, categoryTagInput);
        } else {
            categoryTagContainer.appendChild(tagEl);
        }
    });
    if (categoryInputHidden) {
        categoryInputHidden.value = (window.categoryTags ?? []).join(',');
        categoryInputHidden.dispatchEvent(new Event('input'));
    }
}

async function addCategoryTag(tag: string): Promise<void> {
    const cleanTag = tag.trim();
    if (!cleanTag) return;
    if (!window.categoryTags) window.categoryTags = [];
    if (!window.categoryAclChoices) window.categoryAclChoices = {};

    if (!/^[가-힣a-zA-Z0-9\s_.-]+$/.test(cleanTag)) {
        window.Swal?.fire({
            icon: 'warning',
            title: '특수문자 제외',
            text: '특수문자를 제외한 카테고리 이름을 입력해 주세요.',
            toast: true,
            position: 'top-end',
            timer: 2000,
            showConfirmButton: false,
        });
        return;
    }

    if (window.categoryTags.includes(cleanTag)) return;

    // 1) 서버 사전 검증 — admin_only 카테고리 차단 + ACL 템플릿 동봉
    const check = await checkCategoryWithServer(cleanTag);
    if (!check.ok) {
        if (check.reason === 'admin_only') {
            window.Swal?.fire({
                icon: 'warning',
                title: '관리자 전용 카테고리',
                text: `"${cleanTag}" 카테고리는 관리자만 적용할 수 있습니다.`,
            });
        } else {
            window.Swal?.fire({
                icon: 'warning',
                title: '카테고리 사용 불가',
                text: `"${cleanTag}" 카테고리는 사용할 수 없습니다.`,
            });
        }
        return;
    }

    // 2) ACL 템플릿이 있으면 사용자에게 모드 선택
    if (check.edit_acl && check.edit_acl.flags && check.edit_acl.flags.length > 0) {
        const mode = await promptCategoryAclMode(cleanTag, check.edit_acl);
        if (mode === null) return; // 사용자가 취소 — chip 추가하지 않음
        window.categoryAclChoices[cleanTag] = mode;
    }

    window.categoryTags.push(cleanTag);
    renderCategoryTags();
}

function removeCategoryTag(index: number): void {
    const removed = window.categoryTags?.[index];
    if (removed && removed === getAutoCategory()) return;
    window.categoryTags?.splice(index, 1);
    if (removed && window.categoryAclChoices && Object.prototype.hasOwnProperty.call(window.categoryAclChoices, removed)) {
        delete window.categoryAclChoices[removed];
    }
    renderCategoryTags();
}

if (categoryTagInput) {
    categoryTagInput.addEventListener('keydown', (e) => {
        if (e.isComposing) return;

        if (categoryAc.visible) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (categoryAc.results.length > 0) {
                    categoryAc.selectedIndex = (categoryAc.selectedIndex + 1) % categoryAc.results.length;
                    highlightCategoryAcItem();
                }
                return;
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (categoryAc.results.length > 0) {
                    categoryAc.selectedIndex = (categoryAc.selectedIndex - 1 + categoryAc.results.length) % categoryAc.results.length;
                    highlightCategoryAcItem();
                }
                return;
            } else if (e.key === 'Escape') {
                e.preventDefault();
                hideCategoryAutocomplete();
                return;
            } else if ((e.key === 'Enter' || e.key === 'Tab') && categoryAc.selectedIndex >= 0) {
                e.preventDefault();
                selectCategoryAc(categoryAc.selectedIndex);
                return;
            }
        }

        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            if (categoryTagInput.value.trim()) {
                categoryTagInput.value.split(',').forEach(t => addCategoryTag(t));
                categoryTagInput.value = '';
                hideCategoryAutocomplete();
            }
        } else if (e.key === 'Backspace' && categoryTagInput.value === '') {
            if ((window.categoryTags?.length ?? 0) > 0) {
                const last = window.categoryTags![window.categoryTags!.length - 1];
                if (last === getAutoCategory()) return;
                window.categoryTags!.pop();
                renderCategoryTags();
            }
        }
    });

    categoryTagInput.addEventListener('blur', () => {
        setTimeout(() => {
            hideCategoryAutocomplete();
            if (categoryTagInput.value.trim()) {
                categoryTagInput.value.split(',').forEach(t => addCategoryTag(t));
                categoryTagInput.value = '';
            }
        }, 150);
    });

    categoryTagInput.addEventListener('input', () => {
        if (categoryTagInput.value.includes(',')) {
            const parts = categoryTagInput.value.split(',');
            const lastFragment = parts.pop() ?? '';
            parts.forEach(t => addCategoryTag(t));
            categoryTagInput.value = lastFragment;
            hideCategoryAutocomplete();
            return;
        }
        showCategoryAutocomplete(categoryTagInput.value.trim());
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 위키 링크 / 틀 자동완성
// ─────────────────────────────────────────────────────────────────────────────

const wikiAc = {
    visible: false,
    type: 'link' as 'link' | 'template',
    results: [] as WikiResult[],
    selectedIndex: -1,
    query: '',
    lastQuery: null as string | null,
    debounceTimer: null as ReturnType<typeof setTimeout> | null,
    div: document.getElementById('wiki-autocomplete'),
};

function hideAutocomplete(): void {
    wikiAc.visible = false;
    wikiAc.results = [];
    wikiAc.selectedIndex = -1;
    wikiAc.lastQuery = null;
    if (wikiAc.div) wikiAc.div.style.display = 'none';
}

function showAutocomplete(query: string, type: 'link' | 'template'): void {
    wikiAc.query = query;
    wikiAc.type = type;
    wikiAc.visible = true;

    window.positionDropdownAtCursor?.(wikiAc.div, 250);

    if (wikiAc.query === wikiAc.lastQuery) return;
    wikiAc.lastQuery = wikiAc.query;

    if (wikiAc.debounceTimer !== null) clearTimeout(wikiAc.debounceTimer);
    wikiAc.debounceTimer = setTimeout(async () => {
        if (!wikiAc.visible) return;
        try {
            let acUrl = `/api/w/search-titles?q=${encodeURIComponent(wikiAc.query)}&type=${wikiAc.type}`;
            if (wikiAc.type === 'template' && window.slug) {
                acUrl += `&exclude=${encodeURIComponent(window.slug)}`;
            }
            const res = await fetch(acUrl);
            if (!res.ok) return;
            const data = await res.json() as { results?: WikiResult[] };
            wikiAc.results = data.results || [];
            renderAutocompleteResults();
        } catch (e) {
            console.error('Autocomplete fetch error:', e);
        }
    }, 300);
}

function renderAutocompleteResults(): void {
    if (!wikiAc.div) return;
    if (wikiAc.results.length === 0) {
        wikiAc.div.innerHTML = '<div class="list-group-item text-muted" style="font-size:0.85rem">결과 없음</div>';
        return;
    }
    wikiAc.div.innerHTML = wikiAc.results.map((item, index) => `
        <div class="list-group-item autocomplete-item" data-index="${index}" onclick="selectAutocomplete(${index})">
            <i class="mdi ${wikiAc.type === 'template' ? 'mdi-toy-brick-outline' : 'mdi-file-document-outline'}"></i>
            <span class="item-title">${escapeHtml(item.slug)}</span>
            <span class="item-type">${wikiAc.type === 'template' ? '틀' : '문서'}</span>
        </div>
    `).join('');
    wikiAc.selectedIndex = 0;
    highlightAutocompleteItem();
}

function highlightAutocompleteItem(): void {
    if (!wikiAc.div) return;
    wikiAc.div.querySelectorAll('.autocomplete-item').forEach((item, idx) => {
        item.classList.toggle('active', idx === wikiAc.selectedIndex);
        if (idx === wikiAc.selectedIndex) item.scrollIntoView({ block: 'nearest' });
    });
}

function selectAutocomplete(index: number): void {
    const item = wikiAc.results[index];
    const editor = window.editor;
    if (!item || !editor) return;

    const selection = editor.getSelection?.();
    if (!selection) { hideAutocomplete(); return; }

    const [from] = selection;
    const line = from[0];
    const col  = from[1];

    const lines = editor.getMarkdown().split('\n');
    const textBefore = (lines[line - 1] || '').substring(0, col - 1);

    const trigger = wikiAc.type === 'template' ? '{{' : '[[';
    const close   = wikiAc.type === 'template' ? '}}' : ']]';
    const lastTriggerIndex = textBefore.lastIndexOf(trigger);

    if (lastTriggerIndex !== -1) {
        editor.setSelection?.([line, lastTriggerIndex + 1], [line, col]);
        editor.insertText?.(`${trigger}${item.slug}${close}`);

        if (wikiAc.type === 'template' && item.slug) {
            _autoInsertTemplateParamSchema(item.slug, line, lastTriggerIndex + 1, item.slug);
        }
    }

    hideAutocomplete();
}

// ─────────────────────────────────────────────────────────────────────────────
// 틀 파라미터 스키마 자동 삽입
// ─────────────────────────────────────────────────────────────────────────────

function _extractTemplateParamNames(content: string): { positional: string[]; named: string[] } {
    if (typeof window._findParamRefs !== 'function') return { positional: [], named: [] };
    const seen = new Set<string>();
    const positional: string[] = [];
    const named: string[] = [];
    const POSITIONAL_RE = /^[1-9]\d*$/;

    function scan(text: string): void {
        const refs = window._findParamRefs!(text);
        for (const r of refs) {
            const raw = r.raw;
            const pipeIdx = raw.indexOf('|');
            const name = (pipeIdx === -1 ? raw : raw.substring(0, pipeIdx)).trim();
            if (name && !seen.has(name)) {
                seen.add(name);
                if (POSITIONAL_RE.test(name)) positional.push(name);
                else named.push(name);
            }
            if (pipeIdx !== -1) scan(raw.substring(pipeIdx + 1));
        }
    }
    scan(content);
    positional.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    return { positional, named };
}

async function _autoInsertTemplateParamSchema(slug: string, line: number, insertCol: number, title: string): Promise<void> {
    try {
        if (typeof window._isExtensionCall === 'function' && window._isExtensionCall(slug)) return;
    } catch (_) { /* noop */ }

    let data: { content?: string } | null = null;
    try {
        const res = await fetch(`/api/w/${encodeURIComponent(slug)}`);
        if (!res.ok) return;
        data = await res.json() as { content?: string };
    } catch (_) { return; }
    if (!data || typeof data.content !== 'string') return;

    const params = _extractTemplateParamNames(data.content);
    const tokens: string[] = [];
    const positionalIndices = (Array.isArray(params.positional) ? params.positional : [])
        .map(p => Number(p))
        .filter(n => Number.isInteger(n) && n > 0);
    positionalIndices.sort((a, b) => a - b);
    const maxPositionalIndex = positionalIndices.length > 0
        ? positionalIndices[positionalIndices.length - 1] : 0;

    const POSITIONAL_BLANK_CAP = 9;
    if (maxPositionalIndex > 0 && maxPositionalIndex <= POSITIONAL_BLANK_CAP) {
        for (let i = 0; i < maxPositionalIndex; i++) tokens.push('');
    } else {
        for (const n of positionalIndices) tokens.push(`${n}=`);
    }
    for (const n of params.named) tokens.push(`${n}=`);
    if (tokens.length === 0) return;

    const editor = window.editor;
    if (!editor) return;
    const currentMd = editor.getMarkdown();
    const currentLines = currentMd.split('\n');
    const currentLine = currentLines[line - 1];
    if (typeof currentLine !== 'string') return;

    const expected = `{{${title}}}`;
    const openAt = insertCol - 1;
    if (currentLine.substring(openAt, openAt + expected.length) !== expected) return;

    const expectedCaret = insertCol + 4 + title.length;
    const caretSel = editor.getSelection?.();
    if (!caretSel) return;
    const [cFrom, cTo] = caretSel;
    if (cFrom[0] !== line || cTo[0] !== line ||
        cFrom[1] !== expectedCaret || cTo[1] !== expectedCaret) return;

    const schema = '|' + tokens.join('|');
    const insertAt = insertCol + 2 + title.length;
    editor.setSelection?.([line, insertAt], [line, insertAt]);
    editor.insertText?.(schema);

    const cursorCol = insertAt + 1 + tokens[0].length;
    editor.setSelection?.([line, cursorCol], [line, cursorCol]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 통합 레지스트리
// ─────────────────────────────────────────────────────────────────────────────

const _AUTOCOMPLETE_HIDERS: Record<string, () => void> = {
    wiki:      hideAutocomplete,
    icon:      hideIconAutocomplete,
    color:     hideColorAutocomplete,
    palette:   hidePaletteAutocomplete,
    timestamp: hideTimestampAutocomplete,
    imgsize:   hideImgSizeAutocomplete,
    code:      hideCodeAutocomplete,
    block:     hideBlockAutocomplete,
};

function hideAutocompletesExcept(keep: string | null): void {
    for (const kind in _AUTOCOMPLETE_HIDERS) {
        if (kind !== keep) _AUTOCOMPLETE_HIDERS[kind]();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 통합 키보드 네비게이션
// ─────────────────────────────────────────────────────────────────────────────

window.addEventListener('keydown', (e) => {
    if (e.key === 'Process') return;

    const activeAc = wikiAc.visible ? 'wiki'
        : iconAc.visible ? 'icon'
        : colorAc.visible ? 'color'
        : imgSizeAc.visible ? 'imgsize'
        : timestampAc.visible ? 'timestamp'
        : paletteAc.visible ? 'palette'
        : codeAc.visible ? 'code'
        : blockAc.visible ? 'block'
        : null;
    if (!activeAc) return;

    const isDown  = e.key === 'ArrowDown'  || e.keyCode === 40;
    const isUp    = e.key === 'ArrowUp'    || e.keyCode === 38;
    const isRight = e.key === 'ArrowRight' || e.keyCode === 39;
    const isLeft  = e.key === 'ArrowLeft'  || e.keyCode === 37;
    const isEnter = e.key === 'Enter'      || e.keyCode === 13;
    const isTab   = e.key === 'Tab'        || e.keyCode === 9;
    const isEsc   = e.key === 'Escape'     || e.keyCode === 27;
    const isCommit = isEnter || (isTab && !e.shiftKey);

    if (activeAc === 'wiki') {
        if (isDown) {
            if (wikiAc.results.length > 0) { e.preventDefault(); e.stopPropagation(); wikiAc.selectedIndex = (wikiAc.selectedIndex + 1) % wikiAc.results.length; highlightAutocompleteItem(); }
            else { hideAutocomplete(); }
        } else if (isUp) {
            if (wikiAc.results.length > 0) { e.preventDefault(); e.stopPropagation(); wikiAc.selectedIndex = (wikiAc.selectedIndex - 1 + wikiAc.results.length) % wikiAc.results.length; highlightAutocompleteItem(); }
            else { hideAutocomplete(); }
        } else if (isLeft || isRight) {
            hideAutocomplete();
        } else if (isCommit) {
            if (wikiAc.results.length > 0 && wikiAc.selectedIndex >= 0) { e.preventDefault(); e.stopPropagation(); selectAutocomplete(wikiAc.selectedIndex); }
            else { hideAutocomplete(); }
        } else if (isEsc) { e.preventDefault(); e.stopPropagation(); hideAutocomplete(); }

    } else if (activeAc === 'icon') {
        if (isDown) {
            if (iconAc.results.length > 0) { e.preventDefault(); e.stopPropagation(); iconAc.selectedIndex = Math.min(iconAc.selectedIndex + iconAc.COLS, iconAc.results.length - 1); highlightIconAcItem(); }
            else { hideIconAutocomplete(); }
        } else if (isUp) {
            if (iconAc.results.length > 0) { e.preventDefault(); e.stopPropagation(); iconAc.selectedIndex = Math.max(iconAc.selectedIndex - iconAc.COLS, 0); highlightIconAcItem(); }
            else { hideIconAutocomplete(); }
        } else if (isRight) {
            if (iconAc.results.length > 0) { e.preventDefault(); e.stopPropagation(); iconAc.selectedIndex = (iconAc.selectedIndex + 1) % iconAc.results.length; highlightIconAcItem(); }
        } else if (isLeft) {
            if (iconAc.results.length > 0) { e.preventDefault(); e.stopPropagation(); iconAc.selectedIndex = (iconAc.selectedIndex - 1 + iconAc.results.length) % iconAc.results.length; highlightIconAcItem(); }
        } else if (isCommit) {
            if (iconAc.results.length > 0 && iconAc.selectedIndex >= 0) { e.preventDefault(); e.stopPropagation(); selectIconAutocomplete(iconAc.selectedIndex); }
            else { hideIconAutocomplete(); }
        } else if (isEsc) { e.preventDefault(); e.stopPropagation(); hideIconAutocomplete(); }

    } else if (activeAc === 'imgsize') {
        if (isDown) { e.preventDefault(); e.stopPropagation(); imgSizeAc.selectedIndex = (imgSizeAc.selectedIndex + 1) % imgSizeAc.options.length; highlightImgSizeAcItem(); }
        else if (isUp) { e.preventDefault(); e.stopPropagation(); imgSizeAc.selectedIndex = (imgSizeAc.selectedIndex - 1 + imgSizeAc.options.length) % imgSizeAc.options.length; highlightImgSizeAcItem(); }
        else if (isLeft || isRight) { hideImgSizeAutocomplete(); }
        else if (isCommit) {
            if (imgSizeAc.selectedIndex >= 0) { e.preventDefault(); e.stopPropagation(); selectImgSizeAutocomplete(imgSizeAc.selectedIndex); }
            else { hideImgSizeAutocomplete(); }
        } else if (isEsc) { e.preventDefault(); e.stopPropagation(); hideImgSizeAutocomplete(); }

    } else if (activeAc === 'color') {
        const swatchCount = COLOR_SWATCHES.length;
        const SWATCH_COLS = 10;
        const SV_STEP = 0.04;
        const HUE_STEP = 6;
        const inSwatchMode = colorAc.selectedSwatchIndex >= 0;

        if (isCommit) { e.preventDefault(); e.stopPropagation(); applyColorAutocomplete(); }
        else if (isEsc) { e.preventDefault(); e.stopPropagation(); hideColorAutocomplete(); }
        else if (inSwatchMode) {
            if (isRight) { if (swatchCount > 0) { e.preventDefault(); e.stopPropagation(); colorAc.selectedSwatchIndex = (colorAc.selectedSwatchIndex + 1) % swatchCount; selectColorSwatch(colorAc.selectedSwatchIndex); } }
            else if (isLeft) { if (swatchCount > 0) { e.preventDefault(); e.stopPropagation(); colorAc.selectedSwatchIndex = (colorAc.selectedSwatchIndex - 1 + swatchCount) % swatchCount; selectColorSwatch(colorAc.selectedSwatchIndex); } }
            else if (isDown) { if (swatchCount > 0) { e.preventDefault(); e.stopPropagation(); colorAc.selectedSwatchIndex = Math.min(colorAc.selectedSwatchIndex + SWATCH_COLS, swatchCount - 1); selectColorSwatch(colorAc.selectedSwatchIndex); } }
            else if (isUp) { if (swatchCount > 0) { e.preventDefault(); e.stopPropagation(); colorAc.selectedSwatchIndex = Math.max(colorAc.selectedSwatchIndex - SWATCH_COLS, 0); selectColorSwatch(colorAc.selectedSwatchIndex); } }
        } else {
            if (e.shiftKey && (isRight || isLeft)) {
                e.preventDefault(); e.stopPropagation();
                colorAc.hue = isRight ? (colorAc.hue + HUE_STEP) % 360 : (colorAc.hue - HUE_STEP + 360) % 360;
                drawColorPalette(); drawHueSlider(); updateColorPreview(); renderColorSwatches();
            } else if (isRight) { e.preventDefault(); e.stopPropagation(); colorAc.saturation = Math.min(1, colorAc.saturation + SV_STEP); drawColorPalette(); updateColorPreview(); }
            else if (isLeft)  { e.preventDefault(); e.stopPropagation(); colorAc.saturation = Math.max(0, colorAc.saturation - SV_STEP); drawColorPalette(); updateColorPreview(); }
            else if (isUp)    { e.preventDefault(); e.stopPropagation(); colorAc.brightness = Math.min(1, colorAc.brightness + SV_STEP); drawColorPalette(); updateColorPreview(); }
            else if (isDown)  { e.preventDefault(); e.stopPropagation(); colorAc.brightness = Math.max(0, colorAc.brightness - SV_STEP); drawColorPalette(); updateColorPreview(); }
        }

    } else if (activeAc === 'timestamp') {
        if (isEsc) { e.preventDefault(); e.stopPropagation(); hideTimestampAutocomplete(); window.editor?.focus?.(); }
        else if (isCommit) { e.preventDefault(); e.stopPropagation(); applyTimestampAutocomplete(); }

    } else if (activeAc === 'palette') {
        if (isDown) {
            if (paletteAc.results.length > 0) { e.preventDefault(); e.stopPropagation(); paletteAc.selectedIndex = (paletteAc.selectedIndex + 1) % paletteAc.results.length; highlightPaletteAcItem(); }
            else { hidePaletteAutocomplete(); }
        } else if (isUp) {
            if (paletteAc.results.length > 0) { e.preventDefault(); e.stopPropagation(); paletteAc.selectedIndex = (paletteAc.selectedIndex - 1 + paletteAc.results.length) % paletteAc.results.length; highlightPaletteAcItem(); }
            else { hidePaletteAutocomplete(); }
        } else if (isLeft || isRight) { hidePaletteAutocomplete(); }
        else if (isCommit) {
            if (paletteAc.results.length > 0 && paletteAc.selectedIndex >= 0) { e.preventDefault(); e.stopPropagation(); selectPaletteAutocomplete(paletteAc.selectedIndex); }
            else { hidePaletteAutocomplete(); }
        } else if (isEsc) { e.preventDefault(); e.stopPropagation(); hidePaletteAutocomplete(); }

    } else if (activeAc === 'code') {
        if (isDown) {
            if (codeAc.filtered.length > 0) { e.preventDefault(); e.stopPropagation(); codeAc.selectedIndex = (codeAc.selectedIndex + 1) % codeAc.filtered.length; highlightCodeAcItem(); }
            else { hideCodeAutocomplete(); }
        } else if (isUp) {
            if (codeAc.filtered.length > 0) { e.preventDefault(); e.stopPropagation(); codeAc.selectedIndex = (codeAc.selectedIndex - 1 + codeAc.filtered.length) % codeAc.filtered.length; highlightCodeAcItem(); }
            else { hideCodeAutocomplete(); }
        } else if (isLeft || isRight) { hideCodeAutocomplete(); }
        else if (isCommit) {
            if (codeAc.filtered.length > 0 && codeAc.selectedIndex >= 0) { e.preventDefault(); e.stopPropagation(); selectCodeAutocomplete(codeAc.selectedIndex); }
            else { hideCodeAutocomplete(); }
        } else if (isEsc) { e.preventDefault(); e.stopPropagation(); hideCodeAutocomplete(); }

    } else if (activeAc === 'block') {
        if (isDown) {
            if (blockAc.filtered.length > 0) { e.preventDefault(); e.stopPropagation(); blockAc.selectedIndex = (blockAc.selectedIndex + 1) % blockAc.filtered.length; highlightBlockAcItem(); }
            else { hideBlockAutocomplete(); }
        } else if (isUp) {
            if (blockAc.filtered.length > 0) { e.preventDefault(); e.stopPropagation(); blockAc.selectedIndex = (blockAc.selectedIndex - 1 + blockAc.filtered.length) % blockAc.filtered.length; highlightBlockAcItem(); }
            else { hideBlockAutocomplete(); }
        } else if (isLeft || isRight) { hideBlockAutocomplete(); }
        else if (isCommit) {
            if (blockAc.filtered.length > 0 && blockAc.selectedIndex >= 0) { e.preventDefault(); e.stopPropagation(); selectBlockAutocomplete(blockAc.selectedIndex); }
            else { hideBlockAutocomplete(); }
        } else if (isEsc) { e.preventDefault(); e.stopPropagation(); hideBlockAutocomplete(); }
    }
}, true);

// 전역 클릭 시 자동완성 닫기
document.addEventListener('mousedown', (e) => {
    const acDivs = [wikiAc.div, iconAc.div, colorAc.div, imgSizeAc.div, timestampAc.div, paletteAc.div, codeAc.div, blockAc.div];
    if (acDivs.some(div => div && div.contains(e.target as Node))) return;
    setTimeout(() => hideAutocompletesExcept(null), 100);
});

// ─────────────────────────────────────────────────────────────────────────────
// 에디터 변경 감지 및 트리거
// ─────────────────────────────────────────────────────────────────────────────

// 부착은 idempotent — 즉시 시도 / 'wiki-editor-ready' 이벤트 / 명시적
// ensureAutocompleteAttached 호출 / 폴링 안전망 어느 경로로 호출되어도
// editorEventHandlers.change 에 중복 push 되지 않도록 _autocompleteAttached 로
// 가드한다.
//
// 정상 경로 — edit-main.ts 가 editor shim 초기화 직후 'wiki-editor-ready' 이벤트
// 디스패치 + ensureAutocompleteAttached 명시 호출을 모두 수행하므로 첫 시도에 부착된다.
// 두 트리거가 모두 같은 함수를 호출하고 같은 window.editor 시점을 공유하므로
// 사실상 단일 진입점과 같다. 그 단일 진입점이 어떤 이유(예: dispatch 직전 throw,
// 모듈 평가 순서 이슈, 미래의 리팩터링으로 인한 트리거 누락 등)로 누락되면
// 자동완성은 페이지 새로고침 전까지 영구히 부착되지 않는다. 그래서 30회×100ms
// (≈3초) 의 bounded 폴링을 마지막 안전망으로 둔다 — 정상 경로에서는 첫 시도에
// 부착되어 폴링은 사실상 한 번도 가동되지 않으며, 트리거 누락 시에만 3초 내에
// 자동 복구된다. 폴링 경로로 부착된 경우 console.warn 으로 관측 가능하게 남긴다.
let _autocompleteAttached = false;
let _attachAttempts = 0;
const MAX_ATTACH_ATTEMPTS = 30;

// *Ac.div 들은 모듈 top-level 에서 document.getElementById 로 한 번 캐시한다.
// 그러나 일부 환경(서버 HTMLRewriter 스트리밍 / 특정 브라우저 큐잉 동작 등)에서
// type="module" 의 deferred 보장이 깨지고 div 가 아직 DOM 에 없을 때 모듈 본문이
// 평가되어 9개 *Ac.div 가 전부 null 로 굳어지는 케이스가 실제로 재현된다.
// (재현 검증: 콘솔에서 `await import('/dist/edit-autocomplete.js?' + Date.now())`
//  로 모듈을 다시 평가해 fresh closure 를 만들면 즉시 정상 작동.)
//
// attachAutocomplete 시점에는 editor 가 준비된 상태이고 DOM 도 안정된 상태이므로
// 이 헬퍼를 attach 직전에 호출해 null 캐시를 보강한다. div 가 이미 non-null 이면
// `?? getElementById(...)` 가 단락 평가로 추가 lookup 을 건너뛰므로 happy path 의
// 비용은 없다.
function _resolveAutocompleteDivs(): void {
    imgSizeAc.div   = imgSizeAc.div   ?? document.getElementById('imgsize-autocomplete');
    codeAc.div      = codeAc.div      ?? document.getElementById('code-autocomplete');
    blockAc.div     = blockAc.div     ?? document.getElementById('block-autocomplete');
    iconAc.div      = iconAc.div      ?? document.getElementById('icon-autocomplete');
    colorAc.div     = colorAc.div     ?? document.getElementById('color-autocomplete');
    timestampAc.div = timestampAc.div ?? document.getElementById('timestamp-autocomplete');
    paletteAc.div   = paletteAc.div   ?? document.getElementById('palette-autocomplete');
    categoryAc.div  = categoryAc.div  ?? document.getElementById('category-autocomplete');
    wikiAc.div      = wikiAc.div      ?? document.getElementById('wiki-autocomplete');
}

function attachAutocomplete(viaFallback = false): void {
    if (_autocompleteAttached) return;
    const editor = window.editor;
    // window.editor 가 truthy 라도 진짜 에디터 shim 인지 검증해야 한다.
    // edit.html / blog-edit.html 에는 <div id="editor"> 가 존재하므로,
    // 브라우저의 "named access on the Window object" 정책에 따라 own
    // 프로퍼티가 아직 세팅되지 않은 시점의 `window.editor` 는 그 HTMLDivElement
    // 를 자동 반환한다. div 에는 .on 메서드가 없어 `editor.on?.('change', cb)`
    // 가 옵셔널 체이닝으로 조용히 no-op 되는데, 그 사이 _autocompleteAttached
    // 만 true 로 굳어 이후 정상 트리거(wiki-editor-ready / ensureAutocompleteAttached
    // / 폴링) 가 전부 "이미 부착됨" 으로 skip 되어 자동완성이 영구 비활성화된다.
    // (재현: 페이지 로드 후 콘솔에서 `await import('/dist/edit-autocomplete.js?'
    //  + Date.now())` 로 재평가하면 그 시점에는 main.ts 가 진짜 shim 을 own
    //  프로퍼티로 덮어쓴 뒤라 정상 부착됨.)
    // 따라서 .on 이 함수인 경우에만 진짜 shim 으로 간주한다.
    if (!editor || typeof editor.on !== 'function') return;
    _autocompleteAttached = true;
    if (viaFallback) {
        console.warn('[edit] 자동완성이 폴링 안전망으로 부착됨 — 정상 트리거가 누락되었을 가능성. _attachAttempts=' + _attachAttempts);
    }
    _resolveAutocompleteDivs();

    editor.on('change', () => {
        requestAnimationFrame(() => {
            // 사용자가 "문법 자동완성" 을 끈 경우 어떤 트리거에도 반응하지 않는다.
            // 이미 떠 있을 수 있는 드롭다운도 정리한다.
            if (window.wikiSyntaxAutocompleteEnabled === false) {
                hideAutocompletesExcept(null);
                return;
            }
            // 매 키스트로크마다 *Ac.div 의 null 캐시를 보강한다. attach 시점에
            // 한 번만 _resolveAutocompleteDivs() 를 호출하면, 그 시점에 일부
            // div 가 DOM 에 없었거나 (스트리밍/큐잉) 미래에 어떤 DOM 조작으로
            // 분리되었을 때 영구히 null 로 굳어진다. RAF 콜백 안에서 사용자가
            // 실제로 에디터에 타이핑한 시점에는 DOM 이 안정되어 있으므로
            // ?? 단락 평가로 누락된 div 만 다시 lookup 한다. happy path 비용은
            // 9 번의 prop read 로 무시할 수 있는 수준이다.
            _resolveAutocompleteDivs();
            const selection = editor.getSelection?.();
            if (!selection) { hideAutocompletesExcept(null); return; }

            const [from, to] = selection;
            if (from[0] !== to[0] || from[1] !== to[1]) { hideAutocompletesExcept(null); return; }

            const lines = editor.getMarkdown().split('\n');
            const lineText = lines[from[0] - 1] || '';
            const textBefore = lineText.substring(0, from[1] - 1);

            const selectedIconsOnly = window.selectedIconsOnly ?? false;

            const linkMatch     = textBefore.match(/\[\[([^\]\[|#]*)$/);
            const templateMatch = textBefore.match(/(?<!\{)\{\{([^\}\{|]*)$/);
            const biIconMatch   = textBefore.match(/\{bi:([^}]*)$/);
            const mdiIconMatch  = textBefore.match(/\{mdi:([^}]*)$/);
            const iconMatch     = textBefore.match(/\{icon:([^}]*)$/);
            const bgColorMatch  = textBefore.match(/\{bg:([^}]*)$/);
            const textColorMatch = textBefore.match(/\{color:([^}]*)$/);
            const paletteMatch  = textBefore.match(/\{palette:([^}]*)$/);
            const imgMatch      = textBefore.match(/!\[[^\]]*\]\([^)]+\)$/);
            const ddayMatch     = textBefore.match(/\{dday:([^}]*)$/);
            const timeMatch     = textBefore.match(/\{time:([^}]*)$/);
            const timerMatch    = textBefore.match(/\{timer:([^}]*)$/);
            const ageMatch      = textBefore.match(/\{age:([^}]*)$/);
            const calendarMatch = textBefore.match(/\{calendar:([^}]*)$/);
            const codeMatch     = textBefore.match(/(?<!\{)\{([a-zA-Z]*)$/);
            const blockMatchRaw = textBefore.match(/^:::([a-zA-Z][a-zA-Z0-9_-]*)?$/);
            // 이름이 없는 단독 `:::` 가 열린 블록 안에서 입력된 경우 닫는 쪽으로 간주.
            const blockMatch = (blockMatchRaw && !blockMatchRaw[1] && hasUnclosedBlockBefore(lines, from[0]))
                ? null
                : blockMatchRaw;

            if (linkMatch) {
                hideAutocompletesExcept('wiki'); showAutocomplete(linkMatch[1], 'link');
            } else if (templateMatch) {
                hideAutocompletesExcept('wiki'); showAutocomplete(templateMatch[1], 'template');
            } else if (iconMatch && selectedIconsOnly) {
                hideAutocompletesExcept('icon'); showIconAutocomplete(iconMatch[1], 'icon');
            } else if (biIconMatch && !selectedIconsOnly) {
                hideAutocompletesExcept('icon'); showIconAutocomplete(biIconMatch[1], 'bi');
            } else if (mdiIconMatch && !selectedIconsOnly) {
                hideAutocompletesExcept('icon'); showIconAutocomplete(mdiIconMatch[1], 'mdi');
            } else if (biIconMatch && selectedIconsOnly) {
                hideAutocompletesExcept('icon'); showIconAutocomplete(biIconMatch[1], 'bi');
            } else if (mdiIconMatch && selectedIconsOnly) {
                hideAutocompletesExcept('icon'); showIconAutocomplete(mdiIconMatch[1], 'mdi');
            } else if (bgColorMatch) {
                hideAutocompletesExcept('color'); showColorAutocomplete(bgColorMatch[1], 'bg');
            } else if (textColorMatch) {
                hideAutocompletesExcept('color'); showColorAutocomplete(textColorMatch[1], 'color');
            } else if (paletteMatch) {
                hideAutocompletesExcept('palette'); showPaletteAutocomplete(paletteMatch[1]);
            } else if (calendarMatch) {
                hideAutocompletesExcept('timestamp'); showTimestampAutocomplete('calendar');
            } else if (ageMatch) {
                hideAutocompletesExcept('timestamp'); showTimestampAutocomplete('age');
            } else if (ddayMatch) {
                hideAutocompletesExcept('timestamp'); showTimestampAutocomplete('dday');
            } else if (timerMatch) {
                hideAutocompletesExcept('timestamp'); showTimestampAutocomplete('timer');
            } else if (timeMatch) {
                hideAutocompletesExcept('timestamp'); showTimestampAutocomplete('time');
            } else if (imgMatch) {
                hideAutocompletesExcept('imgsize'); showImgSizeAutocomplete();
            } else if (codeMatch) {
                hideAutocompletesExcept('code'); showCodeAutocomplete(codeMatch[1]);
            } else if (blockMatch) {
                hideAutocompletesExcept('block'); showBlockAutocomplete(blockMatch[1] || '');
            } else {
                hideAutocompletesExcept(null);
            }
        });
    });

    editor.on?.('blur', () => {
        setTimeout(() => {
            const activeEl = document.activeElement;
            if (activeEl?.closest('.cm-editor')) return;
            if (!activeEl?.closest('#wiki-autocomplete'))      hideAutocomplete();
            if (!activeEl?.closest('#icon-autocomplete'))      hideIconAutocomplete();
            if (!activeEl?.closest('#color-autocomplete'))     hideColorAutocomplete();
            if (!activeEl?.closest('#imgsize-autocomplete'))   hideImgSizeAutocomplete();
            if (!activeEl?.closest('#timestamp-autocomplete')) hideTimestampAutocomplete();
            if (!activeEl?.closest('#palette-autocomplete'))   hidePaletteAutocomplete();
            if (!activeEl?.closest('#code-autocomplete'))      hideCodeAutocomplete();
            if (!activeEl?.closest('#block-autocomplete'))     hideBlockAutocomplete();
        }, 200);
    });
}

// 모듈 평가 시점에 즉시 1회 시도. 보통 이 시점에는 window.editor 가 아직 세팅되지
// 않아 no-op 으로 끝난다. 단, edit-main.ts 가 동기 경로로 매우 빠르게 에디터 shim 을
// 만든 드문 경우(또는 미래의 리팩터링)에 한 번에 부착할 수 있도록 시도해 둔다.
attachAutocomplete();

// 이벤트 기반 부착 — edit-main.ts 가 editor shim 을 만든 직후
// `window.dispatchEvent(new Event('wiki-editor-ready'))` 를 호출하여 부착을 트리거한다.
// 이벤트가 두 번 디스패치되어도 attachAutocomplete 내부의 _autocompleteAttached
// 가드 덕에 안전.
window.addEventListener('wiki-editor-ready', () => attachAutocomplete());

// 명시적 호출 진입점: edit-main.ts 가 에디터 shim 초기화 직후 호출.
// 이벤트 디스패치와 별개로 백업 경로로 유지해 둔다.
// 가드는 attachAutocomplete 내부에서 수행하므로 여기서는 단순 위임.
window.ensureAutocompleteAttached = () => attachAutocomplete();

// 외부 진입점: "문법 자동완성" 설정 해제 등으로 모든 드롭다운을 즉시 닫아야 할 때.
// hideAutocompletesExcept(null) 가 각 hide* 헬퍼를 호출해 visible/selectedIndex/
// query 등 내부 상태까지 초기화하므로, 토글 직후 잔존하는 visible 플래그가
// 키보드 네비게이션을 가로채는 문제를 피할 수 있다.
window.hideAllSyntaxAutocompletes = () => hideAutocompletesExcept(null);

// 폴링 안전망 — 위 정상 트리거(이벤트 + 명시 호출)가 어떤 이유로든 누락되거나
// 호출 시점에 window.editor 가 아직 비어 있어 부착되지 못한 케이스를 자동 복구.
// 정상 경로에서는 첫 dispatch 시점에 부착되므로 polling 루프는 즉시 종료된다.
function _attachPollFallback(): void {
    if (_autocompleteAttached) return;
    if (_attachAttempts++ >= MAX_ATTACH_ATTEMPTS) return;
    attachAutocomplete(true);
    if (!_autocompleteAttached) setTimeout(_attachPollFallback, 100);
}
setTimeout(_attachPollFallback, 100);

// 에디터 영역 드래그앤드롭 비활성화
(function disableEditorDragDrop(): void {
    function setup(): void {
        const editorEl = document.querySelector('#editor');
        if (!editorEl) { setTimeout(setup, 300); return; }
        editorEl.addEventListener('dragover', (e) => { e.preventDefault(); (e as DragEvent).dataTransfer!.dropEffect = 'none'; });
        editorEl.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); });
    }
    setTimeout(setup, 600);
})();

// ─────────────────────────────────────────────────────────────────────────────
// Window 브리지 노출
// ─────────────────────────────────────────────────────────────────────────────

// 인라인 onclick 핸들러
window.selectImgSizeAutocomplete = selectImgSizeAutocomplete;
window.selectCodeAutocomplete    = selectCodeAutocomplete;
window.selectBlockAutocomplete   = selectBlockAutocomplete;
window.selectIconAutocomplete    = selectIconAutocomplete;
window.selectAutocomplete        = selectAutocomplete;
window.selectCategoryAcByIndex   = selectCategoryAc;
window.removeCategoryTag         = removeCategoryTag;

// edit.js / edit-modals.js 에서 호출
window.showColorAutocomplete    = showColorAutocomplete;
window.showPaletteAutocomplete  = showPaletteAutocomplete;
window.hideAutocomplete              = hideAutocomplete;
window.hideIconAutocomplete          = hideIconAutocomplete;
window.hideColorAutocomplete         = hideColorAutocomplete;
window.hideImgSizeAutocomplete       = hideImgSizeAutocomplete;
window.hideTimestampAutocomplete     = hideTimestampAutocomplete;
window.getAllPalettesForEditor   = getAllPalettesForEditor;
window.renderCategoryTags       = renderCategoryTags;

// edit.js 가 .replaceRange 를 직접 기록하는 상태 객체
window.paletteAc = paletteAc;

console.log('[edit/autocomplete] module loaded');
