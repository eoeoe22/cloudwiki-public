/**
 * 이미지 업로드 / 기존 이미지 검색 / 이미지 편집기 (크롭 + 90도 회전, 터치 지원).
 * 기존 public/js/edit-image.js 의 ES 모듈 이전.
 *
 * edit.html / blog-edit.html 양쪽에서 로드 (양 페이지 동일한 #imageEditorModal 마크업).
 *
 * 외부 노출 (브리지):
 *   - window.openExistingImageSearch(callback)  ← edit.js 가 호출
 *   - window.handleImageUpload(blob, callback)   ← edit.js 가 호출
 *
 *   ImageEditor 는 모듈 내부에서만 사용 (handleImageUpload 가 직접 참조). 외부 어떤
 *   raw script 도 ImageEditor 글로벌을 직접 사용하지 않음을 grep 으로 확인했으므로
 *   window 노출 불필요.
 *
 * 외부 의존:
 *   - window.Swal (CDN sweetalert2)
 *   - window.mountMediaTagInput (common.js)
 *   - window.bootstrap.Modal (CDN bootstrap)
 *   - DOM: #imageEditorModal 외 (edit.html / blog-edit.html 양쪽 동일)
 *
 * 모듈 평가 타이밍:
 *   type="module" 스크립트는 deferred — 모든 classic top-level 실행 후, 어떤
 *   DOMContentLoaded 핸들러보다 앞이다. 따라서 브리지 노출과 ImageEditor 의
 *   내부 setTimeout(init, 300) 모두 안전.
 */

import './types';
import type { MediaTagWidget } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// 내부 타입
// ─────────────────────────────────────────────────────────────────────────────

interface MediaItem {
    id: number;
    url: string;
    filename: string;
    tags?: string[];
}

type ImageInsertCallback = (url: string, alt: string, size: string) => void;

interface EditResult {
    blob: Blob;
    size: string;
}

interface MediaSearchResponse {
    total?: number;
    items?: MediaItem[];
    error?: string;
}

interface MediaUploadResponse {
    url: string;
    filename: string;
    error?: string;
}

