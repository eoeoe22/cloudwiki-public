// ──────────────────────────────────────────────────────────────────────────
// 편집 충돌 해결 UI (GitHub PR conflict editor 스타일)
//
// 용어:
//   base   = 사용자가 편집을 시작했을 때의 본문 (originalContent, 클라이언트 보유)
//   ours   = 내 수정본 (editor.getMarkdown())
//   theirs = 서버 최신본 (409 응답의 data.content)
//
// 자동 병합(diff3) 알고리즘은 도입하지 않는다. 대신 3-way 정보를
// 활용해 (1) 충돌 마커가 자동 삽입된 병합 초안을 통합 textarea에 채우고,
// (2) 비교 패널에서 "내 vs 서버 / 내 vs base / 서버 vs base" 세 가지
// 시점의 GitHub 스타일 hunk 테이블을 보여준다.
// ──────────────────────────────────────────────────────────────────────────

const CONFLICT_CONTEXT_LINES = 3;

// 현재 충돌 세션 상태
let conflictState = {
    base: '',
    ours: '',
    theirs: '',
    serverVersion: null,
    diffMode: 'unified',          // 'unified' | 'split'
    compareMode: 'mine-vs-server', // 'mine-vs-server' | 'mine-vs-base' | 'server-vs-base'
    serverPaneMode: 'diff',        // 'diff' | 'raw' (서버 본문 raw/preview 보기)
    serverPreviewMode: 'raw',      // 'raw' | 'preview'
    conflicts: [],                 // [{ id, ours, theirs, resolved }]
};

// ── 라인 분할 / 결합 헬퍼 ───────────────────────────────────────────────
// jsdiff가 생성하는 part.value 는 보통 트레일링 \n 을 포함하므로,
// split('\n') 결과의 마지막 빈 토큰을 제거해 라인 배열로 만든다.
function splitLines(text) {
    if (!text) return [];
    const arr = text.split('\n');
    if (arr.length > 0 && arr[arr.length - 1] === '') arr.pop();
    return arr;
}

