// ── 텍스트 카운터 ──
// 에디터 하단에 "n줄 n자 n자(공백포함) n단어" 표시.
// Hot path(문서 변경 시) 최적화:
//   1) span 참조를 최초 1회 탐색 후 캐시
//   2) CM6 doc 객체의 cheap 메트릭(lines/length)은 즉시 반영
//   3) 전체 문자열 스캔이 필요한 무공백 자수/단어 수는 디바운스(200ms)
let _counterEls = null;
let _counterHeavyTimer = null;

function _ensureCounterEls() {
    if (_counterEls) return _counterEls;
    const root = document.getElementById('editorTextCounter');
    if (!root) return null;
    _counterEls = {
        lines: root.querySelector('[data-counter="lines"]'),
        chars: root.querySelector('[data-counter="chars"]'),
        charsWithSpaces: root.querySelector('[data-counter="charsWithSpaces"]'),
        words: root.querySelector('[data-counter="words"]'),
    };
    return _counterEls;
}

function _fmtCount(n) { return n.toLocaleString(); }

function _setCheapCounts(els, lines, charsWithSpaces) {
    if (els.lines) els.lines.textContent = `${_fmtCount(lines)}줄`;
    if (els.charsWithSpaces) els.charsWithSpaces.textContent = `${_fmtCount(charsWithSpaces)}자(공백포함)`;
}

function _setHeavyCountsFromText(els, str) {
    const chars = str.replace(/\s/g, '').length;
    const trimmed = str.trim();
    const words = trimmed ? trimmed.split(/\s+/).length : 0;
    if (els.chars) els.chars.textContent = `${_fmtCount(chars)}자`;
    if (els.words) els.words.textContent = `${_fmtCount(words)}단어`;
}

function _cancelHeavy() {
    if (_counterHeavyTimer) {
        clearTimeout(_counterHeavyTimer);
        _counterHeavyTimer = null;
    }
}

// 문자열 기반 (전체 동기 계산) — 초기 로드, raw textarea, 섹션 전환 등에서 사용
function updateEditorTextCounter(text) {
    const els = _ensureCounterEls();
    if (!els) return;
    const str = text == null ? '' : String(text);
    const lines = str.length ? str.split('\n').length : 1;
    _cancelHeavy();
    _setCheapCounts(els, lines, str.length);
    _setHeavyCountsFromText(els, str);
}

// CM6 전용 hot-path: cheap 메트릭은 즉시, heavy 메트릭은 디바운스
function updateEditorTextCounterFromDoc(doc) {
    const els = _ensureCounterEls();
    if (!els) return;
    _setCheapCounts(els, doc.lines, doc.length);
    _cancelHeavy();
    _counterHeavyTimer = setTimeout(() => {
        _counterHeavyTimer = null;
        _setHeavyCountsFromText(els, doc.toString());
    }, 200);
}

// raw textarea hot-path: cheap 메트릭은 즉시, heavy 메트릭은 디바운스
// (익스텐션 데이터는 대용량이므로 키스트로크마다 regex/split 전체 스캔 회피)
function updateEditorTextCounterFromTextDebounced(text) {
    const els = _ensureCounterEls();
    if (!els) return;
    const str = text == null ? '' : String(text);
    const lines = str.length ? str.split('\n').length : 1;
    _setCheapCounts(els, lines, str.length);
    _cancelHeavy();
    _counterHeavyTimer = setTimeout(() => {
        _counterHeavyTimer = null;
        _setHeavyCountsFromText(els, str);
    }, 200);
}

// ── 에디터 상태 ──
let slug = null;
let pageVersion = null;
let originalContent = '';
let editor = null;
let AUTO_SAVE_KEY = '';
let conflictEditor = null;
let serverViewMode = 'raw';
let serverViewer = null;
let cachedDiffData = null;
let diffViewMode = 'summary';
let pageLeft = false;
let isExtensionData = false;

// ── 섹션 편집 모드 상태 ──
// URL에 ?section=N&h=... 이 있을 때 활성화: 특정 섹션만 편집기에 로드하고
// 저장 시 전체 원본과 합성하여 PUT 한다.
let sectionMode = false;
let sectionIndex = -1;
let sectionHeadingParam = '';
// 서버에서 받아온 전체 본문(섹션 편집 시 합성을 위해 보관)
let fullOriginalContent = '';
// 섹션 라인 범위/헤딩 텍스트
let sectionRange = null; // { lineIdx, endLine, headingText, level }
// 섹션 모드에서는 제목/카테고리/잠금/리다이렉트를 현재 값으로 고정 송신
let originalPageMeta = null;

