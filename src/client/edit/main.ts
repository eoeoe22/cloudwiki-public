// @ts-nocheck — Phase 4-7 의 1차 마이그레이션은 동작 보존을 우선해 임시로 type
// 검사를 끈다. CodeMirror 6 패키지가 npm 설치되어 있지 않아 ViewPlugin.fromClass /
// MatchDecorator decorate 콜백 등의 정확한 타입을 얻지 못하고, HTMLElement subclass
// 캐스팅이 100+ 곳에 흩어져 있어 1회성 도입으로 다루기 어렵다. 후속 Phase 4-7.1 에서
// (1) @codemirror/* devDeps 추가 또는 .d.ts shim 정밀화, (2) HTML 요소 캐스팅 정리,
// (3) window.* non-null 단정 정리를 끝내고 본 디렉티브를 제거할 예정.
/**
 * 에디터(public/edit.html / public/blog-edit.html) 진입점.
 *
 * Phase 4-7 마이그레이션: public/js/edit.js (classic) → src/client/edit/main.ts (ESM).
 * - CodeMirror 6 모듈은 **CM6 가 실제로 필요한 비-extension 편집 경로 안에서 동적
 *   import 로 로드한다.** 이는 (1) esm.sh CDN 이 unreachable 일 때 익스텐션 데이터
 *   편집 경로와 다른 페이지 로직(인증 / 저장 / 취소 등)이 살아남도록 하며, (2) Turnstile
 *   ?onload= 콜백 노출이 외부 import 네트워크 대기에 의해 지연되지 않도록 하기 위함이다.
 * - vite.config.ts 의 rollupOptions.external 가 `@codemirror/*` 와 `@lezer/highlight`
 *   를 외부화하므로 번들에 포함되지 않으며, HTML 의 `<script type="importmap">` 이
 *   esm.sh CDN 으로 해석한다.
 * - 인라인 onclick 핸들러(savePage / cancelEdit / reloadTurnstile / onTurnstileLoad)
 *   는 module top-level 의 가장 이른 시점에서 window.* 로 노출한다.
 * - 다른 모듈이 read/write 하는 state(slug, editor, sectionMode 등)는 types.ts 에
 *   선언된 window 프로퍼티를 직접 read/write 한다 — 모듈 내부 로컬 미러는 두지 않는다.
 */
import './types';
import { escapeHtml } from '../utils/html';
import { normalizeSlug, hasSlugForbiddenChars } from '../utils/slug';
import { CDN_URLS } from '../../shared/cdn';
import { snapshotPreviewState, restorePreviewState } from './preview-state';
import { splitSlides } from '../render-presentation';
import type { CMEditor, CMSelection, PageMeta, SectionRange } from './types';

declare global {
    interface Window {
        /** blog-edit.html 인라인 스크립트가 설정 (true = 블로그 편집 모드) */
        BLOG_MODE?: boolean;
        /** Turnstile <script ?onload=onTurnstileLoad> 콜백 — module top-level 에서 노출 */
        onTurnstileLoad?: () => void;
        /** Turnstile pre-bootstrap stub (HTML <head>) 이 모듈 평가 전 fire 를 기록 */
        __turnstileEarlyFire?: boolean;
        /** Turnstile pre-bootstrap stub 이 호출하는 실제 핸들러 슬롯 — 모듈이 채워줌 */
        __turnstileLoadHandler?: () => void;
        /** edit.html / blog-edit.html 의 인라인 onclick="savePage()" */
        savePage?: () => void | Promise<void>;
        /** edit.html 의 인라인 onclick="cancelEdit()" */
        cancelEdit?: () => void | Promise<void>;
        /** edit.html / blog-edit.html 의 인라인 onclick="reloadTurnstile()" */
        reloadTurnstile?: () => void;
        /** edit.html 섹션 편집 배너의 인라인 onclick="openSplitToSubdocModal()" */
        openSplitToSubdocModal?: () => Promise<void>;
    }
}

// ── 블로그 모드 (blog-edit.html에서 window.BLOG_MODE = true로 설정) ──
const BLOG_MODE = !!(window.BLOG_MODE);
let blogPostId: string | null = null; // 기존 포스트 수정 시 ID (?id= 파라미터)

// ── MCP 편집안 충돌 해결 모드 ──
// /edit?slug=...&mcp_submission=<id> 로 진입하면 (mypage 의 "에디터에서 충돌 해결" 동선)
// 정상 페이지 로드 대신 /api/mcp-submissions/<id> 의 base/proposed/current 본문을
// 받아 3-way merge UI 를 자동으로 띄운다. 저장이 성공하면 /resolve 로 draft 를 정리한다.
let mcpSubmissionId: number | null = null;

// ── 편집 요청 검토(승인) 모드 ──
// /edit?slug=...&edit_request=<id> 로 진입하면(문서 페이지 "에디터에서 편집") 정상 페이지 로드 대신
// /api/pending-edits/<id> 의 요청 본문을 에디터에 적재하고, 저장 시 정상 PUT 대신
// approve(content) 를 호출해 2-리비전(요청자+승인자)으로 반영한다. 적재 성공 시에만 켜진다.
let editRequestId: number | null = null;

// ── Turnstile 상태 ──
let turnstileToken: string | null = null;
let turnstileWidgetId: string | null = null;
let turnstileReady = false;
// 저장 시도 시 검증 모달이 떠 있는 동안의 pending Promise 와 cleanup 핸들.
// 원본 위젯이 모달 도중 자동 검증으로 통과하면 callback 이 이를 resolve(true) 한다.
let pendingTurnstileVerification: { resolve: (ok: boolean) => void } | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// 인라인 onclick / 외부 CDN 콜백 브리지 — module body 의 가장 이른 시점에서 노출.
//
// Turnstile 콜백 처리:
//   <head> 의 inline <script> 가 사전에 stub `window.onTurnstileLoad` 를 등록하고,
//   모듈 평가 전 Turnstile 이 fire 하면 `window.__turnstileEarlyFire = true` 로
//   기록한다. 이 모듈은 실제 핸들러를 `window.__turnstileLoadHandler` 슬롯에
//   채워주고 (이후의 fire 는 stub → 슬롯으로 디스패치), 큐된 fire 가 있으면 즉시
//   replay 한다. `window.onTurnstileLoad` 도 reloadTurnstile 의 재주입 경로와
//   호환되도록 실제 핸들러로 덮어쓴다.
// 동일한 이유로 인라인 onclick 핸들러(savePage / cancelEdit / reloadTurnstile) 와
// scrollToBottom (다른 모듈이 호출 가능) 도 즉시 노출. CodeMirrorView 는 CM6 가 로드된
// 후에만 의미가 있으므로 CM6 path 안에서 노출한다.
// ─────────────────────────────────────────────────────────────────────────────
window.__turnstileLoadHandler = onTurnstileLoad;
window.onTurnstileLoad = onTurnstileLoad;
if (window.__turnstileEarlyFire) {
    window.__turnstileEarlyFire = false;
    onTurnstileLoad();
}
window.reloadTurnstile = reloadTurnstile;
window.savePage = savePage;
window.cancelEdit = cancelEdit;
window.scrollToBottom = scrollToBottom;
window.openSplitToSubdocModal = openSplitToSubdocModal;

// ─────────────────────────────────────────────────────────────────────────────
// 모듈 로컬 에디터 상태 — 동시에 window.* 로 mirror 한다.
//
// edit/utils.ts (먼저 평가되는 ESM) 가 이미 window.editor / window.slug 등을
// 초기화하므로 모듈 평가 시점의 값을 그대로 가져와 시작한다. 이후 main.ts 가
// state 를 갱신할 때마다 window.* 도 동시에 갱신해야 다른 모듈이 본다.
// (`assignState` 헬퍼로 두 갱신을 한 줄로 처리)
// ─────────────────────────────────────────────────────────────────────────────
let editor: CMEditor | null = window.editor ?? null;
let slug: string | null = window.slug ?? null;
let sectionMode: boolean = window.sectionMode ?? false;
let sectionIndex: number = window.sectionIndex ?? -1;
let sectionHeadingParam: string = window.sectionHeadingParam ?? '';
let DRAFT_KEY: string = window.DRAFT_KEY ?? '';
let originalContent: string = window.originalContent ?? '';
let originalPageMeta: PageMeta | null = (window.originalPageMeta as PageMeta | null) ?? null;
let pageVersion: number | string | null = window.pageVersion ?? null;
let categoryTags: string[] = window.categoryTags ?? [];
let fullOriginalContent: string = window.fullOriginalContent ?? '';
let sectionRange: SectionRange | null = window.sectionRange ?? null;
let pageLeft: boolean = window.pageLeft ?? false;
let isExtensionData: boolean = window.isExtensionData ?? false;
let selectedIconsOnly: boolean = window.selectedIconsOnly ?? false;

// 모듈-내부 read 는 위 로컬 변수를 그대로 사용하고, write 는 항상 이 헬퍼로
// 모아 window.* 로도 동기화한다. (다른 모듈이 window.editor / window.slug 등을
// 직접 읽는다)
function syncStateToWindow(): void {
    window.editor = editor;
    window.slug = slug;
    window.sectionMode = sectionMode;
    window.sectionIndex = sectionIndex;
    window.sectionHeadingParam = sectionHeadingParam;
    window.DRAFT_KEY = DRAFT_KEY;
    window.originalContent = originalContent;
    window.originalPageMeta = originalPageMeta;
    window.pageVersion = pageVersion;
    window.categoryTags = categoryTags;
    window.fullOriginalContent = fullOriginalContent;
    window.sectionRange = sectionRange;
    window.pageLeft = pageLeft;
    window.isExtensionData = isExtensionData;
    window.selectedIconsOnly = selectedIconsOnly;
}
// utils.ts 의 checkDraft 가 section→full-edit promotion 시 window.sectionMode /
// sectionRange / DRAFT_KEY / originalContent 등을 직접 갱신한다. 모듈 로컬 변수를
// 그대로 두면 savePage 가 stale 한 sectionMode=true / sectionRange 를 읽어
// editor 의 (이미 full doc 인) 본문을 다시 mergeSectionIntoFull 로 감싸 본문이
// 손상된다. 따라서 외부에서 window.* 만 쓰는 분기가 끝나면 이 헬퍼로 로컬을
// 다시 끌어와 동기 상태로 맞춘다.
function syncStateFromWindow(): void {
    if (window.editor !== undefined) editor = window.editor;
    if (typeof window.slug === 'string' || window.slug === null) slug = window.slug;
    if (typeof window.sectionMode === 'boolean') sectionMode = window.sectionMode;
    if (typeof window.sectionIndex === 'number') sectionIndex = window.sectionIndex;
    if (typeof window.sectionHeadingParam === 'string') sectionHeadingParam = window.sectionHeadingParam;
    if (typeof window.DRAFT_KEY === 'string') DRAFT_KEY = window.DRAFT_KEY;
    if (typeof window.originalContent === 'string') originalContent = window.originalContent;
    if (window.originalPageMeta !== undefined) originalPageMeta = window.originalPageMeta as PageMeta | null;
    if (window.pageVersion !== undefined) pageVersion = window.pageVersion;
    if (Array.isArray(window.categoryTags)) categoryTags = window.categoryTags;
    if (typeof window.fullOriginalContent === 'string') fullOriginalContent = window.fullOriginalContent;
    if (window.sectionRange !== undefined) sectionRange = window.sectionRange;
    if (typeof window.pageLeft === 'boolean') pageLeft = window.pageLeft;
    if (typeof window.isExtensionData === 'boolean') isExtensionData = window.isExtensionData;
    if (typeof window.selectedIconsOnly === 'boolean') selectedIconsOnly = window.selectedIconsOnly;
}
// 초기 상태 미러 (특히 default 값을 처음 적용)
syncStateToWindow();

function onTurnstileLoad() {
    turnstileReady = true;
    initTurnstile();
}

function initTurnstile() {
    const siteKey = window.appConfig && window.appConfig.turnstileSiteKey;
    if (!siteKey) {
        // Turnstile 미설정 시 저장 버튼 활성화
        const btn = document.getElementById('saveBtn');
        if (btn) btn.disabled = false;
        return;
    }
    // Turnstile 필요 환경 → 새로고침 버튼 노출 (스크립트 로드 실패 시에도 재시도 가능)
    const refreshBtn = document.getElementById('turnstileRefreshBtn');
    if (refreshBtn) refreshBtn.style.display = '';

    if (!turnstileReady) return;
    const container = document.getElementById('turnstile-container');
    if (!container || turnstileWidgetId !== null) return;
    turnstileWidgetId = window.turnstile!.render(container, {
        sitekey: siteKey,
        callback: function (token) {
            turnstileToken = token;
            const btn = document.getElementById('saveBtn');
            if (btn) btn.disabled = false;
            // 검증 모달이 열려 있는 동안 원본 위젯이 자동 검증으로 통과한 경우
            // 모달을 즉시 닫고 저장 절차를 진행한다.
            if (pendingTurnstileVerification) {
                pendingTurnstileVerification.resolve(true);
            }
        },
        'expired-callback': function () {
            turnstileToken = null;
            // 만료 시 저장 버튼은 그대로 두고, 다음 저장 시도에서 검증 모달이 띄워진다.
            refreshTurnstile();
        },
        'error-callback': function () {
            turnstileToken = null;
        },
    });
    // 위젯이 렌더링되면 사용자가 저장을 시도할 수 있도록 버튼을 활성화한다.
    // 토큰이 없는 상태에서 저장 시도 시에는 ensureTurnstileVerified 가 검증 모달을 띄운다.
    const btn = document.getElementById('saveBtn');
    if (btn) btn.disabled = false;
}

function refreshTurnstile() {
    if (turnstileWidgetId !== null) {
        turnstileToken = null;
        window.turnstile!.reset(turnstileWidgetId);
    }
}

// 사용자가 수동으로 Turnstile을 다시 로드할 때 호출.
// 탭이 불완전하게 리프레시되어 Turnstile 스크립트가 로드되지 않으면 저장이 막히므로,
// 스크립트/위젯을 모두 초기화한 뒤 다시 주입하여 복구한다.
function reloadTurnstile() {
    const container = document.getElementById('turnstile-container');
    if (!container) return;

    if (typeof window.turnstile !== 'undefined' && turnstileWidgetId !== null) {
        try { window.turnstile!.remove(turnstileWidgetId); } catch (e) { /* ignore */ }
    }
    turnstileWidgetId = null;
    turnstileToken = null;
    container.innerHTML = '';

    const btn = document.getElementById('saveBtn');
    if (btn) btn.disabled = true;

    if (typeof window.turnstile !== 'undefined' && turnstileReady) {
        initTurnstile();
    } else {
        turnstileReady = false;
        const oldScript = document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]');
        if (oldScript) oldScript.remove();
        const script = document.createElement('script');
        script.src = CDN_URLS.turnstileJs;
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
    }
}

// ── 저장 직전 Turnstile 검증 모달 ──
// 저장이 시도되었지만 turnstileToken 이 없을 때, 화면 중앙에 새 Turnstile 위젯을
// 렌더링한 오프캔버스 모달을 띄운다. 모달 바깥(또는 ESC)을 누르면 저장 절차가
// 취소되고 원래대로 복귀하며, 모달 위젯이 검증을 통과하면 turnstileToken 을 설정한
// 뒤 Promise 가 true 로 resolve 되어 저장 흐름이 계속된다.
//
// 원본 turnstile-container 위젯은 모달 표시 동안 같은 색상 오버레이로 시각적으로
// 가려 두 위젯이 동시에 노출되는 혼란을 막는다(모달이 닫히면 오버레이도 제거).
function ensureTurnstileVerified(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const siteKey = window.appConfig && window.appConfig.turnstileSiteKey;
        // Turnstile 비활성 또는 이미 토큰 보유: 그대로 진행
        if (!siteKey || turnstileToken) {
            resolve(true);
            return;
        }
        // 스크립트/위젯 로드 전이면 모달을 띄울 수 없으므로 기존 안내로 대체
        if (typeof window.turnstile === 'undefined' || !turnstileReady) {
            window.Swal.fire({
                icon: 'warning',
                title: 'Turnstile 미준비',
                text: '보안 검증 스크립트가 아직 로드되지 않았습니다. "캡챠 다시 로드" 버튼을 누른 뒤 다시 시도해주세요.',
            });
            resolve(false);
            return;
        }
        if (pendingTurnstileVerification) {
            // 이미 모달이 떠 있다면 중복 호출은 무시(이전 호출의 결과를 그대로 따른다)
            resolve(false);
            return;
        }

        // 1) 원본 위젯을 배경 컬러로 가리기
        const originalContainer = document.getElementById('turnstile-container');
        let originalCover: HTMLDivElement | null = null;
        let prevContainerPos = '';
        if (originalContainer) {
            prevContainerPos = originalContainer.style.position;
            originalContainer.style.position = 'relative';
            originalCover = document.createElement('div');
            originalCover.className = 'turnstile-original-cover';
            originalContainer.appendChild(originalCover);
        }

        // 2) 오프캔버스 풍 모달 오버레이 + 다이얼로그 생성
        const overlay = document.createElement('div');
        overlay.className = 'turnstile-verify-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', '저장 전 보안 인증');

        const dialog = document.createElement('div');
        dialog.className = 'turnstile-verify-dialog';

        const titleEl = document.createElement('div');
        titleEl.className = 'turnstile-verify-title';
        titleEl.textContent = '저장 전 보안 인증';

        const bodyEl = document.createElement('div');
        bodyEl.className = 'turnstile-verify-body';
        bodyEl.textContent = '계속 저장하려면 아래 보안 검증을 완료해주세요.';

        const mount = document.createElement('div');
        mount.className = 'turnstile-verify-mount';

        const hintEl = document.createElement('div');
        hintEl.className = 'turnstile-verify-hint';
        hintEl.textContent = '바깥 영역을 클릭하거나 ESC 키를 누르면 저장이 취소됩니다.';

        dialog.appendChild(titleEl);
        dialog.appendChild(bodyEl);
        dialog.appendChild(mount);
        dialog.appendChild(hintEl);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        let modalWidgetId: string | null = null;
        let settled = false;

        const cleanup = () => {
            if (modalWidgetId !== null) {
                try { window.turnstile!.remove(modalWidgetId); } catch (e) { /* ignore */ }
                modalWidgetId = null;
            }
            if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
            if (originalContainer) {
                if (originalCover && originalCover.parentElement === originalContainer) {
                    originalContainer.removeChild(originalCover);
                }
                originalContainer.style.position = prevContainerPos;
            }
            document.removeEventListener('keydown', onKey, true);
            pendingTurnstileVerification = null;
        };

        const finish = (ok: boolean) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(ok);
        };

        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                finish(false);
            }
        };
        document.addEventListener('keydown', onKey, true);

        // 다이얼로그 내부 클릭은 취소로 전파되지 않도록 차단
        dialog.addEventListener('click', (e) => e.stopPropagation());
        overlay.addEventListener('click', () => finish(false));

        pendingTurnstileVerification = { resolve: finish };

        try {
            modalWidgetId = window.turnstile!.render(mount, {
                sitekey: siteKey,
                callback: function (token: string) {
                    turnstileToken = token;
                    const btn = document.getElementById('saveBtn');
                    if (btn) btn.disabled = false;
                    finish(true);
                },
                'expired-callback': function () {
                    turnstileToken = null;
                },
                'error-callback': function () {
                    // 모달은 그대로 두어 사용자가 재시도하거나 바깥 클릭으로 취소할 수 있게 한다.
                },
            });
        } catch (e) {
            finish(false);
            window.Swal.fire('오류', '보안 검증 위젯을 렌더링하지 못했습니다.', 'error');
        }
    });
}

// 아이콘 피커 상태(biIconList, mdiIconList, selectedIconsList, iconPickerToken,
// iconPickerSavedSelection, pendingIconInsertion)는 edit/modals.ts(ESM)가 관리.
// selectedIconsOnly (SELECTED_ICONS_ONLY 환경변수) 는 위쪽 모듈 상태 블록에서 선언했다.

// ── 커스텀 프리뷰 렌더링 (render.js의 window.renderWikiContent 모듈 사용) ──
let previewDebounce;
let saveInProgress = false;
// 렌더 diff(buildRichDiffHtml)는 비동기라 빠른 연속 편집 시 stale 결과가 최신 결과를
// 덮어쓰지 않도록 호출 토큰으로 가드한다.
let _previewDiffSeq = 0;

// 변경 사항 미리보기 모드: 'off'(일반 렌더) | 'text'(텍스트 diff) | 'rendered'(렌더 diff)
// "변경사항 미리 보기" 체크박스가 켜지면 text, 추가로 "렌더링 미리 보기"가 켜지면 rendered.
function getDiffPreviewMode() {
    const toggle = document.getElementById('diffPreviewToggle');
    if (!toggle || !toggle.checked) return 'off';
    const rendered = document.getElementById('diffPreviewRenderedToggle');
    return (rendered && rendered.checked) ? 'rendered' : 'text';
}

// ── 프리뷰 보기 모드(슬라이드 덱 분기) ─────────────────────────────────────────
// CM6 init 클로저의 setPcMode 가 갱신하는 현재 PC 보기 모드의 모듈 레벨 미러.
// module-level 인 updateCustomPreview 가 클로저 밖에서 모드를 읽기 위해 둔다.
let pcViewMode = 'split';
// 슬라이드 덱이 현재 프리뷰에 렌더돼 있는지 — 일반 렌더 경로로 복귀할 때
// 프레젠테이션 전역 핸들러(키보드/해시/풀스크린)를 한 번만 정리하기 위한 게이트.
let _deckActive = false;

// ── 통합 단일 슬라이드 편집 상태 ──────────────────────────────────────────────
// 프레젠테이션 문서 + 일반(split) 모드일 때 활성. 에디터 CM 문서는 "현재 슬라이드"
// 텍스트만 보유하고, editor.getMarkdown() 은 재구성된 전체 문서를 반환한다.
//  - slides:  전체 문서를 `---` 로 분할한 정규 슬라이드 배열(빈 슬라이드 유지)
//  - idx:     현재 편집 중인 슬라이드 인덱스
//  - suppressChange: 프로그램적 에디터 스왑 중 change 핸들러를 무력화하는 가드
//  - enterDoc/enterCanonical: 진입 시점 원본 전체 문서와 그 정규화 형태. 슬라이드 내용이
//    진입 시점과 동일하면(구분자 공백 차이뿐) 원본을 그대로 반환해 불필요한 화이트스페이스
//    변경·거짓 미저장 경고를 막는다.
const slideCtl = {
    active: false,
    slides: [] as string[],
    idx: 0,
    suppressChange: false,
    enterDoc: '',
    enterCanonical: '',
};
// 슬라이드 조인 구분자. 앞뒤 빈 줄로 setext heading 오인을 막고 splitSlides 왕복을 안정화한다.
const SLIDE_JOIN = '\n\n---\n\n';
// 슬라이드 앞뒤의 빈 줄만 제거(첫 줄 들여쓰기·내부 빈 줄은 보존). 정규화의 멱등성을 보장.
function trimSlide(s: string): string {
    return (s || '').replace(/^\n+/, '').replace(/\n+$/, '');
}
// 슬라이드 배열을 정규 전체 문서로 합친다(각 슬라이드 trim + SLIDE_JOIN). 멱등.
function canonicalizeSlides(parts: string[]): string {
    return parts.map(trimSlide).join(SLIDE_JOIN);
}
// 덱(프리뷰)의 활성 슬라이드가 바뀔 때 호출될 콜백 — CM init 클로저가 채운다.
// (module-level updateCustomPreview 가 renderPresentation 에 넘기기 위해 슬롯으로 둔다.)
let _onDeckSlideChanged: ((idx: number) => void) | null = null;
// 에디터 하단 슬라이드 내비게이션 바(인디케이터/이동 버튼)의 상태를 라이브 갱신하는 콜백 슬롯.
// CM init 클로저가 채우며, module-level updateCustomPreview 가 덱 재렌더 후 호출한다.
let _refreshSlideNav: (() => void) | null = null;

// 문서가 프레젠테이션 모드(설정 체크박스 ON)인지.
function isPresentationActive() {
    const cb = document.getElementById('presentationModeToggle');
    return !!(cb && cb.checked);
}

// 프리뷰에 슬라이드 덱을 렌더해야 하는지. 그 외에는 일반 마크다운/ diff 렌더.
//  - 일반(split): 통합 단일 슬라이드 편집이 활성(slideCtl.active)일 때만 덱.
//    slideCtl.active 는 프레젠테이션·split·!sectionMode 를 모두 인코딩하므로 섹션 편집
//    중인 프레젠테이션 문서(에디터가 단편만 보유)는 덱으로 렌더하지 않는다.
//  - 보기(preview): 프레젠테이션 문서면 기존대로 덱.
function shouldRenderSlideDeck() {
    if (!isPresentationActive()) return false;
    if (pcViewMode === 'split') return slideCtl.active;
    return pcViewMode === 'preview';
}

async function updateCustomPreview() {
    if (!editor) return;

    let customPreview = document.getElementById('custom-wiki-preview');
    if (!customPreview) return;

    // 슬라이드 덱 렌더 경로 — 프레젠테이션 문서의 슬라이드 모드/보기 모드.
    // 본문을 `---` 기준으로 분할해 조회 화면과 동일한 인라인 덱(하단 컨트롤 바 +
    // 전체화면 버튼)으로 표시한다. diff 토글보다 우선하며 diff 잔재 클래스를 제거한다.
    if (shouldRenderSlideDeck() && typeof window.renderPresentation === 'function') {
        // 진행 중인 렌더 diff(buildRichDiffHtml await) 를 무효화한다. diff 토글은
        // 여전히 'rendered' 일 수 있어 그 guard(getDiffPreviewMode==='rendered')만으로는
        // 막히지 않으므로, seq 를 bump 해 늦게 끝난 diff HTML 이 덱을 덮어쓰지 못하게 한다.
        ++_previewDiffSeq;
        customPreview.classList.remove('preview-diff-text', 'preview-diff-rendered', 'wrap-mode', 'wiki-content');
        customPreview.classList.add('preview-slide-deck');
        _deckActive = true;
        const deckMd = editor.getMarkdown();
        const palettes = (window.appConfig && window.appConfig.palettes) || null;
        await window.renderPresentation(deckMd, slug || '', 'custom-wiki-preview', {
            palettes,
            // 통합 편집 중에는 빈 슬라이드도 유지해 덱 인덱스를 slideCtl 과 1:1 정렬한다.
            keepEmptySlides: slideCtl.active,
            // 덱에서 슬라이드를 넘기면 에디터의 현재 슬라이드도 함께 전환한다.
            onSlideChange: (i) => { _onDeckSlideChanged?.(i); },
            // 덱 자체 컨트롤/썸네일 클릭 등으로 오버뷰가 바뀌면 에디터 내비게이션 버튼 상태도 맞춘다.
            onOverviewChange: () => { _refreshSlideNav?.(); },
        });
        // 덱 모드에서는 스크롤 싱크가 의미 없으므로 가이드 캐시만 무효화한다.
        if (typeof window._invalidateScrollSyncGuides === 'function') {
            window._invalidateScrollSyncGuides();
        }
        // 에디터 하단 내비게이션 바(인디케이터/버튼 상태)를 라이브 슬라이드 수에 맞춰 갱신.
        _refreshSlideNav?.();
        return;
    }

    // 일반/diff 렌더 경로로 복귀: 직전에 덱이 떠 있었다면 프레젠테이션 전역 핸들러를
    // 한 번 정리하고 덱 전용 클래스를 제거한다.
    if (_deckActive) {
        if (typeof window.teardownPresentation === 'function') {
            try { window.teardownPresentation(); } catch (e) { /* noop */ }
        }
        _deckActive = false;
        customPreview.classList.remove('preview-slide-deck');
    }

    // 변경 사항 미리보기 모드가 켜진 경우 프리뷰 패널을 텍스트/렌더 diff 로 대체한다.
    const diffMode = getDiffPreviewMode();
    if (diffMode !== 'off') {
        await renderPreviewDiff(customPreview, diffMode);
        // diff 모드에서는 스크롤 싱크가 비활성화되지만(syncEditorScrollToPreview /
        // syncPreviewScrollToEditor 가 diff 모드에서 early return), 일반 렌더로 복귀했을 때
        // 직전 diff DOM 기준의 가이드가 남지 않도록 캐시를 무효화하고 레이아웃 관찰만 갱신한다.
        if (typeof window._invalidateScrollSyncGuides === 'function') {
            window._invalidateScrollSyncGuides();
        }
        if (typeof window._observePreviewLayoutShifts === 'function') {
            window._observePreviewLayoutShifts();
        }
        return;
    }

    // 일반 렌더 모드로 복귀: diff 모드 잔재 클래스 제거
    customPreview.classList.remove('preview-diff-text', 'preview-diff-rendered', 'wrap-mode');

    // wiki-content 클래스 보장
    if (!customPreview.classList.contains('wiki-content')) {
        customPreview.classList.add('wiki-content');
    }

    const md = editor.getMarkdown();
    // 익스텐션 데이터 문서는 프리뷰 렌더링 비활성화
    const enabledExts = (window.appConfig && window.appConfig.enabledExtensions) || [];
    const extPrefix = enabledExts.find(ext => slug && slug.startsWith(ext + ':'));
    if (extPrefix) {
        customPreview.innerHTML = `<div class="wiki-ext-raw-data">
        <div class="wiki-ext-raw-badge"><i class="bi bi-database"></i> ${escapeHtml(extPrefix)} 익스텐션 데이터 (프리뷰 비활성화)</div>
        <pre class="wiki-ext-raw-pre">${escapeHtml(md)}</pre>
    </div>`;
    } else {
        // 프리뷰 재렌더 전: 펼치기/접기, 아코디언, 탭, 외부 임베드 iframe 의
        // 상태를 캡처하고 iframe 노드는 document 내 parking 컨테이너로 옮긴다.
        // renderWikiContent 가 innerHTML 을 통째로 교체한 뒤 restore 단계에서
        // 같은 data-state-key 를 가진 새 노드에 상태를 다시 적용하고, src 가
        // 일치하는 iframe 은 캐시 노드로 in-place 치환한다.
        const previewSnap = snapshotPreviewState(customPreview);
        try {
            // 목차 카드는 전체 편집 모드에서만 프리뷰에 삽입한다(섹션 편집은 문서 일부만 다루므로 제외).
            // left-toc/docs 레이아웃에서의 데스크탑(≥992px) 숨김은 조회 화면과 동일하게 CSS 가
            // 담당한다(style.css #custom-wiki-preview .wiki-toc-card). 모바일에서는 사이드바가
            // 숨겨지므로 카드를 그대로 노출해 실제 조회 화면과 일치시킨다.
            const showInlineToc = !sectionMode;
            await window.renderWikiContent(md, slug, 'custom-wiki-preview', {
                inlineTocLayout: showInlineToc
            });
        } finally {
            restorePreviewState(customPreview, previewSnap);
        }
    }
    // 프리뷰가 갱신됐으니 스크롤 동기화 가이드 캐시 무효화 + 사후 레이아웃 변동 감시 재설정
    if (typeof window._invalidateScrollSyncGuides === 'function') {
        window._invalidateScrollSyncGuides();
    }
    if (typeof window._observePreviewLayoutShifts === 'function') {
        window._observePreviewLayoutShifts();
    }
}

// ── 변경 사항 미리보기: 프리뷰 패널을 텍스트/렌더 diff 로 표시 ──
// diffMode === 'text'     → 인라인 텍스트 diff (conflict.ts 의 buildLocalDiffHtml)
// diffMode === 'rendered' → 렌더 결과 diff (diff.ts 의 buildRichDiffHtml, 리비전 비교와 동일)
async function renderPreviewDiff(customPreview, diffMode) {
    const originalContent = typeof window.originalContent === 'string' ? window.originalContent : '';
    const currentContent = editor.getMarkdown();

    if (diffMode === 'rendered') {
        // wiki-content 는 내부 rich-diff-container 에 부여한다(리비전 비교 모달과 동일 마크업).
        customPreview.classList.remove('preview-diff-text', 'wrap-mode', 'wiki-content');
        customPreview.classList.add('preview-diff-rendered');
        if (typeof window.buildRichDiffHtml !== 'function') {
            customPreview.innerHTML = '<div class="diff-empty">렌더 비교 모듈을 불러오지 못했습니다.</div>';
            return;
        }
        const token = ++_previewDiffSeq;
        const html = await window.buildRichDiffHtml(originalContent, currentContent, slug || '');
        // 렌더 도중 더 최신 호출이 시작됐거나 사용자가 모드를 바꿨으면 stale 결과 폐기
        if (token !== _previewDiffSeq || getDiffPreviewMode() !== 'rendered') return;
        customPreview.innerHTML = `<div class="rich-diff-container wiki-content">${html}</div>`;
        return;
    }

    // 텍스트 diff
    ++_previewDiffSeq; // 진행 중인 렌더 diff 가 있으면 무효화
    customPreview.classList.remove('preview-diff-rendered', 'wiki-content');
    customPreview.classList.add('preview-diff-text');
    const wrap = localStorage.getItem('editor_word_wrap') !== 'false';
    customPreview.classList.toggle('wrap-mode', wrap);
    customPreview.innerHTML = (typeof window.buildLocalDiffHtml === 'function')
        ? window.buildLocalDiffHtml()
        : '';
}

// ── 문서 하단으로 스크롤 (에디터 + 프리뷰) ──
let hasScrolledToBottom = false;


function scrollPreviewToBottom() {
    if (!editor) return;
    const customPreview = document.getElementById('custom-wiki-preview');
    if (customPreview) {
        customPreview.scrollTop = customPreview.scrollHeight;
    }
}


