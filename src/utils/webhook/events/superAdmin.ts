// super_admin 전용 행위 감사 이벤트 빌더 (admin 채널).
// 다른 admin 이벤트(권한 변경, 차단 등) 로 잡히지 않는 super_admin 액션만 발행한다.
// 예: 전역 설정 변경 (signup_policy, namechange_ratelimit, allow_direct_message).

import type { WebhookEvent } from '../discord';
import { escapeMd, nowIso, truncate } from '../format';

const COLOR_SUPER = 0xC0392B;

export function superAdminAction(args: {
    actorName: string;
    label: string; // 예: '전역 설정 변경'
    target?: string | null; // 예: 'signup_policy: open → approval'
}): WebhookEvent {
    const { actorName, label, target } = args;
    const fields = target
        ? [{ name: '대상', value: truncate(escapeMd(target), 500) }]
        : undefined;

    return {
        channel: 'admin',
        type: 'super_admin_action',
        embed: {
            color: COLOR_SUPER,
            title: '🛡 Super Admin 행위',
            description: `**${escapeMd(actorName)}** : ${truncate(escapeMd(label), 200)}`,
            fields,
            timestamp: nowIso(),
        },
    };
}
