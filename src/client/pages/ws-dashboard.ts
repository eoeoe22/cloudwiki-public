// @ts-nocheck — 워크스페이스 대시보드 부트스트랩 (ws-dashboard.html).
// 탭 없는 단일 스크롤 페이지. 그리드 레이아웃으로 구성됨.
// common.ts / render.ts 가 window.* 로 노출하는 전역(loadConfig/checkAuth/escapeHtml/
// getRelativeTime/uiEmptyState/uiSkeletonList/renderWikiContent)을 사용한다.

import { apiGet } from '../utils/api';
import { workspaceIconClass } from '../../shared/workspaceIcon';
import { initTodoPanel } from '../workspace/todo';

const esc = (s) => window.escapeHtml(String(s ?? ''));

// ── URL 파싱 ──

function parseWslug(): string {
    const parts = location.pathname.split('/').filter(Boolean); // ['ws', wslug, ...]
    if (parts[0] !== 'ws' || !parts[1]) return '';
    try { return decodeURIComponent(parts[1]); } catch { return parts[1]; }
}

const WSLUG = parseWslug();

// ── 상태 ──

let canWrite = false;
let canManage = false;
let wsName = WSLUG;

// ── 진입점 ──

document.addEventListener('DOMContentLoaded', async () => {
    await window.loadConfig();
    await window.checkAuth();
    initDashboard();
});

async function initDashboard(): Promise<void> {
    const loadingEl = document.getElementById('wsLoading');
    const contentEl = document.getElementById('wsContent');
    const errorEl = document.getElementById('wsError');

    if (!WSLUG) {
        loadingEl?.classList.add('d-none');
        errorEl?.classList.remove('d-none');
        return;
    }

    let meta;
    try {
        meta = await apiGet('/api/ws/' + encodeURIComponent(WSLUG));
    } catch (e) {
        loadingEl?.classList.add('d-none');
        const msg = String(e?.message || '');
        if (/403/.test(msg)) {
            const t = document.getElementById('wsErrorTitle');
            if (t) t.textContent = '접근 권한이 없습니다';
        }
        errorEl?.classList.remove('d-none');
        return;
    }

    const ws = meta.workspace || {};
    const access = meta.access || {};
    canWrite = !!access.canWrite;
    canManage = !!access.canManage;
    wsName = ws.name || ws.slug || WSLUG;

    renderHeader(meta);
    loadingEl?.classList.add('d-none');
    contentEl?.classList.remove('d-none');

    // 모든 섹션 병렬 로드
    loadRecentDocs();
    loadMedia();
    loadMembers();
    loadBoardSection();

    // Todo 패널 초기화 (대시보드는 compact 위젯: 미완료 우선 최대 10개)
    initTodoPanel({ wslug: WSLUG, canWrite, mode: 'compact' });
}

// ── 게시판 섹션 로드 ──

async function loadBoardSection(): Promise<void> {
    const el = document.getElementById('boardSection');
    if (!el) return;
    try {
        const page = await apiGet('/api/ws/' + encodeURIComponent(WSLUG) + '/pages/_board');
        if (page && page.content) {
            const wenc = encodeURIComponent(WSLUG);
            if (canWrite) {
                const editArea = document.getElementById('boardEditArea');
                if (editArea) {
                    editArea.innerHTML = `<a href="/ws/${wenc}/edit?slug=_board" class="btn btn-sm btn-wiki-outline"><i class="bi bi-pencil"></i> 편집</a>`;
                }
            }
            el.innerHTML = '<div class="ws-board-content rendered-content" id="wsBoardContent"></div>';
            try {
                // 보드 글의 {{틀}} 도 워크스페이스 자체 틀로 해석(익스텐션 비활성).
                if (typeof window.configureWikiRender === 'function') {
                    window.configureWikiRender({ templateApiBase: '/api/ws/' + encodeURIComponent(WSLUG) + '/pages', disableExtensions: true });
                }
                await window.renderWikiContent(page.content, '_board', 'wsBoardContent', {
                    showCategory: false, canEdit: false, enableSectionEdit: false,
                });
            } catch {
                const bodyEl = document.getElementById('wsBoardContent');
                if (bodyEl) bodyEl.textContent = page.content;
            }
        } else {
            const wenc = encodeURIComponent(WSLUG);
            const writeLink = canWrite
                ? ` <a href="/ws/${wenc}/edit?slug=_board">작성하기</a>`
                : '';
            el.innerHTML = `<div class="text-muted small">게시판 내용이 없습니다.${writeLink}</div>`;
        }
    } catch (e) {
        const is404 = /\b404\b/.test(String(e?.message || ''));
        if (is404) {
            const wenc = encodeURIComponent(WSLUG);
            const writeLink = canWrite
                ? ` <a href="/ws/${wenc}/edit?slug=_board">작성하기</a>`
                : '';
            el.innerHTML = `<div class="text-muted small">게시판 내용이 없습니다.${writeLink}</div>`;
        } else {
            el.innerHTML = '<div class="text-muted small">게시판을 불러올 수 없습니다.</div>';
        }
    }
}

