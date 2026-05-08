// 가입 신청 / 거부 / 가입 완료(open + approved) Discord 이벤트 빌더.

import type { Env } from '../../../types';
import type { WebhookEvent } from '../discord';
import { absoluteUrl, escapeMd, nowIso, truncate } from '../format';

const COLOR_PENDING = 0xFFA500; // 주황 — admin 액션 필요
const COLOR_REJECTED = 0x9B59B6; // 보라 — 감사
const COLOR_JOINED = 0x2ECC71; // 초록 — 환영

export function signupPending(args: {
    requestId: number;
    name: string;
    email: string;
    provider: string;
    env: Env['Bindings'];
}): WebhookEvent {
    const { requestId, name, email, provider, env } = args;
    const adminUrl = absoluteUrl(env, '/admin#signup-requests');
    const description = adminUrl
        ? `**${escapeMd(name)}** 님이 가입을 신청했습니다.\n[승인하러 가기](${adminUrl})`
        : `**${escapeMd(name)}** 님이 가입을 신청했습니다.`;

    return {
        channel: 'admin',
        type: 'signup_pending',
        embed: {
            color: COLOR_PENDING,
            title: '🆕 가입 신청',
            description,
            fields: [
                { name: '이메일', value: `\`${escapeMd(email)}\``, inline: true },
                { name: '공급자', value: escapeMd(provider), inline: true },
            ],
            footer: { text: `Request #${requestId}` },
            timestamp: nowIso(),
        },
    };
}

export function signupRejected(args: {
    name: string;
    email: string;
    actorName: string;
    reason?: string | null;
}): WebhookEvent {
    const { name, email, actorName, reason } = args;
    const fields = reason
        ? [{ name: '사유', value: truncate(escapeMd(reason), 200) }]
        : undefined;

    return {
        channel: 'admin',
        type: 'signup_rejected',
        embed: {
            color: COLOR_REJECTED,
            title: '🚫 가입 신청 거부',
            description: `**${escapeMd(name)}** (\`${escapeMd(email)}\`) 의 가입 신청이 거부되었습니다.`,
            author: { name: `by ${actorName}` },
            fields,
            timestamp: nowIso(),
        },
    };
}

export function userJoined(args: {
    user: { id: number; name: string; picture?: string | null };
    env: Env['Bindings'];
}): WebhookEvent {
    const { user, env } = args;
    const profileUrl = absoluteUrl(env, `/profile/${encodeURIComponent(String(user.id))}`);
    const thumbnailUrl = user.picture ? absoluteUrl(env, user.picture) : undefined;

    return {
        channel: 'community',
        type: 'user_joined',
        embed: {
            color: COLOR_JOINED,
            title: '👋 새 사용자 가입',
            description: `**${escapeMd(user.name)}** 님이 합류했습니다. 환영해주세요!`,
            url: profileUrl,
            thumbnail: thumbnailUrl ? { url: thumbnailUrl } : undefined,
            timestamp: nowIso(),
        },
    };
}
