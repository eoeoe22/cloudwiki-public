/**
 * 카테고리 ACL 편집 모달 — 카테고리 문서의 "문서 도구 > 권한 관리" 항목에서 호출된다.
 * 관리자 콘솔 카드의 목록/탐색은 admin.html 인라인 스크립트가 직접 처리한다.
 *
 * 호출 API (모두 관리자 전용 — adminRoutes.use(requireAdmin)):
 *   GET    /api/admin/category-acl/:name      — 단건 조회
 *   PUT    /api/admin/category-acl/:name      — ACL upsert (null/빈 flags → DELETE)
 *   GET    /api/admin/category-acl/:name/pages — 카테고리에 속한 페이지 목록
 *   POST   /api/admin/category-acl/:name/bulk-apply
 *
 * window.openCategoryAclModal(name) — 카테고리 ACL 편집 폼을 연다.
 */

import '../utils/swal';

declare global {
    interface Window {
        openCategoryAclModal?: (name: string) => Promise<void>;
    }
}

type EditAclFlag = 'aged' | 'page_editor' | 'any_editor' | 'admin_only';
interface EditAcl { flags: EditAclFlag[]; }
type BulkMode = 'overwrite' | 'merge' | 'ignore';

interface PageItem {
    id: number;
    slug: string;
    edit_acl: EditAcl | null;
}

interface PageRowState {
    id: number;
    slug: string;
    edit_acl: EditAcl | null;
    currentlyChecked: boolean;
    checkbox: HTMLInputElement;
}

const ACL_FLAG_LABELS: Record<EditAclFlag, string> = {
    aged: '가입 N일 이상',
    page_editor: '본 문서 편집 이력',
    any_editor: '임의 문서 편집 이력',
    admin_only: '관리자 전용',
};

const ACL_FLAG_ORDER: EditAclFlag[] = ['aged', 'page_editor', 'any_editor', 'admin_only'];

