// @ts-nocheck — Phase 4-8 의 1차 마이그레이션은 동작 보존을 우선해 임시로 type
// 검사를 끈다. marked / DOMPurify / Prism 패키지가 npm 설치되지 않은 상태이고,
// 마크다운 렌더 파이프라인의 광범위한 DOM/Element 캐스팅이 100+ 곳에 흩어져 있어
// 1회성 도입으로 다루기 어렵다. 후속 Phase 4-8.1 에서 (1) marked / DOMPurify
// devDeps 또는 .d.ts shim 도입, (2) HTML 요소 캐스팅 정리, (3) window.* 글로벌
// 단정 정리를 끝내고 본 디렉티브를 제거할 예정.
/**
 * 위키 렌더링 엔진 — public/js/render.js (3,350 줄, classic) 를 1:1 로 ESM 으로
 * 이전한 모듈. public/edit.html / public/blog-edit.html / public/index.html /
 * public/blog.html / public/revisions.html 다섯 페이지가 사용한다.
 *
 * Phase 4-8 마이그레이션:
 * - 모든 top-level function 을 그대로 유지하되, 파일 하단에서 window.* 로 노출해
 *   기존 classic-script-global 동작을 보존한다 (freq 익스텐션 등 외부 코드와의 계약).
 * - escapeHtml / isSafeUrl 은 ESM 으로 import. 그 외 CDN/공통 글로벌(marked,
 *   DOMPurify, appConfig, Swal, bootstrap, Prism) 은 bare 참조 — 모듈 평가 시점에
 *   common.js (classic, 먼저 로드) 가 이미 globalThis 에 노출했으므로 안전.
 * - DOMContentLoaded 시점 처리(_setupArticleTitleCopy 등) 는 module top-level 에서
 *   동기적으로 호출되며, 모듈은 deferred 이므로 DOM 이 이미 준비된 상태이다.
 */
import { escapeHtml } from './utils/html';
import { isSafeUrl } from './utils/url';
import { CDN_URLS, FONTS } from '../shared/cdn';
// 트랜스클루전 토큰 스캐너는 서버측 역링크 인덱싱(wiki.ts/blog.ts/palettes.ts)과
// 공유하는 단일 소스(src/shared/transclusion.ts). 기존 내부 이름(_scanCodeSpan 등)으로
// 별칭 import 해 호출부와 window.* 노출을 그대로 유지한다.
import {
    scanCodeSpan as _scanCodeSpan,
    findParamRefEnd as _findParamRefEnd,
    findTemplateCallEnd as _findTemplateCallEnd,
    findTemplateCalls as _findTemplateCalls,
    hasTemplatePrefix,
} from '../shared/transclusion';

// ── Marked 설정 및 렌더링 코어 로직 ──
// ── Marked 설정 (1회 초기화) ──
function initMarkedConfig() {
    if (typeof marked === 'undefined') return;
    marked.use({
        extensions: [
            {
                name: 'highlight',
                level: 'inline',
                // ==text== 의 시작이 어디 있는지를 찾되, 선행 스타일 토큰
                // ({color:...}, {bg:...}, {palette:...}) 가 있을 수 있는 가장 이른 위치도 후보로 삼는다.
                start(src) {
                    let min = -1;
                    for (const needle of ['==', '{color:', '{bg:', '{palette:']) {
                        const idx = src.indexOf(needle);
                        if (idx >= 0 && (min === -1 || idx < min)) min = idx;
                    }
                    return min;
                },
                tokenizer(src) {
                    // 선행 스타일 토큰을 0개 이상 흡수하고 ==text== 본문을 캡처.
                    const match = src.match(/^((?:\{(?:palette|bg|color):[^}]+\})*)==([^=]+)==/);
                    if (match && match[2]) {
                        const token = {
                            type: 'highlight',
                            raw: match[0],
                            prefix: match[1] || '',
                            text: match[2],
                            tokens: []
                        };
                        this.lexer.inline(token.text, token.tokens);
                        return token;
                    }
                },
                childTokens: ['tokens'],
                renderer(token) {
                    // 채널별 소스 추적: null | { kind:'palette', value:이름 } | { kind:'literal', value:색 }
                    // prefix 토큰을 좌→우 순회하며 뒤 토큰이 앞을 덮어쓴다(순서 우선 보존).
                    //   - 빌트인 {palette:NAME} : 두 채널을 모두 그 팔레트로 리셋 → render.css 의
                    //     mark.wiki-palette-NAME 클래스로 렌더(테마/스킨/다크모드 CSS 자동 반영).
                    //   - 커스텀 {palette:NAME}  : 모드별 hex 로 풀어 두 채널 literal(현행 의미 유지).
                    //   - {bg:V}/{color:V}       : 해당 채널만 literal 로 덮음(클래스 위에 인라인 우선).
                    // 예: {palette:primary}{bg:blue} → bg=blue(인라인), color=primary(클래스).
                    let bgCh = null, colorCh = null;
                    if (token.prefix) {
                        let merged = null; // 커스텀 팔레트는 필요 시에만 조회
                        const re = /\{(palette|bg|color):\s*([^}]+?)\s*\}/g;
                        let m;
                        while ((m = re.exec(token.prefix)) !== null) {
                            const kind = m[1];
                            const val = m[2].trim();
                            if (kind === 'bg') {
                                bgCh = { kind: 'literal', value: val };
                            } else if (kind === 'color') {
                                colorCh = { kind: 'literal', value: val };
                            } else { // palette
                                if (BUILTIN_PALETTE_NAMES.has(val)) {
                                    bgCh = { kind: 'palette', value: val };
                                    colorCh = { kind: 'palette', value: val };
                                } else {
                                    if (!merged) merged = getMergedWikiPalettes();
                                    const entry = merged[val];
                                    if (entry) {
                                        const variant = _isWikiDarkMode() ? entry.dark : entry.light;
                                        if (variant) {
                                            if (variant.bg) bgCh = { kind: 'literal', value: variant.bg };
                                            if (variant.color) colorCh = { kind: 'literal', value: variant.color };
                                        }
                                    }
                                    // 미등록 이름: 무시 (현행 유지)
                                }
                            }
                        }
                    }
                    const inner = this.parser.parseInline(token.tokens);
                    const classes = [];
                    let style = '';
                    let hasBg = false, hasColor = false;
                    if (bgCh) {
                        if (bgCh.kind === 'palette') { classes.push('wiki-palette-' + bgCh.value); hasBg = true; }
                        else if (_isSafeCssColor(bgCh.value)) { style += `background-color:${bgCh.value};`; hasBg = true; }
                    }
                    if (colorCh) {
                        if (colorCh.kind === 'palette') { classes.push('wiki-palette-' + colorCh.value); hasColor = true; }
                        else if (_isSafeCssColor(colorCh.value)) { style += `color:${colorCh.value};`; hasColor = true; }
                    }
                    // color 만 지정(배경 없음): 형광펜 없이 글씨색만 바꾼 <span>.
                    // literal 채널일 때만 — 빌트인 팔레트는 bg 가 거부돼도(예: {palette:primary}{bg:이상값})
                    // color 채널이 palette 인 채로 도달할 수 있는데, 그때 colorCh.value 는 색이 아니라
                    // 팔레트 '이름'(primary 등)이라 span 의 color 로 쓰면 무효 CSS 가 된다. 그 경우는
                    // 아래 <mark class> 경로로 떨어뜨려 팔레트 클래스(bg+color)가 살아나게 한다.
                    if (hasColor && !hasBg && colorCh.kind === 'literal') {
                        return `<span style="color:${colorCh.value};">` + inner + '</span>';
                    }
                    const classAttr = classes.length ? ` class="${[...new Set(classes)].join(' ')}"` : '';
                    const styleAttr = style ? ` style="${style}"` : '';
                    return `<mark${classAttr}${styleAttr}>` + inner + '</mark>';
                }
            },
            {
                name: 'underline',
                level: 'inline',
                start(src) { return src.indexOf('__'); },
                tokenizer(src) {
                    const match = src.match(/^__([^_]+(?:_[^_]+)*)__/);
                    if (match) {
                        const token = {
                            type: 'underline',
                            raw: match[0],
                            text: match[1],
                            tokens: []
                        };
                        this.lexer.inline(token.text, token.tokens);
                        return token;
                    }
                },
                childTokens: ['tokens'],
                renderer(token) {
                    return '<u>' + this.parser.parseInline(token.tokens) + '</u>';
                }
            },
            {
                name: 'customImage',
                level: 'inline',
                start(src) { return src.indexOf('!['); },
                tokenizer(src) {
                    const match = src.match(/^!\[([^\]]*)\]\(([^)]+)\)(?:\{size:\s*(icon|small|medium|full)\})/);
                    if (match) {
                        return {
                            type: 'customImage',
                            raw: match[0],
                            text: match[1],
                            href: match[2],
                            size: match[3]
                        };
                    }
                },
                renderer(token) {
                    let style = '';
                    if (token.size === 'icon') {
                        style = 'height: 1.2em; width: auto; display: inline-block; vertical-align: middle; margin: 0 2px;';
                    } else if (token.size === 'small') {
                        style = 'max-width: 25%; height: auto;';
                    } else if (token.size === 'medium') {
                        style = 'max-width: 50%; height: auto;';
                    } else if (token.size === 'full') {
                        style = 'max-width: 100%; height: auto;';
                    }
                    return `<img src="${escapeHtml(token.href)}" alt="${escapeHtml(token.text)}" style="${style}" data-size="${token.size}">`;
                }
            },
            {
                // 팝오버 각주. 인라인 토크나이저로 등록해 marked 가 코드 스팬/코드
                // 블록/인덴트 코드 등에서 자동으로 건드리지 않게 한다. 세 가지 형태:
                //   [* 내용]            익명 각주(기존)
                //   [*이름 내용]        이름 있는 각주 정의(MediaWiki name= 대응)
                //   [*이름]             같은 이름의 재참조(내용 없음)
                // 정의 내용은 lexer.inline 으로 재귀 토크나이즈해 기본 인라인 마크다운을
                // 허용하고, 렌더된 HTML 은 data-fn-html 에 escape 해 보관한다(이름은
                // data-fn-name, 재참조는 data-fn-ref). 번호 매핑·백링크는 processFootnotes.
                name: 'wikiFootnote',
                level: 'inline',
                start(src) { return src.indexOf('[*'); },
                tokenizer(src) {
                    if (src.charCodeAt(0) !== 91 /* [ */ || src.charCodeAt(1) !== 42 /* * */) return;
                    // 닫는 ']' 뒤에 '(' 가 오면 각주가 아니라 마크다운 링크([*텍스트](url))
                    // 이므로 (?!\() 로 제외해 링크를 가로채지 않는다.
                    const m = src.match(/^\[\*((?:[^\[\]\n]|\[[^\[\]\n]*\]|\[)*)\](?!\()/);
                    if (!m) return;
                    const body = m[1];
                    let name = '', content = '', isRef = false;
                    if (/^\s/.test(body)) {
                        // 익명 각주: [* 내용]
                        content = body.replace(/^\s+/, '');
                        if (content === '') return; // 빈 각주는 미매치(기존 동작 유지)
                    } else {
                        // 이름 있는 각주: [*이름 내용] 또는 재참조 [*이름]
                        const sp = body.search(/\s/);
                        if (sp === -1) { name = body.trim(); isRef = true; }
                        else { name = body.slice(0, sp).trim(); content = body.slice(sp + 1).replace(/^\s+/, ''); }
                        // 이름은 식별자 문자만 허용([*강조*] 같은 마크다운 강조를 각주로
                        // 오인하지 않도록 ASCII 구두점/공백을 배제, 한글·CJK 등은 허용).
                        if (!name || !/^[\w.\-\u00C0-\uFFFF]+$/.test(name)) return;
                    }
                    const token = {
                        type: 'wikiFootnote',
                        raw: m[0],
                        fnName: name,
                        fnRef: isRef,
                        text: content,
                        tokens: []
                    };
                    if (!isRef && content) this.lexer.inline(content, token.tokens);
                    return token;
                },
                childTokens: ['tokens'],
                renderer(token) {
                    const nameAttr = token.fnName ? ` data-fn-name="${escapeHtml(token.fnName)}"` : '';
                    if (token.fnRef) {
                        // 재참조: 내용 없이 이름·ref 플래그만 실어 보낸다.
                        return `<sup class="wiki-fn-marker"${nameAttr} data-fn-ref="1"></sup>`;
                    }
                    const innerHtml = this.parser.parseInline(token.tokens);
                    return `<sup class="wiki-fn-marker" data-fn-html="${escapeHtml(innerHtml)}"${nameAttr}></sup>`;
                }
            },
            {
                // {button:텍스트|url} 은 GFM 자동 링크로부터 보호해야 URL이 그대로 보존됨.
                // tokenizer가 토큰으로 잡으면 autolink 단계가 내부를 건드리지 않음.
                // 실제 <a> 변환은 _processInlineLayoutTokens에서 수행.
                name: 'wikiButton',
                level: 'inline',
                start(src) { return src.indexOf('{button:'); },
                tokenizer(src) {
                    if (!src.startsWith('{button:')) return;
                    // 중괄호 균형 스캔: {button:{dday:…}|url} 처럼 중첩 {…} 토큰을 포함한
                    // 전체 토큰을 raw 로 잡는다. '<'/개행을 만나거나 닫는 '}' 없이 끝나면
                    // 매치 포기(런어웨이 방지 — 기존 [^}]+ 와 동일한 보호).
                    const openLen = '{button:'.length;
                    let depth = 1;
                    for (let i = openLen; i < src.length; i++) {
                        const ch = src[i];
                        if (ch === '<' || ch === '\n') return;
                        if (ch === '{') depth++;
                        else if (ch === '}') {
                            depth--;
                            if (depth === 0) {
                                if (i === openLen) return; // 빈 인자 — 기존 [^}]+ 와 동일하게 미매치
                                return {
                                    type: 'wikiButton',
                                    raw: src.slice(0, i + 1),
                                    text: src.slice(openLen, i)
                                };
                            }
                        }
                    }
                },
                renderer(token) {
                    return token.raw;
                }
            }
        ],
        renderer: {
            html(token) {
                const htmlStr = typeof token === 'string' ? token : (token.text || token.raw || '');
                // HTML 주석은 escape 하지 않고 그대로 통과시킨다.
                // transclusion 센티넬(<!--WIKI_TCL_B--> / <!--WIKI_TCL_E-->) 등이
                // escape 되면 일반 텍스트로 노출되며, 최종 HTML 에서는 DOMPurify 가
                // 모든 주석 노드를 제거하므로 XSS 위험이 없다.
                if (/^\s*<!--[\s\S]*?-->\s*$/.test(htmlStr)) {
                    return htmlStr;
                }
                return escapeHtml(htmlStr);
            }
        }
    });
    try {
        marked.setOptions({
            gfm: true,
            breaks: true,
        });
    } catch (_) {
        // setOptions는 newer marked에서 제거됨 — per-call 옵션으로 대체
    }
}
initMarkedConfig();
// ── 익스텐션 데이터 임시 저장소 (렌더링 시 render.js에서 참조) ──
var _wikiExtensionData = [];

// ── 렌더 컨텍스트 (위키 vs 워크스페이스) ──
// 트랜스클루전 틀 본문 fetch 경로와 익스텐션 활성 여부를 컨텍스트별로 주입한다.
// 기본값은 메인 위키(`/api/w/{slug}`, 익스텐션 활성) — 컨텍스트 미주입 시 기존 동작 그대로.
// 워크스페이스 페이지(ws-doc/ws-edit 등)는 로드 시 `window.configureWikiRender(...)` 로
// 자체 공간(`/api/ws/<wslug>/pages/{slug}`)을 가리키게 하고 익스텐션을 비활성화한다.
// 모듈 전역으로 두는 이유: renderWikiContent/renderPresentation/diff/conflict 시그니처를
// 바꾸지 않고도 모든 렌더 경로(프레젠테이션 per-slide 포함)가 동일 컨텍스트를 읽도록 한다.
// (편집기 이미지 업로드의 window.configureImageUpload 와 동일한 페이지-당-1회 주입 패턴.)
var _renderCtx = {
    templateApiBase: '/api/w',          // 틀 본문 fetch 베이스
    disableExtensions: false,           // true 면 콜론 네임스페이스 익스텐션 호출을 확장하지 않음
    categoryApiBase: '/api/w/category', // 카테고리 정렬 목록 fetch 베이스
    wikiLinkBase: '/w',                 // [[위키링크]] href 베이스
    imageDocLinkBase: '/w',             // 이미지→문서(이미지:파일명) 링크 href 베이스
};

/**
 * 이름에 ':'가 포함되어 있고 틀 접두사(틀:/template:/템플릿:)가 아닌 경우 → 익스텐션 호출
 */
function _isExtensionCall(name) {
    const colonIdx = name.indexOf(':');
    if (colonIdx <= 0) return false;
    // 틀 접두사(틀:/template:/템플릿:) 판정은 공유 헬퍼 재사용(src/shared/transclusion.ts).
    if (hasTemplatePrefix(name)) return false;
    // '#' 접두는 파서 함수(조건문 {{#if}}/{{#ifeq}}/{{#switch}}). 정상 경로에서는
    // _expandParserFunctions 프리패스가 먼저 소비하지만, 인식 실패한 잔여 토큰이
    // 익스텐션으로 오인돼 /api/w/#... 로 fetch 되지 않도록 방어적으로 제외한다.
    if (name.charCodeAt(0) === 35 /* '#' */) return false;
    return true;
}

/**
 * 최상위(depth=0) 파이프(|)만 기준으로 raw를 분리합니다.
 * 다음 위키 문법 내부의 '|'는 분리하지 않습니다:
 *   - [[링크|레이블]]          이중 대괄호
 *   - {{틀|인자}}              이중 중괄호
 *   - {{{파라미터|기본값}}}    삼중 중괄호 (파라미터 참조)
 *   - {button:text|url}, {stat:value|label} 등 단일 중괄호 토큰
 *   - `...` 인라인 코드 스팬
 */
function _splitPipeTopLevel(raw) {
    const parts = [];
    let depth = 0;        // {{...}} / [[...]] / {{{...}}} 합산 깊이
    let singleBrace = 0;  // {...} 단일 중괄호 토큰 깊이
    let start = 0;
    let i = 0;
    while (i < raw.length) {
        const ch = raw[i];
        if (ch === '`') {
            const end = _scanCodeSpan(raw, i);
            if (end > 0) { i = end; continue; }
        }
        if (ch === '{') {
            // 가장 긴 접두사 우선: {{ 는 이중 중괄호 (혹은 {{{ 의 일부)
            if (raw[i + 1] === '{') {
                depth++;
                i += (raw[i + 2] === '{') ? 3 : 2;
                continue;
            }
            singleBrace++;
            i++;
            continue;
        }
        if (ch === '}') {
            // LIFO: 단일 중괄호가 열려 있으면 먼저 닫는다. {{Foo|{{Bar|{btn:X|Y}}}|...}}
            // 에서 내부 {btn:...} 의 `}` 가 바깥 `}}` 의 일부로 먼저 소비되지 않도록.
            if (singleBrace > 0) {
                singleBrace--;
                i++;
                continue;
            }
            if (raw[i + 1] === '}') {
                if (depth > 0) depth--;
                i += (raw[i + 2] === '}') ? 3 : 2;
                continue;
            }
            // 짝 없는 `}` — 텍스트로 간주.
            i++;
            continue;
        }
        if (ch === '[' && raw[i + 1] === '[') {
            depth++;
            i += 2;
            continue;
        }
        if (ch === ']' && raw[i + 1] === ']') {
            if (depth > 0) depth--;
            i += 2;
            continue;
        }
        if (ch === '|' && depth === 0 && singleBrace === 0) {
            parts.push(raw.substring(start, i));
            start = i + 1;
        }
        i++;
    }
    parts.push(raw.substring(start));
    return parts;
}

/**
 * part 내부에서 named-arg 구분자로 쓸 첫 번째 `=` 위치를 반환한다.
 * `{button:text|url?k=v}`, `{{nested|k=v}}`, `[[link|k=v]]` 등 중첩 토큰 내부의
 * `=` 는 무시한다. 없으면 -1. _splitPipeTopLevel 과 동일한 깊이 규칙을 사용.
 *
 * @param {number} [minIndex] `=` 로 인정할 최소 위치(기본 1). 틀 인자 파싱(`_parseTemplateCall`)
 *   은 선행 `=`(빈 키)을 키-값 구분자로 보지 않으려 1 을 쓰지만, `#switch` 케이스는 빈 키가
 *   의미를 가지므로(`=값` = 빈 문자열 케이스, MediaWiki 동일) 0 을 넘겨 선행 `=` 도 인정한다.
 */
function _findTopLevelEquals(part, minIndex) {
    if (minIndex === undefined) minIndex = 1;
    let depth = 0;        // {{...}} / [[...]] / {{{...}}} 합산 깊이
    let singleBrace = 0;  // {...} 단일 중괄호 토큰 깊이
    let i = 0;
    while (i < part.length) {
        const ch = part[i];
        if (ch === '`') {
            const end = _scanCodeSpan(part, i);
            if (end > 0) { i = end; continue; }
        }
        if (ch === '{') {
            if (part[i + 1] === '{') {
                depth++;
                i += (part[i + 2] === '{') ? 3 : 2;
                continue;
            }
            singleBrace++;
            i++;
            continue;
        }
        if (ch === '}') {
            if (singleBrace > 0) { singleBrace--; i++; continue; }
            if (part[i + 1] === '}') {
                if (depth > 0) depth--;
                i += (part[i + 2] === '}') ? 3 : 2;
                continue;
            }
            i++;
            continue;
        }
        if (ch === '[' && part[i + 1] === '[') { depth++; i += 2; continue; }
        if (ch === ']' && part[i + 1] === ']') { if (depth > 0) depth--; i += 2; continue; }
        if (ch === '=' && depth === 0 && singleBrace === 0 && i >= minIndex) return i;
        i++;
    }
    return -1;
}

/**
 * {{틀이름|값1|key=값2}} 호출 내부 텍스트를 파싱한다. 첫 토큰은 틀 이름, 이후 토큰은 좌→우 순으로:
 *   - 최상위 `=` 가 있으면 `key=value` 이름 인자로 저장
 *     (단일 중괄호 `{...}`, 중첩 `{{...}}`, `[[...]]` 내부의 `=` 는 무시)
 *   - 없으면 현재 위치 카운터(1부터 시작) 를 키로 하는 이름 인자로 저장
 * 같은 키가 반복되면 나중 값이 이전 값을 덮어쓴다. 따라서 호출자가 `1=value` 형태로
 * 명시적 위치 인자를 넘겨도 `{{{1}}}` 참조가 올바르게 해결된다.
 */
function _parseTemplateCall(raw) {
    const parts = _splitPipeTopLevel(raw);
    const name = (parts.shift() || '').trim();
    const args = {};
    let posIndex = 1;
    for (const part of parts) {
        const eq = _findTopLevelEquals(part);
        if (eq > 0) {
            args[part.substring(0, eq).trim()] = part.substring(eq + 1).trim();
        } else {
            args[String(posIndex)] = part.trim();
            posIndex++;
        }
    }
    return { name, args };
}

/**
 * text 에서 최상위 `{{{...}}}` 파라미터 참조를 모두 찾는다.
 */
function _findParamRefs(text) {
    const refs = [];
    let i = 0;
    while (i < text.length - 2) {
        if (text[i] === '`') {
            const end = _scanCodeSpan(text, i);
            if (end > 0) { i = end; continue; }
        }
        if (text[i] === '{' && text[i + 1] === '{' && text[i + 2] === '{') {
            const end = _findParamRefEnd(text, i + 3);
            if (end) {
                refs.push({ start: i, fullEnd: end.fullEnd, raw: text.substring(i + 3, end.contentEnd) });
                i = end.fullEnd;
                continue;
            }
        }
        i++;
    }
    return refs;
}

/**
 * 틀 본문의 {{{이름}}} / {{{1}}} / {{{이름|기본값}}} 파라미터 참조를 호출 인자로 치환.
 * - 인자로 전달된 값은 그대로(리터럴) 삽입한다.
 * - 기본값에 포함된 `{{{...}}}` 참조는 동일 args 로 재귀적으로 치환된다.
 *   (예: `{{{reason|{{{1|}}}}}}` 처럼 이름 인자가 없을 때 위치 인자를 폴백으로 쓰는 관용 패턴 지원)
 * - 기본값에 {{fallback}}, {button:text|url} 같은 중괄호 포함 위키 토큰이 있어도 보존된다.
 * @param {number} [depth] 재귀 깊이 (기본값의 기본값 중첩 방어용 안전장치)
 */
function _substituteTemplateParams(templateContent, args, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 10) return templateContent;

    const refs = _findParamRefs(templateContent);
    if (refs.length === 0) return templateContent;

    let result = '';
    let cursor = 0;
    for (const ref of refs) {
        result += templateContent.substring(cursor, ref.start);

        const parts = _splitPipeTopLevel(ref.raw);
        const key = (parts.shift() || '').trim();
        // 첫 `|` 뒤는 기본값. 2번째 이후의 `|` 는 기본값 안에 그대로 포함.
        const def = parts.length > 0 ? parts.join('|') : undefined;

        const value = Object.prototype.hasOwnProperty.call(args, key) ? args[key] : undefined;

        if (value !== undefined) {
            result += value;
        } else if (def !== undefined) {
            // 기본값은 재귀적으로 파라미터 치환하여 중첩 폴백 패턴을 해소.
            result += _substituteTemplateParams(def, args, depth + 1);
        }
        // 아무것도 없으면 빈 문자열

        cursor = ref.fullEnd;
    }
    result += templateContent.substring(cursor);
    return result;
}

// ── 파서 함수(조건문): {{#if}} / {{#ifeq}} / {{#switch}} ──
// MediaWiki ParserFunctions 스타일의 선언적 조건 분기. 틀 본문에서 {{{파라미터}}} 치환
// 결과에 따라 출력 분기를 고른다. 임의 코드 실행/반복 없이 문자열·수치 비교만 수행하고,
// 틀 fetch 가 필요 없으므로 _resolveTransclusionsCore 의 확장 루프 이전 동기 프리패스로 처리한다.
//
// 평가 시점: {{{...}}} 파라미터 치환은 부모 패스의 _substituteTemplateParams 에서 이미
// 끝난 상태이고(예: {{{x}}} → 실제 인자값), 그 다음 재귀 패스에서 이 프리패스가 최상위
// {{#...}} 를 만나 분기를 고른다. 선택된 분기에 남은 {{틀}} 호출은 이후 확장 루프가 처리한다.
//
// 한계(1단계): 조건/비교 인자는 "그 시점의 문자열" 로 평가된다. 즉 조건 안의 {{다른틀}} 은
// 아직 렌더 확장 전이라 그 호출 텍스트(비어있지 않음=참)로 취급된다 — 다른 틀의 *렌더 결과*
// 로 분기할 수는 없다. 표준 사용법은 {{{파라미터}}} 기준 분기다.
const _PARSER_FUNCTIONS = new Set(['if', 'ifeq', 'switch', 'expr']);

