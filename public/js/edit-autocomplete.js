// ── 이미지 사이즈 인라인 자동완성 상태 ──
const imgSizeAc = {
    visible: false,
    selectedIndex: -1,
    div: document.getElementById('imgsize-autocomplete'),
    options: [
        { id: 'icon', label: '아이콘', icon: 'mdi-square-medium-outline' },
        { id: 'small', label: '작게', icon: 'mdi-arrow-collapse' },
        { id: 'medium', label: '중간', icon: 'mdi-square-outline' },
        { id: 'full', label: '크게(기본)', icon: 'mdi-arrow-expand-all' }
    ]
};

function hideImgSizeAutocomplete() {
    imgSizeAc.visible = false;
    imgSizeAc.selectedIndex = -1;
    if (imgSizeAc.div) imgSizeAc.div.style.display = 'none';
}

function showImgSizeAutocomplete() {
    imgSizeAc.visible = true;
    positionDropdownAtCursor(imgSizeAc.div, 200);
    renderImgSizeAcResults();
}

function renderImgSizeAcResults() {
    const gridEl = document.getElementById('imgsizeAcGrid');
    if (!gridEl) return;

    gridEl.innerHTML = imgSizeAc.options.map((opt, index) => `
        <div class="list-group-item autocomplete-item" data-index="${index}" onclick="selectImgSizeAutocomplete(${index})" style="cursor:pointer; padding:8px 10px;">
            <i class="mdi ${opt.icon}"></i>
            <span>${escapeHtml(opt.label)}</span>
            <span class="text-muted" style="font-size:0.8em; margin-left:4px;">${escapeHtml(opt.id)}</span>
        </div>
    `).join('');

    imgSizeAc.selectedIndex = 0;
    highlightImgSizeAcItem();
}

function highlightImgSizeAcItem() {
    if (!imgSizeAc.div) return;
    const items = imgSizeAc.div.querySelectorAll('.autocomplete-item');
    items.forEach((item, idx) => {
        if (idx === imgSizeAc.selectedIndex) {
            item.classList.add('active');
            item.scrollIntoView({ block: 'nearest' });
        } else {
            item.classList.remove('active');
        }
    });
}

function selectImgSizeAutocomplete(index) {
    const opt = imgSizeAc.options[index];
    if (!opt || !editor) return;

    const selection = editor.getSelection();
    if (!selection) { hideImgSizeAutocomplete(); return; }

    const [from] = selection;
    const line = from[0];
    const col = from[1];

    const md = editor.getMarkdown();
    const lines = md.split('\n');
    const lineText = lines[line - 1] || '';
    const textBefore = lineText.substring(0, col - 1);

    // `![...](...)` 의 마지막 `)` 위치를 찾는다
    const match = textBefore.match(/!\[[^\]]*\]\([^)]+\)$/);

    if (match) {
        // 이미지가 바로 앞에 있을 때
        if (opt.id !== 'full') {
            editor.insertText(`{size:${opt.id}}`);
        }
    }
    hideImgSizeAutocomplete();
    editor.focus();
}

// ── 아이콘 인라인 자동완성 상태 ──
const iconAc = {
    visible: false,
    type: 'bi',              // 'bi' | 'mdi' | 'icon'
    query: '',
    results: [],
    selectedIndex: -1,
    lastKey: null,
    debounceTimer: null,
    div: document.getElementById('icon-autocomplete'),
    COLS: 5,                 // 인라인 자동완성 그리드 열 수
};

// ── 색상 피커 인라인 자동완성 상태 ──
const colorAc = {
    visible: false,
    trigger: 'bg',           // 'bg' | 'color'
    hue: 0,
    saturation: 1,
    brightness: 1,
    selectedSwatchIndex: -1,
    dragging: null,          // 'palette' | 'hue' | null
    div: document.getElementById('color-autocomplete'),
};
const COLOR_SWATCHES = [
    '#000000', '#FFFFFF', '#FF0000', '#FF8000', '#FFFF00',
    '#00FF00', '#00FFFF', '#0080FF', '#0000FF', '#8000FF',
    '#FF00FF', '#FF0080', '#808080', '#C0C0C0', '#800000',
    '#808000', '#008000', '#008080', '#000080', '#800080'
];

// ── 색상 팔레트 캔버스 그리기 ──
function drawColorPalette() {
    const canvas = document.getElementById('colorPaletteCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;

    // 배경: 왼→오 = 흰색→순색 (채도), 위→아래 = 밝음→검정 (명도)
    for (let x = 0; x < w; x++) {
        const s = x / w;
        for (let y = 0; y < h; y++) {
            const v = 1 - y / h;
            ctx.fillStyle = hsvToHex(colorAc.hue, s, v);
            ctx.fillRect(x, y, 1, 1);
        }
    }

    // 선택 위치 표시
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

function drawHueSlider() {
    const canvas = document.getElementById('colorHueSlider');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;

    const gradient = ctx.createLinearGradient(0, 0, w, 0);
    for (let i = 0; i <= 6; i++) {
        gradient.addColorStop(i / 6, hsvToHex(i * 60, 1, 1));
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);

    // 선택 위치 표시
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

function updateColorPreview() {
    const hex = hsvToHex(colorAc.hue, colorAc.saturation, colorAc.brightness);
    const previewBox = document.getElementById('colorPreviewBox');
    const hexInput = document.getElementById('colorHexInput');
    if (previewBox) previewBox.style.backgroundColor = hex;
    if (hexInput) hexInput.value = hex.toUpperCase();
}

// ── 색상 스와치 렌더링 ──
function renderColorSwatches() {
    const container = document.getElementById('colorAcSwatches');
    if (!container) return;
    container.innerHTML = COLOR_SWATCHES.map((color, i) =>
        `<div class="color-swatch${i === colorAc.selectedSwatchIndex ? ' active' : ''}" data-index="${i}" style="background:${color};" title="${color}"></div>`
    ).join('');

    container.querySelectorAll('.color-swatch').forEach(el => {
        el.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const idx = parseInt(el.dataset.index);
            selectColorSwatch(idx);
            applyColorAutocomplete();
        });
        el.addEventListener('touchend', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const idx = parseInt(el.dataset.index);
            selectColorSwatch(idx);
            applyColorAutocomplete();
        });
    });
}

function selectColorSwatch(index) {
    colorAc.selectedSwatchIndex = index;
    const hex = COLOR_SWATCHES[index];
    const hsv = hexToHsv(hex);
    colorAc.hue = hsv.h;
    colorAc.saturation = hsv.s;
    colorAc.brightness = hsv.v;
    drawColorPalette();
    drawHueSlider();
    updateColorPreview();
    renderColorSwatches();
}

// ── 캔버스 이벤트 처리 (마우스 + 터치) ──
function getCanvasPos(canvas, e) {
    const rect = canvas.getBoundingClientRect();
    let clientX, clientY;
    if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    } else {
        clientX = e.clientX;
        clientY = e.clientY;
    }
    return {
        x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
    };
}

