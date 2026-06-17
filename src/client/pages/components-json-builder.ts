/**
 * 컴포넌트 JSON 빌더(/components-json-builder) 클라이언트 스크립트.
 *
 * wrangler.toml 의 `SIDEBAR` / `FOOTER` 환경변수에 넣을 네비게이션 JSON 을
 * GUI 로 제작·편집하는 운영자용 보조 도구. 서버 호출 없이 전적으로 브라우저에서
 * 동작하며, 결과 JSON 을 복사해 운영자가 직접 `wrangler.toml` 에 붙여넣는다.
 *
 * - sweetalert2 (CDN, window.Swal) 로 항목 추가 모달/토스트를 표시한다.
 * - HTML on* 핸들러(onclick)에서 호출되는 함수는 window.* 로 노출한다.
 * - escapeHtml 은 공통 유틸을 재사용해 innerHTML 삽입을 안전하게 처리한다.
 */

import { escapeHtml } from '../utils/html';
import '../utils/swal';

type NavTarget = 'sidebar' | 'footer';
type NavItemType = 'link' | 'header' | 'text' | 'divider';

interface NavItem {
    type: NavItemType;
    text?: string;
    url?: string;
    icon?: string;
}

// 상태 관리를 위한 데이터 배열 (초기값 빈 배열)
const configData: Record<NavTarget, NavItem[]> = {
    sidebar: [],
    footer: [],
};

// 리스트 렌더링 및 JSON 업데이트 함수
function renderList(target: NavTarget): void {
    const listElement = document.getElementById(`${target}List`);
    const countElement = document.getElementById(`${target}Count`);
    if (!listElement || !countElement) return;
    const data = configData[target];

    countElement.textContent = String(data.length);

    if (data.length === 0) {
        listElement.innerHTML = `<div class="p-4 text-center text-muted small"><i class="mdi mdi-tray-open fs-3 d-block mb-2"></i>항목이 없습니다.</div>`;
    } else {
        listElement.innerHTML = data
            .map((item, idx) => {
                let badge = '';
                const iconHtml = item.icon ? `<i class="${escapeHtml(item.icon)} me-2"></i>` : '';

                if (item.type === 'header') badge = '<span class="badge badge-type bg-success-subtle text-success border border-success-subtle me-3">제목</span>';
                else if (item.type === 'link') badge = '<span class="badge badge-type bg-primary-subtle text-primary border border-primary-subtle me-3">링크</span>';
                else if (item.type === 'text') badge = '<span class="badge badge-type bg-secondary-subtle text-secondary border border-secondary-subtle me-3">텍스트</span>';
                else if (item.type === 'divider') badge = '<span class="badge badge-type bg-light text-muted border me-3">구분선</span>';

                let content = '';
                if (item.type === 'divider') {
                    content = `<span class="text-muted w-100"><hr class="my-1"></span>`;
                } else {
                    content = `
                        <div class="flex-grow-1 text-truncate">
                            <span class="fw-bold">${iconHtml}${escapeHtml(item.text || '')}</span>
                            ${item.url ? `<div class="text-muted small mt-1 text-truncate" style="font-family: monospace;"><i class="mdi mdi-link-variant me-1"></i>${escapeHtml(item.url)}</div>` : ''}
                        </div>
                    `;
                }

                return `
                <li class="list-group-item d-flex align-items-center">
                    <div class="d-flex flex-column me-2">
                        <button class="btn btn-link btn-control p-0" onclick="moveItem('${target}', ${idx}, -1)" ${idx === 0 ? 'disabled' : ''} title="위로 이동">
                            <i class="mdi mdi-menu-up"></i>
                        </button>
                        <button class="btn btn-link btn-control p-0" onclick="moveItem('${target}', ${idx}, 1)" ${idx === data.length - 1 ? 'disabled' : ''} title="아래로 이동">
                            <i class="mdi mdi-menu-down"></i>
                        </button>
                    </div>
                    ${badge}
                    ${content}
                    <button class="btn btn-link btn-delete ms-auto p-2" onclick="deleteItem('${target}', ${idx})" title="삭제">
                        <i class="mdi mdi-trash-can-outline fs-5"></i>
                    </button>
                </li>`;
            })
            .join('');
    }

    updateJsonOutput(target);
}

// JSON 출력 업데이트
function updateJsonOutput(target: NavTarget): void {
    const textarea = document.getElementById(`${target}JsonOut`) as HTMLTextAreaElement | null;
    if (!textarea) return;
    // JSON 결과물을 항상 minify 하여 출력
    textarea.value = JSON.stringify(configData[target]);
}

// 직접 입력한 JSON 적용하기
function applyJson(target: NavTarget): void {
    const textarea = document.getElementById(`${target}JsonOut`) as HTMLTextAreaElement | null;
    if (!textarea) return;
    const jsonString = textarea.value.trim();

    // 내용을 다 지우고 적용 버튼을 누른 경우 빈 배열 처리
    if (jsonString === '') {
        configData[target] = [];
        renderList(target);
        return;
    }

    try {
        const parsedData = JSON.parse(jsonString);

        // 최상위가 배열 형식인지 검사
        if (!Array.isArray(parsedData)) {
            throw new Error('JSON 최상위 형식은 배열([ ])이어야 합니다.');
        }

        configData[target] = parsedData as NavItem[];
        renderList(target);

        window.Swal?.fire({
            toast: true,
            position: 'top-end',
            icon: 'success',
            title: 'JSON 구조가 화면에 적용되었습니다.',
            showConfirmButton: false,
            timer: 1500,
        });
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        window.Swal?.fire({
            icon: 'error',
            title: 'JSON 형식 오류',
            html: `입력한 JSON 형식이 올바르지 않습니다.<br><br><small class="text-danger text-start d-block bg-light p-2 rounded">${escapeHtml(message)}</small>`,
        });
    }
}

