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

// 미디어 목록 상태 (클라이언트 검색/정렬)
let mediaItems = []; // 서버에서 받은 원본 목록
let mediaSearch = '';
let mediaSort = 'date_desc';

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

  // 헤더/브레드크럼
  const wsLabel = ws.name || ws.slug || WSLUG;
  document.getElementById('wsMediaTitle').textContent = wsLabel + ' 미디어';
  document.getElementById('bcrWsName').textContent = wsLabel;
  document.getElementById('bcrWsLink').setAttribute('href', '/ws/' + encodeURIComponent(WSLUG));
  document.getElementById('backToWsBtn').setAttribute('href', '/ws/' + encodeURIComponent(WSLUG));

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
  const totalInfo = document.getElementById('mediaTotalInfo');

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

  listEl.innerHTML = list.map((m) => {
    const id = Number(m.id);
    const uploadDate = m.created_at
      ? new Date(Number(m.created_at) * 1000).toLocaleString('ko-KR')
      : '알 수 없음';
    const pubBadge = m.ws_public
      ? '<span class="badge bg-success bg-opacity-10 text-success border flex-shrink-0">공개</span>'
      : '<span class="badge bg-secondary bg-opacity-10 text-secondary border flex-shrink-0">비공개</span>';
    const delBtn = canWrite
      ? `<button type="button" class="btn btn-sm btn-wiki btn-wiki-danger flex-shrink-0" onclick="window.deleteMedia(${id}, this.dataset.filename)" data-filename="${esc(m.filename)}" title="삭제"><i class="bi bi-trash"></i></button>`
      : '';
    return `
      <div class="d-flex align-items-center gap-2 px-1 py-2 border-bottom" id="ws-media-item-${id}">
        <a href="${esc(m.url)}" target="_blank" rel="noopener" class="flex-shrink-0" title="${esc(m.filename)} 원본 열기">
          <img src="${esc(m.url)}" alt="${esc(m.filename)}" loading="lazy" style="width:56px;height:56px;object-fit:cover;border-radius:var(--wiki-radius-base);border:1px solid var(--bs-border-color,#dee2e6);display:block;">
        </a>
        <div class="me-auto" style="min-width:0;">
          <div class="text-truncate fw-medium">${esc(m.filename)}</div>
          <div class="text-muted small">${humanBytes(m.size)} · ${uploadDate}</div>
        </div>
        ${pubBadge}
        ${delBtn}
      </div>`;
  }).join('');

  totalInfo.textContent =
    mediaSearch && list.length !== mediaItems.length
      ? `총 ${mediaItems.length}개 중 ${list.length}개 표시`
      : `총 ${mediaItems.length}개`;
}

function searchMedia() {
  mediaSearch = (document.getElementById('mediaSearchInput').value || '').trim();
  renderMedia();
}

function changeMediaSort() {
  mediaSort = document.getElementById('mediaSortSelect').value;
  renderMedia();
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
    return `
      <label class="d-flex align-items-center gap-2 px-1 py-2 border-bottom" style="cursor:pointer;">
        <input type="checkbox" class="form-check-input gc-check flex-shrink-0" value="${id}">
        <span class="text-truncate me-auto">${esc(m.filename)}</span>
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
window.deleteMedia = deleteMedia;
window.scanGc = scanGc;
window.deleteGcSelected = deleteGcSelected;
window.deleteGcAll = deleteGcAll;
