/**
 * 관리자 콘솔 컬러 팔레트 관리 모듈.
 *
 * 백엔드:
 *   GET    /api/admin/palettes              → { palettes: PaletteRow[] } (NULL 보존 raw row)
 *   POST   /api/admin/palettes              → body { name, light_bg, light_color, dark_bg, dark_color }
 *                                              각 채널은 string | null. null 은 NULL 로 저장되며
 *                                              sibling 폴백 없음 (sparse 보존).
 *   DELETE /api/admin/palettes/:name        → { success: true }
 *
 * 하드코딩 프리셋 7종은 예약어로 거부된다 (백엔드 검증).
 *
 * UI 는 에디터 모달의 "색상 삽입 > 커스텀 색상" 과 동일한 형태를 따른다:
 * 채널별로 프리셋 스와치 그리드 + Saturation/Brightness 캔버스 + Hue 슬라이더 +
 * Hex 입력. 글씨색 채널은 "자동 대비" 토글로 WCAG 대비 색상을 자동 적용.
 */

import { escapeHtml } from '../utils/html';

declare const Swal: any;

interface PaletteRow {
    name: string;
    light_bg: string | null;
    light_color: string | null;
    dark_bg: string | null;
    dark_color: string | null;
}

declare global {
    interface Window {
        loadPaletteList?: () => Promise<void>;
    }
}

const PALETTE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED = new Set([
    'primary', 'secondary', 'success', 'info', 'warning', 'danger', 'muted',
]);

type ChannelKey = 'light.bg' | 'light.color' | 'dark.bg' | 'dark.color';

const ALL_CHANNELS: ChannelKey[] = ['light.bg', 'light.color', 'dark.bg', 'dark.color'];

const CHANNEL_TO_RAW_KEY: Record<ChannelKey, keyof PaletteRow> = {
    'light.bg': 'light_bg',
    'light.color': 'light_color',
    'dark.bg': 'dark_bg',
    'dark.color': 'dark_color',
};

/** 채널별 DOM id prefix. {prefix}Canvas / {prefix}Hue / {prefix}Hex / {prefix}Swatches */
const CHANNEL_ID_PREFIX: Record<ChannelKey, string> = {
    'light.bg': 'paletteLightBg',
    'light.color': 'paletteLightColor',
    'dark.bg': 'paletteDarkBg',
    'dark.color': 'paletteDarkColor',
};

interface ColorState {
    hue: number;
    saturation: number;
    brightness: number;
    hex: string;
    dragging: 'palette' | 'hue' | null;
}

const SWATCHES = [
    '#000000', '#FFFFFF', '#FF0000', '#FF8000', '#FFFF00',
    '#00FF00', '#00FFFF', '#0080FF', '#0000FF', '#8000FF',
    '#FF00FF', '#FF0080', '#808080', '#C0C0C0',
];

let editingName: string | null = null;
let editingRow: PaletteRow | null = null;
let cache: Record<string, PaletteRow> = {};

/**
 * 폼 로드 이후 사용자가 명시적으로 변경/생성한 채널. 미터치 채널은 저장 시
 * editingRow 의 raw 값을 그대로 사용해 NULL/콘크리트 상태를 보존한다.
 */
const touchedChannels = new Set<ChannelKey>();

const colorStates: Record<ChannelKey, ColorState> = {
    'light.bg': { hue: 0, saturation: 0, brightness: 0, hex: '#000000', dragging: null },
    'light.color': { hue: 0, saturation: 0, brightness: 1, hex: '#FFFFFF', dragging: null },
    'dark.bg': { hue: 0, saturation: 0, brightness: 0, hex: '#000000', dragging: null },
    'dark.color': { hue: 0, saturation: 0, brightness: 1, hex: '#FFFFFF', dragging: null },
};

function markTouched(key: ChannelKey) {
    touchedChannels.add(key);
}

