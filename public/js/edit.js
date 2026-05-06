
// ── 블로그 모드 (blog-edit.html에서 window.BLOG_MODE = true로 설정) ──
const BLOG_MODE = !!(window.BLOG_MODE);
let blogPostId = null; // 기존 포스트 수정 시 ID (?id= 파라미터)

// ── Turnstile 상태 ──
let turnstileToken = null;
let turnstileWidgetId = null;
let turnstileReady = false;

function onTurnstileLoad() {
    turnstileReady = true;
    initTurnstile();
}

function initTurnstile() {
    const siteKey = appConfig && appConfig.turnstileSiteKey;
    if (!siteKey) {
        // Turnstile 미설정 시 저장 버튼 활성화
        const btn = document.getElementById('saveBtn');
        if (btn) btn.disabled = false;
        return;
    }
    // Turnstile 필요 환경 → 새로고침 버튼 노출 (스크립트 로드 실패 시에도 재시도 가능)
    const refreshBtn = document.getElementById('turnstileRefreshBtn');
    if (refreshBtn) refreshBtn.style.display = '';

    if (!turnstileReady) return;
    const container = document.getElementById('turnstile-container');
    if (!container || turnstileWidgetId !== null) return;
    turnstileWidgetId = turnstile.render(container, {
        sitekey: siteKey,
        callback: function (token) {
            turnstileToken = token;
            document.getElementById('saveBtn').disabled = false;
        },
        'expired-callback': function () {
            turnstileToken = null;
            document.getElementById('saveBtn').disabled = true;
            refreshTurnstile();
        },
        'error-callback': function () {
            turnstileToken = null;
            document.getElementById('saveBtn').disabled = true;
        },
    });
}

function refreshTurnstile() {
    if (turnstileWidgetId !== null) {
        turnstileToken = null;
        document.getElementById('saveBtn').disabled = true;
        turnstile.reset(turnstileWidgetId);
    }
}

// 사용자가 수동으로 Turnstile을 다시 로드할 때 호출.
// 탭이 불완전하게 리프레시되어 Turnstile 스크립트가 로드되지 않으면 저장이 막히므로,
// 스크립트/위젯을 모두 초기화한 뒤 다시 주입하여 복구한다.
function reloadTurnstile() {
    const container = document.getElementById('turnstile-container');
    if (!container) return;

    if (typeof turnstile !== 'undefined' && turnstileWidgetId !== null) {
        try { turnstile.remove(turnstileWidgetId); } catch (e) { /* ignore */ }
    }
    turnstileWidgetId = null;
    turnstileToken = null;
    container.innerHTML = '';

    const btn = document.getElementById('saveBtn');
    if (btn) btn.disabled = true;

    if (typeof turnstile !== 'undefined' && turnstileReady) {
        initTurnstile();
    } else {
        turnstileReady = false;
        const oldScript = document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]');
        if (oldScript) oldScript.remove();
        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad';
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
    }
}

// ── 아이콘 설정 변수 ──
let selectedIconsOnly = false; // SELECTED_ICONS_ONLY 환경변수 (true: icons.json만 허용)
let selectedIconsList = null;  // icons.json에서 로드된 아이콘 목록

// ── 아이콘 피커 변수 ──
let biIconList = null;       // Bootstrap Icons 목록 (지연 로딩됨)
let mdiIconList = null;      // MDI 목록 (지연 로딩됨)
let iconPickerSavedSelection = null; // 모달 열기 전 에디터 선택 위치
let pendingIconInsertion = null;     // 모달에서 선택된 아이콘 삽입 대기
let iconPickerToken = 0;             // 아이콘 피커 호출 토큰 (경쟁 조건 방지)

// ── 커스텀 프리뷰 렌더링 (render.js의 renderWikiContent 모듈 사용) ──
let previewDebounce;
let saveInProgress = false;

async function updateCustomPreview() {
    if (!editor) return;

    let customPreview = document.getElementById('custom-wiki-preview');
    if (!customPreview) return;

    // wiki-content 클래스 보장
    if (!customPreview.classList.contains('wiki-content')) {
        customPreview.classList.add('wiki-content');
    }

    const md = editor.getMarkdown();
    // 익스텐션 데이터 문서는 프리뷰 렌더링 비활성화
    const enabledExts = (appConfig && appConfig.enabledExtensions) || [];
    const extPrefix = enabledExts.find(ext => slug && slug.startsWith(ext + ':'));
    if (extPrefix) {
        customPreview.innerHTML = `<div class="wiki-ext-raw-data">
        <div class="wiki-ext-raw-badge"><i class="bi bi-database"></i> ${escapeHtml(extPrefix)} 익스텐션 데이터 (프리뷰 비활성화)</div>
        <pre class="wiki-ext-raw-pre">${escapeHtml(md)}</pre>
    </div>`;
    } else {
        await renderWikiContent(md, slug, 'custom-wiki-preview');
    }
    // 프리뷰가 갱신됐으니 스크롤 동기화 가이드 캐시 무효화 + 사후 레이아웃 변동 감시 재설정
    if (typeof window._invalidateScrollSyncGuides === 'function') {
        window._invalidateScrollSyncGuides();
    }
    if (typeof window._observePreviewLayoutShifts === 'function') {
        window._observePreviewLayoutShifts();
    }
}

// ── 문서 하단으로 스크롤 (에디터 + 프리뷰) ──
let hasScrolledToBottom = false;


function scrollPreviewToBottom() {
    if (!editor) return;
    const customPreview = document.getElementById('custom-wiki-preview');
    if (customPreview) {
        customPreview.scrollTop = customPreview.scrollHeight;
    }
}


let hasScrolledPreviewToBottom = false;
function scrollPreviewToBottomOnce() {
    if (hasScrolledPreviewToBottom) return;
    hasScrolledPreviewToBottom = true;
    const customPreview = document.getElementById('custom-wiki-preview');
    if (customPreview) customPreview.scrollTop = customPreview.scrollHeight;
}