function initColorPickerCanvasEvents() {
    const paletteCanvas = document.getElementById('colorPaletteCanvas');
    const hueCanvas = document.getElementById('colorHueSlider');
    if (!paletteCanvas || !hueCanvas) return;

    function handlePaletteInteraction(e) {
        const pos = getCanvasPos(paletteCanvas, e);
        colorAc.saturation = pos.x;
        colorAc.brightness = 1 - pos.y;
        colorAc.selectedSwatchIndex = -1;
        drawColorPalette();
        updateColorPreview();
        renderColorSwatches();
    }

    function handleHueInteraction(e) {
        const pos = getCanvasPos(hueCanvas, e);
        colorAc.hue = pos.x * 360;
        colorAc.selectedSwatchIndex = -1;
        drawColorPalette();
        drawHueSlider();
        updateColorPreview();
        renderColorSwatches();
    }

    // 마우스 이벤트
    paletteCanvas.addEventListener('mousedown', (e) => {
        e.preventDefault();
        colorAc.dragging = 'palette';
        handlePaletteInteraction(e);
    });
    hueCanvas.addEventListener('mousedown', (e) => {
        e.preventDefault();
        colorAc.dragging = 'hue';
        handleHueInteraction(e);
    });
    document.addEventListener('mousemove', (e) => {
        if (colorAc.dragging === 'palette') handlePaletteInteraction(e);
        else if (colorAc.dragging === 'hue') handleHueInteraction(e);
    });
    document.addEventListener('mouseup', () => { colorAc.dragging = null; });

    // 터치 이벤트
    paletteCanvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        colorAc.dragging = 'palette';
        handlePaletteInteraction(e);
    }, { passive: false });
    hueCanvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        colorAc.dragging = 'hue';
        handleHueInteraction(e);
    }, { passive: false });
    document.addEventListener('touchmove', (e) => {
        if (colorAc.dragging === 'palette') { e.preventDefault(); handlePaletteInteraction(e); }
        else if (colorAc.dragging === 'hue') { e.preventDefault(); handleHueInteraction(e); }
    }, { passive: false });
    document.addEventListener('touchend', () => { colorAc.dragging = null; });

    // Hex 입력 직접 수정
    const hexInput = document.getElementById('colorHexInput');
    if (hexInput) {
        hexInput.addEventListener('input', () => {
            const val = hexInput.value.trim();
            if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
                const hsv = hexToHsv(val);
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
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                applyColorAutocomplete();
            }
        });
    }

    // 적용 버튼
    const applyBtn = document.getElementById('colorApplyBtn');
    if (applyBtn) {
        applyBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            applyColorAutocomplete();
        });
    }
}

// ── 색상 자동완성: 숨기기 ──
function hideColorAutocomplete() {
    colorAc.visible = false;
    colorAc.dragging = null;
    colorAc.selectedSwatchIndex = -1;
    if (colorAc.div) colorAc.div.style.display = 'none';
}

// ── 색상 자동완성: 표시 ──
function showColorAutocomplete(query, type) {
    colorAc.trigger = type;
    colorAc.visible = true;

    const typeLabelEl = document.getElementById('colorAcTypeLabel');
    if (typeLabelEl) {
        typeLabelEl.textContent = type === 'bg' ? '배경색 선택' : '글자색 선택';
    }

    // 커서 위치에 드롭다운 표시
    positionDropdownAtCursor(colorAc.div, 280);

    // 쿼리에 이미 색상값이 있으면 반영
    if (query && /^#[0-9A-Fa-f]{6}$/.test(query.trim())) {
        const hsv = hexToHsv(query.trim());
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

// ── 색상 자동완성: 적용 ──
function applyColorAutocomplete() {
    if (!editor) { hideColorAutocomplete(); return; }

    const hex = hsvToHex(colorAc.hue, colorAc.saturation, colorAc.brightness).toUpperCase();
    const selection = editor.getSelection();
    if (!selection) { hideColorAutocomplete(); return; }

    const [from] = selection;
    const line = from[0];
    const col = from[1];

    const md = editor.getMarkdown();
    const lines = md.split('\n');
    const lineText = lines[line - 1] || '';
    const textBefore = lineText.substring(0, col - 1);

    const prefix = colorAc.trigger === 'bg' ? '{bg:' : '{color:';
    const lastTriggerIndex = textBefore.lastIndexOf(prefix);

    if (lastTriggerIndex !== -1) {
        editor.setSelection([line, lastTriggerIndex + 1], [line, col]);
        editor.insertText(`${prefix}${hex}}`);
    }

    hideColorAutocomplete();
    editor.focus();
}

// 캔버스 이벤트 초기화
initColorPickerCanvasEvents();

// ── 타임스탬프 인라인 자동완성 ──
const timestampAc = {
    visible: false,
    trigger: 'dday',   // 'age' | 'dday' | 'time' | 'timer' | 'calendar'
    div: document.getElementById('timestamp-autocomplete'),
};

// ── 달력 상태 ──
const cal = {
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1, // 1~12
    selectedDate: null,               // 'YYYY-MM-DD'
    yearPanelBase: Math.floor(new Date().getFullYear() / 12) * 12,
    showingYearPanel: false,
};

function _calPad(n) { return String(n).padStart(2, '0'); }

function _renderCalendar() {
    const grid = document.getElementById('tsCalGrid');
    const ymBtn = document.getElementById('tsCalYearMonth');
    const yearRangeEl = document.getElementById('tsCalYearRange');
    const yearGrid = document.getElementById('tsCalYearGrid');
    const calSection = document.getElementById('tsCalSection');
    const yearPanel = document.getElementById('tsCalYearPanel');
    if (!grid || !ymBtn) return;

    ymBtn.textContent = `${cal.year}년 ${_calPad(cal.month)}월`;

    if (cal.showingYearPanel) {
        calSection.style.display = 'none';
        yearPanel.style.display = 'block';
        const base = cal.yearPanelBase;
        if (yearRangeEl) yearRangeEl.textContent = `${base} – ${base + 11}`;
        if (yearGrid) {
            yearGrid.innerHTML = '';
            for (let y = base; y < base + 12; y++) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'ts-cal-year-btn' + (y === cal.year ? ' selected' : '');
                btn.textContent = y;
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

    calSection.style.display = 'block';
    yearPanel.style.display = 'none';

    const firstDay = new Date(cal.year, cal.month - 1, 1).getDay(); // 0=Sun
    const daysInMonth = new Date(cal.year, cal.month, 0).getDate();
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${_calPad(today.getMonth() + 1)}-${_calPad(today.getDate())}`;

    grid.innerHTML = '';
    // 빈 칸
    for (let i = 0; i < firstDay; i++) {
        const empty = document.createElement('div');
        empty.className = 'ts-cal-cell empty';
        grid.appendChild(empty);
    }
    // 날짜 칸
    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${cal.year}-${_calPad(cal.month)}-${_calPad(d)}`;
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'ts-cal-cell';
        if (dateStr === todayStr) cell.classList.add('today');
        if (dateStr === cal.selectedDate) cell.classList.add('selected');
        cell.textContent = d;
        cell.addEventListener('mousedown', (e) => {
            e.preventDefault();
            cal.selectedDate = dateStr;
            const inputEl = document.getElementById('tsAcInput');
            if (inputEl) inputEl.value = dateStr;
            applyTimestampAutocomplete();
        });
        grid.appendChild(cell);
    }
}

function _initCalendarEvents() {
    document.getElementById('tsCalPrev').addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (cal.showingYearPanel) { cal.yearPanelBase -= 12; }
        else { cal.month--; if (cal.month < 1) { cal.month = 12; cal.year--; } }
        _renderCalendar();
    });
    document.getElementById('tsCalNext').addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (cal.showingYearPanel) { cal.yearPanelBase += 12; }
        else { cal.month++; if (cal.month > 12) { cal.month = 1; cal.year++; } }
        _renderCalendar();
    });
    document.getElementById('tsCalYearMonth').addEventListener('mousedown', (e) => {
        e.preventDefault();
        cal.yearPanelBase = Math.floor(cal.year / 12) * 12;
        cal.showingYearPanel = !cal.showingYearPanel;
        _renderCalendar();
    });
    document.getElementById('tsCalYearPrev').addEventListener('mousedown', (e) => {
        e.preventDefault();
        cal.yearPanelBase -= 12;
        _renderCalendar();
    });
    document.getElementById('tsCalYearNext').addEventListener('mousedown', (e) => {
        e.preventDefault();
        cal.yearPanelBase += 12;
        _renderCalendar();
    });
}
_initCalendarEvents();

function hideTimestampAutocomplete() {
    timestampAc.visible = false;
    if (timestampAc.div) timestampAc.div.style.display = 'none';
}

