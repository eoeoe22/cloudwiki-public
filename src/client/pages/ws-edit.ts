// @ts-nocheck — 워크스페이스 문서 편집(/ws/:wslug/edit?slug=...) 부트스트랩.
// common.ts / render.ts 가 window.* 로 노출하는 공통 전역(loadConfig/checkAuth/currentUser/
// escapeHtml/renderWikiContent)을 사용한다. any 형태 fetch 응답이라 타입검사를 끈다.
// 본문 에디터는 단순/견고함을 위해 CodeMirror 가 아닌 <textarea> 를 쓴다.

import { apiGet } from '../utils/api';

const esc = (s) => window.escapeHtml(String(s ?? ''));

// ── URL 파싱: /ws/<wslug>/edit?slug=<slug> ──
let WSLUG = '';
let TARGET_SLUG = '';
let IS_NEW = true; // 기존 문서를 불러왔으면 false
let EXPECTED_VERSION = null;
(function parseUrl() {
  const parts = window.location.pathname.split('/').filter(Boolean); // ['ws', wslug, 'edit']
  WSLUG = parts[1] ? decodeURIComponent(parts[1]) : '';
  TARGET_SLUG = new URLSearchParams(window.location.search).get('slug') || '';
})();

function encodeSlugPath(slug) {
  return String(slug || '')
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

const WS_BASE = '/api/ws/' + encodeURIComponent(WSLUG);
const wsDocUrl = (slug) => '/ws/' + encodeURIComponent(WSLUG) + '/w/' + encodeSlugPath(slug);
const wsDashUrl = () => '/ws/' + encodeURIComponent(WSLUG);

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', async () => {
  await window.loadConfig();
  await window.checkAuth();

  // 로그인 필수
  if (!window.currentUser) {
    Swal.fire({ icon: 'info', title: '로그인 필요', text: '문서를 편집하려면 로그인하세요.' })
      .then(() => { window.location.href = '/login?redirect=' + encodeURIComponent(window.location.pathname + window.location.search); });
    return;
  }

  // 브레드크럼 / 취소 링크
  const crumb = $('wsEditCrumbWs');
  if (crumb) { crumb.setAttribute('href', wsDashUrl()); crumb.textContent = WSLUG; }
  const cancel = $('wsEditCancel');
  if (cancel) cancel.setAttribute('href', TARGET_SLUG ? wsDocUrl(TARGET_SLUG) : wsDashUrl());

  await loadDoc();
  wireEditor();
});

function show(id) { $(id)?.classList.remove('d-none'); }
function hide(id) { $(id)?.classList.add('d-none'); }

async function loadDoc() {
  // ?slug= 가 있으면 기존 문서를 시도해 불러온다(404 면 신규 취급).
  if (TARGET_SLUG) {
    try {
      const data = await apiGet(WS_BASE + '/pages/' + encodeSlugPath(TARGET_SLUG));
      IS_NEW = false;
      EXPECTED_VERSION = data.version ?? null;
      TARGET_SLUG = data.slug; // 정규화된 슬러그 사용
      $('wsEditBody').value = data.content || '';
      $('wsEditTitle').value = data.title || '';
      $('wsEditPublic').checked = data.ws_public === 1;
      if (!data.can_write) {
        Swal.fire({ icon: 'error', title: '권한 없음', text: '이 문서를 수정할 권한이 없습니다.' })
          .then(() => { window.location.href = wsDocUrl(TARGET_SLUG); });
        return;
      }
    } catch (e) {
      // 404 = 신규 문서(슬러그 미리채움). 그 외(403/401) 는 안내 후 중단.
      if (!/\b404\b/.test(String(e?.message || ''))) {
        Swal.fire({ icon: 'error', title: '오류', text: '문서를 불러오지 못했습니다. 권한을 확인하세요.' })
          .then(() => { window.location.href = wsDashUrl(); });
        return;
      }
      IS_NEW = true;
    }
  }

  // 슬러그 입력 상태: 신규는 편집 가능, 기존은 읽기전용 + 이름 변경 버튼
  const slugInput = $('wsEditSlug');
  if (slugInput) {
    slugInput.value = TARGET_SLUG;
    if (IS_NEW) {
      slugInput.removeAttribute('readonly');
      hide('wsEditMoveBtn');
    } else {
      slugInput.setAttribute('readonly', 'readonly');
      show('wsEditMoveBtn');
    }
  }

  // 삭제 버튼은 기존 문서에서만
  if (!IS_NEW) show('wsEditDeleteBtn'); else hide('wsEditDeleteBtn');

  hide('wsEditLoading');
  show('wsEditMain');

  renderPreview();
}

function wireEditor() {
  const body = $('wsEditBody');
  if (!body) return;
  let timer = null;
  body.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(renderPreview, 250);
  });
  const mediaInput = $('wsEditMediaInput');
  if (mediaInput) mediaInput.addEventListener('change', onMediaSelected);
}

async function renderPreview() {
  const body = $('wsEditBody');
  if (!body) return;
  try {
    await window.renderWikiContent(body.value || '', TARGET_SLUG || 'preview', 'wsEditPreview', {
      showCategory: false,
      canEdit: false,
      enableSectionEdit: false,
    });
  } catch {
    const p = $('wsEditPreview');
    if (p) p.textContent = body.value || '';
  }
}

