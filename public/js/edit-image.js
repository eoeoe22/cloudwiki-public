// ── 기존 이미지 검색 모달 ──
async function openExistingImageSearch(callback) {
    let offset = 0;
    const limit = 24;
    let total = 0;
    let items = [];
    let currentQuery = '';
    let currentTags = [];
    let loading = false;
    let finished = false;
    let tagWidget = null;

    const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));

    let pickedItem = null;

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
                <div class="existing-img-tag-filter" style="margin-top:8px;">
                    <label style="display:block; font-size:0.82rem; color:var(--wiki-text-muted,#888); margin-bottom:4px; text-align:left;">
                        <i class="mdi mdi-tag-multiple-outline"></i> 태그 검색
                    </label>
                    <div class="category-tag-container" id="existingImgTagContainer" style="max-width:100%;">
                        <input type="text" id="existingImgTagInput" class="category-tag-input" placeholder="(엔터/쉼표로 추가)">
                    </div>
                </div>
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
            const input = document.getElementById('existingImgSearchInput');
            const searchBtn = document.getElementById('existingImgSearchBtn');
            const moreBtn = document.getElementById('existingImgMoreBtn');

            const doSearch = (reset) => {
                if (reset) {
                    offset = 0;
                    items = [];
                    finished = false;
                    currentQuery = input.value.trim();
                    currentTags = tagWidget ? tagWidget.getTags() : [];
                }
                loadPage();
            };

            tagWidget = mountMediaTagInput({
                container: document.getElementById('existingImgTagContainer'),
                input: document.getElementById('existingImgTagInput'),
                initial: [],
            });
            tagWidget.setOnChange(() => doSearch(true));

            searchBtn.addEventListener('click', () => doSearch(true));
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); doSearch(true); }
            });
            moreBtn.addEventListener('click', () => loadPage());

            doSearch(true);
        },
        willClose: () => { if (tagWidget) tagWidget.destroy(); },
        preConfirm: () => pickedItem,
    });

    async function loadPage() {
        if (loading || finished) return;
        loading = true;
        const grid = document.getElementById('existingImgSearchGrid');
        const info = document.getElementById('existingImgSearchInfo');
        const moreWrap = document.getElementById('existingImgSearchMore');

        if (offset === 0) {
            grid.innerHTML = '<div class="existing-img-search-empty">불러오는 중...</div>';
        }
        try {
            const params = new URLSearchParams();
            if (currentQuery) params.set('q', currentQuery);
            if (currentTags && currentTags.length > 0) params.set('tags', currentTags.join(','));
            params.set('limit', String(limit));
            params.set('offset', String(offset));

            const res = await fetch(`/api/media/search?${params.toString()}`);
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || '검색 실패');
            }
            const data = await res.json();
            total = data.total || 0;
            const fetched = data.items || [];
            if (offset === 0) items = [];
            items = items.concat(fetched);
            offset += fetched.length;
            if (fetched.length < limit || items.length >= total) finished = true;

            renderGrid(grid);
            info.textContent = total > 0
                ? `총 ${total}개 중 ${items.length}개 표시`
                : '결과가 없습니다.';
            moreWrap.style.display = finished ? 'none' : '';
        } catch (err) {
            grid.innerHTML = `<div class="existing-img-search-empty text-danger">${escapeHtml(err.message)}</div>`;
        } finally {
            loading = false;
        }
    }

    function renderGrid(grid) {
        if (!items.length) {
            grid.innerHTML = '<div class="existing-img-search-empty">이미지가 없습니다.</div>';
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

        grid.querySelectorAll('.existing-img-tile').forEach((tile) => {
            tile.addEventListener('click', async () => {
                const id = Number(tile.dataset.id);
                const picked = items.find((it) => it.id === id);
                if (!picked) return;
                const size = await askImageSize(picked);
                if (size === null) return;
                Swal.close();
                const altBase = picked.filename.replace(/\.[^.]+$/, '');
                callback(picked.url, altBase, size);
            });
        });
    }

    async function askImageSize(picked) {
        const result = await Swal.fire({
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
                const sel = document.querySelector('input[name="existingImgSize"]:checked');
                return sel ? sel.value : 'full';
            },
        });
        return result.isConfirmed ? (result.value || 'full') : null;
    }
}

