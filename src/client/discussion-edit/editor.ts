/**
 * 토론·티켓용 미니 마크다운 에디터 (CodeMirror 6 기반).
 *
 * 위키 풀 에디터(src/client/edit/main.ts) 와 달리:
 *   - 한 페이지에 여러 인스턴스가 동시에 떠도 충돌하지 않는다 (싱글톤 window.editor 미사용).
 *   - 위키 모달/자동완성/충돌해결/슬러그 드래프트 저장은 비포함.
 *   - 툴바는 B/I/링크/이미지/인용/코드 만.
 *   - 이미지 업로드는 edit/image.ts 의 window.openExistingImageSearch /
 *     window.handleImageUpload 를 그대로 재사용 (둘 다 페이지 컨텍스트 의존 없음).
 *
 * CodeMirror 6 패키지는 vite external + HTML 의 importmap (esm.sh) 으로 해석된다.
 * import 는 dynamic 으로 수행해 esm.sh unreachable 시 다른 페이지 로직(인증/스크립트)
 * 이 살아남도록 한다.
 *
 * 사용 예 (discussions.html / tickets.html 에서):
 *   const handle = await createMiniEditor(rootEl, {
 *       initialValue: '',
 *       placeholder: '토론 내용을 입력하세요',
 *       onChange: () => { ... },
 *   });
 *   handle.getValue();    // 현재 본문
 *   handle.setValue('');  // 본문 교체
 *   handle.focus();
 *   handle.destroy();     // 마운트 해제 (페이지 SPA 라우팅 시)
 */

declare global {
    interface Window {
        openExistingImageSearch?: (cb: (url: string, alt: string, size: string) => void) => Promise<void>;
        handleImageUpload?: (blob: File | Blob | null, cb: (url: string, alt: string, size: string) => void) => Promise<void>;
    }
}

export interface MiniEditorOptions {
    initialValue?: string;
    placeholder?: string;
    onChange?: (value: string) => void;
}

export interface MiniEditorHandle {
    getValue: () => string;
    setValue: (value: string) => void;
    focus: () => void;
    destroy: () => void;
    insertText: (text: string) => void;
    /** root 컨테이너 (caller 가 disable / style 등 부착할 때 사용) */
    root: HTMLElement;
}

let darkModeMql: MediaQueryList | null = null;
function getIsDarkMode(): boolean {
    const themeAttr = document.documentElement.getAttribute('data-theme');
    if (themeAttr === 'dark') return true;
    if (themeAttr === 'light') return false;
    if (!darkModeMql && typeof window.matchMedia === 'function') {
        darkModeMql = window.matchMedia('(prefers-color-scheme: dark)');
    }
    return !!darkModeMql?.matches;
}

/** B/I/링크/이미지/인용/코드 + Markdown 이미지 삽입 헬퍼.
 *  EditorView dispatch 를 직접 호출해 어떤 인스턴스든 caller 의 view 만 조작. */