// ── 저장 ──
async function wsEditSave() {
  const body = $('wsEditBody');
  const slugInput = $('wsEditSlug');
  const slug = IS_NEW ? String(slugInput.value || '').trim() : TARGET_SLUG;
  clearSlugError();
  if (!slug) {
    setSlugError('제목을 입력하세요.');
    return;
  }

  const payload = {
    content: body.value || '',
    title: $('wsEditTitle').value.trim() || null,
    summary: $('wsEditSummary').value.trim() || undefined,
    ws_public: $('wsEditPublic').checked ? 1 : 0,
  };
  if (!IS_NEW && EXPECTED_VERSION != null) payload.expected_version = EXPECTED_VERSION;

  const btn = $('wsEditSaveBtn');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(WS_BASE + '/pages/' + encodeSlugPath(slug), {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      window.location.href = wsDocUrl(slug);
      return;
    }

    if (res.status === 409 && data.code === 'CONCURRENT_MODIFICATION') {
      Swal.fire({ icon: 'warning', title: '동시 수정 감지', text: '다른 곳에서 이 문서가 수정되었습니다. 새로고침 후 다시 시도하세요.' });
    } else if (res.status === 409 && data.code === 'SLUG_TAKEN') {
      setSlugError(data.error || '이미 사용 중인 제목입니다.');
    } else {
      Swal.fire('저장 실패', esc(data.error || ('오류 ' + res.status)), 'error');
    }
  } catch (e) {
    Swal.fire('저장 실패', '네트워크 오류가 발생했습니다.', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function setSlugError(msg) {
  const el = $('wsEditSlugError');
  if (el) { el.textContent = msg; el.classList.remove('d-none'); }
}
function clearSlugError() {
  const el = $('wsEditSlugError');
  if (el) { el.textContent = ''; el.classList.add('d-none'); }
}

// ── 이름 변경 (기존 문서) ──
async function wsEditMove() {
  const { value: newSlug } = await Swal.fire({
    title: '문서 제목 변경',
    input: 'text',
    inputValue: TARGET_SLUG,
    inputPlaceholder: '새 제목',
    showCancelButton: true,
    confirmButtonText: '변경',
    cancelButtonText: '취소',
  });
  if (!newSlug || newSlug.trim() === TARGET_SLUG) return;

  try {
    const res = await fetch(WS_BASE + '/pages/' + encodeSlugPath(TARGET_SLUG) + '/move', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_slug: newSlug.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      // 새 슬러그로 편집 페이지 재진입
      window.location.href = '/ws/' + encodeURIComponent(WSLUG) + '/edit?slug=' + encodeURIComponent(data.slug || newSlug.trim());
      return;
    }
    Swal.fire('이름 변경 실패', esc(data.error || ('오류 ' + res.status)), 'error');
  } catch {
    Swal.fire('이름 변경 실패', '네트워크 오류가 발생했습니다.', 'error');
  }
}

// ── 삭제 (기존 문서) ──
async function wsEditDelete() {
  const ok = await Swal.fire({
    icon: 'warning',
    title: '문서 삭제',
    text: TARGET_SLUG + ' 문서를 삭제할까요?',
    showCancelButton: true,
    confirmButtonText: '삭제',
    cancelButtonText: '취소',
    confirmButtonColor: '#d33',
  });
  if (!ok.isConfirmed) return;
  try {
    const res = await fetch(WS_BASE + '/pages/' + encodeSlugPath(TARGET_SLUG), {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (res.ok) {
      window.location.href = wsDashUrl();
      return;
    }
    const data = await res.json().catch(() => ({}));
    Swal.fire('삭제 실패', esc(data.error || ('오류 ' + res.status)), 'error');
  } catch {
    Swal.fire('삭제 실패', '네트워크 오류가 발생했습니다.', 'error');
  }
}

// ── 미디어 업로드 ──
function wsEditPickMedia() {
  $('wsEditMediaInput')?.click();
}

async function onMediaSelected(ev) {
  const input = ev.target;
  const file = input.files && input.files[0];
  if (!file) return;

  // 파일명: 확장자 제거 후 금지문자 정리(서버 검증과 동일 방향)
  const baseName = file.name.replace(/\.[^.]+$/, '').replace(/[\[\]()#%|<>^/\\.?\s]+/g, '-').replace(/^-+|-+$/g, '') || 'image';

  const fd = new FormData();
  fd.append('file', file);
  fd.append('filename', baseName);

  const btn = $('wsEditMediaBtn');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(WS_BASE + '/media', {
      method: 'POST',
      credentials: 'same-origin',
      body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.url) {
      insertAtCursor($('wsEditBody'), '![](' + data.url + ')');
      renderPreview();
    } else {
      Swal.fire('업로드 실패', esc(data.error || ('오류 ' + res.status)), 'error');
    }
  } catch {
    Swal.fire('업로드 실패', '네트워크 오류가 발생했습니다.', 'error');
  } finally {
    if (btn) btn.disabled = false;
    input.value = '';
  }
}

function insertAtCursor(textarea, text) {
  if (!textarea) return;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  const insert = (before && !before.endsWith('\n') ? '\n' : '') + text + '\n';
  textarea.value = before + insert + after;
  const pos = (before + insert).length;
  textarea.focus();
  textarea.setSelectionRange(pos, pos);
}

// HTML on* 핸들러용 노출
window.wsEditSave = wsEditSave;
window.wsEditMove = wsEditMove;
window.wsEditDelete = wsEditDelete;
window.wsEditPickMedia = wsEditPickMedia;
