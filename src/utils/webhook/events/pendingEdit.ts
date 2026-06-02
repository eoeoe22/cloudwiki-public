// 사람 편집 보류(pending changes) 생성 Discord 이벤트 빌더 (admin 채널).
// 신뢰되지 않은 사용자의 편집이 검토 대기로 보류될 때 관리자 채널에 알린다.
// 비공개 문서의 보류는 호출부에서 필터링한다(본문/제목 노출 방지).

import type { Env } from '../../../types';
import type { WebhookEvent } from '../discord';
import { absoluteUrl, escapeMd, nowIso, truncate } from '../format';

const COLOR_PENDING = 0xE67E22;

export function pendingEditCreated(args: {
    slug: string;
    action: 'create' | 'update';
    actor: { name: string; picture?: string | null };
    summary?: string | null;
    env: Env['Bindings'];
}): WebhookEvent {
    const { slug, action, actor, summary, env } = args;
    const reviewUrl = absoluteUrl(env, '/mypage#pending-edits');
    const actionLabel = action === 'create' ? '새 문서 생성' : '문서 수정';
    const summaryLine = summary && summary.trim()
        ? `\n\n> ${truncate(escapeMd(summary), 200)}`
        : '';
    const description = reviewUrl
        ? `**${escapeMd(slug)}** (${actionLabel}) 편집이 검토 대기로 보류되었습니다.\n[검토하기](${reviewUrl})${summaryLine}`
        : `**${escapeMd(slug)}** (${actionLabel}) 편집이 검토 대기로 보류되었습니다.${summaryLine}`;

    return {
        channel: 'admin',
        type: 'pending_edit',
        embed: {
            color: COLOR_PENDING,
            title: '📝 검토 대기 편집',
            description,
            author: {
                name: actor.name,
                icon_url: actor.picture ? absoluteUrl(env, actor.picture) : undefined,
            },
            timestamp: nowIso(),
        },
    };
}