function scrollToBottom() {
    if (hasScrolledToBottom) return;
    hasScrolledToBottom = true;

    if (!editor) return;
    if (isExtensionData) {
        // const rawTextarea = document.getElementById('rawExtTextarea');
        // if (rawTextarea) {
        //     rawTextarea.scrollTop = rawTextarea.scrollHeight;
        // }
    } else {
        // 프리뷰 스크롤
        const customPreview = document.getElementById('custom-wiki-preview');
        if (customPreview) {
            customPreview.scrollTop = customPreview.scrollHeight;
        }
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    await loadConfig();
    selectedIconsOnly = !!(appConfig && appConfig.selectedIconsOnly);
    initTurnstile();
    // 인증 확인
    try {
        const res = await fetch('/api/me');
        if (res.ok) {
            currentUser = await res.json();
            document.querySelectorAll('#navUserName, #userName').forEach(el => el.textContent = currentUser.name);
            document.querySelectorAll('#userAvatar').forEach(el => el.src = currentUser.picture || '');
            document.querySelectorAll('#navLogin').forEach(el => el.classList.add('d-none'));
            document.querySelectorAll('#navUser').forEach(el => el.classList.remove('d-none'));
            if (currentUser.role === 'admin' || currentUser.role === 'super_admin') {
                document.querySelectorAll('#navAdminConsole').forEach(el => el.classList.remove('d-none'));
            }
        } else {
            Swal.fire({
                icon: 'warning',
                title: '로그인 필요',
                text: '문서를 편집하려면 로그인이 필요합니다.',
                confirmButtonText: '로그인',
            }).then(() => {
                window.location.href = '/login';
            });
            return;
        }
    } catch (e) {
        window.location.href = '/login';
        return;
    }

    // slug 파싱
    const params = new URLSearchParams(window.location.search);
    slug = params.get('slug');

    // 블로그 모드: ?id= 파라미터 처리 (섹션 모드 없음, slug 불필요)
    if (BLOG_MODE) {
        const idParam = params.get('id');
        blogPostId = idParam && /^\d+$/.test(idParam) ? idParam : null;
        slug = '__blog__'; // slug 미입력 체크 우회용 더미값
        sectionMode = false;
    }

    // 섹션 편집 모드 (?section=N&h=...)
    const sectionParam = params.get('section');
    if (sectionParam !== null && sectionParam !== '') {
        const parsed = parseInt(sectionParam, 10);
        if (!Number.isNaN(parsed) && parsed >= 0) {
            sectionMode = true;
            sectionIndex = parsed;
            sectionHeadingParam = params.get('h') || '';
        }
    }

    if (slug) {
        DRAFT_KEY = 'wiki_draft_' + slug
            + (sectionMode ? ('#section=' + sectionIndex) : '');
    }
    // 과거 자동저장 잔여 키 일회성 정리 (오토세이브 기능은 제거됨)
    if (typeof purgeLegacyAutosaveKeys === 'function') purgeLegacyAutosaveKeys();

    if (!slug && !BLOG_MODE) {
        Swal.fire('오류', '문서 제목이 지정되지 않았습니다.', 'error').then(() => {
            window.location.href = '/';
        });
        return;
    }

    // 익스텐션 데이터 문서 감지 (freq: 등)
    const enabledExts = (appConfig && appConfig.enabledExtensions) || [];
    const extPrefix = enabledExts.find(ext => slug.startsWith(ext + ':'));
    isExtensionData = !!extPrefix;

    // 익스텐션 데이터 문서는 섹션 모드를 지원하지 않는다(raw 편집 UI 사용).
    // URL 에 ?section= 이 붙어 들어오더라도 sectionMode 플래그를 해제하지 않으면,
    // savePage 가 sectionMode && originalPageMeta 조건으로 category/redirect/is_locked
    // 를 초기 로드 값(originalPageMeta)으로 고정해 송신하여,
    // UI 에는 전체 편집 필드가 보이는데도 사용자의 메타데이터 편집이 조용히 버려진다.
    if (isExtensionData && sectionMode) {
        sectionMode = false;
        sectionIndex = -1;
        sectionHeadingParam = '';
        if (slug) DRAFT_KEY = 'wiki_draft_' + slug;
    }

    if (isExtensionData) {
        // 익스텐션 데이터: raw textarea 사용 (대용량 데이터 지원)
        const editorContainer = document.getElementById('editor');
        editorContainer.innerHTML = `
            <div class="wiki-ext-raw-editor">
                <div class="wiki-ext-raw-editor-badge">
                    <i class="bi bi-database"></i> ${escapeHtml(extPrefix)} 익스텐션 데이터
                    <span class="wiki-ext-raw-editor-hint">마크다운 렌더링이 비활성화된 원시 데이터 편집 모드입니다</span>
                </div>
                <textarea id="rawExtTextarea" class="wiki-ext-raw-textarea" spellcheck="false"></textarea>
            </div>
        `;

        const rawTextarea = document.getElementById('rawExtTextarea');

        function updateRawCounts() {
            updateEditorTextCounter(rawTextarea.value);
        }
        // 키스트로크마다 전체 regex/split 스캔이 돌지 않도록 input에는 디바운스 버전 사용
        rawTextarea.addEventListener('input', () => {
            updateEditorTextCounterFromTextDebounced(rawTextarea.value);
        });
        updateRawCounts();

        // editor 심(shim) 객체: 기존 코드(save, cancel, diff, autosave 등)가
        // editor.getMarkdown() / editor.setMarkdown()을 통해 동작하도록 호환 유지
        editor = {
            getMarkdown: () => rawTextarea.value,
            setMarkdown: (md) => { rawTextarea.value = md; updateRawCounts(); },
            on: () => { },           // change 이벤트 등 무시
            focus: () => rawTextarea.focus(),
            insertText: (t) => {
                const start = rawTextarea.selectionStart;
                const end = rawTextarea.selectionEnd;
                rawTextarea.value = rawTextarea.value.substring(0, start) + t + rawTextarea.value.substring(end);
                rawTextarea.selectionStart = rawTextarea.selectionEnd = start + t.length;
                updateRawCounts();
            },
            changePreviewStyle: () => { },
            // 프리뷰, diff 등에서 참조하는 메서드 추가 방지
        };

        // 변경 사항 미리보기, 스크롤 동기화, 자동 프리뷰 등 건너뜀
    } else {
        // ── CodeMirror 6 에디터 초기화 ──
        const isMobile = window.innerWidth <= 768;

        // 에디터 레이아웃 구성 (PC: 툴바 전체폭 + 좌우 스플릿 / 모바일: 탭)
        const editorContainer = document.getElementById('editor');
        editorContainer.innerHTML = `
            <div class="wiki-editor-layout">
                <div class="cm-mobile-tabs" id="cm-mobile-tabs">
                    <button class="cm-tab-btn active" data-tab="editor"><i class="mdi mdi-pencil"></i> 에디터</button>
                    <button class="cm-tab-btn" data-tab="preview"><i class="mdi mdi-eye"></i> 프리뷰</button>
                </div>
                <div id="cm-toolbar" class="cm-toolbar"></div>
                <div class="wiki-editor-split-row" id="wiki-editor-split-row">
                    <div class="wiki-editor-pane" id="cm-editor-pane">
                        <div id="cm-editor"></div>
                    </div>
                    <div class="wiki-preview-pane" id="custom-wiki-preview"></div>
                    <!-- 에디터 전용 플로팅 TOC 패널 -->
                    <div class="toc-floating-panel" id="editorTocFloatingPanel">
                        <div class="toc-floating-header">
                            <span><i class="mdi mdi-format-list-bulleted-square me-1"></i> 목차</span>
                        </div>
                        <nav class="toc-floating-body" id="editorTocFloatingNav"></nav>
                    </div>
                    <!-- 에디터 전용 스크롤 FAB -->
                    <div class="scroll-fab-group" id="editorScrollFabGroup">
                        <button class="scroll-fab" id="editorTocFabBtn" onclick="toggleEditorFloatingToc()" title="목차">
                            <i class="mdi mdi-format-list-bulleted-square"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;

        // CM6 모듈 동적 import (Import Map으로 해석)
        const [cmState, cmViewMod, cmCommands, cmMarkdown, cmLangData, cmOneDark, cmLanguage, cmLezer, cmSearch] = await Promise.all([
            import("@codemirror/state"),
            import("@codemirror/view"),
            import("@codemirror/commands"),
            import("@codemirror/lang-markdown"),
            import("@codemirror/language-data"),
            import("@codemirror/theme-one-dark"),
            import("@codemirror/language"),
            import("@lezer/highlight"),
            import("@codemirror/search"),
        ]);

        const { EditorState, Compartment, RangeSetBuilder, StateField, StateEffect } = cmState;
        const { EditorView, keymap: cmKeymap, lineNumbers, highlightActiveLineGutter, drawSelection,
            MatchDecorator, ViewPlugin, Decoration, WidgetType } = cmViewMod;
        const { defaultKeymap, history, historyKeymap, indentWithTab } = cmCommands;
        const { markdown, markdownLanguage } = cmMarkdown;
        const { languages } = cmLangData;
        const { oneDark } = cmOneDark;
        const { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, HighlightStyle, syntaxTree } = cmLanguage;
        const { tags: t } = cmLezer;
        const { SearchCursor } = cmSearch;

        // 이벤트 핸들러 저장소 (shim의 editor.on() 용)
        const editorEventHandlers = { change: [], blur: [] };

        // 스크롤 동기화 활성화 플래그 (커서 위치 기반)
        let _scrollSyncEnabled = false;

        // 다크모드 감지
        let isDarkMode = getIsDarkMode();

        // ── 에디터 설정 (localStorage에서 불러오기) ──
        const editorSettings = {
            showLineNumbers: localStorage.getItem('editor_show_line_numbers') !== 'false',
            scrollSync: localStorage.getItem('editor_scroll_sync') === 'true',
            scrollSyncMode: localStorage.getItem('editor_scroll_sync_mode') === 'twoway' ? 'twoway' : 'oneway',
            wordWrap: localStorage.getItem('editor_word_wrap') !== 'false',
            syntaxHighlight: localStorage.getItem('editor_syntax_highlight') !== 'false',
            advancedEdit: localStorage.getItem('editor_advanced_edit') !== 'false',
            autoSummary: localStorage.getItem('editor_auto_summary') !== 'false',
        };

        // ── CM6 동적 재설정용 Compartment ──
        const lineNumbersCompartment = new Compartment();
        const lineWrappingCompartment = new Compartment();
        const syntaxHighlightCompartment = new Compartment();
        const advancedEditCompartment = new Compartment();
        const themeCompartment = new Compartment();
        const darkBgCompartment = new Compartment();

        // ── 찾기/바꾸기 매치 하이라이트 (StateField + StateEffect) ──
        const setSearchMatchesEffect = StateEffect.define();
        const searchMatchDeco = Decoration.mark({ class: "cm-search-match" });
        const searchActiveDeco = Decoration.mark({ class: "cm-search-match-active" });
        const searchMatchField = StateField.define({
            create() { return Decoration.none; },
            update(value, tr) {
                value = value.map(tr.changes);
                for (const e of tr.effects) {
                    if (e.is(setSearchMatchesEffect)) value = e.value;
                }
                return value;
            },
            provide: f => EditorView.decorations.from(f)
        });

        // ── 마크다운 문법 하이라이트 스타일 ──
        const markdownLightStyle = HighlightStyle.define([
            // 헤딩 (레벨별 구분)
            { tag: t.heading1, color: "#0550ae", fontWeight: "700", fontSize: "2em" },
            { tag: t.heading2, color: "#0550ae", fontWeight: "700", fontSize: "1.75em" },
            { tag: t.heading3, color: "#0a3069", fontWeight: "700", fontSize: "1.5em" },
            { tag: t.heading4, color: "#0a3069", fontWeight: "600", fontSize: "1.25em" },
            { tag: t.heading5, color: "#0a3069", fontWeight: "600", fontSize: "1.1em" },
            { tag: t.heading6, color: "#0a3069", fontWeight: "600", fontSize: "1em" },
            // 인라인 서식
            { tag: t.strong, fontWeight: "700" },
            { tag: t.emphasis, fontStyle: "italic" },
            { tag: t.strikethrough, textDecoration: "line-through", color: "#6e7781" },
            // 링크 & URL
            { tag: t.link, color: "#0969da" },
            { tag: t.url, color: "#0969da" },
            // 인라인 코드
            { tag: t.monospace, class: "cm-inline-code" },
            // 인용
            { tag: t.quote, color: "inherit", fontStyle: "normal" },
            // 마크업 메타문자 (# * _ ~ ` > - 등)
            { tag: t.meta, color: "#6e7781" },
            { tag: t.processingInstruction, color: "#6e7781" },
            // 구분선 / 리스트 마커
            { tag: t.contentSeparator, color: "#6e7781" },
            { tag: t.list, color: "inherit" },
            // 코드 블록 내부 토큰
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
            { tag: t.invalid, color: "#f85149" },
        ]);

        const markdownDarkStyle = HighlightStyle.define([
            { tag: t.heading1, color: "#79c0ff", fontWeight: "700", fontSize: "2em" },
            { tag: t.heading2, color: "#79c0ff", fontWeight: "700", fontSize: "1.75em" },
            { tag: t.heading3, color: "#79c0ff", fontWeight: "700", fontSize: "1.5em" },
            { tag: t.heading4, color: "#58a6ff", fontWeight: "600", fontSize: "1.25em" },
            { tag: t.heading5, color: "#58a6ff", fontWeight: "600", fontSize: "1.1em" },
            { tag: t.heading6, color: "#58a6ff", fontWeight: "600", fontSize: "1em" },
            { tag: t.strong, fontWeight: "700" },
            { tag: t.emphasis, fontStyle: "italic" },
            { tag: t.strikethrough, textDecoration: "line-through", color: "#8b949e" },
            { tag: t.link, color: "#58a6ff" },
            { tag: t.url, color: "#58a6ff" },
            { tag: t.monospace, class: "cm-inline-code" },
            { tag: t.quote, color: "inherit", fontStyle: "normal" },
            { tag: t.meta, color: "#8b949e" },
            { tag: t.processingInstruction, color: "#8b949e" },
            { tag: t.contentSeparator, color: "#8b949e" },
            { tag: t.list, color: "inherit" },
            { tag: t.keyword, color: "#ff7b72", fontWeight: "500" },
            { tag: [t.atom, t.bool], color: "#79c0ff" },
            { tag: t.number, color: "#79c0ff" },
            { tag: t.string, color: "#a5d6ff" },
            { tag: [t.regexp, t.escape], color: "#ffa657" },
            { tag: t.comment, color: "#8b949e", fontStyle: "italic" },
            { tag: t.variableName, color: "#ffa657" },
            { tag: t.definition(t.variableName), color: "#7ee787" },
            { tag: t.typeName, color: "#7ee787" },
            { tag: t.tagName, color: "#7ee787" },
            { tag: t.attributeName, color: "#ffa657" },
            { tag: t.operator, color: "#ff7b72" },
            { tag: t.invalid, color: "#f85149" },
        ]);

        // 라이트 모드 테마 (라이트 전용 색상 및 스타일)
        const lightTheme = EditorView.theme({
            "&": {
                backgroundColor: "#ffffff",
                color: "#24292f",
                height: "100%",
                fontSize: "14px",
                fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace"
            },
            ".cm-content": {
                caretColor: "#24292f",
                paddingBottom: "25vh"
            },
            ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#24292f" },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
                backgroundColor: "#b4d5fe"
            },
            ".cm-gutters": {
                backgroundColor: "#f6f8fa",
                color: "#6e7781",
                border: "none",
                borderRight: "1px solid #d0d7de"
            },
            ".cm-activeLineGutter": { backgroundColor: "#dbeafe" },
            ".cm-activeLine": { backgroundColor: "#f0f7ff" },
            ".cm-scroller": { overflow: "auto" },
            ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px" },
            ".cm-foldGutter .cm-gutterElement": { padding: "0 4px" },
        }, { dark: false });

        const buildDarkBgExt = () => isDarkMode ? EditorView.theme({
            "&": { height: "100%", fontSize: "14px", backgroundColor: "#000000" },
            ".cm-scroller": { overflow: "auto" },
            ".cm-content": { paddingBottom: "25vh" },
            ".cm-gutters": { backgroundColor: "#000000", borderRight: "1px solid #333" },
            ".cm-activeLineGutter": { backgroundColor: "#2d2d2d" }
        }) : [];

        // ── 위키 문법 에디터 내 하이라이팅 플러그인 ──
        const makePlugin = (matcher) => ViewPlugin.fromClass(class {
            constructor(view) { this.decorations = matcher.createDeco(view); }
            update(update) { this.decorations = matcher.updateDeco(update, this.decorations); }
        }, { decorations: v => v.decorations });

        const wikiLinkMatcher = new MatchDecorator({
            regexp: /\[\[([^\]]*)\]\]/g,
            decoration: Decoration.mark({ class: "cm-wiki-link" })
        });
        const wikiLinkPlugin = makePlugin(wikiLinkMatcher);

        const templateMatcher = new MatchDecorator({
            // {{{...}}} 파라미터 참조는 제외 (lookbehind + lookahead 사용)
            regexp: /(?<!\{)\{\{(?!\{)([^}]*)\}\}/g,
            decoration: Decoration.mark({ class: "cm-wiki-template" })
        });
        const templatePlugin = makePlugin(templateMatcher);

        // 틀 파라미터 참조 {{{이름}}} / {{{1}}} / {{{이름|기본값}}}
        const templateParamMatcher = new MatchDecorator({
            regexp: /\{\{\{([^{}|]+)(?:\|[^{}]*)?\}\}\}/g,
            decoration: Decoration.mark({ class: "cm-wiki-template-param" })
        });
        const templateParamPlugin = makePlugin(templateParamMatcher);

        const alignMatcher = new MatchDecorator({
            regexp: /\{[<p^>><]+\}/g,
            decoration: Decoration.mark({ class: "cm-align-marker" })
        });
        const alignPlugin = makePlugin(alignMatcher);

        // ── 인라인 아이콘 위젯 ({bi:}/{mdi:}/{icon:} 옆에 실제 아이콘 미리보기) ──
        class InlineIconWidget extends WidgetType {
            constructor(type, name) { super(); this.type = type; this.name = name; }
            eq(other) { return other.type === this.type && other.name === this.name; }
            toDOM() {
                const wrap = document.createElement('span');
                wrap.className = 'cm-inline-icon-widget';
                wrap.setAttribute('aria-hidden', 'true');
                let iconEl = null;
                if (this.type === 'bi') {
                    iconEl = document.createElement('i');
                    iconEl.className = `bi bi-${this.name}`;
                } else if (this.type === 'mdi') {
                    iconEl = document.createElement('span');
                    iconEl.className = `mdi mdi-${this.name}`;
                } else if (this.type === 'icon') {
                    if (this.name.startsWith('bi-')) {
                        iconEl = document.createElement('i');
                        iconEl.className = `bi ${this.name}`;
                    } else if (this.name.startsWith('mdi-')) {
                        iconEl = document.createElement('span');
                        iconEl.className = `mdi ${this.name}`;
                    }
                }
                if (iconEl) wrap.appendChild(iconEl);
                return wrap;
            }
            ignoreEvent() { return true; }
        }

        const iconMarkerMatcher = new MatchDecorator({
            regexp: /\{(bi|mdi|icon):[^}]+\}/g,
            decoration: Decoration.mark({ class: "cm-icon-marker" })
        });
        const iconMarkerPlugin = makePlugin(iconMarkerMatcher);

        const iconWidgetMatcher = new MatchDecorator({
            regexp: /\{(bi|mdi|icon):([^}\s]+)\}/g,
            decorate: (add, from, to, match, view) => {
                // 인라인 코드(`...`) 내부에서는 아이콘 위젯 표시하지 않음
                const line = view.state.doc.lineAt(from);
                const relPos = from - line.from;
                const codeRegex = /`[^`]+`/g;
                let m;
                while ((m = codeRegex.exec(line.text)) !== null) {
                    if (relPos >= m.index && relPos < m.index + m[0].length) return;
                }
                const type = match[1];
                const name = (match[2] || '').trim();
                // 안전한 아이콘 이름 패턴만 허용 (영문/숫자/하이픈/언더스코어)
                if (!/^[a-zA-Z0-9_-]+$/.test(name)) return;
                if (type === 'icon' && !(name.startsWith('bi-') || name.startsWith('mdi-'))) return;
                add(to, to, Decoration.widget({
                    widget: new InlineIconWidget(type, name),
                    side: 1
                }));
            }
        });
        const iconWidgetPlugin = makePlugin(iconWidgetMatcher);

        const colorBadgeMatcher = new MatchDecorator({
            regexp: /\{(color|bg):\s*([^}]+)\}/g,
            decoration: (match, view, pos) => {
                // 인라인 코드(`...`) 내부에서는 컬러 배지 표시하지 않음
                const line = view.state.doc.lineAt(pos);
                const relPos = pos - line.from;
                const codeRegex = /`[^`]+`/g;
                let m;
                while ((m = codeRegex.exec(line.text)) !== null) {
                    if (relPos >= m.index && relPos < m.index + m[0].length) {
                        return null;
                    }
                }
                return Decoration.mark({
                    class: "cm-color-badge",
                    attributes: { style: `--badge-color: ${match[2]};` }
                });
            }
        });
        const colorBadgePlugin = makePlugin(colorBadgeMatcher);

        const paletteBadgeMatcher = new MatchDecorator({
            regexp: /\{palette:\s*([^}]+)\}/g,
            decoration: (match, view, pos) => {
                // 인라인 코드(`...`) 내부에서는 팔레트 배지 표시하지 않음
                const line = view.state.doc.lineAt(pos);
                const relPos = pos - line.from;
                const codeRegex = /`[^`]+`/g;
                let m;
                while ((m = codeRegex.exec(line.text)) !== null) {
                    if (relPos >= m.index && relPos < m.index + m[0].length) {
                        return null;
                    }
                }
                const name = (match[1] || '').trim();
                let variant = null;
                try {
                    const merged = (typeof getMergedWikiPalettes === 'function') ? getMergedWikiPalettes() : {};
                    const entry = merged[name];
                    if (entry) {
                        const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
                        variant = isDark ? (entry.dark || entry.light) : (entry.light || entry.dark);
                    }
                } catch (_) { /* noop */ }
                if (!variant) return null;
                const rawBg = variant.bg || 'transparent';
                const rawColor = variant.color || 'inherit';
                const safeBg = (typeof _isSafeCssColor === 'function' && _isSafeCssColor(rawBg)) ? rawBg : 'transparent';
                const safeColor = (typeof _isSafeCssColor === 'function' && _isSafeCssColor(rawColor)) ? rawColor : 'inherit';
                return Decoration.mark({
                    class: "cm-palette-badge",
                    attributes: { style: `--palette-bg: ${safeBg}; --palette-color: ${safeColor};` }
                });
            }
        });
        const paletteBadgePlugin = makePlugin(paletteBadgeMatcher);

        // 파라미터 토큰: {badge:}, {tag:}, {button:}, {stat:}, {size:}, {hr}
        // {{틀}} 과 충돌하지 않도록 앞뒤 중괄호 제외
        const paramTokenMatcher = new MatchDecorator({
            regexp: /(?<!\{)\{(?:hr|(?:badge|tag|button|stat|size):[^}]+)\}(?!\})/g,
            decoration: (match, view, pos) => {
                // 인라인 코드(`...`) 내부에서는 표시하지 않음
                const line = view.state.doc.lineAt(pos);
                const relPos = pos - line.from;
                const codeRegex = /`[^`]+`/g;
                let m;
                while ((m = codeRegex.exec(line.text)) !== null) {
                    if (relPos >= m.index && relPos < m.index + m[0].length) {
                        return null;
                    }
                }
                return Decoration.mark({ class: "cm-param-token" });
            }
        });
        const paramTokenPlugin = makePlugin(paramTokenMatcher);

        const highlightMatcher = new MatchDecorator({
            regexp: /==([^=]+)==/g,
            decoration: Decoration.mark({ class: "cm-highlight" })
        });
        const highlightPlugin = makePlugin(highlightMatcher);

        const timeMatcher = new MatchDecorator({
            regexp: /\{(time|timer|age|dday|calendar):[^}]+\}/g,
            decoration: Decoration.mark({ class: "cm-time-marker" })
        });
        const timePlugin = makePlugin(timeMatcher);

        const inlineCodeMatcher = new MatchDecorator({
            regexp: /`([^`]+)`/g,
            decoration: Decoration.mark({ class: "cm-inline-code" })
        });
        const inlineCodePlugin = makePlugin(inlineCodeMatcher);

        const quoteListMatcher = new MatchDecorator({
            regexp: /^[ \t]*(>|[-+*]|\d+\.)(?=[ \t])/gm,
            decoration: (match) => {
                if (match[1] === '>') return Decoration.mark({ class: "cm-quote-marker" });
                return Decoration.mark({ class: "cm-list-marker" });
            }
        });
        const quoteListPlugin = makePlugin(quoteListMatcher);

        // 마크다운 일반 링크 대괄호/괄호 회색 처리
        const mdLinkBracketsPlugin = ViewPlugin.fromClass(class {
            constructor(view) { this.decorations = this.getDeco(view); }
            update(update) {
                if (update.docChanged || update.viewportChanged) {
                    this.decorations = this.getDeco(update.view);
                }
            }
            getDeco(view) {
                let builder = new RangeSetBuilder();
                let ranges = [];
                for (let { from, to } of view.visibleRanges) {
                    syntaxTree(view.state).iterate({
                        from, to,
                        enter: (node) => {
                            if (node.name === "LinkMark" || node.name === "ImageMark") {
                                ranges.push({ from: node.from, to: node.to });
                            }
                        }
                    });
                }
                ranges.sort((a, b) => a.from - b.from);
                const deco = Decoration.mark({ class: "cm-md-link-bracket" });
                for (let r of ranges) {
                    builder.add(r.from, r.to, deco);
                }
                return builder.finish();
            }
        }, { decorations: v => v.decorations });

        // 줄 단위 블록 스타일링 (접기, 코드블록 등)
        const lineStylePlugin = ViewPlugin.fromClass(class {
            constructor(view) { this.decorations = this.getDeco(view); }
            update(update) {
                if (update.docChanged || update.viewportChanged) {
                    this.decorations = this.getDeco(update.view);
                }
            }
            getDeco(view) {
                let builder = new RangeSetBuilder();
                let doc = view.state.doc;
                let maxLine = doc.lines;
                let inFold = false;
                let inCode = false;
                let colonBlockDepth = 0;
                const colonOpenRe = /^:::[a-zA-Z][a-zA-Z0-9_-]*(?:[ \t]+.*)?[ \t]*$/;
                const colonCloseRe = /^:::[ \t]*$/;

                for (let i = 1; i <= maxLine; i++) {
                    let line = doc.line(i);
                    let text = line.text;
                    let classes = [];

                    if (text.includes("[+")) inFold = true;
                    const isColonOpen = !inCode && colonOpenRe.test(text);
                    const isColonClose = !inCode && !isColonOpen && colonCloseRe.test(text);
                    if (isColonOpen) colonBlockDepth++;
                    if (inFold || colonBlockDepth > 0) classes.push("cm-fold-block");
                    if (text.includes("[-]")) inFold = false;
                    if (isColonClose && colonBlockDepth > 0) colonBlockDepth--;

                    let isCodeFence = text.trim().startsWith("```");
                    if (isCodeFence) {
                        inCode = !inCode;
                        classes.push("cm-code-block");
                    } else if (inCode) {
                        classes.push("cm-code-block");
                    }

                    if (classes.length > 0) {
                        builder.add(line.from, line.from, Decoration.line({ class: classes.join(" ") }));
                    }
                }
                return builder.finish();
            }
        }, { decorations: v => v.decorations });

        // ── 빈 표 셀 병합 미니툴바 ──
        // 커서가 마크다운 표의 빈 셀에 위치하면 병합 토큰 4종을 빠르게 삽입할 수 있는 툴바를 띄운다.
        const CELL_MERGE_BUTTONS = [
            { token: '{<}', label: '좌측 셀과 병합', icon: 'mdi mdi-arrow-left-bold-outline' },
            { token: '{>}', label: '우측 셀과 병합', icon: 'mdi mdi-arrow-right-bold-outline' },
            { token: '{^}', label: '상단 셀과 병합', icon: 'mdi mdi-arrow-up-bold-outline' },
            { token: '{><}', label: '가운데로 모음', icon: 'mdi mdi-arrow-collapse-horizontal' }
        ];
        const cellMergeToolbarEl = document.createElement('div');
        cellMergeToolbarEl.className = 'cm-cell-merge-toolbar';
        cellMergeToolbarEl.style.display = 'none';
        CELL_MERGE_BUTTONS.forEach(b => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'cm-cell-merge-btn';
            btn.title = `${b.label} ${b.token}`;
            btn.dataset.token = b.token;
            btn.innerHTML = `<i class="${b.icon}"></i>`;
            cellMergeToolbarEl.appendChild(btn);
        });
        document.body.appendChild(cellMergeToolbarEl);

        // 현재 활성 셀 정보 (range는 절대 오프셋)
        let activeMergeCell = null;

        function isTableSeparatorLine(text) {
            return /^\s*\|\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)*\s*\|?\s*$/.test(text);
        }
        function isPipeRow(text) {
            // 표 행: '|'로 시작 (구분선/일반 행 모두)
            return /^\s*\|/.test(text) && (text.match(/(?<!\\)\|/g) || []).length >= 2;
        }
        function isInsideTableBlock(state, lineNum) {
            // 현재 라인 또는 인접 라인 중 하나가 구분선이면 표 블록으로 간주
            const totalLines = state.doc.lines;
            const cur = state.doc.line(lineNum).text;
            if (isTableSeparatorLine(cur)) return false; // 구분선 자체에서는 표시 안 함
            // 아래 한 줄이 구분선 (현재 라인이 헤더)
            if (lineNum + 1 <= totalLines && isTableSeparatorLine(state.doc.line(lineNum + 1).text)) return true;
            // 위로 거슬러 올라가며 구분선 발견 (현재 라인이 본문)
            for (let n = lineNum - 1; n >= Math.max(1, lineNum - 30); n--) {
                const t = state.doc.line(n).text;
                if (isTableSeparatorLine(t)) return true;
                if (!isPipeRow(t)) break;
            }
            return false;
        }
        function findEmptyCellAt(lineText, col) {
            // col: 라인 내 0-based 커서 오프셋
            // 이스케이프 처리된 \\| 는 셀 구분자가 아님
            const pipes = [];
            for (let i = 0; i < lineText.length; i++) {
                if (lineText[i] === '\\') { i++; continue; }
                if (lineText[i] === '|') pipes.push(i);
            }
            if (pipes.length < 2) return null;
            for (let i = 0; i < pipes.length - 1; i++) {
                const lo = pipes[i];
                const hi = pipes[i + 1];
                if (col > lo && col <= hi) {
                    const segStart = lo + 1;
                    const segEnd = hi;
                    const seg = lineText.substring(segStart, segEnd);
                    if (seg.trim() === '') {
                        return { segStart, segEnd };
                    }
                    return null;
                }
            }
            return null;
        }

        function hideCellMergeToolbar() {
            if (cellMergeToolbarEl.style.display !== 'none') {
                cellMergeToolbarEl.style.display = 'none';
            }
            activeMergeCell = null;
        }

        function updateCellMergeToolbar(view) {
            const sel = view.state.selection.main;
            if (sel.from !== sel.to) { hideCellMergeToolbar(); return; }
            const pos = sel.head;
            const line = view.state.doc.lineAt(pos);
            const col = pos - line.from;
            if (!isPipeRow(line.text) || isTableSeparatorLine(line.text)) {
                hideCellMergeToolbar();
                return;
            }
            if (!isInsideTableBlock(view.state, line.number)) {
                hideCellMergeToolbar();
                return;
            }
            const cell = findEmptyCellAt(line.text, col);
            if (!cell) { hideCellMergeToolbar(); return; }

            activeMergeCell = {
                from: line.from + cell.segStart,
                to: line.from + cell.segEnd
            };

            // 위치: 커서 위쪽 (공간 부족 시 아래쪽)
            const coords = view.coordsAtPos(pos);
            if (!coords) { hideCellMergeToolbar(); return; }
            cellMergeToolbarEl.style.display = 'flex';
            // 측정을 위해 보이지 않게 한 번 렌더
            const tbW = cellMergeToolbarEl.offsetWidth || 160;
            const tbH = cellMergeToolbarEl.offsetHeight || 32;
            const margin = 6;
            let top = coords.top - tbH - margin;
            if (top < margin) top = coords.bottom + margin;
            let left = coords.left - tbW / 2;
            const viewportW = document.documentElement.clientWidth;
            left = Math.max(margin, Math.min(left, viewportW - tbW - margin));
            cellMergeToolbarEl.style.left = (left + window.scrollX) + 'px';
            cellMergeToolbarEl.style.top = (top + window.scrollY) + 'px';
        }

        cellMergeToolbarEl.addEventListener('mousedown', (e) => {
            // 에디터 blur로 인한 셀렉션 해제 방지
            e.preventDefault();
        });
        cellMergeToolbarEl.addEventListener('click', (e) => {
            const btn = e.target.closest('.cm-cell-merge-btn');
            if (!btn || !activeMergeCell) return;
            const token = btn.dataset.token;
            const view = window._cmView;
            if (!view) return;
            const insert = ` ${token} `;
            const { from, to } = activeMergeCell;
            view.dispatch({
                changes: { from, to, insert },
                selection: { anchor: from + insert.length }
            });
            hideCellMergeToolbar();
            view.focus();
        });

        // 에디터 스크롤/리사이즈 시 위치 갱신
        window.addEventListener('scroll', () => {
            if (cellMergeToolbarEl.style.display !== 'none' && window._cmView) {
                updateCellMergeToolbar(window._cmView);
            }
        }, true);
        window.addEventListener('resize', () => {
            if (cellMergeToolbarEl.style.display !== 'none' && window._cmView) {
                updateCellMergeToolbar(window._cmView);
            }
        });

        // 찾기/바꾸기 패널이 외부 편집을 감지하기 위한 훅 (find 패널 init 후 할당됨)
        var _findFeatureOnDocChange = null;

        // 문서 변경 감지 리스너
        const updateListener = EditorView.updateListener.of((update) => {
            if (update.docChanged) {
                editorEventHandlers.change.forEach(cb => cb());
                updateEditorTextCounterFromDoc(update.state.doc);
                if (_findFeatureOnDocChange) _findFeatureOnDocChange(update);
            }
            // 빈 표 셀 병합 미니툴바 위치/표시 갱신
            if (update.selectionSet || update.docChanged || update.viewportChanged) {
                updateCellMergeToolbar(update.view);
            }
        });

        // blur 감지
        const blurHandler = EditorView.domEventHandlers({
            blur: () => {
                editorEventHandlers.blur.forEach(cb => cb());
                // 에디터에서 포커스가 떠나면(모달 열기, 다른 입력 등) 셀 병합 툴바도 숨김.
                // 툴바 버튼 클릭은 mousedown.preventDefault()로 blur가 발생하지 않으므로 안전.
                hideCellMergeToolbar();
            },
            mousedown: (event, view) => {
                const target = event.target;
                const isColorBadge = target.classList && target.classList.contains('cm-color-badge');
                const isPaletteBadge = target.classList && target.classList.contains('cm-palette-badge');
                if (isColorBadge || isPaletteBadge) {
                    const rect = target.getBoundingClientRect();
                    // 배지(가상 요소) 클릭 여부 확인: 컬러 18px / 팔레트 28px 우측 영역
                    const badgeWidth = isColorBadge ? 18 : 28;
                    if (event.clientX > rect.right - badgeWidth) {
                        event.preventDefault();
                        event.stopPropagation();
                        const text = target.textContent;
                        if (isColorBadge) {
                            const match = text.match(/\{(color|bg):\s*([^}]+)\}/);
                            if (match) {
                                const type = match[1];
                                const colorCode = match[2];
                                const pos = view.posAtDOM(target);
                                if (pos !== null) {
                                    const endPos = pos + text.length;
                                    view.dispatch({ selection: { anchor: endPos } });
                                    showColorAutocomplete(colorCode, type);
                                    return true;
                                }
                            }
                        } else {
                            const match = text.match(/\{palette:\s*([^}]+)\}/);
                            if (match) {
                                const pos = view.posAtDOM(target);
                                if (pos !== null) {
                                    // posAtDOM이 요소 기준으로 오프셋이 어긋날 수 있어,
                                    // 클릭한 배지의 textContent와 동일한 토큰 중 pos에 가장 가까운 것을 택한다.
                                    // 같은 라인에 {palette:a}{palette:b} 처럼 인접 토큰이 있을 때
                                    // 경계 허용치 때문에 이전 토큰이 잘못 매칭되던 문제 방지.
                                    const line = view.state.doc.lineAt(pos);
                                    const relPos = pos - line.from;
                                    const tokenRegex = /\{palette:\s*[^}]+\}/g;
                                    let tokenFrom = -1;
                                    let tokenTo = -1;
                                    let bestDist = Infinity;
                                    let m;
                                    while ((m = tokenRegex.exec(line.text)) !== null) {
                                        if (m[0] !== text) continue;
                                        const start = m.index;
                                        const end = start + m[0].length;
                                        // 클릭 위치가 토큰 내부면 거리 0, 아니면 가장 가까운 끝까지의 거리
                                        const dist = relPos < start ? start - relPos
                                            : relPos > end ? relPos - end
                                                : 0;
                                        if (dist < bestDist) {
                                            bestDist = dist;
                                            tokenFrom = line.from + start;
                                            tokenTo = line.from + end;
                                            if (dist === 0) break;
                                        }
                                    }
                                    if (tokenFrom === -1) {
                                        // 폴백: 기존 추정치 사용
                                        tokenFrom = pos;
                                        tokenTo = pos + text.length;
                                    }
                                    const docLength = view.state.doc.length;
                                    tokenFrom = Math.max(0, Math.min(tokenFrom, docLength));
                                    tokenTo = Math.max(0, Math.min(tokenTo, docLength));
                                    if (tokenFrom > tokenTo) {
                                        const tmp = tokenFrom;
                                        tokenFrom = tokenTo;
                                        tokenTo = tmp;
                                    }
                                    view.dispatch({ selection: { anchor: tokenTo } });
                                    if (typeof hideAutocomplete === 'function') hideAutocomplete();
                                    if (typeof hideIconAutocomplete === 'function') hideIconAutocomplete();
                                    if (typeof hideColorAutocomplete === 'function') hideColorAutocomplete();
                                    if (typeof hideTimestampAutocomplete === 'function') hideTimestampAutocomplete();
                                    if (typeof hideImgSizeAutocomplete === 'function') hideImgSizeAutocomplete();
                                    paletteAc.replaceRange = { from: tokenFrom, to: tokenTo };
                                    showPaletteAutocomplete('', { showAll: true });
                                    return true;
                                }
                            }
                        }
                    }
                }
                return false;
            }
        });

        // ── 문법 하이라이트/고급 편집 확장 묶음 ──
        const buildSyntaxHighlightExts = () => editorSettings.syntaxHighlight ? [
            markdown({ base: markdownLanguage, codeLanguages: languages }),
            syntaxHighlighting(isDarkMode ? markdownDarkStyle : markdownLightStyle),
            wikiLinkPlugin,
            templatePlugin,
            templateParamPlugin,
            alignPlugin,
            iconMarkerPlugin,
            highlightPlugin,
            timePlugin,
            inlineCodePlugin,
            quoteListPlugin,
            paramTokenPlugin,
            lineStylePlugin
        ] : [];

        const buildAdvancedEditExts = () => (editorSettings.syntaxHighlight && editorSettings.advancedEdit) ? [
            colorBadgePlugin,
            paletteBadgePlugin,
            iconWidgetPlugin
        ] : [];

        // ── CM6 EditorView 생성 ──
        const cmEditorView = new EditorView({
            state: EditorState.create({
                doc: "",
                extensions: [
                    lineNumbersCompartment.of(
                        editorSettings.showLineNumbers
                            ? [lineNumbers(), highlightActiveLineGutter()]
                            : []
                    ),
                    drawSelection(),
                    indentOnInput(),
                    bracketMatching(),
                    history(),
                    cmKeymap.of([
                        { key: "Mod-f", run: () => { if (typeof openFindPanel === 'function') { openFindPanel(); } return true; }, preventDefault: true },
                        ...defaultKeymap,
                        ...historyKeymap,
                        indentWithTab
                    ]),
                    searchMatchField,
                    themeCompartment.of(isDarkMode ? oneDark : lightTheme),
                    darkBgCompartment.of(buildDarkBgExt()),
                    lineWrappingCompartment.of(
                        editorSettings.wordWrap ? EditorView.lineWrapping : []
                    ),
                    updateListener,
                    blurHandler,
                    syntaxHighlightCompartment.of(buildSyntaxHighlightExts()),
                    advancedEditCompartment.of(buildAdvancedEditExts())
                ]
            }),
            parent: document.querySelector('#cm-editor')
        });

        // 전역 CM6 인스턴스 보관
        window._cmView = cmEditorView;
        window.CodeMirrorView = cmViewMod;

        // 초기 텍스트 카운터 상태 반영
        updateEditorTextCounter(cmEditorView.state.doc.toString());

        // ── 에디터 Shim 객체 (기존 edit.js 코드와 호환) ──
        editor = {
            getMarkdown: () => cmEditorView.state.doc.toString(),
            setMarkdown: (md) => {
                cmEditorView.dispatch({
                    changes: { from: 0, to: cmEditorView.state.doc.length, insert: md }
                });
            },
            insertText: (text) => {
                const { main } = cmEditorView.state.selection;
                cmEditorView.dispatch({
                    changes: { from: main.from, to: main.to, insert: text },
                    selection: { anchor: main.from + text.length }
                });
                cmEditorView.focus();
            },
            getSelection: () => {
                const { main } = cmEditorView.state.selection;
                const fromLine = cmEditorView.state.doc.lineAt(main.from);
                const toLine = cmEditorView.state.doc.lineAt(main.to);
                return [
                    [fromLine.number, main.from - fromLine.from + 1],
                    [toLine.number, main.to - toLine.from + 1]
                ];
            },
            setSelection: (fromArr, toArr) => {
                try {
                    const fromLine = cmEditorView.state.doc.line(fromArr[0]);
                    const toLine = cmEditorView.state.doc.line(toArr[0]);
                    const from = fromLine.from + fromArr[1] - 1;
                    const to = toLine.from + toArr[1] - 1;
                    cmEditorView.dispatch({
                        selection: { anchor: from, head: to }
                    });
                } catch (e) {
                    // 잘못된 위치 무시
                }
            },
            focus: () => cmEditorView.focus(),
            on: (event, callback) => {
                if (editorEventHandlers[event]) {
                    editorEventHandlers[event].push(callback);
                }
            },
            changePreviewStyle: () => { /* CM6 스플릿 뷰에서는 불필요 */ },
            getCursorCoords: () => {
                const { main } = cmEditorView.state.selection;
                return cmEditorView.coordsAtPos(main.head);
            }
        };

        // ── 모바일 탭 전환 로직 ──
        const cmTabBtns = document.querySelectorAll('.cm-tab-btn');
        const cmEditorPane = document.getElementById('cm-editor-pane');
        const cmPreviewPane = document.getElementById('custom-wiki-preview');

        function activateCmTab(tab) {
            cmTabBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
            const layoutEl = document.querySelector('.wiki-editor-layout');
            if (layoutEl) layoutEl.dataset.activeTab = tab;
            if (tab === 'editor') {
                cmEditorPane.classList.add('cm-tab-active');
                cmPreviewPane.classList.remove('cm-tab-active');
                // 에디터 크기 재계산
                cmEditorView.requestMeasure();
            } else {
                cmEditorPane.classList.remove('cm-tab-active');
                cmPreviewPane.classList.add('cm-tab-active');
                // 프리뷰 탭으로 전환 시 즉시 렌더링
                updateCustomPreview();
            }
        }

        cmTabBtns.forEach(btn => {
            btn.addEventListener('click', () => activateCmTab(btn.dataset.tab));
        });

        // 모바일이면 에디터 탭을 기본 활성화 (PC는 CSS로 항상 표시)
        if (isMobile) {
            activateCmTab('editor');
        }

        // ── 커스텀 툴바 구성 ──
        const toolbar = document.getElementById('cm-toolbar');

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

        // 마크다운 서식 삽입 헬퍼
        function wrapSelection(prefix, suffix) {
            const { main } = cmEditorView.state.selection;
            const selected = cmEditorView.state.sliceDoc(main.from, main.to);
            const wrapped = prefix + (selected || '텍스트') + suffix;
            cmEditorView.dispatch({
                changes: { from: main.from, to: main.to, insert: wrapped },
                selection: { anchor: main.from + prefix.length, head: main.from + wrapped.length - suffix.length }
            });
            cmEditorView.focus();
        }

        function insertPrefix(prefix) {
            const { main } = cmEditorView.state.selection;
            const line = cmEditorView.state.doc.lineAt(main.from);
            cmEditorView.dispatch({
                changes: { from: line.from, to: line.from, insert: prefix }
            });
            cmEditorView.focus();
        }

        // 그리드/row 같은 블록 위키 문법 인라인 삽입.
        // 선택이 없으면 예시(stat 3개) 삽입, 있으면 선택을 ::: 블록으로 감쌈.
        // 시작/끝이 라인 경계가 아니면 줄바꿈을 자동 보정.
        function insertOrWrapWikiBlock(blockType) {
            const { main } = cmEditorView.state.selection;
            const selected = cmEditorView.state.sliceDoc(main.from, main.to);
            const inner = selected || `{palette:primary}{stat:값1|라벨1}\n{palette:secondary}{stat:값2|라벨2}\n{palette:success}{stat:값3|라벨3}`;
            const lineStart = cmEditorView.state.doc.lineAt(main.from);
            const lineEnd = cmEditorView.state.doc.lineAt(main.to);
            const prefix = (main.from === lineStart.from) ? '' : '\n';
            const suffix = (main.to === lineEnd.to) ? '' : '\n';
            const wrapped = `${prefix}:::${blockType}\n${inner}\n:::${suffix}`;
            cmEditorView.dispatch({
                changes: { from: main.from, to: main.to, insert: wrapped },
                selection: { anchor: main.from + wrapped.length }
            });
            cmEditorView.focus();
        }

        // 포맷 버튼
        toolbar.appendChild(createToolbarBtn('<b>H</b>', '제목', () => insertPrefix('## ')));
        toolbar.appendChild(createToolbarBtn('<b>B</b>', '굵게', () => wrapSelection('**', '**')));
        toolbar.appendChild(createToolbarBtn('<i>I</i>', '기울임', () => wrapSelection('*', '*')));
        toolbar.appendChild(createToolbarBtn('<s>S</s>', '취소선', () => wrapSelection('~~', '~~')));
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-format-underline"></i>', '밑줄', () => wrapSelection('__', '__')));
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-marker"></i>', '형광펜', () => wrapSelection('==', '==')));
        toolbar.appendChild(createToolbarSep());
        toolbar.appendChild(createToolbarBtn('─', '구분선', () => editor.insertText('\n---\n')));
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-format-quote-close"></i>', '인용', () => insertPrefix('> ')));
        toolbar.appendChild(createToolbarSep());
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-format-list-bulleted"></i>', '목록', () => insertPrefix('- ')));
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-format-list-numbered"></i>', '번호 목록', () => insertPrefix('1. ')));
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-checkbox-marked-outline"></i>', '체크리스트', () => insertPrefix('- [ ] ')));
        toolbar.appendChild(createToolbarSep());
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-view-grid-outline"></i>', '그리드', () => insertOrWrapWikiBlock('grid')));
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-view-week-outline"></i>', 'row(가로 배치)', () => insertOrWrapWikiBlock('row')));
        toolbar.appendChild(createToolbarSep());
        const tableBtn = createToolbarBtn('<i class="mdi mdi-table"></i>', '표', () => { });
        toolbar.appendChild(tableBtn);
        setupTableInsertPopover(tableBtn);
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-link-variant"></i>', '링크', () => wrapSelection('[', '](url)')));
        toolbar.appendChild(createToolbarSep());

        // 위키 커스텀 버튼
        toolbar.appendChild(createToolbarBtn('[[ ]]', '위키 링크 삽입', () => editor.insertText('[[문서제목]]')));
        toolbar.appendChild(createToolbarBtn('{{ }}', '틀 삽입', () => editor.insertText('{{틀제목}}')));

        toolbar.appendChild(createToolbarBtn('[*]', '각주 삽입', () => editor.insertText('[* 각주 내용]')));
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-form-dropdown"></i>', '펼치기 접기', () => editor.insertText('[+ 펼치기/접기 제목]\n여기에 숨겨진 내용이 들어갑니다.\n[-]')));
        toolbar.appendChild(createToolbarBtn('<i class="bi bi-diagram-3-fill"></i>', '하위 문서', () => openSubdocInsertModal()));
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-calendar-clock"></i>', '타임스탬프 삽입', () => openTimestampInsertModal()));
        toolbar.appendChild(createToolbarSep());
        const specialCharBtn = createToolbarBtn('<span class="cm-toolbar-omega">Ω</span>', '특수문자 삽입', () => { });
        toolbar.appendChild(specialCharBtn);
        setupSpecialCharPicker(specialCharBtn);
        toolbar.appendChild(createToolbarSep());
        if (selectedIconsOnly) {
            toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-vector-square"></i>', '아이콘 삽입', () => openSelectedIconsPicker()));
        } else {
            toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-vector-square"></i>', 'MDI 아이콘', () => openIconPicker('mdi')));
            toolbar.appendChild(createToolbarBtn('<i class="bi bi-bootstrap-fill"></i>', 'Bootstrap 아이콘', () => openIconPicker('bi')));
        }
        toolbar.appendChild(createToolbarSep());
        toolbar.appendChild(createToolbarBtn('<i class="bi bi-card-heading"></i>', '카드 블록', () => openCardInsertModal()));
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-palette-outline"></i>', '색상 삽입', () => openPaletteColorModal()));
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-label-outline"></i>', '배지', () => openBadgeInsertModal()));
        toolbar.appendChild(createToolbarSep());
        toolbar.appendChild(createToolbarBtn('<code>&lt;/&gt;</code>', '인라인 코드', () => wrapSelection('`', '`')));
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-code-braces"></i>', '코드 블록', () => wrapSelection('\n```\n', '\n```\n')));
        toolbar.appendChild(createToolbarSep());
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-google-maps"></i>', '구글 지도 삽입', () => openGoogleMapsEmbedModal()));

        // 이미지 업로드 버튼 + 드래그앤드롭 팝업
        const imageUploadBtn = createToolbarBtn('<i class="mdi mdi-image-plus"></i>', '이미지 업로드', () => { });
        toolbar.appendChild(imageUploadBtn);

        const imgUploadPopup = document.createElement('div');
        imgUploadPopup.className = 'img-upload-popup';
        imgUploadPopup.innerHTML = `
        <div class="img-upload-dropzone">
            <i class="mdi mdi-cloud-upload-outline"></i>
            <div class="drop-main-text">이미지를 여기에 드래그하세요</div>
            <div class="drop-sub-text">또는 클릭하여 파일 선택</div>
        </div>
        <button type="button" class="img-upload-search-btn">
            <i class="mdi mdi-magnify"></i> 기존 이미지 검색
        </button>
    `;
        document.body.appendChild(imgUploadPopup);

        const imgDropzone = imgUploadPopup.querySelector('.img-upload-dropzone');
        const imgSearchBtn = imgUploadPopup.querySelector('.img-upload-search-btn');

        imgSearchBtn.addEventListener('click', async () => {
            imgUploadPopup.classList.remove('active');
            await openExistingImageSearch((url, alt, size) => {
                let insertTxt = `![${alt}](${url})`;
                if (size && size !== 'full') insertTxt += `{size:${size}}`;
                insertTxt += '\n';
                editor.insertText(insertTxt);
            });
        });
        const imgFileInput = document.createElement('input');
        imgFileInput.type = 'file';
        imgFileInput.accept = 'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/ogg';
        imgFileInput.style.display = 'none';
        imgUploadPopup.appendChild(imgFileInput);

        imageUploadBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isActive = imgUploadPopup.classList.contains('active');
            imgUploadPopup.classList.toggle('active');
            if (!isActive) {
                const rect = imageUploadBtn.getBoundingClientRect();
                const popupW = imgUploadPopup.offsetWidth;
                const popupH = imgUploadPopup.offsetHeight;
                const viewportW = document.documentElement.clientWidth;
                const viewportH = document.documentElement.clientHeight;
                const margin = 8;
                const triggerCenterX = rect.left + (rect.width / 2);

                let left = triggerCenterX - (popupW / 2);
                left = Math.max(margin, Math.min(left, viewportW - popupW - margin));

                let top = rect.bottom + 6;
                if (top + popupH + margin > viewportH && rect.top - popupH - 6 >= margin) {
                    top = rect.top - popupH - 6;
                }
                top = Math.max(margin, Math.min(top, viewportH - popupH - margin));

                imgUploadPopup.style.left = (left + window.scrollX) + 'px';
                imgUploadPopup.style.top = (top + window.scrollY) + 'px';
            }
        });

        document.addEventListener('click', (e) => {
            if (!imgUploadPopup.contains(e.target) && !imageUploadBtn.contains(e.target)) {
                imgUploadPopup.classList.remove('active');
            }
        });

        imgDropzone.addEventListener('click', () => { imgFileInput.click(); });

        imgFileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            imgUploadPopup.classList.remove('active');
            await handleImageUpload(file, (url, alt, size) => {
                let insertTxt = `![${alt}](${url})`;
                if (size && size !== 'full') insertTxt += `{size:${size}}`;
                insertTxt += '\n';
                editor.insertText(insertTxt);
            });
            imgFileInput.value = '';
        });

        imgDropzone.addEventListener('dragenter', (e) => { e.preventDefault(); imgDropzone.classList.add('dragover'); });
        imgDropzone.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
        imgDropzone.addEventListener('dragleave', (e) => { e.preventDefault(); imgDropzone.classList.remove('dragover'); });
        imgDropzone.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            imgDropzone.classList.remove('dragover');
            const files = e.dataTransfer.files;
            if (!files || files.length === 0) return;
            const file = files[0];
            const acceptTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp',
                'video/mp4', 'video/webm', 'video/ogg'];
            if (!acceptTypes.includes(file.type)) {
                Swal.fire('오류', '지원하지 않는 파일 형식입니다.', 'warning');
                return;
            }
            imgUploadPopup.classList.remove('active');
            await handleImageUpload(file, (url, alt, size) => {
                let insertTxt = `![${alt}](${url})`;
                if (size && size !== 'full') insertTxt += `{size:${size}}`;
                insertTxt += '\n';
                editor.insertText(insertTxt);
            });
        });

        // ── 툴바 오른쪽 끝: 찾기/바꾸기 + 프리뷰 모드 + 설정 버튼 ──
        // 우측 정렬은 #cm-find-btn 의 margin-left:auto 로 처리 (findBtn 이 이 그룹의 첫 항목)

        // PC 전용: 보기/작성/일반 모드 전환 드롭다운
        const PC_MODES = {
            split: { icon: 'mdi-view-split-vertical', label: '일반 모드', desc: '에디터 + 프리뷰' },
            edit: { icon: 'mdi-pencil', label: '작성 모드', desc: '에디터만' },
            preview: { icon: 'mdi-eye-outline', label: '보기 모드', desc: '프리뷰만' },
        };

        const modeBtn = createToolbarBtn(
            `<i class="mdi ${PC_MODES.split.icon}"></i><i class="mdi mdi-menu-down cm-toolbar-caret"></i>`,
            '보기 방식 전환',
            () => toggleModePanel()
        );
        modeBtn.id = 'cm-mode-btn';
        modeBtn.classList.add('cm-toolbar-btn-pc-only', 'cm-toolbar-btn-mode');
        toolbar.appendChild(modeBtn);

        const modePanel = document.createElement('div');
        modePanel.id = 'editor-mode-panel';
        modePanel.className = 'editor-settings-panel editor-mode-panel';
        modePanel.style.display = 'none';
        modePanel.innerHTML = Object.entries(PC_MODES).map(([key, m]) => `
            <button type="button" class="editor-mode-option" data-mode="${key}">
                <i class="mdi ${m.icon}"></i>
                <span class="editor-mode-option-text">
                    <span class="editor-mode-option-label">${m.label}</span>
                    <span class="editor-mode-option-desc">${m.desc}</span>
                </span>
                <i class="mdi mdi-check editor-mode-option-check"></i>
            </button>
        `).join('');
        document.body.appendChild(modePanel);

        let currentPcMode = 'split';
        function setPcMode(mode) {
            const layoutEl = document.querySelector('.wiki-editor-layout');
            if (!layoutEl) return;
            if (!PC_MODES[mode]) mode = 'split';
            const prev = currentPcMode;
            currentPcMode = mode;
            if (mode === 'split') {
                delete layoutEl.dataset.pcMode;
            } else {
                layoutEl.dataset.pcMode = mode;
            }
            const m = PC_MODES[mode];
            modeBtn.innerHTML = `<i class="mdi ${m.icon}"></i><i class="mdi mdi-menu-down cm-toolbar-caret"></i>`;
            modeBtn.title = `보기 방식: ${m.label}`;
            modeBtn.classList.toggle('active', mode !== 'split');
            modePanel.querySelectorAll('.editor-mode-option').forEach(opt => {
                opt.classList.toggle('active', opt.dataset.mode === mode);
            });
            if (prev === mode) return;
            // 에디터가 숨김에서 표시로 전환된 경우 CM6에 레이아웃 재측정 요청
            if (prev === 'preview' && mode !== 'preview' && typeof cmEditorView !== 'undefined' && cmEditorView) {
                cmEditorView.requestMeasure();
            }
            // 프리뷰가 숨김에서 표시로 전환된 경우 즉시 갱신
            if (prev === 'edit' && mode !== 'edit') {
                updateCustomPreview();
            }
        }

        function toggleModePanel() {
            const isVisible = modePanel.style.display !== 'none';
            if (isVisible) {
                modePanel.style.display = 'none';
                return;
            }
            modePanel.style.visibility = 'hidden';
            modePanel.style.left = '-9999px';
            modePanel.style.top = '-9999px';
            modePanel.style.display = 'block';

            const panelW = modePanel.offsetWidth;
            const panelH = modePanel.offsetHeight;
            const rect = modeBtn.getBoundingClientRect();
            const viewportW = document.documentElement.clientWidth;
            const viewportH = document.documentElement.clientHeight;
            const margin = 8;

            let left = rect.right - panelW;
            left = Math.max(margin, Math.min(left, viewportW - panelW - margin));
            let top = rect.bottom + 4;
            if (top + panelH + margin > viewportH && rect.top - panelH - 4 >= margin) {
                top = rect.top - panelH - 4;
            }
            top = Math.max(margin, Math.min(top, viewportH - panelH - margin));

            modePanel.style.left = `${left + window.scrollX}px`;
            modePanel.style.top = `${top + window.scrollY}px`;
            modePanel.style.visibility = '';
        }

        modePanel.querySelectorAll('.editor-mode-option').forEach(opt => {
            opt.addEventListener('click', () => {
                setPcMode(opt.dataset.mode);
                modePanel.style.display = 'none';
            });
        });

        document.addEventListener('click', (e) => {
            if (!modePanel.contains(e.target) && !modeBtn.contains(e.target)) {
                modePanel.style.display = 'none';
            }
        });

        setPcMode('split');

        const settingsBtn = createToolbarBtn('<i class="mdi mdi-cog"></i>', '에디터 설정', () => toggleSettingsPanel());
        settingsBtn.id = 'cm-settings-btn';
        toolbar.appendChild(settingsBtn);

        // ── 에디터 설정 패널 ──
        const settingsPanel = document.createElement('div');
        settingsPanel.id = 'editor-settings-panel';
        settingsPanel.className = 'editor-settings-panel';
        settingsPanel.style.display = 'none';
        settingsPanel.innerHTML = `
            <div class="editor-settings-title"><i class="mdi mdi-cog"></i> 에디터 설정</div>
            <label class="editor-settings-item">
                <span>줄 번호 표시</span>
                <input type="checkbox" id="settingLineNumbers" ${editorSettings.showLineNumbers ? 'checked' : ''}>
            </label>
            <label class="editor-settings-item">
                <span>스크롤 동기화</span>
                <input type="checkbox" id="settingScrollSync" ${editorSettings.scrollSync ? 'checked' : ''}>
            </label>
            <label class="editor-settings-item editor-settings-subitem">
                <input type="radio" name="settingScrollSyncMode" value="oneway"
                    ${editorSettings.scrollSyncMode === 'oneway' ? 'checked' : ''}
                    ${editorSettings.scrollSync ? '' : 'disabled'}>
                <span>단방향 (에디터 → 프리뷰)</span>
            </label>
            <label class="editor-settings-item editor-settings-subitem">
                <input type="radio" name="settingScrollSyncMode" value="twoway"
                    ${editorSettings.scrollSyncMode === 'twoway' ? 'checked' : ''}
                    ${editorSettings.scrollSync ? '' : 'disabled'}>
                <span>양방향</span>
            </label>
            <label class="editor-settings-item">
                <span>문법 하이라이트</span>
                <input type="checkbox" id="settingSyntaxHighlight" ${editorSettings.syntaxHighlight ? 'checked' : ''}>
            </label>
            <label class="editor-settings-item">
                <span>아이콘 표시</span>
                <input type="checkbox" id="settingAdvancedEdit"
                    ${editorSettings.advancedEdit && editorSettings.syntaxHighlight ? 'checked' : ''}
                    ${editorSettings.syntaxHighlight ? '' : 'disabled'}>
            </label>
            <div class="editor-settings-divider"></div>
            <div class="editor-settings-section-title">줄바꿈 모드</div>
            <label class="editor-settings-item">
                <input type="radio" name="settingWrapMode" value="wrap" ${editorSettings.wordWrap ? 'checked' : ''}>
                <span>자동 줄바꿈 (기본)</span>
            </label>
            <label class="editor-settings-item">
                <input type="radio" name="settingWrapMode" value="scroll" ${!editorSettings.wordWrap ? 'checked' : ''}>
                <span>가로 스크롤</span>
            </label>
            <div class="editor-settings-divider"></div>
            <label class="editor-settings-item">
                <span>편집 요약 자동 작성</span>
                <input type="checkbox" id="settingAutoSummary" ${editorSettings.autoSummary ? 'checked' : ''}>
            </label>
        `;
        document.body.appendChild(settingsPanel);

        function toggleSettingsPanel() {
            const isVisible = settingsPanel.style.display !== 'none';
            if (isVisible) {
                settingsPanel.style.display = 'none';
                settingsBtn.classList.remove('active');
            } else {
                // 크기 측정을 위해 일단 보이지 않게 렌더링
                settingsPanel.style.visibility = 'hidden';
                settingsPanel.style.left = '-9999px';
                settingsPanel.style.top = '-9999px';
                settingsPanel.style.display = 'block';

                const panelW = settingsPanel.offsetWidth;
                const panelH = settingsPanel.offsetHeight;
                const rect = settingsBtn.getBoundingClientRect();
                const viewportW = document.documentElement.clientWidth;
                const viewportH = document.documentElement.clientHeight;
                const margin = 8;

                // 버튼 바로 아래, 오른쪽 정렬 + 뷰포트 경계 클램핑
                let left = rect.right - panelW;
                left = Math.max(margin, Math.min(left, viewportW - panelW - margin));

                let top = rect.bottom + 4;
                if (top + panelH + margin > viewportH && rect.top - panelH - 4 >= margin) {
                    top = rect.top - panelH - 4;
                }
                top = Math.max(margin, Math.min(top, viewportH - panelH - margin));

                // position:absolute → document 좌표 사용 (scrollX/Y 포함)
                settingsPanel.style.left = `${left + window.scrollX}px`;
                settingsPanel.style.top = `${top + window.scrollY}px`;
                settingsPanel.style.visibility = '';
                settingsBtn.classList.add('active');
            }
        }

        // 설정 패널 외부 클릭 시 닫기
        document.addEventListener('click', (e) => {
            if (!settingsPanel.contains(e.target) && !settingsBtn.contains(e.target)) {
                settingsPanel.style.display = 'none';
                settingsBtn.classList.remove('active');
            }
        });

        // ── 찾기/바꾸기 ──
        const findBtn = createToolbarBtn(
            '<i class="mdi mdi-magnify"></i>',
            '찾기 / 바꾸기 (Ctrl+F)',
            () => {
                if (findPanel.style.display === 'block') closeFindPanel();
                else openFindPanel();
            }
        );
        findBtn.id = 'cm-find-btn';
        toolbar.insertBefore(findBtn, modeBtn);

        const findPanel = document.createElement('div');
        findPanel.id = 'cm-find-panel';
        findPanel.className = 'cm-find-panel';
        findPanel.style.display = 'none';
        findPanel.innerHTML = `
            <div class="cm-find-row">
                <input type="text" id="cmFindInput" class="cm-find-input" placeholder="찾기" autocomplete="off" spellcheck="false">
                <span class="cm-find-status" id="cmFindStatus"></span>
                <button type="button" id="cmFindPrevBtn" class="cm-find-btn" title="이전 (Shift+Enter)"><i class="mdi mdi-chevron-up"></i></button>
                <button type="button" id="cmFindNextBtn" class="cm-find-btn" title="다음 (Enter)"><i class="mdi mdi-chevron-down"></i></button>
                <label class="cm-find-toggle" title="대소문자 구분">
                    <input type="checkbox" id="cmFindCaseSensitive">
                    <span>Aa</span>
                </label>
                <button type="button" id="cmFindCloseBtn" class="cm-find-btn cm-find-close" title="닫기 (Esc)"><i class="mdi mdi-close"></i></button>
            </div>
            <div class="cm-find-row">
                <input type="text" id="cmReplaceInput" class="cm-find-input" placeholder="바꾸기" autocomplete="off" spellcheck="false">
                <button type="button" id="cmReplaceOneBtn" class="cm-find-btn cm-find-btn-text" title="현재 일치 항목을 바꾸고 다음으로 이동">
                    <i class="mdi mdi-find-replace"></i> 바꾸기
                </button>
            </div>
        `;
        document.body.appendChild(findPanel);

        const findInput = findPanel.querySelector('#cmFindInput');
        const replaceInput = findPanel.querySelector('#cmReplaceInput');
        const findStatus = findPanel.querySelector('#cmFindStatus');
        const findPrevBtn = findPanel.querySelector('#cmFindPrevBtn');
        const findNextBtn = findPanel.querySelector('#cmFindNextBtn');
        const findCaseCheck = findPanel.querySelector('#cmFindCaseSensitive');
        const findCloseBtn = findPanel.querySelector('#cmFindCloseBtn');
        const replaceOneBtn = findPanel.querySelector('#cmReplaceOneBtn');

        const _findState = { matches: [], currentIdx: -1, query: '', caseSensitive: false };

        function _computeFindMatches() {
            const q = _findState.query;
            if (!q) return [];
            // SearchCursor는 원본 Text 트리 위에서 동작하므로 İ→i̇ 처럼 길이가 변하는
            // Unicode 케이스 매핑이 있어도 from/to 가 항상 원본 인덱스로 반환된다.
            // 단순 인덱싱(toLowerCase 후 indexOf) 방식은 그런 문자 뒤의 위치가 어긋난다.
            const doc = cmEditorView.state.doc;
            const normalize = _findState.caseSensitive ? undefined : (s) => s.toLowerCase();
            const cursor = new SearchCursor(doc, q, 0, doc.length, normalize);
            const out = [];
            while (!cursor.next().done) {
                out.push({ from: cursor.value.from, to: cursor.value.to });
                if (out.length > 5000) break;
            }
            return out;
        }

        function _rebuildFindDeco() {
            if (_findState.matches.length === 0) {
                cmEditorView.dispatch({ effects: setSearchMatchesEffect.of(Decoration.none) });
                return;
            }
            const builder = new RangeSetBuilder();
            _findState.matches.forEach((m, i) => {
                builder.add(m.from, m.to, i === _findState.currentIdx ? searchActiveDeco : searchMatchDeco);
            });
            cmEditorView.dispatch({ effects: setSearchMatchesEffect.of(builder.finish()) });
        }

        function _updateFindStatus() {
            if (!_findState.query) { findStatus.textContent = ''; return; }
            if (_findState.matches.length === 0) { findStatus.textContent = '0/0'; return; }
            findStatus.textContent = `${_findState.currentIdx + 1}/${_findState.matches.length}`;
        }

        function _scrollFindMatchIntoView() {
            const m = _findState.matches[_findState.currentIdx];
            if (!m) return;
            cmEditorView.dispatch({ effects: EditorView.scrollIntoView(m.from, { y: 'center' }) });
        }

        // scroll: true 면 활성 매치를 화면에 보이도록 스크롤. 사용자 입력에 의한 본문
        // 변경(_findFeatureOnDocChange)에서는 false 로 호출해야 한다 — 그렇지 않으면 입력
        // 위치와 무관하게 매번 활성 매치로 뷰포트가 점프해 다른 곳을 편집하기 힘들어진다.
        function _refreshFind(useCursorAnchor, scroll) {
            if (scroll === undefined) scroll = true;
            _findState.matches = _computeFindMatches();
            if (_findState.matches.length === 0) {
                _findState.currentIdx = -1;
            } else if (useCursorAnchor) {
                const cursor = cmEditorView.state.selection.main.from;
                let idx = _findState.matches.findIndex(m => m.from >= cursor);
                if (idx === -1) idx = 0;
                _findState.currentIdx = idx;
            } else {
                if (_findState.currentIdx < 0) _findState.currentIdx = 0;
                if (_findState.currentIdx >= _findState.matches.length) _findState.currentIdx = _findState.matches.length - 1;
            }
            _rebuildFindDeco();
            if (_findState.currentIdx >= 0 && scroll) _scrollFindMatchIntoView();
            _updateFindStatus();
        }

        function _gotoFindNext() {
            if (_findState.matches.length === 0) return;
            _findState.currentIdx = (_findState.currentIdx + 1) % _findState.matches.length;
            _rebuildFindDeco();
            _scrollFindMatchIntoView();
            _updateFindStatus();
        }
        function _gotoFindPrev() {
            if (_findState.matches.length === 0) return;
            _findState.currentIdx = (_findState.currentIdx - 1 + _findState.matches.length) % _findState.matches.length;
            _rebuildFindDeco();
            _scrollFindMatchIntoView();
            _updateFindStatus();
        }

        function _replaceCurrentAndAdvance() {
            if (_findState.matches.length === 0 || _findState.currentIdx < 0) return;
            const m = _findState.matches[_findState.currentIdx];
            const replacement = replaceInput.value;
            cmEditorView.dispatch({
                changes: { from: m.from, to: m.to, insert: replacement }
            });
            // 본문이 바뀌었으므로 매치 재계산. 치환된 위치 다음으로 이동.
            const after = m.from + replacement.length;
            _findState.matches = _computeFindMatches();
            if (_findState.matches.length === 0) {
                _findState.currentIdx = -1;
            } else {
                let idx = _findState.matches.findIndex(mm => mm.from >= after);
                if (idx === -1) idx = 0;
                _findState.currentIdx = idx;
            }
            _rebuildFindDeco();
            if (_findState.currentIdx >= 0) _scrollFindMatchIntoView();
            _updateFindStatus();
        }

        function _positionFindPanel() {
            const tb = document.getElementById('cm-toolbar');
            if (!tb) return;
            const rect = tb.getBoundingClientRect();
            const margin = 8;
            const panelW = findPanel.offsetWidth || 420;
            const panelH = findPanel.offsetHeight || 90;
            const viewportW = document.documentElement.clientWidth;
            const viewportH = document.documentElement.clientHeight;
            let left = rect.right - panelW - 4;
            left = Math.max(margin, Math.min(left, viewportW - panelW - margin));
            let top = rect.bottom + 4;
            if (top + panelH + margin > viewportH && rect.top - panelH - 4 >= margin) {
                top = rect.top - panelH - 4;
            }
            findPanel.style.left = `${left + window.scrollX}px`;
            findPanel.style.top = `${top + window.scrollY}px`;
        }

        function openFindPanel() {
            const wasHidden = findPanel.style.display !== 'block';
            findPanel.style.display = 'block';
            // 측정 후 위치 설정
            _positionFindPanel();
            findBtn.classList.add('active');
            if (wasHidden) {
                // 에디터에 줄바꿈 없는 선택이 있으면 그걸로 채움
                const sel = cmEditorView.state.selection.main;
                if (sel.from !== sel.to) {
                    const text = cmEditorView.state.sliceDoc(sel.from, sel.to);
                    if (text && !text.includes('\n')) {
                        findInput.value = text;
                    }
                }
                _findState.query = findInput.value;
                _findState.caseSensitive = findCaseCheck.checked;
                _refreshFind(true);
            }
            findInput.focus();
            findInput.select();
        }

        function closeFindPanel() {
            findPanel.style.display = 'none';
            findBtn.classList.remove('active');
            _findState.query = '';
            _findState.matches = [];
            _findState.currentIdx = -1;
            _rebuildFindDeco();
            _updateFindStatus();
            cmEditorView.focus();
        }

        findInput.addEventListener('input', () => {
            _findState.query = findInput.value;
            _refreshFind(true);
        });
        findCaseCheck.addEventListener('change', () => {
            _findState.caseSensitive = findCaseCheck.checked;
            _refreshFind(false);
        });
        findInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) _gotoFindPrev(); else _gotoFindNext();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeFindPanel();
            }
        });
        replaceInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                _replaceCurrentAndAdvance();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeFindPanel();
            }
        });
        findNextBtn.addEventListener('click', _gotoFindNext);
        findPrevBtn.addEventListener('click', _gotoFindPrev);
        replaceOneBtn.addEventListener('click', () => {
            _replaceCurrentAndAdvance();
            // 연속 클릭 시 포커스 유지
            replaceInput.focus();
        });
        findCloseBtn.addEventListener('click', closeFindPanel);

        // 외부에서 본문이 변경되면 매치 재계산. 사용자가 다른 곳을 편집 중일 때 활성
        // 매치로 자동 스크롤되면 뷰포트가 계속 점프하므로, 여기서는 스크롤하지 않는다
        // (스크롤은 next/prev/open/replace 등 명시적 네비게이션에서만 수행).
        _findFeatureOnDocChange = () => {
            if (findPanel.style.display !== 'block') return;
            if (!_findState.query) return;
            _refreshFind(false, false);
        };

        window.addEventListener('resize', () => {
            if (findPanel.style.display === 'block') _positionFindPanel();
        });

        // 브라우저 Ctrl+F (또는 macOS Cmd+F) 인터셉트
        window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
                if (!document.getElementById('cm-editor')) return;
                e.preventDefault();
                openFindPanel();
            }
        });

        // ── 줄 번호 토글 ──
        document.getElementById('settingLineNumbers').addEventListener('change', (e) => {
            editorSettings.showLineNumbers = e.target.checked;
            localStorage.setItem('editor_show_line_numbers', editorSettings.showLineNumbers);
            cmEditorView.dispatch({
                effects: lineNumbersCompartment.reconfigure(
                    editorSettings.showLineNumbers
                        ? [lineNumbers(), highlightActiveLineGutter()]
                        : []
                )
            });
        });

        // ── 스크롤 동기화 토글 ──
        document.getElementById('settingScrollSync').addEventListener('change', (e) => {
            editorSettings.scrollSync = e.target.checked;
            localStorage.setItem('editor_scroll_sync', editorSettings.scrollSync);
            // 체크박스 상태에 따라 모드 라디오 활성/비활성 토글
            settingsPanel.querySelectorAll('input[name="settingScrollSyncMode"]').forEach(r => {
                r.disabled = !editorSettings.scrollSync;
            });
            setScrollSync(editorSettings.scrollSync);
        });

        // ── 스크롤 동기화 방향 모드 ──
        settingsPanel.querySelectorAll('input[name="settingScrollSyncMode"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                if (!e.target.checked) return;
                editorSettings.scrollSyncMode = e.target.value === 'twoway' ? 'twoway' : 'oneway';
                localStorage.setItem('editor_scroll_sync_mode', editorSettings.scrollSyncMode);
                if (editorSettings.scrollSync) setScrollSync(true);
            });
        });

        // ── 문법 하이라이트 / 고급 편집 토글 ──
        function applySyntaxAndAdvancedExtensions() {
            cmEditorView.dispatch({
                effects: [
                    syntaxHighlightCompartment.reconfigure(buildSyntaxHighlightExts()),
                    advancedEditCompartment.reconfigure(buildAdvancedEditExts())
                ]
            });
        }

        const syntaxHighlightCheckbox = document.getElementById('settingSyntaxHighlight');
        const advancedEditCheckbox = document.getElementById('settingAdvancedEdit');

        syntaxHighlightCheckbox.addEventListener('change', (e) => {
            editorSettings.syntaxHighlight = e.target.checked;
            localStorage.setItem('editor_syntax_highlight', editorSettings.syntaxHighlight);
            // 하이라이트가 꺼지면 고급 편집도 자동으로 꺼짐
            if (!editorSettings.syntaxHighlight && editorSettings.advancedEdit) {
                editorSettings.advancedEdit = false;
                localStorage.setItem('editor_advanced_edit', 'false');
                advancedEditCheckbox.checked = false;
            }
            advancedEditCheckbox.disabled = !editorSettings.syntaxHighlight;
            applySyntaxAndAdvancedExtensions();
        });

        advancedEditCheckbox.addEventListener('change', (e) => {
            if (!editorSettings.syntaxHighlight) {
                e.target.checked = false;
                return;
            }
            editorSettings.advancedEdit = e.target.checked;
            localStorage.setItem('editor_advanced_edit', editorSettings.advancedEdit);
            applySyntaxAndAdvancedExtensions();
        });

        // ── 줄바꿈 모드 토글 ──
        settingsPanel.querySelectorAll('input[name="settingWrapMode"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                if (e.target.checked) {
                    editorSettings.wordWrap = (e.target.value === 'wrap');
                    localStorage.setItem('editor_word_wrap', editorSettings.wordWrap);
                    cmEditorView.dispatch({
                        effects: lineWrappingCompartment.reconfigure(
                            editorSettings.wordWrap ? EditorView.lineWrapping : []
                        )
                    });
                    const diffPreview = document.getElementById('diffPreviewContainer');
                    if (diffPreview) {
                        diffPreview.classList.toggle('wrap-mode', editorSettings.wordWrap);
                    }
                }
            });
        });

        // ── 편집 요약 자동 작성 토글 ──
        const autoSummaryCheckbox = document.getElementById('settingAutoSummary');
        if (autoSummaryCheckbox) {
            autoSummaryCheckbox.addEventListener('change', (e) => {
                editorSettings.autoSummary = e.target.checked;
                localStorage.setItem('editor_auto_summary', editorSettings.autoSummary);
                if (typeof refreshAutoSummary === 'function') refreshAutoSummary();
            });
        }

        // ── 스크롤 동기화 로직 ──
        let _scrollSyncHandler = null;        // 에디터 → 프리뷰
        let _previewScrollHandler = null;     // 프리뷰 → 에디터 (양방향 모드 한정)
        let _previewScrollTarget = null;
        let _previewLerpRAF = null;
        let _lerpLastSetScrollTop = null;
        let _editorScrollTarget = null;
        let _editorLerpRAF = null;
        let _lerpLastSetEditorScrollTop = null;

        function runPreviewLerp() {
            const customPreview = document.getElementById('custom-wiki-preview');
            if (!customPreview || _previewScrollTarget === null) {
                _previewLerpRAF = null;
                return;
            }
            // 우리가 마지막에 설정한 값과 현재 값이 다르면 사용자가 직접 스크롤한 것 → lerp 중단
            if (_lerpLastSetScrollTop !== null && Math.abs(customPreview.scrollTop - _lerpLastSetScrollTop) > 2) {
                _previewScrollTarget = null;
                _previewLerpRAF = null;
                _lerpLastSetScrollTop = null;
                return;
            }
            const current = customPreview.scrollTop;
            const diff = _previewScrollTarget - current;
            if (Math.abs(diff) < 0.5) {
                customPreview.scrollTop = _previewScrollTarget;
                _previewScrollTarget = null;
                _previewLerpRAF = null;
                _lerpLastSetScrollTop = null;
                return;
            }
            const newScrollTop = current + diff * 0.15;
            customPreview.scrollTop = newScrollTop;
            _lerpLastSetScrollTop = newScrollTop;
            _previewLerpRAF = requestAnimationFrame(runPreviewLerp);
        }

        function smoothScrollPreviewTo(targetTop) {
            _previewScrollTarget = Math.max(0, targetTop);
            _lerpLastSetScrollTop = null; // 새 lerp 시작 시 초기화
            if (!_previewLerpRAF) {
                _previewLerpRAF = requestAnimationFrame(runPreviewLerp);
            }
        }

        function runEditorLerp() {
            const scroller = window._cmView && window._cmView.scrollDOM;
            if (!scroller || _editorScrollTarget === null) {
                _editorLerpRAF = null;
                return;
            }
            if (_lerpLastSetEditorScrollTop !== null && Math.abs(scroller.scrollTop - _lerpLastSetEditorScrollTop) > 2) {
                _editorScrollTarget = null;
                _editorLerpRAF = null;
                _lerpLastSetEditorScrollTop = null;
                return;
            }
            const current = scroller.scrollTop;
            const diff = _editorScrollTarget - current;
            if (Math.abs(diff) < 0.5) {
                scroller.scrollTop = _editorScrollTarget;
                _editorScrollTarget = null;
                _editorLerpRAF = null;
                _lerpLastSetEditorScrollTop = null;
                return;
            }
            const newScrollTop = current + diff * 0.15;
            scroller.scrollTop = newScrollTop;
            _lerpLastSetEditorScrollTop = newScrollTop;
            _editorLerpRAF = requestAnimationFrame(runEditorLerp);
        }

        function smoothScrollEditorTo(targetTop) {
            _editorScrollTarget = Math.max(0, targetTop);
            _lerpLastSetEditorScrollTop = null;
            if (!_editorLerpRAF) {
                _editorLerpRAF = requestAnimationFrame(runEditorLerp);
            }
        }

        // 에디터 raw 마크다운에서 헤딩 라인 인덱스 목록을 추출.
        // - ATX 헤딩(`#`~`####`) + Setext 헤딩(`===`/`---`) 모두 인식
        // - 펜스 코드블록(백틱/틸드) 내부의 헤딩은 제외
        // - 반환: [{ lineIdx (0-based) }, ...] (등장 순서)
        // 프리뷰 측 `data-raw-line` 속성과 동일한 기준으로 산출되어야 한다.
        function _collectRawHeadingsFromDoc(docText) {
            const lines = docText.split('\n');
            const headings = [];
            let inFencedCode = false;
            let fenceChar = '';
            let fenceLen = 0;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];

                if (!inFencedCode) {
                    const fenceMatch = line.match(/^(`{3,}|~{3,})(.*)$/);
                    if (fenceMatch) {
                        const opener = fenceMatch[1];
                        const rest = fenceMatch[2];
                        const ch = opener[0];
                        // CommonMark: 백틱 펜스 오프너의 info string 에는 백틱이 들어갈 수 없다.
                        // 틸드 펜스는 info string 에 어떤 문자(틸드 포함)든 허용된다.
                        const isValidFence = ch !== '`' || !rest.includes('`');
                        if (isValidFence) {
                            inFencedCode = true;
                            fenceChar = ch;
                            fenceLen = opener.length;
                            continue;
                        }
                    }
                    if (/^#{1,4}[ \t]/.test(line)) {
                        headings.push({ lineIdx: i });
                        continue;
                    }
                    // Setext 헤딩 감지: 이전 줄이 문단 텍스트일 때만 인정.
                    // marked 의 Setext 인식 조건과 일치시켜 프리뷰의 헤딩 수와 어긋나지 않도록 한다.
                    if (i > 0) {
                        const underlineMatch = line.match(/^(=+|-+)\s*$/);
                        if (underlineMatch) {
                            const prev = lines[i - 1];
                            // 들여쓰기 코드 컨텍스트(앞에 빈 줄 또는 문서 시작이 있고 prev 가 4칸 이상
                            // 공백/탭으로 시작) 는 문단이 아니라 코드블록이므로 Setext 베이스가 될 수 없다.
                            // 들여쓰기 자체로만 판정하지 않고 직전 라인이 빈 줄/문서 시작인지 함께 보아
                            // 문단 lazy continuation(들여쓴 후속 라인) 케이스를 보존한다.
                            const isIndentedCodeBlockStart = /^(?: {4,}|\t)/.test(prev)
                                && (i - 2 < 0 || lines[i - 2].trim() === '');
                            const prevTrim = prev.trim();
                            const isParagraph = !isIndentedCodeBlockStart
                                && prevTrim !== ''
                                && !prevTrim.startsWith('#')
                                && !prevTrim.startsWith('>')
                                && !/^[-*_]{3,}\s*$/.test(prevTrim)
                                && !/^[-*+]\s+/.test(prevTrim)
                                && !/^\d+[.)]\s+/.test(prevTrim)
                                && !/^(`{3,}|~{3,})/.test(prevTrim);
                            if (isParagraph) {
                                headings.push({ lineIdx: i - 1 });
                            }
                        }
                    }
                } else {
                    const trimmed = line.trim();
                    if (trimmed[0] === fenceChar
                        && trimmed.replace(new RegExp('^' + fenceChar + '+'), '').trim() === ''
                        && trimmed.length >= fenceLen) {
                        inFencedCode = false;
                    }
                }
            }
            return headings;
        }

        // 프리뷰에서 raw 라인 인덱스에 대응하는 anchor 엘리먼트를 찾는다.
        // data-raw-line 부여 전 렌더본/수동 호출 등에 대비해 data-heading-idx 폴백을 둔다.
        function _findPreviewAnchorByRawLine(previewEl, rawLineIdx, fallbackIdx) {
            if (rawLineIdx != null) {
                const anchor = previewEl.querySelector(`[data-raw-line="${rawLineIdx}"]`);
                if (anchor) return anchor;
            }
            if (fallbackIdx != null && fallbackIdx >= 0) {
                return previewEl.querySelector(`[data-heading-idx="${fallbackIdx}"]`);
            }
            return null;
        }

        // 가이드포인트 캐시.
        // 헤딩 anchor 의 절대 scrollTop 위치는 프리뷰 콘텐츠가 변하지 않는 한 불변이므로,
        // 매 스크롤 이벤트마다 _collectRawHeadingsFromDoc / getBoundingClientRect 를 다시 돌리지 않는다.
        // 무효화 트리거: 프리뷰 재렌더, 윈도우 리사이즈, 스크롤 동기화 활성화.
        let _scrollSyncGuidesCache = null;
        function _invalidateScrollSyncGuides() {
            _scrollSyncGuidesCache = null;
        }
        // updateCustomPreview / 윈도우 리사이즈 등 동기화 함수 외부에서도 무효화할 수 있도록 노출
        window._invalidateScrollSyncGuides = _invalidateScrollSyncGuides;
        window.addEventListener('resize', _invalidateScrollSyncGuides, { passive: true });

        // 프리뷰 내부의 비동기 레이아웃 변동(이미지/임베드 지연 로드, 폰트 늦은 적용,
        // 익스텐션의 사후 DOM 변형 등)도 헤딩 오프셋을 흔들 수 있으므로 감지하여 캐시 무효화.
        // 매 스크롤 이벤트가 아니라 "레이아웃이 실제로 흔들렸을 때"만 캐시를 버린다.
        let _scrollSyncResizeObserver = null;
        function _observePreviewLayoutShifts() {
            const customPreview = document.getElementById('custom-wiki-preview');
            if (!customPreview) return;
            if (typeof ResizeObserver !== 'undefined') {
                if (!_scrollSyncResizeObserver) {
                    _scrollSyncResizeObserver = new ResizeObserver(_invalidateScrollSyncGuides);
                }
                _scrollSyncResizeObserver.disconnect();
                // 직접 자식 노드의 크기 변화를 본다 (이미지/임베드/익스텐션 캔버스 등)
                Array.from(customPreview.children).forEach(child => {
                    try { _scrollSyncResizeObserver.observe(child); } catch (_) { /* ignore */ }
                });
            }
            // 폰트 늦은 적용으로 인한 텍스트 metrics 재계산 한 번
            if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
                document.fonts.ready.then(_invalidateScrollSyncGuides).catch(() => {});
            }
        }
        window._observePreviewLayoutShifts = _observePreviewLayoutShifts;
        function _buildScrollSyncGuides() {
            const customPreview = document.getElementById('custom-wiki-preview');
            if (!customPreview || !window._cmView) return null;
            const view = window._cmView;
            const totalLines = view.state.doc.lines;
            const rawHeadings = _collectRawHeadingsFromDoc(view.state.doc.toString());
            const previewRect = customPreview.getBoundingClientRect();
            const previewScrollTop = customPreview.scrollTop;
            const maxScroll = Math.max(0, customPreview.scrollHeight - customPreview.clientHeight);

            const guides = [{ line: 0, targetTop: 0 }];
            for (let k = 0; k < rawHeadings.length; k++) {
                const anchor = _findPreviewAnchorByRawLine(customPreview, rawHeadings[k].lineIdx, k);
                if (!anchor) continue;
                const anchorRect = anchor.getBoundingClientRect();
                const t = previewScrollTop + (anchorRect.top - previewRect.top) - 10;
                guides.push({
                    line: rawHeadings[k].lineIdx,
                    targetTop: Math.min(maxScroll, Math.max(0, t))
                });
            }
            // refLine0 은 0..totalLines-1 범위라 끝 가이드 라인을 totalLines-1 로 맞춘다.
            // 단, 끝 라인이 마지막 가이드(시작 가이드 또는 마지막 헤딩) 의 라인보다
            // 더 크지 않으면 push 하지 않는다. (라인 동일 시 동일라인 가이드의 마지막 항목이
            // loIdx 로 선택되어 maxScroll 로 잘못 점프하는 회귀 방지)
            const endLine = Math.max(0, totalLines - 1);
            if (endLine > guides[guides.length - 1].line) {
                guides.push({ line: endLine, targetTop: maxScroll });
            }
            return guides;
        }

        function syncEditorScrollToPreview() {
            // 에디터 스크롤 영역 최상단 라인을 기준으로 프리뷰 scrollTop 을 결정한다.
            // (커서 위치는 사용하지 않음 — 휠/스크롤바 등 스크롤 위치 변화에만 반응)
            //
            // 헤딩 anchor 만 사용하던 섹션 단위 스크롤을 줄 단위로 세분화한다.
            // 헤딩들의 (raw 라인, 프리뷰 scrollTop) 쌍을 가이드포인트로 두고,
            // 현재 기준 라인이 두 가이드 사이에 있으면 라인 위치로 선형 보간하여
            // 프리뷰 scrollTop 을 결정한다. 결과적으로 에디터에서 한 줄 움직이면
            // 프리뷰도 비례해 한 줄만큼 따라간다.
            const customPreview = document.getElementById('custom-wiki-preview');
            if (!customPreview || !window._cmView) return;

            // 양방향 모드: 프리뷰 → 에디터 lerp 가 진행 중이면 에디터 스크롤은
            // 프로그램에 의한 것이므로 다시 프리뷰로 되돌리지 않는다.
            if (_editorScrollTarget !== null) return;

            const view = window._cmView;
            const scroller = view.scrollDOM;
            if (!scroller) return;

            // 에디터가 맨 아래까지 스크롤되면 프리뷰도 맨 아래로 (끝부분 오차 보정)
            if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) {
                smoothScrollPreviewTo(customPreview.scrollHeight);
                return;
            }

            const rect = scroller.getBoundingClientRect();
            let topPos = view.posAtCoords({ x: rect.left + 20, y: rect.top + 10 }, false);
            if (topPos === null) {
                if (!view.visibleRanges || !view.visibleRanges.length) return;
                topPos = view.visibleRanges[0].from;
            }
            const refLine0 = view.state.doc.lineAt(topPos).number - 1;

            // 가이드포인트: { line (0-indexed), targetTop (프리뷰 scrollTop) }
            // - 문서 시작(line=0) → 프리뷰 최상단
            // - 각 헤딩 → 해당 anchor 가 프리뷰 상단에 오는 scrollTop
            // - 문서 끝(line=totalLines-1) → 프리뷰 최하단
            // 캐시가 비어 있을 때만 재계산 (스크롤 이벤트마다 DOM 측정 회피).
            if (!_scrollSyncGuidesCache) {
                _scrollSyncGuidesCache = _buildScrollSyncGuides();
            }
            const guides = _scrollSyncGuidesCache;
            if (!guides || guides.length === 0) return;

            // refLine0 을 포함하는 가이드 구간 [lo, hi] 를 찾는다.
            // 같은 line 의 가이드가 여러 개면 더 뒤쪽(=헤딩 anchor)을 lo 로 선택해
            // 헤딩 위치 정확도를 유지한다.
            let loIdx = 0;
            for (let k = 0; k < guides.length; k++) {
                if (guides[k].line <= refLine0) loIdx = k;
                else break;
            }
            const lo = guides[loIdx];
            const hi = guides[Math.min(loIdx + 1, guides.length - 1)];

            const lineSpan = hi.line - lo.line;
            let targetTop;
            if (lineSpan <= 0) {
                targetTop = lo.targetTop;
            } else {
                const ratio = (refLine0 - lo.line) / lineSpan;
                targetTop = lo.targetTop + (hi.targetTop - lo.targetTop) * ratio;
            }
            smoothScrollPreviewTo(targetTop);
        }

        // 양방향 모드에서 사용: 프리뷰 스크롤 위치 → 에디터 스크롤 위치 동기화.
        // 가이드포인트의 (line, targetTop) 쌍을 역으로 보간하여 대응 라인을 얻고,
        // 그 라인의 픽셀 위치로 에디터 스크롤을 부드럽게 이동시킨다.
        function syncPreviewScrollToEditor() {
            const customPreview = document.getElementById('custom-wiki-preview');
            if (!customPreview || !window._cmView) return;

            // 에디터 → 프리뷰 lerp 가 진행 중이면 프리뷰 스크롤은 프로그램에 의한 것
            if (_previewScrollTarget !== null) return;

            const view = window._cmView;
            const scroller = view.scrollDOM;
            if (!scroller) return;

            // 프리뷰가 맨 아래까지 스크롤되면 에디터도 맨 아래로
            if (customPreview.scrollTop + customPreview.clientHeight >= customPreview.scrollHeight - 4) {
                smoothScrollEditorTo(scroller.scrollHeight);
                return;
            }

            if (!_scrollSyncGuidesCache) {
                _scrollSyncGuidesCache = _buildScrollSyncGuides();
            }
            const guides = _scrollSyncGuidesCache;
            if (!guides || guides.length === 0) return;

            const previewTop = customPreview.scrollTop;

            // previewTop 을 포함하는 가이드 구간 [lo, hi] 찾기 (targetTop 기준).
            // 가이드는 line 오름차순으로 만들어졌고 targetTop 도 단조 증가가 보장되지 않을 수
            // 있으나(설계상 헤딩 순서대로 늘어남), 안전하게 targetTop 을 기준으로 다시 찾는다.
            let loIdx = 0;
            for (let k = 0; k < guides.length; k++) {
                if (guides[k].targetTop <= previewTop) loIdx = k;
                else break;
            }
            const lo = guides[loIdx];
            const hi = guides[Math.min(loIdx + 1, guides.length - 1)];

            const topSpan = hi.targetTop - lo.targetTop;
            let refLine0;
            if (topSpan <= 0) {
                refLine0 = lo.line;
            } else {
                const ratio = (previewTop - lo.targetTop) / topSpan;
                refLine0 = lo.line + (hi.line - lo.line) * ratio;
            }

            // 라인 → 에디터 픽셀 위치 변환.
            // 1차: view.coordsAtPos 는 뷰포트 기준 좌표를 주므로 문서 좌표로 변환.
            // 2차(폴백): 대상 라인이 렌더된 뷰포트 밖이면 coordsAtPos 가 null 을 반환할 수
            //   있으므로, 문서 전체에 대해 유효한 view.lineBlockAt 으로 절대 top 을 얻는다.
            //   (lineBlockAt 의 top 은 문서 시작 기준 오프셋이라 그대로 scrollTop 에 사용 가능)
            const totalLines = view.state.doc.lines;
            const lineNum = Math.max(1, Math.min(totalLines, Math.round(refLine0) + 1));
            const linePos = view.state.doc.line(lineNum).from;
            let targetTop;
            const coords = view.coordsAtPos(linePos);
            if (coords) {
                const scrollerRect = scroller.getBoundingClientRect();
                targetTop = scroller.scrollTop + (coords.top - scrollerRect.top) - 10;
            } else {
                const block = view.lineBlockAt(linePos);
                if (!block) return;
                targetTop = block.top - 10;
            }
            smoothScrollEditorTo(targetTop);
        }

        function setScrollSync(enabled) {
            // 에디터 스크롤(뷰포트 최상단 라인)을 기준으로 프리뷰를 따라가게 한다.
            // 양방향(twoway) 모드에서는 프리뷰 스크롤 시 에디터도 따라간다.
            _scrollSyncEnabled = !!enabled;

            const scroller = cmEditorView && cmEditorView.scrollDOM;
            if (scroller && _scrollSyncHandler) {
                scroller.removeEventListener('scroll', _scrollSyncHandler);
                _scrollSyncHandler = null;
            }
            const customPreview = document.getElementById('custom-wiki-preview');
            if (customPreview && _previewScrollHandler) {
                customPreview.removeEventListener('scroll', _previewScrollHandler);
                _previewScrollHandler = null;
            }
            // 진행 중인 lerp RAF 가 있으면 즉시 취소하고 타깃 상태를 비운다.
            // (리스너만 떼면 이미 큐된 RAF 콜백이 한두 프레임 더 scrollTop 을 움직여
            //  사용자가 토글을 끈 직후에도 자동 스크롤이 잠깐 이어지는 문제 방지)
            if (_previewLerpRAF) {
                cancelAnimationFrame(_previewLerpRAF);
                _previewLerpRAF = null;
            }
            _previewScrollTarget = null;
            _lerpLastSetScrollTop = null;
            if (_editorLerpRAF) {
                cancelAnimationFrame(_editorLerpRAF);
                _editorLerpRAF = null;
            }
            _editorScrollTarget = null;
            _lerpLastSetEditorScrollTop = null;

            if (_scrollSyncEnabled && scroller) {
                _scrollSyncHandler = () => syncEditorScrollToPreview();
                scroller.addEventListener('scroll', _scrollSyncHandler, { passive: true });
                if (editorSettings.scrollSyncMode === 'twoway' && customPreview) {
                    _previewScrollHandler = () => syncPreviewScrollToEditor();
                    customPreview.addEventListener('scroll', _previewScrollHandler, { passive: true });
                }
                // 활성화 직후 가이드 캐시를 새로 만들고 현재 스크롤 위치에 맞춤
                _invalidateScrollSyncGuides();
                syncEditorScrollToPreview();
            }
        }

        // 초기 스크롤 동기화 설정 적용
        if (editorSettings.scrollSync) {
            setScrollSync(true);
        }

        // ── 아이콘 피커 모달 닫힘 후 아이콘 삽입 ──
        document.getElementById('iconPickerModal').addEventListener('hidden.bs.modal', () => {
            if (pendingIconInsertion && editor) {
                editor.focus();
                if (iconPickerSavedSelection) {
                    editor.setSelection(iconPickerSavedSelection[0], iconPickerSavedSelection[1]);
                }
                editor.insertText(pendingIconInsertion);
                pendingIconInsertion = null;
            }
        });


        // ── 붙여넣기 시 화면 스크롤 이동 방지 ──
        const editorEl = document.querySelector('#editor');
        if (editorEl) {
            editorEl.addEventListener('paste', () => {
                const currentScrollY = window.scrollY;
                const currentScrollX = window.scrollX;
                requestAnimationFrame(() => {
                    window.scrollTo(currentScrollX, currentScrollY);
                    setTimeout(() => window.scrollTo(currentScrollX, currentScrollY), 10);
                });
            }, true);
        }

        // ── 실시간 프리뷰 ──
        editor.on('change', () => {
            clearTimeout(previewDebounce);
            previewDebounce = setTimeout(async () => {
                await updateCustomPreview();
                // 프리뷰 재렌더 후 현재 에디터 스크롤 위치에 맞춰 동기화
                // (헤딩 추가/삭제 시 data-heading-idx 가 갱신된 후에 매칭되도록)
                if (_scrollSyncEnabled && typeof syncEditorScrollToPreview === 'function') {
                    syncEditorScrollToPreview();
                }
            }, 300);
        });
        let isInitialLoadScroll = true;
        setTimeout(async () => {
            await updateCustomPreview();
            if (isInitialLoadScroll) {
                scrollPreviewToBottom();
                isInitialLoadScroll = false;
            } else {
                // If it's not initial, we don't auto scroll preview
            }
        }, 300);

        // 테마 변경 시 에디터 실시간 업데이트
        const applyEditorTheme = () => {
            const newIsDarkMode = getIsDarkMode();
            if (newIsDarkMode === isDarkMode) return;
            isDarkMode = newIsDarkMode;

            const effects = [
                themeCompartment.reconfigure(isDarkMode ? oneDark : lightTheme),
                darkBgCompartment.reconfigure(buildDarkBgExt()),
                syntaxHighlightCompartment.reconfigure(buildSyntaxHighlightExts()),
            ];

            if (typeof advancedEditCompartment !== 'undefined') {
                effects.push(
                    advancedEditCompartment.reconfigure(
                        advancedEditCompartment.get(cmEditorView.state) || []
                    )
                );
            }

            cmEditorView.dispatch({ effects });
        };

        // data-theme 속성 변경 감지 (수동 테마 전환)
        new MutationObserver(applyEditorTheme).observe(
            document.documentElement,
            { attributes: true, attributeFilter: ['data-theme'] }
        );

        // OS 다크모드 변경 감지 (auto 모드 시)
        if (window.matchMedia) {
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyEditorTheme);
        }
    } // ── isExtensionData else 블록 종료 ──

    // 반응형 Preview Style 변경
    window.addEventListener('resize', () => {
        if (!editor) return;
        const isMobileNow = window.innerWidth <= 768;
        const targetStyle = isMobileNow ? 'tab' : 'vertical';
        editor.changePreviewStyle(targetStyle);
    });

    // 관리자면 Lock ui 노출
    if (currentUser.role === 'admin' || currentUser.role === 'super_admin') {
        document.getElementById('adminLockContainer').style.display = 'block';
    }

    // 관리자 전용 카테고리 목록 불러오기
    let adminCategories = [];
    try {
        const catRes = await fetch('/api/w/admin-categories');
        if (catRes.ok) {
            const catData = await catRes.json();
            adminCategories = catData.categories || [];
        }
    } catch (e) { }

    // 카테고리 입력 시 관리자 전용 여부 경고
    const catInput = document.getElementById('categoryInput');
    const catWarning = document.createElement('div');
    catWarning.className = 'text-danger small mt-1 d-none';
    catWarning.id = 'categoryWarning';
    catWarning.innerHTML = '<i class="mdi mdi-alert"></i> 이 카테고리는 관리자만 적용할 수 있습니다.';
    catInput.parentNode.appendChild(catWarning);

    catInput.addEventListener('input', () => {
        const isAdmin = currentUser.role === 'admin' || currentUser.role === 'super_admin';
        const cats = catInput.value.split(',').map(c => c.trim()).filter(c => c);
        const blockedCat = !isAdmin && cats.find(c => adminCategories.includes(c));
        if (blockedCat) {
            catWarning.innerHTML = `<i class="mdi mdi-alert"></i> "${blockedCat}" 카테고리는 관리자만 적용할 수 있습니다.`;
            catWarning.classList.remove('d-none');
        } else {
            catWarning.classList.add('d-none');
        }
        // 카테고리 추가/삭제 시 편집 요약 자동 갱신 (renderCategoryTags에서 input 이벤트가 디스패치된다)
        // 블로그 모드는 edit-summary.js 를 로드하지 않으므로 typeof 가드.
        if (typeof refreshAutoSummary === 'function') refreshAutoSummary();
    });

    // 관리자 전용(잠금) 토글 시 편집 요약 자동 갱신 (블로그 모드 미적용)
    const lockEl = document.getElementById('isLockedCheck');
    if (lockEl && typeof refreshAutoSummary === 'function') {
        lockEl.addEventListener('change', refreshAutoSummary);
    }

    // 넘겨주기(redirect) 변경 시 편집 요약 자동 갱신
    // input: 매 키 입력마다 디바운스로 갱신 (입력 중간 prefix 가 길어졌다 짧아졌다 반복하는 것 완화)
    // change: blur 직후 즉시 확정
    const redirectInputEl = document.getElementById('redirectInput');
    if (redirectInputEl) {
        let redirectDebounce = null;
        redirectInputEl.addEventListener('input', () => {
            clearTimeout(redirectDebounce);
            redirectDebounce = setTimeout(refreshAutoSummary, 300);
        });
        redirectInputEl.addEventListener('change', () => {
            clearTimeout(redirectDebounce);
            refreshAutoSummary();
        });
    }
    // 기존 문서 불러오기 (블로그 모드는 별도 처리)
    if (BLOG_MODE) {
        await loadBlogContentForEdit();
        return;
    }

    try {
        const res = await fetch(`/api/w/${encodeURIComponent(slug)}?redirect=no&nocache=true`);

        if (res.status === 410) {
            // 로딩 오버레이 먼저 숨김
            const overlay = document.getElementById('initLoadingOverlay');
            if (overlay) {
                overlay.classList.add('hidden');
                overlay.style.display = 'none';
            }
            Swal.fire({
                icon: 'error',
                title: '삭제된 문서',
                text: '삭제된 문서는 열람하거나 편집할 수 없습니다.',
                confirmButtonText: '홈으로'
            }).then(() => {
                window.location.href = '/';
            });
            return;
        }

        if (res.ok) {
            const page = await res.json();
            document.getElementById('titleInput').value = page.slug;

            // 섹션 모드에서는 서버가 보낸 메타데이터를 그대로 유지해 저장 시 함께 송신.
            // renderCategoryTags()가 input 이벤트를 디스패치해 자동 편집 요약을 갱신하기 전에
            // 베이스라인을 먼저 확정해야 카테고리 변경이 없는데도 '문서 생성'이 표시되는
            // 깜빡임을 방지할 수 있다.
            originalPageMeta = {
                slug: page.slug,
                category: page.category || '',
                redirect_to: page.redirect_to || '',
                is_locked: page.is_locked ? 1 : 0
            };

            if (page.category) {
                document.getElementById('categoryInput').value = page.category;
                categoryTags = page.category.split(',').map(c => c.trim()).filter(c => c);
                renderCategoryTags();
            }
            if (page.redirect_to) document.getElementById('redirectInput').value = page.redirect_to;
            if (page.is_locked) document.getElementById('isLockedCheck').checked = true;

            let initialContent = page.content || '';
            if (!isExtensionData) {
                if (!initialContent.endsWith('\n')) {
                    initialContent += '\n\n';
                } else if (!initialContent.endsWith('\n\n')) {
                    initialContent += '\n';
                }
            }

            // 섹션 편집 모드: 해당 섹션 텍스트만 에디터에 로드
            // (익스텐션 데이터 문서는 섹션 모드 비활성)
            let useSectionMode = false;
            if (sectionMode && !isExtensionData) {
                const range = findSectionRange(initialContent, sectionIndex, sectionHeadingParam);
                if (range) {
                    useSectionMode = true;
                    fullOriginalContent = initialContent;
                    sectionRange = range;
                    const lines = initialContent.split('\n');
                    const sectionText = lines.slice(range.lineIdx, range.endLine).join('\n');
                    originalContent = sectionText;
                    editor.setMarkdown(sectionText);
                    scrollPreviewToBottom();

                    // 섹션 모드 UI
                    const banner = document.getElementById('sectionEditBanner');
                    const headingEl = document.getElementById('sectionEditHeading');
                    const fullLink = document.getElementById('sectionEditFullLink');
                    if (banner && headingEl) {
                        headingEl.textContent = range.headingText;
                        banner.classList.remove('d-none');
                        banner.classList.add('d-flex');
                    }
                    if (fullLink) {
                        fullLink.href = '/edit?slug=' + encodeURIComponent(slug);
                    }
                    // 섹션 모드에서 수정 불가한 필드 숨김 (제목/카테고리/잠금/리다이렉트)
                    const lockedContainers = [
                        document.getElementById('titleInput'),
                        document.getElementById('categoryInput'),
                        document.getElementById('redirectInput')
                    ];
                    lockedContainers.forEach(el => {
                        if (el) {
                            const wrapper = el.closest('.mb-3') || el.closest('.row');
                            if (wrapper) wrapper.style.display = 'none';
                        }
                    });
                    const adminLockWrapper = document.getElementById('adminLockContainer');
                    if (adminLockWrapper) adminLockWrapper.style.display = 'none';
                } else {
                    // 섹션을 찾지 못하면 전체 편집으로 자동 fallback
                    sectionMode = false;
                    sectionIndex = -1;
                    DRAFT_KEY = 'wiki_draft_' + slug;
                    if (typeof Swal !== 'undefined') {
                        Swal.fire({
                            icon: 'warning',
                            title: '섹션을 찾지 못했습니다',
                            text: '문서 구조가 변경되어 전체 편집 모드로 전환합니다.',
                            timer: 2500,
                            showConfirmButton: false
                        });
                    }
                }
            }

            if (!useSectionMode) {
                originalContent = initialContent;
                editor.setMarkdown(initialContent);
                scrollPreviewToBottom();
            }

            pageVersion = page.version;
            document.getElementById('editPageTitle').innerHTML =
                useSectionMode
                    ? `<i class="mdi mdi-pencil-box-multiple"></i> 섹션 편집: ${escapeHtml(page.slug)}`
                    : `<i class="mdi mdi-pencil-box-multiple"></i> 편집: ${escapeHtml(page.slug)}`;
            document.title = `편집: ${page.slug} - ${appConfig.wikiName}`;
            document.getElementById('diffPreviewSection').style.display = 'block'; // 편집일 때만 노출
            // 전체 편집 모드일 때만 같은 슬러그의 섹션 초안 잔여분을 추가로 안내한다.
            // (섹션 모드에서는 checkDraft 가 자체 초안을 처리한다.)
            checkDraft().then(() => {
                if (!useSectionMode && typeof checkSectionDrafts === 'function') {
                    checkSectionDrafts();
                }
            });
            // 기존 문서: 카테고리/잠금 변경 시 자동 요약이 입력되도록 초기 상태 동기화
            refreshAutoSummary();
        } else {
            // 새 문서: 슬러그가 곧 제목이므로 readonly 필드를 슬러그로 채운다
            originalContent = '';
            document.getElementById('titleInput').value = decodeURIComponent(slug);
            document.getElementById('editPageTitle').innerHTML =
                `<i class="mdi mdi-plus-circle"></i> 새 문서 만들기`;
            document.title = `새 문서 - ${appConfig.wikiName}`;

            // 템플릿 불러오기 버튼 추가
            const templateBtn = document.createElement('button');
            templateBtn.className = 'btn btn-sm btn-outline-primary ms-3';
            templateBtn.innerHTML = '<i class="mdi mdi-content-copy"></i> 템플릿으로 시작하기';
            templateBtn.onclick = openTemplateModal;
            document.getElementById('editPageTitle').appendChild(templateBtn);
            checkDraft();
            // 새 문서: 편집 요약을 '문서 생성'으로 자동 채움
            refreshAutoSummary();
        }
    } catch (e) {
        // 새 문서로 취급
        originalContent = '';
        refreshAutoSummary();
    }

    // 변경 사항 미리보기 이벤트 연동
    const diffDetails = document.getElementById('diffPreviewDetails');
    if (diffDetails) {
        diffDetails.addEventListener('toggle', (e) => {
            if (diffDetails.open) {
                renderLocalDiff();
            }
        });

        // 펼쳐진 상태에서 에디터 변경 시 실시간 재렌더 (디바운스)
        let diffPreviewDebounce = null;
        if (editor && typeof editor.on === 'function') {
            editor.on('change', () => {
                if (!diffDetails.open) return;
                clearTimeout(diffPreviewDebounce);
                diffPreviewDebounce = setTimeout(() => {
                    if (diffDetails.open) renderLocalDiff();
                }, 300);
            });
        }
    }

    // 본문 헤딩(목차) 변화 실시간 감지 → 자동 편집 요약 갱신.
    // 별도 디바운스로 미리보기/diff 와 독립 동작하며, 헤딩 추가/삭제/이름변경 시
    // refreshAutoSummary 가 새 prefix 를 합성한다.
    if (editor && typeof editor.on === 'function') {
        let summaryDebounce = null;
        editor.on('change', () => {
            clearTimeout(summaryDebounce);
            summaryDebounce = setTimeout(() => {
                if (typeof refreshAutoSummary === 'function') refreshAutoSummary();
            }, 400);
        });
    }

    // 동시편집 감지: 하트비트 전송 + 편집자 체크 시작
    startEditingHeartbeat();
    checkConcurrentEditors();

    // 미저장 변경사항 이탈 경고
    window.addEventListener('beforeunload', (e) => {
        if (pageLeft || !editor) return;
        if (editor.getMarkdown() !== originalContent) {
            e.preventDefault();
            e.returnValue = '';
        }
    });

    // Ctrl/Cmd+S 단축키로 저장 (브라우저 기본 저장 다이얼로그 차단)
    window.addEventListener('keydown', (e) => {
        const isSaveShortcutKey = e.code === 'KeyS' || e.key?.toLowerCase() === 's';
        if (!isSaveShortcutKey || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
        e.preventDefault();
        // 충돌 해결 UI 표시 중에는 저장을 트리거하지 않는다 — 병합 전 본문이
        // 새 pageVersion 으로 그대로 제출되는 것을 방지한다.
        const conflictUi = document.getElementById('conflict-ui');
        if (conflictUi && conflictUi.offsetParent !== null) return;
        if (appConfig && appConfig.turnstileSiteKey && !turnstileToken) {
            Swal.fire({
                icon: 'warning',
                title: 'Turnstile 미완료',
                text: 'Turnstile 검증이 완료된 뒤 저장할 수 있습니다.',
                toast: true,
                position: 'top-end',
                timer: 2000,
                showConfirmButton: false,
            });
            return;
        }
        const saveBtn = document.getElementById('saveBtn');
        if (e.repeat || saveInProgress || saveBtn?.disabled) return;
        savePage();
    }, true);

    // 로딩 오버레이 숨기기
    const overlay = document.getElementById('initLoadingOverlay');
    if (overlay) {
        overlay.classList.add('hidden');
        // 트랜지션 완료 후 DOM에서 완전히 숨김 처리
        setTimeout(() => {
            overlay.style.display = 'none';
        }, 300);
    }
});

