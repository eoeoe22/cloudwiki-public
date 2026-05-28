// setup-profile 페이지 보조 모듈.
// setup-profile-form 모듈이 폼 제출과 UI 분기를 담당하고, 본 모듈은 Web Push 옵트인 헬퍼만 노출한다.
//
// 라이프사이클:
//  - DOMContentLoaded 시점에 푸시 가용성을 확인해 #pushOptInGroup 토글
//  - setup-profile-form 모듈이 가입 신청 성공 시 window.subscribeForSignupRequest(requestId) 호출

import { checkPushAvailability, prepareSignupPushSubscription, registerSignupPushSubscription, subscribeForUser } from '../push';

type SignupPushPayload = { endpoint: string; keys: { p256dh: string; auth: string } };

declare global {
    interface Window {
        prepareSignupPushSubscription?: () => Promise<
            | { ok: true; payload: SignupPushPayload }
            | { ok: false; reason: string }
        >;
        registerSignupPushSubscription?: (payload: SignupPushPayload, pushToken: string) => Promise<{ success: boolean; reason?: string }>;
        subscribeForUser?: () => Promise<{ success: boolean; reason?: string }>;
    }
}

window.prepareSignupPushSubscription = prepareSignupPushSubscription;
window.registerSignupPushSubscription = registerSignupPushSubscription;
window.subscribeForUser = subscribeForUser;

document.addEventListener('DOMContentLoaded', async () => {
    const optInGroup = document.getElementById('pushOptInGroup');
    if (!optInGroup) return;

    const status = await checkPushAvailability();
    if (status.kind === 'ready') {
        optInGroup.style.display = '';
    } else {
        optInGroup.style.display = 'none';
    }
});
