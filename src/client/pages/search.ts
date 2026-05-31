// @ts-nocheck — search.html 의 인라인 classic <script> 를 동작 보존 우선으로 이관한
// 모듈이다. common.ts 와 동일한 사유(CDN 글로벌 의존, 광범위한 DOM/Element 캐스팅,
// any 형태의 fetch 응답 처리)로 1차 이관 단계에서는 타입 검사를 끈다.
//
// 이관 규칙:
//  - common.ts 가 window.* 로 노출하는 공통 전역(loadConfig / checkAuth /
//    loadRecentChanges / currentUser / escapeHtml)은 모듈 스코프에서 bare 식별자로
//    해석되지 않으므로 모두 window.* 로 접근한다. (특히 `typeof loadConfig` 는 모듈
//    스코프에서 window 에 값이 있어도 'undefined' 가 되므로 `typeof window.loadConfig`)
//  - HTML 의 onclick 속성에서 호출되는 함수(goImageSearch / goCategorySearch)는
//    파일 끝에서 window.* 로 노출한다.

// 모바일 전용 "최근 변경" 사이드바 로더. (기존 .wiki-article 내부 인라인 블록)
document.addEventListener('DOMContentLoaded', async function () {
    if (!document.querySelector('.recent-changes-container') || window.__searchRecentChangesLoaded) {
        return;
    }

    window.__searchRecentChangesLoaded = true;

    if (typeof window.loadConfig === 'function') {
        await window.loadConfig();
    }

    if (typeof window.checkAuth === 'function') {
        await window.checkAuth();
    }

    if (typeof window.loadRecentChanges === 'function') {
        await window.loadRecentChanges();
    }
});

// 페이지네이션은 서버에서 LIMIT/OFFSET 으로 처리한다. 페이지 크기는 /api/search 응답의 pageSize 를 신뢰한다.
// 같은 (q, mode, page) 조합을 세션 내에서 재방문(뒤로가기 등)할 때 중복 API 호출을 피하기 위한 메모리 캐시.
let currentQuery = '';
let currentMode = 'content';
const responseCache = new Map();
const IMAGE_PREFIX = '이미지:';
const CATEGORY_PREFIX = '카테고리:';

// 검색어에 네임스페이스 prefix 를 보장한 뒤 재검색한다. 다른 네임스페이스 prefix 가
// 이미 붙어 있으면 제거하고 새 prefix 를 적용해 모드 간 전환을 매끄럽게 한다.
function goNamespaceSearch(prefix) {
    const params = new URLSearchParams(window.location.search);
    const headerInput = document.getElementById('searchInput');
    const rawBaseQuery = (headerInput && headerInput.value.trim()) || params.get('q') || currentQuery || '';
    let baseQuery = rawBaseQuery.trim();
    for (const other of [IMAGE_PREFIX, CATEGORY_PREFIX]) {
        if (other !== prefix && baseQuery.startsWith(other)) {
            baseQuery = baseQuery.slice(other.length).trim();
            break;
        }
    }
    const next = baseQuery.startsWith(prefix) ? baseQuery : (prefix + baseQuery);
    if (headerInput) headerInput.value = next;
    window.location.href = `/search?q=${encodeURIComponent(next)}&mode=content`;
}

// 상단 "이미지 검색하기" 버튼: 현재 검색어 맨 앞에 "이미지:"를 붙여 재검색한다.
function goImageSearch() {
    goNamespaceSearch(IMAGE_PREFIX);
}

// 상단 "카테고리 검색하기" 버튼: 현재 검색어 맨 앞에 "카테고리:"를 붙여 재검색한다.
function goCategorySearch() {
    goNamespaceSearch(CATEGORY_PREFIX);
}
// 진행 중인 fetch 를 추적해 새 요청이 시작될 때 이전 요청을 취소한다.
// 이전 요청이 늦게 완료되어 현재 UI 를 덮어쓰는 경쟁 상태를 방지한다.
let activeAbortController = null;
const CACHE_CAPACITY = 30;

