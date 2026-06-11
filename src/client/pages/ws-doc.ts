// @ts-nocheck — 워크스페이스 문서 조회(/ws/:wslug/w/:slug) 부트스트랩.
// 전역 위키 문서 조회(index.ts)와 동일한 공유 모듈(src/client/article/*)을 워크스페이스
// 컨텍스트로 구동해 브레드크럼·문서 구조 보기·목차(TOC)·역링크·읽기/Raw·공유 동작을 계승한다.
// 워크스페이스 차이점만 주입한다: 풀 내비게이션(SPA 아님), `/ws/<wslug>/w/<slug>` 경로,
// `/api/ws/<wslug>/pages/...` API, AI 공유 제외. common.ts / render.ts 가 window.* 로 노출하는
// 공통 전역(loadConfig/checkAuth/currentUser/escapeHtml/getRelativeTime/renderWikiContent/
// renderPresentation)을 사용한다.

import { apiGet } from '../utils/api';
import { createBreadcrumbNav } from '../article/breadcrumb';
import { createStructureModal } from '../article/structure';
import { createShareActions } from '../article/share';
import { renderBacklinks } from '../article/backlinks';
import { createTocController } from '../article/toc';

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
// 편집 이력(리비전) 페이지 — 전역 위키와 동일하게 ?mode=revisions 로 분기해 ws-revisions 셸을 서빙한다.
const wsRevisionsUrl = (slug) => wsDocUrl(slug) + '?mode=revisions';

let currentPage = null;

// ── 공유 문서 조회 모듈(워크스페이스 컨텍스트) ──
const wsArticleCtx = {
  docHref: (slug) => wsDocUrl(slug),
  subdocsUrl: (slug, immediate) => WS_BASE + '/pages/' + encodeSlugPath(slug) + '/subdocs' + (immediate ? '?immediate=1' : ''),
  backlinksUrl: (slug) => WS_BASE + '/pages/' + encodeSlugPath(slug) + '/backlinks',
  navigate: (href) => { if (href) window.location.href = href; },
  getDoc: () => currentPage,
  getSlug: () => SLUG,
  wikiName: () => (window.appConfig && window.appConfig.wikiName) || 'CloudWiki',
  canCreateSubdoc: () => !!(currentPage && currentPage.can_write),
  onCreateSubdoc: (parentSlug) => createWsSubdoc(parentSlug),
  includeAi: false,
};
const wsBreadcrumb = createBreadcrumbNav(wsArticleCtx);
const wsStructure = createStructureModal(wsArticleCtx);
const wsShare = createShareActions(wsArticleCtx);
const wsToc = createTocController({
  onReadingModeToggled: () => {
    // 프레젠테이션 문서는 모드 전환 시 본문 렌더 경로가 갈리므로 재렌더가 필요.
    if (currentPage && currentPage.doc_type === 'presentation') {
      if (typeof window.teardownPresentation === 'function') {
        try { window.teardownPresentation(); } catch (e) { /* noop */ }
      }
      renderBody();
    }
  },
});

async function createWsSubdoc(parentSlug) {
  if (!currentPage || !currentPage.can_write) {
    Swal.fire('권한 없음', '하위 문서를 만들 권한이 없습니다.', 'error');
    return;
  }
  const { value: subTitle } = await Swal.fire({
    title: '하위 문서 생성',
    input: 'text',
    inputLabel: `"${parentSlug}" 아래에 만들 하위 문서 이름`,
    inputPlaceholder: '하위 문서 이름',
    showCancelButton: true,
    confirmButtonText: '생성',
    cancelButtonText: '취소',
    inputValidator: (value) => {
      const trimmed = value ? value.trim() : '';
      if (!trimmed) return '이름을 입력해주세요.';
      if (trimmed.includes('/')) return '슬래시(/)는 포함할 수 없습니다.';
      if (trimmed.includes(':')) return '콜론(:)은 포함할 수 없습니다.';
    },
  });
  const trimmed = subTitle ? subTitle.trim() : '';
  if (!trimmed) return;
  window.location.href = wsEditUrl(`${parentSlug}/${trimmed}`);
}

document.addEventListener('DOMContentLoaded', async () => {
  await window.loadConfig();
  await window.checkAuth();

  wsToc.attachSpy();
  wsToc.restoreReadingMode();

  await loadPage();
});

function show(id) { document.getElementById(id)?.classList.remove('d-none'); }
function hide(id) { document.getElementById(id)?.classList.add('d-none'); }

