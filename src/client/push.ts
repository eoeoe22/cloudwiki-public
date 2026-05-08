// 브라우저 측 Web Push 매니저.
// common.ts (전체 페이지) 와 setup-profile (가입 신청 옵트인) 양쪽에서 import 한다.
//
// 동작 흐름:
//  1. 브라우저 지원 + VAPID 활성 여부 확인
//  2. Notification.requestPermission()
//  3. navigator.serviceWorker.register('/sw.js')
//  4. PushManager.subscribe({ userVisibleOnly:true, applicationServerKey })
//  5. 서버에 /api/push/subscribe (또는 -signup) POST

type PublicKeyResponse = { enabled: boolean; public_key: string | null };

export type PushBootstrap =
    | { kind: 'unsupported'; reason: string }
    | { kind: 'disabled' }
    | { kind: 'denied' }
    | { kind: 'ready'; publicKey: string };

function isPushSupported(): boolean {
    return (
        typeof window !== 'undefined' &&
        'serviceWorker' in navigator &&
        'PushManager' in window &&
        'Notification' in window
    );
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    // Allocate a fresh ArrayBuffer (not SharedArrayBuffer) so that BufferSource overloads accept it.
    const buf = new ArrayBuffer(raw.length);
    const out = new Uint8Array(buf);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out as Uint8Array<ArrayBuffer>;
}

async function fetchPublicKey(): Promise<PublicKeyResponse | null> {
    try {
        const res = await fetch('/api/push/public-key', { credentials: 'same-origin' });
        if (!res.ok) return null;
        return (await res.json()) as PublicKeyResponse;
    } catch {
        return null;
    }
}

/**
 * 푸시 부트스트랩 — 권한 요청 없이 현재 상태만 점검.
 * UI 가 토글 표시 여부를 결정할 때 사용.
 */
export async function checkPushAvailability(): Promise<PushBootstrap> {
    if (!isPushSupported()) return { kind: 'unsupported', reason: '브라우저가 푸시를 지원하지 않습니다.' };

    const info = await fetchPublicKey();
    if (!info || !info.enabled || !info.public_key) return { kind: 'disabled' };

    if (Notification.permission === 'denied') return { kind: 'denied' };

    return { kind: 'ready', publicKey: info.public_key };
}

async function getOrCreateRegistration(): Promise<ServiceWorkerRegistration> {
    const existing = await navigator.serviceWorker.getRegistration('/');
    if (existing) return existing;
    return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

async function ensurePermission(): Promise<boolean> {
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    const result = await Notification.requestPermission();
    return result === 'granted';
}

async function getOrCreateSubscription(reg: ServiceWorkerRegistration, publicKey: string): Promise<PushSubscription> {
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
        // 현재 등록된 키와 다르면 재구독
        const currentKey = existing.options?.applicationServerKey;
        if (currentKey) {
            const currentKeyB64 = btoa(String.fromCharCode(...new Uint8Array(currentKey as ArrayBuffer)))
                .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            if (currentKeyB64 === publicKey) return existing;
        }
        await existing.unsubscribe().catch(() => {});
    }
    return reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
}

function subscriptionToJson(sub: PushSubscription): {
    endpoint: string;
    keys: { p256dh: string; auth: string };
} {
    const json = sub.toJSON();
    return {
        endpoint: json.endpoint!,
        keys: {
            p256dh: json.keys?.p256dh || '',
            auth: json.keys?.auth || '',
        },
    };
}

/**
 * 가입 완료 유저용 구독.
 * 이미 권한이 거부되었거나 비지원이면 false 반환.
 */
export async function subscribeForUser(): Promise<{ success: boolean; reason?: string }> {
    const status = await checkPushAvailability();
    if (status.kind !== 'ready') return { success: false, reason: status.kind };

    if (!(await ensurePermission())) return { success: false, reason: 'denied' };

    try {
        const reg = await getOrCreateRegistration();
        const sub = await getOrCreateSubscription(reg, status.publicKey);
        const payload = subscriptionToJson(sub);

        const res = await fetch('/api/push/subscribe', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            return { success: false, reason: 'server' };
        }
        return { success: true };
    } catch (e) {
        console.error('[push] subscribe failed', e);
        return { success: false, reason: 'error' };
    }
}

/**
 * 가입 신청자(승인제 단계)용 옵트인 구독 — user gesture 안에서 호출되는 준비 단계.
 *
 * Firefox / Safari 등 일부 브라우저는 await 이후에 user gesture 컨텍스트가 만료되면
 * Notification.requestPermission() 과 PushManager.subscribe() 를 거부한다. 따라서
 * 폼 제출 fetch 를 호출하기 *전에* 본 함수를 사용해 권한과 구독을 미리 받아두고,
 * fetch 응답에서 push_token 을 얻은 뒤 registerSignupPushSubscription 으로 서버 등록만 별도로 수행한다.
 */
export async function prepareSignupPushSubscription(): Promise<
    | { ok: true; payload: { endpoint: string; keys: { p256dh: string; auth: string } } }
    | { ok: false; reason: string }
> {
    const status = await checkPushAvailability();
    if (status.kind !== 'ready') return { ok: false, reason: status.kind };

    if (!(await ensurePermission())) return { ok: false, reason: 'denied' };

    try {
        const reg = await getOrCreateRegistration();
        const sub = await getOrCreateSubscription(reg, status.publicKey);
        return { ok: true, payload: subscriptionToJson(sub) };
    } catch (e) {
        console.error('[push] prepareSignupPushSubscription failed', e);
        return { ok: false, reason: 'error' };
    }
}

/**
 * prepareSignupPushSubscription 으로 미리 받아둔 구독을 서버에 등록한다.
 * pushToken 은 가입 신청 제출 응답에서 받은 단발성 KV 토큰이다.
 */
export async function registerSignupPushSubscription(
    payload: { endpoint: string; keys: { p256dh: string; auth: string } },
    pushToken: string,
): Promise<{ success: boolean; reason?: string }> {
    try {
        const res = await fetch('/api/push/subscribe-signup', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payload, push_token: pushToken }),
        });
        if (!res.ok) return { success: false, reason: 'server' };
        return { success: true };
    } catch (e) {
        console.error('[push] registerSignupPushSubscription failed', e);
        return { success: false, reason: 'error' };
    }
}

/**
 * 구독 해제. 본인 user_id 행만 서버에서 제거.
 */
export async function unsubscribe(): Promise<{ success: boolean }> {
    if (!isPushSupported()) return { success: true };

    try {
        const reg = await navigator.serviceWorker.getRegistration('/');
        if (!reg) return { success: true };
        const sub = await reg.pushManager.getSubscription();
        if (!sub) return { success: true };

        const endpoint = sub.endpoint;
        await sub.unsubscribe().catch(() => {});

        await fetch('/api/push/subscribe', {
            method: 'DELETE',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint }),
        }).catch(() => {});

        return { success: true };
    } catch (e) {
        console.error('[push] unsubscribe failed', e);
        return { success: false };
    }
}

export async function isCurrentlySubscribed(): Promise<boolean> {
    if (!isPushSupported()) return false;
    if (Notification.permission !== 'granted') return false;
    try {
        const reg = await navigator.serviceWorker.getRegistration('/');
        if (!reg) return false;
        const sub = await reg.pushManager.getSubscription();
        return !!sub;
    } catch {
        return false;
    }
}
