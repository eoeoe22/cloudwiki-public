/**
 * 하위 문서 일괄 설정 관리 모달 — pages.is_locked / is_private 일괄 토글.
 *
 * - public/edit.html 의 #docSettingsBtn 클릭 시 SweetAlert2 모달을 띄운다.
 * - 관리자 전용. 백엔드(/api/admin/doc-setting-prefix-rules*) 도 admin:access 로 보호된다.
 * - 모달은 현재 편집 중인 문서의 슬러그를 prefix 로 사용해 하위 문서 트리를 펼치고,
 *   각 행에 체크박스를 두어 선택한 행에 두 플래그를 일괄 적용한다.
 * - "적용할 설정" 섹션의 두 segmented radio (편집 잠금 / 비공개) 가 각각
 *   '그대로 | 켜기 | 끄기' 액션을 결정한다. 액션='none' 인 플래그는 변경하지 않는다.
 * - 자동 규칙으로 저장하면 이후 prefix 하위에 새 문서가 만들어질 때 강제 적용된다.
 *
 * UI 마크업은 bulk-category.ts 의 .bulkcat-* 클래스를 그대로 재사용한다.
 */

import '../utils/swal';

import { normalizeSlug } from '../utils/slug';

type FlagValue = 0 | 1 | null;
type FlagAction = 'none' | 'on' | 'off';

type EditAclFlag = 'aged' | 'allowlist' | 'page_editor' | 'any_editor';
interface EditAcl { mode: 'or' | 'and'; flags: EditAclFlag[]; }
type AclAction = 'none' | 'clear' | 'set';

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