function cacheKey(q, mode, page) {
    // 사용자 ID·역할을 키에 포함해 권한이 다른 세션 간 캐시 재사용을 방지한다.
    // (예: 관리자가 조회한 삭제/비공개 문서가 권한 변경 후에도 캐시에서 노출되는 상황 차단)
    const uid = window.currentUser ? `${window.currentUser.id}\u0000${window.currentUser.role}` : 'anon';
    return `${q}\u0000${mode}\u0000${page}\u0000${uid}`;
}

function cacheGet(q, mode, page) {
    const key = cacheKey(q, mode, page);
    if (!responseCache.has(key)) return null;
    // LRU: 최근 사용 항목을 Map 뒤로 이동
    const val = responseCache.get(key);
    responseCache.delete(key);
    responseCache.set(key, val);
    return val;
}

function cacheSet(q, mode, page, data) {
    const key = cacheKey(q, mode, page);
    if (responseCache.has(key)) responseCache.delete(key);
    responseCache.set(key, data);
    while (responseCache.size > CACHE_CAPACITY) {
        const oldestKey = responseCache.keys().next().value;
        responseCache.delete(oldestKey);
    }
}

function setNoResultsState(title, description) {
    const noResultsEl = document.getElementById('noResults');
    if (!noResultsEl) return;
    const titleEl = noResultsEl.querySelector('h4');
    const descriptionEl = noResultsEl.querySelector('p');
    if (titleEl) titleEl.textContent = title;
    if (descriptionEl) descriptionEl.textContent = description;
}

document.addEventListener('DOMContentLoaded', async () => {
    await Promise.all([window.loadConfig(), window.checkAuth()]);
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q') || '';
    const mode = params.get('mode') || 'content';
    const page = getCurrentPage();

    currentQuery = q;
    currentMode = mode;

    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.value = q;
    document.getElementById('searchQuery').textContent = q ? `"${q}" 검색 결과` : '';

    if (q) {
        performSearch(q, mode, page);
    } else {
        document.getElementById('loading').classList.add('d-none');
    }
});

// popstate: 뒤/앞 브라우저 이동 시 캐시 우선으로 렌더링(미스 시 재요청)한다.
window.addEventListener('popstate', () => {
    if (!currentQuery) return;
    performSearch(currentQuery, currentMode, getCurrentPage());
});

function getCurrentPage() {
    const params = new URLSearchParams(window.location.search);
    const p = parseInt(params.get('page') || '1', 10);
    return Number.isFinite(p) && p >= 1 ? p : 1;
}

async function performSearch(q, mode, page) {
    const loadingEl = document.getElementById('loading');
    const noResultsEl = document.getElementById('noResults');
    const listEl = document.getElementById('resultsList');

    // 캐시 히트: 네트워크 호출 없이 즉시 렌더 (이전 요청도 취소한다)
    const cached = cacheGet(q, mode, page);
    if (cached) {
        if (activeAbortController) {
            activeAbortController.abort();
            activeAbortController = null;
        }
        loadingEl.classList.add('d-none');
        noResultsEl.classList.add('d-none');
        renderSearchResponse(q, page, cached);
        return;
    }

    // 이전 요청이 아직 진행 중이면 취소한다.
    if (activeAbortController) {
        activeAbortController.abort();
    }
    const controller = new AbortController();
    activeAbortController = controller;

    loadingEl.classList.remove('d-none');
    noResultsEl.classList.add('d-none');

    try {
        const res = await fetch(
            `/api/search?q=${encodeURIComponent(q)}&mode=${encodeURIComponent(mode)}&page=${encodeURIComponent(page)}`,
            { signal: controller.signal }
        );

        if (!res.ok) {
            let errorMessage = `검색 요청에 실패했습니다. (HTTP ${res.status})`;

            try {
                const errorData = await res.json();
                if (errorData && typeof errorData.message === 'string' && errorData.message.trim()) {
                    errorMessage = errorData.message;
                } else if (errorData && typeof errorData.error === 'string' && errorData.error.trim()) {
                    errorMessage = errorData.error;
                }
            } catch (parseError) {
                console.debug('검색 오류 응답 파싱 실패', parseError);
                // 오류 응답이 JSON이 아닐 수 있으므로 기본 메시지를 유지한다.
            }

            throw new Error(errorMessage);
        }

        const data = await res.json();

        // 이 응답이 반환됐을 때 이미 더 새로운 요청이 시작된 경우(controller 가 교체된 경우) 렌더를 건너뛴다.
        if (activeAbortController !== controller) return;
        activeAbortController = null;

        loadingEl.classList.add('d-none');
        cacheSet(q, mode, page, data);
        renderSearchResponse(q, page, data);
    } catch (err) {
        // AbortError 는 의도적 취소이므로 UI 를 건드리지 않는다.
        if (err.name === 'AbortError') return;
        loadingEl.classList.add('d-none');
        listEl.innerHTML = '';
        setNoResultsState('검색 요청에 실패했습니다', err instanceof Error && err.message
            ? err.message
            : '잠시 후 다시 시도해 주세요.');
        noResultsEl.classList.remove('d-none');
        console.error('검색 실패', err);
    }
}

