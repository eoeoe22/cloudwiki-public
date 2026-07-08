/**
 * 문법 치트시트 (Syntax cheatsheet) — 제안 G-5.
 *
 * 기억나지 않는 위키 문법 토큰/블록을 **이름·용도로 검색해 커서 위치에 삽입**하는
 * 경량 검색 모달. 커맨드 팔레트(Cmd/Ctrl+K)의 "문법 치트시트" 액션과 에디터 툴바
 * 버튼(edit/main.ts 가 추가)이 진입점이며, 두 진입점 모두 `window.openSyntaxCheatsheet()`
 * 를 호출한다.
 *
 * 모달 DOM/CSS 는 커맨드 팔레트와 동일하게 첫 오픈 시 동적 주입한다(별도 CSS 파일/셸
 * 링크 불필요). 삽입은 CM6 `window._cmView` 를 직접 사용해 선택 범위를 스니펫으로
 * 교체하고, 스니펫 내 커서 센티넬('') 위치로 캐럿을 옮긴다.
 *
 * 카탈로그는 렌더러(render.ts)가 실제로 지원하는 어휘만 담는다 — 없는 문법을 넣어
 * "삽입은 되는데 렌더가 안 되는" 상태를 만들지 않는다.
 */

import './types';
import { escapeHtml } from '../utils/html';

// 삽입 후 커서를 놓을 위치를 표시하는 센티넬(삽입 전 제거).
const CARET = '';

interface CheatEntry {
    /** 표시 이름 */
    label: string;
    /** 용도 설명 */
    desc: string;
    /** 검색 키워드(라벨/설명 외 추가 매칭 어휘) */
    keywords: string;
    /** 삽입 스니펫(CARET 로 커서 위치 지정) */
    insert: string;
    /** 미리보기용 문법 표기(모노스페이스) */
    syntax: string;
}

interface CheatSection {
    title: string;
    entries: CheatEntry[];
}

