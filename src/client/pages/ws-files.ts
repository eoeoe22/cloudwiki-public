// @ts-nocheck — 워크스페이스 파일(문서) 탐색기 부트스트랩 (/ws/:wslug/files).
// common.ts 가 window.* 로 노출하는 공통 전역(loadConfig/checkAuth/escapeHtml/uiEmptyState)을 사용한다.
// any 형태 fetch 응답이라 타입 검사를 끈다.

import { apiGet } from '../utils/api';

// ── 상태 ──────────────────────────────────────────────────────────────────────
let wslug = '';
let pages = []; // 현재 페이지(서버가 반환한 문서) { id, slug, title, updated_at, version, ws_public, rows, characters, redirect_to, doc_type }[]
let total = 0; // 서버 기준 전체 매칭 문서 수
// 접힘 상태: slug → false 면 접힘(기본은 펼침). 페이지 내 모든 문서를 보이게 하기 위함.
const collapsed = {};
// 검색 / 정렬 / 페이지 (서버에 전달)
let searchQuery = '';
let sortKey = 'updated_at'; // 'updated_at' | 'slug'
let currentPage = 0;
const PAGE_SIZE = 50;

const esc = (s) => window.escapeHtml(String(s ?? ''));
/** 인라인 on* 핸들러 인자용 — JSON 직렬화 후 HTML 이스케이프해 속성에 안전하게 넣는다. */
const attrJson = (v) => esc(JSON.stringify(v));

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

  // 돌아가기 버튼 링크 업데이트
  const btnBack = document.getElementById('btnBackToWs');
  if (btnBack) (btnBack as HTMLAnchorElement).href = '/ws/' + encodeURIComponent(wslug);

  await loadTree();
});

// ── 데이터 로드 ───────────────────────────────────────────────────────────────
// 검색어/정렬/페이지를 빠르게 바꾸면 요청이 순서대로 끝나지 않을 수 있다. 시퀀스 가드로
// 가장 최근 요청의 응답만 상태에 반영해, 늦게 도착한 옛 응답이 덮어쓰지 못하게 한다.
let loadSeq = 0;
async function loadTree() {
  const loadingEl = document.getElementById('wsFilesLoading');
  const treeEl = document.getElementById('wsFileTree');
  const emptyEl = document.getElementById('wsFilesEmpty');
  const errorEl = document.getElementById('wsFilesError');
  const toolbarEl = document.getElementById('wsFilesToolbar');

  const seq = ++loadSeq;

  // 재로드 시 상태 초기화
  loadingEl.classList.remove('d-none');
  treeEl.classList.add('d-none');
  emptyEl.classList.add('d-none');
  errorEl.classList.add('d-none');
  toolbarEl.classList.add('d-none');

  try {
    const params = new URLSearchParams();
    params.set('sort', sortKey);
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(currentPage * PAGE_SIZE));
    if (searchQuery.trim()) params.set('q', searchQuery.trim());

    const data = await apiGet(`/api/ws/${encodeURIComponent(wslug)}/pages?${params.toString()}`);
    // 더 새로운 요청이 시작됐다면 이 응답은 폐기한다.
    if (seq !== loadSeq) return;
    pages = data.pages || [];
    total = data.total ?? pages.length;

    // 삭제/검색으로 전체 수가 줄어 현재 페이지가 범위를 벗어났다면 마지막 유효 페이지로 보정 후 1회 재로드.
    const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
    if (currentPage > lastPage && total > 0) {
      currentPage = lastPage;
      return loadTree();
    }

    loadingEl.classList.add('d-none');

    // 검색어가 없고 전체가 비었을 때만 빈 상태. 검색 결과 없음은 트리 영역에서 안내.
    if (total === 0 && !searchQuery.trim()) {
      emptyEl.classList.remove('d-none');
      return;
    }

    toolbarEl.classList.remove('d-none');
    renderTree();
    treeEl.classList.remove('d-none');
  } catch (e) {
    if (seq !== loadSeq) return;
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
// 검색·정렬·페이지네이션은 서버(/api/ws/:wslug/pages 의 q/sort/limit/offset)가 처리한다.
// 클라이언트는 서버가 반환한 현재 페이지 문서로 계층 트리를 구성하고, 같은 페이지에
// 함께 온 조상 경로를 가상 폴더로 표시한다(페이지 경계를 넘는 펼침은 없음).
/**
 * pagesArr(평면 슬러그 목록)로부터 트리를 빌드한다.
 */
function buildTree(pagesArr) {
  const root = new Map();

  for (const page of pagesArr) {
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
        node.page = page;
      }

      current = node.children;
    }
  }

  return root;
}

