// @ts-nocheck — 워크스페이스 TODO 패널 모듈.
// ws-dashboard.ts(compact) / ws-todo.ts(full) 에서 initTodoPanel() 로 초기화된다.
// common.ts 가 window.* 로 노출하는 전역(escapeHtml/uiEmptyState/uiSkeletonList)을 사용한다.
//
// 두 가지 렌더 모드:
//   - 'compact' : 대시보드 위젯. 미완료 우선(먼저 추가된 순) 최대 10개만 표시,
//                 부족하면 완료 항목으로 채움. 보관 항목은 표시하지 않음.
//                 섹션 제목(#todoDetailLink)을 TODO 상세 페이지로 링크.
//   - 'full'    : TODO 상세 페이지. 활성+보관 전체 표시, 정렬/필터/보관 관리,
//                 좁은 화면에서는 항목이 줄바꿈 대신 가로 스크롤된다.
// '선택' 토글(#todoSelectToggle)이 켜지면 각 행의 완료/미완료 체크박스가
// 선택 체크박스로 대체되고, 일괄 작업 바가 노출된다.

import { apiGet } from '../utils/api';

const esc = (s) => window.escapeHtml(String(s ?? ''));

// 대시보드 위젯에 표시할 최대 항목 수.
const DASH_LIMIT = 10;

let _wsBase = '';
let _canWrite = false;
let _mode: 'compact' | 'full' = 'full';
let _todos: any[] = [];
let _archivedTodos: any[] = [];
let _sort = 'created_asc';
let _filter = '';
let _selectedIds = new Set<number>();
let _selectMode = false;
let _archivedOpen = false;
let _archivedSelectedIds = new Set<number>();
let _archivedSelectMode = false;

export interface TodoPanelCtx {
    wslug: string;
    canWrite: boolean;
    mode?: 'compact' | 'full';
}

export function initTodoPanel(ctx: TodoPanelCtx): void {
    _wsBase = '/api/ws/' + encodeURIComponent(ctx.wslug);
    _canWrite = ctx.canWrite;
    _mode = ctx.mode === 'compact' ? 'compact' : 'full';

    // compact: 섹션 제목 → 상세 페이지 링크
    if (_mode === 'compact') {
        const link = document.getElementById('todoDetailLink');
        if (link) link.setAttribute('href', '/ws/' + encodeURIComponent(ctx.wslug) + '/todos');
    }

    if (_canWrite) {
        const addArea = document.getElementById('todoAddArea');
        addArea?.classList.remove('d-none');
        const input = document.getElementById('todoAddInput') as HTMLInputElement | null;
        input?.addEventListener('keydown', (ev) => {
            if ((ev as KeyboardEvent).key === 'Enter') {
                ev.preventDefault();
                addTodo();
            }
        });
    }

    // '선택' 토글 버튼 — 일괄 보관은 쓰기 권한이 필요하므로 writer 전용.
    if (_canWrite) {
        const selectToggle = document.getElementById('todoSelectToggle');
        selectToggle?.classList.remove('d-none');
        selectToggle?.addEventListener('click', (ev) => {
            ev.preventDefault();
            toggleSelectMode();
        });

        // 보관 섹션 선택 토글 (full 모드에만 존재)
        const archivedSelectToggle = document.getElementById('todoArchivedSelectToggle');
        archivedSelectToggle?.addEventListener('click', (ev) => {
            ev.preventDefault();
            toggleArchivedSelectMode();
        });
    }

    // 정렬/필터 드롭다운 이벤트 (full 모드에만 존재)
    document.querySelectorAll('.todo-sort-item').forEach((el) => {
        el.addEventListener('click', (ev) => {
            ev.preventDefault();
            const sort = (el as HTMLElement).dataset.sort || 'created_asc';
            document.querySelectorAll('.todo-sort-item').forEach((i) => i.classList.remove('active'));
            el.classList.add('active');
            _sort = sort;
            _selectedIds.clear();
            loadTodos();
        });
    });
    document.querySelectorAll('.todo-filter-item').forEach((el) => {
        el.addEventListener('click', (ev) => {
            ev.preventDefault();
            const filter = (el as HTMLElement).dataset.filter || '';
            document.querySelectorAll('.todo-filter-item').forEach((i) => i.classList.remove('active'));
            el.classList.add('active');
            _filter = filter;
            _selectedIds.clear();
            loadTodos();
        });
    });

    // window 노출 (HTML on* 핸들러용)
    window.addTodo = addTodo;
    window.toggleTodo = toggleTodo;
    window.editTodo = editTodo;
    window.deleteTodo = deleteTodo;
    window.archiveTodo = archiveTodo;
    window.unarchiveTodo = unarchiveTodo;
    window.todoBulkAction = todoBulkAction;
    window.todoCopy = todoCopy;
    window.copyTodoItem = copyTodoItem;
    window.todoToggleArchived = todoToggleArchived;
    window.todoToggleSelect = todoToggleSelect;
    window.todoToggleSelectMode = toggleSelectMode;
    window.archivedTodoToggleSelect = archivedTodoToggleSelect;
    window.archivedBulkAction = archivedBulkAction;
    window.todoToggleArchivedSelectMode = toggleArchivedSelectMode;

    loadTodos();
}

