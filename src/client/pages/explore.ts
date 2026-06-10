// @ts-nocheck — explore.html 포털 부트스트랩. common.ts 가 window.* 로 노출하는 공통 전역
// (loadConfig / checkAuth / loadTrending / loadRecentChanges / getRelativeTime / escapeHtml /
//  uiSkeletonList / uiEmptyState / goRandomPage)을 사용한다. any 형태 fetch 응답이라 타입 검사를 끈다.

// ── 문서 활동(최근 수정 내역 / 모든 문서 목록) 상태 — 기존 recent-changes 페이지에서 통합 ──
const PAGE_SIZE = 10;
let currentRecentPage = 1;
let totalRecentPages = 0;
let recentRevisionsAbortController = null;

const ALL_PAGES_SIZE = 20;
let allPagesLoaded = false; // '모든 문서 목록' 탭 최초 로드 여부
let currentSort = 'slug_asc';
let currentAllPage = 1;
let totalAllPages = 0;
let allPagesAbortController = null;

document.addEventListener('DOMContentLoaded', async () => {
  await window.loadConfig();
  await window.checkAuth();

  // 사이드바 트렌딩 / 최근 변경 (자동 호출 아님 — 페이지가 직접 호출)
  window.loadTrending();
  window.loadRecentChanges();

  loadSummary();
  loadPendingEdits();

  // 문서 활동: 최근 수정 내역은 즉시, 모든 문서 목록은 탭 최초 진입 시 로드
  loadRecentRevisions();
  document.getElementById('tab-allpages').addEventListener('shown.bs.tab', () => {
    if (!allPagesLoaded) {
      loadAllPages();
      allPagesLoaded = true;
    }
  });
});

const esc = (s) => window.escapeHtml(String(s ?? ''));
const wikiHref = (slug) => '/w/' + encodeURIComponent(slug);

// ── 포털 집계 로드 ──
async function loadSummary() {
  const orphansEl = document.getElementById('orphansList');
  const wantedEl = document.getElementById('wantedList');
  const discEl = document.getElementById('recentDiscussionsList');
  orphansEl.innerHTML = window.uiSkeletonList(5);
  wantedEl.innerHTML = window.uiSkeletonList(5);
  discEl.innerHTML = window.uiSkeletonList(5);

  try {
    const res = await fetch('/api/explore/summary');
    if (!res.ok) throw new Error('summary load failed');
    const data = await res.json();

    renderStats(data.stats || {});
    renderOrphans(orphansEl, data.orphans || []);
    renderWanted(wantedEl, data.wanted || []);
    renderDiscussions(discEl, data.recent_discussions || []);
  } catch (e) {
    console.error('탐색 데이터 로드 실패:', e);
    const err = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: '불러오지 못했습니다' });
    orphansEl.innerHTML = err;
    wantedEl.innerHTML = err;
    discEl.innerHTML = err;
  }
}

// ── 통계 배지 ──
function renderStats(stats) {
  const el = document.getElementById('exploreStats');
  const n = (v) => Number(v || 0).toLocaleString();
  const badge = (icon, color, label, value) =>
    `<span class="badge bg-${color} bg-opacity-10 text-${color} border px-3 py-2" style="font-size: 0.9rem;">
       <i class="bi ${icon}"></i> ${label} <strong>${n(value)}</strong></span>`;
  el.innerHTML = [
    badge('bi-file-earmark-text', 'primary', '문서', stats.page_count),
    badge('bi-people', 'success', '유저', stats.user_count),
    badge('bi-pencil-square', 'info', '편집', stats.revision_count),
    badge('bi-image', 'secondary', '미디어', stats.media_count),
    badge('bi-person-up', 'warning', '30일 활성 편집자', stats.active_editors_30d),
  ].join('');
}

// ── 고아 문서 ──
function renderOrphans(el, items) {
  if (!items.length) {
    el.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-check2-circle', title: '고아 문서가 없습니다' });
    return;
  }
  el.innerHTML = items.map(it => `
    <a href="${wikiHref(it.slug)}" class="d-flex align-items-center justify-content-between text-decoration-none text-body px-2 py-2 border-bottom explore-row">
      <span class="text-truncate me-2">${esc(it.title || it.slug)}</span>
      <span class="text-muted small flex-shrink-0">${window.getRelativeTime(it.updated_at)}</span>
    </a>`).join('');
}

// ── 미작성 문서 (빨간 링크) ──
function renderWanted(el, items) {
  if (!items.length) {
    el.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-check2-circle', title: '미작성 문서가 없습니다' });
    return;
  }
  el.innerHTML = items.map(it => `
    <a href="${wikiHref(it.slug)}" class="d-flex align-items-center justify-content-between text-decoration-none px-2 py-2 border-bottom explore-row">
      <span class="text-danger text-truncate me-2">${esc(it.slug)}</span>
      <span class="badge bg-light text-muted border flex-shrink-0">${Number(it.ref_count || 0).toLocaleString()}곳에서 링크</span>
    </a>`).join('');
}

// ── 최근 토론 활동 ──
function renderDiscussions(el, items) {
  if (!items.length) {
    el.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-chat-left', title: '최근 토론 활동이 없습니다' });
    return;
  }
  el.innerHTML = items.map(it => `
    <a href="${wikiHref(it.page_slug)}?mode=discussions&id=${it.discussion_id}" class="d-block text-decoration-none text-body px-2 py-2 border-bottom explore-row">
      <div class="d-flex align-items-center justify-content-between">
        <span class="text-truncate me-2 fw-medium">${esc(it.page_slug)}</span>
        <span class="text-muted small flex-shrink-0">${window.getRelativeTime(it.created_at)}</span>
      </div>
      <div class="small text-muted text-truncate">${esc(it.discussion_title)} · ${esc(it.author_name || '알 수 없음')}</div>
    </a>`).join('');
}

