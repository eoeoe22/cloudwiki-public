// @ts-nocheck — ws-settings.html (워크스페이스 설정 /ws/:wslug/settings) 부트스트랩.
// canManage 가 아닌 사용자는 안내 후 대시보드로 돌려보낸다. wslug 는 location.pathname
// 2번째 세그먼트에서 파싱한다. common.ts 가 window.* 로 노출하는 공통 전역
// (loadConfig/checkAuth/escapeHtml/uiEmptyState/uiSkeletonList)을 사용한다.
// any 형태 fetch 응답이라 타입 검사를 끈다.

import { apiGet } from '../utils/api';
import { workspaceIconClass } from '../../shared/workspaceIcon';

const esc = (s) => window.escapeHtml(String(s ?? ''));

// 현재 편집 중인 워크스페이스 아이콘(class 문자열, null = 기본). 저장 시 PUT 본문에 포함.
let currentIcon = null;

function parseWslug() {
  const parts = location.pathname.split('/').filter(Boolean); // ['ws', '<wslug>', 'settings']
  if (parts[0] !== 'ws' || !parts[1]) return '';
  try {
    return decodeURIComponent(parts[1]);
  } catch {
    return parts[1];
  }
}

let WSLUG = parseWslug();
const wbase = () => '/api/ws/' + encodeURIComponent(WSLUG);

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

document.addEventListener('DOMContentLoaded', async () => {
  await window.loadConfig();
  await window.checkAuth();
  initSettings();
});

async function initSettings() {
  const loadingEl = document.getElementById('wsLoading');
  const contentEl = document.getElementById('wsContent');

  if (!WSLUG) {
    Swal.fire('오류', '워크스페이스 제목을 확인할 수 없습니다.', 'error').then(() => {
      location.href = '/workspaces';
    });
    return;
  }

  let meta;
  try {
    meta = await apiGet(wbase());
  } catch (e) {
    loadingEl.innerHTML = window.uiEmptyState({
      icon: 'bi bi-exclamation-triangle',
      title: '불러오지 못했습니다',
      text: '존재하지 않거나 접근 권한이 없는 워크스페이스입니다.',
      cta: { label: '내 워크스페이스로', href: '/workspaces' },
    });
    return;
  }

  const access = meta.access || {};
  if (!access.canManage) {
    await Swal.fire('권한 없음', '이 워크스페이스를 관리할 권한이 없습니다.', 'info');
    location.href = '/ws/' + encodeURIComponent(WSLUG);
    return;
  }

  // 헤더/정보 폼 채우기
  const ws = meta.workspace || {};
  document.getElementById('wsSettingsTitle').textContent = (ws.name || ws.slug) + ' 설정';
  document.getElementById('wsNameInput').value = ws.name || '';
  document.getElementById('wsSlugInput').value = ws.slug || '';
  currentIcon = ws.icon || null;
  renderWsIconBtn();
  document.getElementById('backToWsBtn').setAttribute('href', '/ws/' + encodeURIComponent(WSLUG));

  loadingEl.classList.add('d-none');
  contentEl.classList.remove('d-none');

  loadMembers();
}

// ──────────────────────────────────────────────────────────────
// 1. 참가자 관리 + 3. 소유권 이전 대상 채우기 (members 한 번 로드로 공유)
// ──────────────────────────────────────────────────────────────
async function loadMembers() {
  const el = document.getElementById('membersManage');
  el.innerHTML = window.uiSkeletonList(4);

  let data;
  try {
    data = await apiGet(wbase() + '/members');
  } catch (e) {
    el.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: '불러오지 못했습니다' });
    return;
  }

  const members = data.members || [];

  // 참가자 관리 표 (owner 는 읽기 전용, members 는 역할 변경/추방 가능)
  const rows = [];
  if (data.owner) rows.push(ownerRow(data.owner));
  for (const m of members) rows.push(manageRow(m));
  el.innerHTML = rows.length
    ? rows.join('')
    : window.uiEmptyState({ compact: true, icon: 'bi bi-people', title: '소유자 외 참가자가 없습니다' });

  // 소유권 이전 드롭다운 (정식 멤버 active 만 대상 — 대기중 초대는 제외)
  const sel = document.getElementById('transferTarget');
  const activeMembers = members.filter((m) => m.status !== 'pending');
  if (!activeMembers.length) {
    sel.innerHTML = '<option value="">이전 가능한 멤버가 없습니다</option>';
    sel.disabled = true;
  } else {
    sel.disabled = false;
    sel.innerHTML = activeMembers
      .map((m) => `<option value="${Number(m.id)}">${esc(m.name || '알 수 없음')} (${esc(m.role)})</option>`)
      .join('');
  }
}

function avatarHtml(picture) {
  return picture
    ? `<img src="${esc(picture)}" alt="" class="rounded-circle flex-shrink-0" style="width:28px;height:28px;object-fit:cover;">`
    : `<span class="rounded-circle bg-light d-inline-flex align-items-center justify-content-center flex-shrink-0" style="width:28px;height:28px;"><i class="bi bi-person text-muted"></i></span>`;
}

