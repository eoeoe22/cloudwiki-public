// 알림 생성 + 푸시 발송 통합 헬퍼.
//
// 의도한 흐름은 한 곳입니다:
//   1) notifications 테이블에 INSERT (truth source)
//   2) 푸시 구독이 있으면 best-effort 푸시 발송
//
// 라우트마다 INSERT 와 pushToUser 호출을 수동으로 짝짓던 패턴 때문에 한쪽이 누락되는 사고가
// 발생하기 쉬워, 두 동작을 한 함수로 묶고 모든 호출처가 이 함수를 거치도록 한다.

import type { ExecutionContext } from '@cloudflare/workers-types';
import type { Env } from '../types';
import { pushToUser, type PushPayload } from './push';

export type NotificationInput = {
    userId: number;
    type: string;
    content: string;
    link?: string | null;
    refId?: number | null;
    // push 가 명시되면 푸시도 함께 발송한다. null/undefined 이면 in-app 알림만 생성.
    push?: PushPayload | null;
};

function schedulePush(
    env: Env['Bindings'],
    ctx: ExecutionContext,
    userId: number,
    payload: PushPayload,
): void {
    ctx.waitUntil(pushToUser(env, userId, payload));
}

/**
 * 단일 사용자에게 알림 1건을 발행한다. INSERT + (선택) 푸시 발송을 함께 처리.
 * 푸시는 best-effort 로 waitUntil 에 위임되므로 응답을 막지 않는다.
 */
export async function createNotification(
    env: Env['Bindings'],
    ctx: ExecutionContext,
    input: NotificationInput,
): Promise<void> {
    await env.DB
        .prepare(
            'INSERT INTO notifications (user_id, type, content, link, ref_id) VALUES (?, ?, ?, ?, ?)'
        )
        .bind(
            input.userId,
            input.type,
            input.content,
            input.link ?? null,
            input.refId ?? null,
        )
        .run();
    if (input.push) schedulePush(env, ctx, input.userId, input.push);
}

/**
 * 여러 사용자에게 알림을 한 번에 발행한다. INSERT 는 db.batch() 로 묶고, 각 항목의 push 가
 * 지정된 경우 사용자별로 푸시 발송 작업을 waitUntil 에 등록한다.
 */
export async function createNotifications(
    env: Env['Bindings'],
    ctx: ExecutionContext,
    inputs: NotificationInput[],
): Promise<void> {
    if (inputs.length === 0) return;
    const stmts = inputs.map((n) =>
        env.DB
            .prepare(
                'INSERT INTO notifications (user_id, type, content, link, ref_id) VALUES (?, ?, ?, ?, ?)'
            )
            .bind(
                n.userId,
                n.type,
                n.content,
                n.link ?? null,
                n.refId ?? null,
            )
    );
    await env.DB.batch(stmts);
    for (const n of inputs) {
        if (n.push) schedulePush(env, ctx, n.userId, n.push);
    }
}
