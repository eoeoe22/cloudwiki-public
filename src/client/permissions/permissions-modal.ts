/**
 * 권한 관리 모달 — 문서 도구 드롭다운의 "권한 관리" 항목에서 호출.
 *
 * 한 모달에서 처리하는 것:
 *  1) 현재 문서 단건: 잠금 / 비공개 / 편집 ACL
 *  2) 현재 문서 편집 허용 명단 (목록·추가·삭제)
 *  3) 하위 문서 일괄 적용 (잠금 / 비공개 / 편집 ACL)
 *  4) 기존 자동 규칙 목록·삭제
 *
 * 호출 API (모두 관리자 전용 — adminRoutes.use(requireAdmin)):
 *  - GET    /api/admin/pages/:slug/edit-acl
 *  - PUT    /api/admin/pages/:slug/edit-acl
 *  - PATCH  /api/admin/pages/:slug/flags
 *  - GET    /api/admin/pages/:slug/edit-allowlist
 *  - POST   /api/admin/pages/:slug/edit-allowlist
 *  - DELETE /api/admin/pages/:slug/edit-allowlist/:userId
 *  - GET    /api/admin/doc-setting-prefix-rules
 *  - DELETE /api/admin/doc-setting-prefix-rules/:id
 *  - GET    /api/admin/doc-setting-prefix-rules/subpages?prefix=<slug>
 *  - POST   /api/admin/doc-setting-prefix-rules/bulk-apply
 *
 * window.openPermissionsModal(slug) 으로만 노출 — 페이지 로드시 자동 실행되지 않는다.
 */

import '../utils/swal';

import { normalizeSlug } from '../utils/slug';

declare global {
    interface Window {
        openPermissionsModal?: (slug: string) => Promise<void>;
    }
}

type FlagValue = 0 | 1 | null;
type FlagAction = 'none' | 'on' | 'off';
type AclAction = 'none' | 'clear' | 'set';
type EditAclFlag = 'aged' | 'allowlist' | 'page_editor' | 'any_editor';
interface EditAcl { mode: 'or' | 'and'; flags: EditAclFlag[]; }

interface CurrentPage {
    id: number;
    slug: string;
    is_locked: 0 | 1;
    is_private: 0 | 1;
    edit_acl: EditAcl | null;
}

interface DocSettingRule {
    id: number;
    prefix: string;
    is_locked: FlagValue;
    is_private: FlagValue;
    edit_acl: string | null;
    created_at: number;
    created_by_name: string | null;
}

interface SubpageItem {
    id: number;
    slug: string;
    depth: number;
    is_locked: 0 | 1;
    is_private: 0 | 1;
    edit_acl: EditAcl | null;
}

interface AllowlistItem {
    user_id: number;
    name: string;
    picture: string | null;
    role: string;
    added_at: number;
    added_by_name: string | null;
}

interface RowState {
    id: number;
    slug: string;
    depth: number;
    is_locked: 0 | 1;
    is_private: 0 | 1;
    edit_acl: EditAcl | null;
    currentlyChecked: boolean;
    checkbox: HTMLInputElement;
}

interface ModalState {
    slug: string;
    prefix: string;
    rows: RowState[];
    page: CurrentPage | null;
    initialAcl: EditAcl | null;
}

const ACL_FLAG_LABELS: Record<EditAclFlag, string> = {
    aged: '가입 N일 이상',
    allowlist: '허용 명단 등재',
    page_editor: '본 문서 편집 이력',
    any_editor: '임의 문서 편집 이력',
};

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

function parseEditAclFromRaw(raw: string | null | undefined): EditAcl | null {
    if (!raw) return null;
    try {
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object' || !Array.isArray(obj.flags)) return null;
        const flags = obj.flags.filter((f: unknown): f is EditAclFlag =>
            f === 'aged' || f === 'allowlist' || f === 'page_editor' || f === 'any_editor'
        );
        if (flags.length === 0) return null;
        const mode: 'or' | 'and' = obj.mode === 'and' ? 'and' : 'or';
        return { mode, flags };
    } catch {
        return null;
    }
}

function aclSummary(acl: EditAcl | null): string {
    if (!acl || acl.flags.length === 0) return '비활성';
    const joiner = acl.mode === 'and' ? ' 그리고 ' : ' 또는 ';
    return acl.flags.map(f => ACL_FLAG_LABELS[f]).join(joiner);
}

function aclEqual(a: EditAcl | null, b: EditAcl | null): boolean {
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;
    if (a.mode !== b.mode) return false;
    if (a.flags.length !== b.flags.length) return false;
    const setA = new Set(a.flags);
    for (const f of b.flags) if (!setA.has(f)) return false;
    return true;
}

// ── API 헬퍼 ─────────────────────────────────────────────────────────

async function fetchCurrentPage(slug: string): Promise<CurrentPage | { error: string }> {
    // GET /api/w/:slug 는 pages 컬럼을 flat 으로 반환 ({ id, slug, is_locked, is_private, edit_acl, ... }).
    // edit_acl 은 raw JSON 문자열 — 호출 후 parseEditAclFromRaw 로 객체화한다.
    // 관리자 권한자만 모달을 열 수 있으므로 비공개 / 삭제 문서 조회도 통과한다.
    // redirect=no 필수: 리다이렉트 페이지에서 모달을 열 때 타겟 페이지 메타가 아닌
    // 호출 슬러그의 메타를 가져와야 한다 (저장은 원본 슬러그로 이루어지므로).
    const res = await fetch(`/api/w/${encodeURIComponent(slug)}?redirect=no&nocache=true`);
    if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { error: err.error || `문서 조회 실패 (${res.status})` };
    }
    const data = (await res.json()) as { id?: number; is_locked?: number; is_private?: number; edit_acl?: string | null };
    const id = Number(data.id);
    if (!Number.isFinite(id)) return { error: '문서 메타를 읽지 못했습니다.' };
    return {
        id,
        slug,
        is_locked: (data.is_locked ? 1 : 0) as 0 | 1,
        is_private: (data.is_private ? 1 : 0) as 0 | 1,
        edit_acl: parseEditAclFromRaw(data.edit_acl ?? null),
    };
}

