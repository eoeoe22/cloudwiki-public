/**
 * 위키 트랜스클루전(틀)·익스텐션 호출 토큰 스캐너 — 서버측 역링크/팔레트 인덱싱
 * (`shared/links.ts` extractPageLinks · `blog.ts` extractBlogTemplateLinks · `palettes.ts`
 * extractTemplateSlugsFromContent)과 클라이언트 렌더(`render.ts`)가 공유하는 단일 소스.
 *
 * 순수 문자열 로직(브라우저/Worker 의존 없음)이라 서버·클라이언트 양쪽 tsconfig 에서
 * 컴파일된다. 스택 기반으로 중첩 중괄호(`{...}`/`{{...}}`/`{{{...}}}`)와 여러 줄에 걸친
 * 호출, 백틱 코드 스팬을 올바르게 건너뛴다. 이로써 naive 한 `/\{\{([^}]+?)\}\}/` 가
 * 파라미터 값에 든 `}` (예: 색 팔레트 틀의 `{bg:#fff}{color:#000}`)를 만나 첫 `}` 에서
 * 조기 종료해 멀티라인/중괄호 포함 트랜스클루전의 역링크를 누락하던 버그를 막는다.
 *
 * render.ts 의 `_scanCodeSpan`/`_findParamRefEnd`/`_findTemplateCallEnd`/`_findTemplateCalls`
 * 와 알고리즘이 동일하며(그쪽이 이 모듈을 import 한다) 역링크 인덱스가 실제 렌더 결과와
 * 일치하도록 보장한다.
 */

/** `{{...}}` 호출 한 건의 위치/내부 텍스트 */
export interface TokenSpan {
    /** 토큰 시작 위치 (여는 `{{` 의 첫 `{`) */
    start: number;
    /** 토큰 종료 직후 위치 (닫는 `}}` 다음 인덱스) */
    fullEnd: number;
    /** `{{` 와 `}}` 사이 내부 문자열 */
    raw: string;
}

/** 닫는 중괄호 위치 탐색 결과 */
interface BraceEnd {
    contentEnd: number;
    fullEnd: number;
}

/** 틀/익스텐션 접두사(`틀:`/`template:`/`템플릿:`) 보유 여부 */
export function hasTemplatePrefix(slug: string): boolean {
    return slug.startsWith('틀:') || slug.startsWith('template:') || slug.startsWith('템플릿:');
}

/**
 * text[i] 가 인라인 코드 스팬(`` `...` ``, ``` ``...`` ``` 등 매칭 백틱 런)의 시작이면
 * 닫는 백틱 런 직후의 인덱스를 반환. 아니면 -1.
 *
 * 위키 토큰 파서(`{{...}}`, `[[...]]`, `|`, `=`)가 백틱 코드 스팬 내부를 verbatim 으로
 * 취급하도록 도와준다 — 예: `` {{Foo|`a|b`|c}} `` 에서 가운데 `|` 가 인자 구분자로 잘못
 * 잡히지 않도록 한다. 닫는 백틱 런이 없으면 -1 을 반환해 호출자가 `` ` `` 를 일반 문자로
 * 처리하게 한다.
 */
export function scanCodeSpan(text: string, i: number): number {
    if (text[i] !== '`') return -1;
    // CommonMark: 코드 스팬 오프너는 "선행/후행 백틱이 없는" 백틱 런이다.
    // text[i-1] 이 백틱이면 우리는 더 긴 런의 중간에서 시작하는 셈 — 그 런 전체가
    // 이미 (앞쪽에서 호출된) scanCodeSpan 에 의해 평가되어 짝이 없다고 결론났을
    // 수 있으므로 부분 매칭을 거부해 가짜 스팬으로 `|`/`=`/`{{…}}` 를 가리는
    // 회귀를 막는다. (예: `` `````foo```` `` 의 2번째 백틱부터 4-런 스팬으로 잘못 매칭되는 케이스)
    if (i > 0 && text[i - 1] === '`') return -1;
    // CommonMark: 백슬래시로 이스케이프된 백틱(`` \` ``)은 리터럴 문자라 델리미터가 되지 못한다.
    // 직전 연속 백슬래시 개수가 홀수면 이스케이프된 상태(짝수면 `\\`+`` \` ``... 즉 백슬래시
    // 자체가 이스케이프되어 백틱은 정상 델리미터). 클로저 측은 검사하지 않는다 — CommonMark
    // 사양상 코드 스팬 내부에서는 백슬래시 이스케이프가 작동하지 않아 `` `foo\` `` 의 트레일링
    // `` ` `` 도 정상 클로저로 매칭된다.
    let backslashes = 0;
    let bk = i - 1;
    while (bk >= 0 && text[bk] === '\\') { backslashes++; bk--; }
    if (backslashes % 2 === 1) return -1;
    let n = 1;
    while (i + n < text.length && text[i + n] === '`') n++;
    let j = i + n;
    while (j < text.length) {
        if (text[j] !== '`') { j++; continue; }
        // k 는 j 에서 시작하는 백틱 런의 최대 길이(while 종료 시 다음 문자는 비-백틱).
        // 따라서 k === n 이면 자동으로 "후행 백틱이 없는" 완전한 클로저 런이다.
        let k = 1;
        while (j + k < text.length && text[j + k] === '`') k++;
        if (k === n) return j + k;
        j += k;
    }
    return -1;
}

