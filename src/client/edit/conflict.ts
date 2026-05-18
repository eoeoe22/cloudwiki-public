/**
 * 편집 충돌 해결 UI (GitHub PR conflict editor 스타일).
 * 기존 public/js/edit-conflict.js 의 ES 모듈 이전.
 *
 * edit.html 만 로드 (블로그 편집은 의도적으로 미포함 — 블로그는 리비전/충돌 관리 없음).
 *
 * 용어:
 *   base   = 사용자가 편집을 시작했을 때의 본문 (originalContent, 클라이언트 보유)
 *   ours   = 내 수정본 (editor.getMarkdown())
 *   theirs = 서버 최신본 (409 응답의 data.content)
 *
 * 자동 병합(diff3) 알고리즘은 도입하지 않는다. 대신 3-way 정보를 활용해
 *  (1) 충돌 마커가 자동 삽입된 병합 초안을 통합 textarea 에 채우고,
 *  (2) 비교 패널에서 "내 vs 서버 / 내 vs base / 서버 vs base" 세 시점의 GitHub
 *      스타일 hunk 테이블을 보여준다.
 *
 * 외부 노출 (브리지):
 *   - window.showConflictModal      ← edit.js (raw) 의 409 응답 핸들러,
 *                                     edit/utils.ts 의 checkDraft 가 호출
 *   - window.renderLocalDiff        ← edit.js 의 diff details 토글 핸들러
 *   - window.startEditingHeartbeat  ← edit.js 의 DOMContentLoaded 부트스트랩
 *   - window.stopEditingHeartbeat   ← 본 모듈 자체가 beforeunload 에 등록
 *   - HTML 인라인 onclick 으로 호출되는 함수 (edit.html 충돌 UI 마크업):
 *     resolveConflict, cancelConflict, jumpToConflict, setDiffMode,
 *     renderDiffView, toggleServerView, toggleServerPreview
 *
 * 외부 의존:
 *   - window.Diff (jsdiff CDN, edit.html 만 로드)
 *   - window.Swal (CDN sweetalert2)
 *   - window.editor / originalContent / pageVersion / slug / isExtensionData /
 *     conflictEditor / serverViewer / scrollToBottom (types.ts 단일 소스)
 *   - window.appConfig.enableConcurrentEditDetection (common.js)
 *   - window.renderWikiContent (render.js — 서버 본문 프리뷰용)
 *   - common.js 의 escapeHtml 글로벌 (sloppy 모드 bare reference) — 본 모듈에서는
 *     utils/html.ts 의 ESM escapeHtml 을 import 해서 정확한 타입으로 사용한다.
 */