let hasScrolledPreviewToBottom = false;
function scrollPreviewToBottomOnce() {
    if (hasScrolledPreviewToBottom) return;
    hasScrolledPreviewToBottom = true;
    const customPreview = document.getElementById('custom-wiki-preview');
    if (customPreview) customPreview.scrollTop = customPreview.scrollHeight;
}

function scrollToBottom() {
    if (hasScrolledToBottom) return;
    hasScrolledToBottom = true;

    if (!editor) return;
    if (isExtensionData) {
        // const rawTextarea = document.getElementById('rawExtTextarea');
        // if (rawTextarea) {
        //     rawTextarea.scrollTop = rawTextarea.scrollHeight;
        // }
    } else {
        // 프리뷰 스크롤
        const customPreview = document.getElementById('custom-wiki-preview');
        if (customPreview) {
            customPreview.scrollTop = customPreview.scrollHeight;
        }
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    await window.loadConfig();
    selectedIconsOnly = !!(window.appConfig && window.appConfig.selectedIconsOnly);
    window.selectedIconsOnly = selectedIconsOnly; // ESM 모듈에서 읽기 위한 노출

    initTurnstile();

    // 편집기에서는 자동완성/모달이 동작하려면 전체 커스텀 팔레트가 필요하다.
    // /api/config 는 더 이상 palettes 를 반환하지 않으므로 /api/palettes 로 별도 로드.
    // (문서 열람 페이지는 SSR 이 사용된 부분집합만 #ssr-data 로 주입한다.)
    // 팔레트와 인증(/api/me)은 서로 독립이므로 병렬로 시작해 직렬 대기(2 RTT)를 1 RTT 로 줄인다.
    // 결과는 둘 다 에디터 생성 이전에 반영되므로 동작은 기존과 동일하다.
    const palettePromise = fetch('/api/palettes')
        .then(res => (res.ok ? res.json() : null))
        .catch(e => { console.error('Failed to load palettes:', e); return null; });

    // 인증 확인
    try {
        const res = await fetch('/api/me');
        if (res.ok) {
            window.currentUser = await res.json();
            document.querySelectorAll('#navUserName, #userName').forEach(el => el.textContent = window.currentUser.name);
            document.querySelectorAll('#userAvatar').forEach(el => el.src = window.currentUser.picture || '');
            document.querySelectorAll('#navLogin').forEach(el => el.classList.add('d-none'));
            document.querySelectorAll('#navUser').forEach(el => el.classList.remove('d-none'));
            if (window.currentUser.role === 'admin' || window.currentUser.role === 'super_admin') {
                document.querySelectorAll('#navAdminConsole').forEach(el => el.classList.remove('d-none'));
            }
        } else {
            window.Swal.fire({
                icon: 'warning',
                title: '로그인 필요',
                text: '문서를 편집하려면 로그인이 필요합니다.',
                confirmButtonText: '로그인',
            }).then(() => {
                window.location.href = '/login';
            });
            return;
        }
    } catch (e) {
        window.location.href = '/login';
        return;
    }

    // 병렬로 로드한 팔레트 결과를 에디터 생성 전에 반영한다(기존 직렬 흐름과 동일한 시점).
    const paletteData: any = await palettePromise;
    if (paletteData && paletteData.palettes && typeof paletteData.palettes === 'object' && window.appConfig) {
        window.appConfig.palettes = paletteData.palettes;
    }

    // slug 파싱
    // 서버는 PUT 시 슬러그의 앞뒤 슬래시/공백을 제거(normalizeSlug)한 키로 문서를 저장한다.
    // 클라이언트가 원본 슬러그를 그대로 들고 있으면 저장 후 redirect URL 이 실제 저장 키와
    // 어긋나 404 가 발생하므로, 여기서도 동일한 정책으로 정규화한다.
    const params = new URLSearchParams(window.location.search);
    const rawSlug = params.get('slug');
    slug = rawSlug !== null ? normalizeSlug(rawSlug) : null;

    // 블로그 모드: ?id= 파라미터 처리 (섹션 모드 없음, slug 불필요)
    if (BLOG_MODE) {
        const idParam = params.get('id');
        blogPostId = idParam && /^\d+$/.test(idParam) ? idParam : null;
        slug = '__blog__'; // slug 미입력 체크 우회용 더미값
        sectionMode = false;
    }

    // 섹션 편집 모드 (?section=N&h=...)
    const sectionParam = params.get('section');
    if (sectionParam !== null && sectionParam !== '') {
        const parsed = parseInt(sectionParam, 10);
        if (!Number.isNaN(parsed) && parsed >= 0) {
            sectionMode = true;
            sectionIndex = parsed;
            sectionHeadingParam = params.get('h') || '';
        }
    }

    // MCP 편집안 충돌 해결 모드: ?mcp_submission=<id>.
    // URL 파라미터 단계에서는 후보값(pendingMcpSubmissionId) 만 채워두고, 이후 정상 페이지 로드 +
    // 제출안 preload 가 모두 성공한 뒤에야 `mcpSubmissionId` (저장 후 /resolve cleanup 게이트)로
    // 승격한다. 페이지가 410/403 으로 막혔거나 (mypage 가 stale 상태였던 경우), /api/w/:slug 가
    // 404 로 신규 페이지 분기로 빠지거나, /api/mcp-submissions/:id 가 4xx/5xx 인 경우 cleanup 이
    // 무관한 draft 를 silent 삭제하지 못하게 한다.
    // 섹션 편집과는 동시에 동작하지 않는다 (제안 본문은 항상 문서 전체) — 무시하고 전체 편집으로 강제.
    let pendingMcpSubmissionId: number | null = null;
    const mcpSubParam = params.get('mcp_submission');
    if (mcpSubParam !== null && /^\d+$/.test(mcpSubParam)) {
        const parsed = parseInt(mcpSubParam, 10);
        if (parsed > 0) {
            pendingMcpSubmissionId = parsed;
            sectionMode = false;
            sectionIndex = -1;
            sectionHeadingParam = '';
        }
    }

    // 편집 요청 검토 모드: ?edit_request=<id>. 승인자가 요청 본문을 에디터에 불러와 병합·추가 편집 후
    // 저장하면 정상 PUT 대신 approve(content) 를 호출해 2-리비전(요청자+승인자)으로 반영한다.
    // mcp_submission 과 상호배타(둘 다 있으면 edit_request 무시) — 제안 본문은 항상 문서 전체라 섹션 편집 강제 해제.
    let pendingEditRequestId: number | null = null;
    const editReqParam = params.get('edit_request');
    if (pendingMcpSubmissionId === null && editReqParam !== null && /^\d+$/.test(editReqParam)) {
        const parsedEr = parseInt(editReqParam, 10);
        if (parsedEr > 0) {
            pendingEditRequestId = parsedEr;
            sectionMode = false;
            sectionIndex = -1;
            sectionHeadingParam = '';
        }
    }

    if (slug) {
        DRAFT_KEY = 'wiki_draft_' + slug
            + (sectionMode ? ('#section=' + sectionIndex) : '');
    }
    // 과거 자동저장 잔여 키 일회성 정리 (오토세이브 기능은 제거됨)
    if (typeof window.purgeLegacyAutosaveKeys === 'function') window.purgeLegacyAutosaveKeys();

    syncStateToWindow();
    if (!slug && !BLOG_MODE) {
        window.Swal.fire('오류', '문서 제목이 지정되지 않았습니다.', 'error').then(() => {
            window.location.href = '/';
        });
        return;
    }

    // 슬러그 금지 문자 사전 차단 — 서버 PUT /w/:slug 가 SLUG_FORBIDDEN_CHARS 로 거부하는
    // 입력을 에디터 진입 직후에 미리 잡아내, 사용자가 본문을 작성한 뒤 저장 시점에야
    // 거부당하는 회귀를 막는다. BLOG_MODE 는 더미 슬러그(`__blog__`)를 쓰므로 제외.
    if (!BLOG_MODE && slug && hasSlugForbiddenChars(slug)) {
        // 초기 로딩 오버레이(#initLoadingOverlay, z-index:9999) 위로 SweetAlert 컨테이너를
        // 끌어올려, 사용자가 확인 버튼을 눌러 홈으로 돌아갈 수 있도록 한다.
        window.Swal.fire({
            icon: 'error',
            title: '오류',
            text: '제목에 사용할 수 없는 특수문자가 포함되어 있습니다.',
            didOpen: (el: HTMLElement) => {
                const container = el.closest('.swal2-container') as HTMLElement | null;
                if (container) container.style.zIndex = '10000';
            },
        }).then(() => {
            window.location.href = '/';
        });
        return;
    }

    // ── 편집 권한 사전 검사 (BLOG_MODE 제외) ──
    // 자동 prefix 룰로 ACL 이 적용된 신규 문서를 본문 작성 후에 저장 단계에서 거부당하면 작업이 날아간다.
    // 진입 시점에 GET /api/wiki/w/:slug/edit-permission 으로 미리 평가해 본문 입력 UI 가 뜨기 전에 차단한다.
    // 저장 단계(PUT)의 가드는 그대로 유지되므로 race 가 발생해도 안전망이 남는다.
    if (slug && !BLOG_MODE) {
        try {
            const res = await fetch(`/api/w/${encodeURIComponent(slug)}/edit-permission`);
            if (res.ok) {
                const ep = await res.json() as {
                    allowed: boolean;
                    edit_request?: boolean;
                    reason?: string;
                    decisive?: string;
                    acl?: { flags: string[] } | null;
                    source?: 'page' | 'prefix_rule' | 'none';
                    min_age_days?: number;
                    is_private?: number;
                };
                if (!ep.allowed) {
                    const reason = ep.reason || 'unknown';
                    const labelMap: Record<string, string> = {
                        aged: '가입 N일 이상',
                        page_editor: '본 문서 편집 이력',
                        any_editor: '임의 문서 편집 이력',
                        admin_only: '관리자 전용',
                    };
                    const aclSummary = (() => {
                        if (!ep.acl || !Array.isArray(ep.acl.flags) || ep.acl.flags.length === 0) return null;
                        return ep.acl.flags.map((f: string) => labelMap[f] || f).join(' 그리고 ');
                    })();
                    let title = '편집 권한이 없습니다';
                    let html = '';
                    if (reason === 'admin_only') {
                        html = '이 문서는 관리자 전용으로 지정되어 일반 사용자는 편집할 수 없습니다.';
                    } else if (reason === 'private') {
                        html = '이 문서는 비공개로 설정되어 있어 편집할 수 없습니다.';
                    } else if (reason === 'deleted') {
                        title = '삭제된 문서';
                        html = '이 문서는 삭제된 상태입니다. 관리자가 복원해야 다시 편집할 수 있습니다.';
                    } else if (reason === 'main_page') {
                        html = '메인 문서는 관리자만 편집할 수 있습니다.';
                    } else if (reason === 'image_namespace') {
                        html = '"이미지:" 네임스페이스의 문서는 미디어 업로드 페이지로 관리됩니다.';
                    } else if (reason === 'no_permission') {
                        html = '편집 권한이 없는 계정입니다.';
                    } else if (reason === 'edit_acl' && aclSummary) {
                        const sourceLabel = ep.source === 'prefix_rule' ? '하위 문서 자동 규칙' : '문서 설정';
                        const minAge = typeof ep.min_age_days === 'number' ? ep.min_age_days : 0;
                        const renderedSummary = aclSummary.replace(/N일/g, `${minAge}일`);
                        html = `이 문서는 다음 조건을 만족하는 사용자만 편집할 수 있습니다 (${sourceLabel}):<br><b>${renderedSummary}</b>`;
                    } else {
                        html = '편집 권한이 부족합니다.';
                    }
                    await window.Swal.fire({
                        icon: 'warning',
                        title,
                        html,
                        confirmButtonText: '확인',
                    });
                    window.location.href = slug ? `/w/${encodeURIComponent(slug)}` : '/';
                    return;
                }
                // ACL 미달이지만 편집 요청 기능으로 진입이 허용된 경우 — 저장 시 편집 요청으로
                // 제출됨을 미리 알린다(비차단 토스트). 차단 팝업은 띄우지 않고 에디터를 그대로 연다.
                if (ep.edit_request) {
                    window.Swal.fire({
                        toast: true,
                        position: 'top',
                        icon: 'info',
                        title: '편집 요청 모드',
                        text: '편집 권한이 부족하여, 저장하면 검토자 승인을 위한 편집 요청으로 제출됩니다.',
                        showConfirmButton: false,
                        timer: 6000,
                        timerProgressBar: true,
                    });
                }
            }
        } catch (e) {
            console.warn('edit-permission preflight failed', e);
            // 사전 검사 실패는 치명적이지 않다 — 저장 단계 가드에 맡긴다.
        }
    }

    // 익스텐션 데이터 문서 감지 (freq: 등)
    const enabledExts = (window.appConfig && window.appConfig.enabledExtensions) || [];
    const extPrefix = enabledExts.find(ext => slug.startsWith(ext + ':'));
    isExtensionData = !!extPrefix;

    // 익스텐션 데이터 문서는 섹션 모드를 지원하지 않는다(raw 편집 UI 사용).
    // URL 에 ?section= 이 붙어 들어오더라도 sectionMode 플래그를 해제하지 않으면,
    // savePage 가 sectionMode && originalPageMeta 조건으로 category/redirect
    // 를 초기 로드 값(originalPageMeta)으로 고정해 송신하여,
    // UI 에는 전체 편집 필드가 보이는데도 사용자의 메타데이터 편집이 조용히 버려진다.
    if (isExtensionData && sectionMode) {
        sectionMode = false;
        sectionIndex = -1;
        sectionHeadingParam = '';
        if (slug) DRAFT_KEY = 'wiki_draft_' + slug;
    }

    if (isExtensionData) {
        // 익스텐션 데이터: raw textarea 사용 (대용량 데이터 지원)
        //
        // 익스텐션 에디터 훅 (window._extensionEditors[<name>]):
        //   common.ts 의 loadConfig() 가 에디터 페이지에서 /ext/<name>/<name>-editor.js 를
        //   로드한 뒤 await 했으므로, 이 시점에 동기 lookup 으로 안전하게 사용할 수 있다.
        //   훅이 존재하지 않으면 (해당 익스텐션이 에디터 도구를 제공하지 않음) 기본 동작을 유지.
        //
        //   훅 옵션:
        //     - disableTextCounter: 키스트로크별 문자/줄 카운터를 끈다. REW 데이터처럼
        //       MB 단위 텍스트에서 split/regex 가 모바일에서 버벅이는 문제를 회피.
        //     - mount(toolbarEl, api): 도구막대 컨테이너에 익스텐션 전용 버튼을 추가.
        const extHook = (window._extensionEditors && window._extensionEditors[extPrefix]) || null;
        const disableTextCounter = !!(extHook && extHook.disableTextCounter);

        const editorContainer = document.getElementById('editor');
        editorContainer.innerHTML = `
            <div class="wiki-ext-raw-editor">
                <div class="wiki-ext-raw-editor-badge">
                    <i class="bi bi-database"></i> ${escapeHtml(extPrefix)} 익스텐션 데이터
                    <span class="wiki-ext-raw-editor-hint">마크다운 렌더링이 비활성화된 원시 데이터 편집 모드입니다</span>
                </div>
                <div id="extEditorToolbar" class="wiki-ext-editor-toolbar"></div>
                <textarea id="rawExtTextarea" class="wiki-ext-raw-textarea" spellcheck="false"></textarea>
            </div>
        `;

        const rawTextarea = document.getElementById('rawExtTextarea');
        const toolbarEl = document.getElementById('extEditorToolbar');

        // 카운터: disableTextCounter 가 설정된 익스텐션은 카운터 UI 자체를 숨기고
        // 갱신 호출도 모두 no-op 으로 둔다. MB 단위 데이터 환경에서 setMarkdown 직후
        // 동기 split/regex 가 메인 스레드를 점유하는 문제를 회피한다.
        let updateRawCounts;
        if (disableTextCounter) {
            const counterEl = document.getElementById('editorTextCounter');
            if (counterEl) counterEl.style.display = 'none';
            updateRawCounts = () => { /* no-op */ };
        } else {
            updateRawCounts = () => { window.updateEditorTextCounter(rawTextarea.value); };
            // 키스트로크마다 전체 regex/split 스캔이 돌지 않도록 input에는 디바운스 버전 사용
            rawTextarea.addEventListener('input', () => {
                window.updateEditorTextCounterFromTextDebounced(rawTextarea.value);
            });
            updateRawCounts();
        }

        // editor 심(shim) 객체: 기존 코드(save, cancel, diff, autosave 등)가
        // editor.getMarkdown() / editor.setMarkdown()을 통해 동작하도록 호환 유지
        editor = {
            getMarkdown: () => rawTextarea.value,
            getRawText: () => rawTextarea.value,
            setMarkdown: (md) => { rawTextarea.value = md; updateRawCounts(); },
            on: () => { },           // change 이벤트 등 무시
            focus: () => rawTextarea.focus(),
            insertText: (t) => {
                const start = rawTextarea.selectionStart;
                const end = rawTextarea.selectionEnd;
                rawTextarea.value = rawTextarea.value.substring(0, start) + t + rawTextarea.value.substring(end);
                rawTextarea.selectionStart = rawTextarea.selectionEnd = start + t.length;
                updateRawCounts();
            },
            changePreviewStyle: () => { },
            // 프리뷰, diff 등에서 참조하는 메서드 추가 방지
        };

        // 익스텐션 에디터 훅의 mount — 도구막대 컨테이너에 익스텐션 전용 UI 를 부착.
        // api 는 getValue/setValue 만 노출. setValue 는 editor.setMarkdown 과 동일하게
        // updateRawCounts 를 호출하므로, disableTextCounter 가 false 인 미래의 훅도
        // 카운터가 stale 해지지 않는다. disableTextCounter=true 인 경우 updateRawCounts
        // 가 no-op 이라 비용이 없다.
        if (extHook && typeof extHook.mount === 'function' && toolbarEl) {
            try {
                extHook.mount(toolbarEl, {
                    getValue: () => rawTextarea.value,
                    setValue: (s) => { rawTextarea.value = s; updateRawCounts(); },
                    slug,
                    extName: extPrefix,
                });
            } catch (e) {
                console.error('[edit/main] 익스텐션 에디터 훅 mount 실패:', e);
            }
        }

        syncStateToWindow();
        // 익스텐션 데이터 shim 의 on() 은 no-op 이라 자동완성이 실제로 동작하진
        // 않지만, autocomplete.ts 의 부착 가드가 idempotent 이므로 결정적으로
        // 한 번 부착해 둔다 (이벤트 + 명시 호출 양쪽).
        window.dispatchEvent(new Event('wiki-editor-ready'));
        if (typeof window.ensureAutocompleteAttached === 'function') {
            window.ensureAutocompleteAttached();
        }
        // 변경 사항 미리보기, 스크롤 동기화, 자동 프리뷰 등 건너뜀
    } else {
        // ── CodeMirror 6 에디터 초기화 ──
        const isMobile = window.innerWidth <= 768;

        // 에디터 레이아웃 구성 (PC: 툴바 전체폭 + 좌우 스플릿 / 모바일: 탭)
        const editorContainer = document.getElementById('editor');
        editorContainer.innerHTML = `
            <div class="wiki-editor-layout">
                <div class="cm-mobile-tabs" id="cm-mobile-tabs">
                    <button class="cm-tab-btn active" data-tab="editor"><i class="mdi mdi-pencil"></i> 에디터</button>
                    <button class="cm-tab-btn" data-tab="preview"><i class="mdi mdi-eye"></i> 프리뷰</button>
                </div>
                <div id="cm-toolbar" class="cm-toolbar"></div>
                <div class="wiki-editor-split-row" id="wiki-editor-split-row">
                    <div class="wiki-editor-pane" id="cm-editor-pane">
                        <div class="slide-add-zone slide-add-zone-top" id="slideAddZoneTop" hidden>
                            <i class="mdi mdi-plus-circle-outline"></i>
                            <div class="slide-add-main">위에 새 슬라이드</div>
                            <div class="slide-add-sub">현재 슬라이드 앞에 빈 슬라이드 추가</div>
                        </div>
                        <div id="cm-editor"></div>
                        <div class="slide-add-zone slide-add-zone-bottom" id="slideAddZoneBottom" hidden>
                            <i class="mdi mdi-plus-circle-outline"></i>
                            <div class="slide-add-main">아래에 새 슬라이드</div>
                            <div class="slide-add-sub">현재 슬라이드 뒤에 빈 슬라이드 추가</div>
                        </div>
                        <!-- 통합 슬라이드 편집용 하단 내비게이션 바(에디터 폭 전체). 프리뷰 탭 없이도
                             슬라이드 이동/전체보기/전체화면을 제어한다. slideCtl.active 일 때만 노출. -->
                        <div class="slide-edit-nav" id="slideEditNav" hidden role="toolbar" aria-label="슬라이드 이동">
                            <button type="button" class="slide-edit-nav-btn" data-slide-nav="prev" aria-label="이전 슬라이드"><i class="bi bi-chevron-left"></i></button>
                            <span class="slide-edit-nav-indicator" id="slideEditNavIndicator" aria-live="polite">1 / 1</span>
                            <button type="button" class="slide-edit-nav-btn" data-slide-nav="next" aria-label="다음 슬라이드"><i class="bi bi-chevron-right"></i></button>
                            <button type="button" class="slide-edit-nav-btn slide-edit-nav-btn-overview" data-slide-nav="overview" title="전체 보기 (그리드)" aria-label="전체 슬라이드 그리드 보기" aria-pressed="false"><i class="bi bi-grid-3x3-gap"></i></button>
                            <button type="button" class="slide-edit-nav-btn slide-edit-nav-btn-fullscreen" data-slide-nav="fullscreen" title="전체 화면" aria-label="전체 화면 전환"><i class="bi bi-arrows-fullscreen"></i></button>
                        </div>
                    </div>
                    <div class="wiki-preview-pane" id="custom-wiki-preview"></div>
                    <!-- 에디터 전용 플로팅 TOC 패널 -->
                    <div class="toc-floating-panel" id="editorTocFloatingPanel">
                        <div class="toc-floating-header">
                            <span><i class="mdi mdi-format-list-bulleted-square me-1"></i> 목차</span>
                        </div>
                        <nav class="toc-floating-body" id="editorTocFloatingNav"></nav>
                    </div>
                    <!-- 에디터 전용 스크롤 FAB -->
                    <div class="scroll-fab-group" id="editorScrollFabGroup">
                        <button class="scroll-fab" id="editorTocFabBtn" onclick="toggleEditorFloatingToc()" title="목차">
                            <i class="mdi mdi-format-list-bulleted-square"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;

        // CM6 모듈 동적 import — CM6 가 필요한 이 경로에서만 네트워크를 기다린다.
        // (importmap 으로 해석되며 vite.config.ts 의 rollupOptions.external 가
        //  번들에서 제외한다. esm.sh 가 unreachable 이면 이 경로가 throw 하지만
        //  익스텐션 데이터 편집 경로와 모듈 top-level 에서 노출한 인라인 핸들러는
        //  여전히 동작한다.)
        const [cmState, cmViewMod, cmCommands, cmMarkdown, cmLangData, cmOneDark, cmLanguage, cmLezer, cmSearch] = await Promise.all([
            import('@codemirror/state'),
            import('@codemirror/view'),
            import('@codemirror/commands'),
            import('@codemirror/lang-markdown'),
            import('@codemirror/language-data'),
            import('@codemirror/theme-one-dark'),
            import('@codemirror/language'),
            import('@lezer/highlight'),
            import('@codemirror/search'),
        ]);

        const { EditorState, Compartment, RangeSetBuilder, StateField, StateEffect } = cmState;
        const { EditorView, keymap: cmKeymap, lineNumbers, highlightActiveLineGutter, drawSelection,
            MatchDecorator, ViewPlugin, Decoration, WidgetType } = cmViewMod;
        const { defaultKeymap, history, historyKeymap, indentWithTab } = cmCommands;
        const { markdown, markdownLanguage } = cmMarkdown;
        const { languages } = cmLangData;
        const { oneDark } = cmOneDark;
        const { syntaxHighlighting, indentOnInput, bracketMatching, HighlightStyle, syntaxTree } = cmLanguage;
        const { tags: t } = cmLezer;
        const { SearchCursor } = cmSearch;

        // 이벤트 핸들러 저장소 (shim의 editor.on() 용)
        const editorEventHandlers: { change: Array<() => void>; blur: Array<() => void> } = { change: [], blur: [] };

        // 스크롤 동기화 활성화 플래그 (커서 위치 기반)
        let _scrollSyncEnabled = false;

        // 다크모드 감지
        let isDarkMode = window.getIsDarkMode();

        // ── 에디터 설정 (localStorage에서 불러오기) ──
        const editorSettings = {
            showLineNumbers: localStorage.getItem('editor_show_line_numbers') !== 'false',
            scrollSync: localStorage.getItem('editor_scroll_sync') === 'true',
            scrollSyncMode: localStorage.getItem('editor_scroll_sync_mode') === 'twoway' ? 'twoway' : 'oneway',
            wordWrap: localStorage.getItem('editor_word_wrap') !== 'false',
            syntaxHighlight: localStorage.getItem('editor_syntax_highlight') !== 'false',
            advancedEdit: localStorage.getItem('editor_advanced_edit') !== 'false',
            autoSummary: localStorage.getItem('editor_auto_summary') !== 'false',
            syntaxAutocomplete: localStorage.getItem('editor_syntax_autocomplete') !== 'false',
        };

        // 자동완성·인라인 표 툴바가 lazy 하게 읽는 플래그.
        // 모듈 평가 순서상 autocomplete.ts 의 첫 부착 시점에 이미 정의되어 있어야 한다.
        window.wikiSyntaxAutocompleteEnabled = editorSettings.syntaxAutocomplete;

        // ── CM6 동적 재설정용 Compartment ──
        const lineNumbersCompartment = new Compartment();
        const lineWrappingCompartment = new Compartment();
        const syntaxHighlightCompartment = new Compartment();
        const advancedEditCompartment = new Compartment();
        const themeCompartment = new Compartment();
        const darkBgCompartment = new Compartment();

        // ── 찾기/바꾸기 매치 하이라이트 (StateField + StateEffect) ──
        const setSearchMatchesEffect = StateEffect.define();
        const searchMatchDeco = Decoration.mark({ class: "cm-search-match" });
        const searchActiveDeco = Decoration.mark({ class: "cm-search-match-active" });
        const searchMatchField = StateField.define({
            create() { return Decoration.none; },
            update(value, tr) {
                value = value.map(tr.changes);
                for (const e of tr.effects) {
                    if (e.is(setSearchMatchesEffect)) value = e.value;
                }
                return value;
            },
            provide: f => EditorView.decorations.from(f)
        });

        // ── 마크다운 문법 하이라이트 스타일 ──
        const markdownLightStyle = HighlightStyle.define([
            // 헤딩 (레벨별 구분) — 폰트 크기는 cm-md-h* 라인 클래스(public/css/edit.css)에서
            // 줄 단위로 적용. 인라인 fontSize 를 함께 두면 라인 클래스의 em 위에 다시
            // 곱해져 과대 확대되므로 여기서는 색/굵기만 지정한다.
            { tag: t.heading1, color: "#0550ae", fontWeight: "700" },
            { tag: t.heading2, color: "#0550ae", fontWeight: "700" },
            { tag: t.heading3, color: "#0a3069", fontWeight: "700" },
            { tag: t.heading4, color: "#0a3069", fontWeight: "600" },
            { tag: t.heading5, color: "#0a3069", fontWeight: "600" },
            { tag: t.heading6, color: "#0a3069", fontWeight: "600" },
            // 인라인 서식
            { tag: t.strong, fontWeight: "700" },
            { tag: t.emphasis, fontStyle: "italic" },
            { tag: t.strikethrough, textDecoration: "line-through", color: "#6e7781" },
            // 링크 & URL
            { tag: t.link, color: "#0969da" },
            { tag: t.url, color: "#0969da" },
            // 인라인 코드
            { tag: t.monospace, class: "cm-inline-code" },
            // 인용
            { tag: t.quote, color: "inherit", fontStyle: "normal" },
            // 마크업 메타문자 (# * _ ~ ` > - 등)
            { tag: t.meta, color: "#6e7781" },
            { tag: t.processingInstruction, color: "#6e7781" },
            // 구분선 / 리스트 마커
            { tag: t.contentSeparator, color: "#6e7781" },
            { tag: t.list, color: "inherit" },
            // 코드 블록 내부 토큰
            { tag: t.keyword, color: "#cf222e", fontWeight: "500" },
            { tag: [t.atom, t.bool], color: "#0550ae" },
            { tag: t.number, color: "#0550ae" },
            { tag: t.string, color: "#0a3069" },
            { tag: [t.regexp, t.escape], color: "#e36209" },
            { tag: t.comment, color: "#6e7781", fontStyle: "italic" },
            { tag: t.variableName, color: "#953800" },
            { tag: t.definition(t.variableName), color: "#116329" },
            { tag: t.typeName, color: "#116329" },
            { tag: t.tagName, color: "#116329" },
            { tag: t.attributeName, color: "#953800" },
            { tag: t.operator, color: "#cf222e" },
            { tag: t.invalid, color: "#f85149" },
        ]);

        const markdownDarkStyle = HighlightStyle.define([
            { tag: t.heading1, color: "#79c0ff", fontWeight: "700" },
            { tag: t.heading2, color: "#79c0ff", fontWeight: "700" },
            { tag: t.heading3, color: "#79c0ff", fontWeight: "700" },
            { tag: t.heading4, color: "#58a6ff", fontWeight: "600" },
            { tag: t.heading5, color: "#58a6ff", fontWeight: "600" },
            { tag: t.heading6, color: "#58a6ff", fontWeight: "600" },
            { tag: t.strong, fontWeight: "700" },
            { tag: t.emphasis, fontStyle: "italic" },
            { tag: t.strikethrough, textDecoration: "line-through", color: "#8b949e" },
            { tag: t.link, color: "#58a6ff" },
            { tag: t.url, color: "#58a6ff" },
            { tag: t.monospace, class: "cm-inline-code" },
            { tag: t.quote, color: "inherit", fontStyle: "normal" },
            { tag: t.meta, color: "#8b949e" },
            { tag: t.processingInstruction, color: "#8b949e" },
            { tag: t.contentSeparator, color: "#8b949e" },
            { tag: t.list, color: "inherit" },
            { tag: t.keyword, color: "#ff7b72", fontWeight: "500" },
            { tag: [t.atom, t.bool], color: "#79c0ff" },
            { tag: t.number, color: "#79c0ff" },
            { tag: t.string, color: "#a5d6ff" },
            { tag: [t.regexp, t.escape], color: "#ffa657" },
            { tag: t.comment, color: "#8b949e", fontStyle: "italic" },
            { tag: t.variableName, color: "#ffa657" },
            { tag: t.definition(t.variableName), color: "#7ee787" },
            { tag: t.typeName, color: "#7ee787" },
            { tag: t.tagName, color: "#7ee787" },
            { tag: t.attributeName, color: "#ffa657" },
            { tag: t.operator, color: "#ff7b72" },
            { tag: t.invalid, color: "#f85149" },
        ]);

        // 라이트 모드 테마 (라이트 전용 색상 및 스타일)
        const lightTheme = EditorView.theme({
            "&": {
                backgroundColor: "#ffffff",
                color: "#24292f",
                height: "100%",
                fontSize: "14px",
                fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace"
            },
            ".cm-content": {
                caretColor: "#24292f",
                paddingBottom: "25vh"
            },
            ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#24292f" },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
                backgroundColor: "#b4d5fe"
            },
            ".cm-gutters": {
                backgroundColor: "#f6f8fa",
                color: "#6e7781",
                border: "none",
                borderRight: "1px solid #d0d7de"
            },
            ".cm-activeLineGutter": { backgroundColor: "#dbeafe" },
            ".cm-activeLine": { backgroundColor: "#f0f7ff" },
            ".cm-scroller": { overflow: "auto" },
            ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px" },
            ".cm-foldGutter .cm-gutterElement": { padding: "0 4px" },
        }, { dark: false });

        const buildDarkBgExt = () => isDarkMode ? EditorView.theme({
            "&": { height: "100%", fontSize: "14px", backgroundColor: "#000000" },
            ".cm-scroller": { overflow: "auto" },
            ".cm-content": { paddingBottom: "25vh", caretColor: "#ffffff" },
            ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#ffffff", borderLeftWidth: "2px" },
            ".cm-gutters": { backgroundColor: "#000000", borderRight: "1px solid #333" },
            ".cm-activeLineGutter": { backgroundColor: "#2d2d2d" }
        }) : [];

        // ── 위키 문법 에디터 내 하이라이팅 플러그인 ──
        const makePlugin = (matcher) => ViewPlugin.fromClass(class {
            constructor(view) { this.decorations = matcher.createDeco(view); }
            update(update) { this.decorations = matcher.updateDeco(update, this.decorations); }
        }, { decorations: v => v.decorations });

        // 인라인 코드(백틱) 내부 위치인지 확인하는 헬퍼
        const isInInlineCode = (state, pos) => {
            const line = state.doc.lineAt(pos);
            const relPos = pos - line.from;
            const re = /`[^`]+`/g;
            let m;
            while ((m = re.exec(line.text)) !== null) {
                if (relPos >= m.index && relPos < m.index + m[0].length) return true;
            }
            return false;
        };

        const wikiLinkMatcher = new MatchDecorator({
            regexp: /\[\[([^\]]*)\]\]/g,
            decoration: (match, view, pos) => {
                if (isInInlineCode(view.state, pos)) return null;
                return Decoration.mark({ class: "cm-wiki-link" });
            }
        });
        const wikiLinkPlugin = makePlugin(wikiLinkMatcher);

        const templateMatcher = new MatchDecorator({
            // {{{...}}} 파라미터 참조는 제외 (lookbehind + lookahead 사용)
            regexp: /(?<!\{)\{\{(?!\{)([^}]*)\}\}/g,
            decoration: (match, view, pos) => {
                if (isInInlineCode(view.state, pos)) return null;
                return Decoration.mark({ class: "cm-wiki-template" });
            }
        });
        const templatePlugin = makePlugin(templateMatcher);

        // 틀 파라미터 참조 {{{이름}}} / {{{1}}} / {{{이름|기본값}}}
        const templateParamMatcher = new MatchDecorator({
            regexp: /\{\{\{([^{}|]+)(?:\|[^{}]*)?\}\}\}/g,
            decoration: (match, view, pos) => {
                if (isInInlineCode(view.state, pos)) return null;
                return Decoration.mark({ class: "cm-wiki-template-param" });
            }
        });
        const templateParamPlugin = makePlugin(templateParamMatcher);

        const alignMatcher = new MatchDecorator({
            regexp: /\{[<p^>><]+\}/g,
            decoration: (match, view, pos) => {
                if (isInInlineCode(view.state, pos)) return null;
                return Decoration.mark({ class: "cm-align-marker" });
            }
        });
        const alignPlugin = makePlugin(alignMatcher);

        // ── 인라인 아이콘 위젯 ({bi:}/{mdi:}/{icon:} 옆에 실제 아이콘 미리보기) ──
        class InlineIconWidget extends WidgetType {
            constructor(type, name) { super(); this.type = type; this.name = name; }
            eq(other) { return other.type === this.type && other.name === this.name; }
            toDOM() {
                const wrap = document.createElement('span');
                wrap.className = 'cm-inline-icon-widget';
                wrap.setAttribute('aria-hidden', 'true');
                let iconEl = null;
                if (this.type === 'bi') {
                    iconEl = document.createElement('i');
                    iconEl.className = `bi bi-${this.name}`;
                } else if (this.type === 'mdi') {
                    iconEl = document.createElement('span');
                    iconEl.className = `mdi mdi-${this.name}`;
                } else if (this.type === 'icon') {
                    if (this.name.startsWith('bi-')) {
                        iconEl = document.createElement('i');
                        iconEl.className = `bi ${this.name}`;
                    } else if (this.name.startsWith('mdi-')) {
                        iconEl = document.createElement('span');
                        iconEl.className = `mdi ${this.name}`;
                    }
                }
                if (iconEl) wrap.appendChild(iconEl);
                return wrap;
            }
            ignoreEvent() { return true; }
        }

        const iconMarkerMatcher = new MatchDecorator({
            regexp: /\{(bi|mdi|icon):[^}]+\}/g,
            decoration: (match, view, pos) => {
                if (isInInlineCode(view.state, pos)) return null;
                return Decoration.mark({ class: "cm-icon-marker" });
            }
        });
        const iconMarkerPlugin = makePlugin(iconMarkerMatcher);

        const iconWidgetMatcher = new MatchDecorator({
            regexp: /\{(bi|mdi|icon):([^}\s]+)\}/g,
            decorate: (add, from, to, match, view) => {
                if (isInInlineCode(view.state, from)) return;
                const type = match[1];
                const name = (match[2] || '').trim();
                // 안전한 아이콘 이름 패턴만 허용 (영문/숫자/하이픈/언더스코어)
                if (!/^[a-zA-Z0-9_-]+$/.test(name)) return;
                if (type === 'icon' && !(name.startsWith('bi-') || name.startsWith('mdi-'))) return;
                add(to, to, Decoration.widget({
                    widget: new InlineIconWidget(type, name),
                    side: 1
                }));
            }
        });
        const iconWidgetPlugin = makePlugin(iconWidgetMatcher);

        const colorBadgeMatcher = new MatchDecorator({
            regexp: /\{(color|bg):\s*([^}]+)\}/g,
            decoration: (match, view, pos) => {
                if (isInInlineCode(view.state, pos)) return null;
                return Decoration.mark({
                    class: "cm-color-badge",
                    attributes: { style: `--badge-color: ${match[2]};` }
                });
            }
        });
        const colorBadgePlugin = makePlugin(colorBadgeMatcher);

        const paletteBadgeMatcher = new MatchDecorator({
            regexp: /\{palette:\s*([^}]+)\}/g,
            decoration: (match, view, pos) => {
                if (isInInlineCode(view.state, pos)) return null;
                const name = (match[1] || '').trim();
                let variant = null;
                try {
                    const merged = (typeof window.getMergedWikiPalettes === 'function') ? window.getMergedWikiPalettes() : {};
                    const entry = merged[name];
                    if (entry) {
                        const isDark = isDarkMode;
                        variant = isDark ? (entry.dark || entry.light) : (entry.light || entry.dark);
                    }
                } catch (_) { /* noop */ }
                if (!variant) return null;
                const rawBg = variant.bg || 'transparent';
                const rawColor = variant.color || 'inherit';
                const safeBg = (typeof window._isSafeCssColor === 'function' && window._isSafeCssColor(rawBg)) ? rawBg : 'transparent';
                const safeColor = (typeof window._isSafeCssColor === 'function' && window._isSafeCssColor(rawColor)) ? rawColor : 'inherit';
                return Decoration.mark({
                    class: "cm-palette-badge",
                    attributes: { style: `--palette-bg: ${safeBg}; --palette-color: ${safeColor};` }
                });
            }
        });
        const paletteBadgePlugin = makePlugin(paletteBadgeMatcher);

        // 파라미터 토큰: {badge:}, {tag:}, {button:}, {stat:}, {size:}, {hr}
        // {{틀}} 과 충돌하지 않도록 앞뒤 중괄호 제외
        const paramTokenMatcher = new MatchDecorator({
            regexp: /(?<!\{)\{(?:hr|(?:badge|tag|button|stat|size):[^}]+)\}(?!\})/g,
            decoration: (match, view, pos) => {
                if (isInInlineCode(view.state, pos)) return null;
                return Decoration.mark({ class: "cm-param-token" });
            }
        });
        const paramTokenPlugin = makePlugin(paramTokenMatcher);

        // ==text== 형광펜 — {color:..} / {bg:..} / {palette:..} 선행 토큰을 0개 이상 흡수하고
        // render.ts 와 동일하게 (뒤 토큰이 우선) 색을 풀어 본문에만 데코를 적용한다.
        // 선행 토큰 자체는 colorBadgePlugin / paletteBadgePlugin 이 별도 처리.
        // {palette:NAME} 은 현재 다크모드에 맞춰 등록 팔레트의 bg/color 를 풀어 그 자리에 삽입한 뒤
        // bg/color 토큰을 순서대로 스캔한다 (render.ts 의 _resolvePaletteTokens 와 동일 의미).
        const resolvePalettePrefix = (raw) => {
            if (!raw || raw.indexOf('{palette:') === -1) return raw;
            const merged = (typeof window.getMergedWikiPalettes === 'function') ? window.getMergedWikiPalettes() : {};
            return raw.replace(/\{palette:\s*([^}\s][^}]*?)\s*\}/g, (m, nameRaw) => {
                const name = (nameRaw || '').trim();
                const entry = merged[name];
                if (!entry) return m;
                const variant = isDarkMode ? (entry.dark || entry.light) : (entry.light || entry.dark);
                if (!variant) return m;
                let out = '';
                if (variant.bg) out += `{bg:${variant.bg}}`;
                if (variant.color) out += `{color:${variant.color}}`;
                return out || m;
            });
        };
        const highlightMatcher = new MatchDecorator({
            regexp: /((?:\{(?:palette|bg|color):[^}]+\})*)==([^=\n]+)==/g,
            decorate: (add, from, to, match, view) => {
                if (isInInlineCode(view.state, from)) return;
                const prefix = match[1] || '';
                const innerStart = from + prefix.length;
                const innerEnd = to;
                const expanded = resolvePalettePrefix(prefix);
                let color = '';
                let bg = '';
                const colorRe = /\{color:\s*([^}]+)\}/g;
                const bgRe = /\{bg:\s*([^}]+)\}/g;
                let pm;
                while ((pm = colorRe.exec(expanded)) !== null) color = pm[1].trim();
                while ((pm = bgRe.exec(expanded)) !== null) bg = pm[1].trim();
                const isSafe = (typeof window._isSafeCssColor === 'function') ? window._isSafeCssColor : () => false;
                const safeColor = color && isSafe(color) ? color : '';
                const safeBg = bg && isSafe(bg) ? bg : '';
                if (!safeColor && !safeBg) {
                    add(innerStart, innerEnd, Decoration.mark({ class: 'cm-highlight' }));
                    return;
                }
                let style = '';
                if (safeColor && !safeBg) {
                    style = `color: ${safeColor};`;
                } else {
                    if (safeBg) style += `background-color: ${safeBg};`;
                    if (safeColor) style += `color: ${safeColor};`;
                }
                add(innerStart, innerEnd, Decoration.mark({
                    class: 'cm-highlight-styled',
                    attributes: { style }
                }));
            }
        });
        const highlightPlugin = makePlugin(highlightMatcher);

        // **강조** — 마크다운 strong. lang-markdown 의 tag 기반 스타일이
        // 일관되게 적용되지 않는 케이스가 있어 명시적 데코를 둔다.
        // 백슬래시 이스케이프(`\*\*`)는 매칭하지 않도록 여는/닫는 `**` 직전에 `\` 가드.
        const strongMatcher = new MatchDecorator({
            regexp: /(?<!\\)\*\*([^*\n]+?)(?<!\\)\*\*/g,
            decoration: (match, view, pos) => {
                if (isInInlineCode(view.state, pos)) return null;
                return Decoration.mark({ class: "cm-md-strong" });
            }
        });
        const strongPlugin = makePlugin(strongMatcher);

        // *기울임* — 마크다운 emphasis. 인접 `*` 은 강조(`**`) 가 흡수하므로 lookaround 로 제외.
        // 여는 `*` 뒤 / 닫는 `*` 앞에 공백을 두지 않도록 강제해 `* item` 리스트 마커와 충돌하지 않게 한다.
        // 백슬래시 이스케이프(`\*foo\*`) 는 매칭하지 않는다.
        const emphasisMatcher = new MatchDecorator({
            regexp: /(?<!\\)(?<!\*)\*(?!\*|\s)([^*\n]+?)(?<!\s)(?<!\\)\*(?!\*)/g,
            decoration: (match, view, pos) => {
                if (isInInlineCode(view.state, pos)) return null;
                return Decoration.mark({ class: "cm-md-emphasis" });
            }
        });
        const emphasisPlugin = makePlugin(emphasisMatcher);

        // __밑줄__ — 위키 커스텀 underline (render.ts 의 underline 익스텐션과 동일 패턴).
        // 백슬래시 이스케이프(`\_\_`)는 매칭하지 않는다.
        const underlineMatcher = new MatchDecorator({
            regexp: /(?<!\\)__([^_\n]+(?:_[^_\n]+)*)(?<!\\)__/g,
            decoration: (match, view, pos) => {
                if (isInInlineCode(view.state, pos)) return null;
                return Decoration.mark({ class: "cm-md-underline" });
            }
        });
        const underlinePlugin = makePlugin(underlineMatcher);

        // ~~취소선~~ — GFM strikethrough. 백슬래시 이스케이프(`\~\~`)는 매칭하지 않는다.
        const strikethroughMatcher = new MatchDecorator({
            regexp: /(?<!\\)~~([^~\n]+?)(?<!\\)~~/g,
            decoration: (match, view, pos) => {
                if (isInInlineCode(view.state, pos)) return null;
                return Decoration.mark({ class: "cm-md-strikethrough" });
            }
        });
        const strikethroughPlugin = makePlugin(strikethroughMatcher);

        const timeMatcher = new MatchDecorator({
            regexp: /\{(time|timer|age|dday|calendar):[^}]+\}/g,
            decoration: (match, view, pos) => {
                if (isInInlineCode(view.state, pos)) return null;
                return Decoration.mark({ class: "cm-time-marker" });
            }
        });
        const timePlugin = makePlugin(timeMatcher);

        const inlineCodeMatcher = new MatchDecorator({
            regexp: /`([^`]+)`/g,
            decoration: Decoration.mark({ class: "cm-inline-code" })
        });
        const inlineCodePlugin = makePlugin(inlineCodeMatcher);

        const quoteListMatcher = new MatchDecorator({
            regexp: /^[ \t]*(>|[-+*]|\d+\.)(?=[ \t])/gm,
            decoration: (match) => {
                if (match[1] === '>') return Decoration.mark({ class: "cm-quote-marker" });
                return Decoration.mark({ class: "cm-list-marker" });
            }
        });
        const quoteListPlugin = makePlugin(quoteListMatcher);

        // 마크다운 일반 링크 대괄호/괄호 회색 처리
        const mdLinkBracketsPlugin = ViewPlugin.fromClass(class {
            constructor(view) { this.decorations = this.getDeco(view); }
            update(update) {
                if (update.docChanged || update.viewportChanged) {
                    this.decorations = this.getDeco(update.view);
                }
            }
            getDeco(view) {
                let builder = new RangeSetBuilder();
                let ranges = [];
                for (let { from, to } of view.visibleRanges) {
                    syntaxTree(view.state).iterate({
                        from, to,
                        enter: (node) => {
                            if (node.name === "LinkMark" || node.name === "ImageMark") {
                                ranges.push({ from: node.from, to: node.to });
                            }
                        }
                    });
                }
                ranges.sort((a, b) => a.from - b.from);
                const deco = Decoration.mark({ class: "cm-md-link-bracket" });
                for (let r of ranges) {
                    builder.add(r.from, r.to, deco);
                }
                return builder.finish();
            }
        }, { decorations: v => v.decorations });

        // 줄 단위 블록 스타일링 (접기, 코드블록 등)
        const lineStylePlugin = ViewPlugin.fromClass(class {
            constructor(view) { this.decorations = this.getDeco(view); }
            update(update) {
                if (update.docChanged || update.viewportChanged) {
                    this.decorations = this.getDeco(update.view);
                }
            }
            getDeco(view) {
                let builder = new RangeSetBuilder();
                let doc = view.state.doc;
                let maxLine = doc.lines;
                let inFold = false;
                // CommonMark 코드 펜스 추적: null = 코드 밖, "`" 또는 "~" = 해당 문자로 열린 펜스 안.
                // 닫는 펜스는 (1) 같은 문자, (2) 여는 펜스보다 길이가 같거나 길고,
                // (3) 뒤에 공백만 와야 한다. 따라서 fenceLen 도 함께 보존한다.
                let fenceChar = null;
                let fenceLen = 0;
                let colonBlockDepth = 0;
                const colonOpenRe = /^:::[a-zA-Z][a-zA-Z0-9_-]*(?:[ \t]+.*)?[ \t]*$/;
                const colonCloseRe = /^:::[ \t]*$/;
                const fenceRe = /^ {0,3}(`{3,}|~{3,})(.*)$/;

                for (let i = 1; i <= maxLine; i++) {
                    let line = doc.line(i);
                    let text = line.text;
                    let classes = [];

                    // 인라인 코드 내부의 문법은 폴드/접기 감지에서 제외
                    const textForFold = text.replace(/`[^`]+`/g, s => ' '.repeat(s.length));
                    if (textForFold.includes("[+")) inFold = true;
                    const isColonOpen = fenceChar === null && colonOpenRe.test(text);
                    const isColonClose = fenceChar === null && !isColonOpen && colonCloseRe.test(text);
                    if (isColonOpen) colonBlockDepth++;
                    if (inFold || colonBlockDepth > 0) classes.push("cm-fold-block");
                    if (textForFold.includes("[-]")) inFold = false;
                    if (isColonClose && colonBlockDepth > 0) colonBlockDepth--;

                    const fenceMatch = fenceRe.exec(text);
                    let isCodeFence = false;
                    if (fenceMatch) {
                        const seq = fenceMatch[1];
                        const tail = fenceMatch[2];
                        const ch = seq[0];
                        if (fenceChar === null) {
                            // 펜스 여는 줄. CommonMark 규정상 백틱 펜스의 info string 에는
                            // 백틱이 올 수 없으므로 그 경우는 펜스로 보지 않는다.
                            if (!(ch === '`' && tail.indexOf('`') !== -1)) {
                                fenceChar = ch;
                                fenceLen = seq.length;
                                isCodeFence = true;
                            }
                        } else if (fenceChar === ch && seq.length >= fenceLen && /^[ \t]*$/.test(tail)) {
                            // 닫는 펜스: 같은 문자 + 같거나 더 긴 길이 + 뒤에 공백뿐
                            fenceChar = null;
                            fenceLen = 0;
                            isCodeFence = true;
                        }
                        // 그 외(같은 문자라도 길이 부족 / 뒤에 텍스트 있음, 다른 종류 펜스 토큰)는
                        // 코드 본문으로 취급되어 아래 fenceChar 체크로 cm-code-block 클래스가 붙는다.
                    }
                    if (isCodeFence || fenceChar !== null) {
                        classes.push("cm-code-block");
                    }

                    // ATX 헤딩: 줄 시작 0–3칸 들여쓰기 허용, # 1–6개, 그 뒤 공백/EOL.
                    // 코드 펜스 안이면 무시 (``` / ~~~ 양쪽 모두 해당).
                    if (fenceChar === null && !isCodeFence) {
                        const headingMatch = /^ {0,3}(#{1,6})(?:\s|$)/.exec(text);
                        if (headingMatch) {
                            classes.push("cm-md-h" + headingMatch[1].length);
                        }
                    }

                    if (classes.length > 0) {
                        builder.add(line.from, line.from, Decoration.line({ class: classes.join(" ") }));
                    }
                }
                return builder.finish();
            }
        }, { decorations: v => v.decorations });

        // ── 표 안 커서 위 통합 인라인 편집 툴바 ──
        // 정렬/행/열/셀 병합을 한 곳에서 제공. 스크롤·리사이즈 리스너는 모듈 내부에서 등록.
        // edit-table-toolbar.js 모듈 로드가 실패할 경우(캐시 불일치 등) 에디터 자체가
        // 죽지 않도록 no-op fallback 으로 가드한다.
        const tableToolbar = window.setupTableToolbar
            ? window.setupTableToolbar()
            : { update: () => {}, hide: () => {} };

        // 찾기/바꾸기 패널이 외부 편집을 감지하기 위한 훅 (find 패널 init 후 할당됨)
        var _findFeatureOnDocChange = null;

        // 문서 변경 감지 리스너
        const updateListener = EditorView.updateListener.of((update) => {
            if (update.docChanged) {
                editorEventHandlers.change.forEach(cb => cb());
                window.updateEditorTextCounterFromDoc(update.state.doc);
                if (_findFeatureOnDocChange) _findFeatureOnDocChange(update);
            }
            // 표 인라인 편집 툴바 위치/표시 갱신
            if (update.selectionSet || update.docChanged || update.viewportChanged) {
                tableToolbar.update(update.view);
            }
        });

        // blur 감지
        const blurHandler = EditorView.domEventHandlers({
            blur: () => {
                editorEventHandlers.blur.forEach(cb => cb());
                // 에디터에서 포커스가 떠나면(모달 열기, 다른 입력 등) 표 툴바도 숨김.
                // 툴바 버튼 클릭은 mousedown.preventDefault()로 blur가 발생하지 않으므로 안전.
                tableToolbar.hide();
            },
            mousedown: (event, view) => {
                const target = event.target;
                const isColorBadge = target.classList && target.classList.contains('cm-color-badge');
                const isPaletteBadge = target.classList && target.classList.contains('cm-palette-badge');
                if (isColorBadge || isPaletteBadge) {
                    // "문법 자동완성" 이 꺼져 있으면 컬러/팔레트 배지 클릭으로 인라인
                    // 자동완성을 띄우는 명시적 진입점도 막아야 한다. 일반 텍스트 클릭처럼
                    // 동작하도록 그대로 위임.
                    if (window.wikiSyntaxAutocompleteEnabled === false) return;
                    const rect = target.getBoundingClientRect();
                    // 배지(가상 요소) 클릭 여부 확인: 컬러 18px / 팔레트 28px 우측 영역
                    const badgeWidth = isColorBadge ? 18 : 28;
                    if (event.clientX > rect.right - badgeWidth) {
                        event.preventDefault();
                        event.stopPropagation();
                        const text = target.textContent;
                        if (isColorBadge) {
                            const match = text.match(/\{(color|bg):\s*([^}]+)\}/);
                            if (match) {
                                const type = match[1];
                                const colorCode = match[2];
                                const pos = view.posAtDOM(target);
                                if (pos !== null) {
                                    const endPos = pos + text.length;
                                    view.dispatch({ selection: { anchor: endPos } });
                                    window.showColorAutocomplete(colorCode, type);
                                    return true;
                                }
                            }
                        } else {
                            const match = text.match(/\{palette:\s*([^}]+)\}/);
                            if (match) {
                                const pos = view.posAtDOM(target);
                                if (pos !== null) {
                                    // posAtDOM이 요소 기준으로 오프셋이 어긋날 수 있어,
                                    // 클릭한 배지의 textContent와 동일한 토큰 중 pos에 가장 가까운 것을 택한다.
                                    // 같은 라인에 {palette:a}{palette:b} 처럼 인접 토큰이 있을 때
                                    // 경계 허용치 때문에 이전 토큰이 잘못 매칭되던 문제 방지.
                                    const line = view.state.doc.lineAt(pos);
                                    const relPos = pos - line.from;
                                    const tokenRegex = /\{palette:\s*[^}]+\}/g;
                                    let tokenFrom = -1;
                                    let tokenTo = -1;
                                    let bestDist = Infinity;
                                    let m;
                                    while ((m = tokenRegex.exec(line.text)) !== null) {
                                        if (m[0] !== text) continue;
                                        const start = m.index;
                                        const end = start + m[0].length;
                                        // 클릭 위치가 토큰 내부면 거리 0, 아니면 가장 가까운 끝까지의 거리
                                        const dist = relPos < start ? start - relPos
                                            : relPos > end ? relPos - end
                                                : 0;
                                        if (dist < bestDist) {
                                            bestDist = dist;
                                            tokenFrom = line.from + start;
                                            tokenTo = line.from + end;
                                            if (dist === 0) break;
                                        }
                                    }
                                    if (tokenFrom === -1) {
                                        // 폴백: 기존 추정치 사용
                                        tokenFrom = pos;
                                        tokenTo = pos + text.length;
                                    }
                                    const docLength = view.state.doc.length;
                                    tokenFrom = Math.max(0, Math.min(tokenFrom, docLength));
                                    tokenTo = Math.max(0, Math.min(tokenTo, docLength));
                                    if (tokenFrom > tokenTo) {
                                        const tmp = tokenFrom;
                                        tokenFrom = tokenTo;
                                        tokenTo = tmp;
                                    }
                                    view.dispatch({ selection: { anchor: tokenTo } });
                                    if (typeof window.hideAutocomplete === 'function') window.hideAutocomplete();
                                    if (typeof window.hideIconAutocomplete === 'function') window.hideIconAutocomplete();
                                    if (typeof window.hideColorAutocomplete === 'function') window.hideColorAutocomplete();
                                    if (typeof window.hideTimestampAutocomplete === 'function') window.hideTimestampAutocomplete();
                                    if (typeof window.hideImgSizeAutocomplete === 'function') window.hideImgSizeAutocomplete();
                                    window.paletteAc.replaceRange = { from: tokenFrom, to: tokenTo };
                                    window.showPaletteAutocomplete('', { showAll: true });
                                    return true;
                                }
                            }
                        }
                    }
                }
                return false;
            }
        });

        // ── 문법 하이라이트/고급 편집 확장 묶음 ──
        const buildSyntaxHighlightExts = () => editorSettings.syntaxHighlight ? [
            markdown({ base: markdownLanguage, codeLanguages: languages }),
            syntaxHighlighting(isDarkMode ? markdownDarkStyle : markdownLightStyle),
            wikiLinkPlugin,
            templatePlugin,
            templateParamPlugin,
            alignPlugin,
            iconMarkerPlugin,
            highlightPlugin,
            strongPlugin,
            emphasisPlugin,
            underlinePlugin,
            strikethroughPlugin,
            timePlugin,
            inlineCodePlugin,
            quoteListPlugin,
            paramTokenPlugin,
            lineStylePlugin
        ] : [];

        const buildAdvancedEditExts = () => (editorSettings.syntaxHighlight && editorSettings.advancedEdit) ? [
            colorBadgePlugin,
            paletteBadgePlugin,
            iconWidgetPlugin
        ] : [];

        // ── CM6 EditorView 생성 ──
        const cmEditorView = new EditorView({
            state: EditorState.create({
                doc: "",
                extensions: [
                    lineNumbersCompartment.of(
                        editorSettings.showLineNumbers
                            ? [lineNumbers(), highlightActiveLineGutter()]
                            : []
                    ),
                    drawSelection(),
                    indentOnInput(),
                    bracketMatching(),
                    history(),
                    cmKeymap.of([
                        { key: "Mod-f", run: () => { if (typeof openFindPanel === 'function') { openFindPanel(); } return true; }, preventDefault: true },
                        {
                            key: "Shift-Enter",
                            run: (view) => {
                                // 표 셀 안에서 Shift+Enter → {br} 토큰 삽입. 표 밖 / 구분선 위 /
                                // 셀 경계 밖 (leading | 앞, trailing | 뒤) / table-toolbar 번들
                                // 미로드 시 / wikiSyntaxAutocompleteEnabled === false 일 때는
                                // false 를 반환해 defaultKeymap 으로 폴백. autocomplete 토글은
                                // table-toolbar 와 동일한 옵트아웃 정책을 따른다.
                                if (window.wikiSyntaxAutocompleteEnabled === false) return false;
                                const finder = (window as unknown as { findTableContext?: (v: unknown) => { rowIndex: number; separatorRowIndex: number } | null }).findTableContext;
                                if (typeof finder !== 'function') return false;
                                const ctx = finder(view);
                                if (!ctx) return false;
                                if (ctx.rowIndex === ctx.separatorRowIndex) return false;
                                // 커서가 실제 셀 내부인지 확인.
                                // (1) 좌측에 escape 되지 않은 | 가 반드시 존재해야 셀 시작 이후.
                                // (2) trailing pipe 가 실제로 있는 경우 (GFM 은 optional) cursor 가
                                //     그 뒤로 가면 셀 밖. trailing pipe 없는 row 의 마지막 셀에서는
                                //     line 끝까지 셀 내부로 인정한다.
                                const sel = view.state.selection.main;
                                const line = view.state.doc.lineAt(sel.from);
                                const col = sel.from - line.from;
                                if (!/(?<!\\)\|/.test(line.text.slice(0, col))) return false;
                                const trailingPipe = line.text.match(/(?<!\\)\|(?=[ \t]*$)/);
                                if (trailingPipe && col > (trailingPipe.index ?? -1)) return false;
                                const pos = sel.from;
                                view.dispatch({
                                    changes: { from: pos, insert: '{br}' },
                                    selection: { anchor: pos + 4 }
                                });
                                return true;
                            }
                            // preventDefault 미설정: false 반환 시 defaultKeymap (insertNewline) 으로
                            // 그대로 fall-through. preventDefault: true 를 두면 false 반환 시에도
                            // browser default 가 막혀 셀 밖 Shift+Enter 가 무력화된다.
                        },
                        ...defaultKeymap,
                        ...historyKeymap,
                        indentWithTab
                    ]),
                    searchMatchField,
                    themeCompartment.of(isDarkMode ? oneDark : lightTheme),
                    darkBgCompartment.of(buildDarkBgExt()),
                    lineWrappingCompartment.of(
                        editorSettings.wordWrap ? EditorView.lineWrapping : []
                    ),
                    updateListener,
                    blurHandler,
                    syntaxHighlightCompartment.of(buildSyntaxHighlightExts()),
                    advancedEditCompartment.of(buildAdvancedEditExts())
                ]
            }),
            parent: document.querySelector('#cm-editor')
        });

        // 전역 CM6 인스턴스 보관
        window._cmView = cmEditorView;
        window.CodeMirrorView = cmViewMod;

        // 초기 텍스트 카운터 상태 반영
        window.updateEditorTextCounter(cmEditorView.state.doc.toString());

        // ── 에디터 Shim 객체 (기존 edit.js 코드와 호환) ──
        editor = {
            // 통합 슬라이드 편집 중이면 CM 문서는 "현재 슬라이드"만 보유하므로,
            // 저장/초안/충돌/프리뷰 등 모든 기존 호출 경로가 전체 문서를 보도록
            // 재구성된 전체 마크다운을 반환한다(reconstructFullDoc).
            getMarkdown: () => slideCtl.active ? reconstructFullDoc() : cmEditorView.state.doc.toString(),
            // 커서 좌표와 일치하는 원시 CM 텍스트(현재 슬라이드). 자동완성 등 커서 결합 소비자용.
            getRawText: () => cmEditorView.state.doc.toString(),
            setMarkdown: (md) => {
                // 통합 슬라이드 편집 중에는 외부 호출자가 넘긴 값이 항상 "전체 문서"
                // (초안 복원/MCP 적재/충돌 머지 등)이므로, 그대로 단일 슬라이드 에디터에
                // 덤프하지 않고 재분할해 현재 슬라이드만 다시 로드한다. 내부 슬라이드
                // 스왑은 setEditorDocSuppressed(직접 dispatch)를 쓰므로 이 경로를 타지 않는다.
                if (slideCtl.active) {
                    const parts = splitSlides(md || '');
                    slideCtl.slides = parts.length ? parts : [''];
                    // 새 전체 문서가 새 기준선이 된다(원본 보존 비교용 스냅샷 갱신).
                    slideCtl.enterDoc = md || '';
                    slideCtl.enterCanonical = canonicalizeSlides(slideCtl.slides);
                    slideCtl.idx = Math.max(0, Math.min(slideCtl.idx, slideCtl.slides.length - 1));
                    loadActiveSlideIntoEditor();
                    // loadActiveSlideIntoEditor 는 억제된 스왑이라 change 핸들러가 프리뷰를
                    // 갱신하지 않는다(내부 슬라이드 전환용). 하지만 setMarkdown 은 외부에서
                    // 들어온 전체 문서 교체(초안 복원/충돌 머지/MCP 적재)이므로, 비-슬라이드
                    // 경로가 change 로 프리뷰를 갱신하는 것과 동일하게 덱을 명시적으로 다시
                    // 그린다(덱 initial 이 새 문서와 어긋나지 않도록 해시도 동기화).
                    syncHashToActive();
                    updateCustomPreview();
                    return;
                }
                cmEditorView.dispatch({
                    changes: { from: 0, to: cmEditorView.state.doc.length, insert: md }
                });
            },
            insertText: (text) => {
                const { main } = cmEditorView.state.selection;
                cmEditorView.dispatch({
                    changes: { from: main.from, to: main.to, insert: text },
                    selection: { anchor: main.from + text.length }
                });
                cmEditorView.focus();
            },
            getSelection: () => {
                const { main } = cmEditorView.state.selection;
                const fromLine = cmEditorView.state.doc.lineAt(main.from);
                const toLine = cmEditorView.state.doc.lineAt(main.to);
                return [
                    [fromLine.number, main.from - fromLine.from + 1],
                    [toLine.number, main.to - toLine.from + 1]
                ];
            },
            setSelection: (fromArr, toArr) => {
                try {
                    const fromLine = cmEditorView.state.doc.line(fromArr[0]);
                    const toLine = cmEditorView.state.doc.line(toArr[0]);
                    const from = fromLine.from + fromArr[1] - 1;
                    const to = toLine.from + toArr[1] - 1;
                    cmEditorView.dispatch({
                        selection: { anchor: from, head: to }
                    });
                } catch (e) {
                    // 잘못된 위치 무시
                }
            },
            focus: () => cmEditorView.focus(),
            on: (event, callback) => {
                if (editorEventHandlers[event]) {
                    editorEventHandlers[event].push(callback);
                }
            },
            changePreviewStyle: () => { /* CM6 스플릿 뷰에서는 불필요 */ },
            getCursorCoords: () => {
                const { main } = cmEditorView.state.selection;
                return cmEditorView.coordsAtPos(main.head);
            }
        };

        // ── 통합 단일 슬라이드 편집 헬퍼 ─────────────────────────────────────────
        // 프레젠테이션 문서 + 일반(split) 모드일 때, 에디터 CM 문서는 "현재 슬라이드"
        // 텍스트만 보유한다. slideCtl.slides[idx] 는 자리표시자로, reconstructFullDoc 이
        // 항상 라이브 에디터 텍스트로 덮어쓴다. 따라서 슬라이드 안에 `---` 를 입력하면
        // 재구성된 전체 문서가 그만큼 더 분할되어 덱/카운트에 라이브 반영된다.
        // slides 배열의 정규화(재분할)는 이동/삽입/이탈 경계에서만 수행한다.
        function isSlideEditing() {
            return isPresentationActive() && currentPcMode === 'split' && !sectionMode;
        }
        function reconstructFullDoc() {
            const parts = slideCtl.slides.slice();
            parts[slideCtl.idx] = cmEditorView.state.doc.toString();
            const rebuilt = canonicalizeSlides(parts);
            // 슬라이드 내용이 진입 시점과 동일하면(구분자 공백만 차이) 원본을 그대로 반환해
            // 화이트스페이스 변경/거짓 미저장 경고를 방지한다.
            if (rebuilt === slideCtl.enterCanonical) return slideCtl.enterDoc;
            return rebuilt;
        }
        // 전체 문서를 재분할해 slideCtl.slides 를 정규화(액티브 영역에 `---` 가 들어가
        // 여러 슬라이드로 늘어난 경우 반영). 이동/삽입/이탈 경계에서만 호출한다.
        function reconcileSlidesFromEditor() {
            const parts = splitSlides(reconstructFullDoc());
            slideCtl.slides = parts.length ? parts : [''];
            slideCtl.idx = Math.max(0, Math.min(slideCtl.idx, slideCtl.slides.length - 1));
        }
        // change 핸들러를 무력화한 채 CM 문서를 통째로 교체(프로그램적 슬라이드 스왑).
        function setEditorDocSuppressed(text) {
            slideCtl.suppressChange = true;
            try {
                cmEditorView.dispatch({ changes: { from: 0, to: cmEditorView.state.doc.length, insert: text } });
            } finally {
                slideCtl.suppressChange = false;
            }
            cmEditorView.requestMeasure();
        }
        function loadActiveSlideIntoEditor() {
            // 슬라이드 앞뒤 빈 줄을 정리해 깔끔한 단일 슬라이드 본문만 에디터에 둔다.
            setEditorDocSuppressed(trimSlide(slideCtl.slides[slideCtl.idx] ?? ''));
        }
        function syncHashToActive() {
            const expected = `#/${slideCtl.idx + 1}`;
            if (window.location.hash !== expected) history.replaceState(history.state, '', expected);
        }
        function toggleSlideAddZones(show) {
            const top = document.getElementById('slideAddZoneTop');
            const bottom = document.getElementById('slideAddZoneBottom');
            if (top) top.hidden = !show;
            if (bottom) bottom.hidden = !show;
            // 에디터 하단 슬라이드 내비게이션 바도 함께 토글(프리뷰 탭 없이 이동/전체화면 제어).
            const nav = document.getElementById('slideEditNav');
            if (nav) nav.hidden = !show;
            // 통합 슬라이드 편집 활성 표시 — CSS 가 본문 목차 FAB/플로팅 패널을 숨긴다.
            const layoutEl = document.querySelector('.wiki-editor-layout');
            if (layoutEl) layoutEl.classList.toggle('slide-edit-active', !!show);
            if (show) refreshSlideNav();
        }
        // 일반(split) 진입: 전체 문서를 슬라이드로 분할해 현재 슬라이드만 에디터에 로드.
        function enterSlideEditing() {
            if (slideCtl.active) return;
            const full = cmEditorView.state.doc.toString();
            const parts = splitSlides(full);
            slideCtl.slides = parts.length ? parts : [''];
            // 진입 시점 스냅샷 — 무편집 이탈/저장 시 원본을 그대로 보존하기 위함.
            slideCtl.enterDoc = full;
            slideCtl.enterCanonical = canonicalizeSlides(slideCtl.slides);
            const m = /^#\/(\d+)$/.exec(window.location.hash);
            slideCtl.idx = m ? Math.max(0, Math.min(parseInt(m[1], 10) - 1, slideCtl.slides.length - 1)) : 0;
            slideCtl.active = true;
            loadActiveSlideIntoEditor();
            toggleSlideAddZones(true);
        }
        // 일반(split) 이탈: 전체 문서를 재구성해 에디터에 되돌린다(작성/보기 모드는 전체 문서).
        function leaveSlideEditing() {
            if (!slideCtl.active) return;
            const full = reconstructFullDoc();
            slideCtl.active = false;
            setEditorDocSuppressed(full);
            toggleSlideAddZones(false);
        }
        // 덱(프리뷰)에서 슬라이드를 넘겼을 때 에디터를 해당 슬라이드로 전환.
        function onDeckSlideChanged(deckIdx) {
            if (!slideCtl.active) return;
            if (deckIdx === slideCtl.idx) return; // 같은 슬라이드 → no-op(편집 중 재렌더 루프 차단)
            reconcileSlidesFromEditor();          // 사용자 실제 이동 → 정규화(액티브 영역 멀티파트 확정)
            slideCtl.idx = Math.max(0, Math.min(deckIdx, slideCtl.slides.length - 1));
            loadActiveSlideIntoEditor();
            refreshSlideNav();
        }
        _onDeckSlideChanged = onDeckSlideChanged;
        // 위/아래 추가 존 클릭 → 현재 슬라이드 앞/뒤에 빈 슬라이드 삽입 후 활성화.
        function insertSlide(where) {
            if (!slideCtl.active) return;
            reconcileSlidesFromEditor();
            const at = where === 'before' ? slideCtl.idx : slideCtl.idx + 1;
            slideCtl.slides.splice(at, 0, '');
            slideCtl.idx = at;
            loadActiveSlideIntoEditor();
            syncHashToActive();
            updateCustomPreview();
            refreshSlideNav();
            cmEditorView.focus();
        }
        // 추가 존 클릭 핸들러 부착(요소는 에디터 템플릿에 포함, 기본 hidden).
        document.getElementById('slideAddZoneTop')?.addEventListener('click', () => insertSlide('before'));
        document.getElementById('slideAddZoneBottom')?.addEventListener('click', () => insertSlide('after'));

        // ── 에디터 하단 슬라이드 내비게이션 바 ──────────────────────────────────
        // 프리뷰 탭(모바일) 없이도 슬라이드를 이동/전체보기/전체화면 할 수 있도록, 에디터 폭
        // 전체를 차지하는 하단 바를 둔다. 이동은 통합 슬라이드 편집 상태(slideCtl)를 직접
        // 조작하고, 전체보기/전체화면은 덱 토글(render-presentation)에 위임한다.
        const slideNavEl = document.getElementById('slideEditNav');
        const slideNavIndicator = document.getElementById('slideEditNavIndicator');
        const slideNavPrevBtn = slideNavEl?.querySelector('[data-slide-nav="prev"]');
        const slideNavNextBtn = slideNavEl?.querySelector('[data-slide-nav="next"]');
        const slideNavOverviewBtn = slideNavEl?.querySelector('[data-slide-nav="overview"]');
        // 에디터 측 전체보기 버튼의 pressed/active 상태를 덱의 오버뷰 활성 상태와 동기화한다.
        // (PC split 에서는 덱 자체 컨트롤이 숨겨져 이 버튼이 유일한 오버뷰 컨트롤이므로 a11y/시각 표시 필요.)
        function syncSlideNavOverviewBtn() {
            if (!slideNavOverviewBtn) return;
            const on = !!window.presentationIsOverview?.();
            slideNavOverviewBtn.classList.toggle('active', on);
            slideNavOverviewBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        // 인디케이터/이동 버튼 상태를 라이브 슬라이드 수(전체 문서 재분할)에 맞춰 갱신.
        function refreshSlideNav() {
            if (!slideNavEl || slideNavEl.hidden) return;
            const total = slideCtl.active ? Math.max(1, splitSlides(reconstructFullDoc()).length) : 1;
            const cur = Math.min(slideCtl.idx, total - 1);
            if (slideNavIndicator) slideNavIndicator.textContent = `${cur + 1} / ${total}`;
            if (slideNavPrevBtn) slideNavPrevBtn.disabled = cur <= 0;
            if (slideNavNextBtn) slideNavNextBtn.disabled = cur >= total - 1;
            // 덱 재렌더가 보존된 오버뷰 상태를 재적용할 수 있으므로 버튼 상태도 함께 맞춘다.
            syncSlideNavOverviewBtn();
        }
        _refreshSlideNav = refreshSlideNav;
        // 에디터 측 이전/다음 — 현재 슬라이드 텍스트를 확정(reconcile)한 뒤 대상 슬라이드로 전환.
        function gotoEditorSlide(delta) {
            if (!slideCtl.active) return;
            reconcileSlidesFromEditor();
            const target = Math.max(0, Math.min(slideCtl.idx + delta, slideCtl.slides.length - 1));
            if (target === slideCtl.idx) { refreshSlideNav(); return; }
            slideCtl.idx = target;
            loadActiveSlideIntoEditor();
            syncHashToActive();
            updateCustomPreview();
            refreshSlideNav();
            cmEditorView.focus();
        }
        // 전체보기/전체화면은 덱에 위임한다. 모바일 에디터 탭에서는 덱이 숨겨진 프리뷰
        // 패널에 라이브 렌더돼 있으므로, 패널을 표시(탭 전환, 재렌더 없음)한 뒤 덱을 토글한다.
        function runDeckAction(act) {
            // 모바일 에디터 탭에서는 덱이 숨겨진 프리뷰 패널에 라이브 렌더돼 있으므로,
            // 패널을 표시(탭 전환, 재렌더 없음)한 뒤 덱을 토글한다. isMobile 은 init 시점 값이라
            // 초기화 후 뷰포트가 좁아진 경우를 놓치므로, 클릭 시점의 실제 너비로 판정한다.
            if (window.innerWidth <= 768) revealPreviewPaneForDeck();
            // 토글만 수행한다. 직전 편집의 지연 프리뷰 재렌더(change debounce)가 뒤따라 fire 돼도
            // renderPresentation 이 오버뷰/풀스크린 상태를 보존·재적용하므로 그리드/풀스크린이
            // 닫히지 않으며, 그 재렌더가 최신 본문을 덱에 반영한다(전체화면은 시뮬레이션으로 이어짐).
            if (act === 'overview') {
                window.presentationToggleOverview?.();
                syncSlideNavOverviewBtn();
            } else if (act === 'fullscreen') {
                window.presentationToggleFullscreen?.();
            }
        }
        slideNavEl?.querySelectorAll('[data-slide-nav]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const act = btn.dataset.slideNav;
                if (act === 'prev') gotoEditorSlide(-1);
                else if (act === 'next') gotoEditorSlide(1);
                else runDeckAction(act);
            });
        });

        syncStateToWindow();
        // 에디터 shim 이 준비됐으니 자동완성 부착을 결정적으로 트리거한다.
        // autocomplete.ts 가 'wiki-editor-ready' 이벤트와 ensureAutocompleteAttached
        // 양쪽을 가드 idempotent 하게 처리하므로 어느 한 경로만 도달해도 부착된다.
        // 폴링 안전망을 제거한 뒤로는 이 트리거가 누락되면 자동완성이 부착되지
        // 않으므로, 두 경로를 모두 호출해 한쪽이 어떤 이유(미래의 리팩터링,
        // window 프로퍼티 충돌 등)로 무시되더라도 다른 한쪽이 동작하도록 한다.
        window.dispatchEvent(new Event('wiki-editor-ready'));
        if (typeof window.ensureAutocompleteAttached === 'function') {
            window.ensureAutocompleteAttached();
        }
        // ── 모바일 탭 전환 로직 ──
        const cmTabBtns = document.querySelectorAll('.cm-tab-btn');
        const cmEditorPane = document.getElementById('cm-editor-pane');
        const cmPreviewPane = document.getElementById('custom-wiki-preview');

        function activateCmTab(tab) {
            cmTabBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
            const layoutEl = document.querySelector('.wiki-editor-layout');
            if (layoutEl) layoutEl.dataset.activeTab = tab;
            if (tab === 'editor') {
                cmEditorPane.classList.add('cm-tab-active');
                cmPreviewPane.classList.remove('cm-tab-active');
                // 에디터 크기 재계산
                cmEditorView.requestMeasure();
            } else {
                cmEditorPane.classList.remove('cm-tab-active');
                cmPreviewPane.classList.add('cm-tab-active');
                // 프리뷰 탭으로 전환 시 즉시 렌더링
                updateCustomPreview();
            }
        }

        cmTabBtns.forEach(btn => {
            btn.addEventListener('click', () => activateCmTab(btn.dataset.tab));
        });

        // 모바일에서 에디터 하단 내비게이션의 전체보기/전체화면을 누르면, 덱이 보이도록
        // 프리뷰 탭을 표시한다. 덱은 (숨겨진 프리뷰 패널에) 이미 라이브 렌더돼 있으므로
        // updateCustomPreview 로 재렌더하지 않는다 — 재렌더는 _activeDeckEl 을 잠시 비워
        // 직후의 덱 토글(전체화면 requestFullscreen 등)을 무력화할 수 있다.
        function revealPreviewPaneForDeck() {
            cmTabBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === 'preview'));
            const layoutEl = document.querySelector('.wiki-editor-layout');
            if (layoutEl) layoutEl.dataset.activeTab = 'preview';
            cmEditorPane.classList.remove('cm-tab-active');
            cmPreviewPane.classList.add('cm-tab-active');
        }

        // 모바일이면 에디터 탭을 기본 활성화 (PC는 CSS로 항상 표시)
        if (isMobile) {
            activateCmTab('editor');
        }

        // ── 커스텀 툴바 구성 ──
        const toolbar = document.getElementById('cm-toolbar');

        function createToolbarBtn(icon, tooltip, onClick) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'cm-toolbar-btn';
            btn.innerHTML = icon;
            btn.title = tooltip;
            btn.addEventListener('click', onClick);
            return btn;
        }

        function createToolbarSep() {
            const sep = document.createElement('span');
            sep.className = 'cm-toolbar-sep';
            return sep;
        }

        // 마크다운 서식 삽입 헬퍼
        function wrapSelection(prefix, suffix) {
            const { main } = cmEditorView.state.selection;
            const selected = cmEditorView.state.sliceDoc(main.from, main.to);
            const wrapped = prefix + (selected || '텍스트') + suffix;
            cmEditorView.dispatch({
                changes: { from: main.from, to: main.to, insert: wrapped },
                selection: { anchor: main.from + prefix.length, head: main.from + wrapped.length - suffix.length }
            });
            cmEditorView.focus();
        }

        function insertPrefix(prefix) {
            const { main } = cmEditorView.state.selection;
            const line = cmEditorView.state.doc.lineAt(main.from);
            cmEditorView.dispatch({
                changes: { from: line.from, to: line.from, insert: prefix }
            });
            cmEditorView.focus();
        }

        // 그리드/row 같은 블록 위키 문법 인라인 삽입.
        // 선택이 없으면 예시(stat 3개) 삽입, 있으면 선택을 ::: 블록으로 감쌈.
        // 시작/끝이 라인 경계가 아니면 줄바꿈을 자동 보정.
        function insertOrWrapWikiBlock(blockType) {
            const { main } = cmEditorView.state.selection;
            const selected = cmEditorView.state.sliceDoc(main.from, main.to);
            const inner = selected || `{palette:primary}{stat:값1|라벨1}\n{palette:secondary}{stat:값2|라벨2}\n{palette:success}{stat:값3|라벨3}`;
            const lineStart = cmEditorView.state.doc.lineAt(main.from);
            const lineEnd = cmEditorView.state.doc.lineAt(main.to);
            const prefix = (main.from === lineStart.from) ? '' : '\n';
            const suffix = (main.to === lineEnd.to) ? '' : '\n';
            const wrapped = `${prefix}:::${blockType}\n${inner}\n:::${suffix}`;
            cmEditorView.dispatch({
                changes: { from: main.from, to: main.to, insert: wrapped },
                selection: { anchor: main.from + wrapped.length }
            });
            cmEditorView.focus();
        }

        // 포맷 버튼
        toolbar.appendChild(createToolbarBtn('<b>H</b>', '제목', () => insertPrefix('## ')));
        toolbar.appendChild(createToolbarBtn('<b>B</b>', '굵게', () => wrapSelection('**', '**')));
        toolbar.appendChild(createToolbarBtn('<i>I</i>', '기울임', () => wrapSelection('*', '*')));
        toolbar.appendChild(createToolbarBtn('<s>S</s>', '취소선', () => wrapSelection('~~', '~~')));
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-format-underline"></i>', '밑줄', () => wrapSelection('__', '__')));
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-marker"></i>', '형광펜', () => wrapSelection('==', '==')));
        toolbar.appendChild(createToolbarSep());
        toolbar.appendChild(createToolbarBtn('─', '구분선', () => editor.insertText('\n---\n')));
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-format-quote-close"></i>', '인용', () => insertPrefix('> ')));
        toolbar.appendChild(createToolbarSep());
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-format-list-bulleted"></i>', '목록', () => insertPrefix('- ')));
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-format-list-numbered"></i>', '번호 목록', () => insertPrefix('1. ')));
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-checkbox-marked-outline"></i>', '체크리스트', () => insertPrefix('- [ ] ')));
        toolbar.appendChild(createToolbarSep());
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-view-grid-outline"></i>', '그리드', () => insertOrWrapWikiBlock('grid')));
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-view-week-outline"></i>', 'row(가로 배치)', () => insertOrWrapWikiBlock('row')));
        toolbar.appendChild(createToolbarSep());
        const tableBtn = createToolbarBtn('<i class="mdi mdi-table"></i>', '표', () => { });
        toolbar.appendChild(tableBtn);
        window.setupTableInsertPopover(tableBtn);
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-link-variant"></i>', '링크', () => wrapSelection('[', '](url)')));
        toolbar.appendChild(createToolbarSep());

        // 위키 커스텀 버튼
        toolbar.appendChild(createToolbarBtn('[[ ]]', '위키 링크 삽입', () => editor.insertText('[[문서제목]]')));
        toolbar.appendChild(createToolbarBtn('{{ }}', '틀 삽입', () => editor.insertText('{{틀제목}}')));

        toolbar.appendChild(createToolbarBtn('[*]', '각주 삽입', () => editor.insertText('[* 각주 내용]')));
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-form-dropdown"></i>', '펼치기 접기', () => editor.insertText('[+ 펼치기/접기 제목]\n여기에 숨겨진 내용이 들어갑니다.\n[-]')));
        toolbar.appendChild(createToolbarBtn('<i class="bi bi-diagram-3-fill"></i>', '하위 문서', () => window.openSubdocInsertModal()));
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-calendar-clock"></i>', '타임스탬프 삽입', () => window.openTimestampInsertModal()));
        toolbar.appendChild(createToolbarSep());
        const specialCharBtn = createToolbarBtn('<span class="cm-toolbar-omega">Ω</span>', '특수문자 삽입', () => { });
        toolbar.appendChild(specialCharBtn);
        window.setupSpecialCharPicker(specialCharBtn);
        toolbar.appendChild(createToolbarSep());
        if (selectedIconsOnly) {
            toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-vector-square"></i>', '아이콘 삽입', () => window.openSelectedIconsPicker()));
        } else {
            toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-vector-square"></i>', 'MDI 아이콘', () => window.openIconPicker('mdi')));
            toolbar.appendChild(createToolbarBtn('<i class="bi bi-bootstrap-fill"></i>', 'Bootstrap 아이콘', () => window.openIconPicker('bi')));
        }
        toolbar.appendChild(createToolbarSep());
        toolbar.appendChild(createToolbarBtn('<i class="bi bi-card-heading"></i>', '카드 블록', () => window.openCardInsertModal()));
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-view-dashboard-outline"></i>', '탭 / 아코디언 / 진행상황', () => window.openStructureBlockInsertModal()));
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-palette-outline"></i>', '색상 삽입', () => window.openPaletteColorModal()));
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-label-outline"></i>', '배지', () => window.openBadgeInsertModal()));
        toolbar.appendChild(createToolbarSep());
        toolbar.appendChild(createToolbarBtn('<code>&lt;/&gt;</code>', '인라인 코드', () => wrapSelection('`', '`')));
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-code-braces"></i>', '코드 블록', () => wrapSelection('\n```\n', '\n```\n')));
        toolbar.appendChild(createToolbarSep());
        toolbar.appendChild(createToolbarBtn('<i class="mdi mdi-google-maps"></i>', '구글 지도 삽입', () => window.openGoogleMapsEmbedModal()));

        // 이미지 업로드 버튼 + 드래그앤드롭 팝업
        const imageUploadBtn = createToolbarBtn('<i class="mdi mdi-image-plus"></i>', '이미지 업로드', () => { });
        toolbar.appendChild(imageUploadBtn);

        const imgUploadPopup = document.createElement('div');
        imgUploadPopup.className = 'img-upload-popup';
        imgUploadPopup.innerHTML = `
        <div class="img-upload-dropzone">
            <i class="mdi mdi-cloud-upload-outline"></i>
            <div class="drop-main-text">이미지를 여기에 드래그하세요</div>
            <div class="drop-sub-text">또는 클릭하여 파일 선택</div>
        </div>
        <button type="button" class="img-upload-search-btn">
            <i class="mdi mdi-magnify"></i> 기존 이미지 검색
        </button>
    `;
        document.body.appendChild(imgUploadPopup);

        const imgDropzone = imgUploadPopup.querySelector('.img-upload-dropzone');
        const imgSearchBtn = imgUploadPopup.querySelector('.img-upload-search-btn');

        imgSearchBtn.addEventListener('click', async () => {
            imgUploadPopup.classList.remove('active');
            await window.openExistingImageSearch((url, alt, size) => {
                let insertTxt = `![${alt}](${url})`;
                if (size && size !== 'full') insertTxt += `{size:${size}}`;
                insertTxt += '\n';
                editor.insertText(insertTxt);
            });
        });
        const imgFileInput = document.createElement('input');
        imgFileInput.type = 'file';
        imgFileInput.accept = 'image/jpeg,image/png,image/gif,image/webp,image/svg+xml';
        imgFileInput.style.display = 'none';
        imgUploadPopup.appendChild(imgFileInput);

        imageUploadBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isActive = imgUploadPopup.classList.contains('active');
            imgUploadPopup.classList.toggle('active');
            if (!isActive) {
                const rect = imageUploadBtn.getBoundingClientRect();
                const popupW = imgUploadPopup.offsetWidth;
                const popupH = imgUploadPopup.offsetHeight;
                const viewportW = document.documentElement.clientWidth;
                const viewportH = document.documentElement.clientHeight;
                const margin = 8;
                const triggerCenterX = rect.left + (rect.width / 2);

                let left = triggerCenterX - (popupW / 2);
                left = Math.max(margin, Math.min(left, viewportW - popupW - margin));

                let top = rect.bottom + 6;
                if (top + popupH + margin > viewportH && rect.top - popupH - 6 >= margin) {
                    top = rect.top - popupH - 6;
                }
                top = Math.max(margin, Math.min(top, viewportH - popupH - margin));

                imgUploadPopup.style.left = (left + window.scrollX) + 'px';
                imgUploadPopup.style.top = (top + window.scrollY) + 'px';
            }
        });

        document.addEventListener('click', (e) => {
            if (!imgUploadPopup.contains(e.target) && !imageUploadBtn.contains(e.target)) {
                imgUploadPopup.classList.remove('active');
            }
        });

        imgDropzone.addEventListener('click', () => { imgFileInput.click(); });

        imgFileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            imgUploadPopup.classList.remove('active');
            await window.handleImageUpload(file, (url, alt, size) => {
                let insertTxt = `![${alt}](${url})`;
                if (size && size !== 'full') insertTxt += `{size:${size}}`;
                insertTxt += '\n';
                editor.insertText(insertTxt);
            });
            imgFileInput.value = '';
        });

        imgDropzone.addEventListener('dragenter', (e) => { e.preventDefault(); imgDropzone.classList.add('dragover'); });
        imgDropzone.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
        imgDropzone.addEventListener('dragleave', (e) => { e.preventDefault(); imgDropzone.classList.remove('dragover'); });
        imgDropzone.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            imgDropzone.classList.remove('dragover');
            const files = e.dataTransfer.files;
            if (!files || files.length === 0) return;
            const file = files[0];
            const acceptTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
            if (!acceptTypes.includes(file.type)) {
                window.Swal.fire('오류', '지원하지 않는 파일 형식입니다.', 'warning');
                return;
            }
            imgUploadPopup.classList.remove('active');
            await window.handleImageUpload(file, (url, alt, size) => {
                let insertTxt = `![${alt}](${url})`;
                if (size && size !== 'full') insertTxt += `{size:${size}}`;
                insertTxt += '\n';
                editor.insertText(insertTxt);
            });
        });

        // ── 툴바 오른쪽 끝: 찾기/바꾸기 + 프리뷰 모드 + 설정 버튼 ──
        // 우측 정렬은 #cm-find-btn 의 margin-left:auto 로 처리 (findBtn 이 이 그룹의 첫 항목)

        // PC 전용: 일반/작성/보기 모드 전환 드롭다운.
        // 프레젠테이션 문서에서는 별도 '슬라이드 모드'가 없다 — 일반(split) 모드가 곧
        // 단일 슬라이드 에디터 + 동기화 덱 프리뷰로 통합된 슬라이드 편집 경험이다.
        const PC_MODES = {
            split: { icon: 'mdi-view-split-vertical', label: '일반 모드', desc: '에디터 + 프리뷰' },
            edit: { icon: 'mdi-pencil', label: '작성 모드', desc: '에디터만' },
            preview: { icon: 'mdi-eye-outline', label: '보기 모드', desc: '프리뷰만' },
        };

        const modeBtn = createToolbarBtn(
            `<i class="mdi ${PC_MODES.split.icon}"></i><i class="mdi mdi-menu-down cm-toolbar-caret"></i>`,
            '보기 방식 전환',
            () => toggleModePanel()
        );
        modeBtn.id = 'cm-mode-btn';
        modeBtn.classList.add('cm-toolbar-btn-pc-only', 'cm-toolbar-btn-mode');
        toolbar.appendChild(modeBtn);

        const modePanel = document.createElement('div');
        modePanel.id = 'editor-mode-panel';
        modePanel.className = 'editor-settings-panel editor-mode-panel';
        modePanel.style.display = 'none';
        document.body.appendChild(modePanel);

        // 노출할 모드 키 목록. 프레젠테이션 여부와 무관하게 일반/작성/보기 3종.
        // (프레젠테이션 문서의 일반 모드가 통합 슬라이드 편집 경험을 담당한다.)
        function modeKeysForState() {
            return ['split', 'edit', 'preview'];
        }

        // 패널 옵션을 현재 상태에 맞춰 다시 그리고 클릭 핸들러/활성 표시를 부착한다.
        function renderModePanel() {
            modePanel.innerHTML = modeKeysForState().map((key) => {
                const m = PC_MODES[key];
                return `
            <button type="button" class="editor-mode-option" data-mode="${key}">
                <i class="mdi ${m.icon}"></i>
                <span class="editor-mode-option-text">
                    <span class="editor-mode-option-label">${m.label}</span>
                    <span class="editor-mode-option-desc">${m.desc}</span>
                </span>
                <i class="mdi mdi-check editor-mode-option-check"></i>
            </button>`;
            }).join('');
            modePanel.querySelectorAll('.editor-mode-option').forEach(opt => {
                opt.classList.toggle('active', opt.dataset.mode === currentPcMode);
                opt.addEventListener('click', () => {
                    setPcMode(opt.dataset.mode);
                    modePanel.style.display = 'none';
                });
            });
        }

        let currentPcMode = 'split';
        function setPcMode(mode) {
            const layoutEl = document.querySelector('.wiki-editor-layout');
            if (!layoutEl) return;
            if (!PC_MODES[mode]) mode = 'split';
            const prev = currentPcMode;
            currentPcMode = mode;
            pcViewMode = mode; // module-level updateCustomPreview 가 읽는 미러
            // 레이아웃: split 은 좌우 분할(프레젠테이션 문서면 좌=단일 슬라이드, 우=덱).
            if (mode === 'split') {
                delete layoutEl.dataset.pcMode;
            } else {
                layoutEl.dataset.pcMode = mode;
            }
            // 통합 단일 슬라이드 편집 진입/이탈. 프레젠테이션 문서 + split + !sectionMode 일 때만 활성.
            // updateCustomPreview(아래) 보다 먼저 처리해 에디터/덱이 올바른 내용으로 렌더되게 한다.
            const wantSlideEditing = isPresentationActive() && mode === 'split' && !sectionMode;
            if (wantSlideEditing && !slideCtl.active) enterSlideEditing();
            else if (!wantSlideEditing && slideCtl.active) leaveSlideEditing();
            const m = PC_MODES[mode];
            modeBtn.innerHTML = `<i class="mdi ${m.icon}"></i><i class="mdi mdi-menu-down cm-toolbar-caret"></i>`;
            modeBtn.title = `보기 방식: ${m.label}`;
            modeBtn.classList.toggle('active', mode !== 'split');
            modePanel.querySelectorAll('.editor-mode-option').forEach(opt => {
                opt.classList.toggle('active', opt.dataset.mode === mode);
            });
            if (prev === mode) return;
            // 에디터가 숨김에서 표시로 전환된 경우 CM6에 레이아웃 재측정 요청
            if (prev === 'preview' && mode !== 'preview' && typeof cmEditorView !== 'undefined' && cmEditorView) {
                cmEditorView.requestMeasure();
            }
            // 프리뷰가 보이는 모드(작성 모드 외)로 바뀌었으면 갱신. slide↔split↔preview 간
            // 전환은 프리뷰 렌더 경로(덱/일반)가 달라질 수 있으므로 항상 다시 그린다.
            if (mode !== 'edit') {
                updateCustomPreview();
            }
        }

        // 프레젠테이션 설정 체크박스 변경 시 호출되는 훅(initPresentationModeToggle 에서 연결).
        // 일반(split) 모드에서 프레젠테이션을 켜면 통합 단일 슬라이드 편집으로 진입하고,
        // 끄면 전체 문서 편집으로 되돌린다. 이후 프리뷰 렌더 경로(덱/일반)가 바뀌었을 수
        // 있으므로 프리뷰를 갱신한다.
        window._onPresentationModeToggled = () => {
            if (currentPcMode === 'split' && !sectionMode) {
                if (isPresentationActive()) {
                    if (!slideCtl.active) enterSlideEditing();
                } else if (slideCtl.active) {
                    leaveSlideEditing();
                }
            }
            if (currentPcMode !== 'edit') {
                updateCustomPreview();
            }
        };

        function toggleModePanel() {
            const isVisible = modePanel.style.display !== 'none';
            if (isVisible) {
                modePanel.style.display = 'none';
                return;
            }
            // 열 때마다 현재 프레젠테이션 상태/활성 모드를 반영해 옵션을 다시 그린다.
            renderModePanel();
            modePanel.style.visibility = 'hidden';
            modePanel.style.left = '-9999px';
            modePanel.style.top = '-9999px';
            modePanel.style.display = 'block';

            const panelW = modePanel.offsetWidth;
            const panelH = modePanel.offsetHeight;
            const rect = modeBtn.getBoundingClientRect();
            const viewportW = document.documentElement.clientWidth;
            const viewportH = document.documentElement.clientHeight;
            const margin = 8;

            let left = rect.right - panelW;
            left = Math.max(margin, Math.min(left, viewportW - panelW - margin));
            let top = rect.bottom + 4;
            if (top + panelH + margin > viewportH && rect.top - panelH - 4 >= margin) {
                top = rect.top - panelH - 4;
            }
            top = Math.max(margin, Math.min(top, viewportH - panelH - margin));

            modePanel.style.left = `${left + window.scrollX}px`;
            modePanel.style.top = `${top + window.scrollY}px`;
            modePanel.style.visibility = '';
        }

        // 패널 옵션 버튼의 클릭 핸들러는 renderModePanel 이 매 렌더 시 부착한다(열 때마다 갱신).

        document.addEventListener('click', (e) => {
            if (!modePanel.contains(e.target) && !modeBtn.contains(e.target)) {
                modePanel.style.display = 'none';
            }
        });

        renderModePanel();
        setPcMode('split');

        const settingsBtn = createToolbarBtn('<i class="mdi mdi-cog"></i>', '에디터 설정', () => toggleSettingsPanel());
        settingsBtn.id = 'cm-settings-btn';
        toolbar.appendChild(settingsBtn);

        // ── 에디터 설정 패널 ──
        const settingsPanel = document.createElement('div');
        settingsPanel.id = 'editor-settings-panel';
        settingsPanel.className = 'editor-settings-panel';
        settingsPanel.style.display = 'none';
        settingsPanel.innerHTML = `
            <div class="editor-settings-title"><i class="mdi mdi-cog"></i> 에디터 설정</div>
            <label class="editor-settings-item">
                <span>줄 번호 표시</span>
                <input type="checkbox" id="settingLineNumbers" ${editorSettings.showLineNumbers ? 'checked' : ''}>
            </label>
            <label class="editor-settings-item">
                <span>스크롤 동기화</span>
                <input type="checkbox" id="settingScrollSync" ${editorSettings.scrollSync ? 'checked' : ''}>
            </label>
            <label class="editor-settings-item editor-settings-subitem">
                <input type="radio" name="settingScrollSyncMode" value="oneway"
                    ${editorSettings.scrollSyncMode === 'oneway' ? 'checked' : ''}
                    ${editorSettings.scrollSync ? '' : 'disabled'}>
                <span>단방향 (에디터 → 프리뷰)</span>
            </label>
            <label class="editor-settings-item editor-settings-subitem">
                <input type="radio" name="settingScrollSyncMode" value="twoway"
                    ${editorSettings.scrollSyncMode === 'twoway' ? 'checked' : ''}
                    ${editorSettings.scrollSync ? '' : 'disabled'}>
                <span>양방향</span>
            </label>
            <label class="editor-settings-item">
                <span>문법 하이라이트</span>
                <input type="checkbox" id="settingSyntaxHighlight" ${editorSettings.syntaxHighlight ? 'checked' : ''}>
            </label>
            <label class="editor-settings-item">
                <span>아이콘 표시</span>
                <input type="checkbox" id="settingAdvancedEdit"
                    ${editorSettings.advancedEdit && editorSettings.syntaxHighlight ? 'checked' : ''}
                    ${editorSettings.syntaxHighlight ? '' : 'disabled'}>
            </label>
            <div class="editor-settings-divider"></div>
            <div class="editor-settings-section-title">줄바꿈 모드</div>
            <label class="editor-settings-item">
                <input type="radio" name="settingWrapMode" value="wrap" ${editorSettings.wordWrap ? 'checked' : ''}>
                <span>자동 줄바꿈 (기본)</span>
            </label>
            <label class="editor-settings-item">
                <input type="radio" name="settingWrapMode" value="scroll" ${!editorSettings.wordWrap ? 'checked' : ''}>
                <span>가로 스크롤</span>
            </label>
            <div class="editor-settings-divider"></div>
            <label class="editor-settings-item">
                <span>문법 자동완성</span>
                <input type="checkbox" id="settingSyntaxAutocomplete" ${editorSettings.syntaxAutocomplete ? 'checked' : ''}>
            </label>
            <label class="editor-settings-item">
                <span>편집 요약 자동 작성</span>
                <input type="checkbox" id="settingAutoSummary" ${editorSettings.autoSummary ? 'checked' : ''}>
            </label>
        `;
        document.body.appendChild(settingsPanel);

        function toggleSettingsPanel() {
            const isVisible = settingsPanel.style.display !== 'none';
            if (isVisible) {
                settingsPanel.style.display = 'none';
                settingsBtn.classList.remove('active');
            } else {
                // 크기 측정을 위해 일단 보이지 않게 렌더링
                settingsPanel.style.visibility = 'hidden';
                settingsPanel.style.left = '-9999px';
                settingsPanel.style.top = '-9999px';
                settingsPanel.style.display = 'block';

                const panelW = settingsPanel.offsetWidth;
                const panelH = settingsPanel.offsetHeight;
                const rect = settingsBtn.getBoundingClientRect();
                const viewportW = document.documentElement.clientWidth;
                const viewportH = document.documentElement.clientHeight;
                const margin = 8;

                // 버튼 바로 아래, 오른쪽 정렬 + 뷰포트 경계 클램핑
                let left = rect.right - panelW;
                left = Math.max(margin, Math.min(left, viewportW - panelW - margin));

                let top = rect.bottom + 4;
                if (top + panelH + margin > viewportH && rect.top - panelH - 4 >= margin) {
                    top = rect.top - panelH - 4;
                }
                top = Math.max(margin, Math.min(top, viewportH - panelH - margin));

                // position:absolute → document 좌표 사용 (scrollX/Y 포함)
                settingsPanel.style.left = `${left + window.scrollX}px`;
                settingsPanel.style.top = `${top + window.scrollY}px`;
                settingsPanel.style.visibility = '';
                settingsBtn.classList.add('active');
            }
        }

        // 설정 패널 외부 클릭 시 닫기
        document.addEventListener('click', (e) => {
            if (!settingsPanel.contains(e.target) && !settingsBtn.contains(e.target)) {
                settingsPanel.style.display = 'none';
                settingsBtn.classList.remove('active');
            }
        });

        // ── 찾기/바꾸기 ──
        const findBtn = createToolbarBtn(
            '<i class="mdi mdi-magnify"></i>',
            '찾기 / 바꾸기 (Ctrl+F)',
            () => {
                if (findPanel.style.display === 'block') closeFindPanel();
                else openFindPanel();
            }
        );
        findBtn.id = 'cm-find-btn';
        toolbar.insertBefore(findBtn, modeBtn);

        const findPanel = document.createElement('div');
        findPanel.id = 'cm-find-panel';
        findPanel.className = 'cm-find-panel';
        findPanel.style.display = 'none';
        findPanel.innerHTML = `
            <div class="cm-find-row">
                <input type="text" id="cmFindInput" class="cm-find-input" placeholder="찾기" autocomplete="off" spellcheck="false">
                <span class="cm-find-status" id="cmFindStatus"></span>
                <button type="button" id="cmFindPrevBtn" class="cm-find-btn" title="이전 (Shift+Enter)"><i class="mdi mdi-chevron-up"></i></button>
                <button type="button" id="cmFindNextBtn" class="cm-find-btn" title="다음 (Enter)"><i class="mdi mdi-chevron-down"></i></button>
                <label class="cm-find-toggle" title="대소문자 구분">
                    <input type="checkbox" id="cmFindCaseSensitive">
                    <span>Aa</span>
                </label>
                <button type="button" id="cmFindCloseBtn" class="cm-find-btn cm-find-close" title="닫기 (Esc)"><i class="mdi mdi-close"></i></button>
            </div>
            <div class="cm-find-row">
                <input type="text" id="cmReplaceInput" class="cm-find-input" placeholder="바꾸기" autocomplete="off" spellcheck="false">
                <button type="button" id="cmReplaceOneBtn" class="cm-find-btn cm-find-btn-text" title="현재 일치 항목을 바꾸고 다음으로 이동">
                    <i class="mdi mdi-find-replace"></i> 바꾸기
                </button>
            </div>
        `;
        document.body.appendChild(findPanel);

        const findInput = findPanel.querySelector('#cmFindInput');
        const replaceInput = findPanel.querySelector('#cmReplaceInput');
        const findStatus = findPanel.querySelector('#cmFindStatus');
        const findPrevBtn = findPanel.querySelector('#cmFindPrevBtn');
        const findNextBtn = findPanel.querySelector('#cmFindNextBtn');
        const findCaseCheck = findPanel.querySelector('#cmFindCaseSensitive');
        const findCloseBtn = findPanel.querySelector('#cmFindCloseBtn');
        const replaceOneBtn = findPanel.querySelector('#cmReplaceOneBtn');

        const _findState = { matches: [], currentIdx: -1, query: '', caseSensitive: false };

        function _computeFindMatches() {
            const q = _findState.query;
            if (!q) return [];
            // SearchCursor는 원본 Text 트리 위에서 동작하므로 İ→i̇ 처럼 길이가 변하는
            // Unicode 케이스 매핑이 있어도 from/to 가 항상 원본 인덱스로 반환된다.
            // 단순 인덱싱(toLowerCase 후 indexOf) 방식은 그런 문자 뒤의 위치가 어긋난다.
            const doc = cmEditorView.state.doc;
            const normalize = _findState.caseSensitive ? undefined : (s) => s.toLowerCase();
            const cursor = new SearchCursor(doc, q, 0, doc.length, normalize);
            const out = [];
            while (!cursor.next().done) {
                out.push({ from: cursor.value.from, to: cursor.value.to });
                if (out.length > 5000) break;
            }
            return out;
        }

        function _rebuildFindDeco() {
            if (_findState.matches.length === 0) {
                cmEditorView.dispatch({ effects: setSearchMatchesEffect.of(Decoration.none) });
                return;
            }
            const builder = new RangeSetBuilder();
            _findState.matches.forEach((m, i) => {
                builder.add(m.from, m.to, i === _findState.currentIdx ? searchActiveDeco : searchMatchDeco);
            });
            cmEditorView.dispatch({ effects: setSearchMatchesEffect.of(builder.finish()) });
        }

        function _updateFindStatus() {
            if (!_findState.query) { findStatus.textContent = ''; return; }
            if (_findState.matches.length === 0) { findStatus.textContent = '0/0'; return; }
            findStatus.textContent = `${_findState.currentIdx + 1}/${_findState.matches.length}`;
        }

        function _scrollFindMatchIntoView() {
            const m = _findState.matches[_findState.currentIdx];
            if (!m) return;
            cmEditorView.dispatch({ effects: EditorView.scrollIntoView(m.from, { y: 'center' }) });
        }

        // scroll: true 면 활성 매치를 화면에 보이도록 스크롤. 사용자 입력에 의한 본문
        // 변경(_findFeatureOnDocChange)에서는 false 로 호출해야 한다 — 그렇지 않으면 입력
        // 위치와 무관하게 매번 활성 매치로 뷰포트가 점프해 다른 곳을 편집하기 힘들어진다.
        function _refreshFind(useCursorAnchor, scroll) {
            if (scroll === undefined) scroll = true;
            _findState.matches = _computeFindMatches();
            if (_findState.matches.length === 0) {
                _findState.currentIdx = -1;
            } else if (useCursorAnchor) {
                const cursor = cmEditorView.state.selection.main.from;
                let idx = _findState.matches.findIndex(m => m.from >= cursor);
                if (idx === -1) idx = 0;
                _findState.currentIdx = idx;
            } else {
                if (_findState.currentIdx < 0) _findState.currentIdx = 0;
                if (_findState.currentIdx >= _findState.matches.length) _findState.currentIdx = _findState.matches.length - 1;
            }
            _rebuildFindDeco();
            if (_findState.currentIdx >= 0 && scroll) _scrollFindMatchIntoView();
            _updateFindStatus();
        }

        function _gotoFindNext() {
            if (_findState.matches.length === 0) return;
            _findState.currentIdx = (_findState.currentIdx + 1) % _findState.matches.length;
            _rebuildFindDeco();
            _scrollFindMatchIntoView();
            _updateFindStatus();
        }
        function _gotoFindPrev() {
            if (_findState.matches.length === 0) return;
            _findState.currentIdx = (_findState.currentIdx - 1 + _findState.matches.length) % _findState.matches.length;
            _rebuildFindDeco();
            _scrollFindMatchIntoView();
            _updateFindStatus();
        }

        function _replaceCurrentAndAdvance() {
            if (_findState.matches.length === 0 || _findState.currentIdx < 0) return;
            const m = _findState.matches[_findState.currentIdx];
            const replacement = replaceInput.value;
            cmEditorView.dispatch({
                changes: { from: m.from, to: m.to, insert: replacement }
            });
            // 본문이 바뀌었으므로 매치 재계산. 치환된 위치 다음으로 이동.
            const after = m.from + replacement.length;
            _findState.matches = _computeFindMatches();
            if (_findState.matches.length === 0) {
                _findState.currentIdx = -1;
            } else {
                let idx = _findState.matches.findIndex(mm => mm.from >= after);
                if (idx === -1) idx = 0;
                _findState.currentIdx = idx;
            }
            _rebuildFindDeco();
            if (_findState.currentIdx >= 0) _scrollFindMatchIntoView();
            _updateFindStatus();
        }

        function _positionFindPanel() {
            const tb = document.getElementById('cm-toolbar');
            if (!tb) return;
            const rect = tb.getBoundingClientRect();
            const margin = 8;
            const panelW = findPanel.offsetWidth || 420;
            const panelH = findPanel.offsetHeight || 90;
            const viewportW = document.documentElement.clientWidth;
            const viewportH = document.documentElement.clientHeight;
            let left = rect.right - panelW - 4;
            left = Math.max(margin, Math.min(left, viewportW - panelW - margin));
            let top = rect.bottom + 4;
            if (top + panelH + margin > viewportH && rect.top - panelH - 4 >= margin) {
                top = rect.top - panelH - 4;
            }
            findPanel.style.left = `${left + window.scrollX}px`;
            findPanel.style.top = `${top + window.scrollY}px`;
        }

        function openFindPanel() {
            const wasHidden = findPanel.style.display !== 'block';
            findPanel.style.display = 'block';
            // 측정 후 위치 설정
            _positionFindPanel();
            findBtn.classList.add('active');
            if (wasHidden) {
                // 에디터에 줄바꿈 없는 선택이 있으면 그걸로 채움
                const sel = cmEditorView.state.selection.main;
                if (sel.from !== sel.to) {
                    const text = cmEditorView.state.sliceDoc(sel.from, sel.to);
                    if (text && !text.includes('\n')) {
                        findInput.value = text;
                    }
                }
                _findState.query = findInput.value;
                _findState.caseSensitive = findCaseCheck.checked;
                _refreshFind(true);
            }
            findInput.focus();
            findInput.select();
        }

        function closeFindPanel() {
            findPanel.style.display = 'none';
            findBtn.classList.remove('active');
            _findState.query = '';
            _findState.matches = [];
            _findState.currentIdx = -1;
            _rebuildFindDeco();
            _updateFindStatus();
            cmEditorView.focus();
        }

        findInput.addEventListener('input', () => {
            _findState.query = findInput.value;
            _refreshFind(true);
        });
        findCaseCheck.addEventListener('change', () => {
            _findState.caseSensitive = findCaseCheck.checked;
            _refreshFind(false);
        });
        findInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) _gotoFindPrev(); else _gotoFindNext();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeFindPanel();
            }
        });
        replaceInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                _replaceCurrentAndAdvance();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeFindPanel();
            }
        });
        findNextBtn.addEventListener('click', _gotoFindNext);
        findPrevBtn.addEventListener('click', _gotoFindPrev);
        replaceOneBtn.addEventListener('click', () => {
            _replaceCurrentAndAdvance();
            // 연속 클릭 시 포커스 유지
            replaceInput.focus();
        });
        findCloseBtn.addEventListener('click', closeFindPanel);

        // 외부에서 본문이 변경되면 매치 재계산. 사용자가 다른 곳을 편집 중일 때 활성
        // 매치로 자동 스크롤되면 뷰포트가 계속 점프하므로, 여기서는 스크롤하지 않는다
        // (스크롤은 next/prev/open/replace 등 명시적 네비게이션에서만 수행).
        _findFeatureOnDocChange = () => {
            if (findPanel.style.display !== 'block') return;
            if (!_findState.query) return;
            _refreshFind(false, false);
        };

        window.addEventListener('resize', () => {
            if (findPanel.style.display === 'block') _positionFindPanel();
        });

        // 브라우저 Ctrl+F (또는 macOS Cmd+F) 인터셉트
        window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
                if (!document.getElementById('cm-editor')) return;
                e.preventDefault();
                openFindPanel();
            }
        });

        // ── 줄 번호 토글 ──
        document.getElementById('settingLineNumbers').addEventListener('change', (e) => {
            editorSettings.showLineNumbers = e.target.checked;
            localStorage.setItem('editor_show_line_numbers', editorSettings.showLineNumbers);
            cmEditorView.dispatch({
                effects: lineNumbersCompartment.reconfigure(
                    editorSettings.showLineNumbers
                        ? [lineNumbers(), highlightActiveLineGutter()]
                        : []
                )
            });
        });

        // ── 스크롤 동기화 토글 ──
        document.getElementById('settingScrollSync').addEventListener('change', (e) => {
            editorSettings.scrollSync = e.target.checked;
            localStorage.setItem('editor_scroll_sync', editorSettings.scrollSync);
            // 체크박스 상태에 따라 모드 라디오 활성/비활성 토글
            settingsPanel.querySelectorAll('input[name="settingScrollSyncMode"]').forEach(r => {
                r.disabled = !editorSettings.scrollSync;
            });
            setScrollSync(editorSettings.scrollSync);
        });

        // ── 스크롤 동기화 방향 모드 ──
        settingsPanel.querySelectorAll('input[name="settingScrollSyncMode"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                if (!e.target.checked) return;
                editorSettings.scrollSyncMode = e.target.value === 'twoway' ? 'twoway' : 'oneway';
                localStorage.setItem('editor_scroll_sync_mode', editorSettings.scrollSyncMode);
                if (editorSettings.scrollSync) setScrollSync(true);
            });
        });

        // ── 문법 하이라이트 / 고급 편집 토글 ──
        function applySyntaxAndAdvancedExtensions() {
            cmEditorView.dispatch({
                effects: [
                    syntaxHighlightCompartment.reconfigure(buildSyntaxHighlightExts()),
                    advancedEditCompartment.reconfigure(buildAdvancedEditExts())
                ]
            });
        }

        const syntaxHighlightCheckbox = document.getElementById('settingSyntaxHighlight');
        const advancedEditCheckbox = document.getElementById('settingAdvancedEdit');

        syntaxHighlightCheckbox.addEventListener('change', (e) => {
            editorSettings.syntaxHighlight = e.target.checked;
            localStorage.setItem('editor_syntax_highlight', editorSettings.syntaxHighlight);
            // 하이라이트가 꺼지면 고급 편집도 자동으로 꺼짐
            if (!editorSettings.syntaxHighlight && editorSettings.advancedEdit) {
                editorSettings.advancedEdit = false;
                localStorage.setItem('editor_advanced_edit', 'false');
                advancedEditCheckbox.checked = false;
            }
            advancedEditCheckbox.disabled = !editorSettings.syntaxHighlight;
            applySyntaxAndAdvancedExtensions();
        });

        advancedEditCheckbox.addEventListener('change', (e) => {
            if (!editorSettings.syntaxHighlight) {
                e.target.checked = false;
                return;
            }
            editorSettings.advancedEdit = e.target.checked;
            localStorage.setItem('editor_advanced_edit', editorSettings.advancedEdit);
            applySyntaxAndAdvancedExtensions();
        });

        // ── 줄바꿈 모드 토글 ──
        settingsPanel.querySelectorAll('input[name="settingWrapMode"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                if (e.target.checked) {
                    editorSettings.wordWrap = (e.target.value === 'wrap');
                    localStorage.setItem('editor_word_wrap', editorSettings.wordWrap);
                    cmEditorView.dispatch({
                        effects: lineWrappingCompartment.reconfigure(
                            editorSettings.wordWrap ? EditorView.lineWrapping : []
                        )
                    });
                    // 텍스트 diff 미리보기가 활성화돼 있으면 줄바꿈 변경을 즉시 반영
                    if (getDiffPreviewMode() === 'text') updateCustomPreview();
                }
            });
        });

        // ── 문법 자동완성 토글 (인라인 자동완성 + 표 인라인 툴바 공용 스위치) ──
        const syntaxAutocompleteCheckbox = document.getElementById('settingSyntaxAutocomplete');
        if (syntaxAutocompleteCheckbox) {
            syntaxAutocompleteCheckbox.addEventListener('change', (e) => {
                editorSettings.syntaxAutocomplete = e.target.checked;
                localStorage.setItem('editor_syntax_autocomplete', editorSettings.syntaxAutocomplete);
                window.wikiSyntaxAutocompleteEnabled = editorSettings.syntaxAutocomplete;
                // 비활성 즉시 떠 있을 수 있는 자동완성 드롭다운/표 툴바를 정리.
                // hideAllSyntaxAutocompletes 는 단순 display:none 이 아니라 각 hide*
                // 헬퍼를 호출해 visible/selectedIndex/query 등 내부 상태까지 초기화하므로,
                // 토글 직후 잔존하는 visible 플래그가 키보드 네비게이션(Enter/방향키)을
                // 가로채는 문제를 피할 수 있다.
                if (!editorSettings.syntaxAutocomplete) {
                    window.hideAllSyntaxAutocompletes?.();
                    tableToolbar.hide();
                } else {
                    // 재활성 시 현재 커서 위치에서 즉시 표 툴바 갱신 (자동완성은 다음 키입력에서 부착).
                    tableToolbar.update(cmEditorView);
                }
            });
        }

        // ── 편집 요약 자동 작성 토글 ──
        const autoSummaryCheckbox = document.getElementById('settingAutoSummary');
        if (autoSummaryCheckbox) {
            autoSummaryCheckbox.addEventListener('change', (e) => {
                editorSettings.autoSummary = e.target.checked;
                localStorage.setItem('editor_auto_summary', editorSettings.autoSummary);
                if (typeof window.refreshAutoSummary === 'function') window.refreshAutoSummary();
            });
        }

        // ── 스크롤 동기화 로직 ──
        let _scrollSyncHandler = null;        // 에디터 → 프리뷰
        let _previewScrollHandler = null;     // 프리뷰 → 에디터 (양방향 모드 한정)
        let _previewScrollTarget = null;
        let _previewLerpRAF = null;
        let _lerpLastSetScrollTop = null;
        let _editorScrollTarget = null;
        let _editorLerpRAF = null;
        let _lerpLastSetEditorScrollTop = null;

        function runPreviewLerp() {
            const customPreview = document.getElementById('custom-wiki-preview');
            if (!customPreview || _previewScrollTarget === null) {
                _previewLerpRAF = null;
                return;
            }
            // diff 미리보기로 전환되면 진행 중이던 lerp 가 diff DOM 의 scrollTop 을
            // stale 한 일반 프리뷰 오프셋으로 계속 끌고 가지 않도록 즉시 중단한다.
            if (getDiffPreviewMode() !== 'off') {
                _previewScrollTarget = null;
                _previewLerpRAF = null;
                _lerpLastSetScrollTop = null;
                return;
            }
            // 우리가 마지막에 설정한 값과 현재 값이 다르면 사용자가 직접 스크롤한 것 → lerp 중단
            if (_lerpLastSetScrollTop !== null && Math.abs(customPreview.scrollTop - _lerpLastSetScrollTop) > 2) {
                _previewScrollTarget = null;
                _previewLerpRAF = null;
                _lerpLastSetScrollTop = null;
                return;
            }
            const current = customPreview.scrollTop;
            const diff = _previewScrollTarget - current;
            if (Math.abs(diff) < 0.5) {
                customPreview.scrollTop = _previewScrollTarget;
                _previewScrollTarget = null;
                _previewLerpRAF = null;
                _lerpLastSetScrollTop = null;
                return;
            }
            const newScrollTop = current + diff * 0.15;
            customPreview.scrollTop = newScrollTop;
            _lerpLastSetScrollTop = newScrollTop;
            _previewLerpRAF = requestAnimationFrame(runPreviewLerp);
        }

        function smoothScrollPreviewTo(targetTop) {
            _previewScrollTarget = Math.max(0, targetTop);
            _lerpLastSetScrollTop = null; // 새 lerp 시작 시 초기화
            if (!_previewLerpRAF) {
                _previewLerpRAF = requestAnimationFrame(runPreviewLerp);
            }
        }

        function runEditorLerp() {
            const scroller = window._cmView && window._cmView.scrollDOM;
            if (!scroller || _editorScrollTarget === null) {
                _editorLerpRAF = null;
                return;
            }
            // diff 미리보기로 전환되면 역방향 lerp 도 즉시 중단 (위 동일 사유)
            if (getDiffPreviewMode() !== 'off') {
                _editorScrollTarget = null;
                _editorLerpRAF = null;
                _lerpLastSetEditorScrollTop = null;
                return;
            }
            if (_lerpLastSetEditorScrollTop !== null && Math.abs(scroller.scrollTop - _lerpLastSetEditorScrollTop) > 2) {
                _editorScrollTarget = null;
                _editorLerpRAF = null;
                _lerpLastSetEditorScrollTop = null;
                return;
            }
            const current = scroller.scrollTop;
            const diff = _editorScrollTarget - current;
            if (Math.abs(diff) < 0.5) {
                scroller.scrollTop = _editorScrollTarget;
                _editorScrollTarget = null;
                _editorLerpRAF = null;
                _lerpLastSetEditorScrollTop = null;
                return;
            }
            const newScrollTop = current + diff * 0.15;
            scroller.scrollTop = newScrollTop;
            _lerpLastSetEditorScrollTop = newScrollTop;
            _editorLerpRAF = requestAnimationFrame(runEditorLerp);
        }

        function smoothScrollEditorTo(targetTop) {
            _editorScrollTarget = Math.max(0, targetTop);
            _lerpLastSetEditorScrollTop = null;
            if (!_editorLerpRAF) {
                _editorLerpRAF = requestAnimationFrame(runEditorLerp);
            }
        }

        // 에디터 raw 마크다운에서 헤딩 라인 인덱스 목록을 추출.
        // - ATX 헤딩(`#`~`####`) + Setext 헤딩(`===`/`---`) 모두 인식
        // - 펜스 코드블록(백틱/틸드) 내부의 헤딩은 제외
        // - 반환: [{ lineIdx (0-based) }, ...] (등장 순서)
        // 프리뷰 측 `data-raw-line` 속성과 동일한 기준으로 산출되어야 한다.
        function _collectRawHeadingsFromDoc(docText) {
            const lines = docText.split('\n');
            const headings = [];
            let inFencedCode = false;
            let fenceChar = '';
            let fenceLen = 0;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];

                if (!inFencedCode) {
                    const fenceMatch = line.match(/^(`{3,}|~{3,})(.*)$/);
                    if (fenceMatch) {
                        const opener = fenceMatch[1];
                        const rest = fenceMatch[2];
                        const ch = opener[0];
                        // CommonMark: 백틱 펜스 오프너의 info string 에는 백틱이 들어갈 수 없다.
                        // 틸드 펜스는 info string 에 어떤 문자(틸드 포함)든 허용된다.
                        const isValidFence = ch !== '`' || !rest.includes('`');
                        if (isValidFence) {
                            inFencedCode = true;
                            fenceChar = ch;
                            fenceLen = opener.length;
                            continue;
                        }
                    }
                    if (/^#{1,4}[ \t]/.test(line)) {
                        headings.push({ lineIdx: i });
                        continue;
                    }
                    // Setext 헤딩 감지: 이전 줄이 문단 텍스트일 때만 인정.
                    // marked 의 Setext 인식 조건과 일치시켜 프리뷰의 헤딩 수와 어긋나지 않도록 한다.
                    if (i > 0) {
                        const underlineMatch = line.match(/^(=+|-+)\s*$/);
                        if (underlineMatch) {
                            const prev = lines[i - 1];
                            // 들여쓰기 코드 컨텍스트(앞에 빈 줄 또는 문서 시작이 있고 prev 가 4칸 이상
                            // 공백/탭으로 시작) 는 문단이 아니라 코드블록이므로 Setext 베이스가 될 수 없다.
                            // 들여쓰기 자체로만 판정하지 않고 직전 라인이 빈 줄/문서 시작인지 함께 보아
                            // 문단 lazy continuation(들여쓴 후속 라인) 케이스를 보존한다.
                            const isIndentedCodeBlockStart = /^(?: {4,}|\t)/.test(prev)
                                && (i - 2 < 0 || lines[i - 2].trim() === '');
                            const prevTrim = prev.trim();
                            const isParagraph = !isIndentedCodeBlockStart
                                && prevTrim !== ''
                                && !prevTrim.startsWith('#')
                                && !prevTrim.startsWith('>')
                                && !/^[-*_]{3,}\s*$/.test(prevTrim)
                                && !/^[-*+]\s+/.test(prevTrim)
                                && !/^\d+[.)]\s+/.test(prevTrim)
                                && !/^(`{3,}|~{3,})/.test(prevTrim);
                            if (isParagraph) {
                                headings.push({ lineIdx: i - 1 });
                            }
                        }
                    }
                } else {
                    const trimmed = line.trim();
                    if (trimmed[0] === fenceChar
                        && trimmed.replace(new RegExp('^' + fenceChar + '+'), '').trim() === ''
                        && trimmed.length >= fenceLen) {
                        inFencedCode = false;
                    }
                }
            }
            return headings;
        }

        // 프리뷰에서 raw 라인 인덱스에 대응하는 anchor 엘리먼트를 찾는다.
        // data-raw-line 부여 전 렌더본/수동 호출 등에 대비해 data-heading-idx 폴백을 둔다.
        function _findPreviewAnchorByRawLine(previewEl, rawLineIdx, fallbackIdx) {
            if (rawLineIdx != null) {
                const anchor = previewEl.querySelector(`[data-raw-line="${rawLineIdx}"]`);
                if (anchor) return anchor;
            }
            if (fallbackIdx != null && fallbackIdx >= 0) {
                return previewEl.querySelector(`[data-heading-idx="${fallbackIdx}"]`);
            }
            return null;
        }

        // 가이드포인트 캐시.
        // 헤딩 anchor 의 절대 scrollTop 위치는 프리뷰 콘텐츠가 변하지 않는 한 불변이므로,
        // 매 스크롤 이벤트마다 _collectRawHeadingsFromDoc / getBoundingClientRect 를 다시 돌리지 않는다.
        // 무효화 트리거: 프리뷰 재렌더, 윈도우 리사이즈, 스크롤 동기화 활성화.
        let _scrollSyncGuidesCache = null;
        function _invalidateScrollSyncGuides() {
            _scrollSyncGuidesCache = null;
        }
        // updateCustomPreview / 윈도우 리사이즈 등 동기화 함수 외부에서도 무효화할 수 있도록 노출
        window._invalidateScrollSyncGuides = _invalidateScrollSyncGuides;
        window.addEventListener('resize', _invalidateScrollSyncGuides, { passive: true });
        // mermaid 다이어그램은 비동기(네트워크 import + SVG 렌더)로 레이아웃을 크게 바꾸는데,
        // fold/트랜스클루전 등 프리뷰 직속 자식이 아닌 위치면 ResizeObserver(직속 자식만 관찰)가
        // 변동을 놓친다. render.ts 가 렌더 완료 시 쏘는 신호를 받아 헤딩 가이드 캐시를 무효화한다.
        window.addEventListener('wiki:mermaid-rendered', _invalidateScrollSyncGuides);

        // 프리뷰 내부의 비동기 레이아웃 변동(이미지/임베드 지연 로드, 폰트 늦은 적용,
        // 익스텐션의 사후 DOM 변형 등)도 헤딩 오프셋을 흔들 수 있으므로 감지하여 캐시 무효화.
        // 매 스크롤 이벤트가 아니라 "레이아웃이 실제로 흔들렸을 때"만 캐시를 버린다.
        let _scrollSyncResizeObserver = null;
        let _scrollSyncBsListenersBound = false;
        function _observePreviewLayoutShifts() {
            const customPreview = document.getElementById('custom-wiki-preview');
            if (!customPreview) return;
            if (typeof ResizeObserver !== 'undefined') {
                if (!_scrollSyncResizeObserver) {
                    _scrollSyncResizeObserver = new ResizeObserver(_invalidateScrollSyncGuides);
                }
                _scrollSyncResizeObserver.disconnect();
                // 직접 자식 노드의 크기 변화를 본다 (이미지/임베드/익스텐션 캔버스 등)
                Array.from(customPreview.children).forEach(child => {
                    try { _scrollSyncResizeObserver.observe(child); } catch (_) { /* ignore */ }
                });
            }
            // Bootstrap 탭/아코디언 토글은 패널 display 만 바꿔서 자식 크기 변화로
            // 잡히지 않을 수 있다. shown/hidden 이벤트는 버블되므로 prev 자식에서 받는다.
            if (!_scrollSyncBsListenersBound) {
                ['shown.bs.tab', 'hidden.bs.tab', 'shown.bs.collapse', 'hidden.bs.collapse']
                    .forEach(evt => customPreview.addEventListener(evt, _invalidateScrollSyncGuides));
                _scrollSyncBsListenersBound = true;
            }
            // 폰트 늦은 적용으로 인한 텍스트 metrics 재계산 한 번
            if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
                document.fonts.ready.then(_invalidateScrollSyncGuides).catch(() => {});
            }
        }
        window._observePreviewLayoutShifts = _observePreviewLayoutShifts;
        function _buildScrollSyncGuides() {
            const customPreview = document.getElementById('custom-wiki-preview');
            if (!customPreview || !window._cmView) return null;
            const view = window._cmView;
            const totalLines = view.state.doc.lines;
            const rawHeadings = _collectRawHeadingsFromDoc(view.state.doc.toString());
            const previewRect = customPreview.getBoundingClientRect();
            const previewScrollTop = customPreview.scrollTop;
            const maxScroll = Math.max(0, customPreview.scrollHeight - customPreview.clientHeight);

            // 헤딩 anchor 가 비활성 탭 패널(display:none) / 접힌 아코디언 내부면
            // getBoundingClientRect 가 0/누락 좌표를 돌려준다. 가시 조상 컨테이너로
            // 폴백해 최소한 해당 컴포넌트 위치까지는 따라가도록 한다.
            function _resolveMeasurableAnchor(anchorEl) {
                if (!anchorEl) return null;
                if (anchorEl.offsetParent !== null) return anchorEl;
                let cur = anchorEl.parentElement;
                while (cur && cur !== customPreview) {
                    if (cur.offsetParent !== null) return cur;
                    cur = cur.parentElement;
                }
                return null;
            }
            const guides = [{ line: 0, targetTop: 0 }];
            for (let k = 0; k < rawHeadings.length; k++) {
                const anchorRaw = _findPreviewAnchorByRawLine(customPreview, rawHeadings[k].lineIdx, k);
                const anchor = _resolveMeasurableAnchor(anchorRaw);
                if (!anchor) continue;
                const anchorRect = anchor.getBoundingClientRect();
                const t = previewScrollTop + (anchorRect.top - previewRect.top) - 10;
                guides.push({
                    line: rawHeadings[k].lineIdx,
                    targetTop: Math.min(maxScroll, Math.max(0, t))
                });
            }
            // refLine0 은 0..totalLines-1 범위라 끝 가이드 라인을 totalLines-1 로 맞춘다.
            // 단, 끝 라인이 마지막 가이드(시작 가이드 또는 마지막 헤딩) 의 라인보다
            // 더 크지 않으면 push 하지 않는다. (라인 동일 시 동일라인 가이드의 마지막 항목이
            // loIdx 로 선택되어 maxScroll 로 잘못 점프하는 회귀 방지)
            const endLine = Math.max(0, totalLines - 1);
            if (endLine > guides[guides.length - 1].line) {
                guides.push({ line: endLine, targetTop: maxScroll });
            }
            return guides;
        }

        function syncEditorScrollToPreview() {
            // 에디터 스크롤 영역 최상단 라인을 기준으로 프리뷰 scrollTop 을 결정한다.
            // (커서 위치는 사용하지 않음 — 휠/스크롤바 등 스크롤 위치 변화에만 반응)
            //
            // 헤딩 anchor 만 사용하던 섹션 단위 스크롤을 줄 단위로 세분화한다.
            // 헤딩들의 (raw 라인, 프리뷰 scrollTop) 쌍을 가이드포인트로 두고,
            // 현재 기준 라인이 두 가이드 사이에 있으면 라인 위치로 선형 보간하여
            // 프리뷰 scrollTop 을 결정한다. 결과적으로 에디터에서 한 줄 움직이면
            // 프리뷰도 비례해 한 줄만큼 따라간다.
            // 통합 슬라이드 편집 중에는 프리뷰가 덱이고 에디터는 단일 슬라이드라
            // 줄↔헤딩 매핑이 무의미하므로 스크롤 동기화를 건너뛴다.
            if (slideCtl.active) return;
            const customPreview = document.getElementById('custom-wiki-preview');
            if (!customPreview || !window._cmView) return;

            // 양방향 모드: 프리뷰 → 에디터 lerp 가 진행 중이면 에디터 스크롤은
            // 프로그램에 의한 것이므로 다시 프리뷰로 되돌리지 않는다.
            if (_editorScrollTarget !== null) return;

            const view = window._cmView;
            const scroller = view.scrollDOM;
            if (!scroller) return;

            // diff 미리보기 모드: 프리뷰 DOM 에 헤딩/라인 마커(data-raw-line)가 없어
            // 줄↔블록 정밀 매핑이 불가능하므로 스크롤 싱크를 끈다(프리뷰는 독립 스크롤).
            // 빈 가이드 캐시만으로는 아래 하단 스냅 로직이 남아 부분 싱크가 일어나므로
            // 여기서 명시적으로 early return 해 완전히 비활성화한다.
            if (getDiffPreviewMode() !== 'off') return;

            // 에디터가 맨 아래까지 스크롤되면 프리뷰도 맨 아래로 (끝부분 오차 보정)
            if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) {
                smoothScrollPreviewTo(customPreview.scrollHeight);
                return;
            }

            const rect = scroller.getBoundingClientRect();
            let topPos = view.posAtCoords({ x: rect.left + 20, y: rect.top + 10 }, false);
            if (topPos === null) {
                if (!view.visibleRanges || !view.visibleRanges.length) return;
                topPos = view.visibleRanges[0].from;
            }
            const refLine0 = view.state.doc.lineAt(topPos).number - 1;

            // 가이드포인트: { line (0-indexed), targetTop (프리뷰 scrollTop) }
            // - 문서 시작(line=0) → 프리뷰 최상단
            // - 각 헤딩 → 해당 anchor 가 프리뷰 상단에 오는 scrollTop
            // - 문서 끝(line=totalLines-1) → 프리뷰 최하단
            // 캐시가 비어 있을 때만 재계산 (스크롤 이벤트마다 DOM 측정 회피).
            if (!_scrollSyncGuidesCache) {
                _scrollSyncGuidesCache = _buildScrollSyncGuides();
            }
            const guides = _scrollSyncGuidesCache;
            if (!guides || guides.length === 0) return;

            // refLine0 을 포함하는 가이드 구간 [lo, hi] 를 찾는다.
            // 같은 line 의 가이드가 여러 개면 더 뒤쪽(=헤딩 anchor)을 lo 로 선택해
            // 헤딩 위치 정확도를 유지한다.
            let loIdx = 0;
            for (let k = 0; k < guides.length; k++) {
                if (guides[k].line <= refLine0) loIdx = k;
                else break;
            }
            const lo = guides[loIdx];
            const hi = guides[Math.min(loIdx + 1, guides.length - 1)];

            const lineSpan = hi.line - lo.line;
            let targetTop;
            if (lineSpan <= 0) {
                targetTop = lo.targetTop;
            } else {
                const ratio = (refLine0 - lo.line) / lineSpan;
                targetTop = lo.targetTop + (hi.targetTop - lo.targetTop) * ratio;
            }
            smoothScrollPreviewTo(targetTop);
        }

        // 양방향 모드에서 사용: 프리뷰 스크롤 위치 → 에디터 스크롤 위치 동기화.
        // 가이드포인트의 (line, targetTop) 쌍을 역으로 보간하여 대응 라인을 얻고,
        // 그 라인의 픽셀 위치로 에디터 스크롤을 부드럽게 이동시킨다.
        function syncPreviewScrollToEditor() {
            // 통합 슬라이드 편집 중에는 프리뷰가 덱이므로 역방향 스크롤 싱크도 끈다.
            if (slideCtl.active) return;
            const customPreview = document.getElementById('custom-wiki-preview');
            if (!customPreview || !window._cmView) return;

            // 에디터 → 프리뷰 lerp 가 진행 중이면 프리뷰 스크롤은 프로그램에 의한 것
            if (_previewScrollTarget !== null) return;

            const view = window._cmView;
            const scroller = view.scrollDOM;
            if (!scroller) return;

            // diff 미리보기 모드: 역방향 스크롤 싱크도 끈다 (위 동일 사유)
            if (getDiffPreviewMode() !== 'off') return;

            // 프리뷰가 맨 아래까지 스크롤되면 에디터도 맨 아래로
            if (customPreview.scrollTop + customPreview.clientHeight >= customPreview.scrollHeight - 4) {
                smoothScrollEditorTo(scroller.scrollHeight);
                return;
            }

            if (!_scrollSyncGuidesCache) {
                _scrollSyncGuidesCache = _buildScrollSyncGuides();
            }
            const guides = _scrollSyncGuidesCache;
            if (!guides || guides.length === 0) return;

            const previewTop = customPreview.scrollTop;

            // previewTop 을 포함하는 가이드 구간 [lo, hi] 찾기 (targetTop 기준).
            // 가이드는 line 오름차순으로 만들어졌고 targetTop 도 단조 증가가 보장되지 않을 수
            // 있으나(설계상 헤딩 순서대로 늘어남), 안전하게 targetTop 을 기준으로 다시 찾는다.
            let loIdx = 0;
            for (let k = 0; k < guides.length; k++) {
                if (guides[k].targetTop <= previewTop) loIdx = k;
                else break;
            }
            const lo = guides[loIdx];
            const hi = guides[Math.min(loIdx + 1, guides.length - 1)];

            const topSpan = hi.targetTop - lo.targetTop;
            let refLine0;
            if (topSpan <= 0) {
                refLine0 = lo.line;
            } else {
                const ratio = (previewTop - lo.targetTop) / topSpan;
                refLine0 = lo.line + (hi.line - lo.line) * ratio;
            }

            // 라인 → 에디터 픽셀 위치 변환.
            // 1차: view.coordsAtPos 는 뷰포트 기준 좌표를 주므로 문서 좌표로 변환.
            // 2차(폴백): 대상 라인이 렌더된 뷰포트 밖이면 coordsAtPos 가 null 을 반환할 수
            //   있으므로, 문서 전체에 대해 유효한 view.lineBlockAt 으로 절대 top 을 얻는다.
            //   (lineBlockAt 의 top 은 문서 시작 기준 오프셋이라 그대로 scrollTop 에 사용 가능)
            const totalLines = view.state.doc.lines;
            const lineNum = Math.max(1, Math.min(totalLines, Math.round(refLine0) + 1));
            const linePos = view.state.doc.line(lineNum).from;
            let targetTop;
            const coords = view.coordsAtPos(linePos);
            if (coords) {
                const scrollerRect = scroller.getBoundingClientRect();
                targetTop = scroller.scrollTop + (coords.top - scrollerRect.top) - 10;
            } else {
                const block = view.lineBlockAt(linePos);
                if (!block) return;
                targetTop = block.top - 10;
            }
            smoothScrollEditorTo(targetTop);
        }

        function setScrollSync(enabled) {
            // 에디터 스크롤(뷰포트 최상단 라인)을 기준으로 프리뷰를 따라가게 한다.
            // 양방향(twoway) 모드에서는 프리뷰 스크롤 시 에디터도 따라간다.
            _scrollSyncEnabled = !!enabled;

            const scroller = cmEditorView && cmEditorView.scrollDOM;
            if (scroller && _scrollSyncHandler) {
                scroller.removeEventListener('scroll', _scrollSyncHandler);
                _scrollSyncHandler = null;
            }
            const customPreview = document.getElementById('custom-wiki-preview');
            if (customPreview && _previewScrollHandler) {
                customPreview.removeEventListener('scroll', _previewScrollHandler);
                _previewScrollHandler = null;
            }
            // 진행 중인 lerp RAF 가 있으면 즉시 취소하고 타깃 상태를 비운다.
            // (리스너만 떼면 이미 큐된 RAF 콜백이 한두 프레임 더 scrollTop 을 움직여
            //  사용자가 토글을 끈 직후에도 자동 스크롤이 잠깐 이어지는 문제 방지)
            if (_previewLerpRAF) {
                cancelAnimationFrame(_previewLerpRAF);
                _previewLerpRAF = null;
            }
            _previewScrollTarget = null;
            _lerpLastSetScrollTop = null;
            if (_editorLerpRAF) {
                cancelAnimationFrame(_editorLerpRAF);
                _editorLerpRAF = null;
            }
            _editorScrollTarget = null;
            _lerpLastSetEditorScrollTop = null;

            if (_scrollSyncEnabled && scroller) {
                _scrollSyncHandler = () => syncEditorScrollToPreview();
                scroller.addEventListener('scroll', _scrollSyncHandler, { passive: true });
                if (editorSettings.scrollSyncMode === 'twoway' && customPreview) {
                    _previewScrollHandler = () => syncPreviewScrollToEditor();
                    customPreview.addEventListener('scroll', _previewScrollHandler, { passive: true });
                }
                // 활성화 직후 가이드 캐시를 새로 만들고 현재 스크롤 위치에 맞춤
                _invalidateScrollSyncGuides();
                syncEditorScrollToPreview();
            }
        }

        // 초기 스크롤 동기화 설정 적용
        if (editorSettings.scrollSync) {
            setScrollSync(true);
        }

        // ── 아이콘 피커 모달 닫힘 후 아이콘 삽입 (상태는 edit/modals.ts 가 window.* 로 노출) ──
        document.getElementById('iconPickerModal').addEventListener('hidden.bs.modal', () => {
            if (window.pendingIconInsertion && editor) {
                editor.focus();
                if (window.iconPickerSavedSelection) {
                    editor.setSelection(window.iconPickerSavedSelection[0], window.iconPickerSavedSelection[1]);
                }
                editor.insertText(window.pendingIconInsertion);
                window.pendingIconInsertion = null;
            }
        });


        // ── 붙여넣기 시 화면 스크롤 이동 방지 ──
        const editorEl = document.querySelector('#editor');
        if (editorEl) {
            editorEl.addEventListener('paste', () => {
                const currentScrollY = window.scrollY;
                const currentScrollX = window.scrollX;
                requestAnimationFrame(() => {
                    window.scrollTo(currentScrollX, currentScrollY);
                    setTimeout(() => window.scrollTo(currentScrollX, currentScrollY), 10);
                });
            }, true);
        }

        // ── 실시간 프리뷰 ──
        editor.on('change', () => {
            // 프로그램적 슬라이드 스왑(loadActiveSlideIntoEditor/leaveSlideEditing) 중에는
            // 불필요한 덱 재렌더를 막는다(스왑 결과는 동일 전체 문서라 무의미한 비용).
            if (slideCtl.suppressChange) return;
            clearTimeout(previewDebounce);
            previewDebounce = setTimeout(async () => {
                await updateCustomPreview();
                // 프리뷰 재렌더 후 현재 에디터 스크롤 위치에 맞춰 동기화
                // (헤딩 추가/삭제 시 data-heading-idx 가 갱신된 후에 매칭되도록)
                if (_scrollSyncEnabled && typeof syncEditorScrollToPreview === 'function') {
                    syncEditorScrollToPreview();
                }
            }, 300);
        });
        let isInitialLoadScroll = true;
        setTimeout(async () => {
            // 초기 렌더 전, 프레젠테이션 문서이면서 일반(split) 모드면 통합 단일 슬라이드
            // 편집으로 진입한다(초기 setPcMode('split') 시점엔 본문/체크박스가 아직 미초기화일 수 있음).
            if (isSlideEditing() && !slideCtl.active) enterSlideEditing();
            await updateCustomPreview();
            if (isInitialLoadScroll) {
                scrollPreviewToBottom();
                isInitialLoadScroll = false;
            } else {
                // If it's not initial, we don't auto scroll preview
            }
        }, 300);

        // 테마 변경 시 에디터 실시간 업데이트
        const applyEditorTheme = () => {
            const newIsDarkMode = window.getIsDarkMode();
            if (newIsDarkMode === isDarkMode) return;
            isDarkMode = newIsDarkMode;

            const effects = [
                themeCompartment.reconfigure(isDarkMode ? oneDark : lightTheme),
                darkBgCompartment.reconfigure(buildDarkBgExt()),
                syntaxHighlightCompartment.reconfigure(buildSyntaxHighlightExts()),
            ];

            if (typeof advancedEditCompartment !== 'undefined') {
                effects.push(
                    advancedEditCompartment.reconfigure(
                        advancedEditCompartment.get(cmEditorView.state) || []
                    )
                );
            }

            cmEditorView.dispatch({ effects });
        };

        // data-theme 속성 변경 감지 (수동 테마 전환)
        new MutationObserver(applyEditorTheme).observe(
            document.documentElement,
            { attributes: true, attributeFilter: ['data-theme'] }
        );

        // OS 다크모드 변경 감지 (auto 모드 시)
        if (window.matchMedia) {
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyEditorTheme);
        }
    } // ── isExtensionData else 블록 종료 ──

    // 반응형 Preview Style 변경
    window.addEventListener('resize', () => {
        if (!editor) return;
        const isMobileNow = window.innerWidth <= 768;
        const targetStyle = isMobileNow ? 'tab' : 'vertical';
        editor.changePreviewStyle(targetStyle);
    });

    // 관리자면 하위 일괄 카테고리 관리 패널 노출. (잠금/비공개/편집 ACL 토글은 에디터에서
    // 제거됨 — 문서 도구 드롭다운의 "권한 관리" 모달에서 처리.)
    if (window.currentUser.role === 'admin' || window.currentUser.role === 'super_admin') {
        const bulkPanel = document.getElementById('bulkCategoryAdminPanel');
        if (bulkPanel) bulkPanel.style.display = '';
    }

    // 관리자 전용 카테고리 목록 불러오기
    let adminCategories = [];
    try {
        const catRes = await fetch('/api/w/admin-categories');
        if (catRes.ok) {
            const catData = await catRes.json();
            adminCategories = catData.categories || [];
        }
    } catch (e) { }

    // 카테고리 입력 시 관리자 전용 여부 경고
    const catInput = document.getElementById('categoryInput');
    const catWarning = document.createElement('div');
    catWarning.className = 'text-danger small mt-1 d-none';
    catWarning.id = 'categoryWarning';
    catWarning.innerHTML = '<i class="mdi mdi-alert"></i> 이 카테고리는 관리자만 적용할 수 있습니다.';
    catInput.parentNode.appendChild(catWarning);

    catInput.addEventListener('input', () => {
        const isAdmin = window.currentUser.role === 'admin' || window.currentUser.role === 'super_admin';
        const cats = catInput.value.split(',').map(c => c.trim()).filter(c => c);
        const blockedCat = !isAdmin && cats.find(c => adminCategories.includes(c));
        if (blockedCat) {
            catWarning.innerHTML = `<i class="mdi mdi-alert"></i> "${blockedCat}" 카테고리는 관리자만 적용할 수 있습니다.`;
            catWarning.classList.remove('d-none');
        } else {
            catWarning.classList.add('d-none');
        }
        // 카테고리 추가/삭제 시 편집 요약 자동 갱신 (renderCategoryTags에서 input 이벤트가 디스패치된다)
        // 블로그 모드는 edit-summary.js 를 로드하지 않으므로 typeof 가드.
        if (typeof window.refreshAutoSummary === 'function') window.refreshAutoSummary();
    });

    // 넘겨주기(redirect) 변경 시 편집 요약 자동 갱신
    // input: 매 키 입력마다 디바운스로 갱신 (입력 중간 prefix 가 길어졌다 짧아졌다 반복하는 것 완화)
    // change: blur 직후 즉시 확정
    const redirectInputEl = document.getElementById('redirectInput');
    if (redirectInputEl) {
        let redirectDebounce = null;
        redirectInputEl.addEventListener('input', () => {
            clearTimeout(redirectDebounce);
            redirectDebounce = setTimeout(window.refreshAutoSummary, 300);
        });
        redirectInputEl.addEventListener('change', () => {
            clearTimeout(redirectDebounce);
            window.refreshAutoSummary();
        });
    }

    // 대체 제목 변경 시 편집 요약 자동 갱신 — 본문/메타 변경이 전혀 없이 대체 제목만
    // 수정하는 경우에도 자동 요약 prefix 가 채워져 저장이 가능하도록 한다.
    const altTitleInputEl = document.getElementById('alternateTitleInput');
    if (altTitleInputEl) {
        let altTitleDebounce = null;
        altTitleInputEl.addEventListener('input', () => {
            clearTimeout(altTitleDebounce);
            altTitleDebounce = setTimeout(window.refreshAutoSummary, 300);
        });
        altTitleInputEl.addEventListener('change', () => {
            clearTimeout(altTitleDebounce);
            window.refreshAutoSummary();
        });
    }
    // 기존 문서 불러오기 (블로그 모드는 별도 처리)
    if (BLOG_MODE) {
        await loadBlogContentForEdit();
        return;
    }

    try {
        const res = await fetch(`/api/w/${encodeURIComponent(slug)}?redirect=no&nocache=true`);

        if (res.status === 410) {
            // 로딩 오버레이 먼저 숨김
            const overlay = document.getElementById('initLoadingOverlay');
            if (overlay) {
                overlay.classList.add('hidden');
                overlay.style.display = 'none';
            }
            window.Swal.fire({
                icon: 'error',
                title: '삭제된 문서',
                text: '삭제된 문서는 열람하거나 편집할 수 없습니다.',
                confirmButtonText: '홈으로'
            }).then(() => {
                window.location.href = '/';
            });
            return;
        }

        // 비공개 문서: 권한 없는 사용자는 편집 불가
        if (res.status === 403) {
            const overlay = document.getElementById('initLoadingOverlay');
            if (overlay) {
                overlay.classList.add('hidden');
                overlay.style.display = 'none';
            }
            let errMsg = '비공개 문서는 열람하거나 편집할 수 없습니다.';
            try {
                const data = await res.json();
                if (data && data.error) errMsg = data.error;
            } catch (_e) { /* noop */ }
            window.Swal.fire({
                icon: 'error',
                title: '비공개 문서',
                text: errMsg,
                confirmButtonText: '홈으로'
            }).then(() => {
                window.location.href = '/';
            });
            return;
        }

        if (res.ok) {
            const page = await res.json();
            document.getElementById('titleInput').value = page.slug;
            // 대체 제목 — page.title 은 NULL 일 수 있음. 빈 문자열로 표시.
            const altTitleEl = document.getElementById('alternateTitleInput') as HTMLInputElement | null;
            if (altTitleEl) altTitleEl.value = page.title || '';

            // 섹션 모드에서는 서버가 보낸 메타데이터를 그대로 유지해 저장 시 함께 송신.
            // window.renderCategoryTags()가 input 이벤트를 디스패치해 자동 편집 요약을 갱신하기 전에
            // 베이스라인을 먼저 확정해야 카테고리 변경이 없는데도 '문서 생성'이 표시되는
            // 깜빡임을 방지할 수 있다.
            originalPageMeta = {
                slug: page.slug,
                title: page.title || '',
                category: page.category || '',
                redirect_to: page.redirect_to || '',
                is_private: page.is_private ? 1 : 0,
                view_mode: page.view_mode === 'presentation' ? 'presentation' : ''
            };

            // 프레젠테이션 모드 체크박스 초기화 (모든 편집자, 기존 문서). 현재 view_mode 가
            // 'presentation' 이면 체크 상태로 표시. 즉시 적용하지 않고 문서 저장 시 PUT 으로 반영된다.
            initPresentationModeToggle(page.view_mode === 'presentation');

            {
                categoryTags = (page.category || '').split(',').map(c => c.trim()).filter(c => c);
                // 카테고리 문서(카테고리:이름)는 해당 카테고리를 항상 포함
                const _autoSlugCat = (() => {
                    if (!slug?.startsWith('카테고리:')) return null;
                    const n = slug.slice('카테고리:'.length).trim();
                    return (n && /^[가-힣a-zA-Z0-9\s]+$/.test(n)) ? n : null;
                })();
                if (_autoSlugCat && !categoryTags.includes(_autoSlugCat)) {
                    categoryTags.unshift(_autoSlugCat);
                }
                if (categoryTags.length > 0) {
                    document.getElementById('categoryInput').value = categoryTags.join(',');
                    syncStateToWindow();
                    window.renderCategoryTags();
                }
            }
            if (page.redirect_to) document.getElementById('redirectInput').value = page.redirect_to;

            let initialContent = page.content || '';
            if (!isExtensionData) {
                if (!initialContent.endsWith('\n')) {
                    initialContent += '\n\n';
                } else if (!initialContent.endsWith('\n\n')) {
                    initialContent += '\n';
                }
            }

            // 섹션 편집 모드: 해당 섹션 텍스트만 에디터에 로드
            // (익스텐션 데이터 문서는 섹션 모드 비활성)
            let useSectionMode = false;
            if (sectionMode && !isExtensionData) {
                const range = window.findSectionRange(initialContent, sectionIndex, sectionHeadingParam);
                if (range) {
                    useSectionMode = true;
                    fullOriginalContent = initialContent;
                    sectionRange = range;
                    const lines = initialContent.split('\n');
                    const sectionText = lines.slice(range.lineIdx, range.endLine).join('\n');
                    originalContent = sectionText;
                    editor.setMarkdown(sectionText);
                    scrollPreviewToBottom();

                    // 섹션 모드 UI
                    const banner = document.getElementById('sectionEditBanner');
                    const headingEl = document.getElementById('sectionEditHeading');
                    const fullLink = document.getElementById('sectionEditFullLink');
                    if (banner && headingEl) {
                        headingEl.textContent = range.headingText;
                        banner.classList.remove('d-none');
                        banner.classList.add('d-flex');
                    }
                    if (fullLink) {
                        fullLink.href = '/edit?slug=' + encodeURIComponent(slug);
                    }
                    // 섹션 모드에서 수정 불가한 필드 숨김 (슬러그/대체 제목/카테고리/리다이렉트/프레젠테이션 모드)
                    const lockedContainers = [
                        document.getElementById('titleInput'),
                        document.getElementById('alternateTitleInput'),
                        document.getElementById('categoryInput'),
                        document.getElementById('redirectInput')
                    ];
                    lockedContainers.forEach(el => {
                        if (el) {
                            const wrapper = el.closest('.mb-3') || el.closest('.row');
                            if (wrapper) wrapper.style.display = 'none';
                        }
                    });
                    // 프레젠테이션 체크박스는 자체 .mb-3 컨테이너를 직접 숨긴다.
                    const presoSetting = document.getElementById('presentationModeSetting');
                    if (presoSetting) presoSetting.style.display = 'none';
                } else {
                    // 섹션을 찾지 못하면 전체 편집으로 자동 fallback
                    sectionMode = false;
                    sectionIndex = -1;
                    DRAFT_KEY = 'wiki_draft_' + slug;
                    if (typeof window.Swal !== 'undefined') {
                        window.Swal.fire({
                            icon: 'warning',
                            title: '섹션을 찾지 못했습니다',
                            text: '문서 구조가 변경되어 전체 편집 모드로 전환합니다.',
                            timer: 2500,
                            showConfirmButton: false
                        });
                    }
                }
            }

            if (!useSectionMode) {
                originalContent = initialContent;
                editor.setMarkdown(initialContent);
                scrollPreviewToBottom();
            }

            // 본문 적재 직후, 프레젠테이션 문서 + 일반(split) 모드면 통합 단일 슬라이드 편집으로
            // 진입한다(이 시점의 에디터 전체 본문이 분할 기준). _onPresentationModeToggled 가
            // 비프레젠테이션/섹션 문서에서는 enter 를 건너뛴다. (콘텐츠 로드와 초기 setTimeout
            // 프리뷰 사이의 경합과 무관하게 결정적으로 진입시키는 경로.)
            if (getPresentationLayoutValue() === 'presentation'
                && typeof window._onPresentationModeToggled === 'function') {
                window._onPresentationModeToggled();
            }

            pageVersion = page.version;
            document.getElementById('editPageTitle').innerHTML =
                useSectionMode
                    ? `<i class="mdi mdi-pencil-box-multiple"></i> 섹션 편집: ${escapeHtml(page.slug)}`
                    : pendingMcpSubmissionId
                        ? `<i class="mdi mdi-robot-outline"></i> MCP 편집안 편집: ${escapeHtml(page.slug)}`
                        : pendingEditRequestId
                            ? `<i class="mdi mdi-account-check-outline"></i> 편집 요청 검토: ${escapeHtml(page.slug)}`
                            : `<i class="mdi mdi-pencil-box-multiple"></i> 편집: ${escapeHtml(page.slug)}`;
            document.title = `편집: ${page.slug} - ${window.appConfig.wikiName}`;
            // 변경 사항 미리보기 토글: 기존 문서 편집일 때만 노출.
            // 익스텐션 데이터는 프리뷰 패널 자체가 없으므로(원시 textarea 편집) 숨긴다.
            {
                const _diffSection = document.getElementById('diffPreviewSection');
                if (_diffSection) _diffSection.style.display = isExtensionData ? 'none' : 'block';
            }

            // MCP 편집안 적재 모드: 페이지의 정상 본문 로드를 마쳤지만, 본문을 제출안으로
            // 덮어쓴다. 동시 편집 충돌이 있으면 추가로 3-way merge 모달까지 띄운다.
            // (정상 로드를 끝까지 거치는 이유: 카테고리 입력/잠금/리다이렉트/UI 초기화 등
            //  편집기 부트스트랩이 page 데이터에 의존하기 때문. 본문 / pageVersion 만 교체.)
            // checkDraft / refreshAutoSummary 의 일반 흐름은 건너뛴다 — 본문은 이미 제출안으로
            // 세팅되며 로컬 초안 복구 프롬프트가 함께 떠선 안 된다.
            if (pendingMcpSubmissionId) {
                let mcpLoaded = false;
                try {
                    // loaded === true 인 경우에만 제출안이 정상 적재되어 사용자가 저장 시 /resolve
                    // cleanup 을 트리거해야 한다. false 는 거부 분기(슬러그 불일치/처리 불가 충돌) 로
                    // redirect 안내만 띄운 상태이므로 cleanup 게이트를 켜면 안 된다 (navigation 이
                    // 끝나기 전 저장이 트리거되면 무관한 draft 가 silently 삭제될 위험).
                    const loaded = await loadMcpSubmissionIntoEditor(pendingMcpSubmissionId);
                    if (loaded) {
                        mcpSubmissionId = pendingMcpSubmissionId;
                        mcpLoaded = true;
                    }
                } catch (e: any) {
                    // 제출안 preload 실패: 정상 편집 세션으로 진행하되 cleanup 게이트는 끈 채로 둔다
                    // (mcpSubmissionId 가 set 되지 않은 상태이므로 저장 후 /resolve 호출 없음).
                    // 그렇지 않으면 사용자가 일반 편집을 마치고 저장했을 때 cleanup 경로가 무관한
                    // draft 를 silently 삭제할 위험이 있다.
                    window.Swal.fire('오류', e?.message || 'MCP 편집안을 불러오지 못했습니다.', 'error');
                }
                // 제출안 적재가 실패한 경우 (preload 실패 등) 정상 편집 세션으로 fallback. 이때
                // checkDraft() 가 한번도 실행되지 않으면 같은 슬러그의 로컬 초안은 사용자에게
                // 노출되지 않고 다음 저장 시 silent 삭제된다 — 일반 분기와 동일한 draft 복구 흐름을
                // 돌려 사용자가 미저장 초안을 인지/복구할 기회를 보장한다.
                if (!mcpLoaded) {
                    window.checkDraft().then(() => {
                        syncStateFromWindow();
                        if (!sectionMode && typeof window.checkSectionDrafts === 'function') {
                            window.checkSectionDrafts();
                        }
                    });
                }
                syncStateToWindow();
                window.refreshAutoSummary();
            } else if (pendingEditRequestId) {
                // 편집 요청 적재 모드(update): MCP 적재와 동일하게 본문/메타만 요청값으로 교체하고
                // 충돌이면 3-way merge 모달을 띄운다. 적재 성공 시에만 editRequestId 를 켜
                // 저장 시 approve(content) 경로로 분기한다(잘못된 요청의 silent 승인 방지).
                let erLoaded = false;
                try {
                    const loaded = await loadEditRequestIntoEditor(pendingEditRequestId);
                    if (loaded) {
                        editRequestId = pendingEditRequestId;
                        erLoaded = true;
                    }
                } catch (e: any) {
                    window.Swal.fire('오류', e?.message || '편집 요청을 불러오지 못했습니다.', 'error');
                }
                if (!erLoaded) {
                    window.checkDraft().then(() => {
                        syncStateFromWindow();
                        if (!sectionMode && typeof window.checkSectionDrafts === 'function') {
                            window.checkSectionDrafts();
                        }
                    });
                }
                syncStateToWindow();
                window.refreshAutoSummary();
            } else {
            // 전체 편집 모드일 때만 같은 슬러그의 섹션 초안 잔여분을 추가로 안내한다.
            // (섹션 모드에서는 window.checkDraft 가 자체 초안을 처리한다.)
            window.checkDraft().then(() => {
                // checkDraft 가 section→full-edit promotion 을 수행했을 수 있으므로
                // 로컬 변수를 window 상태에서 다시 끌어와 동기화한다. 그렇지 않으면
                // savePage 가 stale 한 sectionMode/sectionRange 를 사용해 editor 의
                // 본문(이미 full doc) 을 다시 mergeSectionIntoFull 로 감싸 본문이 손상된다.
                syncStateFromWindow();
                // promotion 으로 useSectionMode 가 사실상 무효화된 경우에도 같은 슬러그의
                // 다른 섹션 초안이 남아 있을 수 있으므로 현재 sectionMode 상태를 다시 본다.
                if (!sectionMode && typeof window.checkSectionDrafts === 'function') {
                    window.checkSectionDrafts();
                }
            });
            // 기존 문서 로드 완료 — 로컬 originalContent / originalPageMeta /
            // pageVersion / sectionRange / fullOriginalContent 를 window.* 로 미러링.
            // (summary.ts 는 window.originalPageMeta 로 신규/기존 문서를 분기하고,
            //  conflict.ts 의 buildLocalDiffHtml 은 window.originalContent 를 base 로
            //  사용하므로, 동기화가 빠지면 미수정 상태가 '문서 생성' / 전체 신규로
            //  잘못 표시된다.)
            syncStateToWindow();
            // 기존 문서: 카테고리/잠금 변경 시 자동 요약이 입력되도록 초기 상태 동기화
            window.refreshAutoSummary();
            } // ── mcpSubmissionId else 블록 종료 ──
        } else {
            // 새 문서: 슬러그가 곧 제목이므로 readonly 필드를 슬러그로 채운다
            syncStateToWindow();
            originalContent = '';
            document.getElementById('titleInput').value = decodeURIComponent(slug);

            // 카테고리 문서(카테고리:이름)는 신규 생성 시에도 해당 카테고리를 미리 주입
            if (slug?.startsWith('카테고리:')) {
                const _autoNewCat = slug.slice('카테고리:'.length).trim();
                if (_autoNewCat && /^[가-힣a-zA-Z0-9\s]+$/.test(_autoNewCat) && !categoryTags.includes(_autoNewCat)) {
                    categoryTags.unshift(_autoNewCat);
                    document.getElementById('categoryInput').value = categoryTags.join(',');
                    syncStateToWindow();
                    window.renderCategoryTags?.();
                }
            }

            // MCP 편집안(create 액션) 적재 모드: 신규 문서 UI 골격은 그대로 두고 본문/메타만
            // 제출안으로 채운다. 적재 성공 시 mcpSubmissionId 를 켜 저장 후 /resolve cleanup 트리거.
            if (pendingMcpSubmissionId) {
                let mcpLoaded = false;
                try {
                    const loaded = await loadMcpSubmissionIntoEditor(pendingMcpSubmissionId);
                    if (loaded) {
                        mcpSubmissionId = pendingMcpSubmissionId;
                        mcpLoaded = true;
                    }
                } catch (e: any) {
                    window.Swal.fire('오류', e?.message || 'MCP 편집안을 불러오지 못했습니다.', 'error');
                }
                document.getElementById('editPageTitle').innerHTML = mcpLoaded
                    ? `<i class="mdi mdi-robot-outline"></i> MCP 편집안 편집(신규): ${escapeHtml(slug)}`
                    : `<i class="mdi mdi-plus-circle"></i> 새 문서 만들기`;
                document.title = mcpLoaded
                    ? `MCP 편집: ${slug} - ${window.appConfig.wikiName}`
                    : `새 문서 - ${window.appConfig.wikiName}`;
                if (!mcpLoaded) {
                    // 적재 실패 시에는 일반 신규 문서 흐름으로 fallback (템플릿 버튼 + 초안 복구).
                    const templateBtn = document.createElement('button');
                    templateBtn.className = 'btn btn-sm btn-outline-primary ms-3';
                    templateBtn.innerHTML = '<i class="mdi mdi-content-copy"></i> 템플릿으로 시작하기';
                    templateBtn.onclick = window.openTemplateModal;
                    document.getElementById('editPageTitle').appendChild(templateBtn);
                    window.checkDraft();
                }
                syncStateToWindow();
                window.refreshAutoSummary();
            } else if (pendingEditRequestId) {
                // 편집 요청 적재 모드(create): 신규 문서 골격은 유지하고 본문/메타만 요청값으로 채운다.
                let erLoaded = false;
                try {
                    const loaded = await loadEditRequestIntoEditor(pendingEditRequestId);
                    if (loaded) {
                        editRequestId = pendingEditRequestId;
                        erLoaded = true;
                    }
                } catch (e: any) {
                    window.Swal.fire('오류', e?.message || '편집 요청을 불러오지 못했습니다.', 'error');
                }
                document.getElementById('editPageTitle').innerHTML = erLoaded
                    ? `<i class="mdi mdi-account-check-outline"></i> 편집 요청 검토(신규): ${escapeHtml(slug)}`
                    : `<i class="mdi mdi-plus-circle"></i> 새 문서 만들기`;
                document.title = erLoaded
                    ? `편집 요청 검토: ${slug} - ${window.appConfig.wikiName}`
                    : `새 문서 - ${window.appConfig.wikiName}`;
                if (!erLoaded) {
                    const templateBtn = document.createElement('button');
                    templateBtn.className = 'btn btn-sm btn-outline-primary ms-3';
                    templateBtn.innerHTML = '<i class="mdi mdi-content-copy"></i> 템플릿으로 시작하기';
                    templateBtn.onclick = window.openTemplateModal;
                    document.getElementById('editPageTitle').appendChild(templateBtn);
                    window.checkDraft();
                }
                syncStateToWindow();
                window.refreshAutoSummary();
            } else {
                document.getElementById('editPageTitle').innerHTML =
                    `<i class="mdi mdi-plus-circle"></i> 새 문서 만들기`;
                document.title = `새 문서 - ${window.appConfig.wikiName}`;

                // 템플릿 불러오기 버튼 추가
                const templateBtn = document.createElement('button');
                templateBtn.className = 'btn btn-sm btn-outline-primary ms-3';
                templateBtn.innerHTML = '<i class="mdi mdi-content-copy"></i> 템플릿으로 시작하기';
                templateBtn.onclick = window.openTemplateModal;
                document.getElementById('editPageTitle').appendChild(templateBtn);
                window.checkDraft();
                // 새 문서: 편집 요약을 '문서 생성'으로 자동 채움
                window.refreshAutoSummary();
            }
        }
    } catch (e) {
        // 새 문서로 취급
        syncStateToWindow();
        originalContent = '';
        window.refreshAutoSummary();
    }

    // 변경 사항 미리보기 모드 토글 (체크박스 2개)
    //  - "변경사항 미리 보기"  : 프리뷰 패널을 텍스트 diff 로 표시
    //  - "렌더링 미리 보기"    : (상위 토글에 종속) 렌더 결과 diff 로 표시
    // 실시간 재렌더는 에디터 change 핸들러(updateCustomPreview)가 diff 모드를 인식해 담당한다.
    const diffToggle = document.getElementById('diffPreviewToggle');
    const diffRenderedToggle = document.getElementById('diffPreviewRenderedToggle');
    const diffRenderedRow = document.getElementById('diffPreviewRenderedRow');

    function syncDiffRenderedAvailability() {
        if (!diffRenderedToggle) return;
        const enabled = !!(diffToggle && diffToggle.checked);
        diffRenderedToggle.disabled = !enabled;
        if (diffRenderedRow) diffRenderedRow.classList.toggle('is-disabled', !enabled);
        // 상위 토글이 꺼지면 종속 토글도 강제 해제(단독 활성 불가)
        if (!enabled && diffRenderedToggle.checked) diffRenderedToggle.checked = false;
    }

    if (diffToggle) {
        diffToggle.addEventListener('change', () => {
            syncDiffRenderedAvailability();
            updateCustomPreview();
        });
    }
    if (diffRenderedToggle) {
        diffRenderedToggle.addEventListener('change', () => {
            if (diffRenderedToggle.disabled) { diffRenderedToggle.checked = false; return; }
            updateCustomPreview();
        });
    }
    syncDiffRenderedAvailability();

    // 본문 헤딩(목차) 변화 실시간 감지 → 자동 편집 요약 갱신.
    // 별도 디바운스로 미리보기/diff 와 독립 동작하며, 헤딩 추가/삭제/이름변경 시
    // window.refreshAutoSummary 가 새 prefix 를 합성한다.
    if (editor && typeof editor.on === 'function') {
        let summaryDebounce = null;
        editor.on('change', () => {
            // 프로그램적 슬라이드 스왑 중에는 자동 요약 재계산을 건너뛴다(전체 문서 불변).
            if (slideCtl.suppressChange) return;
            clearTimeout(summaryDebounce);
            summaryDebounce = setTimeout(() => {
                if (typeof window.refreshAutoSummary === 'function') window.refreshAutoSummary();
            }, 400);
        });
    }

    // 동시편집 감지: 하트비트 전송 + 편집자 체크 시작
    window.startEditingHeartbeat();
    window.checkConcurrentEditors();

    // 미저장 변경사항 이탈 경고
    window.addEventListener('beforeunload', (e) => {
        if (pageLeft || !editor) return;
        if (editor.getMarkdown() !== originalContent) {
            e.preventDefault();
            e.returnValue = '';
        }
    });

    // Ctrl/Cmd+S 단축키로 저장 (브라우저 기본 저장 다이얼로그 차단)
    window.addEventListener('keydown', (e) => {
        const isSaveShortcutKey = e.code === 'KeyS' || e.key?.toLowerCase() === 's';
        if (!isSaveShortcutKey || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
        e.preventDefault();
        // 충돌 해결 UI 표시 중에는 저장을 트리거하지 않는다 — 병합 전 본문이
        // 새 pageVersion 으로 그대로 제출되는 것을 방지한다.
        const conflictUi = document.getElementById('conflict-ui');
        if (conflictUi && conflictUi.offsetParent !== null) return;
        const saveBtn = document.getElementById('saveBtn');
        // Turnstile 미검증 사유로 비활성된 경우에는 단축키도 모달을 띄울 수 있어야 하므로
        // 검증은 savePage 내부의 ensureTurnstileVerified 에 위임한다. 다만
        // saveBtn.disabled 가 다른 안전 가드(예: section-mode 409 fallback 의 metadata
        // 재조회 실패로 blockResave 가 set 되어 finally 가 의도적으로 disable 을 유지한
        // 경우)인 경우에는 단축키 저장도 차단해야 한다. Turnstile 미검증 케이스는
        // turnstileSiteKey 설정 + 토큰 부재로 판별해 disabled 여부와 무관하게 통과시킨다.
        const turnstileNeedsVerify = !!(window.appConfig && window.appConfig.turnstileSiteKey && !turnstileToken);
        if (e.repeat || saveInProgress) return;
        if (saveBtn?.disabled && !turnstileNeedsVerify) return;
        savePage();
    }, true);

    // 로딩 오버레이 숨기기
    const overlay = document.getElementById('initLoadingOverlay');
    if (overlay) {
        overlay.classList.add('hidden');
        // 트랜지션 완료 후 DOM에서 완전히 숨김 처리
        setTimeout(() => {
            overlay.style.display = 'none';
        }, 300);
    }
});