/**
 * `{{{` 로 시작하는 파라미터 참조의 닫는 `}}}` 위치를 스택 기반으로 찾는다.
 * 기본값이 `{{...}}`, `{{{...}}}`, `{...}` 등 중첩된 위키 토큰을 포함해도 정확히 매칭한다.
 */
export function findParamRefEnd(text: string, contentStart: number): BraceEnd | null {
    const stack: string[] = ['tri']; // 외부 {{{ 는 이미 소비
    let i = contentStart;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '`') {
            const end = scanCodeSpan(text, i);
            if (end > 0) { i = end; continue; }
        }
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
 * `{{`(contentStart-2 위치)로 시작하는 틀 호출의 닫는 `}}` 위치를 찾는다.
 * 단일 중괄호 `{...}` 토큰, 삼중 중괄호 `{{{...}}}` 파라미터 참조, 중첩된 `{{...}}` 호출을
 * 모두 올바르게 건너뛰며, 호출 인자 안에 `{button:text|url}` 같은 `}`-포함 토큰이 있어도
 * 첫 번째 `}` 에서 조기 종료하지 않는다.
 * @returns 성공 시 `{ contentEnd, fullEnd }`, 짝이 없으면 null
 */
export function findTemplateCallEnd(text: string, contentStart: number): BraceEnd | null {
    let dblBrace = 1; // 외부 {{ 는 이미 소비된 상태로 호출됨
    let sgl = 0;      // 단일 중괄호 {...} 깊이
    let i = contentStart;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '`') {
            const end = scanCodeSpan(text, i);
            if (end > 0) { i = end; continue; }
        }
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
 * 최상위 호출로 잘못 인식되지 않는다. 백틱 코드 스팬 내부의 `{{...}}` 도 무시한다.
 */
export function findTemplateCalls(text: string): TokenSpan[] {
    const calls: TokenSpan[] = [];
    let i = 0;
    while (i < text.length - 1) {
        if (text[i] === '`') {
            const end = scanCodeSpan(text, i);
            if (end > 0) { i = end; continue; }
        }
        if (text[i] === '{' && text[i + 1] === '{') {
            if (text[i + 2] === '{') {
                const refEnd = findParamRefEnd(text, i + 3);
                i = refEnd ? refEnd.fullEnd : i + 3;
                continue;
            }
            const end = findTemplateCallEnd(text, i + 2);
            if (end) {
                calls.push({
                    start: i,
                    fullEnd: end.fullEnd,
                    raw: text.substring(i + 2, end.contentEnd),
                });
                i = end.fullEnd;
                continue;
            }
        }
        i++;
    }
    return calls;
}

/** 트랜스클루전/익스텐션 호출 대상 */
export interface TransclusionTarget {
    /** 정규화된 대상 slug — 틀이면 `틀:` 접두사 부착, 익스텐션이면 원문 그대로 */
    slug: string;
    type: 'template' | 'extension';
}

/**
 * content 에서 트랜스클루전(틀) 및 익스텐션 호출 대상을 중복 없이 추출한다.
 * 이름은 각 호출 raw 의 첫 토큰(`|` 인자 이전, `#` 섹션 앵커 제거)이다.
 *   - 콜론 포함 + 틀 접두사 아님(`freq:foo` 등) → 익스텐션(`type:'extension'`, slug 원문)
 *   - 그 외 → 틀(`type:'template'`, 미접두 시 `틀:` 자동 부착)
 *
 * `shared/links.ts` extractPageLinks / `blog.ts` extractBlogTemplateLinks / `palettes.ts`
 * extractTemplateSlugsFromContent 의 template/extension 분기가 공유하는 단일 소스.
 * 호출 측은 코드블록을 미리 제거해 넘겨도 되고(이중 보호), 넘기지 않아도 scanCodeSpan
 * 이 백틱 코드 스팬을 건너뛴다.
 */
