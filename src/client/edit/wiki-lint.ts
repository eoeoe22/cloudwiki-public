/**
 * 위키 문법 린트 (제안 G-4) — **순수 함수** 계층.
 *
 * 에디터 거터에 비차단(non-blocking) 경고를 띄우기 위한 진단만 계산한다. 렌더는
 * 지금처럼 관대하게 유지하고(잘못 써도 최대한 그려냄), 이 모듈은 "아마 실수일" 지점만
 * 짚어 준다. CodeMirror/DOM 의존이 전혀 없어 단위 검사가 가능하다(CM 배선은 main.ts).
 *
 * 검사 규칙(제안 명세 4종 + 추가 1종):
 *   1) 미종료 ::: 블록 — 열렸으나 EOF 까지 닫히지 않은 디렉티브.
 *   2) 미등록 팔레트명 — {palette:NAME} 의 NAME 이 빌트인/커스텀 어디에도 없음.
 *   3) 캔버스 span 합 ≠ 12 — :::canvas 직계 :::area 들이 모두 {span:N} 을 가질 때 합이 12 아님.
 *   4) 중복 {id:} — 같은 {id:이름} 이 문서에서 2회 이상 등장.
 *   5) 줄 시작 제로폭 문자(U+200B/U+FEFF) — 보이지 않는 채로 헤딩(#)/목록 등
 *      줄 시작 문법 인식을 깨뜨린다(IME·붙여넣기 유입; 저장 시 서버가 제거).
 *
 * 코드펜스(``` / ~~~) 내부와 인라인 코드(`...`) 내부의 토큰은 검사에서 제외한다.
 */

export interface WikiLintDiag {
    /** 1-기반 라인 번호 */
    line: number;
    /** 경고 메시지 */
    message: string;
}

// CommonMark 코드펜스 / 디렉티브 정규식 (cm-highlight.ts·render.ts 계약과 동일).
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const COLON_OPEN_RE = /^:::([a-zA-Z][a-zA-Z0-9_-]*)(?:[ \t]+(.*))?[ \t]*$/;
const COLON_CLOSE_RE = /^:::[ \t]*$/;

interface BlockFrame {
    name: string;
    line: number;
    isCanvas: boolean;
    areaCount: number;
    spanSum: number;
    allAreasHaveSpan: boolean;
}