async function loadPage() {
  hide('articlePage');
  hide('wsDocEmpty');
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
  show('articlePage');

  // 돌아가기 버튼: 워크스페이스 멤버(canRead)에게만 노출
  if (data.can_read) {
    const backBtn = document.getElementById('wsBackBtn');
    if (backBtn) backBtn.setAttribute('href', '/ws/' + encodeURIComponent(WSLUG));
    document.getElementById('wsBackBtnArea')?.classList.remove('d-none');
  }

  // 제목
  const titleEl = document.getElementById('articleTitle');
  if (titleEl) titleEl.textContent = data.title || data.slug;
  document.title = (data.title || data.slug) + ' - ' + wsArticleCtx.wikiName();

  // 대체 title 라벨(슬러그)
  renderSlugLabel(data.title ? data.slug : null);

  // 문서 메타(수정 시각·버전·읽기 모드 토글)
  renderMeta(data);

  // 리다이렉트 안내
  renderRedirect(data);

  // 액션(편집·공유·도구)
  renderActions(data);

  // 본문 렌더
  renderBody();

  // 문서 구조(브레드크럼) — 전역 위키와 동일 컴포넌트
  wsBreadcrumb.render(data.slug);

  // 역링크(본문 하단) — 멤버 한정(권한 없으면 섹션 숨김)
  renderBacklinks(wsArticleCtx, { slug: data.slug });
}

/** 본문 렌더(일반/프레젠테이션 분기) + Raw 원문 적재 + 링크 재배선 + 목차 동기화. */
async function renderBody() {
  const data = currentPage;
  if (!data) return;

  // Raw 보기 원문 적재
  const rawEl = document.getElementById('articleRawContent');
  if (rawEl) rawEl.textContent = data.content || '';

  const isPresentation = data.doc_type === 'presentation' && !document.body.classList.contains('reading-mode');
  try {
    if (isPresentation && typeof window.renderPresentation === 'function') {
      await window.renderPresentation(data.content || '', data.slug, 'articleContent', {});
    } else {
      await window.renderWikiContent(data.content || '', data.slug, 'articleContent', {
        showCategory: false,
        canEdit: false,
        enableSectionEdit: false,
        tocContainerId: 'tocContainer',
        tocNavId: 'tocNav',
        inlineTocLayout: true,
        collapsibleSections: true,
      });
    }
  } catch (e) {
    const c = document.getElementById('articleContent');
    if (c) c.textContent = data.content || '';
  }

  // 워크스페이스 내부 [[링크]] 를 워크스페이스 문서 경로로 재배선
  rewireWikiLinks();

  // 레이아웃 모드별 목차 사이드바 동기화 + 스파이 재계산
  syncTocSidebars();
  wsToc.refresh();
}

/** 레이아웃 모드(left-toc/right-toc/docs)에 따라 좌/우 목차 사이드바를 채운다. */
function syncTocSidebars() {
  const mode = window.appConfig && window.appConfig.layoutMode;
  if (mode === 'left-toc') {
    wsToc.populateSidebar('wikiTocSidebar', 'wikiTocSidebarNav');
  } else if (mode === 'right-toc' || mode === 'docs') {
    wsToc.populateSidebar('wikiTocSidebarRight', 'wikiTocSidebarRightNav');
  }
}

function renderMeta(data) {
  const el = document.getElementById('articleMeta');
  if (!el) return;
  const parts = [];
  if (data.updated_at) {
    parts.push('<span><i class="bi bi-clock-history"></i> ' + esc(new Date(data.updated_at * 1000).toLocaleString('ko-KR')) + '</span>');
  }
  if (data.version != null) parts.push('<span>v' + esc(data.version) + '</span>');
  if (data.ws_public === 1) parts.push('<span class="badge bg-success">공개</span>');
  // 읽기 모드 토글(전역 위키 meta 와 동일 동선)
  parts.push('<button type="button" class="reading-mode-toggle" onclick="toggleReadingMode()" title="읽기 모드" aria-label="읽기 모드"><i class="bi bi-book"></i></button>');
  el.innerHTML = parts.join(' ');
}

function renderRedirect(data) {
  const redirEl = document.getElementById('redirectMessage');
  if (!redirEl) return;
  if (data.redirect_to) {
    redirEl.innerHTML =
      '<div class="alert alert-info py-2 px-3 mb-3"><i class="bi bi-signpost-2 me-1"></i> 이 문서는 <a href="' +
      esc(wsDocUrl(data.redirect_to)) + '">' + esc(data.redirect_to) +
      '</a> 문서로 넘어왔습니다.</div>';
  } else {
    redirEl.innerHTML = '';
  }
}