// 자동 편집 요약(buildAutoEditSummary / refreshAutoSummary)은 edit-summary.js 로 분리됨.

// ── 변경 사항 검증 (프론트 전용) ──
// 본문이 바뀌지 않았어도 카테고리/리다이렉트/관리자 잠금이 변경되었다면 저장을 허용한다.
// 신규 문서(originalPageMeta 미설정)에서는 기본값(빈 카테고리/리다이렉트, 잠금 해제) 대비
// 메타데이터 입력 여부로 판단 — 본문 없이 리다이렉트만 설정해 새 문서를 만드는 용례 지원.
function hasMeaningfulChanges() {
    const currentContent = editor ? editor.getMarkdown() : '';

    // 섹션 모드: 제목/카테고리/잠금/리다이렉트를 수정할 수 없으므로 본문(섹션 텍스트) 비교만 유효.
    if (sectionMode) {
        return currentContent !== originalContent;
    }

    if (currentContent !== originalContent) return true;

    // 신규 문서(originalPageMeta === null)는 빈 메타데이터를 기준선으로 사용한다.
    const baseMeta = originalPageMeta || { category: '', redirect_to: '', is_locked: 0 };

    const origCats = baseMeta.category
        ? baseMeta.category.split(',').map(c => c.trim()).filter(Boolean).sort()
        : [];
    const currCats = Array.isArray(categoryTags)
        ? categoryTags.slice().map(c => String(c).trim()).filter(Boolean).sort()
        : [];
    if (origCats.join('\u0000') !== currCats.join('\u0000')) return true;

    const origRedirect = baseMeta.redirect_to || '';
    const redirectEl = document.getElementById('redirectInput');
    const currRedirect = redirectEl ? redirectEl.value.trim() : '';
    if (origRedirect !== currRedirect) return true;

    const origLocked = baseMeta.is_locked ? 1 : 0;
    const lockEl = document.getElementById('isLockedCheck');
    const currLocked = lockEl && lockEl.checked ? 1 : 0;
    if (origLocked !== currLocked) return true;

    return false;
}

