// @ts-nocheck — 워크스페이스 문서 편집(/ws/:wslug/edit?slug=...) 부트스트랩.
// common.ts / render.ts 가 window.* 로 노출하는 공통 전역(loadConfig/checkAuth/currentUser/
// escapeHtml/renderWikiContent)을 사용한다. any 형태 fetch 응답이라 타입검사를 끈다.
// 본문 에디터는 위키 에디터(src/client/edit/main.ts)와 동일하게 CodeMirror6 로 구성하되,
// 워크스페이스 전용 저장/이동/삭제 흐름만 별도로 둔다. 자동 편집 요약(edit-summary.js)·
// 위키 자동완성(edit-autocomplete.js)·이미지 편집(edit-image.js)·표 툴바(edit-table-toolbar.js)
// 모듈은 window.editor 셰임 계약(on/getSelection/setSelection/getRawText/getMarkdown/insertText)
// 을 통해 그대로 재사용한다.

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

// CodeMirror6 EditorView 핸들. initWSEditor 가 채운다.
let cmView = null;

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

  // 에디터를 먼저 초기화한 뒤 문서를 로드해 setMarkdown 으로 본문을 적재한다.
  await initWSEditor();
  await loadDoc();
  wireEditor();
});

function show(id) { $(id)?.classList.remove('d-none'); }
function hide(id) { $(id)?.classList.add('d-none'); }