// ── 섹션 편집 유틸 ──
// 전체 본문에서 section 인덱스 + 헤딩 텍스트로 해당 섹션 범위 탐색.
// 1) 인덱스가 유효하고 headingText 일치 → 그대로 반환
// 2) 인덱스는 무효하지만 headingText가 유일하게 매칭되면 그 섹션 반환
// 3) 실패 시 null
function findSectionRange(fullContent, idx, expectedHeading) {
    if (typeof _extractMarkdownSectionRanges !== 'function') return null;
    const ranges = _extractMarkdownSectionRanges(fullContent || '');
    if (!ranges.length) return null;

    const normalize = (s) => (s || '').trim();
    const target = normalize(expectedHeading);

    if (idx >= 0 && idx < ranges.length) {
        if (!target || normalize(ranges[idx].headingText) === target) {
            return ranges[idx];
        }
    }
    if (target) {
        const matches = ranges.filter(r => normalize(r.headingText) === target);
        if (matches.length === 1) return matches[0];
    }
    return null;
}

// 섹션 인덱스를 열람 페이지의 계층적 목차 번호(예: "1.2.1")로 변환.
// common.js 의 numberHeadings() 와 동일한 카운터 로직을 복제해 열람 페이지의
// s-X.Y 앵커 ID 와 1:1 로 매칭되는 번호를 생성한다.
// _extractMarkdownSectionRanges 는 render.js 에 정의되어 있다.
//
// 중요: sectionIndex 는 섹션 편집 링크(render.js 의 _addHeadingCopyButtons)
// 에서 **원본(raw) 헤딩 순서** 즉 transclusion 으로 주입되지 않은 헤딩만
// 0-based 로 센 인덱스다. 반면 열람 페이지의 s-X.Y 앵커는 transclusion 전개
// 이후의 전체 헤딩 순서로 번호가 매겨지므로, 전달받은 ranges(resolveTransclusions
// 결과에서 추출) 에서 idx 를 그대로 쓰면 문서 앞쪽에 transcluded 헤딩이
// 존재할 때 엉뚱한 섹션을 가리킨다. 따라서 ranges 의 non-transcluded 엔트리
// 만 세어 idx 번째 위치를 찾아낸 뒤 번호 계산에 사용한다.
function computeSectionNumber(fullContent, idx, expectedHeading) {
    if (typeof _extractMarkdownSectionRanges !== 'function') return null;
    const ranges = _extractMarkdownSectionRanges(fullContent || '');
    if (!ranges.length) return null;

    const normalize = (s) => (s || '').trim();
    const target = normalize(expectedHeading);

    // raw idx → resolved ranges 인덱스 매핑: non-transcluded 엔트리 중 idx 번째.
    // _extractMarkdownSectionRanges 는 transclusion 센티넬이 없으면 모든 엔트리의
    // transcluded 를 false 로 세팅하므로, 비-전개 본문에서도 이 로직은 idx 와 동일.
    let targetIdx = -1;
    if (idx >= 0) {
        let seen = 0;
        for (let i = 0; i < ranges.length; i++) {
            if (ranges[i].transcluded) continue;
            if (seen === idx) { targetIdx = i; break; }
            seen++;
        }
    }

    // non-transcluded 엔트리가 idx 개 미만이어서 매핑이 실패한 경우(예: 다른
    // 편집자가 섹션을 삭제해 raw 헤딩 수가 줄어든 경우) expectedHeading 텍스트로
    // 재탐색한다. non-transcluded 쪽을 먼저 시도하고, 없으면 전체 ranges 에서
    // 단일 매칭을 허용한다.
    if (targetIdx === -1 && target) {
        const nonTransMatches = [];
        const allMatches = [];
        for (let i = 0; i < ranges.length; i++) {
            if (normalize(ranges[i].headingText) !== target) continue;
            allMatches.push(i);
            if (!ranges[i].transcluded) nonTransMatches.push(i);
        }
        if (nonTransMatches.length === 1) targetIdx = nonTransMatches[0];
        else if (allMatches.length === 1) targetIdx = allMatches[0];
    }

    if (targetIdx === -1) return null;

    const minLevel = Math.min(...ranges.map(r => r.level));
    const counters = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i <= targetIdx; i++) {
        const relLevel = ranges[i].level - minLevel;
        counters[relLevel]++;
        for (let k = relLevel + 1; k < counters.length; k++) counters[k] = 0;
    }
    const relLevel = ranges[targetIdx].level - minLevel;
    const parts = [];
    for (let k = 0; k <= relLevel; k++) parts.push(counters[k] || 1);
    return parts.join('.');
}