/** 문자열이 순수 숫자 리터럴이면 Number, 아니면 null. (#ifeq/#switch 수치 비교용) */
function _parserNumeric(s) {
    const t = s.trim();
    if (t === '' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
}

/** #ifeq/#switch 비교: 양쪽이 숫자면 수치로(예: "1"=="1.0", "+2"=="2"), 아니면 문자열로 동일성 판정. */
function _parserLooseEquals(a, b) {
    if (a === b) return true;
    const na = _parserNumeric(a);
    if (na === null) return false;
    const nb = _parserNumeric(b);
    return nb !== null && na === nb;
}

/**
 * text 안의 최상위 {{#if|#ifeq|#switch: ...}} 파서 함수를 평가해 선택된 분기로 치환한다.
 * 일반 {{틀}}·{{익스텐션:..}} 호출과 {{{파라미터}}} 참조, 백틱 코드스팬은 건드리지 않는다
 * (_findTemplateCalls 가 코드스팬/파라미터 참조 범위를 건너뛴다). 조건/분기 안에 중첩된
 * 파서 함수는 재귀로 평가한다(inside-out).
 */
function _expandParserFunctions(text) {
    // 빠른 종료: '{{' 뒤(공백/개행 허용) '#' 가 없으면 파서 함수가 없다. 아래 per-call
    // 정규식(/^\s*#.../)이 공백 폼 {{ #if: }} 을 받아들이므로 이 가드도 동일하게 \s* 를
    // 허용해야 한다 — 안 그러면 {{ #if }} 가 평가를 건너뛰고 틀:#if 로 fetch 돼 깨진다.
    if (!/\{\{\s*#/.test(text)) return text;
    const calls = _findTemplateCalls(text);
    if (calls.length === 0) return text;
    let out = '';
    let cursor = 0;
    let changed = false;
    for (const c of calls) {
        out += text.substring(cursor, c.start);
        const m = /^\s*#([a-zA-Z]+)\s*:/.exec(c.raw);
        if (m && _PARSER_FUNCTIONS.has(m[1].toLowerCase())) {
            out += _evalParserFunction(m[1].toLowerCase(), c.raw);
            changed = true;
        } else {
            out += text.substring(c.start, c.fullEnd);
        }
        cursor = c.fullEnd;
    }
    out += text.substring(cursor);
    return changed ? out : text;
}

/** 단일 파서 함수 호출(raw = "#fn: arg1 | arg2 | ...") 을 평가해 결과 문자열을 반환. */
function _evalParserFunction(fn, raw) {
    const colon = raw.indexOf(':');
    const segs = _splitPipeTopLevel(raw.substring(colon + 1));
    if (fn === 'if') {
        // {{#if: test | then | else}} — test 가 (trim 후) 비어있지 않으면 then, 아니면 else.
        const test = _expandParserFunctions(segs[0] || '').trim();
        const branch = test !== '' ? segs[1] : segs[2];
        return branch === undefined ? '' : _expandParserFunctions(branch).trim();
    }
    if (fn === 'ifeq') {
        // {{#ifeq: a | b | eq | neq}} — a 와 b 가 같으면 eq, 아니면 neq.
        const a = _expandParserFunctions(segs[0] || '').trim();
        const b = _expandParserFunctions(segs[1] || '').trim();
        const branch = _parserLooseEquals(a, b) ? segs[2] : segs[3];
        return branch === undefined ? '' : _expandParserFunctions(branch).trim();
    }
    if (fn === 'expr') {
        // {{#expr: 식}} — 사칙연산 안전 부분집합(+ - * / round floor ceil, 괄호, 단항 ±).
        // 임의 코드 실행 없이 문자열 파싱만 수행하며, 파이프 인자를 쓰지 않으므로
        // 콜론 이후 전체를 식으로 본다. 내부 파서 함수는 먼저 전개한다.
        const exprStr = _expandParserFunctions(raw.substring(colon + 1));
        const val = _evalExpr(exprStr);
        return val === null ? '' : _formatExprResult(val);
    }
    // switch
    return _evalParserSwitch(segs);
}

/**
 * MediaWiki #expr 의 안전 부분집합 평가기. 지원: 숫자, 괄호, 이항 + - * / 와 round,
 * 단항 + -, 단항 floor / ceil. 그 외 문자(임의 함수·식별자·비교연산 등)는 전부 오류.
 * 우선순위(낮음→높음): round < +,- < *,/ < 단항(floor/ceil/부호) < primary.
 * 오류(구문/미지원/0 나눗셈/비유한)면 null 을 반환한다(호출부가 빈 문자열로 치환).
 */
function _evalExpr(input) {
    if (typeof input !== 'string') return null;
    const tokens = [];
    const re = /\s*(?:(\d+\.?\d*|\.\d+)|([+\-*/()])|([a-zA-Z]+))/g;
    let consumed = 0;
    let mm;
    while ((mm = re.exec(input)) !== null) {
        if (mm.index !== consumed) return null; // 허용되지 않는 문자를 건너뜀 → 오류
        consumed = re.lastIndex;
        if (mm[1] !== undefined) tokens.push({ t: 'num', v: parseFloat(mm[1]) });
        else if (mm[2] !== undefined) tokens.push({ t: 'op', v: mm[2] });
        else {
            const w = mm[3].toLowerCase();
            if (w === 'round' || w === 'floor' || w === 'ceil') tokens.push({ t: 'fn', v: w });
            else return null; // 알 수 없는 단어
        }
    }
    if (input.slice(consumed).trim() !== '') return null; // 잔여 문자
    if (tokens.length === 0) return null;

    let pos = 0;
    const peek = () => tokens[pos];

    function parseRound() {
        let left = parseAddSub();
        if (left === null) return null;
        while (peek() && peek().t === 'fn' && peek().v === 'round') {
            pos++;
            const right = parseAddSub();
            if (right === null || !Number.isFinite(right)) return null;
            const digits = Math.trunc(right);
            if (digits < 0 || digits > 15) return null;
            const f = Math.pow(10, digits);
            left = Math.round(left * f) / f;
        }
        return left;
    }
    function parseAddSub() {
        let left = parseMulDiv();
        if (left === null) return null;
        while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
            const op = peek().v; pos++;
            const right = parseMulDiv();
            if (right === null) return null;
            left = op === '+' ? left + right : left - right;
        }
        return left;
    }
    function parseMulDiv() {
        let left = parseUnary();
        if (left === null) return null;
        while (peek() && peek().t === 'op' && (peek().v === '*' || peek().v === '/')) {
            const op = peek().v; pos++;
            const right = parseUnary();
            if (right === null) return null;
            if (op === '*') left = left * right;
            else { if (right === 0) return null; left = left / right; }
        }
        return left;
    }
    function parseUnary() {
        const p = peek();
        if (p && p.t === 'fn' && (p.v === 'floor' || p.v === 'ceil')) {
            pos++;
            const operand = parseUnary();
            if (operand === null) return null;
            return p.v === 'floor' ? Math.floor(operand) : Math.ceil(operand);
        }
        if (p && p.t === 'op' && (p.v === '-' || p.v === '+')) {
            pos++;
            const operand = parseUnary();
            if (operand === null) return null;
            return p.v === '-' ? -operand : operand;
        }
        return parsePrimary();
    }
    function parsePrimary() {
        const p = peek();
        if (!p) return null;
        if (p.t === 'num') { pos++; return p.v; }
        if (p.t === 'op' && p.v === '(') {
            pos++;
            const val = parseRound();
            if (val === null) return null;
            if (!peek() || peek().t !== 'op' || peek().v !== ')') return null;
            pos++;
            return val;
        }
        return null;
    }

    const result = parseRound();
    if (result === null || pos !== tokens.length || !Number.isFinite(result)) return null;
    return result;
}

/** #expr 결과 포매팅: 부동소수 오차를 정리하고 불필요한 꼬리 0 을 제거. */
function _formatExprResult(n) {
    return String(parseFloat(n.toFixed(10)));
}

/**
 * {{#switch: value | k1=r1 | k2=r2 | #default=rd }} 평가.
 * - value 와 일치하는 첫 케이스의 결과를 반환. 일치 없으면 #default(또는 '=' 없는 마지막
 *   세그먼트)를, 그것도 없으면 빈 문자열.
 * - 폴스루: '=' 없는 케이스 키가 value 와 일치하면 그 뒤 첫 '=' 케이스의 결과를 공유한다
 *   (예: `| a | b = 2` 에서 value 가 a 든 b 든 결과는 2).
 */
function _evalParserSwitch(segs) {
    const value = _expandParserFunctions(segs[0] || '').trim();
    const cases = segs.slice(1);
    let defaultVal = null;
    for (let i = 0; i < cases.length; i++) {
        const seg = cases[i];
        // minIndex=0: '=값'(빈 키) 케이스를 빈 문자열 케이스로 인식(MediaWiki 동일).
        const eq = _findTopLevelEquals(seg, 0);
        if (eq < 0) {
            // '=' 없는 마지막 세그먼트 = raw default 값.
            if (i === cases.length - 1) {
                if (defaultVal === null) defaultVal = seg;
                break;
            }
            // 폴스루: 이 키가 매치되면 뒤따르는 첫 '=' 세그먼트의 값을 결과로.
            const key = _expandParserFunctions(seg).trim();
            if (_parserLooseEquals(value, key)) {
                for (let j = i + 1; j < cases.length; j++) {
                    const e2 = _findTopLevelEquals(cases[j], 0);
                    if (e2 >= 0) return _expandParserFunctions(cases[j].substring(e2 + 1)).trim();
                }
                return '';
            }
            continue;
        }
        const key = _expandParserFunctions(seg.substring(0, eq)).trim();
        const val = seg.substring(eq + 1);
        if (key === '#default') { defaultVal = val; continue; }
        if (_parserLooseEquals(value, key)) return _expandParserFunctions(val).trim();
    }
    return defaultVal === null ? '' : _expandParserFunctions(defaultVal).trim();
}

// ── 틀(Transclusion) 및 익스텐션 처리 ──

/**
 * 섹션 트랜스클루전 참조({{문서#s-1.2}} / {{문서#1.2}} / {{문서#제목}}) 파싱.
 * 이름에 '#'(슬러그 금지 문자)가 있으면 앞부분을 문서 슬러그, 뒷부분을 섹션 앵커로
 * 나눈다. 전체 문서가 아닌 한 섹션만 포함하는 용도라 문서 슬러그는 그대로 쓴다
 * (틀: 접두 미부착 — 일반 문서 대상. `틀:Foo#s-1` 처럼 명시 접두는 유지). 없으면 null.
 */
function _parseSectionRef(name) {
    const hashIdx = name.indexOf('#');
    if (hashIdx === -1) return null;
    const docPart = name.slice(0, hashIdx).trim();
    const anchor = name.slice(hashIdx + 1).trim();
    if (!docPart || !anchor) return null;
    return { docPart, anchor };
}

/**
 * 원본(미전개) 마크다운에 헤딩을 주입할 수 있는 트랜스클루전 호출(틀·일반 문서 섹션
 * 트랜스클루전·파서 함수)이 있는지 검사. 익스텐션 호출은 컴포넌트로 렌더돼 마크다운 헤딩을
 * 내지 않으므로 제외한다. 숫자 섹션 앵커(s-N.N)의 안전 가드에 사용한다.
 */
function _hasHeadingInjectingCalls(content) {
    if (typeof content !== 'string' || content.indexOf('{{') === -1) return false;
    const calls = _findTemplateCalls(content);
    for (const c of calls) {
        const raw = c.raw.trim();
        // 파서 함수: 값만 내는 {{#expr:...}} 는 숫자만 출력해 헤딩을 주입할 수 없으므로 제외.
        // 분기 선택형({{#if}}/{{#ifeq}}/{{#switch}} 등)은 분기 안에 헤딩이 있을 수 있어 주입 가능.
        if (raw.charCodeAt(0) === 35 /* '#' */) {
            const pm = /^#([a-zA-Z]+)/.exec(raw);
            if (pm && pm[1].toLowerCase() === 'expr') continue;
            return true;
        }
        const { name } = _parseTemplateCall(raw);
        const secRef = _parseSectionRef(name);
        // 익스텐션(및 익스텐션 docPart 섹션 참조)은 헤딩을 주입하지 않는다 → 제외.
        if (secRef && _isExtensionCall(secRef.docPart)) continue;
        if (_isExtensionCall(name)) continue;
        // 그 외(틀/일반 문서 섹션 트랜스클루전)는 fetch 본문의 헤딩을 주입할 수 있다.
        return true;
    }
    return false;
}

/**
 * 헤딩의 raw 마크다운 텍스트를 렌더된 순수 텍스트에 가깝게 정규화(제목 기반 섹션 매칭용).
 * `_resolveAnchorTarget` 이 DOM textContent(마크다운 전개 후)로 매칭하는 것과 어긋나지
 * 않도록 `## **Install**` · `` ## `Install` `` · `## Install ##`(ATX 닫기) 같은 흔한 서식을
 * 벗겨 `{{Doc#Install}}` 이 매칭되게 한다. DOM 비의존(서버 SSR·wiki-shared 미러 공용).
 * 불균형 서식 등은 벗기지 못해도 exact 매칭 실패 시 '섹션 없음'으로 안전하게 떨어진다.
 */
function _stripInlineMarkdownForMatch(s) {
    if (typeof s !== 'string') return '';
    let t = s;
    t = t.replace(/\s+#+\s*$/, '');                       // ATX 닫기 마커(예: "Install ##")
    t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');        // 이미지 → alt
    t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');         // 링크 → 텍스트
    t = t.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');        // 참조 링크 → 텍스트
    t = t.replace(/`+/g, '');                              // 인라인 코드 백틱
    t = t.replace(/(\*\*|__)(.*?)\1/g, '$2');              // 볼드
    t = t.replace(/(\*|_)(.*?)\1/g, '$2');                 // 이탤릭
    t = t.replace(/~~(.*?)~~/g, '$1');                     // 취소선
    t = t.replace(/[*_~]/g, '');                           // 잔여 홑 마커(불균형 대비)
    t = t.replace(/\\([\\`*_{}\[\]()#+\-.!~>])/g, '$1');   // 이스케이프 해제(\X → X)
    return t.trim();
}

/**
 * 마크다운 본문에서 앵커(s-1.2 / 1.2 / 헤딩 텍스트)에 해당하는 섹션(헤딩 라인~다음 동급
 * 헤딩 직전)을 잘라 반환. numberHeadings 와 동일한 상대 레벨 카운터로 s-N.N 번호를
 * 재구성해 매칭한다. 못 찾으면 null. (_extractMarkdownSectionRanges 가 코드펜스·setext
 * 예외를 이미 처리하므로 그 range 를 슬라이스만 한다.)
 *
 * 안전 가드: 원본에 헤딩 주입 트랜스클루전이 있으면 렌더된 s-N(numberHeadings — 트랜스클루전
 * 헤딩 포함)과 여기 원본 기준 s-N 이 어긋나므로, 숫자 앵커는 null 로 폴백해 조용한 오슬라이스를
 * 막는다. 헤딩 텍스트 앵커는 번호와 무관하므로 그대로 허용한다.
 */
function _sliceMarkdownSection(content, anchor) {
    const ranges = _extractMarkdownSectionRanges(content);
    if (ranges.length === 0) return null;
    const lines = content.split('\n');

    const minLevel = Math.min(...ranges.map(r => r.level));
    const counters = [0, 0, 0, 0, 0, 0];
    const numByIdx = ranges.map(r => {
        const rel = r.level - minLevel;
        counters[rel]++;
        for (let k = rel + 1; k < counters.length; k++) counters[k] = 0;
        const parts = [];
        for (let k = 0; k <= rel; k++) parts.push(counters[k] || 1);
        return parts.join('.');
    });

    const a = (anchor || '').trim();
    const isNumericAnchor = /^(?:s-)?\d+(?:\.\d+)*$/.test(a);
    // 숫자 앵커 + 원본에 헤딩 주입 트랜스클루전 → 렌더 번호와 어긋날 수 있어 폴백(null).
    if (isNumericAnchor && _hasHeadingInjectingCalls(content)) return null;
    let idx = -1;
    if (/^s-\d+(?:\.\d+)*$/.test(a)) idx = numByIdx.indexOf(a.slice(2));
    else if (/^\d+(?:\.\d+)*$/.test(a)) idx = numByIdx.indexOf(a);
    else {
        // 먼저 raw headingText 와 정확히 비교(기존 동작 보존), 실패 시 인라인 마크다운을
        // 벗겨 렌더된 헤딩 텍스트 기준(_resolveAnchorTarget 과 동일)으로 재매칭한다.
        idx = ranges.findIndex(r => r.headingText === a);
        if (idx === -1) {
            const target = _stripInlineMarkdownForMatch(a);
            if (target) idx = ranges.findIndex(r => _stripInlineMarkdownForMatch(r.headingText) === target);
        }
    }
    if (idx === -1) return null;

    const r = ranges[idx];
    return lines.slice(r.lineIdx, r.endLine).join('\n');
}

/**
 * 전개 결과(expanded)를 호출 위치의 라인 컨텍스트에 맞춰 transclusion 센티넬로 감싼다.
 * (블록 단독 라인 / 들여쓰기 단독 라인 / 인라인) — 틀·섹션 트랜스클루전이 공유한다.
 */
function _wrapTransclusionSentinels(protectedText, c, expanded) {
    const OPEN = '<!--WIKI_TCL_B-->';
    const CLOSE = '<!--WIKI_TCL_E-->';
    const lineStart = protectedText.lastIndexOf('\n', c.start - 1) + 1;
    const nextNl = protectedText.indexOf('\n', c.fullEnd);
    const lineEnd = nextNl === -1 ? protectedText.length : nextNl;
    const beforeOnLine = protectedText.substring(lineStart, c.start);
    const afterOnLine = protectedText.substring(c.fullEnd, lineEnd);
    const aloneOnLine = beforeOnLine.trim() === '' && afterOnLine.trim() === '';
    if (aloneOnLine && beforeOnLine === '') {
        // 진짜 블록 컨텍스트(컬럼 0, 단독 라인): 센티넬을 빈 줄로 분리.
        return '\n\n' + OPEN + '\n\n' + expanded + '\n\n' + CLOSE + '\n\n';
    }
    if (aloneOnLine) {
        // 들여쓰기된 단독 라인: 원본 접두사를 다음 줄들에도 이어 붙여 부모 블록 유지.
        const indentedExpanded = expanded.split('\n').join('\n' + beforeOnLine);
        return OPEN + indentedExpanded + CLOSE;
    }
    // 인라인 컨텍스트(문장 중간): 같은 줄에 바로 붙여 문단 흐름 유지.
    return OPEN + expanded + CLOSE;
}

/**
 * text 안의 최상위 `{{...}}` 호출 중 selfSlug 와 일치하는 것을 경고로 교체한다.
 * `_substituteTemplateParams` 가 기본값을 전개한 결과에 남아 있는 자기 호출을 잡아낸다.
 */
function _replaceSelfCalls(text, selfSlug) {
    const calls = _findTemplateCalls(text);
    if (calls.length === 0) return text;
    const warning = `⚠️ [자기 자신을 참조하는 틀은 사용할 수 없습니다: ${selfSlug}]`;
    let out = '';
    let cursor = 0;
    for (const c of calls) {
        out += text.substring(cursor, c.start);
        const rawTrim = c.raw.trim();
        if (rawTrim.charCodeAt(0) === 35 /* '#' */) {
            // 파서 함수(#if/#ifeq/#switch …): 호출 자체는 자기참조가 아니지만 분기 안에
            // 자기 호출이 숨어 있을 수 있다(예: {{#if:1|{{A}}|ok}}). 분기를 평가/선택하지
            // 않고 raw 내부만 재귀해 자기 호출 토큰만 경고로 바꾼다 — 분기 선택을 하지 않으므로
            // 코드펜스 안의 {{#if:...}} 예시를 #if 평가로 재작성하지 않는다(파서 함수 평가는
            // 코드블록 보호를 거친 프리패스에서만 수행). 이후 프리패스가 분기를 평가하면
            // 경고가 그대로 출력된다.
            out += '{{' + _replaceSelfCalls(c.raw, selfSlug) + '}}';
            cursor = c.fullEnd;
            continue;
        }
        const { name } = _parseTemplateCall(rawTrim);
        // 대상 슬러그를 fetch 로직(_resolveTransclusionsCore)과 동일한 순서로 판정한다.
        // 섹션 트랜스클루전 {{문서#섹션}} 은 docPart 를 그대로(틀: 미부착) fetch 하므로,
        // selfSlug 가 섹션 소스 문서(bare docPart, 또는 {{틀:X#s}} 의 '틀:X')이면
        // {{docPart#다른섹션}} 자기 참조를 잡아 MAX_DEPTH 까지의 반복 자기 포함을 막는다.
        // (반대로 {{Foo}}=틀:Foo 는 일반 문서 Foo 와 다른 개체이므로 여기서 잡지 않는다.)
        const selfSecRef = _parseSectionRef(name);
        if (selfSecRef && !_isExtensionCall(selfSecRef.docPart)) {
            out += selfSecRef.docPart === selfSlug ? warning : text.substring(c.start, c.fullEnd);
        } else if (_isExtensionCall(name)) {
            out += text.substring(c.start, c.fullEnd);
        } else {
            let refSlug = name;
            if (!refSlug.startsWith('template:') && !refSlug.startsWith('틀:') && !refSlug.startsWith('템플릿:')) {
                refSlug = '틀:' + refSlug;
            }
            out += refSlug === selfSlug ? warning : text.substring(c.start, c.fullEnd);
        }
        cursor = c.fullEnd;
    }
    out += text.substring(cursor);
    return out;
}

/**
 * 틀 확장 공통 핵심 로직.
 * options.expandExtensions: true이면 익스텐션 호출도 처리 (resolveTransclusions용)
 * options.emitExtensionPlaceholders: true이면 WIKIEXTPH 플레이스홀더를 생성 (resolveTransclusions용)
 */
async function _resolveTransclusionsCore(text, depth, cache, pageSlug, options) {
    const MAX_DEPTH = 3;
    if (depth > MAX_DEPTH) return text;

    // 조기 종료: {{가 없으면 파싱 불필요 (코드 블록 내의 {{는 이후 matches.length===0 체크로 처리됨)
    if (!text.includes('{{')) return text;

    const codeBlocks = [];
    let protectedText = text;
    if (typeof marked === 'undefined') return text;
    const tokens = marked.lexer(protectedText);

    marked.walkTokens(tokens, token => {
        if (token.type === 'code' || token.type === 'codespan') {
            const raw = token.raw;
            if (protectedText.includes(raw)) {
                const idx = codeBlocks.length;
                codeBlocks.push(raw);
                protectedText = protectedText.replace(raw, `\x00CODEBLOCK_${idx}\x00`);
            }
        }
    });

    // 파서 함수(#if/#ifeq/#switch) 프리패스: 틀 fetch 없이 조건 분기를 선택해 치환한다.
    // 코드블록은 위에서 \x00CODEBLOCK_n\x00 플레이스홀더로 보호된 상태이므로 그 내부의
    // {{#...}} 는 건드리지 않는다. {{{파라미터}}} 치환은 부모 패스에서 이미 끝났고, 그 결과
    // 텍스트의 최상위 파서 함수를 여기서 평가한다.
    protectedText = _expandParserFunctions(protectedText);

    // 괄호 균형을 추적하는 파서로 호출 위치를 찾는다. 인자 안의 {button:a|b} 처럼
    // `}` 를 포함한 단일 중괄호 토큰이 있어도 첫 `}` 에서 중단되지 않는다.
    const calls = _findTemplateCalls(protectedText);

    if (calls.length === 0) {
        // 남은 틀 호출이 없다 — 파서 함수 분기 선택만으로 본문이 바뀌었을 수 있으므로
        // 코드블록을 복원해 반환한다. (분기 안에 {{틀}} 이 있었다면 calls 가 비지 않는다.)
        const restored = protectedText.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx, 10)]);
        return restored === text ? text : restored;
    }

    const slugsToFetch = new Set();
    const extensionSlugs = new Set();
    calls.forEach(c => {
        const { name, args } = _parseTemplateCall(c.raw.trim());
        // 섹션 트랜스클루전({{문서#섹션}})은 문서 슬러그를 그대로 fetch(틀: 미부착).
        const secRef = _parseSectionRef(name);
        if (secRef && !_isExtensionCall(secRef.docPart)) {
            slugsToFetch.add(secRef.docPart);
            return;
        }
        if (_isExtensionCall(name)) {
            // 익스텐션 비활성 컨텍스트(워크스페이스)에서는 fetch 대상에 넣지 않는다 —
            // 메인 위키 `/api/w/` 로 새지 않도록. 치환 단계에서 안내 메시지로 처리한다.
            if (options.expandExtensions && !_renderCtx.disableExtensions) {
                // 익스텐션: slug를 그대로 사용 (예: "freq:AirPods_Pro_2")
                extensionSlugs.add(name);
                slugsToFetch.add(name);
                // 익스텐션 호출의 인자값이 다른 익스텐션 슬러그(ex. freq:Target)인 경우
                // 렌더러가 secondary 데이터로 사용할 수 있도록 미리 fetch.
                for (const argVal of Object.values(args)) {
                    if (typeof argVal === 'string' && _isExtensionCall(argVal)) {
                        extensionSlugs.add(argVal);
                        slugsToFetch.add(argVal);
                    }
                }
            }
        } else {
            let slug = name;
            if (!slug.startsWith('template:') && !slug.startsWith('틀:') && !slug.startsWith('템플릿:')) {
                slug = '틀:' + slug;
            }
            slugsToFetch.add(slug);
        }
    });

    const fetchPromises = [];
    for (const slug of slugsToFetch) {
        if (!cache.has(slug)) {
            if (pageSlug && slug === pageSlug) {
                cache.set(slug, `⚠️ [자기 자신을 참조하는 틀은 사용할 수 없습니다: ${slug}]`);
                continue;
            }

            // 익스텐션인 경우: 활성화 여부 확인
            if (extensionSlugs.has(slug)) {
                const extName = slug.substring(0, slug.indexOf(':'));
                const enabledExts = (appConfig && appConfig.enabledExtensions) || [];
                if (!enabledExts.includes(extName)) {
                    cache.set(slug, { _ext: true, _disabled: true, extName, slug });
                    continue;
                }
            }

            fetchPromises.push(
                fetch(`${_renderCtx.templateApiBase}/${encodeURIComponent(slug)}`)
                    .then(res => res.ok ? res.json() : null)
                    .then(data => {
                        if (extensionSlugs.has(slug)) {
                            // 익스텐션: 원본 데이터를 저장 (마크다운으로 인라인하지 않음)
                            const extName = slug.substring(0, slug.indexOf(':'));
                            if (data) {
                                cache.set(slug, { _ext: true, extName, slug, content: data.content, title: data.slug });
                            } else {
                                // 문서가 없어도 익스텐션 렌더러가 slug/args만으로 동작할 수 있도록 빈 콘텐츠로 처리
                                cache.set(slug, { _ext: true, extName, slug, content: '', title: slug });
                            }
                        } else {
                            if (!data || typeof data.content !== 'string') {
                                cache.set(slug, `⚠️ [틀을 찾을 수 없음: ${slug}]`);
                                return;
                            }
                            // 틀 본문도 CRLF/CR → LF 정규화. 이후 펜스/`:::`/폴드 정규식과
                            // marked.lexer 의 `raw` 매칭이 어긋나지 않도록 한다.
                            const tplBody = data.content.replace(/\r\n?/g, '\n');
                            const selfReferenceWarning = `⚠️ [자기 자신을 참조하는 틀은 사용할 수 없습니다: ${slug}]`;
                            // 틀 본문 내부의 자기 참조를 치환. 중괄호 균형을 맞추는 파서로 호출을
                            // 찾기 때문에 인자 내부의 {button:...} 같은 토큰이 있어도 정확히 매칭한다.
                            const innerCalls = _findTemplateCalls(tplBody);
                            let tplContent = '';
                            let cursor = 0;
                            for (const ic of innerCalls) {
                                tplContent += tplBody.substring(cursor, ic.start);
                                const { name: innerName } = _parseTemplateCall(ic.raw.trim());
                                const original = tplBody.substring(ic.start, ic.fullEnd);
                                if (_isExtensionCall(innerName)) {
                                    tplContent += original;
                                } else {
                                    let refSlug = innerName;
                                    if (!refSlug.startsWith('template:') && !refSlug.startsWith('틀:') && !refSlug.startsWith('템플릿:')) {
                                        refSlug = '틀:' + refSlug;
                                    }
                                    tplContent += refSlug === slug ? selfReferenceWarning : original;
                                }
                                cursor = ic.fullEnd;
                            }
                            tplContent += tplBody.substring(cursor);
                            cache.set(slug, tplContent);
                        }
                    })
                    .catch(() => {
                        if (extensionSlugs.has(slug)) {
                            cache.set(slug, `⚠️ [익스텐션 로딩 실패: ${slug}]`);
                        } else {
                            cache.set(slug, `⚠️ [틀 로딩 실패: ${slug}]`);
                        }
                    })
            );
        }
    }
    await Promise.all(fetchPromises);

    // transclusion 으로 주입된 헤딩을 원본 헤딩과 구분하기 위해, 템플릿/섹션 전개
    // 결과를 보이지 않는 HTML 주석 센티넬(<!--WIKI_TCL_B-->/<!--WIKI_TCL_E-->)로
    // 감싼다(_wrapTransclusionSentinels). 같은 헤딩 텍스트가 원본과 주입본 양쪽에
    // 존재할 때 텍스트 매칭만으로는 섹션 편집 링크가 엉뚱한 섹션을 가리킬 수 있으므로,
    // 확실한 소스 표식이 필요하다. 센티넬은 _extractMarkdownSectionRanges 에서
    // 문자 오프셋 깊이 추적으로 감지되고, 최종 HTML 에서는 DOMPurify 가 제거한다.

    // 각 호출에 대응할 치환 텍스트를 먼저 계산한 뒤, 호출 위치(start, fullEnd) 를 이용해
    // 원본에서 세그먼트 단위로 교체. 정규식 기반 replace 를 사용하지 않아 인자 내부의
    // 브레이스 포함 토큰도 안전하게 처리된다.
    let newText = '';
    let cursor = 0;
    for (const c of calls) {
        newText += protectedText.substring(cursor, c.start);
        const match = protectedText.substring(c.start, c.fullEnd);
        const call = _parseTemplateCall(c.raw.trim());
        const trimmed = call.name;
        let replacement;
        const secRef = _parseSectionRef(trimmed);
        if (secRef && !_isExtensionCall(secRef.docPart)) {
            // 섹션 트랜스클루전({{문서#섹션}}): 문서를 fetch 해 해당 섹션만 슬라이스한다.
            // 문서 슬러그는 그대로 사용(틀: 미부착 — 일반 문서 대상).
            const slug = secRef.docPart;
            const cached = cache.get(slug);
            if (cached === undefined || cached === null || typeof cached !== 'string') {
                replacement = match;
            } else {
                // 소스 문서의 문서 변수(:::meta + {{{@이름}}})를 슬라이스 이전에 적용한다.
                // 섹션 밖에 정의된 :::meta 도 반영돼 {{{@이름}}} 값 유실을 막고, 섹션 안의
                // :::meta 블록도 원본 텍스트로 새지 않도록 제거된다 — 문서를 단독으로 열 때와 동일.
                const section = _sliceMarkdownSection(_applyDocMetaVars(cached), secRef.anchor);
                if (section === null) {
                    replacement = `⚠️ [섹션을 찾을 수 없음: ${slug}#${secRef.anchor}]`;
                } else {
                    let expanded = _substituteTemplateParams(section, call.args);
                    expanded = _replaceSelfCalls(expanded, slug);
                    replacement = _wrapTransclusionSentinels(protectedText, c, expanded);
                }
            }
        } else if (_isExtensionCall(trimmed)) {
            if (!options.expandExtensions) {
                replacement = match;
            } else if (_renderCtx.disableExtensions) {
                // 워크스페이스 등 익스텐션 미지원 컨텍스트: 메인 위키로 새지 않도록 안내로 치환.
                const colonIdx = trimmed.indexOf(':');
                const extName = colonIdx > 0 ? trimmed.substring(0, colonIdx) : trimmed;
                replacement = `⚠️ [이 공간에서는 익스텐션을 사용할 수 없습니다: ${extName}]`;
            } else {
                const cached = cache.get(trimmed);
                if (!cached) {
                    replacement = match;
                } else if (typeof cached === 'string') {
                    replacement = cached; // 에러 메시지
                } else if (cached._disabled) {
                    replacement = `⚠️ [비활성화된 익스텐션: ${cached.extName}]`;
                } else if (options.emitExtensionPlaceholders) {
                    const idx = _wikiExtensionData.length;
                    // 호출 인자 중 익스텐션 슬러그를 가리키는 값들을 secondary 로 해소.
                    // 렌더러는 extData.secondary[<arg값>] 으로 부속 데이터에 접근한다.
                    const secondary = {};
                    for (const argVal of Object.values(call.args || {})) {
                        if (typeof argVal === 'string' && _isExtensionCall(argVal)) {
                            const sub = cache.get(argVal);
                            if (sub && typeof sub === 'object' && sub._ext) {
                                if (sub._disabled) {
                                    secondary[argVal] = { slug: argVal, disabled: true };
                                } else {
                                    secondary[argVal] = { slug: argVal, content: sub.content, title: sub.title };
                                }
                            } else {
                                secondary[argVal] = { slug: argVal, error: typeof sub === 'string' ? sub : '참조를 찾을 수 없습니다.' };
                            }
                        }
                    }
                    _wikiExtensionData.push({ extName: cached.extName, slug: cached.slug, content: cached.content, title: cached.title, args: call.args, secondary });
                    replacement = `\n\nWIKIEXTPH_${cached.extName}_${idx}_XEND\n\n`;
                } else {
                    replacement = match;
                }
            }
        } else {
            let slug = trimmed;
            if (!slug.startsWith('template:') && !slug.startsWith('틀:') && !slug.startsWith('템플릿:')) {
                slug = '틀:' + slug;
            }
            const cached = cache.get(slug);
            if (cached === undefined || cached === null || typeof cached !== 'string') {
                replacement = match;
            } else {
                // 파라미터 치환: {{{이름}}} / {{{1}}} / {{{이름|기본값}}} 을 호출 인자로 대체.
                // 치환 후 남은 {{...}} 는 다음 재귀 단계(depth+1) 에서 확장된다.
                let expanded = _substituteTemplateParams(cached, call.args);
                // 기본값(default) 에 숨어 있던 자기 호출이 파라미터 치환으로 드러날 수 있다.
                // (예: {{{1|{{A}}}}} 에 1 이 미지정된 경우 expanded 에 {{A}} 가 나타남.)
                // cache 시점의 사전 스캔은 {{{...}}} 범위를 건너뛰므로 이 지점에서 한 번 더
                // 자기 호출을 경고로 교체해 MAX_DEPTH 까지의 무한 재귀를 차단한다.
                expanded = _replaceSelfCalls(expanded, slug);
                replacement = _wrapTransclusionSentinels(protectedText, c, expanded);
            }
        }
        newText += replacement;
        cursor = c.fullEnd;
    }
    newText += protectedText.substring(cursor);

    newText = newText.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx, 10)]);

    if (newText !== text) {
        return await _resolveTransclusionsCore(newText, depth + 1, cache, pageSlug, options);
    }
    return newText;
}

async function resolveTransclusions(content, pageSlug) {
    // 매 호출 시 익스텐션 데이터 초기화
    _wikiExtensionData = [];
    const cache = new Map();
    // CRLF/CR → LF 정규화. 코어의 `marked.lexer(...).raw` 매칭이 LF 기준이라
    // CRLF 가 섞이면 코드블록 보호가 실패해 코드블록 내부에서도 {{...}} 가 확장된다.
    const normalized = (content || '').replace(/\r\n?/g, '\n');
    return await _resolveTransclusionsCore(normalized, 0, cache, pageSlug, { expandExtensions: true, emitExtensionPlaceholders: true });
}

/**
 * 마크다운 복사용 틀 확장: 틀: 네임스페이스만 확장하고, 다른 네임스페이스는 그대로 유지.
 * 익스텐션 플레이스홀더 없이 순수 마크다운 텍스트로 반환.
 */
async function resolveTransclusionsForMarkdown(content, pageSlug) {
    const cache = new Map();
    const normalized = (content || '').replace(/\r\n?/g, '\n');
    const expanded = await _resolveTransclusionsCore(normalized, 0, cache, pageSlug, { expandExtensions: false, emitExtensionPlaceholders: false });
    // 마크다운 원문 복사 경로에서는 transclusion 센티넬을 제거해 깔끔한 텍스트로 반환.
    return expanded.replace(/<!--WIKI_TCL_[BE]-->/g, '');
}

// ── 문서 변수 :::meta + {{{@이름}}} ──
// 문서 최상단(어디든)의 `:::meta` 블록에서 `이름 = 값` 정의를 수집하고, 본문의
// `{{{@이름}}}` / `{{{@이름|기본값}}}` 참조를 그 값으로 치환한 뒤 meta 블록은 제거한다.
// 틀 파라미터({{{이름}}})와 이름공간이 `@` 로 분리되어 충돌하지 않으며, `@` 가 아닌
// {{{...}}} 참조는 손대지 않는다(틀 본문 파라미터는 이후 _substituteTemplateParams 담당).
// 트랜스클루전·타임스탬프·컴포넌트 인자 치환보다 먼저 수행되어 값 하나로 문서 전체가
// 갱신되고 #expr·{dday:} 등과 조합된다. 코드블록/코드스팬 내부는 보호한다.
function _applyDocMetaVars(content) {
    if (typeof content !== 'string') return content;
    if (content.indexOf(':::meta') === -1 && content.indexOf('{{{@') === -1) return content;
    let text = content.replace(/\r\n?/g, '\n');

    // 코드블록/코드스팬 보호 (resolveTransclusions 와 동일 방식).
    const codeBlocks = [];
    if (typeof marked !== 'undefined') {
        try {
            const tokens = marked.lexer(text);
            marked.walkTokens(tokens, token => {
                if (token.type === 'code' || token.type === 'codespan') {
                    const raw = token.raw;
                    if (text.includes(raw)) {
                        const idx = codeBlocks.length;
                        codeBlocks.push(raw);
                        text = text.replace(raw, `\x00METACODE_${idx}\x00`);
                    }
                }
            });
        } catch (_) { /* lexer 실패 시 보호 없이 진행 */ }
    }

    // :::meta 블록 추출(라인 시작 오프너 ~ 단독 ::: 클로저). 여러 개면 모두 소비.
    const metaArgs = {};
    text = text.replace(/^:::meta[ \t]*\n([\s\S]*?)\n:::[ \t]*$\n?/gm, (whole, bodyText) => {
        bodyText.split('\n').forEach(line => {
            const eq = line.indexOf('=');
            if (eq === -1) return;
            const key = line.slice(0, eq).trim();
            if (!key) return;
            metaArgs['@' + key] = line.slice(eq + 1).trim();
        });
        return '';
    });

    // {{{@이름}}} / {{{@이름|기본값}}} 참조만 치환. @ 가 아닌 참조는 원본 유지.
    if (text.indexOf('{{{@') !== -1) {
        const refs = _findParamRefs(text);
        if (refs.length > 0) {
            let out = '';
            let cursor = 0;
            for (const ref of refs) {
                out += text.substring(cursor, ref.start);
                const parts = _splitPipeTopLevel(ref.raw);
                const key = (parts.shift() || '').trim();
                if (key.charCodeAt(0) === 64 /* @ */) {
                    const def = parts.length > 0 ? parts.join('|') : undefined;
                    if (Object.prototype.hasOwnProperty.call(metaArgs, key)) out += metaArgs[key];
                    else if (def !== undefined) out += def;
                    // 정의도 기본값도 없으면 빈 문자열
                } else {
                    out += text.substring(ref.start, ref.fullEnd);
                }
                cursor = ref.fullEnd;
            }
            out += text.substring(cursor);
            text = out;
        }
    }

    // 코드블록 복원
    return text.replace(/\x00METACODE_(\d+)\x00/g, (_, i) => codeBlocks[parseInt(i, 10)]);
}

