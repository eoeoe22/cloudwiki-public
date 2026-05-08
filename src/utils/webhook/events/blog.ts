// 공지사항 발행 Discord 이벤트 빌더 (community 채널).
// settings.announce_post 가 NULL → id 또는 id1 → id2 (실제 발행/교체) 일 때만 호출되어야 한다.
// announce_post 가 NULL 로 해제되거나 동일 게시물 메타만 갱신되는 경우는 호출부에서 필터링.

import type { Env } from '../../../types';
import type { WebhookEvent } from '../discord';
import { absoluteUrl, escapeMd, nowIso, stripWiki, truncate } from '../format';

const COLOR_ANNOUNCE = 0x1ABC9C;

export function announcementPublish(args: {
    postId: number;
    announceTitle: string;
    postContent?: string | null;
    thumbnail?: string | null;
    actorName: string;
    env: Env['Bindings'];
}): WebhookEvent {
    const { postId, announceTitle, postContent, thumbnail, actorName, env } = args;
    const url = absoluteUrl(env, `/blog/${postId}`);
    const previewSource = stripWiki(postContent);
    const description = previewSource ? truncate(escapeMd(previewSource), 350) : undefined;
    const thumbnailUrl = thumbnail ? absoluteUrl(env, thumbnail) : undefined;

    return {
        channel: 'community',
        type: 'announcement_publish',
        embed: {
            color: COLOR_ANNOUNCE,
            title: `📢 ${truncate(escapeMd(announceTitle), 80)}`,
            url,
            description,
            thumbnail: thumbnailUrl ? { url: thumbnailUrl } : undefined,
            author: { name: actorName },
            timestamp: nowIso(),
        },
    };
}
