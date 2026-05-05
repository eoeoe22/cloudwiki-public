// ── 편집 요약 자동 작성 ──
// summaryInput 입력 칸을 자동 prefix + 사용자 입력 형태로 유지한다.
// 형식: "<자동요약> / <사용자입력>" (둘 중 하나만 있으면 해당 부분만 표시)
//
// 자동요약 규칙:
//   - 섹션 편집 모드: "'<섹션 헤딩 텍스트>' 편집"
//                    헤딩 텍스트 자체가 바뀌면 "'OLD' → 'NEW' 섹션 이름 변경"
//                    섹션 내부 하위 헤딩 추가/삭제도 합성
//   - 신규 문서:      "문서 생성"
//   - 기존 문서:      카테고리 추가/삭제, 관리자 전용(잠금) 변경,
//                    본문 헤딩 추가/삭제/이름 변경,
//                    공통 섹션 본문 편집("섹션 'X' 편집") 을 합성
//
// 사용자가 에디터 설정에서 자동 작성을 끄면(localStorage editor_auto_summary
// = "false") refreshAutoSummary 가 직전 prefix 만 정리하고 즉시 종료한다.
//
// 의존하는 외부(edit.js / render.js) 전역:
//   sectionMode, sectionRange, originalContent, originalPageMeta, categoryTags, editor
//   _extractMarkdownSectionRanges (render.js)
//   #summaryInput, #isLockedCheck DOM

let lastAutoSummaryPrefix = '';

// 사용자가 summaryInput 에 직접 타이핑 중일 때 prefix 강제 갱신으로 커서가
// 튀는 것을 방지하기 위한 보호 타임스탬프.
let _lastUserSummaryEditAt = 0;

// 헤딩 목록 표시 상한. 초과 시 "외 N개" 로 잘라 255자 제한 안에 들어오게 한다.
const _HEADING_LIST_CAP = 3;

function _extractHeadingsForSummary(text) {
    if (typeof _extractMarkdownSectionRanges !== 'function') return [];
    const ranges = _extractMarkdownSectionRanges(text || '');
    const lines = (text || '').split('\n');
    // 각 헤딩의 "own body" — 다음 헤딩(레벨 무관) 직전까지의 본문.
    // 부모/자식 섹션이 동일한 변화로 동시에 마킹되는 잡음을 피하려면 own body 비교가
    // 적절하다. ATX 면 body 시작은 lineIdx+1, setext(=== 또는 ---)면 lineIdx+2
    // (제목 라인 다음 underline 라인까지 헤딩으로 간주).
    const nextNonTransIdx = [];
    for (let i = 0; i < ranges.length; i++) {
        let next = lines.length;
        for (let j = i + 1; j < ranges.length; j++) {
            if (!ranges[j].transcluded) { next = ranges[j].lineIdx; break; }
        }
        nextNonTransIdx.push(next);
    }
    const out = [];
    for (let i = 0; i < ranges.length; i++) {
        const r = ranges[i];
        if (r.transcluded) continue;
        const headingLine = lines[r.lineIdx] || '';
        const isAtx = /^#{1,4}\s+/.test(headingLine);
        const bodyStart = isAtx ? r.lineIdx + 1 : r.lineIdx + 2;
        const bodyEnd = nextNonTransIdx[i];
        const bodyLines = lines.slice(bodyStart, Math.max(bodyStart, bodyEnd));
        // 잡음 줄이기: 시작/끝의 빈 줄 정규화
        while (bodyLines.length && bodyLines[0].trim() === '') bodyLines.shift();
        while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop();
        out.push({
            level: r.level,
            text: (r.headingText || '').trim(),
            lineIdx: r.lineIdx,
            body: bodyLines.join('\n')
        });
    }
    return out;
}

// 첫 헤딩이 본문 최상단에 위치하는지(앞에 빈 줄만 있는지) 검사.
// ATX(#~####)와 setext(=== / ---) 모두 _extractMarkdownSectionRanges 가
// 동일한 lineIdx 로 반환하므로 통일된 판정이 가능하다.
function _firstHeadingAtTop(content, headings) {
    const first = headings && headings[0];
    if (!first) return null;
    const lines = (content || '').split('\n');
    for (let i = 0; i < first.lineIdx; i++) {
        if (lines[i].trim() !== '') return null;
    }
    return first;
}