// ── 문법 카탈로그 ──────────────────────────────────────────────────────────
const CATALOG: CheatSection[] = [
    {
        title: '텍스트 서식',
        entries: [
            { label: '굵게', desc: '강조(볼드)', keywords: 'bold strong 볼드 굵게', syntax: '**텍스트**', insert: `**${CARET}**` },
            { label: '기울임', desc: '이탤릭', keywords: 'italic emphasis 이탤릭 기울임', syntax: '*텍스트*', insert: `*${CARET}*` },
            { label: '밑줄', desc: '밑줄', keywords: 'underline 밑줄', syntax: '__텍스트__', insert: `__${CARET}__` },
            { label: '취소선', desc: '취소선', keywords: 'strike 취소선 삭제', syntax: '~~텍스트~~', insert: `~~${CARET}~~` },
            { label: '형광펜', desc: '배경 강조 — 색 토큰({bg:} 등) 선행 필요', keywords: 'highlight mark 형광펜 하이라이트 배경 강조 형식', syntax: '{bg:색}==텍스트==', insert: `{bg:${CARET}}==텍스트==` },
            { label: '제목', desc: 'ATX 헤딩(개수로 레벨)', keywords: 'heading h2 h3 제목 헤딩', syntax: '## 제목', insert: `## ${CARET}` },
            { label: '인라인 코드', desc: '코드 스팬', keywords: 'code inline 코드', syntax: '`코드`', insert: '`' + CARET + '`' },
            { label: '헤딩 접기', desc: '해당 섹션을 기본 접힘으로', keywords: 'collapse fold 접기 헤딩', syntax: '## 제목 {collapse}', insert: `## ${CARET} {collapse}` },
        ],
    },
    {
        title: '색 · 팔레트 · 크기',
        entries: [
            { label: '배경색', desc: '형광펜/컴포넌트 배경색', keywords: 'bg background 배경 색', syntax: '{bg:#RRGGBB}', insert: `{bg:${CARET}}` },
            { label: '글자색', desc: '형광펜/컴포넌트 글자색', keywords: 'color 글자 색', syntax: '{color:#RRGGBB}', insert: `{color:${CARET}}` },
            { label: '팔레트', desc: '빌트인/커스텀 팔레트 색', keywords: 'palette 팔레트 테마 색', syntax: '{palette:primary}', insert: `{palette:${CARET}}` },
            { label: '글자 크기', desc: '글자 크기 (xs·sm·lg·xl·xxl)', keywords: 'fs fontsize 크기 글자', syntax: '{fs:lg}', insert: `{fs:${CARET}}` },
        ],
    },
    {
        title: '아이콘 · 컴포넌트',
        entries: [
            { label: 'Bootstrap 아이콘', desc: 'bi 아이콘', keywords: 'bi bootstrap icon 아이콘', syntax: '{bi:star}', insert: `{bi:${CARET}}` },
            { label: 'MDI 아이콘', desc: 'Material Design 아이콘', keywords: 'mdi material icon 아이콘', syntax: '{mdi:home}', insert: `{mdi:${CARET}}` },
            { label: '배지', desc: '작은 라벨 칩', keywords: 'badge 배지 라벨', syntax: '{badge:텍스트}', insert: `{badge:${CARET}}` },
            { label: '태그', desc: '태그 칩', keywords: 'tag 태그', syntax: '{tag:텍스트}', insert: `{tag:${CARET}}` },
            { label: '버튼', desc: '링크/내부이동 버튼', keywords: 'button 버튼 링크', syntax: '{button:텍스트|[[문서]]}', insert: `{button:${CARET}|[[문서]]}` },
            { label: '통계 수치', desc: '수치 강조 블록', keywords: 'stat 통계 수치', syntax: '{stat:123|라벨}', insert: `{stat:${CARET}|라벨}` },
            { label: '키보드 키', desc: 'kbd 키 표기', keywords: 'kbd keyboard 키보드', syntax: '{kbd:Ctrl+C}', insert: `{kbd:${CARET}}` },
            { label: '진행도 바', desc: '진행률(숫자 또는 auto)', keywords: 'progress 진행 바', syntax: '{progress:70}', insert: `{progress:${CARET}}` },
        ],
    },
    {
        title: '링크 · 틀 · 각주',
        entries: [
            { label: '위키 링크', desc: '문서/섹션 링크', keywords: 'link wikilink 링크 문서', syntax: '[[문서#섹션]]', insert: `[[${CARET}]]` },
            { label: '틀 트랜스클루전', desc: '틀 문서 포함', keywords: 'template transclusion 틀', syntax: '{{틀이름}}', insert: `{{${CARET}}}` },
            { label: '틀 파라미터', desc: '틀 안 파라미터 참조', keywords: 'param parameter 파라미터', syntax: '{{{이름|기본값}}}', insert: `{{{${CARET}}}}` },
            { label: '조건문 #if', desc: '파서 함수 분기', keywords: 'if 조건 parser 파서', syntax: '{{#if:조건|참|거짓}}', insert: `{{#if:${CARET}|참|거짓}}` },
            { label: '분기 #switch', desc: '값별 분기', keywords: 'switch 분기 parser', syntax: '{{#switch:값|키=결과|#default=기본}}', insert: `{{#switch:${CARET}|키=결과|#default=기본}}` },
            { label: '산술 #expr', desc: '사칙연산', keywords: 'expr 계산 산술 parser', syntax: '{{#expr:1 + 2}}', insert: `{{#expr:${CARET}}}` },
            { label: '각주', desc: '이름 있는 각주 정의', keywords: 'footnote 각주 주석', syntax: '[*이름 내용]', insert: `[*${CARET} 내용]` },
        ],
    },
    {
        title: '이미지 · 임베드',
        entries: [
            { label: '이미지', desc: '이미지 삽입', keywords: 'image img 이미지 사진', syntax: '![alt](URL)', insert: `![${CARET}]()` },
            { label: '이미지 크기', desc: '이미지 뒤 크기 토큰', keywords: 'size 크기 이미지', syntax: '{size:medium}', insert: `{size:${CARET}}` },
            { label: '이미지 정렬', desc: '이미지 뒤 정렬 토큰', keywords: 'align 정렬 이미지', syntax: '{align:center}', insert: `{align:${CARET}}` },
            { label: '이미지 캡션', desc: '이미지 뒤 캡션 토큰', keywords: 'caption 캡션 설명 이미지', syntax: '{caption:설명}', insert: `{caption:${CARET}}` },
            { label: '미디어 임베드', desc: 'YouTube·니코동·Spotify·지도 삽입', keywords: 'embed 임베드 youtube spotify 니코동 지도 미디어 영상 음악', syntax: '{embed:URL}', insert: `{embed:${CARET}}` },
            { label: '임베드 크기', desc: '임베드 뒤 크기 토큰(가운데 정렬)', keywords: 'size 크기 임베드 embed', syntax: '{embed:URL}{size:small}', insert: `{embed:URL}{size:${CARET}}` },
        ],
    },
    {
        title: '표 옵션',
        entries: [
            { label: '표 정렬', desc: '표 바로 윗줄 정렬 토큰', keywords: 'table align 표 정렬', syntax: '{table:center}', insert: `{table:${CARET}}` },
            { label: '표 너비', desc: '표/열 너비(10% 단위)', keywords: 'width 너비 표 w', syntax: '{w:50%}', insert: `{w:${CARET}}` },
            { label: '표 캡션', desc: '<caption> 제목', keywords: 'caption 표 제목', syntax: '{caption:제목}', insert: `{caption:${CARET}}` },
            { label: '헤더 고정', desc: '세로 스크롤 시 헤더 고정', keywords: 'sticky header 고정 헤더', syntax: '{sticky-header}', insert: '{sticky-header}' },
            { label: '정렬 가능 표', desc: '헤더 클릭 정렬', keywords: 'sortable 정렬 표', syntax: '{sortable}', insert: '{sortable}' },
            { label: '행 헤더', desc: '첫 열을 세로 헤더로', keywords: 'row-header 행 헤더', syntax: '{row-header}', insert: '{row-header}' },
        ],
    },
    {
        title: '시간',
        entries: [
            { label: 'D-Day', desc: '남은/지난 날짜', keywords: 'dday 디데이 날짜', syntax: '{dday:2026-01-01}', insert: `{dday:${CARET}}` },
            { label: '표시 시간', desc: '유닉스 시각 표시', keywords: 'time 시간 시각', syntax: '{time:1735689600}', insert: `{time:${CARET}}` },
            { label: '타이머', desc: '카운트다운', keywords: 'timer 타이머 카운트다운', syntax: '{timer:1735689600}', insert: `{timer:${CARET}}` },
            { label: '만 나이', desc: '생년월일 → 만 나이', keywords: 'age 나이', syntax: '{age:2000-01-01}', insert: `{age:${CARET}}` },
            { label: '캘린더 날짜', desc: '날짜 표기', keywords: 'calendar 달력 날짜', syntax: '{calendar:2026-01-01}', insert: `{calendar:${CARET}}` },
        ],
    },
    {
        title: '블록 (:::)',
        entries: [
            { label: '카드', desc: '제목 + 본문 박스', keywords: 'card 카드', syntax: ':::card', insert: `:::card ${CARET}\n\n:::` },
            { label: '그리드', desc: '격자 배치({cols:N}/{template:})', keywords: 'grid 그리드 격자', syntax: ':::grid {cols:2}', insert: `:::grid {cols:2}\n${CARET}\n\n:::` },
            { label: '캔버스', desc: '12컬럼 비대칭 배치(자식 :::area)', keywords: 'canvas 캔버스 레이아웃 12', syntax: ':::canvas', insert: `:::canvas {gap:md}\n:::area {span:8} {panel}\n${CARET}\n:::\n:::area {span:4} {panel}\n\n:::\n:::` },
            { label: '인포박스', desc: '옆을 감싸는 프로필 카드', keywords: 'infobox 인포박스 프로필', syntax: ':::infobox', insert: `:::infobox {right} {span:4} ${CARET}\n| 이름 | 값 |\n| 이름 | 값 |\n\n:::` },
            { label: '플로팅 패널', desc: '본문이 옆을 감싸는 좌/우 패널', keywords: 'float 플로팅 패널', syntax: ':::float {right} {span:4}', insert: `:::float {right} {span:4}\n${CARET}\n\n:::` },
            { label: '갤러리', desc: '이미지 균등 그리드', keywords: 'gallery 갤러리 이미지', syntax: ':::gallery {cols:3}', insert: `:::gallery {cols:3}\n![](${CARET})\n![]()\n:::` },
            { label: '탭', desc: '탭 컨테이너(자식 :::tab)', keywords: 'tabs tab 탭', syntax: ':::tabs', insert: `:::tabs\n:::tab 탭 1\n${CARET}내용\n:::\n:::tab 탭 2\n내용\n:::\n:::` },
            { label: '아코디언', desc: '접이식 항목(자식 :::item)', keywords: 'accordion 아코디언 접기', syntax: ':::accordion', insert: `:::accordion\n:::item 항목 1\n${CARET}내용\n:::\n:::item 항목 2\n내용\n:::\n:::` },
            { label: '스텝퍼', desc: '진행 단계(자식 :::step)', keywords: 'steps 스텝 단계', syntax: ':::steps', insert: `:::steps\n:::step 단계 1\n${CARET}내용\n:::\n:::step 단계 2\n내용\n:::\n:::` },
            { label: '문서 변수', desc: '이름=값 정의 → {{{@이름}}}', keywords: 'meta 변수 문서변수', syntax: ':::meta', insert: `:::meta\n제목 = ${CARET}\n저자 = \n:::` },
            { label: '임베드 블록', desc: '강조선 박스 + 내부 URL 미디어 임베드', keywords: 'embed 임베드 인용 미디어 youtube spotify', syntax: ':::embed', insert: `:::embed\n${CARET}\n\n:::` },
            { label: '시점 이후 표시', desc: '지정 시각 후에만 표시', keywords: 'after 시점 이후', syntax: ':::after 2026-01-01', insert: `:::after ${CARET}\n\n:::` },
            { label: '시점 이전 표시', desc: '지정 시각 전에만 표시', keywords: 'until 시점 이전', syntax: ':::until 2026-01-01', insert: `:::until ${CARET}\n\n:::` },
        ],
    },
    {
        title: '콜아웃',
        entries: [
            { label: '정보 콜아웃', desc: '정보 강조 박스', keywords: 'info 정보 콜아웃 callout', syntax: ':::info', insert: `:::info\n${CARET}\n\n:::` },
            { label: '팁 콜아웃', desc: '팁 강조 박스', keywords: 'tip 팁 콜아웃', syntax: ':::tip', insert: `:::tip\n${CARET}\n\n:::` },
            { label: '성공 콜아웃', desc: '성공 강조 박스', keywords: 'success 성공 콜아웃', syntax: ':::success', insert: `:::success\n${CARET}\n\n:::` },
            { label: '주의 콜아웃', desc: '주의 강조 박스', keywords: 'warning 주의 경고 콜아웃', syntax: ':::warning', insert: `:::warning\n${CARET}\n\n:::` },
            { label: '위험 콜아웃', desc: '위험 강조 박스', keywords: 'danger 위험 콜아웃', syntax: ':::danger', insert: `:::danger\n${CARET}\n\n:::` },
            { label: '노트 콜아웃', desc: '노트 강조 박스', keywords: 'note 노트 콜아웃', syntax: ':::note', insert: `:::note\n${CARET}\n\n:::` },
        ],
    },
    {
        title: '코드 블록',
        entries: [
            { label: '차트', desc: 'Chart.js 차트(키-값 DSL)', keywords: 'chart 차트 그래프', syntax: '```chart', insert: '```chart\ntype: bar\nlabels: [A, B, C]\nseries:\n  - ' + CARET + '1, 2, 3\n```' },
            { label: '다이어그램', desc: 'Mermaid 다이어그램', keywords: 'mermaid diagram 다이어그램 flowchart', syntax: '```mermaid', insert: '```mermaid\n' + CARET + '\n```' },
        ],
    },
];

