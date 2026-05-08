// Web Push 발송 헬퍼.
// @block65/webcrypto-web-push 가 VAPID JWT (ES256) + ECDH/HKDF/AES-GCM 페이로드 암호화 (aesgcm) 를 처리한다.
// 본 모듈은 D1 의 push_subscriptions 행을 읽어 RFC 8030 push service 로 POST 한다.
//
// 도달 보장 없음. in-app 알림이 truth source 이며 본 채널은 best-effort 부가 알림이다.
// 410 Gone / 404 Not Found 응답은 영구 실패로 보고 해당 구독을 삭제한다.

import { buildPushPayload, type PushMessage, type PushSubscription, type VapidKeys } from '@block65/webcrypto-web-push';
import type { Env } from '../types';

export type PushPayload = {
    title: string;
    body: string;
    url?: string;     // 클릭 시 이동할 URL
    tag?: string;     // 동일 tag 푸시는 OS 가 1개로 합침
    icon?: string;
};

type SubscriptionRow = {
    id: number;
    endpoint: string;
    p256dh: string;
    auth: string;
};

function getVapidKeys(env: Env['Bindings']): VapidKeys | null {
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
        return null;
    }
    return {
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
        subject: env.VAPID_SUBJECT,
    };
}

export function isPushEnabled(env: Env['Bindings']): boolean {
    return getVapidKeys(env) !== null;
}

async function deleteSubscription(env: Env['Bindings'], id: number): Promise<void> {
    try {
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(id).run();
    } catch (e) {
        console.error('[push] delete subscription failed', id, e);
    }
}

async function sendOne(
    env: Env['Bindings'],
    vapid: VapidKeys,
    sub: SubscriptionRow,
    payload: PushPayload,
): Promise<void> {
    const message: PushMessage = {
        data: {
            title: payload.title,
            body: payload.body,
            url: payload.url || '/',
            tag: payload.tag,
            icon: payload.icon,
        },
        options: { ttl: 60 * 60 * 24, urgency: 'normal' as const },
    };

    const subscription: PushSubscription = {
        endpoint: sub.endpoint,
        expirationTime: null,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
    };

    let built: Awaited<ReturnType<typeof buildPushPayload>>;
    try {
        built = await buildPushPayload(message, subscription, vapid);
    } catch (e) {
        console.error('[push] buildPushPayload failed', sub.endpoint, e);
        return;
    }

    let res: Response;
    try {
        res = await fetch(sub.endpoint, {
            method: built.method.toUpperCase(),
            headers: built.headers as Record<string, string>,
            body: built.body,
        });
    } catch (e) {
        console.error('[push] fetch failed', sub.endpoint, e);
        return;
    }

    // 410 Gone / 404 Not Found: 해당 구독은 영구 무효 → DB 정리
    if (res.status === 404 || res.status === 410) {
        await deleteSubscription(env, sub.id);
        return;
    }
    if (res.status >= 400) {
        const text = await res.text().catch(() => '');
        console.error('[push] push service error', res.status, sub.endpoint, text.slice(0, 200));
    }
}

async function sendToSubscriptions(
    env: Env['Bindings'],
    rows: SubscriptionRow[],
    payload: PushPayload,
): Promise<void> {
    const vapid = getVapidKeys(env);
    if (!vapid || rows.length === 0) return;
    await Promise.allSettled(rows.map((sub) => sendOne(env, vapid, sub, payload)));
}

/**
 * 가입 완료 유저(user_id) 의 모든 구독으로 푸시 발송.
 * 알림 INSERT 와 동시에 호출되며, executionCtx.waitUntil() 로 감싸 응답을 막지 않게 한다.
 */
export async function pushToUser(
    env: Env['Bindings'],
    userId: number,
    payload: PushPayload,
): Promise<void> {
    if (!isPushEnabled(env)) return;
    const { results } = await env.DB
        .prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
        .bind(userId)
        .all<SubscriptionRow>();
    await sendToSubscriptions(env, results, payload);
}

/**
 * 가입 신청자(signup_request) 단계의 옵트인 구독으로 푸시 발송.
 * 승인/거절/차단 처리 시 호출.
 */
export async function pushToSignupRequest(
    env: Env['Bindings'],
    signupRequestId: number,
    payload: PushPayload,
): Promise<void> {
    if (!isPushEnabled(env)) return;
    const { results } = await env.DB
        .prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE signup_request_id = ?')
        .bind(signupRequestId)
        .all<SubscriptionRow>();
    await sendToSubscriptions(env, results, payload);
}

/**
 * 가입 신청 단계 구독을 가입 완료 유저로 승격.
 * approve 시 호출되어 signup_request_id 를 NULL 로 비우고 user_id 를 채운다.
 */
export async function promoteSignupSubscriptions(
    env: Env['Bindings'],
    signupRequestId: number,
    userId: number,
): Promise<void> {
    try {
        await env.DB
            .prepare('UPDATE push_subscriptions SET user_id = ?, signup_request_id = NULL WHERE signup_request_id = ?')
            .bind(userId, signupRequestId)
            .run();
    } catch (e) {
        console.error('[push] promote signup subs failed', signupRequestId, e);
    }
}

/**
 * 가입 거절/차단 처리 후 해당 신청자의 구독 정리.
 * (push 발송이 끝난 뒤 호출해야 한다.)
 */
export async function deleteSignupSubscriptions(
    env: Env['Bindings'],
    signupRequestId: number,
): Promise<void> {
    try {
        await env.DB
            .prepare('DELETE FROM push_subscriptions WHERE signup_request_id = ?')
            .bind(signupRequestId)
            .run();
    } catch (e) {
        console.error('[push] delete signup subs failed', signupRequestId, e);
    }
}