function buildTodosUrl(archived = false): string {
    const params = new URLSearchParams();
    if (archived) {
        params.set('archived', '1');
    } else {
        if (_sort !== 'created_asc') params.set('sort', _sort);
        if (_filter) params.set('filter', _filter);
    }
    const qs = params.toString();
    return _wsBase + '/todos' + (qs ? '?' + qs : '');
}

async function loadTodos(): Promise<void> {
    const listEl = document.getElementById('todoList');
    if (listEl) listEl.innerHTML = window.uiSkeletonList(_mode === 'compact' ? 3 : 4);

    // 리스트 초기화 시 선택 모드·선택 항목도 함께 초기화한다.
    if (_selectMode) {
        _selectMode = false;
        const btn = document.getElementById('todoSelectToggle');
        if (btn) {
            btn.classList.remove('active');
            btn.setAttribute('aria-pressed', 'false');
        }
    }
    _selectedIds.clear();
    updateBulkBar();

    // 보관 섹션 선택 모드도 초기화
    if (_archivedSelectMode) {
        _archivedSelectMode = false;
        _archivedSelectedIds.clear();
        const archivedBtn = document.getElementById('todoArchivedSelectToggle');
        if (archivedBtn) {
            archivedBtn.classList.remove('active');
            archivedBtn.setAttribute('aria-pressed', 'false');
        }
        updateArchivedBulkBar();
    }
    _archivedSelectedIds.clear();

    try {
        if (_mode === 'compact') {
            // 대시보드: 활성 항목만 (보관 항목 미표시)
            const activeData = await apiGet(buildTodosUrl(false));
            _todos = Array.isArray(activeData.todos) ? activeData.todos : [];
            _archivedTodos = [];
            if (typeof activeData.can_write === 'boolean') _canWrite = activeData.can_write;
        } else {
            const [activeData, archivedData] = await Promise.all([
                apiGet(buildTodosUrl(false)),
                apiGet(buildTodosUrl(true)),
            ]);
            _todos = Array.isArray(activeData.todos) ? activeData.todos : [];
            _archivedTodos = Array.isArray(archivedData.todos) ? archivedData.todos : [];
            if (typeof activeData.can_write === 'boolean') _canWrite = activeData.can_write;
        }
    } catch {
        if (listEl) {
            listEl.innerHTML = window.uiEmptyState({
                compact: true,
                icon: 'bi bi-exclamation-triangle',
                title: '불러오지 못했습니다',
            });
        }
        return;
    }
    renderTodos();
    if (_mode === 'full') renderArchivedSection();
}

/**
 * 화면에 표시할 항목 목록.
 *   - compact: 미완료(먼저 추가된 순) 우선 → 부족하면 완료 항목으로 채워 최대 10개.
 *   - full   : API 가 정렬/필터한 활성 항목 전체.
 * (_todos 는 API 기본 정렬인 created_asc 순서를 유지한다.)
 */
function getVisibleTodos(): any[] {
    if (_mode !== 'compact') return _todos;
    const incomplete = _todos.filter((t) => Number(t.checked) !== 1);
    const complete = _todos.filter((t) => Number(t.checked) === 1);
    return incomplete.concat(complete).slice(0, DASH_LIMIT);
}

function renderTodos(): void {
    const listEl = document.getElementById('todoList');
    if (!listEl) return;

    const visible = getVisibleTodos();
    if (!visible.length) {
        listEl.innerHTML = window.uiEmptyState({
            icon: 'bi bi-check2-square',
            title: '할 일이 없습니다',
            text: _canWrite ? '위 입력란에서 첫 번째 할 일을 추가해 보세요.' : '아직 등록된 할 일이 없습니다.',
        });
        return;
    }

    const listHtml = '<div class="list-group">' + visible.map(todoRow).join('') + '</div>';
    listEl.innerHTML = '<div class="todo-list-detail">' + listHtml + '</div>';
}

