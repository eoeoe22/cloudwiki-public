/* eslint-disable @typescript-eslint/no-explicit-any */
// 위키 문법 CodeMirror6 인라인 하이라이트 플러그인 단일 소스.
//
// 문서 에디터(edit/main.ts)와 개방 메모장(pages/memo.ts)이 동일한 위키 문법
// 데코레이션(위키 링크 `[[..]]`, 틀 `{{..}}`/`{{{..}}}`, 정렬 마커, 아이콘 마커/위젯,
// 색·팔레트 배지, 형광펜 `==..==`, 강조/기울임/밑줄/취소선, 타임스탬프, 인라인 코드,
// 인용/목록 마커, 코드펜스/접기/헤딩 줄 스타일)을 공유하도록 일원화한다.
//
// CodeMirror 모듈은 두 진입점 모두 런타임 동적 import(esm.sh importmap, vite external)
// 로 받으므로, 이 파일은 CM 을 정적 import 하지 않고 필요한 생성자(EditorView/
// MatchDecorator/ViewPlugin/Decoration/WidgetType/RangeSetBuilder)를 인자로 받는다
// (번들에 CM 정적 의존성을 추가하지 않기 위함 — cm-shared.ts 와 동일한 패턴).

export interface WikiHighlightCM {
    EditorView: any;
    MatchDecorator: any;
    ViewPlugin: any;
    Decoration: any;
    WidgetType: any;
    RangeSetBuilder: any;
}

export interface WikiHighlightOptions {
    /** 라이브 다크모드 여부. 팔레트 배지/형광펜 색 해석 시 매 데코 계산에서 호출된다. */
    getIsDark: () => boolean;
}

export interface WikiHighlightPlugins {
    /** 문법 하이라이트가 켜져 있을 때 항상 적용되는 기본 데코레이션 플러그인. */
    base: any[];
    /** 고급 편집(아이콘 위젯 · 색/팔레트 배지 미리보기). advancedEdit 가 켜졌을 때만 적용. */
    advanced: any[];
}

/**
 * 위키 문법 하이라이트 플러그인 묶음을 생성한다.
 * 반환된 `base`/`advanced` 배열은 호출 측이 Compartment 로 감싸 동적 on/off 한다.
 * (markdown() · syntaxHighlighting() 등 lang-markdown 기반 확장은 호출 측이 별도로 조합한다.)
 */