// ── 저장 ──
async function savePage() {
    if (BLOG_MODE) {
        await saveBlogPost();
        return;
    }
    // 섹션 모드에서는 카테고리/잠금/리다이렉트는 서버 값 유지
    // (slug = 제목은 URL 파라미터가 곧 식별자이자 표시 이름이므로 별도 입력 불필요)
    const category = sectionMode && originalPageMeta
        ? (originalPageMeta.category || '')
        : document.getElementById('categoryInput').value.trim();
    const redirect_to = sectionMode && originalPageMeta
        ? (originalPageMeta.redirect_to || '')
        : document.getElementById('redirectInput').value.trim();
    const is_locked = sectionMode && originalPageMeta
        ? (originalPageMeta.is_locked ? 1 : 0)
        : (document.getElementById('isLockedCheck').checked ? 1 : 0);

    // 섹션 모드: 에디터 내용(= 섹션 텍스트)을 원본에 재주입한 전체 본문을 전송
    let content;
    if (sectionMode && sectionRange) {
        content = mergeSectionIntoFull(fullOriginalContent, sectionRange, editor.getMarkdown());
    } else {
        content = editor.getMarkdown();
    }
    // 디바운스로 대기 중인 자동 요약(특히 넘겨주기 input)을 즉시 반영해야
    // Ctrl/Cmd+S 단축키로 저장할 때 최신 변경이 누락되지 않는다.
    if (typeof refreshAutoSummary === 'function') refreshAutoSummary();
    const userSummary = document.getElementById('summaryInput').value.trim();

    // 본문/메타데이터 변경이 전혀 없으면 저장 거부 (프론트 전용 검증).
    // 카테고리, 관리자 전용 잠금, 리다이렉트 중 하나라도 바뀌었다면 본문 변경이 없어도 저장 허용.
    if (!hasMeaningfulChanges()) {
        Swal.fire({
            icon: 'info',
            title: '변경된 내용이 없습니다',
            text: '본문을 편집하거나 카테고리, 리다이렉트 설정을 변경해주세요.',
        });
        return;
    }

    if (category && !/^[가-힣a-zA-Z0-9\s,]+$/.test(category)) {
        Swal.fire('오류', '카테고리에는 특수문자를 사용할 수 없습니다.', 'warning');
        return;
    }
    if (userSummary && userSummary.length > 255) {
        Swal.fire('오류', '편집 요약은 최대 255자까지 입력할 수 있습니다.', 'warning');
        return;
    }

    // 자동 요약(신규 문서/카테고리/잠금 변경/섹션 편집)은 페이지 로드·필드 변경 시
    // 입력 칸에 이미 채워져 있으므로 별도 결합 없이 그대로 사용한다.
    let summary = userSummary;
    if (summary.length > 255) summary = summary.slice(0, 255);

    if (appConfig.turnstileSiteKey && !turnstileToken) {
        Swal.fire('오류', 'Turnstile 검증을 완료해주세요.', 'warning');
        return;
    }

    const saveBtn = document.getElementById('saveBtn');
    if (saveInProgress) return;
    saveInProgress = true;
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 저장 중...';

    let isSuccess = false;
    // 재저장 차단 플래그 — 섹션 모드 409 복구 중 메타데이터 재조회 실패 시 설정한다.
    // originalPageMeta 가 스테일한 상태에서 새로운 expected_version 으로 저장하면
    // 다른 편집자의 카테고리/리다이렉트/잠금 변경을 조용히 덮어쓸 수 있으므로,
    // finally 블록에서 저장 버튼을 다시 활성화하지 않도록 한다. 사용자는 새로고침이 필요.
    let blockResave = false;

    try {
        const body = {
            content,
            category: category || undefined,
            redirect_to: redirect_to || undefined,
            is_locked,
            summary: summary || undefined,
            turnstileToken,
        };

        if (pageVersion !== null) {
            body.expected_version = pageVersion;
        }

        const res = await fetch(`/api/w/${encodeURIComponent(slug)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (res.status === 409) {
            const data = await res.json();

            // 섹션 모드에서 충돌 발생 시: 두 가지 시나리오를 구분한다.
            // 1. 동일 섹션 동시 편집(sameSectionChangedByOther): 서버의 해당 섹션 내용이
            //    사용자 베이스(originalContent)와 다른 경우 → 전체 편집 모드로 전환 후 충돌 UI 표시.
            // 2. 섹션 경계 변경(boundary-only): 서버에서 해당 섹션을 찾을 수 있고 내용도
            //    동일하지만 문서 구조가 바뀐 경우 → 서버 최신 본문에 섹션 편집을 합성해
            //    전체 편집 모드로 전환 후 재저장을 허용한다(충돌 UI 불필요).
            if (sectionMode && sectionRange) {
                // 409 응답의 data.content 에서 해당 섹션을 탐색해 동시 편집 여부를 판별
                let sameSectionChangedByOther = false;
                let serverRange = null;
                // data.content 는 항상 문자열이지만 빈 문자열일 수 있다(다른 사용자가 문서 전체를
                // 비운 경우). 이전에는 if (data.content) 로 truthy 체크를 해 빈 본문이 들어오면
                // 섹션 탐지 자체를 스킵 → sameSectionChangedByOther 가 false 로 남고 boundary-only
                // 경로의 if (... && data.content) 도 false 가 되어 어떤 충돌 안내도 없이 사용자가
                // 재저장하면 다른 편집자의 전체 삭제를 silent overwrite 하던 회귀가 있었다.
                // 빈 본문은 곧 우리가 편집 중인 섹션도 사라졌음을 의미하므로 동시 편집으로 간주.
                const serverContentStr = typeof data.content === 'string' ? data.content : '';
                if (serverContentStr === '') {
                    sameSectionChangedByOther = true;
                } else {
                    serverRange = findSectionRange(serverContentStr, sectionIndex, sectionRange.headingText);
                    if (serverRange) {
                        const serverLines = serverContentStr.split('\n');
                        const newServerSection = serverLines.slice(serverRange.lineIdx, serverRange.endLine).join('\n');
                        // 서버의 섹션 내용이 사용자 베이스와 다르면 동시 편집으로 판단.
                        // trim() 으로 공백 차이를 무시하면 안 된다 — 다른 편집자가 같은 섹션의
                        // 선/후행 공백만 바꾼 경우(예: 마크다운 hard line break "foo  \n",
                        // 의도된 빈 줄)도 실제 동시 편집이며 silent overwrite 대상이 된다.
                        // _extractMarkdownSectionRanges 가 이미 섹션 끝의 빈 줄을 endLine 에서
                        // 제외하므로 양쪽 모두 결정론적이고, 정확 비교가 false positive 를 만들지
                        // 않는다.
                        if (newServerSection !== originalContent) {
                            sameSectionChangedByOther = true;
                        }
                    } else {
                        // 섹션 자체가 사라진 경우(다른 사용자가 헤딩을 삭제하는 등) →
                        // 동시 편집으로 간주하고 충돌 UI 를 표시해 사용자가 직접 병합하게 한다.
                        sameSectionChangedByOther = true;
                    }
                }

                // 409 응답에는 메타데이터가 없으므로 최신 제목/카테고리/잠금/리다이렉트를
                // 다시 받아와 입력 필드와 originalPageMeta 를 갱신한다. 갱신에 실패하면
                // 스테일 메타데이터로 다른 편집자 변경을 덮어쓸 위험이 있어 재저장을
                // 차단하고 새로고침을 유도한다.
                let freshPageForFallback = null;
                try {
                    const metaRes = await fetch(`/api/w/${encodeURIComponent(slug)}?redirect=no&nocache=true`);
                    if (metaRes.ok) {
                        freshPageForFallback = await metaRes.json();
                    }
                } catch (e) { /* freshPageForFallback 유지 */ }

                if (!freshPageForFallback) {
                    // 메타 재조회 실패 → 재저장 차단(finally 에서 버튼 재활성화 금지)
                    // 사용자는 페이지 새로고침 후 다시 편집해야 함.
                    blockResave = true;
                    await Swal.fire({
                        icon: 'error',
                        title: '문서 정보를 다시 가져오지 못했습니다',
                        text: '다른 사용자의 변경을 덮어쓸 수 있어 저장을 중단합니다. 페이지를 새로고침 해주세요.',
                    });
                    return;
                }

                await Swal.fire({
                    icon: 'warning',
                    title: '편집 충돌이 발생했습니다',
                    text: sameSectionChangedByOther
                        ? '같은 섹션을 다른 사용자가 동시에 편집했습니다. 전체 편집 모드에서 충돌 내용을 확인해 주세요.'
                        : '다른 사용자가 문서 구조를 변경했습니다. 전체 편집 모드로 전환합니다.',
                });

                // 편집하던 섹션 텍스트를 전체 본문에 합성.
                // - 동시 편집: fullOriginalContent 기준으로 합성(3-way diff base 로 사용)
                // - 경계 변경: data.content(서버 최신) 의 새 섹션 위치에 합성해 구조 변경을 보존.
                //   논리적 보장: serverRange 가 null 이면 위에서 sameSectionChangedByOther = true 로
                //   설정되므로, !sameSectionChangedByOther 가 참이면 serverRange 는 반드시 non-null.
                let mergedBase;
                let mergedLocal;
                if (!sameSectionChangedByOther && serverRange && data.content) {
                    mergedBase = data.content;
                    mergedLocal = mergeSectionIntoFull(data.content, serverRange, editor.getMarkdown());
                } else {
                    mergedBase = fullOriginalContent;
                    mergedLocal = mergeSectionIntoFull(fullOriginalContent, sectionRange, editor.getMarkdown());
                }
                editor.setMarkdown(mergedLocal);
                // 충돌 모달은 originalContent 를 base 로 사용하므로 섹션 텍스트 조각이 아닌
                // 전체 본문 기준으로 갱신한다.
                originalContent = mergedBase;
                sectionMode = false;
                sectionRange = null;
                DRAFT_KEY = 'wiki_draft_' + slug;
                const resolvedTitle = slug;
                const editPageTitle = document.getElementById('editPageTitle');
                if (editPageTitle) {
                    editPageTitle.textContent = '문서 편집: ' + resolvedTitle;
                }
                document.title = '문서 편집: ' + resolvedTitle;
                const banner = document.getElementById('sectionEditBanner');
                if (banner) { banner.classList.add('d-none'); banner.classList.remove('d-flex'); }
                // 숨겼던 필드 복원
                const fallbackLockedFields = [
                    document.getElementById('titleInput'),
                    document.getElementById('categoryInput'),
                    document.getElementById('redirectInput')
                ];
                fallbackLockedFields.forEach(el => {
                    if (el) {
                        const wrapper = el.closest('.mb-3') || el.closest('.row');
                        if (wrapper) wrapper.style.display = '';
                    }
                });
                // 섹션 모드 진입 시 adminLockContainer 도 숨겼으므로(관리자 잠금 컨트롤) 반드시 복원.
                // 누락 시 관리자가 전체 편집 모드로 전환된 뒤에도 잠금 상태를 변경/확인할 수 없음.
                // 단, 관리자 전용 UI 이므로 원래 가시성 조건(role 검사)을 다시 적용한다 —
                // 일반 사용자에게는 보여선 안 됨.
                const adminLockWrapper = document.getElementById('adminLockContainer');
                if (adminLockWrapper) {
                    const isAdminUser = currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin');
                    adminLockWrapper.style.display = isAdminUser ? 'block' : 'none';
                }

                // 메타데이터 입력 필드를 서버 최신값으로 갱신 — 재시도 시 스테일 값 송신 방지
                const titleEl = document.getElementById('titleInput');
                const categoryEl = document.getElementById('categoryInput');
                const redirectEl = document.getElementById('redirectInput');
                const lockedEl = document.getElementById('isLockedCheck');
                if (titleEl) titleEl.value = freshPageForFallback.slug || slug;
                const freshCategory = freshPageForFallback.category || '';
                if (categoryEl) categoryEl.value = freshCategory;
                categoryTags = freshCategory ? freshCategory.split(',').map(c => c.trim()).filter(c => c) : [];
                if (typeof renderCategoryTags === 'function') renderCategoryTags();
                if (redirectEl) redirectEl.value = freshPageForFallback.redirect_to || '';
                if (lockedEl) lockedEl.checked = !!freshPageForFallback.is_locked;
                // originalPageMeta 도 일관성 유지 (sectionMode 는 false 가 되었지만 방어적으로 갱신)
                originalPageMeta = {
                    slug: freshPageForFallback.slug,
                    category: freshPageForFallback.category || '',
                    redirect_to: freshPageForFallback.redirect_to || '',
                    is_locked: freshPageForFallback.is_locked ? 1 : 0
                };
                // 새 베이스라인이 적용되었으므로 자동 요약을 재계산해 입력 칸을 동기화
                if (typeof refreshAutoSummary === 'function') refreshAutoSummary();
                // pageVersion 을 최신값으로 갱신
                pageVersion = data.current_version;

                if (sameSectionChangedByOther) {
                    // 동시 편집: 서버의 최신 전체 본문을 기준으로 충돌 UI 표시
                    showConflictModal({ current_version: data.current_version, content: data.content });
                }
                // 경계 변경: 충돌 UI 없이 전체 편집 모드로 전환 완료 → 사용자가 재저장 가능
                saveBtn.innerHTML = '<i class="mdi mdi-check"></i> 저장';
                return;
            }

            // 버전 충돌 (Optimistic Locking Failure) — 일반 편집
            showConflictModal(data);

            saveBtn.innerHTML = '<i class="mdi mdi-check"></i> 저장';
            return;
        }

        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || '저장 실패');
        }

        if (DRAFT_KEY) localStorage.removeItem(DRAFT_KEY);

        isSuccess = true;
        // 섹션 모드: originalContent 는 섹션 텍스트 기준이어야 beforeunload 경고가 정상 동작
        originalContent = sectionMode ? editor.getMarkdown() : content;
        // 섹션 편집 완료 시 해당 섹션의 열람 페이지 앵커로 복귀하여 같은 위치로 스크롤한다.
        // 열람 페이지의 s-X.Y 앵커는 resolveTransclusions 이후의 헤딩 순서를 기준으로
        // 생성되므로, 틀(transclusion)이 포함된 문서에서도 올바른 번호를 구하기 위해
        // 저장된 전체 본문을 먼저 트랜스클루전 전개한 뒤 섹션 번호를 계산한다.
        let redirectHash = '';
        if (sectionMode) {
            try {
                const resolvedContent = typeof resolveTransclusions === 'function'
                    ? await resolveTransclusions(content, slug)
                    : content;
                const sectionNum = computeSectionNumber(
                    resolvedContent,
                    sectionIndex,
                    sectionRange ? sectionRange.headingText : ''
                );
                if (sectionNum) redirectHash = `#s-${sectionNum}`;
            } catch (e) { /* 앵커 계산 실패 시 최상단으로 이동 */ }
        }
        Swal.fire({
            icon: 'success',
            title: '저장 완료!',
            text: '문서가 성공적으로 저장되었습니다.',
            timer: 1500,
            showConfirmButton: false,
        }).then(() => {
            window.location.href = `/w/${encodeURIComponent(slug)}${redirectHash}`;
        });

    } catch (err) {
        Swal.fire('오류', err.message, 'error');
    } finally {
        saveInProgress = false;
        // blockResave 가 true 이면 재저장으로 인한 덮어쓰기 위험이 있으므로 버튼을 비활성 상태로 유지.
        if (!isSuccess && !blockResave) {
            saveBtn.innerHTML = '<i class="mdi mdi-check"></i> 저장';
            if (turnstileWidgetId !== null) {
                refreshTurnstile();
            } else {
                saveBtn.disabled = false;
            }
        }
    }
}

