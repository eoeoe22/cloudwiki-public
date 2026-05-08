// 사용자 차단 / 권한 변경 Discord 이벤트 빌더 (admin 채널).

import type { WebhookEvent } from '../discord';
import { escapeMd, nowIso, truncate } from '../format';

const COLOR_BAN = 0xE74C3C;
const COLOR_ROLE = 0x9B59B6;

export function userBan(args: {
    targetName: string;
    actorName: string;
    action: 'ban' | 'unban';
    days?: number;
    reason?: string | null;
}): WebhookEvent {
    const { targetName, actorName, action, days, reason } = args;
    const fields: { name: string; value: string; inline?: boolean }[] = [];
    if (action === 'ban' && typeof days === 'number' && days > 0) {
        fields.push({ name: '기간', value: `${days}일`, inline: true });
    }
    if (reason) {
        fields.push({ name: '사유', value: truncate(escapeMd(reason), 200) });
    }

    return {
        channel: 'admin',
        type: 'user_ban',
        embed: {
            color: COLOR_BAN,
            title: action === 'ban' ? '⛔ 사용자 차단' : '✅ 차단 해제',
            description: `**${escapeMd(targetName)}**`,
            author: { name: `by ${actorName}` },
            fields: fields.length > 0 ? fields : undefined,
            timestamp: nowIso(),
        },
    };
}

export function userRoleChange(args: {
    targetName: string;
    oldRole: string;
    newRole: string;
    actorName: string;
}): WebhookEvent {
    const { targetName, oldRole, newRole, actorName } = args;
    return {
        channel: 'admin',
        type: 'user_role_change',
        embed: {
            color: COLOR_ROLE,
            title: '🔧 권한 변경',
            description:
                `**${escapeMd(targetName)}** : \`${escapeMd(oldRole)}\` → \`${escapeMd(newRole)}\``,
            author: { name: `by ${actorName}` },
            timestamp: nowIso(),
        },
    };
}