// ── jsdiff 결과 → base 라인 범위에 매핑된 hunk 배열 ─────────────────────
// 반환: [{ baseStart, baseEnd, replacement }]
//   baseStart..baseEnd 는 base 라인 인덱스 [0-based, end exclusive]
//   replacement 는 해당 영역을 대체할 modified 측 텍스트(라인 배열)
function extractHunks(base, modified) {
    if (typeof Diff === 'undefined' || !Diff.diffLines) return [];
    const parts = Diff.diffLines(base, modified);
    const hunks = [];
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
        let removedLines = [];
        let addedLines = [];
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

// ── 3-way 합성: 충돌 마커가 삽입된 병합 초안 생성 ────────────────────────
// 자동 병합이 아닌 "표기 초안". 겹치는 변경은 충돌 블록으로 감싸 사용자가
// 직접 결정하도록 남긴다.
function buildConflictDraft(base, ours, theirs, serverVer) {
    const oursHunks = extractHunks(base, ours);
    const theirsHunks = extractHunks(base, theirs);
    const baseLines = splitLines(base);

    const result = [];
    const conflicts = [];
    let baseIdx = 0;
    let oI = 0, tI = 0;

    function copyBase(upTo) {
        const end = Math.min(upTo, baseLines.length);
        while (baseIdx < end) {
            result.push(baseLines[baseIdx]);
            baseIdx++;
        }
    }

    function pushConflict(oursLines, theirsLines) {
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

    function arraysEqual(a, b) {
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
        const oOverlapsT = oH && tH && oH.baseStart < tH.baseEnd && tH.baseStart < oH.baseEnd;

        if (oH && (!tH || oH.baseStart < tH.baseStart)) {
            if (oOverlapsT) {
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
            if (oOverlapsT) {
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

// ── 비교 모드별 source/target 텍스트 산출 ───────────────────────────────
function getCompareSources(mode) {
    const s = conflictState;
    if (mode === 'mine-vs-base')   return { left: s.base,   right: s.ours,   leftLabel: 'base',   rightLabel: '내 수정본' };
    if (mode === 'server-vs-base') return { left: s.base,   right: s.theirs, leftLabel: 'base',   rightLabel: '서버 최신본' };
    return                                { left: s.theirs, right: s.ours,   leftLabel: '서버',   rightLabel: '내 수정본' };
}

// ── 변경 hunk 개수 (요약 칩용) ───────────────────────────────────────────
function countChangeHunks(oldStr, newStr) {
    if (oldStr === newStr) return 0;
    if (typeof Diff === 'undefined' || !Diff.structuredPatch) return 0;
    const patch = Diff.structuredPatch('a', 'b', oldStr || '', newStr || '', '', '', { context: 0 });
    return patch.hunks ? patch.hunks.length : 0;
}

// ── Diff 테이블 빌드 ────────────────────────────────────────────────────
function buildDiffTable(oldStr, newStr, mode) {
    if (oldStr === newStr) {
        return '<div class="diff-empty">변경된 내용이 없습니다.</div>';
    }
    if (typeof Diff === 'undefined' || !Diff.structuredPatch) {
        return '<div class="diff-empty">diff 라이브러리를 불러오지 못했습니다.</div>';
    }
    const patch = Diff.structuredPatch('a', 'b', oldStr || '', newStr || '', '', '', { context: CONFLICT_CONTEXT_LINES });
    if (!patch.hunks || patch.hunks.length === 0) {
        return '<div class="diff-empty">변경된 내용이 없습니다.</div>';
    }
    return mode === 'split' ? buildSplitTable(patch) : buildUnifiedTable(patch);
}

function buildUnifiedTable(patch) {
    const rows = [];
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
            let type, oldCol, newCol, prefix;
            if (ch === '+')      { type = 'add';  oldCol = '';     newCol = newLn++; prefix = '+'; }
            else if (ch === '-') { type = 'del';  oldCol = oldLn++; newCol = '';      prefix = '-'; }
            else                 { type = 'same'; oldCol = oldLn++; newCol = newLn++; prefix = ' '; }
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

function buildSplitTable(patch) {
    const rows = [];
    patch.hunks.forEach(h => {
        rows.push(
            `<tr class="hunk-header"><td colspan="4" class="diff-line">@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@</td></tr>`
        );
        let oldLn = h.oldStart, newLn = h.newStart;
        let pendingDel = [];
        let pendingAdd = [];
        const flushPending = () => {
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

// ── 줄바꿈 모드 반영 ────────────────────────────────────────────────────
function applyDiffPreviewWrapMode(container) {
    if (!container) return;
    const wrap = localStorage.getItem('editor_word_wrap') !== 'false';
    container.classList.toggle('wrap-mode', wrap);
}

// ── 변경 사항(내 수정본 기준) 미리보기 — 메인 에디터의 diff 패널에서 사용 ──
function renderLocalDiff() {
    const container = document.getElementById('diffPreviewContainer');
    if (!container) return;

    applyDiffPreviewWrapMode(container);

    const currentContent = editor ? editor.getMarkdown() : '';
    if (originalContent === currentContent) {
        container.innerHTML = '<span class="text-muted">변경 사항이 없습니다.</span>';
        return;
    }

    if (typeof Diff === 'undefined' || !Diff.diffLines) {
        container.textContent = currentContent;
        return;
    }

    const diffData = Diff.diffLines(originalContent, currentContent);
    container.innerHTML = renderInlineDiffSummary(diffData, CONFLICT_CONTEXT_LINES);
}

// (작은 인라인 diff: 메인 에디터의 변경 미리보기용 — 기존 동작 유지)
function renderInlineDiffSummary(diffData, contextLines) {
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

// ── 충돌 모달 표시 ──────────────────────────────────────────────────────
function showConflictModal(data) {
    pageVersion = data.current_version;
    const serverContent = data.content || '';
    const localContent = editor ? editor.getMarkdown() : '';
    const baseContent = typeof originalContent === 'string' ? originalContent : '';

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
    if (serverVerEl) serverVerEl.textContent = data.current_version != null ? data.current_version : '?';
    if (serverChEl) serverChEl.textContent = countChangeHunks(baseContent, serverContent);
    if (mineChEl) mineChEl.textContent = countChangeHunks(baseContent, localContent);

    // 서버 본문 raw 채우기
    const serverRawEl = document.getElementById('conflict-server-raw');
    if (serverRawEl) serverRawEl.textContent = serverContent;
    const serverPreviewEl = document.getElementById('conflict-server-preview');
    if (serverPreviewEl) {
        serverPreviewEl.style.display = 'none';
        serverPreviewEl.innerHTML = '';
    }
    const serverViewToggleBtn = document.getElementById('serverViewToggle');
    if (serverViewToggleBtn) serverViewToggleBtn.innerHTML = '<i class="mdi mdi-eye"></i> 서버 본문';
    const serverPreviewToggleBtn = document.getElementById('serverPreviewToggle');
    if (serverPreviewToggleBtn) serverPreviewToggleBtn.innerHTML = '<i class="mdi mdi-eye"></i> 프리뷰';
    const serverRawPane = document.getElementById('conflict-server-raw-pane');
    if (serverRawPane) serverRawPane.style.display = 'none';
    const diffViewEl = document.getElementById('conflict-diff-view');
    if (diffViewEl) diffViewEl.style.display = '';

    // 비교 모드 셀렉터 초기화
    const compareSelect = document.getElementById('diffCompareMode');
    if (compareSelect) compareSelect.value = 'mine-vs-server';

    // diff 모드 버튼 상태
    syncDiffModeButtons();

    // 충돌 UI 표시
    document.getElementById('conflict-ui').style.display = 'block';
    document.getElementById('main-editor-container').style.display = 'none';
    window.scrollTo(0, 0);

    // 병합 초안 생성
    const draft = buildConflictDraft(baseContent, localContent, serverContent, data.current_version);
    conflictState.conflicts = draft.conflicts;
    const initialContent = draft.merged != null ? draft.merged : localContent;

    // 충돌 해결용 textarea 마운트(또는 기존 객체 재사용)
    const conflictEl = document.querySelector('#conflict-local-editor');
    if (!conflictEditor) {
        const textareaId = isExtensionData ? 'conflictRawTextarea' : 'conflictTextarea';
        conflictEl.innerHTML = `<textarea id="${textareaId}" class="wiki-ext-raw-textarea" spellcheck="false"></textarea>`;
        const conflictTextarea = document.getElementById(textareaId);
        conflictTextarea.value = initialContent;
        conflictEditor = {
            getMarkdown: () => conflictTextarea.value,
            setMarkdown: (md) => { conflictTextarea.value = md; },
            _textarea: conflictTextarea,
        };
        // 사용자가 직접 마커를 지웠을 때도 카운터/리스트가 갱신되도록 input 후크
        conflictTextarea.addEventListener('input', updateConflictMarkerStateFromTextarea);
    } else {
        conflictEditor.setMarkdown(initialContent);
    }
    applyDiffPreviewWrapMode(document.getElementById('conflict-local-editor'));

    renderDiffView();
    renderHunkList();
    updateMarkerCount();
}

// ── Diff 비교 패널 렌더 ─────────────────────────────────────────────────
function renderDiffView() {
    const compareSelect = document.getElementById('diffCompareMode');
    if (compareSelect) conflictState.compareMode = compareSelect.value;

    const container = document.getElementById('conflict-diff-view');
    if (!container) return;
    applyDiffPreviewWrapMode(container);

    const { left, right } = getCompareSources(conflictState.compareMode);
    container.innerHTML = buildDiffTable(left, right, conflictState.diffMode);
}

// ── Diff 모드 토글 (Unified / Split) ────────────────────────────────────
function setDiffMode(mode) {
    if (mode !== 'unified' && mode !== 'split') return;
    conflictState.diffMode = mode;
    syncDiffModeButtons();
    renderDiffView();
}

function syncDiffModeButtons() {
    const unifiedBtn = document.getElementById('diffModeUnifiedBtn');
    const splitBtn = document.getElementById('diffModeSplitBtn');
    if (unifiedBtn) unifiedBtn.classList.toggle('active', conflictState.diffMode === 'unified');
    if (splitBtn) splitBtn.classList.toggle('active', conflictState.diffMode === 'split');
}

// ── 서버 본문 raw 보기 토글 (비교 패널 ↔ 서버 raw 패널) ──────────────────
function toggleServerView() {
    conflictState.serverPaneMode = conflictState.serverPaneMode === 'raw' ? 'diff' : 'raw';
    const diffEl = document.getElementById('conflict-diff-view');
    const rawPane = document.getElementById('conflict-server-raw-pane');
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

// ── 서버 본문 raw ↔ 프리뷰 토글 ──────────────────────────────────────────
function toggleServerPreview() {
    const raw = document.getElementById('conflict-server-raw');
    const preview = document.getElementById('conflict-server-preview');
    const btn = document.getElementById('serverPreviewToggle');
    if (!raw || !preview) return;

    if (conflictState.serverPreviewMode === 'raw') {
        // raw → preview
        preview.innerHTML = '';
        const previewContent = document.createElement('div');
        previewContent.id = 'conflict-server-preview-content';
        previewContent.className = 'wiki-content';
        preview.appendChild(previewContent);
        if (typeof renderWikiContent === 'function') {
            renderWikiContent(raw.textContent, slug, 'conflict-server-preview-content');
        } else {
            previewContent.textContent = raw.textContent;
        }
        serverViewer = {
            setMarkdown: (md) => {
                if (typeof renderWikiContent === 'function') {
                    renderWikiContent(md, slug, 'conflict-server-preview-content');
                }
            },
        };
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

// ── 충돌 hunk 액션 리스트 렌더 ───────────────────────────────────────────
function renderHunkList() {
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

function makeHunkBtn(label, cls, handler) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn ${cls}`;
    btn.textContent = label;
    btn.addEventListener('click', handler);
    return btn;
}

function truncate(s, n) {
    if (!s) return '(빈 줄)';
    const oneLine = s.replace(/\n/g, ' ↵ ');
    return oneLine.length > n ? oneLine.substring(0, n - 1) + '…' : oneLine;
}

// ── 특정 충돌 hunk 영역을 본문에서 찾기 ──────────────────────────────────
// 반환: { start, end, body } 또는 null
//   start: '<<<<<<<' 시작 줄 인덱스(0-based)
//   end: '>>>>>>>' 줄 인덱스(0-based)
//   body: 라인 배열
function findConflictRange(textareaValue, conflictId) {
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

function focusConflict(conflictId) {
    if (!conflictEditor || !conflictEditor._textarea) return;
    const ta = conflictEditor._textarea;
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

// ── hunk 단위 채택 액션 ──────────────────────────────────────────────────
function applyHunkAction(conflictId, action) {
    if (!conflictEditor || !conflictEditor._textarea) return;
    const ta = conflictEditor._textarea;
    const range = findConflictRange(ta.value, conflictId);
    if (!range) return;

    const conflict = conflictState.conflicts.find(c => c.id === conflictId);
    if (!conflict) return;

    let replacement;
    if (action === 'mine') replacement = conflict.ours;
    else if (action === 'theirs') replacement = conflict.theirs;
    else if (action === 'both') {
        // 내 것 다음에 서버 것을 이어 붙임
        const parts = [];
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

// ── 마커 카운터 갱신 ────────────────────────────────────────────────────
function updateMarkerCount() {
    const badge = document.getElementById('conflict-marker-count');
    if (!badge) return;
    const remaining = countRemainingMarkers();
    badge.textContent = `${remaining}개 미해결`;
    badge.classList.toggle('bg-warning', remaining > 0);
    badge.classList.toggle('text-dark', remaining > 0);
    badge.classList.toggle('bg-success', remaining === 0);
}

function countRemainingMarkers() {
    if (!conflictEditor) return 0;
    const text = conflictEditor.getMarkdown();
    const matches = text.match(/^<{7}\s/gm);
    return matches ? matches.length : 0;
}

// 사용자가 textarea 를 직접 편집했을 때 호출 — hunk 객체의 resolved 플래그도 동기화
function updateConflictMarkerStateFromTextarea() {
    if (!conflictEditor) return;
    const text = conflictEditor.getMarkdown();
    if (conflictState.conflicts) {
        for (const c of conflictState.conflicts) {
            const present = text.includes(`<<<<<<< 내 수정본 [#${c.id}]`)
                         && text.includes(`>>>>>>> `) // end tag 존재 + id marker 검사
                         && text.includes(`[#${c.id}]`);
            c.resolved = !present;
        }
        renderHunkList();
    }
    updateMarkerCount();
}

// ── 충돌 순회 ───────────────────────────────────────────────────────────
function jumpToConflict(direction) {
    if (!conflictEditor || !conflictEditor._textarea) return;
    const ta = conflictEditor._textarea;
    const text = ta.value;
    const positions = [];
    const re = /^<{7} /gm;
    let m;
    while ((m = re.exec(text)) !== null) positions.push(m.index);
    if (positions.length === 0) return;

    const cursor = ta.selectionStart;
    let target;
    if (direction > 0) {
        target = positions.find(p => p > cursor);
        if (target == null) target = positions[0]; // wrap
    } else {
        const before = positions.filter(p => p < cursor);
        target = before.length ? before[before.length - 1] : positions[positions.length - 1];
    }
    ta.focus();
    ta.setSelectionRange(target, target);
    // 라인 인덱스 계산해 스크롤
    const lineIndex = text.substring(0, target).split('\n').length - 1;
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    ta.scrollTop = Math.max(0, lineIndex * lineHeight - ta.clientHeight / 3);
}

// ── 충돌 해결 (저장 재시도) ──────────────────────────────────────────────
function resolveConflict() {
    const finalContent = conflictEditor ? conflictEditor.getMarkdown() : '';
    const remaining = countRemainingMarkers();

    const proceed = () => {
        editor.setMarkdown(finalContent);
        if (typeof scrollToBottom === 'function') scrollToBottom();
        document.getElementById('conflict-ui').style.display = 'none';
        document.getElementById('main-editor-container').style.display = 'block';
        savePage();
    };

    if (remaining > 0) {
        Swal.fire({
            title: '미해결 충돌이 남아있습니다',
            html: `${remaining}개의 충돌 마커(<code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code>)가 본문에 그대로 있습니다. 그래도 저장하시겠습니까?`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: '그대로 저장',
            cancelButtonText: '계속 편집하기',
        }).then((result) => {
            if (result.isConfirmed) proceed();
        });
        return;
    }

    proceed();
}

function cancelConflict() {
    Swal.fire({
        title: '충돌 해결 취소',
        text: '편집 내용을 버리고 최신 버전으로 새로고침 하시겠습니까?',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: '새로고침 (내용 버림)',
        cancelButtonText: '계속 해결하기'
    }).then((result) => {
        if (result.isConfirmed) {
            window.location.reload();
        }
    });
}


// ── 동시편집 감지 (기존 동작 유지) ───────────────────────────────────────
const heartbeat = {
    interval: null,
    editorCheckInterval: null,
};

function startEditingHeartbeat() {
    if (!slug) return;
    if (appConfig.enableConcurrentEditDetection === false) return;

    sendHeartbeat();
    heartbeat.interval = setInterval(sendHeartbeat, 50000);
    heartbeat.editorCheckInterval = setInterval(checkConcurrentEditors, 50000);

    window.addEventListener('beforeunload', stopEditingHeartbeat);
}

function stopEditingHeartbeat() {
    if (heartbeat.interval) {
        clearInterval(heartbeat.interval);
        heartbeat.interval = null;
    }
    if (heartbeat.editorCheckInterval) {
        clearInterval(heartbeat.editorCheckInterval);
        heartbeat.editorCheckInterval = null;
    }
}

async function sendHeartbeat() {
    if (!slug) return;
    try {
        await fetch(`/api/w/${encodeURIComponent(slug)}/editing`, {
            method: 'POST',
        });
    } catch (e) {
        // 하트비트 실패는 무시
    }
}

async function checkConcurrentEditors() {
    if (!slug) return;
    try {
        const res = await fetch(`/api/w/${encodeURIComponent(slug)}/editors`);
        if (!res.ok) return;
        const data = await res.json();

        const banner = document.getElementById('concurrent-edit-banner');
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
    } catch (e) {
        // 조회 실패는 무시
    }
}
