// @ts-nocheck — 워크스페이스 문서 편집 이력(리비전) 페이지 (/ws/:wslug/w/:slug?mode=revisions).
//
// 전역 위키 리비전 페이지(pages/revisions.ts)와 동일한 화면 구성(목록/보기/비교/되돌리기/
// 페이지네이션)을 워크스페이스 API 로 구동한다. 워크스페이스는 리비전 소프트/하드 삭제·관리자
// 가시성 개념이 없으므로 삭제 버튼은 노출하지 않는다. common.ts / render.ts / diff.ts 가
// window.* 로 노출하는 공통 전역(loadConfig/checkAuth/escapeHtml/getRelativeTime/
// renderWikiContent/showDiffModal)을 사용한다. HTML onclick 핸들러는 파일 끝에서 window.* 로 노출.

// ── URL 파싱: /ws/<wslug>/w/<slug...> ──
let WSLUG = '';
let SLUG = '';
(function parseUrl() {
  const parts = window.location.pathname.split('/').filter(Boolean); // ['ws', wslug, 'w', ...slug]
  WSLUG = parts[1] ? decodeURIComponent(parts[1]) : '';
  const wIdx = parts.indexOf('w');
  if (wIdx >= 0 && wIdx + 1 < parts.length) {
    try { SLUG = parts.slice(wIdx + 1).map((p) => decodeURIComponent(p)).join('/'); }
    catch { SLUG = parts.slice(wIdx + 1).join('/'); }
  }
})();

function encodeSlugPath(slug) {
  return String(slug || '').split('/').map((s) => encodeURIComponent(s)).join('/');
}

const WS_BASE = '/api/ws/' + encodeURIComponent(WSLUG);
const wsDocUrl = (slug) => '/ws/' + encodeURIComponent(WSLUG) + '/w/' + encodeSlugPath(slug);

const REV_PAGE_SIZE = 10;
let currentRevPage = 1;
let totalRevPages = 0;
let currentRevisionRawContent = '';
let isRawView = false;
// 되돌리기 권한(canWrite) — 리비전 목록 응답에서 받아 되돌리기 버튼 노출을 게이팅한다.
let canWrite = false;

// 렌더된 리비전 본문의 전역 위키 링크(`/w/...`)를 워크스페이스 경로(`/ws/<wslug>/w/...`)로
// 재배선한다(ws-doc.ts 와 동일 정책). 그러지 않으면 과거 본문의 [[링크]] 를 따라갔을 때
// 워크스페이스를 벗어나 전역 위키로 이동한다. 같은 페이지 앵커(#...)는 보존.
function rewireRevisionLinks() {
  const container = document.getElementById('revisionViewContent');
  if (!container) return;
  container.querySelectorAll('a[href^="/w/"]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    const rest = href.slice('/w/'.length);
    const hashIdx = rest.indexOf('#');
    const slugPart = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
    const anchor = hashIdx >= 0 ? rest.slice(hashIdx) : '';
    let slug;
    try { slug = decodeURIComponent(slugPart); } catch { slug = slugPart; }
    a.setAttribute('href', wsDocUrl(slug) + anchor);
    a.onclick = null;
  });
}

// 편집 요약의 [+N줄 -M줄] 토큰 색칠(전역 위키 revisions 와 동일).
function renderRevisionSummary(raw) {
  if (!raw) return '(요약 없음)';
  const tokenRe = /\[(?:\+\d+줄(?: -\d+줄)?|-\d+줄)\]/g;
  let html = '';
  let last = 0;
  let m;
  while ((m = tokenRe.exec(raw)) !== null) {
    html += window.escapeHtml(raw.slice(last, m.index));
    html += m[0]
      .replace(/\+(\d+)줄/, '<span class="text-success">+$1줄</span>')
      .replace(/-(\d+)줄/, '<span class="text-danger">-$1줄</span>');
    last = m.index + m[0].length;
  }
  html += window.escapeHtml(raw.slice(last));
  return html;
}