function ownerRow(owner) {
  return `
    <div class="d-flex align-items-center gap-2 px-1 py-2 border-bottom">
      ${avatarHtml(owner.picture)}
      <a href="/profile/${Number(owner.id)}" class="text-decoration-none text-body text-truncate me-auto">${esc(owner.name || '알 수 없음')}</a>
      <span class="badge bg-warning bg-opacity-10 text-warning border flex-shrink-0">소유자</span>
    </div>`;
}

function manageRow(m) {
  const id = Number(m.id);
  const name = String(m.name || '알 수 없음');
  const isPending = m.status === 'pending';
  // 대기중(pending) 초대는 '초대 대기중' 배지를 달고, 추방 버튼은 '초대 취소' 로 표기한다.
  const pendingBadge = isPending
    ? `<span class="badge bg-warning bg-opacity-10 text-warning border flex-shrink-0">초대 대기중</span>`
    : '';
  const removeLabel = isPending
    ? `<i class="bi bi-x-circle"></i> 초대 취소`
    : `<i class="bi bi-person-x"></i> 추방`;
  // 이름은 data-name 속성에 담고(이중 이스케이프), kickMember 는 id 로 행에서 읽는다.
  return `
    <div class="d-flex align-items-center gap-2 px-1 py-2 border-bottom" data-member-id="${id}" data-member-name="${esc(name)}" data-member-pending="${isPending ? '1' : '0'}">
      ${avatarHtml(m.picture)}
      <a href="/profile/${id}" class="text-decoration-none text-body text-truncate me-auto">${esc(name)}</a>
      ${pendingBadge}
      <select class="form-select form-select-sm flex-shrink-0" style="width:auto;" onchange="changeMemberRole(${id}, this.value)">
        <option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>viewer</option>
        <option value="editor" ${m.role === 'editor' ? 'selected' : ''}>editor</option>
      </select>
      <button type="button" class="btn btn-wiki btn-wiki-danger btn-sm flex-shrink-0" onclick="kickMember(${id})">
        ${removeLabel}
      </button>
    </div>`;
}

async function changeMemberRole(userId, role) {
  const r = await send(wbase() + '/members/' + Number(userId), 'PATCH', { role });
  if (!r.ok) {
    Swal.fire('변경 실패', r.body.error || '역할을 변경하지 못했습니다.', 'error');
    loadMembers();
    return;
  }
  toast('역할이 변경되었습니다.');
}

async function kickMember(userId) {
  const row = document.querySelector(`[data-member-id="${Number(userId)}"]`);
  const name = row ? row.getAttribute('data-member-name') : '';
  const isPending = row ? row.getAttribute('data-member-pending') === '1' : false;
  const confirm = await Swal.fire({
    title: isPending ? '초대 취소' : '멤버 추방',
    text: isPending
      ? (name || '이 사용자') + ' 님에게 보낸 초대를 취소하시겠습니까?'
      : (name || '이 멤버') + ' 님을 워크스페이스에서 추방하시겠습니까?',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: isPending ? '초대 취소' : '추방',
    cancelButtonText: '취소',
    confirmButtonColor: '#dc3545',
  });
  if (!confirm.isConfirmed) return;
  const r = await send(wbase() + '/members/' + Number(userId), 'DELETE');
  if (!r.ok) {
    Swal.fire(isPending ? '취소 실패' : '추방 실패', r.body.error || '요청을 처리하지 못했습니다.', 'error');
    return;
  }
  toast(isPending ? '초대를 취소했습니다.' : '멤버를 추방했습니다.');
  loadMembers();
}

// ──────────────────────────────────────────────────────────────
// 2. 초대 (사용자 검색 → 추가)
// ──────────────────────────────────────────────────────────────
let inviteSearchTimer = null;
let inviteSearchSeq = 0;

function onInviteSearch() {
  if (inviteSearchTimer) clearTimeout(inviteSearchTimer);
  inviteSearchTimer = setTimeout(runInviteSearch, 250);
}

