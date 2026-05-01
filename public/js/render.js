// ── Marked 설정 및 렌더링 코어 로직 ──
// ── Marked 설정 (1회 초기화) ──
function initMarkedConfig() {
    if (typeof marked === 'undefined') return;
    marked.use({
        extensions: [
            {
                name: 'highlight',
                level: 'inline',
                start(src) { return src.indexOf('=='); },
                tokenizer(src) {
                    const match = src.match(/^==([^=]+)==/);
                    if (match) {
                        const token = {
                            type: 'highlight',
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
                    return '<mark>' + this.parser.parseInline(token.tokens) + '</mark>';
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
                name: 'spoiler',
                level: 'inline',
                start(src) { return src.indexOf('||'); },
                tokenizer(src) {
                    const match = src.match(/^\|\|([^|]+(?:\|[^|]+)*?)\|\|/);
                    if (match) {
                        const token = {
                            type: 'spoiler',
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
                    return '<span class="spoiler">' + this.parser.parseInline(token.tokens) + '</span>';
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
                    const match = src.match(/^\{button:([^}]+)\}/);
                    if (match) {
                        return {
                            type: 'wikiButton',
                            raw: match[0],
                            text: match[1]
                        };
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
    marked.setOptions({
        gfm: true,
        breaks: true,
        headerIds: true,
    });
}
initMarkedConfig();
// ── 익스텐션 데이터 임시 저장소 (렌더링 시 render.js에서 참조) ──
var _wikiExtensionData = [];

/**
 * 이름에 ':'가 포함되어 있고 틀 접두사(틀:/template:/템플릿:)가 아닌 경우 → 익스텐션 호출
 */
function _isExtensionCall(name) {
    const colonIdx = name.indexOf(':');
    if (colonIdx <= 0) return false;
    if (name.startsWith('틀:') || name.startsWith('template:') || name.startsWith('템플릿:')) return false;
    return true;
}

/**
 * 최상위(depth=0) 파이프(|)만 기준으로 raw를 분리합니다.
 * 다음 위키 문법 내부의 '|'는 분리하지 않습니다:
 *   - [[링크|레이블]]          이중 대괄호
 *   - {{틀|인자}}              이중 중괄호
 *   - {{{파라미터|기본값}}}    삼중 중괄호 (파라미터 참조)
 *   - {button:text|url}, {stat:value|label} 등 단일 중괄호 토큰
 */
function _splitPipeTopLevel(raw) {
    const parts = [];
    let depth = 0;        // {{...}} / [[...]] / {{{...}}} 합산 깊이
    let singleBrace = 0;  // {...} 단일 중괄호 토큰 깊이
    let start = 0;
    let i = 0;
    while (i < raw.length) {
        const ch = raw[i];
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
 * {{틀이름|값1|key=값2}} 호출 내부 텍스트를 파싱한다. 첫 토큰은 틀 이름, 이후 토큰은 좌→우 순으로:
 *   - `=` 가 있으면 `key=value` 이름 인자로 저장
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
        const eq = part.indexOf('=');
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
 * `{{{` 로 시작하는 파라미터 참조의 닫는 `}}}` 위치를 스택 기반으로 찾는다.
 * 기본값이 {{...}}, {{{...}}}, {...} 등 중첩된 위키 토큰을 포함해도 정확히 매칭한다.
 */
function _findParamRefEnd(text, contentStart) {
    const stack = ['tri']; // 외부 {{{ 는 이미 소비
    let i = contentStart;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '{') {
            if (text[i + 1] === '{' && text[i + 2] === '{') { stack.push('tri'); i += 3; continue; }
            if (text[i + 1] === '{') { stack.push('dbl'); i += 2; continue; }
            stack.push('sgl');
            i++;
            continue;
        }
        if (ch === '}') {
            const top = stack[stack.length - 1];
            if (top === 'tri' && text[i + 1] === '}' && text[i + 2] === '}') {
                stack.pop();
                i += 3;
                if (stack.length === 0) return { contentEnd: i - 3, fullEnd: i };
                continue;
            }
            if (top === 'dbl' && text[i + 1] === '}') {
                stack.pop();
                i += 2;
                if (stack.length === 0) return { contentEnd: i - 2, fullEnd: i };
                continue;
            }
            if (top === 'sgl') {
                stack.pop();
                i++;
                if (stack.length === 0) return { contentEnd: i - 1, fullEnd: i };
                continue;
            }
            // 매칭 없는 `}` — 그냥 스킵.
            i++;
            continue;
        }
        i++;
    }
    return null;
}

/**
 * text 에서 최상위 `{{{...}}}` 파라미터 참조를 모두 찾는다.
 */
function _findParamRefs(text) {
    const refs = [];
    let i = 0;
    while (i < text.length - 2) {
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

/**
 * `{{`(contentStart-2 위치) 로 시작하는 틀 호출의 닫는 `}}` 위치를 찾는다.
 * 단일 중괄호 `{...}` 토큰, 삼중 중괄호 `{{{...}}}` 파라미터 참조, 중첩된 `{{...}}` 호출을
 * 모두 올바르게 건너뛰며, 호출 인자 안에 {button:text|url} 같은 `}`-포함 토큰이 있어도
 * 첫 번째 `}` 에서 조기 종료하지 않는다.
 * @returns { contentEnd: number, fullEnd: number } 성공 / null 실패 (짝 없음)
 */
function _findTemplateCallEnd(text, contentStart) {
    let dblBrace = 1; // 외부 {{ 는 이미 소비된 상태로 호출됨
    let sgl = 0;      // 단일 중괄호 {...} 깊이
    let i = contentStart;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '}') {
            // 단일 중괄호 토큰이 열려 있으면 먼저 닫아 준다 ({button:...|...} 내부 `|` 보호와 대칭)
            if (sgl > 0) {
                sgl--;
                i++;
                continue;
            }
            if (text[i + 1] === '}') {
                dblBrace--;
                i += 2;
                if (dblBrace === 0) return { contentEnd: i - 2, fullEnd: i };
                continue;
            }
            // 짝이 없는 `}` — 스킵
            i++;
            continue;
        }
        if (ch === '{') {
            if (text[i + 1] === '{') {
                dblBrace++;
                i += 2;
                continue;
            }
            sgl++;
            i++;
            continue;
        }
        i++;
    }
    return null;
}

/**
 * text 에서 최상위 `{{...}}` 호출을 모두 찾아 반환한다.
 * `{{{...}}}` 파라미터 참조는 범위 전체를 건너뛰므로, 그 내부(특히 기본값)의 `{{...}}` 가
 * 최상위 호출로 잘못 인식되지 않는다.
 */
function _findTemplateCalls(text) {
    const calls = [];
    let i = 0;
    while (i < text.length - 1) {
        if (text[i] === '{' && text[i + 1] === '{') {
            if (text[i + 2] === '{') {
                const refEnd = _findParamRefEnd(text, i + 3);
                i = refEnd ? refEnd.fullEnd : i + 3;
                continue;
            }
            const end = _findTemplateCallEnd(text, i + 2);
            if (end) {
                calls.push({
                    start: i,
                    fullEnd: end.fullEnd,
                    raw: text.substring(i + 2, end.contentEnd)
                });
                i = end.fullEnd;
                continue;
            }
        }
        i++;
    }
    return calls;
}

// ── 틀(Transclusion) 및 익스텐션 처리 ──
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
        const { name } = _parseTemplateCall(c.raw.trim());
        if (_isExtensionCall(name)) {
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

    // 괄호 균형을 추적하는 파서로 호출 위치를 찾는다. 인자 안의 {button:a|b} 처럼
    // `}` 를 포함한 단일 중괄호 토큰이 있어도 첫 `}` 에서 중단되지 않는다.
    const calls = _findTemplateCalls(protectedText);

    if (calls.length === 0) return text;

    const slugsToFetch = new Set();
    const extensionSlugs = new Set();
    calls.forEach(c => {
        const { name, args } = _parseTemplateCall(c.raw.trim());
        if (_isExtensionCall(name)) {
            if (options.expandExtensions) {
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
                fetch(`/api/w/${encodeURIComponent(slug)}`)
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

    // transclusion 으로 주입된 헤딩을 원본 헤딩과 구분하기 위해, 템플릿 전개 결과를
    // 보이지 않는 HTML 주석 센티넬로 감싼다. 같은 헤딩 텍스트가 원본과 템플릿 양쪽에
    // 존재할 때 텍스트 매칭만으로는 섹션 편집 링크가 엉뚱한 섹션을 가리킬 수 있으므로,
    // 확실한 소스 표식이 필요하다. 센티넬은 _extractMarkdownSectionRanges 에서
    // 문자 오프셋 깊이 추적으로 감지되고, 최종 HTML 에서는 DOMPurify 가 제거한다.
    const WIKI_TCL_OPEN = '<!--WIKI_TCL_B-->';
    const WIKI_TCL_CLOSE = '<!--WIKI_TCL_E-->';

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
        if (_isExtensionCall(trimmed)) {
            if (!options.expandExtensions) {
                replacement = match;
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

                // 현재 라인의 접두 / 접미 컨텍스트 분석
                const lineStart = protectedText.lastIndexOf('\n', c.start - 1) + 1;
                const nextNl = protectedText.indexOf('\n', c.fullEnd);
                const lineEnd = nextNl === -1 ? protectedText.length : nextNl;
                const beforeOnLine = protectedText.substring(lineStart, c.start);
                const afterOnLine = protectedText.substring(c.fullEnd, lineEnd);
                const aloneOnLine = beforeOnLine.trim() === '' && afterOnLine.trim() === '';

                if (aloneOnLine && beforeOnLine === '') {
                    // 진짜 블록 컨텍스트(컬럼 0, 단독 라인): 센티넬을 빈 줄로 분리.
                    replacement = '\n\n' + WIKI_TCL_OPEN + '\n\n' + expanded + '\n\n' + WIKI_TCL_CLOSE + '\n\n';
                } else if (aloneOnLine) {
                    // 들여쓰기된 단독 라인: 원본 접두사를 다음 줄들에도 이어 붙여 부모 블록 유지.
                    const prefix = beforeOnLine;
                    const indentedExpanded = expanded.split('\n').join('\n' + prefix);
                    replacement = WIKI_TCL_OPEN + indentedExpanded + WIKI_TCL_CLOSE;
                } else {
                    // 인라인 컨텍스트(문장 중간): 같은 줄에 바로 붙여 문단 흐름 유지.
                    replacement = WIKI_TCL_OPEN + expanded + WIKI_TCL_CLOSE;
                }
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

// ── 카테고리 목록 렌더링 ──
async function fetchCategoryList(category) {
    try {
        const res = await fetch(`/api/w/category/${encodeURIComponent(category)}`);
        if (!res.ok) return '';

        const data = await res.json();
        if (data.pages.length === 0) {
            return '<div class="alert alert-light border text-center my-4">이 카테고리에 속한 문서가 없습니다.</div>';
        }

        // 트리 구조 빌드
        const tree = {};
        for (const page of data.pages) {
            const parts = page.slug.split('/');
            let node = tree;
            for (const part of parts) {
                if (!node[part]) node[part] = { _children: {}, _doc: null };
                node = node[part]._children;
            }
            let target = tree;
            for (let i = 0; i < parts.length; i++) {
                if (i === parts.length - 1) {
                    target[parts[i]]._doc = page;
                } else {
                    target = target[parts[i]]._children;
                }
            }
        }

        function renderTree(nodes, parentPrefix) {
            const entries = Object.keys(nodes).sort();
            let html = '';
            entries.forEach((key, idx) => {
                const node = nodes[key];
                const isLast = idx === entries.length - 1;
                const hasChildren = Object.keys(node._children).length > 0;
                const connector = isLast ? '└── ' : '├── ';
                const childPrefix = parentPrefix + (isLast ? '    ' : '│   ');

                if (node._doc) {
                    html += `<div class="wiki-tree-line">${parentPrefix}${connector}<a href="/w/${encodeURIComponent(node._doc.slug)}" class="text-decoration-none wiki-spa-link">${escapeHtml(key)}</a></div>`;
                } else {
                    html += `<div class="wiki-tree-line">${parentPrefix}${connector}${escapeHtml(key)}</div>`;
                }

                if (hasChildren) {
                    html += renderTree(node._children, childPrefix);
                }
            });
            return html;
        }

        const treeHtml = renderTree(tree, '');

        return `
        <div class="category-list mt-4">
            <h4><i class="bi bi-folder2-open"></i> "${escapeHtml(category)}" 카테고리에 속한 문서</h4>
            <div class="mt-3">${treeHtml}</div>
        </div>
    `;
    } catch (e) {
        console.error(e);
        return '<div class="alert alert-danger">카테고리 목록을 불러오는 데 실패했습니다.</div>';
    }
}

// ── TOC 생성 ──
// 헤딩에 계층적 번호 프리픽스 삽입 (예: 1., 1.1., 1.1.1.)
function numberHeadings(contentEl) {
    if (!contentEl) return;
    const headings = contentEl.querySelectorAll('h1, h2, h3, h4');
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

function generateTOC(contentEl, tocContainerId, tocNavId) {
    if (!contentEl) return;
    const headings = contentEl.querySelectorAll('h1, h2, h3, h4');
    const tocContainer = document.getElementById(tocContainerId);
    if (!tocContainer) return;

    if (headings.length < 1) {
        tocContainer.classList.add('d-none');
        return;
    }

    const tocNav = document.getElementById(tocNavId);
    if (!tocNav) return;

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
        // .wiki-heading-num을 제외한 순수 텍스트만 사용 (번호는 <ol>이 자동 생성)
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

        html += `<li><a href="#${id}">${escapeHtml(text.trim())}</a></li>`;
        prevLevel = level;
    });

    for (let j = 0; j < prevLevel; j++) html += '</ol>';

    tocNav.innerHTML = html;
    tocContainer.classList.remove('d-none');
}

// numberHeadings()는 헤딩별로 항상 `s-{N.N}` 형태의 앵커를 보장한다.
// 원본 마크다운/HTML이 부여한 기존 id 가 있는 경우 h.id 는 그 값을 유지하고,
// 별도의 <span class="wiki-section-anchor" id="s-N"> 가 헤딩 내부에 삽입된다.
function _getSectionAnchorId(heading) {
    const anchorEl = heading.querySelector('.wiki-section-anchor[id^="s-"]');
    if (anchorEl) return anchorEl.id;
    return heading.id || '';
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
        // 목차 아코디언(#collapseTOC) — Bootstrap Collapse API 로 열기
        if (el.id === 'collapseTOC' && el.classList.contains('collapse') && !el.classList.contains('show')) {
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
    const headings = containerEl.querySelectorAll('h1, h2, h3, h4, h5, h6');
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

                // 섹션 링크 문법: [[slug#1.2]], [[slug#1.2|텍스트]], [[#1.2]]
                // 슬러그에는 '#'이 금지 문자(서버/에디터에서 검증)이므로
                // '#'을 발견하면 항상 앵커 구분자로 취급하고 슬러그에서 제거한다.
                // '#' 뒷부분이 목차 번호 형식이면 내부 헤딩 ID(s-N.N...)로 매핑하고,
                // 형식이 유효하지 않으면 앵커를 무시한다(스크롤 없이 문서만 이동).
                let anchor = '';
                const hashIdx = linkText.indexOf('#');
                if (hashIdx !== -1) {
                    const candidate = linkText.substring(hashIdx + 1).trim();
                    linkText = linkText.substring(0, hashIdx).trim();
                    if (/^\d+(?:\.\d+)*$/.test(candidate)) {
                        // 사용자 친화적 목차 번호 → 내부 헤딩 ID로 매핑
                        anchor = `s-${candidate}`;
                    } else if (/^s-\d+(?:\.\d+)*$/.test(candidate)) {
                        // 내부 ID 직접 입력(하위 호환)
                        anchor = candidate;
                    }
                    // 그 외 형식은 무시
                }

                if (!linkText && !anchor) {
                    // 유효한 슬러그도 앵커도 없음 → 원본 텍스트 그대로 노출
                    frag.appendChild(document.createTextNode(part));
                    return;
                }

                const a = document.createElement('a');
                if (!linkText && anchor) {
                    // 같은 페이지 앵커
                    a.href = `#${anchor}`;
                } else {
                    a.href = `/w/${encodeURIComponent(linkText)}${anchor ? '#' + anchor : ''}`;
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
                        const target = id ? document.getElementById(id) : null;
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

// ── 각주 처리 ──
var _fnUniqueCounter = 0;
function processFootnotes(contentEl) {
    if (!contentEl) return;
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];

    while (walker.nextNode()) {
        const parentTag = walker.currentNode.parentNode.tagName;
        if (parentTag === 'CODE' || parentTag === 'PRE') continue;

        const val = walker.currentNode.nodeValue;
        if (/\[\*\s/.test(val)) {
            textNodes.push(walker.currentNode);
        }
    }

    if (textNodes.length === 0) return;

    let footnoteIndex = 0;
    const footnotes = [];

    textNodes.forEach(node => {
        const frag = document.createDocumentFragment();
        const parts = node.nodeValue.split(/(\[\*\s[^\]]+\])/g);

        parts.forEach(part => {
            const fnMatch = part.match(/^\[\*\s(.+)\]$/);
            if (fnMatch) {
                footnoteIndex++;
                const fnContent = fnMatch[1];
                const uniqueId = ++_fnUniqueCounter;
                const fnId = `fn-${footnoteIndex}-${uniqueId}`;
                const refId = `fn-ref-${footnoteIndex}-${uniqueId}`;

                footnotes.push({ id: fnId, refId: refId, num: footnoteIndex, content: fnContent });

                const sup = document.createElement('sup');
                sup.className = 'wiki-fn-ref';
                const a = document.createElement('a');
                a.href = `#${fnId}`;
                a.id = refId;
                a.textContent = `[${footnoteIndex}]`;

                if (typeof bootstrap !== 'undefined') {
                    a.setAttribute('data-bs-toggle', 'popover');
                    a.setAttribute('data-bs-trigger', 'hover focus');
                    a.setAttribute('data-bs-placement', 'top');
                    a.setAttribute('data-bs-content', escapeHtml(fnContent || ''));
                }

                a.onclick = (e) => {
                    e.preventDefault();
                    if (window.innerWidth >= 992) {
                        const target = document.getElementById(fnId);
                        if (target) _scrollToElementWithAncestors(target, { behavior: 'smooth', block: 'start' });
                    }
                };
                sup.appendChild(a);
                frag.appendChild(sup);
            } else if (part) {
                frag.appendChild(document.createTextNode(part));
            }
        });

        node.parentNode.replaceChild(frag, node);
    });

    if (footnotes.length > 0) {
        const fnSection = document.createElement('div');
        fnSection.className = 'wiki-footnotes';
        fnSection.innerHTML = `<hr><h4><i class="bi bi-card-text"></i> 각주</h4>`;

        const ol = document.createElement('ol');
        footnotes.forEach(fn => {
            const li = document.createElement('li');
            li.id = fn.id;

            const backLink = document.createElement('a');
            backLink.href = `#${fn.refId}`;
            backLink.className = 'wiki-fn-back';
            backLink.innerHTML = '<i class="bi bi-arrow-return-left"></i>';
            backLink.title = '본문으로 돌아가기';
            backLink.onclick = (e) => {
                e.preventDefault();
                document.getElementById(fn.refId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            };

            const span = document.createElement('span');
            span.textContent = ' ' + fn.content;

            li.appendChild(backLink);
            li.appendChild(span);
            ol.appendChild(li);
        });

        fnSection.appendChild(ol);
        contentEl.appendChild(fnSection);
    }
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
// 부트스트랩 컬러 스키마 기반. 라이트/다크 모두 자연스럽게 보이도록 모드별 색상을 분리 정의.
// 이름 충돌 시 커스텀(appConfig.palettes)이 하드코딩을 덮어씌움.
const WIKI_HARDCODED_PALETTES = {
    primary:   { light: { bg: '#CFE2FF', color: '#052C65' }, dark: { bg: '#031633', color: '#9EC5FE' } },
    secondary: { light: { bg: '#E2E3E5', color: '#2B2F32' }, dark: { bg: '#1C1F22', color: '#C4C8CB' } },
    success:   { light: { bg: '#D1E7DD', color: '#0A3622' }, dark: { bg: '#051B11', color: '#A3CFBB' } },
    info:      { light: { bg: '#CFF4FC', color: '#055160' }, dark: { bg: '#032830', color: '#9EEAF9' } },
    warning:   { light: { bg: '#FFF3CD', color: '#664D03' }, dark: { bg: '#332701', color: '#FFE69C' } },
    danger:    { light: { bg: '#F8D7DA', color: '#58151C' }, dark: { bg: '#2C0B0E', color: '#F1AEB5' } },
    muted:     { light: { bg: '#F8F9FA', color: '#6C757D' }, dark: { bg: '#1A1D20', color: '#ADB5BD' } },
};

/** 커스텀(appConfig.palettes) + 하드코딩을 병합한 팔레트 맵. 커스텀 우선. */
function getMergedWikiPalettes() {
    const custom = (typeof appConfig !== 'undefined' && appConfig && appConfig.palettes && typeof appConfig.palettes === 'object') ? appConfig.palettes : {};
    return Object.assign({}, WIKI_HARDCODED_PALETTES, custom);
}


/** 현재 다크모드 여부 */
function _isWikiDarkMode() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

/**
 * 텍스트에 포함된 {palette:이름} 토큰을 {bg:#...}{color:#...} 토큰으로 치환.
 * 존재하지 않는 팔레트는 원본 토큰을 그대로 남겨 { bg:}/{color:} 파서에서 무시되도록 함.
 * 기존 렌더링 파이프라인의 매크로 치환 단계로서 동작하며 새로운 렌더 경로를 만들지 않음.
 */
function _resolvePaletteTokens(text) {
    if (!text || typeof text !== 'string') return text;
    if (text.indexOf('{palette:') === -1) return text;
    const merged = getMergedWikiPalettes();
    const isDark = _isWikiDarkMode();
    return text.replace(/\{palette:\s*([^}\s][^}]*?)\s*\}/g, (match, nameRaw) => {
        const name = nameRaw.trim();
        const entry = merged[name];
        if (!entry) return match; // 미등록 이름: 원본 유지 (bg/color 파서도 매칭 실패하여 무시됨)
        const variant = isDark ? entry.dark : entry.light;
        if (!variant) return match;
        let out = '';
        if (variant.bg) out += `{bg:${variant.bg}}`;
        if (variant.color) out += `{color:${variant.color}}`;
        return out || match;
    });
}

// ── 고급 레이아웃: ::: 블록 디렉티브 & 인라인 칩 ──

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
    innerHtml = innerHtml.replace(/<img([^>]*)>\s*\{size:([a-zA-Z0-9_-]+)\}/g, (_, attrs, size) => `<img${attrs} data-size="${size.trim()}">`);
    innerHtml = innerHtml.replace(/(?:<p>)?WIKIBLOCKPH(\d+)XEND(?:<\/p>)?/g, (m, i) => {
        const sub = blockData[parseInt(i, 10)];
        return sub ? _renderBlockHtml(sub, blockData) : '';
    });

    let style = '';
    if (bg && _isSafeCssColor(bg)) style += `background-color:${bg};`;
    if (color && _isSafeCssColor(color)) style += `color:${color};`;
    const styleAttr = style ? ` style="${style}"` : '';
    const titleEsc = escapeHtml(cleanTitle);

    switch (type) {
        case 'card': {
            // 헤더(제목)와 바디(내용)에 스타일을 분리 적용
            let headerStyle = '';
            if (bg && _isSafeCssColor(bg)) headerStyle += `background-color:${bg};`;
            if (color && _isSafeCssColor(color)) headerStyle += `color:${color};`;
            const headerStyleAttr = headerStyle ? ` style="${headerStyle}"` : '';

            let bodyStyle = '';
            if (bodyBg && _isSafeCssColor(bodyBg)) bodyStyle += `background-color:${bodyBg};`;
            if (bodyColor && _isSafeCssColor(bodyColor)) bodyStyle += `color:${bodyColor};`;
            const bodyStyleAttr = bodyStyle ? ` style="${bodyStyle}"` : '';

            return `<div class="wiki-card">` +
                (titleEsc ? `<div class="wiki-card-header"${headerStyleAttr}>${titleEsc}</div>` : '') +
                `<div class="wiki-card-body"${bodyStyleAttr}>${innerHtml}</div>` +
                `</div>`;
        }
        case 'grid':
            return `<div class="wiki-grid"${styleAttr}>${innerHtml}</div>`;
        case 'row':
            return `<div class="wiki-row"${styleAttr}>${innerHtml}</div>`;
        case 'embed': {
            const accentRaw = (bg && _isSafeCssColor(bg)) ? bg
                            : (color && _isSafeCssColor(color)) ? color
                            : '';
            const accentStyle = accentRaw ? ` style="border-left-color:${accentRaw};"` : '';
            const titleHtml = titleEsc ? `<div class="wiki-embed-title">${titleEsc}</div>` : '';
            return `<div class="wiki-embed"${accentStyle}>` +
                titleHtml +
                `<div class="wiki-embed-body">${innerHtml}</div>` +
                `</div>`;
        }
        case 'info':
        case 'tip':
        case 'success':
        case 'warning':
        case 'danger':
        case 'note': {
            const calloutMeta = {
                info:    { icon: 'mdi-information-outline',   title: '정보' },
                tip:     { icon: 'mdi-lightbulb-on-outline',  title: '팁' },
                success: { icon: 'mdi-check-circle-outline',  title: '성공' },
                warning: { icon: 'mdi-alert-outline',         title: '주의' },
                danger:  { icon: 'mdi-alert-octagon-outline', title: '위험' },
                note:    { icon: 'mdi-note-text-outline',     title: '노트' }
            }[type];
            const headerTitle = titleEsc || escapeHtml(calloutMeta.title);
            return `<div class="wiki-callout wiki-callout-${type}">` +
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
    // 스타일/아이콘 토큰({palette|bg|color|mdi|bi|icon}:...)을 흡수해 컴포넌트 내부에 렌더링.
    // 순서 무관하게 혼용 가능. 아이콘 토큰은 최대 1개만 소비.
    // 프리픽스는 컴포넌트 매치 후 역방향 결정적 스캔으로 수집하여
    // 탐욕적 반복 정규식의 백트래킹을 회피한다.
    const COMPONENT_TOKEN_RE = /^\{(?:palette|bg|color|mdi|bi|icon):[^}]+\}$/;
    const ICON_TOKEN_RE = /^\{(mdi|bi|icon):\s*([^}]+?)\s*\}$/;
    const CLASS_NAME_RE = /^[a-zA-Z0-9\-_]+$/;

    function extractIconHtml(prefix) {
        let iconHtml = '';
        const tokenRe = /\{(?:palette|bg|color|mdi|bi|icon):[^}]+\}/g;
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

    html = scanComponent(html, /\{badge:([^}|]+)\}/g, (prefix, m) => {
        const { bg, color } = parseStylePrefix(prefix);
        const iconHtml = extractIconHtml(prefix);
        const text = m[1].trim();
        const inner = iconHtml
            ? `${iconHtml}<span class="wiki-badge-label">${escapeHtml(text)}</span>`
            : escapeHtml(text);
        return `<span class="wiki-badge"${buildStyleAttr(bg, color)}>${inner}</span>`;
    });

    html = scanComponent(html, /\{tag:([^}|]+)\}/g, (prefix, m) => {
        const { bg, color } = parseStylePrefix(prefix);
        const iconHtml = extractIconHtml(prefix);
        const text = m[1].trim();
        const inner = iconHtml
            ? `${iconHtml}<span class="wiki-tag-label">${escapeHtml(text)}</span>`
            : escapeHtml(text);
        return `<span class="wiki-tag"${buildStyleAttr(bg, color)}>${inner}</span>`;
    });

    html = scanComponent(html, /\{button:([^}]+)\}/g, (prefix, m) => {
        const { bg, color } = parseStylePrefix(prefix);
        const iconHtml = extractIconHtml(prefix);
        const parts = m[1].split('|').map(s => s.trim());
        const text = parts[0] || '';
        const url = parts[1] || '';
        if (!text || !url) return null;
        const safe = (typeof isSafeUrl === 'function') && isSafeUrl(url);
        const href = safe ? url : '#';
        let external = false;
        try {
            const u = new URL(url, window.location.origin);
            external = (u.origin !== window.location.origin);
        } catch (e) { /* 상대 경로 등 */ }
        const styled = !!(bg || color);
        const cls = styled ? 'wiki-button wiki-button-custom' : 'wiki-button';
        const extAttr = external ? ' target="_blank" rel="noopener noreferrer"' : '';
        const inner = iconHtml
            ? `${iconHtml}<span class="wiki-button-label">${escapeHtml(text)}</span>`
            : escapeHtml(text);
        return `<a class="${cls}" href="${escapeHtml(href)}"${extAttr}${buildStyleAttr(bg, color)}>${inner}</a>`;
    });

    html = scanComponent(html, /\{stat:([^}]+)\}/g, (prefix, m) => {
        const { bg, color } = parseStylePrefix(prefix);
        const iconHtml = extractIconHtml(prefix);
        const parts = m[1].split('|').map(s => s.trim());
        const value = escapeHtml(parts[0] || '');
        const label = parts[1] ? escapeHtml(parts[1]) : '';
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
    // stat이 자신만 있는 단락(<p>...</p>) 안에 래핑된 경우 <p>를 제거해 블록으로 승격.
    html = html.replace(/<p>\s*(<div class="wiki-stat"[\s\S]*?<\/div>)\s*<\/p>/g, '$1');

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

    html = scanComponent(html, /\{progress:([^}<\n]+)\}/g, (prefix, m) => {
        const { bg, color } = parseStylePrefix(prefix);
        const iconHtml = extractIconHtml(prefix);
        const parts = m[1].split('|').map(s => s.trim());
        const valueStr = parts[0] || '';
        const label = parts[1] || '';
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
            ? `<span class="wiki-progress-label">${iconHtml}${label ? `<span class="wiki-progress-label-text">${escapeHtml(label)}</span>` : ''}</span>`
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
    // progress가 자신만 있는 단락(<p>...</p>) 안에 래핑된 경우 <p>를 제거해 블록으로 승격.
    html = html.replace(/<p>\s*(<div class="wiki-progress"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>)\s*<\/p>/g, '$1');

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

// containerId → ResizeObserver (그리드 균형 조정 중복 방지)
const _gridObserverMap = {};

/**
 * .wiki-grid 내부 카드가 줄바꿈될 때 위아래 개수가 대칭이 되도록 열 수를 조정.
 * 예) 4개 카드가 3+1로 깨지지 않고 2+2로 배치되도록.
 * 한 줄에 모두 들어가는 경우에는 기본 flex 레이아웃을 유지.
 */
function _balanceWikiGrids(containerEl, containerId) {
    // CSS flex-grow(1 1 200px)를 통해 왼쪽부터 순차적으로 채우고
    // 전체 너비를 활용하는 방식으로 변경되었으므로 JS 균형 조절 로직을 비활성화합니다.
    return;
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
// 체크된 항목은 초록색으로 표시.
function _replaceTaskCheckboxesWithIcons(html) {
    return html.replace(/<input\b([^>]*?)\btype="checkbox"([^>]*?)>/gi, (match, before, after) => {
        const attrs = before + after;
        const checked = /\bchecked\b/i.test(attrs);
        if (checked) {
            return `<span class="mdi mdi-checkbox-marked wiki-task-checkbox" style="color:#8bc34a;" aria-hidden="true"></span>`;
        }
        return `<span class="mdi mdi-square wiki-task-checkbox" aria-hidden="true"></span>`;
    });
}

// ── 문서 렌더링 통합 (index.html, edit.html 공통) ──
async function renderWikiContent(content, slug, containerId, options = {}) {
    const containerEl = document.getElementById(containerId);
    if (!containerEl) return;

    try {
        const resolvedContent = await resolveTransclusions(content || '', slug);

        const codeBlocksForFold = [];
        let foldInput = resolvedContent.replace(/^(`{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$|`[^`\n]+`/gm, (m) => {
            const idx = codeBlocksForFold.length;
            codeBlocksForFold.push(m);
            return `WIKICODEFPH${idx}XEND`;
        });

        foldInput = foldInput.replace(/^[\u200B\uFEFF]+(\[[-+])/gm, '$1');

        // "- []" (공백 없는 빈 체크박스) → GFM 표준 "- [ ]" 로 정규화
        foldInput = foldInput.replace(/^(\s*[-*+] )\[\](?=[ \t]|$)/gm, '$1[ ]');

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
            let contentHtml = (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(rawContentHtml, { ADD_TAGS: ['i', 'span', 'details', 'summary', 'div', 'canvas'], ADD_ATTR: ['class', 'style', 'data-bg', 'data-color', 'data-size', 'data-unix', 'data-ext-name', 'data-ext-idx', 'colspan', 'rowspan', 'title'] }) : escapeHtml(rawContentHtml);

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
            return `<details class="wiki-fold border rounded mb-3"${block.bgAttr}${block.colorAttr}>` +
                `<summary class="fw-bold p-2 wiki-fold-summary">${block.summaryText}</summary>` +
                `<div class="wiki-fold-content p-3 border-top">${block.contentHtml}</div>` +
                `</details>`;
        });
        // 익스텐션 플레이스홀더를 div 태그로 변환 (DOMPurify 전에)
        rawHtml = rawHtml.replace(/(?:<p>)?WIKIEXTPH_([a-zA-Z0-9]+)_(\d+)_XEND(?:<\/p>)?/g, (m, extName, idx) => {
            return `<div class="wiki-ext wiki-ext-${escapeHtml(extName)}" data-ext-name="${escapeHtml(extName)}" data-ext-idx="${escapeHtml(idx)}"></div>`;
        });

        let html = (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(rawHtml, { ADD_TAGS: ['i', 'span', 'details', 'summary', 'div', 'canvas'], ADD_ATTR: ['class', 'style', 'data-bg', 'data-color', 'data-size', 'data-unix', 'data-ext-name', 'data-ext-idx', 'colspan', 'rowspan', 'title'] }) : escapeHtml(rawHtml);

        if (options.showCategory && slug) {
            const decodedSlug = decodeURIComponent(slug);
            if (decodedSlug.startsWith('카테고리:')) {
                const categoryName = decodedSlug.replace(/^카테고리:/, '');
                const listHtml = await fetchCategoryList(categoryName);
                if (listHtml) {
                    html += (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(listHtml, { ADD_TAGS: ['i', 'span'], ADD_ATTR: ['class', 'title'] }) : escapeHtml(listHtml);
                }
            }
        }

        // 인라인 레이아웃 토큰 처리 ({badge:}, {tag:}, {stat:}, {hr})
        html = _processInlineLayoutTokens(html);

        // 타임스탬프 문법 처리
        html = _processTimestampsInHtml(html);

        containerEl.innerHTML = html;

        // 테이블 색상 적용
        containerEl.querySelectorAll('td, th').forEach(cell => {
            let walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null, false);
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

            // {^} 병합이 thead/tbody 경계를 넘는 경우 rowspan이 작동하지 않으므로,
            // thead 행을 tbody로 이동하고 th를 td로 변환
            const thead = table.querySelector(':scope > thead');
            const tbody = table.querySelector(':scope > tbody');
            if (thead && tbody) {
                const hasVerticalMerge = Array.from(tbody.querySelectorAll('td, th')).some(cell => cell.textContent.trim().match(/^\{\^\}$/));
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
            const markers = grid.map(row => row.map(cell => {
                const text = cell.textContent.trim();
                const m = text.match(/^\{(><|[<>^])\}$/);
                return m ? m[1] : null;
            }));

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
                            iframe.setAttribute('height', (type === 'track' || type === 'episode') ? '152' : '352');
                            iframe.setAttribute('frameborder', '0');
                            iframe.setAttribute('allow', 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture');
                            iframe.setAttribute('loading', 'lazy');
                            iframe.style.borderRadius = '12px';

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
                    let listId = url.searchParams.get('list');
                    let start = url.searchParams.get('t');

                    if (url.hostname.includes('youtu.be')) {
                        videoId = url.pathname.slice(1);
                    } else if (url.pathname === '/watch') {
                        videoId = url.searchParams.get('v');
                    } else if (url.pathname.startsWith('/shorts/')) {
                        videoId = url.pathname.split('/')[2];
                    } else if (url.pathname.startsWith('/live/')) {
                        videoId = url.pathname.split('/')[2];
                    } else if (url.pathname === '/playlist' && listId) {
                        // Playlist only URL
                        const iframeWrapper = document.createElement('div');
                        iframeWrapper.className = 'ratio ratio-16x9 my-3';
                        iframeWrapper.style.maxWidth = '100%';
                        const ytIframe = document.createElement('iframe');
                        ytIframe.setAttribute('src', `https://www.youtube.com/embed/videoseries?list=${encodeURIComponent(listId)}`);
                        ytIframe.setAttribute('title', 'YouTube playlist player');
                        ytIframe.setAttribute('frameborder', '0');
                        ytIframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture');
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
                        const query = queryParams.length > 0 ? '?' + queryParams.join('&') : '';

                        const iframeWrapper = document.createElement('div');
                        iframeWrapper.className = 'ratio ratio-16x9 my-3';
                        iframeWrapper.style.maxWidth = '100%';
                        const ytIframe = document.createElement('iframe');
                        ytIframe.setAttribute('src', `https://www.youtube.com/embed/${encodeURIComponent(videoId)}${query}`);
                        ytIframe.setAttribute('title', 'YouTube video player');
                        ytIframe.setAttribute('frameborder', '0');
                        ytIframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture');
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
                return new bootstrap.Popover(popoverTriggerEl, { html: false });
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
            link.href = `/w/${encodeURIComponent('이미지:' + filename)}`;
            link.className = 'wiki-image-link';
            link.setAttribute('aria-label', `이미지 문서 보기: ${filename}`);
            img.parentNode.insertBefore(link, img);
            link.appendChild(img);
        });

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
                codeFont.href = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Nanum+Gothic+Coding:wght@400;700&display=swap';
                document.head.appendChild(codeFont);
            }

            if (typeof window.Prism === 'undefined') {
                if (!document.getElementById('prism-core-script')) {
                    const prismCore = document.createElement('script');
                    prismCore.id = 'prism-core-script';
                    prismCore.src = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-core.min.js';
                    prismCore.onload = () => {
                        const prismAutoloader = document.createElement('script');
                        prismAutoloader.id = 'prism-autoloader-script';
                        prismAutoloader.src = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/plugins/autoloader/prism-autoloader.min.js';
                        prismAutoloader.onload = () => {
                            Prism.plugins.autoloader.languages_path = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/';
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

        // 헤딩 번호 삽입 (항상 실행)
        numberHeadings(containerEl);

        // 각주 섹션 헤딩(<h4>각주</h4>)에는 문단 번호 prefix 를 부여하지 않는다.
        containerEl.querySelectorAll('.wiki-footnotes .wiki-heading-num').forEach(el => el.remove());

        if (options.tocContainerId && options.tocNavId) {
            generateTOC(containerEl, options.tocContainerId, options.tocNavId);
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
            rawContent: content
        });

        // :::grid 레이아웃 균형 조정 (줄바꿈시 위아래 카드 개수 대칭)
        _balanceWikiGrids(containerEl, containerId);

        // {timer:} 요소 실시간 업데이트
        _initTimers(containerEl, containerId);

        // 익스텐션 렌더링 (Chart.js 등)
        _processExtensions(containerEl);

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
                    headingText: hMatch[2].trim(),
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
                            headingText: prevTrim,
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
    const headingEls = Array.from(containerEl.querySelectorAll('h1, h2, h3, h4'));

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
        const linkBtn = document.createElement('button');
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
            if (linkBtn.nextSibling) {
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

/** 컨테이너 내 모든 익스텐션 요소를 찾아 렌더러 실행 */
function _processExtensions(containerEl) {
    const extElements = containerEl.querySelectorAll('.wiki-ext[data-ext-name]');
    if (extElements.length === 0) return;

    extElements.forEach(el => {
        const extName = el.getAttribute('data-ext-name');
        const extIdx = parseInt(el.getAttribute('data-ext-idx'), 10);
        const extData = (typeof _wikiExtensionData !== 'undefined') ? _wikiExtensionData[extIdx] : null;

        if (!extData) {
            el.innerHTML = '<div class="alert alert-warning">⚠️ 익스텐션 데이터를 찾을 수 없습니다.</div>';
            return;
        }

        const renderer = window._extensionRenderers[extName];
        if (renderer) {
            renderer(el, extData);
        } else {
            el.innerHTML = `<div class="alert alert-warning">⚠️ 알 수 없는 익스텐션: ${escapeHtml(extName)}</div>`;
        }
    });
}