interface SubpagesResponse {
    prefix: string;
    scanned: number;
    items: SubpageItem[];
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

interface DocSettingsModalState {
    prefix: string;
    rows: RowState[];
    getLockAction: () => FlagAction;
    getPrivateAction: () => FlagAction;
    getAclAction: () => AclAction;
    getAclValue: () => EditAcl | null;
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

const ACL_FLAG_LABELS: Record<EditAclFlag, string> = {
    aged: '가입 N일 이상',
    allowlist: '허용 명단 등재',
    page_editor: '본 문서 편집 이력',
    any_editor: '임의 문서 편집 이력',
};

function aclSummary(acl: EditAcl | null): string {
    if (!acl || acl.flags.length === 0) return '비활성';
    const joiner = acl.mode === 'and' ? ' 그리고 ' : ' 또는 ';
    return acl.flags.map(f => ACL_FLAG_LABELS[f]).join(joiner);
}

function escapeHtml(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getCurrentSlug(): string {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('slug');
    return raw ? normalizeSlug(raw) : '';
}

async function fetchRules(): Promise<DocSettingRule[]> {
    const res = await fetch('/api/admin/doc-setting-prefix-rules');
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as DocSettingRule[]) : [];
}

async function fetchSubpages(prefix: string): Promise<SubpagesResponse | { error: string }> {
    const res = await fetch(`/api/admin/doc-setting-prefix-rules/subpages?prefix=${encodeURIComponent(prefix)}`);
    if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { error: err.error || `오류 (${res.status})` };
    }
    return (await res.json()) as SubpagesResponse;
}

function flagBadge(flag: 0 | 1, kind: 'lock' | 'private'): string {
    if (!flag) return '<span class="bulkcat-cat-chip" style="opacity: .4;">—</span>';
    if (kind === 'lock') {
        return '<span class="bulkcat-cat-chip" title="편집 잠금"><i class="mdi mdi-lock"></i> 잠금</span>';
    }
    return '<span class="bulkcat-cat-chip" title="비공개"><i class="mdi mdi-eye-off"></i> 비공개</span>';
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
    const rows = rules
        .map(
            (r) => `
            <tr data-rule-id="${r.id}">
                <td class="text-break"><code>${escapeHtml(r.prefix)}/**</code></td>
                <td>${ruleFlagLabel(r.is_locked, 'lock')}</td>
                <td>${ruleFlagLabel(r.is_private, 'private')}</td>
                <td>${ruleAclLabel(r.edit_acl)}</td>
                <td class="text-end">
                    <button type="button" class="btn btn-sm btn-wiki btn-wiki-danger docset-rule-delete">
                        <i class="mdi mdi-trash-can-outline"></i>
                    </button>
                </td>
            </tr>`
        )
        .join('');
    return `
        <table class="bulkcat-rules-table">
            <thead>
                <tr><th>접두사</th><th>편집 잠금</th><th>비공개</th><th>편집 ACL</th><th aria-label="삭제"></th></tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

function buildModalHtml(currentSlug: string, rules: DocSettingRule[]): string {
    return `
        <div class="bulkcat-modal">
            <section class="bulkcat-section">
                <header class="bulkcat-section-head">
                    <h6 class="bulkcat-section-title">대상 하위 문서</h6>
                    <span class="bulkcat-counter" id="docSetCounter">불러오는 중…</span>
                </header>
                <div class="bulkcat-prefix-line">
                    <span class="bulkcat-prefix-label">prefix</span>
                    <code class="bulkcat-prefix-code">${escapeHtml(currentSlug)}/**</code>
                </div>
                <div class="bulkcat-subpages-panel" id="docSetSubpagesPanel">
                    <div class="bulkcat-empty">불러오는 중…</div>
                </div>
            </section>

            <section class="bulkcat-section">
                <header class="bulkcat-section-head">
                    <h6 class="bulkcat-section-title">적용할 설정</h6>
                </header>
                <div class="bulkcat-actions-row" style="display: flex; flex-direction: column; gap: 10px;">
                    <div role="radiogroup" aria-label="편집 잠금" style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                        <span style="min-width: 84px; font-weight: 600;">
                            <i class="mdi mdi-lock"></i> 편집 잠금
                        </span>
                        <label class="form-check-inline mb-0">
                            <input class="form-check-input" type="radio" name="docSetLockAction" value="none" checked>
                            <span class="ms-1">그대로</span>
                        </label>
                        <label class="form-check-inline mb-0">
                            <input class="form-check-input" type="radio" name="docSetLockAction" value="on">
                            <span class="ms-1">잠금</span>
                        </label>
                        <label class="form-check-inline mb-0">
                            <input class="form-check-input" type="radio" name="docSetLockAction" value="off">
                            <span class="ms-1">잠금 해제</span>
                        </label>
                    </div>
                    <div role="radiogroup" aria-label="비공개" style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                        <span style="min-width: 84px; font-weight: 600;">
                            <i class="mdi mdi-eye-off"></i> 비공개
                        </span>
                        <label class="form-check-inline mb-0">
                            <input class="form-check-input" type="radio" name="docSetPrivateAction" value="none" checked>
                            <span class="ms-1">그대로</span>
                        </label>
                        <label class="form-check-inline mb-0">
                            <input class="form-check-input" type="radio" name="docSetPrivateAction" value="on">
                            <span class="ms-1">비공개</span>
                        </label>
                        <label class="form-check-inline mb-0">
                            <input class="form-check-input" type="radio" name="docSetPrivateAction" value="off">
                            <span class="ms-1">공개</span>
                        </label>
                    </div>
                    <div role="radiogroup" aria-label="편집 ACL" style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                        <span style="min-width: 84px; font-weight: 600;">
                            <i class="mdi mdi-shield-account"></i> 편집 ACL
                        </span>
                        <label class="form-check-inline mb-0">
                            <input class="form-check-input" type="radio" name="docSetAclAction" value="none" checked>
                            <span class="ms-1">그대로</span>
                        </label>
                        <label class="form-check-inline mb-0">
                            <input class="form-check-input" type="radio" name="docSetAclAction" value="clear">
                            <span class="ms-1">비활성화</span>
                        </label>
                        <label class="form-check-inline mb-0">
                            <input class="form-check-input" type="radio" name="docSetAclAction" value="set">
                            <span class="ms-1">아래 ACL 적용</span>
                        </label>
                    </div>
                    <fieldset class="docset-acl-fieldset" id="docSetAclFieldset" style="border: 1px dashed var(--bs-border-color); padding: 8px 12px; border-radius: 6px; display: none;">
                        <legend class="bulkcat-section-title" style="font-size: 0.85em; padding: 0 6px;">ACL 정의</legend>
                        <div style="display: flex; align-items: center; gap: 14px; flex-wrap: wrap;">
                            <label class="form-check-inline mb-0">
                                <input class="form-check-input" type="radio" name="docSetAclMode" value="or" checked>
                                <span class="ms-1">조건 중 하나 충족 (OR)</span>
                            </label>
                            <label class="form-check-inline mb-0">
                                <input class="form-check-input" type="radio" name="docSetAclMode" value="and">
                                <span class="ms-1">모든 조건 충족 (AND)</span>
                            </label>
                        </div>
                        <div style="display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 8px;">
                            <label class="form-check-inline mb-0"><input class="form-check-input docset-acl-flag" type="checkbox" value="aged"> <span class="ms-1">가입 N일 이상</span></label>
                            <label class="form-check-inline mb-0"><input class="form-check-input docset-acl-flag" type="checkbox" value="allowlist"> <span class="ms-1">허용 명단 등재</span></label>
                            <label class="form-check-inline mb-0"><input class="form-check-input docset-acl-flag" type="checkbox" value="page_editor"> <span class="ms-1">본 문서 편집 이력</span></label>
                            <label class="form-check-inline mb-0"><input class="form-check-input docset-acl-flag" type="checkbox" value="any_editor"> <span class="ms-1">임의 문서 편집 이력</span></label>
                        </div>
                        <small class="text-muted">가입일 임계값(N일)은 관리자 콘솔 &gt; 위키 설정의 <b>편집 ACL 가입 일수</b> 전역 설정을 따릅니다.</small>
                    </fieldset>
                </div>
                <p class="bulkcat-section-hint">
                    체크된 문서에만 위 액션이 적용됩니다. <b>그대로</b> 인 항목은 변경되지 않습니다.
                </p>
                <label class="bulkcat-persist-row">
                    <input class="form-check-input" type="checkbox" id="docSetPersist">
                    <span>자동 규칙으로 저장 <span class="bulkcat-persist-sub">(이후 이 prefix 하위에 새로 만들어지는 문서에 자동 적용)</span></span>
                </label>
            </section>

            <section class="bulkcat-section">
                <header class="bulkcat-section-head">
                    <h6 class="bulkcat-section-title">기존 자동 규칙</h6>
                </header>
                <div class="bulkcat-rules-wrap" id="docSetRulesTable">${rulesTableHtml(rules)}</div>
            </section>
        </div>
    `;
}

async function deleteRule(id: number): Promise<boolean> {
    const res = await fetch(`/api/admin/doc-setting-prefix-rules/${id}`, { method: 'DELETE' });
    return res.ok;
}

async function refreshRulesTable(container: HTMLElement) {
    const rules = await fetchRules();
    container.innerHTML = rulesTableHtml(rules);
    hookRuleDeleteButtons(container);
}

function hookRuleDeleteButtons(container: HTMLElement) {
    container.querySelectorAll<HTMLButtonElement>('.docset-rule-delete').forEach((btn) => {
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
            await refreshRulesTable(container);
        });
    });
}

function aclBadge(acl: EditAcl | null): string {
    if (!acl) return '<span class="bulkcat-cat-chip" style="opacity: .4;">—</span>';
    return `<span class="bulkcat-cat-chip" title="${escapeHtml(JSON.stringify(acl))}"><i class="mdi mdi-shield-account"></i> ${escapeHtml(acl.mode.toUpperCase())} · ${acl.flags.length}</span>`;
}

function renderSubpagesTable(items: SubpageItem[], prefix: string): { panelHtml: string } {
    if (items.length === 0) {
        return { panelHtml: '<div class="bulkcat-empty">선택 가능한 하위 문서가 없습니다.</div>' };
    }
    const prefixWithSlash = prefix + '/';
    const tbodyRows = items.map((item) => {
        const display = item.slug.startsWith(prefixWithSlash) ? item.slug.slice(prefixWithSlash.length) : item.slug;
        const flags = `${flagBadge(item.is_locked, 'lock')} ${flagBadge(item.is_private, 'private')} ${aclBadge(item.edit_acl)}`;
        return `
            <tr data-page-id="${item.id}" style="--bulkcat-depth: ${item.depth};">
                <td>
                    <label class="bulkcat-row-label">
                        <input type="checkbox" class="form-check-input docset-checkbox" data-page-id="${item.id}">
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

    return {
        panelHtml: `
            ${warning}
            <div class="bulkcat-master-row">
                <label class="bulkcat-master-label">
                    <input type="checkbox" class="form-check-input bulkcat-master-checkbox" id="docSetMasterCheckbox">
                    <span class="bulkcat-master-text">전체</span>
                </label>
                <span class="bulkcat-master-count">${items.length}개</span>
            </div>
            <table class="bulkcat-subpages-table">
                <tbody>${tbodyRows}</tbody>
            </table>
        `,
    };
}

function updateMasterCheckbox(state: DocSettingsModalState): void {
    const master = document.getElementById('docSetMasterCheckbox') as HTMLInputElement | null;
    if (!master) return;
    if (state.rows.length === 0) {
        master.checked = false;
        master.indeterminate = false;
        master.disabled = true;
        return;
    }
    master.disabled = false;
    const checked = state.rows.filter((r) => r.currentlyChecked).length;
    if (checked === 0) {
        master.checked = false;
        master.indeterminate = false;
    } else if (checked === state.rows.length) {
        master.checked = true;
        master.indeterminate = false;
    } else {
        master.checked = false;
        master.indeterminate = true;
    }
}

function actionToTarget(a: FlagAction): 0 | 1 | null {
    return a === 'on' ? 1 : a === 'off' ? 0 : null;
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

function targetAclForRow(state: DocSettingsModalState, row: RowState): EditAcl | null {
    const action = state.getAclAction();
    if (action === 'none') return row.edit_acl;
    if (action === 'clear') return null;
    return state.getAclValue();
}

function updateCounter(state: DocSettingsModalState): void {
    const counter = document.getElementById('docSetCounter');
    if (counter) {
        if (state.rows.length === 0) {
            counter.textContent = '하위 문서 없음';
        } else {
            const checked = state.rows.filter((r) => r.currentlyChecked).length;
            const targetLock = actionToTarget(state.getLockAction());
            const targetPriv = actionToTarget(state.getPrivateAction());
            let changeCount = 0;
            for (const r of state.rows) {
                if (!r.currentlyChecked) continue;
                const newLock = targetLock === null ? r.is_locked : targetLock;
                const newPriv = targetPriv === null ? r.is_private : targetPriv;
                const newAcl = targetAclForRow(state, r);
                if (newLock !== r.is_locked || newPriv !== r.is_private || !aclEqual(newAcl, r.edit_acl)) changeCount++;
            }
            counter.textContent = `체크 ${checked} / ${state.rows.length} (변경 +${changeCount})`;
        }
    }
    updateMasterCheckbox(state);
}

async function loadAndRenderTree(state: DocSettingsModalState): Promise<void> {
    const panel = document.getElementById('docSetSubpagesPanel');
    if (!panel) return;

    const res = await fetchSubpages(state.prefix);
    if ('error' in res) {
        panel.innerHTML = `<div class="bulkcat-warning">${escapeHtml(res.error)}</div>`;
        const counter = document.getElementById('docSetCounter');
        if (counter) counter.textContent = '불러오기 실패';
        return;
    }

    const { panelHtml } = renderSubpagesTable(res.items, state.prefix);
    panel.innerHTML = panelHtml;

    const master = panel.querySelector<HTMLInputElement>('#docSetMasterCheckbox');
    if (master) {
        master.addEventListener('change', () => {
            setAllRows(state, master.checked);
        });
    }

    state.rows.length = 0;
    for (const item of res.items) {
        const cb = panel.querySelector<HTMLInputElement>(
            `input.docset-checkbox[data-page-id="${item.id}"]`
        );
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
            updateCounter(state);
        });
        state.rows.push(row);
    }

    updateCounter(state);
}

function setAllRows(state: DocSettingsModalState, checked: boolean): void {
    for (const row of state.rows) {
        row.currentlyChecked = checked;
        row.checkbox.checked = checked;
        const tr = row.checkbox.closest<HTMLTableRowElement>('tr[data-page-id]');
        tr?.classList.add('bulkcat-row-touched');
    }
    updateCounter(state);
}

function readAction(name: string): FlagAction {
    const el = document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
    const v = el?.value;
    return v === 'on' || v === 'off' ? v : 'none';
}

function readAclAction(): AclAction {
    const el = document.querySelector<HTMLInputElement>('input[name="docSetAclAction"]:checked');
    const v = el?.value;
    return v === 'set' || v === 'clear' ? v : 'none';
}

function readAclValue(): EditAcl | null {
    const modeEl = document.querySelector<HTMLInputElement>('input[name="docSetAclMode"]:checked');
    const mode: 'or' | 'and' = modeEl?.value === 'and' ? 'and' : 'or';
    const flags: EditAclFlag[] = [];
    document.querySelectorAll<HTMLInputElement>('.docset-acl-flag').forEach((el) => {
        if (!el.checked) return;
        const v = el.value;
        if (v === 'aged' || v === 'allowlist' || v === 'page_editor' || v === 'any_editor') {
            flags.push(v);
        }
    });
    if (flags.length === 0) return null;
    return { mode, flags };
}

function toggleAclFieldsetVisibility() {
    const fs = document.getElementById('docSetAclFieldset') as HTMLFieldSetElement | null;
    if (!fs) return;
    fs.style.display = readAclAction() === 'set' ? '' : 'none';
}

async function openDocSettingsModal() {
    const swal = window.Swal;
    if (!swal) return;

    const currentSlug = getCurrentSlug();
    if (!currentSlug) {
        await swal.fire({
            icon: 'warning',
            title: '대상 문서 없음',
            text: '현재 편집 중인 문서의 제목을 확인할 수 없습니다.',
        });
        return;
    }

    let rules: DocSettingRule[] = [];
    try {
        rules = await fetchRules();
    } catch (e) {
        console.warn('Failed to load doc-setting prefix rules', e);
    }

    const state: DocSettingsModalState = {
        prefix: currentSlug,
        rows: [],
        getLockAction: () => readAction('docSetLockAction'),
        getPrivateAction: () => readAction('docSetPrivateAction'),
        getAclAction: () => readAclAction(),
        getAclValue: () => readAclValue(),
    };

    const result = await swal.fire({
        title: '하위 문서 설정 관리',
        html: buildModalHtml(currentSlug, rules),
        width: 760,
        showCancelButton: true,
        confirmButtonText: '실행',
        cancelButtonText: '닫기',
        focusConfirm: false,
        didOpen: () => {
            const tableEl = document.getElementById('docSetRulesTable');
            if (tableEl) hookRuleDeleteButtons(tableEl);

            // 라디오 변경 시 카운터 재계산
            document.querySelectorAll<HTMLInputElement>(
                'input[name="docSetLockAction"], input[name="docSetPrivateAction"], input[name="docSetAclAction"], input[name="docSetAclMode"]'
            ).forEach((el) => {
                el.addEventListener('change', () => updateCounter(state));
            });
            document.querySelectorAll<HTMLInputElement>('input[name="docSetAclAction"]').forEach((el) => {
                el.addEventListener('change', toggleAclFieldsetVisibility);
            });
            document.querySelectorAll<HTMLInputElement>('.docset-acl-flag').forEach((el) => {
                el.addEventListener('change', () => updateCounter(state));
            });
            toggleAclFieldsetVisibility();

            void loadAndRenderTree(state);
        },
        preConfirm: () => {
            const lockAction = state.getLockAction();
            const privateAction = state.getPrivateAction();
            const aclAction = state.getAclAction();
            const aclValue = aclAction === 'set' ? state.getAclValue() : null;
            const persistEl = document.getElementById('docSetPersist') as HTMLInputElement | null;
            const persist = !!persistEl?.checked;

            if (aclAction === 'set' && !aclValue) {
                swal.showValidationMessage("편집 ACL '아래 ACL 적용'을 선택했지만 플래그가 비어 있습니다.");
                return false;
            }

            const targetLock = actionToTarget(lockAction);
            const targetPriv = actionToTarget(privateAction);

            // 실제로 값이 바뀌는 행만 ids 에 포함 (서버 부담·로그 정확성을 위해)
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

            if (willApply && !anyAction) {
                // 이론상 도달 불가 (변경된 행이 있으면 액션이 'none' 이 아님)
                swal.showValidationMessage('편집 잠금/비공개/편집 ACL 중 하나 이상의 액션을 선택해주세요.');
                return false;
            }
            if (!willApply && !persist) {
                swal.showValidationMessage('적용할 문서를 선택하거나 "자동 규칙으로 저장"을 선택해주세요.');
                return false;
            }
            if (persist) {
                const persistHasLock = lockAction !== 'none';
                const persistHasPriv = privateAction !== 'none';
                const persistHasAcl = aclAction === 'set';  // 룰은 'set' 만 ACL 강제 — 'clear' 는 룰 없음 의미.
                if (!persistHasLock && !persistHasPriv && !persistHasAcl) {
                    swal.showValidationMessage('자동 규칙을 저장하려면 편집 잠금/비공개/편집 ACL 중 하나 이상을 지정해야 합니다.');
                    return false;
                }
            }

            return {
                prefix: currentSlug,
                lockAction,
                privateAction,
                aclAction,
                aclValue,
                ids,
                persist,
                willApply,
            };
        },
    });

    if (!result.isConfirmed || !result.value) return;
    const { prefix, lockAction, privateAction, aclAction, aclValue, ids, persist, willApply } = result.value as {
        prefix: string;
        lockAction: FlagAction;
        privateAction: FlagAction;
        aclAction: AclAction;
        aclValue: EditAcl | null;
        ids: number[];
        persist: boolean;
        willApply: boolean;
    };

    try {
        if (willApply || persist) {
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
            const data = (await res.json()) as {
                scanned: number;
                requested: number;
                changed: number;
                ruleSaved: boolean;
            };
            const changeMsg = willApply
                ? `대상 ${escapeHtml(String(data.scanned))}개 중 <b>${escapeHtml(String(data.changed))}개</b> 변경되었습니다.`
                : '';
            const ruleMsg = data.ruleSaved
                ? (changeMsg ? '<br>자동 규칙도 함께 저장되었습니다.' : '자동 규칙이 저장되었습니다.')
                : '';
            await swal.fire({
                icon: 'success',
                title: '적용 완료',
                html: changeMsg + ruleMsg || '변경 사항이 없습니다.',
            });
        }
    } catch (e) {
        console.error('doc-settings apply failed', e);
        await swal.fire({ icon: 'error', title: '네트워크 오류', text: String(e) });
    }
}

function init() {
    const btn = document.getElementById('docSettingsBtn');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        void openDocSettingsModal();
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
