// 위키 에디터(edit/main.ts)와 워크스페이스 에디터(pages/ws-edit.ts)가 공유하는
// CodeMirror6 빌딩 블록 단일 소스. 두 에디터가 동일한 레이아웃·마크다운 하이라이트·
// 라이트/다크 테마·툴바 버튼 팩토리·서식 삽입 헬퍼를 쓰도록 일원화해, 과거 ws-edit 가
// 보유하던 분기된 간소 사본(서로 다른 색/툴바/레이아웃)을 제거한다.
//
// CodeMirror 모듈은 두 진입점 모두 런타임 동적 import(esm.sh, vite external) 로 받으므로,
// 이 파일은 CM 을 static import 하지 않고 필요한 생성자(HighlightStyle/EditorView/tags)를
// 인자로 받는다(번들에 CM 정적 의존성을 추가하지 않기 위함).

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── 마크다운 문법 하이라이트 스타일 (라이트/다크) ──
// 헤딩 폰트 크기는 cm-md-h* 라인 클래스(public/css/edit.css)가 줄 단위로 적용하므로
// 여기서는 색/굵기만 지정한다(인라인 fontSize 중복 곱셈 방지).
export function makeMarkdownHighlightStyles(HighlightStyle: any, t: any): { light: any; dark: any } {
    const light = HighlightStyle.define([
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
        { tag: t.invalid, color: "#f85149" },
    ]);

    const dark = HighlightStyle.define([
        { tag: t.heading1, color: "#79c0ff", fontWeight: "700" },
        { tag: t.heading2, color: "#79c0ff", fontWeight: "700" },
        { tag: t.heading3, color: "#79c0ff", fontWeight: "700" },
        { tag: t.heading4, color: "#58a6ff", fontWeight: "600" },
        { tag: t.heading5, color: "#58a6ff", fontWeight: "600" },
        { tag: t.heading6, color: "#58a6ff", fontWeight: "600" },
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

    return { light, dark };
}

// ── 라이트 모드 에디터 테마 ──
export function makeLightTheme(EditorView: any): any {
    return EditorView.theme({
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
}

// ── 다크 모드 배경 보정 테마(#000 배경 + 흰 커서) ──
// oneDark 토큰 테마와 함께 다크 모드에서만 적용된다(호출 측이 isDark 게이팅).
export function makeDarkBgTheme(EditorView: any): any {
    return EditorView.theme({
        "&": { height: "100%", fontSize: "14px", backgroundColor: "#000000" },
        ".cm-scroller": { overflow: "auto" },
        ".cm-content": { paddingBottom: "25vh", caretColor: "#ffffff" },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#ffffff", borderLeftWidth: "2px" },
        ".cm-gutters": { backgroundColor: "#000000", borderRight: "1px solid #333" },
        ".cm-activeLineGutter": { backgroundColor: "#2d2d2d" }
    });
}

// ── 툴바 버튼/구분선 DOM 팩토리 ──
export function createToolbarBtn(
    icon: string,
    tooltip: string,
    onClick: (e: MouseEvent) => void
): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-toolbar-btn';
    btn.innerHTML = icon;
    btn.title = tooltip;
    btn.addEventListener('click', onClick);
    return btn;
}

export function createToolbarSep(): HTMLSpanElement {
    const sep = document.createElement('span');
    sep.className = 'cm-toolbar-sep';
    return sep;
}

// ── 서식 삽입 헬퍼 (CM6 EditorView 기반) ──
export interface FormatHelpers {
    /** 선택 범위(없으면 '텍스트' 플레이스홀더)를 prefix/suffix 로 감싼다. */
    wrapSelection(prefix: string, suffix: string): void;
    /** 현재 줄 맨 앞에 prefix 를 삽입한다(헤딩/목록/인용 등). */
    insertPrefix(prefix: string): void;
    /** 그리드/row 등 ::: 블록을 삽입하거나 선택을 감싼다. */
    insertOrWrapWikiBlock(blockType: string): void;
    /** 커서 위치에 raw 텍스트를 삽입한다. */
    insertText(text: string): void;
}

export function makeFormatHelpers(view: any): FormatHelpers {
    function wrapSelection(prefix: string, suffix: string) {
        const { main } = view.state.selection;
        const selected = view.state.sliceDoc(main.from, main.to);
        const wrapped = prefix + (selected || '텍스트') + suffix;
        view.dispatch({
            changes: { from: main.from, to: main.to, insert: wrapped },
            selection: { anchor: main.from + prefix.length, head: main.from + wrapped.length - suffix.length }
        });
        view.focus();
    }
    function insertPrefix(prefix: string) {
        const { main } = view.state.selection;
        const line = view.state.doc.lineAt(main.from);
        view.dispatch({ changes: { from: line.from, to: line.from, insert: prefix } });
        view.focus();
    }
    function insertOrWrapWikiBlock(blockType: string) {
        const { main } = view.state.selection;
        const selected = view.state.sliceDoc(main.from, main.to);
        const inner = selected || `{palette:primary}{stat:값1|라벨1}\n{palette:secondary}{stat:값2|라벨2}\n{palette:success}{stat:값3|라벨3}`;
        const lineStart = view.state.doc.lineAt(main.from);
        const lineEnd = view.state.doc.lineAt(main.to);
        const prefix = (main.from === lineStart.from) ? '' : '\n';
        const suffix = (main.to === lineEnd.to) ? '' : '\n';
        const wrapped = `${prefix}:::${blockType}\n${inner}\n:::${suffix}`;
        view.dispatch({
            changes: { from: main.from, to: main.to, insert: wrapped },
            selection: { anchor: main.from + wrapped.length }
        });
        view.focus();
    }
    function insertText(text: string) {
        const { main } = view.state.selection;
        view.dispatch({
            changes: { from: main.from, to: main.to, insert: text },
            selection: { anchor: main.from + text.length }
        });
        view.focus();
    }
    return { wrapSelection, insertPrefix, insertOrWrapWikiBlock, insertText };
}

// ── 공유 툴바 빌더 ──
// 위키 에디터(edit/main.ts)와 워크스페이스 에디터(pages/ws-edit.ts)가 동일한 본문
// 삽입 버튼(포맷/구분선/인용/목록/그리드/표/링크/위키링크/틀/각주/펼치기·접기/
// 인라인코드/코드블록)과 위키 전용 모달 버튼(타임스탬프/특수문자/아이콘/카드·구조·
// 팔레트·배지/지도 등)을 갖도록 단일 소스에서 생성한다. 우측 정렬되는 보기 모드/
// 설정 드롭다운은 각 에디터가 별도로 부착한다(setupTabSwitcher / main.ts 자체 구현).
export interface SharedToolbarOpts {
    /** 커서 위치에 raw 텍스트를 삽입한다(window.editor 셰임과 동일 동작이면 그쪽을 넘겨도 됨). */
    insertText: (text: string) => void;
    /** 이미지 버튼 동작. 'wiki-popup' 은 드래그앤드롭 + 기존 이미지 검색 팝업(위키),
     *  'ws-upload' 는 워크스페이스 미디어 업로드 핸들러를 직접 호출한다.
     *  'ws-upload' 모드에서만 handler 가 필요하다. */
    imageButton: { mode: 'wiki-popup' } | { mode: 'ws-upload'; handler: () => void };
    /** true 이면 위키 전용 모달 버튼(타임스탬프/특수문자/아이콘/카드·구조·팔레트·배지/지도)을
     *  추가한다. 해당 버튼은 edit-modals.js 가 노출하는 window.* 함수에 의존한다. */
    enableWikiModals: boolean;
}

export function buildSharedToolbar(
    toolbar: HTMLElement,
    view: any, // EditorView
    opts: SharedToolbarOpts
): void {
    const w = window as any;
    const { wrapSelection, insertPrefix, insertOrWrapWikiBlock } = makeFormatHelpers(view);
    const insertText = opts.insertText;

    // ── 포맷 ──
    toolbar.appendChild(createToolbarBtn('<b>H</b>', '제목', () => insertPrefix('## ')));
    toolbar.appendChild(createToolbarBtn('<b>B</b>', '굵게', () => wrapSelection('**', '**')));
    toolbar.appendChild(createToolbarBtn('<i>I</i>', '기울임', () => wrapSelection('*', '*')));
    toolbar.appendChild(createToolbarBtn('<s>S</s>', '취소선', () => wrapSelection('~~', '~~')));
    toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-format-underline"></i>', '밑줄', () => wrapSelection('__', '__')));
    toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-marker"></i>', '형광펜', () => wrapSelection('==', '==')));
    toolbar.appendChild(createToolbarSep());
    // ── 구분선/인용 ──
    toolbar.appendChild(createToolbarBtn('─', '구분선', () => insertText('\n---\n')));
    toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-format-quote-close"></i>', '인용', () => insertPrefix('> ')));
    toolbar.appendChild(createToolbarSep());
    // ── 목록 ──
    toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-format-list-bulleted"></i>', '목록', () => insertPrefix('- ')));
    toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-format-list-numbered"></i>', '번호 목록', () => insertPrefix('1. ')));
    toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-checkbox-marked-outline"></i>', '체크리스트', () => insertPrefix('- [ ] ')));
    toolbar.appendChild(createToolbarSep());
    // ── 그리드/row ──
    toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-view-grid-outline"></i>', '그리드', () => insertOrWrapWikiBlock('grid')));
    toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-view-week-outline"></i>', 'row(가로 배치)', () => insertOrWrapWikiBlock('row')));
    toolbar.appendChild(createToolbarSep());
    // ── 표 ──
    // setupTableInsertPopover(edit-modals.js)이 로드돼 있으면 팝오버를, 아니면 기본 스니펫을 삽입한다.
    // edit-modals.js 는 위키 에디터와 워크스페이스 에디터 모두 로드하므로 enableWikiModals 와 무관하다.
    const tableBtn = createToolbarBtn('<i class="mdi mdi-table"></i>', '표', () => { });
    toolbar.appendChild(tableBtn);
    if (typeof w.setupTableInsertPopover === 'function') {
        w.setupTableInsertPopover(tableBtn);
    } else {
        tableBtn.addEventListener('click', () => insertText('\n| 머리글1 | 머리글2 |\n| --- | --- |\n| 셀1 | 셀2 |\n'));
    }
    toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-link-variant"></i>', '링크', () => wrapSelection('[', '](url)')));
    toolbar.appendChild(createToolbarSep());

    // ── 위키 문법 버튼(모달 비의존) ──
    toolbar.appendChild(createToolbarBtn('[[ ]]', '위키 링크 삽입', () => insertText('[[문서제목]]')));
    toolbar.appendChild(createToolbarBtn('{{ }}', '틀 삽입', () => insertText('{{틀제목}}')));
    toolbar.appendChild(createToolbarBtn('[*]', '각주 삽입', () => insertText('[* 각주 내용]')));
    toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-form-dropdown"></i>', '펼치기 접기', () => insertText('[+ 펼치기/접기 제목]\n여기에 숨겨진 내용이 들어갑니다.\n[-]')));

    // ── edit-modals.js 에 의존하되 API 독립적인 버튼(위키·워크스페이스 공용) ──
    // window.* 함수가 아직 로드되지 않은 경우 optional chain 으로 no-op 처리한다.
    toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-calendar-clock"></i>', '타임스탬프 삽입', () => w.openTimestampInsertModal?.()));
    toolbar.appendChild(createToolbarSep());
    const specialCharBtn = createToolbarBtn('<span class="cm-toolbar-omega">Ω</span>', '특수문자 삽입', () => { });
    toolbar.appendChild(specialCharBtn);
    if (typeof w.setupSpecialCharPicker === 'function') w.setupSpecialCharPicker(specialCharBtn);
    toolbar.appendChild(createToolbarSep());
    if (w.selectedIconsOnly) {
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-vector-square"></i>', '아이콘 삽입', () => w.openSelectedIconsPicker?.()));
    } else {
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-vector-square"></i>', 'MDI 아이콘', () => w.openIconPicker?.('mdi')));
        toolbar.appendChild(createToolbarBtn('<i class="bi bi-bootstrap-fill"></i>', 'Bootstrap 아이콘', () => w.openIconPicker?.('bi')));
    }
    toolbar.appendChild(createToolbarSep());
    toolbar.appendChild(createToolbarBtn('<i class="bi bi-card-heading"></i>', '카드 블록', () => w.openCardInsertModal?.()));
    toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-view-dashboard-outline"></i>', '탭 / 아코디언 / 진행상황', () => w.openStructureBlockInsertModal?.()));
    toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-palette-outline"></i>', '색상 삽입', () => w.openPaletteColorModal?.()));
    toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-label-outline"></i>', '배지', () => w.openBadgeInsertModal?.()));

    // ── 위키 전용 버튼(워크스페이스 문서 목록 / 검색 API 의존) ──
    if (opts.enableWikiModals) {
        toolbar.appendChild(createToolbarBtn('<i class="bi bi-diagram-3-fill"></i>', '하위 문서', () => w.openSubdocInsertModal?.()));
    }
    toolbar.appendChild(createToolbarSep());
    // ── 코드 ──
    toolbar.appendChild(createToolbarBtn('<code>&lt;/&gt;</code>', '인라인 코드', () => wrapSelection('`', '`')));
    toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-code-braces"></i>', '코드 블록', () => wrapSelection('\n```\n', '\n```\n')));

    toolbar.appendChild(createToolbarSep());
    toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-google-maps"></i>', '구글 지도 삽입', () => w.openGoogleMapsEmbedModal?.()));

    // ── 이미지 ──
    toolbar.appendChild(createToolbarSep());
    const imgBtn = opts.imageButton;
    if (imgBtn.mode === 'wiki-popup') {
        buildImageUploadPopupButton(toolbar, insertText);
    } else {
        const btn = createToolbarBtn('<i class="mdi mdi-image-plus"></i>', '이미지 업로드', () => imgBtn.handler());
        btn.id = 'wsEditMediaBtn';
        toolbar.appendChild(btn);
    }
}

// 위키 에디터용 이미지 업로드 버튼 + 드래그앤드롭/기존 이미지 검색 팝업.
// window.handleImageUpload / window.openExistingImageSearch(edit-modals.js)에 의존한다.
function buildImageUploadPopupButton(toolbar: HTMLElement, insertText: (text: string) => void): void {
    const w = window as any;
    const imageUploadBtn = createToolbarBtn('<i class="mdi mdi-image-plus"></i>', '이미지 업로드', () => { });
    toolbar.appendChild(imageUploadBtn);

    const insertImage = (url: string, alt: string, size?: string) => {
        let insertTxt = `![${alt}](${url})`;
        if (size && size !== 'full') insertTxt += `{size:${size}}`;
        insertTxt += '\n';
        insertText(insertTxt);
    };

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

    const imgDropzone = imgUploadPopup.querySelector('.img-upload-dropzone') as HTMLElement;
    const imgSearchBtn = imgUploadPopup.querySelector('.img-upload-search-btn') as HTMLElement;

    imgSearchBtn.addEventListener('click', async () => {
        imgUploadPopup.classList.remove('active');
        await w.openExistingImageSearch?.((url: string, alt: string, size: string) => insertImage(url, alt, size));
    });

    const imgFileInput = document.createElement('input');
    imgFileInput.type = 'file';
    imgFileInput.accept = 'image/jpeg,image/png,image/gif,image/webp,image/svg+xml';
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
        if (!imgUploadPopup.contains(e.target as Node) && !imageUploadBtn.contains(e.target as Node)) {
            imgUploadPopup.classList.remove('active');
        }
    });

    imgDropzone.addEventListener('click', () => { imgFileInput.click(); });

    imgFileInput.addEventListener('change', async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        imgUploadPopup.classList.remove('active');
        await w.handleImageUpload?.(file, (url: string, alt: string, size: string) => insertImage(url, alt, size));
        imgFileInput.value = '';
    });

    imgDropzone.addEventListener('dragenter', (e) => { e.preventDefault(); imgDropzone.classList.add('dragover'); });
    imgDropzone.addEventListener('dragover', (e) => { e.preventDefault(); (e as DragEvent).dataTransfer!.dropEffect = 'copy'; });
    imgDropzone.addEventListener('dragleave', (e) => { e.preventDefault(); imgDropzone.classList.remove('dragover'); });
    imgDropzone.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        imgDropzone.classList.remove('dragover');
        const files = (e as DragEvent).dataTransfer?.files;
        if (!files || files.length === 0) return;
        const file = files[0];
        const acceptTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
        if (!acceptTypes.includes(file.type)) {
            w.Swal?.fire('오류', '지원하지 않는 파일 형식입니다.', 'warning');
            return;
        }
        imgUploadPopup.classList.remove('active');
        await w.handleImageUpload?.(file, (url: string, alt: string, size: string) => insertImage(url, alt, size));
    });
}