// 자동 편집 요약(buildAutoEditSummary / window.refreshAutoSummary)은 edit-summary.js 로 분리됨.

// ── 변경 사항 검증 (프론트 전용) ──
// 본문이 바뀌지 않았어도 카테고리/리다이렉트/관리자 잠금이 변경되었다면 저장을 허용한다.
// 신규 문서(originalPageMeta 미설정)에서는 기본값(빈 카테고리/리다이렉트, 잠금 해제) 대비
// 메타데이터 입력 여부로 판단 — 본문 없이 리다이렉트만 설정해 새 문서를 만드는 용례 지원.
// ── MCP 편집안 에디터 적재: 제출안을 에디터에 불러와 (필요시) 3-way merge 모달까지 띄우기 ──
//
// 호출 시점:
//   - update 액션: 정상 페이지 로드(/api/w/:slug)가 끝난 직후 DOMContentLoaded 핸들러 안.
//   - create 액션: GET /api/w/:slug 가 404 로 떨어진 신규 문서 분기 안.
// 사전조건: editor 가 마운트되어 setMarkdown 가능 상태, (update 분기) originalContent / pageVersion 가
//          이 모듈 / window 양쪽에 미러링되어 있음.
//
// 수행:
//   1) /api/mcp-submissions/:id 에서 base_content / proposed_content / current_content + 메타 fetch.
//   2) 처리 불가 충돌은 에디터에서 다룰 수 없음 — 안내 후 mypage 로 돌려보낸다.
//        - page_missing: 페이지가 삭제됨
//        - slug_taken / slug_soft_deleted: create 액션인데 같은 슬러그가 점거됨
//   3) 카테고리/리다이렉트/잠금/제목/요약 입력란을 제출안 메타로 채운다 (있는 값만).
//   4) editor.setMarkdown(proposed_content) 로 본문을 제출안으로 적재.
//   5) concurrent_modification 충돌 분기:
//        - originalContent = base_content, pageVersion = current_version 으로 세팅
//        - window.showConflictModal 로 3-way merge UI 띄움
//      그 외 (충돌 없음) 분기:
//        - update: originalContent = current_content 유지 (페이지 로드값 그대로)
//        - 사용자는 그대로 저장하거나 추가 편집 후 저장 → 정상 PUT /api/w/:slug → /resolve cleanup
//
// 반환값: 에디터에 정상 적재되었으면 true, 거부 분기(슬러그 불일치/처리 불가 충돌)로 안내 후
// mypage 로 redirect 한 경우 false. 호출자는 true 인 경우에만 cleanup 게이트 (mcpSubmissionId)
// 를 켠다 — false 인 분기에서 set 하면 navigation 이 비동기라 그 사이 사용자가 저장을 트리거할
// 경우 무관한 draft 가 /resolve 로 silently 삭제될 수 있다.
async function loadMcpSubmissionIntoEditor(submissionId: number): Promise<boolean> {
    const res = await fetch(`/api/mcp-submissions/${submissionId}`);
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `제출안 조회 실패 (HTTP ${res.status})`);
    }
    const detail = await res.json();

    // 슬러그 정합성 검증: URL 의 slug 와 제출안의 slug 가 일치해야 한다.
    // 사용자가 URL 을 임의 조작해 slug=A&mcp_submission=<B의 id> 로 진입하면
    // A 페이지 에디터에 B 제출안 본문이 적용된 채 저장 시 A 가 B 의 본문으로 덮어쓰일 위험이 있다.
    // 양쪽 모두 서버에서 normalizeSlug 된 값이므로 정확 비교만으로 충분하다.
    if (typeof detail.slug !== 'string' || detail.slug !== slug) {
        await window.Swal.fire({
            icon: 'error',
            title: '제출안 제목 불일치',
            text: `제출안의 문서(${detail.slug ?? '?'}) 가 현재 편집 중인 문서(${slug ?? '?'}) 와 다릅니다. 해당 문서로 이동해 다시 시도하세요.`,
        });
        window.location.href = '/mypage#mcp-submissions';
        return false;
    }

    // 에디터에서 처리 불가한 충돌은 거부. 충돌이 없는 경우와 동시 편집 충돌은 아래에서 분기 처리.
    if (detail.has_conflict && detail.conflict_reason !== 'concurrent_modification') {
        await window.Swal.fire({
            icon: 'warning',
            title: '에디터에서 처리할 수 없는 충돌',
            text: detail.conflict_reason === 'page_missing'
                ? '문서가 삭제되었습니다. 에디터에서 편집할 수 없습니다.'
                : detail.conflict_reason === 'slug_taken'
                    ? '동일 제목의 다른 문서가 그 사이 생성되었습니다. mypage 에서 거부하거나 다른 제목으로 다시 시도하세요.'
                    : detail.conflict_reason === 'slug_soft_deleted'
                        ? '동일 제목의 소프트 삭제된 문서가 존재합니다. 관리자가 먼저 처리해야 합니다.'
                        : '에디터에서 해결할 수 없는 충돌입니다.',
        });
        window.location.href = '/mypage#mcp-submissions';
        return false;
    }

    // 카테고리/리다이렉트는 제출안 값을 적용 (있는 경우만; null 이면 페이지의 기존 값 유지).
    if (typeof detail.category === 'string') {
        const catInputEl = document.getElementById('categoryInput') as HTMLInputElement | null;
        if (catInputEl) {
            catInputEl.value = detail.category;
            categoryTags = detail.category.split(',').map((c: string) => c.trim()).filter((c: string) => c);
            syncStateToWindow();
            if (typeof window.renderCategoryTags === 'function') window.renderCategoryTags();
        }
    }
    if (typeof detail.redirect_to === 'string') {
        const redirEl = document.getElementById('redirectInput') as HTMLInputElement | null;
        if (redirEl) redirEl.value = detail.redirect_to;
    }
    // 대체 제목 변경을 요청한 제출안이면 대체 제목 입력란도 미리 채워둔다.
    if (detail.action === 'update' && detail.has_title_change && typeof detail.title === 'string') {
        const altTitleEl = document.getElementById('alternateTitleInput') as HTMLInputElement | null;
        if (altTitleEl) altTitleEl.value = detail.title;
    }
    // 요약 입력칸에 제출 시 AI 가 작성한 요약을 미리 채워준다.
    // edit.html 의 편집 요약 입력 id 는 'summaryInput' (summary.ts 도 동일 id 를 갱신).
    if (typeof detail.submitted_summary === 'string' && detail.submitted_summary) {
        const sumEl = document.getElementById('summaryInput') as HTMLInputElement | null;
        if (sumEl && !sumEl.value) sumEl.value = detail.submitted_summary;
    }

    // base = base_revision_id 시점의 본문. 충돌이 없으면 base==current 이지만, 그 경우 모달이
    // 충돌 hunk 0개로 떠도 동작은 정상(사용자가 그대로 적용 가능).
    const baseContent: string = typeof detail.base_content === 'string' ? detail.base_content : '';
    const proposedContent: string = typeof detail.proposed_content === 'string' ? detail.proposed_content : '';
    const currentContent: string = typeof detail.current_content === 'string' ? detail.current_content : '';
    const isConflictMerge = detail.has_conflict && detail.conflict_reason === 'concurrent_modification';

    // 같은 슬러그에 사용자의 로컬 초안(checkDraft 가 보통 띄울 prompt 대상)이 남아 있으면,
    // MCP 적재 모드는 그것을 건너뛰고 에디터를 제출안 본문으로 덮어쓴다 — 저장 성공 시
    // DRAFT_KEY 가 제거되어 그 로컬 초안이 silent 손실된다. 손실 방지를 위해 백업 키로
    // 옮겨두고 사용자에게 안내한다 (사용자는 mypage 나 콘솔에서 키를 확인해 복구 가능).
    if (DRAFT_KEY) {
        try {
            const existing = localStorage.getItem(DRAFT_KEY);
            if (existing !== null) {
                const backupKey = `${DRAFT_KEY}__pre_mcp_${submissionId}`;
                localStorage.setItem(backupKey, existing);
                localStorage.removeItem(DRAFT_KEY);
                window.Swal?.fire({
                    icon: 'info',
                    title: '기존 로컬 초안을 백업했습니다',
                    html: `같은 문서에 작성 중이던 로컬 초안이 있어 MCP 편집안 적재 전에 보존했습니다.<br>저장 후에도 다음 키로 localStorage 에서 복구할 수 있습니다:<br><code>${escapeHtml(backupKey)}</code>`,
                    toast: false,
                    confirmButtonText: '확인',
                });
            }
        } catch { /* localStorage 비활성 등은 무시 */ }
    }

    if (editor) editor.setMarkdown(proposedContent);

    if (isConflictMerge) {
        // 동시 편집 충돌 — base/ours/theirs 3-way merge UI 로 진입.
        // originalContent = base 시점 본문 (충돌 모달이 window.originalContent 를 base 로 사용).
        // 충돌 모달은 window.pageVersion 을 current_version 으로 갱신하지만, 본 모듈은 모듈 로컬
        // `pageVersion` 을 사용해 savePage 의 expected_version 을 송신한다. resolveConflict 직후
        // 사용자가 저장하면 stale 한 base_version 이 보내져 다시 409 가 나므로, 충돌 모달 호출 전에
        // 로컬값도 미리 갱신한다 — 일반 동시편집 충돌 경로와 동일한 패턴.
        originalContent = baseContent;
        if (detail.current_version != null) {
            pageVersion = detail.current_version;
        } else {
            pageVersion = detail.base_version ?? pageVersion;
        }
        syncStateToWindow();
        // 충돌 모달 트리거 — window.pageVersion 은 모달이 한 번 더 current_version 으로 세팅한다.
        if (typeof window.showConflictModal === 'function') {
            window.showConflictModal({
                current_version: detail.current_version,
                content: currentContent,
            });
        }
        return true;
    }

    // 충돌 없음 — 사용자가 제출안 본문을 그대로 (또는 수정 후) 저장.
    // update 액션: originalContent 는 페이지 로드 시점의 현재 본문 유지 (호출자가 이미 세팅).
    //              저장 시 PUT /api/w/:slug 가 통상 흐름으로 새 리비전 생성 → /resolve cleanup.
    // create 액션: 호출자(신규 문서 분기)가 originalContent='' 로 세팅. 저장 시 신규 페이지 생성.
    //   pageVersion = 0 은 PUT /api/w/:slug 의 "신규 생성 전용" 시멘틱 — 같은 슬러그의 페이지가
    //   preload~save 사이에 생성되면 서버가 409 로 거부한다. /approve 경로가 가진 slug_taken
    //   재검증을 대체하기 위함이며, 설정하지 않으면 expected_version 이 빠져 다른 사용자가
    //   먼저 만든 페이지를 silent 하게 덮어쓸 위험이 있다.
    if (detail.action === 'create') {
        pageVersion = 0;
    }
    syncStateToWindow();
    return true;
}

