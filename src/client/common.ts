// @ts-nocheck — Phase 4-9 의 1차 마이그레이션은 동작 보존을 우선해 임시로 type
// 검사를 끈다. Bootstrap / Swal CDN 글로벌 의존, 광범위한 DOM/Element 캐스팅,
// 알림 패널 등 dynamically-built innerHTML 처리 때문에 1회성 도입으로 다루기 어렵다.
// 후속 Phase 4-9.1 에서 (1) Bootstrap / Swal devDeps 또는 .d.ts shim 도입,
// (2) HTMLElement 캐스팅 정리, (3) window.* 단정 정리 후 본 디렉티브 제거 예정.
/**
 * CloudWiki 공통 클라이언트 모듈 — 전역 변수, 인증, 테마, 알림/쪽지, 사이드바
 * 레이아웃, 트렌딩 / 최근 변경 사이드바 등 모든 페이지에서 공통으로 사용한다.
 *
 * Phase 4-9 마이그레이션: public/js/common.js (1,203 줄, classic) → src/client/common.ts.
 * - 모든 top-level function 과 var 선언을 그대로 유지하되, 파일 끝의 window 브리지
 *   블록에서 window.* 로 노출해 기존 classic-script-global 동작을 보존한다.
 * - 14개 HTML 페이지가 사용. 각 페이지의 inline classic <script> 가 bare 식별자
 *   (loadConfig / currentUser / escapeHtml / cycleTheme 등) 로 호출하므로 브리지 필수.
 * - HTML <head> 의 inline 테마 FOUC 방지 스크립트는 유지 (deferred ESM 보다 먼저 실행).
 *   본 모듈의 동일 IIFE 는 fallback 으로 남겨두며 실질적으로 no-op.
 * - escapeHtml / isSafeUrl 은 src/client/utils/* 에도 동일 구현이 있으나, 다른 클래식
 *   inline <script> 와의 호환성을 위해 본 모듈도 자체 정의 + window 노출 유지.
 */

import * as PushClient from './push';
import {
    emptyState,
    inlineLoading,
    skeletonLines,
    skeletonList,
    skeletonCards,
} from './utils/ui-state';

// ── 테마 초기화 (body 내 fallback, head의 인라인 스크립트가 먼저 실행됨) ──
// data-theme: 위키 자체 다크모드 변수 (--wiki-card-bg 등)
// data-bs-theme: Bootstrap 5.3 컴포넌트(.nav-tabs / .accordion / .alert 등) 다크모드.
//   auto 모드일 때는 OS 환경설정을 즉시 반영하고, 변경 이벤트도 추적한다.
(function () {
    try {
        var saved = localStorage.getItem('themeMode') || 'auto';
        if (saved === 'light' || saved === 'dark') {
            document.documentElement.setAttribute('data-theme', saved);
        }
    } catch (e) { /* 스토리지 접근 불가 시 auto 테마 유지 */ }
})();

function _resolveBsTheme(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    try {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) { return 'light'; }
}
function applyBsTheme(mode) {
    document.documentElement.setAttribute('data-bs-theme', _resolveBsTheme(mode));
}
(function () {
    try {
        applyBsTheme(localStorage.getItem('themeMode') || 'auto');
        if (window.matchMedia) {
            const mq = window.matchMedia('(prefers-color-scheme: dark)');
            const onChange = () => {
                const cur = (function () { try { return localStorage.getItem('themeMode') || 'auto'; } catch (e) { return 'auto'; } })();
                if (cur === 'auto') applyBsTheme('auto');
            };
            if (mq.addEventListener) mq.addEventListener('change', onChange);
            else if (mq.addListener) mq.addListener(onChange);
        }
    } catch (e) { /* 무시 */ }
})();

// ── 전역 변수 ──
var appConfig = { wikiName: 'CloudWiki' };
var currentUser = null;


// ── URL 스킴 검증 (XSS 방지) ──
function isSafeUrl(url) {
    if (!url) return false;
    try {
        const parsed = new URL(url, window.location.origin);
        return ['http:', 'https:'].includes(parsed.protocol);
    } catch { return false; }
}

// ── HTML 이스케이프 ──
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ── 미디어 태그 입력 위젯 (카테고리 입력과 동일한 UX) ──
// 컨테이너에 버블 UI + 자동완성(/api/media/search-tags)을 장착한다.
// 업로드 모달, 이미지 검색 모달, 이미지 문서 편집 모달에서 공통 사용한다.
const MEDIA_TAG_VALID_RE = /^[가-힣a-zA-Z0-9 _.-]+$/;
function mountMediaTagInput({ container, input, initial }) {
    const tags = Array.isArray(initial) ? initial.slice() : [];

    const ac = document.createElement('div');
    ac.className = 'list-group';
    ac.style.cssText = 'position:absolute; display:none; z-index:10000; background:var(--wiki-bg,#fff); border:1px solid var(--wiki-border,#ddd); border-radius:4px; box-shadow:0 4px 12px rgba(0,0,0,0.15); max-height:240px; overflow-y:auto;';
    document.body.appendChild(ac);

    let acResults = [];
    let acSelected = -1;
    let acDebounce = null;
    let lastQ = null;

    function positionAc() {
        const rect = container.getBoundingClientRect();
        ac.style.left = (rect.left + window.scrollX) + 'px';
        ac.style.top = (rect.bottom + window.scrollY + 2) + 'px';
        ac.style.width = rect.width + 'px';
    }
    function hideAc() { ac.style.display = 'none'; acResults = []; acSelected = -1; lastQ = null; }

    function render() {
        container.querySelectorAll('.category-tag').forEach(el => el.remove());
        tags.forEach((t, i) => {
            const el = document.createElement('span');
            el.className = 'category-tag';
            const textSpan = document.createElement('span');
            textSpan.textContent = t;
            const close = document.createElement('i');
            close.className = 'mdi mdi-close';
            close.style.cursor = 'pointer';
            close.addEventListener('click', (e) => { e.stopPropagation(); tags.splice(i, 1); render(); onChange(); });
            el.appendChild(textSpan);
            el.appendChild(document.createTextNode(' '));
            el.appendChild(close);
            container.insertBefore(el, input);
        });
    }

    function showTagWarning(title, text) {
        if (typeof Swal !== 'undefined' && Swal && typeof Swal.fire === 'function') {
            Swal.fire({ icon: 'warning', title, text, toast: true, position: 'top-end', timer: 2000, showConfirmButton: false });
        }
    }

    function addTag(raw) {
        const t = String(raw || '').trim();
        if (!t) return false;
        if (t.length > 50) {
            showTagWarning('태그 길이 초과', '태그는 최대 50자까지 입력할 수 있습니다.');
            return false;
        }
        if (!MEDIA_TAG_VALID_RE.test(t)) {
            showTagWarning('특수문자 제외', '특수문자를 제외한 태그명을 입력해 주세요.');
            return false;
        }
        if (tags.includes(t)) return false;
        if (tags.length >= 20) {
            showTagWarning('태그 개수 초과', '태그는 최대 20개까지 추가할 수 있습니다.');
            return false;
        }
        tags.push(t);
        render();
        onChange();
        return true;
    }

    async function fetchAc(q) {
        if (q === lastQ) return;
        lastQ = q;
        const requestQ = q;
        try {
            const res = await fetch(`/api/media/search-tags?q=${encodeURIComponent(q)}`);
            if (!res.ok) return;
            // Discard stale responses if the query changed while awaiting
            if (requestQ !== lastQ) return;
            const data = await res.json();
            acResults = (data.results || []).filter(r => !tags.includes(r));
            renderAc();
        } catch (_) { /* ignore */ }
    }
    function renderAc() {
        if (acResults.length === 0) { hideAc(); return; }
        positionAc();
        ac.style.display = 'block';
        ac.innerHTML = '';
        acResults.forEach((tag, idx) => {
            const row = document.createElement('div');
            row.className = 'list-group-item tag-ac-item';
            row.style.cssText = 'cursor:pointer; padding:6px 12px; display:flex; align-items:center; gap:6px;';
            row.innerHTML = '<i class="mdi mdi-tag-outline"></i>';
            const span = document.createElement('span');
            span.textContent = tag;
            row.appendChild(span);
            row.addEventListener('mousedown', (e) => {
                e.preventDefault();
                addTag(tag);
                input.value = '';
                hideAc();
                input.focus();
            });
            ac.appendChild(row);
        });
        acSelected = -1;
    }
    function highlightAc() {
        const items = ac.querySelectorAll('.tag-ac-item');
        items.forEach((el, i) => {
            if (i === acSelected) { el.classList.add('active'); el.scrollIntoView({ block: 'nearest' }); }
            else el.classList.remove('active');
        });
    }

    function showAcForQuery(q) {
        positionAc();
        if (acDebounce) clearTimeout(acDebounce);
        acDebounce = setTimeout(() => fetchAc(q), 200);
    }

    input.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        if (ac.style.display !== 'none' && acResults.length > 0) {
            if (e.key === 'ArrowDown') { e.preventDefault(); acSelected = (acSelected + 1) % acResults.length; highlightAc(); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); acSelected = (acSelected - 1 + acResults.length) % acResults.length; highlightAc(); return; }
            if (e.key === 'Escape') { e.preventDefault(); hideAc(); return; }
            if (e.key === 'Enter' && acSelected >= 0) {
                e.preventDefault(); addTag(acResults[acSelected]); input.value = ''; hideAc(); return;
            }
        }
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            if (input.value.trim()) {
                input.value.split(',').forEach(t => addTag(t));
                input.value = '';
                hideAc();
            }
        } else if (e.key === 'Backspace' && input.value === '') {
            if (tags.length > 0) { tags.pop(); render(); onChange(); }
        }
    });

    input.addEventListener('input', () => {
        if (input.value.includes(',')) {
            const parts = input.value.split(',');
            const last = parts.pop();
            parts.forEach(t => addTag(t));
            input.value = last;
            hideAc();
            return;
        }
        showAcForQuery(input.value.trim());
    });

    input.addEventListener('blur', () => {
        setTimeout(() => {
            hideAc();
            if (input.value.trim()) {
                input.value.split(',').forEach(t => addTag(t));
                input.value = '';
            }
        }, 150);
    });

    container.addEventListener('click', (e) => {
        if (e.target === container) input.focus();
    });

    let onChange = () => {};

    render();

    return {
        getTags: () => tags.slice(),
        flush: () => {
            if (input.value.trim()) {
                input.value.split(',').forEach(t => addTag(t));
                input.value = '';
            }
        },
        setOnChange: (fn) => { onChange = typeof fn === 'function' ? fn : () => {}; },
        destroy: () => { if (acDebounce) clearTimeout(acDebounce); hideAc(); ac.remove(); },
    };
}

