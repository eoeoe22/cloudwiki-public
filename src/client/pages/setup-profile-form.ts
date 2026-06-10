// @ts-nocheck — setup-profile.html 의 인라인 classic <script>(폼 제출/UI 분기)를
// 동작 보존 우선으로 이관한 모듈이다. common.ts 와 동일한 사유(CDN 글로벌 Swal,
// DOM 캐스팅, any 형태 fetch 응답)로 1차 이관 단계에서는 타입 검사를 끈다.
//
// 같은 페이지의 setup-profile.ts 는 Web Push 옵트인 헬퍼만 담당하며 타입이 적용돼
// 있다. 본 모듈은 그 헬퍼를 window.prepareSignupPushSubscription /
// window.registerSignupPushSubscription 으로 호출한다.
//
// 이관 규칙: common.ts 가 window.* 로 노출하는 전역(loadConfig / checkAuth /
// currentUser / escapeHtml)은 모듈 스코프에서 bare 로 해석되지 않으므로 window.*
// 로 접근한다. onclick 에서 호출되는 saveProfile 은 파일 끝에서 window 로 노출한다.

// 승인제 모드 여부 확인
const urlParams = new URLSearchParams(window.location.search);
const isApprovalMode = urlParams.get('mode') === 'approval';
const signupToken = urlParams.get('token') || '';

document.addEventListener('DOMContentLoaded', async () => {
    await window.loadConfig();

    if (isApprovalMode) {
        // 승인제 모드: 비인증 상태이므로 checkAuth 건너뛰기
        if (!signupToken) {
            Swal.fire('오류', '유효하지 않은 접근입니다.', 'error').then(() => {
                window.location.href = '/';
            });
            return;
        }

        // UI 변경
        document.getElementById('setupIcon').className = 'mdi mdi-account-clock-outline setup-icon';
        document.getElementById('setupTitle').textContent = '가입 신청';
        document.getElementById('setupSubtitle').textContent = '사용할 표시명을 입력하고 가입을 신청해주세요. 관리자 승인 후 이용 가능합니다.';
        document.getElementById('signupMessageGroup').style.display = '';
        document.getElementById('submitBtn').textContent = '가입 신청하기';
        document.getElementById('statusMessage').innerHTML = '<i class="mdi mdi-information-outline"></i> 관리자가 신청을 확인한 후 승인 또는 거절합니다.';
    } else {
        await window.checkAuth();

        if (!window.currentUser) {
            window.location.href = '/login';
            return;
        }

        // 구글에서 받아온 기본 이름 세팅
        document.getElementById('nameInput').value = window.currentUser.name;

        // 표시명 설정 상태(메시지) 확인
        try {
            const res = await fetch('/api/me/namechange-status');
            if (res.ok) {
                const data = await res.json();
                if (data.message) {
                    const statusEl = document.getElementById('statusMessage');

                    if (data.message.includes('불가능')) {
                        statusEl.innerHTML = '<i class="mdi mdi-alert-circle"></i> <span class="text-danger fw-bold">' + window.escapeHtml(data.message) + '</span>';
                    } else {
                        statusEl.innerHTML = '<i class="mdi mdi-information-outline"></i> ' + window.escapeHtml(data.message);
                    }
                }
            }
        } catch (e) {
            console.error(e);
        }
    }
});

async function saveProfile() {
    const name = document.getElementById('nameInput').value.trim();
    if (!name) {
        Swal.fire('오류', '이름을 입력해주세요.', 'warning');
        return;
    }
    if (name.length > 20) {
        Swal.fire('오류', '표시명은 20자 이내로 입력해주세요.', 'warning');
        return;
    }

    const picturePrivate = !!document.getElementById('picturePrivateOptIn')?.checked;

    const btn = document.getElementById('submitBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 처리 중...';

    try {
        if (isApprovalMode) {
            // 승인제: 가입 신청 제출
            const message = document.getElementById('signupMessage').value.trim();

            // user gesture 컨텍스트 보존: Firefox/Safari 는 await 이후 권한 요청을 거부한다.
            // 따라서 옵트인된 경우 fetch 보다 먼저 권한+PushManager.subscribe 를 받아둔다.
            let preparedPush = null;
            const pushOptIn = document.getElementById('pushOptIn');
            if (pushOptIn && pushOptIn.checked && typeof window.prepareSignupPushSubscription === 'function') {
                try {
                    const prep = await window.prepareSignupPushSubscription();
                    if (prep && prep.ok) preparedPush = prep.payload;
                } catch (e) {
                    console.warn('push prepare failed', e);
                }
            }

            const res = await fetch('/api/auth/signup-request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: signupToken, name, message, picture_private: picturePrivate })
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '가입 신청에 실패했습니다.');

            // 신청 성공 + 미리 받아둔 구독이 있으면 단발성 push_token 으로 서버 등록 (실패는 무시)
            if (preparedPush && typeof window.registerSignupPushSubscription === 'function' && data.push_token) {
                try { await window.registerSignupPushSubscription(preparedPush, data.push_token); } catch (e) { console.warn('push register failed', e); }
            }

            Swal.fire({
                icon: 'success',
                title: '가입 신청 완료',
                text: '관리자 승인 후 이용 가능합니다.',
                confirmButtonText: '확인'
            }).then(() => {
                window.location.href = '/?info=signup_submitted';
            });
        } else {
            // 일반 모드: 프로필 저장
            const res = await fetch('/api/me/profile', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '저장에 실패했습니다.');

            // 사진 비공개를 선택했으면 별도 엔드포인트로 반영 (실패해도 가입 자체는 완료된 것으로 처리)
            if (picturePrivate) {
                try {
                    await fetch('/api/me/picture-privacy', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ private: true })
                    });
                } catch (e) {
                    console.warn('picture privacy set failed', e);
                }
            }

            Swal.fire({
                icon: 'success',
                title: '설정 완료!',
                text: 'CloudWiki에 오신 것을 환영합니다.',
                showConfirmButton: false,
                timer: 1500
            }).then(() => {
                window.location.href = '/';
            });
        }
    } catch (err) {
        btn.disabled = false;
        btn.textContent = isApprovalMode ? '가입 신청하기' : '시작하기';
        Swal.fire('오류', err.message, 'error');
    }
}

// HTML onclick 속성(#submitBtn)에서 호출되므로 window 로 노출한다.
window.saveProfile = saveProfile;