// ── 공통 헤더 렌더 ──

function humanBytes(n) {
    const v = Number(n || 0);
    if (v < 1024) return v + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let val = v / 1024, i = 0;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return val.toFixed(val >= 10 || i === 0 ? 0 : 1) + ' ' + units[i];
}

function renderHeader(meta): void {
    const ws = meta.workspace || {};
    const access = meta.access || {};
    const stats = meta.stats || {};

    document.getElementById('wsIcon').className = workspaceIconClass(ws.icon) + ' text-primary';
    document.getElementById('wsName').textContent = ws.name || ws.slug || '워크스페이스';
    document.getElementById('wsSlug').textContent = ws.slug || '';

    // 통계 배지
    const n = (v) => Number(v || 0).toLocaleString();
    const badge = (icon, color, label, value) =>
        `<span class="badge bg-${color} bg-opacity-10 text-${color} border px-3 py-2" style="font-size:var(--wiki-fs-body);">` +
        `<i class="bi ${icon}"></i> ${label} <strong>${value}</strong></span>`;
    document.getElementById('wsStats').innerHTML = [
        badge('bi-file-earmark-text', 'primary', '문서', n(stats.pages)),
        badge('bi-image', 'secondary', '미디어', n(stats.media)),
        badge('bi-hdd', 'info', '용량', humanBytes(stats.media_bytes)),
        badge('bi-file-text', 'warning', '텍스트', humanBytes(stats.text_bytes)),
        badge('bi-people', 'success', '멤버', n(stats.members)),
    ].join('');

    // 툴바 버튼
    const wenc = encodeURIComponent(WSLUG);
    const tools: string[] = [];
    if (access.canWrite) {
        tools.push(`<a href="/ws/${wenc}/edit" class="btn btn-wiki btn-sm"><i class="bi bi-plus-lg"></i> 새 문서</a>`);
        tools.push(`<a href="/ws/${wenc}/files" class="btn btn-wiki-outline btn-sm"><i class="bi bi-folder2-open"></i> 파일</a>`);
    }
    if (access.canManage) {
        tools.push(`<a href="/ws/${wenc}/settings" class="btn btn-wiki-outline btn-sm"><i class="bi bi-gear"></i> 설정</a>`);
    }
    document.getElementById('wsToolbar').innerHTML = tools.join('');

    // '전체 문서 보기' 버튼 href
    const allDocsBtn = document.getElementById('wsAllDocsBtn');
    if (allDocsBtn) allDocsBtn.setAttribute('href', '/ws/' + wenc + '/files');

    // 미디어 섹션 제목 → 미디어 관리 페이지 href
    const mediaLink = document.getElementById('mediaDetailLink');
    if (mediaLink) mediaLink.setAttribute('href', '/ws/' + wenc + '/media');

    // 멤버 초대 토글 (canManage 만)
    if (access.canManage) {
        document.getElementById('wsInviteToggle')?.classList.remove('d-none');
    }
}

// ── 개요 패널: 데이터 로드 ──

function rel(unix) {
    const n = Number(unix);
    return Number.isFinite(n) ? window.getRelativeTime(n) : '';
}

async function loadRecentDocs(): Promise<void> {
    const pagesEl = document.getElementById('wsPagesList');
    if (pagesEl) pagesEl.innerHTML = window.uiSkeletonList(5);

    let pages;
    try {
        const data = await apiGet('/api/ws/' + encodeURIComponent(WSLUG) + '/pages');
        pages = Array.isArray(data.pages) ? data.pages : [];
    } catch {
        if (pagesEl) {
            pagesEl.innerHTML = window.uiEmptyState({
                compact: true, icon: 'bi bi-exclamation-triangle', title: '불러오지 못했습니다',
            });
        }
        return;
    }

    const wenc = encodeURIComponent(WSLUG);
    const docHref = (slug) => '/ws/' + wenc + '/w/' + encodeURIComponent(slug);
    const recent = pages.slice(0, 8);
    if (!recent.length) {
        pagesEl.innerHTML = window.uiEmptyState({
            compact: true, icon: 'bi bi-file-earmark-plus',
            title: '문서가 없습니다', text: '첫 문서를 작성해 보세요.',
        });
        return;
    }
    pagesEl.innerHTML = recent.map((p) =>
        `<a href="${docHref(p.slug)}" class="d-flex align-items-center justify-content-between text-decoration-none text-body px-2 py-2 border-bottom">` +
        `<span class="text-truncate me-2 fw-medium">${esc(p.title || p.slug)}</span>` +
        `<span class="text-muted small flex-shrink-0">${rel(p.updated_at)}</span>` +
        `</a>`
    ).join('');
}