// ── 검색 ──
function doSearch(e) {
    e.preventDefault();
    const q = document.getElementById('searchInput').value.trim();
    if (q) {
        window.location.href = `/search?q=${encodeURIComponent(q)}&mode=content`;
    }
}

// ── 테마 관리 ──
function applyThemeClass(mode) {
    if (mode === 'light' || mode === 'dark') {
        document.documentElement.setAttribute('data-theme', mode);
    } else {
        document.documentElement.removeAttribute('data-theme');
    }
    applyBsTheme(mode);
    // 테마 변경 구독자(예: render.ts 의 Mermaid 다이어그램 재렌더)에 통지.
    try { window.dispatchEvent(new CustomEvent('wiki:theme-changed', { detail: { mode: mode } })); } catch (e) { /* noop */ }
}

function setTheme(mode) {
    var validModes = ['light', 'dark', 'auto'];
    if (validModes.indexOf(mode) === -1) mode = 'auto';
    try {
        localStorage.setItem('themeMode', mode);
    } catch (e) { /* 스토리지 접근 불가 시 무시 */ }
    applyThemeClass(mode);
    updateThemeToggleUI(mode);
}

function getCurrentTheme() {
    try { return localStorage.getItem('themeMode') || 'auto'; } catch (e) { return 'auto'; }
}

function cycleTheme() {
    var order = ['auto', 'light', 'dark'];
    var curr = getCurrentTheme();
    var next = order[(order.indexOf(curr) + 1) % order.length];
    setTheme(next);
}

function updateThemeToggleUI(mode) {
    // 헤더의 단독 테마 토글 버튼은 개인 설정 모달로 이관되어 제거됐다. 잔존 셀렉터(있으면)만
    // 갱신하는 무해한 no-op 으로 남겨 둔다(외부 호환). 실제 테마 적용은 setTheme 이 담당.
    if (!mode) mode = getCurrentTheme();
    var icons = { auto: 'mdi-theme-light-dark', light: 'mdi-white-balance-sunny', dark: 'mdi-moon-waning-crescent' };
    document.querySelectorAll('#navThemeIcon').forEach(function (el) {
        el.classList.remove('mdi-theme-light-dark', 'mdi-white-balance-sunny', 'mdi-moon-waning-crescent');
        el.classList.add(icons[mode] || icons.auto);
    });
}

// ── 레이아웃 모드 사용자 오버라이드 (클라이언트 전용, localStorage) ──
// 사이트 전역 LAYOUT_MODE(wrangler.toml → BaseLayout 베이킹 → /api/config.layoutMode) 위에
// 사용자가 자신의 브라우저에서만 적용되는 레이아웃을 덮어쓴다.
// - CSS 는 body[data-layout-mode] 를, index.ts 의 사이드바 동기화는 window.appConfig.layoutMode 를
//   읽으므로 두 경로 모두 갱신한다.
// - FOUC 방지를 위한 조기 적용은 BaseLayout.astro 의 <body> 인라인 스크립트가 담당하며,
//   본 헬퍼는 loadConfig 시점에 appConfig 까지 일관되게 맞추는 역할.
var LAYOUT_OVERRIDE_KEY = 'layoutModeOverride';
var VALID_LAYOUT_OVERRIDES = ['default', 'left-toc', 'right-toc', 'docs', 'wide'];

function getLayoutOverride() {
    try {
        var v = localStorage.getItem(LAYOUT_OVERRIDE_KEY);
        return (v && VALID_LAYOUT_OVERRIDES.indexOf(v) >= 0) ? v : null;
    } catch (e) { return null; }
}

function applyLayoutOverride() {
    var v = getLayoutOverride();
    if (!v) return;
    try { document.body.setAttribute('data-layout-mode', v); } catch (e) { /* ignore */ }
    if (appConfig) appConfig.layoutMode = v;
    if (window.appConfig) window.appConfig.layoutMode = v;
}

