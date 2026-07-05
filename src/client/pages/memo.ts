/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 개방 메모장(/memo) 진입점 — 문서 편집기(edit/main.ts)의 편집 경험을 그대로 이식하되
 * autocomplete 만 제외한 경량 오케스트레이터.
 *
 * 권한·로그인 없이 누구나 위키 문법을 작성하고 실시간 프리뷰로 확인할 수 있다.
 * 일반 문서 편집과 달리:
 *   - 서버에 저장되지 않으며 어떤 문서에도 적용되지 않는다. 본문은 브라우저
 *     localStorage(`cloudwiki_memo`) 에만 보관되어 새로고침/재방문 시 복원된다.
 *   - 인증/Turnstile/카테고리/리다이렉트/편집 요약/저장(PUT)·섹션·충돌 해결·자동 요약이 없다.
 *   - **자동완성(edit-autocomplete) 은 의도적으로 로드하지 않는다**(요청 사양).
 *
 * 재사용 전략(분기 사본 최소화):
 *   - CodeMirror6 빌딩 블록·공유 툴바·레이아웃: edit/cm-shared.ts
 *   - 위키 문법 인라인 하이라이트 플러그인: edit/cm-highlight.ts (문서 편집기와 단일 소스)
 *   - 툴바 모달(아이콘/타임스탬프/카드/구조/팔레트/배지/지도/특수문자/CSV/표 삽입),
 *     인라인 표 편집 툴바, 이미지 업로드·편집·검색, 색 변환·카운터 헬퍼:
 *     memo.astro 가 문서 편집과 동일한 edit-modals/edit-table-toolbar/edit-image/edit-utils
 *     번들을 로드해 window.* 로 노출 → 여기서는 그 심(window.editor/_cmView)만 제공해 연결.
 *   - 본문 렌더링: render.js 의 window.renderWikiContent (+ edit/preview-state.ts 의 스냅샷/복원).
 *
 * CM6 모듈은 main.ts 와 동일하게 런타임 동적 import(esm.sh importmap, vite external) 로 받으며,
 * CDN 이 unreachable 이면 textarea 폴백으로 최소 편집·저장·프리뷰를 유지한다.
 */
import {
    makeMarkdownHighlightStyles,
    makeLightTheme,
    makeDarkBgTheme,
    createToolbarBtn,
    buildEditorLayoutHTML,
    buildSharedToolbar,
    setupTabSwitcher,
} from '../edit/cm-shared';
import { buildWikiHighlightPlugins } from '../edit/cm-highlight';
import { snapshotPreviewState, restorePreviewState } from '../edit/preview-state';

const w = window as any;

// 본문 보관 키 — 문서 슬러그가 없는 단일 메모장이라 전역 고정 키 1개를 쓴다.
const MEMO_STORAGE_KEY = 'cloudwiki_memo';
// 프리뷰는 디바운스, 저장은 약간 더 길게 디바운스해 입력 중 과도한 쓰기를 피한다.
const PREVIEW_DEBOUNCE_MS = 250;
const SAVE_DEBOUNCE_MS = 400;
// renderWikiContent 에 넘기는 가상 슬러그(자기 참조 링크/트랜스클루전 베이스용 — 실제 문서 아님).
const MEMO_SLUG = 'memo';

let previewTimer: ReturnType<typeof setTimeout> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// ── 현재 다크 모드 여부 (edit/utils.ts 의 getIsDarkMode 와 동일 규칙) ──
function getIsDarkMode(): boolean {
    const themeAttr = document.documentElement.getAttribute('data-theme');
    if (themeAttr === 'dark') return true;
    if (themeAttr === 'light') return false;
    return !!(typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

// ── localStorage 입출력 (Privacy 모드 등 접근 불가 환경은 무시) ──
function loadSavedMemo(): string {
    try { return localStorage.getItem(MEMO_STORAGE_KEY) || ''; } catch { return ''; }
}
function persistMemo(text: string): void {
    try {
        if (text) localStorage.setItem(MEMO_STORAGE_KEY, text);
        else localStorage.removeItem(MEMO_STORAGE_KEY);
    } catch { /* 무시 */ }
}

// ── 하단 글자수 카운터 ──
// edit-utils.js 가 노출하는 #editorTextCounter 갱신 함수를 재사용한다(문서 편집과 동일).
// 번들 미로드(폴백) 시를 대비해 옵셔널 체이닝으로 가드한다.
function updateCounterFromText(text: string): void {
    if (typeof w.updateEditorTextCounter === 'function') w.updateEditorTextCounter(text);
}
function updateCounterFromDoc(doc: any): void {
    if (typeof w.updateEditorTextCounterFromDoc === 'function') w.updateEditorTextCounterFromDoc(doc);
    else if (typeof w.updateEditorTextCounter === 'function') w.updateEditorTextCounter(doc.toString());
}

// ── 실시간 프리뷰 렌더 (render.js 의 위키 본문 렌더 + 폴드/탭/iframe 상태 보존) ──
async function renderMemoPreview(text: string): Promise<void> {
    const preview = document.getElementById('custom-wiki-preview');
    if (!preview) return;
    // 본문 렌더 스타일(render.css)이 적용되도록 wiki-content 클래스를 보장한다.
    if (!preview.classList.contains('wiki-content')) preview.classList.add('wiki-content');
    if (!text.trim()) {
        preview.innerHTML = '<p class="text-muted">여기에 작성한 내용의 미리보기가 표시됩니다.</p>';
        return;
    }
    if (typeof w.renderWikiContent === 'function') {
        // 재렌더 시 펼침/접힘·탭·iframe 상태를 보존해 깜빡임을 줄인다(문서 편집기와 동일).
        const snap = snapshotPreviewState(preview);
        await w.renderWikiContent(text, MEMO_SLUG, 'custom-wiki-preview', { inlineTocLayout: false });
        try { restorePreviewState(preview, snap); } catch { /* 렌더 실패 등은 무시 */ }
    }
}

// ── 메모 에디터 추상화 — CM6 와 textarea 폴백이 공유하는 최소 인터페이스 ──
interface MemoEditor {
    getText(): string;
    setText(text: string): void;
    focus(): void;
}

// ── 복사 / 비우기 버튼 + 초기 렌더 와이어링 (두 경로 공통) ──
function wireActions(editor: MemoEditor): void {
    const copyBtn = document.getElementById('memoCopyBtn');
    if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
            const text = editor.getText();
            if (!text) return;
            try {
                await navigator.clipboard.writeText(text);
                w.Swal?.fire({
                    toast: true, position: 'top-end', icon: 'success',
                    title: '복사했습니다', showConfirmButton: false, timer: 1500,
                });
            } catch {
                w.Swal?.fire('복사 실패', '클립보드 접근이 차단되어 복사하지 못했습니다.', 'warning');
            }
        });
    }

    const clearBtn = document.getElementById('memoClearBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
            if (!editor.getText()) return;
            let confirmed = false;
            if (w.Swal) {
                const result = await w.Swal.fire({
                    icon: 'warning',
                    title: '메모를 비울까요?',
                    text: '작성한 내용이 모두 지워집니다. 이 동작은 되돌릴 수 없습니다.',
                    showCancelButton: true,
                    confirmButtonText: '비우기',
                    cancelButtonText: '취소',
                });
                confirmed = !!result.isConfirmed;
            } else {
                confirmed = window.confirm('메모를 비울까요? 작성한 내용이 모두 지워집니다.');
            }
            if (!confirmed) return;
            editor.setText('');
            updateCounterFromText('');
            void renderMemoPreview('');
            persistMemo('');
            editor.focus();
        });
    }

    // 초기 1회 반영 (복원된 본문 기준 카운터·프리뷰)
    const initial = editor.getText();
    updateCounterFromText(initial);
    void renderMemoPreview(initial);
}