// 섹션 텍스트 조각을 원본에 재주입하여 전체 본문 복원
function mergeSectionIntoFull(fullContent, range, newSectionText) {
    const lines = (fullContent || '').split('\n');
    const before = lines.slice(0, range.lineIdx);
    const after = lines.slice(range.endLine);
    // 편집된 섹션 텍스트를 그대로 보존한다.
    // 과거에는 .replace(/\s+$/, '') 로 후행 공백을 제거했는데, 이 경우 사용자가
    // 의도한 두 칸 공백 하드 라인브레이크("foo  \n") 나 섹션 끝의 빈 줄 같은 유효한
    // 마크다운이 조용히 사라져 주변만 편집해도 렌더링이 달라지는 문제가 있었다.
    const section = String(newSectionText || '');
    const merged = before.concat(section.split('\n')).concat(after);
    return merged.join('\n');
}

// ── 다크모드 감지 유틸리티 ──
function getIsDarkMode() {
    const themeAttr = document.documentElement.getAttribute('data-theme');
    if (themeAttr === 'dark') return true;
    if (themeAttr === 'light') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

// ── 커서 위치 기반 드롭다운 포지셔닝 공통 함수 ──
function positionDropdownAtCursor(dropdownEl, dropdownWidth) {
    if (!dropdownEl) return;
    let positioned = false;

    // CM6 좌표 API 우선 사용
    if (window._cmView) {
        const coords = window._cmView.coordsAtPos(window._cmView.state.selection.main.head);
        if (coords) {
            let left = coords.left + window.scrollX;
            let top = coords.bottom + window.scrollY + 4;
            if (left + dropdownWidth > window.innerWidth) left = window.innerWidth - (dropdownWidth + 5);
            if (left < 0) left = 4;
            // 에디터 패인 오른쪽 경계 클리핑: 드롭다운이 프리뷰 영역으로 넘어가지 않도록
            const editorPane = document.getElementById('cm-editor-pane');
            if (editorPane) {
                const paneRight = editorPane.getBoundingClientRect().right + window.scrollX;
                if (left + dropdownWidth > paneRight) {
                    left = Math.max(4, paneRight - dropdownWidth - 4);
                }
            }
            dropdownEl.style.left = `${left}px`;
            dropdownEl.style.top = `${top}px`;
            dropdownEl.style.display = 'block';
            positioned = true;
        }
    }

    // 폴백: window.getSelection()
    if (!positioned) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0).cloneRange();
            range.collapse(true);
            const rect = range.getBoundingClientRect();
            if (rect.height > 0) {
                let left = rect.left + window.scrollX;
                let top = rect.bottom + window.scrollY + 4;
                if (left + dropdownWidth > window.innerWidth) left = window.innerWidth - (dropdownWidth + 5);
                if (left < 0) left = 4;
                dropdownEl.style.left = `${left}px`;
                dropdownEl.style.top = `${top}px`;
                dropdownEl.style.display = 'block';
                positioned = true;
            }
        }
    }

    if (!positioned) {
        const editorEl = document.querySelector('#editor');
        if (editorEl) {
            const rect = editorEl.getBoundingClientRect();
            dropdownEl.style.left = `${rect.left + 50 + window.scrollX}px`;
            dropdownEl.style.top = `${rect.top + 80 + window.scrollY}px`;
            dropdownEl.style.display = 'block';
        }
    }
}

// ── 색상 유틸리티 함수 ──
function hsvToHex(h, s, v) {
    let r, g, b;
    const i = Math.floor(h / 60) % 6;
    const f = h / 60 - Math.floor(h / 60);
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    switch (i) {
        case 0: r = v; g = t; b = p; break;
        case 1: r = q; g = v; b = p; break;
        case 2: r = p; g = v; b = t; break;
        case 3: r = p; g = q; b = v; break;
        case 4: r = t; g = p; b = v; break;
        case 5: r = v; g = p; b = q; break;
    }
    const toHex = (c) => {
        const hex = Math.round(c * 255).toString(16);
        return hex.length === 1 ? '0' + hex : hex;
    };
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hexToHsv(hex) {
    hex = hex.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16) / 255;
    const g = parseInt(hex.substring(2, 4), 16) / 255;
    const b = parseInt(hex.substring(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0, s = max === 0 ? 0 : d / max, v = max;
    if (d !== 0) {
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) * 60; break;
            case g: h = ((b - r) / d + 2) * 60; break;
            case b: h = ((r - g) / d + 4) * 60; break;
        }
    }
    return { h, s, v };
}