// ── 에디터 레이아웃 HTML (전폭 툴바 + 좌우 분할 + 모바일 탭) ──
// 위키 에디터와 워크스페이스 에디터가 동일한 .wiki-editor-layout 구조/CSS 를 공유한다.
// CM 마운트 지점은 #cm-editor, 프리뷰 컨테이너는 #custom-wiki-preview(.wiki-content) 이다.
export interface EditorLayoutOptions {
    /** 프레젠테이션 통합 슬라이드 편집용 추가 존(위키 에디터 전용). */
    slideZones?: boolean;
    /** 에디터 전용 플로팅 목차 패널 + 스크롤 FAB(위키 에디터 전용). */
    tocFab?: boolean;
}

export function buildEditorLayoutHTML(opts: EditorLayoutOptions = {}): string {
    const slideZones = !!opts.slideZones;
    const tocFab = !!opts.tocFab;

    const slideTop = slideZones ? `
                        <div class="slide-add-zone slide-add-zone-top" id="slideAddZoneTop" hidden>
                            <i class="mdi mdi-plus-circle-outline"></i>
                            <div class="slide-add-main">위에 새 슬라이드</div>
                            <div class="slide-add-sub">현재 슬라이드 앞에 빈 슬라이드 추가</div>
                        </div>` : '';
    const slideBottom = slideZones ? `
                        <div class="slide-add-zone slide-add-zone-bottom" id="slideAddZoneBottom" hidden>
                            <i class="mdi mdi-plus-circle-outline"></i>
                            <div class="slide-add-main">아래에 새 슬라이드</div>
                            <div class="slide-add-sub">현재 슬라이드 뒤에 빈 슬라이드 추가</div>
                        </div>
                        <div class="slide-edit-nav" id="slideEditNav" hidden role="toolbar" aria-label="슬라이드 이동">
                            <button type="button" class="slide-edit-nav-btn" data-slide-nav="prev" aria-label="이전 슬라이드"><i class="bi bi-chevron-left"></i></button>
                            <span class="slide-edit-nav-indicator" id="slideEditNavIndicator" aria-live="polite">1 / 1</span>
                            <button type="button" class="slide-edit-nav-btn" data-slide-nav="next" aria-label="다음 슬라이드"><i class="bi bi-chevron-right"></i></button>
                            <button type="button" class="slide-edit-nav-btn slide-edit-nav-btn-overview" data-slide-nav="overview" title="전체 보기 (그리드)" aria-label="전체 슬라이드 그리드 보기" aria-pressed="false"><i class="bi bi-grid-3x3-gap"></i></button>
                            <button type="button" class="slide-edit-nav-btn slide-edit-nav-btn-fullscreen" data-slide-nav="fullscreen" title="전체 화면" aria-label="전체 화면 전환"><i class="bi bi-arrows-fullscreen"></i></button>
                        </div>` : '';
    const tocFabHtml = tocFab ? `
                    <div class="toc-floating-panel" id="editorTocFloatingPanel">
                        <div class="toc-floating-header">
                            <span><i class="mdi mdi-format-list-bulleted-square me-1"></i> 목차</span>
                        </div>
                        <nav class="toc-floating-body" id="editorTocFloatingNav"></nav>
                    </div>
                    <div class="scroll-fab-group" id="editorScrollFabGroup">
                        <button class="scroll-fab" id="editorTocFabBtn" onclick="toggleEditorFloatingToc()" title="목차">
                            <i class="mdi mdi-format-list-bulleted-square"></i>
                        </button>
                    </div>` : '';

    return `
            <div class="wiki-editor-layout">
                <div class="cm-mobile-tabs" id="cm-mobile-tabs">
                    <button class="cm-tab-btn active" data-tab="editor"><i class="mdi mdi-pencil"></i> 에디터</button>
                    <button class="cm-tab-btn" data-tab="preview"><i class="mdi mdi-eye"></i> 프리뷰</button>
                </div>
                <div id="cm-toolbar" class="cm-toolbar"></div>
                <div class="wiki-editor-split-row" id="wiki-editor-split-row">
                    <div class="wiki-editor-pane" id="cm-editor-pane">${slideTop}
                        <div id="cm-editor"></div>${slideBottom}
                    </div>
                    <div class="wiki-preview-pane" id="custom-wiki-preview"></div>${tocFabHtml}
                </div>
            </div>
        `;
}