export function buildWikiHighlightPlugins(cm: WikiHighlightCM, opts: WikiHighlightOptions): WikiHighlightPlugins {
    const { MatchDecorator, ViewPlugin, Decoration, WidgetType, RangeSetBuilder } = cm;
    const w = window as any;
    const getIsDark = opts.getIsDark;

    // matcher → ViewPlugin 어댑터
    const makePlugin = (matcher: any) => ViewPlugin.fromClass(class {
        decorations: any;
        constructor(view: any) { this.decorations = matcher.createDeco(view); }
        update(update: any) { this.decorations = matcher.updateDeco(update, this.decorations); }
    }, { decorations: (v: any) => v.decorations });

    // 인라인 코드(백틱) 내부 위치인지 확인하는 헬퍼
    const isInInlineCode = (state: any, pos: number) => {
        const line = state.doc.lineAt(pos);
        const relPos = pos - line.from;
        const re = /`[^`]+`/g;
        let m;
        while ((m = re.exec(line.text)) !== null) {
            if (relPos >= m.index && relPos < m.index + m[0].length) return true;
        }
        return false;
    };

    const wikiLinkMatcher = new MatchDecorator({
        regexp: /\[\[([^\]]*)\]\]/g,
        decoration: (match: any, view: any, pos: number) => {
            if (isInInlineCode(view.state, pos)) return null;
            return Decoration.mark({ class: "cm-wiki-link" });
        }
    });
    const wikiLinkPlugin = makePlugin(wikiLinkMatcher);

    const templateMatcher = new MatchDecorator({
        // {{{...}}} 파라미터 참조는 제외 (lookbehind + lookahead 사용).
        // 파서 함수 {{#if:}}/{{#ifeq:}}/{{#switch:}}/{{#expr:}} 도 제외 — parserFuncMatcher 가 별도 색으로 처리.
        regexp: /(?<!\{)\{\{(?!\{)(?!\s*#(?:if|ifeq|switch|expr)\b\s*:)([^}]*)\}\}/gi,
        decoration: (match: any, view: any, pos: number) => {
            if (isInInlineCode(view.state, pos)) return null;
            return Decoration.mark({ class: "cm-wiki-template" });
        }
    });
    const templatePlugin = makePlugin(templateMatcher);

    // 틀 파서 함수 {{#if:}}/{{#ifeq:}}/{{#switch:}}/{{#expr:}} — 일반 틀 호출과 구분되는 색.
    // render.ts 의 _PARSER_FUNCTIONS 와 동일한 함수만 인식한다(대소문자 무시).
    // 렌더러 계약(`/^\s*#([a-zA-Z]+)\s*:/`)과 일치하도록 함수명 뒤 콜론을 필수로 둔다.
    const parserFuncMatcher = new MatchDecorator({
        regexp: /(?<!\{)\{\{(?!\{)\s*#(?:if|ifeq|switch|expr)\b\s*:[^}]*\}\}/gi,
        decoration: (match: any, view: any, pos: number) => {
            if (isInInlineCode(view.state, pos)) return null;
            return Decoration.mark({ class: "cm-wiki-parserfunc" });
        }
    });
    const parserFuncPlugin = makePlugin(parserFuncMatcher);

    // 틀 파라미터 참조 {{{이름}}} / {{{1}}} / {{{이름|기본값}}}
    const templateParamMatcher = new MatchDecorator({
        regexp: /\{\{\{([^{}|]+)(?:\|[^{}]*)?\}\}\}/g,
        decoration: (match: any, view: any, pos: number) => {
            if (isInInlineCode(view.state, pos)) return null;
            return Decoration.mark({ class: "cm-wiki-template-param" });
        }
    });
    const templateParamPlugin = makePlugin(templateParamMatcher);

    const alignMatcher = new MatchDecorator({
        regexp: /\{[<p^>><]+\}/g,
        decoration: (match: any, view: any, pos: number) => {
            if (isInInlineCode(view.state, pos)) return null;
            return Decoration.mark({ class: "cm-align-marker" });
        }
    });
    const alignPlugin = makePlugin(alignMatcher);

    // ── 인라인 아이콘 위젯 ({bi:}/{mdi:}/{icon:} 옆에 실제 아이콘 미리보기) ──
    class InlineIconWidget extends WidgetType {
        type: string;
        name: string;
        constructor(type: string, name: string) { super(); this.type = type; this.name = name; }
        eq(other: any) { return other.type === this.type && other.name === this.name; }
        toDOM() {
            const wrap = document.createElement('span');
            wrap.className = 'cm-inline-icon-widget';
            wrap.setAttribute('aria-hidden', 'true');
            let iconEl: HTMLElement | null = null;
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
        decoration: (match: any, view: any, pos: number) => {
            if (isInInlineCode(view.state, pos)) return null;
            return Decoration.mark({ class: "cm-icon-marker" });
        }
    });
    const iconMarkerPlugin = makePlugin(iconMarkerMatcher);

    const iconWidgetMatcher = new MatchDecorator({
        regexp: /\{(bi|mdi|icon):([^}\s]+)\}/g,
        decorate: (add: any, from: number, to: number, match: any, view: any) => {
            if (isInInlineCode(view.state, from)) return;
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
        decoration: (match: any, view: any, pos: number) => {
            if (isInInlineCode(view.state, pos)) return null;
            return Decoration.mark({
                class: "cm-color-badge",
                attributes: { style: `--badge-color: ${match[2]};` }
            });
        }
    });
    const colorBadgePlugin = makePlugin(colorBadgeMatcher);

    const paletteBadgeMatcher = new MatchDecorator({
        regexp: /\{palette:\s*([^}]+)\}/g,
        decoration: (match: any, view: any, pos: number) => {
            if (isInInlineCode(view.state, pos)) return null;
            const name = (match[1] || '').trim();
            // 빌트인 팔레트: 실제 렌더(mark.wiki-palette-NAME 클래스)와 동일하게 토큰 var() 로
            // 스와치를 표시해 테마/스킨/다크모드를 라이브 반영한다(.cm-palette-badge::after 가
            // --palette-bg/--palette-color 를 읽는다). var() 는 우리가 통제하는 토큰이라 안전.
            const builtins = w.WIKI_HARDCODED_PALETTES || {};
            if (Object.prototype.hasOwnProperty.call(builtins, name)) {
                return Decoration.mark({
                    class: "cm-palette-badge",
                    attributes: { style: `--palette-bg: var(--wiki-palette-${name}-bg); --palette-color: var(--wiki-palette-${name}-text);` }
                });
            }
            // 커스텀 팔레트: 모드별 hex 로 표시(임의값이라 인라인 hex 유지).
            let variant: any = null;
            try {
                const merged = (typeof w.getMergedWikiPalettes === 'function') ? w.getMergedWikiPalettes() : {};
                const entry = merged[name];
                if (entry) {
                    const isDark = getIsDark();
                    variant = isDark ? (entry.dark || entry.light) : (entry.light || entry.dark);
                }
            } catch (_) { /* noop */ }
            if (!variant) return null;
            const rawBg = variant.bg || 'transparent';
            const rawColor = variant.color || 'inherit';
            const safeBg = (typeof w._isSafeCssColor === 'function' && w._isSafeCssColor(rawBg)) ? rawBg : 'transparent';
            const safeColor = (typeof w._isSafeCssColor === 'function' && w._isSafeCssColor(rawColor)) ? rawColor : 'inherit';
            return Decoration.mark({
                class: "cm-palette-badge",
                attributes: { style: `--palette-bg: ${safeBg}; --palette-color: ${safeColor};` }
            });
        }
    });
    const paletteBadgePlugin = makePlugin(paletteBadgeMatcher);

    // 파라미터 토큰: {badge:}, {tag:}, {button:}, {stat:}, {size:}, {embed:}, {hr}
    // {{틀}} 과 충돌하지 않도록 앞뒤 중괄호 제외
    const paramTokenMatcher = new MatchDecorator({
        regexp: /(?<!\{)\{(?:hr|(?:badge|tag|button|stat|size|embed):[^}]+)\}(?!\})/g,
        decoration: (match: any, view: any, pos: number) => {
            if (isInInlineCode(view.state, pos)) return null;
            return Decoration.mark({ class: "cm-param-token" });
        }
    });
    const paramTokenPlugin = makePlugin(paramTokenMatcher);

    // ==text== 형광펜 — {color:..} / {bg:..} / {palette:..} 선행 토큰을 0개 이상 흡수하고
    // render.ts renderer 와 동일한 채널 우선 규칙(뒤 토큰이 우선)으로 최종 bg/color 를 산출해
    // 본문에만 데코를 적용한다. 선행 토큰 자체는 colorBadgePlugin / paletteBadgePlugin 이 별도 처리.
    //   - 빌트인 {palette:NAME}: 실제 렌더(클래스)와 동일하게 토큰 var(--wiki-palette-*) 로 풀어
    //     테마/스킨/다크모드를 반영(우리가 통제하는 토큰이라 _isSafeCssColor 우회).
    //   - 커스텀 {palette:NAME}: 모드별 hex(안전 검증), {bg:}/{color:}: 리터럴(안전 검증).
    const resolveHighlightStyle = (prefix: string) => {
        const builtins = w.WIKI_HARDCODED_PALETTES || {};
        const isSafe = (typeof w._isSafeCssColor === 'function') ? w._isSafeCssColor : () => false;
        let merged: any = null; // 커스텀은 필요 시에만 조회
        let bg = '', color = '';
        const re = /\{(palette|bg|color):\s*([^}]+?)\s*\}/g;
        let m;
        while ((m = re.exec(prefix)) !== null) {
            const kind = m[1];
            const val = m[2].trim();
            if (kind === 'bg') { bg = isSafe(val) ? val : ''; }
            else if (kind === 'color') { color = isSafe(val) ? val : ''; }
            else { // palette
                if (Object.prototype.hasOwnProperty.call(builtins, val)) {
                    bg = `var(--wiki-palette-${val}-bg)`;
                    color = `var(--wiki-palette-${val}-text)`;
                } else {
                    if (!merged) merged = (typeof w.getMergedWikiPalettes === 'function') ? w.getMergedWikiPalettes() : {};
                    const entry = merged[val];
                    if (entry) {
                        const variant = getIsDark() ? (entry.dark || entry.light) : (entry.light || entry.dark);
                        if (variant) {
                            if (variant.bg && isSafe(variant.bg)) bg = variant.bg;
                            if (variant.color && isSafe(variant.color)) color = variant.color;
                        }
                    }
                }
            }
        }
        return { bg, color };
    };
    const highlightMatcher = new MatchDecorator({
        regexp: /((?:\{(?:palette|bg|color):[^}]+\})*)==([^=\n]+)==/g,
        decorate: (add: any, from: number, to: number, match: any, view: any) => {
            if (isInInlineCode(view.state, from)) return;
            const prefix = match[1] || '';
            const innerStart = from + prefix.length;
            const innerEnd = to;
            const { bg: safeBg, color: safeColor } = resolveHighlightStyle(prefix);
            if (!safeColor && !safeBg) {
                add(innerStart, innerEnd, Decoration.mark({ class: 'cm-highlight' }));
                return;
            }
            let style = '';
            if (safeColor && !safeBg) {
                style = `color: ${safeColor};`;
            } else {
                if (safeBg) style += `background-color: ${safeBg};`;
                if (safeColor) style += `color: ${safeColor};`;
            }
            add(innerStart, innerEnd, Decoration.mark({
                class: 'cm-highlight-styled',
                attributes: { style }
            }));
        }
    });
    const highlightPlugin = makePlugin(highlightMatcher);

    // **강조** — 마크다운 strong. lang-markdown 의 tag 기반 스타일이
    // 일관되게 적용되지 않는 케이스가 있어 명시적 데코를 둔다.
    // 백슬래시 이스케이프(`\*\*`)는 매칭하지 않도록 여는/닫는 `**` 직전에 `\` 가드.
    const strongMatcher = new MatchDecorator({
        regexp: /(?<!\\)\*\*([^*\n]+?)(?<!\\)\*\*/g,
        decoration: (match: any, view: any, pos: number) => {
            if (isInInlineCode(view.state, pos)) return null;
            return Decoration.mark({ class: "cm-md-strong" });
        }
    });
    const strongPlugin = makePlugin(strongMatcher);

    // *기울임* — 마크다운 emphasis. 인접 `*` 은 강조(`**`) 가 흡수하므로 lookaround 로 제외.
    // 여는 `*` 뒤 / 닫는 `*` 앞에 공백을 두지 않도록 강제해 `* item` 리스트 마커와 충돌하지 않게 한다.
    // 백슬래시 이스케이프(`\*foo\*`) 는 매칭하지 않는다.
    const emphasisMatcher = new MatchDecorator({
        regexp: /(?<!\\)(?<!\*)\*(?!\*|\s)([^*\n]+?)(?<!\s)(?<!\\)\*(?!\*)/g,
        decoration: (match: any, view: any, pos: number) => {
            if (isInInlineCode(view.state, pos)) return null;
            return Decoration.mark({ class: "cm-md-emphasis" });
        }
    });
    const emphasisPlugin = makePlugin(emphasisMatcher);

    // __밑줄__ — 위키 커스텀 underline (render.ts 의 underline 익스텐션과 동일 패턴).
    // 백슬래시 이스케이프(`\_\_`)는 매칭하지 않는다.
    const underlineMatcher = new MatchDecorator({
        regexp: /(?<!\\)__([^_\n]+(?:_[^_\n]+)*)(?<!\\)__/g,
        decoration: (match: any, view: any, pos: number) => {
            if (isInInlineCode(view.state, pos)) return null;
            return Decoration.mark({ class: "cm-md-underline" });
        }
    });
    const underlinePlugin = makePlugin(underlineMatcher);

    // ~~취소선~~ — GFM strikethrough. 백슬래시 이스케이프(`\~\~`)는 매칭하지 않는다.
    const strikethroughMatcher = new MatchDecorator({
        regexp: /(?<!\\)~~([^~\n]+?)(?<!\\)~~/g,
        decoration: (match: any, view: any, pos: number) => {
            if (isInInlineCode(view.state, pos)) return null;
            return Decoration.mark({ class: "cm-md-strikethrough" });
        }
    });
    const strikethroughPlugin = makePlugin(strikethroughMatcher);

    const timeMatcher = new MatchDecorator({
        regexp: /\{(time|timer|age|dday|calendar):[^}]+\}/g,
        decoration: (match: any, view: any, pos: number) => {
            if (isInInlineCode(view.state, pos)) return null;
            return Decoration.mark({ class: "cm-time-marker" });
        }
    });
    const timePlugin = makePlugin(timeMatcher);

    const inlineCodeMatcher = new MatchDecorator({
        regexp: /`([^`]+)`/g,
        decoration: Decoration.mark({ class: "cm-inline-code" })
    });
    const inlineCodePlugin = makePlugin(inlineCodeMatcher);

    const quoteListMatcher = new MatchDecorator({
        regexp: /^[ \t]*(>|[-+*]|\d+\.)(?=[ \t])/gm,
        decoration: (match: any) => {
            if (match[1] === '>') return Decoration.mark({ class: "cm-quote-marker" });
            return Decoration.mark({ class: "cm-list-marker" });
        }
    });
    const quoteListPlugin = makePlugin(quoteListMatcher);

    // 줄 단위 블록 스타일링 (접기, 코드블록 등)
    const lineStylePlugin = ViewPlugin.fromClass(class {
        decorations: any;
        constructor(view: any) { this.decorations = this.getDeco(view); }
        update(update: any) {
            if (update.docChanged || update.viewportChanged) {
                this.decorations = this.getDeco(update.view);
            }
        }
        getDeco(view: any) {
            const builder = new RangeSetBuilder();
            const doc = view.state.doc;
            const maxLine = doc.lines;
            let inFold = false;
            // CommonMark 코드 펜스 추적: null = 코드 밖, "`" 또는 "~" = 해당 문자로 열린 펜스 안.
            // 닫는 펜스는 (1) 같은 문자, (2) 여는 펜스보다 길이가 같거나 길고,
            // (3) 뒤에 공백만 와야 한다. 따라서 fenceLen 도 함께 보존한다.
            let fenceChar: string | null = null;
            let fenceLen = 0;
            let colonBlockDepth = 0;
            const colonOpenRe = /^:::[a-zA-Z][a-zA-Z0-9_-]*(?:[ \t]+.*)?[ \t]*$/;
            const colonCloseRe = /^:::[ \t]*$/;
            const fenceRe = /^ {0,3}(`{3,}|~{3,})(.*)$/;

            for (let i = 1; i <= maxLine; i++) {
                const line = doc.line(i);
                const text = line.text;
                const classes: string[] = [];

                // 인라인 코드 내부의 문법은 폴드/접기 감지에서 제외
                const textForFold = text.replace(/`[^`]+`/g, (s: string) => ' '.repeat(s.length));
                if (textForFold.includes("[+")) inFold = true;
                const isColonOpen = fenceChar === null && colonOpenRe.test(text);
                const isColonClose = fenceChar === null && !isColonOpen && colonCloseRe.test(text);
                if (isColonOpen) colonBlockDepth++;
                if (inFold || colonBlockDepth > 0) classes.push("cm-fold-block");
                if (textForFold.includes("[-]")) inFold = false;
                if (isColonClose && colonBlockDepth > 0) colonBlockDepth--;

                const fenceMatch = fenceRe.exec(text);
                let isCodeFence = false;
                if (fenceMatch) {
                    const seq = fenceMatch[1];
                    const tail = fenceMatch[2];
                    const ch = seq[0];
                    if (fenceChar === null) {
                        // 펜스 여는 줄. CommonMark 규정상 백틱 펜스의 info string 에는
                        // 백틱이 올 수 없으므로 그 경우는 펜스로 보지 않는다.
                        if (!(ch === '`' && tail.indexOf('`') !== -1)) {
                            fenceChar = ch;
                            fenceLen = seq.length;
                            isCodeFence = true;
                        }
                    } else if (fenceChar === ch && seq.length >= fenceLen && /^[ \t]*$/.test(tail)) {
                        // 닫는 펜스: 같은 문자 + 같거나 더 긴 길이 + 뒤에 공백뿐
                        fenceChar = null;
                        fenceLen = 0;
                        isCodeFence = true;
                    }
                    // 그 외(같은 문자라도 길이 부족 / 뒤에 텍스트 있음, 다른 종류 펜스 토큰)는
                    // 코드 본문으로 취급되어 아래 fenceChar 체크로 cm-code-block 클래스가 붙는다.
                }
                if (isCodeFence || fenceChar !== null) {
                    classes.push("cm-code-block");
                }

                // ATX 헤딩: 줄 시작 0–3칸 들여쓰기 허용, # 1–6개, 그 뒤 공백/EOL.
                // 코드 펜스 안이면 무시 (``` / ~~~ 양쪽 모두 해당).
                if (fenceChar === null && !isCodeFence) {
                    const headingMatch = /^ {0,3}(#{1,6})(?:\s|$)/.exec(text);
                    if (headingMatch) {
                        classes.push("cm-md-h" + headingMatch[1].length);
                    }
                }

                if (classes.length > 0) {
                    builder.add(line.from, line.from, Decoration.line({ class: classes.join(" ") }));
                }
            }
            return builder.finish();
        }
    }, { decorations: (v: any) => v.decorations });

    return {
        base: [
            wikiLinkPlugin,
            templatePlugin,
            parserFuncPlugin,
            templateParamPlugin,
            alignPlugin,
            iconMarkerPlugin,
            highlightPlugin,
            strongPlugin,
            emphasisPlugin,
            underlinePlugin,
            strikethroughPlugin,
            timePlugin,
            inlineCodePlugin,
            quoteListPlugin,
            paramTokenPlugin,
            lineStylePlugin,
        ],
        advanced: [
            colorBadgePlugin,
            paletteBadgePlugin,
            iconWidgetPlugin,
        ],
    };
}
