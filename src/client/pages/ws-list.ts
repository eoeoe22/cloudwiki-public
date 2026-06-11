// @ts-nocheck — workspaces.html (내 워크스페이스 목록) 부트스트랩.
// common.ts 가 window.* 로 노출하는 공통 전역(loadConfig/checkAuth/escapeHtml/getRelativeTime/
// uiEmptyState)을 사용한다. any 형태 fetch 응답이라 타입 검사를 끈다.

import { apiGet } from '../utils/api';
import { workspaceIconClass } from '../../shared/workspaceIcon';

const esc = (s) => window.escapeHtml(String(s ?? ''));

document.addEventListener('DOMContentLoaded', async () => {
  await window.loadConfig();
  await window.checkAuth();
  loadWorkspaces();
});

async function loadWorkspaces() {
  const loadingEl = document.getElementById('wsLoading');
  const contentEl = document.getElementById('wsContent');
  try {
    const data = await apiGet('/api/workspaces');

    if (data.can_create) {
      document.getElementById('createWsBtn').classList.remove('d-none');
    }

    renderInvites(data.invites || []);
    renderOwned(data.owned || []);
    renderJoined(data.joined || []);

    loadingEl.classList.add('d-none');
    contentEl.classList.remove('d-none');
  } catch (e) {
    console.error('워크스페이스 목록 로드 실패:', e);
    loadingEl.innerHTML = window.uiEmptyState({
      icon: 'bi bi-exclamation-triangle',
      title: '불러오지 못했습니다',
      text: '로그인이 필요하거나 일시적인 오류일 수 있습니다.',
      cta: { label: '로그인', href: '/login?redirect=' + encodeURIComponent('/workspaces') },
    });
  }
}

function wsCard(ws, roleBadge) {
  const iconCls = esc(workspaceIconClass(ws.icon));
  return `
    <div class="col-12 col-sm-6 col-lg-4">
      <a href="/ws/${encodeURIComponent(ws.slug)}" class="card h-100 text-decoration-none text-body workspace-card">
        <div class="card-body">
          <div class="d-flex align-items-center gap-2 mb-1">
            <i class="${iconCls} text-primary flex-shrink-0" style="font-size:1.1rem;" aria-hidden="true"></i>
            <h6 class="card-title mb-0 text-truncate flex-grow-1">${esc(ws.name || ws.slug)}</h6>
            ${roleBadge || ''}
          </div>
          <p class="card-text text-muted small mb-0 text-truncate">${esc(ws.slug)}</p>
        </div>
      </a>
    </div>`;
}

function renderOwned(items) {
  const el = document.getElementById('ownedList');
  if (!items.length) {
    el.innerHTML = `<div class="col-12">${window.uiEmptyState({ compact: true, icon: 'bi bi-folder-plus', title: '소유한 워크스페이스가 없습니다', text: '새 워크스페이스를 만들어 보세요.' })}</div>`;
    return;
  }
  el.innerHTML = items.map((ws) => wsCard(ws, '')).join('');
}

function renderJoined(items) {
  const el = document.getElementById('joinedList');
  if (!items.length) {
    el.innerHTML = `<div class="col-12">${window.uiEmptyState({ compact: true, icon: 'bi bi-people', title: '참가 중인 워크스페이스가 없습니다' })}</div>`;
    return;
  }
  el.innerHTML = items.map((ws) => {
    const role = ws.my_role === 'editor' ? 'editor' : ws.my_role === 'viewer' ? 'viewer' : esc(ws.my_role);
    const color = ws.my_role === 'editor' ? 'primary' : 'secondary';
    const badge = `<span class="badge bg-${color} bg-opacity-10 text-${color} border flex-shrink-0">${esc(role)}</span>`;
    return wsCard(ws, badge);
  }).join('');
}

