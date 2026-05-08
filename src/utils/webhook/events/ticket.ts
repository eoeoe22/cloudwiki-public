// 티켓 생성 / 상태 변경 Discord 이벤트 빌더 (admin 채널).

import type { Env } from '../../../types';
import type { WebhookEvent } from '../discord';
import { absoluteUrl, escapeMd, nowIso, truncate } from '../format';

const COLOR_TICKET = 0x3498DB;

export function ticketCreate(args: {
    ticketId: number;
    title: string;
    body?: string | null;
    category?: string | null;
    actor: { name: string; picture?: string | null };
    env: Env['Bindings'];
}): WebhookEvent {
    const { ticketId, title, body, category, actor, env } = args;
    const url = absoluteUrl(env, `/tickets/${ticketId}`);

    return {
        channel: 'admin',
        type: 'ticket_create',
        embed: {
            color: COLOR_TICKET,
            title: `🎫 #${ticketId} ${truncate(escapeMd(title), 80)}`,
            url,
            description: body ? truncate(escapeMd(body), 300) : undefined,
            author: {
                name: actor.name,
                icon_url: actor.picture ? absoluteUrl(env, actor.picture) : undefined,
            },
            fields: [
                { name: '카테고리', value: escapeMd(category || '미지정'), inline: true },
            ],
            timestamp: nowIso(),
        },
    };
}

export function ticketStatus(args: {
    ticketId: number;
    title: string;
    oldStatus: string;
    newStatus: string;
    actorName: string;
    env: Env['Bindings'];
}): WebhookEvent {
    const { ticketId, title, oldStatus, newStatus, actorName, env } = args;
    const url = absoluteUrl(env, `/tickets/${ticketId}`);

    return {
        channel: 'admin',
        type: 'ticket_status',
        embed: {
            color: COLOR_TICKET,
            title: `🎫 #${ticketId} 상태 변경`,
            url,
            description:
                `${truncate(escapeMd(title), 80)}\n\n\`${escapeMd(oldStatus)}\` → \`${escapeMd(newStatus)}\``,
            author: { name: `by ${actorName}` },
            timestamp: nowIso(),
        },
    };
}