function $(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function $input(id: string): HTMLInputElement | null {
    return document.getElementById(id) as HTMLInputElement | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 색상 유틸 (edit/utils.ts 의 hsvToHex/hexToHsv 와 동일 알고리즘)
// ─────────────────────────────────────────────────────────────────────────────

function hsvToHex(h: number, s: number, v: number): string {
    let r = 0, g = 0, b = 0;
    const i = Math.floor(h / 60) % 6;
    const f = h / 60 - Math.floor(h / 60);
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    switch (i) {
        case 0: r = v; g = t; b = p; break;
        case 1: r = q; g = v; b = p; break;
        case 2: r = p; g = v; b = t; break;
        case 3: r = p; g = q; b = v; break;
        case 4: r = t; g = p; b = v; break;
        case 5: r = v; g = p; b = q; break;
    }
    const toHex = (c: number) => {
        const x = Math.round(c * 255).toString(16);
        return x.length === 1 ? '0' + x : x;
    };
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

function hexToHsv(hex: string): { h: number; s: number; v: number } {
    const cleaned = hex.replace('#', '');
    const r = parseInt(cleaned.substring(0, 2), 16) / 255;
    const g = parseInt(cleaned.substring(2, 4), 16) / 255;
    const b = parseInt(cleaned.substring(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    const s = max === 0 ? 0 : d / max;
    const v = max;
    if (d !== 0) {
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) * 60; break;
            case g: h = ((b - r) / d + 2) * 60; break;
            case b: h = ((r - g) / d + 4) * 60; break;
        }
    }
    return { h, s, v };
}

/** 짧은 #RGB → #RRGGBB 로 정규화하고 대문자화. 유효성 검증 동반. */
function normalizeHex(raw: string): string | null {
    const trimmed = raw.trim();
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed);
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return '#' + h.toUpperCase();
}

/** 배경 휘도(WCAG relative luminance)에 따라 #000 또는 #FFF 반환. */
function wcagContrastHex(hex: string): string {
    const h = hex.replace('#', '');
    if (h.length !== 6) return '#FFFFFF';
    const toLinear = (c: number) => {
        c = c / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const r = toLinear(parseInt(h.substring(0, 2), 16));
    const g = toLinear(parseInt(h.substring(2, 4), 16));
    const b = toLinear(parseInt(h.substring(4, 6), 16));
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return L > 0.179 ? '#000000' : '#FFFFFF';
}

// ─────────────────────────────────────────────────────────────────────────────
// 캔버스 렌더링
// ─────────────────────────────────────────────────────────────────────────────

function drawSV(canvasId: string, state: ColorState) {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Sync internal resolution to CSS display size to prevent stretching distortion.
    const dw = canvas.offsetWidth;
    const dh = canvas.offsetHeight;
    if (dw > 0) canvas.width = dw;
    if (dh > 0) canvas.height = dh;
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
    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, Math.PI * 2);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.stroke();
}

function drawHue(canvasId: string, state: ColorState) {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Sync internal resolution to CSS display size to prevent stretching distortion.
    const dw = canvas.offsetWidth;
    const dh = canvas.offsetHeight;
    if (dw > 0) canvas.width = dw;
    if (dh > 0) canvas.height = dh;
    const w = canvas.width, h = canvas.height;
    const gradient = ctx.createLinearGradient(0, 0, w, 0);
    for (let i = 0; i <= 6; i++) gradient.addColorStop(i / 6, hsvToHex(i * 60, 1, 1));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    const cx = (state.hue / 360) * w;
    ctx.beginPath();
    ctx.rect(cx - 5, 0, 10, h);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.rect(cx - 6, -1, 12, h + 2);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.stroke();
}

// ─────────────────────────────────────────────────────────────────────────────
// 채널 색상 get/set
// ─────────────────────────────────────────────────────────────────────────────

function renderChannel(key: ChannelKey) {
    const state = colorStates[key];
    state.hex = hsvToHex(state.hue, state.saturation, state.brightness);
    const prefix = CHANNEL_ID_PREFIX[key];
    drawSV(`${prefix}Canvas`, state);
    drawHue(`${prefix}Hue`, state);
    const hexInput = $input(`${prefix}Hex`);
    if (hexInput) {
        hexInput.value = state.hex;
        hexInput.classList.remove('is-invalid');
    }
}

function setChannelColor(key: ChannelKey, hexRaw: string) {
    const hex = normalizeHex(hexRaw) ?? '#000000';
    const hsv = hexToHsv(hex);
    const state = colorStates[key];
    state.hue = hsv.h;
    state.saturation = hsv.s;
    state.brightness = hsv.v;
    renderChannel(key);
}

function getChannelHex(key: ChannelKey): string {
    return colorStates[key].hex;
}

// ─────────────────────────────────────────────────────────────────────────────
// 자동 대비 / 미리보기
// ─────────────────────────────────────────────────────────────────────────────

function isAutoContrast(side: 'light' | 'dark'): boolean {
    const id = side === 'light' ? 'paletteLightAuto' : 'paletteDarkAuto';
    return $input(id)?.checked ?? false;
}

function applyAutoContrast(side: 'light' | 'dark') {
    const bgKey: ChannelKey = side === 'light' ? 'light.bg' : 'dark.bg';
    const fgKey: ChannelKey = side === 'light' ? 'light.color' : 'dark.color';
    const contrast = wcagContrastHex(getChannelHex(bgKey));
    setChannelColor(fgKey, contrast);
}

function setColorBlockDisabled(channel: ChannelKey, disabled: boolean) {
    const prefix = CHANNEL_ID_PREFIX[channel];
    const block = document.querySelector<HTMLElement>(`.palette-color-block[data-channel="${channel}"]`);
    if (block) block.classList.toggle('is-disabled', disabled);
    const hex = $input(`${prefix}Hex`);
    if (hex) hex.disabled = disabled;
}

function updatePreview() {
    const name = $input('paletteNameInput')?.value.trim() || 'Preview';
    const hasDark = $input('paletteHasDark')?.checked ?? false;

    const lightBadge = $('paletteLightPreview');
    const darkBadge = $('paletteDarkPreview');

    if (lightBadge) {
        lightBadge.style.background = getChannelHex('light.bg');
        lightBadge.style.color = getChannelHex('light.color');
        lightBadge.textContent = name;
    }
    if (darkBadge) {
        if (hasDark) {
            darkBadge.style.display = '';
            darkBadge.style.background = getChannelHex('dark.bg');
            darkBadge.style.color = getChannelHex('dark.color');
            darkBadge.textContent = name;
        } else {
            darkBadge.style.display = 'none';
        }
    }
}

function syncAutoState(side: 'light' | 'dark') {
    const fgKey: ChannelKey = side === 'light' ? 'light.color' : 'dark.color';
    const auto = isAutoContrast(side);
    setColorBlockDisabled(fgKey, auto);
    if (auto) applyAutoContrast(side);
}

function syncDarkRow() {
    const hasDark = $input('paletteHasDark')?.checked ?? false;
    const row = $('paletteDarkRow');
    if (row) row.style.display = hasDark ? '' : 'none';

    if (hasDark) {
        // 다크 행을 처음 켤 때 라이트 값으로 시드 (편집 모드가 아닐 때만).
        const darkBgHex = $input('paletteDarkBgHex');
        if (darkBgHex && !darkBgHex.dataset.seeded) {
            setChannelColor('dark.bg', getChannelHex('light.bg'));
            setChannelColor('dark.color', getChannelHex('light.color'));
            darkBgHex.dataset.seeded = '1';
        }
        syncAutoState('dark');
    }
    updatePreview();
}

// ─────────────────────────────────────────────────────────────────────────────
// 이름 유효성 / 폼 상태
// ─────────────────────────────────────────────────────────────────────────────

function setNameError(msg: string | null) {
    const el = $('paletteNameError');
    const input = $input('paletteNameInput');
    if (el) {
        el.textContent = msg ?? '';
        el.style.display = msg ? '' : 'none';
    }
    if (input) input.classList.toggle('is-invalid', !!msg);
}

function validateName(raw: string): string | null {
    const name = raw.trim();
    if (!name) return '이름을 입력해주세요.';
    if (!PALETTE_NAME_RE.test(name))
        return '영문/숫자/언더스코어/하이픈 1~64자만 사용할 수 있습니다.';
    if (RESERVED.has(name.toLowerCase()))
        return '하드코딩 프리셋 이름과 겹칠 수 없습니다.';
    return null;
}

function hasInvalidHexInput(): boolean {
    const hasDark = $input('paletteHasDark')?.checked ?? false;
    const keys: ChannelKey[] = hasDark
        ? ['light.bg', 'light.color', 'dark.bg', 'dark.color']
        : ['light.bg', 'light.color'];
    for (const k of keys) {
        const el = $input(`${CHANNEL_ID_PREFIX[k]}Hex`);
        if (!el || el.disabled) continue;
        if (el.classList.contains('is-invalid')) return true;
        if (el.value && !normalizeHex(el.value)) return true;
    }
    return false;
}

function resetForm() {
    editingName = null;
    editingRow = null;
    touchedChannels.clear();

    const title = $('paletteFormTitle');
    if (title) title.textContent = '새 팔레트 추가';

    const nameInput = $input('paletteNameInput');
    if (nameInput) {
        nameInput.value = '';
        nameInput.disabled = false;
        nameInput.classList.remove('is-invalid');
    }
    setNameError(null);

    setChannelColor('light.bg', '#0D65F5');
    setChannelColor('light.color', '#FFFFFF');
    setChannelColor('dark.bg', '#0D65F5');
    setChannelColor('dark.color', '#FFFFFF');

    const lightAuto = $input('paletteLightAuto');
    const darkAuto = $input('paletteDarkAuto');
    if (lightAuto) lightAuto.checked = true;
    if (darkAuto) darkAuto.checked = true;

    const hasDark = $input('paletteHasDark');
    if (hasDark) hasDark.checked = false;

    const darkBgHex = $input('paletteDarkBgHex');
    if (darkBgHex) delete darkBgHex.dataset.seeded;

    const resetBtn = $('paletteFormReset');
    if (resetBtn) resetBtn.style.display = 'none';

    const submitBtn = $('paletteFormSubmit');
    if (submitBtn) submitBtn.textContent = '저장';

    syncAutoState('light');
    syncDarkRow();
}

function loadIntoForm(row: PaletteRow) {
    const name = row.name;
    editingName = name;
    editingRow = row;

    const title = $('paletteFormTitle');
    if (title) title.textContent = `팔레트 편집: ${name}`;

    const nameInput = $input('paletteNameInput');
    if (nameInput) {
        nameInput.value = name;
        nameInput.disabled = true; // PK 변경 불가
        nameInput.classList.remove('is-invalid');
    }
    setNameError(null);

    touchedChannels.clear();

    // 화면 표시용 폴백: 정의된 값 > sibling 변형의 같은 채널 > 기본값.
    const displayLightBg = row.light_bg ?? row.dark_bg ?? '#0D65F5';
    const displayLightFg = row.light_color ?? row.dark_color ?? '#FFFFFF';
    const displayDarkBg = row.dark_bg ?? row.light_bg ?? displayLightBg;
    const displayDarkFg = row.dark_color ?? row.light_color ?? displayLightFg;

    setChannelColor('light.bg', displayLightBg);
    setChannelColor('light.color', displayLightFg);
    setChannelColor('dark.bg', displayDarkBg);
    setChannelColor('dark.color', displayDarkFg);

    // 편집 모드에서는 자동 대비 끔 (사용자가 명시 설정한 값 보존).
    const lightAuto = $input('paletteLightAuto');
    const darkAuto = $input('paletteDarkAuto');
    if (lightAuto) lightAuto.checked = false;
    if (darkAuto) darkAuto.checked = false;

    // 다크 분리 토글: raw 가 명시적으로 다를 때만 ON.
    const darkBgDiffers = row.dark_bg !== null && row.dark_bg !== row.light_bg;
    const darkFgDiffers = row.dark_color !== null && row.dark_color !== row.light_color;
    const hasDark = $input('paletteHasDark');
    if (hasDark) hasDark.checked = darkBgDiffers || darkFgDiffers;

    const darkBgHex = $input('paletteDarkBgHex');
    if (darkBgHex) darkBgHex.dataset.seeded = '1';

    const resetBtn = $('paletteFormReset');
    if (resetBtn) resetBtn.style.display = '';

    const submitBtn = $('paletteFormSubmit');
    if (submitBtn) submitBtn.textContent = '수정';

    syncAutoState('light');
    syncDarkRow();

    $('paletteForm')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ─────────────────────────────────────────────────────────────────────────────
// 목록 렌더 / API
// ─────────────────────────────────────────────────────────────────────────────

function renderList() {
    const container = $('paletteList');
    if (!container) return;
    const names = Object.keys(cache).sort();
    if (names.length === 0) {
        container.innerHTML =
            '<div class="p-3 text-center text-muted small">등록된 커스텀 팔레트가 없습니다.</div>';
        return;
    }
    container.innerHTML = names
        .map((name) => {
            const row = cache[name];
            const lightBgRaw = row.light_bg ?? row.dark_bg ?? '#000000';
            const lightFgRaw = row.light_color ?? row.dark_color ?? '#FFFFFF';
            const darkBgRaw = row.dark_bg ?? row.light_bg ?? lightBgRaw;
            const darkFgRaw = row.dark_color ?? row.light_color ?? lightFgRaw;
            const darkExplicit =
                (row.dark_bg !== null && row.dark_bg !== row.light_bg) ||
                (row.dark_color !== null && row.dark_color !== row.light_color);
            const fmt = (v: string | null, fallback: string) =>
                v === null ? `(미지정 → ${fallback})` : v;
            return `
              <div class="palette-row" data-name="${escapeHtml(name)}">
                <span class="palette-name">${escapeHtml(name)}</span>
                <span class="palette-swatch-pair" title="Light: bg ${escapeHtml(fmt(row.light_bg, lightBgRaw))} / fg ${escapeHtml(fmt(row.light_color, lightFgRaw))}">
                  <span class="palette-swatch" style="background:${escapeHtml(lightBgRaw)}"></span>
                  <span class="palette-swatch" style="background:${escapeHtml(lightFgRaw)}"></span>
                </span>
                ${
                    darkExplicit
                        ? `<span class="palette-swatch-pair" title="Dark: bg ${escapeHtml(fmt(row.dark_bg, darkBgRaw))} / fg ${escapeHtml(fmt(row.dark_color, darkFgRaw))}">
                             <span class="text-muted small">/</span>
                             <span class="palette-swatch" style="background:${escapeHtml(darkBgRaw)}"></span>
                             <span class="palette-swatch" style="background:${escapeHtml(darkFgRaw)}"></span>
                           </span>`
                        : ''
                }
                <span class="palette-actions">
                  <button class="btn btn-sm btn-wiki-outline" data-action="edit" data-name="${escapeHtml(name)}">
                    <i class="mdi mdi-pencil-outline"></i>
                  </button>
                  <button class="btn btn-sm btn-link text-danger p-1" data-action="delete" data-name="${escapeHtml(name)}">
                    <i class="mdi mdi-delete-outline"></i>
                  </button>
                </span>
              </div>
            `;
        })
        .join('');
}

async function loadPaletteList() {
    const container = $('paletteList');
    if (!container) return;
    try {
        const res = await fetch('/api/admin/palettes', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`${res.status}`);
        const data = (await res.json()) as { palettes?: PaletteRow[] };
        const rows = Array.isArray(data.palettes) ? data.palettes : [];
        cache = {};
        for (const row of rows) cache[row.name] = row;
        renderList();
    } catch {
        container.innerHTML =
            '<div class="p-3 text-center text-danger small">팔레트 목록을 불러오지 못했습니다.</div>';
    }
}

async function submitForm() {
    const nameRaw = $input('paletteNameInput')?.value ?? '';
    const nameErr = validateName(nameRaw);
    if (nameErr && !editingName) {
        setNameError(nameErr);
        return;
    }
    setNameError(null);
    const name = editingName ?? nameRaw.trim();

    if (hasInvalidHexInput()) {
        if (typeof Swal !== 'undefined') {
            Swal.fire('오류', '잘못된 색상 코드가 입력되어 있습니다. (#RRGGBB 또는 #RGB)', 'error');
        }
        return;
    }

    const hasDark = $input('paletteHasDark')?.checked ?? false;

    /**
     * 각 채널의 저장값을 결정. raw row 페이로드로 보내며 null 은 그대로 NULL 로 저장.
     *   - touched: 사용자가 만진 값 → 현재 state hex
     *   - 편집 모드에서 미터치: editingRow 의 raw 값 (null 유지 또는 원본 콘크리트)
     *   - 신규 모드: 현재 state hex
     */
    function rawChannelValue(k: ChannelKey): string | null {
        if (touchedChannels.has(k)) return getChannelHex(k);
        if (editingRow) return editingRow[CHANNEL_TO_RAW_KEY[k]];
        return getChannelHex(k);
    }

    const lightBg = rawChannelValue('light.bg');
    const lightFg = rawChannelValue('light.color');

    let darkBg: string | null;
    let darkFg: string | null;
    if (hasDark) {
        darkBg = rawChannelValue('dark.bg');
        darkFg = rawChannelValue('dark.color');
    } else {
        // hasDark=false: 다크가 라이트와 같이 렌더돼야 함.
        //   1) 라이트 변경 시 원본 다크가 NULL 이면 NULL 유지, 아니면 라이트로 미러링.
        //   2) 라이트 미변경 시 editingRow 의 다크 raw 보존 (inverse sparse 도 손실 없음).
        //   3) 신규 팔레트: lightValue 로 미러링.
        darkBg = touchedChannels.has('light.bg')
            ? (editingRow && editingRow.dark_bg === null ? null : lightBg)
            : (editingRow ? editingRow.dark_bg : lightBg);
        darkFg = touchedChannels.has('light.color')
            ? (editingRow && editingRow.dark_color === null ? null : lightFg)
            : (editingRow ? editingRow.dark_color : lightFg);
    }

    const body = {
        name,
        light_bg: lightBg,
        light_color: lightFg,
        dark_bg: darkBg,
        dark_color: darkFg,
    };

    try {
        const res = await fetch('/api/admin/palettes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({} as any));
            throw new Error(data.error || `저장 실패 (${res.status})`);
        }
        await loadPaletteList();
        resetForm();
        if (typeof Swal !== 'undefined') {
            Swal.fire({
                icon: 'success',
                title: '저장되었습니다.',
                showConfirmButton: false,
                timer: 1200,
            });
        }
    } catch (err: any) {
        if (typeof Swal !== 'undefined') {
            Swal.fire('오류', err.message || String(err), 'error');
        } else {
            alert(err.message || String(err));
        }
    }
}

async function deletePalette(name: string) {
    const confirmed = await (typeof Swal !== 'undefined'
        ? Swal.fire({
              icon: 'warning',
              title: '팔레트 삭제',
              text: `'${name}' 팔레트를 삭제하시겠습니까? 이 팔레트를 사용 중인 문서는 색상이 적용되지 않게 됩니다.`,
              showCancelButton: true,
              confirmButtonText: '삭제',
              cancelButtonText: '취소',
              confirmButtonColor: '#d33',
          }).then((r: any) => r.isConfirmed)
        : Promise.resolve(window.confirm(`'${name}' 을 삭제하시겠습니까?`)));
    if (!confirmed) return;
    try {
        const res = await fetch(`/api/admin/palettes/${encodeURIComponent(name)}`, {
            method: 'DELETE',
            credentials: 'same-origin',
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({} as any));
            throw new Error(data.error || `삭제 실패 (${res.status})`);
        }
        if (editingName === name) resetForm();
        await loadPaletteList();
    } catch (err: any) {
        if (typeof Swal !== 'undefined') {
            Swal.fire('오류', err.message || String(err), 'error');
        } else {
            alert(err.message || String(err));
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 채널별 인터랙션 (캔버스 드래그, 스와치, hex 입력)
// ─────────────────────────────────────────────────────────────────────────────

function getCanvasPos(canvas: HTMLCanvasElement, e: MouseEvent | TouchEvent) {
    const rect = canvas.getBoundingClientRect();
    let cx: number, cy: number;
    const te = e as TouchEvent;
    if (te.touches && te.touches.length > 0) {
        cx = te.touches[0].clientX;
        cy = te.touches[0].clientY;
    } else {
        const me = e as MouseEvent;
        cx = me.clientX;
        cy = me.clientY;
    }
    return {
        x: Math.max(0, Math.min(1, (cx - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (cy - rect.top) / rect.height)),
    };
}

function onChannelChanged(key: ChannelKey) {
    markTouched(key);
    // BG 변경 시 자동 대비가 켜져 있으면 같은 side 의 FG 도 자동 갱신 → FG 도 touched.
    if (key === 'light.bg' && isAutoContrast('light')) {
        markTouched('light.color');
        applyAutoContrast('light');
    } else if (key === 'dark.bg' && isAutoContrast('dark')) {
        markTouched('dark.color');
        applyAutoContrast('dark');
    }
    updatePreview();
}

function bindChannel(key: ChannelKey) {
    const prefix = CHANNEL_ID_PREFIX[key];
    const svCanvas = document.getElementById(`${prefix}Canvas`) as HTMLCanvasElement | null;
    const hueCanvas = document.getElementById(`${prefix}Hue`) as HTMLCanvasElement | null;
    const hexInput = $input(`${prefix}Hex`);
    const swatches = document.getElementById(`${prefix}Swatches`);
    const state = colorStates[key];

    // 스와치 그리드
    if (swatches) {
        swatches.innerHTML = SWATCHES.map(
            (c) => `<div class="palette-swatch-cell" style="background:${c};" title="${c}" data-color="${c}"></div>`,
        ).join('');
        swatches.querySelectorAll<HTMLElement>('.palette-swatch-cell').forEach((sw) => {
            sw.addEventListener('click', (e) => {
                e.preventDefault();
                setChannelColor(key, sw.dataset.color || '#000000');
                onChannelChanged(key);
            });
        });
    }

    const handleSV = (e: MouseEvent | TouchEvent) => {
        if (!svCanvas) return;
        const pos = getCanvasPos(svCanvas, e);
        state.saturation = pos.x;
        state.brightness = 1 - pos.y;
        renderChannel(key);
        onChannelChanged(key);
    };

    const handleHue = (e: MouseEvent | TouchEvent) => {
        if (!hueCanvas) return;
        const pos = getCanvasPos(hueCanvas, e);
        state.hue = pos.x * 360;
        renderChannel(key);
        onChannelChanged(key);
    };

    if (svCanvas) {
        svCanvas.addEventListener('mousedown', (e) => {
            e.preventDefault();
            state.dragging = 'palette';
            handleSV(e);
        });
        svCanvas.addEventListener(
            'touchstart',
            (e) => {
                e.preventDefault();
                state.dragging = 'palette';
                handleSV(e);
            },
            { passive: false },
        );
    }
    if (hueCanvas) {
        hueCanvas.addEventListener('mousedown', (e) => {
            e.preventDefault();
            state.dragging = 'hue';
            handleHue(e);
        });
        hueCanvas.addEventListener(
            'touchstart',
            (e) => {
                e.preventDefault();
                state.dragging = 'hue';
                handleHue(e);
            },
            { passive: false },
        );
    }

    document.addEventListener('mousemove', (e) => {
        if (state.dragging === 'palette') handleSV(e);
        else if (state.dragging === 'hue') handleHue(e);
    });
    document.addEventListener(
        'touchmove',
        (e) => {
            if (state.dragging === 'palette') {
                e.preventDefault();
                handleSV(e);
            } else if (state.dragging === 'hue') {
                e.preventDefault();
                handleHue(e);
            }
        },
        { passive: false },
    );
    document.addEventListener('mouseup', () => {
        state.dragging = null;
    });
    document.addEventListener('touchend', () => {
        state.dragging = null;
    });
    document.addEventListener('touchcancel', () => {
        state.dragging = null;
    });

    if (hexInput) {
        hexInput.addEventListener('input', () => {
            const v = normalizeHex(hexInput.value);
            if (v) {
                hexInput.classList.remove('is-invalid');
                const hsv = hexToHsv(v);
                state.hue = hsv.h;
                state.saturation = hsv.s;
                state.brightness = hsv.v;
                renderChannel(key);
                // hex 입력으로 인한 변경은 disabled 가 아닌 한 사용자 의도.
                if (!hexInput.disabled) onChannelChanged(key);
            } else {
                hexInput.classList.add('is-invalid');
            }
        });
        hexInput.addEventListener('change', () => {
            const v = normalizeHex(hexInput.value);
            if (v) hexInput.value = v;
        });
    }

    // 초기 state 를 HTML hex 입력의 기본값으로부터 시드. 시드 없이 첫 render 를
    // 돌리면 colorStates 의 하드코딩 초기값(#000000/#FFFFFF)이 HTML 의 #0D65F5
    // 같은 마크업 디폴트를 덮어쓴다 — Codex P1 (#686) 회귀 방지.
    const initialHex = hexInput?.value ? normalizeHex(hexInput.value) : null;
    if (initialHex) {
        const hsv = hexToHsv(initialHex);
        state.hue = hsv.h;
        state.saturation = hsv.s;
        state.brightness = hsv.v;
    }
    renderChannel(key);
}

// ─────────────────────────────────────────────────────────────────────────────
// 초기 부팅
// ─────────────────────────────────────────────────────────────────────────────

function attach() {
    ALL_CHANNELS.forEach(bindChannel);

    $input('paletteLightAuto')?.addEventListener('change', () => {
        if (isAutoContrast('light')) markTouched('light.color');
        syncAutoState('light');
        updatePreview();
    });
    $input('paletteDarkAuto')?.addEventListener('change', () => {
        if (isAutoContrast('dark')) markTouched('dark.color');
        syncAutoState('dark');
        updatePreview();
    });
    $input('paletteHasDark')?.addEventListener('change', syncDarkRow);

    $input('paletteNameInput')?.addEventListener('input', () => {
        if ($input('paletteNameInput')?.value.trim()) setNameError(null);
        updatePreview();
    });

    $('paletteFormSubmit')?.addEventListener('click', submitForm);
    $('paletteFormReset')?.addEventListener('click', resetForm);

    // 목록 행 액션 위임
    $('paletteList')?.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('button[data-action]') as HTMLButtonElement | null;
        if (!btn) return;
        const name = btn.dataset.name || '';
        const action = btn.dataset.action;
        if (action === 'edit') {
            const row = cache[name];
            if (row) loadIntoForm(row);
        } else if (action === 'delete') {
            void deletePalette(name);
        }
    });

    // 초기 상태: light 자동 대비 ON 이므로 light.color disable + 자동 적용.
    syncAutoState('light');
    syncDarkRow();
    updatePreview();
}

window.loadPaletteList = loadPaletteList;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach);
} else {
    attach();
}
