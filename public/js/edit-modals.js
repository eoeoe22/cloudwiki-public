// ── Bootstrap Icons 목록 로딩 (지연 로딩, 캐시됨) ──
async function loadBiIcons() {
    if (biIconList) return biIconList;
    try {
        const res = await fetch('https://cdn.jsdelivr.net/npm/bootstrap-icons@1.13.1/font/bootstrap-icons.json');
        const data = await res.json();
        biIconList = Object.keys(data).sort();
    } catch (e) {
        console.error('BI icon list load failed:', e);
        biIconList = [];
    }
    return biIconList;
}

// ── MDI 목록 로딩 (지연 로딩, 캐시됨) - CSS에서 아이콘명 추출 ──
async function loadMdiIcons() {
    if (mdiIconList) return mdiIconList;
    try {
        const res = await fetch('https://cdn.jsdelivr.net/npm/@mdi/font@7.4.47/css/materialdesignicons.min.css');
        const css = await res.text();
        const matches = [...css.matchAll(/\.mdi-([\w-]+)::before/g)];
        mdiIconList = [...new Set(matches.map(m => m[1]))].sort();
    } catch (e) {
        console.error('MDI icon list load failed:', e);
        mdiIconList = [];
    }
    return mdiIconList;
}

// ── 선택된 아이콘 목록 로딩 (icons.json) ──
async function loadSelectedIcons() {
    if (selectedIconsList) return selectedIconsList;
    try {
        const res = await fetch('/icons.json');
        selectedIconsList = await res.json();
    } catch (e) {
        console.error('icons.json load failed:', e);
        selectedIconsList = [];
    }
    return selectedIconsList;
}

// ── 아이콘 필터링 (우선순위: 정확일치 → startsWith → contains) ──
function filterIcons(iconList, query) {
    if (!iconList || iconList.length === 0) return [];
    if (!query || !query.trim()) return iconList;
    const q = query.toLowerCase().trim();
    const exact = iconList.filter(n => n === q);
    const sw = iconList.filter(n => n !== q && n.startsWith(q));
    const inc = iconList.filter(n => !n.startsWith(q) && n.includes(q));
    return [...exact, ...sw, ...inc];
}

// ── 선택된 아이콘 전체 피커 열기 (icons.json의 mdi+bi 모두 표시) ──
async function openSelectedIconsPicker() {
    if (editor) {
        iconPickerSavedSelection = editor.getSelection();
    }
    pendingIconInsertion = null;
    const myToken = ++iconPickerToken;

    const titleEl = document.getElementById('iconPickerTitle');
    const typeIconEl = document.getElementById('iconPickerTypeIcon');
    const gridEl = document.getElementById('iconPickerGrid');
    const spinner = document.getElementById('iconLoadingSpinner');
    const searchInput = document.getElementById('iconSearchInput');
    const emptyEl = document.getElementById('iconPickerEmpty');

    titleEl.textContent = '아이콘 선택';
    typeIconEl.className = 'mdi mdi-vector-square me-2';

    const modalEl = document.getElementById('iconPickerModal');
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.show();

    searchInput.value = '';
    gridEl.innerHTML = '';
    emptyEl.style.display = 'none';
    spinner.style.display = 'block';

    const allIcons = await loadSelectedIcons();
    if (myToken !== iconPickerToken) return;
    spinner.style.display = 'none';
    renderMixedIconGrid(gridEl, emptyEl, allIcons, '');

    let searchTimer;
    searchInput.oninput = () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
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

// ── 혼합 아이콘 그리드 렌더링 (mdi + bi) ──
function renderMixedIconGrid(gridEl, emptyEl, iconList, query) {
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
            let cssClass, type, iconName;
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
                pendingIconInsertion = `{${type}:${iconName}}`;
                bootstrap.Modal.getOrCreateInstance(document.getElementById('iconPickerModal')).hide();
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

// ── 아이콘 피커 모달 열기 ──
async function openIconPicker(type) {
    if (editor) {
        iconPickerSavedSelection = editor.getSelection();
    }
    pendingIconInsertion = null;
    const myToken = ++iconPickerToken;

    const titleEl = document.getElementById('iconPickerTitle');
    const typeIconEl = document.getElementById('iconPickerTypeIcon');
    const gridEl = document.getElementById('iconPickerGrid');
    const spinner = document.getElementById('iconLoadingSpinner');
    const searchInput = document.getElementById('iconSearchInput');
    const emptyEl = document.getElementById('iconPickerEmpty');

    if (type === 'bi') {
        titleEl.textContent = 'Bootstrap Icons 선택';
        typeIconEl.className = 'bi bi-bootstrap me-2';
    } else {
        titleEl.textContent = 'Material Design Icons 선택';
        typeIconEl.className = 'mdi mdi-material-design me-2';
    }

    // 모달 표시
    const modalEl = document.getElementById('iconPickerModal');
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.show();

    // 상태 초기화
    searchInput.value = '';
    gridEl.innerHTML = '';
    emptyEl.style.display = 'none';
    spinner.style.display = 'block';

    // 아이콘 목록 로딩
    let icons;
    if (selectedIconsOnly) {
        const all = await loadSelectedIcons();
        const prefix = type === 'bi' ? 'bi-' : 'mdi-';
        icons = all.filter(n => n.startsWith(prefix)).map(n => n.slice(prefix.length));
    } else {
        icons = type === 'bi' ? await loadBiIcons() : await loadMdiIcons();
    }
    if (myToken !== iconPickerToken) return;
    spinner.style.display = 'none';
    renderIconPickerGrid(gridEl, emptyEl, icons, '', type);

    // 검색 핸들러
    let searchTimer;
    searchInput.oninput = () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            renderIconPickerGrid(gridEl, emptyEl, icons, searchInput.value, type);
        }, 200);
    };
    searchInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            renderIconPickerGrid(gridEl, emptyEl, icons, searchInput.value, type);
        }
    };

    // 검색창 자동 포커스
    setTimeout(() => searchInput.focus(), 300);
}

