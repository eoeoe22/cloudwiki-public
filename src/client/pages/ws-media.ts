// @ts-nocheck — ws-media.html (워크스페이스 미디어 관리 /ws/:wslug/media) 부트스트랩.
// 미디어 목록 조회·삭제(canWrite) + 미참조 미디어 가비지 컬렉터(canManage)를 제공한다.
// 가비지 컬렉터는 워크스페이스 설정 페이지(ws-settings)에서 이 페이지로 이관됐다.
// wslug 는 location.pathname 2번째 세그먼트에서 파싱한다. common.ts 가 window.* 로 노출하는
// 공통 전역(loadConfig/checkAuth/escapeHtml/uiEmptyState/uiSkeletonList)을 사용한다.
// any 형태 fetch 응답이라 타입 검사를 끈다.

import { apiGet } from '../utils/api';

const esc = (s) => window.escapeHtml(String(s ?? ''));

function parseWslug() {
  const parts = location.pathname.split('/').filter(Boolean); // ['ws', '<wslug>', 'media']
  if (parts[0] !== 'ws' || !parts[1]) return '';
  try {
    return decodeURIComponent(parts[1]);
  } catch {
    return parts[1];
  }
}

let WSLUG = parseWslug();
const wbase = () => '/api/ws/' + encodeURIComponent(WSLUG);

// 권한/상태
let canWrite = false;
let canManage = false;

// 미디어 목록 상태 (클라이언트 검색/정렬/페이지네이션)
let mediaItems = []; // 서버에서 받은 원본 목록
let mediaSearch = '';
let mediaSort = 'date_desc';
let mediaPage = 1; // 1-기반 현재 페이지
const MEDIA_PAGE_SIZE = 20; // 한 페이지에 표시할 미디어 수

function humanBytes(n) {
  const v = Number(n || 0);
  if (v < 1024) return v + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = v / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return val.toFixed(val >= 10 || i === 0 ? 0 : 1) + ' ' + units[i];
}

