// Service Worker — Web Push 수신 + notificationclick 라우팅 전담.
// 자산 캐싱 등 PWA 기능은 포함하지 않는다 (의도적 미니멀).
//
// 빌드: vite → public/dist/sw.js. Worker 가 /sw.js → /dist/sw.js 로 위임하면서
// `Service-Worker-Allowed: /` 헤더를 추가해 root scope 를 부여한다.
//
// classic-script-global 호환은 필요 없다. 이 파일은 service worker 컨텍스트에서만 평가된다.

/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

type PushPayload = {
    title?: string;
    body?: string;
    url?: string;
    tag?: string;
    icon?: string;
};

self.addEventListener('install', () => {
    // 새 SW 가 즉시 활성화되도록 (사용자가 명시적으로 푸시 옵트인 직후 적용 필요)
    void self.skipWaiting();
});

self.addEventListener('activate', (event: ExtendableEvent) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event: PushEvent) => {
    let payload: PushPayload = {};
    try {
        payload = event.data ? (event.data.json() as PushPayload) : {};
    } catch {
        // 텍스트 페이로드 fallback
        payload = { body: event.data?.text() || '' };
    }

    const title = payload.title || '알림';
    const options: NotificationOptions = {
        body: payload.body || '',
        tag: payload.tag,
        icon: payload.icon || '/favicon.jpg',
        badge: '/favicon.jpg',
        data: { url: payload.url || '/' },
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
    event.notification.close();
    const targetUrl = (event.notification.data && (event.notification.data as { url?: string }).url) || '/';

    event.waitUntil((async () => {
        let targetURL: URL;
        try {
            targetURL = new URL(targetUrl, self.location.origin);
        } catch {
            targetURL = new URL('/', self.location.origin);
        }

        const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

        // pathname + search 가 정확히 일치하는 창에만 포커스. substring 매칭은
        // targetUrl 이 '/' 일 때 모든 same-origin 탭이 매칭되어 잘못된 탭이 포커스되는 문제.
        for (const client of allClients) {
            try {
                const clientURL = new URL(client.url);
                if (clientURL.origin === targetURL.origin
                    && clientURL.pathname === targetURL.pathname
                    && clientURL.search === targetURL.search) {
                    if ('focus' in client) return (client as WindowClient).focus();
                }
            } catch {
                // 파싱 실패한 client.url 은 무시
            }
        }

        // 일치 창이 없으면 새 창
        if (self.clients.openWindow) {
            return self.clients.openWindow(targetURL.href);
        }
    })());
});

export {};