function makeToolbar(view: any, EditorView: any): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'mini-editor-toolbar';

    function wrap(prefix: string, suffix: string, placeholder = '텍스트'): void {
        const { main } = view.state.selection;
        const selected = view.state.sliceDoc(main.from, main.to);
        const inner = selected || placeholder;
        const text = prefix + inner + suffix;
        view.dispatch({
            changes: { from: main.from, to: main.to, insert: text },
            selection: {
                anchor: main.from + prefix.length,
                head: main.from + prefix.length + inner.length,
            },
        });
        view.focus();
    }

    function insertLinePrefix(prefix: string): void {
        const { main } = view.state.selection;
        const line = view.state.doc.lineAt(main.from);
        view.dispatch({
            changes: { from: line.from, to: line.from, insert: prefix },
        });
        view.focus();
    }

    function insertText(text: string): void {
        const { main } = view.state.selection;
        view.dispatch({
            changes: { from: main.from, to: main.to, insert: text },
            selection: { anchor: main.from + text.length },
        });
        view.focus();
    }

    function makeBtn(html: string, title: string, onClick: () => void): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mini-editor-btn';
        btn.innerHTML = html;
        btn.title = title;
        btn.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
        return btn;
    }

    function makeSep(): HTMLElement {
        const s = document.createElement('span');
        s.className = 'mini-editor-sep';
        return s;
    }

    bar.appendChild(makeBtn('<b>B</b>', '굵게', () => wrap('**', '**')));
    bar.appendChild(makeBtn('<i>I</i>', '기울임', () => wrap('*', '*')));
    bar.appendChild(makeBtn('<s>S</s>', '취소선', () => wrap('~~', '~~')));
    bar.appendChild(makeSep());
    bar.appendChild(makeBtn('<i class="mdi mdi-format-quote-close"></i>', '인용', () => insertLinePrefix('> ')));
    bar.appendChild(makeBtn('<i class="mdi mdi-format-list-bulleted"></i>', '목록', () => insertLinePrefix('- ')));
    bar.appendChild(makeSep());
    bar.appendChild(makeBtn('<code>&lt;/&gt;</code>', '인라인 코드', () => wrap('`', '`')));
    bar.appendChild(makeBtn('<i class="mdi mdi-code-braces"></i>', '코드 블록', () => wrap('\n```\n', '\n```\n')));
    bar.appendChild(makeSep());
    bar.appendChild(makeBtn('<i class="mdi mdi-link-variant"></i>', '링크', () => wrap('[', '](url)', '텍스트')));

    // 이미지 버튼: 클릭 시 두 버튼(업로드/기존검색) 메뉴 표시
    const imgBtn = makeBtn('<i class="mdi mdi-image-plus"></i>', '이미지', () => { });
    const imgMenu = document.createElement('div');
    imgMenu.className = 'mini-editor-img-menu';
    imgMenu.style.display = 'none';

    const uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.className = 'mini-editor-img-menu-btn';
    uploadBtn.innerHTML = '<i class="mdi mdi-cloud-upload-outline"></i> 새 이미지 업로드';

    const searchBtn = document.createElement('button');
    searchBtn.type = 'button';
    searchBtn.className = 'mini-editor-img-menu-btn';
    searchBtn.innerHTML = '<i class="mdi mdi-magnify"></i> 기존 이미지 검색';

    imgMenu.appendChild(uploadBtn);
    imgMenu.appendChild(searchBtn);

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/ogg';
    fileInput.style.display = 'none';
    imgMenu.appendChild(fileInput);

    const imgWrapper = document.createElement('span');
    imgWrapper.className = 'mini-editor-img-wrapper';
    imgWrapper.appendChild(imgBtn);
    imgWrapper.appendChild(imgMenu);

    imgBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        imgMenu.style.display = (imgMenu.style.display === 'none') ? 'flex' : 'none';
    });
    document.addEventListener('click', (e) => {
        if (!imgWrapper.contains(e.target as Node)) imgMenu.style.display = 'none';
    });

    uploadBtn.addEventListener('click', () => {
        imgMenu.style.display = 'none';
        fileInput.click();
    });
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (!file || !window.handleImageUpload) {
            fileInput.value = '';
            return;
        }
        await window.handleImageUpload(file, (url, alt, size) => {
            let md = `![${alt}](${url})`;
            if (size && size !== 'full') md += `{size:${size}}`;
            insertText(md + '\n');
        });
        fileInput.value = '';
    });
    searchBtn.addEventListener('click', async () => {
        imgMenu.style.display = 'none';
        if (!window.openExistingImageSearch) return;
        await window.openExistingImageSearch((url, alt, size) => {
            let md = `![${alt}](${url})`;
            if (size && size !== 'full') md += `{size:${size}}`;
            insertText(md + '\n');
        });
    });

    bar.appendChild(imgWrapper);

    return bar;
}

/**
 * 미니 에디터를 rootEl 안에 마운트한다. rootEl 의 기존 내용은 비워진다.
 * CM6 패키지는 importmap 으로 동적 로드.
 */