// 편집 요청(pending-edits)을 에디터에 적재. loadMcpSubmissionIntoEditor 와 동일 구조지만 소스가
// /api/pending-edits/:id 이고(요약 필드는 summary), 거부 분기에서 문서 열람 페이지로 돌려보낸다.
// 반환 true 면 정상 적재 → 호출자가 editRequestId 게이트를 켜고 저장 시 approve(content) 로 분기한다.
async function loadEditRequestIntoEditor(requestId: number): Promise<boolean> {
    const res = await fetch(`/api/pending-edits/${requestId}`);
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `편집 요청 조회 실패 (HTTP ${res.status})`);
    }
    const detail = await res.json();

    // 슬러그 정합성 검증 — URL 조작으로 다른 문서의 요청 본문이 적용/덮어쓰이는 것을 방지.
    if (typeof detail.slug !== 'string' || detail.slug !== slug) {
        await window.Swal.fire({
            icon: 'error',
            title: '문서 불일치',
            text: `편집 요청의 문서(${detail.slug ?? '?'}) 가 현재 편집 중인 문서(${slug ?? '?'}) 와 다릅니다.`,
        });
        window.location.href = '/w/' + encodeURIComponent(slug);
        return false;
    }

    // 에디터에서 처리 불가한 충돌(문서 삭제/슬러그 점거 등)은 거부. 동시 편집 충돌만 아래에서 머지.
    if (detail.has_conflict && detail.conflict_reason !== 'concurrent_modification') {
        await window.Swal.fire({
            icon: 'warning',
            title: '에디터에서 처리할 수 없는 충돌',
            text: detail.conflict_reason === 'page_missing'
                ? '문서가 삭제되었습니다. 요청을 반려하세요.'
                : detail.conflict_reason === 'slug_taken'
                    ? '동일 제목의 다른 문서가 그 사이 생성되었습니다. 요청을 반려하세요.'
                    : detail.conflict_reason === 'slug_soft_deleted'
                        ? '동일 제목의 소프트 삭제된 문서가 존재합니다. 관리자가 먼저 처리해야 합니다.'
                        : '에디터에서 해결할 수 없는 충돌입니다.',
        });
        window.location.href = '/w/' + encodeURIComponent(slug);
        return false;
    }

    // 카테고리/리다이렉트는 요청 값으로 **항상** 덮어쓴다(null=요청이 비운 경우 빈 값으로). string 일 때만
    // 덮어쓰면, 요청이 기존 값을 비운 경우 에디터에 페이지의 옛 값이 남아 승인 시 rev2 가 그 값을 복원해
    // 요청자의 클리어가 사라진다.
    {
        const catInputEl = document.getElementById('categoryInput') as HTMLInputElement | null;
        if (catInputEl) {
            const catVal = (typeof detail.category === 'string') ? detail.category : '';
            catInputEl.value = catVal;
            categoryTags = catVal.split(',').map((c: string) => c.trim()).filter((c: string) => c);
            syncStateToWindow();
            if (typeof window.renderCategoryTags === 'function') window.renderCategoryTags();
        }
    }
    {
        const redirEl = document.getElementById('redirectInput') as HTMLInputElement | null;
        if (redirEl) redirEl.value = (typeof detail.redirect_to === 'string') ? detail.redirect_to : '';
    }
    // 요청이 대체 제목 변경을 제안했으면 입력칸을 그 값으로 프리로드(create/update 공통). 그래야 승인자가
    // 보는 값과 승인 시 rev2 에 반영되는 값이 일치한다(요청 제목을 페이지 기존 값으로 되돌리는 회귀 방지).
    // title=null(명시적 제목 제거)도 빈 문자열로 반영해, 페이지에 남아있던 기존 제목이 rev2 로 복원되지 않게 한다.
    if (detail.has_title_change) {
        const altTitleEl = document.getElementById('alternateTitleInput') as HTMLInputElement | null;
        if (altTitleEl) altTitleEl.value = (typeof detail.title === 'string') ? detail.title : '';
    }
    // 요청이 보기 모드(프레젠테이션) 변경을 제안했으면 토글을 그 값으로 맞춘다(apply_view=1 인 경우만;
    // 0 이면 페이지 현재 보기 모드 유지). change 이벤트를 발생시켜 슬라이드 프리뷰/자동요약을 동기화한다.
    if (detail.apply_view) {
        const cb = document.getElementById('presentationModeToggle') as HTMLInputElement | null;
        if (cb) {
            const want = detail.view_mode === 'presentation';
            if (cb.checked !== want) {
                cb.checked = want;
                cb.dispatchEvent(new Event('change'));
            }
        }
    }
    // 요청자가 작성한 편집 요약을 미리 채워 승인자가 그대로/수정해 저장하게 한다(요청 본문 요약 필드는 summary).
    if (typeof detail.summary === 'string' && detail.summary) {
        const sumEl = document.getElementById('summaryInput') as HTMLInputElement | null;
        if (sumEl && !sumEl.value) sumEl.value = detail.summary;
    }

    const baseContent: string = typeof detail.base_content === 'string' ? detail.base_content : '';
    const proposedContent: string = typeof detail.proposed_content === 'string' ? detail.proposed_content : '';
    const currentContent: string = typeof detail.current_content === 'string' ? detail.current_content : '';
    const isConflictMerge = detail.has_conflict && detail.conflict_reason === 'concurrent_modification';

    // 같은 슬러그의 로컬 초안이 있으면 적재 전에 백업 키로 보존(저장 시 DRAFT_KEY 가 제거되므로).
    if (DRAFT_KEY) {
        try {
            const existing = localStorage.getItem(DRAFT_KEY);
            if (existing !== null) {
                const backupKey = `${DRAFT_KEY}__pre_editreq_${requestId}`;
                localStorage.setItem(backupKey, existing);
                localStorage.removeItem(DRAFT_KEY);
                window.Swal?.fire({
                    icon: 'info',
                    title: '기존 로컬 초안을 백업했습니다',
                    html: `같은 문서에 작성 중이던 로컬 초안이 있어 편집 요청 적재 전에 보존했습니다.<br>다음 키로 localStorage 에서 복구할 수 있습니다:<br><code>${escapeHtml(backupKey)}</code>`,
                    confirmButtonText: '확인',
                });
            }
        } catch { /* localStorage 비활성 등은 무시 */ }
    }

    if (editor) editor.setMarkdown(proposedContent);

    if (isConflictMerge) {
        originalContent = baseContent;
        if (detail.current_version != null) {
            pageVersion = detail.current_version;
        } else {
            pageVersion = detail.base_version ?? pageVersion;
        }
        syncStateToWindow();
        if (typeof window.showConflictModal === 'function') {
            window.showConflictModal({
                current_version: detail.current_version,
                content: currentContent,
            });
        }
        return true;
    }

    // 충돌 없음. create 액션은 호출자가 originalContent='' 로 둔 상태. 저장은 approve(content) 가
    // 서버에서 2-리비전(요청자 rev1 + 승인자 rev2)으로 반영하며, expected_version 은 보내지 않는다
    // (approve 가 자체적으로 충돌/슬러그 재검증을 수행).
    syncStateToWindow();
    return true;
}

