// @ts-nocheck — user-profile.html 인라인 스크립트 이관(동작 보존). common.ts 와 동일 사유로 타입검사 비활성.
//
// 이관 규칙:
//  - common.ts 가 window.* 로 노출하는 공통 전역(loadConfig / currentUser /
//    loadNotificationCount / escapeHtml / appConfig)은 모듈 스코프에서 bare 식별자로
//    해석되지 않으므로 모두 window.* 로 접근한다.
//  - CDN 전역(Swal)은 그대로 둔다.
//  - HTML on* 속성에서 호출되는, 이 블록에서 정의된 함수(adminBanUser /
//    adminChangeRole / goToContributionsPage)는 파일 끝에서 window.* 로 노출한다.

let profileUser = null;
let contributionsPage = 1;
let contributionsTotal = 0;
let contributionsRequestSeq = 0;
const PAGE_SIZE = 20;

// URL에서 유저 ID 추출
function getUserIdFromUrl() {
    const match = window.location.pathname.match(/^\/profile\/(\d+)$/);
    return match ? parseInt(match[1]) : null;
}

document.addEventListener('DOMContentLoaded', async () => {
    await window.loadConfig();
    const userId = getUserIdFromUrl();
    if (!userId) {
        document.getElementById('profileHeader').innerHTML =
            '<div class="text-center text-muted py-3">유효하지 않은 사용자 ID입니다.</div>';
        return;
    }

    try {
        // 동시에 checkAuth와 fetchProfile 호출
        const [authRes, res] = await Promise.all([
            fetch('/api/me').catch(() => null),
            fetch(`/api/users/${userId}/profile`)
        ]);

        if (authRes && authRes.ok) {
            window.currentUser = await authRes.json();
            document.querySelectorAll('#navLogin').forEach(el => el.classList.add('d-none'));
            document.querySelectorAll('#navUser').forEach(el => el.classList.remove('d-none'));
            document.querySelectorAll('#userAvatar').forEach(el => el.src = window.currentUser.picture || '');
            document.querySelectorAll('#userName').forEach(el => el.textContent = window.currentUser.name);

            if (window.currentUser.role === 'admin' || window.currentUser.role === 'super_admin') {
                document.querySelectorAll('#navAdminConsole, #navAdminDivider').forEach(el => el.classList.remove('d-none'));
            }

            // 알림 버튼 표시
            document.querySelectorAll('#notificationBtnWrapper').forEach(el => el.classList.remove('d-none'));
            window.loadNotificationCount();
        }

        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || '사용자를 찾을 수 없습니다.');
        }
        profileUser = await res.json();
        renderProfile();
        loadContributions();
    } catch (e) {
        document.getElementById('profileHeader').innerHTML =
            `<div class="text-center text-muted py-3">${window.escapeHtml(e.message)}</div>`;
    }
});

async function renderProfile() {
    const header = document.getElementById('profileHeader');

    const joinDate = profileUser.created_at
        ? new Date(profileUser.created_at * 1000).toLocaleDateString('ko-KR', {
            year: 'numeric', month: 'long', day: 'numeric'
        })
        : '알 수 없음';

    const avatarHtml = profileUser.picture
        ? `<img src="${profileUser.picture}" class="profile-avatar" alt="프로필" loading="lazy">`
        : `<div class="profile-avatar-placeholder">${window.escapeHtml(profileUser.name.charAt(0))}</div>`;

    // 쪽지 보내기 버튼 표시 여부
    let sendMsgBtn = '';
    if (window.currentUser && window.currentUser.id !== profileUser.id) {
        if (window.currentUser.role === 'banned') {
            // 차단 사용자: 소명(이의제기) 채널로 관리자에게만 쪽지 발송 가능.
            // 공개 프로필은 role 을 숨기므로 안전한 is_admin 플래그로 관리자 여부를 판단한다.
            if (profileUser.is_admin) {
                sendMsgBtn = `<button class="btn btn-sm btn-outline-primary mt-2" data-uid="${profileUser.id}" data-uname="${window.escapeHtml(profileUser.name)}" onclick="sendMessage(+this.dataset.uid, this.dataset.uname)"><i class="mdi mdi-email-plus-outline"></i> 관리자에게 소명</button>`;
            }
        } else {
            try {
                const dmRes = await fetch('/api/settings/dm');
                const dmData = dmRes.ok ? await dmRes.json() : { allow_direct_message: 0 };
                const canBypassDm = ['admin', 'super_admin', 'discussion_manager'].includes(window.currentUser.role);

                if (dmData.allow_direct_message === 1 || canBypassDm) {
                    if (profileUser.role === 'deleted') {
                        sendMsgBtn = `<button class="btn btn-sm btn-outline-secondary mt-2" disabled><i class="mdi mdi-email-plus-outline"></i> 쪽지 보내기 (탈퇴한 사용자)</button>`;
                    } else {
                        sendMsgBtn = `<button class="btn btn-sm btn-outline-primary mt-2" data-uid="${profileUser.id}" data-uname="${window.escapeHtml(profileUser.name)}" onclick="sendMessage(+this.dataset.uid, this.dataset.uname)"><i class="mdi mdi-email-plus-outline"></i> 쪽지 보내기</button>`;
                    }
                }
            } catch (e) { }
        }
    }

    header.innerHTML = `
        ${avatarHtml}
        <div class="profile-info">
            <h2>${window.escapeHtml(profileUser.name)}</h2>
            <div class="text-muted"><i class="mdi mdi-calendar"></i> ${joinDate} 가입</div>
            <div class="d-flex flex-wrap gap-2 align-items-center">
                ${sendMsgBtn}
            </div>
        </div>
    `;

    document.title = `${profileUser.name} - 사용자 프로필 - ${window.appConfig.wikiName}`;
    renderAdminControls();
}

