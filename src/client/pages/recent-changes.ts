// @ts-nocheck — recent-changes.html 의 인라인 classic <script> 를 동작 보존 우선으로
// 이관한 모듈이다. common.ts 와 동일한 사유(CDN 글로벌 Swal, 광범위한 DOM 캐스팅,
// any 형태의 fetch 응답)로 1차 이관 단계에서는 타입 검사를 끈다.
//
// 이관 규칙:
//  - common.ts 가 window.* 로 노출하는 공통 전역(loadConfig / checkAuth /
//    loadRecentChanges / loadTrending / getRelativeTime / escapeHtml /
//    renderUserRoleIcon / initRoleIconPopovers)은 모듈 스코프에서 bare 식별자로
//    해석되지 않으므로 window.* 로 접근한다.
//  - HTML onclick/onchange 속성에서 호출되는 함수(goToRecentPage / goToAllPage /
//    changeSort)는 파일 끝에서 window.* 로 노출한다.

// ── 전역 상태 ──
const PAGE_SIZE = 10;
let currentRecentPage = 1;
let totalRecentPages = 0;
let recentRevisionsAbortController = null;

// 모든 문서 목록 상태
const ALL_PAGES_SIZE = 20;
let allPagesLoaded = false; // 탭 최초 로드 여부
let currentSort = 'slug_asc';
let currentAllPage = 1;
let totalAllPages = 0;
let allPagesAbortController = null;

// ── 초기화 ──
document.addEventListener('DOMContentLoaded', async () => {
  await window.loadConfig();
  await window.checkAuth();
  loadRecentRevisions();
  loadWikiStats();
  window.loadTrending();
  window.loadRecentChanges();

  // 모든 문서 목록 탭 클릭 시 최초 1회 로드
  document.getElementById('tab-allpages').addEventListener('shown.bs.tab', () => {
    if (!allPagesLoaded) {
      loadAllPages();
      allPagesLoaded = true;
    }
  });
});

// ── 위키 통계 로드 ──
async function loadWikiStats() {
  try {
    const res = await fetch('/api/w/wiki-stats');
    if (!res.ok) return;
    const data = await res.json();
    document.getElementById('statPageCount').textContent = Number(data.page_count).toLocaleString();
    document.getElementById('statRevisionCount').textContent = Number(data.revision_count).toLocaleString();
  } catch (e) {
    console.error('통계 로드 실패:', e);
  }
}

// ── 최근 수정 내역 로드 ──
async function loadRecentRevisions(page = 1) {
  if (recentRevisionsAbortController) {
    recentRevisionsAbortController.abort();
    recentRevisionsAbortController = null;
  }
  recentRevisionsAbortController = new AbortController();
  const signal = recentRevisionsAbortController.signal;

  const isInitial = totalRecentPages === 0;

  try {
    const listEl = document.getElementById('revisionsList');
    if (isInitial) {
      document.getElementById('loading').classList.remove('d-none');
      document.getElementById('mainContent').classList.add('d-none');
    } else {
      listEl.innerHTML = '<div class="text-center py-4"><div class="spinner-border spinner-border-sm text-primary" role="status"></div> 불러오는 중...</div>';
      document.getElementById('recentRevisionsPagination').classList.add('d-none');
    }

    const offset = (page - 1) * PAGE_SIZE;
    const res = await fetch(`/api/w/recent-revisions?offset=${offset}&limit=${PAGE_SIZE}`, { signal });
    if (!res.ok) throw new Error('최근 수정 내역 로딩 실패');

    const data = await res.json();
    currentRecentPage = page;
    totalRecentPages = Math.max(1, Math.ceil((data.total || 0) / PAGE_SIZE));

    if (data.revisions.length === 0 && data.total > 0 && page > totalRecentPages) {
      loadRecentRevisions(totalRecentPages);
      return;
    }

    const itemsHtml = data.revisions.map(rev => {
      const date = new Date(rev.created_at * 1000).toLocaleString('ko-KR');
      const timeAgo = window.getRelativeTime(rev.created_at);
      const versionLabel = rev.page_version != null ? `v${rev.page_version}` : `#${rev.id}`;

      return `
        <div class="revision-item d-flex align-items-center justify-content-between border-bottom py-2" style="flex-wrap: nowrap;">
          <div class="d-flex align-items-center gap-3 flex-grow-1" style="flex-wrap: nowrap; white-space: nowrap;">
            <span class="revision-date text-muted small" title="${window.escapeHtml(date)}" style="white-space: nowrap;">${timeAgo}</span>
            <a href="/w/${encodeURIComponent(rev.slug)}" class="text-decoration-none" style="white-space: nowrap;" title="${window.escapeHtml(rev.slug)}"
               onclick="event.preventDefault(); window.location.href=this.href;">
              ${window.escapeHtml(rev.slug)}
            </a>
            ${rev.author_id ? `<a href="/profile/${rev.author_id}" class="revision-author badge bg-light text-dark border text-decoration-none" style="white-space: nowrap;">${window.escapeHtml(rev.author_name || '알 수 없음')}${window.renderUserRoleIcon(rev.author_role)}</a>` : `<span class="revision-author badge bg-light text-dark border" style="white-space: nowrap;">${window.escapeHtml(rev.author_name || '알 수 없음')}${window.renderUserRoleIcon(rev.author_role)}</span>`}
            <span class="revision-summary" style="white-space: nowrap;">${window.escapeHtml(rev.summary || '(요약 없음)')}</span>
          </div>
          <div class="d-flex gap-2 ms-2" style="white-space: nowrap;">
            <span class="text-muted small">${versionLabel}</span>
            <a href="/w/${encodeURIComponent(rev.slug)}?mode=revisions" class="btn btn-rev-action btn-rev-view" title="편집 이력 보기">
              <i class="bi bi-clock-history"></i> 이력
            </a>
          </div>
        </div>
      `;
    }).join('');

    listEl.innerHTML = itemsHtml;

    // 빈 결과 처리
    if (data.revisions.length === 0) {
      listEl.innerHTML = '<div class="text-center text-muted py-5"><i class="bi bi-inbox fs-1 d-block mb-2"></i>최근 수정 내역이 없습니다.</div>';
    }

    renderRecentRevisionsPagination();

    document.getElementById('loading').classList.add('d-none');
    document.getElementById('mainContent').classList.remove('d-none');
    window.initRoleIconPopovers(listEl);

  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    document.getElementById('loading').classList.add('d-none');
    Swal.fire('오류', '최근 수정 내역을 불러오는 데 실패했습니다.', 'error');
  }
}