// ── 프레젠테이션 모드 체크박스 (에디터 문서 설정) ─────────────────────────────
// 모든 편집자에게 노출되는 체크박스. 즉시 적용하지 않고, 체크 상태를 문서 저장 시
// PUT /api/w/:slug 의 view_mode 로 함께 전송해 본문 리비전과 함께 반영한다.
// 변경 시 자동 편집 요약을 갱신해 "프레젠테이션 모드 설정/해제" 가 요약에 반영되게 한다.
function initPresentationModeToggle(active: boolean): void {
    const cb = document.getElementById('presentationModeToggle') as HTMLInputElement | null;
    if (!cb) return;
    cb.checked = active;
    cb.addEventListener('change', () => {
        if (typeof window.refreshAutoSummary === 'function') window.refreshAutoSummary();
        // 보기 방식 패널의 슬라이드 모드 노출 및 프리뷰 렌더 경로(덱/일반) 동기화.
        if (typeof window._onPresentationModeToggled === 'function') window._onPresentationModeToggled();
    });
}

// 현재 프레젠테이션 체크박스 상태를 view_mode 값('presentation' | '')으로 반환.
function getPresentationLayoutValue(): 'presentation' | '' {
    const cb = document.getElementById('presentationModeToggle') as HTMLInputElement | null;
    return cb && cb.checked ? 'presentation' : '';
}