// ── getAllPalettesForEditor 심 ──
// edit-modals.js 의 카드/배지/구조/팔레트 모달이 호출하는 헬퍼는 본래 edit-autocomplete.ts
// 가 노출한다. 메모장은 autocomplete 를 로드하지 않으므로 동일 동작의 순수 함수를 제공한다
// (WIKI_HARDCODED_PALETTES + appConfig.palettes 병합 → 현재 밝기 variant 반환).
function installPaletteShim(): void {
    if (typeof w.getAllPalettesForEditor === 'function') return;
    w.getAllPalettesForEditor = function (): Array<{ name: string; source: string; variant: any }> {
        const isDark = (typeof w.getIsDarkMode === 'function') ? w.getIsDarkMode() : getIsDarkMode();
        const hardcoded = w.WIKI_HARDCODED_PALETTES ?? {};
        const custom = (w.appConfig?.palettes && typeof w.appConfig.palettes === 'object')
            ? w.appConfig.palettes as Record<string, unknown>
            : {};
        const merged: Record<string, { source: string; entry: any }> = {};
        for (const [name, entry] of Object.entries(hardcoded)) merged[name] = { source: 'preset', entry };
        for (const [name, entry] of Object.entries(custom)) {
            if (!entry || typeof entry !== 'object') continue;
            merged[name] = { source: merged[name] ? 'override' : 'custom', entry };
        }
        return Object.entries(merged).map(([name, info]) => {
            const e = info.entry as { light?: any; dark?: any };
            const variant = isDark ? (e.dark || e.light) : (e.light || e.dark);
            return { name, source: info.source, variant: variant || {} };
        });
    };
}