// (level, text) 튜플 LCS 로 공통 시퀀스 추출 후, 양쪽 잔여를 좌→우 순서로
// 짝지어 같은 level 끼리는 rename 으로 승격. 이 휴리스틱은 한 글자 수정 같은
// 헤딩 이름 편집을 add+remove 잡음 없이 단일 rename 항목으로 분류한다.
function _diffHeadings(orig, curr) {
    const m = orig.length;
    const n = curr.length;
    // dp[i][j] = LCS length of orig[i..] vs curr[j..]
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            if (orig[i].level === curr[j].level && orig[i].text === curr[j].text) {
                dp[i][j] = dp[i + 1][j + 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
        }
    }
    const removed = [];
    const added = [];
    const matched = []; // {origIdx, currIdx} — 본문 비교에 사용
    let i = 0, j = 0;
    while (i < m && j < n) {
        if (orig[i].level === curr[j].level && orig[i].text === curr[j].text) {
            matched.push({ origIdx: i, currIdx: j });
            i++; j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            removed.push(orig[i]); i++;
        } else {
            added.push(curr[j]); j++;
        }
    }
    while (i < m) removed.push(orig[i++]);
    while (j < n) added.push(curr[j++]);

    // rename 짝짓기: 같은 level 끼리 좌→우 순서대로 1:1 매칭.
    const renamed = [];
    const remRemoved = [];
    const remAdded = added.slice();
    for (const r of removed) {
        const idx = remAdded.findIndex(a => a.level === r.level);
        if (idx >= 0) {
            const a = remAdded.splice(idx, 1)[0];
            if (r.text !== a.text) {
                renamed.push({ level: r.level, from: r.text, to: a.text });
            }
            // text 동일(공백/대소문자 등 trim 차이 없음) 시 변화 없음 → 무시
        } else {
            remRemoved.push(r);
        }
    }
    return { added: remAdded, removed: remRemoved, renamed, matched };
}

function _formatHeadingList(items, mapToLabel) {
    const labels = items.map(mapToLabel);
    if (labels.length <= _HEADING_LIST_CAP) return labels.join(', ');
    const head = labels.slice(0, _HEADING_LIST_CAP).join(', ');
    return `${head} 외 ${labels.length - _HEADING_LIST_CAP}개`;
}

function _buildHeadingDiffParts(origHeadings, currHeadings, opts) {
    const labelPrefix = (opts && opts.labelPrefix) || '섹션';
    const includeBodyEdits = !!(opts && opts.includeBodyEdits);
    const diff = _diffHeadings(origHeadings, currHeadings);
    const parts = [];
    if (diff.renamed.length === 1) {
        const r = diff.renamed[0];
        parts.push(`${labelPrefix} '${r.from}' → '${r.to}' 이름 변경`);
    } else if (diff.renamed.length > 1) {
        const list = _formatHeadingList(diff.renamed, r => `'${r.from}' → '${r.to}'`);
        parts.push(`${labelPrefix} 이름 변경 ${list}`);
    }
    if (diff.added.length) {
        parts.push(`${labelPrefix} ${_formatHeadingList(diff.added, h => `'${h.text}'`)} 추가`);
    }
    if (diff.removed.length) {
        parts.push(`${labelPrefix} ${_formatHeadingList(diff.removed, h => `'${h.text}'`)} 삭제`);
    }
    // 헤딩이 동일한(공통) 섹션의 본문이 바뀐 경우 "섹션 'X' 편집" 으로 보고.
    // 부모-자식 섹션이 같은 변화로 중복 표시되는 잡음을 피하려고 own-body
    // (다음 헤딩 직전까지) 만 비교한다.
    if (includeBodyEdits && diff.matched.length) {
        const edited = [];
        for (const pair of diff.matched) {
            const o = origHeadings[pair.origIdx];
            const c = currHeadings[pair.currIdx];
            if (o && c && (o.body || '') !== (c.body || '')) {
                edited.push(c);
            }
        }
        if (edited.length) {
            parts.push(`${labelPrefix} ${_formatHeadingList(edited, h => `'${h.text}'`)} 편집`);
        }
    }
    return parts;
}