// ── 검색 인덱스 ────────────────────────────────────────────────────────────
interface FlatEntry extends CheatEntry { section: string; }
const FLAT: FlatEntry[] = CATALOG.flatMap(sec => sec.entries.map(e => ({ ...e, section: sec.title })));

function matches(e: FlatEntry, term: string): boolean {
    if (!term) return true;
    const t = term.toLowerCase();
    return e.label.toLowerCase().includes(t)
        || e.desc.toLowerCase().includes(t)
        || e.keywords.toLowerCase().includes(t)
        || e.syntax.toLowerCase().includes(t)
        || e.section.toLowerCase().includes(t);
}

// ── 삽입 (CM6 직접) ─────────────────────────────────────────────────────────
function insertSnippet(snippet: string): void {
    const view = (window as unknown as { _cmView?: any })._cmView;
    const markerIdx = snippet.indexOf(CARET);
    const clean = markerIdx >= 0 ? snippet.replace(CARET, '') : snippet;
    if (!view || !view.state) {
        // 폴백: shim 삽입(캐럿 지정 불가)
        window.editor?.insertText?.(clean);
        return;
    }
    const sel = view.state.selection.main;
    const from = sel.from;
    const to = sel.to;
    const caretPos = markerIdx >= 0 ? from + markerIdx : from + clean.length;
    view.dispatch({ changes: { from, to, insert: clean }, selection: { anchor: caretPos } });
    view.focus();
}