// 공통 변이 헬퍼: JSON 본문 fetch → {ok, body}
async function send(path, method, payload) {
  const init = {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
  };
  if (payload !== undefined) init.body = JSON.stringify(payload);
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function toast(msg) {
  Swal.fire({
    toast: true,
    position: 'top-end',
    icon: 'success',
    title: msg,
    showConfirmButton: false,
    timer: 2000,
    timerProgressBar: true,
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  // 대시보드 돌아가기 링크는 비동기 로드 전에 즉시 설정한다 (로딩 중 클릭 대비).
  if (WSLUG) document.getElementById('backToWsBtn')?.setAttribute('href', '/ws/' + encodeURIComponent(WSLUG));
  await window.loadConfig();
  await window.checkAuth();
  initMediaPage();
});

async function initMediaPage() {
  const loadingEl = document.getElementById('wsMediaLoading');
  const contentEl = document.getElementById('wsMediaContent');
  const errorEl = document.getElementById('wsMediaError');

  if (!WSLUG) {
    loadingEl?.classList.add('d-none');
    errorEl?.classList.remove('d-none');
    return;
  }

  let meta;
  try {
    meta = await apiGet(wbase());
  } catch (e) {
    loadingEl?.classList.add('d-none');
    const msg = String(e?.message || '');
    if (/403/.test(msg)) {
      const t = document.getElementById('wsMediaErrorTitle');
      if (t) t.textContent = '접근 권한이 없습니다';
    }
    errorEl?.classList.remove('d-none');
    return;
  }

  const ws = meta.workspace || {};
  const access = meta.access || {};
  canWrite = !!access.canWrite;
  canManage = !!access.canManage;

  // 헤더 + 대시보드 돌아가기 링크
  const wsLabel = ws.name || ws.slug || WSLUG;
  document.getElementById('wsMediaTitle').textContent = wsLabel + ' 미디어';

  // 가비지 컬렉터는 canManage 만 노출
  if (canManage) document.getElementById('gcCard')?.classList.remove('d-none');

  loadingEl?.classList.add('d-none');
  contentEl?.classList.remove('d-none');

  loadMedia();
}

// ──────────────────────────────────────────────────────────────
// 미디어 목록 (조회 + 클라이언트 검색/정렬 + 삭제)
// ──────────────────────────────────────────────────────────────
async function loadMedia() {
  const listEl = document.getElementById('mediaList');
  listEl.innerHTML = window.uiSkeletonList(4);

  try {
    // 미디어 전체를 페이지 단위(최대 200개)로 끝까지 순회해 모은다.
    // 목록 엔드포인트는 한 응답을 200개로 캡하므로, 200개를 초과하는 워크스페이스에서도
    // 클라이언트 검색/정렬/총계가 전체 집합 기준이 되도록 모든 페이지를 가져온다.
    const PAGE = 200;
    const MAX_PAGES = 200; // 안전 상한 (비정상적으로 큰 워크스페이스에서 무한 요청 방지)
    const all = [];
    for (let i = 0; i < MAX_PAGES; i++) {
      const data = await apiGet(wbase() + '/media?limit=' + PAGE + '&offset=' + i * PAGE);
      const batch = Array.isArray(data.items) ? data.items : [];
      all.push(...batch);
      if (batch.length < PAGE) break; // 마지막 페이지
    }
    mediaItems = all;
  } catch (e) {
    listEl.innerHTML = window.uiEmptyState({
      icon: 'bi bi-exclamation-triangle',
      title: '미디어 목록을 불러올 수 없습니다',
    });
    document.getElementById('mediaTotalInfo').textContent = '';
    return;
  }

  renderMedia();
}

// 검색어/정렬을 적용한 목록을 반환한다.
function filteredSortedMedia() {
  const q = mediaSearch.toLowerCase();
  let list = mediaItems.filter((m) => !q || String(m.filename || '').toLowerCase().includes(q));
  const byName = (a, b) => String(a.filename || '').localeCompare(String(b.filename || ''));
  switch (mediaSort) {
    case 'date_asc':
      list.sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0));
      break;
    case 'name_asc':
      list.sort(byName);
      break;
    case 'name_desc':
      list.sort((a, b) => byName(b, a));
      break;
    case 'size_desc':
      list.sort((a, b) => Number(b.size || 0) - Number(a.size || 0));
      break;
    case 'size_asc':
      list.sort((a, b) => Number(a.size || 0) - Number(b.size || 0));
      break;
    case 'date_desc':
    default:
      list.sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
      break;
  }
  return list;
}