function escapeHtml(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function aclSummary(acl: EditAcl | null): string {
    if (!acl || acl.flags.length === 0) return '비활성';
    return acl.flags.map(f => ACL_FLAG_LABELS[f]).join(' 그리고 ');
}

function readCheckedFlags(scope: HTMLElement, selector: string): EditAclFlag[] {
    const out: EditAclFlag[] = [];
    scope.querySelectorAll<HTMLInputElement>(selector).forEach(el => {
        if (el.checked && ACL_FLAG_ORDER.includes(el.value as EditAclFlag)) {
            out.push(el.value as EditAclFlag);
        }
    });
    return out;
}

// ── API ──────────────────────────────────────────────────────────────

async function apiFetchPages(name: string): Promise<PageItem[]> {
    const res = await fetch(`/api/admin/category-acl/${encodeURIComponent(name)}/pages`);
    if (!res.ok) throw new Error(`페이지 조회 실패 (${res.status})`);
    const data = (await res.json()) as { items?: PageItem[] };
    return data.items || [];
}

async function apiBulkApply(name: string, payload: {
    mode: BulkMode;
    ids: number[];
    persistTemplate: boolean;
    templateAcl: EditAcl | null;
}): Promise<{ scanned: number; requested: number; changed: number; templateSaved: boolean }> {
    const res = await fetch(`/api/admin/category-acl/${encodeURIComponent(name)}/bulk-apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `일괄 적용 실패 (${res.status})`);
    }
    return (await res.json()) as { scanned: number; requested: number; changed: number; templateSaved: boolean };
}

// ── HTML 빌더 ─────────────────────────────────────────────────────────

function aclFieldsetHtml(idPrefix: string, initialAcl: EditAcl | null): string {
    const flagSet = new Set(initialAcl?.flags ?? []);
    return `
        <fieldset class="perm-acl-fieldset" style="border: 1px dashed var(--bs-border-color); padding: 8px 12px; border-radius: 6px;">
            <div class="bulkcat-flag-row">
                ${ACL_FLAG_ORDER.map(f => `
                    <label class="form-check-inline mb-0"><input class="form-check-input ${idPrefix}-flag" type="checkbox" value="${f}"${flagSet.has(f) ? ' checked' : ''}> <span class="ms-1">${ACL_FLAG_LABELS[f]}</span></label>
                `).join('')}
            </div>
            <small class="text-muted"><b>관리자 전용</b> 플래그가 있는 카테고리는 일반 사용자가 적용할 수 없습니다.</small>
        </fieldset>
    `;
}

function aclBadge(acl: EditAcl | null): string {
    if (!acl) return '<span class="bulkcat-cat-chip" style="opacity: .4;">—</span>';
    return `<span class="bulkcat-cat-chip" title="${escapeHtml(JSON.stringify(acl))}"><i class="mdi mdi-shield-account"></i> ${escapeHtml(aclSummary(acl))}</span>`;
}

function pageListHtml(pages: PageItem[]): string {
    if (pages.length === 0) {
        return window.uiEmptyState({
            icon: 'bi bi-folder',
            title: '이 카테고리에 속한 문서가 없습니다',
            text: '템플릿만 저장하면 이후 적용되는 문서에 적용됩니다.',
            compact: true,
        });
    }
    const rows = pages.map(p => `
        <tr data-page-id="${p.id}">
            <td>
                <label class="bulkcat-row-label">
                    <input type="checkbox" class="form-check-input cat-page-check" data-page-id="${p.id}" checked>
                    <code class="bulkcat-slug">${escapeHtml(p.slug)}</code>
                </label>
            </td>
            <td class="bulkcat-row-cats-cell">${aclBadge(p.edit_acl)}</td>
        </tr>
    `).join('');
    const warning = pages.length > 500
        ? `<div class="bulkcat-warning">총 ${pages.length}개</div>`
        : '';
    return `
        ${warning}
        <div class="bulkcat-master-row">
            <label class="bulkcat-master-label">
                <input type="checkbox" class="form-check-input bulkcat-master-checkbox" id="catAclMaster" checked>
                <span class="bulkcat-master-text">전체</span>
            </label>
            <span class="bulkcat-master-count" id="catAclSelectedCount">${pages.length} / ${pages.length}</span>
        </div>
        <table class="bulkcat-subpages-table"><tbody>${rows}</tbody></table>
    `;
}

function buildEditorHtml(name: string, initialAcl: EditAcl | null, pageCount: number): string {
    return `
        <div class="bulkcat-modal">
            <section class="bulkcat-section bulk-modal-section-card">
                <header class="bulkcat-section-head">
                    <h6 class="bulkcat-section-title">카테고리 <code>${escapeHtml(name)}</code></h6>
                    <span class="bulkcat-counter">${pageCount}개 문서에 적용 가능</span>
                </header>
                ${aclFieldsetHtml('catAcl', initialAcl)}
                <div class="bulkcat-actions-row" style="margin-top: 0.5rem; justify-content: flex-end; gap: 6px;">
                    <button type="button" class="btn btn-sm btn-wiki" id="catAclSaveTemplateBtn">
                        <i class="mdi mdi-content-save"></i> 템플릿 저장
                    </button>
                </div>
                <small class="text-muted">템플릿을 저장하면 이후 문서가 이 카테고리를 적용할 때 적용됩니다. 기존 문서들의 ACL 은 변경되지 않습니다.</small>
            </section>

            <section class="bulkcat-section bulk-modal-section-card bulk-modal-section-muted">
                <header class="bulkcat-section-head">
                    <h6 class="bulkcat-section-title">이 카테고리 문서에 일괄 적용</h6>
                    <span class="bulkcat-counter" id="catAclPagesCounter">불러오는 중…</span>
                </header>
                <div class="bulkcat-subpages-panel" id="catAclPagesPanel">
                    ${window.uiInlineLoading({ block: true })}
                </div>
                <div class="bulkcat-actions-row" style="display: flex; flex-direction: column; gap: 10px; margin-top: 0.5rem;">
                    <div role="radiogroup" aria-label="모드" class="bulkcat-option-row">
                        <span class="bulkcat-option-label"><i class="mdi mdi-merge"></i> 모드</span>
                        <label class="form-check-inline mb-0"><input class="form-check-input" type="radio" name="catAclBulkMode" value="merge" checked> <span class="ms-1">합치기</span></label>
                        <label class="form-check-inline mb-0"><input class="form-check-input" type="radio" name="catAclBulkMode" value="overwrite"> <span class="ms-1">덮어쓰기</span></label>
                        <label class="form-check-inline mb-0"><input class="form-check-input" type="radio" name="catAclBulkMode" value="ignore"> <span class="ms-1">무시 (페이지 변경 없음)</span></label>
                    </div>
                </div>
                <p class="bulkcat-section-hint">
                    체크된 문서의 <code>edit_acl</code> 만 선택한 모드로 갱신됩니다. <b>합치기</b> 는 기존 flag 와 카테고리 flag 의 합집합 (AND 평가이므로 결과는 더 엄격), <b>덮어쓰기</b> 는 기존 ACL 을 통째 교체. 카테고리 ACL 템플릿은 저장되지 않으며, 별도로 위쪽 <b>템플릿 저장</b> 버튼을 눌러야 합니다.
                </p>
                <div class="bulkcat-actions-row" style="margin-top: 0.5rem; justify-content: flex-end; gap: 6px;">
                    <button type="button" class="btn btn-sm btn-wiki btn-wiki-primary" id="catAclBulkApplyBtn">
                        <i class="mdi mdi-check-all"></i> 일괄 적용
                    </button>
                </div>
            </section>
        </div>
    `;
}

// ── 인터랙션 ─────────────────────────────────────────────────────────

async function showCategoryEditor(name: string): Promise<void> {
    if (!window.Swal) return;
    const res = await fetch(`/api/admin/category-acl/${encodeURIComponent(name)}`);
    if (!res.ok) {
        await window.Swal.fire({ icon: 'error', title: '조회 실패', text: `(${res.status})` });
        return;
    }
    const data = (await res.json()) as { name: string; edit_acl: EditAcl | null; exists: boolean; page_count: number };

    const result = await window.Swal.fire({
        title: '카테고리 ACL 편집',
        html: buildEditorHtml(name, data.edit_acl, data.page_count),
        width: 720,
        showConfirmButton: false,
        showCloseButton: true,
        didOpen: async (modal: HTMLElement) => {
            const pagesPanel = modal.querySelector('#catAclPagesPanel') as HTMLElement;
            const pagesCounter = modal.querySelector('#catAclPagesCounter') as HTMLElement;

            const rowStates: PageRowState[] = [];
            try {
                const pages = await apiFetchPages(name);
                pagesPanel.innerHTML = pageListHtml(pages);
                pagesCounter.textContent = `${pages.length}개 문서`;

                const master = pagesPanel.querySelector<HTMLInputElement>('#catAclMaster');
                const selectedCounter = pagesPanel.querySelector<HTMLElement>('#catAclSelectedCount');

                const updateMaster = () => {
                    if (!master) return;
                    if (rowStates.length === 0) {
                        master.checked = false;
                        master.indeterminate = false;
                        master.disabled = true;
                        return;
                    }
                    master.disabled = false;
                    const checked = rowStates.filter(r => r.currentlyChecked).length;
                    if (checked === 0) { master.checked = false; master.indeterminate = false; }
                    else if (checked === rowStates.length) { master.checked = true; master.indeterminate = false; }
                    else { master.checked = false; master.indeterminate = true; }
                };
                const updateCounter = () => {
                    const checked = rowStates.filter(r => r.currentlyChecked).length;
                    if (selectedCounter) selectedCounter.textContent = `${checked} / ${rowStates.length}`;
                    updateMaster();
                };

                for (const p of pages) {
                    const cb = pagesPanel.querySelector<HTMLInputElement>(`input.cat-page-check[data-page-id="${p.id}"]`);
                    if (!cb) continue;
                    const row: PageRowState = {
                        id: p.id,
                        slug: p.slug,
                        edit_acl: p.edit_acl,
                        currentlyChecked: cb.checked,
                        checkbox: cb,
                    };
                    cb.addEventListener('change', () => {
                        row.currentlyChecked = cb.checked;
                        const tr = cb.closest<HTMLTableRowElement>('tr[data-page-id]');
                        tr?.classList.add('bulkcat-row-touched');
                        updateCounter();
                    });
                    rowStates.push(row);
                }

                master?.addEventListener('change', () => {
                    const next = master.checked;
                    for (const row of rowStates) {
                        row.currentlyChecked = next;
                        row.checkbox.checked = next;
                        const tr = row.checkbox.closest<HTMLTableRowElement>('tr[data-page-id]');
                        tr?.classList.add('bulkcat-row-touched');
                    }
                    updateCounter();
                });

                updateCounter();
            } catch (e) {
                pagesPanel.innerHTML = `<div class="bulkcat-warning">${escapeHtml(String(e))}</div>`;
            }

            modal.querySelector('#catAclSaveTemplateBtn')?.addEventListener('click', async () => {
                const flags = readCheckedFlags(modal, '.catAcl-flag');
                const acl: EditAcl | null = flags.length > 0 ? { flags } : null;
                try {
                    const saveRes = await fetch(`/api/admin/category-acl/${encodeURIComponent(name)}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ edit_acl: acl }),
                    });
                    if (!saveRes.ok) {
                        const err = (await saveRes.json().catch(() => ({}))) as { error?: string };
                        throw new Error(err.error || `저장 실패 (${saveRes.status})`);
                    }
                    await window.Swal!.fire({ icon: 'success', title: '템플릿 저장됨', toast: true, position: 'top-end', timer: 1500, showConfirmButton: false });
                    window.Swal!.close();
                } catch (e: any) {
                    await window.Swal!.fire({ icon: 'error', title: '저장 실패', text: e?.message || String(e) });
                }
            });

            modal.querySelector('#catAclBulkApplyBtn')?.addEventListener('click', async () => {
                const flags = readCheckedFlags(modal, '.catAcl-flag');
                const templateAcl: EditAcl | null = flags.length > 0 ? { flags } : null;
                const modeEl = modal.querySelector<HTMLInputElement>('input[name="catAclBulkMode"]:checked');
                const mode = (modeEl?.value as BulkMode) || 'merge';
                const ids: number[] = [];
                modal.querySelectorAll<HTMLInputElement>('.cat-page-check:checked').forEach(el => {
                    const id = Number(el.dataset.pageId);
                    if (Number.isFinite(id) && id > 0) ids.push(id);
                });

                if (mode !== 'ignore' && ids.length === 0) {
                    await window.Swal!.fire({ icon: 'warning', title: '선택된 문서가 없습니다.', text: '모드가 무시가 아니면 적용할 문서를 선택해야 합니다.' });
                    return;
                }

                const confirm = await window.Swal!.fire({
                    icon: 'question',
                    title: '일괄 적용',
                    html: `<div style="text-align: left;">
                        모드: <b>${mode}</b><br>
                        적용 ACL: <b>${escapeHtml(aclSummary(templateAcl))}</b><br>
                        대상 문서: <b>${mode === 'ignore' ? 0 : ids.length}개</b><br>
                        <small class="text-muted">카테고리 템플릿은 저장되지 않습니다.</small>
                    </div>`,
                    showCancelButton: true,
                    confirmButtonText: '적용',
                    cancelButtonText: '취소',
                });
                if (!confirm.isConfirmed) return;

                try {
                    const result = await apiBulkApply(name, {
                        mode,
                        ids,
                        persistTemplate: false,
                        templateAcl,
                    });
                    await window.Swal!.fire({
                        icon: 'success',
                        title: '완료',
                        html: `스캔: ${result.scanned} / 변경: ${result.changed} / 요청: ${result.requested}`,
                    });
                    window.Swal!.close();
                } catch (e: any) {
                    await window.Swal!.fire({ icon: 'error', title: '실패', text: e?.message || String(e) });
                }
            });
        },
    });

    void result;
}

window.openCategoryAclModal = async (name: string) => {
    await showCategoryEditor(name);
};