// ── 모바일 탭(에디터/프리뷰) + PC 보기 모드(일반/작성/보기) 스위처 ──
// 위키 에디터의 PC 모드 토글은 프레젠테이션 슬라이드 편집과 얽혀 있어 main.ts 가 자체
// 구현하지만, 워크스페이스 에디터처럼 슬라이드가 없는 단순 경로는 이 헬퍼로 공유한다.
export interface TabSwitcherOptions {
    /** PC 모드 변경 시 호출(프리뷰 재측정 등). */
    onModeChange?: (mode: 'split' | 'edit' | 'preview') => void;
    /** 모바일 탭 변경 시 호출. */
    onTabChange?: (tab: 'editor' | 'preview') => void;
    /** 프리뷰 탭/모드로 전환될 때 프리뷰를 갱신하기 위한 콜백. */
    onPreviewShown?: () => void;
}

export interface TabSwitcher {
    setPcMode(mode: 'split' | 'edit' | 'preview'): void;
    activateTab(tab: 'editor' | 'preview'): void;
}

const PC_MODES: Record<string, { icon: string; label: string; desc: string }> = {
    split: { icon: 'mdi-view-split-vertical', label: '일반 모드', desc: '에디터 + 프리뷰' },
    edit: { icon: 'mdi-pencil', label: '작성 모드', desc: '에디터만' },
    preview: { icon: 'mdi-eye-outline', label: '보기 모드', desc: '프리뷰만' },
};

