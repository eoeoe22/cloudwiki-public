// @ts-nocheck — 워크스페이스 파일(문서) 탐색기 부트스트랩 (/ws/:wslug/files).
// common.ts 가 window.* 로 노출하는 공통 전역(loadConfig/checkAuth/escapeHtml/uiEmptyState)을 사용한다.
// any 형태 fetch 응답이라 타입 검사를 끈다.

import { apiGet } from '../utils/api';

// ── 상태 ──────────────────────────────────────────────────────────────────────
let wslug = '';
let pages = []; // { id, slug, title, updated_at, version, ws_public, rows, characters, redirect_to }[]
// 확장 상태: slug → boolean (메모리에만 유지)
const expanded = {};

const esc = (s) => window.escapeHtml(String(s ?? ''));

/** slug 의 각 세그먼트를 encodeURIComponent 로 인코딩해 URL 경로로 반환 */
function encodeSlugPath(slug) {
  return slug.split('/').map(encodeURIComponent).join('/');
}

// ── 진입점 ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await window.loadConfig();
  await window.checkAuth();

  // /ws/<wslug>/files 에서 wslug 파싱
  const parts = location.pathname.split('/').filter(Boolean); // ['ws', '<wslug>', 'files']
  wslug = decodeURIComponent(parts[1] || '');

  if (!wslug) {
    showError('워크스페이스를 찾을 수 없습니다.');
    return;
  }

  // 브레드크럼 워크스페이스 링크 업데이트
  const bcrWsLink = document.getElementById('bcrWsLink');
  const bcrWsName = document.getElementById('bcrWsName');
  if (bcrWsLink) bcrWsLink.href = '/ws/' + encodeURIComponent(wslug);
  if (bcrWsName) bcrWsName.textContent = wslug;

  await loadTree();
});

// ── 데이터 로드 ───────────────────────────────────────────────────────────────
async function loadTree() {
  const loadingEl = document.getElementById('wsFilesLoading');
  const treeEl = document.getElementById('wsFileTree');
  const emptyEl = document.getElementById('wsFilesEmpty');
  const errorEl = document.getElementById('wsFilesError');

  // 재로드 시 상태 초기화
  loadingEl.classList.remove('d-none');
  treeEl.classList.add('d-none');
  emptyEl.classList.add('d-none');
  errorEl.classList.add('d-none');

  try {
    const data = await apiGet(`/api/ws/${encodeURIComponent(wslug)}/pages`);
    pages = data.pages || [];

    loadingEl.classList.add('d-none');

    if (!pages.length) {
      emptyEl.classList.remove('d-none');
      return;
    }

    renderTree();
    treeEl.classList.remove('d-none');
  } catch (e) {
    console.error('워크스페이스 파일 목록 로드 실패:', e);
    loadingEl.classList.add('d-none');
    showError('파일 목록을 불러오지 못했습니다.');
  }
}

// ── 오류 표시 ─────────────────────────────────────────────────────────────────
function showError(msg) {
  const errorEl = document.getElementById('wsFilesError');
  const errorTitle = document.getElementById('wsFilesErrorTitle');
  if (errorTitle) errorTitle.textContent = msg;
  errorEl.classList.remove('d-none');
}

// ── 트리 빌드 & 렌더 ──────────────────────────────────────────────────────────
/**
 * pages 배열(평면 슬러그 목록)로부터 트리를 빌드한다.
 * 노드 구조:
 *   { key: string (slug prefix), label: string (마지막 세그먼트),
 *     page: object|null (실제 문서 데이터, 없으면 가상 폴더),
 *     children: Map<string, Node> }
 */
function buildTree() {
  const root = new Map(); // key → Node

  for (const page of pages) {
    const segs = page.slug.split('/');
    let current = root;

    for (let i = 0; i < segs.length; i++) {
      const key = segs.slice(0, i + 1).join('/');
      const label = segs[i];

      if (!current.has(label)) {
        current.set(label, {
          key,
          label,
          page: null,
          children: new Map(),
        });
      }

      const node = current.get(label);

      if (i === segs.length - 1) {
        // 마지막 세그먼트 — 실제 문서
        node.page = page;
      }

      current = node.children;
    }
  }

  return root;
}

function renderTree() {
  const treeEl = document.getElementById('wsFileTree');
  const root = buildTree();
  treeEl.innerHTML = renderNodes(root, 0);
}

/** Map<label, Node> → HTML 문자열 */
function renderNodes(nodes, depth) {
  let html = '';
  for (const [, node] of nodes) {
    html += renderNode(node, depth);
  }
  return html;
}

