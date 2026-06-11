// @ts-nocheck — 워크스페이스 게시판 패널 모듈.
// ws-dashboard.ts 에서 initBoardPanel() 로 초기화된다.
// common.ts / render.ts 가 window.* 로 노출하는 전역(escapeHtml/getRelativeTime/
// currentUser/renderWikiContent/uiEmptyState/uiSkeletonList)을 사용한다.

import { apiGet } from '../utils/api';

const esc = (s) => window.escapeHtml(String(s ?? ''));

let _wslug = '';
let _wsBase = '';
let _wsName = '';
let _canWrite = false;
let _canManage = false;

// 경쟁 조건 방지: 새 요청이 오면 이전 stale 응답을 버린다.
let _fetchSeq = 0;

const boardUrl = () => '/ws/' + encodeURIComponent(_wslug) + '/board';
const postUrl = (id: number) => boardUrl() + '/' + Number(id);

export interface BoardPanelCtx {
    wslug: string;
    wsName: string;
    canWrite: boolean;
    canManage: boolean;
}

export function initBoardPanel(ctx: BoardPanelCtx, initialPostId?: number | null): void {
    _wslug = ctx.wslug;
    _wsBase = '/api/ws/' + encodeURIComponent(ctx.wslug);
    _wsName = ctx.wsName;
    _canWrite = ctx.canWrite;
    _canManage = ctx.canManage;

    // window 노출 (HTML on* 핸들러용)
    window.goDetail = goDetail;
    window.goList = goList;
    window.goPage = goPage;
    window.onPostClick = onPostClick;
    window.newPost = newPost;
    window.editPost = editPost;
    window.deletePost = deletePost;
    window.submitComment = submitComment;
    window.deleteComment = deleteComment;

    if (initialPostId) {
        loadDetail(initialPostId);
    } else {
        const page = Number(new URLSearchParams(location.search).get('page')) || 1;
        loadList(page);
    }
}

// 대시보드 popstate 핸들러에서 호출 — 현재 URL에 맞는 뷰를 렌더한다.
export function navigateBoardTo(postId: number | null, page = 1): void {
    if (postId) {
        loadDetail(postId);
    } else {
        loadList(page);
    }
}

// ════════════════════════════════════════════
// 목록 뷰
// ════════════════════════════════════════════

function show(id: string) { document.getElementById(id)?.classList.remove('d-none'); }
function hide(id: string) { document.getElementById(id)?.classList.add('d-none'); }

function goList(): void {
    history.pushState({}, '', boardUrl());
    loadList(1);
}

async function loadList(page: number): Promise<void> {
    const seq = ++_fetchSeq;
    document.title = '게시판 - ' + _wsName + ' - CloudWiki';
    hide('boardDetailView');
    show('boardListView');

    const newBtn = document.getElementById('boardNewBtn');
    if (newBtn) {
        if (_canWrite) {
            newBtn.classList.remove('d-none');
            newBtn.innerHTML =
                '<button type="button" class="btn btn-wiki btn-sm" onclick="window.newPost()">' +
                '<i class="bi bi-pencil-square"></i> 새 게시글</button>';
        } else {
            newBtn.classList.add('d-none');
            newBtn.innerHTML = '';
        }
    }

    const listEl = document.getElementById('postList');
    if (listEl) listEl.innerHTML = window.uiSkeletonList(5);

    let data;
    try {
        data = await apiGet(_wsBase + '/board/posts?page=' + Number(page || 1));
    } catch {
        if (seq !== _fetchSeq) return;
        if (listEl) {
            listEl.innerHTML = window.uiEmptyState({
                compact: true, icon: 'bi bi-exclamation-triangle', title: '불러오지 못했습니다',
            });
        }
        return;
    }
    if (seq !== _fetchSeq) return;
    if (typeof data.can_write === 'boolean') _canWrite = data.can_write;
    renderList(data);
}