document.addEventListener('DOMContentLoaded', async () => {
  await window.loadConfig();
  await window.checkAuth();

  if (!SLUG) {
    document.getElementById('loading').classList.add('d-none');
    Swal.fire('오류', '문서를 찾을 수 없습니다.', 'error');
    return;
  }
  // 상단 워크스페이스 브레드크럼
  const crumb = document.getElementById('wsRevCrumbWs');
  if (crumb) { crumb.setAttribute('href', '/ws/' + encodeURIComponent(WSLUG)); crumb.textContent = WSLUG; }

  // 초기 페이지는 URL `?page=N`(1-based, DESIGN.md 페이지네이션 규약)에서 읽는다 — 새로고침/공유/뒤로가기 보존.
  const pageParam = parseInt(new URLSearchParams(window.location.search).get('page') || '1', 10);
  const initialPage = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;
  await showRevisions(SLUG, initialPage);
  const diffParam = new URLSearchParams(window.location.search).get('diff');
  const diffRevId = diffParam ? Number(diffParam) : NaN;
  if (Number.isInteger(diffRevId) && diffRevId > 0) showDiff(diffRevId);
});

// mode=revisions 를 보존하면서 현재 페이지를 URL `?page=N` 에 반영(공유·북마크·뒤로가기 가능).
function syncPageToUrl(page) {
  const params = new URLSearchParams(window.location.search);
  params.set('mode', 'revisions');
  if (page > 1) params.set('page', String(page));
  else params.delete('page');
  history.replaceState(history.state, '', window.location.pathname + '?' + params.toString());
}

