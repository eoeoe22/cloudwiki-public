/**
 * 에디터(public/edit.html / public/blog-edit.html) 의 유틸리티 통합 모듈.
 *
 * 도메인:
 *   - 텍스트 카운터: updateEditorTextCounter / *FromDoc / *FromTextDebounced
 *   - 섹션 범위: findSectionRange / computeSectionNumber / mergeSectionIntoFull
 *   - 다크모드 판정: getIsDarkMode
 *   - 커서 좌표 기반 드롭다운 포지셔닝: positionDropdownAtCursor
 *   - 색상 변환: hsvToHex / hexToHsv
 *   - 에디터 상태 초기화 (window.slug / pageVersion / originalContent / editor / ...)
 *   - 로컬 초안 저장/복구: saveDraftToLocal / readDraftFromLocal / checkDraft /
 *                       checkSectionDrafts / purgeLegacyAutosaveKeys
 *
 * 마이그레이션 노트:
 *   기존 public/js/edit-utils.js 를 두 단계에 걸쳐 ES 모듈로 이전 완료한 결과물.
 *   classic edit-utils.js 는 더 이상 존재하지 않는다.
 *
 * 브리지 (raw script ↔ ESM):
 *   - 출력: 모듈 평가 시점에 함수와 상태를 window.X 로 노출. edit.js /
 *     edit-autocomplete.js / edit-modals.js / edit-conflict.js 등의 bare reference
 *     (예: `hsvToHex(...)`, `editor.getMarkdown()`, `originalContent`) 는 sloppy
 *     모드 글로벌 lookup 으로 window.X 에 도달한다.
 *   - 입력: render.js 의 `_extractMarkdownSectionRanges` (function 선언이라 자동
 *     window 노출), edit.js 가 만드는 `_cmView`, edit-conflict.js 의
 *     `showConflictModal`, edit.js 의 `scrollToBottom` 은 src/client/edit/types.ts
 *     에 선언된 Window 타입을 통해 읽는다. CDN 글로벌 Swal 은 src/client/utils/swal.ts
 *     의 타입을 사용.
 *
 * 모듈 평가 타이밍:
 *   모듈 스크립트는 deferred — 모든 classic top-level 실행 후 / DOMContentLoaded
 *   핸들러 실행 전에 평가된다. 따라서:
 *     - 어떤 raw script 도 top-level 에서 직접 상태(originalContent 등) 를 read 하면
 *       안 된다 (현재 모든 read 는 함수 본문 안에 있어 안전).
 *     - raw script 의 bare assignment(`originalContent = newValue`) 는 sloppy 모드
 *       글로벌 property 쓰기로 동작 — 모든 raw script 에 'use strict' 없음 확인됨.
 */

import { escapeHtml } from '../utils/html';
import './types';
import type { CMView, DraftPayload, SectionRange } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// 텍스트 카운터
// 에디터 하단에 "n줄 n자 n자(공백포함) n단어" 표시.
// Hot path(문서 변경 시) 최적화:
//   1) span 참조를 최초 1회 탐색 후 캐시
//   2) CM6 doc 객체의 cheap 메트릭(lines/length)은 즉시 반영
//   3) 전체 문자열 스캔이 필요한 무공백 자수/단어 수는 디바운스(200ms)
// ─────────────────────────────────────────────────────────────────────────────

interface CounterEls {
    lines: HTMLElement | null;
    chars: HTMLElement | null;
    charsWithSpaces: HTMLElement | null;
    words: HTMLElement | null;
}

interface CMDoc {
    lines: number;
    length: number;
    toString(): string;
}

let counterEls: CounterEls | null = null;
let counterHeavyTimer: ReturnType<typeof setTimeout> | null = null;

function ensureCounterEls(): CounterEls | null {
    if (counterEls) return counterEls;
    const root = document.getElementById('editorTextCounter');
    if (!root) return null;
    counterEls = {
        lines: root.querySelector<HTMLElement>('[data-counter="lines"]'),
        chars: root.querySelector<HTMLElement>('[data-counter="chars"]'),
        charsWithSpaces: root.querySelector<HTMLElement>('[data-counter="charsWithSpaces"]'),
        words: root.querySelector<HTMLElement>('[data-counter="words"]'),
    };
    return counterEls;
}