async function loadDoc() {
  let loadedContent = '';
  // ?slug= 가 있으면 기존 문서를 시도해 불러온다(404 면 신규 취급).
  if (TARGET_SLUG) {
    try {
      const data = await apiGet(WS_BASE + '/pages/' + encodeSlugPath(TARGET_SLUG));
      IS_NEW = false;
      EXPECTED_VERSION = data.version ?? null;
      TARGET_SLUG = data.slug; // 정규화된 슬러그 사용
      loadedContent = data.content || '';
      window.editor?.setMarkdown(loadedContent);
      $('alternateTitleInput').value = data.title || '';
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

  // 자동 편집 요약(edit-summary.js)이 읽는 전역 상태를 초기화한다.
  // 신규 문서: summary.ts 가 originalPageMeta falsy 여부로 "문서 생성" 분기를 판정하므로 null.
  // 기존 문서: 워크스페이스는 카테고리/넘겨주기/프레젠테이션 없음 → 빈 값. title 은 대체제목 변경 감지용.
  window.originalContent = loadedContent;
  window.originalPageMeta = IS_NEW
    ? null
    : { category: '', redirect_to: '', view_mode: '', title: ($('alternateTitleInput')?.value || '') };
  window.categoryTags = [];
  window.sectionMode = false;
  window.slug = TARGET_SLUG;

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

  // CM6 가 d-none 컨테이너 안에서 생성되어 측정이 틀어졌을 수 있으므로 재측정한다.
  cmView?.requestMeasure();

  // 자동 요약 초기 prefix 반영 + 프리뷰 갱신
  if (typeof window.refreshAutoSummary === 'function') window.refreshAutoSummary();
  renderPreview();
}

function wireEditor() {
  const mediaInput = $('wsEditMediaInput');
  if (mediaInput) mediaInput.addEventListener('change', onMediaSelected);
}

async function renderPreview() {
  const md = window.editor?.getMarkdown() || '';
  try {
    await window.renderWikiContent(md, TARGET_SLUG || 'preview', 'wsEditPreview', {
      showCategory: false,
      canEdit: false,
      enableSectionEdit: false,
    });
  } catch {
    const p = $('wsEditPreview');
    if (p) p.textContent = md;
  }
}

// ── CodeMirror6 에디터 초기화 ──
// 위키 에디터(main.ts)와 동일한 엔진/하이라이트를 쓰되, 워크스페이스용으로 경량 구성한다.
// window.editor 셰임 계약을 채워 자동완성/자동요약/이미지/표 모듈이 그대로 동작하게 한다.
async function initWSEditor() {
  const [cmState, cmViewMod, cmCommands, cmMarkdown, cmLangData, cmOneDark, cmLanguage, cmLezer] = await Promise.all([
    import('@codemirror/state'),
    import('@codemirror/view'),
    import('@codemirror/commands'),
    import('@codemirror/lang-markdown'),
    import('@codemirror/language-data'),
    import('@codemirror/theme-one-dark'),
    import('@codemirror/language'),
    import('@lezer/highlight'),
  ]);

  const { EditorState, Compartment } = cmState;
  const { EditorView, keymap: cmKeymap, lineNumbers, highlightActiveLineGutter, drawSelection, dropCursor } = cmViewMod;
  const { defaultKeymap, history, historyKeymap, indentWithTab } = cmCommands;
  const { markdown, markdownLanguage } = cmMarkdown;
  const { languages } = cmLangData;
  const { oneDark } = cmOneDark;
  const { syntaxHighlighting, indentOnInput, bracketMatching, HighlightStyle } = cmLanguage;
  const { tags: t } = cmLezer;

  // 다크모드 감지
  const isDarkMode = window.getIsDarkMode ? window.getIsDarkMode() : (document.documentElement.getAttribute('data-theme') === 'dark');

  // 워드랩 설정
  const wordWrap = localStorage.getItem('editor_word_wrap') !== 'false';

  // 마크다운 라이트 스타일 (main.ts 와 동일)
  const markdownLightStyle = HighlightStyle.define([
    { tag: t.heading1, color: "#0550ae", fontWeight: "700" },
    { tag: t.heading2, color: "#0550ae", fontWeight: "700" },
    { tag: t.heading3, color: "#0a3069", fontWeight: "700" },
    { tag: t.heading4, color: "#0a3069", fontWeight: "600" },
    { tag: t.heading5, color: "#0a3069", fontWeight: "600" },
    { tag: t.heading6, color: "#0a3069", fontWeight: "600" },
    { tag: t.strong, fontWeight: "700" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through", color: "#6e7781" },
    { tag: t.link, color: "#0969da" },
    { tag: t.url, color: "#0969da" },
    { tag: t.monospace, class: "cm-inline-code" },
    { tag: t.quote, color: "inherit", fontStyle: "normal" },
    { tag: t.meta, color: "#6e7781" },
    { tag: t.processingInstruction, color: "#6e7781" },
    { tag: t.contentSeparator, color: "#6e7781" },
    { tag: t.list, color: "inherit" },
    { tag: t.keyword, color: "#cf222e", fontWeight: "500" },
    { tag: [t.atom, t.bool], color: "#0550ae" },
    { tag: t.number, color: "#0550ae" },
    { tag: t.string, color: "#0a3069" },
    { tag: [t.regexp, t.escape], color: "#e36209" },
    { tag: t.comment, color: "#6e7781", fontStyle: "italic" },
    { tag: t.variableName, color: "#953800" },
    { tag: t.definition(t.variableName), color: "#116329" },
    { tag: t.typeName, color: "#116329" },
    { tag: t.tagName, color: "#116329" },
    { tag: t.attributeName, color: "#953800" },
    { tag: t.operator, color: "#cf222e" },
  ]);

  // 라이트 테마
  const lightTheme = EditorView.theme({
    '&': { background: 'var(--wiki-bg)', color: 'var(--wiki-text)', height: '100%', minHeight: '60vh' },
    '.cm-content': { fontFamily: 'var(--bs-font-monospace, monospace)', fontSize: '0.875rem', padding: '8px 12px' },
    '.cm-gutters': { background: 'var(--wiki-bg-alt)', borderRight: '1px solid var(--wiki-border)', color: 'var(--wiki-text-muted)' },
    '.cm-activeLineGutter': { background: 'var(--wiki-bg-alt2, var(--wiki-bg-alt))' },
    '.cm-activeLine': { background: 'rgba(0,0,0,0.03)' },
    '.cm-selectionBackground, ::selection': { background: 'rgba(0,100,200,0.2) !important' },
    '.cm-cursor': { borderLeftColor: 'var(--wiki-text)' },
  });

  const themeCompartment = new Compartment();
  const lineWrappingCompartment = new Compartment();

  // window.editor 셰임 계약상 on('change'|'blur') 핸들러를 등록받는 레지스트리.
  const editorEventHandlers = { change: [], blur: [] };

  // updateListener: change 이벤트 시 프리뷰 갱신 + 자동요약 + 자동완성 트리거 + 카운터 갱신.
  let previewTimer = null;
  let summaryTimer = null;
  const updateListener = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    // 자동완성 등 change 구독자에게 동기 통지(편집 위치 기반 드롭다운).
    editorEventHandlers.change.forEach((cb) => { try { cb(); } catch { /* 격리 */ } });
    // 텍스트 카운터(있으면) 갱신.
    if (typeof window.updateEditorTextCounterFromDoc === 'function') {
      window.updateEditorTextCounterFromDoc(update.state.doc);
    }
    // 프리뷰는 디바운스.
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 250);
    // 자동 편집 요약은 디바운스.
    if (summaryTimer) clearTimeout(summaryTimer);
    summaryTimer = setTimeout(() => {
      if (typeof window.refreshAutoSummary === 'function') window.refreshAutoSummary();
    }, 300);
  });

  const blurHandler = EditorView.domEventHandlers({
    blur: () => { editorEventHandlers.blur.forEach((cb) => { try { cb(); } catch { /* 격리 */ } }); },
  });

  // 표 인라인 편집 툴바(번들 미로드 시 no-op).
  const tableToolbar = window.setupTableToolbar
    ? window.setupTableToolbar()
    : { update: () => {}, hide: () => {} };

  const cmEditorView = new EditorView({
    state: EditorState.create({
      doc: "",
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        history(),
        cmKeymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        themeCompartment.of(isDarkMode ? oneDark : lightTheme),
        // 다크일 때는 oneDark 가 토큰 색을 담당하므로 라이트 스타일을 등록하지 않는다.
        syntaxHighlighting(isDarkMode ? [] : markdownLightStyle),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        lineWrappingCompartment.of(wordWrap ? EditorView.lineWrapping : []),
        updateListener,
        blurHandler,
        EditorView.updateListener.of((update) => {
          if (update.selectionSet || update.docChanged || update.viewportChanged) {
            tableToolbar.update(update.view);
          }
        }),
      ]
    }),
    parent: document.getElementById('editor')
  });

  cmView = cmEditorView;
  window._cmView = cmEditorView;
  window.CodeMirrorView = cmViewMod;

  // ── 에디터 Shim (autocomplete/summary/image/table 모듈 호환) ──
  // 좌표는 main.ts 와 동일하게 1-indexed [line, col] 쌍을 쓴다.
  window.editor = {
    getMarkdown: () => cmEditorView.state.doc.toString(),
    getRawText: () => cmEditorView.state.doc.toString(),
    setMarkdown: (md) => {
      cmEditorView.dispatch({ changes: { from: 0, to: cmEditorView.state.doc.length, insert: md || '' } });
    },
    insertText: (text) => {
      const { main } = cmEditorView.state.selection;
      cmEditorView.dispatch({
        changes: { from: main.from, to: main.to, insert: text },
        selection: { anchor: main.from + text.length },
      });
      cmEditorView.focus();
    },
    getSelection: () => {
      const { main } = cmEditorView.state.selection;
      const fromLine = cmEditorView.state.doc.lineAt(main.from);
      const toLine = cmEditorView.state.doc.lineAt(main.to);
      return [
        [fromLine.number, main.from - fromLine.from + 1],
        [toLine.number, main.to - toLine.from + 1],
      ];
    },
    setSelection: (fromArr, toArr) => {
      try {
        const fromLine = cmEditorView.state.doc.line(fromArr[0]);
        const toLine = cmEditorView.state.doc.line(toArr[0]);
        const from = fromLine.from + fromArr[1] - 1;
        const to = toLine.from + toArr[1] - 1;
        cmEditorView.dispatch({ selection: { anchor: from, head: to } });
      } catch { /* 잘못된 위치 무시 */ }
    },
    focus: () => cmEditorView.focus(),
    on: (event, callback) => {
      if (editorEventHandlers[event]) editorEventHandlers[event].push(callback);
    },
    getCursorCoords: () => {
      const { main } = cmEditorView.state.selection;
      return cmEditorView.coordsAtPos(main.head);
    },
  };

  // 다크모드 변경 시 테마 reconfigure.
  document.addEventListener('wiki:theme-changed', () => {
    const dark = window.getIsDarkMode ? window.getIsDarkMode() : (document.documentElement.getAttribute('data-theme') === 'dark');
    cmEditorView.dispatch({ effects: themeCompartment.reconfigure(dark ? oneDark : lightTheme) });
  });

  // 텍스트 카운터 초기화.
  if (typeof window.updateEditorTextCounter === 'function') {
    window.updateEditorTextCounter(cmEditorView.state.doc.toString());
  }

  // 툴바 생성.
  buildToolbar(cmEditorView);

  // 에디터 셰임이 준비됐으니 자동완성 부착을 결정적으로 트리거한다.
  window.dispatchEvent(new Event('wiki-editor-ready'));
  if (typeof window.ensureAutocompleteAttached === 'function') {
    window.ensureAutocompleteAttached();
  }

  return cmEditorView;
}

