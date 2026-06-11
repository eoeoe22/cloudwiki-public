// @ts-nocheck — ws-dashboard.html (워크스페이스 대시보드 /ws/:wslug) 부트스트랩.
// common.ts 가 window.* 로 노출하는 공통 전역(loadConfig/checkAuth/escapeHtml/getRelativeTime/
// uiEmptyState/uiSkeletonList)을 사용한다. wslug 는 location.pathname 2번째 세그먼트에서 파싱한다.
// any 형태 fetch 응답이라 타입 검사를 끈다.

import { apiGet } from '../utils/api';
import { workspaceIconClass } from '../../shared/workspaceIcon';

const esc = (s) => window.escapeHtml(String(s ?? ''));

// /ws/<wslug>[/...] → 2번째 세그먼트
function parseWslug() {
  const parts = location.pathname.split('/').filter(Boolean); // ['ws', '<wslug>', ...]
  if (parts[0] !== 'ws' || !parts[1]) return '';
  try {
    return decodeURIComponent(parts[1]);
  } catch {
    return parts[1];
  }
}

const WSLUG = parseWslug();

// 바이트 휴머나이즈
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

// updated_at(unix 초)을 상대 시간으로
function rel(unix) {
  const n = Number(unix);
  return Number.isFinite(n) ? window.getRelativeTime(n) : '';
}

document.addEventListener('DOMContentLoaded', async () => {
  await window.loadConfig();
  await window.checkAuth();
  initDashboard();
});

async function initDashboard() {
  const loadingEl = document.getElementById('wsLoading');
  const contentEl = document.getElementById('wsContent');
  const errorEl = document.getElementById('wsError');

  if (!WSLUG) {
    loadingEl.classList.add('d-none');
    errorEl.classList.remove('d-none');
    return;
  }

  let meta;
  try {
    meta = await apiGet('/api/ws/' + encodeURIComponent(WSLUG));
  } catch (e) {
    console.error('워크스페이스 로드 실패:', e);
    loadingEl.classList.add('d-none');
    const msg = String(e && e.message || '');
    const titleEl = document.getElementById('wsErrorTitle');
    if (titleEl && /403/.test(msg)) titleEl.textContent = '접근 권한이 없습니다';
    errorEl.classList.remove('d-none');
    return;
  }

  renderHeader(meta);
  loadingEl.classList.add('d-none');
  contentEl.classList.remove('d-none');

  // 각 섹션 독립 로드 (한 섹션 실패가 나머지를 막지 않도록)
  loadRecentDocs();
  loadMedia();
  loadMembers();
}

function renderHeader(meta) {
  const ws = meta.workspace || {};
  const access = meta.access || {};
  const stats = meta.stats || {};

  document.getElementById('wsIcon').className = workspaceIconClass(ws.icon) + ' text-primary';
  document.getElementById('wsName').textContent = ws.name || ws.slug || '워크스페이스';
  document.getElementById('wsSlug').textContent = ws.slug || '';

  // 통계 배지
  const n = (v) => Number(v || 0).toLocaleString();
  const badge = (icon, color, label, value) =>
    `<span class="badge bg-${color} bg-opacity-10 text-${color} border px-3 py-2" style="font-size:0.9rem;">
       <i class="bi ${icon}"></i> ${label} <strong>${value}</strong></span>`;
  document.getElementById('wsStats').innerHTML = [
    badge('bi-file-earmark-text', 'primary', '문서', n(stats.pages)),
    badge('bi-image', 'secondary', '미디어', n(stats.media)),
    badge('bi-hdd', 'info', '용량', humanBytes(stats.media_bytes)),
    badge('bi-people', 'success', '멤버', n(stats.members)),
  ].join('');

  // 툴바 — 폴더 뷰 진입은 '전체 문서 보기' 버튼으로 이관, 여기엔 새 문서/설정만 둔다.
  const wenc = encodeURIComponent(WSLUG);
  const tools = [];
  if (access.canWrite) {
    tools.push(`<a href="/ws/${wenc}/edit" class="btn btn-wiki btn-sm"><i class="bi bi-plus-lg"></i> 새 문서</a>`);
  }
  if (access.canManage) {
    tools.push(`<a href="/ws/${wenc}/settings" class="btn btn-wiki-outline btn-sm"><i class="bi bi-gear"></i> 설정</a>`);
  }
  document.getElementById('wsToolbar').innerHTML = tools.join('');

  // '전체 문서 보기' → 폴더 뷰
  document.getElementById('wsAllDocsBtn').setAttribute('href', '/ws/' + wenc + '/files');

  // 멤버 초대 토글 (canManage 만)
  if (access.canManage) {
    document.getElementById('wsInviteToggle').classList.remove('d-none');
  }
}