// ── CM6 에디터 초기화 ──
async function initCodeMirrorEditor(host: HTMLElement, initialDoc: string): Promise<MemoEditor> {
    const [cmState, cmViewMod, cmCommands, cmMarkdown, cmLangData, cmOneDark, cmLanguage, cmLezer, cmSearch] = await Promise.all([
        import('@codemirror/state'),
        import('@codemirror/view'),
        import('@codemirror/commands'),
        import('@codemirror/lang-markdown'),
        import('@codemirror/language-data'),
        import('@codemirror/theme-one-dark'),
        import('@codemirror/language'),
        import('@lezer/highlight'),
        import('@codemirror/search'),
    ]);

    const { EditorState, Compartment, RangeSetBuilder, StateField, StateEffect } = cmState;
    const { EditorView, keymap, lineNumbers, highlightActiveLineGutter, drawSelection,
        MatchDecorator, ViewPlugin, Decoration, WidgetType } = cmViewMod;
    const { defaultKeymap, history, historyKeymap, indentWithTab } = cmCommands;
    const { markdown, markdownLanguage } = cmMarkdown;
    const { languages } = cmLangData;
    const { oneDark } = cmOneDark;
    const { syntaxHighlighting, indentOnInput, bracketMatching, HighlightStyle } = cmLanguage;
    const { tags } = cmLezer;
    const { SearchCursor } = cmSearch;

    // ── 레이아웃(전폭 툴바 + 좌우 분할 + 모바일 탭) 마운트 — tocFab 는 메모장엔 불필요 ──
    host.innerHTML = buildEditorLayoutHTML({ tocFab: false });
    const layoutEl = host.querySelector('.wiki-editor-layout') as HTMLElement;
    const toolbarEl = host.querySelector('#cm-toolbar') as HTMLElement;
    const cmMount = host.querySelector('#cm-editor') as HTMLElement;

    // 다크모드 상태(테마 동기화 시 갱신). 하이라이트 플러그인/스타일이 라이브로 참조.
    let isDarkMode = getIsDarkMode();

    // ── 에디터 설정 (localStorage — 문서 편집기와 동일 키를 공유) ──
    const editorSettings = {
        showLineNumbers: localStorage.getItem('editor_show_line_numbers') !== 'false',
        wordWrap: localStorage.getItem('editor_word_wrap') !== 'false',
        syntaxHighlight: localStorage.getItem('editor_syntax_highlight') !== 'false',
        advancedEdit: localStorage.getItem('editor_advanced_edit') !== 'false',
        scrollSync: localStorage.getItem('editor_scroll_sync') === 'true',
        scrollSyncMode: (localStorage.getItem('editor_scroll_sync_mode') === 'twoway' ? 'twoway' : 'oneway') as 'oneway' | 'twoway',
    };
    // 인라인 표 툴바 / Shift+Enter {br} 가 읽는 플래그. 메모장은 autocomplete 드롭다운을
    // 로드하지 않지만 이 플래그는 표 편집 기능 게이트도 겸하므로 true 로 둔다(드롭다운은
    // 모듈 미로드라 뜨지 않음 — 표 편집/줄바꿈 토큰만 활성화된다).
    w.wikiSyntaxAutocompleteEnabled = true;

    // ── Compartment (동적 재설정) ──
    const lineNumbersCompartment = new Compartment();
    const lineWrappingCompartment = new Compartment();
    const syntaxHighlightCompartment = new Compartment();
    const advancedEditCompartment = new Compartment();
    const themeCompartment = new Compartment();
    const darkBgCompartment = new Compartment();

    // ── 찾기/바꾸기 매치 하이라이트 (StateField + StateEffect) — main.ts 와 동일 ──
    const setSearchMatchesEffect = StateEffect.define();
    const searchMatchDeco = Decoration.mark({ class: 'cm-search-match' });
    const searchActiveDeco = Decoration.mark({ class: 'cm-search-match-active' });
    const searchMatchField = StateField.define({
        create() { return Decoration.none; },
        update(value: any, tr: any) {
            value = value.map(tr.changes);
            for (const e of tr.effects) {
                if (e.is(setSearchMatchesEffect)) value = e.value;
            }
            return value;
        },
        provide: (f: any) => EditorView.decorations.from(f),
    });

    // ── 마크다운 하이라이트 스타일 / 테마 (cm-shared 단일 소스) ──
    const { light: mdLight, dark: mdDark } = makeMarkdownHighlightStyles(HighlightStyle, tags);
    const lightTheme = makeLightTheme(EditorView);
    const darkBgTheme = makeDarkBgTheme(EditorView);

    // ── 위키 문법 인라인 하이라이트 플러그인 (cm-highlight 단일 소스, 문서 편집기와 공유) ──
    // 테마 토글 시 커스텀 팔레트 색(getIsDark() 의존)을 즉시 재계산하려면 플러그인을 새
    // 인스턴스로 교체해야 하므로(syncTheme 참조) let 으로 둔다.
    const buildWikiPlugins = () => buildWikiHighlightPlugins(
        { EditorView, MatchDecorator, ViewPlugin, Decoration, WidgetType, RangeSetBuilder },
        { getIsDark: () => isDarkMode }
    );
    let { base: wikiBasePlugins, advanced: wikiAdvancedPlugins } = buildWikiPlugins();

    const buildSyntaxHighlightExts = () => editorSettings.syntaxHighlight ? [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(isDarkMode ? mdDark : mdLight),
        ...wikiBasePlugins,
    ] : [];
    const buildAdvancedEditExts = () => (editorSettings.syntaxHighlight && editorSettings.advancedEdit) ? [
        ...wikiAdvancedPlugins,
    ] : [];

    // ── 인라인 표 편집 툴바 (edit-table-toolbar.js) — 미로드 시 no-op 가드 ──
    const tableToolbar = (typeof w.setupTableToolbar === 'function')
        ? w.setupTableToolbar()
        : { update: () => { }, hide: () => { } };

    // 외부 핸들(키맵/리스너)이 늦게 정의된 함수를 참조하기 위한 가변 슬롯.
    let findOpen: () => void = () => { };
    let findOnDocChange: () => void = () => { };

    // ── 문서 변경 / 선택 변경 리스너 ──
    const updateListener = EditorView.updateListener.of((update: any) => {
        if (update.docChanged) {
            const text = update.state.doc.toString();
            updateCounterFromDoc(update.state.doc);
            if (previewTimer) clearTimeout(previewTimer);
            previewTimer = setTimeout(() => { void renderMemoPreview(text); }, PREVIEW_DEBOUNCE_MS);
            if (saveTimer) clearTimeout(saveTimer);
            saveTimer = setTimeout(() => persistMemo(text), SAVE_DEBOUNCE_MS);
            findOnDocChange();
        }
        if (update.selectionSet || update.docChanged || update.viewportChanged) {
            tableToolbar.update(update.view);
        }
    });

    // blur 시 표 툴바 숨김(버튼 클릭은 mousedown.preventDefault 로 blur 미발생이라 안전).
    const blurHandler = EditorView.domEventHandlers({
        blur: () => { tableToolbar.hide(); },
    });

    // Shift+Enter → 표 셀 안에서 {br} 토큰 삽입 (main.ts 와 동일 규칙). 표 밖이면 false 로
    // 폴백해 defaultKeymap(개행)으로 처리. table-toolbar 미로드/플래그 off 시도 폴백.
    const shiftEnterTableBr = (view: any): boolean => {
        if (w.wikiSyntaxAutocompleteEnabled === false) return false;
        const finder = w.findTableContext;
        if (typeof finder !== 'function') return false;
        const ctx = finder(view);
        if (!ctx) return false;
        if (ctx.rowIndex === ctx.separatorRowIndex) return false;
        const sel = view.state.selection.main;
        const line = view.state.doc.lineAt(sel.from);
        const col = sel.from - line.from;
        if (!/(?<!\\)\|/.test(line.text.slice(0, col))) return false;
        const trailingPipe = line.text.match(/(?<!\\)\|(?=[ \t]*$)/);
        if (trailingPipe && col > (trailingPipe.index ?? -1)) return false;
        const pos = sel.from;
        view.dispatch({ changes: { from: pos, insert: '{br}' }, selection: { anchor: pos + 4 } });
        return true;
    };

    // ── CM6 EditorView 생성 ──
    const view = new EditorView({
        state: EditorState.create({
            doc: initialDoc,
            extensions: [
                lineNumbersCompartment.of(
                    editorSettings.showLineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []
                ),
                drawSelection(),
                indentOnInput(),
                bracketMatching(),
                history(),
                keymap.of([
                    { key: 'Mod-f', run: () => { findOpen(); return true; }, preventDefault: true },
                    { key: 'Shift-Enter', run: shiftEnterTableBr },
                    ...defaultKeymap,
                    ...historyKeymap,
                    indentWithTab,
                ]),
                searchMatchField,
                themeCompartment.of(isDarkMode ? oneDark : lightTheme),
                darkBgCompartment.of(isDarkMode ? darkBgTheme : []),
                lineWrappingCompartment.of(editorSettings.wordWrap ? EditorView.lineWrapping : []),
                updateListener,
                blurHandler,
                syntaxHighlightCompartment.of(buildSyntaxHighlightExts()),
                advancedEditCompartment.of(buildAdvancedEditExts()),
            ],
        }),
        parent: cmMount,
    });

    // ── 전역 CM6 인스턴스 + 에디터 Shim 노출 ──
    // edit-modals.js / edit-table-toolbar.js / edit-image.js 가 window.editor·_cmView 를
    // 통해 본문을 삽입/포커스한다. 문서 편집기(main.ts)의 shim 과 동일 시그니처.
    w._cmView = view;
    w.CodeMirrorView = cmViewMod;
    const editorShim = {
        getMarkdown: () => view.state.doc.toString(),
        getRawText: () => view.state.doc.toString(),
        setMarkdown: (md: string) => {
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: md } });
        },
        insertText: (text: string) => {
            const { main } = view.state.selection;
            view.dispatch({
                changes: { from: main.from, to: main.to, insert: text },
                selection: { anchor: main.from + text.length },
            });
            view.focus();
        },
        getSelection: () => {
            const { main } = view.state.selection;
            const fromLine = view.state.doc.lineAt(main.from);
            const toLine = view.state.doc.lineAt(main.to);
            return [
                [fromLine.number, main.from - fromLine.from + 1],
                [toLine.number, main.to - toLine.from + 1],
            ];
        },
        setSelection: (fromArr: number[], toArr: number[]) => {
            try {
                const fromLine = view.state.doc.line(fromArr[0]);
                const toLine = view.state.doc.line(toArr[0]);
                view.dispatch({ selection: { anchor: fromLine.from + fromArr[1] - 1, head: toLine.from + toArr[1] - 1 } });
            } catch { /* 잘못된 위치 무시 */ }
        },
        focus: () => view.focus(),
        on: () => { /* 메모장은 change/blur 외부 구독 불필요 */ },
        changePreviewStyle: () => { /* split 뷰에서는 불필요 */ },
        getCursorCoords: () => view.coordsAtPos(view.state.selection.main.head),
    };
    w.editor = editorShim;

    // ── 아이콘 피커 모달 닫힘 후 아이콘 삽입 ──
    // edit-modals.js 의 아이콘 피커(openIconPicker/openSelectedIconsPicker)는 선택 결과를
    // window.pendingIconInsertion(삽입할 텍스트)에 담고 #iconPickerModal 을 닫기만 한다.
    // 실제 삽입은 본래 main.ts 의 hidden.bs.modal 리스너가 수행하므로(모달이 가로챈 포커스/
    // 선택을 복원한 뒤 insertText), 메모장도 동일 리스너를 설치해야 아이콘 삽입이 동작한다.
    const iconPickerModalEl = document.getElementById('iconPickerModal');
    if (iconPickerModalEl) {
        iconPickerModalEl.addEventListener('hidden.bs.modal', () => {
            if (!w.pendingIconInsertion) return;
            editorShim.focus();
            if (w.iconPickerSavedSelection) {
                editorShim.setSelection(w.iconPickerSavedSelection[0], w.iconPickerSavedSelection[1]);
            }
            editorShim.insertText(w.pendingIconInsertion);
            w.pendingIconInsertion = null;
        });
    }

    // 초기 카운터
    updateCounterFromDoc(view.state.doc);

    // ── 툴바: 공유 빌더(전체 모달 버튼 + 이미지 업로드 팝업). enableWikiModals=false 로
    //    실제 문서 슬러그가 필요한 "하위 문서" 버튼만 제외한다(나머지는 게스트 안전). ──
    buildSharedToolbar(toolbarEl, view, {
        insertText: (text: string) => editorShim.insertText(text),
        imageButton: { mode: 'wiki-popup' },
        enableWikiModals: false,
    });

    // ── 문법 치트시트 버튼 (제안 G-5) — 문서 편집기와 동일한 진입점 ──
    const cheatsheetBtn = createToolbarBtn('<i class="mdi mdi-book-search-outline"></i>', '문법 치트시트 (문법 검색)', () => {
        if (typeof window.openSyntaxCheatsheet === 'function') window.openSyntaxCheatsheet();
    });
    cheatsheetBtn.id = 'cm-cheatsheet-btn';
    toolbarEl.appendChild(cheatsheetBtn);

    // ── 찾기/바꾸기 + 설정 버튼(공유 모드 드롭다운 앞에 위치) ──
    const findBtn = createToolbarBtn('<i class="mdi mdi-magnify"></i>', '찾기 / 바꾸기 (Ctrl+F)', () => {
        if (findPanel.style.display === 'block') closeFindPanel(); else openFindPanel();
    });
    findBtn.id = 'cm-find-btn';
    toolbarEl.appendChild(findBtn);

    const settingsBtn = createToolbarBtn('<i class="mdi mdi-cog"></i>', '에디터 설정', () => toggleSettingsPanel());
    settingsBtn.id = 'cm-settings-btn';
    toolbarEl.appendChild(settingsBtn);

    // ── 모바일 탭 + PC 보기 모드(일반/작성/보기) 드롭다운(우측 정렬). 프리뷰 표시 시 즉시 렌더 ──
    setupTabSwitcher(layoutEl, toolbarEl, {
        onPreviewShown: () => { void renderMemoPreview(view.state.doc.toString()); },
        onModeChange: () => { /* 스크롤 동기화 측정은 다음 스크롤 이벤트에서 자연히 갱신 */ },
    });

    // ── 설정 패널 (메모장 서브셋: 줄번호 / 문법 하이라이트 / 아이콘 / 줄바꿈 / 스크롤 동기화) ──
    const settingsPanel = document.createElement('div');
    settingsPanel.className = 'editor-settings-panel';
    settingsPanel.style.display = 'none';
    settingsPanel.innerHTML = `
        <div class="editor-settings-title"><i class="mdi mdi-cog"></i> 에디터 설정</div>
        <label class="editor-settings-item">
            <span>줄 번호 표시</span>
            <input type="checkbox" id="memoSettingLineNumbers" ${editorSettings.showLineNumbers ? 'checked' : ''}>
        </label>
        <label class="editor-settings-item">
            <span>스크롤 동기화</span>
            <input type="checkbox" id="memoSettingScrollSync" ${editorSettings.scrollSync ? 'checked' : ''}>
        </label>
        <label class="editor-settings-item editor-settings-subitem">
            <input type="radio" name="memoScrollSyncMode" value="oneway"
                ${editorSettings.scrollSyncMode === 'oneway' ? 'checked' : ''} ${editorSettings.scrollSync ? '' : 'disabled'}>
            <span>단방향 (에디터 → 프리뷰)</span>
        </label>
        <label class="editor-settings-item editor-settings-subitem">
            <input type="radio" name="memoScrollSyncMode" value="twoway"
                ${editorSettings.scrollSyncMode === 'twoway' ? 'checked' : ''} ${editorSettings.scrollSync ? '' : 'disabled'}>
            <span>양방향</span>
        </label>
        <label class="editor-settings-item">
            <span>문법 하이라이트</span>
            <input type="checkbox" id="memoSettingSyntaxHighlight" ${editorSettings.syntaxHighlight ? 'checked' : ''}>
        </label>
        <label class="editor-settings-item">
            <span>아이콘 표시</span>
            <input type="checkbox" id="memoSettingAdvancedEdit"
                ${editorSettings.advancedEdit && editorSettings.syntaxHighlight ? 'checked' : ''} ${editorSettings.syntaxHighlight ? '' : 'disabled'}>
        </label>
        <div class="editor-settings-divider"></div>
        <div class="editor-settings-section-title">줄바꿈 모드</div>
        <label class="editor-settings-item">
            <input type="radio" name="memoWrapMode" value="wrap" ${editorSettings.wordWrap ? 'checked' : ''}>
            <span>자동 줄바꿈 (기본)</span>
        </label>
        <label class="editor-settings-item">
            <input type="radio" name="memoWrapMode" value="scroll" ${!editorSettings.wordWrap ? 'checked' : ''}>
            <span>가로 스크롤</span>
        </label>
    `;
    document.body.appendChild(settingsPanel);

    function toggleSettingsPanel(): void {
        const isVisible = settingsPanel.style.display !== 'none';
        if (isVisible) {
            settingsPanel.style.display = 'none';
            settingsBtn.classList.remove('active');
            return;
        }
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
        let left = rect.right - panelW;
        left = Math.max(margin, Math.min(left, viewportW - panelW - margin));
        let top = rect.bottom + 4;
        if (top + panelH + margin > viewportH && rect.top - panelH - 4 >= margin) top = rect.top - panelH - 4;
        top = Math.max(margin, Math.min(top, viewportH - panelH - margin));
        settingsPanel.style.left = `${left + window.scrollX}px`;
        settingsPanel.style.top = `${top + window.scrollY}px`;
        settingsPanel.style.visibility = '';
        settingsBtn.classList.add('active');
    }
    document.addEventListener('click', (e) => {
        if (!settingsPanel.contains(e.target as Node) && !settingsBtn.contains(e.target as Node)) {
            settingsPanel.style.display = 'none';
            settingsBtn.classList.remove('active');
        }
    });

    // 줄 번호
    settingsPanel.querySelector<HTMLInputElement>('#memoSettingLineNumbers')!.addEventListener('change', (e) => {
        editorSettings.showLineNumbers = (e.target as HTMLInputElement).checked;
        localStorage.setItem('editor_show_line_numbers', String(editorSettings.showLineNumbers));
        view.dispatch({
            effects: lineNumbersCompartment.reconfigure(
                editorSettings.showLineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []
            ),
        });
    });
    // 문법 하이라이트 (+ 아이콘 토글 활성/비활성 동기화)
    const advancedCheck = settingsPanel.querySelector<HTMLInputElement>('#memoSettingAdvancedEdit')!;
    settingsPanel.querySelector<HTMLInputElement>('#memoSettingSyntaxHighlight')!.addEventListener('change', (e) => {
        editorSettings.syntaxHighlight = (e.target as HTMLInputElement).checked;
        localStorage.setItem('editor_syntax_highlight', String(editorSettings.syntaxHighlight));
        advancedCheck.disabled = !editorSettings.syntaxHighlight;
        view.dispatch({
            effects: [
                syntaxHighlightCompartment.reconfigure(buildSyntaxHighlightExts()),
                advancedEditCompartment.reconfigure(buildAdvancedEditExts()),
            ],
        });
    });
    // 아이콘(고급 편집)
    advancedCheck.addEventListener('change', (e) => {
        editorSettings.advancedEdit = (e.target as HTMLInputElement).checked;
        localStorage.setItem('editor_advanced_edit', String(editorSettings.advancedEdit));
        view.dispatch({ effects: advancedEditCompartment.reconfigure(buildAdvancedEditExts()) });
    });
    // 줄바꿈 모드
    settingsPanel.querySelectorAll<HTMLInputElement>('input[name="memoWrapMode"]').forEach((radio) => {
        radio.addEventListener('change', () => {
            if (!radio.checked) return;
            editorSettings.wordWrap = radio.value === 'wrap';
            localStorage.setItem('editor_word_wrap', String(editorSettings.wordWrap));
            view.dispatch({
                effects: lineWrappingCompartment.reconfigure(editorSettings.wordWrap ? EditorView.lineWrapping : []),
            });
        });
    });
    // 스크롤 동기화 토글 + 모드
    const scrollModeRadios = settingsPanel.querySelectorAll<HTMLInputElement>('input[name="memoScrollSyncMode"]');
    settingsPanel.querySelector<HTMLInputElement>('#memoSettingScrollSync')!.addEventListener('change', (e) => {
        editorSettings.scrollSync = (e.target as HTMLInputElement).checked;
        localStorage.setItem('editor_scroll_sync', String(editorSettings.scrollSync));
        scrollModeRadios.forEach((r) => { r.disabled = !editorSettings.scrollSync; });
    });
    scrollModeRadios.forEach((radio) => {
        radio.addEventListener('change', () => {
            if (!radio.checked) return;
            editorSettings.scrollSyncMode = radio.value === 'twoway' ? 'twoway' : 'oneway';
            localStorage.setItem('editor_scroll_sync_mode', editorSettings.scrollSyncMode);
        });
    });

    // ── 스크롤 동기화 (에디터 ↔ 프리뷰) ──
    // 메모장은 문서 편집기의 정교한 lerp 대신 data-raw-line 앵커 기반의 경량 직접 동기화를
    // 쓴다(스크래치패드 용도에 충분). 피드백 루프는 "마지막으로 우리가 설정한 scrollTop" 을
    // 양쪽에 기록해, 이어서 들어오는 scroll 이벤트가 그 값(±2px)이면 프로그램 echo 로 보고
    // 무시하는 방식으로 차단한다(main.ts 의 _lerpLastSet* 와 동일 발상 — rAF 타이밍 비의존).
    let _lastSetPreviewTop: number | null = null;
    let _lastSetEditorTop: number | null = null;
    const collectAnchors = (preview: HTMLElement): Array<{ line: number; top: number }> => {
        const out: Array<{ line: number; top: number }> = [];
        preview.querySelectorAll('[data-raw-line]').forEach((el) => {
            const line = parseInt((el as HTMLElement).getAttribute('data-raw-line') || '', 10);
            if (Number.isFinite(line)) out.push({ line, top: (el as HTMLElement).offsetTop });
        });
        out.sort((a, b) => a.line - b.line);
        return out;
    };
    // 가이드 포인트를 **에디터/프리뷰 스크롤 픽셀 공간**으로 만든다: 각 헤딩 앵커를
    //   { e: 그 헤딩 라인이 에디터 뷰포트 최상단에 올 때의 scrollTop, p: 프리뷰 내 offsetTop }
    // 쌍으로 두고, 양 끝에 합성 경계 (0,0)·(editorMax, previewMax) 를 더한다.
    // 이렇게 하면 ① render.ts 가 헤딩에만 data-raw-line 을 부여해도 인트로/말미가 누락되지 않고,
    // ② 라인 인덱스가 아닌 실제 scrollTop 으로 보간하므로 에디터를 끝까지 내리면(scrollTop=editorMax)
    // 프리뷰도 정확히 최하단(previewMax)에 도달한다(헤딩이 적거나 없는 문서 포함 — 앵커가 없으면
    // 경계 2점만 남아 비례 동기화가 된다). e/p 모두 라인 순서대로 단조 증가하므로 양방향 보간 안정.
    const buildGuide = (preview: HTMLElement): { guide: Array<{ e: number; p: number }>; previewMax: number; editorMax: number } => {
        const scroller = view.scrollDOM;
        const previewMax = Math.max(0, preview.scrollHeight - preview.clientHeight);
        const editorMax = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const docLines = view.state.doc.lines;
        const mid = collectAnchors(preview)
            .map((a) => {
                const lineNo = Math.min(Math.max(a.line + 1, 1), docLines); // data-raw-line 은 0-based → 1-based
                const e = view.lineBlockAt(view.state.doc.line(lineNo).from).top;
                return { e, p: Math.max(0, Math.min(a.top, previewMax)) };
            })
            // 경계와 겹치거나 범위를 벗어나는 점은 제외해 단조성(중복 키) 보장.
            .filter((g) => g.e > 0 && g.e < editorMax && g.p > 0 && g.p < previewMax);
        const guide = [{ e: 0, p: 0 }, ...mid, { e: editorMax, p: previewMax }];
        guide.sort((x, y) => x.e - y.e);
        return { guide, previewMax, editorMax };
    };
    // 가이드에서 target 을 감싸는 두 점을 찾아 대응 값 선형 보간 (가이드는 항상 ≥2 점).
    const interpolate = (guide: Array<{ e: number; p: number }>, key: 'e' | 'p', val: 'e' | 'p', target: number): number => {
        if (target <= guide[0][key]) return guide[0][val];
        const last = guide[guide.length - 1];
        if (target >= last[key]) return last[val];
        for (let i = 0; i < guide.length - 1; i++) {
            const a = guide[i], b = guide[i + 1];
            if (target >= a[key] && target <= b[key]) {
                const span = (b[key] - a[key]) || 1;
                return a[val] + (b[val] - a[val]) * ((target - a[key]) / span);
            }
        }
        return last[val];
    };
    const syncEditorToPreview = (): void => {
        if (!editorSettings.scrollSync) return;
        const preview = document.getElementById('custom-wiki-preview');
        if (!preview) return;
        const scroller = view.scrollDOM;
        // 우리가 직전에 설정한 값이면 프로그램 echo → 무시(사용자 스크롤만 전파).
        if (_lastSetEditorTop !== null && Math.abs(scroller.scrollTop - _lastSetEditorTop) <= 2) {
            _lastSetEditorTop = null;
            return;
        }
        _lastSetEditorTop = null;
        const { guide, previewMax } = buildGuide(preview);
        const clamped = Math.max(0, Math.min(interpolate(guide, 'e', 'p', scroller.scrollTop), previewMax));
        _lastSetPreviewTop = clamped;
        preview.scrollTop = clamped;
    };
    const syncPreviewToEditor = (): void => {
        if (!editorSettings.scrollSync || editorSettings.scrollSyncMode !== 'twoway') return;
        const preview = document.getElementById('custom-wiki-preview');
        if (!preview) return;
        const scroller = view.scrollDOM;
        if (_lastSetPreviewTop !== null && Math.abs(preview.scrollTop - _lastSetPreviewTop) <= 2) {
            _lastSetPreviewTop = null;
            return;
        }
        _lastSetPreviewTop = null;
        const { guide, editorMax } = buildGuide(preview);
        const clamped = Math.max(0, Math.min(interpolate(guide, 'p', 'e', preview.scrollTop), editorMax));
        _lastSetEditorTop = clamped;
        scroller.scrollTop = clamped;
    };
    view.scrollDOM.addEventListener('scroll', syncEditorToPreview, { passive: true });
    // 프리뷰 패널 스크롤(양방향). 프리뷰 컨테이너는 렌더 후에도 동일 엘리먼트가 유지된다.
    const previewPaneEl = document.getElementById('custom-wiki-preview');
    if (previewPaneEl) previewPaneEl.addEventListener('scroll', syncPreviewToEditor, { passive: true });

    // ── 찾기/바꾸기 패널 ──
    const findPanel = document.createElement('div');
    findPanel.id = 'cm-find-panel';
    findPanel.className = 'cm-find-panel';
    findPanel.style.display = 'none';
    findPanel.innerHTML = `
        <div class="cm-find-row">
            <input type="text" id="memoFindInput" class="cm-find-input" placeholder="찾기" autocomplete="off" spellcheck="false">
            <span class="cm-find-status" id="memoFindStatus"></span>
            <button type="button" id="memoFindPrevBtn" class="cm-find-btn" title="이전 (Shift+Enter)"><i class="mdi mdi-chevron-up"></i></button>
            <button type="button" id="memoFindNextBtn" class="cm-find-btn" title="다음 (Enter)"><i class="mdi mdi-chevron-down"></i></button>
            <label class="cm-find-toggle" title="대소문자 구분">
                <input type="checkbox" id="memoFindCaseSensitive">
                <span>Aa</span>
            </label>
            <button type="button" id="memoFindCloseBtn" class="cm-find-btn cm-find-close" title="닫기 (Esc)"><i class="mdi mdi-close"></i></button>
        </div>
        <div class="cm-find-row">
            <input type="text" id="memoReplaceInput" class="cm-find-input" placeholder="바꾸기" autocomplete="off" spellcheck="false">
            <button type="button" id="memoReplaceOneBtn" class="cm-find-btn cm-find-btn-text" title="현재 일치 항목을 바꾸고 다음으로 이동">
                <i class="mdi mdi-find-replace"></i> 바꾸기
            </button>
        </div>
    `;
    document.body.appendChild(findPanel);

    const findInput = findPanel.querySelector<HTMLInputElement>('#memoFindInput')!;
    const replaceInput = findPanel.querySelector<HTMLInputElement>('#memoReplaceInput')!;
    const findStatus = findPanel.querySelector<HTMLElement>('#memoFindStatus')!;
    const findCaseCheck = findPanel.querySelector<HTMLInputElement>('#memoFindCaseSensitive')!;

    const _findState: { matches: Array<{ from: number; to: number }>; currentIdx: number; query: string; caseSensitive: boolean } =
        { matches: [], currentIdx: -1, query: '', caseSensitive: false };

    function _computeFindMatches(): Array<{ from: number; to: number }> {
        const q = _findState.query;
        if (!q) return [];
        const doc = view.state.doc;
        const normalize = _findState.caseSensitive ? undefined : (s: string) => s.toLowerCase();
        const cursor = new SearchCursor(doc, q, 0, doc.length, normalize);
        const out: Array<{ from: number; to: number }> = [];
        while (!cursor.next().done) {
            out.push({ from: cursor.value.from, to: cursor.value.to });
            if (out.length > 5000) break;
        }
        return out;
    }
    function _rebuildFindDeco(): void {
        if (_findState.matches.length === 0) {
            view.dispatch({ effects: setSearchMatchesEffect.of(Decoration.none) });
            return;
        }
        const builder = new RangeSetBuilder();
        _findState.matches.forEach((m, i) => {
            builder.add(m.from, m.to, i === _findState.currentIdx ? searchActiveDeco : searchMatchDeco);
        });
        view.dispatch({ effects: setSearchMatchesEffect.of(builder.finish()) });
    }
    function _updateFindStatus(): void {
        if (!_findState.query) { findStatus.textContent = ''; return; }
        if (_findState.matches.length === 0) { findStatus.textContent = '0/0'; return; }
        findStatus.textContent = `${_findState.currentIdx + 1}/${_findState.matches.length}`;
    }
    function _scrollFindMatchIntoView(): void {
        const m = _findState.matches[_findState.currentIdx];
        if (!m) return;
        view.dispatch({ effects: EditorView.scrollIntoView(m.from, { y: 'center' }) });
    }
    function _refreshFind(useCursorAnchor: boolean, scroll = true): void {
        _findState.matches = _computeFindMatches();
        if (_findState.matches.length === 0) {
            _findState.currentIdx = -1;
        } else if (useCursorAnchor) {
            const cursor = view.state.selection.main.from;
            let idx = _findState.matches.findIndex((m) => m.from >= cursor);
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
    function _gotoFindNext(): void {
        if (_findState.matches.length === 0) return;
        _findState.currentIdx = (_findState.currentIdx + 1) % _findState.matches.length;
        _rebuildFindDeco(); _scrollFindMatchIntoView(); _updateFindStatus();
    }
    function _gotoFindPrev(): void {
        if (_findState.matches.length === 0) return;
        _findState.currentIdx = (_findState.currentIdx - 1 + _findState.matches.length) % _findState.matches.length;
        _rebuildFindDeco(); _scrollFindMatchIntoView(); _updateFindStatus();
    }
    function _replaceCurrentAndAdvance(): void {
        if (_findState.matches.length === 0 || _findState.currentIdx < 0) return;
        const m = _findState.matches[_findState.currentIdx];
        const replacement = replaceInput.value;
        view.dispatch({ changes: { from: m.from, to: m.to, insert: replacement } });
        const after = m.from + replacement.length;
        _findState.matches = _computeFindMatches();
        if (_findState.matches.length === 0) {
            _findState.currentIdx = -1;
        } else {
            let idx = _findState.matches.findIndex((mm) => mm.from >= after);
            if (idx === -1) idx = 0;
            _findState.currentIdx = idx;
        }
        _rebuildFindDeco();
        if (_findState.currentIdx >= 0) _scrollFindMatchIntoView();
        _updateFindStatus();
    }
    function _positionFindPanel(): void {
        const rect = toolbarEl.getBoundingClientRect();
        const margin = 8;
        const panelW = findPanel.offsetWidth || 420;
        const panelH = findPanel.offsetHeight || 90;
        const viewportW = document.documentElement.clientWidth;
        const viewportH = document.documentElement.clientHeight;
        let left = rect.right - panelW - 4;
        left = Math.max(margin, Math.min(left, viewportW - panelW - margin));
        let top = rect.bottom + 4;
        if (top + panelH + margin > viewportH && rect.top - panelH - 4 >= margin) top = rect.top - panelH - 4;
        findPanel.style.left = `${left + window.scrollX}px`;
        findPanel.style.top = `${top + window.scrollY}px`;
    }
    function openFindPanel(): void {
        const wasHidden = findPanel.style.display !== 'block';
        findPanel.style.display = 'block';
        _positionFindPanel();
        findBtn.classList.add('active');
        if (wasHidden) {
            const sel = view.state.selection.main;
            if (sel.from !== sel.to) {
                const text = view.state.sliceDoc(sel.from, sel.to);
                if (text && !text.includes('\n')) findInput.value = text;
            }
            _findState.query = findInput.value;
            _findState.caseSensitive = findCaseCheck.checked;
            _refreshFind(true);
        }
        findInput.focus();
        findInput.select();
    }
    function closeFindPanel(): void {
        findPanel.style.display = 'none';
        findBtn.classList.remove('active');
        _findState.query = '';
        _findState.matches = [];
        _findState.currentIdx = -1;
        _rebuildFindDeco();
        _updateFindStatus();
        view.focus();
    }
    findInput.addEventListener('input', () => { _findState.query = findInput.value; _refreshFind(true); });
    findCaseCheck.addEventListener('change', () => { _findState.caseSensitive = findCaseCheck.checked; _refreshFind(false); });
    findInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) _gotoFindPrev(); else _gotoFindNext(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeFindPanel(); }
    });
    replaceInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); _replaceCurrentAndAdvance(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeFindPanel(); }
    });
    findPanel.querySelector('#memoFindNextBtn')!.addEventListener('click', _gotoFindNext);
    findPanel.querySelector('#memoFindPrevBtn')!.addEventListener('click', _gotoFindPrev);
    findPanel.querySelector('#memoReplaceOneBtn')!.addEventListener('click', () => { _replaceCurrentAndAdvance(); replaceInput.focus(); });
    findPanel.querySelector('#memoFindCloseBtn')!.addEventListener('click', closeFindPanel);

    // 외부 핸들 연결 (키맵 Mod-f / updateListener docChange)
    findOpen = openFindPanel;
    findOnDocChange = () => {
        if (findPanel.style.display !== 'block' || !_findState.query) return;
        _refreshFind(false, false);
    };
    window.addEventListener('resize', () => { if (findPanel.style.display === 'block') _positionFindPanel(); });
    // 브라우저 Ctrl/Cmd+F 인터셉트
    window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
            if (!host.querySelector('#cm-editor')) return;
            e.preventDefault();
            openFindPanel();
        }
    });

    // ── 테마 동기화 (밝기/스킨 변경 시 에디터 테마·하이라이트 스타일 재구성) ──
    const syncTheme = () => {
        const dark = getIsDarkMode();
        if (dark === isDarkMode) return;
        isDarkMode = dark;
        // 위키 하이라이트 플러그인을 새 인스턴스로 재생성해 커스텀 팔레트 배지(advanced)와
        // 커스텀 팔레트 prefix 형광펜(base highlightPlugin)의 인라인 색(getIsDark() 의존)을
        // 즉시 새 밝기로 재계산한다. MatchDecorator 는 문서/뷰포트 변경 없는 단순 reconfigure
        // 로는 데코를 재계산하지 않으므로(기존 인스턴스 유지), 새 인스턴스로 교체해 createDeco
        // 가 다시 실행되게 해야 한다. 빌트인 팔레트는 CSS var() 라 재계산 없이도 자동 추종.
        ({ base: wikiBasePlugins, advanced: wikiAdvancedPlugins } = buildWikiPlugins());
        view.dispatch({
            effects: [
                themeCompartment.reconfigure(dark ? oneDark : lightTheme),
                darkBgCompartment.reconfigure(dark ? darkBgTheme : []),
                // 마크다운 스타일(라이트/다크) 교체 + 위키 base/advanced 플러그인 새 인스턴스 적용.
                syntaxHighlightCompartment.reconfigure(buildSyntaxHighlightExts()),
                advancedEditCompartment.reconfigure(buildAdvancedEditExts()),
            ],
        });
    };
    new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mql = (typeof window.matchMedia === 'function') ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    mql?.addEventListener?.('change', syncTheme);

    return {
        getText: () => view.state.doc.toString(),
        setText: (text: string) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
        focus: () => view.focus(),
    };
}