function hasMeaningfulChanges() {
    const currentContent = editor ? editor.getMarkdown() : '';

    // 섹션 모드: 제목/카테고리/잠금/리다이렉트를 수정할 수 없으므로 본문(섹션 텍스트) 비교만 유효.
    if (sectionMode) {
        return currentContent !== originalContent;
    }

    if (currentContent !== originalContent) return true;

    // 신규 문서(originalPageMeta === null)는 빈 메타데이터를 기준선으로 사용한다.
    const baseMeta = originalPageMeta || { title: '', category: '', redirect_to: '', is_private: 0, view_mode: '' };

    // 대체 제목 — null/빈 문자열은 동일(미설정)로 취급.
    const origTitle = (baseMeta.title || '').trim();
    const altTitleEl = document.getElementById('alternateTitleInput') as HTMLInputElement | null;
    const currTitle = altTitleEl ? altTitleEl.value.trim() : '';
    if (origTitle !== currTitle) return true;

    // 프레젠테이션 모드(view_mode) 변경 — 'presentation' vs ''.
    const origLayout = baseMeta.view_mode === 'presentation' ? 'presentation' : '';
    if (origLayout !== getPresentationLayoutValue()) return true;

    const origCats = baseMeta.category
        ? baseMeta.category.split(',').map(c => c.trim()).filter(Boolean).sort()
        : [];
    // edit/autocomplete.ts 가 사용자 입력에 따라 window.categoryTags 를 직접 갱신하므로
    // 모듈 로컬 categoryTags 가 아닌 window 값을 비교 기준으로 사용한다.
    const currCats = Array.isArray(window.categoryTags)
        ? window.categoryTags.slice().map(c => String(c).trim()).filter(Boolean).sort()
        : [];
    if (origCats.join('\u0000') !== currCats.join('\u0000')) return true;

    const origRedirect = baseMeta.redirect_to || '';
    const redirectEl = document.getElementById('redirectInput');
    const currRedirect = redirectEl ? redirectEl.value.trim() : '';
    if (origRedirect !== currRedirect) return true;

    return false;
}

