// 공지사항 발행 Discord 이벤트 빌더 (community 채널).
// 새 블로그 포스트 연동 공지가 settings.announcements 에 추가될 때만 호출되어야 한다.
// 단순 메타 수정 (PATCH /api/admin/announcements/:id) 이나 공지 철회는 호출부에서 필터링.

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
            title: `📢 공지사항 : ${truncate(escapeMd(announceTitle), 80)}`,
            url,
            description,
            thumbnail: thumbnailUrl ? { url: thumbnailUrl } : undefined,
            author: { name: actorName },
            timestamp: nowIso(),
        },
    };
}
