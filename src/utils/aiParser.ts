import type { D1Database } from '@cloudflare/workers-types';
import { normalizeSlug } from './slug';

const MAX_TEMPLATE_DEPTH = 3;

interface TemplateCall {
    name: string;
    /**
     * 이름이 있는 인자(`key=value`)와 위치 인자(`value`) 를 통합해 저장한다.
     * 위치 인자는 `'1'`, `'2'`, ... 문자열 키로 저장되므로 호출자가 `1=value` 형태로
     * 위치 인자에 이름을 명시적으로 지정해도 `{{{1}}}` 로 조회된다.
     * 같은 키가 반복되면 뒤쪽 인자가 앞쪽을 덮어쓴다 (MediaWiki 와 동일).
     */
    args: Record<string, string>;
}

/**
 * 최상위(depth=0) 파이프(|)만 기준으로 raw를 분리합니다.
 * 다음 위키 문법 내부의 '|'는 분리하지 않습니다:
 *   - [[링크|레이블]]          이중 대괄호
 *   - {{틀|인자}}              이중 중괄호
 *   - {{{파라미터|기본값}}}    삼중 중괄호 (파라미터 참조)
 *   - {button:text|url}, {stat:value|label} 등 단일 중괄호 토큰
 */
function splitPipeTopLevel(raw: string): string[] {
    const parts: string[] = [];
    let depth = 0;       // {{...}} / [[...]] / {{{...}}} 합산 깊이
    let singleBrace = 0; // {...} 단일 중괄호 토큰 깊이
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
 * part 내부에서 named-arg 구분자로 쓸 첫 번째 `=` 위치를 반환합니다.
 * `{button:text|url?k=v}`, `{{nested|k=v}}`, `[[link|k=v]]` 등 중첩 토큰 내부의
 * `=` 는 무시합니다. 없으면 -1. splitPipeTopLevel 과 동일한 깊이 규칙을 사용합니다.
 */
function findTopLevelEquals(part: string): number {
    let depth = 0;
    let singleBrace = 0;
    let i = 0;
    while (i < part.length) {
        const ch = part[i];
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
        if (ch === '=' && depth === 0 && singleBrace === 0 && i > 0) return i;
        i++;
    }
    return -1;
}

/**
 * {{틀이름|값1|key=값2}} 형태의 호출 내부 텍스트(틀이름 포함)를 파싱합니다.
 * 첫 토큰은 틀 이름, 이후 토큰은 좌→우 순으로:
 *   - 최상위 `=` 가 있으면 `key=value` 이름 인자로 저장
 *     (단일 중괄호 `{...}`, 중첩 `{{...}}`, `[[...]]` 내부의 `=` 는 무시)
 *   - 없으면 현재 위치 카운터(1부터 시작)를 키로 하는 이름 인자로 저장
 * 같은 키가 반복되면 나중 값이 이전 값을 덮어쓴다. 따라서 호출자가 `1=value` 형태로
 * 명시적 위치 인자를 넘겨도 `{{{1}}}` 참조가 올바르게 해결된다.
 */
function parseTemplateCall(raw: string): TemplateCall {
    const parts = splitPipeTopLevel(raw);
    const name = (parts.shift() || '').trim();
    const args: Record<string, string> = {};
    let posIndex = 1;
    for (const part of parts) {
        const eq = findTopLevelEquals(part);
        if (eq > 0) {
            args[part.substring(0, eq).trim()] = part.substring(eq + 1).trim();
        } else {
            args[String(posIndex)] = part.trim();
            posIndex++;
        }
    }
    return { name, args };
}

interface TemplateCallSpan {
    start: number;
    fullEnd: number;
    raw: string;
}

/**
 * `{{`(contentStart-2 위치) 로 시작하는 틀 호출의 닫는 `}}` 위치를 찾는다.
 * 단일 중괄호 `{...}` 토큰, 삼중 중괄호 `{{{...}}}` 파라미터 참조, 중첩된 `{{...}}` 호출을
 * 모두 올바르게 건너뛰며, 인자 안에 {button:text|url} 같은 `}`-포함 토큰이 있어도
 * 첫 `}` 에서 조기 종료하지 않는다.
 */
function findTemplateCallEnd(text: string, contentStart: number): { contentEnd: number; fullEnd: number } | null {
    let dblBrace = 1;
    let sgl = 0;
    let i = contentStart;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '}') {
            if (sgl > 0) { sgl--; i++; continue; }
            if (text[i + 1] === '}') {
                dblBrace--;
                i += 2;
                if (dblBrace === 0) return { contentEnd: i - 2, fullEnd: i };
                continue;
            }
            i++;
            continue;
        }
        if (ch === '{') {
            if (text[i + 1] === '{') { dblBrace++; i += 2; continue; }
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
function findTemplateCalls(text: string): TemplateCallSpan[] {
    const calls: TemplateCallSpan[] = [];
    let i = 0;
    while (i < text.length - 1) {
        if (text[i] === '{' && text[i + 1] === '{') {
            if (text[i + 2] === '{') {
                const refEnd = findParamRefEnd(text, i + 3);
                i = refEnd ? refEnd.fullEnd : i + 3;
                continue;
            }
            const end = findTemplateCallEnd(text, i + 2);
            if (end) {
                calls.push({ start: i, fullEnd: end.fullEnd, raw: text.substring(i + 2, end.contentEnd) });
                i = end.fullEnd;
                continue;
            }
        }
        i++;
    }
    return calls;
}

/**
 * `{{{` 로 시작하는 파라미터 참조의 닫는 `}}}` 위치를 스택 기반으로 찾는다.
 * 내부 기본값이 {{...}}, {{{...}}}, {...} 등 중첩된 위키 토큰을 포함해도 정확히 매칭한다.
 */
function findParamRefEnd(text: string, contentStart: number): { contentEnd: number; fullEnd: number } | null {
    const stack: Array<'tri' | 'dbl' | 'sgl'> = ['tri'];
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
            // 매칭 없는 `}` — 그냥 스킵해 무한 루프를 피한다.
            i++;
            continue;
        }
        i++;
    }
    return null;
}