// ── 섹션을 하위 문서로 분리 ──
// 섹션 편집 모드 배너의 "하위 문서로 분리" 버튼이 호출한다.
// 사용자에게 (1) 새 하위 문서 제목, (2) 기존 자리에 남길 내용 두 입력을 받아
//   1) 새 하위 문서를 PUT /api/w/:slug 로 생성하고 (본문 = 현재 섹션의 헤딩 아래 본문)
//   2) 에디터의 섹션 텍스트를 [헤딩 + 빈 줄 + 남길 내용] 으로 교체한다.
// 사용자는 이후 일반 저장 버튼으로 부모 문서 변경을 확정한다.
//
// 주의: 두 단계는 원자적이지 않다. 1) 성공 후 2) 실패하더라도 하위 문서는 이미
// 생성되어 있으므로 데이터 손실은 없다(중복일 뿐).
async function openSplitToSubdocModal(): Promise<void> {
    const Swal = window.Swal;
    if (!Swal) return;
    if (!sectionMode || !sectionRange || !slug || !editor) {
        await Swal.fire('오류', '섹션 편집 모드에서만 사용할 수 있습니다.', 'warning');
        return;
    }

    const headingText = (sectionRange.headingText || '').trim();
    const parentSlug = slug;
    const defaultTitle = headingText ? `${parentSlug}/${headingText}` : `${parentSlug}/`;
    const computeDefaultLeave = (t: string) => `[[${t.trim()}]] 문서를 참고하세요.`;

    const result = await Swal.fire<{ title: string; leave: string }>({
        title: '<i class="mdi mdi-call-split me-2"></i>하위 문서로 분리',
        html: `
            <div class="text-start">
                <div class="mb-3">
                    <label for="splitSubdocTitle" class="form-label fw-bold">생성할 하위 문서 제목</label>
                    <input type="text" id="splitSubdocTitle" class="form-control"
                        value="${escapeHtml(defaultTitle)}" maxlength="100" autocomplete="off">
                    <div class="form-text small text-muted">생성될 하위 문서의 제목입니다. 이미 존재하는 문서 제목은 사용할 수 없습니다.</div>
                </div>
                <div class="mb-2">
                    <label for="splitLeaveBehind" class="form-label fw-bold">남길 내용</label>
                    <textarea id="splitLeaveBehind" class="form-control" rows="3" maxlength="2000" style="resize: vertical;">${escapeHtml(computeDefaultLeave(defaultTitle))}</textarea>
                    <div class="form-text small text-muted">기존 섹션의 헤딩 아래에 남을 내용입니다. 직접 수정하기 전까지는 위 제목 변경에 따라 자동 갱신됩니다.</div>
                </div>
            </div>
        `,
        width: 600,
        showCancelButton: true,
        confirmButtonText: '<i class="mdi mdi-call-split"></i> 분리',
        cancelButtonText: '취소',
        focusConfirm: false,
        didOpen: () => {
            const titleEl = document.getElementById('splitSubdocTitle') as HTMLInputElement | null;
            const leaveEl = document.getElementById('splitLeaveBehind') as HTMLTextAreaElement | null;
            if (!titleEl || !leaveEl) return;
            let leaveTouched = false;
            leaveEl.addEventListener('input', () => { leaveTouched = true; });
            titleEl.addEventListener('input', () => {
                if (!leaveTouched) {
                    leaveEl.value = computeDefaultLeave(titleEl.value || '');
                }
            });
            titleEl.focus();
            titleEl.select();
        },
        preConfirm: () => {
            const titleEl = document.getElementById('splitSubdocTitle') as HTMLInputElement | null;
            const leaveEl = document.getElementById('splitLeaveBehind') as HTMLTextAreaElement | null;
            const rawTitle = (titleEl?.value || '').trim();
            let l = (leaveEl?.value ?? '');
            // 앞뒤 슬래시/공백은 서버에서 자동 제거되므로 클라이언트도 동일하게 정규화한 값을 사용.
            const normalized = normalizeSlug(rawTitle);
            if (!normalized) {
                Swal.showValidationMessage('하위 문서 제목을 입력해주세요.');
                return false;
            }
            if (normalized === parentSlug) {
                Swal.showValidationMessage('하위 문서 제목이 현재 문서와 같을 수 없습니다.');
                return false;
            }
            // 서버 SLUG_FORBIDDEN_CHARS 와 동일하게 클라에서도 1차 차단.
            if (hasSlugForbiddenChars(normalized)) {
                Swal.showValidationMessage('제목에 사용할 수 없는 특수문자가 포함되어 있습니다.');
                return false;
            }
            if (normalized.startsWith('이미지:')) {
                Swal.showValidationMessage('"이미지:"는 이미지 문서 전용 네임스페이스이므로 사용할 수 없습니다.');
                return false;
            }
            // 남길 내용이 현재 입력 제목으로 자동 생성된 기본 문구 그대로면 정규화된 슬러그
            // 기준으로 다시 생성해, 본문에 `[[/Child/]]` 같은 unnormalized 위키링크가
            // 남는 회귀를 막는다. 사용자가 직접 수정한 경우(leaveTouched)는 그대로 둔다.
            if (l === computeDefaultLeave(rawTitle)) {
                l = computeDefaultLeave(normalized);
            }
            return { title: normalized, leave: l };
        },
    });

    if (!result.isConfirmed || !result.value) return;

    const newTitle = result.value.title;
    const leaveText = (result.value.leave || '').trim();

    // Turnstile 검증 — 하위 문서 PUT 호출에 토큰 1회 사용.
    // 토큰이 없으면 화면 중앙 검증 모달을 띄우고, 사용자가 바깥을 누르거나 ESC 로 취소하면
    // 하위 문서 생성 절차도 중단한다.
    if (window.appConfig && window.appConfig.turnstileSiteKey && !turnstileToken) {
        const verified = await ensureTurnstileVerified();
        if (!verified) return;
    }

    // 현재 에디터(=섹션) 내용에서 헤딩 라인과 본문을 분리.
    const sectionText = editor.getMarkdown();
    const firstNl = sectionText.indexOf('\n');
    const headingLine = firstNl >= 0 ? sectionText.slice(0, firstNl) : sectionText;
    const sectionBody = firstNl >= 0 ? sectionText.slice(firstNl + 1) : '';

    Swal.fire({
        title: '하위 문서 생성 중...',
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading(),
    });

    try {
        // 사전 존재 검사 — PUT 은 기존 문서를 수정하므로 모르게 본문이 덮어써질 위험을 막는다.
        // race-condition 은 expected_version=0 으로 추가 차단한다.
        try {
            const checkRes = await fetch(`/api/w/${encodeURIComponent(newTitle)}?redirect=no&nocache=true`);
            if (checkRes.ok) {
                Swal.close();
                await Swal.fire('오류', `"${newTitle}" 문서가 이미 존재합니다. 다른 제목을 사용해주세요.`, 'warning');
                return;
            }
        } catch (e) { /* 네트워크 오류는 PUT 단계에서 처리 */ }

        const requestBody: Record<string, unknown> = {
            content: sectionBody,
            summary: headingText
                ? `'${parentSlug}' 문서 '${headingText}' 섹션에서 분리`
                : `'${parentSlug}' 문서에서 분리`,
            // 신규 생성 강제 — 기존 문서가 있으면 409 로 거부됨.
            expected_version: 0,
        };
        if (window.appConfig && window.appConfig.turnstileSiteKey) {
            requestBody.turnstileToken = turnstileToken;
        }

        const res = await fetch(`/api/w/${encodeURIComponent(newTitle)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });

        // Turnstile 토큰을 소비했으니 결과와 무관하게 새 토큰을 받아둔다.
        if (window.appConfig && window.appConfig.turnstileSiteKey) {
            refreshTurnstile();
        }

        if (!res.ok) {
            let errMsg = '하위 문서 생성에 실패했습니다.';
            try {
                const data = await res.json() as { error?: string };
                if (data && data.error) errMsg = data.error;
            } catch (e) { /* keep default */ }
            if (res.status === 409) {
                errMsg = `"${newTitle}" 문서가 이미 존재합니다. 다른 제목을 사용해주세요.`;
            }
            Swal.close();
            await Swal.fire('오류', errMsg, 'error');
            return;
        }
        // 신규 생성이면 서버가 201 을 반환한다. 200(idempotent update) 은 서버가
        // expected_version=0 차단을 적용하면 발생할 수 없지만, 방어적으로 한 번 더 검증해
        // 다른 사용자의 기존 문서를 무심코 건드리지 않도록 한다.
        if (res.status !== 201) {
            Swal.close();
            await Swal.fire('오류', `"${newTitle}" 문서가 이미 존재합니다. 다른 제목을 사용해주세요.`, 'warning');
            return;
        }
    } catch (e) {
        Swal.close();
        await Swal.fire('오류', '하위 문서 생성 중 네트워크 오류가 발생했습니다.', 'error');
        return;
    }

    // 에디터 본문(=섹션) 을 [헤딩 + 빈 줄 + 남길 내용] 으로 교체.
    // 끝의 개행은 mergeSectionIntoFull 의 라인 분리 로직과 충돌하지 않도록 단일 LF 로 마무리.
    const newSectionText = `${headingLine}\n\n${leaveText}\n`;
    editor.setMarkdown(newSectionText);

    // 자동 편집 요약이 "분리" prefix 를 합성하도록 분리 정보를 기록한다.
    // editor.setMarkdown 의 change 이벤트로 refreshAutoSummary 가 곧 호출되지만,
    // 디바운스 지연 없이 즉시 갱신되도록 명시 호출도 한다.
    window.splitSubdocInfo = { originalHeading: headingText, newTitle };
    if (typeof window.refreshAutoSummary === 'function') window.refreshAutoSummary();

    Swal.close();
    await Swal.fire({
        icon: 'success',
        title: '하위 문서가 생성되었습니다',
        html: `<a href="/w/${encodeURIComponent(newTitle)}" target="_blank" rel="noopener">${escapeHtml(newTitle)}</a> 문서를 새로 만들었습니다.<br>변경된 섹션 본문을 검토한 뒤 <strong>저장</strong> 버튼을 눌러 반영해주세요.`,
    });
}

// ── 저장 ──
async function savePage() {
    if (BLOG_MODE) {
        await saveBlogPost();
        return;
    }
    // 섹션 모드에서는 카테고리/잠금/리다이렉트는 서버 값 유지
    // (slug = 제목은 URL 파라미터가 곧 식별자이자 표시 이름이므로 별도 입력 불필요)
    const category = sectionMode && originalPageMeta
        ? (originalPageMeta.category || '')
        : document.getElementById('categoryInput').value.trim();
    const redirect_to = sectionMode && originalPageMeta
        ? (originalPageMeta.redirect_to || '')
        : document.getElementById('redirectInput').value.trim();
    // is_private 는 에디터 폼에서 제거됨 — 권한 관리 모달이 단건 전용 엔드포인트로 처리.
    // PUT /api/w/:slug 는 키가 누락되면 기존 값을 그대로 유지한다 (wiki.ts 의 ?? fallback).

    // 섹션 모드: 에디터 내용(= 섹션 텍스트)을 원본에 재주입한 전체 본문을 전송
    let content;
    if (sectionMode && sectionRange) {
        // fullOriginalContent 가 비어 있으면 mergeSectionIntoFull 이 섹션 텍스트만
        // 반환해 다른 섹션 본문이 모두 사라진다. 정상 흐름에선 발생하지 않지만
        // checkDraft 등이 섹션 상태를 잘못 두고 떠난 경우에 대비해 마지막 방어선으로
        // 저장을 차단한다 (saveInProgress 진입 전이라 별도 정리 불필요).
        if (!fullOriginalContent) {
            window.Swal.fire({
                icon: 'error',
                title: '문서 상태가 손상되었습니다',
                text: '안전을 위해 저장을 중단합니다. 페이지를 새로고침 한 뒤 다시 시도해주세요.',
            });
            return;
        }
        content = window.mergeSectionIntoFull(fullOriginalContent, sectionRange, editor.getMarkdown());
    } else {
        content = editor.getMarkdown();
    }
    // 디바운스로 대기 중인 자동 요약(특히 넘겨주기 input)을 즉시 반영해야
    // Ctrl/Cmd+S 단축키로 저장할 때 최신 변경이 누락되지 않는다.
    if (typeof window.refreshAutoSummary === 'function') window.refreshAutoSummary();
    const userSummary = document.getElementById('summaryInput').value.trim();

    // 본문/메타데이터 변경이 전혀 없으면 저장 거부 (프론트 전용 검증).
    if (!hasMeaningfulChanges()) {
        window.Swal.fire({
            icon: 'info',
            title: '변경된 내용이 없습니다',
            text: '본문을 편집하거나 카테고리, 리다이렉트 설정을 변경해주세요.',
        });
        return;
    }

    if (category && !/^[가-힣a-zA-Z0-9\s,]+$/.test(category)) {
        window.Swal.fire('오류', '카테고리에는 특수문자를 사용할 수 없습니다.', 'warning');
        return;
    }
    if (userSummary && userSummary.length > 255) {
        window.Swal.fire('오류', '편집 요약은 최대 255자까지 입력할 수 있습니다.', 'warning');
        return;
    }

    // 자동 요약(신규 문서/카테고리/잠금 변경/섹션 편집)은 페이지 로드·필드 변경 시
    // 입력 칸에 이미 채워져 있으므로 별도 결합 없이 그대로 사용한다.
    let summary = userSummary;
    if (summary.length > 255) summary = summary.slice(0, 255);

    if (window.appConfig.turnstileSiteKey && !turnstileToken) {
        const verified = await ensureTurnstileVerified();
        if (!verified) return;
    }

    const saveBtn = document.getElementById('saveBtn');
    if (saveInProgress) return;
    saveInProgress = true;
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 저장 중...';

    let isSuccess = false;
    // 재저장 차단 플래그 — 섹션 모드 409 복구 중 메타데이터 재조회 실패 시 설정한다.
    // originalPageMeta 가 스테일한 상태에서 새로운 expected_version 으로 저장하면
    // 다른 편집자의 카테고리/리다이렉트/잠금 변경을 조용히 덮어쓸 수 있으므로,
    // finally 블록에서 저장 버튼을 다시 활성화하지 않도록 한다. 사용자는 새로고침이 필요.
    let blockResave = false;

    try {
        const body = {
            content,
            category: category || undefined,
            redirect_to: redirect_to || undefined,
            summary: summary || undefined,
            turnstileToken,
            // 카테고리 ACL 적용 모드 — chip 생성 시점에 사용자가 선택한 결과.
            // 빈 객체라도 보내야 서버가 "모던 클라이언트" 로 인식한다 (레거시 클라이언트는 키 누락 → 자동 적용 비활성).
            category_acl_choices: window.categoryAclChoices ?? {},
        };

        if (pageVersion !== null) {
            body.expected_version = pageVersion;
        }

        // 대체 제목 — 섹션 편집 모드에서는 전송하지 않아 서버가 기존 값을 유지하도록 한다.
        // 전체 편집 모드에서만 사용자가 입력한 값을 PUT 한다. 빈 문자열은 명시적 "제거" 의도로 null 송신.
        if (!sectionMode) {
            const altTitleEl = document.getElementById('alternateTitleInput') as HTMLInputElement | null;
            if (altTitleEl) {
                const v = altTitleEl.value.trim();
                (body as any).title = v ? v : null;
            }
            // 프레젠테이션 모드 — 체크 시 'presentation', 해제 시 null('자동'). 섹션 모드에서는 숨겨져 전송하지 않는다.
            const layoutValue = getPresentationLayoutValue();
            (body as any).view_mode = layoutValue ? layoutValue : null;
        }

        // 편집 요청 승인 모드: 정상 PUT 대신 approve(content) 호출 → 2-리비전(요청자 rev1 + 승인자 rev2).
        // approve 가 서버에서 요청 행을 원자적으로 정리하므로 별도 /resolve cleanup 은 없다.
        if (editRequestId) {
            const erRes = await fetch(`/api/pending-edits/${editRequestId}/approve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // expected_version: 승인자가 로드/머지한 페이지 버전. 그 사이 다른 편집이 끼어들면
                // 서버가 409 로 막아 머지본이 그 편집을 덮어쓰지 못하게 한다(create 는 pageVersion=0 → 서버 무시).
                // 메타데이터(카테고리/리다이렉트/대체제목/레이아웃)는 정상 저장 body 와 동일하게 전송해
                // 승인자가 에디터에서 바꾼 값이 rev2 에 반영되도록 한다(미전송 시 서버가 요청 메타로 폴백).
                body: JSON.stringify({
                    content,
                    summary: summary || undefined,
                    expected_version: pageVersion ?? undefined,
                    // category/redirect_to 는 정규화된 `|| undefined`(body.*) 대신 에디터 원시 값(빈 문자열 포함)을
                    // 보낸다. 그래야 승인자가 카테고리/리다이렉트를 비웠을 때 빈 값이 서버에 도달해 rev2 에 반영되며,
                    // 생략(undefined)으로 인해 요청의 원래 메타로 폴백되지 않는다. (title/layout 은 이미 명시적 null 전송)
                    category,
                    redirect_to,
                    title: (body as any).title,
                    view_mode: (body as any).view_mode,
                }),
            });
            const erData: any = await erRes.json().catch(() => ({}));
            if (!erRes.ok) {
                if (erRes.status === 404) {
                    // 다른 검토자가 이미 처리했거나 요청이 취소됨.
                    isSuccess = true;
                    await window.Swal.fire({ icon: 'info', title: '이미 처리된 요청', text: '이 편집 요청은 이미 승인/반려되었거나 취소되었습니다.' });
                    window.location.href = '/w/' + encodeURIComponent(slug);
                    return;
                }
                if (erData.error === 'author_missing') {
                    await window.Swal.fire({ icon: 'error', title: '승인할 수 없음', text: '원 요청자 계정을 찾을 수 없습니다. 요청을 반려하세요.' });
                    return;
                }
                // concurrent_modification: 검토 시작 후 다른 편집이 반영됨.
                // rev2_failed: 충돌 머지에서 추가 편집(rev2) 반영이 실패해 서버가 승인 직전 상태로 롤백/유지함.
                // 둘 다 요청은 살아있으므로(retryable) 최신 본문 기준으로 다시 머지하도록 같은 URL 로 재진입시킨다.
                if (erData.error === 'conflict' && (erData.reason === 'concurrent_modification' || erData.reason === 'rev2_failed')) {
                    const re = await window.Swal.fire({
                        icon: 'warning',
                        title: '문서가 변경되었습니다',
                        text: erData.message || '검토를 시작한 뒤 다른 편집이 반영되었습니다. 최신 본문을 기준으로 다시 병합해야 합니다.',
                        showCancelButton: true,
                        confirmButtonText: '다시 병합',
                        cancelButtonText: '취소',
                    });
                    if (re.isConfirmed) {
                        isSuccess = true; // beforeunload 경고 방지(의도된 재진입)
                        window.location.href = '/edit?slug=' + encodeURIComponent(slug) + '&edit_request=' + encodeURIComponent(editRequestId);
                    }
                    return;
                }
                if (erData.error === 'conflict') {
                    await window.Swal.fire({
                        icon: 'warning',
                        title: '승인 충돌',
                        text: erData.reason === 'slug_taken' ? '동일 제목의 문서가 이미 존재합니다. 요청을 반려하세요.'
                            : erData.reason === 'page_missing' ? '문서가 삭제되었습니다. 요청을 반려하세요.'
                            : '문서 상태가 변경되어 승인할 수 없습니다. 다시 시도하거나 반려하세요.',
                    });
                    return;
                }
                if (erRes.status === 403) {
                    await window.Swal.fire({ icon: 'error', title: '권한 없음', text: '이 문서의 편집 요청을 승인할 권한이 없습니다.' });
                    return;
                }
                await window.Swal.fire({ icon: 'error', title: '승인 실패', text: erData.message || erData.error || '승인에 실패했습니다.' });
                return;
            }
            // 승인 성공.
            if (DRAFT_KEY) localStorage.removeItem(DRAFT_KEY);
            if (window.promotedFromDraftKey && window.promotedFromDraftKey !== DRAFT_KEY) {
                localStorage.removeItem(window.promotedFromDraftKey);
                window.promotedFromDraftKey = null;
            }
            editRequestId = null;
            isSuccess = true;
            await window.Swal.fire({
                icon: 'success',
                title: '편집 요청을 승인했습니다',
                html: erData.partial
                    ? '요청 본문은 반영되었지만, 승인자의 추가 편집은 반영되지 못했습니다. 게시된 문서를 다시 편집해 주세요.'
                    : (erData.two_revisions ? '요청분과 추가 편집이 각각 리비전으로 반영되었습니다.' : '요청자 명의 리비전으로 반영되었습니다.'),
                confirmButtonText: '확인',
            });
            window.location.href = '/w/' + encodeURIComponent(erData.slug || slug);
            return;
        }

        const res = await fetch(`/api/w/${encodeURIComponent(slug)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (res.status === 409) {
            const data = await res.json();

            // 섹션 모드에서 충돌 발생 시: 두 가지 시나리오를 구분한다.
            // 1. 동일 섹션 동시 편집(sameSectionChangedByOther): 서버의 해당 섹션 내용이
            //    사용자 베이스(originalContent)와 다른 경우 → 전체 편집 모드로 전환 후 충돌 UI 표시.
            // 2. 섹션 경계 변경(boundary-only): 서버에서 해당 섹션을 찾을 수 있고 내용도
            //    동일하지만 문서 구조가 바뀐 경우 → 서버 최신 본문에 섹션 편집을 합성해
            //    전체 편집 모드로 전환 후 재저장을 허용한다(충돌 UI 불필요).
            if (sectionMode && sectionRange) {
                // 409 응답의 data.content 에서 해당 섹션을 탐색해 동시 편집 여부를 판별
                let sameSectionChangedByOther = false;
                let serverRange = null;
                // data.content 는 항상 문자열이지만 빈 문자열일 수 있다(다른 사용자가 문서 전체를
                // 비운 경우). 이전에는 if (data.content) 로 truthy 체크를 해 빈 본문이 들어오면
                // 섹션 탐지 자체를 스킵 → sameSectionChangedByOther 가 false 로 남고 boundary-only
                // 경로의 if (... && data.content) 도 false 가 되어 어떤 충돌 안내도 없이 사용자가
                // 재저장하면 다른 편집자의 전체 삭제를 silent overwrite 하던 회귀가 있었다.
                // 빈 본문은 곧 우리가 편집 중인 섹션도 사라졌음을 의미하므로 동시 편집으로 간주.
                const serverContentStr = typeof data.content === 'string' ? data.content : '';
                if (serverContentStr === '') {
                    sameSectionChangedByOther = true;
                } else {
                    serverRange = window.findSectionRange(serverContentStr, sectionIndex, sectionRange.headingText);
                    if (serverRange) {
                        const serverLines = serverContentStr.split('\n');
                        const newServerSection = serverLines.slice(serverRange.lineIdx, serverRange.endLine).join('\n');
                        // 서버의 섹션 내용이 사용자 베이스와 다르면 동시 편집으로 판단.
                        // trim() 으로 공백 차이를 무시하면 안 된다 — 다른 편집자가 같은 섹션의
                        // 선/후행 공백만 바꾼 경우(예: 마크다운 hard line break "foo  \n",
                        // 의도된 빈 줄)도 실제 동시 편집이며 silent overwrite 대상이 된다.
                        // _extractMarkdownSectionRanges 가 이미 섹션 끝의 빈 줄을 endLine 에서
                        // 제외하므로 양쪽 모두 결정론적이고, 정확 비교가 false positive 를 만들지
                        // 않는다.
                        if (newServerSection !== originalContent) {
                            sameSectionChangedByOther = true;
                        }
                    } else {
                        // 섹션 자체가 사라진 경우(다른 사용자가 헤딩을 삭제하는 등) →
                        // 동시 편집으로 간주하고 충돌 UI 를 표시해 사용자가 직접 병합하게 한다.
                        sameSectionChangedByOther = true;
                    }
                }

                // 409 응답에는 메타데이터가 없으므로 최신 제목/카테고리/잠금/리다이렉트를
                // 다시 받아와 입력 필드와 originalPageMeta 를 갱신한다. 갱신에 실패하면
                // 스테일 메타데이터로 다른 편집자 변경을 덮어쓸 위험이 있어 재저장을
                // 차단하고 새로고침을 유도한다.
                let freshPageForFallback = null;
                try {
                    const metaRes = await fetch(`/api/w/${encodeURIComponent(slug)}?redirect=no&nocache=true`);
                    if (metaRes.ok) {
                        freshPageForFallback = await metaRes.json();
                    }
                } catch (e) { /* freshPageForFallback 유지 */ }

                if (!freshPageForFallback) {
                    // 메타 재조회 실패 → 재저장 차단(finally 에서 버튼 재활성화 금지)
                    // 사용자는 페이지 새로고침 후 다시 편집해야 함.
                    blockResave = true;
                    await window.Swal.fire({
                        icon: 'error',
                        title: '문서 정보를 다시 가져오지 못했습니다',
                        text: '다른 사용자의 변경을 덮어쓸 수 있어 저장을 중단합니다. 페이지를 새로고침 해주세요.',
                    });
                    return;
                }

                await window.Swal.fire({
                    icon: 'warning',
                    title: '편집 충돌이 발생했습니다',
                    text: sameSectionChangedByOther
                        ? '같은 섹션을 다른 사용자가 동시에 편집했습니다. 전체 편집 모드에서 충돌 내용을 확인해 주세요.'
                        : '다른 사용자가 문서 구조를 변경했습니다. 전체 편집 모드로 전환합니다.',
                });

                // 편집하던 섹션 텍스트를 전체 본문에 합성.
                // - 동시 편집: fullOriginalContent 기준으로 합성(3-way diff base 로 사용)
                // - 경계 변경: data.content(서버 최신) 의 새 섹션 위치에 합성해 구조 변경을 보존.
                //   논리적 보장: serverRange 가 null 이면 위에서 sameSectionChangedByOther = true 로
                //   설정되므로, !sameSectionChangedByOther 가 참이면 serverRange 는 반드시 non-null.
                let mergedBase;
                let mergedLocal;
                if (!sameSectionChangedByOther && serverRange && data.content) {
                    mergedBase = data.content;
                    mergedLocal = window.mergeSectionIntoFull(data.content, serverRange, editor.getMarkdown());
                } else {
                    mergedBase = fullOriginalContent;
                    mergedLocal = window.mergeSectionIntoFull(fullOriginalContent, sectionRange, editor.getMarkdown());
                }
                editor.setMarkdown(mergedLocal);
                // 충돌 모달은 originalContent 를 base 로 사용하므로 섹션 텍스트 조각이 아닌
                // 전체 본문 기준으로 갱신한다.
                originalContent = mergedBase;
                sectionMode = false;
                sectionRange = null;
                DRAFT_KEY = 'wiki_draft_' + slug;
                const resolvedTitle = slug;
                const editPageTitle = document.getElementById('editPageTitle');
                if (editPageTitle) {
                    editPageTitle.textContent = '문서 편집: ' + resolvedTitle;
                }
                document.title = '문서 편집: ' + resolvedTitle;
                const banner = document.getElementById('sectionEditBanner');
                if (banner) { banner.classList.add('d-none'); banner.classList.remove('d-flex'); }
                // 숨겼던 필드 복원
                const fallbackLockedFields = [
                    document.getElementById('titleInput'),
                    document.getElementById('alternateTitleInput'),
                    document.getElementById('categoryInput'),
                    document.getElementById('redirectInput')
                ];
                fallbackLockedFields.forEach(el => {
                    if (el) {
                        const wrapper = el.closest('.mb-3') || el.closest('.row');
                        if (wrapper) wrapper.style.display = '';
                    }
                });
                // 메타데이터 입력 필드를 서버 최신값으로 갱신 — 재시도 시 스테일 값 송신 방지.
                // 잠금/비공개 토글은 에디터에서 제거되어 별도 DOM 복원이 필요 없다 (권한 관리 모달에서 처리).
                const titleEl = document.getElementById('titleInput');
                const altTitleElFallback = document.getElementById('alternateTitleInput') as HTMLInputElement | null;
                const categoryEl = document.getElementById('categoryInput');
                const redirectEl = document.getElementById('redirectInput');
                if (titleEl) titleEl.value = freshPageForFallback.slug || slug;
                if (altTitleElFallback) altTitleElFallback.value = freshPageForFallback.title || '';
                const freshCategory = freshPageForFallback.category || '';
                if (categoryEl) categoryEl.value = freshCategory;
                categoryTags = freshCategory ? freshCategory.split(',').map(c => c.trim()).filter(c => c) : [];
                if (redirectEl) redirectEl.value = freshPageForFallback.redirect_to || '';
                // originalPageMeta 도 일관성 유지 (sectionMode 는 false 가 되었지만 방어적으로 갱신)
                originalPageMeta = {
                    slug: freshPageForFallback.slug,
                    title: freshPageForFallback.title || '',
                    category: freshPageForFallback.category || '',
                    redirect_to: freshPageForFallback.redirect_to || '',
                    is_private: freshPageForFallback.is_private ? 1 : 0,
                    view_mode: freshPageForFallback.view_mode === 'presentation' ? 'presentation' : ''
                };
                // pageVersion 을 최신값으로 갱신
                pageVersion = data.current_version;

                // refreshAutoSummary / renderCategoryTags 모두 window.* 를 읽으므로
                // 호출 전에 최신 state 를 미러링해야 한다.
                syncStateToWindow();
                if (typeof window.renderCategoryTags === 'function') window.renderCategoryTags();
                // 새 베이스라인이 적용되었으므로 자동 요약을 재계산해 입력 칸을 동기화
                if (typeof window.refreshAutoSummary === 'function') window.refreshAutoSummary();
                if (sameSectionChangedByOther) {
                    // 동시 편집: 서버의 최신 전체 본문을 기준으로 충돌 UI 표시
                    window.showConflictModal({ current_version: data.current_version, content: data.content });
                }
                // 경계 변경: 충돌 UI 없이 전체 편집 모드로 전환 완료 → 사용자가 재저장 가능
                saveBtn.innerHTML = '<i class="mdi mdi-check"></i> 저장';
                return;
            }

            // 버전 충돌 (Optimistic Locking Failure) — 일반 편집
            window.showConflictModal(data);

            saveBtn.innerHTML = '<i class="mdi mdi-check"></i> 저장';
            return;
        }

        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || '저장 실패');
        }

        const saveResult: any = await res.json().catch(() => ({}));

        // 편집 요청(내부적으로 pending changes): ACL 미달 사용자의 편집은 즉시 리비전이 되지 않고
        // 편집 요청으로 보류된다. 서버가 200 + { pending: true } 로 응답하므로 정상 저장과 구분해
        // "편집 요청 제출" 안내를 띄우고 공개 문서(마지막 승인본) 로 이동한다.
        if (saveResult && saveResult.pending) {
            if (DRAFT_KEY) localStorage.removeItem(DRAFT_KEY);
            if (window.promotedFromDraftKey && window.promotedFromDraftKey !== DRAFT_KEY) {
                localStorage.removeItem(window.promotedFromDraftKey);
                window.promotedFromDraftKey = null;
            }
            isSuccess = true; // beforeunload 경고 방지
            await window.Swal.fire({
                icon: 'info',
                title: '편집 요청이 제출되었습니다',
                html: '이 편집은 검토자의 승인 후 반영됩니다.<br>승인 전까지 공개 문서에는 표시되지 않습니다.',
                confirmButtonText: '확인',
            });
            window.location.href = '/w/' + encodeURIComponent(saveResult.slug || slug);
            return;
        }

        if (DRAFT_KEY) localStorage.removeItem(DRAFT_KEY);
        // checkDraft 의 section→full promotion 으로 인해 원래 section 초안 키가
        // DRAFT_KEY 와 달라진 경우, 그 키도 함께 정리한다.
        if (window.promotedFromDraftKey && window.promotedFromDraftKey !== DRAFT_KEY) {
            localStorage.removeItem(window.promotedFromDraftKey);
            window.promotedFromDraftKey = null;
        }

        // MCP 편집안 충돌 해결 모드로 저장이 완료됐다면 제출안(draft) 을 정리한다.
        // /resolve 는 새 리비전을 만들지 않고 draft + 알림만 삭제한다 (리비전은 위 PUT 이 이미 생성).
        // fetch 는 4xx/5xx 에서 throw 하지 않으므로 res.ok 를 명시적으로 확인하고, 실패 시 콘솔에
        // 로그를 남긴 뒤 mcpSubmissionId 를 유지해 사용자가 mypage 에서 수동 삭제하도록 한다 —
        // 무조건 null 로 비우면 정리 실패를 silent 하게 가린다.
        if (mcpSubmissionId) {
            try {
                const resolveRes = await fetch(`/api/mcp-submissions/${mcpSubmissionId}/resolve`, { method: 'POST' });
                if (resolveRes.ok) {
                    mcpSubmissionId = null;
                } else {
                    console.warn('[edit/main] MCP 제출안 cleanup 실패 (HTTP ' + resolveRes.status + '). mypage 에서 수동 정리 필요.');
                }
            } catch (e) {
                console.warn('[edit/main] MCP 제출안 cleanup 네트워크 오류:', e);
            }
        }

        isSuccess = true;
        // 섹션 모드: originalContent 는 섹션 텍스트 기준이어야 beforeunload 경고가 정상 동작
        originalContent = sectionMode ? editor.getMarkdown() : content;
        // 섹션 편집 완료 시 해당 섹션의 열람 페이지 앵커로 복귀하여 같은 위치로 스크롤한다.
        // 열람 페이지의 s-X.Y 앵커는 window.resolveTransclusions 이후의 헤딩 순서를 기준으로
        // 생성되므로, 틀(transclusion)이 포함된 문서에서도 올바른 번호를 구하기 위해
        // 저장된 전체 본문을 먼저 트랜스클루전 전개한 뒤 섹션 번호를 계산한다.
        syncStateToWindow();
        let redirectHash = '';
        if (sectionMode) {
            try {
                const resolvedContent = typeof window.resolveTransclusions === 'function'
                    ? await window.resolveTransclusions(content, slug)
                    : content;
                const sectionNum = window.computeSectionNumber(
                    resolvedContent,
                    sectionIndex,
                    sectionRange ? sectionRange.headingText : ''
                );
                if (sectionNum) redirectHash = `#s-${sectionNum}`;
            } catch (e) { /* 앵커 계산 실패 시 최상단으로 이동 */ }
        }
        window.Swal.fire({
            icon: 'success',
            title: '저장 완료!',
            text: '문서가 성공적으로 저장되었습니다.',
            timer: 1500,
            showConfirmButton: false,
        }).then(() => {
            window.location.href = `/w/${encodeURIComponent(slug)}${redirectHash}`;
        });

    } catch (err) {
        window.Swal.fire('오류', err.message, 'error');
    } finally {
        saveInProgress = false;
        // blockResave 가 true 이면 재저장으로 인한 덮어쓰기 위험이 있으므로 버튼을 비활성 상태로 유지.
        if (!isSuccess && !blockResave) {
            saveBtn.innerHTML = '<i class="mdi mdi-check"></i> 저장';
            if (turnstileWidgetId !== null) {
                refreshTurnstile();
            } else {
                saveBtn.disabled = false;
            }
        }
    }
}