async function runInviteSearch() {
  const q = (document.getElementById('inviteSearch').value || '').trim();
  const el = document.getElementById('inviteResults');
  if (q.length < 1) {
    el.innerHTML = '';
    return;
  }
  const seq = ++inviteSearchSeq;
  try {
    const data = await apiGet(wbase() + '/members/search?q=' + encodeURIComponent(q));
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
        <button type="button" class="list-group-item list-group-item-action d-flex align-items-center gap-2" onclick="inviteUser(${id})">
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

async function inviteUser(userId) {
  const role = document.getElementById('inviteRole').value === 'editor' ? 'editor' : 'viewer';
  const r = await send(wbase() + '/members', 'POST', { user_id: Number(userId), role });
  if (!r.ok) {
    Swal.fire('초대 실패', r.body.error || '초대를 보내지 못했습니다.', 'error');
    return;
  }
  toast('초대를 보냈습니다. 상대가 수락하면 멤버가 됩니다.');
  document.getElementById('inviteSearch').value = '';
  document.getElementById('inviteResults').innerHTML = '';
  loadMembers();
}

// ──────────────────────────────────────────────────────────────
// 3. 소유권 이전
// ──────────────────────────────────────────────────────────────
async function doTransfer() {
  const sel = document.getElementById('transferTarget');
  const userId = Number(sel.value);
  if (!Number.isInteger(userId) || userId <= 0) {
    Swal.fire('대상 없음', '이전할 멤버를 선택해주세요.', 'info');
    return;
  }
  const label = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : '';
  const confirm = await Swal.fire({
    title: '소유권 이전',
    html: `<strong>${esc(label)}</strong> 님에게 소유권을 이전합니다.<br>이전 후 본인은 editor 로 강등됩니다. 계속할까요?`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: '이전',
    cancelButtonText: '취소',
    confirmButtonColor: '#ffc107',
  });
  if (!confirm.isConfirmed) return;
  const r = await send(wbase() + '/transfer', 'POST', { user_id: userId });
  if (!r.ok) {
    Swal.fire('이전 실패', r.body.error || '소유권을 이전하지 못했습니다.', 'error');
    return;
  }
  await Swal.fire('완료', '소유권을 이전했습니다.', 'success');
  location.href = '/ws/' + encodeURIComponent(WSLUG);
}

// ──────────────────────────────────────────────────────────────
// 4. 워크스페이스 정보 (이름/주소/아이콘 변경)
// 미디어 가비지 컬렉터는 미디어 관리 페이지(/ws/:wslug/media, ws-media.ts)로 이관됨.
// ──────────────────────────────────────────────────────────────
function renderWsIconBtn() {
  const btn = document.getElementById('wsIconBtn');
  if (!btn) return;
  const cls = esc(workspaceIconClass(currentIcon));
  btn.innerHTML = `<i class="${cls}" aria-hidden="true"></i> <span>아이콘 변경</span>`;
}

async function pickWsIcon() {
  const picked = window.pickWikiIcon ? await window.pickWikiIcon() : null;
  // '아이콘 없음'(null) → 기본 아이콘으로 되돌림.
  currentIcon = picked || null;
  renderWsIconBtn();
}

async function saveWsInfo() {
  const name = (document.getElementById('wsNameInput').value || '').trim();
  const slug = (document.getElementById('wsSlugInput').value || '').trim();
  if (!name) {
    Swal.fire('대체 제목 필요', '워크스페이스 대체 제목을 입력해주세요.', 'info');
    return;
  }
  if (!slug) {
    Swal.fire('제목 필요', '워크스페이스 제목을 입력해주세요.', 'info');
    return;
  }
  const r = await send(wbase(), 'PUT', { name, slug, icon: currentIcon });
  if (!r.ok) {
    Swal.fire('저장 실패', r.body.error || '저장하지 못했습니다.', 'error');
    return;
  }
  // slug 가 바뀌었으면 새 주소의 설정 페이지로 이동
  if (r.body.slug && r.body.slug !== WSLUG) {
    location.href = '/ws/' + encodeURIComponent(r.body.slug) + '/settings';
    return;
  }
  toast('워크스페이스 정보를 저장했습니다.');
  document.getElementById('wsSettingsTitle').textContent = (r.body.name || name) + ' 설정';
}

// ──────────────────────────────────────────────────────────────
// 5. 워크스페이스 삭제
// ──────────────────────────────────────────────────────────────
async function deleteWorkspace() {
  const confirm = await Swal.fire({
    title: '워크스페이스 삭제',
    html: '정말로 이 워크스페이스를 삭제하시겠습니까?<br>소속 문서와 미디어에 접근할 수 없게 됩니다.<br><br>확인하려면 아래에 워크스페이스 제목을 입력하세요.',
    icon: 'warning',
    input: 'text',
    inputPlaceholder: WSLUG,
    showCancelButton: true,
    confirmButtonText: '삭제',
    cancelButtonText: '취소',
    confirmButtonColor: '#dc3545',
    preConfirm: (val) => {
      if ((val || '').trim() !== WSLUG) {
        Swal.showValidationMessage('워크스페이스 제목이 일치하지 않습니다.');
        return false;
      }
      return true;
    },
  });
  if (!confirm.isConfirmed) return;
  const r = await send(wbase(), 'DELETE');
  if (!r.ok) {
    Swal.fire('삭제 실패', r.body.error || '워크스페이스를 삭제하지 못했습니다.', 'error');
    return;
  }
  await Swal.fire('삭제됨', '워크스페이스를 삭제했습니다.', 'success');
  location.href = '/workspaces';
}

// 간단 토스트
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

// HTML onclick/oninput/onchange 에서 호출되므로 window 로 노출.
window.changeMemberRole = changeMemberRole;
window.kickMember = kickMember;
window.onInviteSearch = onInviteSearch;
window.inviteUser = inviteUser;
window.doTransfer = doTransfer;
window.saveWsInfo = saveWsInfo;
window.pickWsIcon = pickWsIcon;
window.deleteWorkspace = deleteWorkspace;