async function fetchAclForSlug(slug: string): Promise<EditAcl | null> {
    const res = await fetch(`/api/admin/pages/${encodeURIComponent(slug)}/edit-acl`);
    if (!res.ok) return null;
    const data = (await res.json()) as { edit_acl: EditAcl | null };
    return data.edit_acl ?? null;
}

async function patchPageFlags(slug: string, body: { is_locked?: 0 | 1; is_private?: 0 | 1 }): Promise<{ ok: true; data: { is_locked: 0 | 1; is_private: 0 | 1 } } | { ok: false; error: string }> {
    const res = await fetch(`/api/admin/pages/${encodeURIComponent(slug)}/flags`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: err.error || `오류 (${res.status})` };
    }
    const data = (await res.json()) as { is_locked: 0 | 1; is_private: 0 | 1 };
    return { ok: true, data };
}

async function putPageEditAcl(slug: string, acl: EditAcl | null): Promise<{ ok: true; acl: EditAcl | null } | { ok: false; error: string }> {
    const res = await fetch(`/api/admin/pages/${encodeURIComponent(slug)}/edit-acl`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edit_acl: acl }),
    });
    if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: err.error || `오류 (${res.status})` };
    }
    const data = (await res.json()) as { edit_acl: EditAcl | null };
    return { ok: true, acl: data.edit_acl ?? null };
}

async function fetchAllowlist(slug: string): Promise<AllowlistItem[]> {
    const res = await fetch(`/api/admin/pages/${encodeURIComponent(slug)}/edit-allowlist`);
    if (!res.ok) return [];
    const data = (await res.json()) as { items: AllowlistItem[] };
    return Array.isArray(data.items) ? data.items : [];
}