export async function createMiniEditor(
    rootEl: HTMLElement,
    options: MiniEditorOptions = {}
): Promise<MiniEditorHandle> {
    const [cmState, cmView, cmCommands, cmLanguage, cmMarkdown, cmLangData, cmOneDark] = await Promise.all([
        import('@codemirror/state'),
        import('@codemirror/view'),
        import('@codemirror/commands'),
        import('@codemirror/language'),
        import('@codemirror/lang-markdown'),
        import('@codemirror/language-data'),
        import('@codemirror/theme-one-dark'),
    ]);

    const { EditorState, Compartment } = cmState;
    const { EditorView, keymap, drawSelection, placeholder } = cmView;
    const { defaultKeymap, history, historyKeymap } = cmCommands;
    const { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput } = cmLanguage;
    const { markdown, markdownLanguage } = cmMarkdown;
    const { languages } = cmLangData;
    const { oneDark } = cmOneDark;

    rootEl.innerHTML = '';
    rootEl.classList.add('mini-editor-root');

    const themeCompartment = new Compartment();

    const editorHost = document.createElement('div');
    editorHost.className = 'mini-editor-host';

    const placeholderText = options.placeholder ?? '';

    let state = EditorState.create({
        doc: options.initialValue ?? '',
        extensions: [
            history(),
            keymap.of([...defaultKeymap, ...historyKeymap]),
            drawSelection(),
            markdown({ base: markdownLanguage, codeLanguages: languages }),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            bracketMatching(),
            indentOnInput(),
            EditorView.lineWrapping,
            themeCompartment.of(getIsDarkMode() ? oneDark : []),
            placeholderText ? placeholder(placeholderText) : [],
            EditorView.updateListener.of((u: any) => {
                if (u.docChanged && options.onChange) {
                    options.onChange(u.state.doc.toString());
                }
            }),
            // 드래그앤드롭 / 붙여넣기 이미지: handleImageUpload 가 있을 때만 동작
            EditorView.domEventHandlers({
                drop(event: DragEvent, view: any) {
                    const files = event.dataTransfer?.files;
                    if (!files || files.length === 0) return false;
                    const file = files[0];
                    if (!/^image\//.test(file.type) && !/^video\//.test(file.type)) return false;
                    event.preventDefault();
                    if (!window.handleImageUpload) return true;
                    window.handleImageUpload(file, (url, alt, size) => {
                        let md = `![${alt}](${url})`;
                        if (size && size !== 'full') md += `{size:${size}}`;
                        md += '\n';
                        const { main } = view.state.selection;
                        view.dispatch({
                            changes: { from: main.from, to: main.to, insert: md },
                            selection: { anchor: main.from + md.length },
                        });
                    });
                    return true;
                },
                paste(event: ClipboardEvent, view: any) {
                    const items = event.clipboardData?.items;
                    if (!items) return false;
                    for (const item of Array.from(items)) {
                        if (item.kind === 'file' && /^image\//.test(item.type)) {
                            const file = item.getAsFile();
                            if (!file) continue;
                            event.preventDefault();
                            if (!window.handleImageUpload) return true;
                            window.handleImageUpload(file, (url, alt, size) => {
                                let md = `![${alt}](${url})`;
                                if (size && size !== 'full') md += `{size:${size}}`;
                                md += '\n';
                                const { main } = view.state.selection;
                                view.dispatch({
                                    changes: { from: main.from, to: main.to, insert: md },
                                    selection: { anchor: main.from + md.length },
                                });
                            });
                            return true;
                        }
                    }
                    return false;
                },
            }),
        ],
    });

    const view = new EditorView({ state, parent: editorHost });

    // 테마 동적 갱신 (사용자가 다크/라이트 토글 시)
    function syncTheme(): void {
        view.dispatch({ effects: themeCompartment.reconfigure(getIsDarkMode() ? oneDark : []) });
    }
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mql = (typeof window.matchMedia === 'function') ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const mqlHandler = () => syncTheme();
    mql?.addEventListener?.('change', mqlHandler);

    const toolbar = makeToolbar(view, EditorView);
    rootEl.appendChild(toolbar);
    rootEl.appendChild(editorHost);

    return {
        root: rootEl,
        getValue() { return view.state.doc.toString(); },
        setValue(value: string) {
            view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: value },
            });
        },
        focus() { view.focus(); },
        insertText(text: string) {
            const { main } = view.state.selection;
            view.dispatch({
                changes: { from: main.from, to: main.to, insert: text },
                selection: { anchor: main.from + text.length },
            });
            view.focus();
        },
        destroy() {
            observer.disconnect();
            mql?.removeEventListener?.('change', mqlHandler);
            view.destroy();
            rootEl.innerHTML = '';
            rootEl.classList.remove('mini-editor-root');
        },
    };
}

// HTML 인라인 스크립트가 동기 호출할 수 있도록 window 에 노출.
declare global {
    interface Window {
        createMiniEditor?: typeof createMiniEditor;
    }
}
window.createMiniEditor = createMiniEditor;