// 워크스페이스 에디터용 경량 탭/모드 스위처. cm-toolbar 끝에 PC 모드 드롭다운 버튼을
// 추가하고, #cm-mobile-tabs 의 탭 버튼을 와이어링한다. 반환 핸들로 외부에서도 제어 가능.
export function setupTabSwitcher(
    layoutEl: HTMLElement,
    toolbarEl: HTMLElement,
    opts: TabSwitcherOptions = {}
): TabSwitcher {
    const editorPane = layoutEl.querySelector('.wiki-editor-pane') as HTMLElement | null;
    const previewPane = layoutEl.querySelector('.wiki-preview-pane') as HTMLElement | null;

    // ── 모바일 탭 ──
    let activeTab: 'editor' | 'preview' = 'editor';
    function activateTab(tab: 'editor' | 'preview') {
        activeTab = tab;
        layoutEl.dataset.activeTab = tab;
        layoutEl.querySelectorAll('.cm-tab-btn').forEach((b) => {
            b.classList.toggle('active', (b as HTMLElement).dataset.tab === tab);
        });
        editorPane?.classList.toggle('cm-tab-active', tab === 'editor');
        previewPane?.classList.toggle('cm-tab-active', tab === 'preview');
        if (tab === 'preview') opts.onPreviewShown?.();
        opts.onTabChange?.(tab);
    }
    layoutEl.querySelectorAll('.cm-tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => activateTab((btn as HTMLElement).dataset.tab as 'editor' | 'preview'));
    });
    activateTab('editor');

    // ── PC 보기 모드 드롭다운 ──
    let currentPcMode: 'split' | 'edit' | 'preview' = 'split';
    const modeBtn = createToolbarBtn(
        `<i class="mdi ${PC_MODES.split.icon}"></i><i class="mdi mdi-menu-down cm-toolbar-caret"></i>`,
        '보기 방식 전환',
        () => toggleModePanel()
    );
    modeBtn.id = 'cm-mode-btn';
    modeBtn.classList.add('cm-toolbar-btn-pc-only', 'cm-toolbar-btn-mode');
    // 우측 정렬: margin-left auto 로 툴바 끝에 붙인다.
    modeBtn.style.marginLeft = 'auto';
    toolbarEl.appendChild(modeBtn);

    const modePanel = document.createElement('div');
    modePanel.className = 'editor-settings-panel editor-mode-panel';
    modePanel.style.display = 'none';
    document.body.appendChild(modePanel);

    function renderModePanel() {
        modePanel.innerHTML = (['split', 'edit', 'preview'] as const).map((key) => {
            const m = PC_MODES[key];
            return `
            <button type="button" class="editor-mode-option" data-mode="${key}">
                <i class="mdi ${m.icon}"></i>
                <span class="editor-mode-option-text">
                    <span class="editor-mode-option-label">${m.label}</span>
                    <span class="editor-mode-option-desc">${m.desc}</span>
                </span>
                <i class="mdi mdi-check editor-mode-option-check"></i>
            </button>`;
        }).join('');
        modePanel.querySelectorAll('.editor-mode-option').forEach((opt) => {
            opt.classList.toggle('active', (opt as HTMLElement).dataset.mode === currentPcMode);
            opt.addEventListener('click', () => {
                setPcMode((opt as HTMLElement).dataset.mode as 'split' | 'edit' | 'preview');
                modePanel.style.display = 'none';
            });
        });
    }

    function positionModePanel() {
        // display:block 이후 호출되므로 offsetWidth/Height 측정 가능.
        const rect = modeBtn.getBoundingClientRect();
        const margin = 8;
        const panelW = modePanel.offsetWidth;
        const panelH = modePanel.offsetHeight;
        const viewportH = document.documentElement.clientHeight;
        modePanel.style.position = 'absolute';
        // 기본은 버튼 아래. 아래 공간이 부족하고 위 공간이 충분하면 버튼 위로 flip 후 뷰포트 안에 클램프.
        let top = rect.bottom + 4;
        if (top + panelH + margin > viewportH && rect.top - panelH - 4 >= margin) {
            top = rect.top - panelH - 4;
        }
        top = Math.max(margin, Math.min(top, viewportH - panelH - margin));
        modePanel.style.top = (top + window.scrollY) + 'px';
        // 버튼 우측 끝에 정렬하되 좌측 경계 밖으로 나가지 않게 클램프.
        const left = Math.max(margin, rect.right + window.scrollX - panelW);
        modePanel.style.left = left + 'px';
    }

    function toggleModePanel() {
        if (modePanel.style.display === 'none') {
            renderModePanel();
            modePanel.style.display = 'block';
            positionModePanel();
        } else {
            modePanel.style.display = 'none';
        }
    }

    document.addEventListener('click', (e) => {
        if (!modePanel.contains(e.target as Node) && !modeBtn.contains(e.target as Node)) {
            modePanel.style.display = 'none';
        }
    });

    function setPcMode(mode: 'split' | 'edit' | 'preview') {
        if (!PC_MODES[mode]) mode = 'split';
        currentPcMode = mode;
        if (mode === 'split') delete layoutEl.dataset.pcMode;
        else layoutEl.dataset.pcMode = mode;
        const m = PC_MODES[mode];
        modeBtn.innerHTML = `<i class="mdi ${m.icon}"></i><i class="mdi mdi-menu-down cm-toolbar-caret"></i>`;
        modeBtn.title = `보기 방식: ${m.label}`;
        modeBtn.classList.toggle('active', mode !== 'split');
        if (mode !== 'edit') opts.onPreviewShown?.();
        opts.onModeChange?.(mode);
    }

    return { setPcMode, activateTab };
}