// ── 위키 에디터와 동일한 툴바(main.ts 의 핵심 버튼 구성) ──
function buildToolbar(view) {
  const toolbar = document.getElementById('cm-toolbar');
  if (!toolbar) return;

  function createToolbarBtn(icon, tooltip, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-toolbar-btn';
    btn.innerHTML = icon;
    btn.title = tooltip;
    btn.addEventListener('click', onClick);
    return btn;
  }
  function createToolbarSep() {
    const sep = document.createElement('span');
    sep.className = 'cm-toolbar-sep';
    return sep;
  }

  function insertText(text) {
    const sel = view.state.selection.main;
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: text } });
    view.focus();
  }
  function wrapSelection(before, after) {
    const sel = view.state.selection.main;
    const selected = view.state.sliceDoc(sel.from, sel.to);
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: before + selected + after } });
    view.focus();
  }
  function insertPrefix(prefix) {
    const sel = view.state.selection.main;
    const line = view.state.doc.lineAt(sel.from);
    if (line.text.startsWith(prefix)) {
      view.dispatch({ changes: { from: line.from, to: line.from + prefix.length, insert: '' } });
    } else {
      view.dispatch({ changes: { from: line.from, insert: prefix } });
    }
    view.focus();
  }

  toolbar.appendChild(createToolbarBtn('<b>H</b>', '제목', () => insertPrefix('## ')));
  toolbar.appendChild(createToolbarBtn('<b>B</b>', '굵게', () => wrapSelection('**', '**')));
  toolbar.appendChild(createToolbarBtn('<i>I</i>', '기울임', () => wrapSelection('*', '*')));
  toolbar.appendChild(createToolbarBtn('<s>S</s>', '취소선', () => wrapSelection('~~', '~~')));
  toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-format-underline"></i>', '밑줄', () => wrapSelection('__', '__')));
  toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-marker"></i>', '형광펜', () => wrapSelection('==', '==')));
  toolbar.appendChild(createToolbarSep());
  toolbar.appendChild(createToolbarBtn('─', '구분선', () => insertText('\n---\n')));
  toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-format-quote-close"></i>', '인용', () => insertPrefix('> ')));
  toolbar.appendChild(createToolbarSep());
  toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-format-list-bulleted"></i>', '목록', () => insertPrefix('- ')));
  toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-format-list-numbered"></i>', '번호 목록', () => insertPrefix('1. ')));
  toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-checkbox-marked-outline"></i>', '체크리스트', () => insertPrefix('- [ ] ')));
  toolbar.appendChild(createToolbarSep());
  toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-view-grid-outline"></i>', '그리드', () => insertText('\n:::grid\n내용\n:::')));
  toolbar.appendChild(createToolbarSep());
  toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-link-variant"></i>', '링크', () => wrapSelection('[', '](url)')));
  toolbar.appendChild(createToolbarSep());
  toolbar.appendChild(createToolbarBtn('[[ ]]', '위키 링크 삽입', () => insertText('[[문서제목]]')));
  toolbar.appendChild(createToolbarBtn('{{ }}', '틀 삽입', () => insertText('{{틀제목}}')));
  toolbar.appendChild(createToolbarBtn('[*]', '각주 삽입', () => insertText('[* 각주 내용]')));
  toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-form-dropdown"></i>', '펼치기 접기', () => insertText('[+ 펼치기/접기 제목]\n여기에 숨겨진 내용이 들어갑니다.\n[-]')));
}

// ── 저장 ──
async function wsEditSave() {
  const slugInput = $('wsEditSlug');
  const slug = IS_NEW ? String(slugInput.value || '').trim() : TARGET_SLUG;
  clearSlugError();
  if (!slug) {
    setSlugError('제목을 입력하세요.');
    return;
  }

  const payload = {
    content: window.editor?.getMarkdown() || '',
    title: ($('alternateTitleInput')?.value || '').trim() || null,
    summary: ($('summaryInput')?.value || '').trim() || undefined,
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
      window.editor?.insertText('![](' + data.url + ')');
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

// HTML on* 핸들러용 노출
window.wsEditSave = wsEditSave;
window.wsEditMove = wsEditMove;
window.wsEditDelete = wsEditDelete;
window.wsEditPickMedia = wsEditPickMedia;