// ── 카테고리 목록 렌더링 ──
// 첫 글자(알파벳 / 한글 초성 / 일본어 가나)별로 그룹핑하고 그리드로 나열.
// 가타카나는 동일 음의 히라가나로 정규화 (예: カ → か).
// 한글 자모 쌍자음(ㄲ ㄸ ㅃ ㅆ ㅉ)은 평음(ㄱ ㄷ ㅂ ㅅ ㅈ)에 묶음.
function _wikiCategoryGroupOf(name) {
    if (!name) return { order: '9999', label: '#' };
    const ch = name.charAt(0);
    const code = ch.charCodeAt(0);

    // 한글 음절 (가-힣)
    if (code >= 0xAC00 && code <= 0xD7A3) {
        const chosung = Math.floor((code - 0xAC00) / 588);
        // 19 초성 → 14 자음으로 정규화 (쌍자음 병합)
        const normLabel = ['ㄱ','ㄱ','ㄴ','ㄷ','ㄷ','ㄹ','ㅁ','ㅂ','ㅂ','ㅅ','ㅅ','ㅇ','ㅈ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
        const normIdx   = [ 0,    0,    1,    2,    2,    3,    4,    5,    5,    6,    6,    7,    8,    8,    9,    10,   11,   12,   13 ];
        return { order: '1' + String(normIdx[chosung]).padStart(2, '0'), label: normLabel[chosung] };
    }
    // 한글 자모 (호환 자모 영역: ㄱ-ㅎ)
    if (code >= 0x3131 && code <= 0x314E) {
        const jamoMap = { 'ㄱ':[0,'ㄱ'],'ㄲ':[0,'ㄱ'],'ㄳ':[0,'ㄱ'],
                          'ㄴ':[1,'ㄴ'],'ㄵ':[1,'ㄴ'],'ㄶ':[1,'ㄴ'],
                          'ㄷ':[2,'ㄷ'],'ㄸ':[2,'ㄷ'],
                          'ㄹ':[3,'ㄹ'],'ㄺ':[3,'ㄹ'],'ㄻ':[3,'ㄹ'],'ㄼ':[3,'ㄹ'],'ㄽ':[3,'ㄹ'],'ㄾ':[3,'ㄹ'],'ㄿ':[3,'ㄹ'],'ㅀ':[3,'ㄹ'],
                          'ㅁ':[4,'ㅁ'],
                          'ㅂ':[5,'ㅂ'],'ㅃ':[5,'ㅂ'],'ㅄ':[5,'ㅂ'],
                          'ㅅ':[6,'ㅅ'],'ㅆ':[6,'ㅅ'],
                          'ㅇ':[7,'ㅇ'],
                          'ㅈ':[8,'ㅈ'],'ㅉ':[8,'ㅈ'],
                          'ㅊ':[9,'ㅊ'],'ㅋ':[10,'ㅋ'],'ㅌ':[11,'ㅌ'],'ㅍ':[12,'ㅍ'],'ㅎ':[13,'ㅎ'] };
        const m = jamoMap[ch];
        if (m) return { order: '1' + String(m[0]).padStart(2, '0'), label: m[1] };
    }
    // 가타카나 → 히라가나 정규화
    let hira = ch;
    if (code >= 0x30A1 && code <= 0x30F6) {
        hira = String.fromCharCode(code - 0x60);
    }
    const hcode = hira.charCodeAt(0);
    if (hcode >= 0x3041 && hcode <= 0x3096) {
        // 50音圖 행별 분류
        const rows = [
            { label: 'あ', start: 0x3041, end: 0x304A },
            { label: 'か', start: 0x304B, end: 0x3054 },
            { label: 'さ', start: 0x3055, end: 0x305E },
            { label: 'た', start: 0x305F, end: 0x3069 },
            { label: 'な', start: 0x306A, end: 0x306E },
            { label: 'は', start: 0x306F, end: 0x307D },
            { label: 'ま', start: 0x307E, end: 0x3082 },
            { label: 'や', start: 0x3083, end: 0x3088 },
            { label: 'ら', start: 0x3089, end: 0x308D },
            { label: 'わ', start: 0x308E, end: 0x3093 },
        ];
        for (let i = 0; i < rows.length; i++) {
            if (hcode >= rows[i].start && hcode <= rows[i].end) {
                return { order: '2' + String(i).padStart(2, '0'), label: rows[i].label };
            }
        }
    }
    // 알파벳
    if (/[A-Za-z]/.test(ch)) {
        const u = ch.toUpperCase();
        return { order: '3' + u, label: u };
    }
    // 숫자
    if (/[0-9]/.test(ch)) {
        return { order: '40', label: '0-9' };
    }
    return { order: '9999', label: '#' };
}

function _renderCategoryPagination(category, page, totalPages) {
    if (totalPages <= 1) return '';
    const make = (p, label, disabled, active) => {
        const cls = `btn btn-sm ${active ? 'btn-primary' : 'btn-outline-secondary'}`;
        const dis = disabled ? ' disabled' : '';
        return `<button type="button" class="${cls}${dis}" data-category-page="${p}"${disabled ? ' aria-disabled="true"' : ''}>${escapeHtml(label)}</button>`;
    };
    let html = '';
    html += make(Math.max(1, page - 1), '‹', page <= 1, false);
    const win = 2;
    const lo = Math.max(1, page - win);
    const hi = Math.min(totalPages, page + win);
    if (lo > 1) {
        html += make(1, '1', false, page === 1);
        if (lo > 2) html += '<span class="category-pagination-ellipsis">…</span>';
    }
    for (let p = lo; p <= hi; p++) html += make(p, String(p), false, p === page);
    if (hi < totalPages) {
        if (hi < totalPages - 1) html += '<span class="category-pagination-ellipsis">…</span>';
        html += make(totalPages, String(totalPages), false, page === totalPages);
    }
    html += make(Math.min(totalPages, page + 1), '›', page >= totalPages, false);
    return `<nav class="category-pagination" aria-label="카테고리 페이지">${html}</nav>`;
}

// 카테고리별 전체 정렬 결과 캐시. SPA 세션 내에서 stale 데이터를 막기 위해 짧은 TTL 적용.
const _wikiCategorySortedCache = new Map();
const _WIKI_CATEGORY_CACHE_TTL_MS = 30 * 1000;

function _wikiCategoryInvalidate(category) {
    if (category) _wikiCategorySortedCache.delete(category);
    else _wikiCategorySortedCache.clear();
}

async function _loadCategorySortedItems(category) {
    const now = Date.now();
    const cached = _wikiCategorySortedCache.get(category);
    if (cached && (now - cached.t) < _WIKI_CATEGORY_CACHE_TTL_MS) return cached.items;
    const res = await fetch(`${_renderCtx.categoryApiBase}/${encodeURIComponent(category)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const raw = Array.isArray(data.pages) ? data.pages : [];
    const items = raw.map(p => {
        const slug = String(p.slug || '');
        // 카테고리 그룹/정렬 기준은 전체 슬러그의 맨 앞 글자.
        // 하위문서 구조(`/` 세그먼트)는 무시한다 — 'docs/가이드' 는 'D' 그룹에 들어간다.
        const g = _wikiCategoryGroupOf(slug);
        return { slug, _gOrder: g.order, _gLabel: g.label };
    });
    // 1차: 스크립트 그룹 순서 (한글 → 일본어 → 알파벳 → 숫자 → 기타)
    // 2차: 같은 그룹 안에서 전체 슬러그 기준 로케일 사전순.
    const collator = new Intl.Collator(['ko', 'ja', 'en'], { sensitivity: 'base', numeric: true });
    items.sort((a, b) => {
        if (a._gOrder !== b._gOrder) return a._gOrder < b._gOrder ? -1 : 1;
        return collator.compare(a.slug, b.slug);
    });
    _wikiCategorySortedCache.set(category, { items, t: now });
    return items;
}

async function fetchCategoryList(category, page) {
    const reqPage = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = 60;
    const catAttr = escapeHtml(category);
    try {
        const items = await _loadCategorySortedItems(category);
        if (items === null) return '';
        const total = items.length;

        if (total === 0) {
            return `<div class="category-list mt-4" data-category="${catAttr}" data-cpage="1">
                <h4><i class="bi bi-folder2-open"></i> "${escapeHtml(category)}" 카테고리에 속한 문서</h4>
                <div class="alert alert-light border text-center my-4">이 카테고리에 속한 문서가 없습니다.</div>
            </div>`;
        }

        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        // 범위 초과 페이지 요청은 마지막 유효 페이지로 클램프 (stale URL / 문서 삭제 직후 등)
        const curPage = Math.min(Math.max(1, reqPage), totalPages);
        const startIdx0 = (curPage - 1) * pageSize;
        const pageItems = items.slice(startIdx0, startIdx0 + pageSize);

        // 슬라이스 안에서 연속된 그룹 라벨로 묶음. 전체 정렬이 그룹 순서이므로
        // 슬라이스해도 그룹 경계는 그대로 유지된다.
        const groups = [];
        let curG = null;
        for (const it of pageItems) {
            if (!curG || curG.label !== it._gLabel) {
                curG = { label: it._gLabel, items: [] };
                groups.push(curG);
            }
            curG.items.push(it);
        }

        const groupsHtml = groups.map(g => {
            const itemsHtml = g.items.map(it => {
                return `<a class="category-item" href="/w/${encodeURIComponent(it.slug)}" title="${escapeHtml(it.slug)}"><span class="category-item-name">${escapeHtml(it.slug)}</span></a>`;
            }).join('');
            return `<section class="category-group"><h5 class="category-group-label">${escapeHtml(g.label)}</h5><div class="category-grid">${itemsHtml}</div></section>`;
        }).join('');

        const pagination = _renderCategoryPagination(category, curPage, totalPages);
        const startIdx = startIdx0 + 1;
        const endIdx = startIdx0 + pageItems.length;
        const summary = `<div class="category-summary text-muted small mb-2">총 ${total}개 문서 · ${startIdx}–${endIdx} 표시</div>`;

        return `<div class="category-list mt-4" data-category="${catAttr}" data-cpage="${curPage}">
            <h4><i class="bi bi-folder2-open"></i> "${escapeHtml(category)}" 카테고리에 속한 문서</h4>
            ${summary}
            <div class="category-groups">${groupsHtml}</div>
            ${pagination}
        </div>`;
    } catch (e) {
        console.error(e);
        return '<div class="alert alert-danger">카테고리 목록을 불러오는 데 실패했습니다.</div>';
    }
}

// 카테고리 목록 페이지네이션 + 아이템 SPA 네비게이션 전역 위임.
// renderWikiContent 의 DOMPurify 경로(인라인 onclick 제거)와
// showCategoryArticle 의 직접 innerHTML 경로 양쪽에서 동작.
if (typeof document !== 'undefined' && !(window as any).__wikiCategoryListBound) {
    (window as any).__wikiCategoryListBound = true;
    document.addEventListener('click', (e) => {
        const target = e.target as Element | null;
        if (!target) return;
        const pageBtn = target.closest('button[data-category-page]') as HTMLButtonElement | null;
        if (pageBtn && !pageBtn.classList.contains('disabled')) {
            e.preventDefault();
            const container = pageBtn.closest('.category-list') as HTMLElement | null;
            if (!container) return;
            const cat = container.getAttribute('data-category');
            const p = parseInt(pageBtn.getAttribute('data-category-page') || '1', 10);
            if (!cat || !Number.isFinite(p)) return;
            container.setAttribute('aria-busy', 'true');
            (window as any).fetchCategoryList(cat, p).then((html) => {
                const wrap = document.createElement('div');
                wrap.innerHTML = html;
                const next = wrap.firstElementChild;
                if (next) {
                    container.replaceWith(next);
                    const top = (next as HTMLElement).getBoundingClientRect().top + window.scrollY - 80;
                    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
                }
            });
            return;
        }
        const itemLink = target.closest('a.category-item') as HTMLAnchorElement | null;
        if (itemLink && typeof (window as any).navigateTo === 'function') {
            e.preventDefault();
            (window as any).navigateTo(itemLink.href);
        }
    });
}

// ── 헤딩 접기 토큰 ({collapse}) ──
// 헤딩 끝에 `{collapse}` 를 붙이면 그 문단(헤딩 섹션)을 기본 접힘 상태로 렌더한다.
// 토큰 자체는 헤딩 표시 텍스트·목차 카드·FAB·MCP 읽기 어디에도 노출되면 안 되므로,
// 헤딩 텍스트가 소비되는 모든 경로(_extractMarkdownSectionRanges 매칭, 렌더 후 DOM 표시)에서
// 제거한다. 헤딩 끝(트레일링)에 올 때만 유효하며 ATX 닫기(예: `## 제목 {collapse} ##`)가
// 뒤따라도 인식한다. 서버측(aiParser/mapDocument)의 stripCollapseToken 과 동일 규칙.
const WIKI_COLLAPSE_TOKEN_RE = /\s*\{\s*collapse\s*\}\s*#*\s*$/;
function _stripCollapseToken(text) {
    const t = text || '';
    return WIKI_COLLAPSE_TOKEN_RE.test(t)
        ? { text: t.replace(WIKI_COLLAPSE_TOKEN_RE, ''), collapse: true }
        : { text: t, collapse: false };
}

// 렌더된 DOM 헤딩에서 {collapse} 토큰 텍스트를 제거하고 기본 접힘 마커(dataset.wikiCollapseDefault)를
// 부착한다. numberHeadings/목차 생성/섹션 래핑 이전에 실행해 토큰이 표시 텍스트·목차·FAB 에 남지
// 않게 한다. (collapsibleSections 옵션과 무관하게 항상 스트립 — 실제 접힘 효과만 섹션 래핑에 의존)
function _applyHeadingCollapseTokens(containerEl) {
    if (!containerEl) return;
    const headings = containerEl.querySelectorAll(
        'h1:not(.accordion-header), h2:not(.accordion-header), h3:not(.accordion-header), h4:not(.accordion-header), h5:not(.accordion-header), h6:not(.accordion-header)'
    );
    headings.forEach(h => {
        // 토큰은 헤딩 끝(마지막 텍스트 노드)에 있을 때만 유효하다.
        const last = h.lastChild;
        if (!last || last.nodeType !== 3) return; // 3 = TEXT_NODE
        const val = last.nodeValue || '';
        if (!WIKI_COLLAPSE_TOKEN_RE.test(val)) return;
        const stripped = val.replace(WIKI_COLLAPSE_TOKEN_RE, '');
        if (stripped === '') h.removeChild(last);
        else last.nodeValue = stripped;
        h.dataset.wikiCollapseDefault = '1';
    });
}

// ── TOC 생성 ──
// 헤딩에 계층적 번호 프리픽스 삽입 (예: 1., 1.1., 1.1.1.)
function numberHeadings(contentEl) {
    if (!contentEl) return;
    // .accordion-header 는 :::accordion 의 항목 헤더(h2) — 본문 헤딩이 아니므로 제외
    const headings = contentEl.querySelectorAll('h1:not(.accordion-header), h2:not(.accordion-header), h3:not(.accordion-header), h4:not(.accordion-header)');
    if (headings.length < 1) return;

    const minLevel = Math.min(...Array.from(headings).map(h => parseInt(h.tagName[1], 10)));
    const counters = [0, 0, 0, 0, 0, 0];

    headings.forEach((h, i) => {
        const level = parseInt(h.tagName[1], 10);

        const relLevel = level - minLevel;
        counters[relLevel]++;
        for (let k = relLevel + 1; k < counters.length; k++) counters[k] = 0;

        const numParts = [];
        for (let k = 0; k <= relLevel; k++) numParts.push(counters[k] || 1);
        const numStr = numParts.join('.');

        // 섹션 링크 문법 [[문서#s-1.2]] 가 항상 동작하도록 s-{numStr} 앵커 보장.
        // 단, 원본 마크다운/HTML이 부여한 기존 id (예: marked.js의 텍스트 기반 id,
        // 명시적인 raw HTML id) 는 깊은 링크 호환을 위해 보존한다.
        const sectionId = `s-${numStr}`;
        if (!h.id) {
            h.id = sectionId;
        } else if (h.id !== sectionId) {
            // 기존 id를 유지하면서 같은 위치에 섹션 앵커를 추가 삽입
            const existingAnchor = h.querySelector(`:scope > .wiki-section-anchor[id="${sectionId}"]`);
            if (!existingAnchor && !contentEl.querySelector(`#${CSS.escape(sectionId)}`)) {
                const anchor = document.createElement('span');
                anchor.className = 'wiki-section-anchor';
                anchor.id = sectionId;
                h.insertBefore(anchor, h.firstChild);
            }
        }
        // 에디터 스크롤 동기화에서 마크다운 소스의 헤딩 순번과 매핑하기 위한 보조 인덱스
        h.dataset.headingIdx = String(i);

        const existingPrefix = h.querySelector('.wiki-heading-num');
        if (!existingPrefix) {
            const numSpan = document.createElement('span');
            numSpan.className = 'wiki-heading-num';
            numSpan.textContent = numStr + '. ';
            h.insertBefore(numSpan, h.firstChild);
        }
    });
}

// 컨테이너 내부 헤딩으로 중첩 <ol> 목차 HTML 을 생성한다(외부 의존 없음).
// generateTOC(외부 #tocNav 패널)와 인라인 목차 카드가 공유한다. 헤딩이 없으면 ''.
// includeNumbers=true 이면 본문 헤딩 번호(.wiki-heading-num)를 링크 앞에 붙여 본문과
// 동일한 계층 번호를 표시한다(목차 카드 전용 — 외부 패널은 번호 없이 유지).
function _buildTocOlHtml(contentEl, includeNumbers = false) {
    if (!contentEl) return '';
    const headings = contentEl.querySelectorAll('h1:not(.accordion-header), h2:not(.accordion-header), h3:not(.accordion-header), h4:not(.accordion-header)');
    if (headings.length < 1) return '';

    const headingArray = Array.from(headings);
    const regularHeadingLevels = headingArray
        .filter(h => !h.closest('.wiki-footnotes'))
        .map(h => parseInt(h.tagName[1], 10));
    const allHeadingLevels = headingArray.map(h => parseInt(h.tagName[1], 10));
    const minLevel = regularHeadingLevels.length > 0
        ? Math.min(...regularHeadingLevels)
        : Math.min(...allHeadingLevels);

    let html = '<ol>';
    let prevLevel = 0;

    headings.forEach((h, i) => {
        // 각주 섹션 헤딩은 문서의 최상위 헤딩과 같은 기준 레벨로 맞춘 뒤 TOC 레벨을 정규화한다.
        const isFootnoteHeading = !!h.closest('.wiki-footnotes');
        const rawLevel = isFootnoteHeading ? minLevel : parseInt(h.tagName[1], 10);
        const level = rawLevel - minLevel + 1;
        const id = h.id || `heading-${i}`;
        // .wiki-heading-num(번호 prefix)을 제외한 순수 제목 텍스트
        const numSpan = h.querySelector('.wiki-heading-num');
        let text = '';
        h.childNodes.forEach(n => {
            if (n !== numSpan) text += n.textContent;
        });

        if (level > prevLevel) {
            for (let j = prevLevel; j < level; j++) html += '<ol>';
        } else if (level < prevLevel) {
            for (let j = level; j < prevLevel; j++) html += '</ol>';
        }

        // 본문과 정확히 일치하도록 헤딩 번호 prefix(예: "1.2.")를 그대로 사용한다.
        let label = escapeHtml(text.trim());
        if (includeNumbers && numSpan) {
            const num = (numSpan.textContent || '').trim();
            if (num) label = `<span class="wiki-toc-num">${escapeHtml(num)}</span> ${label}`;
        }
        html += `<li><a href="#${id}">${label}</a></li>`;
        prevLevel = level;
    });

    for (let j = 0; j < prevLevel; j++) html += '</ol>';
    return html;
}

function generateTOC(contentEl, tocContainerId, tocNavId) {
    if (!contentEl) return;
    const tocContainer = document.getElementById(tocContainerId);
    if (!tocContainer) return;

    const html = _buildTocOlHtml(contentEl);
    if (!html) {
        tocContainer.classList.add('d-none');
        // #tocNav 는 SPA 전환 간 공유되는 전역 소스다. 헤딩 없는 페이지에서 비우지 않으면
        // 이전 페이지의 목차가 남아 플로팅 패널 / FAB 가 stale 콘텐츠를 렌더할 수 있으므로
        // 반드시 초기화한다.
        const staleNav = document.getElementById(tocNavId);
        if (staleNav) staleNav.innerHTML = '';
        return;
    }

    const tocNav = document.getElementById(tocNavId);
    if (!tocNav) return;

    tocNav.innerHTML = html;
    tocContainer.classList.remove('d-none');
}

// ── 본문 상단 인라인 목차 카드 (좌측 플로팅) ──
// 컨테이너 내부 헤딩으로 목차를 자체 생성한 카드를 본문 최상단에 float:left 로 삽입한다
// (외부 #tocNav 의존 없음 → 프리뷰 등 어떤 렌더 컨텍스트에서도 동작). 도입부(첫 헤딩
// 이전)는 일반 블록 래퍼(.wiki-lead-body)로 감싸 카드 옆을 자연스럽게 감싸 흐르도록 하고,
// 도입부가 카드보다 길면 카드 아래에서 자동으로 전체 폭을 사용한다. 첫 헤딩부터는 clear
// 센티넬로 float 를 해제하여 전체 폭에 배치한다. 헤딩이 없으면(목차 없음) 카드를 만들지 않는다.
function _buildInlineTocLayout(containerEl) {
    if (!containerEl) return;
    // 이전 렌더의 BFC 클래스를 초기화(헤딩 없는 페이지로 전환 시 잔존 방지).
    containerEl.classList.remove('wiki-has-inline-toc');

    const olHtml = _buildTocOlHtml(containerEl, true);
    // 헤딩이 없으면(목차 없음) 인라인 카드를 만들지 않는다.
    if (!olHtml) return;

    // 첫 최상위 헤딩(h1~h4, 아코디언 헤더 제외) 이전의 "도입부" 노드 수집
    const isTopHeading = (n) =>
        n.nodeType === 1 && /^H[1-4]$/.test(n.nodeName) && !n.classList.contains('accordion-header');
    const leadNodes = [];
    for (const node of Array.from(containerEl.childNodes)) {
        if (isTopHeading(node)) break;
        leadNodes.push(node);
    }

    // 목차 카드
    const card = document.createElement('aside');
    card.className = 'wiki-toc-card';
    const head = document.createElement('div');
    head.className = 'wiki-toc-card-head';
    const label = document.createElement('span');
    label.className = 'wiki-toc-card-title';
    label.innerHTML = '<i class="bi bi-list-columns-reverse"></i> 목차';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'wiki-toc-card-toggle';
    toggle.setAttribute('aria-label', '목차 접기/펼치기');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.innerHTML = '<i class="bi bi-chevron-up"></i>';
    head.appendChild(label);
    head.appendChild(toggle);

    // 애니메이션 래퍼(.wiki-toc-card-body)가 grid-template-rows 전환으로 접기/펼치기.
    const body = document.createElement('div');
    body.className = 'wiki-toc-card-body';
    const nav = document.createElement('nav');
    nav.className = 'wiki-toc-card-nav';
    nav.innerHTML = olHtml;
    body.appendChild(nav);

    card.appendChild(head);
    card.appendChild(body);

    // 카드 접기/펼치기
    toggle.addEventListener('click', () => {
        const collapsed = card.classList.toggle('wiki-toc-card-collapsed');
        toggle.setAttribute('aria-expanded', String(!collapsed));
        const icon = toggle.querySelector('i');
        if (icon) icon.className = collapsed ? 'bi bi-chevron-down' : 'bi bi-chevron-up';
    });

    // 목차 링크 클릭: 접힌 섹션을 펼친 뒤 스크롤 (render.ts 자체 헬퍼 사용)
    nav.addEventListener('click', (e: Event) => {
        const tgt = e.target;
        const a = tgt instanceof Element ? tgt.closest('a[href^="#"]') : null;
        if (!a) return;
        const hash = a.getAttribute('href');
        if (!hash || hash.length < 2) return;
        let id;
        try { id = decodeURIComponent(hash.slice(1)); } catch (_) { id = hash.slice(1); }
        const target = id ? _resolveAnchorTarget(id) : null;
        if (!target) return;
        e.preventDefault();
        try { history.pushState(null, '', hash); } catch (_) { /* ignore */ }
        _scrollToElementWithAncestors(target, { behavior: 'smooth', block: 'start' });
    });

    // 카드를 본문 최상단에 float:left 로 삽입.
    containerEl.insertBefore(card, containerEl.firstChild);
    containerEl.classList.add('wiki-has-inline-toc');

    // 도입부를 일반 블록 래퍼로 감싸 카드 옆을 텍스트가 자연스럽게 흐르게 한다. 도입부가
    // 카드보다 길어지면 카드 아래에서부터는 전체 폭을 사용한다(기본 float 흐름 동작).
    const hasMeaningfulLead = leadNodes.some(
        n => n.nodeType === 1 || (n.nodeType === 3 && (n.textContent || '').trim())
    );
    if (hasMeaningfulLead) {
        const leadBody = document.createElement('div');
        leadBody.className = 'wiki-lead-body';
        leadNodes.forEach(n => leadBody.appendChild(n));
        containerEl.insertBefore(leadBody, card.nextSibling);
    }

    // 첫 최상위 헤딩 앞에 clear 센티넬을 넣어, 그 이후 본문 섹션은 float 를 해제하고
    // 전체 폭으로 배치한다(도입부만 카드 옆을 차지).
    const firstHeading = Array.from(containerEl.children).find(isTopHeading);
    if (firstHeading) {
        const clearEl = document.createElement('div');
        clearEl.className = 'wiki-toc-clear';
        containerEl.insertBefore(clearEl, firstHeading);
    }
}

// numberHeadings()는 헤딩별로 항상 `s-{N.N}` 형태의 앵커를 보장한다.
// 원본 마크다운/HTML이 부여한 기존 id 가 있는 경우 h.id 는 그 값을 유지하고,
// 별도의 <span class="wiki-section-anchor" id="s-N"> 가 헤딩 내부에 삽입된다.
function _getSectionAnchorId(heading) {
    const anchorEl = heading.querySelector('.wiki-section-anchor[id^="s-"]');
    if (anchorEl) return anchorEl.id;
    return heading.id || '';
}

// ── 문단(헤딩) 링크 앵커 해석 ──
// URL 해시/위키링크 앵커로 다음 세 형식을 모두 지원한다: `#s-1.2`(내부 ID, 하위 호환),
// `#1.2`(목차 번호), `#제목`(헤딩 텍스트 그대로). 우선순위: 1) 실제 DOM id 완전 일치
// (각주 등 다른 앵커 포함) 2) 순번만 온 경우 `s-{순번}` 매핑 3) 그 외엔 헤딩 텍스트
// (번호 프리픽스 제외)와 정확히 일치하는 헤딩 — 동일 텍스트가 여러 개면 문서상 가장 위(첫 번째)를 사용.
function _resolveAnchorTarget(rawId) {
    if (!rawId) return null;
    let el = document.getElementById(rawId);
    if (el) return el;
    if (/^\d+(?:\.\d+)*$/.test(rawId)) {
        el = document.getElementById(`s-${rawId}`);
        if (el) return el;
    }
    const contentEl = document.getElementById('articleContent') || document.body;
    const headings = contentEl.querySelectorAll('h1:not(.accordion-header), h2:not(.accordion-header), h3:not(.accordion-header), h4:not(.accordion-header)');
    for (const h of headings) {
        // makeCollapsibleSections()가 헤딩 내용을 .wiki-section-heading-text로 감싸면서
        // .wiki-heading-num이 중첩될 수 있으므로, 직계 자식만 보지 않고 복제본에서
        // 번호 프리픽스/버튼류를 모두 제거한 뒤 순수 텍스트를 비교한다.
        const clone = h.cloneNode(true);
        clone.querySelectorAll('.wiki-heading-num, .wiki-heading-copy-btn, .wiki-heading-link-btn, .wiki-heading-edit-btn').forEach(n => n.remove());
        if (clone.textContent.trim() === rawId) return h;
    }
    return null;
}

async function _copySectionLinkToClipboard(url) {
    let ok = false;
    try {
        await navigator.clipboard.writeText(url);
        ok = true;
    } catch (err) {
        const ta = document.createElement('textarea');
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        try { ok = document.execCommand('copy'); } catch (e2) { /* ignore */ }
        document.body.removeChild(ta);
    }
    if (ok && typeof Swal !== 'undefined') {
        Swal.fire({
            icon: 'success',
            title: '섹션 링크가 복사되었습니다.',
            toast: true,
            position: 'top-end',
            timer: 1500,
            showConfirmButton: false
        });
    }
    return ok;
}

// ── 접힌 섹션/폴드를 펼쳐서 타겟이 보이도록 보정 ──
// 본문 섹션 접기(.wiki-section-collapsed), 자체 문법 fold(<details class="wiki-fold">),
// 사이드바의 목차 아코디언(#collapseTOC) — 타겟을 포함하는 접힌 조상을 모두 펼친다.
// 펼침이 발생했으면 true 를 반환하여 호출측이 애니메이션 종료 후 재보정 여부를 결정할 수 있게 한다.
function _expandAncestorsForScroll(targetEl) {
    if (!targetEl) return false;
    let changed = false;
    let el = targetEl.parentElement;
    while (el && el !== document.body) {
        if (el.classList && el.classList.contains('wiki-section-collapsed')) {
            el.classList.remove('wiki-section-collapsed');
            changed = true;
        }
        if (el.tagName === 'DETAILS' && !el.open) {
            el.open = true;
            changed = true;
        }
        // 비활성 Bootstrap 탭 패널 → 대응 nav-tab 버튼을 활성화
        if (el.classList && el.classList.contains('tab-pane') && !el.classList.contains('active')) {
            try {
                const elId = el.id;
                if (elId && window.bootstrap && window.bootstrap.Tab) {
                    const trigger = document.querySelector(`[data-bs-target="#${CSS.escape(elId)}"]`)
                                 || (el.getAttribute('aria-labelledby') ? document.getElementById(el.getAttribute('aria-labelledby')) : null);
                    if (trigger) {
                        window.bootstrap.Tab.getOrCreateInstance(trigger).show();
                        changed = true;
                    }
                }
            } catch (_) { /* ignore */ }
        }
        // 접힌 Bootstrap collapse(.accordion-collapse 포함, 목차 #collapseTOC 도 동일 로직)
        if (el.classList && el.classList.contains('collapse') && !el.classList.contains('show')) {
            try {
                if (window.bootstrap && window.bootstrap.Collapse) {
                    const inst = window.bootstrap.Collapse.getOrCreateInstance(el, { toggle: false });
                    inst.show();
                    changed = true;
                }
            } catch (_) { /* ignore */ }
        }
        el = el.parentElement;
    }
    return changed;
}

// 타겟 요소로 스크롤. 필요하면 접힌 조상들을 먼저 펼친 뒤,
// CSS transition / Bootstrap collapse 애니메이션(~0.35s)이 끝난 뒤 좌표를 재보정한다.
function _scrollToElementWithAncestors(el, options) {
    if (!el) return;
    const opts = options || { behavior: 'instant', block: 'start' };
    const expanded = _expandAncestorsForScroll(el);
    try { el.scrollIntoView(opts); } catch (_) { el.scrollIntoView(); }
    if (expanded) {
        // 애니메이션 진행 중/종료 후 최종 레이아웃 기준으로 다시 스크롤
        const reScroll = () => { try { el.scrollIntoView(opts); } catch (_) { el.scrollIntoView(); } };
        setTimeout(reScroll, 180);
        setTimeout(reScroll, 400);
    }
}

// ── 본문 섹션 접기/펼치기 ──
function makeCollapsibleSections(containerEl) {
    const headings = containerEl.querySelectorAll('h1:not(.accordion-header), h2:not(.accordion-header), h3:not(.accordion-header), h4:not(.accordion-header), h5:not(.accordion-header), h6:not(.accordion-header)');
    if (headings.length < 1) return;
    const minLevel = Math.min(...Array.from(headings).map(h => parseInt(h.tagName[1], 10)));
    _wrapLevelSections(containerEl, minLevel);
}

function _wrapLevelSections(containerEl, level) {
    if (level > 6) return;
    const tagName = 'H' + level;
    const children = Array.from(containerEl.childNodes);
    const inners = [];

    let i = 0;
    while (i < children.length) {
        const child = children[i];
        if (child.nodeName === tagName) {
            // 헤딩의 기존 내용(번호/텍스트/인라인 코드 등)을 단일 span으로 감싼다.
            // display:flex 헤딩에서 텍스트 노드와 <code>가 각기 다른 flex item으로
            // 분해되어 개별적으로 줄바꿈되는 버그(순서 뒤틀림)를 방지하기 위함.
            if (!child.querySelector(':scope > .wiki-section-heading-text')) {
                const textWrapper = document.createElement('span');
                textWrapper.className = 'wiki-section-heading-text';
                while (child.firstChild) {
                    textWrapper.appendChild(child.firstChild);
                }
                child.appendChild(textWrapper);
            }

            // 토글 아이콘 삽입 (왼쪽 끝)
            const toggleIcon = document.createElement('span');
            toggleIcon.className = 'wiki-section-toggle-icon';
            toggleIcon.innerHTML = '<i class="bi bi-chevron-down"></i>';
            child.insertBefore(toggleIcon, child.firstChild);
            child.classList.add('wiki-section-heading');

            // 섹션 래퍼 생성
            const section = document.createElement('div');
            section.className = 'wiki-section wiki-section-level-' + level;
            // 프리뷰 상태 보존용 안정 키 (헤딩 텍스트 + 레벨 기반).
            const headingTextEl = child.querySelector(':scope > .wiki-section-heading-text');
            const headingText = (headingTextEl && headingTextEl.textContent) ? headingTextEl.textContent : (child.textContent || '');
            section.setAttribute('data-state-key', _makeStateKey(`sec${level}`, headingText));
            // 헤딩에 {collapse} 토큰이 있었으면(_applyHeadingCollapseTokens 가 마킹) 기본 접힘.
            if (child.dataset && child.dataset.wikiCollapseDefault === '1') {
                section.classList.add('wiki-section-collapsed');
            }
            child.parentNode.insertBefore(section, child);
            section.appendChild(child);

            // 섹션 본문 래퍼 생성
            const body = document.createElement('div');
            body.className = 'wiki-section-body';
            section.appendChild(body);

            // 애니메이션을 위한 내부 래퍼
            const bodyInner = document.createElement('div');
            bodyInner.className = 'wiki-section-body-inner';
            body.appendChild(bodyInner);
            inners.push(bodyInner);

            // 이 헤딩 이하에 속하는 형제 노드들을 inner로 이동
            let j = i + 1;
            while (j < children.length) {
                const sibling = children[j];
                // 일반 H태그 체크
                const m = sibling.nodeName.match(/^H(\d)$/);
                if (m && parseInt(m[1], 10) <= level) break;
                // 이미 래핑된 상위 레벨의 섹션인지 체크
                let isHigherOrEqualSection = false;
                if (sibling.nodeType === 1 && sibling.classList.contains('wiki-section')) {
                    for (let l = 1; l <= level; l++) {
                        if (sibling.classList.contains('wiki-section-level-' + l)) {
                            isHigherOrEqualSection = true;
                            break;
                        }
                    }
                }
                if (isHigherOrEqualSection) break;
                bodyInner.appendChild(sibling);
                j++;
            }

            // 헤딩 클릭: 본문 내 링크/버튼은 자체 핸들러로 위임하고,
            // 그 외 영역(텍스트/여백/chevron) 클릭은 섹션 접기/펼치기.
            // 섹션 링크 복사는 헤딩 우측의 별도 버튼(.wiki-heading-link-btn)에서 처리.
            child.addEventListener('click', function (e) {
                if (e.target.closest('a, button')) return;
                section.classList.toggle('wiki-section-collapsed');
            });

            i = j;
        } else {
            i++;
        }
    }

    // 하위 레벨 섹션 재귀 처리
    // 현재 레벨에서 생성된 내부 래퍼들을 대상으로 하위 레벨 적용
    inners.forEach(function (inner) {
        _wrapLevelSections(inner, level + 1);
    });

    // 만약 상위 레벨 헤딩 없이 하위 레벨 헤딩만 존재하는 경우를 위해
    // 현재 containerEl에 대해서도 하위 레벨 처리를 수행
    _wrapLevelSections(containerEl, level + 1);
}

// ── 확장 문법(위키링크, 아이콘 등) 처리 ──
function processWikiLinks(contentEl) {
    if (!contentEl) return;
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];

    while (walker.nextNode()) {
        const parentTag = walker.currentNode.parentNode.tagName;
        if (parentTag === 'CODE' || parentTag === 'PRE') continue;

        const val = walker.currentNode.nodeValue;
        if (val.includes('[[') || val.includes('{bi:') || val.includes('{mdi:') || val.includes('{icon:')) {
            textNodes.push(walker.currentNode);
        }
    }

    textNodes.forEach(node => {
        const frag = document.createDocumentFragment();
        const parts = node.nodeValue.split(/(\[\[[^\]]+\]\]|(?<!\{)\{bi:[\w-]+\}(?!\})|(?<!\{)\{mdi:[\w-]+\}(?!\})|(?<!\{)\{icon:[\w-]+\}(?!\}))/g).filter(Boolean);

        parts.forEach(part => {
            if (part.startsWith('[[') && part.endsWith(']]')) {
                const innerContent = part.slice(2, -2).trim();
                let linkText = innerContent;
                let displayText = innerContent;
                const pipeIndex = innerContent.indexOf('|');
                if (pipeIndex !== -1) {
                    linkText = innerContent.substring(0, pipeIndex).trim();
                    displayText = innerContent.substring(pipeIndex + 1).trim();
                }

                // 섹션 링크 문법: [[slug#1.2]], [[slug#s-1.2]], [[slug#제목]], [[#1.2]] 등
                // 슬러그에는 '#'이 금지 문자(서버/에디터에서 검증)이므로
                // '#'을 발견하면 항상 앵커 구분자로 취급하고 슬러그에서 제거한다.
                // '#' 뒷부분은 목차 번호(`1.2`), 내부 ID(`s-1.2`), 헤딩 제목 텍스트를 모두
                // 허용하며 실제 대상 매칭은 이동 시점에 _resolveAnchorTarget()이 수행한다
                // (제목이 중복되면 문서상 가장 위 헤딩으로 매칭).
                let anchor = '';
                const hashIdx = linkText.indexOf('#');
                if (hashIdx !== -1) {
                    const candidate = linkText.substring(hashIdx + 1).trim();
                    linkText = linkText.substring(0, hashIdx).trim();
                    if (candidate) anchor = candidate;
                }

                if (!linkText && !anchor) {
                    // 유효한 슬러그도 앵커도 없음 → 원본 텍스트 그대로 노출
                    frag.appendChild(document.createTextNode(part));
                    return;
                }

                const a = document.createElement('a');
                if (!linkText && anchor) {
                    // 같은 페이지 앵커(제목 형식은 공백/한글 포함 가능하므로 인코딩)
                    a.href = `#${encodeURIComponent(anchor)}`;
                } else {
                    a.href = `${_renderCtx.wikiLinkBase}/${encodeURIComponent(linkText)}${anchor ? '#' + encodeURIComponent(anchor) : ''}`;
                }
                a.textContent = displayText;
                a.onclick = (e) => {
                    e.preventDefault();
                    const href = a.getAttribute('href');
                    if (href && href.startsWith('#')) {
                        // 같은 페이지 앵커: 재로드 없이 스크롤
                        let id;
                        try {
                            id = decodeURIComponent(href.slice(1));
                        } catch (_) {
                            id = href.slice(1);
                        }
                        const target = id ? _resolveAnchorTarget(id) : null;
                        if (target) {
                            history.pushState(null, '', href);
                            _scrollToElementWithAncestors(target, { behavior: 'smooth', block: 'start' });
                        }
                        return;
                    }
                    if (typeof navigateTo === 'function') {
                        navigateTo(a.href);
                    } else {
                        window.location.href = a.href;
                    }
                };
                frag.appendChild(a);
            } else if (part.startsWith('{bi:') && part.endsWith('}')) {
                const iconName = part.slice(4, -1);
                const i = document.createElement('i');
                i.className = `bi bi-${iconName}`;
                frag.appendChild(i);
            } else if (part.startsWith('{mdi:') && part.endsWith('}')) {
                const iconName = part.slice(5, -1);
                const span = document.createElement('span');
                span.className = `mdi mdi-${iconName}`;
                frag.appendChild(span);
            } else if (part.startsWith('{icon:') && part.endsWith('}')) {
                const iconCode = part.slice(6, -1);
                if (iconCode.startsWith('bi-')) {
                    const el = document.createElement('i');
                    el.className = `bi ${iconCode}`;
                    frag.appendChild(el);
                } else if (iconCode.startsWith('mdi-')) {
                    const el = document.createElement('span');
                    el.className = `mdi ${iconCode}`;
                    frag.appendChild(el);
                } else {
                    const errSpan = document.createElement('span');
                    errSpan.className = 'text-danger';
                    errSpan.title = '알 수 없는 아이콘 접두사: bi- 또는 mdi-로 시작해야 합니다';
                    errSpan.textContent = part;
                    frag.appendChild(errSpan);
                }
            } else if (part) {
                frag.appendChild(document.createTextNode(part));
            }
        });

        node.parentNode.replaceChild(frag, node);
    });
}

// ── 사용자 멘션 처리 (@[user:123]) ──
// 토론·티켓 댓글 렌더에서만 동작한다. renderWikiContent 가 options.mentions
// (id→{name} 맵) 를 전달할 때만 호출되며, 일반 위키 본문 렌더에는 영향이 없다.
// processWikiLinks 와 동일하게 마크다운/정화 이후 DOM 텍스트 노드를 후처리한다.
function processMentions(contentEl, mentionUsers) {
    if (!contentEl) return;
    const users = mentionUsers && typeof mentionUsers === 'object' ? mentionUsers : {};
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];

    while (walker.nextNode()) {
        // Prism 하이라이트는 코드블록 텍스트를 중첩 span 으로 감싸므로 직계 부모만 보면
        // CODE/PRE 안의 텍스트를 놓친다. 조상까지 검사해 코드 내 @[user:N] 치환을 방지한다.
        const parentEl = walker.currentNode.parentElement;
        if (parentEl && parentEl.closest('code, pre')) continue;
        if (walker.currentNode.nodeValue.includes('@[user:')) {
            textNodes.push(walker.currentNode);
        }
    }

    textNodes.forEach(node => {
        const frag = document.createDocumentFragment();
        const parts = node.nodeValue.split(/(@\[user:\d+\])/g).filter(part => part !== '');

        parts.forEach(part => {
            const m = /^@\[user:(\d+)\]$/.exec(part);
            if (m) {
                const id = m[1];
                const info = users[id];
                if (info && info.name) {
                    const a = document.createElement('a');
                    a.href = `/profile/${id}`;
                    a.className = 'wiki-mention';
                    a.textContent = `@${info.name}`;
                    a.onclick = (e) => {
                        e.preventDefault();
                        if (typeof navigateTo === 'function') {
                            navigateTo(a.href);
                        } else {
                            window.location.href = a.href;
                        }
                    };
                    frag.appendChild(a);
                } else {
                    // 삭제/알 수 없는 사용자
                    const span = document.createElement('span');
                    span.className = 'wiki-mention wiki-mention-unknown';
                    span.textContent = '@(알 수 없음)';
                    frag.appendChild(span);
                }
            } else if (part) {
                frag.appendChild(document.createTextNode(part));
            }
        });

        node.parentNode.replaceChild(frag, node);
    });
}