// ── 최근 수정 내역 페이지네이션 렌더링 ──
function renderRecentRevisionsPagination() {
  const nav = document.getElementById('recentRevisionsPagination');
  const ul = document.getElementById('recentRevisionsPaginationList');

  if (totalRecentPages <= 1) {
    nav.classList.add('d-none');
    ul.innerHTML = '';
    return;
  }

  nav.classList.remove('d-none');

  const pages = new Set([1, totalRecentPages]);
  for (let i = Math.max(2, currentRecentPage - 2); i <= Math.min(totalRecentPages - 1, currentRecentPage + 2); i++) {
    pages.add(i);
  }
  const sortedPages = [...pages].sort((a, b) => a - b);

  let html = `<li class="page-item ${currentRecentPage === 1 ? 'disabled' : ''}">
    <a class="page-link" href="#" ${currentRecentPage === 1 ? 'tabindex="-1" aria-disabled="true"' : ''} onclick="event.preventDefault(); goToRecentPage(${currentRecentPage - 1})">이전</a>
  </li>`;

  let prev = 0;
  for (const p of sortedPages) {
    if (prev && p - prev > 1) {
      html += `<li class="page-item disabled"><span class="page-link">…</span></li>`;
    }
    html += `<li class="page-item ${p === currentRecentPage ? 'active' : ''}">
      <a class="page-link" href="#" ${p === currentRecentPage ? 'aria-current="page"' : ''} onclick="event.preventDefault(); goToRecentPage(${p})">${p}</a>
    </li>`;
    prev = p;
  }

  html += `<li class="page-item ${currentRecentPage === totalRecentPages ? 'disabled' : ''}">
    <a class="page-link" href="#" ${currentRecentPage === totalRecentPages ? 'tabindex="-1" aria-disabled="true"' : ''} onclick="event.preventDefault(); goToRecentPage(${currentRecentPage + 1})">다음</a>
  </li>`;

  ul.innerHTML = html;
}