// ── 빠른 최근 문서 (updated_at DESC 상위 8) ──
async function loadRecentDocs() {
  const pagesEl = document.getElementById('wsPagesList');
  pagesEl.innerHTML = window.uiSkeletonList(5);

  let pages;
  try {
    const data = await apiGet('/api/ws/' + encodeURIComponent(WSLUG) + '/pages?top=1');
    pages = Array.isArray(data.pages) ? data.pages : [];
  } catch (e) {
    pagesEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: '불러오지 못했습니다' });
    return;
  }

  const wenc = encodeURIComponent(WSLUG);
  const docHref = (slug) => '/ws/' + wenc + '/w/' + encodeURIComponent(slug);

  const recent = pages.slice(0, 8);
  if (!recent.length) {
    pagesEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-file-earmark-plus', title: '문서가 없습니다', text: '첫 문서를 작성해 보세요.' });
    return;
  }
  pagesEl.innerHTML = recent.map((p) => `
    <a href="${docHref(p.slug)}" class="d-flex align-items-center justify-content-between text-decoration-none text-body px-2 py-2 border-bottom">
      <span class="text-truncate me-2 fw-medium">${esc(p.title || p.slug)}</span>
      <span class="text-muted small flex-shrink-0">${rel(p.updated_at)}</span>
    </a>`).join('');
}

// ── 미디어 목록 (썸네일 그리드) ──
async function loadMedia() {
  const el = document.getElementById('wsMediaList');
  el.innerHTML = window.uiSkeletonList(2);

  let items;
  try {
    const data = await apiGet('/api/ws/' + encodeURIComponent(WSLUG) + '/media');
    items = Array.isArray(data.items) ? data.items : [];
  } catch (e) {
    el.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: '불러오지 못했습니다' });
    return;
  }

  if (!items.length) {
    el.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-image', title: '미디어가 없습니다' });
    return;
  }

  const grid = items.slice(0, 12).map((m) => `
    <div class="ws-media-thumb" style="width:72px;height:72px;border-radius:6px;overflow:hidden;border:1px solid var(--bs-border-color,#dee2e6);flex:0 0 auto;">
      <img src="${esc(m.url)}" alt="${esc(m.filename)}" title="${esc(m.filename)}" loading="lazy"
           style="width:100%;height:100%;object-fit:cover;display:block;">
    </div>`).join('');
  el.innerHTML = `<div class="d-flex flex-wrap gap-2">${grid}</div>`;
}

// ── 참가자 목록 ──
async function loadMembers() {
  const el = document.getElementById('wsMembersList');
  el.innerHTML = window.uiSkeletonList(4);

  let data;
  try {
    data = await apiGet('/api/ws/' + encodeURIComponent(WSLUG) + '/members');
  } catch (e) {
    el.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: '불러오지 못했습니다' });
    return;
  }

  const rows = [];
  if (data.owner) rows.push(memberRow(data.owner));
  for (const m of data.members || []) rows.push(memberRow(m));

  if (!rows.length) {
    el.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-people', title: '참가자가 없습니다' });
    return;
  }
  el.innerHTML = rows.join('');
}

function roleBadge(role) {
  const map = {
    owner: ['소유자', 'warning'],
    editor: ['editor', 'primary'],
    viewer: ['viewer', 'secondary'],
  };
  const [label, color] = map[role] || [role, 'secondary'];
  return `<span class="badge bg-${color} bg-opacity-10 text-${color} border flex-shrink-0">${esc(label)}</span>`;
}