// ── 각주 처리 ──
var _fnUniqueCounter = 0;

const _WIKI_FN_ALLOWED_TAGS = ['strong', 'em', 'code', 's', 'del', 'a', 'span', 'i', 'b', 'u', 'mark', 'sup', 'sub', 'br'];
const _WIKI_FN_ALLOWED_ATTR = ['href', 'title', 'class', 'style', 'target', 'rel'];

function _sanitizeFootnoteHtml(html) {
    const src = html == null ? '' : String(html);
    if (typeof DOMPurify !== 'undefined') {
        return DOMPurify.sanitize(src, {
            ALLOWED_TAGS: _WIKI_FN_ALLOWED_TAGS,
            ALLOWED_ATTR: _WIKI_FN_ALLOWED_ATTR,
        });
    }
    return escapeHtml(src);
}

// 여러 참조 위치의 백링크 첨자(a·b·c… → 26개 초과 시 번호로 폴백).
function _fnBackLabel(i) {
    return i < 26 ? String.fromCharCode(97 + i) : String(i + 1);
}

function processFootnotes(contentEl) {
    if (!contentEl) return;
    // 정의(data-fn-html) 와 재참조(data-fn-ref) 마커를 문서 순서대로 모두 수집한다.
    const markers = Array.from(contentEl.querySelectorAll('sup.wiki-fn-marker[data-fn-html], sup.wiki-fn-marker[data-fn-ref]'));
    if (markers.length === 0) return;

    // 번호는 "문서상 첫 등장" 순서로 매긴다(정의/재참조 무관, MediaWiki 동일).
    // 이름 있는 각주는 이름별로 하나의 번호와 정의 내용을 공유하고, 각 참조 위치는
    // 개별 백링크(a·b·c…)를 갖는다. 익명 각주는 참조마다 독립된 번호를 갖는다.
    let footnoteIndex = 0;
    const order = [];               // { num, html|null, refs: marker[], fnId, refIds }
    const namedEntries = new Map();  // name -> entry

    markers.forEach(marker => {
        const name = marker.getAttribute('data-fn-name');
        const hasHtml = marker.hasAttribute('data-fn-html');
        const rawHtml = hasHtml ? (marker.getAttribute('data-fn-html') || '') : null;
        if (!name) {
            // 익명 각주: 참조마다 독립된 note.
            footnoteIndex++;
            const entry = { num: footnoteIndex, html: _sanitizeFootnoteHtml(rawHtml || ''), refs: [marker] };
            order.push(entry);
        } else {
            let entry = namedEntries.get(name);
            if (!entry) {
                footnoteIndex++;
                entry = { num: footnoteIndex, html: null, refs: [] };
                namedEntries.set(name, entry);
                order.push(entry);
            }
            // 첫 번째 정의 내용을 채택(정의가 재참조보다 뒤에 와도 반영).
            if (rawHtml != null && entry.html == null) entry.html = _sanitizeFootnoteHtml(rawHtml);
            entry.refs.push(marker);
        }
    });

    // 안정 id 부여.
    order.forEach(entry => {
        const uniqueId = ++_fnUniqueCounter;
        entry.fnId = `fn-${entry.num}-${uniqueId}`;
        entry.refIds = entry.refs.map((_, i) => `fn-ref-${entry.num}-${uniqueId}-${i}`);
    });

    // 본문 마커를 참조 링크로 교체(각 참조 위치는 자기 refId 를 가진다).
    order.forEach(entry => {
        const multi = entry.refs.length > 1;
        const contentHtml = entry.html != null ? entry.html : '';
        entry.refs.forEach((marker, i) => {
            const sup = document.createElement('sup');
            sup.className = 'wiki-fn-ref';
            const a = document.createElement('a');
            a.href = `#${entry.fnId}`;
            a.id = entry.refIds[i];
            // 재사용 각주는 [n-a] 처럼 첨자를 붙여 어느 참조인지 구분한다.
            a.textContent = multi ? `[${entry.num}-${_fnBackLabel(i)}]` : `[${entry.num}]`;

            if (typeof bootstrap !== 'undefined' && contentHtml) {
                a.setAttribute('data-bs-toggle', 'popover');
                a.setAttribute('data-bs-trigger', 'hover focus');
                a.setAttribute('data-bs-placement', 'top');
                a.setAttribute('data-bs-html', 'true');
                a.setAttribute('data-bs-content', contentHtml);
            }

            a.onclick = (e) => {
                e.preventDefault();
                if (window.innerWidth >= 992) {
                    const target = document.getElementById(entry.fnId);
                    if (target) _scrollToElementWithAncestors(target, { behavior: 'smooth', block: 'start' });
                }
            };
            sup.appendChild(a);
            marker.parentNode?.replaceChild(sup, marker);
        });
    });

    if (order.length > 0) {
        const fnSection = document.createElement('div');
        fnSection.className = 'wiki-footnotes';
        fnSection.innerHTML = `<hr><h4><i class="bi bi-card-text"></i> 각주</h4>`;

        const ol = document.createElement('ol');
        order.forEach(entry => {
            const li = document.createElement('li');
            li.id = entry.fnId;

            // 참조가 하나면 기존과 동일한 아이콘 백링크, 여럿이면 참조별 a·b·c 첨자.
            if (entry.refs.length === 1) {
                const backLink = document.createElement('a');
                backLink.href = `#${entry.refIds[0]}`;
                backLink.className = 'wiki-fn-back';
                backLink.innerHTML = '<i class="bi bi-arrow-return-left"></i>';
                backLink.title = '본문으로 돌아가기';
                backLink.onclick = (e) => {
                    e.preventDefault();
                    document.getElementById(entry.refIds[0])?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                };
                li.appendChild(backLink);
            } else {
                entry.refIds.forEach((rid, i) => {
                    const backLink = document.createElement('a');
                    backLink.href = `#${rid}`;
                    backLink.className = 'wiki-fn-back wiki-fn-back-multi';
                    backLink.textContent = _fnBackLabel(i);
                    backLink.title = '이 참조 위치로 돌아가기';
                    backLink.onclick = (e) => {
                        e.preventDefault();
                        document.getElementById(rid)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    };
                    li.appendChild(backLink);
                });
            }

            const span = document.createElement('span');
            span.innerHTML = ' ' + (entry.html != null ? entry.html : '<span class="text-muted">(내용 없음)</span>');

            li.appendChild(span);
            ol.appendChild(li);
        });

        fnSection.appendChild(ol);
        contentEl.appendChild(fnSection);
    }
}

// 렌더된 문서 본문(contentEl)을 "문서 텍스트 복사"용 평문으로 추출한다.
// 본문의 각주 마커는 이미 `[1]`·`[2]` 형태로 렌더돼 있으므로 그대로 두고,
// 하단의 `.wiki-footnotes` 섹션(아이콘 헤딩 + 번호 없는 <ol>)은 잘라낸 뒤
// `각주\n[1] 내용\n[2] 내용2` 형태로 번호를 붙여 다시 이어 붙인다.
function extractPlainTextWithFootnotes(contentEl) {
    if (!contentEl) return '';
    const fnSection = contentEl.querySelector('.wiki-footnotes');
    if (!fnSection) return contentEl.innerText;

    // 각주 항목을 번호와 함께 평문 라인으로 만든다(되돌아가기 아이콘은 span 외부라 제외됨).
    const items = Array.from(fnSection.querySelectorAll(':scope > ol > li'));
    const lines = items.map((li, i) => {
        const span = li.querySelector('span');
        const text = (span ? span.innerText : li.innerText).replace(/\s+/g, ' ').trim();
        return `[${i + 1}] ${text}`;
    });

    // 본문 텍스트는 각주 섹션을 잠시 떼어낸 상태에서 읽는다(동기 처리라 화면 깜빡임 없음).
    const parent = fnSection.parentNode;
    const nextSibling = fnSection.nextSibling;
    fnSection.remove();
    const bodyText = contentEl.innerText;
    if (nextSibling) parent.insertBefore(fnSection, nextSibling);
    else parent.appendChild(fnSection);

    if (lines.length === 0) return bodyText;
    return `${bodyText.replace(/\s+$/, '')}\n\n각주\n${lines.join('\n')}`;
}

// ── 색상값 → [r,g,b] 파서 (캐시). 16진/rgb는 직접 파싱, 그 외는 DOM 폴백. ──
const _wikiColorRgbCache = new Map();
function _wikiColorToRgb(value) {
    if (!value || typeof value !== 'string') return null;
    const key = value.trim().toLowerCase();
    if (_wikiColorRgbCache.has(key)) return _wikiColorRgbCache.get(key);
    let rgb = null;
    let m = key.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
    if (m) {
        const h = m[1];
        if (h.length === 3 || h.length === 4) {
            rgb = [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
        } else {
            rgb = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
        }
    } else if ((m = key.match(/^rgba?\(\s*([\d.]+)\s*,?\s*([\d.]+)\s*,?\s*([\d.]+)/))) {
        rgb = [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
    } else if (typeof document !== 'undefined' && document.body) {
        try {
            const el = document.createElement('div');
            el.style.color = value;
            if (el.style.color) {
                el.style.position = 'absolute';
                el.style.visibility = 'hidden';
                document.body.appendChild(el);
                const c = getComputedStyle(el).color;
                document.body.removeChild(el);
                const mm = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
                if (mm) rgb = [+mm[1], +mm[2], +mm[3]];
            }
        } catch (_) { rgb = null; }
    }
    _wikiColorRgbCache.set(key, rgb);
    return rgb;
}

// 배경색에 대한 상대휘도 기반 자동 텍스트 색상(WCAG 휘도 공식).
function _wikiAutoContrastColor(bg) {
    const rgb = _wikiColorToRgb(bg);
    if (!rgb) return null;
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const lum = 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
    return lum > 0.5 ? '#1a1a1a' : '#f5f5f5';
}

// ── CSS 색상 값 검증 ──
function _isSafeCssColor(value) {
    if (!value || typeof value !== 'string') return false;
    // 위험 키워드 차단
    const lower = value.toLowerCase().replace(/\s/g, '');
    // 예외: 통제된 빌트인 팔레트 토큰 참조만 허용. _resolvePaletteTokens 가 빌트인 {palette:NAME}
    // 을 이 형태로 풀어 컴포넌트(badge/tag/button/stat/제목/카드)에 인라인하므로 var() 가 필요하다.
    // 패턴이 --wiki-palette-<영소문자>-(bg|text) 로 고정돼 임의 var() 주입은 불가하다(아래 var( 차단 유지).
    if (/^var\(--wiki-palette-[a-z]+-(?:bg|text)\)$/.test(lower)) return true;
    if (lower.includes('url(') || lower.includes('expression(') || lower.includes('var(') || lower.includes('env(')) return false;
    // CSS.supports가 있으면 브라우저 네이티브 검증
    if (typeof CSS !== 'undefined' && CSS.supports) {
        return CSS.supports('color', value);
    }
    // 폴백: 안전한 패턴만 허용
    return /^(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(rgb|hsl)a?\([0-9,.\s/%]+\))$/.test(value);
}

// ── 컬러 팔레트 하드코딩 프리셋 (단일 소스) ──
// render.js(렌더링)와 edit.js(에디터 자동완성)가 동일한 정의를 참조하도록 render.js에 둔다.
// 라이트/다크 모두 자연스럽게 보이도록 모드별 색상을 분리 정의.
// (빌트인 이름은 palettes.ts RESERVED_PALETTE_NAMES 로 커스텀 생성이 차단되고, 본문 renderer 도
//  BUILTIN_PALETTE_NAMES 를 먼저 가로채므로 "커스텀이 빌트인 이름을 덮는" 시나리오는 발생하지 않는다.)
//
// ⚠ 본문 렌더 경로는 빌트인 7종을 더 이상 이 hex 로 인라인하지 않고 render.css 의
// mark.wiki-palette-NAME 클래스(= style.css :root 의 --wiki-palette-* 토큰 참조)로 렌더해
// 테마/스킨/다크모드에 자동 반응한다. 따라서 아래 hex 는 (1) 빌트인 이름 집합 enumeration
// (BUILTIN_PALETTE_NAMES / 에디터 자동완성 목록)과 (2) 커스텀 판정의 소스로만 쓰이며,
// 빌트인 스와치 미리보기도 클래스를 쓰므로 hex 자체는 표시에 거의 관여하지 않는다.
// 색을 바꾸려면 style.css 의 --wiki-palette-* 토큰을 수정하고 이 hex 와 동기화한다.
const WIKI_HARDCODED_PALETTES = {
    primary:   { light: { bg: '#0D65F5', color: '#FFFFFF' }, dark: { bg: '#0D65F5', color: '#FFFFFF' } },
    secondary: { light: { bg: '#6C757D', color: '#FFFFFF' }, dark: { bg: '#5A6370', color: '#FFFFFF' } },
    success:   { light: { bg: '#198754', color: '#FFFFFF' }, dark: { bg: '#198754', color: '#FFFFFF' } },
    info:      { light: { bg: '#0DCAF0', color: '#000000' }, dark: { bg: '#0A7A9B', color: '#FFFFFF' } },
    warning:   { light: { bg: '#FFC107', color: '#000000' }, dark: { bg: '#E0A800', color: '#000000' } },
    danger:    { light: { bg: '#DC3545', color: '#FFFFFF' }, dark: { bg: '#DC3545', color: '#FFFFFF' } },
    muted:     { light: { bg: '#ADB5BD', color: '#212529' }, dark: { bg: '#6C757D', color: '#FFFFFF' } },
};

// 빌트인 팔레트 이름 집합(= 위 테이블 키, palettes.ts RESERVED_PALETTE_NAMES 와 동일 집합).
// 본문 renderer 가 "빌트인(클래스) vs 커스텀(인라인 hex)" 을 가르는 단일 판정 소스.
const BUILTIN_PALETTE_NAMES = new Set(Object.keys(WIKI_HARDCODED_PALETTES));

/**
 * 커스텀 팔레트 + 하드코딩을 병합한 팔레트 맵. 커스텀 우선.
 *
 * 소스 우선순위:
 *   1. _currentRenderPalettes — renderWikiContent(content, slug, container, {palettes})
 *      가 매 호출 시점에 세팅. SPA 네비게이션 / 블로그 동적 로드처럼 페이지마다 다른
 *      팔레트 집합을 받는 경로에서 정확한 매핑을 보장. 초기 SSR 페이지의 메인 본문
 *      렌더 역시 index.html / blog.html 이 window._ssrData._usedPalettes 를 options.palettes
 *      로 명시 전달하므로 이 분기로 처리된다.
 *   2. appConfig.palettes — /api/config 가 채우는 전체 집합. revisions/diff/discussions/
 *      tickets/mypage 처럼 options.palettes 를 명시 전달하지 않는 렌더 경로에서 사용.
 *      그 렌더의 본문에서 참조하는 팔레트가 초기 페이지의 _usedPalettes 부분집합과 다를
 *      수 있으므로 SSR 부분집합 폴백보다 우선해 전체 집합을 적용.
 *   3. #ssr-data 의 _usedPalettes — appConfig 미로딩 상태(드물게) 의 최후 폴백.
 *      options.palettes 를 명시 전달하는 초기 본문 렌더에서는 도달하지 않는다.
 *   4. 모두 없으면 빈 객체 → 하드코딩 프리셋만 사용.
 */
let _currentRenderPalettes = null;
function _readSsrUsedPalettes() {
    try {
        if (typeof document === 'undefined') return null;
        const el = document.getElementById('ssr-data');
        if (!el || !el.textContent) return null;
        const data = JSON.parse(el.textContent);
        const used = data && data._usedPalettes;
        return (used && typeof used === 'object') ? used : null;
    } catch {
        return null;
    }
}
function getMergedWikiPalettes() {
    const appCustom = (typeof appConfig !== 'undefined' && appConfig && appConfig.palettes && typeof appConfig.palettes === 'object') ? appConfig.palettes : null;
    const ssrUsed = (_currentRenderPalettes || appCustom) ? null : _readSsrUsedPalettes();
    const custom = _currentRenderPalettes ?? appCustom ?? ssrUsed ?? {};
    return Object.assign({}, WIKI_HARDCODED_PALETTES, custom);
}


/** 현재 다크모드 여부 (사이트 테마 토글 우선, 미설정 시 OS 설정) */
function _isWikiDarkMode() {
    const themeAttr = document.documentElement.getAttribute('data-theme');
    if (themeAttr === 'dark') return true;
    if (themeAttr === 'light') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

/**
 * 텍스트에 포함된 {palette:이름} 토큰을 {bg:...}{color:...} 토큰으로 치환.
 * - 빌트인 7종: --wiki-palette-* 토큰을 var() 로 풀어, ==text== 하이라이트(클래스)와 동일한
 *   테마/스킨/다크모드 자동 반영을 컴포넌트(badge/tag/button/stat/제목/카드)에도 준다.
 *   (이 var() 는 _isSafeCssColor 의 통제된 예외로 인라인 style 까지 통과한다.)
 * - 커스텀: 현재 모드의 hex 로 풀어 인라인(임의값).
 * 존재하지 않는 팔레트는 원본 토큰을 그대로 남겨 { bg:}/{color:} 파서에서 무시되도록 함.
 * 기존 렌더링 파이프라인의 매크로 치환 단계로서 동작하며 새로운 렌더 경로를 만들지 않음.
 */
function _resolvePaletteTokens(text) {
    if (!text || typeof text !== 'string') return text;
    if (text.indexOf('{palette:') === -1) return text;
    let merged = null; // 커스텀 조회는 필요 시에만
    let isDark = false, isDarkComputed = false;
    return text.replace(/\{palette:\s*([^}\s][^}]*?)\s*\}/g, (match, nameRaw) => {
        const name = nameRaw.trim();
        if (BUILTIN_PALETTE_NAMES.has(name)) {
            // 빌트인: 테마 토큰을 var() 로(라이트/다크/스킨은 토큰 자체가 해소).
            return `{bg:var(--wiki-palette-${name}-bg)}{color:var(--wiki-palette-${name}-text)}`;
        }
        if (!merged) merged = getMergedWikiPalettes();
        const entry = merged[name];
        if (!entry) return match; // 미등록 이름: 원본 유지 (bg/color 파서도 매칭 실패하여 무시됨)
        if (!isDarkComputed) { isDark = _isWikiDarkMode(); isDarkComputed = true; }
        const variant = isDark ? entry.dark : entry.light;
        if (!variant) return match;
        let out = '';
        if (variant.bg) out += `{bg:${variant.bg}}`;
        if (variant.color) out += `{color:${variant.color}}`;
        return out || match;
    });
}

// ── 고급 레이아웃: ::: 블록 디렉티브 & 인라인 칩 ──

// 페이지 내 동일 컴포넌트 인스턴스 간 ID 충돌 방지용 카운터.
// (탭/아코디언은 BS data-bs-target / aria-controls 가 unique id 를 요구)
var _wikiBsBlockCounter = 0;
function _nextWikiBsId(prefix) {
    _wikiBsBlockCounter++;
    return `${prefix}-${_wikiBsBlockCounter}`;
}

// 프리뷰 상태 보존용 안정 키 생성. 같은 콘텐츠(제목 텍스트) 가 여러 번 나오는
// 경우 N번째 등장에 :N 접미사를 붙여 구분한다. 한 번의 renderWikiContent 호출
// 동안에만 의미를 가지므로 시작 시점에 _resetStateKeyDedup() 으로 초기화한다.
// 모듈 전역이지만 호출이 await 로 인해 인터리브 될 수 있으므로(에디터 실시간
// 프리뷰가 디바운스 없이 키 입력마다 renderWikiContent 를 호출), renderWikiContent
// 는 자신의 dedup 객체에 대한 참조를 로컬 변수로 유지하고 매 await 직후 글로벌에
// 복원한다. _resetStateKeyDedup() 은 새 dedup 객체를 반환해 호출처가 보관할 수
// 있도록 한다.
var _stateKeyDedup = Object.create(null);
function _resetStateKeyDedup() {
    _stateKeyDedup = Object.create(null);
    return _stateKeyDedup;
}
function _makeStateKey(prefix, text) {
    const base = (text == null ? '' : String(text)).trim().replace(/\s+/g, ' ');
    const k = `${prefix}|${base}`;
    const n = _stateKeyDedup[k] || 0;
    _stateKeyDedup[k] = n + 1;
    // 키 자체는 attribute value 로 들어가므로 escapeHtml 처리한 결과를 돌려준다.
    return escapeHtml(n === 0 ? k : `${k}#${n}`);
}

// 탭/아코디언의 {id:이름} 을 페이지 내 유일한 DOM id 로 변환한다. 같은 이름이
// 여러 번 나오면 _makeStateKey 와 동일한 렌더-스코프 카운터(_stateKeyDedup)로
// dedup 해 두 번째부터 `이름-2`, `이름-3` … 을 부여한다(딥링크 #이름 은 문서상
// 첫 번째를 가리킴 — 헤딩 텍스트 앵커와 동일한 "가장 위" 규칙). 입력은
// _extractStrictTokens 의 id 타입이 [a-zA-Z0-9_-] 로 이미 검증한다.
function _dedupAnchorDomId(name) {
    const k = `@id|${name}`;
    const n = _stateKeyDedup[k] || 0;
    _stateKeyDedup[k] = n + 1;
    return n === 0 ? name : `${name}-${n + 1}`;
}

/**
 * 컨테이너 블록(:::tabs / :::accordion / :::steps) 의 innerText 에서
 * WIKIBLOCKPH<i>XEND 플레이스홀더를 순서대로 수집해 자식 block 객체로 반환.
 * 자식 type 이 allowedTypes 에 없으면 무시한다.
 */
function _collectWikiChildBlocks(parentInnerText, blockData, allowedTypes) {
    if (!parentInnerText) return [];
    const re = /WIKIBLOCKPH(\d+)XEND/g;
    const out = [];
    let m;
    while ((m = re.exec(parentInnerText)) !== null) {
        const idx = parseInt(m[1], 10);
        const child = blockData[idx];
        if (!child) continue;
        if (allowedTypes && !allowedTypes.includes(child.type)) continue;
        out.push(child);
    }
    return out;
}

/** 특정 토큰 키만 추출하고 반환된 cleanTitle 에서 제거. enum 검증으로 자유 CSS 차단. */
function _extractStrictTokens(titleLine, schema) {
    let t = titleLine || '';
    const found = {};
    for (const key of Object.keys(schema)) {
        const spec = schema[key];
        if (spec.type === 'enum') {
            const re = new RegExp(`\\{${key}:\\s*([^}\\s]+)\\s*\\}`);
            const m = t.match(re);
            if (m) {
                const v = m[1].trim();
                if (spec.values.includes(v)) found[key] = v;
                t = t.replace(m[0], '');
            }
        } else if (spec.type === 'flag') {
            const re = new RegExp(`\\{${key}\\}`);
            const m = t.match(re);
            if (m) {
                found[key] = true;
                t = t.replace(m[0], '');
            }
        } else if (spec.type === 'icon') {
            const re = new RegExp(`\\{${key}:\\s*([a-zA-Z0-9_-]+)\\s*\\}`);
            const m = t.match(re);
            if (m) {
                const v = m[1].trim();
                if (/^(bi-|mdi-)[a-zA-Z0-9_-]+$/.test(v)) found[key] = v;
                t = t.replace(m[0], '');
            }
        } else if (spec.type === 'id') {
            // 안정 앵커 ID 토큰 {id:이름}. 아이콘 토큰과 동일한 [a-zA-Z0-9_-] 문자 규칙.
            const re = new RegExp(`\\{${key}:\\s*([a-zA-Z0-9_-]+)\\s*\\}`);
            const m = t.match(re);
            if (m) {
                found[key] = m[1].trim();
                t = t.replace(m[0], '');
            }
        }
    }
    return { cleanTitle: t.replace(/\s+/g, ' ').trim(), tokens: found };
}

/** 자식 블록 본문(innerText)을 marked 로 렌더링. 중첩 WIKIBLOCKPH 도 재귀 치환. */
function _renderChildInnerHtml(innerText, blockData) {
    const { text: protectedInner, prot: wlProt } = protectWikiLinks(innerText || '');
    let innerHtml = (typeof marked !== 'undefined') ? marked.parse(protectedInner) : protectedInner;
    innerHtml = restoreWikiLinks(innerHtml, wlProt);
    innerHtml = _replaceTaskCheckboxesWithIcons(innerHtml);
    innerHtml = innerHtml.replace(/<img([^>]*)>\s*\{size:([a-zA-Z0-9_-]+)\}/g, (_, attrs, size) => `<img${attrs} data-size="${size.trim()}">`);
    innerHtml = innerHtml.replace(/(?:<p>)?WIKIBLOCKPH(\d+)XEND(?:<\/p>)?/g, (m, i) => {
        const sub = blockData[parseInt(i, 10)];
        return sub ? _renderBlockHtml(sub, blockData) : '';
    });
    return innerHtml;
}

/** 아이콘 토큰을 HTML 로 변환 (bi-* / mdi-*) */
function _iconHtmlFromToken(iconCode) {
    if (!iconCode) return '';
    if (iconCode.startsWith('bi-')) return `<i class="bi ${escapeHtml(iconCode)}" aria-hidden="true"></i>`;
    if (iconCode.startsWith('mdi-')) return `<span class="mdi ${escapeHtml(iconCode)}" aria-hidden="true"></span>`;
    return '';
}



/**
 * 라인 기반 스택 파서. `:::type 제목` 오프너와 단독 `:::` 클로저로 블록을 수집.
 * 코드블록은 외부에서 이미 WIKICODEFPH 로 보호됐다고 가정.
 * 중첩 지원: 여는 디렉티브 하나당 닫는 `:::` 한 줄이 쌍을 이룸.
 * 반환: { text, blockData } — blockData[i] = { type, titleLine, innerText }
 */
function _preprocessBlockDirectives(text) {
    if (!text || text.indexOf(':::') === -1) return { text, blockData: [] };
    const lines = text.split('\n');
    const blockData = [];
    const root = { contentLines: [] };
    const stack = [root];
    const openRe = /^:::([a-zA-Z][a-zA-Z0-9_-]*)(?:[ \t]+(.*))?[ \t]*$/;
    const closeRe = /^:::[ \t]*$/;
    for (const line of lines) {
        const om = line.match(openRe);
        if (om) {
            stack.push({ type: om[1], titleLine: (om[2] || '').trim(), contentLines: [] });
            continue;
        }
        if (closeRe.test(line) && stack.length > 1) {
            const frame = stack.pop();
            const idx = blockData.length;
            blockData.push({ type: frame.type, titleLine: frame.titleLine, innerText: frame.contentLines.join('\n') });
            stack[stack.length - 1].contentLines.push(`\n\nWIKIBLOCKPH${idx}XEND\n\n`);
            continue;
        }
        stack[stack.length - 1].contentLines.push(line);
    }
    // 미종료 블록은 원문 복원 (오타에 관대하게)
    while (stack.length > 1) {
        const orphan = stack.pop();
        const literal = `:::${orphan.type}${orphan.titleLine ? ' ' + orphan.titleLine : ''}\n` + orphan.contentLines.join('\n');
        stack[stack.length - 1].contentLines.push(literal);
    }
    return { text: root.contentLines.join('\n'), blockData };
}

/** titleLine에서 {palette:}/{bg:}/{color:} 토큰을 흡수해 { cleanTitle, bg, color } 반환 */
function _extractBlockStyleTokens(titleLine) {
    let t = _resolvePaletteTokens(titleLine || '');
    let bg = '', color = '';
    let replaced = true;
    while (replaced) {
        replaced = false;
        const bm = t.match(/\{bg:\s*([^}]+)\}/);
        if (bm) { bg = bm[1].trim(); t = t.replace(bm[0], ''); replaced = true; }
        const cm = t.match(/\{color:\s*([^}]+)\}/);
        if (cm) { color = cm[1].trim(); t = t.replace(cm[0], ''); replaced = true; }
    }
    t = t.replace(/\{palette:\s*[^}]*\}/g, '');
    return { cleanTitle: t.trim(), bg, color };
}