// ── 페이지 이동 (최근 수정 내역) ──
function goToRecentPage(page) {
  if (page < 1 || page > totalRecentPages) return;
  loadRecentRevisions(page);
  document.getElementById('pane-recent').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── 모든 문서 목록 로드 ──
async function loadAllPages(page = 1) {
  if (allPagesAbortController) {
    allPagesAbortController.abort();
    allPagesAbortController = null;
  }
  allPagesAbortController = new AbortController();
  const signal = allPagesAbortController.signal;

  try {
    const listEl = document.getElementById('allPagesList');
    const offset = (page - 1) * ALL_PAGES_SIZE;

    listEl.innerHTML = '<div class="text-center py-4"><div class="spinner-border spinner-border-sm text-primary" role="status"></div> 불러오는 중...</div>';
    document.getElementById('allPagesPagination').classList.add('d-none');

    const res = await fetch(`/api/w/all-pages?offset=${offset}&limit=${ALL_PAGES_SIZE}&sort=${currentSort}`, { signal });
    if (!res.ok) throw new Error('문서 목록 로딩 실패');

    const data = await res.json();
    currentAllPage = page;
    totalAllPages = Math.ceil(data.total / ALL_PAGES_SIZE);

    const showCategory = currentSort.startsWith('category');
    const showChars = currentSort.startsWith('chars');

    if (data.pages.length === 0) {
      if (data.total > 0) {
        loadAllPages(totalAllPages);
        return;
      }
      listEl.innerHTML = '<div class="text-center text-muted py-5"><i class="bi bi-inbox fs-1 d-block mb-2"></i>문서가 없습니다.</div>';
      return;
    }

    listEl.innerHTML = data.pages.map(page => {
      const createdDate = new Date(page.created_at * 1000).toLocaleDateString('ko-KR');
      const updatedDate = new Date(page.updated_at * 1000).toLocaleDateString('ko-KR');
      const categoryBadge = page.category
        ? `<span class="badge bg-secondary bg-opacity-10 text-secondary border">${window.escapeHtml(page.category)}</span>`
        : `<span class="badge bg-light text-muted border">미분류</span>`;

      return `
        <div class="revision-item d-flex align-items-center justify-content-between">
          <div class="d-flex align-items-center gap-2">
            ${showCategory ? categoryBadge : ''}
            <a href="/w/${encodeURIComponent(page.slug)}" class="text-decoration-none fw-medium"
               title="${window.escapeHtml(page.slug)}"
               onclick="event.preventDefault(); window.location.href=this.href;">
              ${window.escapeHtml(page.slug)}
            </a>
          </div>
          <div class="d-flex gap-3 ms-4 text-muted small" style="white-space: nowrap;">
            ${!showCategory ? categoryBadge : ''}
            ${showChars ? `<span title="글자 수"><i class="bi bi-textarea-t"></i> ${Number(page.characters || 0).toLocaleString()}자</span>` : ''}
            <span title="생성일"><i class="bi bi-plus-circle"></i> ${createdDate}</span>
            <span title="마지막 수정"><i class="bi bi-pencil"></i> ${updatedDate}</span>
          </div>
        </div>
      `;
    }).join('');

    renderAllPagesPagination();

  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    Swal.fire('오류', '문서 목록을 불러오는 데 실패했습니다.', 'error');
  }
}

// ── 페이지네이션 렌더링 ──
function renderAllPagesPagination() {
  const nav = document.getElementById('allPagesPagination');
  const ul = document.getElementById('allPagesPaginationList');

  if (totalAllPages <= 1) {
    nav.classList.add('d-none');
    return;
  }

  nav.classList.remove('d-none');

  const pages = new Set([1, totalAllPages]);
  for (let i = Math.max(2, currentAllPage - 2); i <= Math.min(totalAllPages - 1, currentAllPage + 2); i++) {
    pages.add(i);
  }
  const sortedPages = [...pages].sort((a, b) => a - b);

  let html = `<li class="page-item ${currentAllPage === 1 ? 'disabled' : ''}">
    <a class="page-link" href="#" ${currentAllPage === 1 ? 'tabindex="-1" aria-disabled="true"' : ''} onclick="event.preventDefault(); goToAllPage(${currentAllPage - 1})">이전</a>
  </li>`;

  let prev = 0;
  for (const p of sortedPages) {
    if (prev && p - prev > 1) {
      html += `<li class="page-item disabled"><span class="page-link">…</span></li>`;
    }
    html += `<li class="page-item ${p === currentAllPage ? 'active' : ''}">
      <a class="page-link" href="#" ${p === currentAllPage ? 'aria-current="page"' : ''} onclick="event.preventDefault(); goToAllPage(${p})">${p}</a>
    </li>`;
    prev = p;
  }

  html += `<li class="page-item ${currentAllPage === totalAllPages ? 'disabled' : ''}">
    <a class="page-link" href="#" ${currentAllPage === totalAllPages ? 'tabindex="-1" aria-disabled="true"' : ''} onclick="event.preventDefault(); goToAllPage(${currentAllPage + 1})">다음</a>
  </li>`;

  ul.innerHTML = html;
}

// ── 페이지 이동 ──
function goToAllPage(page) {
  if (page < 1 || page > totalAllPages) return;
  loadAllPages(page);
  document.getElementById('pane-allpages').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── 정렬 변경 ──
function changeSort() {
  currentSort = document.getElementById('allPagesSortSelect').value;
  loadAllPages(1);
}

// HTML onclick/onchange 속성에서 호출되므로 window 로 노출한다.
window.goToRecentPage = goToRecentPage;
window.goToAllPage = goToAllPage;
window.changeSort = changeSort;