// ── 개인 설정 모달 ──
function openSettingsModal() {
    var modalEl = document.getElementById('settingsModal');
    if (!modalEl || typeof bootstrap === 'undefined' || !bootstrap.Modal) return;
    var themeSel = document.getElementById('settingTheme');
    if (themeSel) themeSel.value = getCurrentTheme();
    var layoutSel = document.getElementById('settingLayoutMode');
    if (layoutSel) layoutSel.value = getLayoutOverride() || 'site';
    bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

function setupSettingsModal() {
    var themeSel = document.getElementById('settingTheme');
    if (themeSel && !themeSel.dataset.bound) {
        themeSel.dataset.bound = '1';
        // 테마는 즉시 라이브 적용(리로드 불필요).
        themeSel.addEventListener('change', function () { setTheme(this.value); });
    }
    var layoutSel = document.getElementById('settingLayoutMode');
    if (layoutSel && !layoutSel.dataset.bound) {
        layoutSel.dataset.bound = '1';
        layoutSel.addEventListener('change', function () {
            var prev = getLayoutOverride();
            var next = this.value === 'site' ? null : this.value;
            if ((prev || null) === (next || null)) return; // 변경 없음
            try {
                if (next) localStorage.setItem(LAYOUT_OVERRIDE_KEY, next);
                else localStorage.removeItem(LAYOUT_OVERRIDE_KEY);
            } catch (e) { /* ignore */ }
            // 사이드바 재배치 1회 가드(_rightSidebarRelocated)·그룹 nav fetch 때문에
            // 깨끗한 재초기화를 위해 새로고침한다.
            location.reload();
        });
    }
}

// ── 랜덤 문서 ──
async function goRandomPage() {
    try {
        const res = await fetch('/api/w/random');
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (data.slug) {
            const url = `/w/${encodeURIComponent(data.slug)}`;
            if (typeof navigateTo === 'function') {
                navigateTo(url);
                const sidebar = document.getElementById('mobileSidebar');
                if (sidebar) {
                    const bsOffcanvas = bootstrap?.Offcanvas?.getInstance(sidebar);
                    if (bsOffcanvas) bsOffcanvas.hide();
                }
            } else {
                window.location.href = url;
            }
        }
    } catch (e) {
        if (typeof Swal !== 'undefined') {
            Swal.fire('오류', '랜덤 문서를 불러올 수 없습니다.', 'error');
        }
    }
}

// ── 공지 배너 렌더 (다중 지원) ──
// 각 배너의 "다시 보지 않기" 체크박스는 해당 공지의 announcedTime 을
// localStorage 키 `announcement:skipUntil:<id>` 에 저장한다. 다음 페이지 로드에서
// 현재 announcedTime 이 그보다 크면 다시 노출.
// 철회되어 사라진 공지의 skipUntil 키는 누수 방지를 위해 매 로드마다 정리한다.
// X 닫기 버튼은 현재 세션에서만 숨기며 저장하지 않는다.
const ANNOUNCEMENT_SKIP_PREFIX = 'announcement:skipUntil:';
const ANNOUNCEMENT_LEGACY_KEY = 'announcement:skipUntil'; // 단일 공지 시절 잔여 키

function purgeStaleAnnouncementSkipKeys(activeIds) {
    try {
        // 단일 공지 시절 잔여 키는 무조건 제거.
        try { localStorage.removeItem(ANNOUNCEMENT_LEGACY_KEY); } catch (e) { /* ignore */ }
        const toRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || !key.startsWith(ANNOUNCEMENT_SKIP_PREFIX)) continue;
            const idStr = key.slice(ANNOUNCEMENT_SKIP_PREFIX.length);
            const id = Number(idStr);
            if (!Number.isFinite(id) || !activeIds.has(id)) toRemove.push(key);
        }
        toRemove.forEach(k => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } });
    } catch (e) { /* ignore */ }
}

function renderSingleBanner(ann) {
    const id = Number(ann.id);
    const announcedTime = Number(ann.announcedTime) || 0;

    let skipUntil = 0;
    try {
        const raw = localStorage.getItem(ANNOUNCEMENT_SKIP_PREFIX + id);
        skipUntil = Number(raw) || 0;
    } catch (e) { /* ignore */ }
    if (announcedTime > 0 && announcedTime <= skipUntil) return null;

    const banner = document.createElement('div');
    banner.className = 'announcement-banner';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    banner.dataset.announcementId = String(id);

    const inner = document.createElement('div');
    inner.className = 'announcement-banner-inner';

    const iconEl = document.createElement('i');
    iconEl.className = 'announcement-banner-icon ' + (ann.icon || 'mdi mdi-bullhorn');
    iconEl.setAttribute('aria-hidden', 'true');
    inner.appendChild(iconEl);

    const url = typeof ann.url === 'string' && ann.url && isSafeUrl(ann.url) ? ann.url : null;
    if (url) {
        const a = document.createElement('a');
        a.className = 'announcement-banner-text';
        a.href = url;
        a.textContent = ann.title || '새 공지';
        inner.appendChild(a);
    } else {
        const span = document.createElement('span');
        span.className = 'announcement-banner-text';
        span.textContent = ann.title || '새 공지';
        inner.appendChild(span);
    }

    const skipLabel = document.createElement('label');
    skipLabel.className = 'announcement-banner-skip';
    const skipBox = document.createElement('input');
    skipBox.type = 'checkbox';
    skipBox.className = 'form-check-input me-1';
    const skipText = document.createElement('span');
    skipText.textContent = '다시 보지 않기';
    skipLabel.appendChild(skipBox);
    skipLabel.appendChild(skipText);
    skipBox.onchange = () => {
        if (skipBox.checked) {
            try {
                localStorage.setItem(ANNOUNCEMENT_SKIP_PREFIX + id, String(announcedTime));
            } catch (e) { /* ignore */ }
            banner.classList.add('d-none');
        }
    };
    inner.appendChild(skipLabel);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'announcement-banner-close btn-close';
    closeBtn.setAttribute('aria-label', '닫기');
    closeBtn.onclick = () => banner.classList.add('d-none');
    inner.appendChild(closeBtn);

    banner.appendChild(inner);
    return banner;
}

function applyAnnouncementBanner() {
    try {
        const container = document.getElementById('announcement-banners');
        if (!container) return;
        const list = Array.isArray(appConfig && appConfig.announcements)
            ? appConfig.announcements
            : [];
        const activeIds = new Set(list.map(a => Number(a.id)).filter(Number.isFinite));
        purgeStaleAnnouncementSkipKeys(activeIds);

        container.innerHTML = '';
        if (list.length === 0) {
            container.classList.add('d-none');
            return;
        }
        list.forEach(ann => {
            const node = renderSingleBanner(ann);
            if (node) container.appendChild(node);
        });
        if (container.children.length === 0) {
            container.classList.add('d-none');
        } else {
            container.classList.remove('d-none');
        }
    } catch (e) {
        console.error('applyAnnouncementBanner failed:', e);
    }
}