// ── CM6 로드 실패(예: esm.sh unreachable) 시 textarea 폴백 ──
// 툴바·문법 하이라이트·모달은 없지만 입력·자동 저장·실시간 프리뷰는 그대로 동작한다.
function initTextareaFallback(host: HTMLElement, initialDoc: string): MemoEditor {
    host.innerHTML = `
        <div class="wiki-editor-layout" data-fallback="1">
            <div class="cm-mobile-tabs" id="cm-mobile-tabs">
                <button class="cm-tab-btn active" data-tab="editor"><i class="mdi mdi-pencil"></i> 에디터</button>
                <button class="cm-tab-btn" data-tab="preview"><i class="mdi mdi-eye"></i> 프리뷰</button>
            </div>
            <div class="wiki-editor-split-row" id="wiki-editor-split-row">
                <div class="wiki-editor-pane cm-tab-active" id="cm-editor-pane">
                    <textarea id="memoFallbackTextarea" class="form-control" spellcheck="false"
                        style="width:100%;min-height:60vh;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;resize:vertical;"></textarea>
                </div>
                <div class="wiki-preview-pane" id="custom-wiki-preview"></div>
            </div>
        </div>`;

    const textarea = host.querySelector('#memoFallbackTextarea') as HTMLTextAreaElement;
    textarea.value = initialDoc;
    textarea.addEventListener('input', () => {
        const text = textarea.value;
        updateCounterFromText(text);
        if (previewTimer) clearTimeout(previewTimer);
        previewTimer = setTimeout(() => { void renderMemoPreview(text); }, PREVIEW_DEBOUNCE_MS);
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => persistMemo(text), SAVE_DEBOUNCE_MS);
    });

    // 모바일 탭 전환 (CM 경로의 setupTabSwitcher 대체 — 폴백은 경량 처리).
    const layoutEl = host.querySelector('.wiki-editor-layout') as HTMLElement;
    const editorPane = host.querySelector('#cm-editor-pane') as HTMLElement;
    const previewPane = host.querySelector('#custom-wiki-preview') as HTMLElement;
    host.querySelectorAll('.cm-tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const tab = (btn as HTMLElement).dataset.tab;
            layoutEl.dataset.activeTab = tab || 'editor';
            host.querySelectorAll('.cm-tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
            editorPane.classList.toggle('cm-tab-active', tab === 'editor');
            previewPane.classList.toggle('cm-tab-active', tab === 'preview');
            if (tab === 'preview') void renderMemoPreview(textarea.value);
        });
    });

    return {
        getText: () => textarea.value,
        setText: (text: string) => { textarea.value = text; },
        focus: () => textarea.focus(),
    };
}

document.addEventListener('DOMContentLoaded', async () => {
    // 프리뷰 렌더(renderWikiContent)·팔레트 심이 참조하는 appConfig(mediaPublicUrl/
    // enabledExtensions/palettes/selectedIconsOnly 등)를 채운다. 실패해도 기본 렌더는 동작.
    if (typeof w.loadConfig === 'function') {
        try { await w.loadConfig(); } catch { /* 무시 */ }
    }

    // edit-modals.js 가 읽는 전역 플래그·헬퍼 심 (autocomplete 미로드분 보강).
    w.selectedIconsOnly = !!(w.appConfig?.selectedIconsOnly);
    installPaletteShim();

    const host = document.getElementById('editor');
    if (!host) return;

    const initialDoc = loadSavedMemo();

    let editor: MemoEditor;
    try {
        editor = await initCodeMirrorEditor(host, initialDoc);
    } catch (e) {
        console.error('[memo] CodeMirror 로드 실패 — textarea 폴백으로 전환합니다.', e);
        editor = initTextareaFallback(host, initialDoc);
    }

    wireActions(editor);
});