function renderActions(data) {
  const el = document.getElementById('wsDocActions');
  if (!el) return;
  let html = '';
  if (data.can_write) {
    html += '<a class="btn btn-outline-secondary" href="' + esc(wsEditUrl(data.slug)) +
      '"><i class="bi bi-pencil" aria-hidden="true"></i><span class="d-none d-sm-inline"> 편집</span></a>';
  }
  // 공유 드롭다운 (AI 질문 제외). 편집자/관리자(can_write)에게는 공개 링크 관리 옵션 추가.
  const publicLinkItems = data.can_write ? `
        <li><hr class="dropdown-divider"></li>
        ${data.ws_public === 1
          ? `<li><button class="dropdown-item" onclick="wsCopyPublicLink()"><i class="bi bi-globe"></i> 공개 링크 복사</button></li>
        <li><button class="dropdown-item text-danger" onclick="wsRevokePublicLink()"><i class="bi bi-globe-x"></i> 공개 링크 해제</button></li>`
          : `<li><button class="dropdown-item" onclick="wsCreatePublicLink()"><i class="bi bi-globe"></i> 공개 링크 만들기</button></li>`
        }` : '';
  html += `
    <div class="dropdown">
      <button class="btn btn-secondary dropdown-toggle no-caret" type="button" data-bs-toggle="dropdown" data-bs-display="static" aria-expanded="false" title="공유하기"><i class="bi bi-share"></i></button>
      <ul class="dropdown-menu dropdown-menu-end">
        <li><button class="dropdown-item" onclick="shareNative()"><i class="bi bi-share"></i> 공유하기</button></li>
        <li><hr class="dropdown-divider"></li>
        <li><button class="dropdown-item" onclick="shareCopyLink()"><i class="bi bi-link"></i> 링크 복사하기</button></li>
        <li><button class="dropdown-item" onclick="shareCopyText()"><i class="bi bi-copy"></i> 문서 텍스트 복사</button></li>
        <li><button class="dropdown-item" onclick="shareCopyMarkdown()"><i class="bi bi-markdown"></i> 문서 복사 (마크다운)</button></li>
        <li><button class="dropdown-item" onclick="sharePrint()"><i class="bi bi-printer"></i> 인쇄하기</button></li>
        ${publicLinkItems}
      </ul>
    </div>`;
  // 도구 드롭다운 (대상 슬러그는 항상 현재 문서이므로 wsShowStructure 가 currentPage 에서 읽는다)
  const structureLabel = data.slug.includes('/') ? '문서 구조 보기' : '하위 문서 보기';
  const structureItem = `<li><button class="dropdown-item" onclick="wsShowStructure(); return false;"><i class="bi bi-diagram-3"></i> ${structureLabel}</button></li>`;
  html += `
    <div class="dropdown">
      <button class="btn btn-secondary dropdown-toggle no-caret" type="button" data-bs-toggle="dropdown" data-bs-display="static" aria-expanded="false" title="문서 도구"><i class="bi bi-three-dots-vertical"></i></button>
      <ul class="dropdown-menu dropdown-menu-end">
        <li><button class="dropdown-item" onclick="wsScrollToBacklinks(); return false;"><i class="bi bi-link-45deg"></i> 역링크 보기</button></li>
        <li><button class="dropdown-item" onclick="toggleRawMode(); return false;"><i class="bi bi-code-slash"></i> Raw 보기</button></li>
        ${structureItem}
        <li><a class="dropdown-item" href="${esc(wsRevisionsUrl(data.slug))}"><i class="bi bi-clock-history"></i> 편집 이력</a></li>
      </ul>
    </div>`;
  el.innerHTML = html;
}

function renderSlugLabel(slug) {
  const el = document.getElementById('articleSlugLabel');
  if (!el) return;
  if (!slug) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.innerHTML = '<code class="text-muted">' + esc(slug) + '</code>';
}

/**
 * render.ts 의 위키 링크는 전역 위키 경로 `/w/<slug>` 로 만들어진다. 워크스페이스 문맥에서는
 * 그 링크가 워크스페이스 문서를 가리켜야 하므로 href 를 워크스페이스 경로로 바꾸고 SPA onclick 을
 * 제거해 일반 네비게이션으로 동작하게 한다. 같은 페이지 앵커(#...)는 보존.
 */
