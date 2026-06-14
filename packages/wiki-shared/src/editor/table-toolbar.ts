/**
 * 표 안 커서 위에 떠 있는 통합 인라인 편집 툴바.
 *
 * 마크다운 표(GFM 파이프 + 위키 고유 셀 병합 토큰)에 커서가 들어가면 셀 바로 위에
 * 정렬·행/열 추가/삭제 + (빈 셀일 때) 셀 병합 토큰 4종 + 색상 삽입 버튼을 띄운다.
 * 색상 삽입은 기존 에디터 툴바의 `openPaletteColorModal()` 을 그대로 재호출해
 * 동일한 팔레트/커스텀 색상 모달을 띄운다.
 *
 * 외부 의존성:
 *   - window._cmView (CodeMirror6 EditorView; main.ts 가 생성)
 *   - window.openPaletteColorModal (edit/modals.ts 가 노출하는 색상 삽입 모달)
 *
 * 노출 글로벌:
 *   - window.setupTableToolbar() → { update, hide } 핸들. main.ts 의 updateListener /
 *     blurHandler 가 호출.
 *
 * 위치 계산 / 표 블록 감지 로직은 기존 main.ts 의 `cellMergeToolbar` 블록을 흡수·확장한
 * 것이다.
 */

import './types';

// CodeMirror6 EditorView. npm 미설치 + codemirror.d.ts shim 이라 type 만 any 로 둔다.
// 실제 view 객체는 main.ts 가 만든 _cmView 그대로 전달된다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EditorView = any;

declare global {
    interface Window {
        setupTableToolbar?: () => TableToolbarHandle;
        findTableContext?: (view: EditorView) => TableContext | null;
        /** edit/modals.ts 가 노출하는 색상 삽입 모달 (table-toolbar 에서 참조) */
        openPaletteColorModal?: () => void;
    }
}

interface TableToolbarHandle {
    update: (view: EditorView) => void;
    hide: () => void;
}

interface TableContext {
    startLine: number;            // 표 블록 첫 라인 번호 (1-based)
    endLine: number;              // 표 블록 마지막 라인 번호
    separatorLineNum: number;     // 정렬 구분선 라인 번호
    rowIndex: number;             // 현재 라인의 표 내 인덱스 (line - startLine, 0-based)
    separatorRowIndex: number;    // 구분선의 표 내 인덱스 (보통 1)
    colIndex: number;             // 현재 셀의 0-based 인덱스
    colCount: number;             // 표 총 열 수
    activeAlign: 'left' | 'center' | 'right';
    bodyRowCount: number;         // 본문 행 수 (헤더/구분선 제외)
    emptyCellRange: { from: number; to: number } | null;  // 현재 셀이 빈 셀이면 절대 오프셋 범위
}

// ─────────────────────────────────────────────────────────────────────────────
// 표 라인 파서
// ─────────────────────────────────────────────────────────────────────────────

function isPipeRow(text: string): boolean {
    return /^\s*\|/.test(text) && (text.match(/(?<!\\)\|/g) || []).length >= 2;
}

function isTableSeparatorLine(text: string): boolean {
    return /^\s*\|\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)*\s*\|?\s*$/.test(text);
}

function splitRowCells(lineText: string): string[] {
    // 비-이스케이프 파이프(`(?<!\\)\|`) 로 분할 후 선두/말미 빈 조각 제거.
    const parts = lineText.split(/(?<!\\)\|/);
    const trimmed = lineText.trim();
    const hasLeading = trimmed.startsWith('|');
    const hasTrailing = trimmed.endsWith('|');
    const cells = [...parts];
    if (hasLeading) cells.shift();
    if (hasTrailing) cells.pop();
    return cells.map(c => c.trim());
}

/**
 * 표 행에서 colIndex 번째 셀의 콘텐츠 시작 절대 오프셋을 반환한다.
 * `|` 직후 표 컨벤션(`| cell |`)의 패딩 공백 1 개만 스킵한다 — 빈 셀(`|   |`)에서
 * 모든 공백을 스킵하면 닫는 파이프 직전(셀 오른쪽 끝)으로 가버려 "맨 앞 삽입"
 * 의도와 어긋난다.
 * 표 행은 항상 선두 `|` 를 가진다(isPipeRow 가 `^\s*\|` 강제).
 * 후행 `|` 가 없는 GFM 행(`| a | b`)의 마지막 셀도 지원 — 마지막 파이프부터
 * 줄 끝까지를 셀 범위로 본다.
 */