function fmtCount(n: number): string {
    return n.toLocaleString();
}

function setCheapCounts(els: CounterEls, lines: number, charsWithSpaces: number): void {
    if (els.lines) els.lines.textContent = `${fmtCount(lines)}줄`;
    if (els.charsWithSpaces) els.charsWithSpaces.textContent = `${fmtCount(charsWithSpaces)}자(공백포함)`;
}

function setHeavyCountsFromText(els: CounterEls, str: string): void {
    const chars = str.replace(/\s/g, '').length;
    const trimmed = str.trim();
    const words = trimmed ? trimmed.split(/\s+/).length : 0;
    if (els.chars) els.chars.textContent = `${fmtCount(chars)}자`;
    if (els.words) els.words.textContent = `${fmtCount(words)}단어`;
}

function cancelHeavy(): void {
    if (counterHeavyTimer) {
        clearTimeout(counterHeavyTimer);
        counterHeavyTimer = null;
    }
}

// 문자열 기반 (전체 동기 계산) — 초기 로드, raw textarea, 섹션 전환 등에서 사용
function updateEditorTextCounter(text: string | null | undefined): void {
    const els = ensureCounterEls();
    if (!els) return;
    const str = text == null ? '' : String(text);
    const lines = str.length ? str.split('\n').length : 1;
    cancelHeavy();
    setCheapCounts(els, lines, str.length);
    setHeavyCountsFromText(els, str);
}

// CM6 전용 hot-path: cheap 메트릭은 즉시, heavy 메트릭은 디바운스
function updateEditorTextCounterFromDoc(doc: CMDoc): void {
    const els = ensureCounterEls();
    if (!els) return;
    setCheapCounts(els, doc.lines, doc.length);
    cancelHeavy();
    counterHeavyTimer = setTimeout(() => {
        counterHeavyTimer = null;
        setHeavyCountsFromText(els, doc.toString());
    }, 200);
}

// raw textarea hot-path: cheap 메트릭은 즉시, heavy 메트릭은 디바운스
// (익스텐션 데이터는 대용량이므로 키스트로크마다 regex/split 전체 스캔 회피)
function updateEditorTextCounterFromTextDebounced(text: string | null | undefined): void {
    const els = ensureCounterEls();
    if (!els) return;
    const str = text == null ? '' : String(text);
    const lines = str.length ? str.split('\n').length : 1;
    setCheapCounts(els, lines, str.length);
    cancelHeavy();
    counterHeavyTimer = setTimeout(() => {
        counterHeavyTimer = null;
        setHeavyCountsFromText(els, str);
    }, 200);
}

// ─────────────────────────────────────────────────────────────────────────────
// 섹션 편집 유틸
// ─────────────────────────────────────────────────────────────────────────────