// ── 모달 UI ────────────────────────────────────────────────────────────────
let overlayEl: HTMLDivElement | null = null;
let inputEl: HTMLInputElement | null = null;
let listEl: HTMLUListElement | null = null;
let triggerEl: Element | null = null;
let selectable: FlatEntry[] = [];
let activeIdx = -1;
let curQuery = '';

const STYLE_ID = 'syntax-cheatsheet-styles';

function ensureStyles(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
.cheat-overlay { position: fixed; inset: 0; z-index: 20000; display: flex; align-items: flex-start; justify-content: center; padding-top: 10vh; background: rgba(0,0,0,0.4); }
.cheat-overlay[hidden] { display: none; }
.cheat-panel { width: min(640px, 92vw); max-height: 76vh; display: flex; flex-direction: column; background: var(--wiki-card-bg, #fff); border: 1px solid var(--wiki-border, #d0d7de); border-radius: var(--wiki-radius-lg, 8px); box-shadow: 0 12px 40px rgba(0,0,0,0.3); overflow: hidden; }
.cheat-input-wrap { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--wiki-border, #d0d7de); }
.cheat-input-wrap > i { color: var(--wiki-text-muted, #6e7781); font-size: 1.1rem; }
.cheat-input { flex: 1; border: none; outline: none; background: transparent; font-size: 1rem; color: var(--wiki-text, #1f2328); }
.cheat-esc { font-size: 0.7rem; color: var(--wiki-text-muted, #6e7781); border: 1px solid var(--wiki-border, #d0d7de); border-radius: 4px; padding: 1px 5px; }
.cheat-list { list-style: none; margin: 0; padding: 6px 0; overflow-y: auto; }
.cheat-group { padding: 8px 14px 4px; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase; color: var(--wiki-text-muted, #6e7781); }
.cheat-item { display: flex; align-items: baseline; gap: 10px; padding: 7px 14px; cursor: pointer; }
.cheat-item.active, .cheat-item:hover { background: var(--wiki-bg, #f6f8fa); }
.cheat-item .cheat-label { font-weight: 600; color: var(--wiki-text, #1f2328); white-space: nowrap; }
.cheat-item .cheat-desc { flex: 1; font-size: 0.82rem; color: var(--wiki-text-muted, #6e7781); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cheat-item .cheat-syntax { font-family: var(--wiki-font-mono, monospace); font-size: 0.78rem; color: var(--wiki-primary, #0969da); background: var(--wiki-bg, #f6f8fa); border: 1px solid var(--wiki-border, #d0d7de); border-radius: 4px; padding: 1px 6px; white-space: nowrap; max-width: 46%; overflow: hidden; text-overflow: ellipsis; }
.cheat-empty { padding: 24px 14px; text-align: center; color: var(--wiki-text-muted, #6e7781); font-size: 0.9rem; }
.cheat-foot { display: flex; gap: 14px; padding: 8px 14px; border-top: 1px solid var(--wiki-border, #d0d7de); font-size: 0.72rem; color: var(--wiki-text-muted, #6e7781); }
.cheat-foot kbd { border: 1px solid var(--wiki-border, #d0d7de); border-radius: 3px; padding: 0 4px; font-size: 0.68rem; }
`;
    document.head.appendChild(style);
}

function ensureDom(): void {
    if (overlayEl) return;
    ensureStyles();

    overlayEl = document.createElement('div');
    overlayEl.className = 'cheat-overlay';
    overlayEl.setAttribute('role', 'dialog');
    overlayEl.setAttribute('aria-modal', 'true');
    overlayEl.setAttribute('aria-label', '문법 치트시트');
    overlayEl.hidden = true;
    overlayEl.innerHTML =
        '<div class="cheat-panel" role="document">' +
        '<div class="cheat-input-wrap">' +
        '<i class="mdi mdi-book-search-outline" aria-hidden="true"></i>' +
        '<input type="text" class="cheat-input" id="cheatInput" autocomplete="off" spellcheck="false" ' +
        'placeholder="문법 검색 (이름·용도)…" role="combobox" aria-expanded="true" aria-controls="cheatList" aria-activedescendant="">' +
        '<span class="cheat-esc">Esc</span>' +
        '</div>' +
        '<ul class="cheat-list" id="cheatList" role="listbox" aria-label="문법 목록"></ul>' +
        '<div class="cheat-foot"><span><kbd>↑</kbd><kbd>↓</kbd> 이동</span><span><kbd>Enter</kbd> 삽입</span><span><kbd>Esc</kbd> 닫기</span></div>' +
        '</div>';
    document.body.appendChild(overlayEl);
    inputEl = overlayEl.querySelector('#cheatInput');
    listEl = overlayEl.querySelector('#cheatList');

    overlayEl.addEventListener('mousedown', (e) => { if (e.target === overlayEl) close(); });
    inputEl!.addEventListener('input', () => { curQuery = inputEl!.value.trim(); render(); });
    inputEl!.addEventListener('keydown', onKey);
}

function render(): void {
    if (!listEl) return;
    selectable = [];
    let html = '';
    let lastSection = '';
    for (const e of FLAT) {
        if (!matches(e, curQuery)) continue;
        if (e.section !== lastSection) {
            html += '<li class="cheat-group" role="presentation">' + escapeHtml(e.section) + '</li>';
            lastSection = e.section;
        }
        const idx = selectable.length;
        selectable.push(e);
        html +=
            '<li class="cheat-item" role="option" id="cheat-opt-' + idx + '" data-idx="' + idx + '">' +
            '<span class="cheat-label">' + escapeHtml(e.label) + '</span>' +
            '<span class="cheat-desc">' + escapeHtml(e.desc) + '</span>' +
            '<span class="cheat-syntax">' + escapeHtml(e.syntax) + '</span>' +
            '</li>';
    }
    if (selectable.length === 0) {
        html = '<li class="cheat-empty" role="presentation">일치하는 문법이 없습니다.</li>';
    }
    listEl.innerHTML = html;
    listEl.querySelectorAll<HTMLLIElement>('.cheat-item').forEach((el) => {
        el.addEventListener('mousedown', (ev) => {
            ev.preventDefault();
            const i = Number(el.dataset.idx);
            if (selectable[i]) choose(i);
        });
        el.addEventListener('mousemove', () => {
            const i = Number(el.dataset.idx);
            if (i !== activeIdx) { activeIdx = i; updateActive(); }
        });
    });
    activeIdx = selectable.length ? 0 : -1;
    updateActive();
}

function updateActive(): void {
    if (!listEl || !inputEl) return;
    const items = listEl.querySelectorAll<HTMLLIElement>('.cheat-item');
    items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
    if (activeIdx >= 0 && items[activeIdx]) {
        items[activeIdx].scrollIntoView({ block: 'nearest' });
        inputEl.setAttribute('aria-activedescendant', 'cheat-opt-' + activeIdx);
    } else {
        inputEl.setAttribute('aria-activedescendant', '');
    }
}

function choose(idx: number): void {
    const e = selectable[idx];
    if (!e) return;
    close();
    insertSnippet(e.insert);
}

function onKey(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (selectable.length) { activeIdx = Math.min(activeIdx + 1, selectable.length - 1); updateActive(); }
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (selectable.length) { activeIdx = Math.max(activeIdx - 1, 0); updateActive(); }
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIdx >= 0) choose(activeIdx);
    } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
    }
}

function isOpen(): boolean { return !!overlayEl && !overlayEl.hidden; }

function open(): void {
    ensureDom();
    if (isOpen()) return;
    triggerEl = document.activeElement;
    curQuery = '';
    inputEl!.value = '';
    overlayEl!.hidden = false;
    render();
    requestAnimationFrame(() => inputEl?.focus());
}

function close(): void {
    if (!overlayEl || overlayEl.hidden) return;
    overlayEl.hidden = true;
    // 삽입 대상 에디터로 포커스 복귀(삽입 경로는 자체적으로 view.focus() 호출).
    if (triggerEl instanceof HTMLElement && document.contains(triggerEl) && !triggerEl.closest('.cheat-overlay')) {
        triggerEl.focus();
    }
    triggerEl = null;
}

// ── 전역 노출 ──────────────────────────────────────────────────────────────
declare global {
    interface Window {
        openSyntaxCheatsheet?: () => void;
    }
}
window.openSyntaxCheatsheet = open;

console.log('[edit/cheatsheet] module loaded');