function showTimestampAutocomplete(trigger) {
    timestampAc.trigger = trigger;
    timestampAc.visible = true;

    const iconEl = document.getElementById('tsAcIcon');
    const labelEl = document.getElementById('tsAcTypeLabel');
    const inputEl = document.getElementById('tsAcInput');
    const presetsEl = document.getElementById('tsAcPresets');
    const calSec = document.getElementById('tsCalSection');
    const yearPanel = document.getElementById('tsCalYearPanel');

    const isDate = (trigger === 'age' || trigger === 'dday' || trigger === 'calendar');

    // 섹션 전환
    if (calSec) calSec.style.display = isDate ? 'block' : 'none';
    if (yearPanel) yearPanel.style.display = 'none';
    if (presetsEl) presetsEl.style.display = isDate ? 'none' : 'flex';

    const today = new Date();
    function _localDateStr(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    function _offsetDate(days) {
        const d = new Date(today);
        d.setDate(d.getDate() + days);
        return _localDateStr(d);
    }
    function _offsetYear(years) {
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
        // time / timer
        if (iconEl) iconEl.className = trigger === 'timer' ? 'mdi mdi-timer-outline' : 'mdi mdi-clock-outline';
        if (labelEl) labelEl.textContent = trigger === 'timer' ? '타이머 시간 선택' : '표시 시간 선택';
        if (inputEl) { inputEl.type = 'text'; inputEl.placeholder = 'Unix 타임스탬프 (초)'; inputEl.readOnly = false; }
        const now = Math.floor(Date.now() / 1000);
        const presets = [
            { label: '지금', value: now },
            { label: '+1시간', value: now + 3600 },
            { label: '+1일', value: now + 86400 },
            { label: '+1주', value: now + 7 * 86400 },
            { label: '+1달', value: now + 30 * 86400 },
            { label: '+1년', value: now + 365 * 86400 },
        ];
        if (presetsEl) {
            presetsEl.innerHTML = presets.map(p =>
                `<button type="button" class="ts-ac-preset-btn" data-value="${p.value}">${escapeHtml(p.label)}</button>`
            ).join('');
            presetsEl.querySelectorAll('.ts-ac-preset-btn').forEach(btn => {
                btn.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    if (inputEl) inputEl.value = btn.dataset.value;
                    applyTimestampAutocomplete();
                });
            });
        }
        if (inputEl) inputEl.value = String(now);
    }

    if (isDate) _renderCalendar();
    positionDropdownAtCursor(timestampAc.div, 294);
}

function applyTimestampAutocomplete() {
    if (!editor) { hideTimestampAutocomplete(); return; }

    const inputEl = document.getElementById('tsAcInput');
    if (!inputEl) { hideTimestampAutocomplete(); return; }
    const val = inputEl.value.trim();
    if (!val) { hideTimestampAutocomplete(); return; }

    const selection = editor.getSelection();
    if (!selection) { hideTimestampAutocomplete(); return; }

    const [from] = selection;
    const line = from[0];
    const col = from[1];

    const md = editor.getMarkdown();
    const lines = md.split('\n');
    const lineText = lines[line - 1] || '';
    const textBefore = lineText.substring(0, col - 1);

    const prefix = `{${timestampAc.trigger}:`;
    const lastTriggerIndex = textBefore.lastIndexOf(prefix);
    if (lastTriggerIndex !== -1) {
        editor.setSelection([line, lastTriggerIndex + 1], [line, col]);
        editor.insertText(`${prefix}${val}}`);
    }

    hideTimestampAutocomplete();
    editor.focus();
}

// 적용 버튼 / 입력창 키보드
(function () {
    const applyBtn = document.getElementById('tsAcApplyBtn');
    if (applyBtn) {
        applyBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            applyTimestampAutocomplete();
        });
    }
    const inputEl = document.getElementById('tsAcInput');
    if (inputEl) {
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                applyTimestampAutocomplete();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                hideTimestampAutocomplete();
                if (editor) editor.focus();
            }
        });
    }
})();

// ── 아이콘 인라인 자동완성: 숨기기 ──
function hideIconAutocomplete() {
    iconAc.visible = false;
    iconAc.results = [];
    iconAc.selectedIndex = -1;
    iconAc.lastKey = null;
    if (iconAc.div) iconAc.div.style.display = 'none';
}

// ── 아이콘 인라인 자동완성: 표시 ──
function showIconAutocomplete(query, type) {
    iconAc.query = query;
    iconAc.type = type;
    iconAc.visible = true;

    const typeIconEl = document.getElementById('iconAc.typeIcon');
    const typeLabelEl = document.getElementById('iconAc.typeLabel');
    if (typeIconEl) {
        typeIconEl.className = type === 'icon' ? 'bi bi-search' : (type === 'bi' ? 'bi bi-bootstrap' : 'mdi mdi-material-design');
    }
    if (typeLabelEl) {
        typeLabelEl.textContent = type === 'icon' ? '아이콘 검색' : (type === 'bi' ? 'Bootstrap Icons' : 'Material Design Icons');
    }

    // 커서 위치에 드롭다운 표시
    positionDropdownAtCursor(iconAc.div, 330);

    const iconAcKey = `${type}:${query}`;
    if (iconAcKey === iconAc.lastKey) return;
    iconAc.lastKey = iconAcKey;

    // 로딩 표시
    const gridEl = document.getElementById('iconAcGrid');
    const emptyEl = document.getElementById('iconAcEmpty');
    const loadingEl = document.getElementById('iconAcLoading');
    if (gridEl) gridEl.innerHTML = '';
    if (emptyEl) emptyEl.style.display = 'none';
    if (loadingEl) loadingEl.style.display = 'block';

    clearTimeout(iconAc.debounceTimer);
    iconAc.debounceTimer = setTimeout(async () => {
        const requestedType = type;
        const requestedQuery = query;
        if (!iconAc.visible) return;

        let icons;
        if (requestedType === 'icon') {
            // {icon:} 자동완성 - icons.json에서 로드
            icons = await loadSelectedIcons();
        } else if (selectedIconsOnly) {
            // selectedIconsOnly 모드에서 {bi:}, {mdi:} 자동완성도 icons.json 기반
            const all = await loadSelectedIcons();
            const prefix = requestedType === 'bi' ? 'bi-' : 'mdi-';
            icons = all.filter(n => n.startsWith(prefix)).map(n => n.slice(prefix.length));
        } else {
            icons = requestedType === 'bi' ? await loadBiIcons() : await loadMdiIcons();
        }

        if (!iconAc.visible) return;
        if (iconAc.type !== requestedType || iconAc.query !== requestedQuery) return;
        if (loadingEl) loadingEl.style.display = 'none';
        iconAc.results = filterIcons(icons, requestedQuery, 30);
        renderIconAcResults();
    }, 150);
}

