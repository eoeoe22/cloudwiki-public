/**
 * 하위 문서 일괄 카테고리 적용 + 자동 prefix 룰 관리 모달.
 *
 * - public/edit.html 의 #bulkCategoryBtn 클릭 시 SweetAlert2 모달을 띄운다.
 * - 관리자 전용. 백엔드(/api/admin/category-prefix-rules*) 도 requireAdmin 으로 보호된다.
 * - 모달은 현재 편집 중인 문서의 슬러그를 자동으로 prefix 로 사용하며,
 *   카테고리는 메인 에디터와 동일한 칩(태그) + 자동완성 UX 로 입력받는다.
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

function buildModalHtml(currentSlug: string, rules: PrefixRule[]): string {
    return `
        <div class="text-start">
            <div class="mb-3">
                <label class="form-label fw-bold">대상</label>
                <div class="form-text">
                    <code>${escapeHtml(currentSlug)}/**</code> 형태의 모든 하위 문서 (손자/증손자 포함, 현재 문서 자체는 제외)
                </div>
            </div>
            <div class="mb-3">
                <label for="bulkCatTagInput" class="form-label fw-bold">적용할 카테고리</label>
                <div class="category-tag-container" id="bulkCatTagContainer">
                    <input type="text" id="bulkCatTagInput" class="category-tag-input"
                        placeholder="카테고리 입력 후 엔터나 쉼표" autocomplete="off">
                </div>
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

// 카테고리 칩 한 항목의 형식 검증 — 백엔드 CATEGORY_PATTERN 이 콤마 포함 문자열
// 전체에 한글/영문/숫자/공백/쉼표만 허용하므로, 칩 단위로는 콤마를 제외한
// 한글/영문/숫자/공백만 허용한다.
const BULK_CAT_TAG_RE = /^[가-힣a-zA-Z0-9\s]+$/;

interface BulkCatAcState {
    visible: boolean;
    results: string[];
    selectedIndex: number;
    query: string;
    lastQuery: string | null;
    debounceTimer: ReturnType<typeof setTimeout> | null;
    div: HTMLElement | null;
}

/**
 * 모달이 열린 뒤 #bulkCatTagContainer / #bulkCatTagInput 에 칩 UI 와
 * 자동완성을 설치한다. 모달 라이프사이클(open → close) 동안에만 유효한
 * 클로저 상태로 동작하므로 메인 에디터의 categoryTagInput 과 충돌하지 않는다.
 *
 * 반환된 tags 배열은 preConfirm 에서 직접 읽어 페이로드를 만든다.
 */
