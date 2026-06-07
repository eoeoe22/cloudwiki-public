// 문서 본문이 바뀐 모든 저장 경로가 공유하는 주시자 알림 헬퍼.
//
// 직접 PUT(wiki.ts)와 commitPageMutation 파이프라인이 동일한 알림(내용/링크/푸시 태그)을
// 내도록 단일 소스로 추출했다. 과거에는 직접 PUT 핸들러에만 존재해, 승인/되돌리기/이동 등
// 다른 저장 경로로 본문이 바뀌어도 주시자에게 알림이 가지 않는 누락이 있었다.
//
// 라우트 계층(wiki.ts 등)을 import 하지 않고 util 계층(role/notification)만 의존해
// wiki ↔ pagePipeline 순환 import 를 피한다.

import type { Context } from 'hono';
import type { Env } from '../../types';
import { ROLE_CASE_SQL, enrichRoles, type RBAC } from '../role';
import { createNotifications } from '../notification';

/**
 * 문서 편집 시 알림을 보낼 주시자(user id) 목록을 수집한다.
 *
 * fan-out 대상:
 *   1) page_watches: 정확히 이 문서를 주시하는 유저 (scope 무관)
 *   2) page_watches scope='subtree': 이 문서의 상위 문서(slug prefix 매치)를 subtree 로 주시하는 유저
 *   3) category_watches: 이 문서가 속한 카테고리를 주시하는 유저
 *
 * 편집 작성자 본인은 항상 제외된다.
 *
 * 비공개 문서(isPrivate=true)의 경우 'wiki:private' 권한이 없는 구독자는 알림 대상에서
 * 제외한다. 권한 없는 유저가 카테고리/상위 슬러그를 추측해 비공개 문서 슬러그·요약을 알림으로
 * 받는 정보 노출을 방지한다.
 */
export async function collectPageEditWatchers(
    db: D1Database,
    pageId: number,
    slug: string,
    editorId: number,
    categories: string[],
    isPrivate: boolean,
    env: Env['Bindings'],
    rbac: RBAC,
): Promise<number[]> {
    const parents: string[] = [];
    const parts = slug.split('/');
    // 'A/B/C' → ['A', 'A/B'] (자기 자신 'A/B/C' 는 제외 — 직접 주시자 쿼리가 담당)
    for (let i = 1; i < parts.length; i++) {
        parents.push(parts.slice(0, i).join('/'));
    }

    const userIds = new Set<number>();
    try {
        const direct = await db
            .prepare('SELECT user_id FROM page_watches WHERE page_id = ? AND user_id != ?')
            .bind(pageId, editorId)
            .all<{ user_id: number }>();
        for (const r of direct.results) userIds.add(r.user_id);

        if (parents.length > 0) {
            const placeholders = parents.map(() => '?').join(',');
            const subtree = await db
                .prepare(
                    `SELECT DISTINCT pw.user_id
                     FROM page_watches pw
                     JOIN pages p ON pw.page_id = p.id
                     WHERE pw.scope = 'subtree'
                       AND pw.user_id != ?
                       AND p.slug IN (${placeholders})`,
                )
                .bind(editorId, ...parents)
                .all<{ user_id: number }>();
            for (const r of subtree.results) userIds.add(r.user_id);
        }

        if (categories.length > 0) {
            const placeholders = categories.map(() => '?').join(',');
            const cat = await db
                .prepare(
                    `SELECT DISTINCT user_id
                     FROM category_watches
                     WHERE user_id != ? AND category IN (${placeholders})`,
                )
                .bind(editorId, ...categories)
                .all<{ user_id: number }>();
            for (const r of cat.results) userIds.add(r.user_id);
        }
    } catch (e) {
        console.error('collectPageEditWatchers failed:', e);
    }

    if (userIds.size === 0) return [];

    // 비공개 문서: wiki:private 권한이 없는 구독자는 제외한다.
    if (!isPrivate) return Array.from(userIds);

    try {
        const ids = Array.from(userIds);
        const placeholders = ids.map(() => '?').join(',');
        const rows = await db
            .prepare(
                `SELECT u.id, u.email, ${ROLE_CASE_SQL} AS role
                 FROM users u
                 WHERE u.id IN (${placeholders})`,
            )
            .bind(...ids)
            .all<{ id: number; email: string; role: string }>();
        // super_admin 이메일 보정 (DB role 값과 별도로 운영자가 .env 로 격상한 경우)
        enrichRoles(rows.results as any[], 'role', 'email', env);
        return rows.results
            .filter(r => rbac.can(r.role, 'wiki:private'))
            .map(r => r.id);
    } catch (e) {
        console.error('collectPageEditWatchers private filter failed:', e);
        // 안전 기본값: 권한 확인이 실패하면 비공개 문서 알림은 발송하지 않는다.
        return [];
    }
}

/**
 * 주시자에게 page_watch 알림(+푸시)을 best-effort(waitUntil)로 발송한다.
 * 직접 PUT 핸들러와 commitPageMutation 파이프라인이 공유하는 단일 소스.
 */
export function notifyPageWatchers(
    c: Context<Env>,
    args: {
        pageId: number;
        slug: string;
        editorId: number;
        editorName: string;
        categories: string[];
        isPrivate: boolean;
        revisionId: number;
        summary: string | null;
        rbac: RBAC;
    },
): void {
    const { pageId, slug, editorId, editorName, categories, isPrivate, revisionId, summary, rbac } = args;
    c.executionCtx.waitUntil(
        collectPageEditWatchers(c.env.DB, pageId, slug, editorId, categories, isPrivate, c.env, rbac)
            .then(async watchers => {
                if (watchers.length === 0) return;
                const watchLink = `/w/${encodeURIComponent(slug)}?mode=revisions&diff=${revisionId}`;
                const rawSummary = (summary ?? '').trim();
                const truncatedSummary = [...rawSummary].length > 15
                    ? [...rawSummary].slice(0, 15).join('') + '...'
                    : rawSummary;
                const summarySuffix = truncatedSummary ? ` (${truncatedSummary})` : '';
                const notifContent = `${editorName}님이 "${slug}" 문서를 편집했습니다.${summarySuffix}`;
                await createNotifications(c.env, c.executionCtx, watchers.map(uid => ({
                    userId: uid,
                    type: 'page_watch',
                    content: notifContent,
                    link: watchLink,
                    push: {
                        title: `${slug}`,
                        body: notifContent,
                        url: watchLink,
                        tag: `page_watch:${pageId}`,
                    },
                })));
            })
            .catch(e => console.error('Failed to notify watchers:', e))
    );
}