// ── 아이콘 피커 그리드 렌더링 ──
function renderIconPickerGrid(gridEl, emptyEl, iconList, query, type) {
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
                pendingIconInsertion = `{${type}:${iconName}}`;
                bootstrap.Modal.getOrCreateInstance(document.getElementById('iconPickerModal')).hide();
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

// ── 표 삽입 팝오버 (그리드 + CSV) ──
function setupTableInsertPopover(tableBtn) {
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

    const grid = popup.querySelector('.table-insert-grid');
    const cells = popup.querySelectorAll('.table-insert-cell');
    const labelText = popup.querySelector('.table-insert-label-text');
    const csvBtn = popup.querySelector('.table-insert-csv-btn');

    function getCell(rows, cols) {
        return popup.querySelector(`.table-insert-cell[data-row="${rows}"][data-col="${cols}"]`);
    }

    function setActiveCell(rows, cols, shouldFocus) {
        activeRow = Math.min(MAX_ROWS, Math.max(1, rows));
        activeCol = Math.min(MAX_COLS, Math.max(1, cols));
        cells.forEach(cell => {
            const isActive = parseInt(cell.dataset.row, 10) === activeRow && parseInt(cell.dataset.col, 10) === activeCol;
            cell.tabIndex = isActive ? 0 : -1;
        });
        const activeCell = getCell(activeRow, activeCol);
        if (shouldFocus && activeCell) {
            activeCell.focus();
        }
    }

    function highlight(rows, cols) {
        cells.forEach(cell => {
            const r = parseInt(cell.dataset.row, 10);
            const c = parseInt(cell.dataset.col, 10);
            cell.classList.toggle('highlighted', r <= rows && c <= cols);
        });
        labelText.textContent = `${rows} × ${cols}`;
    }

    function clearHighlight() {
        cells.forEach(cell => cell.classList.remove('highlighted'));
        labelText.textContent = '크기 선택';
    }

    function insertSelectedTable(rows, cols) {
        insertMarkdownTable(rows, cols);
        popup.classList.remove('active');
        tableBtn.focus();
    }

    cells.forEach(cell => {
        cell.addEventListener('mouseenter', () => {
            const r = parseInt(cell.dataset.row, 10);
            const c = parseInt(cell.dataset.col, 10);
            setActiveCell(r, c, false);
            highlight(r, c);
        });

        cell.addEventListener('focus', () => {
            const r = parseInt(cell.dataset.row, 10);
            const c = parseInt(cell.dataset.col, 10);
            setActiveCell(r, c, false);
            highlight(r, c);
        });

        cell.addEventListener('click', () => {
            const rows = parseInt(cell.dataset.row, 10);
            const cols = parseInt(cell.dataset.col, 10);
            insertSelectedTable(rows, cols);
        });

        cell.addEventListener('keydown', (e) => {
            const row = parseInt(cell.dataset.row, 10);
            const col = parseInt(cell.dataset.col, 10);

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

    // 드래그 중 텍스트 선택 방지
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
        if (!popup.contains(e.target) && !tableBtn.contains(e.target)) {
            popup.classList.remove('active');
        }
    });

    csvBtn.addEventListener('click', () => {
        popup.classList.remove('active');
        openCsvTableModal();
    });
}

function insertMarkdownTable(rows, cols) {
    const headerCells = Array.from({ length: cols }, (_, i) => `제목${i + 1}`);
    const headerLine = '| ' + headerCells.join(' | ') + ' |';
    const sepLine = '|' + ' --- |'.repeat(cols);
    const bodyLines = [];
    const bodyRows = Math.max(0, rows - 1);
    for (let r = 0; r < bodyRows; r++) {
        const rowCells = Array.from({ length: cols }, (_, i) => `내용${i + 1}`);
        bodyLines.push('| ' + rowCells.join(' | ') + ' |');
    }
    const table = '\n' + [headerLine, sepLine, ...bodyLines].join('\n') + '\n';
    editor.insertText(table);
}

function parseCsvRecords(text) {
    const rows = [];
    let row = [];
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

function convertCsvToMarkdownTable(csv) {
    let text = csv.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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

    const escapeCell = (s) => (s == null ? '' : String(s))
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, ' ')
        .trim();

    const toRow = (row) => '| ' + row.map(escapeCell).join(' | ') + ' |';

    const headerLine = toRow(parsed[0]);
    const sepLine = '|' + ' --- |'.repeat(colCount);
    const bodyLines = parsed.slice(1).map(toRow);
    return [headerLine, sepLine, ...bodyLines].join('\n');
}

function openCsvTableModal() {
    Swal.fire({
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
            const el = document.getElementById('swal-csv-input');
            if (el) el.focus();
        },
        preConfirm: () => {
            const input = document.getElementById('swal-csv-input').value;
            if (!input || !input.trim()) {
                Swal.showValidationMessage('CSV 데이터를 입력해주세요.');
                return false;
            }
            try {
                return convertCsvToMarkdownTable(input);
            } catch (err) {
                Swal.showValidationMessage('CSV 형식이 아닙니다: ' + (err && err.message ? err.message : '알 수 없는 오류'));
                return false;
            }
        }
    }).then(result => {
        if (result.isConfirmed && result.value) {
            editor.insertText('\n' + result.value + '\n');
            if (typeof cmEditorView !== 'undefined' && cmEditorView) cmEditorView.focus();
        }
    });
}

// ── 구글 지도 퍼가기 모달 ──
function openGoogleMapsEmbedModal() {
    Swal.fire({
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
            document.getElementById('swal-maps-input').focus();
        },
        preConfirm: () => {
            const input = document.getElementById('swal-maps-input').value.trim();
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
            editor.insertText(result.value + '\n');
            cmEditorView.focus();
        }
    });
}

// ── 카드 블록 삽입 모달 (제목 + 제목/본문 팔레트 선택) ──
function openCardInsertModal() {
    const palettes = getAllPalettesForEditor();

    function paletteSwatchHtml(containerId) {
        let html = `<div id="${containerId}" class="card-insert-palette-swatches">`;
        html += `<button type="button" class="card-insert-palette-swatch" data-palette="" title="선택 안 함">
                    <span class="card-insert-palette-swatch-none">없음</span>
                </button>`;
        for (const p of palettes) {
            const bg = _isSafeCssColor(p.variant.bg || '') ? p.variant.bg : 'transparent';
            const color = _isSafeCssColor(p.variant.color || '') ? p.variant.color : 'inherit';
            html += `<button type="button" class="card-insert-palette-swatch" data-palette="${escapeHtml(p.name)}" title="${escapeHtml(p.name)}" style="background:${bg};color:${color};">${escapeHtml(p.name)}</button>`;
        }
        html += `</div>`;
        return html;
    }

    Swal.fire({
        title: '<i class="bi bi-card-heading me-2"></i>카드 블록 삽입',
        width: 560,
        html: `
                    <div class="text-start card-insert-form">
                        <div class="mb-3">
                            <label class="form-label" for="cardInsertTitle">제목</label>
                            <input type="text" id="cardInsertTitle" class="form-control"
                                placeholder="카드 제목" autocomplete="off"
                                style="background:var(--wiki-bg);color:var(--wiki-text);border-color:var(--wiki-border);">
                        </div>
                        <div class="mb-3">
                            <label class="form-label">제목 팔레트</label>
                            <input type="hidden" id="cardInsertTitlePalette" value="">
                            ${paletteSwatchHtml('cardInsertTitleSwatches')}
                        </div>
                        <div class="mb-2">
                            <label class="form-label">내용 팔레트</label>
                            <input type="hidden" id="cardInsertBodyPalette" value="">
                            ${paletteSwatchHtml('cardInsertBodySwatches')}
                        </div>
                    </div>
                `,
        showCancelButton: true,
        confirmButtonText: '삽입',
        cancelButtonText: '취소',
        didOpen: () => {
            const titleInput = document.getElementById('cardInsertTitle');
            if (titleInput) titleInput.focus();

            function wireSwatches(containerId, hiddenId) {
                const container = document.getElementById(containerId);
                const hidden = document.getElementById(hiddenId);
                if (!container || !hidden) return;
                const swatches = container.querySelectorAll('.card-insert-palette-swatch');
                function setActive(val) {
                    hidden.value = val || '';
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
        },
        preConfirm: () => {
            const title = (document.getElementById('cardInsertTitle').value || '')
                .replace(/[\r\n]+/g, ' ')
                .trim();
            const titlePalette = (document.getElementById('cardInsertTitlePalette').value || '').trim();
            const bodyPalette = (document.getElementById('cardInsertBodyPalette').value || '').trim();
            return { title, titlePalette, bodyPalette };
        }
    }).then(result => {
        if (!result.isConfirmed || !result.value) return;
        const { title, titlePalette, bodyPalette } = result.value;
        let tokens = '';
        if (titlePalette) tokens += `{palette:${titlePalette}}`;
        if (bodyPalette) tokens += `{body-palette:${bodyPalette}}`;
        const titlePart = tokens && title ? `${tokens} ${title}` : (tokens || title);
        const header = titlePart ? `:::card ${titlePart}` : ':::card';
        const body = '내용';
        editor.insertText(`${header}\n${body}\n:::`);
        if (typeof cmEditorView !== 'undefined' && cmEditorView) cmEditorView.focus();
    });
}

// ── 색상 팔레트 / 커스텀 색상 삽입 모달 ──
function openPaletteColorModal() {
    const palettes = getAllPalettesForEditor();

    let paletteHtml = `<div class="d-flex flex-wrap gap-2 mb-3">`;
    for (const p of palettes) {
        const bg = _isSafeCssColor(p.variant.bg || '') ? p.variant.bg : 'transparent';
        const color = _isSafeCssColor(p.variant.color || '') ? p.variant.color : 'inherit';
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

    const modalColorState = {
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

    const drawPalette = (canvasId, state) => {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        for (let x = 0; x < w; x++) {
            const s = x / w;
            for (let y = 0; y < h; y++) {
                const v = 1 - y / h;
                ctx.fillStyle = hsvToHex(state.hue, s, v);
                ctx.fillRect(x, y, 1, 1);
            }
        }
        const cx = state.saturation * w;
        const cy = (1 - state.brightness) * h;
        ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
    };

    const drawHue = (canvasId, state) => {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        const gradient = ctx.createLinearGradient(0, 0, w, 0);
        for (let i = 0; i <= 6; i++) gradient.addColorStop(i / 6, hsvToHex(i * 60, 1, 1));
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, w, h);
        const cx = (state.hue / 360) * w;
        ctx.beginPath(); ctx.rect(cx - 3, 0, 6, h); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath(); ctx.rect(cx - 4, -1, 8, h + 2); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
    };

    const wcagContrastHex = (hex) => {
        const h = hex.replace('#', '');
        const toLinear = (c) => {
            c = c / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        };
        const r = toLinear(parseInt(h.substring(0, 2), 16));
        const g = toLinear(parseInt(h.substring(2, 4), 16));
        const b = toLinear(parseInt(h.substring(4, 6), 16));
        const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        return L > 0.179 ? '#000000' : '#FFFFFF';
    };

    const isAutoContrastOn = () => {
        const cb = document.getElementById('modalAutoContrast');
        return cb ? cb.checked : false;
    };

    const applyAutoContrast = () => {
        const contrastHex = wcagContrastHex(modalColorState.bg.hex);
        const hsv = typeof hexToHsv !== 'undefined' ? hexToHsv(contrastHex) : { h: 0, s: 0, v: contrastHex === '#FFFFFF' ? 1 : 0 };
        modalColorState.color.hue = hsv.h;
        modalColorState.color.saturation = hsv.s;
        modalColorState.color.brightness = hsv.v;
        updateUI('color');
    };

    const updateUI = (type) => {
        const state = modalColorState[type];
        state.hex = hsvToHex(state.hue, state.saturation, state.brightness).toUpperCase();
        drawPalette(`modal${type === 'bg' ? 'Bg' : 'Color'}Canvas`, state);
        drawHue(`modal${type === 'bg' ? 'Bg' : 'Color'}Hue`, state);
        const hexInput = document.getElementById(`modal${type === 'bg' ? 'Bg' : 'Color'}Hex`);
        if (hexInput) hexInput.value = state.hex;
        updatePreview();
        if (type === 'bg' && isAutoContrastOn()) applyAutoContrast();
    };

    const setColorControlsDisabled = (disabled) => {
        ['modalColorSwatches', 'modalColorCanvas', 'modalColorHue'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.style.pointerEvents = disabled ? 'none' : '';
            el.style.opacity = disabled ? '0.5' : '';
        });
        const hexInput = document.getElementById('modalColorHex');
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

    Swal.fire({
        title: '<i class="mdi mdi-palette-outline me-2"></i>색상 삽입',
        width: 650,
        html: modalHtml,
        showCancelButton: true,
        confirmButtonText: '삽입',
        cancelButtonText: '취소',
        didOpen: () => {
            const confirmBtn = Swal.getConfirmButton();
            if (confirmBtn) confirmBtn.style.display = 'none';

            const tabElements = document.querySelectorAll('#colorModalTabs button[data-bs-toggle="tab"]');
            tabElements.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    tabElements.forEach(b => {
                        b.classList.remove('active');
                        const target = document.querySelector(b.dataset.bsTarget);
                        if (target) target.classList.remove('show', 'active');
                    });
                    btn.classList.add('active');
                    const activeTarget = document.querySelector(btn.dataset.bsTarget);
                    if (activeTarget) activeTarget.classList.add('show', 'active');

                    if (confirmBtn) {
                        confirmBtn.style.display = btn.id === 'palette-tab' ? 'none' : 'inline-block';
                    }
                });
            });

            document.querySelectorAll('.palette-insert-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const paletteName = btn.dataset.name;
                    Swal.close();
                    if (typeof editor !== 'undefined' && editor) {
                        editor.insertText(`{palette:${paletteName}}`);
                        if (typeof cmEditorView !== 'undefined' && cmEditorView) cmEditorView.focus();
                    }
                });
            });

            ['bg', 'color'].forEach(type => {
                const prefix = type === 'bg' ? 'Bg' : 'Color';
                const paletteCanvas = document.getElementById(`modal${prefix}Canvas`);
                const hueCanvas = document.getElementById(`modal${prefix}Hue`);
                const hexInput = document.getElementById(`modal${prefix}Hex`);
                const swatchContainer = document.getElementById(`modal${prefix}Swatches`);
                const state = modalColorState[type];

                if (swatchContainer) {
                    swatchContainer.innerHTML = SWATCHES.map(color =>
                        `<div class="color-modal-swatch" style="background:${color};" title="${color}" data-color="${color}"></div>`
                    ).join('');
                    swatchContainer.querySelectorAll('.color-modal-swatch').forEach(sw => {
                        sw.addEventListener('click', (e) => {
                            e.preventDefault();
                            const hsv = typeof hexToHsv !== 'undefined' ? hexToHsv(sw.dataset.color) : { h: 0, s: 0, v: 0 };
                            state.hue = hsv.h;
                            state.saturation = hsv.s;
                            state.brightness = hsv.v;
                            updateUI(type);
                        });
                    });
                }

                function getPos(canvas, e) {
                    const rect = canvas.getBoundingClientRect();
                    let cx, cy;
                    if (e.touches && e.touches.length > 0) { cx = e.touches[0].clientX; cy = e.touches[0].clientY; }
                    else { cx = e.clientX; cy = e.clientY; }
                    return {
                        x: Math.max(0, Math.min(1, (cx - rect.left) / rect.width)),
                        y: Math.max(0, Math.min(1, (cy - rect.top) / rect.height))
                    };
                }

                const handlePalette = (e) => {
                    const pos = getPos(paletteCanvas, e);
                    state.saturation = pos.x;
                    state.brightness = 1 - pos.y;
                    updateUI(type);
                };

                const handleHue = (e) => {
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
                            const hsv = typeof hexToHsv !== 'undefined' ? hexToHsv(val) : { h: 0, s: 0, v: 0 };
                            state.hue = hsv.h;
                            state.saturation = hsv.s;
                            state.brightness = hsv.v;
                            updateUI(type);
                        }
                    });
                }

                updateUI(type);
            });

            const autoContrastCb = document.getElementById('modalAutoContrast');
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

            const bgHex = document.getElementById('modalBgHex').value.trim();
            const colorHex = document.getElementById('modalColorHex').value.trim();

            if (!/^#[0-9A-Fa-f]{6}$/.test(bgHex) || !/^#[0-9A-Fa-f]{6}$/.test(colorHex)) {
                Swal.showValidationMessage('유효한 색상 코드(Hex)를 입력하세요.');
                return false;
            }

            return `{bg:${bgHex.toUpperCase()}}{color:${colorHex.toUpperCase()}}`;
        }
    }).then(result => {
        if (result.isConfirmed && result.value) {
            if (typeof editor !== 'undefined' && editor) {
                editor.insertText(result.value);
                if (typeof cmEditorView !== 'undefined' && cmEditorView) cmEditorView.focus();
            }
        }
    });
}