async function loadConfig() {
    try {
        const res = await fetch('/api/config');
        if (res.ok) {
            appConfig = await res.json();
            // ESM 모듈은 var 재바인딩이 globalThis 에 자동 반영되지 않으므로 명시적 미러.
            // 다른 ESM 모듈 (edit/main.ts 등) 과 inline classic <script> 가 window.appConfig
            // 를 읽으므로 fetch 결과를 즉시 노출해야 한다.
            window.appConfig = appConfig;

            // 사용자 레이아웃 오버라이드를 사이트 기본값 위에 덮어쓴다(index.ts 의 사이드바
            // 동기화가 window.appConfig.layoutMode 를 읽으므로 fetch 직후 적용).
            applyLayoutOverride();

            // 브랜딩(위키 이름/파비콘/로고)은 더 이상 클라이언트에서 덮어쓰지 않는다.
            // - Astro 정적 셸: 빌드 타임에 wrangler.toml 값으로 베이킹됨.
            // - 요청별 SSR 셸(index/blog): 서버 applyPageSSR 이 문서별 메타/브랜딩 마커를 주입.
            // appConfig.wikiName 은 각 페이지가 document.title 을 동적 생성할 때 계속 사용한다.

            // 익스텐션 동적 로드 (JS/CSS)
            //
            // 익스텐션 패키지 구조:
            //   /ext/<name>/<name>.js        ─ 모든 페이지 (렌더러 등록)
            //   /ext/<name>/<name>.css       ─ 모든 페이지 (렌더 스타일)
            //   /ext/<name>/<name>-editor.js ─ 에디터 페이지(/edit, /blog-edit) 만, 옵션 파일.
            //                                  window._extensionEditors[<name>] 에 도구막대
            //                                  mount 함수 / disableTextCounter 등의 옵션을 등록.
            //                                  존재하지 않으면 onerror 로 조용히 무시.
            //
            // 에디터 훅 스크립트는 edit/main.ts 가 동기 lookup 으로 사용하므로 로드 완료까지
            // await 한다. 비-에디터 페이지에서는 이 await 가 없어 페이지 로드가 느려지지 않는다.
            if (appConfig.enabledExtensions && Array.isArray(appConfig.enabledExtensions)) {
                const path = window.location.pathname;
                const isEditPage =
                    path === '/edit' || path.startsWith('/edit/') ||
                    path === '/blog-edit' || path.startsWith('/blog-edit/');

                const editorScriptPromises = [];
                appConfig.enabledExtensions.forEach(ext => {
                    const extName = ext.trim();
                    if (!extName) return;

                    // JS 파일 로드
                    const jsId = `ext-js-${extName}`;
                    if (!document.getElementById(jsId)) {
                        const script = document.createElement('script');
                        script.id = jsId;
                        script.src = `/ext/${extName}/${extName}.js`;
                        script.async = true;
                        document.head.appendChild(script);
                    }

                    // CSS 파일 로드
                    const cssId = `ext-css-${extName}`;
                    if (!document.getElementById(cssId)) {
                        const link = document.createElement('link');
                        link.id = cssId;
                        link.rel = 'stylesheet';
                        link.href = `/ext/${extName}/${extName}.css`;
                        document.head.appendChild(link);
                    }

                    // 에디터 페이지 전용 훅 (옵션 — 파일 없으면 silently 무시)
                    if (isEditPage) {
                        const editorJsId = `ext-editor-js-${extName}`;
                        if (!document.getElementById(editorJsId)) {
                            const script = document.createElement('script');
                            script.id = editorJsId;
                            script.src = `/ext/${extName}/${extName}-editor.js`;
                            script.async = true;
                            const p = new Promise(resolve => {
                                script.onload = () => resolve();
                                // 404 등은 해당 익스텐션이 에디터 훅을 제공하지 않는다는 뜻 — 정상 흐름.
                                script.onerror = () => resolve();
                            });
                            editorScriptPromises.push(p);
                            document.head.appendChild(script);
                        }
                    }
                });

                // 에디터 페이지에서만 훅 스크립트 로드 완료까지 기다린다.
                // edit/main.ts 의 await loadConfig() 이후 동기 lookup 으로 사용되기 때문.
                if (editorScriptPromises.length > 0) {
                    await Promise.all(editorScriptPromises);
                }
            }
        }
    } catch (e) {
        console.error('설정 로드 실패', e);
    }
    // 헤더가 SSR로 이미 주입돼 있는 경우를 대비해 한 번 시도
    applyAnnouncementBanner();

    // 테마 토글 UI 업데이트 (헤더는 Astro 빌드 타임에 인라인됨)
    updateThemeToggleUI();

    // 전역 인증 상태 동기화 (레이아웃 주입 여부와 상관없이 항상 수행)
    await checkAuth();
}

// ── 인증 확인 + 네비바 UI 업데이트 ──
async function checkAuth() {
    // 로그인 버튼 href에 현재 경로를 redirect 파라미터로 추가
    // /login 페이지 자체는 제외하여 무한 리다이렉트 방지
    const currentPath = window.location.pathname + window.location.search;
    if (!currentPath.startsWith('/login')) {
        document.querySelectorAll('#navLogin').forEach(function(el) {
            el.href = '/login?redirect=' + encodeURIComponent(currentPath);
        });
    }

    try {
        const res = await fetch('/api/me');
        if (res.ok) {
            currentUser = await res.json();
            // ESM 모듈은 var 재바인딩이 globalThis 에 자동 반영되지 않으므로 명시적 미러.
            // 다른 ESM 모듈 (edit/main.ts 등) 과 inline classic <script> 가 window.currentUser
            // 를 읽어 인증 UI / 권한 분기를 처리하므로 즉시 노출해야 한다.
            window.currentUser = currentUser;
            document.querySelectorAll('#navLogin').forEach(el => el.classList.add('d-none'));
            // 로그아웃용 개인 설정 톱니 버튼 숨김 — 로그인 사용자는 드롭다운의 "개인 설정" 항목 사용.
            document.querySelectorAll('#navSettings').forEach(el => el.classList.add('d-none'));
            document.querySelectorAll('#navUser').forEach(el => el.classList.remove('d-none'));

            document.querySelectorAll('#userAvatar').forEach(el => el.src = isSafeUrl(currentUser.picture) ? currentUser.picture : '');
            document.querySelectorAll('#userName').forEach(el => el.textContent = currentUser.name);

            if (currentUser.role === 'admin' || currentUser.role === 'super_admin') {
                document.querySelectorAll('#navAdminConsole').forEach(el => el.classList.remove('d-none'));
            }

            // 알림 버튼 표시 및 카운트 로드
            document.querySelectorAll('#notificationBtnWrapper').forEach(el => el.classList.remove('d-none'));
            loadNotificationCount();
            // 60초마다 알림 폴링 (탭 비활성 시 자동 중단)
            startNotifPolling();
        }
    } catch (e) {
        // 로그인 안 됨
    }
}

// ── 알림 시스템 ──
var _notifPanelOpen = false;
var _notifOffset = 0;
const _notifLimit = 10;
var _notifIntervalId = null;

function startNotifPolling() {
    stopNotifPolling();
    _notifIntervalId = setInterval(loadNotificationCount, 60000);
}
function stopNotifPolling() {
    if (_notifIntervalId) { clearInterval(_notifIntervalId); _notifIntervalId = null; }
}
document.addEventListener('visibilitychange', () => {
    if (!currentUser) return;
    if (document.hidden) {
        stopNotifPolling();
    } else {
        loadNotificationCount();
        startNotifPolling();
    }
});

async function loadNotificationCount() {
    try {
        const res = await fetch('/api/notifications/count');
        if (!res.ok) return;
        const data = await res.json();
        const count = Number(data.count) || 0;
        const badge = document.getElementById('notificationBadge');
        if (badge) {
            if (count > 0) {
                badge.innerHTML = '';
                badge.classList.remove('d-none');
            } else {
                badge.classList.add('d-none');
            }
        }
        const menuBadge = document.getElementById('notificationMenuBadge');
        if (menuBadge) {
            if (count > 0) {
                menuBadge.textContent = count > 99 ? '99+' : String(count);
                menuBadge.classList.remove('d-none');
            } else {
                menuBadge.textContent = '';
                menuBadge.classList.add('d-none');
            }
        }
    } catch (e) { }
}

function toggleNotificationPanel() {
    const panel = document.getElementById('notificationPanel');
    if (!panel) return;
    _notifPanelOpen = !_notifPanelOpen;
    if (_notifPanelOpen) {
        panel.classList.remove('d-none');
        loadNotifications(false);
        refreshPushToggle(); // 패널 열릴 때마다 상태 동기화
        // 외부 클릭 시 닫기
        setTimeout(() => {
            document.addEventListener('click', _closeNotifOnOutsideClick);
        }, 0);
    } else {
        panel.classList.add('d-none');
        document.removeEventListener('click', _closeNotifOnOutsideClick);
    }
}