/** 블록을 HTML로 렌더링. 중첩 WIKIBLOCKPH 는 자체적으로 재귀 치환 */
function _renderBlockHtml(block, blockData) {
    const type = block.type;
    let { cleanTitle, bg, color } = _extractBlockStyleTokens(block.titleLine);
    // 본문 색은 본문 맨 앞의 {bg:}/{color:}/{palette:} 토큰만으로 지정한다.
    let bodyBg = '', bodyColor = '';

    let innerText = block.innerText || '';

    const isCallout = (type === 'info' || type === 'tip' || type === 'success'
                    || type === 'warning' || type === 'danger' || type === 'note');
    if (type === 'card' || isCallout) {
        // 본문 색상 토큰은 본문 첫 줄, 맨 앞에 있을 때만 소비한다.
        // 줄바꿈을 만나면 더 이상 흡수하지 않아 다른 줄의 {bg:}/{color:}/{palette:}
        // 토큰은 인라인 컴포넌트(badge/button/tag 등)의 프리픽스로 그대로 남는다.
        let t = innerText.replace(/^[ \t]+/, '');
        let replaced = true;
        while (replaced) {
            replaced = false;
            let palMatch = t.match(/^\{palette:\s*([^}\s][^}]*?)\s*\}/);
            if (palMatch) {
                const expanded = _resolvePaletteTokens(`{palette:${palMatch[1].trim()}}`);
                if (expanded !== `{palette:${palMatch[1].trim()}}`) {
                    t = expanded + t.slice(palMatch[0].length);
                } else {
                    t = t.slice(palMatch[0].length);
                }
                replaced = true;
                continue;
            }
            let bgMatch = t.match(/^\{bg:\s*([^}]+)\}/);
            if (bgMatch) {
                bodyBg = bgMatch[1].trim();
                t = t.slice(bgMatch[0].length).replace(/^[ \t]+/, '');
                replaced = true;
            }
            let colorMatch = t.match(/^\{color:\s*([^}]+)\}/);
            if (colorMatch) {
                bodyColor = colorMatch[1].trim();
                t = t.slice(colorMatch[0].length).replace(/^[ \t]+/, '');
                replaced = true;
            }
        }
        innerText = t;
    }

    const { text: protectedInner, prot: wlProt } = protectWikiLinks(innerText);
    let innerHtml = (typeof marked !== 'undefined') ? marked.parse(protectedInner) : protectedInner;
    innerHtml = restoreWikiLinks(innerHtml, wlProt);
    innerHtml = _replaceTaskCheckboxesWithIcons(innerHtml);
    innerHtml = innerHtml.replace(/<img([^>]*)>\s*\{size:([a-zA-Z0-9_-]+)\}/g, (_, attrs, size) => `<img${attrs} data-size="${size.trim()}">`);
    innerHtml = innerHtml.replace(/(?:<p>)?WIKIBLOCKPH(\d+)XEND(?:<\/p>)?/g, (m, i) => {
        const sub = blockData[parseInt(i, 10)];
        return sub ? _renderBlockHtml(sub, blockData) : '';
    });

    let style = '';
    if (bg && _isSafeCssColor(bg)) style += `background-color:${bg};`;
    if (color && _isSafeCssColor(color)) style += `color:${color};`;
    const styleAttr = style ? ` style="${style}"` : '';
    let titleHtml: string;
    if (cleanTitle && typeof marked !== 'undefined') {
        const { text: protectedTitle, prot: titleWlProt } = protectWikiLinks(cleanTitle);
        titleHtml = marked.parseInline(protectedTitle) as string;
        titleHtml = restoreWikiLinks(titleHtml, titleWlProt);
        titleHtml = _processInlineLayoutTokens(titleHtml);
    } else {
        titleHtml = escapeHtml(cleanTitle);
    }

    switch (type) {
        case 'card': {
            // 헤더(제목)와 바디(내용)에 스타일을 분리 적용. Bootstrap .card 와 호환.
            let headerStyle = '';
            if (bg && _isSafeCssColor(bg)) headerStyle += `background-color:${bg};`;
            if (color && _isSafeCssColor(color)) headerStyle += `color:${color};`;
            const headerStyleAttr = headerStyle ? ` style="${headerStyle}"` : '';

            let bodyStyle = '';
            if (bodyBg && _isSafeCssColor(bodyBg)) bodyStyle += `background-color:${bodyBg};`;
            if (bodyColor && _isSafeCssColor(bodyColor)) bodyStyle += `color:${bodyColor};`;
            const bodyStyleAttr = bodyStyle ? ` style="${bodyStyle}"` : '';

            return `<div class="card wiki-card">` +
                (titleHtml ? `<div class="card-header wiki-card-header"${headerStyleAttr}>${titleHtml}</div>` : '') +
                `<div class="card-body wiki-card-body"${bodyStyleAttr}>${innerHtml}</div>` +
                `</div>`;
        }
        case 'grid': {
            // 옵션 토큰으로 균등 그리드(고정 열 수) / 비대칭 템플릿 / 간격 / 정렬 제어.
            // 토큰이 없으면 기존 flex-wrap 동작을 그대로 유지(하위호환).
            const { tokens: gt } = _extractStrictTokens(block.titleLine, {
                cols:     { type: 'enum', values: ['2', '3', '4', '5', '6'] },
                template: { type: 'enum', values: ['1-1', '1-2', '2-1', '1-3', '3-1', '1-1-1', '1-2-1', '2-1-1', '1-1-2', '1-1-1-1'] },
                gap:      { type: 'enum', values: ['sm', 'md', 'lg'] },
                align:    { type: 'enum', values: ['start', 'center', 'stretch'] },
            });
            // 화이트리스트에 없는 임의 정수 비율(예: {template:8-4}, {template:3-3-6})도 허용한다.
            // enum 으로는 표현할 수 없으므로 인라인 grid-template-columns(<n>fr ...) 로 직접 생성.
            // 열은 2~6개, 각 값 1~12 정수만 허용(그 외 값은 무시해 기존 동작으로 폴백).
            let customCols = '';
            if (!gt.template) {
                const cm = block.titleLine.match(/\{template:\s*([0-9]+(?:-[0-9]+)+)\s*\}/);
                if (cm) {
                    const parts = cm[1].split('-').map((n) => parseInt(n, 10));
                    if (parts.length >= 2 && parts.length <= 6 && parts.every((n) => n >= 1 && n <= 12)) {
                        customCols = parts.map((n) => `${n}fr`).join(' ');
                    }
                }
            }
            const gridCls = ['wiki-grid'];
            // template(화이트리스트) 또는 customCols(임의 비율)가 cols 보다 우선. 셋 중 하나라도 있으면 CSS grid 모드로 전환.
            if (customCols) gridCls.push('wiki-grid--grid');
            else if (gt.template) gridCls.push('wiki-grid--grid', `wiki-grid--tpl-${gt.template}`);
            else if (gt.cols) gridCls.push('wiki-grid--grid', `wiki-grid--cols-${gt.cols}`);
            if (gt.gap) gridCls.push(`wiki-grid--gap-${gt.gap}`);
            if (gt.align) gridCls.push(`wiki-grid--align-${gt.align}`);
            // 임의 비율은 색(bg/color) 인라인 뒤에 grid-template-columns 를 덧붙인다. 좁은 화면에서는
            // render.css 의 @media 규칙(grid-template-columns:1fr !important)이 인라인을 이겨 단일 열로 접힌다.
            const gridStyle = customCols ? `${style}grid-template-columns:${customCols};` : style;
            const gridStyleAttr = gridStyle ? ` style="${gridStyle}"` : '';
            return `<div class="${gridCls.join(' ')}"${gridStyleAttr}>${innerHtml}</div>`;
        }
        case 'row':
            return `<div class="wiki-row"${styleAttr}>${innerHtml}</div>`;
        case 'canvas': {
            // 12컬럼 자유 배치 컨테이너. 자식 :::area {span:N} 이 각자 차지할 폭을 선언.
            const { tokens: ct } = _extractStrictTokens(block.titleLine, {
                gap: { type: 'enum', values: ['sm', 'md', 'lg'] },
            });
            const children = _collectWikiChildBlocks(block.innerText, blockData, ['area']);
            if (children.length === 0) return `<div class="wiki-canvas-empty"></div>`;
            const canvasCls = ['wiki-canvas'];
            if (ct.gap) canvasCls.push(`wiki-canvas--gap-${ct.gap}`);
            const areas = children.map((child) => {
                const meta = _extractStrictTokens(child.titleLine, {
                    span:  { type: 'enum', values: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'] },
                    panel: { type: 'flag' },
                });
                // 영역별 배경/글자색은 카드와 동일한 색 토큰 규칙을 따른다.
                const cs = _extractBlockStyleTokens(child.titleLine);
                let areaStyle = '';
                if (cs.bg && _isSafeCssColor(cs.bg)) areaStyle += `background-color:${cs.bg};`;
                if (cs.color && _isSafeCssColor(cs.color)) areaStyle += `color:${cs.color};`;
                const areaStyleAttr = areaStyle ? ` style="${areaStyle}"` : '';
                const spanCls = meta.tokens.span ? ` wiki-area--span-${meta.tokens.span}` : '';
                // {panel} 토큰: 카드와 동일한 여백·테두리(chrome)를 부여해 색 영역이 날것으로 보이지 않게 한다.
                const panelCls = meta.tokens.panel ? ' wiki-area--panel' : '';
                const childInner = _renderChildInnerHtml(child.innerText, blockData);
                return `<div class="wiki-area${spanCls}${panelCls}"${areaStyleAttr}>${childInner}</div>`;
            });
            return `<div class="${canvasCls.join(' ')}">${areas.join('')}</div>`;
        }
        case 'tabs': {
            // 탭은 항상 좌측 정렬 (align 토큰 미지원)
            const children = _collectWikiChildBlocks(block.innerText, blockData, ['tab']);
            if (children.length === 0) return `<div class="wiki-tabs-empty"></div>`;
            const groupId = _nextWikiBsId('wiki-tabs');
            const navItems = [];
            const panes = [];
            children.forEach((child, i) => {
                const meta = _extractStrictTokens(child.titleLine, {
                    icon: { type: 'icon' },
                    id: { type: 'id' }
                });
                const tabId = `${groupId}-pane-${i}`;
                const navId = `${groupId}-tab-${i}`;
                const isActive = i === 0;
                const iconHtml = meta.tokens.icon ? _iconHtmlFromToken(meta.tokens.icon) + ' ' : '';
                const labelEsc = escapeHtml(meta.cleanTitle || `탭 ${i + 1}`);
                const tabKey = _makeStateKey('tab', meta.cleanTitle || `tab-${i}`);
                // {id:이름} 딥링크 앵커: 패널 내부 첫 자식으로 marker span 을 심어
                // [[문서#이름]] 이동 시 getElementById → _expandAncestorsForScroll 이
                // 접힌 탭을 자동으로 활성화하도록 한다(스크롤 대상도 패널 내부).
                const anchorMarker = meta.tokens.id
                    ? `<span class="wiki-anchor-target" id="${escapeHtml(_dedupAnchorDomId(meta.tokens.id))}"></span>`
                    : '';
                navItems.push(
                    `<li class="nav-item" role="presentation">` +
                    `<button class="nav-link${isActive ? ' active' : ''}" id="${navId}" ` +
                    `data-bs-toggle="tab" data-bs-target="#${tabId}" type="button" ` +
                    `role="tab" aria-controls="${tabId}" aria-selected="${isActive ? 'true' : 'false'}" ` +
                    `data-state-key="${tabKey}">` +
                    `${iconHtml}${labelEsc}</button></li>`
                );
                const childInner = _renderChildInnerHtml(child.innerText, blockData);
                panes.push(
                    `<div class="tab-pane fade${isActive ? ' show active' : ''}" id="${tabId}" ` +
                    `role="tabpanel" aria-labelledby="${navId}" tabindex="0" data-state-key="${tabKey}">${anchorMarker}${childInner}</div>`
                );
            });
            return `<div class="wiki-tabs">` +
                `<ul class="nav nav-tabs" role="tablist">${navItems.join('')}</ul>` +
                `<div class="tab-content">${panes.join('')}</div>` +
                `</div>`;
        }
        case 'accordion': {
            const { tokens } = _extractStrictTokens(block.titleLine, {
                multiple: { type: 'flag' }
            });
            const children = _collectWikiChildBlocks(block.innerText, blockData, ['item']);
            if (children.length === 0) return `<div class="wiki-accordion-empty"></div>`;
            const groupId = _nextWikiBsId('wiki-acc');
            // 단일 열림 모드(default)에서 data-bs-parent 는 후속 토글에만 적용된다.
            // 초기 렌더에 여러 {open} 이 있으면 BS 가 강제로 닫지 않으므로 첫 번째만 인정.
            const allowMultiple = !!tokens.multiple;
            let openSeen = false;
            const items = children.map((child, i) => {
                const meta = _extractStrictTokens(child.titleLine, {
                    open: { type: 'flag' },
                    icon: { type: 'icon' },
                    id: { type: 'id' }
                });
                const itemId = `${groupId}-item-${i}`;
                const headId = `${groupId}-head-${i}`;
                let isOpen = !!meta.tokens.open;
                if (isOpen && !allowMultiple) {
                    if (openSeen) isOpen = false;
                    else openSeen = true;
                }
                const iconHtml = meta.tokens.icon ? _iconHtmlFromToken(meta.tokens.icon) + ' ' : '';
                const labelEsc = escapeHtml(meta.cleanTitle || `항목 ${i + 1}`);
                const parentAttr = allowMultiple ? '' : ` data-bs-parent="#${groupId}"`;
                const childInner = _renderChildInnerHtml(child.innerText, blockData);
                const accKey = _makeStateKey('acc', meta.cleanTitle || `item-${i}`);
                // {id:이름} 딥링크 앵커: 접힌 항목 본문 내부에 marker 를 심어
                // [[문서#이름]] 이동 시 _expandAncestorsForScroll 이 collapse 를 펼치게 한다.
                const anchorMarker = meta.tokens.id
                    ? `<span class="wiki-anchor-target" id="${escapeHtml(_dedupAnchorDomId(meta.tokens.id))}"></span>`
                    : '';
                return `<div class="accordion-item" data-state-key="${accKey}">` +
                    `<h2 class="accordion-header" id="${headId}">` +
                    `<button class="accordion-button${isOpen ? '' : ' collapsed'}" type="button" ` +
                    `data-bs-toggle="collapse" data-bs-target="#${itemId}" ` +
                    `aria-expanded="${isOpen ? 'true' : 'false'}" aria-controls="${itemId}">` +
                    `${iconHtml}${labelEsc}</button></h2>` +
                    `<div id="${itemId}" class="accordion-collapse collapse${isOpen ? ' show' : ''}" ` +
                    `aria-labelledby="${headId}"${parentAttr}>` +
                    `<div class="accordion-body">${anchorMarker}${childInner}</div>` +
                    `</div></div>`;
            });
            return `<div class="accordion wiki-accordion" id="${groupId}">${items.join('')}</div>`;
        }
        case 'steps': {
            const children = _collectWikiChildBlocks(block.innerText, blockData, ['step']);
            if (children.length === 0) return `<div class="wiki-steps-empty"></div>`;
            const items = children.map((child, i) => {
                const meta = _extractStrictTokens(child.titleLine, {
                    status: { type: 'enum', values: ['done', 'current', 'todo'] }
                });
                const status = meta.tokens.status || 'todo';
                const labelEsc = escapeHtml(meta.cleanTitle || `${i + 1}단계`);
                const ariaCurrent = status === 'current' ? ' aria-current="step"' : '';
                const iconCls = status === 'done' ? 'bi-check-circle-fill'
                              : status === 'current' ? 'bi-circle-fill'
                              : 'bi-circle';
                const childInner = _renderChildInnerHtml(child.innerText, blockData);
                return `<li class="wiki-step wiki-step-${status}"${ariaCurrent}>` +
                    `<div class="wiki-step-marker"><span class="wiki-step-num">${i + 1}</span>` +
                    `<i class="bi ${iconCls} wiki-step-icon" aria-hidden="true"></i></div>` +
                    `<div class="wiki-step-content">` +
                    `<div class="wiki-step-title">${labelEsc}</div>` +
                    `<div class="wiki-step-body">${childInner}</div>` +
                    `</div></li>`;
            });
            return `<ol class="wiki-steps">${items.join('')}</ol>`;
        }
        case 'tab':
        case 'item':
        case 'step':
        case 'area':
            // 부모(tabs/accordion/steps/canvas) 밖에서 단독 사용된 경우: 일반 블록으로 폴백.
            return `<div class="wiki-block wiki-block-${escapeHtml(type)}"${styleAttr}>` +
                (titleHtml ? `<div class="wiki-block-title">${titleHtml}</div>` : '') +
                innerHtml +
                `</div>`;
        case 'embed': {
            const accentRaw = (bg && _isSafeCssColor(bg)) ? bg
                            : (color && _isSafeCssColor(color)) ? color
                            : '';
            const accentStyle = accentRaw ? ` style="border-left-color:${accentRaw};"` : '';
            const embedTitleHtml = titleHtml ? `<div class="wiki-embed-title">${titleHtml}</div>` : '';
            return `<div class="wiki-embed"${accentStyle}>` +
                embedTitleHtml +
                `<div class="wiki-embed-body">${innerHtml}</div>` +
                `</div>`;
        }
        case 'info':
        case 'tip':
        case 'success':
        case 'warning':
        case 'danger':
        case 'note': {
            // Bootstrap .alert 변종으로 매핑. note/tip 은 BS 에 직접 대응이 없어 secondary/info 로.
            const calloutMeta = {
                info:    { icon: 'mdi-information-outline',   title: '정보',   bsVariant: 'info' },
                tip:     { icon: 'mdi-lightbulb-on-outline',  title: '팁',     bsVariant: 'info' },
                success: { icon: 'mdi-check-circle-outline',  title: '성공',   bsVariant: 'success' },
                warning: { icon: 'mdi-alert-outline',         title: '주의',   bsVariant: 'warning' },
                danger:  { icon: 'mdi-alert-octagon-outline', title: '위험',   bsVariant: 'danger' },
                note:    { icon: 'mdi-note-text-outline',     title: '노트',   bsVariant: 'secondary' }
            }[type];
            const headerTitle = titleHtml || escapeHtml(calloutMeta.title);
            return `<div class="alert alert-${calloutMeta.bsVariant} wiki-callout wiki-callout-${type}" role="note">` +
                `<div class="wiki-callout-header">` +
                    `<span class="mdi ${calloutMeta.icon} wiki-callout-icon" aria-hidden="true"></span>` +
                    `<span class="wiki-callout-title">${headerTitle}</span>` +
                `</div>` +
                `<div class="wiki-callout-body">${innerHtml}</div>` +
                `</div>`;
        }
        default:
            return `<div class="wiki-block wiki-block-${escapeHtml(type)}"${styleAttr}>${innerHtml}</div>`;
    }
}

/**
 * HTML 내 인라인 레이아웃 토큰을 치환.
 * - {badge:텍스트}, {tag:텍스트}  → <span>
 * - {button:텍스트|url}           → <a class="wiki-button">
 * - {stat:값|라벨}               → <div>  (선행 <p> 제거)
 * - {hr}                          → <hr class="wiki-block-hr">
 * 선행 {palette:}/{bg:}/{color:} 토큰을 흡수해 스타일로 적용.
 * 코드블록/인라인코드 내부는 보호.
 */