export function extractTransclusionTargets(content: string): TransclusionTarget[] {
    if (!content || content.indexOf('{{') < 0) return [];
    const out: TransclusionTarget[] = [];
    const seen = new Set<string>();
    collectTransclusionTargets(content, out, seen);
    return out;
}

/**
 * extractTransclusionTargets 의 내부 수집기 — 파서 함수(`{{#if|#ifeq|#switch: ...}}`,
 * `src/client/render.ts` 의 `_expandParserFunctions`) 의 분기/조건 인자 안에 든 중첩
 * 트랜스클루전 타깃까지 재귀로 인덱싱하기 위해 분리했다.
 *
 * 파서 함수 호출(raw 가 `#` 로 시작)은 함수 이름 자체가 링크 타깃이 아니므로 타깃으로
 * 내보내지 않고, 대신 raw 내부를 재귀 스캔해 분기/조건에 든 실제 `{{틀}}`·`{{익스텐션}}`
 * 호출을 끌어온다. 선택되지 않을 분기도 함께 인덱싱하는 보수적 over-approximation 이며,
 * 역링크/팔레트 그래프는 과대 추정이 안전하다(실제 렌더 시 빠지는 분기가 있어도 무방).
 */
function collectTransclusionTargets(content: string, out: TransclusionTarget[], seen: Set<string>): void {
    for (const call of findTemplateCalls(content)) {
        const rawTrim = call.raw.trim();
        // 파서 함수(#if/#ifeq/#switch …): 이름은 타깃이 아니다. 분기/조건 내부만 재귀 추출.
        if (rawTrim.charCodeAt(0) === 35 /* '#' */) {
            collectTransclusionTargets(call.raw, out, seen);
            continue;
        }
        const nameBeforeArgs = rawTrim.split('|')[0].trim();
        // 섹션 트랜스클루전 {{문서#섹션}} 은 렌더러(render.ts _parseSectionRef)가 문서
        // 슬러그를 그대로(틀: 미부착, 명시 접두는 유지) fetch 한다. 의존성 인덱스도 같은
        // 슬러그를 대상으로 기록해야 역링크·이동 재작성·캐시 무효화가 원본 문서 편집을
        // 반영한다(그러지 않으면 틀:문서 로 잘못 기록돼 섹션 포함 페이지가 stale 로 남는다).
        const hashIdx = nameBeforeArgs.indexOf('#');
        if (hashIdx > 0) {
            const docPart = nameBeforeArgs.slice(0, hashIdx).trim();
            const anchor = nameBeforeArgs.slice(hashIdx + 1).trim();
            const dColon = docPart.indexOf(':');
            const docIsExtension = dColon > 0 && !hasTemplatePrefix(docPart);
            if (docPart && anchor && !docIsExtension) {
                const key = 't:' + docPart;
                if (!seen.has(key)) {
                    seen.add(key);
                    out.push({ slug: docPart, type: 'template' });
                }
                continue;
            }
        }
        // '|' 앞부분만 slug 로 사용 (파라미터/인자 무시), '#' 앞부분만 slug 로 사용 (섹션 앵커 무시).
        // 슬러그 자체는 '#'/'|' 을 포함할 수 없으므로(이동 API 입력검증 참고) 항상 안전하게 제거.
        const slug = nameBeforeArgs.split('#')[0].trim();
        if (!slug) continue;
        // 익스텐션 패턴: 첫 번째 ':' 앞이 익스텐션 이름 (틀/template/템플릿 접두사가 아닌 경우)
        const colonIdx = slug.indexOf(':');
        if (colonIdx > 0 && !hasTemplatePrefix(slug)) {
            const key = 'e:' + slug;
            if (!seen.has(key)) {
                seen.add(key);
                out.push({ slug, type: 'extension' });
            }
        } else {
            const normalized = hasTemplatePrefix(slug) ? slug : '틀:' + slug;
            const key = 't:' + normalized;
            if (!seen.has(key)) {
                seen.add(key);
                out.push({ slug: normalized, type: 'template' });
            }
        }
    }
}