function rewireWikiLinks() {
  const container = document.getElementById('articleContent');
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

// ── 역링크로 스크롤 ──
async function wsScrollToBacklinks() {
  const section = document.getElementById('backlinksSection');
  if (!section) return;
  if (!section.classList.contains('d-none')) {
    section.scrollIntoView({ behavior: 'smooth' });
    return;
  }
  const loaded = await renderBacklinks(wsArticleCtx, { slug: SLUG });
  if (loaded) {
    section.scrollIntoView({ behavior: 'smooth' });
  } else {
    Swal.fire({ icon: 'info', title: '역링크', text: '이 문서를 참조하는 문서가 없습니다.', timer: 2000, showConfirmButton: false });
  }
}

// ── 공개 링크 관리 (편집자/관리자 전용) ──
const WS_DOC_VISIBILITY_URL = () => WS_BASE + '/pages/' + encodeSlugPath(SLUG) + '/visibility';

async function wsSetPublicLink(value: 0 | 1): Promise<boolean> {
  try {
    const res = await fetch(WS_DOC_VISIBILITY_URL(), {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ws_public: value }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      Swal.fire('오류', esc(data.error || ('오류 ' + res.status)), 'error');
      return false;
    }
    return true;
  } catch {
    Swal.fire('오류', '네트워크 오류가 발생했습니다.', 'error');
    return false;
  }
}

async function wsCreatePublicLink() {
  const result = await Swal.fire({
    icon: 'question',
    title: '공개 링크 만들기',
    html: '이 문서를 워크스페이스 비회원도 열람할 수 있는 공개 링크를 만듭니다.<br>계속하시겠습니까?',
    showCancelButton: true,
    confirmButtonText: '만들기',
    cancelButtonText: '취소',
  });
  if (!result.isConfirmed) return;
  const ok = await wsSetPublicLink(1);
  if (!ok) return;
  if (currentPage) {
    currentPage.ws_public = 1;
    renderMeta(currentPage);
    renderActions(currentPage);
  }
  const url = window.location.origin + window.location.pathname;
  let copied = false;
  try { await navigator.clipboard.writeText(url); copied = true; } catch { /* 무시 */ }
  Swal.fire({
    icon: 'success',
    title: '공개 링크가 생성되었습니다',
    html: (copied ? '링크가 클립보드에 복사되었습니다:<br>' : '공개 링크:') + '<code>' + esc(url) + '</code>',
    confirmButtonText: '확인',
  });
}

async function wsCopyPublicLink() {
  const url = window.location.origin + window.location.pathname;
  try {
    await navigator.clipboard.writeText(url);
    Swal.fire({ icon: 'success', title: '링크 복사됨', toast: true, position: 'top-end', timer: 1500, showConfirmButton: false });
  } catch {
    Swal.fire({ icon: 'info', title: '공개 링크', html: '<code>' + esc(url) + '</code>', confirmButtonText: '확인' });
  }
}

async function wsRevokePublicLink() {
  const result = await Swal.fire({
    icon: 'warning',
    title: '공개 링크 해제',
    text: '비회원의 문서 열람 권한이 삭제됩니다. 계속하시겠습니까?',
    showCancelButton: true,
    confirmButtonText: '해제',
    cancelButtonText: '취소',
    confirmButtonColor: '#d33',
  });
  if (!result.isConfirmed) return;
  const ok = await wsSetPublicLink(0);
  if (!ok) return;
  if (currentPage) {
    currentPage.ws_public = 0;
    renderMeta(currentPage);
    renderActions(currentPage);
  }
  Swal.fire({ icon: 'success', title: '공개 링크가 해제되었습니다.', toast: true, position: 'top-end', timer: 2000, showConfirmButton: false });
}

// ── HTML on* 핸들러용 window 노출 (공유 모듈 래퍼) ──
window.shareNative = () => wsShare.shareNative();
window.shareCopyLink = () => wsShare.shareCopyLink();
window.shareCopyText = () => wsShare.shareCopyText();
window.shareCopyMarkdown = () => wsShare.shareCopyMarkdown();
window.sharePrint = () => wsShare.sharePrint();
window.toggleReadingMode = () => wsToc.toggleReadingMode();
window.toggleRawMode = () => wsToc.toggleRawMode();
window.toggleFloatingToc = () => wsToc.toggleFloating();
window.wsShowStructure = () => { if (currentPage) wsStructure.show(currentPage.slug); };
window.wsScrollToBacklinks = wsScrollToBacklinks;
window.wsCreatePublicLink = wsCreatePublicLink;
window.wsCopyPublicLink = wsCopyPublicLink;
window.wsRevokePublicLink = wsRevokePublicLink;