// ── 검토 대기 편집 요청 목록 (검토 가능한 사용자에게만 노출) ──
// 서버가 검토 권한자에게 actionable 한(본인 작성 제외·ACL 통과) 요청만 내려주므로(자연 게이팅)
// 별도 권한 체크 없이 목록을 그대로 렌더한다. 검토는 각 문서 열람 페이지에서 진행한다.
async function loadPendingEdits() {
  try {
    const res = await fetch('/api/pending-edits');
    if (!res.ok) return; // 비로그인(401)/비검토자 등 → 섹션 숨김 유지
    const data = await res.json();
    const subs = Array.isArray(data.submissions) ? data.submissions : [];
    if (!subs.length) return; // 검토 대기 없음 → 섹션 숨김 유지

    document.getElementById('pendingEditsCount').textContent = subs.length.toLocaleString();
    document.getElementById('pendingEditsList').innerHTML = subs.map(renderPendingEditRow).join('');
    document.getElementById('pendingEditsSection').classList.remove('d-none');
  } catch (e) {
    // 무시 — 섹션 숨김 유지
  }
}

function renderPendingEditRow(it) {
  // updated_at 은 ISO 문자열 → getRelativeTime 은 unix 초를 받으므로 변환한다.
  const unix = Math.floor(new Date(it.updated_at).getTime() / 1000);
  const when = Number.isFinite(unix) ? window.getRelativeTime(unix) : '';
  const actionBadge = it.action === 'create'
    ? '<span class="badge bg-success bg-opacity-10 text-success border flex-shrink-0">새 문서</span>'
    : '<span class="badge bg-primary bg-opacity-10 text-primary border flex-shrink-0">수정</span>';
  const conflict = it.has_conflict
    ? '<span class="badge bg-warning bg-opacity-10 text-warning border flex-shrink-0"><i class="bi bi-exclamation-triangle"></i> 충돌</span>'
    : '';
  const meta = `${esc(it.author_name || '알 수 없음')} 님의 편집 요청${it.summary ? ' · ' + esc(it.summary) : ''}`;
  return `
    <a href="${wikiHref(it.slug)}" class="d-block text-decoration-none text-body px-2 py-2 border-bottom explore-row">
      <div class="d-flex align-items-center justify-content-between gap-2">
        <span class="text-truncate me-2 fw-medium">${esc(it.slug)}</span>
        <span class="d-flex align-items-center gap-1 flex-shrink-0">
          ${actionBadge}${conflict}
          <span class="text-muted small">${when}</span>
        </span>
      </div>
      <div class="small text-muted text-truncate">${meta}</div>
    </a>`;
}

// ──────────────────────────────────────────────────────────────────────────
// 문서 활동 (기존 /recent-changes 페이지 통합): 최근 수정 내역 + 모든 문서 목록
// recent-changes.ts 의 로직을 그대로 가져오되, 포털은 전용 #loading/#mainContent 게이트가
// 없으므로 각 탭이 자체 스켈레톤만 사용한다. 통계 배지는 explore 통계로 통일됐다.
// ──────────────────────────────────────────────────────────────────────────

// ── 최근 수정 내역 로드 ──
async function loadRecentRevisions(page = 1) {
  if (recentRevisionsAbortController) {
    recentRevisionsAbortController.abort();
    recentRevisionsAbortController = null;
  }
  recentRevisionsAbortController = new AbortController();
  const signal = recentRevisionsAbortController.signal;

  const listEl = document.getElementById('revisionsList');
  try {
    listEl.innerHTML = window.uiSkeletonList(8);
    document.getElementById('recentRevisionsPagination').classList.add('d-none');

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

    if (data.revisions.length === 0) {
      listEl.innerHTML = window.uiEmptyState({ icon: 'bi bi-inbox', title: '최근 수정 내역이 없습니다', text: '문서가 편집되면 여기에 표시됩니다.' });
    }

    renderRecentRevisionsPagination();
    window.initRoleIconPopovers(listEl);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
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

    listEl.innerHTML = window.uiSkeletonList(8);
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
      listEl.innerHTML = window.uiEmptyState({ icon: 'bi bi-inbox', title: '문서가 없습니다', text: '첫 문서를 작성해 보세요.' });
      return;
    }

    listEl.innerHTML = data.pages.map(pageItem => {
      const createdDate = new Date(pageItem.created_at * 1000).toLocaleDateString('ko-KR');
      const updatedDate = new Date(pageItem.updated_at * 1000).toLocaleDateString('ko-KR');
      const categoryBadge = pageItem.category
        ? `<span class="badge bg-secondary bg-opacity-10 text-secondary border">${window.escapeHtml(pageItem.category)}</span>`
        : `<span class="badge bg-light text-muted border">미분류</span>`;

      return `
        <div class="revision-item d-flex align-items-center justify-content-between">
          <div class="d-flex align-items-center gap-2">
            ${showCategory ? categoryBadge : ''}
            <a href="/w/${encodeURIComponent(pageItem.slug)}" class="text-decoration-none fw-medium"
               title="${window.escapeHtml(pageItem.slug)}"
               onclick="event.preventDefault(); window.location.href=this.href;">
              ${window.escapeHtml(pageItem.slug)}
            </a>
          </div>
          <div class="d-flex gap-3 ms-4 text-muted small" style="white-space: nowrap;">
            ${!showCategory ? categoryBadge : ''}
            ${showChars ? `<span title="글자 수"><i class="bi bi-textarea-t"></i> ${Number(pageItem.characters || 0).toLocaleString()}자</span>` : ''}
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

// ── 페이지네이션 렌더링 (모든 문서 목록) ──
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

// ── 페이지 이동 (모든 문서 목록) ──
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
