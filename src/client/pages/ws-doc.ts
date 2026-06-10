// @ts-nocheck — 워크스페이스 문서 조회(/ws/:wslug/w/:slug) 부트스트랩.
// common.ts / render.ts 가 window.* 로 노출하는 공통 전역(loadConfig/checkAuth/currentUser/
// escapeHtml/getRelativeTime/renderWikiContent)을 사용한다. any 형태 fetch 응답이라 타입검사를 끈다.

import { apiGet } from '../utils/api';

const esc = (s) => window.escapeHtml(String(s ?? ''));

// ── URL 파싱: /ws/<wslug>/w/<slug...> ──
let WSLUG = '';
let SLUG = '';
(function parseUrl() {
  const parts = window.location.pathname.split('/').filter(Boolean); // ['ws', wslug, 'w', ...slug]
  WSLUG = parts[1] ? decodeURIComponent(parts[1]) : '';
  const wIdx = parts.indexOf('w');
  if (wIdx >= 0 && wIdx + 1 < parts.length) {
    try {
      SLUG = parts.slice(wIdx + 1).map((p) => decodeURIComponent(p)).join('/');
    } catch {
      SLUG = parts.slice(wIdx + 1).join('/');
    }
  }
})();

/** 슬러그를 경로 세그먼트별로 encodeURIComponent 하되 슬래시는 보존한다(라우트 :slug{.+}). */
function encodeSlugPath(slug) {
  return String(slug || '')
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

const WS_BASE = '/api/ws/' + encodeURIComponent(WSLUG);
const wsDocUrl = (slug) => '/ws/' + encodeURIComponent(WSLUG) + '/w/' + encodeSlugPath(slug);
const wsEditUrl = (slug) => '/ws/' + encodeURIComponent(WSLUG) + '/edit?slug=' + encodeURIComponent(slug);

let currentPage = null;

document.addEventListener('DOMContentLoaded', async () => {
  await window.loadConfig();
  await window.checkAuth();

  // 브레드크럼: 워크스페이스 대시보드로
  const crumb = document.getElementById('wsDocCrumbWs');
  if (crumb) {
    crumb.setAttribute('href', '/ws/' + encodeURIComponent(WSLUG));
    crumb.textContent = WSLUG;
  }

  await loadPage();
});

function show(id) { document.getElementById(id)?.classList.remove('d-none'); }
function hide(id) { document.getElementById(id)?.classList.add('d-none'); }

async function loadPage() {
  hide('wsDocBody');
  hide('wsDocEmpty');
  hide('wsDocSideToggle');
  show('wsDocLoading');

  let data;
  try {
    data = await apiGet(WS_BASE + '/pages/' + encodeSlugPath(SLUG));
  } catch (e) {
    hide('wsDocLoading');
    renderEmpty(String(e?.message || ''));
    return;
  }

  currentPage = data;
  hide('wsDocLoading');
  show('wsDocBody');

  // 제목
  const titleEl = document.getElementById('wsDocTitle');
  if (titleEl) titleEl.textContent = data.title || data.slug;
  document.title = (data.title || data.slug) + ' - CloudWiki';

  // 리다이렉트 안내
  const redirEl = document.getElementById('wsDocRedirect');
  if (redirEl) {
    if (data.redirect_to) {
      redirEl.classList.remove('d-none');
      redirEl.innerHTML =
        '<i class="bi bi-signpost-2 me-1"></i> 이 문서는 <a href="' +
        esc(wsDocUrl(data.redirect_to)) + '">' + esc(data.redirect_to) +
        '</a> 문서로 넘어왔습니다.';
    } else {
      redirEl.classList.add('d-none');
      redirEl.innerHTML = '';
    }
  }

  // 액션 버튼
  const actionsEl = document.getElementById('wsDocActions');
  if (actionsEl) {
    let html = '';
    if (data.can_write) {
      html += '<a class="btn btn-wiki btn-sm" href="' + esc(wsEditUrl(data.slug)) +
        '"><i class="bi bi-pencil-square"></i> 편집</a>';
    }
    actionsEl.innerHTML = html;
  }

  // 본문 렌더 (index.ts 와 동일한 호출 형태)
  try {
    await window.renderWikiContent(data.content || '', data.slug, 'wsDocContent', {
      showCategory: false,
      canEdit: false,
      enableSectionEdit: false,
    });
  } catch (e) {
    const c = document.getElementById('wsDocContent');
    if (c) c.textContent = data.content || '';
  }

  // 워크스페이스 내부 [[링크]] 를 워크스페이스 문서 경로로 재배선
  rewireWikiLinks();

  // 사이드 도구
  show('wsDocSideToggle');
  loadMedia();
  loadRevisions();
  loadBacklinks();
  initJump();
}

/**
 * render.ts 의 위키 링크는 전역 위키 경로 `/w/<slug>` 로 만들어지고 SPA 네비게이션
 * onclick 이 붙는다. 워크스페이스 문맥에서는 그 링크가 워크스페이스 문서를 가리켜야
 * 하므로, `/w/<slug>` href 를 워크스페이스 문서 경로로 바꾸고 SPA onclick 을 제거해
 * 일반 네비게이션(전체 페이지 이동)으로 동작하게 한다. 같은 페이지 앵커(#...)는 보존.
 */
function rewireWikiLinks() {
  const container = document.getElementById('wsDocContent');
  if (!container) return;
  container.querySelectorAll('a[href^="/w/"]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    const rest = href.slice('/w/'.length); // <encoded-slug>[#anchor]
    const hashIdx = rest.indexOf('#');
    const slugPart = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
    const anchor = hashIdx >= 0 ? rest.slice(hashIdx) : '';
    let slug;
    try { slug = decodeURIComponent(slugPart); } catch { slug = slugPart; }
    a.setAttribute('href', wsDocUrl(slug) + anchor);
    a.onclick = null; // render.ts 가 붙인 전역 SPA 네비게이션 제거
  });
}