function renderList(data): void {
    const posts = Array.isArray(data.posts) ? data.posts : [];
    const listEl = document.getElementById('postList');
    if (!listEl) return;

    if (!posts.length) {
        listEl.innerHTML = window.uiEmptyState({
            icon: 'bi bi-layout-text-sidebar-reverse',
            title: '게시글이 없습니다',
            text: _canWrite ? '첫 게시글을 작성해 보세요.' : '아직 작성된 게시글이 없습니다.',
        });
        renderPagination(data);
        return;
    }

    listEl.innerHTML =
        '<div class="list-group">' +
        posts.map((p) => {
            const id = Number(p.id);
            const cc = Number(p.comment_count || 0);
            const commentBadge = cc > 0
                ? '<span class="badge bg-secondary bg-opacity-10 text-secondary border ms-2 flex-shrink-0"><i class="bi bi-chat"></i> ' + cc + '</span>'
                : '';
            return (
                '<a href="' + esc(postUrl(id)) + '" ' +
                'class="list-group-item list-group-item-action d-flex align-items-center justify-content-between gap-2" ' +
                'onclick="return window.onPostClick(event, ' + id + ')">' +
                '<span class="d-flex align-items-center text-truncate me-2">' +
                '<span class="fw-medium text-truncate">' + esc(p.title) + '</span>' + commentBadge +
                '</span>' +
                '<span class="text-muted small flex-shrink-0">' +
                esc(p.author_name || '익명') + ' · ' + esc(window.getRelativeTime(p.created_at)) +
                '</span>' +
                '</a>'
            );
        }).join('') +
        '</div>';

    renderPagination(data);
}

function renderPagination(data): void {
    const el = document.getElementById('boardPagination');
    if (!el) return;
    const total = Number(data.total || 0);
    const pageSize = Number(data.pageSize || 20);
    const page = Number(data.page || 1);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (totalPages <= 1) { el.innerHTML = ''; return; }

    const item = (p, label, disabled, active) =>
        '<li class="page-item' + (disabled ? ' disabled' : '') + (active ? ' active' : '') + '">' +
        '<a class="page-link" href="#" onclick="window.goPage(' + p + ');return false;">' + label + '</a></li>';

    let html = '<ul class="pagination justify-content-center mb-0">';
    html += item(page - 1, '이전', page <= 1, false);
    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, page + 2);
    if (start > 1) html += item(1, '1', false, page === 1);
    if (start > 2) html += '<li class="page-item disabled"><span class="page-link">…</span></li>';
    for (let p = start; p <= end; p++) html += item(p, String(p), false, p === page);
    if (end < totalPages - 1) html += '<li class="page-item disabled"><span class="page-link">…</span></li>';
    if (end < totalPages) html += item(totalPages, String(totalPages), false, page === totalPages);
    html += item(page + 1, '다음', page >= totalPages, false);
    html += '</ul>';
    el.innerHTML = html;
}

function goPage(p: number): void {
    const np = Number(p);
    if (!Number.isInteger(np) || np < 1) return;
    history.pushState({}, '', boardUrl() + '?page=' + np);
    loadList(np);
}

function onPostClick(ev: MouseEvent, id: number): boolean {
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button === 1) return true;
    ev.preventDefault();
    goDetail(id);
    return false;
}

// ════════════════════════════════════════════
// 상세 뷰
// ════════════════════════════════════════════

function goDetail(id: number): void {
    history.pushState({}, '', postUrl(id));
    loadDetail(id);
}

async function loadDetail(id: number): Promise<void> {
    const seq = ++_fetchSeq;
    hide('boardListView');
    show('boardDetailView');

    const el = document.getElementById('postDetail');
    if (el) el.innerHTML = window.uiSkeletonList(3);

    let data;
    try {
        data = await apiGet(_wsBase + '/board/posts/' + Number(id));
    } catch (e) {
        if (seq !== _fetchSeq) return;
        if (el) {
            const is404 = /\b404\b/.test(String(e?.message || ''));
            el.innerHTML = window.uiEmptyState({
                icon: 'bi bi-file-earmark-x',
                title: is404 ? '게시글이 없습니다' : '불러오지 못했습니다',
                text: is404 ? '삭제되었거나 존재하지 않는 게시글입니다.' : '권한이 없거나 일시적인 오류일 수 있습니다.',
                cta: { label: '목록으로', href: boardUrl() },
            });
        }
        return;
    }
    if (seq !== _fetchSeq) return;
    if (typeof data.can_write === 'boolean') _canWrite = data.can_write;
    if (typeof data.can_manage === 'boolean') _canManage = data.can_manage;
    renderDetail(data.post, data.comments || []);
}

function canEditPost(post): boolean {
    const uid = window.currentUser?.id;
    return _canManage || (uid != null && Number(post.author_id) === Number(uid));
}