function renderAdminControls() {
    if (!window.currentUser) return;
    const isAdmin = window.currentUser.role === 'admin' || window.currentUser.role === 'super_admin';
    if (!isAdmin) return;

    const section = document.getElementById('adminControlsSection');
    const content = document.getElementById('adminControlsContent');
    section.style.display = '';

    const isSuperAdmin = window.currentUser.role === 'super_admin';
    const targetIsSuperAdmin = profileUser.role === 'super_admin';
    const isBanned = profileUser.banned_until && profileUser.banned_until * 1000 > Date.now();

    let html = '<div class="d-flex flex-wrap align-items-center gap-3">';

    // 차단 버튼
    const targetIsAdmin = profileUser.role === 'admin';
    if (targetIsSuperAdmin) {
        // super_admin은 제어 불가
        html += `<span class="badge bg-dark fs-6"><i class="mdi mdi-shield-crown"></i> 최고 관리자 (제어 불가)</span>`;
    } else if (!isSuperAdmin && targetIsAdmin) {
        // 일반 관리자는 다른 관리자를 차단할 수 없음
        html += `<span class="badge bg-secondary fs-6"><i class="mdi mdi-shield-account"></i> 관리자 (차단 불가)</span>`;
    } else {
        const banLabel = isBanned
            ? '<i class="mdi mdi-lock-open-outline"></i> 차단 해제'
            : '<i class="mdi mdi-block-helper"></i> 차단';
        const banClass = isBanned ? 'btn btn-outline-secondary' : 'btn btn-outline-danger';
        html += `<button class="${banClass}" onclick="adminBanUser()">${banLabel}</button>`;

        if (isBanned) {
            const until = new Date(profileUser.banned_until * 1000).toLocaleDateString('ko-KR');
            html += `<span class="badge bg-danger">차단 중 (~${until})</span>`;
        }
    }

    // 역할 변경 (super_admin 뷰어이고 대상이 super_admin이 아닌 경우)
    if (isSuperAdmin && !targetIsSuperAdmin) {
        html += `
            <div class="d-flex align-items-center gap-2 ms-auto">
                <label class="form-label mb-0 text-muted">역할:</label>
                <select class="form-select form-select-sm w-auto" onchange="adminChangeRole(this.value)">
                    <option value="user" ${profileUser.role === 'user' ? 'selected' : ''}>유저</option>
                    <option value="discussion_manager" ${profileUser.role === 'discussion_manager' ? 'selected' : ''}>토론 관리자</option>
                    <option value="admin" ${profileUser.role === 'admin' ? 'selected' : ''}>관리자</option>
                </select>
            </div>
        `;
    }

    html += '</div>';
    content.innerHTML = html;
}

async function adminBanUser() {
    const isBanned = profileUser.banned_until && profileUser.banned_until * 1000 > Date.now();
    const { value: days } = await Swal.fire({
        titleText: `${profileUser.name} 차단`,
        input: 'number',
        inputLabel: '차단 일수 (0 = 해제)',
        inputValue: isBanned ? 0 : 7,
        inputAttributes: { min: 0 },
        showCancelButton: true,
        cancelButtonText: '취소',
        confirmButtonText: '적용',
    });
    if (days === undefined) return;
    const res = await fetch(`/api/admin/users/${profileUser.id}/ban`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: Number(days) }),
    });
    const data = await res.json();
    if (res.ok) {
        profileUser.banned_until = data.banned_until;
        renderAdminControls();
    } else {
        Swal.fire('오류', data.error || '차단 실패', 'error');
    }
}

async function adminChangeRole(role) {
    const res = await fetch(`/api/admin/users/${profileUser.id}/role`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
    });
    const data = await res.json();
    if (res.ok) {
        profileUser.role = role;
        renderAdminControls();
        Swal.fire({ icon: 'success', title: '변경됨', toast: true, position: 'top-end', timer: 1500, showConfirmButton: false });
    } else {
        Swal.fire('오류', data.error || '변경 실패', 'error');
    }
}