// ── 아이콘 인라인 자동완성: 결과 렌더링 ──
function renderIconAcResults() {
    const gridEl = document.getElementById('iconAcGrid');
    const emptyEl = document.getElementById('iconAcEmpty');
    if (!gridEl) return;

    if (iconAc.results.length === 0) {
        gridEl.innerHTML = '';
        if (emptyEl) emptyEl.style.display = 'block';
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    const getIconClass = (iconName) => {
        if (iconAc.type === 'icon') {
            // {icon:} 타입: 아이콘코드에 bi- 또는 mdi- 접두사 포함
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

// ── 아이콘 인라인 자동완성: 선택 항목 하이라이트 ──
function highlightIconAcItem() {
    if (!iconAc.div) return;
    const items = iconAc.div.querySelectorAll('.icon-ac-item');
    items.forEach((item, idx) => {
        if (idx === iconAc.selectedIndex) {
            item.classList.add('active');
            item.scrollIntoView({ block: 'nearest' });
        } else {
            item.classList.remove('active');
        }
    });
}

// ── 아이콘 인라인 자동완성: 선택 ──
function selectIconAutocomplete(index) {
    const iconName = iconAc.results[index];
    if (!iconName || !editor) return;

    const selection = editor.getSelection();
    if (!selection) { hideIconAutocomplete(); return; }

    const [from] = selection;
    const line = from[0];
    const col = from[1];

    const md = editor.getMarkdown();
    const lines = md.split('\n');
    const lineText = lines[line - 1] || '';
    const textBefore = lineText.substring(0, col - 1);

    const prefix = iconAc.type === 'icon' ? '{icon:' : (iconAc.type === 'bi' ? '{bi:' : '{mdi:');
    const lastTriggerIndex = textBefore.lastIndexOf(prefix);

    if (lastTriggerIndex !== -1) {
        editor.setSelection([line, lastTriggerIndex + 1], [line, col]);
        editor.insertText(`${prefix}${iconName}}`);
    }

    hideIconAutocomplete();
    editor.focus();
}

// ══════════════════════════════════════════════════
// ── 팔레트 인라인 자동완성 ──
// ══════════════════════════════════════════════════

// 하드코딩 프리셋 정의는 common.js의 WIKI_HARDCODED_PALETTES가 단일 소스.
// 에디터는 '기본/커스텀/오버라이드' 출처 구분이 필요하므로 common.js의 병합 헬퍼 대신
// 커스텀 맵과 하드코딩을 직접 합치면서 source 라벨을 부여한다.

const paletteAc = {
    visible: false,
    results: [],          // [{ name, source: 'preset'|'custom', variant: {bg,color} }]
    selectedIndex: -1,
    query: '',
    div: document.getElementById('palette-autocomplete'),
    // 배지 클릭으로 열린 경우에 설정: 치환할 정확한 문서 범위 {from, to}
    replaceRange: null,
};

function getAllPalettesForEditor() {
    const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const hardcoded = (typeof WIKI_HARDCODED_PALETTES !== 'undefined') ? WIKI_HARDCODED_PALETTES : {};
    const custom = (appConfig && appConfig.palettes && typeof appConfig.palettes === 'object') ? appConfig.palettes : {};
    const merged = {};
    // 하드코딩 먼저, 그 다음 커스텀이 덮어씌움 (충돌 시 커스텀 우선)
    for (const [name, entry] of Object.entries(hardcoded)) {
        merged[name] = { source: 'preset', entry };
    }
    for (const [name, entry] of Object.entries(custom)) {
        if (!entry || typeof entry !== 'object') continue;
        merged[name] = { source: merged[name] ? 'override' : 'custom', entry };
    }
    return Object.entries(merged).map(([name, info]) => {
        const variant = isDark ? (info.entry.dark || info.entry.light) : (info.entry.light || info.entry.dark);
        return { name, source: info.source, variant: variant || {} };
    });
}

function hidePaletteAutocomplete() {
    paletteAc.visible = false;
    paletteAc.results = [];
    paletteAc.selectedIndex = -1;
    paletteAc.replaceRange = null;
    if (paletteAc.div) paletteAc.div.style.display = 'none';
}

function showPaletteAutocomplete(query, opts) {
    const showAll = !!(opts && opts.showAll);
    paletteAc.query = showAll ? '' : (query || '').toLowerCase();
    paletteAc.visible = true;

    positionDropdownAtCursor(paletteAc.div, 280);

    const all = getAllPalettesForEditor();
    const q = paletteAc.query;
    let results;
    if (!q) {
        results = all;
    } else {
        const exact = all.filter(p => p.name.toLowerCase() === q);
        const starts = all.filter(p => p.name.toLowerCase() !== q && p.name.toLowerCase().startsWith(q));
        const includes = all.filter(p => !p.name.toLowerCase().startsWith(q) && p.name.toLowerCase().includes(q));
        results = [...exact, ...starts, ...includes];
    }
    paletteAc.results = results;
    paletteAc.selectedIndex = results.length > 0 ? 0 : -1;
    renderPaletteAcResults();
}

function renderPaletteAcResults() {
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
        const rawBg = p.variant.bg || 'transparent';
        const rawColor = p.variant.color || 'inherit';
        const bg = _isSafeCssColor(rawBg) ? rawBg : 'transparent';
        const color = _isSafeCssColor(rawColor) ? rawColor : 'inherit';
        const tag = p.source === 'preset' ? '기본' : p.source === 'override' ? '오버라이드' : '커스텀';

        const itemEl = document.createElement('div');
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
            const idx = parseInt(itemEl.dataset.index);
            selectPaletteAutocomplete(idx);
        });

        listEl.appendChild(itemEl);
    });
}

function highlightPaletteAcItem() {
    if (!paletteAc.div) return;
    const items = paletteAc.div.querySelectorAll('.palette-ac-item');
    items.forEach((item, idx) => {
        if (idx === paletteAc.selectedIndex) {
            item.classList.add('active');
            item.scrollIntoView({ block: 'nearest' });
        } else {
            item.classList.remove('active');
        }
    });
}

function selectPaletteAutocomplete(index) {
    const item = paletteAc.results[index];
    if (!item || !editor) return;

    // 배지 클릭으로 열린 경우: 저장된 정확한 범위만 치환하여 중괄호 중첩 방지
    if (paletteAc.replaceRange && window._cmView) {
        const view = window._cmView;
        const { from, to } = paletteAc.replaceRange;
        const insert = `{palette:${item.name}}`;
        const docLen = view.state.doc.length;
        const safeFrom = Math.max(0, Math.min(from, docLen));
        const safeTo = Math.max(safeFrom, Math.min(to, docLen));
        view.dispatch({
            changes: { from: safeFrom, to: safeTo, insert },
            selection: { anchor: safeFrom + insert.length }
        });
        hidePaletteAutocomplete();
        view.focus();
        return;
    }

    const selection = editor.getSelection();
    if (!selection) { hidePaletteAutocomplete(); return; }

    const [from] = selection;
    const line = from[0];
    const col = from[1];

    const md = editor.getMarkdown();
    const lines = md.split('\n');
    const lineText = lines[line - 1] || '';
    const textBefore = lineText.substring(0, col - 1);
    const prefix = '{palette:';
    const lastTriggerIndex = textBefore.lastIndexOf(prefix);

    if (lastTriggerIndex !== -1) {
        editor.setSelection([line, lastTriggerIndex + 1], [line, col]);
        editor.insertText(`${prefix}${item.name}}`);
    }

    hidePaletteAutocomplete();
    editor.focus();
}

function startAutoSave() {
    setInterval(() => {
        if (editor && slug && AUTO_SAVE_KEY) {
            const content = editor.getMarkdown();
            if (content && content.trim().length > 0) {
                localStorage.setItem(AUTO_SAVE_KEY, content);
            }
        }
    }, 10000); // 10초마다 자동 저장
}

// ── 카테고리 태그 UI 로직 ──
const categoryInputHidden = document.getElementById('categoryInput');
const categoryTagContainer = document.getElementById('categoryTagContainer');
const categoryTagInput = document.getElementById('categoryTagInput');
let categoryTags = [];

// ── 카테고리 자동완성 상태 ──
const categoryAc = {
    visible: false,
    results: [],
    selectedIndex: -1,
    query: '',
    lastQuery: null,
    debounceTimer: null,
    div: document.getElementById('category-autocomplete'),
};

function hideCategoryAutocomplete() {
    categoryAc.visible = false;
    categoryAc.results = [];
    categoryAc.selectedIndex = -1;
    categoryAc.lastQuery = null;
    if (categoryAc.div) categoryAc.div.style.display = 'none';
}