async function renderDetail(post, comments): Promise<void> {
    const el = document.getElementById('postDetail');
    if (!el) return;
    const id = Number(post.id);
    document.title = (post.title || '게시글') + ' - CloudWiki';

    let actions = '';
    if (canEditPost(post)) {
        actions =
            '<div class="d-flex gap-1 flex-shrink-0">' +
            '<button type="button" class="btn btn-sm btn-wiki-outline" onclick="window.editPost(' + id + ')"><i class="bi bi-pencil"></i> 수정</button>' +
            '<button type="button" class="btn btn-sm btn-wiki-danger" onclick="window.deletePost(' + id + ')"><i class="bi bi-trash"></i> 삭제</button>' +
            '</div>';
    }

    const edited = Number(post.updated_at) > Number(post.created_at)
        ? ' · 수정됨 ' + esc(window.getRelativeTime(post.updated_at))
        : '';

    el.innerHTML =
        '<div class="d-flex justify-content-between align-items-start flex-wrap gap-2 mb-2">' +
        '<h3 class="mb-0" style="word-break:break-word;">' + esc(post.title) + '</h3>' +
        actions +
        '</div>' +
        '<div class="text-muted small mb-3 pb-3 border-bottom">' +
        '<i class="bi bi-person"></i> ' + esc(post.author_name || '익명') +
        ' · ' + esc(window.getRelativeTime(post.created_at)) + edited +
        '</div>' +
        '<div id="postBody" class="wiki-content mb-4"></div>' +
        '<hr>' +
        '<h5 class="mb-3"><i class="bi bi-chat-left-text"></i> 댓글 <span class="text-muted">(' + comments.length + ')</span></h5>' +
        '<div id="commentList" class="mb-3"></div>' +
        commentFormHtml(id);

    try {
        await window.renderWikiContent(post.content || '', 'board-post-' + id, 'postBody', {
            showCategory: false, canEdit: false, enableSectionEdit: false,
        });
    } catch {
        const b = document.getElementById('postBody');
        if (b) b.textContent = post.content || '';
    }

    renderComments(id, comments);
}

function commentFormHtml(postId: number): string {
    if (!_canWrite) {
        return '<div class="text-muted small">댓글을 작성하려면 편집 권한이 필요합니다.</div>';
    }
    return (
        '<div class="d-flex flex-column gap-2">' +
        '<textarea id="commentInput" class="form-control" rows="3" maxlength="5000" placeholder="댓글을 입력하세요"></textarea>' +
        '<div><button type="button" class="btn btn-wiki btn-sm" onclick="window.submitComment(' + Number(postId) + ')"><i class="bi bi-send"></i> 댓글 작성</button></div>' +
        '</div>'
    );
}

function renderComments(postId: number, comments): void {
    const el = document.getElementById('commentList');
    if (!el) return;
    if (!comments.length) {
        el.innerHTML = '<div class="text-muted small">첫 댓글을 남겨보세요.</div>';
        return;
    }
    const uid = window.currentUser?.id;
    el.innerHTML = comments.map((cm) => {
        const cid = Number(cm.id);
        const canDel = _canManage || (uid != null && Number(cm.author_id) === Number(uid));
        const delBtn = canDel
            ? '<button type="button" class="btn btn-sm btn-link text-danger p-0 flex-shrink-0" title="삭제" onclick="window.deleteComment(' + Number(postId) + ',' + cid + ')"><i class="bi bi-trash"></i></button>'
            : '';
        return (
            '<div class="border-bottom py-2">' +
            '<div class="d-flex align-items-center justify-content-between gap-2 mb-1">' +
            '<span class="small fw-medium">' + esc(cm.author_name || '익명') +
            ' <span class="text-muted fw-normal">· ' + esc(window.getRelativeTime(cm.created_at)) + '</span></span>' +
            delBtn +
            '</div>' +
            '<div class="small" style="white-space:pre-wrap;word-break:break-word;">' + esc(cm.content) + '</div>' +
            '</div>'
        );
    }).join('');
}

// ── 게시글 작성 ──
async function newPost(): Promise<void> {
    const { value: form } = await Swal.fire({
        title: '새 게시글',
        html:
            '<input id="swalPostTitle" class="swal2-input" placeholder="제목" maxlength="200">' +
            '<textarea id="swalPostContent" class="swal2-textarea" placeholder="본문 (위키 문법 지원, 선택)" style="height:12rem;"></textarea>',
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: '작성',
        cancelButtonText: '취소',
        preConfirm: () => {
            const title = (document.getElementById('swalPostTitle').value || '').trim();
            if (!title) { Swal.showValidationMessage('제목을 입력해주세요.'); return false; }
            return { title, content: document.getElementById('swalPostContent').value || '' };
        },
    });
    if (!form) return;

    try {
        const res = await fetch(_wsBase + '/board/posts', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(form),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            Swal.fire('작성 실패', body.error || '게시글을 작성하지 못했습니다.', 'error');
            return;
        }
        goDetail(body.id);
    } catch {
        Swal.fire('오류', '요청 중 문제가 발생했습니다.', 'error');
    }
}

