// Discord webhook 디스패처. 두 채널(admin / community) 을 라우팅하고,
// EVENTS 화이트리스트로 1차 필터링한 뒤 ctx.waitUntil 로 비동기 전송한다.
//
// 호출부는 채널을 모르고 이벤트만 발행한다 — 채널 라우팅은 이벤트 객체의 channel 필드로 결정된다.

import type { ExecutionContext } from 'hono';
import type { Env } from '../../types';
import { absoluteUrl } from './format';

export type DiscordChannel = 'admin' | 'community';

// Discord embed 의 일부 필드만 사용. 실제 스펙은 더 많지만 우리가 쓰는 것만 명시한다.
export interface DiscordEmbed {
    title?: string;
    description?: string;
    url?: string;
    color?: number;
    timestamp?: string;
    footer?: { text: string; icon_url?: string };
    author?: { name: string; url?: string; icon_url?: string };
    thumbnail?: { url: string };
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
}

export interface WebhookEvent {
    channel: DiscordChannel;
    type: string; // EVENTS 화이트리스트 키 (예: 'signup_pending')
    embed: DiscordEmbed;
}

function pickConfig(env: Env['Bindings'], channel: DiscordChannel): { url?: string; events: string } {
    if (channel === 'admin') {
        return { url: env.DISCORD_ADMIN_WEBHOOK_URL, events: env.DISCORD_ADMIN_EVENTS || '' };
    }
    return { url: env.DISCORD_COMMUNITY_WEBHOOK_URL, events: env.DISCORD_COMMUNITY_EVENTS || '' };
}

function isEventEnabled(eventsList: string, type: string): boolean {
    if (!eventsList) return false;
    const set = new Set(eventsList.split(',').map(s => s.trim()).filter(Boolean));
    return set.has(type);
}

/**
 * Discord webhook 으로 이벤트를 발행한다.
 * - URL 미설정 또는 EVENTS 화이트리스트 미포함 시 조용히 drop.
 * - fetch 는 ctx.waitUntil 로 비동기 처리되어 사용자 응답을 막지 않는다.
 * - 실패는 console.error 로만 기록 (웹훅 실패가 핸들러 에러로 전파되면 안 됨).
 */
export function dispatchDiscord(
    env: Env['Bindings'],
    ctx: ExecutionContext,
    event: WebhookEvent,
): void {
    const { url, events } = pickConfig(env, event.channel);
    if (!url) return;
    if (!isEventEnabled(events, event.type)) return;

    const body = JSON.stringify({
        username: env.WIKI_NAME || 'Wiki',
        avatar_url: absoluteUrl(env, env.WIKI_LOGO_URL),
        embeds: [event.embed],
    });

    ctx.waitUntil(
        fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal: AbortSignal.timeout(5000),
        })
            .then(res => {
                if (!res.ok) {
                    console.error('discord webhook non-2xx', event.channel, event.type, res.status);
                }
            })
            .catch(err => {
                console.error('discord webhook failed', event.channel, event.type, err);
            }),
    );
}
