/**
 * 하위 문서 일괄 카테고리 적용 + 자동 prefix 룰 관리 모달.
 *
 * - public/edit.html 의 #bulkCategoryBtn 클릭 시 SweetAlert2 모달을 띄운다.
 * - 관리자 전용. 백엔드(/api/admin/category-prefix-rules*) 도 requireAdmin 으로 보호된다.
 * - 모달에서 prefix / categories 입력, "지금 일괄 적용" / "자동 규칙으로 저장" 체크박스,
 *   그리고 기존 규칙 목록을 보여준다.
 */

import '../utils/swal';

import { normalizeSlug } from '../utils/slug';

interface PrefixRule {
    id: number;
    prefix: string;
    categories: string;
    created_at: number;
    created_by_name: string | null;
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

async function fetchRules(): Promise<PrefixRule[]> {
    const res = await fetch('/api/admin/category-prefix-rules');
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as PrefixRule[]) : [];
}

function rulesTableHtml(rules: PrefixRule[]): string {
    if (rules.length === 0) {
        return '<div class="text-muted small">저장된 자동 규칙이 없습니다.</div>';
    }
    const rows = rules
        .map(
            (r) => `
            <tr data-rule-id="${r.id}">
                <td class="text-break"><code>${escapeHtml(r.prefix)}/**</code></td>
                <td class="text-break">${escapeHtml(r.categories)}</td>
                <td class="text-end">
                    <button type="button" class="btn btn-sm btn-outline-danger bulkcat-rule-delete">
                        <i class="mdi mdi-trash-can-outline"></i>
                    </button>
                </td>
            </tr>`
        )
        .join('');
    return `
        <table class="table table-sm align-middle mb-0">
            <thead>
                <tr><th>접두사</th><th>자동 부여 카테고리</th><th></th></tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

function buildModalHtml(initialPrefix: string, hintCategories: string, rules: PrefixRule[]): string {
    return `
        <div class="text-start">
            <div class="mb-3">
                <label for="bulkCatPrefix" class="form-label fw-bold">접두사 (prefix)</label>
                <input id="bulkCatPrefix" type="text" class="form-control"
                    value="${escapeHtml(initialPrefix)}"
                    placeholder="예: 만화">
                <div class="form-text">
                    <code>접두사/...</code> 형태의 모든 하위 문서가 대상입니다 (손자/증손자 포함, 접두사 문서 자체는 제외).
                </div>
            </div>
            <div class="mb-3">
                <label for="bulkCatCategories" class="form-label fw-bold">적용할 카테고리</label>
                <input id="bulkCatCategories" type="text" class="form-control"
                    placeholder="${escapeHtml(hintCategories || '쉼표로 구분 (예: 시리즈, 만화)')}">
                <div class="form-text">기존 카테고리는 보존되며, 위 카테고리들은 합집합으로 추가됩니다.</div>
            </div>
            <div class="mb-2">
                <div class="form-check">
                    <input class="form-check-input" type="checkbox" id="bulkCatApplyNow" checked>
                    <label class="form-check-label" for="bulkCatApplyNow">
                        지금 하위 문서에 일괄 적용
                    </label>
                </div>
                <div class="form-check">
                    <input class="form-check-input" type="checkbox" id="bulkCatPersist">
                    <label class="form-check-label" for="bulkCatPersist">
                        자동 규칙으로 저장 (이후 새 문서 생성/이동 시 자동 적용)
                    </label>
                </div>
            </div>
            <hr>
            <div class="fw-bold mb-2">기존 자동 규칙</div>
            <div id="bulkCatRulesTable">${rulesTableHtml(rules)}</div>
        </div>
    `;
}

async function deleteRule(id: number): Promise<boolean> {
    const res = await fetch(`/api/admin/category-prefix-rules/${id}`, { method: 'DELETE' });
    return res.ok;
}

async function refreshRulesTable(container: HTMLElement) {
    const rules = await fetchRules();
    container.innerHTML = rulesTableHtml(rules);
    hookRuleDeleteButtons(container);
}

function hookRuleDeleteButtons(container: HTMLElement) {
    container.querySelectorAll<HTMLButtonElement>('.bulkcat-rule-delete').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const row = btn.closest<HTMLTableRowElement>('tr[data-rule-id]');
            if (!row) return;
            const id = Number(row.dataset.ruleId);
            if (!Number.isFinite(id)) return;
            const swal = window.Swal;
            const confirm = await swal?.fire({
                title: '규칙 삭제',
                text: '이 자동 규칙을 삭제하시겠습니까? (이미 적용된 카테고리는 그대로 유지됩니다)',
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: '삭제',
                cancelButtonText: '취소',
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

async function openBulkCategoryModal() {
    const swal = window.Swal;
    if (!swal) return;

    const initialPrefix = getCurrentSlug();
    const hintCategories = (window.categoryTags || []).join(', ');
    let rules: PrefixRule[] = [];
    try {
        rules = await fetchRules();
    } catch (e) {
        console.warn('Failed to load prefix rules', e);
    }

    const result = await swal.fire({
        title: '하위 문서 카테고리 일괄 적용',
        html: buildModalHtml(initialPrefix, hintCategories, rules),
        width: 720,
        showCancelButton: true,
        confirmButtonText: '실행',
        cancelButtonText: '닫기',
        focusConfirm: false,
        didOpen: () => {
            const tableEl = document.getElementById('bulkCatRulesTable');
            if (tableEl) hookRuleDeleteButtons(tableEl);
        },
        preConfirm: () => {
            const prefixEl = document.getElementById('bulkCatPrefix') as HTMLInputElement | null;
            const catsEl = document.getElementById('bulkCatCategories') as HTMLInputElement | null;
            const applyEl = document.getElementById('bulkCatApplyNow') as HTMLInputElement | null;
            const persistEl = document.getElementById('bulkCatPersist') as HTMLInputElement | null;

            const prefix = (prefixEl?.value || '').trim().replace(/\/+$/, '');
            const categories = (catsEl?.value || '').trim();
            const applyNow = !!applyEl?.checked;
            const persist = !!persistEl?.checked;

            if (!prefix) {
                swal.showValidationMessage('접두사를 입력해주세요.');
                return false;
            }
            if (!categories) {
                swal.showValidationMessage('적용할 카테고리를 1개 이상 입력해주세요.');
                return false;
            }
            if (!/^[가-힣a-zA-Z0-9\s,]+$/.test(categories)) {
                swal.showValidationMessage('카테고리에는 한글/영문/숫자/공백/쉼표만 사용할 수 있습니다.');
                return false;
            }
            if (!applyNow && !persist) {
                swal.showValidationMessage('"일괄 적용" 또는 "자동 규칙으로 저장" 중 최소 하나는 선택해야 합니다.');
                return false;
            }
            return { prefix, categories, applyNow, persist };
        },
    });

    if (!result.isConfirmed || !result.value) return;
    const { prefix, categories, applyNow, persist } = result.value as {
        prefix: string;
        categories: string;
        applyNow: boolean;
        persist: boolean;
    };

    try {
        if (applyNow) {
            const res = await fetch('/api/admin/category-prefix-rules/bulk-apply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prefix, categories, persist }),
            });
            if (!res.ok) {
                const err = (await res.json().catch(() => ({}))) as { error?: string };
                await swal.fire({ icon: 'error', title: '실패', text: err.error || `오류 (${res.status})` });
                return;
            }
            const data = (await res.json()) as { scanned: number; updated: number; ruleSaved: boolean };
            await swal.fire({
                icon: 'success',
                title: '적용 완료',
                html: `대상 ${escapeHtml(String(data.scanned))}개 중 <b>${escapeHtml(String(data.updated))}개</b> 문서에 카테고리를 추가했습니다.${data.ruleSaved ? '<br>자동 규칙도 함께 저장되었습니다.' : ''}`,
            });
        } else if (persist) {
            // 일괄 적용 없이 자동 규칙만 저장
            const res = await fetch('/api/admin/category-prefix-rules', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prefix, categories }),
            });
            if (!res.ok) {
                const err = (await res.json().catch(() => ({}))) as { error?: string };
                await swal.fire({ icon: 'error', title: '실패', text: err.error || `오류 (${res.status})` });
                return;
            }
            await swal.fire({
                icon: 'success',
                title: '자동 규칙 저장',
                text: '이후 이 접두사로 새로 만들어지거나 이동되는 문서에 자동으로 카테고리가 적용됩니다.',
            });
        }
    } catch (e) {
        console.error('bulk-category apply failed', e);
        await swal.fire({ icon: 'error', title: '네트워크 오류', text: String(e) });
    }
}

function init() {
    const btn = document.getElementById('bulkCategoryBtn');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        void openBulkCategoryModal();
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