// 주어진 컬럼(idx)이 인라인 코드(백틱 span) 내부인지.
// 토큰 인라인 편집 핀(main.ts)도 코드스팬 내부 토큰을 제외하기 위해 재사용한다.
export function isInInlineCode(lineText: string, idx: number): boolean {
    const re = /`[^`]*`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lineText)) !== null) {
        if (idx >= m.index && idx < m.index + m[0].length) return true;
    }
    return false;
}

/**
 * 위키 문법 진단을 계산한다.
 * @param doc       에디터 전체 텍스트.
 * @param knownPalettes 등록된 팔레트명 집합(빌트인 ∪ 커스텀). 비어 있으면 팔레트 검사 생략.
 */
export function computeWikiLint(doc: string, knownPalettes: Set<string>): WikiLintDiag[] {
    const diags: WikiLintDiag[] = [];
    if (typeof doc !== 'string' || doc.length === 0) return diags;
    const lines = doc.split('\n');

    let fenceChar: string | null = null;
    let fenceLen = 0;
    const stack: BlockFrame[] = [];
    const idOccurrences = new Map<string, number[]>();
    const checkPalettes = knownPalettes && knownPalettes.size > 0;

    for (let i = 0; i < lines.length; i++) {
        const lineNo = i + 1;
        const text = lines[i];

        // ── 줄 시작 제로폭 문자 검사 (코드펜스 밖에서만 — 코드 본문은 사용자 데이터) ──
        if (fenceChar === null && /^[\u200B\uFEFF]/.test(text)) {
            diags.push({ line: lineNo, message: '줄 맨 앞에 보이지 않는 문자(제로폭 공백)가 있습니다 — 헤딩(#)·목록 등 줄 시작 문법이 인식되지 않을 수 있습니다. 저장 시 자동 제거됩니다.' });
        }

        // ── 코드펜스 상태 추적 (펜스 라인/내부는 디렉티브·토큰 검사 제외) ──
        const fm = FENCE_RE.exec(text);
        if (fenceChar === null) {
            if (fm) {
                const seq = fm[1];
                const tail = fm[2];
                const ch = seq[0];
                // 백틱 펜스의 info string 에는 백틱이 올 수 없다(CommonMark).
                if (!(ch === '`' && tail.indexOf('`') !== -1)) {
                    fenceChar = ch;
                    fenceLen = seq.length;
                    continue;
                }
            }
        } else {
            if (fm) {
                const seq = fm[1];
                const ch = seq[0];
                const tail = fm[2];
                if (ch === fenceChar && seq.length >= fenceLen && /^[ \t]*$/.test(tail)) {
                    fenceChar = null;
                    fenceLen = 0;
                }
            }
            continue;
        }

        // ── ::: 디렉티브 (열기/닫기) ──
        const openM = COLON_OPEN_RE.exec(text);
        const closeM = !openM && COLON_CLOSE_RE.test(text);
        if (openM) {
            const name = openM[1];
            const rest = openM[2] || '';
            const parent = stack.length > 0 ? stack[stack.length - 1] : null;
            // 캔버스 직계 area 의 span 집계.
            if (name === 'area' && parent && parent.isCanvas) {
                parent.areaCount++;
                const spanM = rest.match(/\{span:\s*(\d+)\s*\}/);
                if (spanM) parent.spanSum += parseInt(spanM[1], 10);
                else parent.allAreasHaveSpan = false;
            }
            stack.push({
                name,
                line: lineNo,
                isCanvas: name === 'canvas',
                areaCount: 0,
                spanSum: 0,
                allAreasHaveSpan: true,
            });
        } else if (closeM && stack.length > 0) {
            const frame = stack.pop()!;
            // 캔버스는 repeat(12, 1fr) 래핑 그리드다(render.css .wiki-canvas). 즉 area 들이
            // 12칸을 넘으면 다음 행으로 자동 래핑되므로 "합=12" 는 틀린 전제다 — 6+6+6+6=24
            // (2×2), 8+4=12 모두 정상이다. 잘못 채워진 배치(예: 8+5=13 오타로 한 행이 어중간)
            // 만 짚어 주도록, 직계 area 2개 이상이 모두 span 을 명시했는데 합이 12의 배수가
            // 아닐 때만 경고한다(단독 span<12 패널 같은 의도적 부분 폭은 areaCount>=2 로 제외).
            if (frame.isCanvas && frame.areaCount >= 2 && frame.allAreasHaveSpan && frame.spanSum % 12 !== 0) {
                diags.push({ line: frame.line, message: `캔버스 area span 합이 12의 배수가 아닙니다 (현재 ${frame.spanSum} — 행이 꽉 차지 않을 수 있음).` });
            }
        }

        // ── {palette:NAME} 미등록 검사 ──
        if (checkPalettes && text.indexOf('{palette:') !== -1) {
            const palRe = /\{palette:\s*([^}]+?)\s*\}/g;
            let pm: RegExpExecArray | null;
            while ((pm = palRe.exec(text)) !== null) {
                if (isInInlineCode(text, pm.index)) continue;
                const nm = pm[1].trim();
                if (nm && !knownPalettes.has(nm)) {
                    diags.push({ line: lineNo, message: `등록되지 않은 팔레트: "${nm}".` });
                }
            }
        }

        // ── {id:이름} 수집 (중복 검사는 전체 순회 후) ──
        if (text.indexOf('{id:') !== -1) {
            const idRe = /\{id:\s*([a-zA-Z0-9_-]+)\s*\}/g;
            let im: RegExpExecArray | null;
            while ((im = idRe.exec(text)) !== null) {
                if (isInInlineCode(text, im.index)) continue;
                const nm = im[1];
                const arr = idOccurrences.get(nm);
                if (arr) arr.push(lineNo);
                else idOccurrences.set(nm, [lineNo]);
            }
        }
    }

    // ── 미종료 블록 (스택에 남은 프레임) ──
    for (const frame of stack) {
        diags.push({ line: frame.line, message: `블록 ":::${frame.name}" 이(가) 닫히지 않았습니다 (::: 필요).` });
    }

    // ── 중복 {id:} ──
    // occ 에는 같은 줄에 2회 이상 나온 경우 같은 라인 번호가 중복 포함될 수 있으므로,
    // 라인 단위로 dedupe 해 한 줄에 동일 경고가 여러 번 쌓이지 않게 한다(카운트는 총 등장 횟수).
    for (const [nm, occ] of idOccurrences) {
        if (occ.length > 1) {
            for (const ln of new Set(occ)) {
                diags.push({ line: ln, message: `중복된 {id:${nm}} — 문서에서 ${occ.length}회 사용됨.` });
            }
        }
    }

    return diags;
}