// 본문 헤딩 비교의 베이스라인은 항상 호출 시점의 originalContent (edit-utils.js
// 의 전역) 에서 직접 추출한다. 캐싱하면 originalContent 가 충돌 해결/초안
// 복구 등 우회 경로로 갱신될 때 stale 한 비교 기준으로 거짓 add/remove 가
// 발생할 수 있다. 추출은 펜스 처리 포함 정규식 1회 통과로 충분히 가볍고,
// 호출은 400ms 디바운스 되어 있어 매번 재계산해도 부담이 없다.
function _getOriginalHeadingsForSummary() {
    const text = (typeof originalContent === 'string') ? originalContent : '';
    return _extractHeadingsForSummary(text);
}

function buildAutoEditSummary() {
    const editorAvailable = typeof editor !== 'undefined' && editor && typeof editor.getMarkdown === 'function';
    const currentContent = editorAvailable ? editor.getMarkdown() : '';

    // 섹션 편집 모드: 헤딩 텍스트로 요약을 고정한다.
    // (섹션 모드에서는 카테고리/잠금 UI가 숨겨져 변경이 불가능하므로 합성하지 않는다.)
    if (typeof sectionMode !== 'undefined' && sectionMode &&
        typeof sectionRange !== 'undefined' && sectionRange && sectionRange.headingText) {
        const baseHeading = sectionRange.headingText;
        const baseLevel = sectionRange.level || 0;
        const currHeadings = editorAvailable ? _extractHeadingsForSummary(currentContent) : [];

        // 섹션 본문은 "<heading line>\n..." 로 시작해야 한다. _extractMarkdownSectionRanges
        // 가 ATX(`#~####`) 와 setext(=== / ---) 를 모두 동일한 헤딩 엔트리로 반환하므로,
        // 첫 헤딩이 본문 최상단(앞에 빈 줄만 존재) 에 있는지로 일관 판정한다.
        // - 선두에 헤딩이 없거나, 사용자가 선두 헤딩을 지워 하위 헤딩이 첫 항목으로
        //   승격된(앞에 본문 텍스트가 끼어 lineIdx > 0) 경우 → 'removed'
        // - 그 외에는 level / text 비교로 'level' / 'renamed' / 'unchanged' 분류
        const topHeading = _firstHeadingAtTop(currentContent, currHeadings);
        let sectionStatus = 'unchanged';
        let newLevel = baseLevel;
        let newText = baseHeading;
        if (!topHeading) {
            sectionStatus = 'removed';
        } else {
            newLevel = topHeading.level;
            newText = topHeading.text;
            if (baseLevel && newLevel !== baseLevel) sectionStatus = 'level';
            else if (newText !== baseHeading.trim()) sectionStatus = 'renamed';
        }

        // 섹션 헤딩이 사라졌으면 currHeadings 전체가 하위 섹션 후보, 그 외에는
        // 첫 항목(섹션 헤딩) 을 제외한 나머지를 비교한다.
        const origSub = _getOriginalHeadingsForSummary().slice(1);
        const currSub = sectionStatus === 'removed' ? currHeadings : currHeadings.slice(1);
        const subParts = _buildHeadingDiffParts(origSub, currSub, { labelPrefix: '하위 섹션' });

        let prefix;
        if (sectionStatus === 'removed') {
            prefix = `'${baseHeading}' 섹션 헤딩 삭제`;
        } else if (sectionStatus === 'level') {
            prefix = `'${baseHeading}' 섹션 레벨 변경 (H${baseLevel} → H${newLevel})`;
        } else if (sectionStatus === 'renamed') {
            prefix = `'${baseHeading}' → '${newText}' 섹션 이름 변경`;
        } else {
            prefix = `'${baseHeading}' 편집`;
        }
        if (subParts.length) prefix += ', ' + subParts.join(', ');
        return prefix;
    }

    // 신규 문서: 카테고리/잠금/헤딩은 생성에 포함되므로 '문서 생성'만 표시
    if (typeof originalPageMeta === 'undefined' || !originalPageMeta) return '문서 생성';

    const origCats = originalPageMeta.category
        ? originalPageMeta.category.split(',').map(c => c.trim()).filter(Boolean)
        : [];
    const currCats = (typeof categoryTags !== 'undefined' && Array.isArray(categoryTags))
        ? categoryTags.slice()
        : [];
    const added = currCats.filter(c => !origCats.includes(c));
    const removed = origCats.filter(c => !currCats.includes(c));

    const origLocked = originalPageMeta.is_locked ? 1 : 0;
    const lockEl = document.getElementById('isLockedCheck');
    const currLocked = lockEl && lockEl.checked ? 1 : 0;

    const parts = [];
    if (added.length) parts.push(`분류 ${added.map(c => `'${c}'`).join(', ')} 추가`);
    if (removed.length) parts.push(`분류 ${removed.map(c => `'${c}'`).join(', ')} 삭제`);
    if (origLocked !== currLocked) {
        parts.push(currLocked ? '관리자 전용 설정' : '관리자 전용 해제');
    }

    if (editorAvailable) {
        const currHeadings = _extractHeadingsForSummary(currentContent);
        const origHeadings = _getOriginalHeadingsForSummary();
        const headingParts = _buildHeadingDiffParts(origHeadings, currHeadings, {
            labelPrefix: '섹션',
            includeBodyEdits: true
        });
        for (const p of headingParts) parts.push(p);

        // 헤딩이 하나도 없는 문서에서 본문만 변경된 경우에는 섹션 단위로 분류할
        // 수 없으므로 대표 prefix '본문 편집' 을 추가한다(다른 헤딩/카테고리/잠금
        // 변화가 이미 있다면 추가하지 않아 잡음을 늘리지 않는다).
        if (!headingParts.length && parts.length === 0
            && origHeadings.length === 0 && currHeadings.length === 0
            && (originalContent || '') !== (currentContent || '')) {
            parts.push('본문 편집');
        }
    }

    return parts.join(', ');
}