function renderArchivedSection(): void {
    const section = document.getElementById('todoArchivedSection');
    const badge = document.getElementById('todoArchivedBadge');
    if (!section) return;

    const count = _archivedTodos.length;
    if (count === 0) {
        section.classList.add('d-none');
        // 보관 섹션이 사라지면 선택 모드 초기화
        _archivedSelectMode = false;
        _archivedSelectedIds.clear();
        updateArchivedBulkBar();
        return;
    }

    section.classList.remove('d-none');
    if (badge) {
        badge.textContent = String(count);
        badge.classList.remove('d-none');
    }

    if (_archivedOpen) {
        renderArchivedList();
    }
}

function renderArchivedList(): void {
    const listEl = document.getElementById('todoArchivedList');
    if (!listEl) return;

    if (!_archivedTodos.length) {
        listEl.innerHTML = '';
        return;
    }
    listEl.innerHTML = '<div class="todo-list-detail"><div class="list-group">' + _archivedTodos.map(todoArchivedRow).join('') + '</div></div>';
}

function todoRow(t): string {
    const id = Number(t.id);
    const checked = Number(t.checked) === 1;
    const textCls = checked ? 'text-muted text-decoration-line-through' : '';
    const isSelected = _selectedIds.has(id);

    // 선택 모드: 선택 체크박스가 완료/미완료 체크박스를 대체.
    let leadingControl: string;
    if (_selectMode) {
        leadingControl =
            '<input type="checkbox" class="form-check-input mt-0 flex-shrink-0 todo-select-cb" ' +
            (isSelected ? 'checked' : '') +
            ' onchange="window.todoToggleSelect(' + id + ', this.checked)" aria-label="선택">';
    } else {
        const disabledAttr = _canWrite ? '' : 'disabled';
        leadingControl =
            '<input type="checkbox" class="form-check-input mt-0 flex-shrink-0" ' +
            (checked ? 'checked' : '') + ' ' + disabledAttr +
            ' onchange="window.toggleTodo(' + id + ', this.checked)" aria-label="완료">';
    }

    // 선택 모드에서는 일괄 작업 바로 처리하므로 행별 액션 버튼은 숨긴다.
    // 삭제는 보관된 항목에서만 가능하므로 활성 항목에는 삭제 버튼을 두지 않는다.
    let actions = '';
    if (_canWrite && !_selectMode) {
        const mark = checked ? 'x' : ' ';
        actions =
            '<div class="d-flex gap-1 flex-shrink-0">' +
            '<button type="button" class="btn btn-sm btn-wiki-outline" title="편집" onclick="window.editTodo(' + id + ')"><i class="bi bi-pencil"></i></button>' +
            '<button type="button" class="btn btn-sm btn-wiki-outline" title="복사 (- [' + mark + '] 형식)" onclick="window.copyTodoItem(' + id + ')"><i class="bi bi-clipboard"></i></button>' +
            '<button type="button" class="btn btn-sm btn-wiki-outline" title="보관" onclick="window.archiveTodo(' + id + ')"><i class="bi bi-archive"></i></button>' +
            '</div>';
    }

    const meta = t.created_by_name
        ? '<span class="text-muted small ms-2 flex-shrink-0">' + esc(t.created_by_name) + '</span>'
        : '';

    return (
        '<div class="list-group-item d-flex align-items-center gap-2" data-todo-id="' + id + '">' +
        leadingControl +
        '<div class="flex-grow-1 ' + textCls + '" data-todo-text>' +
        esc(t.content) + '</div>' +
        meta +
        actions +
        '</div>'
    );
}