async function addAllowlistUser(slug: string, userId: number): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch(`/api/admin/pages/${encodeURIComponent(slug)}/edit-allowlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId }),
    });
    if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: err.error || `오류 (${res.status})` };
    }
    return { ok: true };
}

async function removeAllowlistUser(slug: string, userId: number): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch(`/api/admin/pages/${encodeURIComponent(slug)}/edit-allowlist/${userId}`, { method: 'DELETE' });
    if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: err.error || `오류 (${res.status})` };
    }
    return { ok: true };
}

async function fetchRules(): Promise<DocSettingRule[]> {
    const res = await fetch('/api/admin/doc-setting-prefix-rules');
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as DocSettingRule[]) : [];
}

async function deleteRule(id: number): Promise<boolean> {
    const res = await fetch(`/api/admin/doc-setting-prefix-rules/${id}`, { method: 'DELETE' });
    return res.ok;
}

async function fetchSubpages(prefix: string): Promise<{ items: SubpageItem[] } | { error: string }> {
    const res = await fetch(`/api/admin/doc-setting-prefix-rules/subpages?prefix=${encodeURIComponent(prefix)}`);
    if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { error: err.error || `오류 (${res.status})` };
    }
    return (await res.json()) as { items: SubpageItem[] };
}

// ── HTML 빌더 ────────────────────────────────────────────────────────

function flagBadge(flag: 0 | 1, kind: 'lock' | 'private'): string {
    if (!flag) return '<span class="bulkcat-cat-chip" style="opacity: .4;">—</span>';
    if (kind === 'lock') {
        return '<span class="bulkcat-cat-chip is-danger" title="편집 잠금"><i class="mdi mdi-lock"></i> 잠금</span>';
    }
    return '<span class="bulkcat-cat-chip is-danger" title="비공개"><i class="mdi mdi-eye-off"></i> 비공개</span>';
}

function aclBadge(acl: EditAcl | null): string {
    if (!acl) return '<span class="bulkcat-cat-chip" style="opacity: .4;">—</span>';
    return `<span class="bulkcat-cat-chip" title="${escapeHtml(JSON.stringify(acl))}"><i class="mdi mdi-shield-account"></i> ${escapeHtml(acl.mode.toUpperCase())} · ${acl.flags.length}</span>`;
}

function ruleFlagLabel(v: FlagValue, kind: 'lock' | 'private'): string {
    if (v === null || v === undefined) return '<span style="opacity: .4;">—</span>';
    if (v === 1) return kind === 'lock'
        ? '<i class="mdi mdi-lock"></i> ON'
        : '<i class="mdi mdi-eye-off"></i> ON';
    return kind === 'lock'
        ? '<i class="mdi mdi-lock-open-variant"></i> OFF'
        : '<i class="mdi mdi-eye-outline"></i> OFF';
}

function ruleAclLabel(raw: string | null): string {
    const acl = parseEditAclFromRaw(raw);
    if (!acl) return '<span style="opacity: .4;">—</span>';
    return `<span title="${escapeHtml(JSON.stringify(acl))}"><i class="mdi mdi-shield-account"></i> ${escapeHtml(aclSummary(acl))}</span>`;
}

function rulesTableHtml(rules: DocSettingRule[]): string {
    if (rules.length === 0) {
        return '<div class="bulkcat-rules-empty">저장된 자동 규칙이 없습니다.</div>';
    }
    const rows = rules.map((r) => `
        <tr data-rule-id="${r.id}">
            <td class="text-break"><code>${escapeHtml(r.prefix)}/**</code></td>
            <td>${ruleFlagLabel(r.is_locked, 'lock')}</td>
            <td>${ruleFlagLabel(r.is_private, 'private')}</td>
            <td>${ruleAclLabel(r.edit_acl)}</td>
            <td class="text-end">
                <button type="button" class="btn btn-sm btn-wiki btn-wiki-danger perm-rule-delete">
                    <i class="mdi mdi-trash-can-outline"></i>
                </button>
            </td>
        </tr>
    `).join('');
    return `
        <table class="bulkcat-rules-table">
            <thead><tr><th>접두사</th><th>편집 잠금</th><th>비공개</th><th>편집 ACL</th><th aria-label="삭제"></th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

function aclFieldsetHtml(idPrefix: string, initialAcl: EditAcl | null, initiallyVisible: boolean): string {
    const mode = initialAcl?.mode ?? 'or';
    const flagSet = new Set(initialAcl?.flags ?? []);
    return `
        <fieldset class="perm-acl-fieldset" id="${idPrefix}Fieldset" style="border: 1px dashed var(--bs-border-color); padding: 8px 12px; border-radius: 6px; ${initiallyVisible ? '' : 'display: none;'}">
            <legend class="bulkcat-section-title" style="font-size: 0.85em; padding: 0 6px;">ACL 정의</legend>
            <div style="display: flex; align-items: center; gap: 14px; flex-wrap: wrap;">
                <label class="form-check-inline mb-0"><input class="form-check-input" type="radio" name="${idPrefix}Mode" value="or"${mode === 'or' ? ' checked' : ''}> <span class="ms-1">조건 중 하나 충족 (OR)</span></label>
                <label class="form-check-inline mb-0"><input class="form-check-input" type="radio" name="${idPrefix}Mode" value="and"${mode === 'and' ? ' checked' : ''}> <span class="ms-1">모든 조건 충족 (AND)</span></label>
            </div>
            <div style="display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 8px;">
                ${(Object.keys(ACL_FLAG_LABELS) as EditAclFlag[]).map(f => `
                    <label class="form-check-inline mb-0"><input class="form-check-input ${idPrefix}-flag" type="checkbox" value="${f}"${flagSet.has(f) ? ' checked' : ''}> <span class="ms-1">${ACL_FLAG_LABELS[f]}</span></label>
                `).join('')}
            </div>
            <small class="text-muted">가입일 임계값(N일)은 관리자 콘솔 &gt; 위키 설정의 <b>편집 ACL 가입 일수</b> 전역 설정을 따릅니다.</small>
        </fieldset>
    `;
}

function buildModalHtml(slug: string, page: CurrentPage | null, pageLoadError: string | null, rules: DocSettingRule[]): string {
    const currentSection = page
        ? `
            <div class="bulk-modal-inline-actions" style="gap: 1rem; margin-bottom: 0.6rem;">
                <label class="form-check mb-0">
                    <input class="form-check-input" type="checkbox" id="permCurLock"${page.is_locked ? ' checked' : ''}>
                    <span class="form-check-label fw-bold text-danger ms-1"><i class="mdi mdi-lock"></i> 편집 잠금</span>
                </label>
                <label class="form-check mb-0">
                    <input class="form-check-input" type="checkbox" id="permCurPrivate"${page.is_private ? ' checked' : ''}>
                    <span class="form-check-label fw-bold text-danger ms-1"><i class="mdi mdi-eye-off"></i> 비공개 (관리자만 열람)</span>
                </label>
            </div>
            <div role="radiogroup" aria-label="편집 ACL" style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 0.4rem;">
                <span style="min-width: 84px; font-weight: 600;"><i class="mdi mdi-shield-account"></i> 편집 ACL</span>
                <label class="form-check-inline mb-0"><input class="form-check-input" type="radio" name="permCurAclAction" value="none"${page.edit_acl ? '' : ' checked'}> <span class="ms-1">그대로</span></label>
                <label class="form-check-inline mb-0"><input class="form-check-input" type="radio" name="permCurAclAction" value="clear"> <span class="ms-1">비활성화</span></label>
                <label class="form-check-inline mb-0"><input class="form-check-input" type="radio" name="permCurAclAction" value="set"${page.edit_acl ? ' checked' : ''}> <span class="ms-1">아래 ACL 적용</span></label>
            </div>
            ${aclFieldsetHtml('permCurAcl', page.edit_acl, !!page.edit_acl)}
            <div class="bulk-modal-inline-actions" style="margin-top: 0.75rem; justify-content: flex-end;">
                <span id="permCurSaveStatus" class="bulkcat-counter"></span>
                <button type="button" class="btn btn-sm btn-wiki" id="permCurSaveBtn">
                    <i class="mdi mdi-content-save"></i> 현재 문서에 저장
                </button>
            </div>
        `
        : `<div class="bulkcat-warning">${escapeHtml(pageLoadError || '문서 메타 로드 실패')}</div>`;

    return `
        <div class="bulkcat-modal">
            <section class="bulkcat-section bulk-modal-section-card">
                <header class="bulkcat-section-head">
                    <h6 class="bulkcat-section-title">현재 문서</h6>
                    <span class="bulkcat-counter">단건 적용 — 즉시 반영</span>
                </header>
                ${currentSection}
            </section>

            <section class="bulkcat-section bulk-modal-section-card">
                <header class="bulkcat-section-head">
                    <h6 class="bulkcat-section-title">편집 허용 명단 (이 문서)</h6>
                    <span id="permAclStatusLabel" class="perm-acl-status is-off">ACL 비활성</span>
                </header>
                <div class="bulk-modal-inline-actions" style="gap: 0.4rem;">
                    <input type="number" min="1" inputmode="numeric" class="form-control form-control-sm" id="permAllowUserIdInput" placeholder="user_id (양의 정수)" style="max-width: 220px;">
                    <button type="button" class="btn btn-sm btn-wiki" id="permAllowAddBtn">
                        <i class="mdi mdi-account-plus"></i> 추가
                    </button>
                </div>
                <div class="perm-allow-list" id="permAllowList">
                    <div class="perm-allow-empty">불러오는 중…</div>
                </div>
            </section>

            <section class="bulkcat-section bulk-modal-section-card bulk-modal-section-muted">
                <header class="bulkcat-section-head">
                    <h6 class="bulkcat-section-title">하위 문서 일괄 적용</h6>
                    <span class="bulkcat-counter" id="permBulkCounter">불러오는 중…</span>
                </header>
                <div class="bulkcat-prefix-line">
                    <span class="bulkcat-prefix-label">prefix</span>
                    <code class="bulkcat-prefix-code">${escapeHtml(slug)}/**</code>
                </div>
                <div class="bulkcat-subpages-panel" id="permBulkPanel">
                    <div class="bulkcat-empty">불러오는 중…</div>
                </div>

                <div class="bulkcat-actions-row" style="display: flex; flex-direction: column; gap: 10px; margin-top: 0.5rem;">
                    <div role="radiogroup" aria-label="편집 잠금" style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                        <span style="min-width: 84px; font-weight: 600;"><i class="mdi mdi-lock"></i> 편집 잠금</span>
                        <label class="form-check-inline mb-0"><input class="form-check-input" type="radio" name="permBulkLockAction" value="none" checked> <span class="ms-1">그대로</span></label>
                        <label class="form-check-inline mb-0"><input class="form-check-input" type="radio" name="permBulkLockAction" value="on"> <span class="ms-1">잠금</span></label>
                        <label class="form-check-inline mb-0"><input class="form-check-input" type="radio" name="permBulkLockAction" value="off"> <span class="ms-1">잠금 해제</span></label>
                    </div>
                    <div role="radiogroup" aria-label="비공개" style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                        <span style="min-width: 84px; font-weight: 600;"><i class="mdi mdi-eye-off"></i> 비공개</span>
                        <label class="form-check-inline mb-0"><input class="form-check-input" type="radio" name="permBulkPrivateAction" value="none" checked> <span class="ms-1">그대로</span></label>
                        <label class="form-check-inline mb-0"><input class="form-check-input" type="radio" name="permBulkPrivateAction" value="on"> <span class="ms-1">비공개</span></label>
                        <label class="form-check-inline mb-0"><input class="form-check-input" type="radio" name="permBulkPrivateAction" value="off"> <span class="ms-1">공개</span></label>
                    </div>
                    <div role="radiogroup" aria-label="편집 ACL" style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                        <span style="min-width: 84px; font-weight: 600;"><i class="mdi mdi-shield-account"></i> 편집 ACL</span>
                        <label class="form-check-inline mb-0"><input class="form-check-input" type="radio" name="permBulkAclAction" value="none" checked> <span class="ms-1">그대로</span></label>
                        <label class="form-check-inline mb-0"><input class="form-check-input" type="radio" name="permBulkAclAction" value="clear"> <span class="ms-1">비활성화</span></label>
                        <label class="form-check-inline mb-0"><input class="form-check-input" type="radio" name="permBulkAclAction" value="set"> <span class="ms-1">아래 ACL 적용</span></label>
                    </div>
                    ${aclFieldsetHtml('permBulkAcl', null, false)}
                </div>
                <p class="bulkcat-section-hint">
                    체크된 하위 문서에만 위 액션이 적용됩니다. <b>그대로</b> 인 항목은 변경되지 않습니다.
                </p>
                <label class="bulkcat-persist-row">
                    <input class="form-check-input" type="checkbox" id="permBulkPersist">
                    <span>자동 규칙으로 저장 <span class="bulkcat-persist-sub">(이후 이 prefix 하위에 새로 만들어지는 문서에 자동 적용)</span></span>
                </label>
            </section>

            <section class="bulkcat-section bulk-modal-section-card">
                <header class="bulkcat-section-head">
                    <h6 class="bulkcat-section-title">기존 자동 규칙</h6>
                </header>
                <div class="bulkcat-rules-wrap" id="permRulesTable">${rulesTableHtml(rules)}</div>
            </section>
        </div>
    `;
}

// ── 섹션 1: 현재 문서 단건 ─────────────────────────────────────────

function readCurAclAction(): AclAction {
    const el = document.querySelector<HTMLInputElement>('input[name="permCurAclAction"]:checked');
    const v = el?.value;
    return v === 'set' || v === 'clear' ? v : 'none';
}

function readAclValueFrom(idPrefix: string): EditAcl | null {
    const modeEl = document.querySelector<HTMLInputElement>(`input[name="${idPrefix}Mode"]:checked`);
    const mode: 'or' | 'and' = modeEl?.value === 'and' ? 'and' : 'or';
    const flags: EditAclFlag[] = [];
    document.querySelectorAll<HTMLInputElement>(`.${idPrefix}-flag`).forEach((el) => {
        if (!el.checked) return;
        const v = el.value;
        if (v === 'aged' || v === 'allowlist' || v === 'page_editor' || v === 'any_editor') {
            flags.push(v);
        }
    });
    if (flags.length === 0) return null;
    return { mode, flags };
}

function toggleCurAclFieldset() {
    const fs = document.getElementById('permCurAclFieldset') as HTMLFieldSetElement | null;
    if (!fs) return;
    fs.style.display = readCurAclAction() === 'set' ? '' : 'none';
}

function setCurSaveStatus(text: string, kind: 'info' | 'ok' | 'err' = 'info') {
    const el = document.getElementById('permCurSaveStatus');
    if (!el) return;
    el.textContent = text;
    el.style.color = kind === 'err' ? 'var(--wiki-danger, #EF4444)'
        : kind === 'ok' ? 'var(--wiki-success, #10B981)'
        : 'var(--wiki-text-muted)';
}

async function saveCurrent(state: ModalState): Promise<void> {
    if (!state.page) return;
    const lockEl = document.getElementById('permCurLock') as HTMLInputElement | null;
    const privEl = document.getElementById('permCurPrivate') as HTMLInputElement | null;
    if (!lockEl || !privEl) return;

    const nextLock: 0 | 1 = lockEl.checked ? 1 : 0;
    const nextPriv: 0 | 1 = privEl.checked ? 1 : 0;

    const aclAction = readCurAclAction();
    let nextAcl: EditAcl | null = state.page.edit_acl;
    if (aclAction === 'clear') nextAcl = null;
    else if (aclAction === 'set') {
        nextAcl = readAclValueFrom('permCurAcl');
        if (!nextAcl) {
            setCurSaveStatus("'아래 ACL 적용' 을 선택했지만 플래그가 비어 있습니다.", 'err');
            return;
        }
    }

    const lockChanged = nextLock !== state.page.is_locked;
    const privChanged = nextPriv !== state.page.is_private;
    const flagsChanged = lockChanged || privChanged;
    const aclChanged = aclAction !== 'none' && !aclEqual(nextAcl, state.page.edit_acl);

    if (!flagsChanged && !aclChanged) {
        setCurSaveStatus('변경 사항이 없습니다.', 'info');
        return;
    }

    setCurSaveStatus('저장 중…', 'info');
    const tasks: Promise<{ ok: boolean; error?: string }>[] = [];
    if (flagsChanged) {
        // PATCH 본문은 실제로 바뀐 키만 포함해, 모달이 열려 있는 동안 다른 관리자가
        // 동시 갱신한 다른 플래그를 stale snapshot 으로 덮어쓰지 않도록 한다.
        // 백엔드 (admin.ts PATCH /pages/:slug/flags) 는 누락 키를 그대로 유지한다.
        const patchBody: { is_locked?: 0 | 1; is_private?: 0 | 1 } = {};
        if (lockChanged) patchBody.is_locked = nextLock;
        if (privChanged) patchBody.is_private = nextPriv;
        tasks.push(patchPageFlags(state.slug, patchBody).then(r => r.ok ? { ok: true } : { ok: false, error: r.error }));
    }
    if (aclChanged) {
        tasks.push(putPageEditAcl(state.slug, nextAcl).then(r => r.ok ? { ok: true } : { ok: false, error: r.error }));
    }

    const results = await Promise.all(tasks);
    const failed = results.find(r => !r.ok);
    if (failed) {
        setCurSaveStatus(`저장 실패: ${failed.error}`, 'err');
        return;
    }

    if (lockChanged) state.page.is_locked = nextLock;
    if (privChanged) state.page.is_private = nextPriv;
    if (aclAction !== 'none') state.page.edit_acl = nextAcl;
    setCurSaveStatus('저장됨', 'ok');
    refreshAclStatusLabel(state.page.edit_acl);

    // 토스트 — SweetAlert2
    const swal = window.Swal;
    swal?.fire({ icon: 'success', title: '저장됨', toast: true, position: 'top-end', timer: 1800, showConfirmButton: false });
}

// ── 섹션 2: 편집 허용 명단 ─────────────────────────────────────────

function refreshAclStatusLabel(acl: EditAcl | null): void {
    const el = document.getElementById('permAclStatusLabel');
    if (!el) return;
    if (!acl || acl.flags.length === 0) {
        el.className = 'perm-acl-status is-off';
        el.textContent = 'ACL 비활성';
        return;
    }
    const hasAllowlist = acl.flags.includes('allowlist');
    el.className = hasAllowlist ? 'perm-acl-status is-on' : 'perm-acl-status is-warn';
    el.title = JSON.stringify(acl);
    const summary = aclSummary(acl);
    el.textContent = hasAllowlist ? `ACL: ${summary}` : `ACL: ${summary} (allowlist 비활성)`;
}

function renderAllowlist(state: ModalState, items: AllowlistItem[]): void {
    const el = document.getElementById('permAllowList');
    if (!el) return;
    if (items.length === 0) {
        el.innerHTML = '<div class="perm-allow-empty">아직 추가된 사용자가 없습니다.</div>';
        return;
    }
    el.innerHTML = items.map((it) => {
        const role = ROLE_LABELS[it.role] || it.role;
        const added = new Date(it.added_at * 1000).toLocaleString();
        const addedBy = it.added_by_name ? ` · ${escapeHtml(it.added_by_name)}` : '';
        const avatar = it.picture
            ? `<img src="${escapeHtml(it.picture)}" alt="" style="width:24px;height:24px;border-radius:50%;object-fit:cover;flex-shrink:0;">`
            : '<i class="mdi mdi-account-circle" style="font-size: 24px; flex-shrink: 0;"></i>';
        return `
            <div class="perm-allow-item" data-user-id="${it.user_id}">
                ${avatar}
                <div class="perm-allow-item-meta">
                    <div class="name">${escapeHtml(it.name)} <small class="text-muted">#${it.user_id}</small></div>
                    <div class="sub">${escapeHtml(role)} · ${escapeHtml(added)}${addedBy}</div>
                </div>
                <button type="button" class="btn btn-sm btn-outline-danger perm-allow-remove" data-user-id="${it.user_id}">
                    <i class="mdi mdi-trash-can-outline"></i>
                </button>
            </div>
        `;
    }).join('');

    el.querySelectorAll<HTMLButtonElement>('.perm-allow-remove').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const uid = Number(btn.dataset.userId);
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
            const res = await removeAllowlistUser(state.slug, uid);
            if (!res.ok) {
                swal?.fire({ icon: 'error', title: '삭제 실패', text: res.error });
                return;
            }
            await reloadAllowlist(state);
        });
    });
}

async function reloadAllowlist(state: ModalState): Promise<void> {
    const items = await fetchAllowlist(state.slug);
    renderAllowlist(state, items);
}

async function addAllowlist(state: ModalState): Promise<void> {
    const input = document.getElementById('permAllowUserIdInput') as HTMLInputElement | null;
    const userId = input ? Number(input.value) : NaN;
    const swal = window.Swal;
    if (!Number.isInteger(userId) || userId <= 0) {
        swal?.fire({ icon: 'warning', title: 'user_id 미입력', text: '양의 정수 user_id 를 입력하세요.' });
        return;
    }
    const res = await addAllowlistUser(state.slug, userId);
    if (!res.ok) {
        swal?.fire({ icon: 'error', title: '추가 실패', text: res.error });
        return;
    }
    if (input) input.value = '';
    await reloadAllowlist(state);
}

// ── 섹션 3: 하위 일괄 적용 ─────────────────────────────────────────

function readBulkLockAction(): FlagAction {
    const el = document.querySelector<HTMLInputElement>('input[name="permBulkLockAction"]:checked');
    const v = el?.value;
    return v === 'on' || v === 'off' ? v : 'none';
}
function readBulkPrivateAction(): FlagAction {
    const el = document.querySelector<HTMLInputElement>('input[name="permBulkPrivateAction"]:checked');
    const v = el?.value;
    return v === 'on' || v === 'off' ? v : 'none';
}
function readBulkAclAction(): AclAction {
    const el = document.querySelector<HTMLInputElement>('input[name="permBulkAclAction"]:checked');
    const v = el?.value;
    return v === 'set' || v === 'clear' ? v : 'none';
}
function toggleBulkAclFieldset() {
    const fs = document.getElementById('permBulkAclFieldset') as HTMLFieldSetElement | null;
    if (!fs) return;
    fs.style.display = readBulkAclAction() === 'set' ? '' : 'none';
}

function actionToTarget(a: FlagAction): 0 | 1 | null {
    return a === 'on' ? 1 : a === 'off' ? 0 : null;
}

function targetAclForRow(row: RowState, action: AclAction, aclVal: EditAcl | null): EditAcl | null {
    if (action === 'none') return row.edit_acl;
    if (action === 'clear') return null;
    return aclVal;
}

function updateBulkMaster(state: ModalState): void {
    const master = document.getElementById('permBulkMaster') as HTMLInputElement | null;
    if (!master) return;
    if (state.rows.length === 0) {
        master.checked = false;
        master.indeterminate = false;
        master.disabled = true;
        return;
    }
    master.disabled = false;
    const checked = state.rows.filter(r => r.currentlyChecked).length;
    if (checked === 0) {
        master.checked = false; master.indeterminate = false;
    } else if (checked === state.rows.length) {
        master.checked = true; master.indeterminate = false;
    } else {
        master.checked = false; master.indeterminate = true;
    }
}

function updateBulkCounter(state: ModalState): void {
    const counter = document.getElementById('permBulkCounter');
    if (counter) {
        if (state.rows.length === 0) {
            counter.textContent = '하위 문서 없음';
        } else {
            const lockA = readBulkLockAction();
            const privA = readBulkPrivateAction();
            const aclA = readBulkAclAction();
            const aclV = aclA === 'set' ? readAclValueFrom('permBulkAcl') : null;
            const targetLock = actionToTarget(lockA);
            const targetPriv = actionToTarget(privA);
            const checked = state.rows.filter(r => r.currentlyChecked).length;
            let changeCount = 0;
            for (const r of state.rows) {
                if (!r.currentlyChecked) continue;
                const newLock = targetLock === null ? r.is_locked : targetLock;
                const newPriv = targetPriv === null ? r.is_private : targetPriv;
                const newAcl = targetAclForRow(r, aclA, aclV);
                if (newLock !== r.is_locked || newPriv !== r.is_private || !aclEqual(newAcl, r.edit_acl)) changeCount++;
            }
            counter.textContent = `체크 ${checked} / ${state.rows.length} (변경 +${changeCount})`;
        }
    }
    updateBulkMaster(state);
}

function setAllBulkRows(state: ModalState, checked: boolean): void {
    for (const row of state.rows) {
        row.currentlyChecked = checked;
        row.checkbox.checked = checked;
        const tr = row.checkbox.closest<HTMLTableRowElement>('tr[data-page-id]');
        tr?.classList.add('bulkcat-row-touched');
    }
    updateBulkCounter(state);
}

function renderBulkSubpages(items: SubpageItem[], prefix: string): string {
    if (items.length === 0) {
        return '<div class="bulkcat-empty">선택 가능한 하위 문서가 없습니다.</div>';
    }
    const prefixWithSlash = prefix + '/';
    const rows = items.map((item) => {
        const display = item.slug.startsWith(prefixWithSlash) ? item.slug.slice(prefixWithSlash.length) : item.slug;
        const flags = `${flagBadge(item.is_locked, 'lock')} ${flagBadge(item.is_private, 'private')} ${aclBadge(item.edit_acl)}`;
        return `
            <tr data-page-id="${item.id}" style="--bulkcat-depth: ${item.depth};">
                <td>
                    <label class="bulkcat-row-label">
                        <input type="checkbox" class="form-check-input perm-bulk-checkbox" data-page-id="${item.id}">
                        <code class="bulkcat-slug">${escapeHtml(display)}</code>
                    </label>
                </td>
                <td class="bulkcat-row-cats-cell">${flags}</td>
            </tr>
        `;
    }).join('');
    const warning = items.length > 500
        ? `<div class="bulkcat-warning">총 ${items.length}개 — 많을 경우 브라우저가 느려질 수 있습니다.</div>`
        : '';
    return `
        ${warning}
        <div class="bulkcat-master-row">
            <label class="bulkcat-master-label">
                <input type="checkbox" class="form-check-input bulkcat-master-checkbox" id="permBulkMaster">
                <span class="bulkcat-master-text">전체</span>
            </label>
            <span class="bulkcat-master-count">${items.length}개</span>
        </div>
        <table class="bulkcat-subpages-table"><tbody>${rows}</tbody></table>
    `;
}

async function loadBulkTree(state: ModalState): Promise<void> {
    const panel = document.getElementById('permBulkPanel');
    if (!panel) return;
    const res = await fetchSubpages(state.prefix);
    if ('error' in res) {
        panel.innerHTML = `<div class="bulkcat-warning">${escapeHtml(res.error)}</div>`;
        const counter = document.getElementById('permBulkCounter');
        if (counter) counter.textContent = '불러오기 실패';
        return;
    }
    panel.innerHTML = renderBulkSubpages(res.items, state.prefix);

    const master = panel.querySelector<HTMLInputElement>('#permBulkMaster');
    master?.addEventListener('change', () => setAllBulkRows(state, master.checked));

    state.rows.length = 0;
    for (const item of res.items) {
        const cb = panel.querySelector<HTMLInputElement>(`input.perm-bulk-checkbox[data-page-id="${item.id}"]`);
        if (!cb) continue;
        const row: RowState = {
            id: item.id,
            slug: item.slug,
            depth: item.depth,
            is_locked: item.is_locked,
            is_private: item.is_private,
            edit_acl: item.edit_acl,
            currentlyChecked: false,
            checkbox: cb,
        };
        cb.addEventListener('change', () => {
            row.currentlyChecked = cb.checked;
            const tr = cb.closest<HTMLTableRowElement>('tr[data-page-id]');
            tr?.classList.add('bulkcat-row-touched');
            updateBulkCounter(state);
        });
        state.rows.push(row);
    }
    updateBulkCounter(state);
}

// ── 섹션 4: 자동 규칙 표 ─────────────────────────────────────────

function hookRuleDeleteButtons(container: HTMLElement) {
    container.querySelectorAll<HTMLButtonElement>('.perm-rule-delete').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const row = btn.closest<HTMLTableRowElement>('tr[data-rule-id]');
            if (!row) return;
            const id = Number(row.dataset.ruleId);
            if (!Number.isFinite(id)) return;
            const swal = window.Swal;
            const confirm = await swal?.fire({
                title: '규칙 삭제',
                text: '이 자동 규칙을 삭제하시겠습니까? (이미 적용된 플래그는 그대로 유지됩니다)',
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: '삭제',
                cancelButtonText: '취소',
                confirmButtonColor: '#EF4444',
            });
            if (!confirm?.isConfirmed) return;
            const ok = await deleteRule(id);
            if (!ok) {
                swal?.fire({ icon: 'error', title: '삭제 실패', toast: true, position: 'top-end', timer: 2500, showConfirmButton: false });
                return;
            }
            const rules = await fetchRules();
            container.innerHTML = rulesTableHtml(rules);
            hookRuleDeleteButtons(container);
        });
    });
}

// ── 진입점 ───────────────────────────────────────────────────────

export async function openPermissionsModal(rawSlug: string): Promise<void> {
    const swal = window.Swal;
    if (!swal) return;
    const slug = normalizeSlug(rawSlug || '');
    if (!slug) {
        await swal.fire({ icon: 'warning', title: '대상 문서 없음', text: '슬러그를 확인할 수 없습니다.' });
        return;
    }

    const [pageRes, rules] = await Promise.all([
        fetchCurrentPage(slug),
        fetchRules().catch(() => [] as DocSettingRule[]),
    ]);

    let page: CurrentPage | null = null;
    let pageLoadError: string | null = null;
    if ('error' in pageRes) {
        pageLoadError = pageRes.error;
    } else {
        page = pageRes;
        // edit-acl 은 관리자 전용 응답이 정답 — GET /api/w/:slug 의 edit_acl 은 admin 전용 표면이 아닐 수 있어 보완.
        const acl = await fetchAclForSlug(slug).catch(() => page!.edit_acl);
        page.edit_acl = acl;
    }

    const state: ModalState = {
        slug,
        prefix: slug,
        rows: [],
        page,
        initialAcl: page?.edit_acl ?? null,
    };

    const result = await swal.fire({
        title: `권한 관리 — ${slug}`,
        html: buildModalHtml(slug, page, pageLoadError, rules),
        width: 820,
        showCancelButton: true,
        confirmButtonText: '하위 일괄 적용',
        cancelButtonText: '닫기',
        focusConfirm: false,
        didOpen: () => {
            refreshAclStatusLabel(state.page?.edit_acl ?? null);

            // 섹션 1: 현재 문서
            document.querySelectorAll<HTMLInputElement>('input[name="permCurAclAction"]').forEach((el) => {
                el.addEventListener('change', toggleCurAclFieldset);
            });
            toggleCurAclFieldset();
            document.getElementById('permCurSaveBtn')?.addEventListener('click', () => { void saveCurrent(state); });

            // 섹션 2: 명단
            document.getElementById('permAllowAddBtn')?.addEventListener('click', () => { void addAllowlist(state); });
            const userIdInput = document.getElementById('permAllowUserIdInput') as HTMLInputElement | null;
            userIdInput?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); void addAllowlist(state); }
            });
            void reloadAllowlist(state);

            // 섹션 3: 일괄
            document.querySelectorAll<HTMLInputElement>(
                'input[name="permBulkLockAction"], input[name="permBulkPrivateAction"], input[name="permBulkAclAction"], input[name="permBulkAclMode"]'
            ).forEach((el) => el.addEventListener('change', () => updateBulkCounter(state)));
            document.querySelectorAll<HTMLInputElement>('input[name="permBulkAclAction"]').forEach((el) => {
                el.addEventListener('change', toggleBulkAclFieldset);
            });
            document.querySelectorAll<HTMLInputElement>('.permBulkAcl-flag').forEach((el) => {
                el.addEventListener('change', () => updateBulkCounter(state));
            });
            toggleBulkAclFieldset();
            void loadBulkTree(state);

            // 섹션 4: 규칙 표
            const tableEl = document.getElementById('permRulesTable');
            if (tableEl) hookRuleDeleteButtons(tableEl);
        },
        preConfirm: () => {
            const lockAction = readBulkLockAction();
            const privateAction = readBulkPrivateAction();
            const aclAction = readBulkAclAction();
            const aclValue = aclAction === 'set' ? readAclValueFrom('permBulkAcl') : null;
            const persistEl = document.getElementById('permBulkPersist') as HTMLInputElement | null;
            const persist = !!persistEl?.checked;

            if (aclAction === 'set' && !aclValue) {
                swal.showValidationMessage("편집 ACL '아래 ACL 적용'을 선택했지만 플래그가 비어 있습니다.");
                return false;
            }

            const targetLock = actionToTarget(lockAction);
            const targetPriv = actionToTarget(privateAction);
            const ids: number[] = [];
            for (const r of state.rows) {
                if (!r.currentlyChecked) continue;
                const newLock = targetLock === null ? r.is_locked : targetLock;
                const newPriv = targetPriv === null ? r.is_private : targetPriv;
                const newAcl = aclAction === 'none' ? r.edit_acl : aclAction === 'clear' ? null : aclValue;
                if (newLock !== r.is_locked || newPriv !== r.is_private || !aclEqual(newAcl, r.edit_acl)) ids.push(r.id);
            }

            const willApply = ids.length > 0;
            const anyAction = lockAction !== 'none' || privateAction !== 'none' || aclAction !== 'none';

            if (!willApply && !persist) {
                swal.showValidationMessage('적용할 하위 문서를 선택하거나 "자동 규칙으로 저장"을 선택해주세요.');
                return false;
            }
            if (willApply && !anyAction) {
                swal.showValidationMessage('편집 잠금/비공개/편집 ACL 중 하나 이상의 액션을 선택해주세요.');
                return false;
            }
            if (persist) {
                const persistHasLock = lockAction !== 'none';
                const persistHasPriv = privateAction !== 'none';
                const persistHasAcl = aclAction === 'set';
                if (!persistHasLock && !persistHasPriv && !persistHasAcl) {
                    swal.showValidationMessage('자동 규칙을 저장하려면 편집 잠금/비공개/편집 ACL 중 하나 이상을 지정해야 합니다.');
                    return false;
                }
            }

            return { prefix: state.prefix, lockAction, privateAction, aclAction, aclValue, ids, persist, willApply };
        },
    });

    if (!result.isConfirmed || !result.value) return;
    const { prefix, lockAction, privateAction, aclAction, aclValue, ids, persist, willApply } = result.value as {
        prefix: string; lockAction: FlagAction; privateAction: FlagAction; aclAction: AclAction;
        aclValue: EditAcl | null; ids: number[]; persist: boolean; willApply: boolean;
    };

    try {
        const res = await fetch('/api/admin/doc-setting-prefix-rules/bulk-apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prefix, lockAction, privateAction, aclAction, aclValue, ids, persist }),
        });
        if (!res.ok) {
            const err = (await res.json().catch(() => ({}))) as { error?: string };
            await swal.fire({ icon: 'error', title: '실패', text: err.error || `오류 (${res.status})` });
            return;
        }
        const data = (await res.json()) as { scanned: number; requested: number; changed: number; ruleSaved: boolean };
        const changeMsg = willApply
            ? `대상 ${data.scanned}개 중 <b>${data.changed}개</b> 변경되었습니다.`
            : '';
        const ruleMsg = data.ruleSaved
            ? (changeMsg ? '<br>자동 규칙도 함께 저장되었습니다.' : '자동 규칙이 저장되었습니다.')
            : '';
        await swal.fire({ icon: 'success', title: '적용 완료', html: changeMsg + ruleMsg || '변경 사항이 없습니다.' });
    } catch (e) {
        console.error('permissions modal bulk-apply failed', e);
        await swal.fire({ icon: 'error', title: '네트워크 오류', text: String(e) });
    }
}

window.openPermissionsModal = openPermissionsModal;