// ── 미디어 업로드 처리 ──
// mountMediaTagInput은 common.js에서 제공한다.
async function handleImageUpload(blob, callback) {
    if (!blob) return;

    if (blob.size > 15 * 1024 * 1024) {
        Swal.fire('오류', '파일 크기는 15MB 이하만 허용됩니다.', 'warning');
        return;
    }

    let selectedSize = 'full';

    // 이미지인 경우 편집기를 먼저 실행 (동영상은 바로 업로드)
    if (blob.type && !blob.type.startsWith('video/') && typeof ImageEditor !== 'undefined') {
        const editResult = await ImageEditor.open(blob);
        if (!editResult) return; // 편집 취소
        blob = new File([editResult.blob], blob.name || 'image', { type: editResult.blob.type });
        selectedSize = editResult.size || 'full';
    }

    // 사용자에게 파일명 + 태그 입력 요청
    const originalName = blob.name || 'image';
    const nameWithoutExt = originalName.replace(/\.[^.]+$/, '');
    const nameDefaultAttr = String(nameWithoutExt).replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));

    let tagWidget = null;
    const { value: formResult, isConfirmed } = await Swal.fire({
        title: '이미지 업로드',
        html: `
            <div style="text-align:left;">
                <label for="uploadFilenameInput" class="form-label fw-bold" style="display:block; margin-bottom:4px;">파일명 (확장자 제외)</label>
                <input type="text" id="uploadFilenameInput" class="swal2-input" style="margin:0 0 14px 0; width:100%;" placeholder="파일명을 입력하세요" value="${nameDefaultAttr}" maxlength="100">
                <label class="form-label fw-bold" style="display:block; margin-bottom:4px;">태그 (선택)</label>
                <div class="category-tag-container" id="uploadTagContainer" style="max-width:100%;">
                    <input type="text" id="uploadTagInput" class="category-tag-input" placeholder="태그 입력 후 엔터나 쉼표">
                </div>
                <div class="form-text text-muted" style="margin-top:4px; font-size:0.82rem;">한글/영문/숫자/공백/_/./- 만 사용 가능 · 최대 20개</div>
            </div>
        `,
        showCancelButton: true,
        confirmButtonText: '업로드',
        cancelButtonText: '취소',
        focusConfirm: false,
        didOpen: () => {
            const fnInput = document.getElementById('uploadFilenameInput');
            fnInput.focus();
            fnInput.select();
            tagWidget = mountMediaTagInput({
                container: document.getElementById('uploadTagContainer'),
                input: document.getElementById('uploadTagInput'),
                initial: [],
            });
        },
        willClose: () => { if (tagWidget) tagWidget.destroy(); },
        preConfirm: () => {
            const fn = document.getElementById('uploadFilenameInput').value.trim();
            if (!fn) {
                Swal.showValidationMessage('파일명을 입력해주세요.');
                return false;
            }
            if (tagWidget) tagWidget.flush();
            return { filename: fn, tags: tagWidget ? tagWidget.getTags() : [] };
        },
    });

    if (!isConfirmed || !formResult) return;
    const customFilename = formResult.filename;
    const uploadTags = formResult.tags || [];

    const formData = new FormData();
    formData.append('file', blob);
    formData.append('filename', customFilename);
    if (uploadTags.length > 0) {
        formData.append('tags', JSON.stringify(uploadTags));
    }

    try {
        const res = await fetch('/api/media', {
            method: 'POST',
            body: formData,
        });

        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || '업로드 실패');
        }

        const data = await res.json();

        // callback(url, altText, size)
        callback(data.url, data.filename, selectedSize);

    } catch (err) {
        console.error(err);
        Swal.fire('오류', err.message, 'error');
    }
}