declare global {
    interface Window {
        /** 기존 이미지 검색 모달 — edit.js 의 imageUploadBtn 핸들러가 호출 */
        openExistingImageSearch?: (callback: ImageInsertCallback) => Promise<void>;
        /** 이미지 업로드 처리 — edit.js 의 파일 input / 드롭 핸들러가 호출 */
        handleImageUpload?: (blob: File | Blob | null, callback: ImageInsertCallback) => Promise<void>;
        /** 미디어 엔드포인트 및 검색 동작을 워크스페이스 등 컨텍스트별로 재설정 */
        configureImageUpload?: (opts: {
            uploadUrl?: string;
            searchFetcher?: ((q: string, tags: string[], limit: number, offset: number) => Promise<{ total: number; items: MediaItem[] }>) | null;
        }) => void;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 미디어 컨텍스트 설정 (워크스페이스 등 커스텀 엔드포인트 지원)
// ─────────────────────────────────────────────────────────────────────────────

type SearchFetcher = (q: string, tags: string[], limit: number, offset: number) => Promise<{ total: number; items: MediaItem[] }>;

let _uploadUrl: string = '/api/media';
let _searchFetcher: SearchFetcher | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// HTML 이스케이프 (이미지 검색 결과 안전 출력)
// 모듈 로컬 작은 유틸 — common.js / utils/html.ts 의 escapeHtml 과 동일 동작이지만
// 클로저 내부 호출 빈도 / 의존 최소화를 위해 인라인 유지 (원본 edit-image.js 와 동일).
// ─────────────────────────────────────────────────────────────────────────────

const ESCAPE_MAP: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};
const escapeHtml = (s: unknown): string =>
    String(s ?? '').replace(/[&<>"']/g, (m) => ESCAPE_MAP[m] ?? m);

// ─────────────────────────────────────────────────────────────────────────────
// 기존 이미지 검색 모달
// ─────────────────────────────────────────────────────────────────────────────

async function openExistingImageSearch(callback: ImageInsertCallback): Promise<void> {
    const Swal = window.Swal;
    if (!Swal) return;

    let offset = 0;
    const limit = 24;
    let total = 0;
    let items: MediaItem[] = [];
    let currentQuery = '';
    let currentTags: string[] = [];
    let loading = false;
    let finished = false;
    let tagWidget: MediaTagWidget | null = null;

    let pickedItem: MediaItem | null = null;

    const tagFilterHtml = _searchFetcher ? '' : `
                <div class="existing-img-tag-filter" style="margin-top:8px;">
                    <label style="display:block; font-size:0.82rem; color:var(--wiki-text-muted,#888); margin-bottom:4px; text-align:left;">
                        <i class="mdi mdi-tag-multiple-outline"></i> 태그 검색
                    </label>
                    <div class="category-tag-container" id="existingImgTagContainer" style="max-width:100%;">
                        <input type="text" id="existingImgTagInput" class="category-tag-input" placeholder="(엔터/쉼표로 추가)">
                    </div>
                </div>`;

    await Swal.fire({
        title: '기존 이미지 검색',
        width: 720,
        showCancelButton: true,
        showConfirmButton: false,
        cancelButtonText: '닫기',
        html: `
            <div class="existing-img-search-wrap">
                <div class="existing-img-search-bar">
                    <input type="text" id="existingImgSearchInput" class="form-control"
                           placeholder="파일명 검색" autocomplete="off">
                    <button type="button" class="btn btn-primary" id="existingImgSearchBtn">
                        <i class="mdi mdi-magnify"></i>
                    </button>
                </div>
                ${tagFilterHtml}
                <div id="existingImgSearchInfo" class="existing-img-search-info"></div>
                <div id="existingImgSearchGrid" class="existing-img-search-grid"></div>
                <div id="existingImgSearchMore" class="existing-img-search-more" style="display:none;">
                    <button type="button" class="btn btn-outline-secondary btn-sm" id="existingImgMoreBtn">
                        더 불러오기
                    </button>
                </div>
            </div>
        `,
        didOpen: () => {
            const input = document.getElementById('existingImgSearchInput') as HTMLInputElement | null;
            const searchBtn = document.getElementById('existingImgSearchBtn');
            const moreBtn = document.getElementById('existingImgMoreBtn');
            if (!input || !searchBtn || !moreBtn) return;

            const doSearch = (reset: boolean): void => {
                if (reset) {
                    offset = 0;
                    items = [];
                    finished = false;
                    currentQuery = input.value.trim();
                    currentTags = tagWidget ? tagWidget.getTags() : [];
                }
                void loadPage();
            };

            if (!_searchFetcher) {
                const tagContainer = document.getElementById('existingImgTagContainer');
                const tagInput = document.getElementById('existingImgTagInput') as HTMLInputElement | null;
                if (tagContainer && tagInput) {
                    const mount = window.mountMediaTagInput;
                    if (mount) {
                        tagWidget = mount({ container: tagContainer, input: tagInput, initial: [] });
                        tagWidget.setOnChange(() => doSearch(true));
                    }
                }
            }

            searchBtn.addEventListener('click', () => doSearch(true));
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); doSearch(true); }
            });
            moreBtn.addEventListener('click', () => { void loadPage(); });

            doSearch(true);
        },
        willClose: () => { if (tagWidget) tagWidget.destroy(); },
        preConfirm: () => pickedItem,
    });

    async function loadPage(): Promise<void> {
        if (loading || finished) return;
        loading = true;
        // 로딩 시작 시점의 검색 조건을 스냅샷 — 비동기 대기 중 doSearch 가 조건을 바꿔도 올바른 값으로 요청한다.
        const querySnapshot = currentQuery;
        const tagsSnapshot = currentTags.slice();
        const offsetSnapshot = offset;
        const grid = document.getElementById('existingImgSearchGrid');
        const info = document.getElementById('existingImgSearchInfo');
        const moreWrap = document.getElementById('existingImgSearchMore') as HTMLElement | null;
        if (!grid || !info || !moreWrap) { loading = false; return; }

        if (offsetSnapshot === 0) {
            grid.innerHTML = '<div class="existing-img-search-empty">' + window.uiInlineLoading() + '</div>';
        }
        try {
            let resultTotal: number;
            let fetched: MediaItem[];
            if (_searchFetcher) {
                const result = await _searchFetcher(querySnapshot, tagsSnapshot, limit, offsetSnapshot);
                resultTotal = result.total || 0;
                fetched = result.items || [];
            } else {
                const params = new URLSearchParams();
                if (querySnapshot) params.set('q', querySnapshot);
                if (tagsSnapshot && tagsSnapshot.length > 0) params.set('tags', tagsSnapshot.join(','));
                params.set('limit', String(limit));
                params.set('offset', String(offsetSnapshot));
                const res = await fetch(`/api/media/search?${params.toString()}`);
                if (!res.ok) {
                    const data = await res.json().catch(() => ({})) as MediaSearchResponse;
                    throw new Error(data.error || '검색 실패');
                }
                const data = await res.json() as MediaSearchResponse;
                resultTotal = data.total || 0;
                fetched = data.items || [];
            }
            // 로딩 중 새 검색이 제출된 경우 결과를 버리고 새 요청에 위임한다.
            if (currentQuery !== querySnapshot) return;
            total = resultTotal;
            if (offsetSnapshot === 0) items = [];
            items = items.concat(fetched);
            offset += fetched.length;
            if (fetched.length < limit || items.length >= total) finished = true;

            renderGrid(grid);
            info.textContent = total > 0
                ? `총 ${total}개 중 ${items.length}개 표시`
                : '결과가 없습니다.';
            moreWrap.style.display = finished ? 'none' : '';
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            grid.innerHTML = `<div class="existing-img-search-empty text-danger">${escapeHtml(msg)}</div>`;
        } finally {
            loading = false;
            // 로딩 중 새 검색이 제출됐으면 이제 실행한다.
            if (currentQuery !== querySnapshot) void loadPage();
        }
    }

    function renderGrid(grid: HTMLElement): void {
        if (!items.length) {
            grid.innerHTML = '<div class="existing-img-search-empty">'
                + window.uiEmptyState({ icon: 'bi bi-images', title: '이미지가 없습니다', compact: true })
                + '</div>';
            return;
        }
        grid.innerHTML = items.map((m) => {
            const tagBadges = (m.tags || []).slice(0, 4).map(t =>
                `<span class="existing-img-tile-tag">${escapeHtml(t)}</span>`
            ).join('');
            const extra = (m.tags && m.tags.length > 4) ? `<span class="existing-img-tile-tag-more">+${m.tags.length - 4}</span>` : '';
            const tagLine = (m.tags && m.tags.length) ? `<div class="existing-img-tile-tags">${tagBadges}${extra}</div>` : '';
            const titleAttr = (m.tags && m.tags.length)
                ? `${m.filename}\n태그: ${m.tags.join(', ')}`
                : m.filename;
            return `
            <div class="existing-img-tile" data-id="${m.id}" title="${escapeHtml(titleAttr)}">
                <img src="${escapeHtml(m.url)}" alt="${escapeHtml(m.filename)}" loading="lazy">
                <div class="existing-img-tile-name">${escapeHtml(m.filename)}</div>
                ${tagLine}
            </div>`;
        }).join('');

        grid.querySelectorAll<HTMLElement>('.existing-img-tile').forEach((tile) => {
            tile.addEventListener('click', async () => {
                const id = Number(tile.dataset.id);
                const picked = items.find((it) => it.id === id);
                if (!picked) return;
                const size = await askImageSize(picked);
                if (size === null) return;
                Swal!.close();
                const altBase = picked.filename.replace(/\.[^.]+$/, '');
                callback(picked.url, altBase, size);
            });
        });
    }

    async function askImageSize(picked: MediaItem): Promise<string | null> {
        const result = await Swal!.fire<string>({
            title: '이미지 크기 선택',
            html: `
                <div class="existing-img-size-preview">
                    <img src="${escapeHtml(picked.url)}" alt="${escapeHtml(picked.filename)}">
                    <div class="existing-img-size-filename">${escapeHtml(picked.filename)}</div>
                </div>
                <div class="existing-img-size-options">
                    <label><input type="radio" name="existingImgSize" value="icon"> 아이콘</label>
                    <label><input type="radio" name="existingImgSize" value="small"> 작게</label>
                    <label><input type="radio" name="existingImgSize" value="medium"> 중간</label>
                    <label><input type="radio" name="existingImgSize" value="full" checked> 크게 (기본)</label>
                </div>
            `,
            showCancelButton: true,
            confirmButtonText: '삽입',
            cancelButtonText: '취소',
            preConfirm: () => {
                const sel = document.querySelector<HTMLInputElement>('input[name="existingImgSize"]:checked');
                return sel ? sel.value : 'full';
            },
        });
        return result.isConfirmed ? (result.value || 'full') : null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 업로드 파일명 검증 (서버 src/routes/media.ts 의 validateUploadFilename 와 규칙 일치)
//
// 사용자 요청 보정 규칙:
//   1) 모든 공백류는 '-' 로 치환한다.
//   2) 양 끝의 공백·'-' 는 제거한다.
// 그 후에도 남는 금지 문자(/[\[\]()#%|<>^/\\.?\x00-\x1F\x7F]/) 가 있거나 길이가
// 100 자를 초과하거나 빈 문자열이면 오류로 처리한다.
// ─────────────────────────────────────────────────────────────────────────────

const FILENAME_FORBIDDEN_CHARS = /[\[\]()#%|<>^/\\.?\x00-\x1F\x7F]/g;
const FILENAME_MAX_LENGTH = 100;

function normalizeUploadFilename(raw: string): string {
    return raw.replace(/\s+/g, '-').replace(/^-+|-+$/g, '');
}

type FilenameValidation =
    | { ok: true; value: string }
    | { ok: false; error: string };

function validateUploadFilenameClient(raw: string): FilenameValidation {
    const normalized = normalizeUploadFilename(raw);
    if (!normalized) {
        return { ok: false, error: '파일명을 입력해주세요.' };
    }
    const matches = normalized.match(FILENAME_FORBIDDEN_CHARS);
    if (matches) {
        const unique = Array.from(new Set(matches)).join(' ');
        return { ok: false, error: `파일명에 사용할 수 없는 문자가 있습니다: ${unique}` };
    }
    if (normalized.length > FILENAME_MAX_LENGTH) {
        return { ok: false, error: `파일명은 최대 ${FILENAME_MAX_LENGTH}자까지 입력할 수 있습니다.` };
    }
    return { ok: true, value: normalized };
}

// ─────────────────────────────────────────────────────────────────────────────
// 미디어 업로드 처리
// ─────────────────────────────────────────────────────────────────────────────

async function handleImageUpload(
    blob: File | Blob | null,
    callback: ImageInsertCallback,
): Promise<void> {
    if (!blob) return;
    const Swal = window.Swal;

    if (blob.size > 15 * 1024 * 1024) {
        Swal?.fire('오류', '파일 크기는 15MB 이하만 허용됩니다.', 'warning');
        return;
    }

    let selectedSize = 'full';
    let workingBlob: File | Blob = blob;

    if (workingBlob.type === 'image/svg+xml') {
        // SVG: 캔버스 편집기 건너뜀. DOMPurify로 XSS 유발 요소 제거 후 업로드.
        const DOMPurify = (window as any).DOMPurify as
            | { sanitize(dirty: string, cfg?: Record<string, unknown>): string }
            | undefined;
        if (!DOMPurify || typeof DOMPurify.sanitize !== 'function') {
            Swal?.fire('오류', 'SVG 보안 정제 라이브러리를 로드할 수 없습니다. 페이지를 새로고침 후 다시 시도해주세요.', 'error');
            return;
        }
        const svgText = await (workingBlob as File).text();
        const sanitized = DOMPurify.sanitize(svgText, { USE_PROFILES: { svg: true, svgFilters: true } });
        const origName = (workingBlob as File).name || 'image.svg';
        workingBlob = new File([sanitized], origName, { type: 'image/svg+xml' });
    } else if (workingBlob.type) {
        // 비SVG 이미지: 편집기 실행 (크롭 + 회전)
        const editResult = await ImageEditor.open(workingBlob);
        if (!editResult) return; // 편집 취소
        const fileName = (workingBlob as File).name || 'image';
        workingBlob = new File([editResult.blob], fileName, { type: editResult.blob.type });
        selectedSize = editResult.size || 'full';
    }

    // 사용자에게 파일명 + 태그 입력 요청
    const originalName = (workingBlob as File).name || 'image';
    const nameWithoutExt = originalName.replace(/\.[^.]+$/, '');
    const initialNormalized = normalizeUploadFilename(nameWithoutExt);
    const nameDefaultAttr = escapeHtml(initialNormalized || nameWithoutExt);
    const FILENAME_HELP_DEFAULT =
        '공백은 <code>-</code> 로 변환되고, 양 끝의 공백·<code>-</code> 는 제거됩니다. ' +
        '<code>[</code> <code>]</code> <code>(</code> <code>)</code> <code>#</code> <code>%</code> <code>|</code> ' +
        '<code>&lt;</code> <code>&gt;</code> <code>^</code> <code>/</code> <code>\\</code> <code>.</code> <code>?</code> 는 사용할 수 없습니다.';

    const showTags = !_searchFetcher;
    const tagSectionHtml = showTags ? `
                <label class="form-label fw-bold" style="display:block; margin-bottom:4px;">태그 (선택)</label>
                <div class="category-tag-container" id="uploadTagContainer" style="max-width:100%;">
                    <input type="text" id="uploadTagInput" class="category-tag-input" placeholder="태그 입력 후 엔터나 쉼표">
                </div>
                <div class="form-text text-muted" style="margin-top:4px; font-size:0.82rem;">한글/영문/숫자/공백/_/./- 만 사용 가능 · 최대 20개</div>` : '';

    let tagWidget: MediaTagWidget | null = null;
    const result = await (Swal?.fire<{ filename: string; tags: string[] }>({
        title: '이미지 업로드',
        html: `
            <div style="text-align:left;">
                <label for="uploadFilenameInput" class="form-label fw-bold" style="display:block; margin-bottom:4px;">파일명 (확장자 제외)</label>
                <input type="text" id="uploadFilenameInput" class="swal2-input" style="margin:0; width:100%;" placeholder="파일명을 입력하세요" value="${nameDefaultAttr}" maxlength="120">
                <div id="uploadFilenameFeedback" class="form-text text-muted" style="margin:4px 0 14px 0; font-size:0.82rem; min-height:1.2em;">${FILENAME_HELP_DEFAULT}</div>
                ${tagSectionHtml}
            </div>
        `,
        showCancelButton: true,
        confirmButtonText: '업로드',
        cancelButtonText: '취소',
        focusConfirm: false,
        didOpen: () => {
            const fnInput = document.getElementById('uploadFilenameInput') as HTMLInputElement | null;
            const fnFeedback = document.getElementById('uploadFilenameFeedback');
            if (!fnInput) return;
            fnInput.focus();
            fnInput.select();

            const updateFnFeedback = (): void => {
                if (!fnFeedback) return;
                const raw = fnInput.value;
                if (!raw) {
                    fnFeedback.innerHTML = FILENAME_HELP_DEFAULT;
                    fnFeedback.className = 'form-text text-muted';
                    return;
                }
                const v = validateUploadFilenameClient(raw);
                if (!v.ok) {
                    fnFeedback.textContent = v.error;
                    fnFeedback.className = 'form-text text-danger';
                    return;
                }
                if (v.value === raw) {
                    fnFeedback.innerHTML = FILENAME_HELP_DEFAULT;
                    fnFeedback.className = 'form-text text-muted';
                } else {
                    fnFeedback.innerHTML = `저장될 파일명: <code>${escapeHtml(v.value)}</code>`;
                    fnFeedback.className = 'form-text text-success';
                }
            };
            fnInput.addEventListener('input', updateFnFeedback);
            updateFnFeedback();

            if (showTags) {
                const tagContainer = document.getElementById('uploadTagContainer');
                const tagInput = document.getElementById('uploadTagInput') as HTMLInputElement | null;
                const mount = window.mountMediaTagInput;
                if (mount && tagContainer && tagInput) {
                    tagWidget = mount({ container: tagContainer, input: tagInput, initial: [] });
                }
            }
        },
        willClose: () => { if (tagWidget) tagWidget.destroy(); },
        preConfirm: () => {
            const fnInput = document.getElementById('uploadFilenameInput') as HTMLInputElement | null;
            const v = validateUploadFilenameClient(fnInput ? fnInput.value : '');
            if (!v.ok) {
                Swal?.showValidationMessage(v.error);
                return false;
            }
            if (tagWidget) tagWidget.flush();
            return { filename: v.value, tags: tagWidget ? tagWidget.getTags() : [] };
        },
    })) ?? { isConfirmed: false, isDenied: false, isDismissed: true, value: undefined };

    if (!result.isConfirmed || !result.value) return;
    const customFilename = result.value.filename;
    const uploadTags = result.value.tags || [];

    const formData = new FormData();
    formData.append('file', workingBlob);
    formData.append('filename', customFilename);
    if (uploadTags.length > 0) {
        formData.append('tags', JSON.stringify(uploadTags));
    }

    try {
        const res = await fetch(_uploadUrl, {
            method: 'POST',
            credentials: 'same-origin',
            body: formData,
        });

        if (!res.ok) {
            const data = await res.json() as MediaUploadResponse;
            throw new Error(data.error || '업로드 실패');
        }

        const data = await res.json() as MediaUploadResponse;

        // callback(url, altText, size)
        callback(data.url, data.filename, selectedSize);

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(err);
        Swal?.fire('오류', msg, 'error');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 이미지 편집기 (크롭 + 90도 회전, 터치 지원)
// ─────────────────────────────────────────────────────────────────────────────

const ImageEditor = (() => {
    let modal: { show(): void; hide(): void } | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let ctx: CanvasRenderingContext2D | null = null;
    let originalImg: HTMLImageElement | null = null; // 원본 Image 객체
    let currentImg: HTMLImageElement | null = null;  // 현재 편집 상태 Image
    let rotation = 0;            // 누적 회전 (0, 90, 180, 270)
    let cropMode = false;
    const crop = { x: 0, y: 0, w: 0, h: 0 }; // 캔버스 좌표 기준
    let resolvePromise: ((value: EditResult | null) => void) | null = null;
    let originalBlob: File | Blob | null = null;
    let selectedSize = 'full';

    function init(): void {
        const modalEl = document.getElementById('imageEditorModal');
        const canvasEl = document.getElementById('imgEditorCanvas') as HTMLCanvasElement | null;
        if (!modalEl || !canvasEl || !window.bootstrap) return;
        modal = new window.bootstrap.Modal(modalEl);
        canvas = canvasEl;
        ctx = canvasEl.getContext('2d');

        document.getElementById('btnRotateLeft')?.addEventListener('click', () => rotate(-90));
        document.getElementById('btnRotateRight')?.addEventListener('click', () => rotate(90));
        document.getElementById('btnCropToggle')?.addEventListener('click', toggleCrop);
        document.getElementById('btnCropApply')?.addEventListener('click', applyCrop);
        document.getElementById('btnImgReset')?.addEventListener('click', resetImage);
        document.getElementById('btnImgEditorDone')?.addEventListener('click', finishEdit);

        // 사이즈 드롭다운 이벤트 연동
        const dropdownItems = document.querySelectorAll<HTMLElement>('#imgEditorSizeDropdown .dropdown-item');
        if (dropdownItems.length) {
            dropdownItems.forEach((item) => {
                item.addEventListener('click', (e) => {
                    e.preventDefault();
                    const target = e.currentTarget as HTMLElement;
                    const size = target.dataset.size || 'full';
                    const label = target.innerHTML;
                    selectedSize = size;
                    const toggleBtn = document.getElementById('btnImgEditorSizeToggle');
                    if (toggleBtn) toggleBtn.innerHTML = label;
                });
            });
        }

        modalEl.addEventListener('hidden.bs.modal', () => {
            if (resolvePromise) {
                resolvePromise(null);
                resolvePromise = null;
            }
        });

        initCropInteraction();
    }

    // 외부에서 호출: 이미지 파일 → 편집 모달 → 편집된 Blob 반환
    function open(blob: File | Blob): Promise<EditResult | null> {
        originalBlob = blob;
        rotation = 0;
        cropMode = false;
        selectedSize = 'full';
        const toggleBtn = document.getElementById('btnImgEditorSizeToggle');
        if (toggleBtn) {
            toggleBtn.innerHTML = '<i class="mdi mdi-arrow-expand-all me-1"></i>크게(기본)';
        }
        const cropOverlay = document.getElementById('cropOverlay') as HTMLElement | null;
        if (cropOverlay) cropOverlay.style.display = 'none';
        document.getElementById('btnCropToggle')?.classList.remove('active');
        const cropApplyBtn = document.getElementById('btnCropApply') as HTMLElement | null;
        if (cropApplyBtn) cropApplyBtn.style.display = 'none';

        return new Promise((resolve) => {
            resolvePromise = resolve;
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                originalImg = img;
                currentImg = img;
                drawImage();
                updateInfo();
                modal?.show();
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                resolve(null);
            };
            img.src = url;
        });
    }

    function drawImage(): void {
        if (!currentImg || !canvas || !ctx) return;
        const w = currentImg.width;
        const h = currentImg.height;

        // 회전 고려
        const rad = (rotation % 360) * Math.PI / 180;
        const abs90 = (rotation % 360 + 360) % 360;
        const swap = abs90 === 90 || abs90 === 270;
        const cw = swap ? h : w;
        const ch = swap ? w : h;

        canvas.width = cw;
        canvas.height = ch;

        ctx.save();
        ctx.translate(cw / 2, ch / 2);
        ctx.rotate(rad);
        ctx.drawImage(currentImg, -w / 2, -h / 2);
        ctx.restore();

        // 캔버스 wrap 크기 자동 조절
        updateInfo();
    }

    function rotate(deg: number): void {
        exitCropMode();
        rotation = (rotation + deg + 360) % 360;
        drawImage();
    }

    function resetImage(): void {
        exitCropMode();
        currentImg = originalImg;
        rotation = 0;
        drawImage();
    }

    function toggleCrop(): void {
        if (cropMode) {
            exitCropMode();
        } else {
            enterCropMode();
        }
    }

    function enterCropMode(): void {
        if (!canvas) return;
        cropMode = true;
        document.getElementById('btnCropToggle')?.classList.add('active');
        const cropApplyBtn = document.getElementById('btnCropApply') as HTMLElement | null;
        if (cropApplyBtn) cropApplyBtn.style.display = '';

        const overlay = document.getElementById('cropOverlay') as HTMLElement | null;
        const wrap = document.getElementById('imgEditorCanvasWrap');
        if (!overlay || !wrap) return;
        overlay.style.display = '';

        // 캔버스의 실제 표시 크기 계산
        const rect = canvas.getBoundingClientRect();
        const wrapRect = wrap.getBoundingClientRect();

        // overlay를 canvas와 동일 위치/크기로 맞춤
        overlay.style.left = (rect.left - wrapRect.left) + 'px';
        overlay.style.top = (rect.top - wrapRect.top) + 'px';
        overlay.style.width = rect.width + 'px';
        overlay.style.height = rect.height + 'px';

        // 기본 크롭 영역: 가운데 80%
        const margin = 0.1;
        crop.x = rect.width * margin;
        crop.y = rect.height * margin;
        crop.w = rect.width * (1 - 2 * margin);
        crop.h = rect.height * (1 - 2 * margin);

        updateCropBox();
    }

    function exitCropMode(): void {
        cropMode = false;
        document.getElementById('btnCropToggle')?.classList.remove('active');
        const cropApplyBtn = document.getElementById('btnCropApply') as HTMLElement | null;
        if (cropApplyBtn) cropApplyBtn.style.display = 'none';
        const overlay = document.getElementById('cropOverlay') as HTMLElement | null;
        if (overlay) overlay.style.display = 'none';
    }

    function updateCropBox(): void {
        const box = document.getElementById('cropBox') as HTMLElement | null;
        if (!box) return;
        box.style.left = crop.x + 'px';
        box.style.top = crop.y + 'px';
        box.style.width = crop.w + 'px';
        box.style.height = crop.h + 'px';
    }

    function applyCrop(): void {
        if (!cropMode || !canvas) return;

        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;

        const sx = Math.round(crop.x * scaleX);
        const sy = Math.round(crop.y * scaleY);
        const sw = Math.round(crop.w * scaleX);
        const sh = Math.round(crop.h * scaleY);

        if (sw < 10 || sh < 10) {
            window.Swal?.fire('오류', '크롭 영역이 너무 작습니다.', 'warning');
            return;
        }

        // 현재 캔버스 → 크롭 데이터 추출
        const tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = sw;
        tmpCanvas.height = sh;
        const tmpCtx = tmpCanvas.getContext('2d');
        if (!tmpCtx) return;
        tmpCtx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);

        // 결과를 새 이미지로
        const img = new Image();
        img.onload = () => {
            currentImg = img;
            rotation = 0;
            exitCropMode();
            drawImage();
        };
        img.src = tmpCanvas.toDataURL();
    }

    // ── 크롭 인터랙션 (마우스 + 터치) ──
    function initCropInteraction(): void {
        const overlay = document.getElementById('cropOverlay');
        if (!overlay) return;
        let dragging: null | 'move' | 'tl' | 'tr' | 'bl' | 'br' = null;
        let startPos = { x: 0, y: 0 };
        let startCrop = { x: 0, y: 0, w: 0, h: 0 };

        function getPos(e: MouseEvent | TouchEvent): { x: number; y: number } {
            const t: { clientX: number; clientY: number } = ('touches' in e && e.touches.length > 0)
                ? e.touches[0]
                : (e as MouseEvent);
            const rect = overlay!.getBoundingClientRect();
            return { x: t.clientX - rect.left, y: t.clientY - rect.top };
        }

        function onStart(e: MouseEvent | TouchEvent): void {
            const target = e.target as HTMLElement | null;
            if (!target) return;
            if (target.classList.contains('crop-handle')) {
                const handle = target.dataset.handle;
                if (handle === 'tl' || handle === 'tr' || handle === 'bl' || handle === 'br') {
                    dragging = handle;
                } else {
                    return;
                }
            } else if (target.id === 'cropBox' || target.closest('#cropBox')) {
                dragging = 'move';
            } else {
                return;
            }
            e.preventDefault();
            startPos = getPos(e);
            startCrop = { ...crop };
        }

        function onMove(e: MouseEvent | TouchEvent): void {
            if (!dragging) return;
            e.preventDefault();
            const pos = getPos(e);
            const dx = pos.x - startPos.x;
            const dy = pos.y - startPos.y;

            const overlayRect = overlay!.getBoundingClientRect();
            const maxW = overlayRect.width;
            const maxH = overlayRect.height;
            const minSize = 20;

            if (dragging === 'move') {
                crop.x = Math.max(0, Math.min(maxW - crop.w, startCrop.x + dx));
                crop.y = Math.max(0, Math.min(maxH - crop.h, startCrop.y + dy));
            } else if (dragging === 'tl') {
                crop.x = Math.max(0, Math.min(startCrop.x + startCrop.w - minSize, startCrop.x + dx));
                crop.y = Math.max(0, Math.min(startCrop.y + startCrop.h - minSize, startCrop.y + dy));
                crop.w = startCrop.w - (crop.x - startCrop.x);
                crop.h = startCrop.h - (crop.y - startCrop.y);
            } else if (dragging === 'tr') {
                crop.w = Math.max(minSize, Math.min(maxW - startCrop.x, startCrop.w + dx));
                crop.y = Math.max(0, Math.min(startCrop.y + startCrop.h - minSize, startCrop.y + dy));
                crop.h = startCrop.h - (crop.y - startCrop.y);
            } else if (dragging === 'bl') {
                crop.x = Math.max(0, Math.min(startCrop.x + startCrop.w - minSize, startCrop.x + dx));
                crop.w = startCrop.w - (crop.x - startCrop.x);
                crop.h = Math.max(minSize, Math.min(maxH - startCrop.y, startCrop.h + dy));
            } else if (dragging === 'br') {
                crop.w = Math.max(minSize, Math.min(maxW - startCrop.x, startCrop.w + dx));
                crop.h = Math.max(minSize, Math.min(maxH - startCrop.y, startCrop.h + dy));
            }

            updateCropBox();
        }

        function onEnd(): void {
            dragging = null;
        }

        // 마우스 이벤트
        overlay.addEventListener('mousedown', onStart);
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);

        // 터치 이벤트
        overlay.addEventListener('touchstart', onStart, { passive: false });
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd);
    }

    function finishEdit(): void {
        if (!canvas) return;
        // 캔버스 → Blob
        const mimeType = originalBlob && originalBlob.type && originalBlob.type.startsWith('image/')
            ? originalBlob.type : 'image/png';
        const quality = mimeType === 'image/jpeg' ? 0.92 : undefined;

        canvas.toBlob((blob) => {
            if (resolvePromise) {
                if (blob) {
                    resolvePromise({ blob, size: selectedSize });
                } else {
                    resolvePromise(null);
                }
                resolvePromise = null;
            }
            modal?.hide();
        }, mimeType, quality);
    }

    function updateInfo(): void {
        const info = document.getElementById('imgEditorInfo');
        if (info && canvas && canvas.width && canvas.height) {
            info.textContent = `${canvas.width} × ${canvas.height}px`;
        }
    }

    // DOM 로드 후 초기화 (원본 edit-image.js 와 동일하게 setTimeout 으로 지연)
    setTimeout(init, 300);

    return { open };
})();

// ─────────────────────────────────────────────────────────────────────────────
// 브리지: edit.js (raw) 가 bare reference 로 호출하므로 window 에 노출
// ─────────────────────────────────────────────────────────────────────────────

window.openExistingImageSearch = openExistingImageSearch;
window.handleImageUpload = handleImageUpload;
window.configureImageUpload = (opts) => {
    if (opts.uploadUrl !== undefined) _uploadUrl = opts.uploadUrl;
    if (opts.searchFetcher !== undefined) _searchFetcher = opts.searchFetcher;
};

console.log('[edit/image] module loaded');
