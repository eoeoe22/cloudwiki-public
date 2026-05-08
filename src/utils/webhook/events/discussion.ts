// 신규 토론 Discord 이벤트 빌더 (community 채널).
// 비공개/잠금 페이지의 토론은 호출부에서 필터링되어야 한다.

import type { Env } from '../../../types';
import type { WebhookEvent } from '../discord';
import { absoluteUrl, escapeMd, nowIso, truncate } from '../format';

const COLOR_DISCUSSION = 0xF1C40F;

export function discussionCreate(args: {
    page: { slug: string; title: string };
    discussion: { id: number; title: string };
    actor: { name: string; picture?: string | null };
    env: Env['Bindings'];
}): WebhookEvent {
    const { page, discussion, actor, env } = args;
    const pageUrl = absoluteUrl(env, `/w/${encodeURIComponent(page.slug)}`);
    const description = pageUrl
        ? `[${escapeMd(page.title)}](${pageUrl}) 에 새 토론이 열렸습니다.\n\n> ${truncate(escapeMd(discussion.title), 200)}`
        : `**${escapeMd(page.title)}** 에 새 토론이 열렸습니다.\n\n> ${truncate(escapeMd(discussion.title), 200)}`;

    return {
        channel: 'community',
        type: 'discussion_create',
        embed: {
            color: COLOR_DISCUSSION,
            title: '💬 새 토론',
            description,
            author: {
                name: actor.name,
                icon_url: actor.picture ? absoluteUrl(env, actor.picture) : undefined,
            },
            timestamp: nowIso(),
        },
    };
}
