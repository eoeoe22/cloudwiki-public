// @ts-nocheck
/**
 * 앱 독립 공통 테마/레이아웃 유틸리티.
 *
 * cloudwiki(common-wiki.ts)와 cloudspace 양쪽이 공유하는 최소한의 클라이언트 부트스트랩.
 * 위키 전용 로직(isForcedDark·스킨 시스템·인증·알림·푸시·사이드바 콘텐츠)은 포함하지 않는다.
 *
 * - 테마(다크/라이트/오토) 초기화·전환
 * - 레이아웃 오버라이드(localStorage 기반)
 * - 설정 모달 세그먼트 헬퍼
 * - 키보드 단축키 설정 읽기
 * - ui-state, html, url 유틸리티 재노출
 */

import { emptyState, inlineLoading, skeletonLines, skeletonList, skeletonCards } from './ui-state';
import { escapeHtml } from './html';
import { isSafeUrl } from './url';

// ── 테마 초기화 IIFE ──
// HTML head 의 인라인 스크립트가 먼저 실행되지 않는 환경(예: 추후 standalone workspace)을
// 위한 fallback. data-theme: 앱 자체 다크모드 변수, data-bs-theme: Bootstrap 컴포넌트 다크모드.
(function () {
    try {
        var saved = localStorage.getItem('themeMode') || 'auto';
        if (saved === 'light' || saved === 'dark') {
            document.documentElement.setAttribute('data-theme', saved);
        }
    } catch (e) { /* 스토리지 접근 불가 시 auto 유지 */ }
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

function applyThemeClass(mode) {
    if (mode === 'light' || mode === 'dark') {
        document.documentElement.setAttribute('data-theme', mode);
    } else {
        document.documentElement.removeAttribute('data-theme');
    }
    applyBsTheme(mode);
    try { window.dispatchEvent(new CustomEvent('wiki:theme-changed', { detail: { mode: mode } })); } catch (e) { /* noop */ }
}

function setTheme(mode) {
    var validModes = ['light', 'dark', 'auto'];
    if (validModes.indexOf(mode) === -1) mode = 'auto';
    try { localStorage.setItem('themeMode', mode); } catch (e) { /* 스토리지 접근 불가 시 무시 */ }
    applyThemeClass(mode);
}

function getCurrentTheme() {
    try { return localStorage.getItem('themeMode') || 'auto'; } catch (e) { return 'auto'; }
}

// ── 레이아웃 모드 오버라이드 ──
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
    if (window.appConfig) window.appConfig.layoutMode = v;
}

// ── 설정 모달 세그먼트 헬퍼 ──
function setSegActive(groupEl, value) {
    if (!groupEl) return;
    var btns = groupEl.querySelectorAll('.seg-btn');
    for (var i = 0; i < btns.length; i++) {
        var on = btns[i].getAttribute('data-value') === value;
        btns[i].classList.toggle('active', on);
        btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
}

var KBD_SHORTCUTS_KEY = 'keyboardShortcutsEnabled';
function getKeyboardShortcutsPref() {
    try { return localStorage.getItem(KBD_SHORTCUTS_KEY) === 'off' ? 'off' : 'on'; } catch (e) { return 'on'; }
}

// ── window 브리지 ──
window.applyBsTheme = applyBsTheme;
window.applyThemeClass = applyThemeClass;
window.setTheme = setTheme;
window.getCurrentTheme = getCurrentTheme;
window.getLayoutOverride = getLayoutOverride;
window.applyLayoutOverride = applyLayoutOverride;
window.setSegActive = setSegActive;
window.getKeyboardShortcutsPref = getKeyboardShortcutsPref;
window.escapeHtml = escapeHtml;
window.isSafeUrl = isSafeUrl;
window.uiEmptyState = emptyState;
window.uiInlineLoading = inlineLoading;
window.uiSkeletonLines = skeletonLines;
window.uiSkeletonList = skeletonList;
window.uiSkeletonCards = skeletonCards;