function renderMedia() {
  const listEl = document.getElementById('mediaList');
  const pagerEl = document.getElementById('mediaPager');
  const totalInfo = document.getElementById('mediaTotalInfo');
  pagerEl.innerHTML = '';

  if (!mediaItems.length) {
    listEl.innerHTML = window.uiEmptyState({ icon: 'bi bi-image', title: '미디어가 없습니다' });
    totalInfo.textContent = '';
    return;
  }

  const list = filteredSortedMedia();
  if (!list.length) {
    listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-search', title: '검색 결과가 없습니다' });
    totalInfo.textContent = `총 ${mediaItems.length}개 중 0개 표시`;
    return;
  }

  // 페이지네이션: 최대 MEDIA_PAGE_SIZE 개씩 표시.
  const totalPages = Math.max(1, Math.ceil(list.length / MEDIA_PAGE_SIZE));
  if (mediaPage > totalPages) mediaPage = totalPages;
  if (mediaPage < 1) mediaPage = 1;
  const start = (mediaPage - 1) * MEDIA_PAGE_SIZE;
  const pageItems = list.slice(start, start + MEDIA_PAGE_SIZE);

  listEl.innerHTML = pageItems.map((m) => {
    const id = Number(m.id);
    const uploadDate = m.created_at
      ? new Date(Number(m.created_at) * 1000).toLocaleString('ko-KR')
      : '알 수 없음';
    const pubBadge = m.ws_public
      ? '<span class="badge bg-success bg-opacity-10 text-success border flex-shrink-0">공개</span>'
      : '<span class="badge bg-secondary bg-opacity-10 text-secondary border flex-shrink-0">비공개</span>';
    const linkBtn =
      `<button type="button" class="btn btn-sm btn-wiki-outline flex-shrink-0" onclick="window.showMediaBacklinks(${id}, this.dataset.filename)" data-filename="${esc(m.filename)}" title="이 이미지를 참조하는 문서"><i class="mdi mdi-link-variant"></i></button>`;
    const delBtn = canWrite
      ? `<button type="button" class="btn btn-sm btn-wiki btn-wiki-danger flex-shrink-0" onclick="window.deleteMedia(${id}, this.dataset.filename)" data-filename="${esc(m.filename)}" title="삭제"><i class="bi bi-trash"></i></button>`
      : '';
    // 화면 폭이 좁을 때 줄바꿈 대신 가로 스크롤(overflow-x). 각 요소는 축소/줄바꿈하지 않는다.
    return `
      <div class="d-flex align-items-center gap-2 px-1 py-2 border-bottom" id="ws-media-item-${id}" style="overflow-x:auto;">
        <a href="${esc(m.url)}" target="_blank" rel="noopener" class="flex-shrink-0" title="${esc(m.filename)} 원본 열기">
          <img src="${esc(m.url)}" alt="${esc(m.filename)}" loading="lazy" style="width:56px;height:56px;object-fit:cover;border-radius:var(--wiki-radius-base);border:1px solid var(--bs-border-color,#dee2e6);display:block;">
        </a>
        <div class="me-auto flex-shrink-0">
          <div class="fw-medium" style="white-space:nowrap;">${esc(m.filename)}</div>
          <div class="text-muted small" style="white-space:nowrap;">${humanBytes(m.size)} · ${uploadDate}</div>
        </div>
        ${pubBadge}
        ${linkBtn}
        ${delBtn}
      </div>`;
  }).join('');

  renderMediaPager(pagerEl, totalPages);

  totalInfo.textContent =
    mediaSearch && list.length !== mediaItems.length
      ? `총 ${mediaItems.length}개 중 ${list.length}개 표시`
      : `총 ${mediaItems.length}개`;
}

// 페이지네이션 컨트롤 렌더링. 페이지가 1개면 표시하지 않는다.
function renderMediaPager(pagerEl, totalPages) {
  if (totalPages <= 1) {
    pagerEl.innerHTML = '';
    return;
  }
  // 현재 페이지 주변 윈도우(±2)만 번호로 노출.
  const win = [];
  const from = Math.max(1, mediaPage - 2);
  const to = Math.min(totalPages, mediaPage + 2);
  for (let p = from; p <= to; p++) win.push(p);

  const item = (label, page, opts = {}) => {
    const disabled = opts.disabled ? ' disabled' : '';
    const active = opts.active ? ' active' : '';
    const inner = opts.disabled || opts.active
      ? `<span class="page-link">${label}</span>`
      : `<button type="button" class="page-link" onclick="window.gotoMediaPage(${page})">${label}</button>`;
    return `<li class="page-item${disabled}${active}">${inner}</li>`;
  };

  let html = '<ul class="pagination pagination-sm mb-0">';
  html += item('이전', mediaPage - 1, { disabled: mediaPage <= 1 });
  if (from > 1) {
    html += item('1', 1);
    if (from > 2) html += item('…', 0, { disabled: true });
  }
  for (const p of win) html += item(String(p), p, { active: p === mediaPage });
  if (to < totalPages) {
    if (to < totalPages - 1) html += item('…', 0, { disabled: true });
    html += item(String(totalPages), totalPages);
  }
  html += item('다음', mediaPage + 1, { disabled: mediaPage >= totalPages });
  html += '</ul>';
  pagerEl.innerHTML = html;
}

function gotoMediaPage(page) {
  mediaPage = Number(page) || 1;
  renderMedia();
  document.getElementById('mediaList')?.scrollIntoView({ block: 'nearest' });
}