function _closeNotifOnOutsideClick(e) {
    const panel = document.getElementById('notificationPanel');
    const navUser = document.getElementById('navUser');
    if ((panel && !panel.contains(e.target)) && (navUser && !navUser.contains(e.target))) {
        _notifPanelOpen = false;
        panel?.classList.add('d-none');
        document.removeEventListener('click', _closeNotifOnOutsideClick);
    }
}

async function handleNotificationClick(event, id, type, refId, link) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }

    // 읽음 처리 API 호출 (백그라운드). 90일 보존 모델: 삭제 대신 읽음 처리해 보관함에 남긴다.
    fetch(`/api/notifications/${id}/read`, { method: 'POST' }).then(() => {
        // 알림 카운트(미읽음) 업데이트
        loadNotificationCount();
    }).catch(console.error);
    // 패널 상에서도 즉시 읽음 표시 반영
    const itemEl = document.querySelector(`.notification-item[data-notif-id="${id}"]`);
    if (itemEl) itemEl.classList.remove('unread');

    // 즉시 이동 또는 팝업 표시
    const isMessage = type === 'message';
    if (isMessage && refId) {
        viewMessage(refId);
    } else if (link && link !== 'null' && isSafeUrl(link)) {
        // 링크가 현재 페이지를 가리키면 SPA 라우터가 no-op 이므로 새로고침으로 대응
        let sameLocation = false;
        try {
            const target = new URL(link, window.location.origin);
            sameLocation = target.origin === window.location.origin
                && target.pathname === window.location.pathname
                && target.search === window.location.search;
            if (sameLocation) {
                toggleNotificationPanel();
                if (target.hash && target.hash !== window.location.hash) {
                    window.location.hash = target.hash;
                }
                window.location.reload();
                return;
            }
        } catch (_) {
            // URL 파싱 실패 시 기본 분기로 폴백
        }
        if (typeof navigateTo === 'function') {
            navigateTo(link);
            toggleNotificationPanel(); // 알림 패널 닫기 (SPA 이동 시)
        } else {
            window.location.href = link;
        }
    }
}

async function loadNotifications(append = false) {
    const body = document.getElementById('notificationPanelBody');
    if (!body) return;

    if (!append) {
        _notifOffset = 0;
        body.innerHTML = inlineLoading({ block: true, text: '' });
    } else {
        const loadMoreBtn = document.getElementById('notifLoadMoreBtn');
        if (loadMoreBtn) {
            loadMoreBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 불러오는 중...';
            loadMoreBtn.disabled = true;
        }
    }

    try {
        const res = await fetch(`/api/notifications?limit=${_notifLimit}&offset=${_notifOffset}`);
        if (!res.ok) throw new Error();
        const data = await res.json();
        const notifs = data.notifications || [];
        const has_more = data.has_more || false;

        if (notifs.length === 0 && !append) {
            body.innerHTML = emptyState({ compact: true, icon: 'mdi mdi-inbox-outline', title: '알림이 없습니다' });
            return;
        }

        const notifsHtml = notifs.map(n => {
            const iconMap = {
                'discussion_comment': 'mdi mdi-comment-text-outline',
                'banned': 'mdi mdi-block-helper',
                'message': 'mdi mdi-email-outline',
                'ticket_created': 'mdi mdi-ticket-outline',
                'ticket_comment': 'mdi mdi-ticket-confirmation-outline'
            };
            const icon = iconMap[n.type] || 'mdi mdi-bell';
            const timeAgo = _formatTimeAgo(n.created_at);
            const unreadCls = n.read_at ? '' : ' unread';

            return `<div class="notification-item${unreadCls}" data-notif-id="${escapeHtml(String(n.id))}" data-notif-type="${escapeHtml(n.type)}" data-notif-ref="${escapeHtml(String(n.ref_id || ''))}" data-notif-link="${escapeHtml(n.link || '')}">
                <i class="notif-icon ${icon} type-${escapeHtml(n.type)}"></i>
                <div class="notif-content">
                    <div class="notif-text">${escapeHtml(n.content)}</div>
                    <div class="notif-time">${timeAgo}</div>
                </div>
                <button class="notif-delete" data-delete-id="${escapeHtml(String(n.id))}" title="삭제">
                    <i class="mdi mdi-close"></i>
                </button>
            </div>`;
        }).join('');

        if (append) {
            const loadMoreWrapper = document.getElementById('notifLoadMoreWrapper');
            if (loadMoreWrapper) loadMoreWrapper.remove();
            body.insertAdjacentHTML('beforeend', notifsHtml);
        } else {
            body.innerHTML = notifsHtml;
        }

        if (has_more) {
            _notifOffset += _notifLimit;
            body.insertAdjacentHTML('beforeend', `
                <div id="notifLoadMoreWrapper" class="text-center p-2 border-top">
                    <button id="notifLoadMoreBtn" class="btn btn-sm btn-link text-decoration-none w-100" data-load-more="true">
                        더보기 <i class="mdi mdi-chevron-down"></i>
                    </button>
                </div>
            `);
        }

        // 이벤트 델리게이션 (한 번만 등록)
        if (!body._notifDelegated) {
            body._notifDelegated = true;
            body.addEventListener('click', (e) => {
                // 삭제 버튼
                const deleteBtn = e.target.closest('[data-delete-id]');
                if (deleteBtn) {
                    e.stopPropagation();
                    deleteNotification(parseInt(deleteBtn.dataset.deleteId, 10));
                    return;
                }
                // 더보기 버튼
                const loadMoreBtn = e.target.closest('[data-load-more]');
                if (loadMoreBtn) {
                    loadNotifications(true);
                    return;
                }
                // 알림 아이템 클릭
                const item = e.target.closest('[data-notif-id]');
                if (item) {
                    const id = parseInt(item.dataset.notifId, 10);
                    const type = item.dataset.notifType;
                    const refId = item.dataset.notifRef ? parseInt(item.dataset.notifRef, 10) : null;
                    const link = item.dataset.notifLink || null;
                    handleNotificationClick(e, id, type, refId, link);
                }
            });
        }
    } catch (e) {
        if (!append) {
            body.innerHTML = '<div class="notification-empty text-danger">알림 로드 실패</div>';
        } else {
            const loadMoreBtn = document.getElementById('notifLoadMoreBtn');
            if (loadMoreBtn) {
                loadMoreBtn.innerHTML = '로드 실패. 다시 시도';
                loadMoreBtn.disabled = false;
            }
        }
    }
}

function _formatTimeAgo(unixTimestamp) {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - unixTimestamp;
    if (diff < 60) return '방금 전';
    if (diff < 3600) return Math.floor(diff / 60) + '분 전';
    if (diff < 86400) return Math.floor(diff / 3600) + '시간 전';
    if (diff < 604800) return Math.floor(diff / 86400) + '일 전';
    return new Date(unixTimestamp * 1000).toLocaleDateString('ko-KR');
}

// ── 사용자 역할 아이콘 렌더링 ──
function renderUserRoleIcon(role) {
    const roleMap = {
        super_admin: { icon: 'bi-shield-fill-check', color: '#f97316', label: '최고 관리자' },
        admin: { icon: 'bi-shield-fill-check', color: '#3b82f6', label: '관리자' },
        discussion_manager: { icon: 'bi-shield-fill-check', color: '#22c55e', label: '토론 관리자' },
        banned: { icon: 'bi-ban', color: '#ef4444', label: '차단' },
        deleted: { icon: 'bi-x-circle-fill', color: '#9ca3af', label: '탈퇴' },
    };
    const cfg = roleMap[role];
    const icon = cfg ? cfg.icon : 'bi-person-fill';
    const color = cfg ? cfg.color : '#9ca3af';
    const label = cfg ? cfg.label : '일반 유저';
    return `<i class="bi ${escapeHtml(icon)} user-role-icon ms-1" tabindex="0" data-bs-toggle="popover" data-bs-content="${escapeHtml(label)}" data-bs-trigger="hover focus" data-bs-placement="top" style="color:${color};font-size:0.8em;cursor:pointer;" aria-label="${escapeHtml(label)}"></i>`;
}

