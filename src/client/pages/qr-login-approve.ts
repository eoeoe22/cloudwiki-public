/**
 * QR 로그인 승인 페이지(/qr-login/:token) 클라이언트 — 호스트(로그인된) 기기.
 *
 * 흐름:
 *  1. URL 경로에서 token 을 읽는다.
 *  2. GET /api/qr-login/info 로 로그인될 계정(본인)과 게스트 기기 정보를 불러와 표시.
 *  3. "확인" → POST /api/qr-login/approve, "취소" → POST /api/qr-login/cancel.
 *
 * 세션 쿠키는 게스트 기기(폴링 후 redeem)에 발급되며, 이 페이지는 승인 신호만 보낸다.
 */

import type { QrLoginInfoResponse } from '../../shared/api/qr-login';

const DEFAULT_AVATAR = '/avatar-default.svg';

function $(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function tokenFromPath(): string {
    // /qr-login/<token>
    const m = window.location.pathname.match(/^\/qr-login\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : '';
}

function show(id: string): void {
    $(id)?.classList.remove('qr-hidden');
}
function hide(id: string): void {
    $(id)?.classList.add('qr-hidden');
}

function setStatus(msg: string, kind: 'muted' | 'error' | 'success' = 'muted'): void {
    const el = $('qrStatus');
    if (!el) return;
    el.textContent = msg;
    el.style.color =
        kind === 'error' ? 'var(--wiki-danger, #dc3545)'
        : kind === 'success' ? 'var(--wiki-primary)'
        : 'var(--wiki-text-muted)';
}

/** 결과 화면(성공/취소/오류)으로 전환한다. */
function showResult(icon: string, message: string, iconColor?: string): void {
    hide('qrLoading');
    hide('qrApprovePanel');
    setStatus('');
    const iconEl = $('qrResultIcon');
    if (iconEl) {
        iconEl.className = 'mdi qr-approve-icon ' + icon;
        if (iconColor) iconEl.style.color = iconColor;
    }
    const msgEl = $('qrResultMessage');
    if (msgEl) msgEl.textContent = message;
    show('qrResult');
}

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: any }> {
    const res = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    let data: any = null;
    try {
        data = await res.json();
    } catch {
        // ignore
    }
    return { ok: res.ok, status: res.status, data };
}

function renderInfo(info: QrLoginInfoResponse): void {
    const avatar = $('qrAccountAvatar') as HTMLImageElement | null;
    if (avatar) {
        avatar.src = info.account.picture || DEFAULT_AVATAR;
        avatar.onerror = () => {
            avatar.onerror = null;
            avatar.src = DEFAULT_AVATAR;
        };
    }
    const nameEl = $('qrAccountName');
    if (nameEl) nameEl.textContent = info.account.name;

    const uaEl = $('qrGuestUa');
    if (uaEl) uaEl.textContent = info.guest.user_agent || '(알 수 없는 기기)';

    hide('qrLoading');
    show('qrApprovePanel');
}

function bindActions(token: string): void {
    const approveBtn = $('qrApproveBtn') as HTMLButtonElement | null;
    const cancelBtn = $('qrCancelBtn') as HTMLButtonElement | null;

    approveBtn?.addEventListener('click', async () => {
        if (approveBtn.disabled) return;
        approveBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = true;
        setStatus('승인 중…', 'muted');
        try {
            const { ok, data } = await postJson('/api/qr-login/approve', { token });
            if (ok) {
                showResult('mdi-check-circle-outline', '로그인을 승인했습니다. 다른 기기에서 로그인이 완료됩니다.', 'var(--wiki-primary)');
            } else {
                setStatus(data?.error || '승인에 실패했습니다.', 'error');
                approveBtn.disabled = false;
                if (cancelBtn) cancelBtn.disabled = false;
            }
        } catch {
            setStatus('네트워크 오류가 발생했습니다. 다시 시도해주세요.', 'error');
            approveBtn.disabled = false;
            if (cancelBtn) cancelBtn.disabled = false;
        }
    });

    cancelBtn?.addEventListener('click', async () => {
        if (cancelBtn.disabled) return;
        cancelBtn.disabled = true;
        if (approveBtn) approveBtn.disabled = true;
        setStatus('취소 중…', 'muted');
        try {
            await postJson('/api/qr-login/cancel', { token });
        } catch {
            // 취소는 best-effort — 실패해도 결과 화면으로 넘어간다.
        }
        showResult('mdi-close-circle-outline', '로그인 요청을 취소했습니다.', 'var(--wiki-text-muted)');
    });
}

async function init(): Promise<void> {
    const token = tokenFromPath();
    if (!token) {
        showResult('mdi-alert-circle-outline', '유효하지 않은 QR 코드입니다.', 'var(--wiki-danger, #dc3545)');
        return;
    }

    let res: Response;
    try {
        res = await fetch('/api/qr-login/info?token=' + encodeURIComponent(token), { credentials: 'same-origin' });
    } catch {
        showResult('mdi-alert-circle-outline', '정보를 불러오지 못했습니다. 다시 시도해주세요.', 'var(--wiki-danger, #dc3545)');
        return;
    }

    // HTTP 상태를 구조적으로 분기한다(에러 메시지 문자열 매칭 금지 — token 이 메시지에 섞여 오탐).
    if (res.status === 401) {
        // 세션 만료/비로그인 → 로그인 후 이 승인 페이지로 복귀.
        window.location.href = '/login?redirect=' + encodeURIComponent(window.location.pathname);
        return;
    }
    if (!res.ok) {
        showResult('mdi-alert-circle-outline', 'QR 코드를 찾을 수 없거나 만료되었습니다.', 'var(--wiki-danger, #dc3545)');
        return;
    }

    let info: QrLoginInfoResponse;
    try {
        info = (await res.json()) as QrLoginInfoResponse;
    } catch {
        showResult('mdi-alert-circle-outline', '정보를 불러오지 못했습니다. 다시 시도해주세요.', 'var(--wiki-danger, #dc3545)');
        return;
    }

    // 이미 처리됐거나 만료된 경우: 승인 버튼 대신 안내만 표시.
    if (info.status !== 'pending') {
        const messages: Record<string, string> = {
            approved: '이미 승인된 요청입니다.',
            consumed: '이미 로그인이 완료된 요청입니다.',
            cancelled: '취소된 요청입니다.',
            expired: 'QR 코드가 만료되었습니다. 기기에서 새 QR 코드를 발급받으세요.',
        };
        showResult('mdi-information-outline', messages[info.status] || '처리할 수 없는 요청입니다.', 'var(--wiki-text-muted)');
        return;
    }

    renderInfo(info);
    bindActions(token);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