// 자동 prefix 만 떼어내고 사용자 입력 부분만 반환.
function _stripAutoPrefix(value) {
    if (!lastAutoSummaryPrefix) return value;
    if (value.startsWith(lastAutoSummaryPrefix + ' / ')) {
        return value.slice((lastAutoSummaryPrefix + ' / ').length);
    }
    if (value === lastAutoSummaryPrefix) return '';
    return value;
}

function isAutoSummaryEnabled() {
    try {
        return localStorage.getItem('editor_auto_summary') !== 'false';
    } catch (e) {
        return true;
    }
}

// 사용자가 직접 입력한 텍스트(자동 prefix 뒤 ' / ')는 보존한 채 prefix만 갱신.
function refreshAutoSummary() {
    const summaryEl = document.getElementById('summaryInput');
    if (!summaryEl) return;

    // 자동 작성 토글 OFF: 직전 prefix 만 정리하고 사용자 입력은 보존.
    // 직전 prefix 가 없거나 이미 정리되어 있으면 입력값을 건드리지 않는다.
    if (!isAutoSummaryEnabled()) {
        if (lastAutoSummaryPrefix) {
            summaryEl.value = _stripAutoPrefix(summaryEl.value);
            lastAutoSummaryPrefix = '';
        }
        return;
    }

    // 사용자가 summaryInput 에 직접 타이핑 중이라면 prefix 가 동일할 때만 갱신해
    // 커서 점프를 방지한다(헤딩 변경이 prefix 길이를 바꾸지 않을 때만 통과).
    const userTypingNow = document.activeElement === summaryEl
        && (Date.now() - _lastUserSummaryEditAt) < 1500;

    const newAutoSummary = buildAutoEditSummary();

    if (userTypingNow && newAutoSummary === lastAutoSummaryPrefix) {
        return;
    }

    // 현재 값에서 직전 자동 prefix를 떼어내 사용자 입력 부분만 추출
    const userPart = _stripAutoPrefix(summaryEl.value);

    let combined;
    if (newAutoSummary && userPart) {
        combined = `${newAutoSummary} / ${userPart}`;
    } else {
        combined = newAutoSummary || userPart;
    }
    if (combined.length > 255) combined = combined.slice(0, 255);

    summaryEl.value = combined;
    lastAutoSummaryPrefix = newAutoSummary;
}

// summaryInput 에 직접 타이핑하는 시점을 기록한다. edit.js 초기화 시 한 번만 등록.
document.addEventListener('DOMContentLoaded', () => {
    const summaryEl = document.getElementById('summaryInput');
    if (!summaryEl) return;
    summaryEl.addEventListener('input', () => {
        _lastUserSummaryEditAt = Date.now();
    });
});
