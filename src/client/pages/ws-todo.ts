// @ts-nocheck — 워크스페이스 TODO 리스트 상세 페이지 부트스트랩 (/ws/:wslug/todos).
// common.ts 가 window.* 로 노출하는 공통 전역(loadConfig/checkAuth)을 사용한다.
// 실제 목록 렌더/조작은 workspace/todo.ts 의 initTodoPanel(mode:'full') 이 담당한다.

import { apiGet } from '../utils/api';
import { initTodoPanel } from '../workspace/todo';

// /ws/<wslug>/todos 에서 wslug 파싱
function parseWslug(): string {
    const parts = location.pathname.split('/').filter(Boolean); // ['ws', wslug, 'todos']
    if (parts[0] !== 'ws' || !parts[1]) return '';
    try { return decodeURIComponent(parts[1]); } catch { return parts[1]; }
}

const WSLUG = parseWslug();

document.addEventListener('DOMContentLoaded', async () => {
    await window.loadConfig();
    await window.checkAuth();
    await init();
});

async function init(): Promise<void> {
    const loadingEl = document.getElementById('todoLoading');
    const contentEl = document.getElementById('todoContent');
    const errorEl = document.getElementById('todoError');

    if (!WSLUG) {
        loadingEl?.classList.add('d-none');
        errorEl?.classList.remove('d-none');
        return;
    }

    let meta;
    try {
        meta = await apiGet('/api/ws/' + encodeURIComponent(WSLUG));
    } catch (e) {
        loadingEl?.classList.add('d-none');
        if (/403/.test(String(e?.message || ''))) {
            const t = document.getElementById('todoErrorTitle');
            if (t) t.textContent = '접근 권한이 없습니다';
        }
        errorEl?.classList.remove('d-none');
        return;
    }

    const ws = meta.workspace || {};
    const access = meta.access || {};
    const canWrite = !!access.canWrite;

    // 브레드크럼 워크스페이스 링크
    const bcrWsLink = document.getElementById('bcrWsLink');
    const bcrWsName = document.getElementById('bcrWsName');
    if (bcrWsLink) bcrWsLink.setAttribute('href', '/ws/' + encodeURIComponent(WSLUG));
    if (bcrWsName) bcrWsName.textContent = ws.name || ws.slug || WSLUG;

    loadingEl?.classList.add('d-none');
    contentEl?.classList.remove('d-none');

    initTodoPanel({ wslug: WSLUG, canWrite, mode: 'full' });
}