function renderTree() {
  const treeEl = document.getElementById('wsFileTree');

  // 결과 없음(검색 매칭 0건 등)
  if (!pages.length) {
    treeEl.innerHTML = `<p class="text-muted small mt-2">검색 결과가 없습니다.</p>`;
    return;
  }

  const root = buildTree(pages);

  // 최소 너비를 보장해 행이 줄바꿈되지 않도록 (가로 스크롤)
  let html = `<div style="min-width:max-content;">`;
  html += renderNodes(root, 0);
  html += `</div>`;

  if (total > PAGE_SIZE) {
    html += renderPagination(total);
  }

  treeEl.innerHTML = html;
}

/** Map<label, Node> → HTML 문자열 */
function renderNodes(nodes, depth) {
  let html = '';
  for (const [, node] of nodes) {
    html += renderNode(node, depth);
  }
  return html;
}

/** 문서 slug/title 에 따른 아이콘 클래스 반환 */
function getDocIcon(node) {
  const slug = node.page?.slug ?? node.key;
  const title = node.page?.title ?? '';
  const lastSeg = slug.split('/').pop() || '';

  if (!node.page) {
    // 가상 폴더 (실제 문서 없음)
    return 'bi-folder text-warning';
  }
  if (lastSeg === '_board') {
    return 'bi-layout-kanban text-info';
  }
  if (title.startsWith('틀:') || lastSeg.startsWith('틀:')) {
    return 'bi-file-earmark-code text-secondary';
  }
  if (node.page?.doc_type === 'presentation') {
    return 'bi-easel2 text-primary';
  }
  return 'bi-file-earmark-text text-secondary';
}

/** 문서 속성 배지 HTML */
function renderBadges(page) {
  if (!page) return '';
  let badges = '';
  if (page.pinned_at) {
    badges += `<i class="bi bi-star-fill text-warning ms-1" style="font-size:0.7rem;" title="상단 고정"></i>`;
  }
  if (page.ws_public === 1) {
    badges += `<span class="badge rounded-pill ms-1 small" style="font-size:0.65rem;background:var(--wiki-success-subtle,#d1e7dd);color:var(--wiki-success,#198754);">공개</span>`;
  }
  if (page.doc_type === 'presentation') {
    badges += `<span class="badge rounded-pill ms-1 small" style="font-size:0.65rem;background:var(--wiki-primary-subtle,#cfe2ff);color:var(--wiki-primary,#0d6efd);">프레젠테이션</span>`;
  }
  return badges;
}