function searchMedia() {
  mediaSearch = (document.getElementById('mediaSearchInput').value || '').trim();
  mediaPage = 1; // 검색어 변경 시 첫 페이지로
  renderMedia();
}

function changeMediaSort() {
  mediaSort = document.getElementById('mediaSortSelect').value;
  mediaPage = 1; // 정렬 변경 시 첫 페이지로
  renderMedia();
}

// 역링크 요청 일련번호 — 빠르게 다른 미디어의 역링크를 여는 경우, 늦게 도착한
// 이전 요청의 응답이 현재 모달을 다른 미디어 내용으로 덮어쓰지 않도록 최신 요청만 렌더한다.
let backlinksReqSeq = 0;

// 미디어 역링크: 이 이미지를 참조하는 문서 목록을 모달로 표시.
async function showMediaBacklinks(id, filename) {
  const seq = ++backlinksReqSeq;
  // 이 요청 전용 로딩 팝업이 (렌더 전에) 닫혔는지 추적한다. 전역 Swal.isVisible() 은
  // 사용자가 로딩을 닫고 연 다른 팝업(삭제/GC 확인 등)까지 "떠 있음"으로 보므로,
  // 이 팝업의 didClose 로만 닫힘을 판정해 무관한 모달을 덮어쓰지 않게 한다.
  let dismissed = false;
  Swal.fire({
    title: '참조 문서',
    html: '<div class="text-muted small py-3">불러오는 중...</div>',
    showConfirmButton: false,
    showCloseButton: true,
    didOpen: () => Swal.showLoading(),
    // 렌더 전에 이 로딩 팝업이 닫히는 경우는 (1) 사용자가 직접 닫음,
    // (2) 더 새로운 역링크 요청이 새 팝업으로 교체 — 어느 쪽이든 이 응답은 폐기 대상.
    didClose: () => { dismissed = true; },
  });

  // 응답을 모달로 렌더해도 되는지: 더 새로운 요청이 없고(seq 최신) 이 팝업이 닫히지 않았어야 한다.
  const stillCurrent = () => !dismissed && seq === backlinksReqSeq;

  let backlinks;
  try {
    const data = await apiGet(wbase() + '/media/' + Number(id) + '/backlinks');
    backlinks = Array.isArray(data.backlinks) ? data.backlinks : [];
  } catch (e) {
    if (stillCurrent()) Swal.fire('오류', '참조 문서를 불러오지 못했습니다.', 'error');
    return;
  }

  // 다른 미디어를 새로 열었거나 사용자가 로딩 모달을 닫았다면 이 응답은 폐기.
  if (!stillCurrent()) return;

  const wsPrefix = '/ws/' + encodeURIComponent(WSLUG) + '/w/';
  const body = backlinks.length
    ? '<ul class="list-group list-group-flush text-start">' +
        backlinks.map((b) => {
          const slug = String(b.slug || '');
          const label = b.title ? esc(b.title) : esc(slug);
          const href = wsPrefix + slug.split('/').map(encodeURIComponent).join('/');
          return `<li class="list-group-item px-2 py-2"><a href="${href}" target="_blank" rel="noopener"><i class="mdi mdi-file-document-outline me-1"></i>${label}</a><div class="text-muted small">${esc(slug)}</div></li>`;
        }).join('') +
      '</ul>'
    : '<div class="text-muted small py-3"><i class="bi bi-info-circle"></i> 이 이미지를 참조하는 문서가 없습니다.</div>';

  Swal.fire({
    title: esc(filename),
    html: body,
    showConfirmButton: false,
    showCloseButton: true,
    width: 480,
  });
}

async function deleteMedia(id, filename) {
  const confirm = await Swal.fire({
    title: '미디어 삭제',
    text: `"${filename}" 미디어를 삭제하시겠습니까? 되돌릴 수 없습니다.`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: '삭제',
    cancelButtonText: '취소',
    confirmButtonColor: '#dc3545',
  });
  if (!confirm.isConfirmed) return;

  const r = await send(wbase() + '/media/' + Number(id), 'DELETE');
  if (!r.ok) {
    Swal.fire('삭제 실패', r.body.error || '미디어를 삭제하지 못했습니다.', 'error');
    return;
  }
  toast('미디어를 삭제했습니다.');
  loadMedia();
}