async function loadMedia(): Promise<void> {
    const el = document.getElementById('wsMediaList');
    if (el) el.innerHTML = window.uiSkeletonList(2);

    let items;
    try {
        const data = await apiGet('/api/ws/' + encodeURIComponent(WSLUG) + '/media');
        items = Array.isArray(data.items) ? data.items : [];
    } catch {
        if (el) {
            el.innerHTML = window.uiEmptyState({
                compact: true, icon: 'bi bi-exclamation-triangle', title: '불러오지 못했습니다',
            });
        }
        return;
    }

    if (!items.length) {
        el.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-image', title: '미디어가 없습니다' });
        return;
    }

    const grid = items.slice(0, 12).map((m) =>
        `<button type="button" data-media-url="${esc(m.url)}" data-media-name="${esc(m.filename)}"` +
        ` style="width:72px;height:72px;border-radius:var(--wiki-radius-base);overflow:hidden;border:1px solid var(--bs-border-color,#dee2e6);flex:0 0 auto;padding:0;background:none;cursor:pointer;">` +
        `<img src="${esc(m.url)}" alt="${esc(m.filename)}" title="${esc(m.filename)}" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;">` +
        `</button>`
    ).join('');
    el.innerHTML = `<div class="d-flex flex-wrap gap-2">${grid}</div>`;
    el.querySelectorAll<HTMLElement>('[data-media-url]').forEach((btn) => {
        btn.addEventListener('click', () => showMediaPreview(btn.dataset.mediaUrl, btn.dataset.mediaName));
    });
}

async function loadMembers(): Promise<void> {
    const el = document.getElementById('wsMembersList');
    if (el) el.innerHTML = window.uiSkeletonList(4);

    let data;
    try {
        data = await apiGet('/api/ws/' + encodeURIComponent(WSLUG) + '/members');
    } catch {
        if (el) {
            el.innerHTML = window.uiEmptyState({
                compact: true, icon: 'bi bi-exclamation-triangle', title: '불러오지 못했습니다',
            });
        }
        return;
    }

    const rows: string[] = [];
    if (data.owner) rows.push(memberRow(data.owner));
    for (const m of data.members || []) rows.push(memberRow(m));

    if (!rows.length) {
        el.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-people', title: '참가자가 없습니다' });
        return;
    }
    el.innerHTML = rows.join('');
}

function roleBadge(role: string): string {
    const map = { owner: ['소유자', 'warning'], editor: ['editor', 'primary'], viewer: ['viewer', 'secondary'] };
    const [label, color] = map[role] || [role, 'secondary'];
    return `<span class="badge bg-${color} bg-opacity-10 text-${color} border flex-shrink-0">${esc(label)}</span>`;
}

function memberRow(m): string {
    const avatar = m.picture
        ? `<img src="${esc(m.picture)}" alt="" class="rounded-circle flex-shrink-0" style="width:28px;height:28px;object-fit:cover;">`
        : `<span class="rounded-circle bg-light d-inline-flex align-items-center justify-content-center flex-shrink-0" style="width:28px;height:28px;"><i class="bi bi-person text-muted"></i></span>`;
    // 대기중 초대(canManage 에게만 내려옴)는 '초대 대기중' 배지를 함께 표시한다.
    const pendingBadge = m.status === 'pending'
        ? `<span class="badge bg-warning bg-opacity-10 text-warning border flex-shrink-0 me-1">초대 대기중</span>`
        : '';
    return (
        `<div class="d-flex align-items-center gap-2 px-1 py-2 border-bottom">` +
        avatar +
        `<a href="/profile/${Number(m.id)}" class="text-decoration-none text-body text-truncate me-auto">${esc(m.name || '알 수 없음')}</a>` +
        pendingBadge +
        roleBadge(m.role) +
        `</div>`
    );
}

// ── 멤버 초대 (canManage) ──

let inviteSearchTimer: ReturnType<typeof setTimeout> | null = null;
let inviteSearchSeq = 0;

function toggleWsInvite(): void {
    const area = document.getElementById('wsInviteArea');
    if (!area) return;
    const willShow = area.classList.contains('d-none');
    area.classList.toggle('d-none', !willShow);
    if (willShow) (document.getElementById('wsInviteSearch') as HTMLInputElement | null)?.focus();
}

function onWsInviteSearch(): void {
    if (inviteSearchTimer) clearTimeout(inviteSearchTimer);
    inviteSearchTimer = setTimeout(runWsInviteSearch, 250);
}