// ── 배지 / 태그 / 스탯 / 버튼 삽입 모달 ──
function openBadgeInsertModal() {
    return openComponentInsertModal();
}

function openComponentInsertModal() {
    const palettes = getAllPalettesForEditor();

    const state = {
        type: 'badge', // 'badge' | 'tag' | 'stat' | 'button'
        palette: '',
        text: '',   // badge/tag: 텍스트, stat: 값, button: 제목
        label: '',  // stat 전용: 라벨
        url: '',    // button 전용: URL
        icon: null, // { type: 'mdi'|'bi', name } - button 전용
        iconType: null,
        iconQuery: '',
        iconList: null,
    };

    const TYPE_META = {
        badge: { label: '배지', icon: 'mdi mdi-label-outline' },
        tag: { label: '태그', icon: 'mdi mdi-tag-outline' },
        stat: { label: '스탯', icon: 'mdi mdi-chart-box-outline' },
        button: { label: '버튼', icon: 'mdi mdi-gesture-tap-button' },
    };

    function paletteSwatchesHtml() {
        let html = `<button type="button" class="badge-insert-palette-swatch" data-palette="" title="선택 안 함">
                    <span class="badge-insert-palette-swatch-none">없음</span>
                </button>`;
        for (const p of palettes) {
            const bg = _isSafeCssColor(p.variant.bg || '') ? p.variant.bg : 'transparent';
            const color = _isSafeCssColor(p.variant.color || '') ? p.variant.color : 'inherit';
            html += `<button type="button" class="badge-insert-palette-swatch" data-palette="${escapeHtml(p.name)}" title="${escapeHtml(p.name)}" style="background:${bg};color:${color};">${escapeHtml(p.name)}</button>`;
        }
        return html;
    }

    function typeTabsHtml() {
        return Object.entries(TYPE_META).map(([key, m]) => {
            const active = state.type === key ? ' active' : '';
            return `<button type="button" class="badge-insert-type-tab${active}" data-type="${key}">
                        <i class="${m.icon}"></i>
                        <span>${m.label}</span>
                    </button>`;
        }).join('');
    }

    function fieldsHtml() {
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
                        </div>`;
        }
        if (state.type === 'button') {
            const hasIcon = !!state.icon;
            const iconPreview = hasIcon
                ? (state.icon.type === 'bi'
                    ? `<i class="bi bi-${escapeHtml(state.icon.name)}"></i>`
                    : `<span class="mdi mdi-${escapeHtml(state.icon.name)}"></span>`)
                : `<span class="badge-insert-icon-placeholder">없음</span>`;
            const iconLabel = hasIcon ? `${state.icon.type}:${state.icon.name}` : '아이콘 선택 안 함';
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
        // badge | tag
        const placeholder = state.type === 'tag' ? '예: Beta' : '예: NEW';
        return `
                    <div class="badge-insert-field">
                        <label class="form-label" for="badgeInsertText">텍스트</label>
                        <input type="text" id="badgeInsertText" class="form-control form-control-sm"
                            placeholder="${placeholder}" autocomplete="off" value="${escapeHtml(state.text)}"
                            style="background:var(--wiki-bg);color:var(--wiki-text);border-color:var(--wiki-border);">
                    </div>`;
    }

    function buildToken() {
        const palettePrefix = state.palette ? `{palette:${state.palette}}` : '';
        const text = (state.text || '').trim();
        if (state.type === 'badge') {
            if (!text) return '';
            return `${palettePrefix}{badge:${text}}`;
        }
        if (state.type === 'tag') {
            if (!text) return '';
            return `${palettePrefix}{tag:${text}}`;
        }
        if (state.type === 'stat') {
            if (!text) return '';
            const lbl = (state.label || '').trim();
            const payload = lbl ? `${text}|${lbl}` : text;
            return `${palettePrefix}{stat:${payload}}`;
        }
        if (state.type === 'button') {
            const url = (state.url || '').trim();
            if (!text || !url) return '';
            const iconPrefix = state.icon ? `{${state.icon.type}:${state.icon.name}}` : '';
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
        // render.js의 _processInlineLayoutTokens로 실제 렌더링 수행
        try {
            if (typeof _processInlineLayoutTokens === 'function') {
                preview.innerHTML = _processInlineLayoutTokens(token);
            } else {
                preview.textContent = token;
            }
        } catch (e) {
            preview.textContent = token;
        }
    }

    function validate() {
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

        // 종류 탭 이벤트
        root.querySelectorAll('.badge-insert-type-tab').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const newType = btn.dataset.type;
                if (newType === state.type) return;
                state.type = newType;
                renderFormView();
            });
        });

        // 팔레트 스와치
        const swatchesEl = document.getElementById('badgeInsertPaletteSwatches');
        if (swatchesEl) {
            swatchesEl.innerHTML = paletteSwatchesHtml();
            swatchesEl.querySelectorAll('.badge-insert-palette-swatch').forEach(sw => {
                if ((sw.dataset.palette || '') === (state.palette || '')) {
                    sw.classList.add('active');
                }
                sw.addEventListener('click', (e) => {
                    e.preventDefault();
                    state.palette = sw.dataset.palette || '';
                    swatchesEl.querySelectorAll('.badge-insert-palette-swatch').forEach(s => {
                        s.classList.toggle('active', (s.dataset.palette || '') === state.palette);
                    });
                    updatePreview();
                });
            });
        }

        // 입력 필드 바인딩
        const textInput = document.getElementById('badgeInsertText');
        if (textInput) {
            textInput.addEventListener('input', () => {
                state.text = textInput.value;
                updatePreview();
                validate();
            });
        }
        const labelInput = document.getElementById('badgeInsertLabel');
        if (labelInput) {
            labelInput.addEventListener('input', () => {
                state.label = labelInput.value;
                updatePreview();
                validate();
            });
        }
        const urlInput = document.getElementById('badgeInsertUrl');
        if (urlInput) {
            urlInput.addEventListener('input', () => {
                state.url = urlInput.value;
                updatePreview();
                validate();
            });
        }

        // 아이콘 선택 버튼 (버튼 타입 전용)
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
        // 첫 렌더링 시 텍스트 필드에 포커스
        if (textInput && !state.text) {
            setTimeout(() => textInput.focus(), 0);
        }
    }

    async function ensureIconList() {
        if (selectedIconsOnly) {
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
                let type, iconName;
                if (fullName.startsWith('bi-')) {
                    type = 'bi';
                    iconName = fullName.slice(3);
                } else if (fullName.startsWith('mdi-')) {
                    type = 'mdi';
                    iconName = fullName.slice(4);
                } else {
                    return;
                }
                // icons.json 값을 class 속성으로 사용하기 전 화이트리스트 검증 (DOM XSS 방지)
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

    async function renderIconView() {
        const root = document.getElementById('badgeInsertRoot');
        if (!root) return;

        if (!selectedIconsOnly && !state.iconType) {
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
            document.getElementById('badgeInsertIconBackType').addEventListener('click', (e) => {
                e.preventDefault();
                renderFormView();
            });
            root.querySelectorAll('.badge-insert-type-select-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    state.iconType = btn.dataset.type;
                    state.iconList = null; // force reload
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
                                <span>${!selectedIconsOnly ? '라이브러리 변경' : '돌아가기'}</span>
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
                if (!selectedIconsOnly) {
                    state.iconType = null;
                    state.iconQuery = '';
                    renderIconView();
                } else {
                    renderFormView();
                }
            });
        }
        const searchInput = document.getElementById('badgeInsertIconSearch');
        const loadingEl = document.getElementById('badgeInsertIconLoading');
        let searchTimer;
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(() => {
                    state.iconQuery = searchInput.value;
                    renderIconGrid();
                }, 150);
            });
            setTimeout(() => searchInput.focus(), 0);
        }

        if (!state.iconList) {
            if (loadingEl) loadingEl.style.display = 'block';
            await ensureIconList();
            // 뷰가 여전히 아이콘 뷰일 때만 렌더
            if (!document.getElementById('badgeInsertIconGrid')) return;
            if (loadingEl) loadingEl.style.display = 'none';
        }
        renderIconGrid();
    }

    Swal.fire({
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
        if (typeof editor !== 'undefined' && editor) {
            editor.insertText(result.value);
            if (typeof cmEditorView !== 'undefined' && cmEditorView) cmEditorView.focus();
        }
    });
}

// ── 그리드·스탯 삽입 모달 ──
function openGridStatInsertModal() {
    const palettes = getAllPalettesForEditor();
    const paletteByName = new Map();
    for (const p of palettes) paletteByName.set(p.name, p);

    function paletteSwatchesHtml() {
        let html = `<button type="button" class="grid-stat-palette-swatch" data-palette="" title="선택 안 함">
                    <span class="grid-stat-palette-swatch-none">없음</span>
                </button>`;
        for (const p of palettes) {
            const bg = _isSafeCssColor(p.variant.bg || '') ? p.variant.bg : 'transparent';
            const color = _isSafeCssColor(p.variant.color || '') ? p.variant.color : 'inherit';
            html += `<button type="button" class="grid-stat-palette-swatch" data-palette="${escapeHtml(p.name)}" title="${escapeHtml(p.name)}" style="background:${bg};color:${color};">${escapeHtml(p.name)}</button>`;
        }
        return html;
    }

    function updatePaletteBtnAppearance(btn, name) {
        const p = paletteByName.get(name);
        if (!p) {
            btn.style.background = '';
            btn.style.color = '';
            btn.innerHTML = `<span class="grid-stat-palette-btn-label grid-stat-palette-btn-none">팔레트 없음</span><i class="mdi mdi-chevron-down grid-stat-palette-btn-caret"></i>`;
            return;
        }
        const bg = _isSafeCssColor(p.variant.bg || '') ? p.variant.bg : 'transparent';
        const color = _isSafeCssColor(p.variant.color || '') ? p.variant.color : 'inherit';
        btn.style.background = bg;
        btn.style.color = color;
        btn.innerHTML = `<span class="grid-stat-palette-btn-label">${escapeHtml(p.name)}</span><i class="mdi mdi-chevron-down grid-stat-palette-btn-caret"></i>`;
    }

    const stats = [
        { value: '', label: '', palette: '' },
        { value: '', label: '', palette: '' },
    ];

    let popoverEl = null;
    let openPopoverIdx = -1;
    let outsideHandler = null;
    let windowResizeHandler = null;

    function closePopover() {
        openPopoverIdx = -1;
        if (popoverEl) popoverEl.style.display = 'none';
    }

    function positionPopover(btn) {
        if (!popoverEl) return;
        const rect = btn.getBoundingClientRect();
        // CSS의 display: flex (wrap + gap) 레이아웃 유지: 'block'으로 덮어쓰지 않음
        popoverEl.style.display = 'flex';
        // 화면 아래 공간이 부족하면 위쪽으로 띄움
        const popH = Math.min(popoverEl.offsetHeight || 240, 300);
        const belowSpace = window.innerHeight - rect.bottom;
        const top = belowSpace < popH + 12 && rect.top > popH + 12
            ? Math.max(8, rect.top - popH - 6)
            : rect.bottom + 4;
        popoverEl.style.top = `${top}px`;
        popoverEl.style.left = `${Math.max(8, rect.left)}px`;
        popoverEl.style.minWidth = `${Math.max(200, rect.width)}px`;
    }

    function openPopover(idx, btn) {
        if (!popoverEl) return;
        openPopoverIdx = idx;
        const currentVal = (stats[idx] && stats[idx].palette) || '';
        popoverEl.querySelectorAll('.grid-stat-palette-swatch').forEach(sw => {
            sw.classList.toggle('active', (sw.dataset.palette || '') === currentVal);
        });
        positionPopover(btn);
    }

    function render() {
        const list = document.getElementById('gridStatList');
        if (!list) return;
        list.innerHTML = '';
        stats.forEach((s, i) => {
            const row = document.createElement('div');
            row.className = 'grid-stat-row';
            row.innerHTML = `
                        <input type="text" class="form-control form-control-sm grid-stat-value" data-idx="${i}"
                            placeholder="값" value="${escapeHtml(s.value)}"
                            style="background:var(--wiki-bg);color:var(--wiki-text);border-color:var(--wiki-border);">
                        <input type="text" class="form-control form-control-sm grid-stat-label" data-idx="${i}"
                            placeholder="라벨" value="${escapeHtml(s.label)}"
                            style="background:var(--wiki-bg);color:var(--wiki-text);border-color:var(--wiki-border);">
                        <button type="button" class="grid-stat-palette-btn" data-idx="${i}"
                            aria-haspopup="listbox" aria-expanded="false"></button>
                        <button type="button" class="grid-stat-remove" data-idx="${i}" title="삭제">
                            <i class="mdi mdi-close"></i>
                        </button>
                    `;
            list.appendChild(row);
            const paletteBtn = row.querySelector('.grid-stat-palette-btn');
            if (paletteBtn) updatePaletteBtnAppearance(paletteBtn, s.palette || '');
        });

        list.querySelectorAll('.grid-stat-value').forEach(el => {
            el.addEventListener('input', (e) => {
                const i = parseInt(e.target.dataset.idx, 10);
                if (!Number.isNaN(i) && stats[i]) stats[i].value = e.target.value;
            });
        });
        list.querySelectorAll('.grid-stat-label').forEach(el => {
            el.addEventListener('input', (e) => {
                const i = parseInt(e.target.dataset.idx, 10);
                if (!Number.isNaN(i) && stats[i]) stats[i].label = e.target.value;
            });
        });
        list.querySelectorAll('.grid-stat-palette-btn').forEach(el => {
            el.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const i = parseInt(el.dataset.idx, 10);
                if (Number.isNaN(i)) return;
                if (openPopoverIdx === i) { closePopover(); return; }
                openPopover(i, el);
            });
        });
        list.querySelectorAll('.grid-stat-remove').forEach(el => {
            el.addEventListener('click', (e) => {
                const i = parseInt(e.currentTarget.dataset.idx, 10);
                if (!Number.isNaN(i)) {
                    stats.splice(i, 1);
                    if (stats.length === 0) stats.push({ value: '', label: '', palette: '' });
                    closePopover();
                    render();
                }
            });
        });
    }

    Swal.fire({
        title: '<i class="mdi mdi-view-grid-outline me-2"></i>그리드·스탯 삽입',
        width: 640,
        html: `
                    <div class="text-start grid-stat-form">
                        <p style="font-size:0.85rem;color:var(--wiki-text-muted);margin-bottom:10px;">
                            그리드에 표시할 스탯 항목을 편집한 뒤 삽입하세요.
                        </p>
                        <div class="grid-stat-header">
                            <span>값</span>
                            <span>라벨</span>
                            <span>팔레트</span>
                            <span></span>
                        </div>
                        <div id="gridStatList" class="grid-stat-list"></div>
                        <button type="button" id="gridStatAddBtn" class="grid-stat-add-btn">
                            <i class="mdi mdi-plus"></i> 스탯 추가
                        </button>
                    </div>
                `,
        showCancelButton: true,
        confirmButtonText: '삽입',
        cancelButtonText: '취소',
        didOpen: () => {
            // 팔레트 팝오버를 body에 부착 (모달 내 overflow 클리핑 방지)
            popoverEl = document.createElement('div');
            popoverEl.className = 'grid-stat-palette-popover';
            popoverEl.style.display = 'none';
            popoverEl.innerHTML = paletteSwatchesHtml();
            document.body.appendChild(popoverEl);

            popoverEl.querySelectorAll('.grid-stat-palette-swatch').forEach(sw => {
                sw.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (openPopoverIdx < 0 || !stats[openPopoverIdx]) { closePopover(); return; }
                    const val = sw.dataset.palette || '';
                    stats[openPopoverIdx].palette = val;
                    const btn = document.querySelector(`.grid-stat-palette-btn[data-idx="${openPopoverIdx}"]`);
                    if (btn) updatePaletteBtnAppearance(btn, val);
                    closePopover();
                });
            });

            outsideHandler = (e) => {
                if (openPopoverIdx < 0) return;
                if (popoverEl && popoverEl.contains(e.target)) return;
                if (e.target.closest && e.target.closest('.grid-stat-palette-btn')) return;
                closePopover();
            };
            document.addEventListener('mousedown', outsideHandler, true);

            windowResizeHandler = () => {
                if (openPopoverIdx < 0) return;
                const btn = document.querySelector(`.grid-stat-palette-btn[data-idx="${openPopoverIdx}"]`);
                if (btn) positionPopover(btn);
                else closePopover();
            };
            window.addEventListener('resize', windowResizeHandler);
            document.querySelector('.swal2-container')?.addEventListener('scroll', windowResizeHandler, true);
            document.getElementById('gridStatList')?.addEventListener('scroll', windowResizeHandler, true);

            render();
            const firstInput = document.querySelector('#gridStatList .grid-stat-value');
            if (firstInput) firstInput.focus();
            const addBtn = document.getElementById('gridStatAddBtn');
            if (addBtn) {
                addBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    closePopover();
                    stats.push({ value: '', label: '', palette: '' });
                    render();
                });
            }
        },
        willClose: () => {
            if (outsideHandler) document.removeEventListener('mousedown', outsideHandler, true);
            if (windowResizeHandler) {
                window.removeEventListener('resize', windowResizeHandler);
                document.querySelector('.swal2-container')?.removeEventListener('scroll', windowResizeHandler, true);
                document.getElementById('gridStatList')?.removeEventListener('scroll', windowResizeHandler, true);
            }
            if (popoverEl && popoverEl.parentNode) popoverEl.parentNode.removeChild(popoverEl);
            popoverEl = null;
            openPopoverIdx = -1;
            outsideHandler = null;
            windowResizeHandler = null;
        },
        preConfirm: () => {
            const normalized = stats.map(s => ({
                value: (s.value || '').trim(),
                label: (s.label || '').trim(),
                palette: (s.palette || '').trim()
            }));
            const filled = normalized.filter(s => s.value !== '' || s.label !== '' || s.palette !== '');
            if (filled.length === 0) {
                Swal.showValidationMessage('최소 한 개 이상의 스탯을 입력해주세요.');
                return false;
            }
            if (filled.some(s => s.value === '')) {
                Swal.showValidationMessage('각 스탯 항목에는 값을 입력해주세요.');
                return false;
            }
            const invalidChars = /[|\}\r\n]/;
            for (const s of filled) {
                if (invalidChars.test(s.value) || invalidChars.test(s.label)) {
                    Swal.showValidationMessage('값 또는 라벨에 |, }, 줄바꿈 문자를 사용할 수 없습니다.');
                    return false;
                }
            }
            return filled;
        }
    }).then(result => {
        if (!result.isConfirmed || !Array.isArray(result.value)) return;
        const lines = [':::grid'];
        for (const s of result.value) {
            const { value, label, palette } = s;
            const prefix = palette ? `{palette:${palette}}` : '';
            const payload = label ? `${value}|${label}` : value;
            lines.push(`${prefix}{stat:${payload}}`);
        }
        lines.push(':::');
        editor.insertText(lines.join('\n'));
        if (typeof cmEditorView !== 'undefined' && cmEditorView) cmEditorView.focus();
    });
}

// ── 하위 문서 구조 삽입 모달 ──
async function openSubdocInsertModal() {
    let subdocSelectedSlug = null;
    let subdocPreviewText = '';
    let subdocDebounceTimer = null;
    let subdocActiveIdx = -1;

    const result = await Swal.fire({
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
                        `, width: 600,
        showCancelButton: true,
        cancelButtonText: '취소',
        confirmButtonText: '삽입',
        didOpen: () => {
            Swal.getConfirmButton().disabled = true;

            const input = document.getElementById('subdocSearchInput');
            const sugBox = document.getElementById('subdocSuggestions');

            input.addEventListener('input', function () {
                clearTimeout(subdocDebounceTimer);
                const q = this.value.trim();
                if (q.length < 2) {
                    sugBox.style.display = 'none';
                    sugBox.innerHTML = '';
                    return;
                }
                subdocDebounceTimer = setTimeout(() => fetchSubdocSuggestions(q), 250);
            });

            async function fetchSubdocSuggestions(q) {
                try {
                    const res = await fetch('/api/search/suggest?q=' + encodeURIComponent(q));
                    if (!res.ok) return;
                    const data = await res.json();
                    renderSubdocSuggestions(data.suggestions || []);
                } catch (e) { }
            }

            function renderSubdocSuggestions(items) {
                subdocActiveIdx = -1;
                const filtered = items.filter(item => !item.slug.includes(':'));
                if (!filtered.length) {
                    sugBox.style.display = 'none';
                    sugBox.innerHTML = '';
                    return;
                }
                sugBox.innerHTML = filtered.map((item) =>
                    '<li class="search-suggestion-item" data-slug="' + escapeHtml(item.slug) +
                    '" data-title="' + escapeHtml(item.title) + '">' +
                    '<i class="mdi mdi-file-document-outline"></i> ' +
                    escapeHtml(item.title) + '</li>'
                ).join('');
                sugBox.style.display = 'block';
                sugBox.querySelectorAll('.search-suggestion-item').forEach(el => {
                    el.addEventListener('mousedown', function (e) {
                        e.preventDefault();
                        selectSubdocItem(this.dataset.slug, this.dataset.title);
                    });
                });
            }

            function selectSubdocItem(slug, title) {
                subdocSelectedSlug = slug;
                input.value = title;
                sugBox.style.display = 'none';
                sugBox.innerHTML = '';
                loadSubdocPreview(slug);
            }

            input.addEventListener('keydown', function (e) {
                const items = sugBox.querySelectorAll('.search-suggestion-item');
                if (sugBox.style.display !== 'none' && items.length) {
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
                        selectSubdocItem(el.dataset.slug, el.dataset.title);
                    } else if (e.key === 'Escape') {
                        sugBox.style.display = 'none';
                    }
                }
            });

            input.addEventListener('blur', function () {
                setTimeout(() => { sugBox.style.display = 'none'; }, 150);
            });

            input.focus();
        },
        preConfirm: () => {
            if (!subdocPreviewText) return false;
            return subdocPreviewText;
        }
    });

    if (result.isConfirmed && result.value) {
        editor.insertText(result.value);
        editor.focus();
    }

    async function loadSubdocPreview(slug) {
        try {
            const res = await fetch('/api/w/' + encodeURIComponent(slug) + '/subdocs');
            const data = await res.json();
            const subdocs = data.subdocs || [];

            const tree = {};
            for (const doc of subdocs) {
                const relative = doc.slug.substring(slug.length + 1);
                const parts = relative.split('/');
                let node = tree;
                for (const part of parts) {
                    if (!node[part]) node[part] = { _children: {}, _doc: null };
                    node = node[part]._children;
                }
                let target = tree;
                for (let i = 0; i < parts.length; i++) {
                    if (i === parts.length - 1) {
                        target[parts[i]]._doc = doc;
                    } else {
                        target = target[parts[i]]._children;
                    }
                }
            }

            function renderTree(nodes, parentPrefix) {
                const entries = Object.keys(nodes).sort();
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
            Swal.getConfirmButton().disabled = false;
        } catch (e) {
            console.error(e);
        }
    }
}
// ── 템플릿 모달 ──
async function openTemplateModal() {
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
            showCloseButton: true,
            didOpen: async () => {
                const searchInput = document.getElementById('templateSearchInput');
                const searchBtn = document.getElementById('templateSearchBtn');
                const listContainer = document.getElementById('templateList');

                const renderTemplates = (templates) => {
                    listContainer.innerHTML = '';
                    if (!templates || templates.length === 0) {
                        listContainer.innerHTML = '<div class="p-3 text-center text-muted">검색 결과가 없습니다.</div>';
                        return;
                    }

                    templates.forEach(t => {
                        // 템플릿: 틀: template: 등의 접두사를 제외한 제목 표시
                        const displayTitle = t.title.replace(/^(틀|template|템플릿):/i, '');
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

                const fetchTemplates = async (query = '') => {
                    listContainer.innerHTML = '<div class="p-3 text-center"><span class="spinner-border spinner-border-sm text-primary" role="status"></span> 불러오는 중...</div>';
                    try {
                        const res = await fetch(`/api/w/templates${query ? `?q=${encodeURIComponent(query)}` : ''}`);
                        if (!res.ok) throw new Error('템플릿 목록을 불러올 수 없습니다.');
                        const data = await res.json();
                        renderTemplates(data.templates);
                    } catch (err) {
                        listContainer.innerHTML = `<div class="p-3 text-center text-danger">${err.message}</div>`;
                    }
                };

                // 초기 로딩 (최신 템플릿 10개)
                await fetchTemplates();

                // 검색 이벤트
                searchBtn.onclick = () => fetchTemplates(searchInput.value.trim());
                searchInput.onkeypress = (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        fetchTemplates(searchInput.value.trim());
                    }
                };
            }
        });

        async function applyTemplate(selectedSlug) {
            try {
                const tRes = await fetch(`/api/w/${encodeURIComponent(selectedSlug)}`);
                if (!tRes.ok) throw new Error('템플릿 내용을 불러올 수 없습니다.');
                const tPage = await tRes.json();

                if (editor.getMarkdown().trim()) {
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
                editor.setMarkdown(tContent);
                scrollToBottom();
                Swal.fire('완료', '템플릿을 불러왔습니다.', 'success');
            } catch (err) {
                Swal.fire('오류', err.message, 'error');
            }
        }
    } catch (err) {
        Swal.fire('오류', err.message, 'error');
    }
}