// 항목 추가 모달 (SweetAlert2)
async function addItem(target: NavTarget, type: NavItemType): Promise<void> {
    if (type === 'divider') {
        configData[target].push({ type: 'divider' });
        renderList(target);
        return;
    }

    let title = '';
    if (type === 'header') title = '제목 (Header) 추가';
    if (type === 'link') title = '링크 (Link) 추가';
    if (type === 'text') title = '텍스트 (Text) 추가';

    let html = `
        <div class="mb-3 text-start">
            <label class="form-label small fw-bold">표시 텍스트 <span class="text-danger">*</span></label>
            <input id="swal-input-text" class="form-control" placeholder="표시될 텍스트를 입력하세요">
        </div>
    `;

    if (type === 'link') {
        html += `
            <div class="mb-3 text-start">
                <label class="form-label small fw-bold">이동할 URL <span class="text-danger">*</span></label>
                <input id="swal-input-url" class="form-control" placeholder="https://...">
            </div>
        `;
    }

    if (type !== 'header') {
        html += `
            <div class="mb-3 text-start">
                <label class="form-label small fw-bold">아이콘 (선택)</label>
                <div class="input-group">
                    <span class="input-group-text"><i class="mdi mdi-star-outline"></i></span>
                    <input id="swal-input-icon" class="form-control" placeholder="예: mdi mdi-home">
                </div>
                <div class="form-text small">MDI 또는 부트스트랩 아이콘 클래스명을 입력하세요.</div>
            </div>
        `;
    }

    const result = await window.Swal?.fire<NavItem | false>({
        title,
        html,
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: '추가하기',
        cancelButtonText: '취소',
        confirmButtonColor: target === 'sidebar' ? '#0d6efd' : '#0dcaf0',
        preConfirm: () => {
            const textInput = document.getElementById('swal-input-text') as HTMLInputElement | null;
            const urlInput = document.getElementById('swal-input-url') as HTMLInputElement | null;
            const iconInput = document.getElementById('swal-input-icon') as HTMLInputElement | null;
            const text = textInput ? textInput.value.trim() : '';
            const url = urlInput ? urlInput.value.trim() : '';
            const icon = iconInput ? iconInput.value.trim() : '';

            if (!text) {
                window.Swal?.showValidationMessage('표시 텍스트를 입력해주세요.');
                return false;
            }
            if (type === 'link' && !url) {
                window.Swal?.showValidationMessage('이동할 URL을 입력해주세요.');
                return false;
            }

            const item: NavItem = { type, text };
            if (url) item.url = url;
            if (icon) item.icon = icon;
            return item;
        },
    });

    const formValues = result?.value;
    if (formValues) {
        configData[target].push(formValues);
        renderList(target);

        window.Swal?.fire({
            toast: true,
            position: 'top-end',
            icon: 'success',
            title: '추가되었습니다.',
            showConfirmButton: false,
            timer: 1500,
        });
    }
}

// 항목 이동 (위/아래)
function moveItem(target: NavTarget, index: number, direction: number): void {
    const arr = configData[target];
    const newIndex = index + direction;

    if (newIndex < 0 || newIndex >= arr.length) return;

    [arr[index], arr[newIndex]] = [arr[newIndex], arr[index]];

    renderList(target);
}

// 항목 삭제
function deleteItem(target: NavTarget, index: number): void {
    configData[target].splice(index, 1);
    renderList(target);
}

// 전체 초기화
function clearAll(): void {
    window.Swal?.fire({
        title: '전체 초기화',
        text: '모든 구성 항목을 삭제하시겠습니까?',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#dc3545',
        confirmButtonText: '네, 삭제합니다',
        cancelButtonText: '취소',
    }).then((res) => {
        if (res?.isConfirmed) {
            configData.sidebar = [];
            configData.footer = [];
            renderList('sidebar');
            renderList('footer');
        }
    });
}

function showCopySuccess(): void {
    window.Swal?.fire({
        toast: true,
        position: 'top-end',
        icon: 'success',
        title: '클립보드에 복사되었습니다.',
        showConfirmButton: false,
        timer: 1500,
    });
}

// 클립보드에 JSON 복사
function copyJson(target: NavTarget): void {
    const textarea = document.getElementById(`${target}JsonOut`) as HTMLTextAreaElement | null;
    if (!textarea) return;

    textarea.select();
    textarea.setSelectionRange(0, 99999);

    try {
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(textarea.value).then(() => {
                showCopySuccess();
            });
        } else {
            document.execCommand('copy');
            showCopySuccess();
        }
    } catch {
        window.Swal?.fire('실패', '복사 중 오류가 발생했습니다.', 'error');
    }

    window.getSelection()?.removeAllRanges();
}

// HTML on* 핸들러용 전역 노출
declare global {
    interface Window {
        addItem: typeof addItem;
        applyJson: typeof applyJson;
        copyJson: typeof copyJson;
        clearAll: typeof clearAll;
        moveItem: typeof moveItem;
        deleteItem: typeof deleteItem;
    }
}

window.addItem = addItem;
window.applyJson = applyJson;
window.copyJson = copyJson;
window.clearAll = clearAll;
window.moveItem = moveItem;
window.deleteItem = deleteItem;

// 초기 렌더링
document.addEventListener('DOMContentLoaded', () => {
    renderList('sidebar');
    renderList('footer');
});