function renderEmpty(errMsg) {
  const el = document.getElementById('wsDocEmpty');
  if (!el) return;
  const is404 = /\b404\b/.test(errMsg);
  let cta = '';
  if (is404 && window.currentUser) {
    cta = '<div class="mt-3"><a class="btn btn-wiki" href="' + esc(wsEditUrl(SLUG)) +
      '"><i class="bi bi-pencil-square"></i> 이 문서 만들기</a></div>';
  }
  const title = is404 ? '문서가 없습니다' : '문서를 불러오지 못했습니다';
  const text = is404
    ? esc(SLUG) + ' 문서가 아직 작성되지 않았습니다.'
    : '권한이 없거나 일시적인 오류일 수 있습니다.';
  el.innerHTML =
    '<div class="empty-state">' +
    '<i class="empty-state-icon bi bi-file-earmark-x" aria-hidden="true"></i>' +
    '<p class="empty-state-title">' + esc(title) + '</p>' +
    '<p class="empty-state-text">' + text + '</p>' + cta + '</div>';
  el.classList.remove('d-none');
}

// ── 사이드바: 1. 이 문서의 미디어 ──
async function loadMedia() {
  const el = document.getElementById('wsDocMedia');
  if (!el) return;
  el.innerHTML = '<div class="text-muted small">불러오는 중...</div>';
  try {
    const data = await apiGet(WS_BASE + '/media');
    const content = currentPage?.content || '';
    const wsid = currentPage?.workspace_id;
    const used = (data.items || []).filter((m) => {
      if (m.url && content.includes(m.url)) return true;
      // 파일명 단독 등장(상대 경로 사용 등)도 보수적으로 매칭
      return m.filename && content.includes(m.filename);
    });
    if (!used.length) {
      el.innerHTML = '<div class="text-muted small">이 문서에서 사용된 미디어가 없습니다.</div>';
      return;
    }
    el.innerHTML =
      '<div class="d-flex flex-wrap gap-2">' +
      used.map((m) =>
        '<a href="' + esc(m.url) + '" target="_blank" rel="noopener" title="' + esc(m.filename) + '">' +
        '<img src="' + esc(m.url) + '" alt="' + esc(m.filename) +
        '" style="width:72px;height:72px;object-fit:cover;border-radius:6px;border:1px solid var(--bs-border-color,#ddd);"></a>'
      ).join('') +
      '</div>';
  } catch {
    el.innerHTML = '<div class="text-muted small">미디어를 불러오지 못했습니다.</div>';
  }
}

