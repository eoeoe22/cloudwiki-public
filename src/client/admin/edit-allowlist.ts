/**
 * 관리자 콘솔 — 문서별 편집 허용 명단 (page_edit_allowlist) UI.
 *
 * - public/admin.html 의 "문서별 편집 허용 명단" 카드 마크업을 조작한다.
 * - /api/admin/pages/:slug/edit-allowlist (GET/POST/DELETE) 와
 *   /api/admin/pages/:slug/edit-acl (GET) 을 호출.
 * - window.loadEditAllowlist / addToEditAllowlist 를 노출해 admin.html 의 inline onclick 핸들러가 호출.
 */

import '../utils/swal';

import { normalizeSlug } from '../utils/slug';

interface EditAcl {
    mode: 'or' | 'and';
    flags: string[];
}

interface AllowlistItem {
    user_id: number;
    name: string;
    picture: string | null;
    role: string;
    added_at: number;
    added_by_name: string | null;
}

declare global {
    interface Window {
        loadEditAllowlist?: () => Promise<void>;
        addToEditAllowlist?: () => Promise<void>;
    }
}

const ROLE_LABELS: Record<string, string> = {
    user: '유저',
    discussion_manager: '토론 관리자',
    admin: '관리자',
    super_admin: '최고 관리자',
    banned: '차단됨',
    deleted: '탈퇴',
};

function escapeHtml(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getInputSlug(): string {
    const el = document.getElementById('allowlistSlugInput') as HTMLInputElement | null;
    if (!el) return '';
    return normalizeSlug(el.value || '');
}

function showPanel(): HTMLElement | null {
    return document.getElementById('editAllowlistPanel');
}

function setSlugLabel(slug: string): void {
    const el = document.getElementById('editAllowlistSlugLabel');
    if (el) el.textContent = slug;
}

function setAclLabel(acl: EditAcl | null): void {
    const el = document.getElementById('editAllowlistAclLabel');
    if (!el) return;
    if (!acl || acl.flags.length === 0) {
        el.innerHTML = '<span class="badge bg-secondary">ACL 비활성</span>';
        return;
    }
    const flagLabels: Record<string, string> = {
        aged: '가입 N일 이상',
        allowlist: '허용 명단',
        page_editor: '본 문서 편집 이력',
        any_editor: '임의 문서 편집 이력',
    };
    const joiner = acl.mode === 'and' ? ' AND ' : ' OR ';
    const summary = acl.flags.map(f => flagLabels[f] || f).join(joiner);
    const hasAllowlist = acl.flags.includes('allowlist');
    const cls = hasAllowlist ? 'bg-success' : 'bg-warning text-dark';
    const tail = hasAllowlist ? '' : ' (이 문서는 allowlist 플래그가 비활성 — 명단을 추가해도 효과 없음)';
    el.innerHTML = `<span class="badge ${cls}" title="${escapeHtml(JSON.stringify(acl))}">ACL: ${escapeHtml(summary)}${escapeHtml(tail)}</span>`;
}

function renderList(slug: string, items: AllowlistItem[]): void {
    const el = document.getElementById('editAllowlistList');
    if (!el) return;
    if (items.length === 0) {
        el.innerHTML = '<div class="list-group-item text-muted small">아직 추가된 사용자가 없습니다.</div>';
        return;
    }
    el.innerHTML = items.map((it) => {
        const role = ROLE_LABELS[it.role] || it.role;
        const added = new Date(it.added_at * 1000).toLocaleString();
        const addedBy = it.added_by_name ? ` · ${escapeHtml(it.added_by_name)}` : '';
        const avatar = it.picture
            ? `<img src="${escapeHtml(it.picture)}" alt="" style="width:24px;height:24px;border-radius:50%;object-fit:cover;">`
            : '<i class="mdi mdi-account-circle" style="font-size: 24px;"></i>';
        return `
            <div class="list-group-item d-flex align-items-center gap-2" data-user-id="${it.user_id}">
                ${avatar}
                <div class="flex-grow-1">
                    <div class="fw-medium">${escapeHtml(it.name)} <small class="text-muted">#${it.user_id}</small></div>
                    <div class="text-muted small">${escapeHtml(role)} · ${escapeHtml(added)}${addedBy}</div>
                </div>
                <button type="button" class="btn btn-sm btn-outline-danger" data-remove-user="${it.user_id}">
                    <i class="mdi mdi-trash-can-outline"></i> 삭제
                </button>
            </div>
        `;
    }).join('');

    el.querySelectorAll<HTMLButtonElement>('[data-remove-user]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const uid = Number(btn.dataset.removeUser);
            if (!Number.isInteger(uid) || uid <= 0) return;
            const swal = window.Swal;
            const confirm = await swal?.fire({
                title: '명단에서 삭제',
                text: `user #${uid} 을(를) 허용 명단에서 제거하시겠습니까?`,
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: '삭제',
                cancelButtonText: '취소',
                confirmButtonColor: '#EF4444',
            });
            if (!confirm?.isConfirmed) return;
            const res = await fetch(`/api/admin/pages/${encodeURIComponent(slug)}/edit-allowlist/${uid}`, { method: 'DELETE' });
            if (!res.ok) {
                const err = (await res.json().catch(() => ({}))) as { error?: string };
                swal?.fire({ icon: 'error', title: '삭제 실패', text: err.error || `오류 (${res.status})` });
                return;
            }
            await loadEditAllowlist();
        });
    });
}