function todoArchivedRow(t): string {
    const id = Number(t.id);
    const checked = Number(t.checked) === 1;
    const textCls = checked ? 'text-muted text-decoration-line-through' : '';
    const isSelected = _archivedSelectedIds.has(id);

    // 보관 섹션 선택 모드: 선택 체크박스 표시
    let leadingControl = '';
    if (_archivedSelectMode) {
        leadingControl =
            '<input type="checkbox" class="form-check-input mt-0 flex-shrink-0 todo-select-cb" ' +
            (isSelected ? 'checked' : '') +
            ' onchange="window.archivedTodoToggleSelect(' + id + ', this.checked)" aria-label="선택">';
    }

    let actions = '';
    if (_canWrite && !_archivedSelectMode) {
        actions =
            '<div class="d-flex gap-1 flex-shrink-0">' +
            '<button type="button" class="btn btn-sm btn-wiki-outline" title="복원" onclick="window.unarchiveTodo(' + id + ')"><i class="bi bi-archive-fill"></i></button>' +
            '<button type="button" class="btn btn-sm btn-wiki-danger" title="삭제" onclick="window.deleteTodo(' + id + ')"><i class="bi bi-trash"></i></button>' +
            '</div>';
    }

    const meta = t.created_by_name
        ? '<span class="text-muted small ms-2 flex-shrink-0">' + esc(t.created_by_name) + '</span>'
        : '';

    return (
        '<div class="list-group-item d-flex align-items-center gap-2 text-muted" data-todo-archived-id="' + id + '">' +
        leadingControl +
        '<div class="flex-grow-1 ' + textCls + '">' +
        esc(t.content) + '</div>' +
        meta +
        actions +
        '</div>'
    );
}

function updateBulkBar(): void {
    const bar = document.getElementById('todoBulkBar');
    const countEl = document.getElementById('todoBulkCount');
    const archiveBtn = document.getElementById('todoBulkArchiveBtn');
    if (!bar) return;

    const count = _selectedIds.size;
    if (!_selectMode || count === 0) {
        bar.classList.add('d-none');
        return;
    }
    bar.classList.remove('d-none');
    if (countEl) countEl.textContent = count + '개 선택됨';
    if (archiveBtn) archiveBtn.style.display = _canWrite ? '' : 'none';
}

function updateArchivedBulkBar(): void {
    const bar = document.getElementById('todoArchivedBulkBar');
    const countEl = document.getElementById('todoArchivedBulkCount');
    if (!bar) return;

    const count = _archivedSelectedIds.size;
    if (!_archivedSelectMode || count === 0) {
        bar.classList.add('d-none');
        return;
    }
    bar.classList.remove('d-none');
    if (countEl) countEl.textContent = count + '개 선택됨';
}

// '선택' 토글: 선택 모드 on/off. off 로 전환 시 선택 초기화.
function toggleSelectMode(): void {
    _selectMode = !_selectMode;
    if (!_selectMode) _selectedIds.clear();
    const btn = document.getElementById('todoSelectToggle');
    if (btn) {
        btn.classList.toggle('active', _selectMode);
        btn.setAttribute('aria-pressed', _selectMode ? 'true' : 'false');
    }
    renderTodos();
    updateBulkBar();
}

// 보관 섹션 '선택' 토글
function toggleArchivedSelectMode(): void {
    _archivedSelectMode = !_archivedSelectMode;
    if (!_archivedSelectMode) _archivedSelectedIds.clear();
    const btn = document.getElementById('todoArchivedSelectToggle');
    if (btn) {
        btn.classList.toggle('active', _archivedSelectMode);
        btn.setAttribute('aria-pressed', _archivedSelectMode ? 'true' : 'false');
    }
    renderArchivedList();
    updateArchivedBulkBar();
}

// 선택 토글: 카드 배경색은 바꾸지 않고 체크박스 상태로만 표시한다.
function todoToggleSelect(id: number, checked: boolean): void {
    if (checked) {
        _selectedIds.add(Number(id));
    } else {
        _selectedIds.delete(Number(id));
    }
    updateBulkBar();
}

function archivedTodoToggleSelect(id: number, checked: boolean): void {
    if (checked) {
        _archivedSelectedIds.add(Number(id));
    } else {
        _archivedSelectedIds.delete(Number(id));
    }
    updateArchivedBulkBar();
}

function todoToggleArchived(): void {
    _archivedOpen = !_archivedOpen;

    // 섹션 닫힐 때 보관 선택 모드 초기화
    if (!_archivedOpen) {
        _archivedSelectMode = false;
        _archivedSelectedIds.clear();
        const selectBtn = document.getElementById('todoArchivedSelectToggle');
        if (selectBtn) {
            selectBtn.classList.remove('active');
            selectBtn.setAttribute('aria-pressed', 'false');
        }
        updateArchivedBulkBar();
    }

    const listEl = document.getElementById('todoArchivedList');
    const chevron = document.getElementById('todoArchivedChevron');
    const selectToggle = document.getElementById('todoArchivedSelectToggle');

    if (listEl) {
        listEl.classList.toggle('d-none', !_archivedOpen);
    }
    if (chevron) {
        chevron.className = _archivedOpen ? 'bi bi-chevron-down' : 'bi bi-chevron-right';
    }
    // 선택 토글은 섹션이 열렸을 때만 표시
    if (selectToggle && _canWrite) {
        selectToggle.classList.toggle('d-none', !_archivedOpen);
    }

    if (_archivedOpen) {
        renderArchivedList();
    }
}