// ── 사이드바: 2. 리비전 ──
async function loadRevisions() {
  const el = document.getElementById('wsDocRevisions');
  if (!el) return;
  el.innerHTML = '<div class="text-muted small">불러오는 중...</div>';
  try {
    const data = await apiGet(WS_BASE + '/pages/' + encodeSlugPath(SLUG) + '/revisions');
    const revs = (data.revisions || []).slice(0, 10);
    if (!revs.length) {
      el.innerHTML = '<div class="text-muted small">리비전이 없습니다.</div>';
      return;
    }
    el.innerHTML =
      '<div class="list-group list-group-flush">' +
      revs.map((r) =>
        '<button type="button" class="list-group-item list-group-item-action px-2 py-1" ' +
        'onclick="wsDocViewRevision(' + Number(r.id) + ')">' +
        '<div class="small fw-medium text-truncate">' + (r.summary ? esc(r.summary) : '<span class="text-muted">(요약 없음)</span>') + '</div>' +
        '<div class="small text-muted">r' + esc(r.page_version) + ' · ' +
        esc(r.author_name || '익명') + ' · ' + esc(window.getRelativeTime(r.created_at)) + '</div>' +
        '</button>'
      ).join('') +
      '</div>';
  } catch {
    el.innerHTML = '<div class="text-muted small">리비전을 불러오지 못했습니다.</div>';
  }
}

async function wsDocViewRevision(id) {
  try {
    const rev = await apiGet(WS_BASE + '/revisions/' + Number(id));
    Swal.fire({
      title: 'r' + esc(rev.page_version) + ' 리비전',
      html: '<pre style="text-align:left;white-space:pre-wrap;word-break:break-word;max-height:60vh;overflow:auto;font-size:0.85rem;">' +
        esc(rev.content || '(본문 없음)') + '</pre>',
      width: '48rem',
      confirmButtonText: '닫기',
    });
  } catch {
    Swal.fire('오류', '리비전을 불러오지 못했습니다.', 'error');
  }
}

// ── 사이드바: 3. 역링크 ──
async function loadBacklinks() {
  const el = document.getElementById('wsDocBacklinks');
  if (!el) return;
  el.innerHTML = '<div class="text-muted small">불러오는 중...</div>';
  try {
    const data = await apiGet(WS_BASE + '/pages/' + encodeSlugPath(SLUG) + '/backlinks');
    const links = data.backlinks || [];
    if (!links.length) {
      el.innerHTML = '<div class="text-muted small">이 문서를 참조하는 문서가 없습니다.</div>';
      return;
    }
    el.innerHTML =
      '<div class="list-group list-group-flush">' +
      links.map((l) =>
        '<a class="list-group-item list-group-item-action px-2 py-1 small" href="' +
        esc(wsDocUrl(l.slug)) + '">' + esc(l.title || l.slug) + '</a>'
      ).join('') +
      '</div>';
  } catch {
    el.innerHTML = '<div class="text-muted small">역링크를 불러오지 못했습니다. (권한이 필요할 수 있습니다)</div>';
  }
}

// ── 사이드바: 4. 빠른 문서 이동 ──
function initJump() {
  const input = document.getElementById('wsDocJumpInput');
  const results = document.getElementById('wsDocJumpResults');
  if (!input || !results) return;
  let timer = null;
  input.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => runJump(input.value.trim(), results), 200);
  });
}

async function runJump(q, results) {
  if (!q) { results.innerHTML = ''; return; }
  try {
    const data = await apiGet(WS_BASE + '/pages?prefix=' + encodeURIComponent(q));
    let pages = data.pages || [];
    // prefix 는 하위 문서만 잡으므로, 부족하면 전체 목록에서 클라이언트 필터로 보강
    if (pages.length === 0) {
      const all = await apiGet(WS_BASE + '/pages');
      const ql = q.toLowerCase();
      pages = (all.pages || []).filter((p) =>
        String(p.slug).toLowerCase().includes(ql) ||
        String(p.title || '').toLowerCase().includes(ql)
      );
    }
    pages = pages.slice(0, 15);
    if (!pages.length) {
      results.innerHTML = '<div class="text-muted small px-2 py-1">결과 없음</div>';
      return;
    }
    results.innerHTML = pages.map((p) =>
      '<a class="list-group-item list-group-item-action px-2 py-1 small" href="' +
      esc(wsDocUrl(p.slug)) + '">' + esc(p.title || p.slug) + '</a>'
    ).join('');
  } catch {
    results.innerHTML = '<div class="text-muted small px-2 py-1">검색 실패</div>';
  }
}

// HTML on* 핸들러용 노출
window.wsDocViewRevision = wsDocViewRevision;