function renderNode(node, depth) {
  const hasChildren = node.children.size > 0;
  const isExpanded = !!expanded[node.key];
  const indent = depth * 20;
  const isFolder = !node.page; // 중간 경로만 있고 실제 문서 없는 경우

  const chevron = hasChildren
    ? `<button class="btn btn-sm p-0 me-1 border-0 text-muted" style="width:1.2em;" onclick="window.wsFileToggle(${JSON.stringify(node.key)})" aria-expanded="${isExpanded}" aria-label="폴더 열기/닫기">
        <i class="bi bi-chevron-${isExpanded ? 'down' : 'right'}" style="font-size:0.75rem;"></i>
       </button>`
    : `<span style="width:1.2em;display:inline-block;"></span>`;

  const icon = (hasChildren || isFolder)
    ? `<i class="bi bi-folder${isExpanded ? '-open' : ''} text-warning me-1"></i>`
    : `<i class="bi bi-file-earmark-text text-secondary me-1"></i>`;

  const actions = node.page ? renderActions(node.page) : '';

  const html = `
    <div class="d-flex align-items-center py-1 border-bottom" style="padding-left:${indent + 8}px;">
      ${chevron}
      ${icon}
      <span class="flex-grow-1 text-truncate small" title="${esc(node.key)}">${esc(node.label)}</span>
      ${actions}
    </div>`;

  const childrenHtml = hasChildren && isExpanded
    ? `<div id="ws-children-${CSS.escape(node.key)}">${renderNodes(node.children, depth + 1)}</div>`
    : hasChildren
    ? `<div id="ws-children-${CSS.escape(node.key)}" class="d-none">${renderNodes(node.children, depth + 1)}</div>`
    : '';

  return html + childrenHtml;
}

function renderActions(page) {
  const slug = page.slug;
  const encodedSlug = encodeSlugPath(slug);
  const wslugEnc = encodeURIComponent(wslug);
  const slugJ = JSON.stringify(slug);

  return `
    <div class="d-flex gap-1 flex-shrink-0 ms-1">
      <a href="/ws/${wslugEnc}/w/${encodedSlug}" class="btn btn-sm btn-wiki-outline py-0 px-1" title="열기">
        <i class="bi bi-box-arrow-up-right" style="font-size:0.75rem;"></i>
      </a>
      <a href="/ws/${wslugEnc}/edit?slug=${encodeURIComponent(slug)}" class="btn btn-sm btn-wiki-outline py-0 px-1" title="편집">
        <i class="bi bi-pencil" style="font-size:0.75rem;"></i>
      </a>
      <button class="btn btn-sm btn-wiki-outline py-0 px-1" title="제목 변경" onclick="window.wsFileRename(${slugJ})">
        <i class="bi bi-cursor-text" style="font-size:0.75rem;"></i>
      </button>
      <button class="btn btn-sm btn-wiki-outline py-0 px-1 text-danger" title="삭제" onclick="window.wsFileDelete(${slugJ})">
        <i class="bi bi-trash3" style="font-size:0.75rem;"></i>
      </button>
    </div>`;
}

// ── 트리 토글 ──────────────────────────────────────────────────────────────────
window.wsFileToggle = function (key) {
  expanded[key] = !expanded[key];
  renderTree();
};

// ── 새 문서 ───────────────────────────────────────────────────────────────────
window.wsFileNew = async function () {
  const { value: slug } = await Swal.fire({
    title: '새 문서 만들기',
    input: 'text',
    inputLabel: '문서 제목 (예: getting-started 또는 docs/intro)',
    inputPlaceholder: '문서 제목을 입력하세요',
    showCancelButton: true,
    confirmButtonText: '편집기 열기',
    cancelButtonText: '취소',
    inputValidator: (v) => {
      if (!v || !v.trim()) return '제목을 입력해주세요.';
    },
  });
  if (!slug) return;
  location.href = `/ws/${encodeURIComponent(wslug)}/edit?slug=${encodeURIComponent(slug.trim())}`;
};

// ── 이름 변경 ─────────────────────────────────────────────────────────────────
window.wsFileRename = async function (slug) {
  const { value: newSlug } = await Swal.fire({
    title: '제목 변경',
    input: 'text',
    inputLabel: '새 제목',
    inputValue: slug,
    showCancelButton: true,
    confirmButtonText: '변경',
    cancelButtonText: '취소',
    inputValidator: (v) => {
      if (!v || !v.trim()) return '제목을 입력해주세요.';
      if (v.trim() === slug) return '현재 제목과 동일합니다.';
    },
  });
  if (!newSlug) return;

  try {
    const encodedSlug = encodeSlugPath(slug);
    const res = await fetch(
      `/api/ws/${encodeURIComponent(wslug)}/pages/${encodedSlug}/move`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_slug: newSlug.trim() }),
      }
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body.code === 'SLUG_TAKEN'
        ? '이미 사용 중인 제목입니다.'
        : (body.error || '제목을 변경하지 못했습니다.');
      Swal.fire('오류', msg, 'error');
      return;
    }
    await loadTree();
  } catch (e) {
    Swal.fire('오류', '요청 중 문제가 발생했습니다.', 'error');
  }
};

// ── 삭제 ─────────────────────────────────────────────────────────────────────
window.wsFileDelete = async function (slug) {
  const { isConfirmed } = await Swal.fire({
    title: '문서 삭제',
    html: `<strong>${esc(slug)}</strong> 문서를 삭제하시겠습니까?`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: '삭제',
    cancelButtonText: '취소',
    confirmButtonColor: '#dc3545',
  });
  if (!isConfirmed) return;

  try {
    const encodedSlug = encodeSlugPath(slug);
    const res = await fetch(
      `/api/ws/${encodeURIComponent(wslug)}/pages/${encodedSlug}`,
      {
        method: 'DELETE',
        credentials: 'same-origin',
      }
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      Swal.fire('오류', body.error || '삭제하지 못했습니다.', 'error');
      return;
    }
    await loadTree();
  } catch (e) {
    Swal.fire('오류', '요청 중 문제가 발생했습니다.', 'error');
  }
};