function showCategoryAutocomplete(query) {
    categoryAc.query = query;
    categoryAc.visible = true;

    if (categoryAc.div) {
        const rect = categoryTagContainer.getBoundingClientRect();
        categoryAc.div.style.left = rect.left + 'px';
        categoryAc.div.style.top = (rect.bottom + 2) + 'px';
        categoryAc.div.style.width = rect.width + 'px';
        categoryAc.div.style.display = 'block';
    }

    if (categoryAc.query === categoryAc.lastQuery) return;
    categoryAc.lastQuery = categoryAc.query;

    clearTimeout(categoryAc.debounceTimer);
    categoryAc.debounceTimer = setTimeout(async () => {
        if (!categoryAc.visible) return;
        try {
            const res = await fetch(`/api/w/search-categories?q=${encodeURIComponent(categoryAc.query)}`);
            if (!res.ok) return;
            const data = await res.json();
            categoryAc.results = data.results || [];
            renderCategoryAcResults();
        } catch (e) {
            console.error('Category autocomplete fetch error:', e);
        }
    }, 200);
}

function renderCategoryAcResults() {
    if (!categoryAc.div) return;
    if (categoryAc.results.length === 0) {
        hideCategoryAutocomplete();
        return;
    }
    categoryAc.div.innerHTML = categoryAc.results.map((item, index) => `
        <div class="list-group-item cat-ac-item" data-index="${index}" onmousedown="selectCategoryAcByIndex(${index})">
            <i class="mdi mdi-tag-outline"></i>
            <span>${escapeHtml(item)}</span>
        </div>
    `).join('');
    categoryAc.selectedIndex = -1;
    highlightCategoryAcItem();
}

function highlightCategoryAcItem() {
    if (!categoryAc.div) return;
    const items = categoryAc.div.querySelectorAll('.cat-ac-item');
    items.forEach((item, idx) => {
        if (idx === categoryAc.selectedIndex) {
            item.classList.add('active');
            item.scrollIntoView({ block: 'nearest' });
        } else {
            item.classList.remove('active');
        }
    });
}

function selectCategoryAc(index) {
    const item = categoryAc.results[index];
    if (!item) return;
    addCategoryTag(item);
    categoryTagInput.value = '';
    hideCategoryAutocomplete();
    categoryTagInput.focus();
}

window.selectCategoryAcByIndex = selectCategoryAc;

function renderCategoryTags() {
    // 기존 렌더링 된 태그 요소들만 삭제
    const tags = categoryTagContainer.querySelectorAll('.category-tag');
    tags.forEach(tag => tag.remove());

    categoryTags.forEach((tagText, index) => {
        const tagEl = document.createElement('span');
        tagEl.className = 'category-tag';
        tagEl.innerHTML = `<span>${escapeHtml(tagText)}</span> <i class="mdi mdi-close" onclick="removeCategoryTag(${index})"></i>`;
        categoryTagContainer.insertBefore(tagEl, categoryTagInput);
    });
    categoryInputHidden.value = categoryTags.join(',');
    // 이벤트 강제 트리거 (관리자 전용 체크 로직 동작을 위해)
    categoryInputHidden.dispatchEvent(new Event('input'));
}

function addCategoryTag(tag) {
    const cleanTag = tag.trim();
    if (cleanTag && !categoryTags.includes(cleanTag) && /^[가-힣a-zA-Z0-9\s_.-]+$/.test(cleanTag)) {
        categoryTags.push(cleanTag);
        renderCategoryTags();
    } else if (cleanTag && !/^[가-힣a-zA-Z0-9\s_.-]+$/.test(cleanTag)) {
        Swal.fire({
            icon: 'warning',
            title: '특수문자 제외',
            text: '특수문자를 제외한 카테고리 이름을 입력해 주세요.',
            toast: true,
            position: 'top-end',
            timer: 2000,
            showConfirmButton: false
        });
    }
}

window.removeCategoryTag = function (index) {
    categoryTags.splice(index, 1);
    renderCategoryTags();
};

if (categoryTagInput) {
    categoryTagInput.addEventListener('keydown', (e) => {
        // 한글 조합 중 엔터 등 처리 방지
        if (e.isComposing) return;

        // 자동완성 키 처리
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
            } else if (e.key === 'Enter' && categoryAc.selectedIndex >= 0) {
                e.preventDefault();
                selectCategoryAc(categoryAc.selectedIndex);
                return;
            }
        }

        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            if (categoryTagInput.value.trim()) {
                const tags = categoryTagInput.value.split(','); // 복붙 등에 의한 다중입력 대비
                tags.forEach(t => addCategoryTag(t));
                categoryTagInput.value = '';
                hideCategoryAutocomplete();
            }
        } else if (e.key === 'Backspace' && categoryTagInput.value === '') {
            if (categoryTags.length > 0) {
                categoryTags.pop();
                renderCategoryTags();
            }
        }
    });

    categoryTagInput.addEventListener('blur', () => {
        // 자동완성 항목 클릭(onmousedown) 처리 후 닫기
        setTimeout(() => {
            hideCategoryAutocomplete();
            if (categoryTagInput.value.trim()) {
                const tags = categoryTagInput.value.split(',');
                tags.forEach(t => addCategoryTag(t));
                categoryTagInput.value = '';
            }
        }, 150);
    });

    // 쉼표 입력시 블러나 다른 이벤트에서 쉼표가 방해될 수 있으므로 input 이벤트에서도 쉼표 감지
    categoryTagInput.addEventListener('input', (e) => {
        if (categoryTagInput.value.includes(',')) {
            const tags = categoryTagInput.value.split(',');
            const lastFragment = tags.pop(); // 아직 입력중인 텍스트
            tags.forEach(t => addCategoryTag(t));
            categoryTagInput.value = lastFragment;
            hideCategoryAutocomplete();
            return;
        }
        // 자동완성 표시
        showCategoryAutocomplete(categoryTagInput.value.trim());
    });
}


async function checkAutoSave() {
    if (!AUTO_SAVE_KEY) return;

    const savedContent = localStorage.getItem(AUTO_SAVE_KEY);
    if (savedContent) {
        // 로드된 내용과 동일하면 묻지 않고 삭제
        if (savedContent.trim() === currentContent.trim()) {
            localStorage.removeItem(AUTO_SAVE_KEY);
            return;
        }

        const result = await Swal.fire({
            title: '작성 중인 내용이 있습니다',
            text: '이전에 작성하던 내용을 불러오시겠습니까?',
            icon: 'info',
            showCancelButton: true,
            confirmButtonText: '예, 불러오기',
            cancelButtonText: '아니오, 삭제'
        });

        if (result.isConfirmed) {
            editor.setMarkdown(savedContent);
            scrollToBottom();
            Swal.fire({
                icon: 'success',
                title: '불러옴',
                text: '저장된 내용을 불러왔습니다.',
                timer: 1000,
                showConfirmButton: false
            });
        } else {
            localStorage.removeItem(AUTO_SAVE_KEY);
        }
    }
}

// ── 위키 자동완성 (Autocomplete) ──
const wikiAc = {
    visible: false,
    type: 'link',            // 'link' | 'template'
    results: [],
    selectedIndex: -1,
    query: '',
    lastQuery: null,
    debounceTimer: null,
    div: document.getElementById('wiki-autocomplete'),
};

function hideAutocomplete() {
    wikiAc.visible = false;
    wikiAc.results = [];
    wikiAc.selectedIndex = -1;
    wikiAc.lastQuery = null;
    if (wikiAc.div) wikiAc.div.style.display = 'none';
}

function showAutocomplete(query, type) {
    wikiAc.query = query;
    wikiAc.type = type;
    wikiAc.visible = true;

    // 커서 위치에 드롭다운 표시
    positionDropdownAtCursor(wikiAc.div, 250);

    if (wikiAc.query === wikiAc.lastQuery) return;
    wikiAc.lastQuery = wikiAc.query;

    clearTimeout(wikiAc.debounceTimer);
    wikiAc.debounceTimer = setTimeout(async () => {
        if (!wikiAc.visible) return;
        try {
            // 쿼리가 비어있어도 API 호출 (최신순 등 반환 가능)
            let acUrl = `/api/w/search-titles?q=${encodeURIComponent(wikiAc.query)}&type=${wikiAc.type}`;
            // 틀 자동완성에서 자기 자신 문서 제외
            if (wikiAc.type === 'template' && slug) {
                acUrl += `&exclude=${encodeURIComponent(slug)}`;
            }
            const res = await fetch(acUrl);
            if (!res.ok) return;
            const data = await res.json();
            wikiAc.results = data.results || [];
            renderAutocompleteResults();
        } catch (e) {
            console.error('Autocomplete fetch error:', e);
        }
    }, 300);
}