// ── 역할 아이콘 팝오버 초기화 (동적 렌더링 후 호출) ──
function initRoleIconPopovers(container) {
    if (!container || typeof bootstrap === 'undefined') return;
    container.querySelectorAll('.user-role-icon[data-bs-toggle="popover"]').forEach(el => {
        if (!el._rolePopover) {
            el._rolePopover = new bootstrap.Popover(el, {
                trigger: 'hover focus',
                container: 'body',
                animation: false,
            });
        }
    });
}

async function deleteNotification(id) {
    const numId = parseInt(id, 10);
    if (isNaN(numId)) return;
    try {
        const res = await fetch(`/api/notifications/${numId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error();
        loadNotifications();
        loadNotificationCount();
    } catch (e) {
        if (typeof Swal !== 'undefined') {
            Swal.fire('오류', '알림 삭제에 실패했습니다.', 'error');
        }
    }
}

async function markAllNotificationsRead() {
    try {
        const res = await fetch('/api/notifications/read-all', { method: 'POST' });
        if (!res.ok) throw new Error();
        loadNotifications();
        loadNotificationCount();
    } catch (e) {
        if (typeof Swal !== 'undefined') {
            Swal.fire('오류', '알림 읽음 처리에 실패했습니다.', 'error');
        }
    }
}
window.markAllNotificationsRead = markAllNotificationsRead;

async function deleteAllNotifications() {
    if (typeof Swal === 'undefined') return;
    const result = await Swal.fire({
        title: '알림 전체 삭제',
        text: '모든 알림을 삭제합니다. 이 작업은 되돌릴 수 없습니다.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#dc3545',
        confirmButtonText: '전체 삭제',
        cancelButtonText: '취소',
    });
    if (!result.isConfirmed) return;
    try {
        const res = await fetch('/api/notifications', { method: 'DELETE' });
        if (!res.ok) throw new Error();
        loadNotifications();
        loadNotificationCount();
    } catch (e) {
        Swal.fire('오류', '알림 삭제에 실패했습니다.', 'error');
    }
}
window.deleteAllNotifications = deleteAllNotifications;

// ── Web Push 토글 (in-app 알림 패널 헤더) ──
// 동적 import 로 push.ts 를 로드하므로 비지원 브라우저에서도 무해.
// 토글 상태는 매번 패널 열릴 때 refreshPushToggle 로 갱신된다.
function showPushToast(icon: 'success' | 'info' | 'warning' | 'error', title: string) {
    if (typeof Swal === 'undefined' || !Swal || typeof Swal.fire !== 'function') return;
    Swal.fire({
        icon,
        title,
        toast: true,
        position: 'top-end',
        timer: 2200,
        showConfirmButton: false,
    });
}

function applyPushStatusPill(subscribed: boolean) {
    const pill = document.getElementById('pushStatusPill');
    const dot = document.getElementById('pushStatusDot');
    const text = document.getElementById('pushStatusText');
    if (!pill || !text) return;
    if (subscribed) {
        pill.classList.remove('push-status-off');
        pill.classList.add('push-status-on');
        text.textContent = '받는 중';
        if (dot) dot.className = 'mdi mdi-bell-ring';
    } else {
        pill.classList.remove('push-status-on');
        pill.classList.add('push-status-off');
        text.textContent = '꺼짐';
        if (dot) dot.className = 'mdi mdi-bell-off';
    }
}

async function refreshPushToggle() {
    const footer = document.getElementById('notificationPanelFooter');
    const btn = document.getElementById('pushToggleBtn') as HTMLButtonElement | null;
    const labelEl = document.getElementById('pushToggleLabel');
    if (!footer || !btn || !labelEl || !currentUser) return;
    try {
        const mod = PushClient;
        const status = await mod.checkPushAvailability();
        if (status.kind !== 'ready') {
            footer.classList.add('d-none');
            return;
        }
        footer.classList.remove('d-none');
        btn.classList.remove('d-none');
        const subscribed = await mod.isCurrentlySubscribed();
        applyPushStatusPill(subscribed);
        const icon = btn.querySelector('i');
        if (subscribed) {
            labelEl.textContent = '푸시 알림 구독 취소';
            if (icon) icon.className = 'mdi mdi-bell-off-outline';
            btn.classList.remove('btn-outline-secondary', 'btn-success');
            btn.classList.add('btn-outline-danger');
        } else {
            labelEl.textContent = '푸시 알림 받기';
            if (icon) icon.className = 'mdi mdi-bell-ring-outline';
            btn.classList.remove('btn-outline-danger', 'btn-outline-secondary');
            btn.classList.add('btn-success');
        }
        btn.onclick = async (e) => {
            e.stopPropagation();
            btn.disabled = true;
            try {
                if (subscribed) {
                    const res = await mod.unsubscribe();
                    if (res.success) {
                        showPushToast('info', '푸시 알림 구독을 해제했습니다');
                    } else {
                        showPushToast('error', '푸시 알림 구독 해제 실패');
                    }
                } else {
                    const res = await mod.subscribeForUser();
                    if (res.success) {
                        showPushToast('success', '푸시 알림을 구독했습니다');
                    } else if (res.reason === 'denied') {
                        if (typeof Swal !== 'undefined') {
                            Swal.fire('알림 권한 차단됨', '브라우저 설정에서 알림 권한을 허용해주세요.', 'warning');
                        }
                    } else if (res.reason === 'unsupported' || res.reason === 'disabled') {
                        showPushToast('warning', '이 브라우저는 푸시 알림을 지원하지 않습니다');
                    } else {
                        showPushToast('error', '푸시 알림 구독에 실패했습니다');
                    }
                }
            } finally {
                btn.disabled = false;
                refreshPushToggle();
            }
        };
    } catch (e) {
        // 푸시 모듈 로드 실패 — 토글 숨김 처리
        footer.classList.add('d-none');
    }
}

async function viewMessage(messageId) {
    try {
        const res = await fetch(`/api/messages/${messageId}`);
        if (!res.ok) throw new Error();
        const msg = await res.json();

        const date = new Date(msg.created_at * 1000).toLocaleString('ko-KR');
        const senderName = msg.sender_name || '알 수 없음';
        const senderPic = isSafeUrl(msg.sender_picture)
            ? `<img src="${escapeHtml(msg.sender_picture)}" class="rounded-circle me-2" width="28" height="28" loading="lazy">`
            : '<i class="mdi mdi-account-circle fs-4 me-2 text-muted"></i>';

        // DM 설정 확인 (답장 가능 여부)
        let canReply = false;
        if (currentUser) {
            const dmRes = await fetch('/api/settings/dm');
            const dmData = dmRes.ok ? await dmRes.json() : { allow_direct_message: 0 };
            const canBypassDm = ['admin', 'super_admin', 'discussion_manager'].includes(currentUser.role);

            if (dmData.allow_direct_message === 1 || canBypassDm) {
                canReply = true;
            } else if (msg.receiver_id === currentUser.id) {
                // DM 비활성화 상태에서 관리자/토론관리자가 보낸 쪽지에 답장 가능
                const senderRole = msg.sender_role || '';
                canReply = ['admin', 'super_admin', 'discussion_manager'].includes(senderRole);
            }
        }

        const showReplyBtn = canReply && currentUser && msg.sender_id !== currentUser.id;
        const replyBtnHtml = showReplyBtn
            ? `<button class="btn btn-sm btn-outline-primary mt-2" id="swal-reply-btn"><i class="mdi mdi-reply"></i> 답장</button>`
            : '';

        if (typeof Swal !== 'undefined') {
            Swal.fire({
                title: '<i class="mdi mdi-email-outline text-primary"></i> 쪽지',
                html: `
                    <div class="text-start">
                        <div class="d-flex align-items-center mb-3 pb-2 border-bottom">
                            ${senderPic}
                            <div>
                                <strong>${escapeHtml(senderName)}</strong>
                                <div class="text-muted small">${date}</div>
                            </div>
                        </div>
                        <div style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(msg.content)}</div>
                        ${replyBtnHtml}
                    </div>
                `,
                showConfirmButton: true,
                confirmButtonText: '닫기',
                width: 480,
                didOpen: () => {
                    const replyBtn = document.getElementById('swal-reply-btn');
                    if (replyBtn) {
                        replyBtn.addEventListener('click', () => {
                            replyToMessage(msg.id, msg.sender_id, senderName);
                        });
                    }
                }
            });
        }

        // 알림 패널 닫기
        _notifPanelOpen = false;
        document.getElementById('notificationPanel')?.classList.add('d-none');
        document.removeEventListener('click', _closeNotifOnOutsideClick);

    } catch (e) {
        if (typeof Swal !== 'undefined') {
            Swal.fire('오류', '쪽지를 불러올 수 없습니다.', 'error');
        }
    }
}

async function replyToMessage(originalMsgId, receiverId, receiverName) {
    if (typeof Swal === 'undefined') return;

    // 기존 Swal 닫기
    Swal.close();

    const { value: content, isConfirmed } = await Swal.fire({
        title: `<i class="mdi mdi-reply text-primary"></i> ${escapeHtml(receiverName)}님에게 답장`,
        input: 'textarea',
        inputPlaceholder: '답장 내용을 입력하세요...',
        inputAttributes: { maxlength: 2000 },
        showCancelButton: true,
        confirmButtonText: '보내기',
        cancelButtonText: '취소',
        width: 480,
        inputValidator: (val) => {
            if (!val || !val.trim()) return '내용을 입력해주세요.';
        }
    });

    if (isConfirmed && content) {
        try {
            const res = await fetch('/api/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ receiver_id: receiverId, content: content.trim(), reply_to: originalMsgId })
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || '발송 실패');
            }

            Swal.fire({ icon: 'success', title: '쪽지 발송 완료', toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
        } catch (e) {
            Swal.fire('오류', '쪽지 발송에 실패했습니다.', 'error');
        }
    }
}

async function sendMessage(receiverId, receiverName) {
    if (typeof Swal === 'undefined') return;

    const { value: content, isConfirmed } = await Swal.fire({
        title: `<i class="mdi mdi-email-plus-outline text-primary"></i> ${escapeHtml(receiverName)}님에게 쪽지`,
        input: 'textarea',
        inputPlaceholder: '쪽지 내용을 입력하세요...',
        inputAttributes: { maxlength: 2000 },
        showCancelButton: true,
        confirmButtonText: '보내기',
        cancelButtonText: '취소',
        width: 480,
        inputValidator: (val) => {
            if (!val || !val.trim()) return '내용을 입력해주세요.';
        }
    });

    if (isConfirmed && content) {
        try {
            const res = await fetch('/api/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ receiver_id: receiverId, content: content.trim() })
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || '발송 실패');
            }

            Swal.fire({ icon: 'success', title: '쪽지 발송 완료', toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
        } catch (e) {
            Swal.fire('오류', '쪽지 발송에 실패했습니다.', 'error');
        }
    }
}



// ── PC 사이드바: 본문 스크롤 연동 및 푸터 겹침 방지 ──
(function () {
    function setupSidebarLayout() {
        const sidebar = document.getElementById('wikiSidebar');
        const footer = document.querySelector('.wiki-footer');
        if (!sidebar || !footer) return;

        const FOOTER_GAP = 16;

        function getNavbarHeight() {
            const navbar = document.querySelector('.navbar');
            return navbar ? navbar.offsetHeight : 0;
        }

        function updateSidebarTop() {
            if (window.innerWidth < 992) {
                sidebar.style.top = '';
                return;
            }
            const navH = getNavbarHeight();
            const top = Math.max(0, navH - window.scrollY);
            sidebar.style.top = top + 'px';
        }

        function update() {
            const layout = sidebar.closest('.wiki-layout');
            if (!layout) return;
            const container = layout.querySelector('.wiki-container');
            if (!container) return;

            if (window.innerWidth < 992) {
                container.style.paddingBottom = '';
                return;
            }

            // 자연 높이 측정을 위해 초기화
            container.style.paddingBottom = '';

            const sidebarH = sidebar.scrollHeight;
            const containerH = container.scrollHeight;

            // 사이드바가 본문보다 긴 경우: 본문 아래에 여백을 추가하여
            // flex 컨테이너가 사이드바 전체를 포함할 수 있도록 함
            if (sidebarH > containerH) {
                const extraPadding = sidebarH - containerH + FOOTER_GAP;
                container.style.paddingBottom = extraPadding + 'px';
            }

            updateSidebarTop();
        }

        window.addEventListener('scroll', updateSidebarTop, { passive: true });
        window.addEventListener('resize', update, { passive: true });
        update();
        // SPA 네비게이션 후 외부에서 호출 가능하도록 노출
        window.__sidebarLayoutUpdate = update;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupSidebarLayout);
    } else {
        setupSidebarLayout();
    }
})();

// ── 모바일 사이드바 열림/닫힘 시 헤더 숨기기/표시 ──
(function () {
    function setupSidebarHeaderToggle() {
        const sidebar = document.getElementById('mobileSidebar');
        if (!sidebar) return;
        const navbar = document.querySelector('.navbar');
        if (!navbar) return;

        sidebar.addEventListener('show.bs.offcanvas', function () {
            navbar.classList.add('header-hidden-mobile');
        });
        sidebar.addEventListener('hide.bs.offcanvas', function () {
            navbar.classList.remove('header-hidden-mobile');
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupSidebarHeaderToggle);
    } else {
        setupSidebarHeaderToggle();
    }
})();

// ── 개인 설정 모달 이벤트 바인딩 ──
(function () {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupSettingsModal);
    } else {
        setupSettingsModal();
    }
})();

// ── 상대 시간 변환 ──
function getRelativeTime(unixTs) {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - unixTs;
    if (diff < 60) return '방금 전';
    if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}일 전`;
    return new Date(unixTs * 1000).toLocaleDateString('ko-KR');
}

// ── 최근 변경 로드 (recent-changes-container 클래스를 가진 모든 요소에 채움) ──
async function loadRecentChanges() {
    try {
        const res = await fetch('/api/w/recent-changes');
        if (!res.ok) return;
        const data = await res.json();

        const html = data.changes.map(item => {
            const timeAgo = getRelativeTime(item.updated_at);
            return `
              <a href="/w/${encodeURIComponent(item.slug)}" class="recent-change-item"
                 onclick="if(typeof navigateTo==='function'){navigateTo(this.href);return false;}">
                <div class="rc-title">${escapeHtml(item.slug)}</div>
                <div class="rc-meta">
                  <span class="rc-time">${timeAgo}</span>
                  <span class="rc-author">${escapeHtml(item.author_name || '알 수 없음')}</span>
                </div>
              </a>
            `;
        }).join('');

        const emptyMsg = emptyState({ compact: true, icon: 'bi bi-inbox', title: '변경 내역이 없습니다' });
        const content = data.changes.length > 0 ? html : emptyMsg;

        document.querySelectorAll('.recent-changes-container').forEach(el => {
            el.innerHTML = content;
            const section = el.closest('.sidebar-section');
            if (section) {
                const title = section.querySelector('.sidebar-title');
                if (title && !title.querySelector('a')) {
                    const link = document.createElement('a');
                    link.href = '/recent-changes';
                    link.className = 'text-decoration-none text-reset';
                    link.addEventListener('click', function (e) {
                        e.preventDefault();
                        if (typeof navigateTo === 'function') {
                            navigateTo(this.href);
                            const sidebar = document.getElementById('mobileSidebar');
                            if (sidebar) {
                                const bsOffcanvas = bootstrap?.Offcanvas?.getInstance(sidebar);
                                if (bsOffcanvas) bsOffcanvas.hide();
                            }
                        } else {
                            window.location.href = this.href;
                        }
                    });
                    while (title.firstChild) {
                        link.appendChild(title.firstChild);
                    }
                    title.appendChild(link);
                }
            }
        });
    } catch (e) {
        // 무시
    }
}

// ── 실시간 트렌딩 로드 ──
// ── 실시간 트렌딩 로드 ──
async function loadTrending() {
    try {
        const res = await fetch('/api/analytics/trending?limit=10');
        if (!res.ok) return;
        const data = await res.json();

        // 트렌딩 문서 표시 간소화: 일반 텍스트 순위, 조회수 미표시
        const html = (data.trending || []).map((item, index) => {
            return `
              <a href="/w/${encodeURIComponent(item.slug)}" class="text-decoration-none d-flex align-items-center py-2 px-2 text-body trending-item-link"
                 onclick="if(typeof navigateTo==='function'){navigateTo(this.href);return false;}">
                <span class="text-muted fw-bold me-2 flex-shrink-0" style="font-size: 0.95rem; white-space: nowrap;">${index + 1}.</span>
                <span class="text-truncate" style="font-size: 0.95rem; min-width: 0;">${escapeHtml(item.slug)}</span>
              </a>
            `;
        }).join('');

        const emptyMsg = emptyState({ compact: true, icon: 'bi bi-graph-up', title: '트렌딩 데이터가 없습니다' });
        const content = data.trending && data.trending.length > 0 ? html : emptyMsg;

        document.querySelectorAll('.trending-container').forEach(el => {
            el.innerHTML = content;
            if (data.trending && data.trending.length > 0) {
                initTrendingTicker(el, Math.min(data.trending.length, 10));
            }
        });
    } catch (e) {
        // 무시
    }
}

function initTrendingTicker(container, count) {
    const parent = container.parentElement;
    if (!parent || !parent.classList.contains('trending-ticker-wrapper')) return;

    const getItemHeight = () => {
        const firstItem = container.querySelector('.trending-item-link');
        if (!firstItem) return 38;
        const rect = firstItem.getBoundingClientRect();
        return Math.max(1, Math.round(rect.height || 38));
    };

    let itemHeight = getItemHeight();

    const applyFoldedState = () => {
        parent.style.height = `${itemHeight}px`;
        container.style.transform = `translateY(-${currentIndex * itemHeight}px)`;
    };

    parent.style.height = `${itemHeight}px`;
    parent.style.transition = 'height 0.4s ease'; // Expand/fold animation
    container.style.position = 'absolute';
    container.style.top = '0';
    container.style.left = '0';
    container.style.width = '100%';
    container.style.transition = 'transform 0.4s ease';

    let currentIndex = 0;
    let tickerInterval = setInterval(slideNext, 3000);
    let isExpanded = false;

    function slideNext() {
        if (isExpanded || document.hidden) return;
        currentIndex++;
        if (currentIndex >= count) {
            currentIndex = 0;
            container.style.transition = 'none';
            container.style.transform = 'translateY(0)';
            // force flush layout
            void container.offsetHeight;
            container.style.transition = 'transform 0.4s ease';
            return;
        }
        container.style.transform = `translateY(-${currentIndex * itemHeight}px)`;
    }

    window.addEventListener('resize', () => {
        const nextHeight = getItemHeight();
        if (nextHeight === itemHeight) return;
        itemHeight = nextHeight;
        if (isExpanded) {
            parent.style.height = `${count * itemHeight}px`;
        } else {
            applyFoldedState();
        }
    }, { passive: true });

    const section = container.closest('.sidebar-section');
    const expandBtn = section ? section.querySelector('.trending-expand-btn') : null;

    if (expandBtn) {
        // 클릭 시 이벤트 전파 방지 등을 고려해 다시 세팅
        const clone = expandBtn.cloneNode(true);
        expandBtn.replaceWith(clone);

        clone.addEventListener('click', (e) => {
            e.preventDefault();
            isExpanded = !isExpanded;
            if (isExpanded) {
                // 펼치기 - 애니메이션으로 전체 높이 적용, 변형 초기화
                parent.style.height = `${count * itemHeight}px`;
                container.style.transform = 'translateY(0)';
                clone.innerHTML = '접기 <i class="bi bi-chevron-up"></i>';
                clearInterval(tickerInterval);
            } else {
                // 접기 - 다시 1줄 크기로, 현재 순위 위치로 이동 애니메이션
                applyFoldedState();
                clone.innerHTML = '펼치기 <i class="bi bi-chevron-down"></i>';
                tickerInterval = setInterval(slideNext, 3000);
            }
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// window 브리지 — classic public/js/common.js 시절 모든 top-level 선언이
// classic-script-global 로 자동 노출되었으므로, ESM 으로 이전한 뒤에도 동일한
// 외부 계약을 유지한다. 14개 HTML 페이지의 inline classic <script> 가
// bare 식별자로 호출 (`loadConfig`, `currentUser`, `escapeHtml`, `cycleTheme`,
// `goRandomPage`, `toggleNotificationPanel`, `doSearch` 등) 하므로 누락 시 회귀.
// ESM 모듈 (edit/main.ts / render.ts 등) 도 window.* 로 읽으므로 동일하게 필수.
// ─────────────────────────────────────────────────────────────────────────────
window.appConfig = appConfig;
window.currentUser = currentUser;
window.isSafeUrl = isSafeUrl;
window.escapeHtml = escapeHtml;
window.uiEmptyState = emptyState;
window.uiInlineLoading = inlineLoading;
window.uiSkeletonLines = skeletonLines;
window.uiSkeletonList = skeletonList;
window.uiSkeletonCards = skeletonCards;
window.mountMediaTagInput = mountMediaTagInput;
window.doSearch = doSearch;
window.applyThemeClass = applyThemeClass;
window.applyBsTheme = applyBsTheme;
window.setTheme = setTheme;
window.getCurrentTheme = getCurrentTheme;
window.cycleTheme = cycleTheme;
window.updateThemeToggleUI = updateThemeToggleUI;
window.openSettingsModal = openSettingsModal;
window.goRandomPage = goRandomPage;
window.applyAnnouncementBanner = applyAnnouncementBanner;
window.loadConfig = loadConfig;
window.checkAuth = checkAuth;
window.startNotifPolling = startNotifPolling;
window.stopNotifPolling = stopNotifPolling;
window.loadNotificationCount = loadNotificationCount;
window.toggleNotificationPanel = toggleNotificationPanel;
window.handleNotificationClick = handleNotificationClick;
window.loadNotifications = loadNotifications;
window.deleteNotification = deleteNotification;
window.renderUserRoleIcon = renderUserRoleIcon;
window.initRoleIconPopovers = initRoleIconPopovers;
window.viewMessage = viewMessage;
window.replyToMessage = replyToMessage;
window.sendMessage = sendMessage;
window.getRelativeTime = getRelativeTime;
window.loadRecentChanges = loadRecentChanges;
window.loadTrending = loadTrending;
window.initTrendingTicker = initTrendingTicker;