// ──────────────────────────────────────────────────────────────
// 미디어 가비지 컬렉터 (canManage) — ws-settings 에서 이관
// ──────────────────────────────────────────────────────────────
async function scanGc() {
  const el = document.getElementById('gcList');
  el.innerHTML = window.uiSkeletonList(3);
  let items;
  try {
    const data = await apiGet(wbase() + '/media/gc');
    items = Array.isArray(data.items) ? data.items : [];
  } catch (e) {
    el.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: '불러오지 못했습니다' });
    return;
  }

  document.getElementById('gcDeleteSelectedBtn').classList.toggle('d-none', items.length === 0);
  document.getElementById('gcDeleteAllBtn').classList.toggle('d-none', items.length === 0);

  if (!items.length) {
    el.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-check2-circle', title: '미참조 미디어가 없습니다' });
    return;
  }

  el.innerHTML = items.map((m) => {
    const id = Number(m.id);
    // 화면 폭이 좁을 때 줄바꿈 대신 가로 스크롤(overflow-x).
    return `
      <label class="d-flex align-items-center gap-2 px-1 py-2 border-bottom" style="cursor:pointer;overflow-x:auto;">
        <input type="checkbox" class="form-check-input gc-check flex-shrink-0" value="${id}">
        <img src="${esc(m.url)}" alt="${esc(m.filename)}" loading="lazy" class="flex-shrink-0" style="width:48px;height:48px;object-fit:cover;border-radius:var(--wiki-radius-base);border:1px solid var(--bs-border-color,#dee2e6);display:block;">
        <span class="me-auto flex-shrink-0" style="white-space:nowrap;">${esc(m.filename)}</span>
        <span class="text-muted small flex-shrink-0">${humanBytes(m.size)}</span>
      </label>`;
  }).join('');
}

function selectedGcIds() {
  return Array.from(document.querySelectorAll('.gc-check'))
    .filter((c) => c.checked)
    .map((c) => Number(c.value));
}

async function deleteGcSelected() {
  const ids = selectedGcIds();
  if (!ids.length) {
    Swal.fire('선택 없음', '삭제할 미디어를 선택해주세요.', 'info');
    return;
  }
  const confirm = await Swal.fire({
    title: '선택 미디어 삭제',
    text: `${ids.length}개의 미참조 미디어를 삭제합니다. 되돌릴 수 없습니다.`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: '삭제',
    cancelButtonText: '취소',
    confirmButtonColor: '#dc3545',
  });
  if (!confirm.isConfirmed) return;
  await runGcDelete({ ids });
}

async function deleteGcAll() {
  const confirm = await Swal.fire({
    title: '전체 미디어 삭제',
    text: '미참조 미디어를 모두 삭제합니다. 되돌릴 수 없습니다.',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: '전체 삭제',
    cancelButtonText: '취소',
    confirmButtonColor: '#dc3545',
  });
  if (!confirm.isConfirmed) return;
  await runGcDelete({});
}

async function runGcDelete(payload) {
  const r = await send(wbase() + '/media/gc', 'POST', payload);
  if (!r.ok) {
    Swal.fire('삭제 실패', r.body.error || '미디어를 삭제하지 못했습니다.', 'error');
    return;
  }
  toast(`${Number(r.body.deleted || 0)}개의 미디어를 삭제했습니다.`);
  scanGc();
  loadMedia(); // 목록도 갱신
}

// HTML on* 핸들러에서 호출되므로 window 로 노출.
window.searchMedia = searchMedia;
window.changeMediaSort = changeMediaSort;
window.gotoMediaPage = gotoMediaPage;
window.showMediaBacklinks = showMediaBacklinks;
window.deleteMedia = deleteMedia;
window.scanGc = scanGc;
window.deleteGcSelected = deleteGcSelected;
window.deleteGcAll = deleteGcAll;
