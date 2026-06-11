// @ts-nocheck — 워크스페이스 문서 편집(/ws/:wslug/edit?slug=...) 부트스트랩.
// common.ts / render.ts 가 window.* 로 노출하는 공통 전역(loadConfig/checkAuth/currentUser/
// escapeHtml/renderWikiContent)을 사용한다. any 형태 fetch 응답이라 타입검사를 끈다.
// 본문 에디터는 위키 에디터(src/client/edit/main.ts)와 동일하게 CodeMirror6 로 구성하되,
// 워크스페이스 전용 저장/이동/삭제 흐름만 별도로 둔다. 자동 편집 요약(edit-summary.js)·
// 위키 자동완성(edit-autocomplete.js)·이미지 편집(edit-image.js)·표 툴바(edit-table-toolbar.js)
// 모듈은 window.editor 셰임 계약(on/getSelection/setSelection/getRawText/getMarkdown/insertText)
// 을 통해 그대로 재사용한다.

import { apiGet } from '../utils/api';
import {
  makeMarkdownHighlightStyles,
  makeLightTheme,
  makeDarkBgTheme,
  makeFormatHelpers,
  buildEditorLayoutHTML,
  buildSharedToolbar,
  setupTabSwitcher,
} from '../edit/cm-shared';
import { createSlideController } from '../edit/slide-edit';

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

// 워크스페이스 미디어 검색용 캐시 (페이지 내 로드 공유, 새 검색 시 갱신)
let wsMediaCache: { id: number; url: string; filename: string; tags: string[] }[] | null = null;

// CodeMirror6 EditorView 핸들. initWSEditor 가 채운다.
let cmView = null;
// 통합 단일 슬라이드 편집 컨트롤러(프레젠테이션 문서). initWSEditor 가 채운다.
let slideCtrl = null;
// 현재 PC 보기 모드(일반/작성/보기). setupTabSwitcher onModeChange 가 갱신.
let currentPcMode = 'split';
// 직전 프리뷰가 슬라이드 덱이었는지 — 일반 렌더 복귀 시 프레젠테이션 전역 핸들러 1회 정리용.
let deckWasActive = false;
// 탭 스위처 핸들(모바일 프리뷰 패널 표시 등 외부 제어용).
let tabSwitcher = null;

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
      const presoCb = $('wsEditPresentation');
      if (presoCb) presoCb.checked = data.doc_type === 'presentation';
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
  // 기존 문서: 워크스페이스는 카테고리/넘겨주기 없음 → 빈 값. title 은 대체제목 변경 감지용.
  window.originalContent = loadedContent;
  window.originalPageMeta = IS_NEW
    ? null
    : { category: '', redirect_to: '', title: ($('alternateTitleInput')?.value || '') };
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

  // 프레젠테이션 문서 + 일반(split) 모드면 통합 단일 슬라이드 편집으로 진입(이 시점 본문이 분할 기준).
  slideCtrl?.syncToMode(currentPcMode);

  // 자동 요약 초기 prefix 반영 + 프리뷰 갱신
  if (typeof window.refreshAutoSummary === 'function') window.refreshAutoSummary();
  renderPreview();
}

function wireEditor() {
  // 프레젠테이션 모드 체크박스 — 토글 시 통합 슬라이드 편집 진입/이탈 + 프리뷰 갱신.
  const presoCb = $('wsEditPresentation');
  if (presoCb) {
    presoCb.addEventListener('change', () => {
      slideCtrl?.onPresentationToggled(currentPcMode);
      if (typeof window.refreshAutoSummary === 'function') window.refreshAutoSummary();
    });
  }
}

// 프리뷰 갱신. 프레젠테이션 문서의 슬라이드 모드/보기 모드면 슬라이드 덱으로, 아니면 일반 위키 렌더.
async function renderPreview() {
  const customPreview = $('custom-wiki-preview');
  if (slideCtrl && slideCtrl.shouldRenderDeck(currentPcMode)) {
    try {
      await slideCtrl.renderDeck('custom-wiki-preview');
      deckWasActive = true;
      return;
    } catch {
      // 덱 렌더 실패 시 일반 렌더로 폴백.
    }
  }
  // 일반 렌더 경로로 복귀: 직전에 덱이 떠 있었다면 프레젠테이션 전역 핸들러를 한 번 정리한다.
  if (deckWasActive) {
    if (typeof window.teardownPresentation === 'function') {
      try { window.teardownPresentation(); } catch { /* noop */ }
    }
    deckWasActive = false;
    customPreview?.classList.remove('preview-slide-deck');
  }
  const md = window.editor?.getMarkdown() || '';
  try {
    await window.renderWikiContent(md, TARGET_SLUG || 'preview', 'custom-wiki-preview', {
      showCategory: false,
      canEdit: false,
      enableSectionEdit: false,
    });
  } catch {
    if (customPreview) customPreview.textContent = md;
  }
}