function installBulkCategoryTagUI(): {
    tags: string[];
    flushPending: () => void;
    hideAutocomplete: () => void;
    inputEl: HTMLInputElement | null;
} {
    const container = document.getElementById('bulkCatTagContainer');
    const input = document.getElementById('bulkCatTagInput') as HTMLInputElement | null;

    const tags: string[] = [];

    // 자동완성 dropdown 컨테이너는 모달 안에 동적으로 추가 (CSS 는 #category-autocomplete 와 공유)
    let acDiv: HTMLElement | null = null;
    if (container) {
        acDiv = document.createElement('div');
        acDiv.id = 'bulkCatAutocomplete';
        acDiv.className = 'list-group';
        acDiv.style.display = 'none';
        document.body.appendChild(acDiv);
    }

    const ac: BulkCatAcState = {
        visible: false,
        results: [],
        selectedIndex: -1,
        query: '',
        lastQuery: null,
        debounceTimer: null,
        div: acDiv,
    };

    function renderTags(): void {
        if (!container) return;
        container.querySelectorAll('.category-tag').forEach((t) => t.remove());
        tags.forEach((tagText, index) => {
            const tagEl = document.createElement('span');
            tagEl.className = 'category-tag';
            const labelSpan = document.createElement('span');
            labelSpan.textContent = tagText;
            const removeIcon = document.createElement('i');
            removeIcon.className = 'mdi mdi-close';
            removeIcon.style.cursor = 'pointer';
            removeIcon.addEventListener('click', (e) => {
                e.stopPropagation();
                tags.splice(index, 1);
                renderTags();
            });
            tagEl.appendChild(labelSpan);
            tagEl.appendChild(document.createTextNode(' '));
            tagEl.appendChild(removeIcon);
            if (input) {
                container.insertBefore(tagEl, input);
            } else {
                container.appendChild(tagEl);
            }
        });
    }

    function addTag(rawTag: string): boolean {
        const cleanTag = rawTag.trim();
        if (!cleanTag) return false;
        if (tags.includes(cleanTag)) return true;
        if (!BULK_CAT_TAG_RE.test(cleanTag)) {
            window.Swal?.fire({
                icon: 'warning',
                title: '특수문자 제외',
                text: '특수문자를 제외한 카테고리 이름을 입력해 주세요.',
                toast: true,
                position: 'top-end',
                timer: 2000,
                showConfirmButton: false,
            });
            return false;
        }
        tags.push(cleanTag);
        renderTags();
        return true;
    }

    function hideAutocomplete(): void {
        ac.visible = false;
        ac.results = [];
        ac.selectedIndex = -1;
        ac.lastQuery = null;
        if (ac.div) ac.div.style.display = 'none';
    }

    function highlightItem(): void {
        if (!ac.div) return;
        ac.div.querySelectorAll('.cat-ac-item').forEach((item, idx) => {
            item.classList.toggle('active', idx === ac.selectedIndex);
            if (idx === ac.selectedIndex) item.scrollIntoView({ block: 'nearest' });
        });
    }

    function selectByIndex(index: number): void {
        const item = ac.results[index];
        if (!item) return;
        addTag(item);
        if (input) input.value = '';
        hideAutocomplete();
        input?.focus();
    }

    function renderResults(): void {
        if (!ac.div) return;
        if (ac.results.length === 0) {
            hideAutocomplete();
            return;
        }
        ac.div.innerHTML = '';
        ac.results.forEach((item, index) => {
            const row = document.createElement('div');
            row.className = 'list-group-item cat-ac-item';
            row.dataset.index = String(index);
            const icon = document.createElement('i');
            icon.className = 'mdi mdi-tag-outline';
            const label = document.createElement('span');
            label.textContent = item;
            row.appendChild(icon);
            row.appendChild(label);
            // 모듈 클로저 안의 selectByIndex 를 호출해야 하므로 인라인 onclick 대신 mousedown 리스너 사용
            // (blur 처리보다 먼저 fire 되어야 input.blur 의 hideAutocomplete 가 동작하기 전에 선택이 끝난다)
            row.addEventListener('mousedown', (e) => {
                e.preventDefault();
                selectByIndex(index);
            });
            ac.div!.appendChild(row);
        });
        ac.selectedIndex = -1;
        highlightItem();
    }

    function showAutocomplete(query: string): void {
        if (!ac.div || !container) return;
        ac.query = query;
        ac.visible = true;
        const rect = container.getBoundingClientRect();
        ac.div.style.position = 'fixed';
        ac.div.style.left = rect.left + 'px';
        ac.div.style.top = rect.bottom + 2 + 'px';
        ac.div.style.width = rect.width + 'px';
        ac.div.style.display = 'block';

        if (ac.query === ac.lastQuery) return;
        ac.lastQuery = ac.query;

        if (ac.debounceTimer !== null) clearTimeout(ac.debounceTimer);
        ac.debounceTimer = setTimeout(async () => {
            if (!ac.visible) return;
            try {
                const res = await fetch(`/api/w/search-categories?q=${encodeURIComponent(ac.query)}`);
                if (!res.ok) return;
                const data = (await res.json()) as { results?: string[] };
                ac.results = data.results || [];
                renderResults();
            } catch (e) {
                console.error('Category autocomplete fetch error:', e);
            }
        }, 200);
    }

    if (container && input) {
        container.addEventListener('click', () => input.focus());

        input.addEventListener('keydown', (e) => {
            if (e.isComposing) return;

            if (ac.visible) {
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    if (ac.results.length > 0) {
                        ac.selectedIndex = (ac.selectedIndex + 1) % ac.results.length;
                        highlightItem();
                    }
                    return;
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (ac.results.length > 0) {
                        ac.selectedIndex = (ac.selectedIndex - 1 + ac.results.length) % ac.results.length;
                        highlightItem();
                    }
                    return;
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    hideAutocomplete();
                    return;
                } else if ((e.key === 'Enter' || e.key === 'Tab') && ac.selectedIndex >= 0) {
                    e.preventDefault();
                    selectByIndex(ac.selectedIndex);
                    return;
                }
            }

            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                if (input.value.trim()) {
                    input.value.split(',').forEach((t) => addTag(t));
                    input.value = '';
                    hideAutocomplete();
                }
            } else if (e.key === 'Backspace' && input.value === '') {
                if (tags.length > 0) {
                    tags.pop();
                    renderTags();
                }
            }
        });

        input.addEventListener('blur', () => {
            setTimeout(() => {
                hideAutocomplete();
            }, 150);
        });

        input.addEventListener('input', () => {
            if (input.value.includes(',')) {
                const parts = input.value.split(',');
                const lastFragment = parts.pop() ?? '';
                parts.forEach((t) => addTag(t));
                input.value = lastFragment;
                hideAutocomplete();
                return;
            }
            showAutocomplete(input.value.trim());
        });
    }

    return {
        tags,
        flushPending: () => {
            if (!input) return;
            const pending = input.value.trim();
            if (pending) {
                pending.split(',').forEach((t) => addTag(t));
                input.value = '';
            }
        },
        hideAutocomplete: () => {
            hideAutocomplete();
            if (ac.div && ac.div.parentNode) {
                ac.div.parentNode.removeChild(ac.div);
            }
        },
        inputEl: input,
    };
}