import { escapeHtml } from '../utils/html';
import './types';
import type {
    AppConfig,
    ConcurrentEditorsResponse,
    ConflictEditor,
    JsDiffApi,
    JsDiffPart,
    JsDiffPatch,
    ServerViewer,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// 상수 및 상태
// ─────────────────────────────────────────────────────────────────────────────

const CONFLICT_CONTEXT_LINES = 3;

interface ConflictHunk {
    id: number;
    ours: string;
    theirs: string;
    resolved: boolean;
}

interface ConflictState {
    base: string;
    ours: string;
    theirs: string;
    serverVersion: number | string | null;
    diffMode: 'unified' | 'split';
    compareMode: 'mine-vs-server' | 'mine-vs-base' | 'server-vs-base';
    serverPaneMode: 'diff' | 'raw';
    serverPreviewMode: 'raw' | 'preview';
    conflicts: ConflictHunk[];
}

const conflictState: ConflictState = {
    base: '',
    ours: '',
    theirs: '',
    serverVersion: null,
    diffMode: 'unified',
    compareMode: 'mine-vs-server',
    serverPaneMode: 'diff',
    serverPreviewMode: 'raw',
    conflicts: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// 라인 분할 / 결합 헬퍼
// jsdiff 가 생성하는 part.value 는 보통 트레일링 \n 을 포함하므로,
// split('\n') 결과의 마지막 빈 토큰을 제거해 라인 배열로 만든다.
// ─────────────────────────────────────────────────────────────────────────────

function splitLines(text: string): string[] {
    if (!text) return [];
    const arr = text.split('\n');
    if (arr.length > 0 && arr[arr.length - 1] === '') arr.pop();
    return arr;
}

interface BaseHunk {
    baseStart: number;
    baseEnd: number;
    replacement: string[];
}

// jsdiff 결과 → base 라인 범위에 매핑된 hunk 배열
//   baseStart..baseEnd 는 base 라인 인덱스 [0-based, end exclusive]
//   replacement 는 해당 영역을 대체할 modified 측 텍스트(라인 배열)
function extractHunks(base: string, modified: string): BaseHunk[] {
    const Diff: JsDiffApi | undefined = window.Diff;
    if (!Diff || !Diff.diffLines) return [];
    const parts: JsDiffPart[] = Diff.diffLines(base, modified);
    const hunks: BaseHunk[] = [];
    let baseLine = 0;
    let i = 0;
    while (i < parts.length) {
        const p = parts[i];
        if (!p.added && !p.removed) {
            baseLine += splitLines(p.value).length;
            i++;
            continue;
        }
        // 변경 시작 — 인접한 added/removed 들을 한 hunk 로 묶는다(순서 무관).
        let removedLines: string[] = [];
        let addedLines: string[] = [];
        while (i < parts.length && (parts[i].added || parts[i].removed)) {
            if (parts[i].removed) removedLines = removedLines.concat(splitLines(parts[i].value));
            else if (parts[i].added) addedLines = addedLines.concat(splitLines(parts[i].value));
            i++;
        }
        hunks.push({
            baseStart: baseLine,
            baseEnd: baseLine + removedLines.length,
            replacement: addedLines,
        });
        baseLine += removedLines.length;
    }
    return hunks;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3-way 합성: 충돌 마커가 삽입된 병합 초안 생성
// 자동 병합이 아닌 "표기 초안". 겹치는 변경은 충돌 블록으로 감싸 사용자가
// 직접 결정하도록 남긴다.
// ─────────────────────────────────────────────────────────────────────────────

interface ConflictDraft {
    merged: string;
    conflicts: ConflictHunk[];
}

function buildConflictDraft(
    base: string,
    ours: string,
    theirs: string,
    serverVer: number | string | null,
): ConflictDraft {
    const oursHunks = extractHunks(base, ours);
    const theirsHunks = extractHunks(base, theirs);
    const baseLines = splitLines(base);

    const result: string[] = [];
    const conflicts: ConflictHunk[] = [];
    let baseIdx = 0;
    let oI = 0;
    let tI = 0;

    function copyBase(upTo: number): void {
        const end = Math.min(upTo, baseLines.length);
        while (baseIdx < end) {
            result.push(baseLines[baseIdx]);
            baseIdx++;
        }
    }

    function pushConflict(oursLines: string[], theirsLines: string[]): void {
        const id = conflicts.length + 1;
        const verLabel = serverVer != null ? `서버 v${serverVer}` : '서버 최신본';
        result.push(`<<<<<<< 내 수정본 [#${id}]`);
        if (oursLines.length === 0) {
            // 내 쪽이 빈 영역(=내가 삭제) — 빈 줄 한 줄 두는 대신 그대로
        } else {
            for (const ln of oursLines) result.push(ln);
        }
        result.push('=======');
        if (theirsLines.length === 0) {
            // 서버 쪽이 빈 영역(=서버가 삭제)
        } else {
            for (const ln of theirsLines) result.push(ln);
        }
        result.push(`>>>>>>> ${verLabel} [#${id}]`);
        conflicts.push({
            id,
            ours: oursLines.join('\n'),
            theirs: theirsLines.join('\n'),
            resolved: false,
        });
    }

    function arraysEqual(a: string[], b: string[]): boolean {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    while (oI < oursHunks.length || tI < theirsHunks.length || baseIdx < baseLines.length) {
        const oH = oursHunks[oI];
        const tH = theirsHunks[tI];
        const oStart = oH ? oH.baseStart : Infinity;
        const tStart = tH ? tH.baseStart : Infinity;
        const nextStart = Math.min(oStart, tStart);

        if (baseIdx < nextStart) {
            copyBase(nextStart);
            continue;
        }

        // hunk 가 없으면 base 잔여를 흘려보내고 종료
        if (!oH && !tH) {
            copyBase(baseLines.length);
            break;
        }

        // 둘 다 같은 base 영역을 정확히 수정 — 결과 비교
        if (oH && tH && oH.baseStart === tH.baseStart && oH.baseEnd === tH.baseEnd) {
            if (arraysEqual(oH.replacement, tH.replacement)) {
                for (const ln of oH.replacement) result.push(ln);
            } else {
                pushConflict(oH.replacement, tH.replacement);
            }
            baseIdx = oH.baseEnd;
            oI++; tI++;
            continue;
        }

        // 한쪽 hunk 가 다른쪽 hunk 와 겹치는지 검사
        const oOverlapsT = !!(oH && tH && oH.baseStart < tH.baseEnd && tH.baseStart < oH.baseEnd);

        if (oH && (!tH || oH.baseStart < tH.baseStart)) {
            if (oOverlapsT && tH) {
                // 겹치는 영역 — 두 hunk를 한 번에 묶어 충돌로 표기
                const oursReplace = oH.replacement;
                const theirsReplace = tH.replacement;
                const newBaseEnd = Math.max(oH.baseEnd, tH.baseEnd);
                pushConflict(oursReplace, theirsReplace);
                baseIdx = newBaseEnd;
                oI++; tI++;
            } else {
                // 내 쪽만 변경
                for (const ln of oH.replacement) result.push(ln);
                baseIdx = oH.baseEnd;
                oI++;
            }
            continue;
        }

        if (tH) {
            if (oOverlapsT && oH) {
                const oursReplace = oH.replacement;
                const theirsReplace = tH.replacement;
                const newBaseEnd = Math.max(oH.baseEnd, tH.baseEnd);
                pushConflict(oursReplace, theirsReplace);
                baseIdx = newBaseEnd;
                oI++; tI++;
            } else {
                // 서버 쪽만 변경
                for (const ln of tH.replacement) result.push(ln);
                baseIdx = tH.baseEnd;
                tI++;
            }
            continue;
        }

        // 안전망 — 무한 루프 방지
        break;
    }

    // base 끝 잔여
    copyBase(baseLines.length);

    // 원본이 트레일링 \n 으로 끝났다면 결과도 동일하게
    const trailingNewline = (base.endsWith('\n') || ours.endsWith('\n') || theirs.endsWith('\n'));
    return {
        merged: result.join('\n') + (trailingNewline ? '\n' : ''),
        conflicts,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 비교 모드별 source/target 텍스트 산출
// ─────────────────────────────────────────────────────────────────────────────

interface CompareSources {
    left: string;
    right: string;
    leftLabel: string;
    rightLabel: string;
}

function getCompareSources(mode: ConflictState['compareMode']): CompareSources {
    const s = conflictState;
    if (mode === 'mine-vs-base') return { left: s.base, right: s.ours, leftLabel: 'base', rightLabel: '내 수정본' };
    if (mode === 'server-vs-base') return { left: s.base, right: s.theirs, leftLabel: 'base', rightLabel: '서버 최신본' };
    return { left: s.theirs, right: s.ours, leftLabel: '서버', rightLabel: '내 수정본' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 변경 hunk 개수 (요약 칩용)
// ─────────────────────────────────────────────────────────────────────────────

function countChangeHunks(oldStr: string, newStr: string): number {
    if (oldStr === newStr) return 0;
    // 익스텐션 데이터(수 MB 단위 raw 데이터) 는 jsdiff 가 메인 스레드를 점거하므로
    // 정확한 hunk 수 대신 변경 유무만 반환한다.
    if (window.isExtensionData) return 1;
    const Diff = window.Diff;
    if (!Diff || !Diff.structuredPatch) return 0;
    const patch = Diff.structuredPatch('a', 'b', oldStr || '', newStr || '', '', '', { context: 0 });
    return patch.hunks ? patch.hunks.length : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 익스텐션 데이터(대용량 raw) 전용 경량 비교 카드.
// jsdiff LCS 호출을 피하고 라인 수 / 바이트 차이 + 머리 5 줄 미리보기만 보여준다.
// 라인 수는 \n 카운트 1 회 선형 스캔으로 산출되어 5MB 데이터도 수 ms 이내.
// ─────────────────────────────────────────────────────────────────────────────

function _countLines(s: string): number {
    if (!s) return 0;
    let n = 1;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
    if (s.charCodeAt(s.length - 1) === 10) n--;
    return n;
}

function buildExtensionDataDiffCard(oldStr: string, newStr: string): string {
    if (oldStr === newStr) {
        return '<div class="diff-empty">변경된 내용이 없습니다.</div>';
    }
    const oldLines = _countLines(oldStr);
    const newLines = _countLines(newStr);
    const oldKB = (oldStr.length / 1024);
    const newKB = (newStr.length / 1024);
    // 빈 베이스(신규 추가 또는 빈 본문 비교)에서는 비율 계산이 의미가 없으므로 별도 표기.
    let sizeChangeText: string;
    if (oldStr.length === 0 && newStr.length === 0) {
        sizeChangeText = '';
    } else if (oldStr.length === 0) {
        sizeChangeText = '(신규 추가)';
    } else if (newStr.length === 0) {
        sizeChangeText = '(전체 삭제)';
    } else {
        const reductionPct = (1 - newStr.length / oldStr.length) * 100;
        const sign = reductionPct >= 0 ? '−' : '+';
        sizeChangeText = '(' + sign + Math.abs(reductionPct).toFixed(1) + '%)';
    }
    const oldHead = oldStr.split('\n', 5).join('\n');
    const newHead = newStr.split('\n', 5).join('\n');
    return (
        '<div class="ext-diff-summary">' +
        '<div class="ext-diff-summary-line">' +
        '<b>줄 수</b>: ' + oldLines.toLocaleString() + ' → ' + newLines.toLocaleString() +
        ' &nbsp;·&nbsp; <b>크기</b>: ' + oldKB.toFixed(1) + ' KB → ' + newKB.toFixed(1) + ' KB ' +
        sizeChangeText +
        '</div>' +
        '<div class="ext-diff-summary-hint text-muted small mt-1">' +
        '대용량 익스텐션 데이터는 줄 단위 diff 대신 요약만 표시합니다. 자세한 비교는 저장 후 리비전 페이지를 이용해 주세요.' +
        '</div>' +
        '<div class="mt-2"><b>이전 본문(앞 5줄)</b><pre class="diff-removed" style="white-space:pre-wrap;margin:0">' + escapeHtml(oldHead) + '</pre></div>' +
        '<div class="mt-2"><b>현재 본문(앞 5줄)</b><pre class="diff-added" style="white-space:pre-wrap;margin:0">' + escapeHtml(newHead) + '</pre></div>' +
        '</div>'
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff 테이블 빌드
// ─────────────────────────────────────────────────────────────────────────────

function buildDiffTable(oldStr: string, newStr: string, mode: ConflictState['diffMode']): string {
    if (oldStr === newStr) {
        return '<div class="diff-empty">변경된 내용이 없습니다.</div>';
    }
    // 익스텐션 데이터: jsdiff structuredPatch 우회 — 요약 카드로 대체.
    if (window.isExtensionData) {
        return buildExtensionDataDiffCard(oldStr, newStr);
    }
    const Diff = window.Diff;
    if (!Diff || !Diff.structuredPatch) {
        return '<div class="diff-empty">diff 라이브러리를 불러오지 못했습니다.</div>';
    }
    const patch = Diff.structuredPatch('a', 'b', oldStr || '', newStr || '', '', '', { context: CONFLICT_CONTEXT_LINES });
    if (!patch.hunks || patch.hunks.length === 0) {
        return '<div class="diff-empty">변경된 내용이 없습니다.</div>';
    }
    return mode === 'split' ? buildSplitTable(patch) : buildUnifiedTable(patch);
}

function buildUnifiedTable(patch: JsDiffPatch): string {
    const rows: string[] = [];
    patch.hunks.forEach(h => {
        rows.push(
            '<tr class="hunk-header"><td class="diff-gutter"></td><td class="diff-gutter"></td>'
            + `<td class="diff-prefix"></td><td class="diff-line">@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@</td></tr>`
        );
        let oldLn = h.oldStart, newLn = h.newStart;
        h.lines.forEach(line => {
            const ch = line.charAt(0);
            const text = line.substring(1);
            if (ch === '\\') return; // "\ No newline at end of file"
            let type: 'add' | 'del' | 'same';
            let oldCol: number | string;
            let newCol: number | string;
            let prefix: string;
            if (ch === '+') { type = 'add'; oldCol = ''; newCol = newLn++; prefix = '+'; }
            else if (ch === '-') { type = 'del'; oldCol = oldLn++; newCol = ''; prefix = '-'; }
            else { type = 'same'; oldCol = oldLn++; newCol = newLn++; prefix = ' '; }
            rows.push(
                `<tr class="diff-${type}">`
                + `<td class="diff-gutter">${oldCol}</td>`
                + `<td class="diff-gutter">${newCol}</td>`
                + `<td class="diff-prefix">${prefix}</td>`
                + `<td class="diff-line">${escapeHtml(text)}</td>`
                + '</tr>'
            );
        });
    });
    return '<table class="conflict-diff-table mode-unified">' + rows.join('') + '</table>';
}

function buildSplitTable(patch: JsDiffPatch): string {
    const rows: string[] = [];
    patch.hunks.forEach(h => {
        rows.push(
            `<tr class="hunk-header"><td colspan="4" class="diff-line">@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@</td></tr>`
        );
        let oldLn = h.oldStart, newLn = h.newStart;
        let pendingDel: { num: number; text: string }[] = [];
        let pendingAdd: { num: number; text: string }[] = [];
        const flushPending = (): void => {
            const max = Math.max(pendingDel.length, pendingAdd.length);
            for (let i = 0; i < max; i++) {
                const d = pendingDel[i], a = pendingAdd[i];
                rows.push(
                    '<tr>'
                    + `<td class="diff-gutter">${d ? d.num : ''}</td>`
                    + `<td class="diff-line ${d ? 'cell-del' : 'cell-empty'}">${d ? escapeHtml(d.text) : ''}</td>`
                    + `<td class="diff-gutter">${a ? a.num : ''}</td>`
                    + `<td class="diff-line ${a ? 'cell-add' : 'cell-empty'}">${a ? escapeHtml(a.text) : ''}</td>`
                    + '</tr>'
                );
            }
            pendingDel = [];
            pendingAdd = [];
        };
        h.lines.forEach(line => {
            const ch = line.charAt(0);
            const text = line.substring(1);
            if (ch === '\\') return;
            if (ch === '-') { pendingDel.push({ num: oldLn++, text }); }
            else if (ch === '+') { pendingAdd.push({ num: newLn++, text }); }
            else {
                flushPending();
                rows.push(
                    '<tr class="diff-same">'
                    + `<td class="diff-gutter">${oldLn}</td>`
                    + `<td class="diff-line">${escapeHtml(text)}</td>`
                    + `<td class="diff-gutter">${newLn}</td>`
                    + `<td class="diff-line">${escapeHtml(text)}</td>`
                    + '</tr>'
                );
                oldLn++; newLn++;
            }
        });
        flushPending();
    });
    return '<table class="conflict-diff-table mode-split">' + rows.join('') + '</table>';
}

// ─────────────────────────────────────────────────────────────────────────────
// 줄바꿈 모드 반영
// ─────────────────────────────────────────────────────────────────────────────

function applyDiffPreviewWrapMode(container: HTMLElement | null): void {
    if (!container) return;
    const wrap = localStorage.getItem('editor_word_wrap') !== 'false';
    container.classList.toggle('wrap-mode', wrap);
}

// ─────────────────────────────────────────────────────────────────────────────
// 변경 사항(내 수정본 기준) 미리보기 — 메인 에디터의 diff 패널에서 사용
// ─────────────────────────────────────────────────────────────────────────────

function renderLocalDiff(): void {
    const container = document.getElementById('diffPreviewContainer');
    if (!container) return;

    applyDiffPreviewWrapMode(container);

    const editor = window.editor;
    const originalContent = typeof window.originalContent === 'string' ? window.originalContent : '';
    const currentContent = editor ? editor.getMarkdown() : '';
    if (originalContent === currentContent) {
        container.innerHTML = '<span class="text-muted">변경 사항이 없습니다.</span>';
        return;
    }

    // 익스텐션 데이터(수 MB 단위 raw 데이터)는 jsdiff LCS 가 메인 스레드를 점거해
    // 고성능 기기에서도 동결을 유발하므로, 라인 수 / 바이트 / 머리 5 줄 요약 카드로 대체.
    if (window.isExtensionData) {
        container.innerHTML = buildExtensionDataDiffCard(originalContent, currentContent);
        return;
    }

    const Diff = window.Diff;
    if (!Diff || !Diff.diffLines) {
        container.textContent = currentContent;
        return;
    }

    const diffData = Diff.diffLines(originalContent, currentContent);
    container.innerHTML = renderInlineDiffSummary(diffData, CONFLICT_CONTEXT_LINES);
}

// ─────────────────────────────────────────────────────────────────────────────
// 변경 사항 미리보기 텍스트 복사
// ─────────────────────────────────────────────────────────────────────────────

function buildLocalDiffText(): string {
    const editor = window.editor;
    const originalContent = typeof window.originalContent === 'string' ? window.originalContent : '';
    const currentContent = editor ? editor.getMarkdown() : '';
    if (originalContent === currentContent) return '';

    if (window.isExtensionData) {
        const oldLines = _countLines(originalContent);
        const newLines = _countLines(currentContent);
        const oldKB = (originalContent.length / 1024).toFixed(1);
        const newKB = (currentContent.length / 1024).toFixed(1);
        const oldHead = originalContent.split('\n', 5).join('\n');
        const newHead = currentContent.split('\n', 5).join('\n');
        return (
            `줄 수: ${oldLines} → ${newLines}\n` +
            `크기: ${oldKB} KB → ${newKB} KB\n\n` +
            `--- 이전 본문(앞 5줄) ---\n${oldHead}\n\n` +
            `+++ 현재 본문(앞 5줄) +++\n${newHead}\n`
        );
    }

    const Diff = window.Diff;
    if (!Diff || !Diff.diffLines) return currentContent;

    const diffData = Diff.diffLines(originalContent, currentContent);
    const ctx = CONFLICT_CONTEXT_LINES;
    const out: string[] = [];
    diffData.forEach((part, i) => {
        const prefix = part.added ? '+' : part.removed ? '-' : ' ';
        const raw = part.value;
        const trailingNl = raw.endsWith('\n');
        const lines = raw.split('\n');
        if (trailingNl) lines.pop();

        if (part.added || part.removed) {
            lines.forEach(line => out.push(prefix + line));
            return;
        }

        const showTop = (i !== 0);
        const showBottom = (i !== diffData.length - 1);
        if (!showTop && !showBottom) {
            lines.forEach(line => out.push(' ' + line));
        } else if (lines.length <= ctx * 2 + 1) {
            lines.forEach(line => out.push(' ' + line));
        } else {
            if (showTop) {
                lines.slice(0, ctx).forEach(line => out.push(' ' + line));
            }
            out.push('... (생략됨) ...');
            if (showBottom) {
                lines.slice(-ctx).forEach(line => out.push(' ' + line));
            }
        }
    });
    return out.join('\n');
}

async function copyDiffPreview(): Promise<void> {
    const btn = document.getElementById('diffPreviewCopyBtn') as HTMLButtonElement | null;
    const text = buildLocalDiffText();
    if (!text) {
        if (btn) {
            const orig = btn.innerHTML;
            btn.innerHTML = '<i class="mdi mdi-information-outline"></i> 변경 없음';
            setTimeout(() => { btn.innerHTML = orig; }, 1500);
        }
        return;
    }

    const setSuccess = (): void => {
        if (!btn) return;
        const orig = '<i class="mdi mdi-content-copy"></i> 복사하기';
        btn.innerHTML = '<i class="mdi mdi-check"></i> 복사됨';
        setTimeout(() => { btn.innerHTML = orig; }, 1500);
    };
    const setFailure = (): void => {
        if (!btn) return;
        const orig = '<i class="mdi mdi-content-copy"></i> 복사하기';
        btn.innerHTML = '<i class="mdi mdi-alert"></i> 복사 실패';
        setTimeout(() => { btn.innerHTML = orig; }, 1500);
    };

    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            setSuccess();
            return;
        }
    } catch {
        // fall through to execCommand
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
        const ok = document.execCommand('copy');
        if (ok) setSuccess();
        else setFailure();
    } catch {
        setFailure();
    } finally {
        document.body.removeChild(textarea);
    }
}

// 작은 인라인 diff: 메인 에디터의 변경 미리보기용 — 기존 동작 유지
function renderInlineDiffSummary(diffData: JsDiffPart[], contextLines: number): string {
    let html = '';
    diffData.forEach((part, i) => {
        if (part.added || part.removed) {
            const cls = part.added ? 'diff-added' : 'diff-removed';
            html += `<span class="${cls}">${escapeHtml(part.value)}</span>`;
        } else {
            const lines = part.value.split('\n');
            const trailing = lines[lines.length - 1] === '';
            if (trailing) lines.pop();

            const showTop = (i !== 0);
            const showBottom = (i !== diffData.length - 1);

            if (!showTop && !showBottom) {
                html += `<span>${escapeHtml(part.value)}</span>`;
            } else if (lines.length <= contextLines * 2 + 1) {
                html += `<span>${escapeHtml(part.value)}</span>`;
            } else {
                if (showTop) {
                    html += `<span>${escapeHtml(lines.slice(0, contextLines).join('\n') + '\n')}</span>`;
                }
                html += '<span style="color: grey; font-style: italic; background: #e9ecef; border-radius: 4px; padding: 0 4px;">... (생략됨) ...</span>\n';
                if (showBottom) {
                    html += `<span>${escapeHtml(lines.slice(-contextLines).join('\n') + (trailing ? '\n' : ''))}</span>`;
                }
            }
        }
    });
    return html;
}

// ─────────────────────────────────────────────────────────────────────────────
// 충돌 모달 표시
// ─────────────────────────────────────────────────────────────────────────────

interface ConflictPayload {
    current_version: number | string | null;
    content: string;
}

function showConflictModal(data: ConflictPayload): void {
    window.pageVersion = data.current_version;
    const serverContent = data.content || '';
    const editor = window.editor;
    const localContent = editor ? editor.getMarkdown() : '';
    const baseContent = typeof window.originalContent === 'string' ? window.originalContent : '';

    conflictState.base = baseContent;
    conflictState.ours = localContent;
    conflictState.theirs = serverContent;
    conflictState.serverVersion = data.current_version;
    conflictState.diffMode = 'unified';
    conflictState.compareMode = 'mine-vs-server';
    conflictState.serverPaneMode = 'diff';
    conflictState.serverPreviewMode = 'raw';

    // 헤더 칩 갱신
    const baseVerEl = document.getElementById('conflict-base-ver');
    const serverVerEl = document.getElementById('conflict-server-ver');
    const serverChEl = document.getElementById('conflict-server-changes');
    const mineChEl = document.getElementById('conflict-mine-changes');
    if (baseVerEl) baseVerEl.textContent = '?'; // 클라이언트는 base 버전 정보를 보유하지 않음
    if (serverVerEl) serverVerEl.textContent = data.current_version != null ? String(data.current_version) : '?';
    if (serverChEl) serverChEl.textContent = String(countChangeHunks(baseContent, serverContent));
    if (mineChEl) mineChEl.textContent = String(countChangeHunks(baseContent, localContent));

    // 서버 본문 raw 채우기
    const serverRawEl = document.getElementById('conflict-server-raw');
    if (serverRawEl) serverRawEl.textContent = serverContent;
    const serverPreviewEl = document.getElementById('conflict-server-preview') as HTMLElement | null;
    if (serverPreviewEl) {
        serverPreviewEl.style.display = 'none';
        serverPreviewEl.innerHTML = '';
    }
    const serverViewToggleBtn = document.getElementById('serverViewToggle');
    if (serverViewToggleBtn) serverViewToggleBtn.innerHTML = '<i class="mdi mdi-eye"></i> 서버 본문';
    const serverPreviewToggleBtn = document.getElementById('serverPreviewToggle');
    if (serverPreviewToggleBtn) serverPreviewToggleBtn.innerHTML = '<i class="mdi mdi-eye"></i> 프리뷰';
    const serverRawPane = document.getElementById('conflict-server-raw-pane') as HTMLElement | null;
    if (serverRawPane) serverRawPane.style.display = 'none';
    const diffViewEl = document.getElementById('conflict-diff-view') as HTMLElement | null;
    if (diffViewEl) diffViewEl.style.display = '';

    // 비교 모드 셀렉터 초기화
    const compareSelect = document.getElementById('diffCompareMode') as HTMLSelectElement | null;
    if (compareSelect) compareSelect.value = 'mine-vs-server';

    // diff 모드 버튼 상태
    syncDiffModeButtons();

    // 충돌 UI 표시
    const conflictUiEl = document.getElementById('conflict-ui') as HTMLElement | null;
    if (conflictUiEl) conflictUiEl.style.display = 'block';
    const mainEditorEl = document.getElementById('main-editor-container') as HTMLElement | null;
    if (mainEditorEl) mainEditorEl.style.display = 'none';
    window.scrollTo(0, 0);

    // 병합 초안 생성
    const draft = buildConflictDraft(baseContent, localContent, serverContent, data.current_version);
    conflictState.conflicts = draft.conflicts;
    const initialContent = draft.merged != null ? draft.merged : localContent;

    // 충돌 해결용 textarea 마운트(또는 기존 객체 재사용)
    const conflictEl = document.querySelector('#conflict-local-editor');
    if (!window.conflictEditor) {
        if (!conflictEl) return;
        const textareaId = window.isExtensionData ? 'conflictRawTextarea' : 'conflictTextarea';
        conflictEl.innerHTML = `<textarea id="${textareaId}" class="wiki-ext-raw-textarea" spellcheck="false"></textarea>`;
        const conflictTextarea = document.getElementById(textareaId) as HTMLTextAreaElement | null;
        if (!conflictTextarea) return;
        conflictTextarea.value = initialContent;
        const ce: ConflictEditor = {
            getMarkdown: () => conflictTextarea.value,
            setMarkdown: (md: string) => { conflictTextarea.value = md; },
            _textarea: conflictTextarea,
        };
        window.conflictEditor = ce;
        // 사용자가 직접 마커를 지웠을 때도 카운터/리스트가 갱신되도록 input 후크
        conflictTextarea.addEventListener('input', updateConflictMarkerStateFromTextarea);
    } else {
        window.conflictEditor.setMarkdown(initialContent);
    }
    applyDiffPreviewWrapMode(document.getElementById('conflict-local-editor'));

    renderDiffView();
    renderHunkList();
    updateMarkerCount();
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff 비교 패널 렌더
// ─────────────────────────────────────────────────────────────────────────────

function renderDiffView(): void {
    const compareSelect = document.getElementById('diffCompareMode') as HTMLSelectElement | null;
    if (compareSelect) {
        const v = compareSelect.value;
        if (v === 'mine-vs-server' || v === 'mine-vs-base' || v === 'server-vs-base') {
            conflictState.compareMode = v;
        }
    }

    const container = document.getElementById('conflict-diff-view');
    if (!container) return;
    applyDiffPreviewWrapMode(container);

    const { left, right } = getCompareSources(conflictState.compareMode);
    container.innerHTML = buildDiffTable(left, right, conflictState.diffMode);
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff 모드 토글 (Unified / Split)
// ─────────────────────────────────────────────────────────────────────────────

function setDiffMode(mode: string): void {
    if (mode !== 'unified' && mode !== 'split') return;
    conflictState.diffMode = mode;
    syncDiffModeButtons();
    renderDiffView();
}

function syncDiffModeButtons(): void {
    const unifiedBtn = document.getElementById('diffModeUnifiedBtn');
    const splitBtn = document.getElementById('diffModeSplitBtn');
    if (unifiedBtn) unifiedBtn.classList.toggle('active', conflictState.diffMode === 'unified');
    if (splitBtn) splitBtn.classList.toggle('active', conflictState.diffMode === 'split');
}

// ─────────────────────────────────────────────────────────────────────────────
// 서버 본문 raw 보기 토글 (비교 패널 ↔ 서버 raw 패널)
// ─────────────────────────────────────────────────────────────────────────────

function toggleServerView(): void {
    conflictState.serverPaneMode = conflictState.serverPaneMode === 'raw' ? 'diff' : 'raw';
    const diffEl = document.getElementById('conflict-diff-view') as HTMLElement | null;
    const rawPane = document.getElementById('conflict-server-raw-pane') as HTMLElement | null;
    const btn = document.getElementById('serverViewToggle');
    if (conflictState.serverPaneMode === 'raw') {
        if (diffEl) diffEl.style.display = 'none';
        if (rawPane) rawPane.style.display = 'block';
        if (btn) btn.innerHTML = '<i class="mdi mdi-compare-horizontal"></i> 비교 보기';
    } else {
        if (diffEl) diffEl.style.display = '';
        if (rawPane) rawPane.style.display = 'none';
        if (btn) btn.innerHTML = '<i class="mdi mdi-eye"></i> 서버 본문';
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 서버 본문 raw ↔ 프리뷰 토글
// ─────────────────────────────────────────────────────────────────────────────

function toggleServerPreview(): void {
    const raw = document.getElementById('conflict-server-raw') as HTMLElement | null;
    const preview = document.getElementById('conflict-server-preview') as HTMLElement | null;
    const btn = document.getElementById('serverPreviewToggle');
    if (!raw || !preview) return;

    const slug = window.slug ?? null;
    if (conflictState.serverPreviewMode === 'raw') {
        // raw → preview
        preview.innerHTML = '';
        const previewContent = document.createElement('div');
        previewContent.id = 'conflict-server-preview-content';
        previewContent.className = 'wiki-content';
        preview.appendChild(previewContent);
        const renderFn = window.renderWikiContent;
        if (typeof renderFn === 'function') {
            void renderFn(raw.textContent || '', slug, 'conflict-server-preview-content');
        } else {
            previewContent.textContent = raw.textContent;
        }
        const sv: ServerViewer = {
            setMarkdown: (md: string): void => {
                const fn = window.renderWikiContent;
                if (typeof fn === 'function') {
                    void fn(md, slug, 'conflict-server-preview-content');
                }
            },
        };
        window.serverViewer = sv;
        raw.style.display = 'none';
        preview.style.display = 'block';
        if (btn) btn.innerHTML = '<i class="mdi mdi-code-tags"></i> Raw';
        conflictState.serverPreviewMode = 'preview';
    } else {
        // preview → raw
        raw.style.display = 'block';
        preview.style.display = 'none';
        if (btn) btn.innerHTML = '<i class="mdi mdi-eye"></i> 프리뷰';
        conflictState.serverPreviewMode = 'raw';
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 충돌 hunk 액션 리스트 렌더
// ─────────────────────────────────────────────────────────────────────────────

function renderHunkList(): void {
    const list = document.getElementById('conflict-hunk-list');
    if (!list) return;
    list.innerHTML = '';
    if (!conflictState.conflicts || conflictState.conflicts.length === 0) return;

    conflictState.conflicts.forEach(c => {
        const row = document.createElement('div');
        row.className = 'conflict-hunk-row' + (c.resolved ? ' resolved' : '');
        row.dataset.id = String(c.id);

        const label = document.createElement('span');
        label.className = 'conflict-hunk-label';
        label.textContent = `#${c.id} — 내: ${truncate(c.ours, 40)} ↔ 서버: ${truncate(c.theirs, 40)}`;
        label.title = '클릭하면 본문에서 해당 충돌 위치로 이동합니다';
        label.addEventListener('click', () => focusConflict(c.id));
        row.appendChild(label);

        const btnGroup = document.createElement('div');
        btnGroup.className = 'btn-group btn-group-sm';
        btnGroup.role = 'group';

        btnGroup.appendChild(makeHunkBtn('내 것', 'btn-outline-primary', () => applyHunkAction(c.id, 'mine')));
        btnGroup.appendChild(makeHunkBtn('서버 것', 'btn-outline-danger', () => applyHunkAction(c.id, 'theirs')));
        btnGroup.appendChild(makeHunkBtn('둘 다', 'btn-outline-secondary', () => applyHunkAction(c.id, 'both')));
        btnGroup.appendChild(makeHunkBtn('직접', 'btn-outline-secondary', () => focusConflict(c.id)));
        row.appendChild(btnGroup);

        list.appendChild(row);
    });
}

function makeHunkBtn(label: string, cls: string, handler: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn ${cls}`;
    btn.textContent = label;
    btn.addEventListener('click', handler);
    return btn;
}

function truncate(s: string, n: number): string {
    if (!s) return '(빈 줄)';
    const oneLine = s.replace(/\n/g, ' ↵ ');
    return oneLine.length > n ? oneLine.substring(0, n - 1) + '…' : oneLine;
}

// ─────────────────────────────────────────────────────────────────────────────
// 특정 충돌 hunk 영역을 본문에서 찾기
// 반환: { start, end, lines } 또는 null
//   start: '<<<<<<<' 시작 줄 인덱스(0-based)
//   end:   '>>>>>>>' 줄 인덱스(0-based)
//   lines: 라인 배열 (split('\n') 결과 그대로)
// ─────────────────────────────────────────────────────────────────────────────

interface ConflictRange {
    start: number;
    end: number;
    lines: string[];
}

function findConflictRange(textareaValue: string, conflictId: number): ConflictRange | null {
    const lines = textareaValue.split('\n');
    const startTag = `<<<<<<<`;
    const endTag = `>>>>>>>`;
    const idMarker = `[#${conflictId}]`;
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith(startTag) && lines[i].endsWith(idMarker)) { start = i; break; }
    }
    if (start === -1) return null;
    let end = -1;
    for (let i = start + 1; i < lines.length; i++) {
        if (lines[i].startsWith(endTag) && lines[i].endsWith(idMarker)) { end = i; break; }
    }
    if (end === -1) return null;
    return { start, end, lines };
}

function focusConflict(conflictId: number): void {
    const ce = window.conflictEditor;
    if (!ce || !ce._textarea) return;
    const ta = ce._textarea;
    const range = findConflictRange(ta.value, conflictId);
    if (!range) return;
    // 텍스트 시작 오프셋 계산
    const beforeLines = range.lines.slice(0, range.start);
    const offset = beforeLines.reduce((s, l) => s + l.length + 1, 0);
    ta.focus();
    ta.setSelectionRange(offset, offset);
    // 스크롤: 라인 높이를 대략 추정
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    ta.scrollTop = Math.max(0, range.start * lineHeight - ta.clientHeight / 3);
}

// ─────────────────────────────────────────────────────────────────────────────
// hunk 단위 채택 액션
// ─────────────────────────────────────────────────────────────────────────────

function applyHunkAction(conflictId: number, action: 'mine' | 'theirs' | 'both'): void {
    const ce = window.conflictEditor;
    if (!ce || !ce._textarea) return;
    const ta = ce._textarea;
    const range = findConflictRange(ta.value, conflictId);
    if (!range) return;

    const conflict = conflictState.conflicts.find(c => c.id === conflictId);
    if (!conflict) return;

    let replacement: string;
    if (action === 'mine') replacement = conflict.ours;
    else if (action === 'theirs') replacement = conflict.theirs;
    else if (action === 'both') {
        // 내 것 다음에 서버 것을 이어 붙임
        const parts: string[] = [];
        if (conflict.ours) parts.push(conflict.ours);
        if (conflict.theirs) parts.push(conflict.theirs);
        replacement = parts.join('\n');
    } else {
        return;
    }

    const newLines = [
        ...range.lines.slice(0, range.start),
        ...(replacement ? replacement.split('\n') : []),
        ...range.lines.slice(range.end + 1),
    ];
    ta.value = newLines.join('\n');
    conflict.resolved = true;
    renderHunkList();
    updateMarkerCount();
}

// ─────────────────────────────────────────────────────────────────────────────
// 마커 카운터 갱신
// ─────────────────────────────────────────────────────────────────────────────

function updateMarkerCount(): void {
    const badge = document.getElementById('conflict-marker-count');
    if (!badge) return;
    const remaining = countRemainingMarkers();
    badge.textContent = `${remaining}개 미해결`;
    badge.classList.toggle('bg-warning', remaining > 0);
    badge.classList.toggle('text-dark', remaining > 0);
    badge.classList.toggle('bg-success', remaining === 0);
}

function countRemainingMarkers(): number {
    const ce = window.conflictEditor;
    if (!ce) return 0;
    const text = ce.getMarkdown();
    const matches = text.match(/^<{7}\s/gm);
    return matches ? matches.length : 0;
}

// 사용자가 textarea 를 직접 편집했을 때 호출 — hunk 객체의 resolved 플래그도 동기화
function updateConflictMarkerStateFromTextarea(): void {
    const ce = window.conflictEditor;
    if (!ce) return;
    const text = ce.getMarkdown();
    if (conflictState.conflicts) {
        for (const c of conflictState.conflicts) {
            const present = text.includes(`<<<<<<< 내 수정본 [#${c.id}]`)
                && text.includes(`>>>>>>> `)
                && text.includes(`[#${c.id}]`);
            c.resolved = !present;
        }
        renderHunkList();
    }
    updateMarkerCount();
}

// ─────────────────────────────────────────────────────────────────────────────
// 충돌 순회
// ─────────────────────────────────────────────────────────────────────────────

function jumpToConflict(direction: number): void {
    const ce = window.conflictEditor;
    if (!ce || !ce._textarea) return;
    const ta = ce._textarea;
    const text = ta.value;
    const positions: number[] = [];
    const re = /^<{7} /gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) positions.push(m.index);
    if (positions.length === 0) return;

    const cursor = ta.selectionStart;
    let target: number | undefined;
    if (direction > 0) {
        target = positions.find(p => p > cursor);
        if (target == null) target = positions[0]; // wrap
    } else {
        const before = positions.filter(p => p < cursor);
        target = before.length ? before[before.length - 1] : positions[positions.length - 1];
    }
    if (target == null) return;
    ta.focus();
    ta.setSelectionRange(target, target);
    // 라인 인덱스 계산해 스크롤
    const lineIndex = text.substring(0, target).split('\n').length - 1;
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    ta.scrollTop = Math.max(0, lineIndex * lineHeight - ta.clientHeight / 3);
}

// ─────────────────────────────────────────────────────────────────────────────
// 충돌 해결 적용
// 병합된 내용을 메인 에디터에 불러오고, 충돌 UI를 닫아 사용자가 편집을 이어갈
// 수 있도록 한다. 저장은 사용자가 직접 트리거한다.
// ─────────────────────────────────────────────────────────────────────────────

function resolveConflict(): void {
    const ce = window.conflictEditor;
    const finalContent = ce ? ce.getMarkdown() : '';
    const remaining = countRemainingMarkers();

    const proceed = (): void => {
        const editor = window.editor;
        if (editor) editor.setMarkdown(finalContent);
        // 새 base = 서버 최신본. pageVersion 은 showConflictModal 에서 이미 갱신됨.
        // 이로써 beforeunload 경고/로컬 diff 가 새 기준점에서 동작하고, 다음 저장 시
        // 백엔드 충돌 검사가 정상 통과한다.
        if (typeof conflictState.theirs === 'string') {
            window.originalContent = conflictState.theirs;
        }
        const conflictUi = document.getElementById('conflict-ui') as HTMLElement | null;
        if (conflictUi) conflictUi.style.display = 'none';
        const mainEditor = document.getElementById('main-editor-container') as HTMLElement | null;
        if (mainEditor) mainEditor.style.display = 'block';
        window.scrollToBottom?.();
        window.Swal?.fire({
            icon: 'success',
            title: '충돌 해결 내용 적용됨',
            text: '에디터에서 편집을 이어가신 뒤 저장하세요.',
            toast: true,
            position: 'top-end',
            timer: 2500,
            showConfirmButton: false,
        });
    };

    if (remaining > 0) {
        const swal = window.Swal;
        if (!swal) { proceed(); return; }
        void swal.fire({
            title: '미해결 충돌이 남아있습니다',
            html: `${remaining}개의 충돌 마커(<code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code>)가 본문에 그대로 있습니다. 그래도 에디터에 적용하시겠습니까?`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: '그대로 적용',
            cancelButtonText: '계속 해결하기',
        }).then((result) => {
            if (result.isConfirmed) proceed();
        });
        return;
    }

    proceed();
}

function cancelConflict(): void {
    const swal = window.Swal;
    if (!swal) { window.location.reload(); return; }
    void swal.fire({
        title: '충돌 해결 취소',
        text: '편집 내용을 버리고 최신 버전으로 새로고침 하시겠습니까?',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: '새로고침 (내용 버림)',
        cancelButtonText: '계속 해결하기',
    }).then((result) => {
        if (result.isConfirmed) {
            window.location.reload();
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 동시편집 감지 (기존 동작 유지)
// ─────────────────────────────────────────────────────────────────────────────

interface HeartbeatState {
    interval: ReturnType<typeof setInterval> | null;
    editorCheckInterval: ReturnType<typeof setInterval> | null;
}

const heartbeat: HeartbeatState = {
    interval: null,
    editorCheckInterval: null,
};

function startEditingHeartbeat(): void {
    const slug = window.slug;
    if (!slug) return;
    const cfg: AppConfig | undefined = window.appConfig;
    if (cfg && cfg.enableConcurrentEditDetection === false) return;

    void sendHeartbeat();
    heartbeat.interval = setInterval(sendHeartbeat, 50000);
    heartbeat.editorCheckInterval = setInterval(checkConcurrentEditors, 50000);

    window.addEventListener('beforeunload', stopEditingHeartbeat);
}

function stopEditingHeartbeat(): void {
    if (heartbeat.interval) {
        clearInterval(heartbeat.interval);
        heartbeat.interval = null;
    }
    if (heartbeat.editorCheckInterval) {
        clearInterval(heartbeat.editorCheckInterval);
        heartbeat.editorCheckInterval = null;
    }
}

async function sendHeartbeat(): Promise<void> {
    const slug = window.slug;
    if (!slug) return;
    try {
        await fetch(`/api/w/${encodeURIComponent(slug)}/editing`, {
            method: 'POST',
        });
    } catch {
        // 하트비트 실패는 무시
    }
}

async function checkConcurrentEditors(): Promise<void> {
    const slug = window.slug;
    if (!slug) return;
    try {
        const res = await fetch(`/api/w/${encodeURIComponent(slug)}/editors`);
        if (!res.ok) return;
        const data = await res.json() as ConcurrentEditorsResponse;

        const banner = document.getElementById('concurrent-edit-banner') as HTMLElement | null;
        const textEl = document.getElementById('concurrent-edit-text');
        if (!banner || !textEl) return;

        if (data.editors && data.editors.length > 0) {
            const editorNames = data.editors.map(e => {
                const avatar = e.picture
                    ? `<img src="${escapeHtml(e.picture)}" class="editor-avatar" alt="" loading="lazy">`
                    : '';
                return `${avatar}<strong>${escapeHtml(e.name)}</strong>`;
            }).join(', ');

            textEl.innerHTML = `이 문서를 ${editorNames}님이 동시에 편집 중입니다. 편집 충돌이 발생할 수 있습니다.`;
            banner.style.display = 'flex';
        } else {
            banner.style.display = 'none';
        }
    } catch {
        // 조회 실패는 무시
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 브리지: edit.js (raw) 와 edit.html 의 인라인 onclick 핸들러가 호출하므로
// window 에 노출. 모듈은 deferred — 모든 classic top-level 실행 후 / 어떤
// DOMContentLoaded 핸들러보다 앞에 평가되므로 안전.
//
// showConflictModal 은 src/client/edit/types.ts 가 단일 소스 (utils.ts 의
// checkDraft 도 동일 시그니처로 read), 그 외 함수들은 본 모듈 자체의 브리지로
// declare 한다.
// ─────────────────────────────────────────────────────────────────────────────

declare global {
    interface Window {
        renderLocalDiff?: typeof renderLocalDiff;
        copyDiffPreview?: typeof copyDiffPreview;
        startEditingHeartbeat?: typeof startEditingHeartbeat;
        stopEditingHeartbeat?: typeof stopEditingHeartbeat;
        /**
         * edit.js 부트스트랩이 startEditingHeartbeat() 직후 별도로 호출 (line 2764).
         * 노출 누락 시 ReferenceError 로 이후 초기화가 끊기므로 반드시 브리지로 노출.
         */
        checkConcurrentEditors?: typeof checkConcurrentEditors;
        resolveConflict?: typeof resolveConflict;
        cancelConflict?: typeof cancelConflict;
        jumpToConflict?: typeof jumpToConflict;
        setDiffMode?: typeof setDiffMode;
        renderDiffView?: typeof renderDiffView;
        toggleServerView?: typeof toggleServerView;
        toggleServerPreview?: typeof toggleServerPreview;
    }
}

window.showConflictModal = showConflictModal;
window.renderLocalDiff = renderLocalDiff;
window.copyDiffPreview = copyDiffPreview;
window.startEditingHeartbeat = startEditingHeartbeat;
window.stopEditingHeartbeat = stopEditingHeartbeat;
window.checkConcurrentEditors = checkConcurrentEditors;
window.resolveConflict = resolveConflict;
window.cancelConflict = cancelConflict;
window.jumpToConflict = jumpToConflict;
window.setDiffMode = setDiffMode;
window.renderDiffView = renderDiffView;
window.toggleServerView = toggleServerView;
window.toggleServerPreview = toggleServerPreview;

console.log('[edit/conflict] module loaded');