async function runWsInviteSearch(): Promise<void> {
    const q = ((document.getElementById('wsInviteSearch') as HTMLInputElement)?.value || '').trim();
    const el = document.getElementById('wsInviteResults');
    if (q.length < 1) { if (el) el.innerHTML = ''; return; }
    const seq = ++inviteSearchSeq;
    try {
        const data = await apiGet('/api/ws/' + encodeURIComponent(WSLUG) + '/members/search?q=' + encodeURIComponent(q));
        if (seq !== inviteSearchSeq) return;
        const results = data.results || [];
        if (!results.length) {
            el.innerHTML = '<div class="list-group-item text-muted small">검색 결과가 없습니다.</div>';
            return;
        }
        el.innerHTML = results.map((u) => {
            const id = Number(u.id);
            const avatar = u.picture
                ? `<img src="${esc(u.picture)}" alt="" class="rounded-circle" style="width:24px;height:24px;object-fit:cover;">`
                : `<i class="bi bi-person-circle text-muted"></i>`;
            return (
                `<button type="button" class="list-group-item list-group-item-action d-flex align-items-center gap-2" onclick="window.wsInviteUser(${id})">` +
                avatar +
                `<span class="text-truncate">${esc(u.name || '이름 없음')}</span>` +
                `<i class="bi bi-plus-lg ms-auto"></i>` +
                `</button>`
            );
        }).join('');
    } catch {
        if (seq !== inviteSearchSeq) return;
        el.innerHTML = '<div class="list-group-item text-danger small">검색 중 오류가 발생했습니다.</div>';
    }
}

async function wsInviteUser(userId: number): Promise<void> {
    const role = (document.getElementById('wsInviteRole') as HTMLSelectElement)?.value === 'editor' ? 'editor' : 'viewer';
    const res = await fetch('/api/ws/' + encodeURIComponent(WSLUG) + '/members', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: Number(userId), role }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        Swal.fire('초대 실패', body.error || '초대를 보내지 못했습니다.', 'error');
        return;
    }
    Swal.fire({
        toast: true, position: 'top-end', icon: 'success',
        title: '초대를 보냈습니다.', showConfirmButton: false, timer: 2000, timerProgressBar: true,
    });
    (document.getElementById('wsInviteSearch') as HTMLInputElement).value = '';
    document.getElementById('wsInviteResults').innerHTML = '';
    loadMembers();
}

// ── 미디어 미리보기 라이트박스 (중앙 확대) ──

function showMediaPreview(url: string, name: string): void {
    document.getElementById('wsMediaPreviewLayer')?.remove();

    const layer = document.createElement('div');
    layer.id = 'wsMediaPreviewLayer';
    layer.style.cssText =
        'position:fixed;inset:0;' +
        'z-index:var(--wiki-z-offcanvas-backdrop);' +
        'background:rgba(0,0,0,0.8);' +
        'display:flex;align-items:center;justify-content:center;' +
        'padding:var(--wiki-space-6);' +
        'opacity:0;transition:opacity var(--wiki-dur-enter) var(--wiki-ease);';

    const panel = document.createElement('div');
    panel.style.cssText =
        'position:relative;' +
        'display:flex;align-items:center;justify-content:center;' +
        'max-width:100%;max-height:100%;' +
        'transform:scale(0.92);' +
        'transition:transform var(--wiki-dur-enter) var(--wiki-ease);';

    panel.innerHTML =
        `<button type="button" class="btn-close flex-shrink-0" aria-label="닫기" ` +
        `style="position:absolute;top:calc(-1 * var(--wiki-space-6));right:0;filter:invert(1) grayscale(1) brightness(2);"></button>` +
        `<img src="${esc(url)}" alt="${esc(name)}" title="${esc(name)}" ` +
        `style="max-width:100%;max-height:calc(100vh - var(--wiki-space-6) * 2);object-fit:contain;` +
        `border-radius:var(--wiki-radius-lg);box-shadow:0 8px 40px rgba(0,0,0,0.5);">`;

    layer.appendChild(panel);
    document.body.appendChild(layer);

    requestAnimationFrame(() => {
        layer.style.opacity = '1';
        panel.style.transform = 'scale(1)';
    });

    const close = () => {
        layer.style.opacity = '0';
        panel.style.transform = 'scale(0.92)';
        setTimeout(() => layer.remove(), 400);
    };

    // 여백(이미지·닫기 버튼 외) 클릭 시 닫기
    layer.addEventListener('click', (e) => { if (e.target === layer || e.target === panel) close(); });
    panel.querySelector('.btn-close')?.addEventListener('click', close);

    const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
}

// window 노출 (HTML on* 핸들러 / 서브모듈에서 호출)
window.toggleWsInvite = toggleWsInvite;
window.onWsInviteSearch = onWsInviteSearch;
window.wsInviteUser = wsInviteUser;