async function showRevisions(slug, page = 1) {
  try {
    const isFirstLoad = totalRevPages === 0 && currentRevPage === 1;
    if (isFirstLoad) {
      document.getElementById('loading').classList.remove('d-none');
      document.getElementById('revisionsPage').classList.add('d-none');
    }

    const offset = (page - 1) * REV_PAGE_SIZE;
    const res = await fetch(`${WS_BASE}/pages/${encodeSlugPath(slug)}/revisions?offset=${offset}&limit=${REV_PAGE_SIZE}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('리비전 로딩 실패');
    const data = await res.json();
    canWrite = !!data.can_write;

    if (isFirstLoad) {
      document.getElementById('revPageTitle').textContent = data.slug || slug;
      document.getElementById('revBackLink').href = wsDocUrl(slug);
      document.title = `편집 이력 - ${data.slug || slug} - ${window.appConfig.wikiName}`;
    }

    currentRevPage = page;
    totalRevPages = Math.max(1, Math.ceil((data.total || 0) / REV_PAGE_SIZE));

    if ((data.revisions || []).length === 0 && data.total > 0) {
      showRevisions(slug, totalRevPages);
      return;
    }

    const listEl = document.getElementById('revisionsList');
    const itemsHtml = (data.revisions || []).map((rev, idx) => {
      const isLatest = page === 1 && idx === 0;
      const date = new Date(rev.created_at * 1000).toLocaleString('ko-KR');
      // 되돌리기는 쓰기 권한(canWrite) 보유자에게만 노출 — 되돌리기 API 가 canWrite 를 요구하므로
      // 뷰어/게스트에게 보여줘 봤자 403/로그인 안내로만 끝난다.
      const revertBtn = canWrite ? `
            <button class="btn btn-rev-action btn-rev-revert" data-id="${rev.id}" data-page-version="${rev.page_version ?? ''}" onclick="wsConfirmRevert(+this.dataset.id, this.dataset.pageVersion)">
              <i class="bi bi-arrow-counterclockwise"></i> 되돌리기
            </button>` : '';
      return `
        <div class="revision-item${isLatest ? ' is-current' : ''} d-flex align-items-center justify-content-between border-bottom py-2">
          <div class="d-flex align-items-center gap-3 flex-grow-1">
            <span class="revision-date text-muted small" style="min-width: 160px;">${date}</span>
            <span class="revision-author badge bg-light text-dark border">${window.escapeHtml(rev.author_name || '알 수 없음')}</span>
            ${isLatest ? '<span class="badge text-bg-warning" style="font-size: 0.7em; flex-shrink: 0;">현재 버전</span>' : ''}
            <span class="revision-summary">${renderRevisionSummary(rev.summary)}</span>
          </div>
          <div class="d-flex gap-2 ms-2" style="white-space: nowrap;">
            <button class="btn btn-rev-action btn-rev-view" data-id="${rev.id}" data-page-version="${rev.page_version ?? ''}" onclick="wsViewRevision(+this.dataset.id, this.dataset.pageVersion)">
              <i class="bi bi-file-text"></i> 보기
            </button>
            <button class="btn btn-rev-action btn-rev-diff" data-id="${rev.id}" onclick="wsConfirmDiff(+this.dataset.id)">
              <i class="bi bi-file-diff"></i> 비교
            </button>${revertBtn}
          </div>
        </div>`;
    }).join('');

    listEl.innerHTML = itemsHtml || (window.uiEmptyState
      ? window.uiEmptyState({ icon: 'bi bi-clock-history', title: '편집 이력이 없습니다' })
      : '<p class="text-muted">편집 이력이 없습니다.</p>');

    renderRevisionsPagination();
    // 실제 적용된 페이지(범위 초과 클램프 반영)를 URL 에 반영한다.
    syncPageToUrl(currentRevPage);
    document.getElementById('loading').classList.add('d-none');
    document.getElementById('revisionsPage').classList.remove('d-none');
  } catch (err) {
    console.error(err);
    document.getElementById('loading').classList.add('d-none');
    Swal.fire('오류', '리비전 목록을 불러오는 데 실패했습니다.', 'error');
  }
}

function renderRevisionsPagination() {
  const nav = document.getElementById('revisionsPagination');
  const ul = document.getElementById('revisionsPaginationList');
  if (totalRevPages <= 1) { nav.classList.add('d-none'); ul.innerHTML = ''; return; }
  nav.classList.remove('d-none');

  const pages = new Set([1, totalRevPages]);
  for (let i = Math.max(2, currentRevPage - 2); i <= Math.min(totalRevPages - 1, currentRevPage + 2); i++) pages.add(i);
  const sortedPages = [...pages].sort((a, b) => a - b);

  let html = `<li class="page-item ${currentRevPage === 1 ? 'disabled' : ''}">
    <a class="page-link" href="#" onclick="event.preventDefault(); wsGoToRevPage(${currentRevPage - 1})">이전</a></li>`;
  let prev = 0;
  for (const p of sortedPages) {
    if (prev && p - prev > 1) html += `<li class="page-item disabled"><span class="page-link">…</span></li>`;
    html += `<li class="page-item ${p === currentRevPage ? 'active' : ''}">
      <a class="page-link" href="#" onclick="event.preventDefault(); wsGoToRevPage(${p})">${p}</a></li>`;
    prev = p;
  }
  html += `<li class="page-item ${currentRevPage === totalRevPages ? 'disabled' : ''}">
    <a class="page-link" href="#" onclick="event.preventDefault(); wsGoToRevPage(${currentRevPage + 1})">다음</a></li>`;
  ul.innerHTML = html;
}

function wsGoToRevPage(page) {
  if (page < 1 || page > totalRevPages || page === currentRevPage) return;
  showRevisions(SLUG, page);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function wsViewRevision(revId, pageVersion) {
  try {
    const res = await fetch(`${WS_BASE}/revisions/${revId}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('리비전 불러오기 실패');
    const rev = await res.json();

    currentRevisionRawContent = rev.content || '';
    isRawView = false;

    const versionLabel = (pageVersion !== '' && pageVersion != null) ? `v${pageVersion}` : `#${revId}`;
    let revDate = '';
    if (rev.created_at) {
      const d = new Date(rev.created_at * 1000);
      revDate = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
    }
    document.getElementById('revisionViewLabel').textContent = revDate
      ? `${revDate} ${versionLabel} 리비전 열람 중입니다.`
      : `${versionLabel} 리비전 열람 중입니다.`;
    document.getElementById('revisionViewTitle').textContent = document.getElementById('revPageTitle').textContent || SLUG;
    document.getElementById('revisionViewContent').innerHTML = '';

    const rawBtn = document.getElementById('rawViewBtn');
    if (rawBtn) {
      rawBtn.innerHTML = '<i class="bi bi-code"></i><span class="btn-collapse-text"> Raw</span>';
      rawBtn.classList.remove('btn-secondary');
      rawBtn.classList.add('btn-outline-secondary');
    }

    await window.renderWikiContent(rev.content || '', SLUG, 'revisionViewContent');
    rewireRevisionLinks();

    document.getElementById('revisionsPage').classList.add('d-none');
    document.getElementById('revisionViewPage').classList.remove('d-none');
    window.scrollTo({ top: 0, behavior: 'instant' });
  } catch (err) {
    Swal.fire('오류', err.message, 'error');
  }
}

function backToRevisions() {
  document.getElementById('revisionViewPage').classList.add('d-none');
  document.getElementById('revisionsPage').classList.remove('d-none');
  window.scrollTo({ top: 0, behavior: 'instant' });
}

async function toggleRawView() {
  isRawView = !isRawView;
  const contentEl = document.getElementById('revisionViewContent');
  const rawBtn = document.getElementById('rawViewBtn');
  if (isRawView) {
    contentEl.innerHTML = `<pre class="wiki-ext-raw-pre">${window.escapeHtml(currentRevisionRawContent)}</pre>`;
    rawBtn.innerHTML = '<i class="bi bi-eye"></i><span class="btn-collapse-text"> 렌더링</span>';
    rawBtn.classList.remove('btn-outline-secondary');
    rawBtn.classList.add('btn-secondary');
  } else {
    contentEl.innerHTML = '';
    await window.renderWikiContent(currentRevisionRawContent, SLUG, 'revisionViewContent');
    rewireRevisionLinks();
    rawBtn.innerHTML = '<i class="bi bi-code"></i><span class="btn-collapse-text"> Raw</span>';
    rawBtn.classList.remove('btn-secondary');
    rawBtn.classList.add('btn-outline-secondary');
  }
}

function wsConfirmDiff(revId) { showDiff(revId); }

async function showDiff(revId) {
  try {
    const res = await fetch(`${WS_BASE}/revisions/${revId}/diff`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Diff 불러오기 실패');
    const data = await res.json();
    const oldLabel = data.old_revision_id
      ? (data.old_page_version != null ? `v${data.old_page_version}` : `#${data.old_revision_id}`)
      : '(없음)';
    const newLabel = data.new_page_version != null ? `v${data.new_page_version}` : `#${data.new_revision_id}`;
    await window.showDiffModal({
      title: `리비전 비교: ${oldLabel} → ${newLabel}`,
      oldText: data.old_content || '',
      newText: data.new_content || '',
      slug: SLUG,
      swalOptions: { confirmButtonText: '닫기' },
    });
  } catch (err) {
    Swal.fire('오류', err.message, 'error');
  }
}

async function wsConfirmRevert(revId, pageVersion) {
  if (!window.currentUser) {
    Swal.fire('로그인 필요', '되돌리기를 하려면 로그인해주세요.', 'info');
    return;
  }
  const versionLabel = (pageVersion !== '' && pageVersion != null) ? `v${pageVersion}` : `#${revId}`;
  const result = await Swal.fire({
    title: '문서 되돌리기',
    text: `정말 리비전 ${versionLabel} 상태로 문서를 되돌리시겠습니까? 현재 내용은 새로운 리비전으로 저장됩니다.`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: '되돌리기',
    cancelButtonText: '취소',
  });
  if (!result.isConfirmed) return;
  try {
    const res = await fetch(`${WS_BASE}/pages/${encodeSlugPath(SLUG)}/revert`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision_id: revId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '되돌리기 실패');
    Swal.fire('성공', '문서가 되돌려졌습니다.', 'success').then(() => {
      window.location.href = wsDocUrl(SLUG);
    });
  } catch (err) {
    Swal.fire('오류', err.message, 'error');
  }
}

// HTML onclick 핸들러용 window 노출
window.toggleRawView = toggleRawView;
window.backToRevisions = backToRevisions;
window.wsViewRevision = wsViewRevision;
window.wsConfirmDiff = wsConfirmDiff;
window.wsConfirmRevert = wsConfirmRevert;
window.wsGoToRevPage = wsGoToRevPage;