function renderNode(node, depth) {
  const hasChildren = node.children.size > 0;
  // 현재 페이지에 함께 온 문서가 모두 보이도록 기본 펼침. 사용자가 접으면 collapsed[key]=true.
  const isExpanded = !collapsed[node.key];
  const indent = depth * 20;

  const chevron = hasChildren
    ? `<button class="btn btn-sm p-0 me-1 border-0 text-muted" style="width:1.2em;" onclick="window.wsFileToggle(${attrJson(node.key)})" aria-expanded="${isExpanded}" aria-label="폴더 열기/닫기">
        <i class="bi bi-chevron-${isExpanded ? 'down' : 'right'}" style="font-size:0.75rem;"></i>
       </button>`
    : `<span style="width:1.2em;display:inline-block;"></span>`;

  const iconClass = getDocIcon(node);
  const icon = `<i class="bi ${iconClass} me-1" style="flex-shrink:0;"></i>`;

  const actions = node.page ? renderActions(node.page) : '';
  const badges = renderBadges(node.page);

  let labelHtml;
  if (node.page) {
    const href = `/ws/${encodeURIComponent(wslug)}/w/${encodeSlugPath(node.page.slug)}`;
    labelHtml = `<a href="${href}" class="text-truncate small ws-file-name" style="min-width:0;" title="${esc(node.key)}">${esc(node.page.title || node.label)}</a>${badges}`;
  } else if (hasChildren) {
    labelHtml = `<span class="text-truncate small ws-file-folder" style="min-width:0;" role="button" title="${esc(node.key)}" onclick="window.wsFileToggle(${attrJson(node.key)})">${esc(node.label)}</span>`;
  } else {
    labelHtml = `<span class="text-truncate small text-muted" style="min-width:0;" title="${esc(node.key)}">${esc(node.label)}</span>`;
  }

  const html = `
    <div class="d-flex align-items-center py-1 border-bottom" style="padding-left:${indent + 8}px;gap:0.25rem;">
      ${chevron}
      ${icon}
      ${labelHtml}
      <span style="flex:1 1 auto;min-width:0.5rem;"></span>
      ${actions}
    </div>`;

  const childrenHtml = hasChildren
    ? `<div id="ws-children-${CSS.escape(node.key)}" ${isExpanded ? '' : 'class="d-none"'}>${renderNodes(node.children, depth + 1)}</div>`
    : '';

  return html + childrenHtml;
}