interface ParamRefSpan {
    start: number;
    fullEnd: number;
    raw: string;
}

/**
 * text 에서 최상위 `{{{...}}}` 파라미터 참조를 모두 찾는다.
 */
function findParamRefs(text: string): ParamRefSpan[] {
    const refs: ParamRefSpan[] = [];
    let i = 0;
    while (i < text.length - 2) {
        if (text[i] === '{' && text[i + 1] === '{' && text[i + 2] === '{') {
            const end = findParamRefEnd(text, i + 3);
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
 * 틀 본문의 {{{이름}}} / {{{1}}} / {{{이름|기본값}}} 파라미터 참조를 주어진 인자로 치환합니다.
 * - 인자로 전달된 값은 그대로(리터럴) 삽입한다.
 * - 기본값에 포함된 `{{{...}}}` 참조는 동일 args 로 재귀적으로 치환된다.
 *   (예: `{{{reason|{{{1|}}}}}}` 처럼 이름 인자가 없을 때 위치 인자를 폴백으로 쓰는 관용 패턴 지원)
 * - 기본값에 {{fallback}}, {button:text|url} 같은 중괄호 포함 위키 토큰이 있어도 보존된다.
 * @param depth 재귀 깊이 (기본값의 기본값 중첩 방어용 안전장치)
 */
function substituteParams(templateContent: string, args: Record<string, string>, depth: number = 0): string {
    if (depth > 10) return templateContent;

    const refs = findParamRefs(templateContent);
    if (refs.length === 0) return templateContent;

    let result = '';
    let cursor = 0;
    for (const ref of refs) {
        result += templateContent.substring(cursor, ref.start);

        const parts = splitPipeTopLevel(ref.raw);
        const key = (parts.shift() || '').trim();
        // 첫 `|` 뒤는 기본값. 2번째 이후의 `|` 는 기본값 안에 그대로 포함.
        const def = parts.length > 0 ? parts.join('|') : undefined;

        const value = Object.prototype.hasOwnProperty.call(args, key) ? args[key] : undefined;

        if (value !== undefined) {
            result += value;
        } else if (def !== undefined) {
            // 기본값은 재귀적으로 파라미터 치환하여 중첩 폴백 패턴을 해소.
            result += substituteParams(def, args, depth + 1);
        }
        // 아무것도 없으면 빈 문자열

        cursor = ref.fullEnd;
    }
    result += templateContent.substring(cursor);
    return result;
}

/**
 * 텍스트에서 AI 처리에 방해되는 위키 전용 문법을 제거/변환합니다.
 * - [[문서간 링크]]는 변환하지 않고 그대로 유지합니다.
 * - 코드블럭(```) 및 인라인 코드(`) 내부는 문법 처리 없이 그대로 반환합니다.
 * @param content 원본 위키 마크다운
 * @param db 데이터베이스 인스턴스 (틀 트랜스클루전에 사용)
 * @param depth 현재 트랜스클루전 깊이 (무한 루프 방지)
 */
export async function renderForAI(content: string, db: D1Database, depth = 0, currentSlug?: string): Promise<string> {
    if (!content) return '';

    let processed = content;
    const placeholders = new Map<string, string>();
    let placeholderIndex = 0;

    // 코드블럭/인라인 코드 보호: 내부 내용이 위키 문법 처리되지 않도록 플레이스홀더로 치환
    // 1) 펜스 코드블럭 (``` ... ```) 먼저 처리 (멀티라인 포함)
    processed = processed.replace(/```[\s\S]*?```/g, (match) => {
        const key = `\x00FENCED_CODE_${placeholderIndex++}\x00`;
        placeholders.set(key, match);
        return key;
    });

    // 2) 인라인 코드 (`...`)
    processed = processed.replace(/`[^`\n]+`/g, (match) => {
        const key = `\x00INLINE_CODE_${placeholderIndex++}\x00`;
        placeholders.set(key, match);
        return key;
    });

    // 3) {{틀 트랜스클루전}} 토큰을 아래 {...} 셀/아이콘 제거 정규식으로부터 보호.
    // 정규식 대신 중괄호 균형 파서로 호출 범위를 찾기 때문에 인자 안에 {stat:v|label}
    // 같은 단일 중괄호 토큰이 있어도 호출 전체가 누락 없이 보호된다.
    {
        const protectCalls = findTemplateCalls(processed);
        if (protectCalls.length > 0) {
            let rebuilt = '';
            let cursor = 0;
            for (const c of protectCalls) {
                rebuilt += processed.substring(cursor, c.start);
                const match = processed.substring(c.start, c.fullEnd);
                const key = `\x00TEMPLATE_${placeholderIndex++}\x00`;
                placeholders.set(key, match);
                rebuilt += key;
                cursor = c.fullEnd;
            }
            rebuilt += processed.substring(cursor);
            processed = rebuilt;
        }
    }

    // 3. {중괄호} 문법 처리
    // {<}, {>}, {^}, {><} 등 표 셀 병합 문법이 포함되어 있으면 안내 문구 추가 후 제거
    if (/\{[<>^]{1,2}\}/.test(processed)) {
        processed = '참고 : 표의 병합된 셀은 빈칸으로 표시됩니다\n\n' + processed;
    }
    processed = processed.replace(/\{[<>^]{1,2}\}/g, '');

    // ::: 블록 디렉티브: 마커 라인만 제거하고 내부 콘텐츠는 보존.
    // :::card 제목 → "제목" (한 줄 남김), :::grid/:::row → 줄 삭제, 단독 ::: → 줄 삭제
    // 콜아웃(:::info 등)은 제목이 없어도 타입 라벨을 유지해 AI 컨텍스트에서 의미가 보존되도록 한다.
    const CALLOUT_LABELS: Record<string, string> = {
        info: '정보', tip: '팁', success: '성공',
        warning: '주의', danger: '위험', note: '노트'
    };
    // 컨테이너 블록(tabs/accordion/steps)의 오프너 라인은 제거.
    // 자식 블록(tab/item/step): 제목을 평문으로 보존. step 은 자동 번호 부여.
    const CONTAINER_TYPES = new Set(['tabs', 'accordion', 'steps']);
    let _stepCounter = 0;
    processed = processed.replace(/^:::([a-zA-Z][a-zA-Z0-9_-]*)(?:[ \t]+([^\n]*))?[ \t]*$/gm, (_, type, title) => {
        const t = (title || '')
            .replace(/\{(?:palette|bg|color):[^}]+\}/g, '')
            .replace(/\{(?:align|multiple|layout|status|open|icon)(?::[^}]*)?\}/g, '')
            .trim();
        const calloutLabel = CALLOUT_LABELS[type as string];
        if (calloutLabel) return t ? `${calloutLabel}: ${t}` : `${calloutLabel}:`;
        if (CONTAINER_TYPES.has(type as string)) {
            if (type === 'steps') _stepCounter = 0;
            return '';
        }
        if (type === 'step') {
            _stepCounter++;
            return `${_stepCounter}. ${t || '단계'}`;
        }
        if (type === 'tab' || type === 'item') return t || '';
        return t ? t : '';
    });
    processed = processed.replace(/^:::[ \t]*$/gm, '');

    // 인라인 레이아웃 토큰: 텍스트 내용은 보존 (AI 컨텍스트에 의미 있음)
    processed = processed.replace(/\{badge:([^}|]+)\}/g, (_, t) => `[${t.trim()}]`);
    processed = processed.replace(/\{tag:([^}|]+)\}/g, (_, t) => `[${t.trim()}]`);
    processed = processed.replace(/\{stat:([^}]+)\}/g, (_, c) => {
        const parts = c.split('|').map((s: string) => s.trim());
        return parts.length >= 2 ? `${parts[0]} (${parts[1]})` : parts[0];
    });
    processed = processed.replace(/\{button:([^}]+)\}/g, (_, c) => {
        const parts = c.split('|').map((s: string) => s.trim());
        const text = parts[0] || '';
        const url = parts[1] || '';
        if (text && url) return `[${text}](${url})`;
        return text;
    });
    processed = processed.replace(/\{kbd:([^}]+)\}/g, (_, c) => c.trim());
    processed = processed.replace(/\{progress:([^}]+)\}/g, (_, c) => {
        const parts = c.split('|').map((s: string) => s.trim());
        const valueStr = parts[0] || '';
        const label = parts[1] || '';
        const fracMatch = valueStr.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
        let text = valueStr;
        if (fracMatch) {
            const a = parseFloat(fracMatch[1]);
            const b = parseFloat(fracMatch[2]);
            if (b > 0) {
                const pct = Math.round((a / b) * 100);
                text = `${fracMatch[1]}/${fracMatch[2]} (${pct}%)`;
            }
        } else if (/^\d+(?:\.\d+)?$/.test(valueStr)) {
            text = `${valueStr}%`;
        }
        return label ? `${label}: ${text}` : text;
    });
    processed = processed.replace(/\{hr\}/g, '');

    // {#fff}, {mdi mdi-icon} 등 남은 표 색상/아이콘/기타 싱글 중괄호 토큰 제거 (내용물 포함)
    processed = processed.replace(/\{[^{}]*\}/g, '');

    // [[문서간 링크]]는 그대로 유지 (변환하지 않음)

    // {{...}} 플레이스홀더만 먼저 복원 (코드블럭/인라인코드는 마지막 단계에서 복원)
    for (const [key, value] of Array.from(placeholders.entries())) {
        if (key.includes('TEMPLATE_')) {
            processed = processed.split(key).join(value);
            placeholders.delete(key);
        }
    }

    // 4. {{틀 트랜스클루전}} 처리 — expandTemplates 와 공유되는 내부 헬퍼로 위임
    processed = await expandTemplateCallsIn(processed, db, depth, currentSlug, renderForAI);

    // 플레이스홀더 복원 (코드블럭/인라인 코드 내용 원상복구)
    for (const [key, value] of placeholders) {
        processed = processed.split(key).join(value);
    }

    return processed;
}

/**
 * 이미 코드블럭/인라인 코드가 보호된 텍스트에 대해 `{{...}}` 틀 호출을 재귀적으로 확장합니다.
 * `recurse` 는 템플릿 본문(파라미터 치환 후)을 한 단계 더 처리할 함수로,
 * `renderForAI` 는 자기 자신을, `expandTemplates` 는 자기 자신을 전달합니다.
 * 이로써 두 호출 경로에서 "배치 조회 + 자기참조 방지 + 재조립" 로직이 단일 구현을 공유합니다.
 */
async function expandTemplateCallsIn(
    processed: string,
    db: D1Database,
    depth: number,
    currentSlug: string | undefined,
    recurse: (content: string, db: D1Database, depth: number, currentSlug?: string) => Promise<string>
): Promise<string> {
    if (depth >= MAX_TEMPLATE_DEPTH) {
        // 최대 깊이를 초과하면 틀 호출 자체를 제거 (파라미터 참조 {{{...}}} 는 보존)
        const overflowCalls = findTemplateCalls(processed);
        if (overflowCalls.length === 0) return processed;
        let rebuilt = '';
        let cursor = 0;
        for (const c of overflowCalls) {
            rebuilt += processed.substring(cursor, c.start);
            cursor = c.fullEnd;
        }
        rebuilt += processed.substring(cursor);
        return rebuilt;
    }

    // 중괄호 균형 파서로 호출 위치를 찾는다. 인자 내부의 {button:a|b} 같은
    // `}` 포함 토큰이나 중첩된 {{...}} 호출이 있어도 전체 호출을 정확히 잡아낸다.
    const templateCalls = findTemplateCalls(processed);
    if (templateCalls.length === 0) return processed;

    // 1) 슬러그 목록 추출 (중복 제거) + 매치별 호출 인자 보존
    const slugMap = new Map<string, string>();
    const selfRefSlugs = new Set<string>();
    const matchCalls: { normalized: string; call: TemplateCall; start: number; fullEnd: number }[] = [];
    for (const tc of templateCalls) {
        const call = parseTemplateCall(tc.raw.trim());
        let targetSlug = call.name;
        if (!targetSlug.startsWith('틀:') && !targetSlug.startsWith('template:') && !targetSlug.startsWith('템플릿:')) {
            targetSlug = '틀:' + targetSlug;
        }
        const normalized = normalizeSlug(targetSlug);
        matchCalls.push({ normalized, call, start: tc.start, fullEnd: tc.fullEnd });
        if (currentSlug && normalized === normalizeSlug(currentSlug)) {
            selfRefSlugs.add(normalized);
            continue;
        }
        if (!slugMap.has(normalized)) {
            slugMap.set(normalized, targetSlug);
        }
    }

    // 2) slug별 단일 SELECT 문을 준비한 뒤 db.batch로 여러 statement를 함께 실행해 틀 내용을 조회
    // D1은 단일 prepare에서 가변 길이 IN 절 바인딩이 제한적이므로 이 방식을 사용
    const slugList = Array.from(slugMap.keys());
    const templateContents = new Map<string, string>();
    const batchStatements = slugList.map(slug =>
        db.prepare('SELECT slug, content FROM pages WHERE slug = ? AND deleted_at IS NULL').bind(slug)
    );
    try {
        const batchResults = await db.batch<{ slug: string; content: string }>(batchStatements);
        for (const result of batchResults) {
            if (result.results && result.results.length > 0) {
                const row = result.results[0];
                templateContents.set(row.slug, row.content);
            }
        }
    } catch {
        // 배치 실패 시 빈 결과로 처리
    }

    // 3) 매치별로 파라미터 치환 후 재귀 처리 (인자가 다르면 결과도 다르므로 매치별 처리)
    const expandedByIndex = new Array<string>(matchCalls.length);
    const expandPromises: Promise<void>[] = [];
    for (let i = 0; i < matchCalls.length; i++) {
        const { normalized, call } = matchCalls[i];
        if (selfRefSlugs.has(normalized)) {
            expandedByIndex[i] = '';
            continue;
        }
        const tplContent = templateContents.get(normalized);
        if (!tplContent) {
            expandedByIndex[i] = '';
            continue;
        }
        const substituted = substituteParams(tplContent, call.args);
        expandPromises.push(
            recurse(substituted, db, depth + 1, normalized).then(expanded => {
                expandedByIndex[i] = expanded;
            })
        );
    }
    await Promise.all(expandPromises);

    // 4) 호출 위치(start, fullEnd) 를 이용해 세그먼트 단위로 교체.
    // findTemplateCalls 가 이미 왼쪽→오른쪽 순서로 비겹침 스팬을 반환하므로
    // 역순 처리 없이 한 번에 재조립 가능.
    let rebuilt = '';
    let cursor = 0;
    for (let i = 0; i < matchCalls.length; i++) {
        const mc = matchCalls[i];
        rebuilt += processed.substring(cursor, mc.start);
        rebuilt += expandedByIndex[i] || '';
        cursor = mc.fullEnd;
    }
    rebuilt += processed.substring(cursor);
    return rebuilt;
}

/**
 * 템플릿 트랜스클루전({{틀이름|인자}})만 재귀적으로 확장하고, 그 외 위키 문법은 원본 그대로 보존합니다.
 * get_toc/read_section 처럼 헤딩 번호를 일관되게 유지해야 하는 경로에서 사용합니다.
 * 코드블럭과 인라인 코드 내부의 {{...}} 는 확장하지 않습니다.
 */
export async function expandTemplates(content: string, db: D1Database, depth = 0, currentSlug?: string): Promise<string> {
    if (!content) return '';

    let processed = content;
    const placeholders = new Map<string, string>();
    let placeholderIndex = 0;

    processed = processed.replace(/```[\s\S]*?```/g, (match) => {
        const key = `\x00FENCED_CODE_${placeholderIndex++}\x00`;
        placeholders.set(key, match);
        return key;
    });
    processed = processed.replace(/`[^`\n]+`/g, (match) => {
        const key = `\x00INLINE_CODE_${placeholderIndex++}\x00`;
        placeholders.set(key, match);
        return key;
    });

    // renderForAI 와 동일한 내부 헬퍼를 공유하되, 재귀 시 자기 자신(expandTemplates)을 전달해
    // 위키 문법 stripping 없이 템플릿 확장만 수행한다.
    processed = await expandTemplateCallsIn(processed, db, depth, currentSlug, expandTemplates);

    for (const [key, value] of placeholders) {
        processed = processed.split(key).join(value);
    }
    return processed;
}

/**
 * 헤딩 레벨별 카운터를 진행시킵니다.
 * - 초기화되지 않은 부모 레벨 카운터(0)는 1로 끌어올려 "0.1", "1.0.1" 같은
 *   0 접두 번호가 생성되지 않도록 합니다 (예: 문서가 ##부터 시작하거나 레벨이 건너뛰는 경우).
 * - 현재 레벨 카운터를 증가시킨 뒤, 더 깊은 레벨의 카운터는 리셋합니다.
 */
function advanceCounters(counters: number[], level: number): void {
    for (let i = 0; i < level - 1; i++) {
        if (counters[i] === 0) counters[i] = 1;
    }
    counters[level - 1]++;
    for (let i = level; i < counters.length; i++) counters[i] = 0;
}

/**
 * 문서에서 헤딩(#) 기반으로 목차만 추출합니다.
 * 이름 중복 시에도 구분 가능하도록 계층적 번호를 붙입니다.
 * 예: "1. 개요", "1.1 상세", "1.1.1 세부", "2. 다음 장"
 * 첫 헤딩 이전에 본문 텍스트가 있으면 "0. 도입부" 항목을 맨 앞에 추가합니다.
 */
export function extractTOC(content: string): string {
    const lines = content.split('\n');
    const toc: string[] = [];
    const counters = [0, 0, 0, 0, 0, 0]; // 레벨 1-6

    let inCodeBlock = false;
    let firstHeadingSeen = false;
    let hasPreamble = false;

    for (const line of lines) {
        const isFence = line.trim().startsWith('```');
        if (isFence) {
            // 코드 펜스 라인 자체도 첫 헤딩 이전이면 도입부 텍스트로 인정한다.
            if (!firstHeadingSeen) hasPreamble = true;
            inCodeBlock = !inCodeBlock;
            continue;
        }

        if (inCodeBlock) {
            if (!firstHeadingSeen && line.trim() !== '') hasPreamble = true;
            continue;
        }

        const match = line.match(/^(#{1,6})\s+(.*)$/);
        if (match) {
            firstHeadingSeen = true;
            const level = match[1].length;
            advanceCounters(counters, level);

            const parts = counters.slice(0, level).map(n => String(n));
            const number = level === 1 ? `${parts[0]}.` : parts.join('.');
            toc.push(`${number} ${match[2].trim()}`);
        } else if (!firstHeadingSeen && line.trim() !== '') {
            hasPreamble = true;
        }
    }

    if (hasPreamble) toc.unshift('0. 도입부');

    return toc.join('\n');
}

/**
 * 문서에서 특정 목차의 내용만 추출합니다.
 * extractTOC가 반환하는 계층적 번호(예: "1", "1.1", "1.1.1")로 지정합니다.
 * 입력은 선행/후행 공백, 말미의 점을 허용합니다 ("1." == "1").
 * @param content 원본 마크다운
 * @param sectionNumber 찾을 목차 번호
 */
export function extractSection(content: string, sectionNumber: string): string {
    const lines = content.split('\n');
    const counters = [0, 0, 0, 0, 0, 0];
    let inSection = false;
    let sectionLevel = 0;
    const result: string[] = [];
    let inCodeBlock = false;

    // 입력 정규화: 공백 제거, 말미의 '.' 제거
    const target = sectionNumber.trim().replace(/\.+$/, '');

    // "0" 은 첫 헤딩 이전 도입부를 가리킨다. 첫 헤딩을 만나기 전까지의 모든 라인을 그대로 반환한다.
    if (target === '0') {
        const intro: string[] = [];
        let inFence = false;
        for (const line of lines) {
            if (line.trim().startsWith('```')) {
                inFence = !inFence;
                intro.push(line);
                continue;
            }
            if (!inFence && /^#{1,6}\s+/.test(line)) break;
            intro.push(line);
        }
        // 후행 빈 줄은 정리한다.
        while (intro.length && intro[intro.length - 1].trim() === '') intro.pop();
        return intro.join('\n');
    }

    for (const line of lines) {
        if (line.trim().startsWith('```')) {
            inCodeBlock = !inCodeBlock;
        }

        if (!inCodeBlock) {
            const match = line.match(/^(#{1,6})\s+(.*)$/);
            if (match) {
                const level = match[1].length;
                advanceCounters(counters, level);

                const currentNumber = counters.slice(0, level).map(n => String(n)).join('.');

                if (inSection) {
                    if (level <= sectionLevel) {
                        break;
                    }
                } else if (currentNumber === target) {
                    inSection = true;
                    sectionLevel = level;
                    result.push(line);
                    continue;
                }
            }
        }

        if (inSection) {
            result.push(line);
        }
    }

    return result.join('\n');
}

/**
 * 원본 마크다운에서 지정한 섹션을 새 본문으로 교체한 결과를 반환합니다.
 * 섹션 번호는 트랜스클루전을 펼치지 않은 원본 헤딩 기준이므로,
 * 호출자는 같은 raw 본문에서 산출한 번호를 넘겨야 합니다 (get_toc raw=true 와 일치).
 *
 * 동작:
 *   - 번호 "0" (도입부): 첫 헤딩 이전까지의 라인을 newSectionContent 로 치환.
 *   - 일반 번호: 해당 헤딩부터 같은 레벨 이상의 헤딩이 다시 나오기 전까지를 치환.
 *   - 펜스 코드블럭(```) 내부의 # 는 헤딩으로 간주하지 않음.
 *   - 섹션을 찾지 못하면 null 반환 — 호출자가 명시적 오류를 내릴 수 있도록.
 */
export function replaceSection(
    content: string,
    sectionNumber: string,
    newSectionContent: string
): string | null {
    const lines = content.split('\n');
    const target = sectionNumber.trim().replace(/\.+$/, '');

    // "0" 도입부: 첫 헤딩 이전까지를 치환. 첫 헤딩이 없으면 전체 문서가 도입부.
    if (target === '0') {
        let inFence = false;
        let firstHeadingIdx = -1;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.trim().startsWith('```')) { inFence = !inFence; continue; }
            if (!inFence && /^#{1,6}\s+/.test(line)) {
                firstHeadingIdx = i;
                break;
            }
        }
        const tail = firstHeadingIdx < 0 ? '' : lines.slice(firstHeadingIdx).join('\n');
        const head = newSectionContent.replace(/\r\n?/g, '\n');
        if (!tail) return head;
        // 빈 도입부로 치환하는 경우(intro 제거): tail 만 반환해 불필요한 선행 빈 줄/리비전을
        // 만들지 않는다.
        if (head === '') return tail;
        // 도입부와 첫 헤딩 사이에는 빈 줄을 한 번 보장.
        const sep = head.endsWith('\n') ? '' : '\n';
        return head + sep + tail;
    }

    const counters = [0, 0, 0, 0, 0, 0];
    let inCodeBlock = false;
    let startIdx = -1;
    let endIdx = lines.length;
    let sectionLevel = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('```')) inCodeBlock = !inCodeBlock;
        if (inCodeBlock) continue;
        const match = line.match(/^(#{1,6})\s+(.*)$/);
        if (!match) continue;

        const level = match[1].length;
        advanceCounters(counters, level);
        const currentNumber = counters.slice(0, level).map(n => String(n)).join('.');

        if (startIdx < 0) {
            if (currentNumber === target) {
                startIdx = i;
                sectionLevel = level;
            }
        } else if (level <= sectionLevel) {
            endIdx = i;
            break;
        }
    }

    if (startIdx < 0) return null;

    const before = lines.slice(0, startIdx);
    const after = lines.slice(endIdx);
    const replacement = newSectionContent.replace(/\r\n?/g, '\n').split('\n');

    return [...before, ...replacement, ...after].join('\n');
}

/**
 * 검색어가 등장하는 모든 섹션(헤딩 텍스트)을 문서 원본에서 등장 순서대로 반환합니다.
 * 한 섹션 아래에서 키워드가 여러 번 등장해도 그 헤딩은 한 번만 포함됩니다.
 * 펜스 코드블럭(```) 내부의 # 기호는 헤딩으로 간주하지 않지만, 그 안의 라인이
 * 키워드를 포함하면 직전 헤딩에 포함됩니다.
 * 헤딩이 등장하기 전 도입부에서 매치되면 빈 문자열 ''이 추가됩니다.
 * @param content 문서 전체 원본 마크다운
 * @param query 검색어 (FTS 입력값 그대로). 공백은 \s+ 로 변환되어 줄바꿈 사이 공백도 매치합니다.
 */
export function findSectionsForQuery(content: string, query: string): string[] {
    if (!content || !query) return [];

    const escapedTerms = query.split(/\s+/).filter(Boolean)
        .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (escapedTerms.length === 0) return [];
    // 'g' 플래그로 본문 전체를 한 번에 스캔한다. 라인별 .test() 로는 \s+ 가
    // 줄바꿈을 가로지를 때 매치를 놓치므로(하드랩된 문구) 전체 문자열에 대해 매치한다.
    const regex = new RegExp(escapedTerms.join('\\s+'), 'gi');

    // 라인별로 활성 헤딩과 라인 시작 오프셋을 미리 수집해, 매치 위치를 헤딩에 매핑한다.
    // 헤딩 라인 자체에는 '그 라인에서 정의된 헤딩' 을 활성으로 둬서, 헤딩 텍스트에
    // 키워드가 포함된 경우 한 단계 위 섹션이 아닌 자기 헤딩이 잡히게 한다.
    // 같은 라벨의 헤딩이 여러 번 등장할 수 있으므로 라인 인덱스를 섹션 식별자로 사용한다
    // (-1 은 헤딩 등장 전 도입부).
    const linesMeta: { start: number; headingId: number; headingText: string }[] = [];
    {
        const lines = content.split('\n');
        let pos = 0;
        let inCodeBlock = false;
        let currentHeading = '';
        let currentHeadingId = -1;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const isFence = line.trim().startsWith('```');
            if (!inCodeBlock && !isFence) {
                const m = line.match(/^(#{1,6})\s+(.+)$/);
                if (m) {
                    currentHeading = m[2].trim();
                    currentHeadingId = i;
                }
            }
            linesMeta.push({ start: pos, headingId: currentHeadingId, headingText: currentHeading });
            if (isFence) inCodeBlock = !inCodeBlock;
            pos += line.length + 1; // +1 for '\n'
        }
    }

    // 매치 시작 오프셋이 속한 라인의 메타를 이진 탐색으로 찾는다.
    function lineMetaAt(offset: number) {
        let lo = 0, hi = linesMeta.length - 1, ans = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (linesMeta[mid].start <= offset) { ans = mid; lo = mid + 1; }
            else hi = mid - 1;
        }
        return linesMeta[ans];
    }

    const sections: string[] = [];
    const seenHeadingIds = new Set<number>();
    let m: RegExpExecArray | null;
    while ((m = regex.exec(content)) !== null) {
        const meta = lineMetaAt(m.index);
        if (!seenHeadingIds.has(meta.headingId)) {
            seenHeadingIds.add(meta.headingId);
            sections.push(meta.headingText);
        }
        // 빈 매치 방어: 현재 정규식으로는 일어나지 않지만 lastIndex 정체로 인한 무한 루프 차단.
        if (m.index === regex.lastIndex) regex.lastIndex++;
    }
    return sections;
}