// 전체 본문에서 section 인덱스 + 헤딩 텍스트로 해당 섹션 범위 탐색.
// 1) 인덱스가 유효하고 headingText 일치 → 그대로 반환
// 2) 인덱스는 무효하지만 headingText가 유일하게 매칭되면 그 섹션 반환
// 3) 실패 시 null
function findSectionRange(fullContent: string, idx: number, expectedHeading: string): SectionRange | null {
    const fn = window._extractMarkdownSectionRanges;
    if (typeof fn !== 'function') return null;
    const ranges = fn(fullContent || '');
    if (!ranges.length) return null;

    const normalize = (s: string | null | undefined): string => (s || '').trim();
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
// render.js 의 numberHeadings() 와 동일한 카운터 로직을 복제해 열람 페이지의
// s-X.Y 앵커 ID 와 1:1 로 매칭되는 번호를 생성한다.
//
// 중요: sectionIndex 는 섹션 편집 링크(render.js 의 _addHeadingCopyButtons)
// 에서 **원본(raw) 헤딩 순서** 즉 transclusion 으로 주입되지 않은 헤딩만
// 0-based 로 센 인덱스다. 반면 열람 페이지의 s-X.Y 앵커는 transclusion 전개
// 이후의 전체 헤딩 순서로 번호가 매겨지므로, 전달받은 ranges(resolveTransclusions
// 결과에서 추출) 에서 idx 를 그대로 쓰면 문서 앞쪽에 transcluded 헤딩이
// 존재할 때 엉뚱한 섹션을 가리킨다. 따라서 ranges 의 non-transcluded 엔트리
// 만 세어 idx 번째 위치를 찾아낸 뒤 번호 계산에 사용한다.
function computeSectionNumber(fullContent: string, idx: number, expectedHeading: string): string | null {
    const fn = window._extractMarkdownSectionRanges;
    if (typeof fn !== 'function') return null;
    const ranges = fn(fullContent || '');
    if (!ranges.length) return null;

    const normalize = (s: string | null | undefined): string => (s || '').trim();
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
        const nonTransMatches: number[] = [];
        const allMatches: number[] = [];
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
    const parts: number[] = [];
    for (let k = 0; k <= relLevel; k++) parts.push(counters[k] || 1);
    return parts.join('.');
}

// 섹션 텍스트 조각을 원본에 재주입하여 전체 본문 복원
function mergeSectionIntoFull(
    fullContent: string,
    range: { lineIdx: number; endLine: number },
    newSectionText: string,
): string {
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

// ─────────────────────────────────────────────────────────────────────────────
// 다크모드 감지
// ─────────────────────────────────────────────────────────────────────────────

function getIsDarkMode(): boolean {
    const themeAttr = document.documentElement.getAttribute('data-theme');
    if (themeAttr === 'dark') return true;
    if (themeAttr === 'light') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

// ─────────────────────────────────────────────────────────────────────────────
// 커서 위치 기반 드롭다운 포지셔닝
// ─────────────────────────────────────────────────────────────────────────────

function positionDropdownAtCursor(dropdownEl: HTMLElement | null, dropdownWidth: number): void {
    if (!dropdownEl) return;
    let positioned = false;

    // CM6 좌표 API 우선 사용
    const cm: CMView | undefined = window._cmView;
    if (cm) {
        const coords = cm.coordsAtPos(cm.state.selection.main.head);
        if (coords) {
            let left = coords.left + window.scrollX;
            const top = coords.bottom + window.scrollY + 4;
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
                const top = rect.bottom + window.scrollY + 4;
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
        const editorEl = document.querySelector<HTMLElement>('#editor');
        if (editorEl) {
            const rect = editorEl.getBoundingClientRect();
            dropdownEl.style.left = `${rect.left + 50 + window.scrollX}px`;
            dropdownEl.style.top = `${rect.top + 80 + window.scrollY}px`;
            dropdownEl.style.display = 'block';
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 색상 유틸리티
// ─────────────────────────────────────────────────────────────────────────────

function hsvToHex(h: number, s: number, v: number): string {
    let r = 0;
    let g = 0;
    let b = 0;
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
    const toHex = (c: number): string => {
        const hex = Math.round(c * 255).toString(16);
        return hex.length === 1 ? '0' + hex : hex;
    };
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hexToHsv(hex: string): { h: number; s: number; v: number } {
    const cleaned = hex.replace('#', '');
    const r = parseInt(cleaned.substring(0, 2), 16) / 255;
    const g = parseInt(cleaned.substring(2, 4), 16) / 255;
    const b = parseInt(cleaned.substring(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    const s = max === 0 ? 0 : d / max;
    const v = max;
    if (d !== 0) {
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) * 60; break;
            case g: h = ((b - r) / d + 2) * 60; break;
            case b: h = ((r - g) / d + 4) * 60; break;
        }
    }
    return { h, s, v };
}

// ─────────────────────────────────────────────────────────────────────────────
// 에디터 상태 초기화
// 모든 에디터 상태를 window.X 로 노출한다. classic raw script 들의 bare reference
// (read/write) 는 sloppy 모드 글로벌 lookup 을 거쳐 동일 프로퍼티에 도달한다.
//
// `??=` 로 초기화하여, 만에 하나 다른 곳에서 이미 세팅된 값이 있다면 덮어쓰지 않는다
// (현재 코드에서는 그런 경로가 없지만 방어적).
// ─────────────────────────────────────────────────────────────────────────────

window.slug ??= null;
window.pageVersion ??= null;
window.DRAFT_KEY ??= '';
window.originalContent ??= '';
// edit.html / blog-edit.html 에는 <div id="editor"> 가 있어, own 프로퍼티가
// 세팅되기 전 `window.editor` 는 "named access on the Window object" 정책에
// 따라 HTMLDivElement 를 반환한다. 이 div 는 truthy 이므로 `??=` 가 발동하지
// 않아 window.editor 가 div 로 계속 노출되는데, 다른 모듈이 truthy 만으로
// "에디터 shim 준비 완료" 로 오인하는 결정적 버그가 발생한다 (autocomplete
// 에서 _autocompleteAttached 가 잘못 true 로 굳던 문제). 진짜 shim 이 아닌
// 경우(=`.on` 메서드가 없는 경우) own 프로퍼티 null 로 정규화해 named access
// 를 영구히 가린다.
if (!window.editor || typeof (window.editor as { on?: unknown }).on !== 'function') {
    window.editor = null;
}
window.conflictEditor ??= null;
window.serverViewMode ??= 'raw';
window.serverViewer ??= null;
window.cachedDiffData ??= null;
window.diffViewMode ??= 'summary';
window.pageLeft ??= false;
window.isExtensionData ??= false;
window.sectionMode ??= false;
window.sectionIndex ??= -1;
window.sectionHeadingParam ??= '';
window.fullOriginalContent ??= '';
window.sectionRange ??= null;
window.originalPageMeta ??= null;

// ─────────────────────────────────────────────────────────────────────────────
// 로컬 초안 저장/복구 (수동)
// 사용자가 "초안 저장" 버튼을 눌렀을 때만 현재 본문을 localStorage 에 저장한다.
// 저장 시 함께 보관: 초안 본문 / 그 시점의 문서 버전 / 그 시점의 base(originalContent).
// base 는 나중에 불러올 때 서버 최신본과의 충돌 해결 UI 의 base 로 재사용된다.
// ─────────────────────────────────────────────────────────────────────────────

function saveDraftToLocal(): boolean {
    const editor = window.editor;
    const slug = window.slug;
    const draftKey = window.DRAFT_KEY;
    if (!editor || !slug || !draftKey) return false;
    const content = editor.getMarkdown();
    if (!content || !content.trim()) {
        window.Swal?.fire({
            icon: 'info',
            title: '저장할 내용이 없습니다',
            timer: 1200,
            showConfirmButton: false,
        });
        return false;
    }
    const pageVersion = window.pageVersion;
    const originalContent = window.originalContent;
    const payload: DraftPayload = {
        content,
        version: (typeof pageVersion === 'number' || typeof pageVersion === 'string') ? pageVersion : null,
        base: typeof originalContent === 'string' ? originalContent : '',
        savedAt: Date.now(),
    };
    if (window.sectionMode) {
        payload.sectionIndex = window.sectionIndex;
        payload.sectionHeading = (window.sectionRange && window.sectionRange.headingText) || window.sectionHeadingParam || '';
    }
    try {
        localStorage.setItem(draftKey, JSON.stringify(payload));
        window.Swal?.fire({
            icon: 'success',
            title: '초안 저장됨',
            text: '이 브라우저에 임시 저장했습니다.',
            toast: true,
            position: 'top-end',
            timer: 1500,
            showConfirmButton: false,
        });
        return true;
    } catch {
        window.Swal?.fire({
            icon: 'error',
            title: '초안 저장 실패',
            text: '브라우저 저장소에 기록할 수 없습니다. (용량 초과 가능성)',
        });
        return false;
    }
}

// 저장된 초안을 읽어 정규화한다. 손상된 데이터는 null 반환.
function readDraftFromLocal(): DraftPayload | null {
    const draftKey = window.DRAFT_KEY;
    if (!draftKey) return null;
    const raw = localStorage.getItem(draftKey);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<DraftPayload> | null;
        if (parsed && typeof parsed.content === 'string') {
            return {
                content: parsed.content,
                version: ('version' in parsed) ? (parsed.version ?? null) : null,
                base: typeof parsed.base === 'string' ? parsed.base : null,
                savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : null,
                sectionIndex: typeof parsed.sectionIndex === 'number' ? parsed.sectionIndex : undefined,
                sectionHeading: typeof parsed.sectionHeading === 'string' ? parsed.sectionHeading : undefined,
            };
        }
    } catch {
        // JSON 이 아니면 손상된 잔여 데이터 — 무시하고 정리
    }
    localStorage.removeItem(draftKey);
    return null;
}

// 페이지 진입 시 저장된 초안 처리:
//  1) 본문 동일 → 조용히 삭제
//  2) 버전이 그대로 → 단순 불러오기 확인
//  3) 버전이 변경됨 → 경고 후 확인 시 충돌 해결 UI 진입
async function checkDraft(): Promise<void> {
    const draftKey = window.DRAFT_KEY;
    if (!draftKey) return;
    const draft = readDraftFromLocal();
    if (!draft) return;

    const currentBase = typeof window.originalContent === 'string' ? window.originalContent : '';

    // 본문이 서버 최신본과 동일하면 의미 없음 — 정리
    if (draft.content.trim() === currentBase.trim()) {
        localStorage.removeItem(draftKey);
        return;
    }

    // 버전 비교: 초안 저장 시점 이후 서버에서 바뀌었는지
    const draftVer = draft.version;
    const pv = window.pageVersion;
    const curVer: number | string | null = (typeof pv === 'number' || typeof pv === 'string') ? pv : null;
    // 버전 정보가 양쪽 다 존재하고 다를 때만 "변경됨" 으로 간주.
    // (한쪽이 null 이면 비교 불가 → 안전하게 변경된 것으로 처리)
    const versionChanged = draftVer == null || curVer == null
        ? (draftVer !== curVer)
        : String(draftVer) !== String(curVer);

    const swal = window.Swal;
    if (!swal) return; // Swal 미로드 (방어적 — edit.html / blog-edit.html 양쪽 모두 CDN 로드)

    if (versionChanged) {
        const result = await swal.fire({
            title: '문서가 그 사이 편집되었습니다',
            text: '마지막으로 초안을 저장한 이후 문서가 편집되었습니다. 초안을 불러오시겠습니까?',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: '예, 불러오기 (충돌 해결)',
            cancelButtonText: '아니오, 초안 삭제',
        });
        if (!result.isConfirmed) {
            localStorage.removeItem(draftKey);
            return;
        }

        // 섹션 편집 페이지에서 발생한 version conflict 는 section-scope 가 아니라
        // full-doc-scope 로 처리한다. 이유:
        //   1) 사용자에게 표시되는 conflict UI 가 전체 문서를 보여줘 변경 컨텍스트
        //      (다른 편집자가 어떤 섹션을 바꿨는지) 를 인지할 수 있다.
        //   2) 후속 저장은 section-mode 를 끈 상태에서 editor.getMarkdown() 을 그대로
        //      서버로 보내므로, sectionMode/sectionRange/fullOriginalContent 의 어떤
        //      상태가 손상되더라도 섹션 텍스트만 저장되어 나머지 본문이 손실되는
        //      회귀가 원천 차단된다.
        //   3) savePage 의 section-mode 409 핸들러와 동일한 패턴을 따라 한 곳에서만
        //      promotion 로직을 검증·유지한다.
        const inSectionMode = !!window.sectionMode;
        const sRange = window.sectionRange;
        const fullOriginal = typeof window.fullOriginalContent === 'string' ? window.fullOriginalContent : '';
        const mergeFn = window.mergeSectionIntoFull;

        if (inSectionMode && sRange && fullOriginal && typeof mergeFn === 'function') {
            // 3-way (full-doc-scope):
            //   base   = 현재 full doc 의 해당 섹션 자리에 draft.base 를 끼워 넣은 가상 doc
            //   ours   = 현재 full doc 의 해당 섹션 자리에 draft.content 를 끼워 넣은 doc
            //   theirs = 현재 full doc (= fullOriginal)
            const draftBase = typeof draft.base === 'string' ? draft.base : currentBase;
            const mergedBase = mergeFn(fullOriginal, sRange, draftBase);
            const mergedOurs = mergeFn(fullOriginal, sRange, draft.content);
            const mergedTheirs = fullOriginal;

            // section-mode UI 정리 — savePage 의 409 핸들러와 동일.
            const banner = document.getElementById('sectionEditBanner');
            if (banner) { banner.classList.add('d-none'); banner.classList.remove('d-flex'); }
            const lockedFields = [
                document.getElementById('titleInput'),
                document.getElementById('categoryInput'),
                document.getElementById('redirectInput'),
            ];
            lockedFields.forEach(el => {
                if (el) {
                    const wrapper = el.closest('.mb-3') || el.closest('.row');
                    if (wrapper) (wrapper as HTMLElement).style.display = '';
                }
            });
            // 잠금/비공개 토글은 에디터에서 제거됨 (권한 관리 모달이 처리) — 별도 DOM 복원 불필요.

            // window 상태를 full-edit mode 로 전환. main.ts 는 await 직후
            // syncStateFromWindow() 로 이 변경을 로컬 변수에 반영한다.
            window.sectionMode = false;
            window.sectionRange = null;
            window.sectionIndex = -1;
            if (typeof window.slug === 'string') {
                window.DRAFT_KEY = 'wiki_draft_' + window.slug;
            }
            window.editor?.setMarkdown(mergedOurs);
            window.scrollToBottom?.();
            window.originalContent = mergedBase;

            // 초안 키 자체는 그대로 둔다. 사용자가 conflict UI 를 취소/새로고침/이탈하면
            // 다음 진입 시 같은 흐름이 재시도되어야 데이터 손실이 없기 때문.
            // 다만 savePage 성공 경로가 정리할 수 있도록 "promoted-from" 키를 기록한다
            // (promotion 후엔 DRAFT_KEY 가 full key 로 바뀌어 원래 section key 가
            // 자동 정리되지 않음).
            window.promotedFromDraftKey = draftKey;

            window.showConflictModal?.({ current_version: curVer, content: mergedTheirs });
            return;
        }

        // 일반(full edit) 경로 — 초안 + 서버 최신본을 충돌 해결 UI 로 넘긴다.
        //  - editor 본문 = 초안 (ours)
        //  - originalContent = 초안의 base (3-way merge 의 base)
        //  - showConflictModal({ current_version, content }) 의 content = 현재 서버 최신본 (theirs)
        const theirs = currentBase;
        const theirsVersion = curVer;
        window.editor?.setMarkdown(draft.content);
        window.scrollToBottom?.();
        // base 가 누락된 레거시 초안은 현재 서버 최신본을 base 로 사용 (보수적 fallback).
        window.originalContent = (typeof draft.base === 'string') ? draft.base : currentBase;
        // 초안은 충돌 해결 후 저장 시점에 정리된다(savePage 성공 경로).
        window.showConflictModal?.({ current_version: theirsVersion, content: theirs });
        return;
    }

    // 버전 동일 → 평소처럼 불러오기 여부만 확인
    const result = await swal.fire({
        title: '저장된 초안이 있습니다',
        text: '이전에 저장한 초안을 불러오시겠습니까?',
        icon: 'info',
        showCancelButton: true,
        confirmButtonText: '예, 불러오기',
        cancelButtonText: '아니오, 삭제',
    });

    if (result.isConfirmed) {
        window.editor?.setMarkdown(draft.content);
        window.scrollToBottom?.();
        await swal.fire({
            icon: 'success',
            title: '불러옴',
            text: '저장된 초안을 불러왔습니다.',
            toast: true,
            position: 'top-end',
            timer: 1500,
            showConfirmButton: false,
        });
    } else {
        localStorage.removeItem(draftKey);
    }
}

// 전체 문서 편집으로 진입했을 때, 같은 슬러그의 섹션 편집 초안이
// localStorage 에 남아 있으면 사용자에게 불러올지 묻는다.
// 키 포맷: 'wiki_draft_{slug}#section={N}' — saveDraftToLocal 이 sectionMode 일 때
// sectionIndex / sectionHeading 도 함께 기록한다.
async function checkSectionDrafts(): Promise<void> {
    const slug = window.slug;
    if (!slug || window.sectionMode || window.isExtensionData) return;
    const editor = window.editor;
    if (!editor || typeof editor.getMarkdown !== 'function') return;
    // 충돌 해결 UI 가 열려 있으면 건너뛴다.
    // checkDraft 가 버전 충돌 분기에서 showConflictModal 을 띄우면 메인 에디터는 숨겨지고,
    // 사용자가 충돌을 해결할 때 resolveConflict 가 conflictEditor 의 내용으로 메인 에디터를
    // 덮어쓴다. 이 시점에 섹션 초안을 메인 에디터에 setMarkdown 해도 곧 사라지므로 스킵.
    const conflictUi = document.getElementById('conflict-ui');
    if (conflictUi && conflictUi.style.display !== 'none' && conflictUi.offsetParent !== null) return;

    const prefix = 'wiki_draft_' + slug + '#section=';
    const keys: string[] = [];
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(prefix)) keys.push(k);
        }
    } catch {
        return;
    }
    if (!keys.length) return;

    const swal = window.Swal;
    if (!swal) return;

    for (const key of keys) {
        let draft: { content: string; sectionIndex?: number; sectionHeading?: string } | null = null;
        try {
            const raw = localStorage.getItem(key);
            if (!raw) continue;
            draft = JSON.parse(raw);
        } catch {
            localStorage.removeItem(key);
            continue;
        }
        if (!draft || typeof draft.content !== 'string') {
            localStorage.removeItem(key);
            continue;
        }

        const sIdxRaw = (typeof draft.sectionIndex === 'number')
            ? draft.sectionIndex
            : parseInt(key.substring(prefix.length), 10);
        const sIdx = Number.isFinite(sIdxRaw) ? sIdxRaw : -1;
        const sHeading = typeof draft.sectionHeading === 'string' ? draft.sectionHeading : '';

        // 에디터의 현재 본문 기준으로 섹션을 찾는다 — checkDraft 가 먼저 전체 초안을
        // 불러와 에디터 내용을 바꿨을 수도 있으므로 originalContent 가 아닌 editor 기준이 안전하다.
        const baseContent = editor.getMarkdown();
        const range: SectionRange | null = findSectionRange(baseContent, sIdx, sHeading);
        const headingDisplay = (range && range.headingText) || sHeading || `섹션 #${sIdx + 1}`;

        // 현재 본문의 해당 섹션 텍스트와 초안이 동일하면 의미 없음 — 정리
        if (range) {
            const lines = baseContent.split('\n');
            const currentSection = lines.slice(range.lineIdx, range.endLine).join('\n');
            if (currentSection.trim() === draft.content.trim()) {
                localStorage.removeItem(key);
                continue;
            }
        }

        if (!range) {
            const result = await swal.fire({
                title: '섹션 위치를 찾지 못했습니다',
                html: `<b>${escapeHtml(headingDisplay)}</b> 섹션의 저장된 초안이 있지만 문서 구조가 변경되어 위치를 찾을 수 없습니다.`,
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: '초안 삭제',
                cancelButtonText: '나중에',
            });
            if (result.isConfirmed) localStorage.removeItem(key);
            continue;
        }

        const result = await swal.fire({
            title: '저장된 섹션 초안',
            html: `<b>${escapeHtml(headingDisplay)}</b> 에 저장된 초안이 있습니다.<br>본문에 불러오시겠습니까?`,
            icon: 'info',
            showCancelButton: true,
            showDenyButton: true,
            confirmButtonText: '예, 불러오기',
            denyButtonText: '아니오, 삭제',
            cancelButtonText: '나중에',
        });

        if (result.isConfirmed) {
            const merged = mergeSectionIntoFull(baseContent, range, draft.content);
            editor.setMarkdown(merged);
            localStorage.removeItem(key);
            await swal.fire({
                icon: 'success',
                title: '불러옴',
                text: `'${headingDisplay}' 섹션 초안을 본문에 병합했습니다.`,
                toast: true,
                position: 'top-end',
                timer: 1500,
                showConfirmButton: false,
            });
        } else if (result.isDenied) {
            localStorage.removeItem(key);
        }
    }
}

// 과거 자동저장이 남긴 wiki_autosave_* 키를 일회성으로 정리한다.
// (오토세이브 기능 자체가 제거되었으므로 더 이상 의미 없음)
function purgeLegacyAutosaveKeys(): void {
    try {
        const toRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('wiki_autosave_')) toRemove.push(k);
        }
        toRemove.forEach(k => localStorage.removeItem(k));
        // 사용자 토글 설정도 정리
        localStorage.removeItem('editor_auto_save');
    } catch {
        // localStorage 접근 불가 환경(Privacy 모드 등)은 무시
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 브리지: classic 스크립트(edit.js / edit-autocomplete.js / edit-modals.js /
// edit-conflict.js) 가 bare reference 또는 typeof 가드로 호출하므로 window 에 노출.
// 모듈은 deferred 라서 이 시점은 모든 classic top-level 실행 후 / 어떤
// DOMContentLoaded 핸들러보다 앞이다.
// edit.html 의 인라인 onclick="saveDraftToLocal()" 도 여기에 의존한다.
// ─────────────────────────────────────────────────────────────────────────────

declare global {
    interface Window {
        updateEditorTextCounter?: typeof updateEditorTextCounter;
        updateEditorTextCounterFromDoc?: typeof updateEditorTextCounterFromDoc;
        updateEditorTextCounterFromTextDebounced?: typeof updateEditorTextCounterFromTextDebounced;
        findSectionRange?: typeof findSectionRange;
        computeSectionNumber?: typeof computeSectionNumber;
        mergeSectionIntoFull?: typeof mergeSectionIntoFull;
        getIsDarkMode?: typeof getIsDarkMode;
        positionDropdownAtCursor?: typeof positionDropdownAtCursor;
        hsvToHex?: typeof hsvToHex;
        hexToHsv?: typeof hexToHsv;
        saveDraftToLocal?: typeof saveDraftToLocal;
        readDraftFromLocal?: typeof readDraftFromLocal;
        checkDraft?: typeof checkDraft;
        checkSectionDrafts?: typeof checkSectionDrafts;
        purgeLegacyAutosaveKeys?: typeof purgeLegacyAutosaveKeys;
    }
}

window.updateEditorTextCounter = updateEditorTextCounter;
window.updateEditorTextCounterFromDoc = updateEditorTextCounterFromDoc;
window.updateEditorTextCounterFromTextDebounced = updateEditorTextCounterFromTextDebounced;
window.findSectionRange = findSectionRange;
window.computeSectionNumber = computeSectionNumber;
window.mergeSectionIntoFull = mergeSectionIntoFull;
window.getIsDarkMode = getIsDarkMode;
window.positionDropdownAtCursor = positionDropdownAtCursor;
window.hsvToHex = hsvToHex;
window.hexToHsv = hexToHsv;
window.saveDraftToLocal = saveDraftToLocal;
window.readDraftFromLocal = readDraftFromLocal;
window.checkDraft = checkDraft;
window.checkSectionDrafts = checkSectionDrafts;
window.purgeLegacyAutosaveKeys = purgeLegacyAutosaveKeys;

console.log('[edit/utils] module loaded');