async function addTodo(): Promise<void> {
    const input = document.getElementById('todoAddInput') as HTMLInputElement | null;
    if (!input) return;
    const content = (input.value || '').trim();
    if (!content) return;

    input.disabled = true;
    try {
        const res = await fetch(_wsBase + '/todos', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            Swal.fire('추가 실패', body.error || '항목을 추가하지 못했습니다.', 'error');
            return;
        }
        input.value = '';
        await loadTodos();
        input.focus();
    } catch {
        Swal.fire('오류', '요청 중 문제가 발생했습니다.', 'error');
    } finally {
        input.disabled = false;
    }
}

// 낙관적 토글: 즉시 UI 반영 후 서버 요청. 실패 시 롤백.
async function toggleTodo(id: number, checked: boolean): Promise<void> {
    const idx = _todos.findIndex((t) => Number(t.id) === Number(id));
    const prev = idx >= 0 ? Number(_todos[idx].checked) : null;

    if (idx >= 0) {
        _todos[idx].checked = checked ? 1 : 0;
        renderTodos();
    }

    try {
        const res = await fetch(_wsBase + '/todos/' + Number(id), {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ checked: !!checked }),
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || '상태 변경 실패');
        }
    } catch (e) {
        if (idx >= 0 && prev !== null) {
            _todos[idx].checked = prev;
            renderTodos();
        }
        Swal.fire({
            toast: true, position: 'top-end', icon: 'error',
            title: String(e?.message || '변경 실패'),
            showConfirmButton: false, timer: 2500, timerProgressBar: true,
        });
    }
}

// 인라인 편집: 텍스트 영역 → input 교체, blur/Enter 저장, Esc 취소.
function editTodo(id: number): void {
    const row = document.querySelector('.list-group-item[data-todo-id="' + Number(id) + '"]');
    if (!row) return;
    const textEl = row.querySelector('[data-todo-text]');
    if (!textEl) return;
    const t = _todos.find((x) => Number(x.id) === Number(id));
    if (!t) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-control form-control-sm flex-grow-1';
    input.maxLength = 2000;
    input.value = t.content || '';
    textEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = async (save: boolean) => {
        if (done) return;
        done = true;
        const newVal = (input.value || '').trim();
        if (!save || !newVal || newVal === t.content) {
            renderTodos();
            return;
        }
        try {
            const res = await fetch(_wsBase + '/todos/' + Number(id), {
                method: 'PATCH',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: newVal }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                Swal.fire('수정 실패', body.error || '항목을 수정하지 못했습니다.', 'error');
                renderTodos();
                return;
            }
            t.content = newVal;
            renderTodos();
        } catch {
            Swal.fire('오류', '요청 중 문제가 발생했습니다.', 'error');
            renderTodos();
        }
    };

    input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
        else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
}

async function archiveTodo(id: number): Promise<void> {
    try {
        const res = await fetch(_wsBase + '/todos/' + Number(id), {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ archived: true }),
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            Swal.fire('보관 실패', body.error || '항목을 보관하지 못했습니다.', 'error');
            return;
        }
        await loadTodos();
    } catch {
        Swal.fire('오류', '요청 중 문제가 발생했습니다.', 'error');
    }
}

async function unarchiveTodo(id: number): Promise<void> {
    try {
        const res = await fetch(_wsBase + '/todos/' + Number(id), {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ archived: false }),
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            Swal.fire('복원 실패', body.error || '항목을 복원하지 못했습니다.', 'error');
            return;
        }
        await loadTodos();
    } catch {
        Swal.fire('오류', '요청 중 문제가 발생했습니다.', 'error');
    }
}