// ── 받은 초대 (수락/거절) ──
function renderInvites(items) {
  const section = document.getElementById('invitesSection');
  const el = document.getElementById('invitesList');
  if (!section || !el) return;
  if (!items.length) {
    section.classList.add('d-none');
    el.innerHTML = '';
    return;
  }
  section.classList.remove('d-none');
  el.innerHTML = items.map((ws) => {
    const iconCls = esc(workspaceIconClass(ws.icon));
    const slug = encodeURIComponent(ws.slug);
    const role = ws.my_role === 'editor' ? 'editor' : 'viewer';
    const color = ws.my_role === 'editor' ? 'primary' : 'secondary';
    const roleBadge = `<span class="badge bg-${color} bg-opacity-10 text-${color} border flex-shrink-0">${esc(role)}</span>`;
    const owner = ws.owner_name ? `<p class="card-text text-muted small mb-2 text-truncate">${esc(ws.owner_name)}님의 초대</p>` : '';
    return `
      <div class="col-12 col-sm-6 col-lg-4">
        <div class="card h-100 workspace-card" data-invite-slug="${slug}">
          <div class="card-body d-flex flex-column">
            <div class="d-flex align-items-center gap-2 mb-1">
              <i class="${iconCls} text-primary flex-shrink-0" style="font-size:1.1rem;" aria-hidden="true"></i>
              <h6 class="card-title mb-0 text-truncate flex-grow-1">${esc(ws.name || ws.slug)}</h6>
              ${roleBadge}
            </div>
            ${owner}
            <div class="d-flex gap-2 mt-auto">
              <button type="button" class="btn btn-wiki btn-sm flex-fill" onclick="window.acceptWsInvite('${slug}')">
                <i class="bi bi-check-lg"></i> 수락
              </button>
              <button type="button" class="btn btn-wiki-outline btn-sm flex-fill" onclick="window.declineWsInvite('${slug}')">
                <i class="bi bi-x-lg"></i> 거절
              </button>
            </div>
          </div>
        </div>
      </div>`;
  }).join('');
}

async function respondInvite(slug, action) {
  try {
    const res = await fetch('/api/ws/' + slug + '/invite/' + action, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      Swal.fire('처리 실패', body.error || '초대를 처리하지 못했습니다.', 'error');
      return;
    }
    if (action === 'accept') {
      location.href = '/ws/' + slug;
      return;
    }
    Swal.fire({
      toast: true, position: 'top-end', icon: 'success',
      title: '초대를 거절했습니다.', showConfirmButton: false, timer: 2000, timerProgressBar: true,
    });
    loadWorkspaces();
  } catch (e) {
    Swal.fire('오류', '요청 중 문제가 발생했습니다.', 'error');
  }
}

function acceptWsInvite(slug) { return respondInvite(slug, 'accept'); }
function declineWsInvite(slug) { return respondInvite(slug, 'decline'); }

// ── 새 워크스페이스 생성 ──
// 생성 모달에서 고른 아이콘(class 문자열, null = 기본). pickWikiIcon 은 별도 Bootstrap
// 모달을 Swal 위에 띄우므로 모달 닫힘 사이 상태를 모듈 스코프에 유지한다.
let createIconSel = null;

function updateCreateIconPreview() {
  const btn = document.getElementById('swalWsIconBtn');
  if (!btn) return;
  const cls = esc(workspaceIconClass(createIconSel));
  btn.innerHTML = `<i class="${cls}" aria-hidden="true"></i> <span>아이콘 선택</span>`;
}

async function openCreateWorkspace() {
  createIconSel = null;
  const { value: formValues } = await Swal.fire({
    title: '새 워크스페이스',
    html: `
      <input id="swalWsSlug" class="swal2-input" placeholder="제목 — 공백/슬래시/콜론 불가" maxlength="64">
      <input id="swalWsName" class="swal2-input" placeholder="대체 제목 (표시용, 선택)" maxlength="100">
      <button type="button" id="swalWsIconBtn" class="btn btn-wiki btn-sm mt-2"></button>`,
    focusConfirm: false,
    showCancelButton: true,
    confirmButtonText: '생성',
    cancelButtonText: '취소',
    didOpen: () => {
      updateCreateIconPreview();
      const btn = document.getElementById('swalWsIconBtn');
      if (btn) {
        btn.onclick = async () => {
          const picked = window.pickWikiIcon ? await window.pickWikiIcon() : null;
          // 사용자가 '아이콘 없음'(null)을 고르면 기본 아이콘으로 되돌린다.
          createIconSel = picked || null;
          updateCreateIconPreview();
        };
      }
    },
    preConfirm: () => {
      const name = (document.getElementById('swalWsName').value || '').trim();
      const slug = (document.getElementById('swalWsSlug').value || '').trim();
      if (!slug) {
        Swal.showValidationMessage('제목을 입력해주세요.');
        return false;
      }
      return { name, slug, icon: createIconSel };
    },
  });
  if (!formValues) return;

  try {
    const res = await fetch('/api/workspaces', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: formValues.slug, name: formValues.name || formValues.slug, icon: formValues.icon || undefined }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      Swal.fire('생성 실패', body.error || '워크스페이스를 만들지 못했습니다.', 'error');
      return;
    }
    location.href = '/ws/' + encodeURIComponent(body.slug);
  } catch (e) {
    Swal.fire('오류', '요청 중 문제가 발생했습니다.', 'error');
  }
}

// HTML onclick 에서 호출되므로 window 로 노출.
window.openCreateWorkspace = openCreateWorkspace;
window.acceptWsInvite = acceptWsInvite;
window.declineWsInvite = declineWsInvite;