function renderSearchResponse(q, requestedPage, data) {
    const listEl = document.getElementById('resultsList');
    const noResultsEl = document.getElementById('noResults');

    const total = data.total ?? (data.results ? data.results.length : 0);
    const pageSize = data.pageSize || 10;
    const currentPage = data.page || requestedPage || 1;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    // 서버가 범위 밖 page 를 마지막 페이지로 클램프한 경우 URL 도 동기화한다.
    if (total > 0 && currentPage !== requestedPage) {
        const params = new URLSearchParams(window.location.search);
        params.set('page', String(currentPage));
        history.replaceState({}, '', `?${params.toString()}`);
    }

    // 서버가 페이지네이션과 무관하게 정확 일치 존재 여부를 exact_match 로 알려준다.
    // (정확 일치 슬러그가 페이지 2 이후로 밀려나도 false-positive CTA 가 뜨지 않게 함)
    // 추가로 SQLite LOWER() 가 ASCII-only 라 비-ASCII 케이스 변형(예: 'Äpfel' vs 'äpfel')은
    // 서버 플래그가 놓칠 수 있어, 결과 페이지 내 슬러그를 JS toLowerCase() 로 한 번 더 검사해 보완한다.
    // "이미지:" 네임스페이스는 일반 문서 슬러그로 저장이 거부되므로 CTA 를 숨긴다.
    const normalizedQuery = q.trim().toLowerCase();
    const hasUnicodeExactMatchInResults = Array.isArray(data.results)
        && normalizedQuery !== ''
        && data.results.some(result =>
            typeof result?.slug === 'string'
            && result.slug.trim().toLowerCase() === normalizedQuery
        );
    const hasExactMatch = !!data.exact_match || hasUnicodeExactMatchInResults;
    const queryTrimmed = q.trim();
    const isImageNamespaceQuery = queryTrimmed.startsWith('이미지:');
    // "map:" 은 하위 문서 트리 + TOC 를 합성해 보여주는 예약 가상 뷰라 실제 문서로 생성할 수 없다.
    // 따라서 "새 문서 만들기" CTA 대신 해당 가상 뷰(/w/map:<base>)로 이동하는 버튼만 노출한다.
    // (가상 뷰는 하위 문서가 있으면 트리가 그려지므로 문서 존재 여부와 무관하게 이동 버튼을 제공)
    const isMapNamespaceQuery = queryTrimmed.startsWith('map:');
    // 이동 대상은 위키 링크 [[...]] 와 동일하게 slug 기준의 문서 조회 경로(/w/<slug>)다.
    const gotoUrl = `/w/${encodeURIComponent(queryTrimmed)}`;
    // category_mode 응답일 때는 카테고리 가상 문서가 결과에 노출되므로 "새 문서 만들기" CTA 를 숨긴다.
    // "카테고리:" prefix 인데 page_categories 매치가 없어 일반 검색으로 폴스루된 경우에는
    // 사용자가 카테고리 설명 문서를 직접 생성하도록 CTA 를 허용한다.
    const canCreate = window.currentUser && window.currentUser.role !== 'banned'
        && !data.image_mode && !data.category_mode && !isImageNamespaceQuery;

    let ctaHtml = '';
    if (queryTrimmed !== '' && currentPage === 1) {
        if (isMapNamespaceQuery) {
            // map: 가상 뷰는 생성 불가 — 이동 버튼만 노출(존재 여부와 무관, 일반 검색 폴스루 시에도 동일).
            ctaHtml = `
        <div class="mb-4">
            <div class="alert alert-light border d-flex justify-content-between align-items-center gap-2">
                <span><strong>"${window.escapeHtml(queryTrimmed)}"</strong> 문서 구조 보기로 이동할 수 있습니다.</span>
                <a class="btn btn-wiki" href="${gotoUrl}">
                    <i class="bi bi-diagram-3"></i> 해당 문서로 이동
                </a>
            </div>
        </div>`;
        } else if (!hasExactMatch && !data.image_mode && !data.category_mode && !isImageNamespaceQuery) {
            // 정확 일치 문서가 없을 때: 위키 링크 [[...]] 로 바로 이동 + (권한 있으면) 새 문서 만들기 동시 노출.
            const gotoBtn = `<a class="btn btn-wiki-outline" href="${gotoUrl}">
                    <i class="bi bi-box-arrow-up-right"></i> ${window.escapeHtml(queryTrimmed)}로 이동
                </a>`;
            const createBtn = canCreate
                ? `<button class="btn btn-wiki" onclick="window.location.href='/edit?slug=${encodeURIComponent(queryTrimmed).replace(/'/g, "%27")}'">
                    <i class="bi bi-pencil-square"></i> 새 문서 만들기
                </button>`
                : '';
            ctaHtml = `
        <div class="mb-4">
            <div class="alert alert-light border d-flex justify-content-between align-items-center gap-2">
                <span><strong>"${window.escapeHtml(queryTrimmed)}"</strong> 문서가 아직 존재하지 않습니다.</span>
                <div class="d-flex gap-2 flex-shrink-0">${gotoBtn}${createBtn}</div>
            </div>
        </div>`;
        }
    }

    if (!data.results || data.results.length === 0) {
        setNoResultsState('검색 결과가 없습니다', '다른 키워드로 검색해 보세요.');
        noResultsEl.classList.remove('d-none');
        listEl.innerHTML = ctaHtml;
        document.getElementById('searchTitle').innerHTML =
            `<i class="mdi mdi-magnify"></i> 검색 결과`;
        return;
    }

    let itemsHtml = '';
    if (data.image_mode) {
        // 이미지 문서 검색 결과: 섬네일 + 파일명 + 태그 + content 미리보기
        // contentPreviewLength는 서버의 IMAGE_CONTENT_PREVIEW와 동기화된 값이다.
        const CONTENT_MAX = data.contentPreviewLength || 200;
        itemsHtml = data.results.map(r => {
            const isVideo = (r.mime_type || '').startsWith('video/');
            const url = r.r2_key ? `/media/${r.r2_key}` : '';
            const preview = isVideo
                ? `<video src="${window.escapeHtml(url)}" muted class="search-image-thumb"></video>`
                : `<img src="${window.escapeHtml(url)}" alt="${window.escapeHtml(r.slug)}" class="search-image-thumb" loading="lazy">`;
            const tagsHtml = Array.isArray(r.tags) && r.tags.length > 0
                ? `<div class="search-image-tags mb-2">${r.tags.map(t => `<span class="badge bg-light text-dark border me-1 mb-1"><i class="mdi mdi-tag-outline"></i> ${window.escapeHtml(t)}</span>`).join('')}</div>`
                : '';
            // content는 서버에서 이미 절단되어 내려오지만,
            // 혹시 더 긴 값이 들어오는 경우를 대비해 클라이언트에서도 안전장치로 재절단한다.
            const rawContent = (r.content || '').toString();
            const contentText = rawContent.length > CONTENT_MAX
                ? rawContent.slice(0, CONTENT_MAX) + '...'
                : rawContent;
            const contentHtml = contentText
                ? `<p class="search-image-content text-body-secondary mb-0">${window.escapeHtml(contentText)}</p>`
                : '';
            const snippetHtml = r.snippet
                ? `<p class="snippet text-body mb-2" style="line-height: 1.6;">${r.snippet}</p>`
                : '';
            return `
                <div class="search-result-item mb-4 pb-3 border-bottom d-flex gap-3 align-items-start">
                    ${preview}
                    <div class="search-result-body">
                        <h4 class="mb-2 fs-5">
                            <a class="text-decoration-none text-primary fw-semibold" href="/w/${encodeURIComponent(r.slug)}">${window.escapeHtml(r.slug)}</a>
                        </h4>
                        ${snippetHtml}
                        ${tagsHtml}
                        ${contentHtml}
                    </div>
                </div>
            `;
        }).join('');
    } else if (data.category_mode) {
        // "카테고리:" prefix 검색 결과: 카테고리를 가상 문서로 노출. 설명 문서가 없는
        // 카테고리도 포함되며, 클릭 시 /w/카테고리:<이름> 의 가상 카테고리 페이지로 이동한다.
        itemsHtml = data.results.map(r => {
            const descBadge = r.has_description
                ? '<span class="badge bg-light text-dark border ms-2">설명 있음</span>'
                : '<span class="badge bg-light text-muted border ms-2">설명 없음</span>';
            const countText = typeof r.page_count === 'number'
                ? `<p class="text-body-secondary mb-0 small"><i class="mdi mdi-file-document-multiple-outline"></i> ${r.page_count}개 문서</p>`
                : '';
            return `
            <div class="search-result-item mb-3 pb-2 border-bottom">
                <h4 class="mb-1 fs-5">
                    <a class="text-decoration-none text-primary fw-semibold" href="/w/${encodeURIComponent(r.slug)}">
                        <i class="mdi mdi-folder-outline"></i> ${window.escapeHtml(r.slug)}
                    </a>
                    ${descBadge}
                </h4>
                ${countText}
            </div>`;
        }).join('');
    } else if (data.mode === 'category') {
        // 카테고리 검색 결과: 스니펫 없이 슬러그(=제목) 목록
        itemsHtml = data.results.map(r => `
            <div class="search-result-item mb-3 pb-2 border-bottom">
                <h4 class="mb-0 fs-5">
                    <a class="text-decoration-none text-primary fw-semibold" href="/w/${encodeURIComponent(r.slug)}">${window.escapeHtml(r.slug)}</a>
                    ${r.isDeleted ? '<span class="badge bg-danger ms-2">삭제됨</span>' : ''}
                </h4>
            </div>
        `).join('');
    } else {
        // 슬러그+본문 검색 결과. r.title 이 있으면 표시 이름으로 사용하고 슬러그를 보조 라벨로.
        // 클릭해 문서로 들어가면 매칭된 단어로 자동 스크롤·하이라이트하도록 ?highlight= 를 붙인다.
        // (삭제된 문서는 본문이 렌더되지 않으므로 파라미터를 생략한다.)
        const highlightTerm = (q || '').trim();
        const highlightQS = highlightTerm
            ? `?highlight=${encodeURIComponent(highlightTerm)}`
            : '';
        itemsHtml = data.results.map(r => {
            const displayName = r.title || r.slug;
            const slugSubLabel = r.title
                ? `<div class="small text-muted mt-1"><code>${window.escapeHtml(r.slug)}</code></div>`
                : '';
            const href = `/w/${encodeURIComponent(r.slug)}${r.isDeleted ? '' : highlightQS}`;
            return `
            <div class="search-result-item mb-4 pb-3 border-bottom">
                <h4 class="mb-2 fs-5">
                    <a class="text-decoration-none text-primary fw-semibold" href="${href}">${window.escapeHtml(displayName)}</a>
                    ${r.isDeleted ? '<span class="badge bg-danger ms-2">삭제됨</span>' : ''}
                </h4>
                ${slugSubLabel}
                <p class="snippet text-body mb-0" style="line-height: 1.6;">${r.snippet || ''}</p>
            </div>`;
        }).join('');
    }

    const paginationHtml = renderPagination(currentPage, totalPages);
    listEl.innerHTML = ctaHtml + itemsHtml + paginationHtml;

    document.getElementById('searchTitle').innerHTML =
        `<i class="mdi mdi-magnify"></i> 검색 결과 (${total}건)`;
}