function renderAutocompleteResults() {
    if (!wikiAc.div) return;

    if (wikiAc.results.length === 0) {
        wikiAc.div.innerHTML = '<div class="list-group-item text-muted" style="font-size:0.85rem">결과 없음</div>';
        return;
    }

    wikiAc.div.innerHTML = wikiAc.results.map((item, index) => `
        <div class="list-group-item autocomplete-item" data-index="${index}" onclick="selectAutocomplete(${index})">
            <i class="mdi ${wikiAc.type === 'template' ? 'mdi-toy-brick-outline' : 'mdi-file-document-outline'}"></i>
            <span class="item-title">${escapeHtml(item.title)}</span>
            <span class="item-type">${wikiAc.type === 'template' ? '틀' : '문서'}</span>
        </div>
    `).join('');

    wikiAc.selectedIndex = 0;
    highlightAutocompleteItem();
}

function highlightAutocompleteItem() {
    const items = wikiAc.div.querySelectorAll('.autocomplete-item');
    items.forEach((item, idx) => {
        if (idx === wikiAc.selectedIndex) {
            item.classList.add('active');
            item.scrollIntoView({ block: 'nearest' });
        } else {
            item.classList.remove('active');
        }
    });
}

function selectAutocomplete(index) {
    const item = wikiAc.results[index];
    if (!item || !editor) return;

    const selection = editor.getSelection();
    if (!selection) { hideAutocomplete(); return; }

    const [from] = selection;
    const line = from[0];
    const col = from[1];

    const md = editor.getMarkdown();
    const lines = md.split('\n');
    const lineText = lines[line - 1] || '';
    const textBefore = lineText.substring(0, col - 1);

    const trigger = wikiAc.type === 'template' ? '{{' : '[[';
    const close = wikiAc.type === 'template' ? '}}' : ']]';
    const lastTriggerIndex = textBefore.lastIndexOf(trigger);

    if (lastTriggerIndex !== -1) {
        // [[query 부분을 선택 후 교체 (setMarkdown 전체 교체 방지)
        editor.setSelection([line, lastTriggerIndex + 1], [line, col]);
        editor.insertText(`${trigger}${item.title}${close}`);

        // 틀 선택 시 대상 틀이 파라미터({{{...}}})를 정의하고 있으면
        // 비동기로 스키마(`|name=|...`)를 끼워 넣고 커서를 첫 빈 칸에 둔다.
        if (wikiAc.type === 'template' && item.slug) {
            _autoInsertTemplateParamSchema(item.slug, line, lastTriggerIndex + 1, item.title);
        }
    }

    hideAutocomplete();
}

/**
 * 틀 본문에서 `{{{이름}}}` / `{{{1}}}` / `{{{이름|기본값}}}` 참조를 수집해
 * 위치 인자와 이름 인자 목록을 반환한다. 기본값 내부의 참조도 재귀 스캔한다.
 */