function _processInlineLayoutTokens(html) {
    if (!html || typeof html !== 'string') return html;
    const prot = [];
    html = html.replace(/<pre[\s\S]*?<\/pre>/gi, (m) => { prot.push(m); return `\x00ILTPROT${prot.length - 1}\x00`; });
    html = html.replace(/<code[^>]*>[\s\S]*?<\/code>/gi, (m) => { prot.push(m); return `\x00ILTPROT${prot.length - 1}\x00`; });

    function parseStylePrefix(prefix) {
        let t = _resolvePaletteTokens(prefix || '');
        let bg = '', color = '';
        let replaced = true;
        while (replaced) {
            replaced = false;
            const bm = t.match(/\{bg:\s*([^}]+)\}/);
            if (bm) { bg = bm[1].trim(); t = t.replace(bm[0], ''); replaced = true; }
            const cm = t.match(/\{color:\s*([^}]+)\}/);
            if (cm) { color = cm[1].trim(); t = t.replace(cm[0], ''); replaced = true; }
        }
        return { bg, color };
    }
    function buildStyleAttr(bg, color) {
        let s = '';
        if (bg && _isSafeCssColor(bg)) s += `background-color:${bg};`;
        if (color && _isSafeCssColor(color)) s += `color:${color};`;
        return s ? ` style="${s}"` : '';
    }

    // 인라인 컴포넌트({button:}, {badge:}, {tag:}, {stat:}) 앞에 놓인
    // 스타일/아이콘 토큰({palette|bg|color|mdi|bi|icon|img}:...)을 흡수해 컴포넌트 내부에 렌더링.
    // 순서 무관하게 혼용 가능. 아이콘 토큰은 최대 1개만 소비.
    // 프리픽스는 컴포넌트 매치 후 역방향 결정적 스캔으로 수집하여
    // 탐욕적 반복 정규식의 백트래킹을 회피한다.
    //
    // ![alt](url){size:icon} 문법: marked가 먼저 <img data-size="icon"> HTML로 변환하므로
    // {img:src} 토큰으로 정규화한 뒤 기존 프리픽스 시스템으로 처리한다.
    // 대상 컴포넌트는 extractIconHtml 을 호출하는 것들만 포함(kbd 제외 — 아이콘을 렌더하지 않으므로
    // 변환 시 이미지가 silently drop 됨).
    html = html.replace(
        /<img\b([^>]*)>(?=\s*\{(?:stat|badge|tag|button|progress):[^}]*\})/g,
        (m, attrs) => {
            if (!/data-size="icon"/.test(attrs)) return m;
            const srcMatch = attrs.match(/src="([^"]*)"/);
            if (!srcMatch) return m;
            // marked customImage 렌더러가 src 에 escapeHtml 을 적용한 상태이므로 원복.
            // 그대로 두면 extractIconHtml 의 escapeHtml 이 한 번 더 적용되어 &amp;amp; 등
            // 이중 인코딩으로 인해 query string URL 이 깨진다(&amp; → &amp;amp;).
            const rawSrc = srcMatch[1]
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#0?39;/g, "'")
                .replace(/&amp;/g, '&');
            return `{img:${rawSrc}}`;
        }
    );

    const COMPONENT_TOKEN_RE = /^\{(?:palette|bg|color|mdi|bi|icon|img):[^}]+\}$/;
    const ICON_TOKEN_RE = /^\{(mdi|bi|icon|img):\s*([^}]+?)\s*\}$/;
    const CLASS_NAME_RE = /^[a-zA-Z0-9\-_]+$/;

    function extractIconHtml(prefix) {
        let iconHtml = '';
        const tokenRe = /\{(?:palette|bg|color|mdi|bi|icon|img):[^}]+\}/g;
        let tm;
        while ((tm = tokenRe.exec(prefix)) !== null) {
            const im = tm[0].match(ICON_TOKEN_RE);
            if (!im) continue;
            const type = im[1];
            const name = im[2];
            if (type === 'mdi') {
                // 단일 아이콘 이름만 허용(공백/특수문자로 클래스 주입 방지)
                if (CLASS_NAME_RE.test(name)) {
                    iconHtml = `<span class="mdi mdi-${escapeHtml(name)}" aria-hidden="true"></span>`;
                }
            } else if (type === 'bi') {
                if (CLASS_NAME_RE.test(name)) {
                    iconHtml = `<i class="bi bi-${escapeHtml(name)}" aria-hidden="true"></i>`;
                }
            } else if (type === 'icon') {
                // 공백으로 구분된 복수 클래스 지원 - 각 클래스를 개별 검증
                const classes = name.split(/\s+/).filter(Boolean);
                const allSafe = classes.length > 0 && classes.every(c => CLASS_NAME_RE.test(c));
                if (allSafe) {
                    // 유틸리티 클래스가 섞여 있을 수 있으므로 전체 배열에서 mdi-*/bi-* 토큰 탐지
                    const hasMdi = classes.some(c => c.startsWith('mdi-'));
                    const hasBi = classes.some(c => c.startsWith('bi-'));
                    if (hasMdi) {
                        iconHtml = `<span class="mdi ${escapeHtml(name)}" aria-hidden="true"></span>`;
                    } else if (hasBi) {
                        iconHtml = `<i class="bi ${escapeHtml(name)}" aria-hidden="true"></i>`;
                    } else {
                        // 알 수 없는 아이콘 클래스 → 제네릭 span으로 렌더링
                        iconHtml = `<span class="${escapeHtml(name)}" aria-hidden="true"></span>`;
                    }
                }
            } else if (type === 'img') {
                // ![alt](url){size:icon} 전처리 결과. http/https 및 동일 오리진 상대경로만 허용.
                if (isSafeUrl(name)) {
                    iconHtml = `<img src="${escapeHtml(name)}" class="wiki-icon-img" data-size="icon" alt="" aria-hidden="true">`;
                }
            }
            if (iconHtml) break;
        }
        return iconHtml;
    }

    // 컴포넌트 토큰 뒤에서 역방향으로 연속된 스타일/아이콘 토큰을 수집(선형 시간).
    function collectPrefixStart(s, startIdx, minIdx) {
        let pStart = startIdx;
        while (pStart > minIdx) {
            let j = pStart;
            while (j > minIdx && /\s/.test(s[j - 1])) j--;
            if (j <= minIdx || s[j - 1] !== '}') break;
            let k = j - 2;
            while (k >= minIdx && s[k] !== '{' && s[k] !== '}') k--;
            if (k < minIdx || s[k] !== '{') break;
            if (!COMPONENT_TOKEN_RE.test(s.slice(k, j))) break;
            pStart = k;
        }
        return pStart;
    }

    // 컴포넌트 토큰 스캐너: tokenRe 매치마다 앞의 프리픽스를 수집하고 render로 HTML을 만든다.
    // render가 null을 반환하면 해당 매치는 원문 유지(다음 매치는 해당 토큰 끝 이후부터 검사).
    function scanComponent(source, tokenRe, render) {
        let out = '';
        let lastIdx = 0;
        let m;
        tokenRe.lastIndex = 0;
        while ((m = tokenRe.exec(source)) !== null) {
            const start = m.index;
            const end = tokenRe.lastIndex;
            const pStart = collectPrefixStart(source, start, lastIdx);
            const prefix = source.slice(pStart, start);
            const built = render(prefix, m);
            if (built === null) continue;
            out += source.slice(lastIdx, pStart) + built;
            lastIdx = end;
        }
        out += source.slice(lastIdx);
        return out;
    }

    // 칩(chip) 계열 컴포넌트의 사람-대상 텍스트 채널 렌더러.
    // escapeHtml 은 {, }, :, 숫자, - 를 건드리지 않으므로 {dday:}/{age:}/{timer:}/{time:}/
    // {calendar:} 타임스탬프 토큰이 이스케이프를 통과해 신뢰된 span 으로 렌더링되고,
    // 나머지 사용자 텍스트는 이스케이프된 채 유지된다.
    function renderChipValue(raw) {
        return _processTimestampsInHtml(escapeHtml(raw == null ? '' : String(raw)));
    }

    // 중괄호 균형 스캐너: {<name>:…} 의 인자를 첫 '}' 가 아니라 중괄호 depth 가 0 으로
    // 돌아오는 '}' 까지 추출해, {stat:{dday:2026-03-09}|라벨} 같은 중첩 토큰을 지원한다.
    // scanComponent 와 동일한 out/lastIdx/프리픽스(collectPrefixStart) 규칙을 따른다.
    // 안전 규칙(기존 정규식의 런어웨이 방지와 동일):
    //   - depth 가 0 으로 돌아오기 전에 '<' 또는 개행을 만나면 매치 포기(원문 유지)
    //   - 닫는 '}' 없이 문자열이 끝나도 포기
    //   - opts.rejectTopLevelPipe: 인자에 최상위 '|' 가 있으면 포기(badge/tag 의 기존
    //     [^}|] 의미 보존 — 중첩 토큰 내부의 '|' 는 _splitPipeTopLevel 이 무시)
    // render 가 null 을 반환하면 해당 매치는 원문 유지.
    function scanComponentBalanced(source, name, render, opts) {
        const rejectTopLevelPipe = !!(opts && opts.rejectTopLevelPipe);
        const open = '{' + name + ':';
        let out = '';
        let lastIdx = 0;
        let searchFrom = 0;
        while (true) {
            const start = source.indexOf(open, searchFrom);
            if (start === -1) break;
            let depth = 1;
            let i = start + open.length;
            let closeIdx = -1;
            while (i < source.length) {
                const ch = source[i];
                if (ch === '<' || ch === '\n') break;
                if (ch === '{') depth++;
                else if (ch === '}') {
                    depth--;
                    if (depth === 0) { closeIdx = i; break; }
                }
                i++;
            }
            if (closeIdx === -1) {
                // 미종결 / HTML 태그·개행 충돌 — 원문 유지, 여는 토큰 뒤부터 재탐색.
                searchFrom = start + open.length;
                continue;
            }
            const arg = source.slice(start + open.length, closeIdx);
            const end = closeIdx + 1;
            if (arg.length === 0 || (rejectTopLevelPipe && _splitPipeTopLevel(arg).length > 1)) {
                searchFrom = start + open.length;
                continue;
            }
            const pStart = collectPrefixStart(source, start, lastIdx);
            const prefix = source.slice(pStart, start);
            const built = render(prefix, arg);
            if (built === null) { searchFrom = end; continue; }
            out += source.slice(lastIdx, pStart) + built;
            lastIdx = end;
            searchFrom = end;
        }
        out += source.slice(lastIdx);
        return out;
    }

    html = scanComponentBalanced(html, 'badge', (prefix, arg) => {
        const { bg, color } = parseStylePrefix(prefix);
        const iconHtml = extractIconHtml(prefix);
        const text = arg.trim();
        const inner = iconHtml
            ? `${iconHtml}<span class="wiki-badge-label">${renderChipValue(text)}</span>`
            : renderChipValue(text);
        return `<span class="wiki-badge"${buildStyleAttr(bg, color)}>${inner}</span>`;
    }, { rejectTopLevelPipe: true });

    html = scanComponentBalanced(html, 'tag', (prefix, arg) => {
        const { bg, color } = parseStylePrefix(prefix);
        const iconHtml = extractIconHtml(prefix);
        const text = arg.trim();
        const inner = iconHtml
            ? `${iconHtml}<span class="wiki-tag-label">${renderChipValue(text)}</span>`
            : renderChipValue(text);
        return `<span class="wiki-tag"${buildStyleAttr(bg, color)}>${inner}</span>`;
    }, { rejectTopLevelPipe: true });

    html = scanComponentBalanced(html, 'button', (prefix, arg) => {
        const { bg, color } = parseStylePrefix(prefix);
        const iconHtml = extractIconHtml(prefix);
        const parts = _splitPipeTopLevel(arg).map(s => s.trim());
        const text = parts[0] || '';
        const url = parts[1] || '';
        if (!text || !url) return null;
        const styled = !!(bg || color);
        const inner = iconHtml
            ? `${iconHtml}<span class="wiki-button-label">${renderChipValue(text)}</span>`
            : renderChipValue(text);

        // 내부 링크 버튼: URL 자리에 위키링크 [[문서]] / [[문서#섹션]] / [[문서#섹션|라벨]]
        // 를 허용한다. 라벨은 버튼 텍스트(parts[0])가 대신하므로 슬러그·앵커만 사용.
        // wikiLinkBase 로 href 를 만들고 wiki-button-internal 클래스로 SPA navigateTo /
        // 앵커 스크롤에 연결한다(동일 오리진이라 외부 링크 확인 팝업도 자연히 우회).
        const wl = url.match(/^\[\[([\s\S]+)\]\]$/);
        if (wl) {
            let target = wl[1];
            const labelPipe = target.indexOf('|');
            if (labelPipe !== -1) target = target.substring(0, labelPipe);
            target = target.trim();
            let linkSlug = target, anchor = '';
            const hashIdx = target.indexOf('#');
            if (hashIdx !== -1) {
                anchor = target.substring(hashIdx + 1).trim();
                linkSlug = target.substring(0, hashIdx).trim();
            }
            if (!linkSlug && !anchor) return null;
            const ihref = (!linkSlug && anchor)
                ? `#${encodeURIComponent(anchor)}`
                : `${_renderCtx.wikiLinkBase}/${encodeURIComponent(linkSlug)}${anchor ? '#' + encodeURIComponent(anchor) : ''}`;
            const icls = styled
                ? 'wiki-button wiki-button-custom wiki-button-internal'
                : 'wiki-button wiki-button-internal';
            return `<a class="${icls}" href="${escapeHtml(ihref)}"${buildStyleAttr(bg, color)}>${inner}</a>`;
        }

        const safe = (typeof isSafeUrl === 'function') && isSafeUrl(url);
        const href = safe ? url : '#';
        let external = false;
        try {
            const u = new URL(url, window.location.origin);
            external = (u.origin !== window.location.origin);
        } catch (e) { /* 상대 경로 등 */ }
        const cls = styled ? 'wiki-button wiki-button-custom' : 'wiki-button';
        const extAttr = external ? ' target="_blank" rel="noopener noreferrer"' : '';
        return `<a class="${cls}" href="${escapeHtml(href)}"${extAttr}${buildStyleAttr(bg, color)}>${inner}</a>`;
    });

    html = scanComponentBalanced(html, 'stat', (prefix, arg) => {
        const { bg, color } = parseStylePrefix(prefix);
        const iconHtml = extractIconHtml(prefix);
        const parts = _splitPipeTopLevel(arg).map(s => s.trim());
        const value = renderChipValue(parts[0] || '');
        const label = parts[1] ? renderChipValue(parts[1]) : '';
        const valueInner = iconHtml
            ? `${iconHtml}<span class="wiki-stat-value-text">${value}</span>`
            : value;
        // 라벨은 var(--wiki-text-muted) 고정이라 사용자 bg와 대비가 어긋날 수 있다.
        // 텍스트 색이 없고 bg만 있으면 휘도 기반 대비 색을 컨테이너에 적용해 value/label 모두 따르게 한다.
        const safeBg = bg && _isSafeCssColor(bg) ? bg : '';
        const safeColor = color && _isSafeCssColor(color) ? color : '';
        let resolvedColor = safeColor;
        if (!resolvedColor && safeBg) {
            const auto = _wikiAutoContrastColor(safeBg);
            if (auto) resolvedColor = auto;
        }
        let containerStyle = '';
        if (safeBg) containerStyle += `background-color:${safeBg};`;
        if (resolvedColor) containerStyle += `color:${resolvedColor};`;
        const containerStyleAttr = containerStyle ? ` style="${containerStyle}"` : '';
        const labelStyleAttr = resolvedColor
            ? ` style="color:${resolvedColor};opacity:0.75;"`
            : '';
        return `<div class="wiki-stat"${containerStyleAttr}>` +
            `<div class="wiki-stat-value">${valueInner}</div>` +
            (label ? `<div class="wiki-stat-label"${labelStyleAttr}>${label}</div>` : '') +
            `</div>`;
    });

    // 닫는 '}' 누락 시 뒤쪽 다른 '}' 까지 탐욕 매치되어 HTML 태그를 내용으로 삼키는 것을 막기 위해
    // 매치 범위를 '<' / 개행 직전까지로 제한한다.
    html = scanComponent(html, /\{kbd:([^}<\n]+)\}/g, (prefix, m) => {
        const { bg, color } = parseStylePrefix(prefix);
        const keys = m[1].split('+').map(s => s.trim()).filter(Boolean);
        if (keys.length === 0) return null;
        const keyStyleAttr = buildStyleAttr(bg, color);
        const parts = keys.map(k => `<kbd class="wiki-kbd"${keyStyleAttr}>${escapeHtml(k)}</kbd>`);
        // 바깥 카드는 사용자 색 토큰을 받지 않고 테마 기본색만 사용한다.
        return `<span class="wiki-kbd-card">` +
            `<span class="wiki-kbd-combo">${parts.join('<span class="wiki-kbd-plus">+</span>')}</span>` +
            `</span>`;
    });

    html = scanComponentBalanced(html, 'progress', (prefix, arg) => {
        const { bg, color } = parseStylePrefix(prefix);
        const iconHtml = extractIconHtml(prefix);
        const parts = _splitPipeTopLevel(arg).map(s => s.trim());
        const valueStr = parts[0] || '';
        const label = parts[1] || '';

        // {progress:auto|라벨} — 같은 블록(카드·폴드·섹션 등) 안의 체크리스트 완료율을
        // 렌더 후처리(_fillAutoProgressBars)가 세어 채운다. 여기서는 0% 자리표시자
        // 막대를 만들고 data-progress-auto 로 표시만 해 둔다(값 텍스트도 후처리가 채움).
        if (valueStr.toLowerCase() === 'auto') {
            const rootStyleA = (color && _isSafeCssColor(color)) ? ` style="color:${color};"` : '';
            const fillStyleA = (bg && _isSafeCssColor(bg))
                ? ` style="width:0%;background-color:${bg};"`
                : ` style="width:0%;"`;
            const hasLabelA = !!(iconHtml || label);
            const labelHtmlA = hasLabelA
                ? `<span class="wiki-progress-label">${iconHtml}${label ? `<span class="wiki-progress-label-text">${renderChipValue(label)}</span>` : ''}</span>`
                : '';
            return `<div class="wiki-progress wiki-progress-auto" data-progress-auto="1"${rootStyleA}>` +
                `<div class="wiki-progress-header">` +
                    labelHtmlA +
                    `<span class="wiki-progress-value"></span>` +
                `</div>` +
                `<div class="wiki-progress-track">` +
                    `<div class="wiki-progress-fill"${fillStyleA}></div>` +
                `</div>` +
            `</div>`;
        }

        let percent = null;
        let valueDisplay = '';
        const fracMatch = valueStr.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
        if (fracMatch) {
            const a = parseFloat(fracMatch[1]);
            const b = parseFloat(fracMatch[2]);
            if (b > 0 && a >= 0 && a <= b) {
                percent = (a / b) * 100;
                valueDisplay = `${fracMatch[1]}/${fracMatch[2]}`;
            }
        } else {
            const n = parseFloat(valueStr);
            if (!isNaN(n) && n >= 0 && n <= 100 && /^-?\d+(?:\.\d+)?%?$/.test(valueStr.replace(/\s/g, ''))) {
                percent = n;
                valueDisplay = `${n}%`;
            }
        }
        if (percent === null) return null;
        const clamped = Math.max(0, Math.min(100, percent));
        const fillStyle = (bg && _isSafeCssColor(bg))
            ? ` style="width:${clamped}%;background-color:${bg};"`
            : ` style="width:${clamped}%;"`;
        const rootStyle = (color && _isSafeCssColor(color)) ? ` style="color:${color};"` : '';
        const hasLabel = !!(iconHtml || label);
        const labelHtml = hasLabel
            ? `<span class="wiki-progress-label">${iconHtml}${label ? `<span class="wiki-progress-label-text">${renderChipValue(label)}</span>` : ''}</span>`
            : '';
        return `<div class="wiki-progress"${rootStyle}>` +
            `<div class="wiki-progress-header">` +
                labelHtml +
                `<span class="wiki-progress-value">${escapeHtml(valueDisplay)}</span>` +
            `</div>` +
            `<div class="wiki-progress-track">` +
                `<div class="wiki-progress-fill"${fillStyle}></div>` +
            `</div>` +
        `</div>`;
    });
    // 블록 레벨 인라인 컴포넌트(stat/progress)는 <div> 로 승격되지만 marked 가
    // 이를 둘러싼 <p> 를 남긴다. <div> 는 <p> 안에 올 수 없어 브라우저가 <p> 를
    // 강제로 닫으며 빈 <p> 를 만들고, 이 빈 <p> 가 그리드/플렉스/캔버스 컨테이너에서
    // 빈 셀(자식)이 되어 카드가 한 줄에 모이지 못하고 체커보드처럼 어긋나 배치된다.
    // 또한 breaks:true 때문에 같은 단락의 연속된 줄은 <br> 로 연결되는데, 컴포넌트
    // 사이에 남은 <br> 역시 빈 그리드 자식이 된다.
    // → ① 블록 컴포넌트 바로 앞의 <br> 를 제거하고,
    //   ② 블록 컴포넌트를 포함한 단락의 <p> 래퍼를 벗겨 컴포넌트를 블록으로 승격한다.
    //   (stat/progress 가 어떤 순서로 섞여도, 단독이어도, 여러 개여도 동일하게 처리)
    html = html.replace(/<br\s*\/?>\s*(?=<div class="wiki-(?:stat|progress)\b)/g, '');
    html = html.replace(/<p>([\s\S]*?)<\/p>/g, (m, inner) =>
        /<div class="wiki-(?:stat|progress)\b/.test(inner) ? inner : m);

    html = html.replace(/(?:<p>)?\{hr\}(?:<\/p>)?/g, '<hr class="wiki-block-hr">');

    html = html.replace(/\x00ILTPROT(\d+)\x00/g, (_, i) => prot[parseInt(i, 10)]);
    return html;
}

// ── 타임스탬프 유틸리티 ──

/**
 * {dday:YYYY-MM-DD} → "n일 남음" / "D-Day" / "n일 지남"
 * {dday:MM-DD}     → 다음 MM-DD까지 "n일 남음" / "D-Day" (해가 지나면 365일부터 다시)
 */
function _computeDdayText(dateStr) {
    const parts = dateStr.split('-');
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (parts.length === 2) {
        const month = parseInt(parts[0], 10);
        const day = parseInt(parts[1], 10);
        if (isNaN(month) || isNaN(day)) return null;
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        // 달력상 존재할 수 없는 조합 거부 (02-30, 04-31 등). 02-29는 윤년에만 유효하므로 허용.
        const maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
        if (day > maxDay) return null;
        // 오늘 이후의 가장 가까운 유효한 MM-DD 찾기 (02-29는 다음 윤년으로 스킵)
        // 세기 경계(예: 2100은 비윤년)에서는 2096→2104처럼 최대 8년 간격이 발생하므로 i=8까지 포함.
        let year = today.getFullYear();
        let target = null;
        for (let i = 0; i <= 8; i++) {
            const candidate = new Date(year + i, month - 1, day);
            candidate.setHours(0, 0, 0, 0);
            const valid = candidate.getMonth() === month - 1 && candidate.getDate() === day;
            if (valid && candidate >= today) {
                target = candidate;
                break;
            }
        }
        if (target === null) return null;
        const diff = Math.round((target - today) / (1000 * 60 * 60 * 24));
        if (diff === 0) return 'D-Day';
        return `${diff}일 남음`;
    }

    if (parts.length !== 3) return null;
    const target = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    target.setHours(0, 0, 0, 0);
    if (isNaN(target.getTime())) return null;
    const diff = Math.round((target - today) / (1000 * 60 * 60 * 24));
    if (diff > 0) return `${diff}일 남음`;
    if (diff === 0) return 'D-Day';
    return `${Math.abs(diff)}일 지남`;
}

/** {time:UNIX} → 날짜+시간 문자열 */
function _formatUnixTime(unixSec) {
    const d = new Date(unixSec * 1000);
    if (isNaN(d.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** {timer:UNIX} → "n년 n달 n일 n시간 n분 n초 남음/지남" (0인 단위 제거) */
function _computeTimerText(unixSec) {
    const now = Math.floor(Date.now() / 1000);
    const diff = unixSec - now;
    const s = Math.abs(diff);
    const years   = Math.floor(s / (365 * 24 * 3600));
    const months  = Math.floor((s % (365 * 24 * 3600)) / (30 * 24 * 3600));
    const days    = Math.floor((s % (30 * 24 * 3600)) / (24 * 3600));
    const hours   = Math.floor((s % (24 * 3600)) / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const seconds = s % 60;
    const parts = [];
    if (years   > 0) parts.push(`${years}년`);
    if (months  > 0) parts.push(`${months}달`);
    if (days    > 0) parts.push(`${days}일`);
    if (hours   > 0) parts.push(`${hours}시간`);
    if (minutes > 0) parts.push(`${minutes}분`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}초`);
    return parts.join(' ') + (diff >= 0 ? ' 남음' : ' 지남');
}

// containerId → intervalId (타이머 중복 방지)
const _timerIntervalMap = {};

function _initTimers(containerEl, containerId) {
    if (_timerIntervalMap[containerId]) {
        clearInterval(_timerIntervalMap[containerId]);
        delete _timerIntervalMap[containerId];
    }
    const timerEls = containerEl.querySelectorAll('.wiki-timer[data-unix]');
    if (timerEls.length === 0) return;
    function tick() {
        timerEls.forEach(el => {
            const unix = parseInt(el.getAttribute('data-unix'), 10);
            if (!isNaN(unix)) el.textContent = _computeTimerText(unix);
        });
    }
    tick();
    _timerIntervalMap[containerId] = setInterval(tick, 1000);
}

/** {age:YYYY-MM-DD} → 만 나이 (국제 표준) */
function _computeAge(dateStr) {
    const parts = dateStr.split('-');
    if (parts.length !== 3) return null;
    const birth = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    if (isNaN(birth.getTime())) return null;
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
    if (age < 0) return null;
    return `${age}세`;
}

/** HTML 문자열 내의 타임스탬프 문법을 span 태그로 치환 (코드블록 제외) */
function _processTimestampsInHtml(html) {
    // <pre>…</pre> 및 인라인 <code>…</code> 내부는 건드리지 않음
    const prot = [];
    html = html.replace(/<pre[\s\S]*?<\/pre>/gi, (m) => {
        prot.push(m);
        return `\x00TSPROT${prot.length - 1}\x00`;
    });
    html = html.replace(/<code[^>]*>[\s\S]*?<\/code>/gi, (m) => {
        prot.push(m);
        return `\x00TSPROT${prot.length - 1}\x00`;
    });

    // {dday:YYYY-MM-DD} 또는 {dday:MM-DD}
    html = html.replace(/\{dday:(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})\}/g, (match, dateStr) => {
        const text = _computeDdayText(dateStr);
        if (text === null) return match;
        const cls = text === 'D-Day' ? 'wiki-dday wiki-dday-today'
            : text.endsWith('남음') ? 'wiki-dday wiki-dday-future'
            : 'wiki-dday wiki-dday-past';
        return `<span class="${cls}" title="${dateStr}">${text}</span>`;
    });
    // {time:UNIX}
    html = html.replace(/\{time:(\d+)\}/g, (match, unixStr) => {
        const text = _formatUnixTime(parseInt(unixStr, 10));
        if (text === null) return match;
        return `<span class="wiki-timestamp" title="Unix: ${unixStr}">${text}</span>`;
    });
    // {timer:UNIX}
    html = html.replace(/\{timer:(\d+)\}/g, (match, unixStr) => {
        const unix = parseInt(unixStr, 10);
        const text = _computeTimerText(unix);
        return `<span class="wiki-timer" data-unix="${unix}" title="Unix: ${unixStr}">${text}</span>`;
    });
    // {age:YYYY-MM-DD}
    html = html.replace(/\{age:(\d{4}-\d{2}-\d{2})\}/g, (match, dateStr) => {
        const text = _computeAge(dateStr);
        if (text === null) return match;
        return `<span class="wiki-age" title="${dateStr}">${text}</span>`;
    });
    // {calendar:YYYY-MM-DD} 또는 {calendar:MM-DD} (연도 생략)
    html = html.replace(/\{calendar:(?:(\d{4})-)?(\d{2})-(\d{2})\}/g, (match, yearStr, monthStr, dayStr) => {
        const monthNames = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];
        const dayNames = ['일요일','월요일','화요일','수요일','목요일','금요일','토요일'];
        const getDowClass = (dayOfWeek) => dayOfWeek === 0 ? ' wiki-cal-sun' : dayOfWeek === 6 ? ' wiki-cal-sat' : '';
        const month = parseInt(monthStr, 10);
        const day = parseInt(dayStr, 10);
        if (yearStr) {
            const year = parseInt(yearStr, 10);
            const d = new Date(year, month - 1, day);
            if (isNaN(d.getTime()) || d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
                return match;
            }
            const monthName = monthNames[month - 1];
            const dowName = dayNames[d.getDay()];
            const dowClass = getDowClass(d.getDay());
            return `<span class="wiki-calendar-box" title="${yearStr}-${monthStr}-${dayStr}">` +
                `<span class="wiki-cal-month">${monthName}</span>` +
                `<span class="wiki-cal-day">${day}</span>` +
                `<span class="wiki-cal-dow${dowClass}">${dowName}</span>` +
                `<span class="wiki-cal-year">${year}</span>` +
                `</span>`;
        }
        // 연도 생략: 월은 필수 유효성 확인(1~12), 일은 표시는 허용하되
        // 실제 존재하는 날짜일 때만 요일을 표시하고 유효하지 않은 날짜(예: 2월 30일)는 요일을 공백으로 처리
        if (month < 1 || month > 12) return match;
        const monthName = monthNames[month - 1];
        const currentYear = new Date().getFullYear();
        const d = new Date(currentYear, month - 1, day);
        const isValidDate = !isNaN(d.getTime()) && d.getFullYear() === currentYear && d.getMonth() === month - 1 && d.getDate() === day;
        const dowHtml = isValidDate
            ? `<span class="wiki-cal-dow${getDowClass(d.getDay())}">${dayNames[d.getDay()]}</span>`
            : `<span class="wiki-cal-dow">&nbsp;</span>`;
        return `<span class="wiki-calendar-box wiki-calendar-box--no-year" title="${monthStr}-${dayStr}">` +
            `<span class="wiki-cal-month">${monthName}</span>` +
            `<span class="wiki-cal-day">${day}</span>` +
            dowHtml +
            `</span>`;
    });

    // 보호했던 코드블록 복원
    html = html.replace(/\x00TSPROT(\d+)\x00/g, (_, i) => prot[parseInt(i, 10)]);
    return html;
}

// ── 위키 링크 보호 유틸리티 ──

/** [[링크|텍스트]] 구문을 플레이스홀더로 치환하여 마크다운 파서로부터 보호 */
function protectWikiLinks(text) {
    const prot = [];
    const protected_text = text.replace(/\[\[[^\]]+\]\]/g, (m) => {
        prot.push(m);
        return `\x00WLPROT${prot.length - 1}\x00`;
    });
    return { text: protected_text, prot };
}

/** protectWikiLinks 로 치환한 플레이스홀더를 원래 위키 링크로 복원 */
function restoreWikiLinks(html, prot) {
    return html.replace(/\x00WLPROT(\d+)\x00/g, (_, i) => prot[parseInt(i, 10)]);
}

// marked 가 생성한 GFM task list 의 <input type="checkbox"> 를 MDI 아이콘으로 치환.
// 체크된 항목은 초록색으로 표시. 진행 중(- [~] / - [/]) 항목은 노란 박스 안에 mdi-reload.
function _replaceTaskCheckboxesWithIcons(html) {
    // 진행 표식(WIKITASKPROGRESSPH)이 붙은 체크박스를 먼저 치환 — 표식까지 함께 소비.
    html = html.replace(
        /<input\b[^>]*\btype="checkbox"[^>]*>\s*WIKITASKPROGRESSPH/gi,
        () => `<span class="mdi mdi-checkbox-blank wiki-task-checkbox wiki-task-progress" style="position:relative;color:#fbc02d;" aria-hidden="true"><span class="mdi mdi-reload" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:0.62em;color:#000;"></span></span>`
    );
    return html.replace(/<input\b([^>]*?)\btype="checkbox"([^>]*?)>/gi, (match, before, after) => {
        const attrs = before + after;
        const checked = /\bchecked\b/i.test(attrs);
        if (checked) {
            return `<span class="mdi mdi-checkbox-marked wiki-task-checkbox" style="color:#8bc34a;" aria-hidden="true"></span>`;
        }
        return `<span class="mdi mdi-square wiki-task-checkbox" aria-hidden="true"></span>`;
    });
}

// {progress:auto|라벨} 자동 집계 진행도 채우기 (렌더 후처리).
// 각 auto 막대에서 가장 가까운 공통 블록 컨테이너(카드·폴드·섹션 본문·탭 패널 등,
// 없으면 문서 본문 전체)를 잡아 그 안의 .wiki-task-checkbox 개수 대비 완료(체크됨,
// mdi-checkbox-marked) 비율을 계산해 막대 폭과 값 텍스트를 채운다. 진행 중([~])·
// 미완료([ ]) 항목은 분모(total)에는 포함되지만 완료로 세지 않는다("완료율").
// makeCollapsibleSections 이후에 호출해 .wiki-section-body-inner 스코프도 인식한다.
function _fillAutoProgressBars(containerEl) {
    if (!containerEl) return;
    const bars = containerEl.querySelectorAll('.wiki-progress-auto[data-progress-auto]');
    bars.forEach(bar => {
        const scope = bar.closest(
            '.wiki-block, .wiki-fold-content, .accordion-body, .tab-pane, ' +
            '.wiki-embed-body, .wiki-callout-body, .wiki-area, .wiki-section-body-inner'
        ) || containerEl;
        const boxes = scope.querySelectorAll('.wiki-task-checkbox');
        const total = boxes.length;
        let done = 0;
        boxes.forEach(b => { if (b.classList.contains('mdi-checkbox-marked')) done++; });
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const fill = bar.querySelector('.wiki-progress-fill');
        if (fill) fill.style.width = pct + '%';
        const valEl = bar.querySelector('.wiki-progress-value');
        if (valEl) valEl.textContent = total > 0 ? `${done}/${total} · ${pct}%` : '—';
    });
}

// ── 문서 렌더링 통합 (index.html, edit.html 공통) ──
async function renderWikiContent(content, slug, containerId, options = {}) {
    const containerEl = document.getElementById(containerId);
    if (!containerEl) return;

    // 이 렌더 호출 동안 _resolvePaletteTokens 가 참조할 팔레트 맵을 옵션으로 받는다.
    // SPA 네비게이션 / 블로그 동적 로드처럼 페이지마다 다른 used_palettes 집합을 받는
    // 경로에서 정확한 매핑을 보장한다. 미전달 시 appConfig.palettes / #ssr-data 폴백.
    //
    // _stateKeyDedup 와 동일한 인터리브 보호 패턴: 로컬 변수에 보관해두고 매 await 직후
    // 모듈 글로벌을 복원해, 동시 다발적 renderWikiContent 호출이 서로의 팔레트 맵을
    // 덮어쓰지 않도록 한다 (편집기 프리뷰의 키 입력 / 빠른 SPA 네비게이션).
    const myPalettes = (options.palettes && typeof options.palettes === 'object') ? options.palettes : null;
    _currentRenderPalettes = myPalettes;

    // 토론·티켓처럼 위키 풀 문법이 필요 없는 경로용 옵트인 플래그.
    //   skipTransclusion: {{include:...}} / {{틀:...}} 트랜스클루전 비활성 (raw content 그대로)
    //   skipExtensions:   ::: 익스텐션 디스패치 (_processExtensions) 비활성
    //   skipHeadingNumbers: numberHeadings() 호출 생략 (헤딩 앞 번호 prefix 미부착)
    // 미전달 시 기존 동작 그대로.
    const skipTransclusion = !!options.skipTransclusion;
    const skipExtensions = !!options.skipExtensions;
    const skipHeadingNumbers = !!options.skipHeadingNumbers;
    const hideSectionLinkCopy = !!options.hideSectionLinkCopy;

    try {
        // 프리뷰 상태 보존용 안정 키 dedup 카운터를 매 렌더 시작 시점에 초기화.
        // 반환된 객체를 로컬에 보관해두고, 매 await 직후 _stateKeyDedup 글로벌에
        // 복원한다 — 그 사이 다른 renderWikiContent 호출이 카운터를 덮어써도
        // 이번 호출의 키 순서가 일관되게 유지되도록.
        const myDedup = _resetStateKeyDedup();
        // 문서 변수(:::meta + {{{@이름}}})를 트랜스클루전 이전에 치환한다(값 하나로
        // 문서 전체가 갱신되고, 이후 #expr·타임스탬프·컴포넌트 인자와 조합된다).
        // 풀 위키 문법을 끄는 경로(skipTransclusion)에서는 함께 생략한다.
        const resolvedContent = skipTransclusion
            ? (content || '')
            : await resolveTransclusions(_applyDocMetaVars(content || ''), slug);
        _stateKeyDedup = myDedup;
        _currentRenderPalettes = myPalettes;
        // resolveTransclusions 가 모듈 로컬 _wikiExtensionData 를 채우는 즉시 스냅샷.
        // 이후 await(fetchCategoryList 등) 사이 다른 renderWikiContent 호출이
        // _wikiExtensionData 를 덮어써도, 이번 호출의 DOM data-ext-idx 는 이 스냅샷을
        // 참조하므로 충돌하지 않는다. (에디터 실시간 프리뷰의 디바운스가 깨지는 등
        // 동시 렌더가 일어나는 경로에서 인덱스 불일치 회귀를 방지.)
        const renderExtensionData = _wikiExtensionData.slice();

        const codeBlocksForFold = [];
        // 백틱(```) · 틸드(~~~) fenced block 과 인라인 백틱 코드 모두 보호한다.
        // 틸드 fence 도 마크다운 표준이므로 보호 대상에 포함해야 다음 단계의
        // {br} → placeholder 치환이 코드 본문 내부까지 침범하지 않는다.
        let foldInput = resolvedContent.replace(/^([`~]{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$|`[^`\n]+`/gm, (m) => {
            const idx = codeBlocksForFold.length;
            codeBlocksForFold.push(m);
            return `WIKICODEFPH${idx}XEND`;
        });

        // {br} 인라인 줄바꿈 토큰을 안전한 placeholder 로 치환. marked 의 로컬 renderer.html
        // 가 raw HTML 을 escape 하므로 직접 <br> 를 넣으면 &lt;br&gt; 로 새어 나간다.
        // placeholder 는 모든 sanitize·토큰 처리 종료 후 innerHTML 직전에 <br> 로 복원한다.
        // 코드 블록·인라인 코드는 위에서 이미 플레이스홀더로 보호된 상태이므로 코드 본문
        // 안의 {br} 은 그대로 보존된다.
        foldInput = foldInput.replace(/\{br\}/g, 'WIKIBRPHEND');

        foldInput = foldInput.replace(/^[\u200B\uFEFF]+(\[[-+])/gm, '$1');

        // "- []" (공백 없는 빈 체크박스) → GFM 표준 "- [ ]" 로 정규화
        foldInput = foldInput.replace(/^(\s*[-*+] )\[\](?=[ \t]|$)/gm, '$1[ ]');
        // "- [~]" / "- [/]" (진행 중 체크박스) → 표준 빈 체크박스 + 진행 표식 placeholder.
        // GFM 은 [ ]/[x] 만 task list 로 인식하므로, 빈 체크박스로 정규화한 뒤 표식을
        // 본문 앞에 끼워 두고 렌더 후 _replaceTaskCheckboxesWithIcons 에서 진행 아이콘으로 치환한다.
        // 단, 4칸 이상 들여쓰기이면서 상위에 리스트 항목이 없는 줄은 indented code block 이므로
        // (펜스/인라인 코드는 이미 보호됨) 표식이 코드 샘플에 노출되지 않도록 정규화를 건너뛴다.
        // 중첩 리스트 항목은 4칸 이상 들여써도 상위 리스트 마커가 있으므로 그대로 정규화한다.
        {
            const progLines = foldInput.split('\n');
            const progRe = /^(\s*(?:[-*+]|\d+\.) )\[[~/]\](?=[ \t]|$)/;
            const indentOf = (ln) => (ln.match(/^[ \t]*/)[0]).replace(/\t/g, '    ').length;
            for (let pi = 0; pi < progLines.length; pi++) {
                if (!progRe.test(progLines[pi])) continue;
                const indent = indentOf(progLines[pi]);
                let inList = indent < 4;
                // 더 얕은 첫 비공백 줄이 리스트 마커이면 중첩 항목으로 간주.
                for (let pj = pi - 1; pj >= 0 && !inList; pj--) {
                    if (/^\s*$/.test(progLines[pj])) continue;
                    if (indentOf(progLines[pj]) >= indent) continue;
                    inList = /^[ \t]*(?:[-*+]|\d+\.)\s/.test(progLines[pj]);
                    break;
                }
                if (inList) progLines[pi] = progLines[pi].replace(progRe, '$1[ ] WIKITASKPROGRESSPH');
            }
            foldInput = progLines.join('\n');
        }

        // 줄 시작의 공백/탭을 NBSP(U+00A0)로 치환해 들여쓰기 보존 (트리 구조 등).
        // 마크다운 블록 마커(리스트/인용/제목/표)로 시작하는 줄은 마크다운 의미를 위해 그대로 둠.
        // 코드 블록은 이미 WIKICODEFPH 로 보호되어 있어 영향받지 않는다.
        foldInput = foldInput.split('\n').map(line => {
            const m = /^([ \t]+)(\S.*)$/.exec(line);
            if (!m) return line;
            const ws = m[1];
            const rest = m[2];
            if (/^([-*+]|\d+\.)\s/.test(rest)) return line;
            if (rest[0] === '>' || rest[0] === '|') return line;
            if (/^#{1,6}\s/.test(rest)) return line;
            return ' '.repeat(ws.length) + rest;
        }).join('\n');

        const foldRegex = /^\[\+\s*(.*?)\s*\][ \t]*\n((?:(?!^\[-\][ \t]*$)[\s\S])*?)\n\[-\][ \t]*$/gm;
        const foldBlocks = [];
        let preprocessed = foldInput.replace(foldRegex, (match, titleLine, foldContent) => {
            foldContent = foldContent.replace(/^\n+|\n+$/g, '');
            // 팔레트 토큰을 {bg:}{color:}로 치환. 원위치에 전개되므로 뒤에 오는 bg/color가 자연스럽게 우선권을 가짐.
            let summaryText = _resolvePaletteTokens(titleLine);
            let bgOpt = '';
            let colorOpt = '';

            let replaced = true;
            while (replaced) {
                replaced = false;
                let bgMatch = summaryText.match(/\{bg:\s*([^}]+)\}/);
                if (bgMatch) { bgOpt = escapeHtml(bgMatch[1].trim()); summaryText = summaryText.replace(bgMatch[0], ''); replaced = true; }
                let colorMatch = summaryText.match(/\{color:\s*([^}]+)\}/);
                if (colorMatch) { colorOpt = escapeHtml(colorMatch[1].trim()); summaryText = summaryText.replace(colorMatch[0], ''); replaced = true; }
            }

            // 미등록 {palette:이름} 토큰은 렌더에 노출되지 않도록 조용히 제거 (표 셀 경로와 동일 정책)
            summaryText = summaryText.replace(/\{palette:\s*[^}]*\}/g, '');

            summaryText = escapeHtml(summaryText.trim());

            let bgAttr = bgOpt ? ` data-bg="${bgOpt}"` : '';
            let colorAttr = colorOpt ? ` data-color="${colorOpt}"` : '';

            const idx = foldBlocks.length;

            // ::: 블록 디렉티브 전처리. 코드블록 placeholder 가 살아 있는 상태에서 수행해
            // 코드 블록 안의 ::: 가 잘못 매칭되는 것을 방지한다.
            const foldBlockResult = _preprocessBlockDirectives(foldContent);
            let foldBlockText = foldBlockResult.text;
            const foldBlockData = foldBlockResult.blockData;
            // 본문과 블록 innerText 양쪽에서 코드블록 placeholder 복원
            foldBlockText = foldBlockText.replace(/WIKICODEFPH(\d+)XEND/g, (_, i) => codeBlocksForFold[parseInt(i, 10)]);
            foldBlockData.forEach(bd => {
                bd.innerText = bd.innerText.replace(/WIKICODEFPH(\d+)XEND/g, (_, i) => codeBlocksForFold[parseInt(i, 10)]);
            });

            // [[링크|텍스트]] 안의 | 가 마크다운 테이블 구분자와 충돌하지 않도록 보호
            const { text: restoredContentProt, prot: foldWikiLinkProt } = protectWikiLinks(foldBlockText);
            let rawContentHtml = (typeof marked !== 'undefined') ? marked.parse(restoredContentProt) : restoredContentProt;
            rawContentHtml = restoreWikiLinks(rawContentHtml, foldWikiLinkProt);
            rawContentHtml = _replaceTaskCheckboxesWithIcons(rawContentHtml);
            rawContentHtml = rawContentHtml.replace(/<img([^>]*)>\s*\{size:([a-zA-Z0-9_-]+)\}/g, (_, attrs, size) => `<img${attrs} data-size="${size.trim()}">`);
            // 블록 placeholder 를 HTML 로 치환 (중첩 블록은 _renderBlockHtml 내부에서 재귀 처리)
            rawContentHtml = rawContentHtml.replace(/(?:<p>)?WIKIBLOCKPH(\d+)XEND(?:<\/p>)?/g, (m, blkIdx) => {
                const b = foldBlockData[parseInt(blkIdx, 10)];
                return b ? _renderBlockHtml(b, foldBlockData) : '';
            });
            let contentHtml = (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(rawContentHtml, { ADD_TAGS: ['i', 'span', 'details', 'summary', 'div', 'canvas'], ADD_ATTR: ['class', 'style', 'data-bg', 'data-color', 'data-size', 'data-unix', 'data-ext-name', 'data-ext-idx', 'data-state-key', 'data-fn-html', 'data-fn-name', 'data-fn-ref', 'data-progress-auto', 'colspan', 'rowspan', 'title'] }) : escapeHtml(rawContentHtml);

            foldBlocks.push({ summaryText, bgAttr, colorAttr, contentHtml });
            return `\n\nWIKIFOLDPH${idx}XEND\n\n`;
        });

        // ::: 블록 디렉티브 전처리. 펼치기 placeholder 를 opaque text 로 간주해 내부/외부 둘 다 대응.
        const blockResult = _preprocessBlockDirectives(preprocessed);
        preprocessed = blockResult.text;
        const blockData = blockResult.blockData;

        preprocessed = preprocessed.replace(/WIKICODEFPH(\d+)XEND/g, (_, idx) => codeBlocksForFold[parseInt(idx, 10)]);
        // 블록 innerText 에 포함된 코드블록 placeholder 도 복원
        blockData.forEach(bd => {
            bd.innerText = bd.innerText.replace(/WIKICODEFPH(\d+)XEND/g, (_, idx) => codeBlocksForFold[parseInt(idx, 10)]);
        });

        // [[링크|텍스트]] 안의 | 가 마크다운 테이블 구분자와 충돌하지 않도록 보호
        const { text: preprocessedProt, prot: mainWikiLinkProt } = protectWikiLinks(preprocessed);
        let rawHtml = (typeof marked !== 'undefined') ? marked.parse(preprocessedProt) : preprocessedProt;
        rawHtml = restoreWikiLinks(rawHtml, mainWikiLinkProt);
        rawHtml = _replaceTaskCheckboxesWithIcons(rawHtml);
        rawHtml = rawHtml.replace(/<img([^>]*)>\s*\{size:([a-zA-Z0-9_-]+)\}/g, (_, attrs, size) => `<img${attrs} data-size="${size.trim()}">`);

        // 블록 placeholder 를 HTML 로 치환 (재귀적으로 중첩 블록도 해결).
        // 먼저 돌려야 내부에 남아 있을 수 있는 fold placeholder 를 뒤이은 fold 치환 단계가 잡아낸다.
        rawHtml = rawHtml.replace(/(?:<p>)?WIKIBLOCKPH(\d+)XEND(?:<\/p>)?/g, (m, idx) => {
            const b = blockData[parseInt(idx, 10)];
            return b ? _renderBlockHtml(b, blockData) : '';
        });

        rawHtml = rawHtml.replace(/(?:<p>)?WIKIFOLDPH(\d+)XEND(?:<\/p>)?/g, (m, idx) => {
            const block = foldBlocks[parseInt(idx, 10)];
            if (!block) return '';
            const foldKey = _makeStateKey('fold', block.summaryText);
            return `<details class="wiki-fold border rounded mb-3" data-state-key="${foldKey}"${block.bgAttr}${block.colorAttr}>` +
                `<summary class="fw-bold p-2 wiki-fold-summary">${block.summaryText}</summary>` +
                `<div class="wiki-fold-content p-3 border-top">${block.contentHtml}</div>` +
                `</details>`;
        });
        // 익스텐션 플레이스홀더를 div 태그로 변환 (DOMPurify 전에)
        rawHtml = rawHtml.replace(/(?:<p>)?WIKIEXTPH_([a-zA-Z0-9]+)_(\d+)_XEND(?:<\/p>)?/g, (m, extName, idx) => {
            return `<div class="wiki-ext wiki-ext-${escapeHtml(extName)}" data-ext-name="${escapeHtml(extName)}" data-ext-idx="${escapeHtml(idx)}"></div>`;
        });
        let html = (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(rawHtml, { ADD_TAGS: ['i', 'span', 'details', 'summary', 'div', 'canvas'], ADD_ATTR: ['class', 'style', 'data-bg', 'data-color', 'data-size', 'data-unix', 'data-ext-name', 'data-ext-idx', 'data-state-key', 'data-fn-html', 'data-fn-name', 'data-fn-ref', 'data-progress-auto', 'colspan', 'rowspan', 'title'] }) : escapeHtml(rawHtml);

        if (options.showCategory && slug) {
            // index.html 의 route() 가 decodeURIComponent 실패 시 원본 slug 를 그대로
            // 넘기므로 (`100%news` 같은 잘못된 인코딩 케이스), 여기서 다시 디코드를
            // 시도할 때 URIError 가 throw 되어 outer try/catch 로 빠지면 본문 자체가
            // 비어 보이는 회귀가 난다. 안전하게 폴백.
            let decodedSlug;
            try {
                decodedSlug = decodeURIComponent(slug);
            } catch (_) {
                decodedSlug = slug;
            }
            if (decodedSlug.startsWith('카테고리:')) {
                const categoryName = decodedSlug.replace(/^카테고리:/, '');
                // 카테고리 페이지 진입 시 캐시 무효화 — SPA 세션 중 mutation 후의 stale 목록 방지.
                // 페이지네이션 버튼은 동일 카테고리 안에서 TTL 동안 캐시를 재사용.
                _wikiCategoryInvalidate(categoryName);
                const listHtml = await fetchCategoryList(categoryName);
                _stateKeyDedup = myDedup;
                _currentRenderPalettes = myPalettes;
                if (listHtml) {
                    html += (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(listHtml, { ADD_TAGS: ['i', 'span'], ADD_ATTR: ['class', 'title'] }) : escapeHtml(listHtml);
                }
            }
        }

        // 인라인 레이아웃 토큰 처리 ({badge:}, {tag:}, {stat:}, {hr})
        html = _processInlineLayoutTokens(html);

        // 타임스탬프 문법 처리
        html = _processTimestampsInHtml(html);

        // {br} placeholder 복원. 모든 sanitize·토큰 처리가 끝난 뒤에만 수행해
        // marked.renderer.html 의 HTML escape 와 무관하게 <br> 가 살아남도록 한다.
        // 코드 블록 안의 {br} 은 placeholder 단계 전에 보호되었기 때문에 영향이 없다.
        html = html.replace(/WIKIBRPHEND/g, '<br>');

        // 기존 렌더된 익스텐션의 정리 훅을 먼저 실행(Chart 인스턴스/리스너 누수 방지) 후 교체.
        _teardownExtensions(containerEl);
        containerEl.innerHTML = html;

        // 테이블 색상 적용
        containerEl.querySelectorAll('td, th').forEach(cell => {
            // 코드 블록 / 인라인 코드 내부의 토큰은 무시한다 (사용자가 의도적으로 텍스트로 노출한 것).
            const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, {
                acceptNode(node) {
                    return node.parentElement && node.parentElement.closest('code, pre')
                        ? NodeFilter.FILTER_REJECT
                        : NodeFilter.FILTER_ACCEPT;
                }
            }, false);
            let firstTextNode = walker.nextNode();
            if (firstTextNode) {
                let val = firstTextNode.nodeValue;
                let replaced = true;

                while (replaced) {
                    replaced = false;
                    // {palette:이름}을 선두에서 {bg:}{color:}로 전개 후 다음 이터레이션에서 파싱되도록 continue
                    let palMatch = val.match(/^([\s]*)\{palette:\s*([^}\s][^}]*?)\s*\}/);
                    if (palMatch) {
                        const expanded = _resolvePaletteTokens(`{palette:${palMatch[2]}}`);
                        // 미등록 팔레트는 치환되지 않음 → 무한 루프 방지: 원본 토큰 그대로면 제거
                        if (expanded === `{palette:${palMatch[2]}}`) {
                            val = palMatch[1] + val.slice(palMatch[0].length);
                        } else {
                            val = palMatch[1] + expanded + val.slice(palMatch[0].length);
                        }
                        replaced = true;
                        continue;
                    }
                    let bgMatch = val.match(/^([\s]*)\{bg:\s*([^}]+)\}/);
                    if (bgMatch) {
                        const colorValue = bgMatch[2].trim();
                        if (_isSafeCssColor(colorValue)) cell.style.backgroundColor = colorValue;
                        val = val.replace(bgMatch[0], '');
                        replaced = true;
                    }
                    let colorMatch = val.match(/^([\s]*)\{color:\s*([^}]+)\}/);
                    if (colorMatch) {
                        const colorValue = colorMatch[2].trim();
                        if (_isSafeCssColor(colorValue)) cell.style.color = colorValue;
                        val = val.replace(colorMatch[0], '');
                        replaced = true;
                    }
                }
                firstTextNode.nodeValue = val;
            }
        });

        // 테이블 셀 병합 처리 (colspan/rowspan)
        containerEl.querySelectorAll('table').forEach(table => {
            const rows = Array.from(table.querySelectorAll(':scope > thead > tr, :scope > tbody > tr, :scope > tr'));
            if (rows.length === 0) return;

            // 셀이 병합 마커 하나만 담고 있는지 판정. 셀 안에 다른 텍스트나 포매팅 요소
            // (예: <strong>{>}</strong>) 가 있으면 일반 텍스트로 취급하고 병합하지 않는다.
            const _matchMergeMarker = (cell: Element): string | null => {
                if (cell.children.length > 0) return null;
                const m = cell.textContent.trim().match(/^\{(><|[<>^])\}$/);
                return m ? m[1] : null;
            };

            // {^} 병합이 thead/tbody 경계를 넘는 경우 rowspan이 작동하지 않으므로,
            // thead 행을 tbody로 이동하고 th를 td로 변환
            const thead = table.querySelector(':scope > thead');
            const tbody = table.querySelector(':scope > tbody');
            if (thead && tbody) {
                const hasVerticalMerge = Array.from(tbody.querySelectorAll('td, th')).some(cell => _matchMergeMarker(cell) === '^');
                if (hasVerticalMerge) {
                    const theadRows = Array.from(thead.querySelectorAll('tr'));
                    theadRows.forEach(tr => {
                        Array.from(tr.querySelectorAll('th')).forEach(th => {
                            const td = document.createElement('td');
                            td.innerHTML = th.innerHTML;
                            Array.from(th.attributes).forEach(attr => td.setAttribute(attr.name, attr.value));
                            td.style.fontWeight = 'bold';
                            td.style.textAlign = th.style.textAlign || 'center';
                            th.replaceWith(td);
                        });
                        tbody.insertBefore(tr, tbody.firstChild);
                    });
                    thead.remove();
                }
            }

            // 행 목록을 재구성 (thead가 이동되었을 수 있으므로)
            const updatedRows = Array.from(table.querySelectorAll(':scope > thead > tr, :scope > tbody > tr, :scope > tr'));
            if (updatedRows.length === 0) return;

            const grid = updatedRows.map(row => Array.from(row.cells));
            const markers = grid.map(row => row.map(cell => _matchMergeMarker(cell)));

            const toRemove = grid.map(row => row.map(() => false));

            // {<} 처리 (왼쪽 병합)
            for (let r = 0; r < grid.length; r++) {
                for (let c = 1; c < grid[r].length; c++) {
                    if (markers[r][c] === '<') {
                        let target = c - 1;
                        while (target >= 0 && markers[r][target] === '<') target--;
                        if (target >= 0 && !toRemove[r][target]) {
                            const currentSpan = parseInt(grid[r][target].getAttribute('colspan') || '1');
                            grid[r][target].setAttribute('colspan', currentSpan + 1);
                            toRemove[r][c] = true;
                        }
                    }
                }
            }

            // {>} 처리 (오른쪽 병합)
            for (let r = 0; r < grid.length; r++) {
                for (let c = grid[r].length - 2; c >= 0; c--) {
                    if (markers[r][c] === '>') {
                        let target = c + 1;
                        while (target < grid[r].length && markers[r][target] === '>') target++;
                        if (target < grid[r].length && !toRemove[r][target]) {
                            const currentSpan = parseInt(grid[r][target].getAttribute('colspan') || '1');
                            grid[r][target].setAttribute('colspan', currentSpan + 1);
                            toRemove[r][c] = true;
                        }
                    }
                }
            }

            // {^} 처리 (위쪽 병합)
            for (let r = 1; r < grid.length; r++) {
                for (let c = 0; c < grid[r].length; c++) {
                    if (markers[r][c] === '^') {
                        if (toRemove[r][c]) continue;
                        let target = r - 1;
                        while (target >= 0 && markers[target][c] === '^') target--;
                        if (target >= 0 && c < grid[target].length) {
                            const currentSpan = parseInt(grid[target][c].getAttribute('rowspan') || '1');
                            grid[target][c].setAttribute('rowspan', currentSpan + 1);
                            toRemove[r][c] = true;
                        }
                    }
                }
            }

            // {><} 처리 (양쪽 분할 병합)
            const hasDoubleMerge = markers.some(row => row.some(m => m === '><'));
            if (hasDoubleMerge) {
                // 모든 셀의 colspan을 2배로 확대하여 반분할 가능하게 함
                for (let r = 0; r < grid.length; r++) {
                    for (let c = 0; c < grid[r].length; c++) {
                        const currentSpan = parseInt(grid[r][c].getAttribute('colspan') || '1');
                        grid[r][c].setAttribute('colspan', currentSpan * 2);
                    }
                }

                // {><} 마커 셀의 공간을 양쪽 이웃에 균등 분배
                for (let r = 0; r < grid.length; r++) {
                    for (let c = 0; c < grid[r].length; c++) {
                        if (markers[r][c] !== '><') continue;

                        let left = c - 1;
                        while (left >= 0 && (toRemove[r][left] || markers[r][left] === '><')) left--;
                        let right = c + 1;
                        while (right < grid[r].length && (toRemove[r][right] || markers[r][right] === '><')) right++;

                        const hasLeft = left >= 0;
                        const hasRight = right < grid[r].length;

                        if (hasLeft && hasRight) {
                            const leftSpan = parseInt(grid[r][left].getAttribute('colspan') || '1');
                            grid[r][left].setAttribute('colspan', leftSpan + 1);
                            const rightSpan = parseInt(grid[r][right].getAttribute('colspan') || '1');
                            grid[r][right].setAttribute('colspan', rightSpan + 1);
                        } else if (hasLeft) {
                            const leftSpan = parseInt(grid[r][left].getAttribute('colspan') || '1');
                            grid[r][left].setAttribute('colspan', leftSpan + 2);
                        } else if (hasRight) {
                            const rightSpan = parseInt(grid[r][right].getAttribute('colspan') || '1');
                            grid[r][right].setAttribute('colspan', rightSpan + 2);
                        }
                        toRemove[r][c] = true;
                    }
                }
            }

            // 병합 마커 셀 제거 및 병합된 셀 가운데 정렬
            for (let r = 0; r < grid.length; r++) {
                for (let c = grid[r].length - 1; c >= 0; c--) {
                    if (toRemove[r][c]) {
                        grid[r][c].remove();
                    } else {
                        const cell = grid[r][c];
                        if (cell.getAttribute('colspan') > 1 || cell.getAttribute('rowspan') > 1) {
                            if (!cell.style.textAlign) cell.style.textAlign = 'center';
                            if (!cell.style.verticalAlign) cell.style.verticalAlign = 'middle';
                        }
                    }
                }
            }
        });

        // Fold 색상 적용
        containerEl.querySelectorAll('.wiki-fold').forEach(fold => {
            const bg = fold.getAttribute('data-bg');
            const color = fold.getAttribute('data-color');
            if (bg && _isSafeCssColor(bg)) fold.style.backgroundColor = bg;
            if (color && _isSafeCssColor(color)) {
                const summary = fold.querySelector('summary');
                if (summary) summary.style.color = color;
            }
        });

        processWikiLinks(containerEl);
        if (options.mentions) {
            processMentions(containerEl, options.mentions);
        }
        processFootnotes(containerEl);

        // 카테고리 링크 SPA 내비게이션 (인라인 onclick 대체)
        if (typeof navigateTo === 'function') {
            containerEl.querySelectorAll('.wiki-spa-link').forEach(a => {
                a.addEventListener('click', (e) => {
                    e.preventDefault();
                    navigateTo(a.href);
                });
            });
        }

        // 내부 링크 버튼({button:텍스트|[[문서#섹션]]}) — processWikiLinks 와 동일한
        // 이동 규칙을 적용한다: 같은 페이지 앵커(#…)는 재로드 없이 스크롤(접힌 조상 펼침
        // 포함), 그 외에는 SPA navigateTo(미정의 시 전체 내비게이션).
        containerEl.querySelectorAll('a.wiki-button-internal').forEach(a => {
            a.addEventListener('click', (e) => {
                e.preventDefault();
                const href = a.getAttribute('href');
                if (href && href.startsWith('#')) {
                    let id;
                    try { id = decodeURIComponent(href.slice(1)); } catch (_) { id = href.slice(1); }
                    const target = id ? _resolveAnchorTarget(id) : null;
                    if (target) {
                        try { history.pushState(null, '', href); } catch (_) { /* ignore */ }
                        _scrollToElementWithAncestors(target, { behavior: 'smooth', block: 'start' });
                    }
                    return;
                }
                if (typeof navigateTo === 'function') navigateTo(a.href);
                else window.location.href = a.href;
            });
        });

        // YouTube / Niconico Embed Processing
        containerEl.querySelectorAll('a').forEach(a => {
            const href = a.getAttribute('href');
            if (!href) return;

            // Must be the only text inside a block level element, specifically a paragraph
            const parent = a.parentElement;
            if (!parent || parent.tagName !== 'P') return;
            if (parent.textContent.trim() !== a.textContent.trim()) return;

            // Must not be a custom markdown link. If text exactly matches href or its domain, we allow it.
            // Also ignore if it is inside a blockquote, a code block, or a footnote
            if (a.closest('code, pre') || a.closest('.wiki-fn-ref')) return;

            // Checking if the link display text looks like a URL instead of custom text
            const textContent = a.textContent.trim();
            let textLooksLikeGoogleMaps = false;
            try {
                const tcUrl = new URL(textContent);
                const h = tcUrl.hostname;
                textLooksLikeGoogleMaps = (h === 'www.google.com' || h === 'google.com' || h === 'maps.google.com' || h === 'goo.gl' || h === 'maps.app.goo.gl');
            } catch (e) { /* textContent가 URL 형식이 아닌 경우 무시 */ }
            if (!textContent.includes('youtube.com') && !textContent.includes('youtu.be') && !textContent.includes('nicovideo.jp') && !textContent.includes('spotify.com') && !textLooksLikeGoogleMaps) return;

            // Spotify Embed Processing
            if (href.includes('open.spotify.com')) {
                try {
                    const url = new URL(href, window.location.origin);
                    const pathParts = url.pathname.split('/').filter(Boolean); // e.g. ["track", "ID"]

                    if (pathParts.length >= 2) {
                        const type = pathParts[0];
                        const id = pathParts[1];
                        const allowedTypes = ['track', 'album', 'playlist', 'artist', 'show', 'episode'];

                        if (allowedTypes.includes(type)) {
                            const container = document.createElement('div');
                            container.className = 'spotify-embed-container my-3';

                            const iframe = document.createElement('iframe');
                            const embedUrl = `https://open.spotify.com/embed/${type}/${id}${url.search}`;

                            iframe.setAttribute('src', embedUrl);
                            iframe.setAttribute('width', '100%');
                            // 트랙/에피소드는 짧게(152px), 나머지는 길게(352px) 설정
                            const embedHeight = (type === 'track' || type === 'episode') ? 152 : 352;
                            iframe.setAttribute('height', String(embedHeight));
                            iframe.setAttribute('frameborder', '0');
                            iframe.setAttribute('allow', 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture');
                            iframe.setAttribute('loading', 'lazy');
                            iframe.style.borderRadius = '12px';
                            // .wiki-content iframe { height: auto } 가 HTML height 속성을 덮어쓰므로
                            // 인라인 스타일로 고정해 하단 공백을 방지한다.
                            iframe.style.height = `${embedHeight}px`;

                            container.appendChild(iframe);
                            parent.replaceWith(container);
                            return;
                        }
                    }
                } catch (e) {
                    console.error('Spotify embed error:', e);
                }
            }

            // Google Maps Embed Processing
            try {
                const mapUrl = new URL(href);
                const mh = mapUrl.hostname;
                const isGoogleMapsHost = (
                    ((mh === 'www.google.com' || mh === 'google.com' || mh === 'maps.google.com') && mapUrl.pathname.startsWith('/maps')) ||
                    (mh === 'goo.gl' && mapUrl.pathname.startsWith('/maps')) ||
                    mh === 'maps.app.goo.gl'
                );
                if (isGoogleMapsHost) {
                    let embedUrl;
                    if (mapUrl.pathname.startsWith('/maps/embed')) {
                        embedUrl = href;
                    } else {
                        mapUrl.searchParams.set('output', 'embed');
                        embedUrl = mapUrl.toString();
                    }

                    const container = document.createElement('div');
                    container.className = 'maps-embed-container my-3';
                    container.style.width = '100%';

                    const iframe = document.createElement('iframe');
                    iframe.setAttribute('src', embedUrl);
                    iframe.setAttribute('width', '100%');
                    iframe.setAttribute('height', '400');
                    iframe.setAttribute('frameborder', '0');
                    iframe.setAttribute('style', 'border:0; border-radius:8px;');
                    iframe.setAttribute('allowfullscreen', '');
                    iframe.setAttribute('loading', 'lazy');
                    iframe.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');

                    container.appendChild(iframe);
                    parent.replaceWith(container);
                    return;
                }
            } catch (e) {
                console.error('Google Maps embed error:', e);
            }

            // YouTube Embed Processing (Improved)
            if (href.includes('youtube.com') || href.includes('youtu.be')) {
                try {
                    const url = new URL(href, window.location.origin);
                    let videoId = '';
                    // 일부 플레이리스트 공유 링크는 pathname 끝에 슬래시가 붙기도 한다.
                    const path = url.pathname.replace(/\/+$/, '') || '/';
                    const listId = url.searchParams.get('list');
                    const siParam = url.searchParams.get('si');
                    const start = url.searchParams.get('t');
                    const ytAllow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';

                    if (url.hostname.includes('youtu.be')) {
                        videoId = url.pathname.slice(1);
                    } else if (path === '/watch') {
                        videoId = url.searchParams.get('v');
                    } else if (path.startsWith('/shorts/')) {
                        videoId = path.split('/')[2];
                    } else if (path.startsWith('/live/')) {
                        videoId = path.split('/')[2];
                    } else if ((path === '/playlist' || path === '/embed/videoseries') && listId) {
                        // 플레이리스트 단독 URL (youtube.com/playlist?list=... 또는
                        // 이미 embed 형태로 들어온 youtube.com/embed/videoseries?list=...)
                        const params = [`list=${encodeURIComponent(listId)}`, 'listType=playlist'];
                        if (siParam) params.push(`si=${encodeURIComponent(siParam)}`);
                        const iframeWrapper = document.createElement('div');
                        iframeWrapper.className = 'ratio ratio-16x9 my-3';
                        iframeWrapper.style.maxWidth = '100%';
                        const ytIframe = document.createElement('iframe');
                        ytIframe.setAttribute('src', `https://www.youtube.com/embed/videoseries?${params.join('&')}`);
                        ytIframe.setAttribute('title', 'YouTube playlist player');
                        ytIframe.setAttribute('frameborder', '0');
                        ytIframe.setAttribute('allow', ytAllow);
                        ytIframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
                        ytIframe.setAttribute('allowfullscreen', '');
                        iframeWrapper.appendChild(ytIframe);
                        parent.replaceWith(iframeWrapper);
                        return;
                    }

                    if (videoId) {
                        const queryParams = [];
                        if (start) {
                            // handle format like 1m30s or 90
                            let seconds = 0;
                            const timeMatch = start.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
                            if (timeMatch && (timeMatch[1] || timeMatch[2] || timeMatch[3])) {
                                seconds = (parseInt(timeMatch[1] || 0) * 3600) + (parseInt(timeMatch[2] || 0) * 60) + parseInt(timeMatch[3] || 0);
                            } else {
                                seconds = parseInt(start, 10);
                            }
                            if (!isNaN(seconds)) queryParams.push(`start=${seconds}`);
                        }
                        if (listId) {
                            queryParams.push(`list=${encodeURIComponent(listId)}`);
                        }
                        if (siParam) {
                            queryParams.push(`si=${encodeURIComponent(siParam)}`);
                        }
                        const query = queryParams.length > 0 ? '?' + queryParams.join('&') : '';

                        const iframeWrapper = document.createElement('div');
                        iframeWrapper.className = 'ratio ratio-16x9 my-3';
                        iframeWrapper.style.maxWidth = '100%';
                        const ytIframe = document.createElement('iframe');
                        ytIframe.setAttribute('src', `https://www.youtube.com/embed/${encodeURIComponent(videoId)}${query}`);
                        ytIframe.setAttribute('title', 'YouTube video player');
                        ytIframe.setAttribute('frameborder', '0');
                        ytIframe.setAttribute('allow', ytAllow);
                        ytIframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
                        ytIframe.setAttribute('allowfullscreen', '');
                        iframeWrapper.appendChild(ytIframe);
                        parent.replaceWith(iframeWrapper);
                        return;
                    }
                } catch (e) {
                    console.error('YouTube embed error:', e);
                }
            }

            const nicoMatch = href.match(/^https?:\/\/(?:www\.)?nicovideo\.jp\/watch\/([a-zA-Z0-9_-]+)(.*)$/);
            if (nicoMatch) {
                const videoId = nicoMatch[1];
                const params = nicoMatch[2] || '';
                // convert ?from= or &from= to from=
                const timeMatch = params.match(/[?&]from=(\d+)/);
                let query = '';
                if (timeMatch) {
                    query = `?from=${parseInt(timeMatch[1], 10)}`;
                }
                const iframeWrapper = document.createElement('div');
                iframeWrapper.className = 'ratio ratio-16x9 my-3';
                iframeWrapper.style.maxWidth = '100%';
                const nicoIframe = document.createElement('iframe');
                nicoIframe.setAttribute('src', `https://embed.nicovideo.jp/watch/${encodeURIComponent(videoId)}${query}`);
                nicoIframe.setAttribute('frameborder', '0');
                nicoIframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
                nicoIframe.setAttribute('allowfullscreen', '');
                iframeWrapper.appendChild(nicoIframe);
                parent.replaceWith(iframeWrapper);
                return;
            }
        });

        const popoverTriggerList = [].slice.call(containerEl.querySelectorAll('[data-bs-toggle="popover"]'));
        if (typeof bootstrap !== 'undefined') {
            popoverTriggerList.map(function (popoverTriggerEl) {
                const useHtml = popoverTriggerEl.getAttribute('data-bs-html') === 'true';
                return new bootstrap.Popover(popoverTriggerEl, { html: useHtml });
            });
        }

        containerEl.querySelectorAll('a').forEach(a => {
            const href = a.getAttribute('href');
            if (href && (href.startsWith('http://') || href.startsWith('https://')) && a.hostname && a.hostname !== window.location.hostname) {
                a.onclick = (e) => {
                    e.preventDefault();
                    if (typeof Swal !== 'undefined') {
                        Swal.fire({
                            title: '외부 링크 이동',
                            html: `외부 링크 <b>${escapeHtml(href)}</b> 로 이동합니다.<br>계속하시겠습니까?`,
                            icon: 'warning',
                            showCancelButton: true,
                            confirmButtonText: '예',
                            cancelButtonText: '아니오'
                        }).then((result) => {
                            if (result.isConfirmed) window.open(href, '_blank');
                        });
                    } else {
                        if (confirm(`외부 링크 ${href} 로 이동하시겠습니까?`)) {
                            window.open(href, '_blank');
                        }
                    }
                };
            }
        });

        containerEl.querySelectorAll('table').forEach(t => {
            t.classList.add('table', 'table-bordered');
            const wrapper = document.createElement('div');
            wrapper.className = 'wiki-table-wrapper';
            t.parentNode.insertBefore(wrapper, t);
            wrapper.appendChild(t);
        });

        containerEl.querySelectorAll('img').forEach(img => {
            if (img.getAttribute('data-size') !== 'icon') {
                img.classList.add('img-fluid');
            }
            if (!img.hasAttribute('loading')) {
                img.setAttribute('loading', 'lazy');
            }

            // 이미지 클릭 시 "이미지:파일명" 문서로 이동
            // 대상: 이 사이트의 업로드 이미지만 — 다음 세 가지 출처를 매칭한다.
            //   1) 루트 상대경로("/media/images/...")
            //   2) 동일 오리진의 절대 URL("https://<host>/media/images/...")
            //   3) appConfig.mediaPublicUrl 접두사와 일치하는 URL
            //      (CDN/별도 도메인에서 서빙되는 배포의 /api/media 응답 URL)
            // 그 외(외부 도메인의 임의 /media/images/ 경로)는 로컬 업로드가 아니므로 매칭 제외.
            if (img.getAttribute('data-size') === 'icon') return;
            if (img.closest('a')) return;
            const rawSrc = img.getAttribute('src') || '';
            const mediaPublicUrl = (typeof appConfig !== 'undefined' && appConfig && typeof appConfig.mediaPublicUrl === 'string')
                ? appConfig.mediaPublicUrl.replace(/\/+$/, '')
                : '';

            let encodedFilename = null;
            if (rawSrc.startsWith('/') && !rawSrc.startsWith('//')) {
                // 루트 상대경로: Worker가 직접 /media/images/... 를 서빙하는 경우
                const m = rawSrc.match(/^\/media\/images\/([^?#]+)$/);
                if (m) encodedFilename = m[1];
            } else if (mediaPublicUrl && rawSrc.startsWith(mediaPublicUrl + '/images/')) {
                // 설정된 미디어 공개 URL 접두사와 일치 (CDN 호스팅 포함)
                const rest = rawSrc.substring((mediaPublicUrl + '/images/').length);
                const cut = rest.search(/[?#]/);
                const candidate = cut >= 0 ? rest.slice(0, cut) : rest;
                if (candidate) encodedFilename = candidate;
            } else if (/^https?:\/\//i.test(rawSrc)) {
                // 동일 오리진 절대 URL 폴백
                try {
                    const u = new URL(rawSrc);
                    if (u.origin === window.location.origin) {
                        const m = u.pathname.match(/^\/media\/images\/([^?#]+)$/);
                        if (m) encodedFilename = m[1];
                    }
                } catch { /* 잘못된 URL은 매칭하지 않음 */ }
            }
            if (!encodedFilename) return;

            // 본문에 잘못된 퍼센트 인코딩이 포함될 수 있으므로(예: /media/images/foo%ZZ.jpg)
            // decodeURIComponent 실패 시 원문을 그대로 사용해 렌더 파이프라인이 중단되지 않게 한다.
            let filename;
            try {
                filename = decodeURIComponent(encodedFilename);
            } catch {
                filename = encodedFilename;
            }
            const link = document.createElement('a');
            link.href = `${_renderCtx.imageDocLinkBase}/${encodeURIComponent('이미지:' + filename)}`;
            link.className = 'wiki-image-link';
            link.setAttribute('aria-label', `이미지 문서 보기: ${filename}`);
            img.parentNode.insertBefore(link, img);
            link.appendChild(img);
        });

        // ── Mermaid 다이어그램: ```mermaid 코드펜스를 복사버튼/Prism 경로 도달 전에 분기 ──
        // 코드펜스는 verbatim 캡처라 Mermaid DSL({결정?}·|예|·==>·~~~ 등)이 위키 인라인 문법과
        // 충돌하지 않는다. 언어 태그가 mermaid 인 <pre><code> 를 <figure> placeholder 로 치환해
        // 이후 복사버튼/Prism 루프가 보지 못하게 하고(코드 하이라이팅 경로 무간섭), 비동기로 SVG 렌더.
        let hasMermaid = false;
        containerEl.querySelectorAll('pre > code.language-mermaid').forEach(codeEl => {
            const pre = codeEl.parentElement;
            if (!pre || !pre.parentNode) return;
            const src = codeEl.textContent || '';
            const figure = document.createElement('figure');
            figure.className = 'mermaid-figure';
            figure.setAttribute('role', 'img');
            figure.dataset.src = src;
            figure.innerHTML = '<div class="mermaid-loading"><span class="spinner-border spinner-border-sm"></span> 다이어그램 렌더링 중…</div>';
            pre.parentNode.replaceChild(figure, pre);
            hasMermaid = true;
        });
        if (hasMermaid) {
            // fire-and-forget: 나머지 후처리를 막지 않도록 await 하지 않는다.
            _renderMermaidFigures(containerEl);
        }

        // 코드블럭 복사 버튼 추가 및 언어 하이라이팅 감지
        let requirePrism = false;
        containerEl.querySelectorAll('pre').forEach(pre => {
            const codeEl = pre.querySelector('code');
            if (codeEl) {
                const hasLanguage = Array.from(codeEl.classList).some(cls => cls.startsWith('language-') && cls !== 'language-');
                if (hasLanguage) {
                    requirePrism = true;
                }
            }

            if (pre.parentNode.classList.contains('wiki-code-wrapper')) return;

            const wrapper = document.createElement('div');
            wrapper.className = 'wiki-code-wrapper';
            pre.parentNode.insertBefore(wrapper, pre);
            wrapper.appendChild(pre);

            const copyBtn = document.createElement('button');
            copyBtn.className = 'btn-copy-code';
            copyBtn.title = '코드 복사';
            copyBtn.innerHTML = '<i class="bi bi-copy"></i>';

            copyBtn.onclick = async () => {
                try {
                    const textToCopy = pre.innerText || pre.textContent;
                    await navigator.clipboard.writeText(textToCopy);
                    copyBtn.innerHTML = '<i class="bi bi-check-lg"></i>';
                    setTimeout(() => { copyBtn.innerHTML = '<i class="bi bi-copy"></i>'; }, 2000);
                } catch (err) {
                    const textarea = document.createElement('textarea');
                    textarea.value = pre.innerText || pre.textContent;
                    document.body.appendChild(textarea);
                    textarea.select();
                    try {
                        document.execCommand('copy');
                        copyBtn.innerHTML = '<i class="bi bi-check-lg"></i>';
                        setTimeout(() => { copyBtn.innerHTML = '<i class="bi bi-copy"></i>'; }, 2000);
                    } catch (e) { /* ignore */ }
                    document.body.removeChild(textarea);
                }
            };

            wrapper.appendChild(copyBtn);
        });

        // ── 코드블럭 문법 하이라이팅 (Prism.js Autoloader 연동) ──
        // 코드블럭이 아무 문법이 아니라면 라이브러리를 불러오지 않음
        if (requirePrism) {
            // 코드 전용 각진 모노스페이스 폰트 (JetBrains Mono + 한국어용 Nanum Gothic Coding)
            // 테마 색상은 render.css에서 직접 정의(VS Code Dark+/Light+)하므로 Prism CDN 테마는 로드하지 않음
            if (!document.getElementById('wiki-code-font-link')) {
                const codeFont = document.createElement('link');
                codeFont.id = 'wiki-code-font-link';
                codeFont.rel = 'stylesheet';
                codeFont.href = FONTS.code;
                document.head.appendChild(codeFont);
            }

            if (typeof window.Prism === 'undefined') {
                if (!document.getElementById('prism-core-script')) {
                    const prismCore = document.createElement('script');
                    prismCore.id = 'prism-core-script';
                    prismCore.src = CDN_URLS.prismCore;
                    prismCore.onload = () => {
                        const prismAutoloader = document.createElement('script');
                        prismAutoloader.id = 'prism-autoloader-script';
                        prismAutoloader.src = CDN_URLS.prismAutoloader;
                        prismAutoloader.onload = () => {
                            Prism.plugins.autoloader.languages_path = CDN_URLS.prismComponentsBase;
                            document.querySelectorAll('pre code[class*="language-"]').forEach(el => Prism.highlightElement(el));
                        };
                        document.body.appendChild(prismAutoloader);
                    };
                    document.body.appendChild(prismCore);
                } else {
                    // 스크립트가 로딩 중인 경우
                    const checkPrism = setInterval(() => {
                        if (typeof window.Prism !== 'undefined' && window.Prism.plugins && window.Prism.plugins.autoloader) {
                            clearInterval(checkPrism);
                            containerEl.querySelectorAll('pre code[class*="language-"]').forEach(el => Prism.highlightElement(el));
                        }
                    }, 100);
                }
            } else if (typeof window.Prism !== 'undefined' && window.Prism.highlightElement) {
                containerEl.querySelectorAll('pre code[class*="language-"]').forEach(el => Prism.highlightElement(el));
            }
        }

        // {collapse} 토큰: 헤딩에서 토큰 텍스트를 제거하고 기본 접힘 마커를 부착한다.
        // (목차 카드/FAB/헤딩 표시에 토큰이 노출되지 않도록 번호·목차·섹션 래핑보다 먼저 수행)
        _applyHeadingCollapseTokens(containerEl);

        // 헤딩 번호 삽입 (옵션으로 비활성 가능 — 토론·티켓 본문 등)
        if (!skipHeadingNumbers) {
            numberHeadings(containerEl);
        }

        // 각주 섹션 헤딩(<h4>각주</h4>)에는 문단 번호 prefix 를 부여하지 않는다.
        containerEl.querySelectorAll('.wiki-footnotes .wiki-heading-num').forEach(el => el.remove());

        // 외부 목차 패널(#tocNav/#tocContainer)은 해당 옵션이 있을 때만 갱신한다.
        if (options.tocContainerId && options.tocNavId) {
            generateTOC(containerEl, options.tocContainerId, options.tocNavId);
        }
        // 본문 상단 인라인 목차 카드는 컨테이너 헤딩으로 자체 생성하므로 외부 패널과 무관하게
        // 동작한다(프리뷰 등). makeCollapsibleSections 전에 실행해 도입부/clear 래핑이 섹션
        // 래핑보다 먼저 일어나도록 한다.
        if (options.inlineTocLayout) {
            _buildInlineTocLayout(containerEl);
        }

        // 문서 원본(마크다운) 기준 통계(줄수/자수/단어수)를 TOC 아래에 표시
        _updateDocumentStatsCounter(content);

        if (options.collapsibleSections) {
            makeCollapsibleSections(containerEl);
            // 각주 목록은 섹션 외부(문서 최하단)에 위치해야 한다.
            // processFootnotes가 먼저 실행되어 .wiki-footnotes가 containerEl 끝에 붙은 상태에서
            // makeCollapsibleSections가 이를 마지막 헤딩 섹션 본문으로 함께 감싸면
            // 마지막 섹션을 접을 때 각주까지 같이 접히는 문제가 발생하므로
            // 래핑 이후 각주 컨테이너를 다시 containerEl 최하단으로 이동시킨다.
            const footnotesEl = containerEl.querySelector('.wiki-footnotes');
            if (footnotesEl && footnotesEl.parentElement !== containerEl) {
                containerEl.appendChild(footnotesEl);
            }
        }

        // 헤딩 복사 버튼 추가 (makeCollapsibleSections 이후에 실행하여 토글 아이콘 위치 인식)
        // 편집 권한이 있을 때는 섹션 편집 버튼도 함께 표시
        // rawContent: 원본(raw) 마크다운 - 섹션 편집 URL 의 section 인덱스를 원본 기준으로 생성하기 위함
        // (transclusion 으로 주입된 헤딩은 원본에 없으므로 raw 매칭 실패 시 편집 버튼 생략)
        _addHeadingCopyButtons(containerEl, resolvedContent, {
            enableSectionEdit: !!options.enableSectionEdit,
            canEdit: !!options.canEdit,
            slug: options.enableSectionEdit ? (options.sectionEditSlug || slug) : null,
            rawContent: content,
            hideSectionLinkCopy: hideSectionLinkCopy
        });

        // {timer:} 요소 실시간 업데이트
        _initTimers(containerEl, containerId);

        // {progress:auto} 체크리스트 완료율 집계 채우기(섹션 래핑 이후라 섹션 스코프 인식).
        _fillAutoProgressBars(containerEl);

        // 익스텐션 렌더링 (Chart.js 등). resolveTransclusions 직후 캡처한 스냅샷을 전달.
        if (!skipExtensions) {
            _processExtensions(containerEl, renderExtensionData);
        }

    } catch (err) {
        console.error('renderWikiContent error:', err);
    }
}

/** #articleTitle 클릭 시 제목 텍스트만 클립보드에 복사. 시각적 UI 는 변경하지 않는다.
 *  핸들러는 article 로드 경로(마크다운/익스텐션/이미지/카테고리)와 무관하게 한 번만
 *  부착되면 충분하다: onclick 콜백은 클릭 시점에 textContent 를 다시 읽으므로
 *  이후 어떤 경로로 제목이 갱신되더라도 항상 최신 제목이 복사된다. */
function _setupArticleTitleCopy() {
    const titleEl = document.getElementById('articleTitle');
    if (!titleEl) return;
    if (titleEl._copyOnClickBound) return; // 중복 부착 방지
    titleEl._copyOnClickBound = true;
    titleEl.onclick = async () => {
        const titleText = (titleEl.textContent || '').trim();
        if (!titleText) return;
        let ok = false;
        try {
            await navigator.clipboard.writeText(titleText);
            ok = true;
        } catch (err) {
            const ta = document.createElement('textarea');
            ta.value = titleText;
            document.body.appendChild(ta);
            ta.select();
            try { ok = document.execCommand('copy'); } catch (e2) { /* ignore */ }
            document.body.removeChild(ta);
        }
        if (ok && typeof Swal !== 'undefined') {
            Swal.fire({
                icon: 'success',
                title: '제목이 복사되었습니다.',
                toast: true,
                position: 'top-end',
                timer: 1500,
                showConfirmButton: false
            });
        }
    };
}

// article 레벨에서 항상 핸들러가 부착되도록 초기화.
// render.js 는 index.html 의 #articleTitle 요소 뒤에 로드되므로 즉시 실행해도 안전하지만,
// 다른 페이지(revisions.html, 편집 프리뷰 등)에서 로드될 수 있으므로 요소 없을 때는 no-op.
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _setupArticleTitleCopy);
    } else {
        _setupArticleTitleCopy();
    }
}

// ── 헤딩 복사 버튼 ──

/**
 * 마크다운 텍스트에서 h1~h4 헤딩을 찾아 섹션별 라인 범위를 반환.
 * 펜스 코드블록 내부의 '#' 라인은 헤딩으로 처리하지 않음.
 * 반환값: [{ level, lineIdx, endLine, headingText }, ...]
 *   - lineIdx: 헤딩 라인 (0-based)
 *   - endLine: 섹션 종료 라인(exclusive, 끝 빈 줄 제거 반영)
 *   - headingText: "## " 등 마크다운 접두사를 제거한 헤딩 텍스트
 */
function _extractMarkdownSectionRanges(markdownText) {
    const text = markdownText || '';
    const lines = text.split('\n');

    // transclusion 센티넬 마커 위치(문자 오프셋)를 수집하여 라인별 깊이를 계산.
    // 센티넬은 _resolveTransclusionsCore 가 템플릿 전개 결과 주위에 삽입한다.
    // 이를 통해 헤딩이 원본에서 온 것인지 transclusion 주입된 것인지를
    // 텍스트가 아닌 구조적 소스 표식으로 판별한다.
    const OPEN = '<!--WIKI_TCL_B-->';
    const CLOSE = '<!--WIKI_TCL_E-->';
    const markers = [];
    let pos = 0;
    while (true) {
        const oIdx = text.indexOf(OPEN, pos);
        const cIdx = text.indexOf(CLOSE, pos);
        if (oIdx < 0 && cIdx < 0) break;
        if (oIdx >= 0 && (cIdx < 0 || oIdx < cIdx)) {
            markers.push({ offset: oIdx, type: +1 });
            pos = oIdx + OPEN.length;
        } else {
            markers.push({ offset: cIdx, type: -1 });
            pos = cIdx + CLOSE.length;
        }
    }

    // 각 라인 시작의 문자 오프셋 사전 계산
    const lineOffsets = new Array(lines.length);
    {
        let off = 0;
        for (let i = 0; i < lines.length; i++) {
            lineOffsets[i] = off;
            off += lines[i].length + 1; // '\n'
        }
    }

    // 주어진 문자 오프셋에서 transclusion 깊이 반환
    function depthAt(charOffset) {
        let d = 0;
        for (const mk of markers) {
            if (mk.offset >= charOffset) break;
            d += mk.type;
        }
        return d > 0 ? d : 0;
    }

    const headings = []; // { level, lineIdx, headingText, transcluded }
    let inFencedCode = false;
    let fenceChar = '';
    let fenceLen = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (!inFencedCode) {
            // CommonMark: 백틱 펜스 오프너의 info string 에는 백틱이 들어갈 수 없다
            // (예: ```lang`` 는 펜스 오프너가 아닌 인라인 코드 시퀀스).
            // 틸드 펜스는 info string 에 어떤 문자(틸드 포함)든 허용된다.
            // edit.js 의 _collectRawHeadingsFromDoc 와 동일한 판정을 적용해
            // raw 라인 인덱스 부여(data-raw-line) 와 스크롤 동기화 측 헤딩 시퀀스가 어긋나지 않게 한다.
            const fenceMatch = line.match(/^(`{3,}|~{3,})(.*)$/);
            if (fenceMatch) {
                const opener = fenceMatch[1];
                const rest = fenceMatch[2];
                const ch = opener[0];
                const isValidFence = ch !== '`' || !rest.includes('`');
                if (isValidFence) {
                    inFencedCode = true;
                    fenceChar = ch;
                    fenceLen = opener.length;
                    continue;
                }
                // 유효한 펜스 오프너가 아니면 일반 라인 흐름으로 떨어뜨려 헤딩 판정 계속.
            }
            const hMatch = line.match(/^(#{1,4})\s+(.*)$/);
            if (hMatch) {
                headings.push({
                    level: hMatch[1].length,
                    lineIdx: i,
                    // {collapse} 토큰은 헤딩 식별/매칭용 텍스트에서 제외한다
                    // (섹션 트랜스클루전 {{문서#제목}}·섹션 편집 매칭이 토큰 없는 제목으로 동작).
                    headingText: _stripCollapseToken(hMatch[2].trim()).text,
                    transcluded: depthAt(lineOffsets[i]) > 0
                });
            } else if (i > 0) {
                // setext 헤딩(=== / ---) 감지.
                // marked 는 setext 를 <h1>/<h2> 로 렌더링하므로 DOM headingEls 에는
                // 포함되지만, ATX 만 파싱하면 ranges 와 DOM 개수가 어긋나 section 인덱스가
                // 엉뚱한 섹션을 가리킬 수 있다.
                const underlineMatch = line.match(/^(=+|-+)\s*$/);
                if (underlineMatch) {
                    const prev = lines[i - 1];
                    // 들여쓰기 코드블록 시작 컨텍스트는 문단이 아니므로 Setext 베이스로 인정 X.
                    // 4칸 이상 공백/탭으로 시작하면서 직전 라인이 빈 줄(또는 문서 시작) 이면 코드블록.
                    const isIndentedCodeBlockStart = /^(?: {4,}|\t)/.test(prev)
                        && (i - 2 < 0 || lines[i - 2].trim() === '');
                    const prevTrim = prev.trim();
                    // 이전 라인이 문단 텍스트여야 setext 로 인정.
                    // 빈 줄/ATX 헤딩/블록쿼트/리스트 항목/들여쓰기 코드블록 등은 제외.
                    const isParagraph = !isIndentedCodeBlockStart
                        && prevTrim !== ''
                        && !prevTrim.startsWith('#')
                        && !prevTrim.startsWith('>')
                        && !/^[-*_]{3,}\s*$/.test(prevTrim)
                        && !/^[-*+]\s+/.test(prevTrim)
                        && !/^\d+[.)]\s+/.test(prevTrim)
                        && !/^(`{3,}|~{3,})/.test(prevTrim);
                    if (isParagraph) {
                        const level = underlineMatch[1][0] === '=' ? 1 : 2;
                        headings.push({
                            level: level,
                            lineIdx: i - 1,
                            headingText: _stripCollapseToken(prevTrim).text,
                            transcluded: depthAt(lineOffsets[i - 1]) > 0
                        });
                    }
                }
            }
        } else {
            const trimmed = line.trim();
            if (trimmed[0] === fenceChar && trimmed.replace(new RegExp('^' + fenceChar + '+'), '').trim() === '' && trimmed.length >= fenceLen) {
                inFencedCode = false;
            }
        }
    }

    return headings.map((h, idx) => {
        let endLine = lines.length;
        for (let j = idx + 1; j < headings.length; j++) {
            if (headings[j].level <= h.level) {
                endLine = headings[j].lineIdx;
                break;
            }
        }
        // 섹션 끝의 빈 줄 제거
        while (endLine > h.lineIdx && lines[endLine - 1].trim() === '') endLine--;
        return {
            level: h.level,
            lineIdx: h.lineIdx,
            endLine,
            headingText: h.headingText,
            transcluded: h.transcluded
        };
    });
}

/**
 * 마크다운 텍스트에서 h1~h4 헤딩 목록과 각 헤딩의 섹션 마크다운을 추출.
 * 펜스 코드블록 내부의 '#' 라인은 헤딩으로 처리하지 않음.
 * 반환값: 헤딩 순서에 대응하는 섹션 마크다운 문자열 배열.
 */
function _extractMarkdownSections(markdownText) {
    const lines = markdownText.split('\n');
    const ranges = _extractMarkdownSectionRanges(markdownText);
    return ranges.map(r => lines.slice(r.lineIdx, r.endLine).join('\n'));
}

/** 컨테이너 내 h1~h4 요소에 섹션 마크다운 복사 버튼(+ 선택적으로 섹션 편집 버튼)을 추가 */
function _addHeadingCopyButtons(containerEl, resolvedContent, options = {}) {
    const ranges = _extractMarkdownSectionRanges(resolvedContent);
    const lines = resolvedContent.split('\n');
    const headingEls = Array.from(containerEl.querySelectorAll('h1:not(.accordion-header), h2:not(.accordion-header), h3:not(.accordion-header), h4:not(.accordion-header)'));

    const enableSectionEdit = !!options.enableSectionEdit;
    const canEdit = !!options.canEdit;
    const editSlug = options.slug || '';
    // 섹션 편집 링크는 원본(raw) 마크다운의 섹션 인덱스를 써야 한다.
    // transclusion 으로 주입된 헤딩은 원본에 존재하지 않으므로 편집 버튼을 생략하며,
    // 이 판정은 headingText 매칭이 아니라 _extractMarkdownSectionRanges 가 센티넬
    // 마커로부터 계산한 range.transcluded (소스 구조 메타데이터) 로 수행한다.
    const rawContent = typeof options.rawContent === 'string' ? options.rawContent : null;
    const rawRanges = rawContent !== null ? _extractMarkdownSectionRanges(rawContent) : null;
    let rawCursor = 0; // non-transcluded DOM 헤딩에 대응하는 raw range 포인터

    // 섹션 콘텐츠에서 센티넬 주석 라인 제거(복사 텍스트를 깔끔하게 유지)
    const SENTINEL_RE = /<!--WIKI_TCL_[BE]-->/g;
    const stripSentinels = (s) => s.replace(SENTINEL_RE, '');

    headingEls.forEach((h, idx) => {
        const range = ranges[idx];
        if (!range) return;
        const sectionContent = stripSentinels(lines.slice(range.lineIdx, range.endLine).join('\n'));

        const copyBtn = document.createElement('button');
        copyBtn.className = 'wiki-heading-copy-btn';
        copyBtn.title = '섹션 마크다운 복사';
        copyBtn.type = 'button';
        copyBtn.innerHTML = '<i class="bi bi-copy"></i>';

        copyBtn.onclick = async (e) => {
            e.stopPropagation(); // 섹션 접기/펼치기 이벤트 전파 방지
            let ok = false;
            try {
                await navigator.clipboard.writeText(sectionContent);
                ok = true;
                copyBtn.innerHTML = '<i class="bi bi-check-lg"></i>';
                setTimeout(() => { copyBtn.innerHTML = '<i class="bi bi-copy"></i>'; }, 2000);
            } catch (err) {
                const ta = document.createElement('textarea');
                ta.value = sectionContent;
                document.body.appendChild(ta);
                ta.select();
                try {
                    ok = document.execCommand('copy');
                    if (ok) {
                        copyBtn.innerHTML = '<i class="bi bi-check-lg"></i>';
                        setTimeout(() => { copyBtn.innerHTML = '<i class="bi bi-copy"></i>'; }, 2000);
                    }
                } catch (e2) { /* ignore */ }
                document.body.removeChild(ta);
            }
            if (ok && typeof Swal !== 'undefined') {
                Swal.fire({
                    icon: 'success',
                    title: '문단이 복사되었습니다.',
                    toast: true,
                    position: 'top-end',
                    timer: 1500,
                    showConfirmButton: false
                });
            }
        };

        // 복사 버튼은 항상 헤딩 끝(우측)에 위치한다.
        // (chevron 토글 아이콘은 헤딩 좌측 끝에 위치한다.)
        h.appendChild(copyBtn);

        // 섹션 링크 복사 버튼 — 섹션 마크다운 복사 버튼과 섹션 편집 버튼 사이에 위치.
        let linkBtn = null;
        if (!options.hideSectionLinkCopy) {
            linkBtn = document.createElement('button');
            linkBtn.className = 'wiki-heading-link-btn';
            linkBtn.title = '섹션 링크 복사';
            linkBtn.type = 'button';
            linkBtn.innerHTML = '<i class="bi bi-link-45deg"></i>';
            linkBtn.onclick = async (e) => {
                e.stopPropagation();
                const anchorId = _getSectionAnchorId(h);
                if (!anchorId) return;
                const url = window.location.origin + window.location.pathname + '#' + anchorId;
                const ok = await _copySectionLinkToClipboard(url);
                if (ok) {
                    linkBtn.innerHTML = '<i class="bi bi-check-lg"></i>';
                    setTimeout(() => { linkBtn.innerHTML = '<i class="bi bi-link-45deg"></i>'; }, 2000);
                }
            };
            h.appendChild(linkBtn);
        }

        // 비-트랜스클루전 헤딩에 한해, 원본 마크다운의 헤딩 라인 인덱스를 데이터 속성으로 부여한다.
        // 에디터 스크롤 동기화가 raw 라인 기준으로 프리뷰 anchor 를 정확히 찾을 수 있도록 한다.
        // (각주 자동 헤딩은 ranges 에 대응 항목이 없어 위에서 이미 return 되었음)
        let rawRangeForHeading = null;
        if (rawRanges && !range.transcluded) {
            const rawIdx = rawCursor;
            rawCursor++;
            const rawRange = rawRanges[rawIdx];
            if (rawRange) {
                const normalize = (s) => (s || '').trim();
                if (normalize(rawRange.headingText) === normalize(range.headingText)) {
                    rawRangeForHeading = rawRange;
                    h.dataset.rawLine = String(rawRange.lineIdx);
                }
            }
        }

        // 편집 권한이 있을 때만 섹션 편집 버튼을 링크 버튼 옆에 추가
        if (enableSectionEdit && canEdit && editSlug && rawRangeForHeading) {
            const rawRange = rawRangeForHeading;
            const rawIdx = rawCursor - 1;

            const editLink = document.createElement('a');
            editLink.className = 'wiki-heading-edit-btn';
            editLink.title = '이 섹션만 편집';
            editLink.setAttribute('aria-label', '섹션 편집');
            const params = new URLSearchParams({
                slug: editSlug,
                section: String(rawIdx),
                h: rawRange.headingText
            });
            editLink.href = '/edit?' + params.toString();
            editLink.innerHTML = '<i class="bi bi-pencil"></i>';
            editLink.addEventListener('click', (e) => {
                // 섹션 접기/펼치기 헤딩 클릭 이벤트와 충돌 방지
                e.stopPropagation();
            });

            // 링크 버튼 바로 다음 형제로 삽입 → [copy][link][edit]
            if (linkBtn && linkBtn.nextSibling) {
                h.insertBefore(editLink, linkBtn.nextSibling);
            } else {
                h.appendChild(editLink);
            }
        }
    });
}

// ── 익스텐션 렌더링 시스템 ──

/** 문서 통계 카운터: TOC 아래에 줄수/자수/단어수를 표시.
 *  원본 마크다운(`content`)을 기준으로 계산하여 에디터 카운터와 일관성을 유지. */
function _updateDocumentStatsCounter(text) {
    const root = document.getElementById('docStatsCounter');
    if (!root) return;
    const str = text == null ? '' : String(text);
    if (!str.length) {
        root.classList.add('d-none');
        return;
    }
    const lines = str.split('\n').length;
    const charsWithSpaces = str.length;
    const chars = str.replace(/\s/g, '').length;
    const trimmed = str.trim();
    const words = trimmed ? trimmed.split(/\s+/).length : 0;
    const fmt = (n) => n.toLocaleString();
    const set = (key, val) => {
        const el = root.querySelector(`[data-counter="${key}"]`);
        if (el) el.textContent = val;
    };
    set('lines', `${fmt(lines)}줄`);
    set('chars', `${fmt(chars)}자`);
    set('charsWithSpaces', `${fmt(charsWithSpaces)}자(공백포함)`);
    set('words', `${fmt(words)}단어`);
    root.classList.remove('d-none');
}

/** 익스텐션 모듈별 렌더러 맵 (각 익스텐션 파일이 로드 시 자동 등록) */
if (!window._extensionRenderers) window._extensionRenderers = {};
/** defineExtension 으로 등록된 익스텐션 정의(라이프사이클 훅 포함) 맵 */
if (!window._extensionDefs) window._extensionDefs = {};

// ─────────────────────────────────────────────────────────────────────────────
// 익스텐션 SDK 런타임
//
// 익스텐션 파일(public/ext/<name>/<name>.js)은 Vite 번들 밖의 raw JS 이지만,
// 라이프사이클 디스패치(destroy/onThemeChange)와 _processExtensions·테마 이벤트
// 리스너가 모두 이 번들(render.ts)에 있으므로, SDK 런타임을 여기서 window 로 노출한다.
// 익스텐션 저작자는 `window.defineExtension(manifest, renderer)` 로 등록하며 타입은
// public/ext/cloudwiki-ext.d.ts(앰비언트)로 제공된다. 레거시 `_extensionRenderers[name]`
// 직접 등록도 그대로 동작하도록 SDK 는 그 위에 additive 하게 얹는다.
// ─────────────────────────────────────────────────────────────────────────────

/** ctx.loadScript 중복 로드 가드용 src→Promise 메모이즈 맵 */
const _extScriptPromises = {};

/** 외부 스크립트를 1회만 로드(중복 가드). opts.global 전역이 이미 있으면 즉시 resolve. */
function _extLoadScript(src, opts) {
    opts = opts || {};
    if (opts.global && window[opts.global]) return Promise.resolve();
    if (_extScriptPromises[src]) return _extScriptPromises[src];
    const p = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        if (opts.id) s.id = opts.id;
        s.dataset.extSrc = src;
        s.src = src;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => {
            // 실패한 promise/스크립트를 캐시·DOM 에서 제거해 다음 렌더(재렌더·재방문)가
            // 재시도할 수 있게 한다. 제거하지 않으면 일시적 CDN/네트워크 실패가 영구 캐시돼
            // 전체 새로고침 전까지 freq 등이 복구되지 못한다.
            delete _extScriptPromises[src];
            if (s.parentNode) s.parentNode.removeChild(s);
            reject(new Error('익스텐션 스크립트 로드 실패: ' + src));
        };
        document.body.appendChild(s);
    });
    _extScriptPromises[src] = p;
    return p;
}

/** 익스텐션 렌더러에 주입하는 공용 컨텍스트(전역 상태만 담으므로 단일 싱글턴). */
const _extSdk = {
    theme: {
        /** 현재 적용 테마가 다크인지(위키 밝기축 data-theme 기준, mermaid 와 동일 판정). */
        isDark: () => _mermaidEffectiveDark(),
        /** 'light' | 'dark' */
        mode: () => (_mermaidEffectiveDark() ? 'dark' : 'light'),
    },
    loadScript: _extLoadScript,
    /** DOMPurify 래퍼(canvas/svg 허용 안전 프로파일). 미로드 시 escape 폴백. */
    sanitizeHtml: (html) => (typeof DOMPurify !== 'undefined')
        ? DOMPurify.sanitize(html, {
            ADD_TAGS: ['canvas', 'svg', 'use', 'i', 'span', 'details', 'summary'],
            ADD_ATTR: ['class', 'style', 'data-bg', 'data-color', 'data-size', 'title'],
        })
        : escapeHtml(html),
};
window._extSdk = _extSdk;

/**
 * 익스텐션 등록 헬퍼. renderer 는 함수형(레거시 호환) 또는
 * `{ render, destroy?, onThemeChange? }` 객체형. 내부적으로 항상 함수 래퍼를
 * `window._extensionRenderers[name]` 에 등록해 _processExtensions 의 기존 호출 규약을 유지하고,
 * 라이프사이클 훅이 담긴 정의는 `window._extensionDefs[name]` 에 보관한다.
 */
function defineExtension(manifest, renderer) {
    if (!manifest || !manifest.name) {
        console.error('[ext-sdk] defineExtension: manifest.name 누락');
        return;
    }
    const name = manifest.name;
    const def = (typeof renderer === 'function') ? { render: renderer } : (renderer || {});
    if (typeof def.render !== 'function') {
        console.error('[ext-sdk] defineExtension: render 함수 누락 (' + name + ')');
        return;
    }
    window._extensionDefs[name] = def;
    const recordDestroy = (el) => {
        if (typeof def.destroy === 'function') el._extDestroy = () => def.destroy(el);
    };
    window._extensionRenderers[name] = function (el, extData) {
        // 렌더 세대(generation) 토큰을 발급한다. 재렌더(_rerenderExt)·정리(_teardownExtensions)가
        // 토큰을 무효화(_bumpExtGen)하므로, 비동기 렌더의 늦은 reject 콜백이 자신을 대체한
        // 더 새로운 렌더의 내용을 덮어쓰지 않는다. 익스텐션 내부의 비동기 작업(예: freq 의
        // Chart.js 지연 로드)도 `el._extGen` 을 캡처해 동일하게 staleness 를 판정할 수 있다.
        const gen = (el._extGen = (el._extGen || 0) + 1);
        // 동기 throw·비동기 reject 모두 .alert 로 격리(레지스트리에 직접 호출하는
        // 직접 익스텐션 문서 경로 pages/index.ts 까지 자체적으로 보호된다).
        let ret;
        try {
            ret = def.render(el, extData, _extSdk);
        } catch (e) {
            console.error('[ext-sdk] 익스텐션 렌더 실패 (' + name + '):', e);
            el.innerHTML = `<div class="alert alert-danger mb-0">⚠️ 익스텐션 렌더 오류: ${escapeHtml(name)}</div>`;
            recordDestroy(el);
            return;
        }
        if (ret && typeof ret.then === 'function') {
            ret.catch((e) => {
                // 이미 더 새로운 렌더로 교체됐다면(세대 불일치) 그 내용을 덮어쓰지 않는다.
                if (el._extGen !== gen) return;
                console.error('[ext-sdk] 익스텐션 비동기 렌더 실패 (' + name + '):', e);
                el.innerHTML = `<div class="alert alert-danger mb-0">⚠️ 익스텐션 렌더 오류: ${escapeHtml(name)}</div>`;
            });
            recordDestroy(el);
        } else if (typeof ret === 'function') {
            // render 가 cleanup 함수를 반환하면 그것을 우선 사용.
            el._extDestroy = ret;
        } else {
            recordDestroy(el);
        }
    };
}
window.defineExtension = defineExtension;

/** 익스텐션 요소의 정리 훅 실행 후 동일 데이터로 재렌더(테마 변경 폴백). */
function _rerenderExt(el) {
    const name = el.getAttribute('data-ext-name');
    const renderer = window._extensionRenderers && window._extensionRenderers[name];
    const extData = el._extData;
    if (!renderer || !extData) return;
    try { if (typeof el._extDestroy === 'function') el._extDestroy(); } catch (e) { /* noop */ }
    el._extDestroy = null;
    el.innerHTML = '';
    try {
        renderer(el, extData);
    } catch (e) {
        console.error('[ext-sdk] 익스텐션 재렌더 실패 (' + name + '):', e);
        el.innerHTML = `<div class="alert alert-danger mb-0">⚠️ 익스텐션 렌더 오류: ${escapeHtml(name || '')}</div>`;
    }
}

// 라이프사이클 셀렉터는 `data-ext-rendered` 속성만으로 매칭한다(`.wiki-ext` 클래스 미요구).
// 본문 인라인 익스텐션(.wiki-ext 플레이스홀더)뿐 아니라 직접 익스텐션 문서(pages/index.ts
// 의 #ext-doc-rendered — 클래스 없이 data-ext-name/data-ext-rendered 만 부여)도 포함하기 위함.
/** 컨테이너 내 이미 렌더된 익스텐션의 정리 훅을 실행(innerHTML 교체 전 호출 — 인스턴스/리스너 누수 방지). */
function _teardownExtensions(containerEl) {
    if (!containerEl || !containerEl.querySelectorAll) return;
    containerEl.querySelectorAll('[data-ext-rendered="1"]').forEach(el => {
        // 세대 무효화 — 정리 시점에 아직 진행 중인 비동기 렌더 콜백(예: Chart.js 로딩 중)이
        // 파기된 캔버스에 인스턴스를 만들지 않도록, 익스텐션이 캡처한 세대와 어긋나게 한다.
        el._extGen = (el._extGen || 0) + 1;
        try { if (typeof el._extDestroy === 'function') el._extDestroy(); } catch (e) { /* noop */ }
        el._extDestroy = null;
    });
}

/** 테마/스킨 변경 시 렌더된 익스텐션을 onThemeChange 로 갱신(없으면 destroy+재렌더 폴백). */
function _onExtThemeChange() {
    document.querySelectorAll('[data-ext-rendered="1"]').forEach(el => {
        const name = el.getAttribute('data-ext-name');
        const def = window._extensionDefs && window._extensionDefs[name];
        if (def && typeof def.onThemeChange === 'function') {
            try { def.onThemeChange(el, _extSdk); }
            catch (e) { console.error('[ext-sdk] onThemeChange 실패 (' + name + '):', e); _rerenderExt(el); }
        } else if (def || typeof el._extDestroy === 'function') {
            // SDK 등록 익스텐션(def 존재)은 onThemeChange 미정의 시 항상 destroy+재렌더로 테마를
            // 반영한다(render 에서 ctx.theme 만 쓰고 정리 훅이 없는 확장도 갱신되도록). 레거시
            // 직접 등록 렌더러(def 없음)는 정리 훅이 있을 때만 갱신하고, 그 외엔 그대로 둔다(기존 동작).
            _rerenderExt(el);
        }
    });
}

if (typeof window !== 'undefined') {
    window.addEventListener('wiki:theme-changed', _onExtThemeChange);
    if (typeof window.matchMedia === 'function') {
        const _extMq = window.matchMedia('(prefers-color-scheme: dark)');
        if (_extMq.addEventListener) _extMq.addEventListener('change', _onExtThemeChange);
        else if (_extMq.addListener) _extMq.addListener(_onExtThemeChange);
    }
}

/** 컨테이너 내 모든 익스텐션 요소를 찾아 렌더러 실행.
 *  extensionData 가 명시되면 그 스냅샷을 사용 (동시 렌더 race 방지).
 *  미지정 시 모듈 로컬 _wikiExtensionData 폴백 — 외부 직접 호출 후방 호환용.
 *
 *  익스텐션 스크립트는 common.ts 의 loadConfig() 가 `<script async>` 로 head 에
 *  삽입하므로 첫 렌더 시점에 아직 등록 전일 수 있다. 등록 전 컴포넌트는 placeholder
 *  로 두고 200ms × 최대 N 회 폴링하여 도착 즉시 렌더한다 (열람 페이지의
 *  익스텐션 본문 렌더가 사용하는 패턴과 동일). 모든 컴포넌트가 해소되거나
 *  재시도 한도를 넘어서면 미등록 메시지로 마감. */
function _processExtensions(containerEl, extensionData) {
    const extElements = containerEl.querySelectorAll('.wiki-ext[data-ext-name]');
    if (extElements.length === 0) return;

    const data = Array.isArray(extensionData) ? extensionData : _wikiExtensionData;
    const MAX_RETRIES = 15;       // 200ms × 15 = 3s 대기 한도 (인라인 ext doc 렌더와 동일)
    const RETRY_INTERVAL_MS = 200;

    const tryRender = (retries) => {
        const pending = [];
        extElements.forEach(el => {
            // 이미 렌더된 요소는 건너뜀 (재시도 시 중복 작업 방지)
            if (!el.isConnected || el.dataset.extRendered === '1') return;

            const extName = el.getAttribute('data-ext-name');
            const extIdx = parseInt(el.getAttribute('data-ext-idx'), 10);
            const extData = data ? data[extIdx] : null;

            if (!extData) {
                el.innerHTML = '<div class="alert alert-warning">⚠️ 익스텐션 데이터를 찾을 수 없습니다.</div>';
                el.dataset.extRendered = '1';
                return;
            }

            const renderer = window._extensionRenderers && window._extensionRenderers[extName];
            if (renderer) {
                // 재렌더(테마 변경 등)·정리 훅이 동일 데이터를 재사용할 수 있도록 요소에 스냅샷 보관.
                el._extData = extData;
                // 렌더러 예외 격리 — 한 익스텐션의 throw 가 형제 요소·재시도 체인을 멈추지 않게 한다.
                try {
                    renderer(el, extData);
                } catch (e) {
                    console.error('[ext-sdk] 익스텐션 렌더 실패 (' + extName + '):', e);
                    el.innerHTML = `<div class="alert alert-danger mb-0">⚠️ 익스텐션 렌더 오류: ${escapeHtml(extName)}</div>`;
                }
                el.dataset.extRendered = '1';
            } else if (retries > 0) {
                // 등록 대기 — 재시도 큐에 둔다
                pending.push(el);
            } else {
                el.innerHTML = `<div class="alert alert-warning">⚠️ 알 수 없는 익스텐션: ${escapeHtml(extName)}</div>`;
                el.dataset.extRendered = '1';
            }
        });

        if (pending.length > 0 && retries > 0) {
            setTimeout(() => tryRender(retries - 1), RETRY_INTERVAL_MS);
        }
    };

    tryRender(MAX_RETRIES);
}


// ─────────────────────────────────────────────────────────────────────────────
// Mermaid 다이어그램 (```mermaid 코드펜스) — 지연 로드 + 테마 동기화 렌더러.
// Prism(코드 하이라이트) 경로와 분리되어, 언어 태그가 mermaid 인 코드펜스만 여기로 온다.
// 라이브러리는 다이어그램이 있는 문서에서만 동적 import 로 1회 로드된다(없으면 비용 0).
// ─────────────────────────────────────────────────────────────────────────────
let _mermaidPromise = null;     // import 메모이즈 (최초 1회만 네트워크 로드)
let _mermaidMod = null;         // 로드 완료된 mermaid 모듈
let _mermaidSeq = 0;            // mermaid.render 고유 id 시퀀스

/** 현재 적용 테마가 다크인지 판정. data-theme 명시값 우선, auto/미설정이면 OS 환경설정. */
function _mermaidEffectiveDark() {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark') return true;
    if (attr === 'light') return false;
    return typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function _mermaidInitConfig() {
    // htmlLabels:false 로 라벨을 <foreignObject> HTML 대신 네이티브 SVG <text> 로 렌더한다.
    // 생성 SVG 는 svg-only DOMPurify 프로파일로 재정화하는데, htmlLabels:true(기본)면
    // 라벨 HTML 이 정화 단계에서 제거돼 노드/엣지 라벨이 사라진다(securityLevel:'strict' 는
    // 라벨 HTML 을 escape 만 할 뿐 foreignObject 사용을 끄지 않음). text 라벨은 svg 프로파일로 보존된다.
    return {
        startOnLoad: false,
        securityLevel: 'strict',
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        theme: _mermaidEffectiveDark() ? 'dark' : 'default',
    };
}

/** mermaid 모듈을 1회 지연 로드(메모이즈). 실패 시 promise 를 비워 재시도를 허용한다. */
function _loadMermaid() {
    if (_mermaidPromise) return _mermaidPromise;
    // Vite 가 URL 동적 import 를 번들하지 않도록 @vite-ignore. 런타임 네이티브 ESM 로 jsdelivr 사전 번들 빌드에서 로드.
    _mermaidPromise = import(/* @vite-ignore */ CDN_URLS.mermaidEsm)
        .then(mod => {
            const mermaid = mod.default || mod;
            mermaid.initialize(_mermaidInitConfig());
            _mermaidMod = mermaid;
            return mermaid;
        })
        .catch(err => {
            _mermaidPromise = null;
            throw err;
        });
    return _mermaidPromise;
}

/**
 * 다이어그램 렌더가 끝나 레이아웃이 바뀌었음을 알리는 전역 신호.
 * mermaid 는 네트워크 지연 import + 비동기 SVG 렌더라, 로딩 스피너 → 실제 다이어그램으로
 * 바뀔 때 figure 높이가 크게 변한다. 에디터 프리뷰 스크롤 싱크는 헤딩 오프셋 가이드를
 * 캐싱하는데, 다이어그램이 fold(<details>)·트랜스클루전 등 프리뷰의 *직속 자식이 아닌*
 * 위치에 있으면 직속 자식만 보는 ResizeObserver 가 이 변동을 놓쳐 가이드가 낡은 채로 남는다.
 * DOM 깊이와 무관하게 동기화할 수 있도록 렌더 완료 시 이벤트를 쏘아 청취 측(에디터)이
 * 가이드 캐시를 무효화하게 한다. (조회 페이지 등 청취자 없는 곳에서는 무해)
 */
function _emitMermaidRendered() {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    try { window.dispatchEvent(new CustomEvent('wiki:mermaid-rendered')); } catch (_) { /* ignore */ }
}

/** root 내부의 .mermaid-figure 들을 SVG 로 렌더(원문은 data-src 에 보존). */
async function _renderMermaidFigures(root) {
    const figures = (root || document).querySelectorAll('.mermaid-figure');
    if (figures.length === 0) return;
    let mermaid;
    try {
        mermaid = await _loadMermaid();
    } catch (err) {
        figures.forEach(fig => {
            fig.innerHTML = '<div class="mermaid-error alert alert-warning mb-0">다이어그램 라이브러리를 불러오지 못했습니다.</div>';
        });
        _emitMermaidRendered();
        return;
    }
    for (const fig of figures) {
        const src = (fig.dataset.src || '');
        if (!src.trim()) { fig.innerHTML = ''; continue; }
        const renderId = `wiki-mermaid-${++_mermaidSeq}`;
        try {
            const { svg } = await mermaid.render(renderId, src);
            // securityLevel:'strict' 가 이미 정화하지만 기존 정책 일관성을 위해 DOMPurify 재정화.
            const clean = (typeof DOMPurify !== 'undefined')
                ? DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })
                : svg;
            fig.innerHTML = clean;
            const svgEl = fig.querySelector('svg');
            if (svgEl) {
                svgEl.removeAttribute('height');
                svgEl.style.maxWidth = '100%';
            }
            if (!fig.getAttribute('aria-label')) fig.setAttribute('aria-label', '다이어그램');
        } catch (err) {
            // 잘못된 DSL 은 페이지를 깨지 않고 인라인 에러 박스로 표시.
            const msg = (err && err.message) ? err.message : String(err);
            fig.innerHTML = `<div class="mermaid-error alert alert-warning mb-0"><strong>다이어그램 오류</strong><br><span class="small">${escapeHtml(msg)}</span></div>`;
            // mermaid 가 렌더 실패 시 body 에 남긴 임시 노드(d{renderId}) 정리.
            const orphan = document.getElementById('d' + renderId);
            if (orphan && orphan.parentNode) orphan.parentNode.removeChild(orphan);
        }
    }
    // 모든 figure 렌더가 끝났으니(레이아웃 확정) 스크롤 싱크 등 청취 측에 알린다.
    _emitMermaidRendered();
}

/** 테마 토글 / OS 다크모드 변경 시 모든 다이어그램을 새 테마로 재렌더. 미로드면 no-op. */
function _rerenderAllMermaid() {
    if (!_mermaidMod) return;
    _mermaidMod.initialize(_mermaidInitConfig());
    _renderMermaidFigures(document);
}

if (typeof window !== 'undefined') {
    window.addEventListener('wiki:theme-changed', _rerenderAllMermaid);
    if (typeof window.matchMedia === 'function') {
        const _mq = window.matchMedia('(prefers-color-scheme: dark)');
        if (_mq.addEventListener) _mq.addEventListener('change', _rerenderAllMermaid);
        else if (_mq.addListener) _mq.addListener(_rerenderAllMermaid);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// window 브리지 — classic public/js/render.js 시절 모든 top-level 함수가
// classic-script-global 로 자동 노출되었으므로, ESM 으로 이전한 뒤에도 동일한
// 외부 계약을 유지한다. 다른 모듈(edit/main.ts / edit/conflict.ts / freq 익스텐션
// / inline HTML 핸들러) 이 window.X 로 호출하므로 누락 시 회귀가 발생한다.
// ─────────────────────────────────────────────────────────────────────────────
window.initMarkedConfig = initMarkedConfig;
window._isExtensionCall = _isExtensionCall;
window._splitPipeTopLevel = _splitPipeTopLevel;
window._findTopLevelEquals = _findTopLevelEquals;
window._parseTemplateCall = _parseTemplateCall;
window._findParamRefEnd = _findParamRefEnd;
window._findParamRefs = _findParamRefs;
window._substituteTemplateParams = _substituteTemplateParams;
window._findTemplateCallEnd = _findTemplateCallEnd;
window._findTemplateCalls = _findTemplateCalls;
window._replaceSelfCalls = _replaceSelfCalls;
window.resolveTransclusions = resolveTransclusions;
window.resolveTransclusionsForMarkdown = resolveTransclusionsForMarkdown;
window.fetchCategoryList = fetchCategoryList;
window._wikiCategoryInvalidate = _wikiCategoryInvalidate;
window.numberHeadings = numberHeadings;
window.generateTOC = generateTOC;
// 좌측 목차 사이드바(left-toc 모드)가 번호 포함 목차를 직접 생성하기 위해 노출.
window.buildTocOlHtml = _buildTocOlHtml;
window.makeCollapsibleSections = makeCollapsibleSections;
window.processWikiLinks = processWikiLinks;
window.processMentions = processMentions;
window.processFootnotes = processFootnotes;
window.extractPlainTextWithFootnotes = extractPlainTextWithFootnotes;
window._isSafeCssColor = _isSafeCssColor;
window.WIKI_HARDCODED_PALETTES = WIKI_HARDCODED_PALETTES;
window.getMergedWikiPalettes = getMergedWikiPalettes;
window._processInlineLayoutTokens = _processInlineLayoutTokens;
window._processTimestampsInHtml = _processTimestampsInHtml;
window.protectWikiLinks = protectWikiLinks;
window.restoreWikiLinks = restoreWikiLinks;
window.renderWikiContent = renderWikiContent;
// 렌더 컨텍스트 주입(워크스페이스 등). 미호출 시 메인 위키 기본값 유지.
window.configureWikiRender = (opts) => {
    if (!opts) return;
    if (opts.templateApiBase !== undefined) _renderCtx.templateApiBase = opts.templateApiBase;
    if (opts.disableExtensions !== undefined) _renderCtx.disableExtensions = !!opts.disableExtensions;
    if (opts.categoryApiBase !== undefined) _renderCtx.categoryApiBase = opts.categoryApiBase;
    if (opts.wikiLinkBase !== undefined) _renderCtx.wikiLinkBase = opts.wikiLinkBase;
    if (opts.imageDocLinkBase !== undefined) _renderCtx.imageDocLinkBase = opts.imageDocLinkBase;
};
// 직접 익스텐션 문서 경로(pages/index.ts)가 컨테이너 교체 전 익스텐션 정리 훅을 호출하기 위해 노출.
window._teardownExtensions = _teardownExtensions;
window._extractMarkdownSectionRanges = _extractMarkdownSectionRanges;
window._extractMarkdownSections = _extractMarkdownSections;
window._addHeadingCopyButtons = _addHeadingCopyButtons;
window._resolveAnchorTarget = _resolveAnchorTarget;
// 초기 로드 해시 스크롤(pages/index.ts scrollToHash)이 접힌 조상을 펼치도록 노출한다.
// {collapse} 기본 접힘 섹션·닫힌 fold(<details>)·비활성 탭 내부로의 딥링크 대상이
// 스크롤 전에 보이도록 조상을 펼친 뒤 스크롤한다(가드: typeof === 'function').
window._scrollToElementWithAncestors = _scrollToElementWithAncestors;

// initMarkedConfig() / _setupArticleTitleCopy() 의 즉시 호출은 원본 render.js
// 와 동일하게 파일 본문 안에서 수행된다(상단의 `initMarkedConfig()` / 본문 끝의
// `if (document.readyState === 'loading') ...`). ESM 모듈 평가 시점에 그대로 호출.