function renderActions(page) {
  const slug = page.slug;
  const wslugEnc = encodeURIComponent(wslug);
  const slugJ = attrJson(slug);
  const isPinned = !!page.pinned_at;

  return `
    <div class="d-flex gap-1 flex-shrink-0">
      <button class="btn btn-sm btn-wiki-outline py-0 px-1 ${isPinned ? 'text-warning' : ''}" title="${isPinned ? '상단 고정 해제' : '상단 고정'}" aria-pressed="${isPinned}" onclick="window.wsFilePin(${slugJ}, ${isPinned ? 'false' : 'true'})">
        <i class="bi ${isPinned ? 'bi-star-fill' : 'bi-star'}" style="font-size:0.75rem;"></i>
      </button>
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

// ── 페이지네이션 ──────────────────────────────────────────────────────────────
function renderPagination(totalRootCount) {
  const totalPages = Math.ceil(totalRootCount / PAGE_SIZE);
  const start = currentPage * PAGE_SIZE + 1;
  const end = Math.min((currentPage + 1) * PAGE_SIZE, totalRootCount);

  let html = `<div class="d-flex align-items-center justify-content-between mt-2 flex-wrap gap-2">
    <small class="text-muted">${start}–${end} / 총 ${totalRootCount}개</small>
    <div class="d-flex gap-1">`;

  // 이전 버튼
  if (currentPage > 0) {
    html += `<button class="btn btn-wiki-outline btn-sm" onclick="window.wsFilePage(${currentPage - 1})"><i class="bi bi-chevron-left"></i></button>`;
  }

  // 페이지 번호 (최대 7개 표시)
  const maxBtns = 7;
  let lo = Math.max(0, currentPage - Math.floor(maxBtns / 2));
  let hi = Math.min(totalPages - 1, lo + maxBtns - 1);
  lo = Math.max(0, hi - maxBtns + 1);

  if (lo > 0) {
    html += `<button class="btn btn-wiki-outline btn-sm" onclick="window.wsFilePage(0)">1</button>`;
    if (lo > 1) html += `<span class="btn btn-sm disabled px-1">…</span>`;
  }
  for (let i = lo; i <= hi; i++) {
    const active = i === currentPage ? ' btn-wiki active' : ' btn-wiki-outline';
    html += `<button class="btn btn-sm${active}" onclick="window.wsFilePage(${i})">${i + 1}</button>`;
  }
  if (hi < totalPages - 1) {
    if (hi < totalPages - 2) html += `<span class="btn btn-sm disabled px-1">…</span>`;
    html += `<button class="btn btn-wiki-outline btn-sm" onclick="window.wsFilePage(${totalPages - 1})">${totalPages}</button>`;
  }

  // 다음 버튼
  if (currentPage < totalPages - 1) {
    html += `<button class="btn btn-wiki-outline btn-sm" onclick="window.wsFilePage(${currentPage + 1})"><i class="bi bi-chevron-right"></i></button>`;
  }

  html += `</div></div>`;
  return html;
}

// ── 트리 토글 (현재 페이지 내 폴더 접기/펼치기) ────────────────────────────────
window.wsFileToggle = function (key) {
  collapsed[key] = !collapsed[key];
  renderTree();
};

// ── 검색 (서버 재조회) ─────────────────────────────────────────────────────────
let _searchTimer;
window.wsFileSearch = function (val) {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => {
    searchQuery = val;
    currentPage = 0;
    loadTree();
  }, 300);
};

// ── 정렬 (서버 재조회) ─────────────────────────────────────────────────────────
window.wsFileSort = function (val) {
  sortKey = val;
  currentPage = 0;
  loadTree();
};

// ── 페이지 이동 (서버 재조회) ──────────────────────────────────────────────────
window.wsFilePage = function (page) {
  currentPage = page;
  loadTree();
  document.getElementById('wsFileTree')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// ── 상단 고정(별표) 토글 ───────────────────────────────────────────────────────
// 워크스페이스 공용 고정 — canWrite 권한 필요(서버 강제). 토글 후 목록을 재조회해
// 고정 문서가 상단으로 재정렬되도록 한다.
window.wsFilePin = async function (slug, pin) {
  try {
    const encodedSlug = encodeSlugPath(slug);
    const res = await fetch(
      `/api/ws/${encodeURIComponent(wslug)}/pages/${encodedSlug}/pin`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: !!pin }),
      }
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      Swal.fire('오류', body.error || '고정 상태를 변경하지 못했습니다.', 'error');
      return;
    }
    await loadTree();
  } catch (e) {
    Swal.fire('오류', '요청 중 문제가 발생했습니다.', 'error');
  }
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

// ── 이름 변경 (하위 문서 일괄 이동) ─────────────────────────────────────────────
window.wsFileRename = async function (slug) {
  // 하위 문서는 서버 move 가 일괄 이동한다. (페이지네이션으로 전체 하위 수를 알 수 없어
  // 카운트 대신 일반 안내를 표시한다.)
  const note = `<div class="small text-muted mt-2">이 문서의 하위 문서가 있다면 새 경로로 함께 이동합니다.</div>`;

  const { value: newSlug } = await Swal.fire({
    title: '제목 변경',
    input: 'text',
    inputLabel: '새 제목',
    inputValue: slug,
    html: note || undefined,
    showCancelButton: true,
    confirmButtonText: '변경',
    cancelButtonText: '취소',
    inputValidator: (v) => {
      if (!v || !v.trim()) return '제목을 입력해주세요.';
      if (v.trim() === slug) return '현재 제목과 동일합니다.';
      if (v.trim().startsWith(slug + '/')) return '문서를 자기 자신의 하위 경로로 이동할 수 없습니다.';
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
    // 접힘 상태 키를 이동된 새 경로로 remap 해 재로드 후에도 접힘 상태가 유지되게 한다.
    const dest = (body.slug || newSlug.trim());
    for (const key of Object.keys(collapsed)) {
      if (key === slug || key.startsWith(slug + '/')) {
        const remapped = dest + key.slice(slug.length);
        if (collapsed[key]) collapsed[remapped] = true;
        delete collapsed[key];
      }
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