function _extractTemplateParamNames(content) {
    if (typeof _findParamRefs !== 'function') return { positional: [], named: [] };
    const seen = new Set();
    const positional = [];
    const named = [];
    // 위치 인자는 `_parseTemplateCall` 이 1부터 증가시키며 문자열 키를 그대로 쓰므로
    // `'1','2',...` 형태만 정준(positional) 이다. `0`, `01` 같은 앞자리 0 포함 숫자는
    // 어떤 호출에서도 위치 인자로 채워지지 않으므로 이름 인자로 취급해 `0=`/`01=` 스키마를 만든다.
    const POSITIONAL_RE = /^[1-9]\d*$/;
    function scan(text) {
        const refs = _findParamRefs(text);
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

/**
 * 자동완성에서 틀을 선택한 직후 호출. 틀 본문을 fetch 해서 파라미터가 있으면
 * `{{title|...|name=|...}}` 형태로 스키마를 삽입하고 커서를 첫 입력 칸에 둔다.
 * - 익스텐션(슬러그에 `:` 포함, `틀:` 접두가 아님) 은 자체 문법을 쓰므로 스킵.
 * - fetch 실패 / 파라미터 없음 / 삽입 위치가 이미 사용자가 수정된 경우 조용히 패스.
 */
async function _autoInsertTemplateParamSchema(slug, line, insertCol, title) {
    try {
        if (typeof _isExtensionCall === 'function' && _isExtensionCall(slug)) return;
    } catch (_) { /* noop */ }

    let data;
    try {
        const res = await fetch(`/api/w/${encodeURIComponent(slug)}`);
        if (!res.ok) return;
        data = await res.json();
    } catch (_) { return; }
    if (!data || typeof data.content !== 'string') return;

    const params = _extractTemplateParamNames(data.content);
    const tokens = [];
    // 위치 인자 참조 번호 집합 (정수 + 양수만).
    const positionalIndices = (Array.isArray(params.positional) ? params.positional : [])
        .map(p => Number(p))
        .filter(n => Number.isInteger(n) && n > 0);
    positionalIndices.sort((a, b) => a - b);
    const maxPositionalIndex = positionalIndices.length > 0
        ? positionalIndices[positionalIndices.length - 1] : 0;

    // 템플릿 본문은 위키 문서이므로 사용자가 `{{{5000}}}` 같은 큰 인덱스를 넣으면
    // 그만큼 빈 인자(`||||...`) 가 끼어 에디터가 멈출 수 있다. 최대 인덱스가 일정
    // 임계값을 넘거나 희소할 가능성이 있을 때는 참조된 번호만 `N=` 이름 인자 형태로
    // 주입해 삽입 크기를 실제 참조 수에 비례하도록 제한한다.
    const POSITIONAL_BLANK_CAP = 9;
    if (maxPositionalIndex > 0 && maxPositionalIndex <= POSITIONAL_BLANK_CAP) {
        for (let i = 0; i < maxPositionalIndex; i++) tokens.push('');
    } else {
        for (const n of positionalIndices) tokens.push(`${n}=`);
    }
    for (const n of params.named) tokens.push(`${n}=`);
    if (tokens.length === 0) return;

    if (!editor) return;
    const currentMd = editor.getMarkdown();
    const currentLines = currentMd.split('\n');
    const currentLine = currentLines[line - 1];
    if (typeof currentLine !== 'string') return;

    // 방금 삽입한 `{{title}}` 이 여전히 예상 위치에 있는지 확인 (유저가 그 사이 다른 편집을 했을 수 있음).
    const expected = `{{${title}}}`;
    const openAt = insertCol - 1; // 0-based
    if (currentLine.substring(openAt, openAt + expected.length) !== expected) return;

    // 네트워크 대기 중 사용자가 다른 위치로 캐럿을 옮겼다면 강제로 포커스를 빼앗지 않는다.
    // 동기 삽입 직후 캐럿은 `}}` 바로 뒤 (insertCol + 4 + title.length) 에 있어야 한다.
    const expectedCaret = insertCol + 4 + title.length;
    const caretSel = editor.getSelection();
    if (!caretSel) return;
    const [cFrom, cTo] = caretSel;
    if (cFrom[0] !== line || cTo[0] !== line ||
        cFrom[1] !== expectedCaret || cTo[1] !== expectedCaret) {
        return;
    }

    const schema = '|' + tokens.join('|');
    const insertAt = insertCol + 2 + title.length; // `}}` 바로 앞 1-based col
    editor.setSelection([line, insertAt], [line, insertAt]);
    editor.insertText(schema);

    // 첫 토큰(prefix) 끝에 커서 배치
    const cursorCol = insertAt + 1 + tokens[0].length;
    editor.setSelection([line, cursorCol], [line, cursorCol]);
}

// ── 자동완성 통합 키보드 네비게이션 (단일 Capturing 핸들러) ──
window.addEventListener('keydown', (e) => {
    // 한글 IME 등에서 Process 키가 들어올 때 무시
    if (e.key === 'Process') return;

    // 현재 활성 자동완성 타입 판별
    const activeAc = wikiAc.visible ? 'wiki'
        : iconAc.visible ? 'icon'
            : colorAc.visible ? 'color'
                : imgSizeAc.visible ? 'imgsize'
                    : timestampAc.visible ? 'timestamp'
                        : paletteAc.visible ? 'palette'
                            : null;
    if (!activeAc) return;

    const key = e.key;
    const isDown = key === 'ArrowDown' || e.keyCode === 40;
    const isUp = key === 'ArrowUp' || e.keyCode === 38;
    const isRight = key === 'ArrowRight' || e.keyCode === 39;
    const isLeft = key === 'ArrowLeft' || e.keyCode === 37;
    const isEnter = key === 'Enter' || e.keyCode === 13;
    const isEsc = key === 'Escape' || e.keyCode === 27;

    if (activeAc === 'wiki') {
        if (isDown) {
            if (wikiAc.results.length > 0) {
                e.preventDefault(); e.stopPropagation();
                wikiAc.selectedIndex = (wikiAc.selectedIndex + 1) % wikiAc.results.length;
                highlightAutocompleteItem();
            } else { hideAutocomplete(); }
        } else if (isUp) {
            if (wikiAc.results.length > 0) {
                e.preventDefault(); e.stopPropagation();
                wikiAc.selectedIndex = (wikiAc.selectedIndex - 1 + wikiAc.results.length) % wikiAc.results.length;
                highlightAutocompleteItem();
            } else { hideAutocomplete(); }
        } else if (isLeft || isRight) {
            hideAutocomplete();
        } else if (isEnter) {
            if (wikiAc.results.length > 0 && wikiAc.selectedIndex >= 0) {
                e.preventDefault(); e.stopPropagation();
                selectAutocomplete(wikiAc.selectedIndex);
            } else { hideAutocomplete(); }
        } else if (isEsc) {
            e.preventDefault(); e.stopPropagation();
            hideAutocomplete();
        }
    } else if (activeAc === 'icon') {
        if (isDown) {
            if (iconAc.results.length > 0) {
                e.preventDefault(); e.stopPropagation();
                iconAc.selectedIndex = Math.min(iconAc.selectedIndex + iconAc.COLS, iconAc.results.length - 1);
                highlightIconAcItem();
            } else { hideIconAutocomplete(); }
        } else if (isUp) {
            if (iconAc.results.length > 0) {
                e.preventDefault(); e.stopPropagation();
                iconAc.selectedIndex = Math.max(iconAc.selectedIndex - iconAc.COLS, 0);
                highlightIconAcItem();
            } else { hideIconAutocomplete(); }
        } else if (isRight) {
            if (iconAc.results.length > 0) {
                e.preventDefault(); e.stopPropagation();
                iconAc.selectedIndex = (iconAc.selectedIndex + 1) % iconAc.results.length;
                highlightIconAcItem();
            }
        } else if (isLeft) {
            if (iconAc.results.length > 0) {
                e.preventDefault(); e.stopPropagation();
                iconAc.selectedIndex = (iconAc.selectedIndex - 1 + iconAc.results.length) % iconAc.results.length;
                highlightIconAcItem();
            }
        } else if (isEnter) {
            if (iconAc.results.length > 0 && iconAc.selectedIndex >= 0) {
                e.preventDefault(); e.stopPropagation();
                selectIconAutocomplete(iconAc.selectedIndex);
            } else { hideIconAutocomplete(); }
        } else if (isEsc) {
            e.preventDefault(); e.stopPropagation();
            hideIconAutocomplete();
        }
    } else if (activeAc === 'imgsize') {
        if (isDown) {
            e.preventDefault(); e.stopPropagation();
            imgSizeAc.selectedIndex = (imgSizeAc.selectedIndex + 1) % imgSizeAc.options.length;
            highlightImgSizeAcItem();
        } else if (isUp) {
            e.preventDefault(); e.stopPropagation();
            imgSizeAc.selectedIndex = (imgSizeAc.selectedIndex - 1 + imgSizeAc.options.length) % imgSizeAc.options.length;
            highlightImgSizeAcItem();
        } else if (isLeft || isRight) {
            hideImgSizeAutocomplete();
        } else if (isEnter) {
            if (imgSizeAc.selectedIndex >= 0) {
                e.preventDefault(); e.stopPropagation();
                selectImgSizeAutocomplete(imgSizeAc.selectedIndex);
            } else { hideImgSizeAutocomplete(); }
        } else if (isEsc) {
            e.preventDefault(); e.stopPropagation();
            hideImgSizeAutocomplete();
        }
    } else if (activeAc === 'color') {
        const swatchCount = COLOR_SWATCHES.length;
        const SWATCH_COLS = 10;

        if (isRight) {
            if (swatchCount > 0) {
                e.preventDefault(); e.stopPropagation();
                colorAc.selectedSwatchIndex = (colorAc.selectedSwatchIndex + 1) % swatchCount;
                selectColorSwatch(colorAc.selectedSwatchIndex);
            }
        } else if (isLeft) {
            if (swatchCount > 0) {
                e.preventDefault(); e.stopPropagation();
                colorAc.selectedSwatchIndex = (colorAc.selectedSwatchIndex - 1 + swatchCount) % swatchCount;
                selectColorSwatch(colorAc.selectedSwatchIndex);
            }
        } else if (isDown) {
            if (swatchCount > 0) {
                e.preventDefault(); e.stopPropagation();
                colorAc.selectedSwatchIndex = Math.min(colorAc.selectedSwatchIndex + SWATCH_COLS, swatchCount - 1);
                selectColorSwatch(colorAc.selectedSwatchIndex);
            }
        } else if (isUp) {
            if (swatchCount > 0) {
                e.preventDefault(); e.stopPropagation();
                colorAc.selectedSwatchIndex = Math.max(colorAc.selectedSwatchIndex - SWATCH_COLS, 0);
                selectColorSwatch(colorAc.selectedSwatchIndex);
            }
        } else if (isEnter) {
            e.preventDefault(); e.stopPropagation();
            applyColorAutocomplete();
        } else if (isEsc) {
            e.preventDefault(); e.stopPropagation();
            hideColorAutocomplete();
        }
    } else if (activeAc === 'timestamp') {
        if (isEsc) {
            e.preventDefault(); e.stopPropagation();
            hideTimestampAutocomplete();
            if (editor) editor.focus();
        } else if (isEnter) {
            e.preventDefault(); e.stopPropagation();
            applyTimestampAutocomplete();
        }
    } else if (activeAc === 'palette') {
        if (isDown) {
            if (paletteAc.results.length > 0) {
                e.preventDefault(); e.stopPropagation();
                paletteAc.selectedIndex = (paletteAc.selectedIndex + 1) % paletteAc.results.length;
                highlightPaletteAcItem();
            } else { hidePaletteAutocomplete(); }
        } else if (isUp) {
            if (paletteAc.results.length > 0) {
                e.preventDefault(); e.stopPropagation();
                paletteAc.selectedIndex = (paletteAc.selectedIndex - 1 + paletteAc.results.length) % paletteAc.results.length;
                highlightPaletteAcItem();
            } else { hidePaletteAutocomplete(); }
        } else if (isLeft || isRight) {
            hidePaletteAutocomplete();
        } else if (isEnter) {
            if (paletteAc.results.length > 0 && paletteAc.selectedIndex >= 0) {
                e.preventDefault(); e.stopPropagation();
                selectPaletteAutocomplete(paletteAc.selectedIndex);
            } else { hidePaletteAutocomplete(); }
        } else if (isEsc) {
            e.preventDefault(); e.stopPropagation();
            hidePaletteAutocomplete();
        }
    }
}, true);

// 전역 클릭 시 자동완성 닫기
document.addEventListener('mousedown', (e) => {
    if (wikiAc.div && !wikiAc.div.contains(e.target)) {
        setTimeout(hideAutocomplete, 100);
    }
    if (iconAc.div && !iconAc.div.contains(e.target)) {
        setTimeout(hideIconAutocomplete, 100);
    }
    if (colorAc.div && !colorAc.div.contains(e.target)) {
        setTimeout(hideColorAutocomplete, 100);
    }
    if (imgSizeAc.div && !imgSizeAc.div.contains(e.target)) {
        setTimeout(hideImgSizeAutocomplete, 100);
    }
    if (timestampAc.div && !timestampAc.div.contains(e.target)) {
        setTimeout(hideTimestampAutocomplete, 100);
    }
    if (paletteAc.div && !paletteAc.div.contains(e.target)) {
        setTimeout(hidePaletteAutocomplete, 100);
    }
});

// 에디터 변경 감지 및 트리거 실행
function attachAutocomplete() {
    if (!editor) {
        setTimeout(attachAutocomplete, 100);
        return;
    }

    editor.on('change', () => {
        // change 이벤트 직후 selection이 확정되도록 한 프레임 뒤에 처리
        requestAnimationFrame(() => {
            const selection = editor.getSelection();
            if (!selection) { hideAutocomplete(); return; }

            // 커서(드래그 없음)인지 확인
            const [from, to] = selection;
            if (from[0] !== to[0] || from[1] !== to[1]) {
                hideAutocomplete();
                return;
            }

            const md = editor.getMarkdown();
            const lines = md.split('\n');
            const lineText = lines[from[0] - 1] || '';
            const textBefore = lineText.substring(0, from[1] - 1);

            const linkMatch = textBefore.match(/\[\[([^\]\[|#]*)$/);
            // | 이후(파라미터 영역) 에서는 자동완성을 띄우지 않도록 | 도 제외.
            // 또한 세 번째 `{` 를 입력해 `{{{` (파라미터 참조 문법) 로 넘어가면
            // 틀 검색을 중단한다 — 선행 `{` 를 네거티브 룩비하인드로 차단.
            const templateMatch = textBefore.match(/(?<!\{)\{\{([^\}\{|]*)$/);
            const biIconMatch = textBefore.match(/\{bi:([^}]*)$/);
            const mdiIconMatch = textBefore.match(/\{mdi:([^}]*)$/);
            const iconMatch = textBefore.match(/\{icon:([^}]*)$/);
            const bgColorMatch = textBefore.match(/\{bg:([^}]*)$/);
            const textColorMatch = textBefore.match(/\{color:([^}]*)$/);
            const paletteMatch = textBefore.match(/\{palette:([^}]*)$/);
            const imgMatch = textBefore.match(/!\[[^\]]*\]\([^)]+\)$/);
            const ddayMatch = textBefore.match(/\{dday:([^}]*)$/);
            const timeMatch = textBefore.match(/\{time:([^}]*)$/);
            const timerMatch = textBefore.match(/\{timer:([^}]*)$/);
            const ageMatch = textBefore.match(/\{age:([^}]*)$/);
            const calendarMatch = textBefore.match(/\{calendar:([^}]*)$/);

            if (linkMatch) {
                hideIconAutocomplete();
                hideColorAutocomplete();
                hideTimestampAutocomplete();
                showAutocomplete(linkMatch[1], 'link');
            } else if (templateMatch) {
                hideIconAutocomplete();
                hideColorAutocomplete();
                hideTimestampAutocomplete();
                showAutocomplete(templateMatch[1], 'template');
            } else if (iconMatch) {
                hideAutocomplete();
                hideColorAutocomplete();
                hideTimestampAutocomplete();
                showIconAutocomplete(iconMatch[1], 'icon');
            } else if (biIconMatch) {
                hideAutocomplete();
                hideColorAutocomplete();
                hideTimestampAutocomplete();
                showIconAutocomplete(biIconMatch[1], 'bi');
            } else if (mdiIconMatch) {
                hideAutocomplete();
                hideColorAutocomplete();
                hideTimestampAutocomplete();
                showIconAutocomplete(mdiIconMatch[1], 'mdi');
            } else if (bgColorMatch) {
                hideAutocomplete();
                hideIconAutocomplete();
                hideTimestampAutocomplete();
                hidePaletteAutocomplete();
                showColorAutocomplete(bgColorMatch[1], 'bg');
            } else if (textColorMatch) {
                hideAutocomplete();
                hideIconAutocomplete();
                hideTimestampAutocomplete();
                hidePaletteAutocomplete();
                showColorAutocomplete(textColorMatch[1], 'color');
            } else if (paletteMatch) {
                hideAutocomplete();
                hideIconAutocomplete();
                hideColorAutocomplete();
                hideTimestampAutocomplete();
                hideImgSizeAutocomplete();
                showPaletteAutocomplete(paletteMatch[1]);
            } else if (calendarMatch) {
                hideAutocomplete();
                hideIconAutocomplete();
                hideColorAutocomplete();
                showTimestampAutocomplete('calendar');
            } else if (ageMatch) {
                hideAutocomplete();
                hideIconAutocomplete();
                hideColorAutocomplete();
                showTimestampAutocomplete('age');
            } else if (ddayMatch) {
                hideAutocomplete();
                hideIconAutocomplete();
                hideColorAutocomplete();
                showTimestampAutocomplete('dday');
            } else if (timerMatch) {
                hideAutocomplete();
                hideIconAutocomplete();
                hideColorAutocomplete();
                showTimestampAutocomplete('timer');
            } else if (timeMatch) {
                hideAutocomplete();
                hideIconAutocomplete();
                hideColorAutocomplete();
                showTimestampAutocomplete('time');
            } else if (imgMatch) {
                // 이미지 마크다운 `)` 입력 직후 트리거
                hideAutocomplete();
                hideIconAutocomplete();
                hideColorAutocomplete();
                hideTimestampAutocomplete();
                showImgSizeAutocomplete();
            } else {
                hideAutocomplete();
                hideIconAutocomplete();
                hideColorAutocomplete();
                hideImgSizeAutocomplete();
                hideTimestampAutocomplete();
                hidePaletteAutocomplete();
            }
        });
    });

    // 포커스 잃으면 닫기
    editor.on('blur', () => {
        setTimeout(() => {
            if (!document.activeElement.closest('#wiki-autocomplete')) {
                hideAutocomplete();
            }
            if (!document.activeElement.closest('#icon-autocomplete')) {
                hideIconAutocomplete();
            }
            if (!document.activeElement.closest('#color-autocomplete')) {
                hideColorAutocomplete();
            }
            if (!document.activeElement.closest('#imgsize-autocomplete')) {
                hideImgSizeAutocomplete();
            }
            if (!document.activeElement.closest('#timestamp-autocomplete')) {
                hideTimestampAutocomplete();
            }
            if (!document.activeElement.closest('#palette-autocomplete')) {
                hidePaletteAutocomplete();
            }
        }, 200);
    });
}

// 에디터 초기화 대기 후 연결
setTimeout(attachAutocomplete, 500);

// 에디터 영역 드래그앤드롭 비활성화 (팝업 드롭존에서만 허용)
(function disableEditorDragDrop() {
    function setup() {
        const editorEl = document.querySelector('#editor');
        if (!editorEl) return setTimeout(setup, 300);
        const wrap = editorEl;
        wrap.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; });
        wrap.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); });
    }
    setTimeout(setup, 600);
})();

// ══════════════════════════════════════════════════