function memberRow(m) {
  const avatar = m.picture
    ? `<img src="${esc(m.picture)}" alt="" class="rounded-circle flex-shrink-0" style="width:28px;height:28px;object-fit:cover;">`
    : `<span class="rounded-circle bg-light d-inline-flex align-items-center justify-content-center flex-shrink-0" style="width:28px;height:28px;"><i class="bi bi-person text-muted"></i></span>`;
  return `
    <div class="d-flex align-items-center gap-2 px-1 py-2 border-bottom">
      ${avatar}
      <a href="/profile/${Number(m.id)}" class="text-decoration-none text-body text-truncate me-auto">${esc(m.name || '알 수 없음')}</a>
      ${roleBadge(m.role)}
    </div>`;
}

// ── 멤버 초대 (canManage) — 설정 페이지의 초대 흐름을 대시보드에 이식 ──
let inviteSearchTimer = null;
let inviteSearchSeq = 0;

function toggleWsInvite() {
  const area = document.getElementById('wsInviteArea');
  if (!area) return;
  const willShow = area.classList.contains('d-none');
  area.classList.toggle('d-none', !willShow);
  if (willShow) {
    const input = document.getElementById('wsInviteSearch');
    if (input) input.focus();
  }
}

function onWsInviteSearch() {
  if (inviteSearchTimer) clearTimeout(inviteSearchTimer);
  inviteSearchTimer = setTimeout(runWsInviteSearch, 250);
}

async function runWsInviteSearch() {
  const q = (document.getElementById('wsInviteSearch').value || '').trim();
  const el = document.getElementById('wsInviteResults');
  if (q.length < 1) {
    el.innerHTML = '';
    return;
  }
  const seq = ++inviteSearchSeq;
  try {
    const data = await apiGet('/api/ws/' + encodeURIComponent(WSLUG) + '/members/search?q=' + encodeURIComponent(q));
    if (seq !== inviteSearchSeq) return; // stale guard
    const results = data.results || [];
    if (!results.length) {
      el.innerHTML = '<div class="list-group-item text-muted small">검색 결과가 없습니다.</div>';
      return;
    }
    el.innerHTML = results.map((u) => {
      const id = Number(u.id);
      const avatar = u.picture
        ? `<img src="${esc(u.picture)}" alt="" class="rounded-circle" style="width:24px;height:24px;object-fit:cover;">`
        : `<i class="bi bi-person-circle text-muted"></i>`;
      return `
        <button type="button" class="list-group-item list-group-item-action d-flex align-items-center gap-2" onclick="wsInviteUser(${id})">
          ${avatar}
          <span class="text-truncate">${esc(u.name || '이름 없음')}</span>
          <i class="bi bi-plus-lg ms-auto"></i>
        </button>`;
    }).join('');
  } catch (e) {
    if (seq !== inviteSearchSeq) return;
    el.innerHTML = '<div class="list-group-item text-danger small">검색 중 오류가 발생했습니다.</div>';
  }
}

async function wsInviteUser(userId) {
  const role = document.getElementById('wsInviteRole').value === 'editor' ? 'editor' : 'viewer';
  const res = await fetch('/api/ws/' + encodeURIComponent(WSLUG) + '/members', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: Number(userId), role }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    Swal.fire('초대 실패', body.error || '멤버를 추가하지 못했습니다.', 'error');
    return;
  }
  Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: '멤버를 추가했습니다.', showConfirmButton: false, timer: 2000, timerProgressBar: true });
  document.getElementById('wsInviteSearch').value = '';
  document.getElementById('wsInviteResults').innerHTML = '';
  loadMembers();
}

// HTML on* 핸들러에서 호출되므로 window 로 노출.
window.toggleWsInvite = toggleWsInvite;
window.onWsInviteSearch = onWsInviteSearch;
window.wsInviteUser = wsInviteUser;