// ── 취소 ──
async function cancelEdit() {
    // 섹션 편집을 취소할 때도 사용자가 보고 있던 섹션 위치로 복귀한다.
    // 열람 페이지의 s-X.Y 앵커는 window.resolveTransclusions 이후 헤딩 기준이므로
    // 원본 본문도 트랜스클루전 전개 후 섹션 번호를 계산한다.
    const buildReturnUrl = async () => {
        if (!slug) return '/';
        let hash = '';
        if (sectionMode && fullOriginalContent) {
            try {
                const resolvedContent = typeof window.resolveTransclusions === 'function'
                    ? await window.resolveTransclusions(fullOriginalContent, slug)
                    : fullOriginalContent;
                const sectionNum = window.computeSectionNumber(
                    resolvedContent,
                    sectionIndex,
                    sectionRange ? sectionRange.headingText : ''
                );
                if (sectionNum) hash = `#s-${sectionNum}`;
            } catch (e) { /* 앵커 계산 실패 시 최상단으로 이동 */ }
        }
        return `/w/${encodeURIComponent(slug)}${hash}`;
    };

    if (editor && editor.getMarkdown().trim()) {
        // 내용 변경 여부 확인
        const result = await window.Swal.fire({
            title: '편집을 취소하시겠습니까?',
            text: '저장하지 않은 변경사항이 사라집니다.',
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: '나가기',
            cancelButtonText: '계속 편집',
        });
        if (result.isConfirmed) {
            syncStateToWindow();
            pageLeft = true;
            window.location.href = await buildReturnUrl();
        }
    } else {
        syncStateToWindow();
        pageLeft = true;
        window.location.href = await buildReturnUrl();
    }
}

// ── 블로그 내용 로드 (DOMContentLoaded 에서 에디터 초기화 완료 후 호출) ──
async function loadBlogContentForEdit() {
    const titleInput = document.getElementById('blogTitleInput');

    if (blogPostId) {
        try {
            const res = await fetch(`/api/blog/${blogPostId}`);
            if (!res.ok) throw new Error('포스트를 찾을 수 없습니다.');
            const post = await res.json();
            if (titleInput) titleInput.value = post.title || '';
            if (editor) editor.setMarkdown(post.content || '');
            syncStateToWindow();
            originalContent = post.content || '';
        } catch (e) {
            window.Swal.fire('오류', e.message, 'error').then(() => {
                window.location.href = '/blog';
            });
            return;
        }
    } else {
        if (editor) editor.setMarkdown('');
        syncStateToWindow();
        originalContent = '';
    }

    const overlay = document.getElementById('initLoadingOverlay');
    if (overlay) {
        overlay.classList.add('hidden');
        overlay.style.display = 'none';
    }

    const saveBtn = document.getElementById('saveBtn');
    if (saveBtn && !window.appConfig?.turnstileSiteKey) saveBtn.disabled = false;
}

// ── 블로그 저장 ──
async function saveBlogPost() {
    const titleInput = document.getElementById('blogTitleInput');
    const title = titleInput ? titleInput.value.trim() : '';
    if (!title) {
        window.Swal.fire('오류', '제목을 입력해주세요.', 'warning');
        return;
    }

    const content = editor ? editor.getMarkdown() : '';

    const saveBtn = document.getElementById('saveBtn');
    if (saveInProgress) return;
    saveInProgress = true;
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 저장 중...';

    try {
        const url = blogPostId ? `/api/blog/${blogPostId}` : '/api/blog';
        const method = blogPostId ? 'PUT' : 'POST';
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, content }),
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || '저장 실패');
        }

        const data = await res.json();
        const savedId = blogPostId || data.id;

        if (DRAFT_KEY) localStorage.removeItem(DRAFT_KEY);

        window.Swal.fire({
            icon: 'success',
            title: '저장 완료!',
            text: '블로그 포스트가 저장되었습니다.',
            timer: 1500,
            showConfirmButton: false,
        }).then(() => {
            window.location.href = `/blog/${savedId}`;
        });
    } catch (err) {
        window.Swal!.fire('오류', (err as Error).message, 'error');
        saveInProgress = false;
        saveBtn.innerHTML = '<i class="mdi mdi-check"></i> 저장';
        saveBtn.disabled = false;
    }
}

// 인라인 onclick / Turnstile 콜백 / scrollToBottom 의 window 노출은 module body
// 상단(BLOG_MODE 선언 바로 다음) 에서 수행한다 — 함수 선언은 hoisting 되므로 안전하며,
// 외부 CDN(Turnstile) 이 우리 모듈보다 먼저 fire 하더라도 즉시 콜백을 발견할 수 있다.
// CodeMirrorView 는 CM6 동적 import 후 본문 내부에서 노출한다.

console.log('[edit/main] module loaded');