// ── CodeMirror6 에디터 초기화 ──
// 위키 에디터(main.ts)와 동일한 레이아웃/하이라이트/테마/툴바 빌딩 블록(cm-shared.ts)을
// 그대로 재사용한다. window.editor 셰임 계약을 채워 자동완성/자동요약/이미지/표 모듈이
// 위키 에디터와 동일하게 동작하게 한다. 워크스페이스 전용 차이는 미디어 업로드 경로뿐이다.
async function initWSEditor() {
  // 위키 에디터와 동일한 레이아웃(전폭 툴바 + 좌우 분할 + 모바일 탭)을 #editor 에 주입.
  // 슬라이드 존/내비게이션 바는 프레젠테이션 통합 편집용으로 활성(워크스페이스 전용 기능).
  // 플로팅 목차는 워크스페이스에 없으므로 비활성.
  const host = document.getElementById('editor');
  if (host) host.innerHTML = buildEditorLayoutHTML({ slideZones: true, tocFab: false });

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
  const isDark = () => window.getIsDarkMode ? window.getIsDarkMode() : (document.documentElement.getAttribute('data-theme') === 'dark');
  const isDarkMode = isDark();

  // 워드랩 설정
  const wordWrap = localStorage.getItem('editor_word_wrap') !== 'false';

  // 위키 에디터와 동일한 마크다운 하이라이트 스타일/테마(cm-shared 단일 소스).
  const { light: markdownLightStyle, dark: markdownDarkStyle } = makeMarkdownHighlightStyles(HighlightStyle, t);
  const lightTheme = makeLightTheme(EditorView);
  const darkBgTheme = makeDarkBgTheme(EditorView);

  const themeCompartment = new Compartment();
  const darkBgCompartment = new Compartment();
  const syntaxHighlightCompartment = new Compartment();
  const lineWrappingCompartment = new Compartment();

  const buildSyntaxHighlightExts = () => syntaxHighlighting(isDark() ? markdownDarkStyle : markdownLightStyle);
  const buildDarkBgExt = () => isDark() ? darkBgTheme : [];

  // window.editor 셰임 계약상 on('change'|'blur') 핸들러를 등록받는 레지스트리.
  const editorEventHandlers = { change: [], blur: [] };

  // updateListener: change 이벤트 시 프리뷰 갱신 + 자동요약 + 자동완성 트리거 + 카운터 갱신.
  let previewTimer = null;
  let summaryTimer = null;
  const updateListener = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    // 프로그램적 슬라이드 스왑 중에는 프리뷰/자동완성 재계산을 건너뛴다(스왑 결과는 동일 전체 문서).
    if (slideCtrl && slideCtrl.isSuppressing()) return;
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
        darkBgCompartment.of(buildDarkBgExt()),
        syntaxHighlightCompartment.of(buildSyntaxHighlightExts()),
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
    parent: document.getElementById('cm-editor')
  });

  cmView = cmEditorView;
  window._cmView = cmEditorView;
  window.CodeMirrorView = cmViewMod;

  // ── 에디터 Shim (autocomplete/summary/image/table 모듈 호환) ──
  // 좌표는 main.ts 와 동일하게 1-indexed [line, col] 쌍을 쓴다.
  window.editor = {
    // 통합 슬라이드 편집 중이면 CM 문서는 "현재 슬라이드"만 보유하므로, 저장/충돌/프리뷰 등
    // 모든 경로가 전체 문서를 보도록 재구성된 전체 마크다운을 반환한다.
    getMarkdown: () => (slideCtrl && slideCtrl.isActive()) ? slideCtrl.getMarkdown() : cmEditorView.state.doc.toString(),
    // 커서 좌표와 일치하는 원시 CM 텍스트(현재 슬라이드). 자동완성 등 커서 결합 소비자용.
    getRawText: () => cmEditorView.state.doc.toString(),
    setMarkdown: (md) => {
      // 통합 슬라이드 편집 중에는 외부 호출자가 넘긴 전체 문서를 재분할해 현재 슬라이드만 적재한다.
      if (slideCtrl && slideCtrl.setMarkdown(md || '')) return;
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

  // ── 통합 단일 슬라이드 편집 컨트롤러(프레젠테이션 문서) ──
  // 좌측 에디터에는 현재 슬라이드만, 우측엔 동기화된 덱을 렌더한다. window.editor 셰임이
  // 준비된 직후 생성하고, 레이아웃의 추가 존/내비게이션 버튼 핸들러를 부착한다.
  slideCtrl = createSlideController({
    getView: () => cmEditorView,
    getSlug: () => TARGET_SLUG || '',
    getPalettes: () => (window.appConfig && window.appConfig.palettes) || null,
    isPresentationActive: () => !!($('wsEditPresentation') && $('wsEditPresentation').checked),
    updatePreview: () => { renderPreview(); },
    revealPreview: () => { tabSwitcher?.activateTab('preview'); },
  });
  slideCtrl.wireControls();

  // 다크모드 변경 시 테마/하이라이트/배경 보정을 위키 에디터와 동일하게 reconfigure.
  document.addEventListener('wiki:theme-changed', () => {
    const dark = isDark();
    cmEditorView.dispatch({
      effects: [
        themeCompartment.reconfigure(dark ? oneDark : lightTheme),
        darkBgCompartment.reconfigure(buildDarkBgExt()),
        syntaxHighlightCompartment.reconfigure(buildSyntaxHighlightExts()),
      ],
    });
  });

  // 텍스트 카운터 초기화.
  if (typeof window.updateEditorTextCounter === 'function') {
    window.updateEditorTextCounter(cmEditorView.state.doc.toString());
  }

  // 툴바 생성.
  buildToolbar(cmEditorView);

  // 모바일 탭(에디터/프리뷰) + PC 보기 모드(일반/작성/보기) 스위처(위키 에디터와 동일 UX).
  const layoutEl = host?.querySelector('.wiki-editor-layout');
  const toolbarEl = document.getElementById('cm-toolbar');
  if (layoutEl && toolbarEl) {
    tabSwitcher = setupTabSwitcher(layoutEl, toolbarEl, {
      onPreviewShown: () => { renderPreview(); },
      onModeChange: (mode) => {
        currentPcMode = mode;
        // 통합 슬라이드 편집 진입/이탈을 먼저 처리(에디터/덱 내용 정합)한 뒤 프리뷰를 다시 그린다.
        // (setupTabSwitcher 는 onPreviewShown 을 onModeChange 보다 먼저 호출하므로, 그 시점의
        //  프리뷰는 이전 슬라이드 상태 기준이다 — 모드 전이 확정 후 한 번 더 렌더해 정합을 맞춘다.)
        slideCtrl?.syncToMode(mode);
        cmView?.requestMeasure();
        if (mode !== 'edit') renderPreview();
      },
    });
  }

  // 에디터 셰임이 준비됐으니 자동완성 부착을 결정적으로 트리거한다.
  window.dispatchEvent(new Event('wiki-editor-ready'));
  if (typeof window.ensureAutocompleteAttached === 'function') {
    window.ensureAutocompleteAttached();
  }

  return cmEditorView;
}

// ── 툴바(위키 에디터와 동일한 버튼/기능을 buildSharedToolbar 로 공유) ──
// 위키 전용 모달(하위 문서 삽입·템플릿)은 /api/w/ 엔드포인트에 의존하므로 enableWikiModals: false.
// 이미지 업로드는 wiki-popup 모드를 그대로 사용하되, configureImageUpload 로 워크스페이스 전용
// 미디어 엔드포인트와 검색 fetcher 를 주입한다(buildToolbar 호출 전 설정).
function buildToolbar(view) {
  const toolbar = document.getElementById('cm-toolbar');
  if (!toolbar) return;

  const { insertText } = makeFormatHelpers(view);

  // 워크스페이스 미디어 컨텍스트 주입: 업로드 → /api/ws/:wslug/media, 검색 → 캐시 기반 클라이언트 필터
  if (typeof window.configureImageUpload === 'function') {
    window.configureImageUpload({
      uploadUrl: WS_BASE + '/media',
      searchFetcher: wsImageSearchFetcher,
    });
  }

  buildSharedToolbar(toolbar, view, {
    insertText,
    imageButton: { mode: 'wiki-popup' },
    enableWikiModals: false,
  });
}

// 워크스페이스 미디어 검색 fetcher: 목록 API 를 전체 페이지 순회해 캐싱 후 파일명으로 클라이언트 필터링.
// 200개 초과 워크스페이스에서도 모든 이미지를 검색할 수 있도록 offset 페이지네이션을 완전히 수행한다.
async function wsImageSearchFetcher(q, _tags, limit, offset) {
  if (offset === 0 && !q) wsMediaCache = null; // 새 검색 시 캐시 갱신
  if (!wsMediaCache) {
    const all = [];
    let off = 0;
    while (true) {
      const res = await fetch(WS_BASE + '/media?limit=200&offset=' + off, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('미디어를 불러오지 못했습니다.');
      const data = await res.json();
      const batch = (data.items || []).map((m) => ({ id: m.id, url: m.url, filename: m.filename, tags: [] }));
      all.push(...batch);
      if (batch.length < 200) break;
      off += 200;
    }
    wsMediaCache = all;
  }
  const all = wsMediaCache || [];
  const filtered = q ? all.filter((m) => m.filename.toLowerCase().includes(q.toLowerCase())) : all;
  return { total: filtered.length, items: filtered.slice(offset, offset + limit) };
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

  // 디바운스로 대기 중인 자동 요약을 즉시 반영한다.
  if (typeof window.refreshAutoSummary === 'function') window.refreshAutoSummary();
  // 편집 요약은 사용자 입력분(summary)과 백그라운드 자동 요약분(auto_summary)을 분리해 전송하고,
  // 병합("<사용자입력> / <자동요약>")은 서버가 수행한다(위키 에디터와 동일). 길이 제한(255자)은
  // 서버가 사용자 입력분에만 적용하고, 자동 요약분에는 적용하지 않는다.
  const userSummary = ($('summaryInput')?.value || '').trim();
  const autoSummary = typeof window.getAutoEditSummary === 'function' ? window.getAutoEditSummary() : '';

  const payload = {
    content: window.editor?.getMarkdown() || '',
    title: ($('alternateTitleInput')?.value || '').trim() || null,
    summary: userSummary || undefined,
    auto_summary: autoSummary || undefined,
    // 프레젠테이션 모드 — 체크 시 'presentation', 해제 시 null(일반 문서). 본문 저장과 함께 반영.
    doc_type: ($('wsEditPresentation') && $('wsEditPresentation').checked) ? 'presentation' : null,
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
      // 전체 새로고침 대신 부분 업데이트로 처리해 편집 중인 본문 소실을 방지한다.
      const nextSlug = data.slug || newSlug.trim();
      TARGET_SLUG = nextSlug;

      // URL 을 새 슬러그로 교체(히스토리 누적 없이).
      history.replaceState({}, '', '/ws/' + encodeURIComponent(WSLUG) + '/edit?slug=' + encodeURIComponent(nextSlug));

      // 슬러그 표시 입력 갱신.
      const slugInput = $('wsEditSlug');
      if (slugInput) (slugInput as HTMLInputElement).value = nextSlug;

      // 취소 링크를 새 문서 보기 주소로 갱신.
      const cancel = $('wsEditCancel');
      if (cancel) cancel.setAttribute('href', wsDocUrl(nextSlug));

      // 자동완성/자동요약 등 외부 모듈이 읽는 전역 슬러그 동기화.
      window.slug = nextSlug;

      // 프리뷰 트랜스클루전/링크 베이스가 슬러그에 의존하므로 다시 그린다(본문은 유지).
      renderPreview();

      Swal.fire({
        icon: 'success',
        title: '제목이 변경되었습니다',
        toast: true,
        position: 'top-end',
        showConfirmButton: false,
        timer: 2000,
        timerProgressBar: true,
      });
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

// HTML on* 핸들러용 노출
window.wsEditSave = wsEditSave;
window.wsEditMove = wsEditMove;
window.wsEditDelete = wsEditDelete;