// 현재 페이지 기준 ±WINDOW 만 노출, 양 끝은 1/totalPages 를 고정하고 사이 간격은 ellipsis 로 축약.
// 결과 건수가 많아도 DOM 노드 수가 상수 수준으로 유지된다.
function renderPagination(currentPage, totalPages) {
    if (totalPages <= 1) return '';

    const WINDOW = 2;
    const buildUrl = (p) => {
        const params = new URLSearchParams(window.location.search);
        params.set('page', String(p));
        return `?${params.toString()}`;
    };
    const clamp = (p) => Math.min(Math.max(1, p), totalPages);

    const prevDisabled = currentPage === 1;
    const nextDisabled = currentPage === totalPages;
    // disabled 상태에서는 경계 밖 URL 이 생성되지 않도록 href=# + data-page 도 현재 페이지로 고정한다.
    const prevPage = prevDisabled ? currentPage : clamp(currentPage - 1);
    const nextPage = nextDisabled ? currentPage : clamp(currentPage + 1);
    const prevHref = prevDisabled ? '#' : buildUrl(prevPage);
    const nextHref = nextDisabled ? '#' : buildUrl(nextPage);

    const items = [];
    items.push(`
        <li class="page-item ${prevDisabled ? 'disabled' : ''}">
            <a class="page-link" href="${prevHref}" data-page="${prevPage}" aria-label="이전"${prevDisabled ? ' tabindex="-1" aria-disabled="true"' : ''}>
                <span aria-hidden="true">&laquo;</span>
            </a>
        </li>
    `);

    // 현재 페이지 주변의 페이지 번호 계산
    const pages = new Set();
    pages.add(1);
    pages.add(totalPages);
    for (let p = currentPage - WINDOW; p <= currentPage + WINDOW; p++) {
        if (p >= 1 && p <= totalPages) pages.add(p);
    }
    const sorted = Array.from(pages).sort((a, b) => a - b);

    let prev = 0;
    for (const p of sorted) {
        if (prev && p - prev > 1) {
            items.push(`
                <li class="page-item disabled">
                    <span class="page-link">&hellip;</span>
                </li>
            `);
        }
        const pageControl = p === currentPage
            ? `<span class="page-link" aria-current="page">${p}</span>`
            : `<a class="page-link" href="${buildUrl(p)}" data-page="${p}">${p}</a>`;
        items.push(`
            <li class="page-item ${p === currentPage ? 'active' : ''}">
                ${pageControl}
            </li>
        `);
        prev = p;
    }

    items.push(`
        <li class="page-item ${nextDisabled ? 'disabled' : ''}">
            <a class="page-link" href="${nextHref}" data-page="${nextPage}" aria-label="다음"${nextDisabled ? ' tabindex="-1" aria-disabled="true"' : ''}>
                <span aria-hidden="true">&raquo;</span>
            </a>
        </li>
    `);

    return `
        <nav aria-label="검색 결과 페이지" class="mt-4">
            <ul class="pagination justify-content-center" id="searchPagination">
                ${items.join('')}
            </ul>
        </nav>
    `;
}

// 페이지네이션 링크 클릭: URL 갱신 후 해당 페이지를 서버에서 재조회(캐시 히트 시 네트워크 생략)
document.addEventListener('click', (e) => {
    const link = e.target.closest('#searchPagination .page-link');
    if (!link) return;
    const li = link.closest('.page-item');
    if (!li || li.classList.contains('disabled') || li.classList.contains('active')) {
        e.preventDefault();
        return;
    }
    const page = parseInt(link.getAttribute('data-page') || '1', 10);
    if (!Number.isFinite(page) || page < 1) return;
    e.preventDefault();
    const params = new URLSearchParams(window.location.search);
    params.set('page', String(page));
    history.pushState({}, '', `?${params.toString()}`);
    performSearch(currentQuery, currentMode, page);
    window.scrollTo({ top: 0, behavior: 'smooth' });
});

// HTML onclick 속성에서 호출되므로 window 로 노출한다.
window.goImageSearch = goImageSearch;
window.goCategorySearch = goCategorySearch;