async function loadEditAllowlist(): Promise<void> {
    const slug = getInputSlug();
    const panel = showPanel();
    if (!slug) {
        window.Swal?.fire({ icon: 'warning', title: '슬러그 미입력', text: '문서 슬러그를 입력하세요.' });
        if (panel) panel.style.display = 'none';
        return;
    }
    if (!panel) return;
    panel.style.display = '';
    setSlugLabel(slug);
    setAclLabel(null);
    const listEl = document.getElementById('editAllowlistList');
    if (listEl) listEl.innerHTML = '<div class="list-group-item text-muted small">불러오는 중…</div>';

    const [listRes, aclRes] = await Promise.all([
        fetch(`/api/admin/pages/${encodeURIComponent(slug)}/edit-allowlist`),
        fetch(`/api/admin/pages/${encodeURIComponent(slug)}/edit-acl`),
    ]);

    if (!listRes.ok) {
        const err = (await listRes.json().catch(() => ({}))) as { error?: string };
        if (listEl) listEl.innerHTML = `<div class="list-group-item text-danger small">${escapeHtml(err.error || `오류 (${listRes.status})`)}</div>`;
        return;
    }
    const data = await listRes.json() as { slug: string; items: AllowlistItem[] };
    if (aclRes.ok) {
        const aclData = await aclRes.json() as { slug: string; edit_acl: EditAcl | null };
        setAclLabel(aclData.edit_acl);
    }
    renderList(slug, data.items);
}

async function addToEditAllowlist(): Promise<void> {
    const slug = getInputSlug();
    if (!slug) {
        window.Swal?.fire({ icon: 'warning', title: '슬러그 미입력', text: '문서 슬러그를 입력하세요.' });
        return;
    }
    const input = document.getElementById('editAllowlistUserIdInput') as HTMLInputElement | null;
    const userId = input ? Number(input.value) : NaN;
    if (!Number.isInteger(userId) || userId <= 0) {
        window.Swal?.fire({ icon: 'warning', title: 'user_id 미입력', text: '양의 정수 user_id 를 입력하세요.' });
        return;
    }
    const res = await fetch(`/api/admin/pages/${encodeURIComponent(slug)}/edit-allowlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId }),
    });
    if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        window.Swal?.fire({ icon: 'error', title: '추가 실패', text: err.error || `오류 (${res.status})` });
        return;
    }
    if (input) input.value = '';
    await loadEditAllowlist();
}

window.loadEditAllowlist = loadEditAllowlist;
window.addToEditAllowlist = addToEditAllowlist;