async function deleteTodo(id: number): Promise<void> {
    const result = await Swal.fire({
        title: '항목 삭제',
        text: '이 할 일을 삭제하시겠습니까?',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: '삭제',
        cancelButtonText: '취소',
        confirmButtonColor: '#dc3545',
    });
    if (!result.isConfirmed) return;

    try {
        const res = await fetch(_wsBase + '/todos/' + Number(id), {
            method: 'DELETE',
            credentials: 'same-origin',
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            Swal.fire('삭제 실패', body.error || '항목을 삭제하지 못했습니다.', 'error');
            return;
        }
        _todos = _todos.filter((t) => Number(t.id) !== Number(id));
        _archivedTodos = _archivedTodos.filter((t) => Number(t.id) !== Number(id));
        _selectedIds.delete(Number(id));
        _archivedSelectedIds.delete(Number(id));
        renderTodos();
        if (_mode === 'full') renderArchivedSection();
        updateBulkBar();
        updateArchivedBulkBar();
    } catch {
        Swal.fire('오류', '요청 중 문제가 발생했습니다.', 'error');
    }
}

async function todoBulkAction(action: 'archive' | 'unarchive' | 'delete'): Promise<void> {
    const ids = Array.from(_selectedIds);
    if (!ids.length) return;

    const labels = { archive: '보관', unarchive: '복원', delete: '삭제' };
    const label = labels[action] || action;

    if (action === 'delete') {
        const result = await Swal.fire({
            title: `${ids.length}개 항목 ${label}`,
            text: '선택한 항목을 삭제하시겠습니까?',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: label,
            cancelButtonText: '취소',
            confirmButtonColor: '#dc3545',
        });
        if (!result.isConfirmed) return;
    }

    try {
        const res = await fetch(_wsBase + '/todos/bulk', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, action }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            Swal.fire('실패', body.error || `${label}하지 못했습니다.`, 'error');
            return;
        }
        _selectedIds.clear();
        await loadTodos();
    } catch {
        Swal.fire('오류', '요청 중 문제가 발생했습니다.', 'error');
    }
}

// 보관된 항목 일괄 작업 (보관 해제 / 삭제)
async function archivedBulkAction(action: 'unarchive' | 'delete'): Promise<void> {
    const ids = Array.from(_archivedSelectedIds);
    if (!ids.length) return;

    const labels = { unarchive: '보관 해제', delete: '삭제' };
    const label = labels[action] || action;

    if (action === 'delete') {
        const result = await Swal.fire({
            title: `${ids.length}개 항목 ${label}`,
            text: '선택한 항목을 삭제하시겠습니까?',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: label,
            cancelButtonText: '취소',
            confirmButtonColor: '#dc3545',
        });
        if (!result.isConfirmed) return;
    }

    try {
        const res = await fetch(_wsBase + '/todos/bulk', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, action }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            Swal.fire('실패', body.error || `${label}하지 못했습니다.`, 'error');
            return;
        }
        _archivedSelectedIds.clear();
        await loadTodos();
    } catch {
        Swal.fire('오류', '요청 중 문제가 발생했습니다.', 'error');
    }
}

// 개별 항목을 `- [ ] 내용` 형식으로 클립보드에 복사한다.
function copyTodoItem(id: number): void {
    const t = _todos.find((x) => Number(x.id) === Number(id));
    if (!t) return;
    const mark = Number(t.checked) === 1 ? 'x' : ' ';
    const text = `- [${mark}] ${t.content}`;
    navigator.clipboard.writeText(text).then(() => {
        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: '복사됨', showConfirmButton: false, timer: 1500 });
    }).catch(() => {
        Swal.fire({ toast: true, position: 'top-end', icon: 'error', title: '복사 실패', showConfirmButton: false, timer: 2000 });
    });
}

// 전체 또는 선택 항목을 마크다운 체크리스트 형식으로 클립보드에 복사한다.
function todoCopy(scope: 'selected' | 'all'): void {
    let items: any[];
    if (scope === 'selected' && _selectedIds.size > 0) {
        items = _todos.filter((t) => _selectedIds.has(Number(t.id)));
    } else {
        items = [..._todos];
    }

    if (!items.length) {
        Swal.fire({ toast: true, position: 'top-end', icon: 'info', title: '복사할 항목이 없습니다.', showConfirmButton: false, timer: 2000 });
        return;
    }

    const lines = items.map((t) => {
        const checked = Number(t.checked) === 1 ? 'x' : ' ';
        return `- [${checked}] ${t.content}`;
    });
    const md = lines.join('\n') + '\n';

    navigator.clipboard.writeText(md).then(() => {
        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: `${items.length}개 항목 복사됨`, showConfirmButton: false, timer: 1500 });
    }).catch(() => {
        Swal.fire({ toast: true, position: 'top-end', icon: 'error', title: '복사 실패', showConfirmButton: false, timer: 2000 });
    });
}