async function loadContributions(page = 1) {
    const userId = getUserIdFromUrl();
    const listEl = document.getElementById('contributionsList');
    const paginationEl = document.getElementById('contributionsPagination');
    const isFirstLoad = contributionsTotal === 0 && page === 1;
    if (!isFirstLoad) {
        listEl.innerHTML = window.uiSkeletonList(5);
    }

    const seq = ++contributionsRequestSeq;
    const offset = (page - 1) * PAGE_SIZE;
    try {
        const res = await fetch(`/api/users/${userId}/contributions?offset=${offset}&limit=${PAGE_SIZE}`);
        if (seq !== contributionsRequestSeq) return;
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (seq !== contributionsRequestSeq) return;
        const contributions = data.contributions || [];
        const total = data.total || 0;

        contributionsTotal = total;

        // 통계 표시
        const statsSection = document.getElementById('statsSection');
        statsSection.style.display = '';
        document.getElementById('statCards').innerHTML = `
            <div class="stat-card">
                <div class="stat-value">${contributionsTotal}</div>
                <div class="stat-label">총 편집 횟수</div>
            </div>
        `;

        // 기여 목록
        const section = document.getElementById('contributionsSection');
        section.style.display = '';

        if (total === 0) {
            contributionsPage = 1;
            listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-inbox', title: '편집 내역이 없습니다' });
            paginationEl.innerHTML = '';
            return;
        }

        // 요청한 페이지가 범위를 벗어났으면 마지막 페이지로 보정해 재요청
        const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        if (contributions.length === 0 && page > totalPages) {
            loadContributions(totalPages);
            return;
        }

        contributionsPage = page;
        listEl.innerHTML = contributions.map(renderContribution).join('');
        renderContributionsPagination();

    } catch (e) {
        if (seq !== contributionsRequestSeq) return;
        listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: '불러오기 실패', text: '잠시 후 다시 시도해 주세요.' });
        paginationEl.innerHTML = '';
    }
}

function goToContributionsPage(page) {
    const totalPages = Math.max(1, Math.ceil(contributionsTotal / PAGE_SIZE));
    const target = Math.min(Math.max(1, page), totalPages);
    if (target === contributionsPage) return;
    loadContributions(target);
    document.getElementById('contributionsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function getContributionsPageNumbers(current, total) {
    const pages = [];
    if (total <= 7) {
        for (let i = 1; i <= total; i++) pages.push(i);
        return pages;
    }
    pages.push(1);
    if (current > 3) pages.push('...');
    const start = Math.max(2, current - 1);
    const end = Math.min(total - 1, current + 1);
    for (let i = start; i <= end; i++) pages.push(i);
    if (current < total - 2) pages.push('...');
    pages.push(total);
    return pages;
}

function renderContributionsPagination() {
    const container = document.getElementById('contributionsPagination');
    const totalPages = Math.max(1, Math.ceil(contributionsTotal / PAGE_SIZE));
    if (totalPages <= 1) {
        container.innerHTML = '';
        return;
    }
    const pages = getContributionsPageNumbers(contributionsPage, totalPages);
    const isFirst = contributionsPage === 1;
    const isLast = contributionsPage === totalPages;

    let html = '<ul class="pagination pagination-sm justify-content-center mb-0 flex-wrap">';
    html += `<li class="page-item ${isFirst ? 'disabled' : ''}"><button type="button" class="page-link" onclick="goToContributionsPage(1)" ${isFirst ? 'disabled' : ''} aria-label="처음"><i class="mdi mdi-chevron-double-left"></i></button></li>`;
    html += `<li class="page-item ${isFirst ? 'disabled' : ''}"><button type="button" class="page-link" onclick="goToContributionsPage(${contributionsPage - 1})" ${isFirst ? 'disabled' : ''} aria-label="이전"><i class="mdi mdi-chevron-left"></i></button></li>`;
    for (const p of pages) {
        if (p === '...') {
            html += '<li class="page-item disabled"><span class="page-link">…</span></li>';
        } else {
            const active = p === contributionsPage ? 'active' : '';
            html += `<li class="page-item ${active}"><button type="button" class="page-link" onclick="goToContributionsPage(${p})">${p}</button></li>`;
        }
    }
    html += `<li class="page-item ${isLast ? 'disabled' : ''}"><button type="button" class="page-link" onclick="goToContributionsPage(${contributionsPage + 1})" ${isLast ? 'disabled' : ''} aria-label="다음"><i class="mdi mdi-chevron-right"></i></button></li>`;
    html += `<li class="page-item ${isLast ? 'disabled' : ''}"><button type="button" class="page-link" onclick="goToContributionsPage(${totalPages})" ${isLast ? 'disabled' : ''} aria-label="마지막"><i class="mdi mdi-chevron-double-right"></i></button></li>`;
    html += '</ul>';
    container.innerHTML = html;
}

function renderContribution(c) {
    const date = new Date(c.created_at * 1000).toLocaleString('ko-KR');
    const summaryHtml = c.summary
        ? `<span class="summary">- ${window.escapeHtml(c.summary)}</span>`
        : '<span class="summary text-muted">- (요약 없음)</span>';
    return `
        <div class="contribution-item">
            <div>
                <a href="/w/${encodeURIComponent(c.slug)}">${window.escapeHtml(c.slug)}</a>
                ${summaryHtml}
            </div>
            <span class="meta">${date}</span>
        </div>
    `;
}

// HTML on* 속성에서 호출되므로 window 로 노출
window.adminBanUser = adminBanUser;
window.adminChangeRole = adminChangeRole;
window.goToContributionsPage = goToContributionsPage;