// ── 이미지 편집기 (크롭 + 90도 회전, 터치 지원) ──
// ══════════════════════════════════════════════════
const ImageEditor = (() => {
    let modal, canvas, ctx;
    let originalImg = null;       // 원본 Image 객체
    let currentImg = null;        // 현재 편집 상태 Image
    let rotation = 0;             // 누적 회전 (0, 90, 180, 270)
    let cropMode = false;
    let crop = { x: 0, y: 0, w: 0, h: 0 }; // 캔버스 좌표 기준
    let resolvePromise = null;
    let originalBlob = null;
    let selectedSize = 'full';

    function init() {
        modal = new bootstrap.Modal(document.getElementById('imageEditorModal'));
        canvas = document.getElementById('imgEditorCanvas');
        ctx = canvas.getContext('2d');

        document.getElementById('btnRotateLeft').addEventListener('click', () => rotate(-90));
        document.getElementById('btnRotateRight').addEventListener('click', () => rotate(90));
        document.getElementById('btnCropToggle').addEventListener('click', toggleCrop);
        document.getElementById('btnCropApply').addEventListener('click', applyCrop);
        document.getElementById('btnImgReset').addEventListener('click', resetImage);
        document.getElementById('btnImgEditorDone').addEventListener('click', finishEdit);

        // 사이즈 드롭다운 이벤트 연동
        const dropdownItems = document.querySelectorAll('#imgEditorSizeDropdown .dropdown-item');
        if (dropdownItems.length) {
            dropdownItems.forEach(item => {
                item.addEventListener('click', (e) => {
                    e.preventDefault();
                    const size = e.currentTarget.dataset.size;
                    const label = e.currentTarget.innerHTML;
                    selectedSize = size;
                    document.getElementById('btnImgEditorSizeToggle').innerHTML = label;
                });
            });
        }

        document.getElementById('imageEditorModal').addEventListener('hidden.bs.modal', () => {
            if (resolvePromise) {
                resolvePromise(null);
                resolvePromise = null;
            }
        });

        initCropInteraction();
    }

    // 외부에서 호출: 이미지 파일 → 편집 모달 → 편집된 Blob 반환
    function open(blob) {
        originalBlob = blob;
        rotation = 0;
        cropMode = false;
        selectedSize = 'full';
        const toggleBtn = document.getElementById('btnImgEditorSizeToggle');
        if (toggleBtn) {
            toggleBtn.innerHTML = '<i class="mdi mdi-arrow-expand-all me-1"></i>크게(기본)';
        }
        document.getElementById('cropOverlay').style.display = 'none';
        document.getElementById('btnCropToggle').classList.remove('active');
        document.getElementById('btnCropApply').style.display = 'none';

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
                modal.show();
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                resolve(null);
            };
            img.src = url;
        });
    }

    function drawImage() {
        if (!currentImg) return;
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

    function rotate(deg) {
        exitCropMode();
        rotation = (rotation + deg + 360) % 360;
        drawImage();
    }

    function resetImage() {
        exitCropMode();
        currentImg = originalImg;
        rotation = 0;
        drawImage();
    }

    function toggleCrop() {
        if (cropMode) {
            exitCropMode();
        } else {
            enterCropMode();
        }
    }

    function enterCropMode() {
        cropMode = true;
        document.getElementById('btnCropToggle').classList.add('active');
        document.getElementById('btnCropApply').style.display = '';

        const overlay = document.getElementById('cropOverlay');
        const wrap = document.getElementById('imgEditorCanvasWrap');
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

    function exitCropMode() {
        cropMode = false;
        document.getElementById('btnCropToggle').classList.remove('active');
        document.getElementById('btnCropApply').style.display = 'none';
        document.getElementById('cropOverlay').style.display = 'none';
    }

    function updateCropBox() {
        const box = document.getElementById('cropBox');
        box.style.left = crop.x + 'px';
        box.style.top = crop.y + 'px';
        box.style.width = crop.w + 'px';
        box.style.height = crop.h + 'px';
    }

    function applyCrop() {
        if (!cropMode) return;

        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;

        const sx = Math.round(crop.x * scaleX);
        const sy = Math.round(crop.y * scaleY);
        const sw = Math.round(crop.w * scaleX);
        const sh = Math.round(crop.h * scaleY);

        if (sw < 10 || sh < 10) {
            Swal.fire('오류', '크롭 영역이 너무 작습니다.', 'warning');
            return;
        }

        // 현재 캔버스 → 크롭 데이터 추출
        const tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = sw;
        tmpCanvas.height = sh;
        const tmpCtx = tmpCanvas.getContext('2d');
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
    function initCropInteraction() {
        const overlay = document.getElementById('cropOverlay');
        const cropBox = document.getElementById('cropBox');
        let dragging = null; // null | 'move' | 'tl' | 'tr' | 'bl' | 'br'
        let startPos = { x: 0, y: 0 };
        let startCrop = {};

        function getPos(e) {
            const t = e.touches ? e.touches[0] : e;
            const rect = overlay.getBoundingClientRect();
            return { x: t.clientX - rect.left, y: t.clientY - rect.top };
        }

        function onStart(e) {
            const target = e.target;
            if (target.classList.contains('crop-handle')) {
                dragging = target.dataset.handle;
            } else if (target.id === 'cropBox' || target.closest('#cropBox')) {
                dragging = 'move';
            } else {
                return;
            }
            e.preventDefault();
            startPos = getPos(e);
            startCrop = { ...crop };
        }

        function onMove(e) {
            if (!dragging) return;
            e.preventDefault();
            const pos = getPos(e);
            const dx = pos.x - startPos.x;
            const dy = pos.y - startPos.y;

            const overlayRect = overlay.getBoundingClientRect();
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

        function onEnd() {
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

    function finishEdit() {
        // 캔버스 → Blob
        const mimeType = originalBlob.type && originalBlob.type.startsWith('image/')
            ? originalBlob.type : 'image/png';
        const quality = mimeType === 'image/jpeg' ? 0.92 : undefined;

        canvas.toBlob((blob) => {
            if (resolvePromise) {
                resolvePromise({ blob, size: selectedSize });
                resolvePromise = null;
            }
            modal.hide();
        }, mimeType, quality);
    }

    function updateInfo() {
        const info = document.getElementById('imgEditorInfo');
        if (canvas.width && canvas.height) {
            info.textContent = `${canvas.width} × ${canvas.height}px`;
        }
    }

    // DOM 로드 후 초기화
    setTimeout(init, 300);

    return { open };
})();