// ── 게시글 수정 ──
async function editPost(id: number): Promise<void> {
    let post;
    try {
        const data = await apiGet(_wsBase + '/board/posts/' + Number(id));
        post = data.post;
    } catch {
        Swal.fire('오류', '게시글을 불러오지 못했습니다.', 'error');
        return;
    }

    const { value: form } = await Swal.fire({
        title: '게시글 수정',
        html:
            '<input id="swalPostTitle" class="swal2-input" placeholder="제목" maxlength="200">' +
            '<textarea id="swalPostContent" class="swal2-textarea" placeholder="본문" style="height:12rem;"></textarea>',
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: '저장',
        cancelButtonText: '취소',
        didOpen: () => {
            document.getElementById('swalPostTitle').value = post.title || '';
            document.getElementById('swalPostContent').value = post.content || '';
        },
        preConfirm: () => {
            const title = (document.getElementById('swalPostTitle').value || '').trim();
            if (!title) { Swal.showValidationMessage('제목을 입력해주세요.'); return false; }
            return { title, content: document.getElementById('swalPostContent').value || '' };
        },
    });
    if (!form) return;

    try {
        const res = await fetch(_wsBase + '/board/posts/' + Number(id), {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(form),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            Swal.fire('수정 실패', body.error || '게시글을 수정하지 못했습니다.', 'error');
            return;
        }
        loadDetail(id);
    } catch {
        Swal.fire('오류', '요청 중 문제가 발생했습니다.', 'error');
    }
}

// ── 게시글 삭제 ──
async function deletePost(id: number): Promise<void> {
    const r = await Swal.fire({
        title: '게시글 삭제',
        text: '이 게시글을 삭제하시겠습니까?',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: '삭제',
        cancelButtonText: '취소',
        confirmButtonColor: '#dc3545',
    });
    if (!r.isConfirmed) return;

    try {
        const res = await fetch(_wsBase + '/board/posts/' + Number(id), {
            method: 'DELETE',
            credentials: 'same-origin',
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            Swal.fire('삭제 실패', body.error || '게시글을 삭제하지 못했습니다.', 'error');
            return;
        }
        Swal.fire({
            toast: true, position: 'top-end', icon: 'success',
            title: '삭제했습니다.', showConfirmButton: false, timer: 1800, timerProgressBar: true,
        });
        goList();
    } catch {
        Swal.fire('오류', '요청 중 문제가 발생했습니다.', 'error');
    }
}

// ── 댓글 작성 ──
async function submitComment(postId: number): Promise<void> {
    const input = document.getElementById('commentInput') as HTMLTextAreaElement | null;
    if (!input) return;
    const content = (input.value || '').trim();
    if (!content) return;

    input.disabled = true;
    try {
        const res = await fetch(_wsBase + '/board/posts/' + Number(postId) + '/comments', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            Swal.fire('작성 실패', body.error || '댓글을 작성하지 못했습니다.', 'error');
            return;
        }
        input.value = '';
        loadDetail(postId);
    } catch {
        Swal.fire('오류', '요청 중 문제가 발생했습니다.', 'error');
    } finally {
        input.disabled = false;
    }
}

// ── 댓글 삭제 ──
async function deleteComment(postId: number, commentId: number): Promise<void> {
    const r = await Swal.fire({
        title: '댓글 삭제',
        text: '이 댓글을 삭제하시겠습니까?',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: '삭제',
        cancelButtonText: '취소',
        confirmButtonColor: '#dc3545',
    });
    if (!r.isConfirmed) return;

    try {
        const res = await fetch(_wsBase + '/board/posts/' + Number(postId) + '/comments/' + Number(commentId), {
            method: 'DELETE',
            credentials: 'same-origin',
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            Swal.fire('삭제 실패', body.error || '댓글을 삭제하지 못했습니다.', 'error');
            return;
        }
        loadDetail(postId);
    } catch {
        Swal.fire('오류', '요청 중 문제가 발생했습니다.', 'error');
    }
}