function findCellStartByIndex(lineText: string, colIndex: number, lineFrom: number): number | null {
    const pipes: number[] = [];
    for (let i = 0; i < lineText.length; i++) {
        if (lineText[i] === '\\') { i++; continue; }
        if (lineText[i] === '|') pipes.push(i);
    }
    if (pipes.length === 0 || colIndex < 0 || colIndex >= pipes.length) return null;
    const lo = pipes[colIndex];
    const hi = colIndex + 1 < pipes.length ? pipes[colIndex + 1] : lineText.length;
    let start = lo + 1;
    if (start < hi && lineText[start] === ' ') start++;
    return lineFrom + start;
}

function findEmptyCellAt(lineText: string, col: number, lineFrom: number): { from: number; to: number } | null {
    const pipes: number[] = [];
    for (let i = 0; i < lineText.length; i++) {
        if (lineText[i] === '\\') { i++; continue; }
        if (lineText[i] === '|') pipes.push(i);
    }
    if (pipes.length < 2) return null;
    for (let i = 0; i < pipes.length - 1; i++) {
        const lo = pipes[i];
        const hi = pipes[i + 1];
        if (col > lo && col <= hi) {
            const seg = lineText.substring(lo + 1, hi);
            if (seg.trim() === '') {
                return { from: lineFrom + lo + 1, to: lineFrom + hi };
            }
            return null;
        }
    }
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 표 컨텍스트 분석
// ─────────────────────────────────────────────────────────────────────────────

function findTableContext(view: EditorView): TableContext | null {
    const state = view.state;
    const sel = state.selection.main;
    if (sel.from !== sel.to) return null;
    const pos = sel.head;
    const line = state.doc.lineAt(pos);
    if (!isPipeRow(line.text)) return null;

    const totalLines = state.doc.lines;
    let start = line.number;
    while (start > 1) {
        const t = state.doc.line(start - 1).text;
        if (!isPipeRow(t)) break;
        start--;
    }
    let end = line.number;
    while (end < totalLines) {
        const t = state.doc.line(end + 1).text;
        if (!isPipeRow(t)) break;
        end++;
    }

    let separatorLineNum = -1;
    for (let n = start; n <= end; n++) {
        if (isTableSeparatorLine(state.doc.line(n).text)) { separatorLineNum = n; break; }
    }
    if (separatorLineNum === -1) return null;

    const lineText: string = line.text;
    const col = pos - line.from;
    let pipeCount = 0;
    for (let i = 0; i < col; i++) {
        if (lineText[i] === '\\') { i++; continue; }
        if (lineText[i] === '|') pipeCount++;
    }
    const lineTrimmed = lineText.trim();
    let colIndex = lineTrimmed.startsWith('|') ? pipeCount - 1 : pipeCount;

    const sepText: string = state.doc.line(separatorLineNum).text;
    const sepCells = splitRowCells(sepText);
    const colCount = sepCells.length;
    if (colCount === 0) return null;
    colIndex = Math.max(0, Math.min(colIndex, colCount - 1));

    const sepCell = sepCells[colIndex] || '';
    let activeAlign: 'left' | 'center' | 'right' = 'left';
    if (sepCell.startsWith(':') && sepCell.endsWith(':')) activeAlign = 'center';
    else if (sepCell.endsWith(':')) activeAlign = 'right';

    // 본문 행 수 = 전체 행 - 헤더 - 구분선
    const bodyRowCount = Math.max(0, (end - start + 1) - 2);

    const emptyCellRange = findEmptyCellAt(lineText, col, line.from);

    return {
        startLine: start,
        endLine: end,
        separatorLineNum,
        rowIndex: line.number - start,
        separatorRowIndex: separatorLineNum - start,
        colIndex,
        colCount,
        activeAlign,
        bodyRowCount,
        emptyCellRange,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 편집 동작
// ─────────────────────────────────────────────────────────────────────────────

function buildRow(cells: string[]): string {
    return '| ' + cells.map(c => (c && c.length ? c : ' ')).join(' | ') + ' |';
}

function replaceTableBlock(view: EditorView, ctx: TableContext, newLines: string[]): void {
    const startPos = view.state.doc.line(ctx.startLine).from;
    const endPos = view.state.doc.line(ctx.endLine).to;
    view.dispatch({
        changes: { from: startPos, to: endPos, insert: newLines.join('\n') }
    });
}

function actionAlign(view: EditorView, ctx: TableContext, align: 'left' | 'center' | 'right'): void {
    const sepLine = view.state.doc.line(ctx.separatorLineNum);
    const cells = splitRowCells(sepLine.text);
    const sym = align === 'center' ? ':---:' : align === 'right' ? '---:' : ':---';
    cells[ctx.colIndex] = sym;
    const newLine = '| ' + cells.join(' | ') + ' |';
    view.dispatch({
        changes: { from: sepLine.from, to: sepLine.to, insert: newLine }
    });
}

function actionAddRow(view: EditorView, ctx: TableContext, direction: 'above' | 'below'): void {
    const newRow = buildRow(Array(ctx.colCount).fill(''));
    let targetLine: number;
    if (direction === 'above') {
        // 헤더/구분선 위에는 행을 끼울 수 없음 (GFM 표 헤더는 구분선 바로 위 라인 1개만
        // 인식하므로 헤더 위에 추가하면 표 구조가 깨진다). UI 에서 disabled 처리되지만
        // 키보드/스크립트 경로 방어를 위해 동작 자체에서도 막는다.
        if (ctx.rowIndex <= ctx.separatorRowIndex) return;
        targetLine = ctx.startLine + ctx.rowIndex;
    } else {
        // 헤더 또는 구분선 아래 → 본문 첫줄로
        if (ctx.rowIndex <= ctx.separatorRowIndex) targetLine = ctx.separatorLineNum + 1;
        else targetLine = ctx.startLine + ctx.rowIndex + 1;
    }

    const totalLines = view.state.doc.lines;
    if (targetLine > totalLines) {
        const lastLine = view.state.doc.line(totalLines);
        view.dispatch({ changes: { from: lastLine.to, insert: '\n' + newRow } });
    } else {
        const pos = view.state.doc.line(targetLine).from;
        view.dispatch({ changes: { from: pos, insert: newRow + '\n' } });
    }
}

function actionDeleteRow(view: EditorView, ctx: TableContext): void {
    const absLine = ctx.startLine + ctx.rowIndex;
    // 헤더/구분선 삭제 금지
    if (absLine === ctx.startLine) return;
    if (absLine === ctx.separatorLineNum) return;
    // 마지막 본문 행 삭제 금지 (표 모양 보존)
    if (ctx.bodyRowCount <= 1) return;

    const line = view.state.doc.line(absLine);
    const totalLines = view.state.doc.lines;
    if (absLine < totalLines) {
        // 다음 라인의 from 까지 삭제 (끝 개행 포함)
        const nextFrom = view.state.doc.line(absLine + 1).from;
        view.dispatch({ changes: { from: line.from, to: nextFrom } });
    } else {
        // 마지막 라인 → 이전 개행부터 삭제
        if (absLine > 1) {
            const prevTo = view.state.doc.line(absLine - 1).to;
            view.dispatch({ changes: { from: prevTo, to: line.to } });
        } else {
            view.dispatch({ changes: { from: line.from, to: line.to } });
        }
    }
}

function actionAddColumn(view: EditorView, ctx: TableContext, direction: 'left' | 'right'): void {
    const insertIdx = direction === 'left' ? ctx.colIndex : ctx.colIndex + 1;
    const newLines: string[] = [];
    for (let n = ctx.startLine; n <= ctx.endLine; n++) {
        const cells = splitRowCells(view.state.doc.line(n).text);
        if (n === ctx.separatorLineNum) {
            cells.splice(insertIdx, 0, '---');
        } else {
            cells.splice(insertIdx, 0, '');
        }
        newLines.push(buildRow(cells));
    }
    replaceTableBlock(view, ctx, newLines);
}

function actionDeleteColumn(view: EditorView, ctx: TableContext): void {
    if (ctx.colCount <= 1) return;
    const newLines: string[] = [];
    for (let n = ctx.startLine; n <= ctx.endLine; n++) {
        const cells = splitRowCells(view.state.doc.line(n).text);
        cells.splice(ctx.colIndex, 1);
        newLines.push(buildRow(cells));
    }
    replaceTableBlock(view, ctx, newLines);
}

function actionMergeToken(view: EditorView, ctx: TableContext, token: string): void {
    if (!ctx.emptyCellRange) return;
    const insert = ` ${token} `;
    const { from, to } = ctx.emptyCellRange;
    view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 툴바 DOM
// ─────────────────────────────────────────────────────────────────────────────

interface ToolbarRefs {
    el: HTMLElement;
    alignBtns: Record<'left' | 'center' | 'right', HTMLButtonElement>;
    rowAbove: HTMLButtonElement;
    rowDelete: HTMLButtonElement;
    colDelete: HTMLButtonElement;
    mergeGroup: HTMLElement;
}

function buildToolbarEl(): ToolbarRefs {
    const el = document.createElement('div');
    el.className = 'cm-cell-merge-toolbar cm-table-toolbar';
    el.style.display = 'none';
    el.innerHTML = `
        <div class="cm-table-toolbar-group" data-group="align">
            <button type="button" class="cm-cell-merge-btn" data-action="align-left" title="왼쪽 정렬"><i class="mdi mdi-format-align-left"></i></button>
            <button type="button" class="cm-cell-merge-btn" data-action="align-center" title="가운데 정렬"><i class="mdi mdi-format-align-center"></i></button>
            <button type="button" class="cm-cell-merge-btn" data-action="align-right" title="오른쪽 정렬"><i class="mdi mdi-format-align-right"></i></button>
        </div>
        <div class="cm-table-toolbar-sep"></div>
        <div class="cm-table-toolbar-group" data-group="row">
            <button type="button" class="cm-cell-merge-btn" data-action="row-above" title="위에 행 삽입"><i class="mdi mdi-table-row-plus-before"></i></button>
            <button type="button" class="cm-cell-merge-btn" data-action="row-below" title="아래에 행 삽입"><i class="mdi mdi-table-row-plus-after"></i></button>
            <button type="button" class="cm-cell-merge-btn cm-table-toolbar-danger" data-action="row-delete" title="현재 행 삭제"><i class="mdi mdi-table-row-remove"></i></button>
        </div>
        <div class="cm-table-toolbar-sep"></div>
        <div class="cm-table-toolbar-group" data-group="col">
            <button type="button" class="cm-cell-merge-btn" data-action="col-left" title="왼쪽에 열 추가"><i class="mdi mdi-table-column-plus-before"></i></button>
            <button type="button" class="cm-cell-merge-btn" data-action="col-right" title="오른쪽에 열 추가"><i class="mdi mdi-table-column-plus-after"></i></button>
            <button type="button" class="cm-cell-merge-btn cm-table-toolbar-danger" data-action="col-delete" title="현재 열 삭제"><i class="mdi mdi-table-column-remove"></i></button>
        </div>
        <div class="cm-table-toolbar-sep cm-table-toolbar-merge-sep"></div>
        <div class="cm-table-toolbar-group cm-table-toolbar-merge-group" data-group="merge">
            <button type="button" class="cm-cell-merge-btn" data-action="merge-left" title="좌측 셀과 병합 {<}"><i class="mdi mdi-arrow-left-bold-outline"></i></button>
            <button type="button" class="cm-cell-merge-btn" data-action="merge-right" title="우측 셀과 병합 {>}"><i class="mdi mdi-arrow-right-bold-outline"></i></button>
            <button type="button" class="cm-cell-merge-btn" data-action="merge-up" title="상단 셀과 병합 {^}"><i class="mdi mdi-arrow-up-bold-outline"></i></button>
            <button type="button" class="cm-cell-merge-btn" data-action="merge-mid" title="가운데로 모음 {><}"><i class="mdi mdi-arrow-collapse-horizontal"></i></button>
        </div>
        <div class="cm-table-toolbar-sep"></div>
        <button type="button" class="cm-cell-merge-btn cm-table-toolbar-color" data-action="color" title="색상 삽입"><i class="mdi mdi-palette-outline"></i></button>
    `;
    const alignBtns = {
        left: el.querySelector<HTMLButtonElement>('[data-action="align-left"]')!,
        center: el.querySelector<HTMLButtonElement>('[data-action="align-center"]')!,
        right: el.querySelector<HTMLButtonElement>('[data-action="align-right"]')!,
    };
    return {
        el,
        alignBtns,
        rowAbove: el.querySelector<HTMLButtonElement>('[data-action="row-above"]')!,
        rowDelete: el.querySelector<HTMLButtonElement>('[data-action="row-delete"]')!,
        colDelete: el.querySelector<HTMLButtonElement>('[data-action="col-delete"]')!,
        mergeGroup: el.querySelector<HTMLElement>('[data-group="merge"]')!,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 메인 entry
// ─────────────────────────────────────────────────────────────────────────────

export function setupTableToolbar(): TableToolbarHandle {
    const refs = buildToolbarEl();
    document.body.appendChild(refs.el);
    const mergeSep = refs.el.querySelector<HTMLElement>('.cm-table-toolbar-merge-sep');

    let activeCtx: TableContext | null = null;

    function hide(): void {
        if (refs.el.style.display !== 'none') refs.el.style.display = 'none';
        activeCtx = null;
    }

    function update(view: EditorView): void {
        // "문법 자동완성" 설정이 꺼져 있으면 표 인라인 툴바도 비활성화한다.
        if (window.wikiSyntaxAutocompleteEnabled === false) { hide(); return; }
        const ctx = findTableContext(view);
        if (!ctx) { hide(); return; }
        activeCtx = ctx;

        // 정렬 active 토글
        (['left', 'center', 'right'] as const).forEach(a => {
            refs.alignBtns[a].classList.toggle('active', ctx.activeAlign === a);
        });
        // 행 삭제 비활성 조건
        const onHeader = ctx.rowIndex === 0;
        const onSeparator = (ctx.startLine + ctx.rowIndex) === ctx.separatorLineNum;
        refs.rowDelete.disabled = onHeader || onSeparator || ctx.bodyRowCount <= 1;
        // "위에 행 삽입" 은 헤더/구분선에서 비활성. GFM 은 구분선 바로 위 라인만 헤더로
        // 인식하므로, 헤더 위에 파이프 라인을 끼우면 표 구조가 깨진다.
        refs.rowAbove.disabled = onHeader || onSeparator;
        // 열 삭제 비활성 조건
        refs.colDelete.disabled = ctx.colCount <= 1;
        // 병합 그룹은 빈 셀에서만 노출
        const mergeVisible = !!ctx.emptyCellRange;
        refs.mergeGroup.style.display = mergeVisible ? '' : 'none';
        if (mergeSep) mergeSep.style.display = mergeVisible ? '' : 'none';

        // 위치 계산: 커서 위쪽 우선, 공간 부족 시 아래쪽
        const coords = view.coordsAtPos(view.state.selection.main.head);
        if (!coords) { hide(); return; }
        refs.el.style.display = 'flex';
        const tbW = refs.el.offsetWidth || 320;
        const tbH = refs.el.offsetHeight || 32;
        const margin = 6;
        let top = coords.top - tbH - margin;
        if (top < margin) top = coords.bottom + margin;
        let left = coords.left - tbW / 2;
        const viewportW = document.documentElement.clientWidth;
        left = Math.max(margin, Math.min(left, viewportW - tbW - margin));
        refs.el.style.left = (left + window.scrollX) + 'px';
        refs.el.style.top = (top + window.scrollY) + 'px';
    }

    // 에디터 blur 방지
    refs.el.addEventListener('mousedown', (e) => e.preventDefault());

    refs.el.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.cm-cell-merge-btn');
        if (!btn || btn.disabled) return;
        const view = window._cmView as EditorView | undefined;
        if (!view || !activeCtx) return;
        const action = btn.dataset.action || '';
        const ctx = activeCtx;
        switch (action) {
            case 'align-left':  actionAlign(view, ctx, 'left'); break;
            case 'align-center':actionAlign(view, ctx, 'center'); break;
            case 'align-right': actionAlign(view, ctx, 'right'); break;
            case 'row-above':   actionAddRow(view, ctx, 'above'); break;
            case 'row-below':   actionAddRow(view, ctx, 'below'); break;
            case 'row-delete':  actionDeleteRow(view, ctx); break;
            case 'col-left':    actionAddColumn(view, ctx, 'left'); break;
            case 'col-right':   actionAddColumn(view, ctx, 'right'); break;
            case 'col-delete':  actionDeleteColumn(view, ctx); break;
            case 'merge-left':  actionMergeToken(view, ctx, '{<}'); break;
            case 'merge-right': actionMergeToken(view, ctx, '{>}'); break;
            case 'merge-up':    actionMergeToken(view, ctx, '{^}'); break;
            case 'merge-mid':   actionMergeToken(view, ctx, '{><}'); break;
            case 'color': {
                // 기존 에디터 툴바의 "색상 삽입" 모달을 재사용. 모달이 닫히면 커서
                // 위치에 `{palette:...}` 또는 `{color:#xxx,bg:#xxx}` 토큰을 삽입한다.
                // 셀 어디서든 색상을 셀 맨 앞에 삽입하기 위해 모달 호출 전 커서를
                // 현재 셀 콘텐츠 시작 위치로 이동한다.
                const lineNum = ctx.startLine + ctx.rowIndex;
                const line = view.state.doc.line(lineNum);
                const cellStart = findCellStartByIndex(line.text, ctx.colIndex, line.from);
                if (cellStart != null) {
                    view.dispatch({ selection: { anchor: cellStart } });
                }
                view.focus();
                window.openPaletteColorModal?.();
                return;
            }
        }
        view.focus();
    });

    // 스크롤/리사이즈 시 위치 갱신
    const onWindowChange = () => {
        const view = window._cmView as EditorView | undefined;
        if (refs.el.style.display !== 'none' && view) update(view);
    };
    window.addEventListener('scroll', onWindowChange, true);
    window.addEventListener('resize', onWindowChange);

    return { update, hide };
}

window.setupTableToolbar = setupTableToolbar;
window.findTableContext = findTableContext;