async function openBulkCategoryModal() {
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

    let rules: PrefixRule[] = [];
    try {
        rules = await fetchRules();
    } catch (e) {
        console.warn('Failed to load prefix rules', e);
    }

    let tagUI: ReturnType<typeof installBulkCategoryTagUI> | null = null;

    const result = await swal.fire({
        title: '하위 문서 카테고리 일괄 적용',
        html: buildModalHtml(currentSlug, rules),
        width: 720,
        showCancelButton: true,
        confirmButtonText: '실행',
        cancelButtonText: '닫기',
        focusConfirm: false,
        didOpen: () => {
            const tableEl = document.getElementById('bulkCatRulesTable');
            if (tableEl) hookRuleDeleteButtons(tableEl);
            tagUI = installBulkCategoryTagUI();
            tagUI.inputEl?.focus();
        },
        willClose: () => {
            tagUI?.hideAutocomplete();
        },
        preConfirm: () => {
            const applyEl = document.getElementById('bulkCatApplyNow') as HTMLInputElement | null;
            const persistEl = document.getElementById('bulkCatPersist') as HTMLInputElement | null;

            const applyNow = !!applyEl?.checked;
            const persist = !!persistEl?.checked;

            tagUI?.flushPending();
            const tags = tagUI?.tags ?? [];

            if (tags.length === 0) {
                swal.showValidationMessage('카테고리를 1개 이상 입력해주세요.');
                return false;
            }
            if (!applyNow && !persist) {
                swal.showValidationMessage('"일괄 적용" 또는 "자동 규칙으로 저장" 중 최소 하나는 선택해야 합니다.');
                return false;
            }
            return { prefix: currentSlug, categories: tags.join(','), applyNow, persist };
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