// ── 취소 ──
async function cancelEdit() {
    // 섹션 편집을 취소할 때도 사용자가 보고 있던 섹션 위치로 복귀한다.
    // 열람 페이지의 s-X.Y 앵커는 resolveTransclusions 이후 헤딩 기준이므로
    // 원본 본문도 트랜스클루전 전개 후 섹션 번호를 계산한다.
    const buildReturnUrl = async () => {
        if (!slug) return '/';
        let hash = '';
        if (sectionMode && fullOriginalContent) {
            try {
                const resolvedContent = typeof resolveTransclusions === 'function'
                    ? await resolveTransclusions(fullOriginalContent, slug)
                    : fullOriginalContent;
                const sectionNum = computeSectionNumber(
                    resolvedContent,
                    sectionIndex,
                    sectionRange ? sectionRange.headingText : ''
                );
                if (sectionNum) hash = `#s-${sectionNum}`;
            } catch (e) { /* 앵커 계산 실패 시 최상단으로 이동 */ }
        }
        return `/w/${encodeURIComponent(slug)}${hash}`;
    };

    if (editor && editor.getMarkdown().trim()) {
        // 내용 변경 여부 확인
        const result = await Swal.fire({
            title: '편집을 취소하시겠습니까?',
            text: '저장하지 않은 변경사항이 사라집니다.',
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: '나가기',
            cancelButtonText: '계속 편집',
        });
        if (result.isConfirmed) {
            pageLeft = true;
            window.location.href = await buildReturnUrl();
        }
    } else {
        pageLeft = true;
        window.location.href = await buildReturnUrl();
    }
}

// ── 블로그 내용 로드 (DOMContentLoaded 에서 에디터 초기화 완료 후 호출) ──
async function loadBlogContentForEdit() {
    const titleInput = document.getElementById('blogTitleInput');

    if (blogPostId) {
        try {
            const res = await fetch(`/api/blog/${blogPostId}`);
            if (!res.ok) throw new Error('포스트를 찾을 수 없습니다.');
            const post = await res.json();
            if (titleInput) titleInput.value = post.title || '';
            if (editor) editor.setMarkdown(post.content || '');
            originalContent = post.content || '';
        } catch (e) {
            Swal.fire('오류', e.message, 'error').then(() => {
                window.location.href = '/blog';
            });
            return;
        }
    } else {
        if (editor) editor.setMarkdown('');
        originalContent = '';
    }

    const overlay = document.getElementById('initLoadingOverlay');
    if (overlay) {
        overlay.classList.add('hidden');
        overlay.style.display = 'none';
    }

    const saveBtn = document.getElementById('saveBtn');
    if (saveBtn && !appConfig?.turnstileSiteKey) saveBtn.disabled = false;
}

// ── 블로그 저장 ──
async function saveBlogPost() {
    const titleInput = document.getElementById('blogTitleInput');
    const title = titleInput ? titleInput.value.trim() : '';
    if (!title) {
        Swal.fire('오류', '제목을 입력해주세요.', 'warning');
        return;
    }

    const content = editor ? editor.getMarkdown() : '';

    const saveBtn = document.getElementById('saveBtn');
    if (saveInProgress) return;
    saveInProgress = true;
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 저장 중...';

    try {
        const url = blogPostId ? `/api/blog/${blogPostId}` : '/api/blog';
        const method = blogPostId ? 'PUT' : 'POST';
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, content }),
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || '저장 실패');
        }

        const data = await res.json();
        const savedId = blogPostId || data.id;

        if (DRAFT_KEY) localStorage.removeItem(DRAFT_KEY);

        Swal.fire({
            icon: 'success',
            title: '저장 완료!',
            text: '블로그 포스트가 저장되었습니다.',
            timer: 1500,
            showConfirmButton: false,
        }).then(() => {
            window.location.href = `/blog/${savedId}`;
        });
    } catch (err) {
        Swal.fire('오류', err.message, 'error');
        saveInProgress = false;
        saveBtn.innerHTML = '<i class="mdi mdi-check"></i> 저장';
        saveBtn.disabled = false;
    }
}
