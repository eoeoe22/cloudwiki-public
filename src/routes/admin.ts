import { Hono } from 'hono';
import {
    buildCategoryOnlyStatements,
    invalidatePageCache,
    mergeCategoriesFromRules,
    refreshRecentChangesCache,
} from './wiki';
import { requireAdmin } from '../middleware/session';
import { isSuperAdmin, getSuperAdmins } from '../utils/auth';
import { RBAC } from '../utils/role';
import { fetchMediaTagMap, sanitizeTags } from '../utils/mediaTags';
import type { Env, User } from '../types';
import { dispatchDiscord } from '../utils/webhook/discord';
import { signupRejected, userJoined } from '../utils/webhook/events/signup';
import { userBan, userRoleChange } from '../utils/webhook/events/user';
import { superAdminAction } from '../utils/webhook/events/superAdmin';
import { pushToUser, pushToSignupRequest, promoteSignupSubscriptions, deleteSignupSubscriptions } from '../utils/push';
import { createNotification } from '../utils/notification';
import {
    loadAllPaletteRows,
    isSafeCssColor,
    PALETTE_NAME_RE,
    RESERVED_PALETTE_NAMES,
    type PaletteVariant,
} from '../utils/palettes';
import {
    loadAnnouncements,
    mutateAnnouncements,
    AnnouncementMutationError,
    type Announcement,
} from '../utils/announcements';
import { announcementPublish } from '../utils/webhook/events/blog';
import type {
    AnnouncementAdminDTO,
    AnnouncementCreateRequest,
    AnnouncementUpdateRequest,
    AnnouncementReorderRequest,
    AnnouncementMoveRequest,
} from '../shared/api/announcement';

const adminRoutes = new Hono<Env>();

adminRoutes.use('*', requireAdmin);

/**
 * 모든 문서의 HTML 캐시를 무효화합니다.
 * 사이드바, 푸터 등의 전역 UI가 변경될 때 사용합니다.
 */
async function invalidateAllPagesCache(c: any) {
    const db = c.env.DB;
    const origin = new URL(c.req.url).origin;
    const cache = caches.default;

    try {
        const { results } = await db.prepare(`
            SELECT slug FROM pages WHERE deleted_at IS NULL
        `).all();

        // 너무 많은 프로미스가 동시에 실행되지 않도록 배치 처리
        for (let i = 0; i < results.length; i += 50) {
            const batch = results.slice(i, i + 50);
            // 브라우저는 URL 경로의 ':'를 인코딩하지 않는 경우도 있으므로 두 변형을 모두 삭제
            const deletions = batch.flatMap((row: any) => {
                const encoded = encodeURIComponent(row.slug);
                const paths = row.slug.includes(':')
                    ? [encoded, encoded.replace(/%3A/g, ':')]
                    : [encoded];
                return paths.map(path => cache.delete(`${origin}/w/${path}`));
            });
            await Promise.allSettled(deletions);
        }
    } catch (e) {
        console.error('Failed to invalidate all pages cache:', e);
    }
}

// ── 관리 로그 기록 헬퍼 ──
export function writeAdminLog(c: any, type: string, log: string, userId: number) {
    const db = c.env.DB;
    c.executionCtx.waitUntil(
        db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
            .bind(type, log, userId)
            .run()
            .catch((e: any) => console.error('Failed to write admin log:', e))
    );
}

/**
 * 이미지 문서(/w/이미지:파일명) SSR/API 캐시 키를 무효화한다.
 * media.ts의 PUT /api/media/doc/:filename과 동일한 키 집합을 사용한다.
 */
async function invalidateImageDocCache(c: any, filename: string) {
    const cache = caches.default;
    const origin = new URL(c.req.url).origin;
    // 브라우저는 URL 경로의 ':'를 인코딩하지 않는 경우도 있으므로 두 변형(%3A / ':')을 모두 삭제
    const encodedSlug = encodeURIComponent(`이미지:${filename}`);
    const decodedSlug = encodedSlug.replace(/%3A/g, ':');
    await Promise.allSettled([
        cache.delete(`${origin}/w/${encodedSlug}`),
        cache.delete(`${origin}/api/w/${encodedSlug}`),
        cache.delete(`${origin}/api/w/${encodedSlug}?redirect=no`),
        cache.delete(`${origin}/w/${decodedSlug}`),
        cache.delete(`${origin}/api/w/${decodedSlug}`),
        cache.delete(`${origin}/api/w/${decodedSlug}?redirect=no`),
    ]);
}

adminRoutes.get('/users', async (c) => {
    const db = c.env.DB;
    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 50));
    const search = c.req.query('search')?.trim() || '';
    const offset = (page - 1) * limit;

    let queryStr = `SELECT id, provider, uid, email, name, picture, role, banned_until, created_at FROM users`;
    let countQueryStr = `SELECT COUNT(*) as count FROM users`;
    const params: any[] = [];
    const conditions: string[] = [];

    if (search) {
        conditions.push(`(name LIKE ? OR email LIKE ?)`);
        params.push(`%${search}%`, `%${search}%`);
    }

    const role = c.req.query('role');
    if (role && role !== 'all') {
        const superAdminsArr = Array.from(getSuperAdmins(c.env));
        if (role === 'super_admin') {
            if (superAdminsArr.length > 0) {
                const placeholders = superAdminsArr.map(() => '?').join(',');
                conditions.push(`email IN (${placeholders})`);
                params.push(...superAdminsArr);
            } else {
                conditions.push(`1 = 0`); // No super admins
            }
        } else {
            conditions.push(`role = ?`);
            params.push(role);
            if (superAdminsArr.length > 0) {
                const placeholders = superAdminsArr.map(() => '?').join(',');
                conditions.push(`email NOT IN (${placeholders})`);
                params.push(...superAdminsArr);
            }
        }
    }

    const ban = c.req.query('ban');
    const nowSecs = Math.floor(Date.now() / 1000);
    if (ban === 'banned') {
        conditions.push(`banned_until > ?`);
        params.push(nowSecs);
    } else if (ban === 'normal') {
        conditions.push(`(banned_until IS NULL OR banned_until <= ?)`);
        params.push(nowSecs);
    }

    if (conditions.length > 0) {
        const whereClause = ` WHERE ` + conditions.join(' AND ');
        queryStr += whereClause;
        countQueryStr += whereClause;
    }

    const sort = c.req.query('sort') || 'desc';
    const sortOrder = sort === 'asc' ? 'ASC' : 'DESC';
    queryStr += ` ORDER BY created_at ${sortOrder} LIMIT ? OFFSET ?`;
    const queryParams = [...params, limit, offset];

    const [usersResult, countResult] = await Promise.all([
        db.prepare(queryStr).bind(...queryParams).all<User>(),
        db.prepare(countQueryStr).bind(...params).first<{ count: number }>()
    ]);

    const users = usersResult.results;
    const total = countResult?.count || 0;
    const totalPages = Math.ceil(total / limit);

    // 이메일에 따른 super_admin 가상 권한 부여
    const now = Math.floor(Date.now() / 1000);
    const superAdmins = getSuperAdmins(c.env);

    const usersProcess = users.map(u => {
        if (superAdmins.has(u.email)) {
            u.role = 'super_admin';
        } else if (u.banned_until && u.banned_until > now) {
            u.role = 'banned';
        } else if (u.role === 'banned') {
            u.role = 'user';
        }
        return u;
    });

    return c.json({
        users: usersProcess,
        total,
        page,
        totalPages
    });
});

adminRoutes.put('/users/:id/role', async (c) => {
    const db = c.env.DB;
    const targetUserId = c.req.param('id');
    const { role } = await c.req.json();
    const currentUser = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;

    if (role !== 'user' && role !== 'discussion_manager' && role !== 'admin') {
        return c.json({ error: '잘못된 권한입니다.' }, 400);
    }

    const targetUser = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(targetUserId).first<User>();

    if (!targetUser) {
        return c.json({ error: '유저를 찾을 수 없습니다.' }, 404);
    }

    if (isSuperAdmin(targetUser.email, c.env)) {
        return c.json({ error: '최고 관리자의 권한은 변경할 수 없습니다.' }, 400);
    }

    // 오직 최고 관리자만 다른 사람을 관리자로 만들거나 내릴 수 있음
    if (!rbac.can(currentUser.role, '*')) {
        return c.json({ error: '관리자 임명/해제는 최고 관리자만 가능합니다.' }, 403);
    }

    const oldRole = targetUser.role;
    await db.prepare(`UPDATE users SET role = ? WHERE id = ?`).bind(role, targetUserId).run();

    // 세션 KV 캐시 무효화 (사용자 정보가 변경되었으므로)
    c.executionCtx.waitUntil(
        db.prepare('SELECT id FROM sessions WHERE user_id = ? AND expires_at > ?')
            .bind(targetUserId, Math.floor(Date.now() / 1000)).all()
            .then(({ results }) => Promise.all(results.map((s: any) => c.env.KV.delete(`session:${s.id}`))))
            .catch(e => console.error('Failed to invalidate session cache:', e))
    );

    // Discord admin 채널에 권한 변경 알림 (자기 자신 변경 / no-op 은 제외)
    if (Number(targetUserId) !== currentUser.id && oldRole !== role) {
        dispatchDiscord(c.env, c.executionCtx, userRoleChange({
            targetName: targetUser.name,
            oldRole,
            newRole: role,
            actorName: currentUser.name,
        }));
    }

    writeAdminLog(c, 'role_change', `유저 #${targetUserId}(${targetUser.name})의 권한을 '${role}'(으)로 변경`, currentUser.id);
    return c.json({ success: true });
});

adminRoutes.put('/users/:id/ban', async (c) => {
    const db = c.env.DB;
    const targetUserId = c.req.param('id');
    const { days } = await c.req.json();
    const currentUser = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;

    if (typeof days !== 'number' || days < 0) {
        return c.json({ error: '올바른 기간을 입력하세요.' }, 400);
    }

    const targetUser = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(targetUserId).first<User>();

    if (!targetUser) {
        return c.json({ error: '유저를 찾을 수 없습니다.' }, 404);
    }

    if (isSuperAdmin(targetUser.email, c.env)) {
        return c.json({ error: '최고 관리자는 차단할 수 없습니다.' }, 400);
    }

    // 관리자는 다른 관리자를 차단할 수 없음 (최고 관리자 제외)
    if (!rbac.can(currentUser.role, '*') && rbac.can(targetUser.role, 'admin:access')) {
        return c.json({ error: '관리자는 다른 관리자를 차단할 수 없습니다.' }, 403);
    }

    const now = Math.floor(Date.now() / 1000);
    // days가 0이면 차단 해제 (null)
    const bannedUntil = days === 0 ? null : now + (days * 24 * 60 * 60);

    await db.prepare(`UPDATE users SET banned_until = ? WHERE id = ?`).bind(bannedUntil, targetUserId).run();

    // 세션 KV 캐시 무효화 (사용자 정보가 변경되었으므로)
    c.executionCtx.waitUntil(
        db.prepare('SELECT id FROM sessions WHERE user_id = ? AND expires_at > ?')
            .bind(targetUserId, Math.floor(Date.now() / 1000)).all()
            .then(({ results }) => Promise.all(results.map((s: any) => c.env.KV.delete(`session:${s.id}`))))
            .catch(e => console.error('Failed to invalidate session cache:', e))
    );

    // 차단 시 알림 생성 (+ 푸시)
    if (days > 0) {
        try {
            const banContent = `관리자에 의해 ${days}일간 차단되었습니다.`;
            await createNotification(c.env, c.executionCtx, {
                userId: Number(targetUserId),
                type: 'banned',
                content: banContent,
                push: {
                    title: '차단 안내',
                    body: banContent,
                    url: '/',
                    tag: `ban:${targetUserId}`,
                },
            });
        } catch (e) {
            console.error('Failed to create ban notification:', e);
        }
    }

    // Discord admin 채널에 차단/해제 알림
    dispatchDiscord(c.env, c.executionCtx, userBan({
        targetName: targetUser.name,
        actorName: currentUser.name,
        action: days === 0 ? 'unban' : 'ban',
        days: days > 0 ? days : undefined,
    }));

    writeAdminLog(c, 'ban', days === 0 ? `유저 #${targetUserId}(${targetUser.name}) 차단 해제` : `유저 #${targetUserId}(${targetUser.name})를 ${days}일간 차단`, currentUser.id);
    return c.json({ success: true, banned_until: bannedUntil });
});


// ── 위키 전역 설정 관리 ──

/**
 * GET /settings
 * 전역 설정 조회
 */
adminRoutes.get('/settings', async (c) => {
    const db = c.env.DB;
    const row = await db.prepare('SELECT * FROM settings WHERE id = 1').first() as any;
    const mcpMode = c.env.MCP_MODE || 'disabled';

    if (!row) {
        return c.json({ namechange_ratelimit: 0, allow_direct_message: 0, signup_policy: 'open', mcp_mode: mcpMode });
    }

    row.mcp_mode = mcpMode;

    return c.json(row);
});

// ── 사이트 전역 공지 관리 ──

const ICON_CLASS_RE = /^(mdi mdi-[a-z0-9-]+|bi bi-[a-z0-9-]+)$/;

/** 공지에 허용되는 URL 인지 검사. http(s) 절대 URL 또는 site-relative `/...` 만 통과. */
function isSafeAnnouncementUrl(url: string): boolean {
    const trimmed = url.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true;
    try {
        const parsed = new URL(trimmed);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

function validateIcon(icon: unknown): string | null | undefined {
    if (icon === undefined) return undefined; // 변경 안 함
    if (icon === null || icon === '') return null;
    if (typeof icon !== 'string') return undefined;
    return ICON_CLASS_RE.test(icon) ? icon : undefined;
}

/** 관리자 응답 — postId 메타 첨부. */
async function buildAdminAnnouncementList(
    db: D1Database,
    list: Announcement[],
): Promise<AnnouncementAdminDTO[]> {
    const postIds = list
        .map(a => a.postId)
        .filter((x): x is number => typeof x === 'number');
    const meta = new Map<number, { title: string | null; deletedAt: number | null }>();
    if (postIds.length > 0) {
        const placeholders = postIds.map(() => '?').join(',');
        const res = await db
            .prepare(`SELECT id, title, deleted_at FROM blog_posts WHERE id IN (${placeholders})`)
            .bind(...postIds)
            .all<{ id: number; title: string; deleted_at: number | null }>();
        for (const r of res.results || []) {
            meta.set(r.id, { title: r.title, deletedAt: r.deleted_at });
        }
    }
    return list.map(a => {
        const m = a.postId !== null ? meta.get(a.postId) : undefined;
        return {
            id: a.id,
            title: a.title,
            announcedTime: a.announcedTime,
            url: a.url ?? (a.postId !== null ? `/blog/${a.postId}` : null),
            icon: a.icon,
            postId: a.postId,
            postTitle: m?.title ?? null,
            postDeleted: m ? !!m.deletedAt : false,
        };
    });
}

/**
 * GET /announcements — 관리자용 공지 목록 (postId 메타 포함)
 */
adminRoutes.get('/announcements', async (c) => {
    const list = await loadAnnouncements(c.env.DB);
    const enriched = await buildAdminAnnouncementList(c.env.DB, list);
    return c.json({ announcements: enriched });
});

/**
 * POST /announcements — 신규 공지 발행 (관리자 콘솔 직접 발행)
 * body: { title, url?, postId?, icon? }
 *   - postId 가 있으면 블로그 포스트 연동. 동일 postId 가 이미 목록에 있으면 409.
 *   - postId 가 있고 url 이 없으면 url 은 /blog/{postId} 로 합성하지 않고 null 저장 (배너 합성 시 처리).
 *   - icon: "mdi mdi-..." 또는 "bi bi-..." 만 허용. 비우면 null (기본 아이콘).
 */
adminRoutes.post('/announcements', async (c) => {
    const db = c.env.DB;
    const body = await c.req.json<AnnouncementCreateRequest>().catch(() => ({} as AnnouncementCreateRequest));
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return c.json({ error: '제목을 입력하세요.' }, 400);
    if (title.length > 200) return c.json({ error: '제목은 200자 이하여야 합니다.' }, 400);

    let url: string | null = null;
    if (typeof body.url === 'string' && body.url.trim()) {
        if (!isSafeAnnouncementUrl(body.url)) {
            return c.json({ error: 'URL 은 http(s):// 또는 / 로 시작해야 합니다.' }, 400);
        }
        url = body.url.trim();
    }

    let postId: number | null = null;
    if (body.postId !== undefined && body.postId !== null) {
        const n = Number(body.postId);
        if (!Number.isInteger(n) || n <= 0) return c.json({ error: 'postId 가 올바르지 않습니다.' }, 400);
        const row = await db
            .prepare('SELECT id, deleted_at FROM blog_posts WHERE id = ?')
            .bind(n)
            .first<{ id: number; deleted_at: number | null }>();
        if (!row || row.deleted_at) return c.json({ error: '존재하지 않는 블로그 포스트입니다.' }, 404);
        postId = n;
    }

    const iconValue = validateIcon(body.icon);
    if (iconValue === undefined && body.icon !== undefined && body.icon !== null && body.icon !== '') {
        return c.json({ error: '아이콘 형식이 올바르지 않습니다.' }, 400);
    }
    const icon: string | null = iconValue ?? null;

    let conflict = false;
    let allocatedId = 0;
    try {
        await mutateAnnouncements(db, (ctx) => {
            if (postId !== null && ctx.list.some(a => a.postId === postId)) {
                conflict = true;
                return null;
            }
            allocatedId = ctx.allocateId();
            const now = Math.floor(Date.now() / 1000);
            const newItem: Announcement = { id: allocatedId, title, announcedTime: now, url, postId, icon };
            return [newItem, ...ctx.list];
        });
    } catch (e) {
        if (e instanceof AnnouncementMutationError) return c.json({ error: e.message }, 503);
        throw e;
    }
    if (conflict) {
        return c.json({ error: '해당 블로그 포스트는 이미 공지로 발행되어 있습니다.' }, 409);
    }

    const id = allocatedId;
    const currentUser = c.get('user')!;
    writeAdminLog(c, 'announce', `공지 발행: #${id} "${title}"${postId !== null ? ` (blog#${postId})` : ''}`, currentUser.id);

    // Discord community 채널 알림은 블로그 포스트 연동 공지에만 발송 (기존 동작 보존).
    if (postId !== null) {
        try {
            const post = await db
                .prepare('SELECT content, thumbnail FROM blog_posts WHERE id = ?')
                .bind(postId)
                .first<{ content: string; thumbnail: string | null }>();
            if (post) {
                dispatchDiscord(c.env, c.executionCtx, announcementPublish({
                    postId,
                    announceTitle: title,
                    postContent: post.content,
                    thumbnail: post.thumbnail,
                    actorName: currentUser.name,
                    env: c.env,
                }));
            }
        } catch (e) {
            console.error('announcement publish webhook failed:', e);
        }
    }

    return c.json({ success: true, id });
});

/**
 * PATCH /announcements/:id — 제목/아이콘만 수정.
 * announcedTime 은 변경하지 않으며 Discord 알림도 발송하지 않는다.
 */
adminRoutes.patch('/announcements/:id', async (c) => {
    const db = c.env.DB;
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'id 가 올바르지 않습니다.' }, 400);

    const body = await c.req.json<AnnouncementUpdateRequest>().catch(() => ({} as AnnouncementUpdateRequest));

    // 변경 입력 검증 (state 무관) 을 mutate 바깥에서 끝낸다.
    let titleUpdate: string | undefined;
    if (typeof body.title === 'string') {
        const t = body.title.trim();
        if (!t) return c.json({ error: '제목을 입력하세요.' }, 400);
        if (t.length > 200) return c.json({ error: '제목은 200자 이하여야 합니다.' }, 400);
        titleUpdate = t;
    }
    let iconUpdate: string | null | undefined; // undefined = 변경 안 함, null = 명시적으로 기본 아이콘
    if (body.icon !== undefined) {
        const v = validateIcon(body.icon);
        if (v === undefined && body.icon !== null && body.icon !== '') {
            return c.json({ error: '아이콘 형식이 올바르지 않습니다.' }, 400);
        }
        iconUpdate = v ?? null;
    }

    let notFound = false;
    let finalTitle = '';
    let didChange = false;
    try {
        await mutateAnnouncements(db, (ctx) => {
            const idx = ctx.list.findIndex(a => a.id === id);
            if (idx < 0) { notFound = true; return null; }
            const target = ctx.list[idx];
            let changed = false;
            if (titleUpdate !== undefined && titleUpdate !== target.title) {
                target.title = titleUpdate;
                changed = true;
            }
            if (iconUpdate !== undefined && iconUpdate !== target.icon) {
                target.icon = iconUpdate;
                changed = true;
            }
            finalTitle = target.title;
            didChange = changed;
            if (!changed) return null; // no-op, skip write
            return ctx.list;
        });
    } catch (e) {
        if (e instanceof AnnouncementMutationError) return c.json({ error: e.message }, 503);
        throw e;
    }
    if (notFound) return c.json({ error: '공지를 찾을 수 없습니다.' }, 404);
    if (didChange) {
        writeAdminLog(c, 'announce', `공지 수정: #${id} "${finalTitle}"`, c.get('user')!.id);
    }
    return c.json({ success: true });
});

/**
 * DELETE /announcements/:id — 단일 철회.
 */
adminRoutes.delete('/announcements/:id', async (c) => {
    const db = c.env.DB;
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'id 가 올바르지 않습니다.' }, 400);

    let notFound = false;
    let removedTitle = '';
    try {
        await mutateAnnouncements(db, (ctx) => {
            const idx = ctx.list.findIndex(a => a.id === id);
            if (idx < 0) { notFound = true; return null; }
            removedTitle = ctx.list[idx].title;
            ctx.list.splice(idx, 1);
            return ctx.list;
        });
    } catch (e) {
        if (e instanceof AnnouncementMutationError) return c.json({ error: e.message }, 503);
        throw e;
    }
    if (notFound) return c.json({ error: '공지를 찾을 수 없습니다.' }, 404);
    writeAdminLog(c, 'announce', `공지 철회: #${id} "${removedTitle}"`, c.get('user')!.id);
    return c.json({ success: true });
});

/**
 * POST /announcements/reorder — 전체 순서 재정렬.
 * body: { order: number[] } — 현재 존재하는 모든 id 가 정확히 한 번씩 포함되어야 함.
 */
adminRoutes.post('/announcements/reorder', async (c) => {
    const db = c.env.DB;
    const body = await c.req.json<AnnouncementReorderRequest>().catch(() => ({} as AnnouncementReorderRequest));
    if (!Array.isArray(body.order)) return c.json({ error: 'order 는 배열이어야 합니다.' }, 400);

    const newOrderIds = body.order.map(n => Number(n));
    if (new Set(newOrderIds).size !== newOrderIds.length) {
        return c.json({ error: '중복된 ID 가 있습니다.' }, 400);
    }

    let mismatch = false;
    try {
        await mutateAnnouncements(db, (ctx) => {
            const currentIds = new Set(ctx.list.map(a => a.id));
            if (newOrderIds.length !== ctx.list.length || !newOrderIds.every(n => currentIds.has(n))) {
                mismatch = true;
                return null;
            }
            const byId = new Map(ctx.list.map(a => [a.id, a]));
            return newOrderIds.map(n => byId.get(n)!);
        });
    } catch (e) {
        if (e instanceof AnnouncementMutationError) return c.json({ error: e.message }, 503);
        throw e;
    }
    if (mismatch) return c.json({ error: '현재 공지 ID 와 일치해야 합니다.' }, 400);
    writeAdminLog(c, 'announce', '공지 순서 변경', c.get('user')!.id);
    return c.json({ success: true });
});

/**
 * POST /announcements/:id/move — 단일 항목을 위 또는 아래로 한 칸 이동.
 */
adminRoutes.post('/announcements/:id/move', async (c) => {
    const db = c.env.DB;
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'id 가 올바르지 않습니다.' }, 400);
    const body = await c.req.json<AnnouncementMoveRequest>().catch(() => ({} as AnnouncementMoveRequest));
    if (body.direction !== 'up' && body.direction !== 'down') {
        return c.json({ error: 'direction 은 up 또는 down 이어야 합니다.' }, 400);
    }

    let notFound = false;
    let moved = false;
    try {
        await mutateAnnouncements(db, (ctx) => {
            const idx = ctx.list.findIndex(a => a.id === id);
            if (idx < 0) { notFound = true; return null; }
            const swapWith = body.direction === 'up' ? idx - 1 : idx + 1;
            if (swapWith < 0 || swapWith >= ctx.list.length) return null; // no-op
            [ctx.list[idx], ctx.list[swapWith]] = [ctx.list[swapWith], ctx.list[idx]];
            moved = true;
            return ctx.list;
        });
    } catch (e) {
        if (e instanceof AnnouncementMutationError) return c.json({ error: e.message }, 503);
        throw e;
    }
    if (notFound) return c.json({ error: '공지를 찾을 수 없습니다.' }, 404);
    if (moved) writeAdminLog(c, 'announce', `공지 이동: #${id} ${body.direction}`, c.get('user')!.id);
    return c.json({ success: true });
});

/**
 * PUT /settings
 * 전역 설정 저장
 */
adminRoutes.put('/settings', async (c) => {
    const db = c.env.DB;
    const currentUser = c.get('user')!;
    const body = await c.req.json<{
        namechange_ratelimit?: number;
        allow_direct_message?: number;
        signup_policy?: string;
    }>();

    // 기존 값 스냅샷 (변경 detail 알림용)
    const oldRow = await db
        .prepare('SELECT namechange_ratelimit, allow_direct_message, signup_policy FROM settings WHERE id = 1')
        .first<{ namechange_ratelimit: number; allow_direct_message: number; signup_policy: string }>();

    const changes: string[] = [];

    if (body.namechange_ratelimit !== undefined) {
        const val = Number(body.namechange_ratelimit);
        if (isNaN(val) || (val < -1)) {
            return c.json({ error: '-1 이상의 정수를 입력하세요.' }, 400);
        }
        await db.prepare('UPDATE settings SET namechange_ratelimit = ? WHERE id = 1')
            .bind(val)
            .run();
        if (oldRow && oldRow.namechange_ratelimit !== val) {
            changes.push(`namechange_ratelimit: ${oldRow.namechange_ratelimit} → ${val}`);
        }
    }

    if (body.allow_direct_message !== undefined) {
        const val = body.allow_direct_message ? 1 : 0;
        await db.prepare('UPDATE settings SET allow_direct_message = ? WHERE id = 1')
            .bind(val)
            .run();
        if (oldRow && oldRow.allow_direct_message !== val) {
            changes.push(`allow_direct_message: ${oldRow.allow_direct_message} → ${val}`);
        }
    }

    if (body.signup_policy !== undefined) {
        const val = body.signup_policy;
        if (val !== 'open' && val !== 'approval') {
            return c.json({ error: '회원가입 정책은 "open" 또는 "approval"만 가능합니다.' }, 400);
        }
        await db.prepare('UPDATE settings SET signup_policy = ? WHERE id = 1')
            .bind(val)
            .run();
        if (oldRow && oldRow.signup_policy !== val) {
            changes.push(`signup_policy: ${oldRow.signup_policy} → ${val}`);
        }
    }

    // super_admin 이 settings 변경한 경우만 감사 알림 (다른 admin 도 settings 호출 가능하나
    // 지금 정책상 settings 수정은 모두 admin 권한이라 super 한정으로 좁혀야 노이즈가 적다).
    const rbac = c.get('rbac') as RBAC;
    if (changes.length > 0 && rbac.can(currentUser.role, '*')) {
        dispatchDiscord(c.env, c.executionCtx, superAdminAction({
            actorName: currentUser.name,
            label: '전역 설정 변경',
            target: changes.join('\n'),
        }));
    }

    writeAdminLog(c, 'settings', `위키 설정 변경: ${JSON.stringify(body)}`, currentUser.id);
    return c.json({ success: true });
});


// ── 가입 신청 관리 (승인제) ──

/**
 * GET /signup-requests
 * 가입 신청 목록 조회
 */
adminRoutes.get('/signup-requests', async (c) => {
    const db = c.env.DB;
    const status = c.req.query('status') || 'pending';
    const limit = Math.min(50, Math.max(1, Number(c.req.query('limit')) || 20));
    const offset = Math.max(0, Number(c.req.query('offset')) || 0);

    const validStatuses = ['pending', 'approved', 'rejected', 'blocked', 'all'];
    if (!validStatuses.includes(status)) {
        return c.json({ error: '잘못된 상태 값입니다.' }, 400);
    }

    let queryStr = `SELECT sr.*, u.name as reviewer_name FROM signup_requests sr LEFT JOIN users u ON sr.reviewed_by = u.id`;
    let countQueryStr = `SELECT COUNT(*) as count FROM signup_requests`;
    const params: any[] = [];

    if (status !== 'all') {
        queryStr += ` WHERE sr.status = ?`;
        countQueryStr += ` WHERE status = ?`;
        params.push(status);
    }

    queryStr += ` ORDER BY sr.created_at DESC LIMIT ? OFFSET ?`;

    const [requestsResult, countResult] = await Promise.all([
        db.prepare(queryStr).bind(...params, limit, offset).all(),
        db.prepare(countQueryStr).bind(...params).first<{ count: number }>()
    ]);

    return c.json({
        requests: requestsResult.results,
        total: countResult?.count || 0,
        hasMore: offset + limit < (countResult?.count || 0)
    });
});

/**
 * PUT /signup-requests/:id/approve
 * 가입 신청 승인
 */
adminRoutes.put('/signup-requests/:id/approve', async (c) => {
    const db = c.env.DB;
    const requestId = Number(c.req.param('id'));
    const currentUser = c.get('user')!;

    const request = await db.prepare('SELECT * FROM signup_requests WHERE id = ?')
        .bind(requestId)
        .first<{ id: number; provider: string; uid: string; email: string; name: string; picture: string | null; status: string }>();

    if (!request) {
        return c.json({ error: '가입 신청을 찾을 수 없습니다.' }, 404);
    }
    if (request.status !== 'pending') {
        return c.json({ error: '이미 처리된 신청입니다.' }, 400);
    }

    // 이메일 중복 체크 (다른 공급자로 이미 가입된 이메일)
    const emailDup = await db
        .prepare('SELECT id FROM users WHERE email = ?')
        .bind(request.email)
        .first<{ id: number }>();
    if (emailDup) {
        return c.json({ error: '이미 동일한 이메일로 가입된 사용자가 있습니다.' }, 409);
    }

    // 중복 이름 확인
    let finalName = request.name;
    const nameExists = await db
        .prepare('SELECT COUNT(*) as cnt FROM users WHERE name = ?')
        .bind(finalName)
        .first<{ cnt: number }>();

    if (nameExists && nameExists.cnt > 0) {
        let suffix = 2;
        while (true) {
            const candidateName = `${request.name} ${suffix}`;
            const dupCheck = await db
                .prepare('SELECT COUNT(*) as cnt FROM users WHERE name = ?')
                .bind(candidateName)
                .first<{ cnt: number }>();
            if (!dupCheck || dupCheck.cnt === 0) {
                finalName = candidateName;
                break;
            }
            suffix++;
        }
    }

    // users 테이블에 유저 생성
    const insertResult = await db.prepare(
        'INSERT INTO users (provider, uid, email, name, picture) VALUES (?, ?, ?, ?, ?)'
    ).bind(request.provider, request.uid, request.email, finalName, request.picture).run();

    // 신청 상태 업데이트
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(
        'UPDATE signup_requests SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?'
    ).bind('approved', currentUser.id, now, requestId).run();

    // 해당 신청 관련 모든 관리자 알림 삭제
    await db.prepare(
        "DELETE FROM notifications WHERE type = 'signup_request' AND ref_id = ?"
    ).bind(requestId).run();

    // Discord community 채널에 가입 완료 환영 알림
    const newUserId = Number(insertResult.meta?.last_row_id ?? 0);
    if (newUserId > 0) {
        dispatchDiscord(c.env, c.executionCtx, userJoined({
            user: { id: newUserId, name: finalName, picture: request.picture },
            env: c.env,
        }));

        // 가입 신청 단계에 옵트인된 구독을 새 user_id 로 승격한 뒤 승인 푸시 발송
        c.executionCtx.waitUntil((async () => {
            await promoteSignupSubscriptions(c.env, requestId, newUserId);
            await pushToUser(c.env, newUserId, {
                title: '가입이 승인되었습니다',
                body: `${finalName}님, ${c.env.WIKI_NAME || '위키'}에 오신 것을 환영합니다.`,
                url: '/',
                tag: `signup:${requestId}`,
            });
        })());
    }

    writeAdminLog(c, 'signup_approve', `가입 신청 승인: ${request.name} (${request.email})`, currentUser.id);
    return c.json({ success: true });
});

/**
 * PUT /signup-requests/:id/reject
 * 가입 신청 거절 (재신청 가능)
 */
adminRoutes.put('/signup-requests/:id/reject', async (c) => {
    const db = c.env.DB;
    const requestId = Number(c.req.param('id'));
    const currentUser = c.get('user')!;

    const request = await db.prepare('SELECT * FROM signup_requests WHERE id = ?')
        .bind(requestId)
        .first<{ id: number; name: string; email: string; status: string }>();

    if (!request) {
        return c.json({ error: '가입 신청을 찾을 수 없습니다.' }, 404);
    }
    if (request.status !== 'pending') {
        return c.json({ error: '이미 처리된 신청입니다.' }, 400);
    }

    const now = Math.floor(Date.now() / 1000);
    await db.prepare(
        'UPDATE signup_requests SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?'
    ).bind('rejected', currentUser.id, now, requestId).run();

    // 해당 신청 관련 모든 관리자 알림 삭제
    await db.prepare(
        "DELETE FROM notifications WHERE type = 'signup_request' AND ref_id = ?"
    ).bind(requestId).run();

    // Discord admin 채널에 거부 감사 알림
    dispatchDiscord(c.env, c.executionCtx, signupRejected({
        name: request.name,
        email: request.email,
        actorName: currentUser.name,
    }));

    // 옵트인된 구독으로 거절 푸시를 보내고 구독 정리
    c.executionCtx.waitUntil((async () => {
        await pushToSignupRequest(c.env, requestId, {
            title: '가입 신청 결과',
            body: '가입 신청이 거절되었습니다. 다시 신청하실 수 있습니다.',
            url: '/login',
            tag: `signup:${requestId}`,
        });
        await deleteSignupSubscriptions(c.env, requestId);
    })());

    writeAdminLog(c, 'signup_reject', `가입 신청 거절: ${request.name} (${request.email})`, currentUser.id);
    return c.json({ success: true });
});

/**
 * PUT /signup-requests/:id/block
 * 가입 신청 차단 (재신청 불가)
 */
adminRoutes.put('/signup-requests/:id/block', async (c) => {
    const db = c.env.DB;
    const requestId = Number(c.req.param('id'));
    const currentUser = c.get('user')!;

    const request = await db.prepare('SELECT * FROM signup_requests WHERE id = ?')
        .bind(requestId)
        .first<{ id: number; name: string; email: string; status: string }>();

    if (!request) {
        return c.json({ error: '가입 신청을 찾을 수 없습니다.' }, 404);
    }
    if (request.status !== 'pending') {
        return c.json({ error: '이미 처리된 신청입니다.' }, 400);
    }

    const now = Math.floor(Date.now() / 1000);
    await db.prepare(
        'UPDATE signup_requests SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?'
    ).bind('blocked', currentUser.id, now, requestId).run();

    // 해당 신청 관련 모든 관리자 알림 삭제
    await db.prepare(
        "DELETE FROM notifications WHERE type = 'signup_request' AND ref_id = ?"
    ).bind(requestId).run();

    // 옵트인된 구독으로 차단 푸시를 보내고 구독 정리
    c.executionCtx.waitUntil((async () => {
        await pushToSignupRequest(c.env, requestId, {
            title: '가입 신청 결과',
            body: '가입이 차단되어 더 이상 신청하실 수 없습니다.',
            url: '/login',
            tag: `signup:${requestId}`,
        });
        await deleteSignupSubscriptions(c.env, requestId);
    })());

    writeAdminLog(c, 'signup_block', `가입 신청 차단: ${request.name} (${request.email})`, currentUser.id);
    return c.json({ success: true });
});

// ── 관리자 전용 카테고리 관리 ──

/**
 * GET /categories
 * 관리자 전용 카테고리 목록 조회
 */
adminRoutes.get('/categories', async (c) => {
    const db = c.env.DB;
    const { results } = await db
        .prepare('SELECT id, name, created_at FROM admin_categories ORDER BY name ASC')
        .all();
    return c.json(results);
});

/**
 * POST /categories
 * 관리자 전용 카테고리 추가
 */
adminRoutes.post('/categories', async (c) => {
    const db = c.env.DB;
    const { name } = await c.req.json<{ name: string }>();

    if (!name || name.trim().length === 0) {
        return c.json({ error: '카테고리 이름을 입력해주세요.' }, 400);
    }

    try {
        await db.prepare('INSERT INTO admin_categories (name) VALUES (?)')
            .bind(name.trim())
            .run();
        writeAdminLog(c, 'category_add', `카테고리 추가: ${name.trim()}`, c.get('user')!.id);
        return c.json({ success: true });
    } catch (e: any) {
        if (e.message?.includes('UNIQUE')) {
            return c.json({ error: '이미 존재하는 카테고리입니다.' }, 409);
        }
        throw e;
    }
});

/**
 * DELETE /categories/:id
 * 관리자 전용 카테고리 삭제
 */
adminRoutes.delete('/categories/:id', async (c) => {
    const db = c.env.DB;
    const id = c.req.param('id');

    // 삭제 전 이름 조회
    const cat = await db.prepare('SELECT name FROM admin_categories WHERE id = ?').bind(id).first<{ name: string }>();

    const result = await db.prepare('DELETE FROM admin_categories WHERE id = ?')
        .bind(id)
        .run();

    if (result.meta.changes === 0) {
        return c.json({ error: '카테고리를 찾을 수 없습니다.' }, 404);
    }

    writeAdminLog(c, 'category_delete', `카테고리 삭제: ${cat?.name || id}`, c.get('user')!.id);
    return c.json({ success: true });
});


// ── 관리자 전용 네임스페이스 (prefix) 관리 ──

/**
 * GET /namespaces
 * 관리자 전용 네임스페이스(prefix) 목록 조회
 */
adminRoutes.get('/namespaces', async (c) => {
    const db = c.env.DB;
    const { results } = await db
        .prepare('SELECT id, prefix, created_at FROM admin_namespaces ORDER BY prefix ASC')
        .all();
    return c.json(results);
});

/**
 * POST /namespaces
 * 관리자 전용 네임스페이스 추가
 */
adminRoutes.post('/namespaces', async (c) => {
    const db = c.env.DB;
    const { prefix } = await c.req.json<{ prefix: string }>();

    if (typeof prefix !== 'string') {
        return c.json({ error: 'prefix 는 문자열이어야 합니다.' }, 400);
    }
    const trimmed = prefix.trim();
    if (trimmed.length === 0) {
        return c.json({ error: '네임스페이스(prefix) 를 입력해주세요.' }, 400);
    }
    if (trimmed.length > 64) {
        return c.json({ error: 'prefix 는 최대 64자까지 입력할 수 있습니다.' }, 400);
    }
    // 제어문자/공백 단독 등은 위에서 trim 후 길이 0 으로 거름.
    if (/[\x00-\x1F\x7F]/.test(trimmed)) {
        return c.json({ error: 'prefix 에 제어문자를 사용할 수 없습니다.' }, 400);
    }

    try {
        await db.prepare('INSERT INTO admin_namespaces (prefix) VALUES (?)')
            .bind(trimmed)
            .run();
        writeAdminLog(c, 'namespace_add', `관리자 네임스페이스 추가: ${trimmed}`, c.get('user')!.id);
        return c.json({ success: true });
    } catch (e: any) {
        if (e.message?.includes('UNIQUE')) {
            return c.json({ error: '이미 존재하는 네임스페이스입니다.' }, 409);
        }
        throw e;
    }
});

/**
 * DELETE /namespaces/:id
 * 관리자 전용 네임스페이스 삭제
 */
adminRoutes.delete('/namespaces/:id', async (c) => {
    const db = c.env.DB;
    const id = c.req.param('id');

    const ns = await db.prepare('SELECT prefix FROM admin_namespaces WHERE id = ?').bind(id).first<{ prefix: string }>();

    const result = await db.prepare('DELETE FROM admin_namespaces WHERE id = ?')
        .bind(id)
        .run();

    if (result.meta.changes === 0) {
        return c.json({ error: '네임스페이스를 찾을 수 없습니다.' }, 404);
    }

    writeAdminLog(c, 'namespace_delete', `관리자 네임스페이스 삭제: ${ns?.prefix || id}`, c.get('user')!.id);
    return c.json({ success: true });
});


// ── 관리자 전용 이미지(미디어) 관리 ──

/**
 * GET /media
 * 이미지 목록 조회 (최신순, 검색, 페이지네이션)
 */
adminRoutes.get('/media', async (c) => {
    const db = c.env.DB;
    const limit = Math.min(50, Math.max(1, Number(c.req.query('limit')) || 10));
    const offset = Math.max(0, Number(c.req.query('offset')) || 0);
    const search = c.req.query('search')?.trim() || '';
    const sort = c.req.query('sort') || 'date_desc';

    // 태그 필터: tags=쉼표구분 또는 tag=단일. 정제 후 AND 매칭(모든 태그 포함).
    const rawTagInput = c.req.query('tags') ?? c.req.query('tag') ?? '';
    const filterTags = sanitizeTags(rawTagInput);

    const sortMap: Record<string, string> = {
        date_desc:  'm.created_at DESC',
        date_asc:   'm.created_at ASC',
        name_asc:   'm.filename COLLATE NOCASE ASC',
        name_desc:  'm.filename COLLATE NOCASE DESC',
        size_desc:  'm.size DESC',
        size_asc:   'm.size ASC',
    };
    const orderBy = sortMap[sort] || sortMap['date_desc'];

    const where: string[] = [];
    const filenameParams: any[] = [];
    if (search) {
        where.push('m.filename LIKE ?');
        filenameParams.push(`%${search}%`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    let listSql: string;
    let countSql: string;
    let listParams: any[];
    let countParams: any[];

    if (filterTags.length > 0) {
        const tagWhere = filterTags.map(() => 'm.id IN (SELECT media_id FROM media_tags WHERE tag = ?)');
        const tagWhereSql = `WHERE ${[...tagWhere, ...where].join(' AND ')}`;

        listSql = `SELECT m.id, m.r2_key, m.filename, m.mime_type, m.size, m.created_at, u.name as uploader_name
                   FROM media m
                   LEFT JOIN users u ON m.uploader_id = u.id
                   ${tagWhereSql}
                   ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
        listParams = [...filterTags, ...filenameParams, limit, offset];

        countSql = `SELECT COUNT(*) as count
                    FROM media m
                    ${tagWhereSql}`;
        countParams = [...filterTags, ...filenameParams];
    } else {
        listSql = `SELECT m.id, m.r2_key, m.filename, m.mime_type, m.size, m.created_at, u.name as uploader_name
                   FROM media m LEFT JOIN users u ON m.uploader_id = u.id
                   ${whereSql}
                   ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
        listParams = [...filenameParams, limit, offset];

        countSql = `SELECT COUNT(*) as count FROM media m ${whereSql}`;
        countParams = [...filenameParams];
    }

    const [mediaResult, countResult] = await Promise.all([
        db.prepare(listSql).bind(...listParams).all(),
        db.prepare(countSql).bind(...countParams).first<{ count: number }>()
    ]);

    const rows = (mediaResult.results || []) as Array<{ id: number; [k: string]: unknown }>;
    const tagMap = await fetchMediaTagMap(db, rows.map(r => r.id));
    const media = rows.map(r => ({ ...r, tags: tagMap.get(r.id) || [] }));

    return c.json({
        media,
        total: countResult?.count || 0
    });
});

// ── 미디어 쓰레기 수집기 (Garbage Collector) ──

/**
 * 이미지 사용 여부를 부분문자열 매칭으로 판정할 때 쓰는 SQL 조건과 바인딩.
 * - r2_key(`images/foo.png`): `![alt](/media/images/...)` 마크다운 임베드 등 직접 URL 참조
 * - `[[이미지:foo.png]]` 형태의 wiki-link 네비게이션 링크도 "사용 중"으로 간주한다.
 *   이 형태는 extractLinks()가 link_type='wikilink'로만 기록하므로 page_links 1차 검사에서
 *   누락되며, 본문에 r2_key 부분문자열도 없으므로 기존 패턴 1개로도 누락된다.
 *   단순 네비게이션 링크라도 GC가 삭제하면 메타페이지(/w/이미지:foo.png)가 깨지므로 보호한다.
 *   `]]` / `|` / `#` 세 종결 형태를 모두 커버한다(공백 변형은 드물어 미포함).
 *
 * NOTE: LIKE 대신 instr() 를 쓰는 이유 — r2_key 등에 SQLite LIKE 와일드카드(`%`, `_`)가
 * 포함되거나 패턴이 길어지면 SQLite 가 "LIKE or GLOB pattern too complex" 오류를 던질 수 있다.
 * instr() 는 단순 substring 검색이라 와일드카드 해석이 없고 동일 의미를 안전하게 표현한다.
 */
function buildImageUsageWhere(): string {
    return `(instr(content, ?) > 0 OR instr(content, ?) > 0 OR instr(content, ?) > 0 OR instr(content, ?) > 0)`;
}
function buildImageUsageBindings(media: { r2_key: string; filename: string }): string[] {
    return [
        media.r2_key,
        `[[이미지:${media.filename}]]`,
        `[[이미지:${media.filename}|`,
        `[[이미지:${media.filename}#`,
    ];
}

/**
 * 미디어가 페이지 / 블로그 / 토론 댓글 / 티켓 댓글 본문 중 어디에서든 참조되면 true.
 * page_links 1차 필터 통과 후 fallback substring 검사를 통합. soft-deleted 행은 제외 —
 * 댓글의 deleted_at 뿐 아니라 부모 토론/티켓의 deleted_at 도 확인해야 한다.
 * (토론·티켓 소프트 삭제는 부모 row 만 갱신하므로 자식 댓글의 deleted_at 은 NULL 인 채
 *  남는다. 부모 검사를 생략하면 삭제된 스레드에만 쓰인 이미지가 영구히 "사용 중" 으로
 *  잠겨 GC 후보에 들어오지 않는다.)
 * 블로그도 함께 검사하는 이유: page_links 색인 외에 본문 substring 안전망을 두면
 * 마이그레이션 backfill 누락 등 롤아웃 변수에도 사용 중 블로그 이미지가 잘못 삭제되지 않는다.
 * 토론·티켓 본문은 마크다운 `![](/media/images/...)` 가 주이므로 첫 번째 binding(r2_key)
 * 만 사실상 매칭되지만, 위키 본문과 동일한 4-패턴 검사를 그대로 적용한다.
 */
async function isImageReferencedAnywhere(
    db: D1Database,
    media: { r2_key: string; filename: string }
): Promise<boolean> {
    const where = buildImageUsageWhere();
    const bindings = buildImageUsageBindings(media);

    // 1) 페이지 본문
    const pageHit = await db.prepare(
        `SELECT 1 FROM pages WHERE deleted_at IS NULL AND ${where} LIMIT 1`
    ).bind(...bindings).first();
    if (pageHit) return true;

    // 2) 블로그 포스트 본문 — page_links 색인이 누락되었더라도 본문에 r2_key 가 있으면 사용 중.
    //    (마이그레이션 backfill 누락 등의 롤아웃 변수에 대한 안전망)
    const blogHit = await db.prepare(
        `SELECT 1 FROM blog_posts WHERE deleted_at IS NULL AND ${where} LIMIT 1`
    ).bind(...bindings).first();
    if (blogHit) return true;

    // 3) 토론 댓글 — 부모 토론도 soft-deleted 아닌 것만
    const discHit = await db.prepare(
        `SELECT 1 FROM discussion_comments dc
         JOIN discussions d ON dc.discussion_id = d.id
         WHERE dc.deleted_at IS NULL AND d.deleted_at IS NULL AND ${where.replace(/content/g, 'dc.content')}
         LIMIT 1`
    ).bind(...bindings).first();
    if (discHit) return true;

    // 4) 티켓 댓글 — 부모 티켓도 soft-deleted 아닌 것만
    const tickHit = await db.prepare(
        `SELECT 1 FROM ticket_comments tc
         JOIN tickets t ON tc.ticket_id = t.id
         WHERE tc.deleted_at IS NULL AND t.deleted_at IS NULL AND ${where.replace(/content/g, 'tc.content')}
         LIMIT 1`
    ).bind(...bindings).first();
    if (tickHit) return true;

    return false;
}

/**
 * GET /media/gc
 * 어떤 문서에서도 참조되지 않는 미사용 이미지 목록 조회
 * page_links(image) + LIKE fallback 두 방식으로 사용 여부 확인
 */
adminRoutes.get('/media/gc', async (c) => {
    const db = c.env.DB;

    // 모든 미디어 조회
    const allMedia = await db.prepare(
        `SELECT m.id, m.r2_key, m.filename, m.mime_type, m.size, m.created_at, u.name as uploader_name
         FROM media m LEFT JOIN users u ON m.uploader_id = u.id
         ORDER BY m.created_at DESC`
    ).all();

    if (!allMedia.results || allMedia.results.length === 0) {
        return c.json({ unused: [], total_media: 0, unused_count: 0 });
    }

    // page_links 에서 image 타입으로 참조되는 r2_key 집합 — 단, 살아있는 소스만 카운트한다.
    // 소프트 삭제된 페이지/블로그/토론/티켓 의 page_links 는 cleanup 되지 않으므로,
    // 단순히 `link_type='image'` 만 보면 삭제된 스레드에 남은 stale 행이 이미지를
    // 영구히 "참조됨" 으로 잠가 GC 후보에 넣지 못한다. source_type 별로 부모 행의
    // deleted_at 을 확인해 살아있는 참조만 prefilter 에 포함한다.
    const linkedResult = await db.prepare(`
        SELECT DISTINCT target_slug FROM (
            SELECT pl.target_slug FROM page_links pl
                JOIN pages p ON pl.source_page_id = p.id
                WHERE pl.link_type = 'image' AND pl.source_type = 'page'
                  AND p.deleted_at IS NULL
            UNION
            -- 'blog' 갈래는 source_type='blog' 필터를 두지 않는다 (legacy 호환).
            -- 마이그레이션 backfill 이전 행은 source_type='page' + blog=1 인 상태로 남아 있으며,
            -- blog=1 은 블로그 INSERT 만 사용하므로 토론·티켓 행이 새어 들어올 일이 없다.
            SELECT pl.target_slug FROM page_links pl
                JOIN blog_posts b ON pl.source_page_id = b.id
                WHERE pl.link_type = 'image' AND pl.blog = 1
                  AND b.deleted_at IS NULL
            UNION
            SELECT pl.target_slug FROM page_links pl
                JOIN discussion_comments dc ON pl.source_page_id = dc.id
                JOIN discussions d ON dc.discussion_id = d.id
                WHERE pl.link_type = 'image' AND pl.source_type = 'discussion_comment'
                  AND dc.deleted_at IS NULL AND d.deleted_at IS NULL
            UNION
            SELECT pl.target_slug FROM page_links pl
                JOIN ticket_comments tc ON pl.source_page_id = tc.id
                JOIN tickets t ON tc.ticket_id = t.id
                WHERE pl.link_type = 'image' AND pl.source_type = 'ticket_comment'
                  AND tc.deleted_at IS NULL AND t.deleted_at IS NULL
        )
    `).all();
    const linkedKeys = new Set((linkedResult.results || []).map((r: any) => r.target_slug));

    // 미사용 후보: page_links에 없는 것들
    const candidates = (allMedia.results as any[]).filter(m => !linkedKeys.has(m.r2_key));

    if (candidates.length === 0) {
        return c.json({ unused: [], total_media: allMedia.results.length, unused_count: 0 });
    }

    // LIKE fallback으로 실제 content에서도 참조 여부 확인 (페이지 + 토론 + 티켓)
    const unused: any[] = [];
    for (const media of candidates) {
        const found = await isImageReferencedAnywhere(db, media);
        if (!found) {
            unused.push(media);
        }
    }

    return c.json({
        unused,
        total_media: allMedia.results.length,
        unused_count: unused.length
    });
});

/**
 * POST /media/gc
 * 선택된 미사용 이미지 일괄 삭제
 * body: { ids: number[] }
 */
adminRoutes.post('/media/gc', async (c) => {
    const db = c.env.DB;
    const user = c.get('user')!;
    const { ids } = await c.req.json<{ ids: number[] }>();

    if (!Array.isArray(ids) || ids.length === 0) {
        return c.json({ error: '삭제할 이미지를 선택해주세요.' }, 400);
    }

    const deleted: number[] = [];
    const deletedFilenames: string[] = [];
    const errors: string[] = [];

    for (const id of ids) {
        const mediaItem = await db.prepare('SELECT r2_key, filename FROM media WHERE id = ?')
            .bind(id)
            .first<{ r2_key: string, filename: string }>();

        if (!mediaItem) {
            errors.push(`ID ${id}: 이미지를 찾을 수 없음`);
            continue;
        }

        // 삭제 전 실제 사용 여부 재확인 (race condition 방지) — 페이지/토론/티켓 모두 검사
        const stillUsed = await isImageReferencedAnywhere(db, mediaItem);

        if (stillUsed) {
            errors.push(`${mediaItem.filename}: 현재 사용 중인 이미지`);
            continue;
        }

        try {
            await c.env.MEDIA.delete(mediaItem.r2_key);
        } catch (e) {
            console.error('R2 삭제 오류:', e);
        }

        await db.prepare('DELETE FROM media WHERE id = ?').bind(id).run();
        // page_links에서 이 이미지를 가리키는 레코드도 정리
        await db.prepare("DELETE FROM page_links WHERE link_type = 'image' AND target_slug = ?")
            .bind(mediaItem.r2_key).run();

        deleted.push(id);
        deletedFilenames.push(mediaItem.filename);
    }

    if (deleted.length > 0) {
        writeAdminLog(c, 'media_gc', `쓰레기 수집: ${deleted.length}개 미사용 이미지 삭제`, user.id);
        // 각 이미지 문서(/w/이미지:파일명) 캐시 무효화
        c.executionCtx.waitUntil(
            Promise.allSettled(deletedFilenames.map(fn => invalidateImageDocCache(c, fn)))
        );
    }

    return c.json({
        success: true,
        deleted_count: deleted.length,
        errors
    });
});

/**
 * GET /media/:id/backlinks
 * 특정 이미지가 사용된 문서/블로그 포스트 목록(역링크) 조회
 * page_links 테이블(link_type='image') 기반 조회 + 본문 부분문자열 fallback
 * 응답 backlinks 항목 형식:
 *   - 위키 문서: { type: 'page', id, slug }
 *   - 블로그 포스트: { type: 'blog', id, title }
 */
adminRoutes.get('/media/:id/backlinks', async (c) => {
    const db = c.env.DB;
    const id = c.req.param('id');

    const mediaItem = await db.prepare('SELECT r2_key, filename FROM media WHERE id = ?')
        .bind(id)
        .first<{ r2_key: string, filename: string }>();

    if (!mediaItem) {
        return c.json({ error: '이미지를 찾을 수 없습니다.' }, 404);
    }

    // 1차: page_links 테이블에서 인덱스 기반 조회 (위키 + 블로그 + 토론 + 티켓)
    const [indexedPages, indexedBlogs, indexedDiscussions, indexedTickets] = await Promise.all([
        db.prepare(`
            SELECT DISTINCT p.id, p.slug
            FROM page_links pl
            JOIN pages p ON pl.source_page_id = p.id
            WHERE pl.link_type = 'image'
              AND pl.blog = 0
              AND pl.source_type = 'page'
              AND pl.target_slug = ?
              AND p.deleted_at IS NULL
        `).bind(mediaItem.r2_key).all(),
        db.prepare(`
            SELECT DISTINCT b.id, b.title
            FROM page_links pl
            JOIN blog_posts b ON pl.source_page_id = b.id
            WHERE pl.link_type = 'image'
              AND pl.blog = 1
              AND pl.target_slug = ?
              AND b.deleted_at IS NULL
        `).bind(mediaItem.r2_key).all(),
        // 토론: source=discussion_comment → 부모 토론으로 묶어 보여준다.
        db.prepare(`
            SELECT DISTINCT d.id, d.title, p.slug AS page_slug
            FROM page_links pl
            JOIN discussion_comments dc ON pl.source_page_id = dc.id
            JOIN discussions d ON dc.discussion_id = d.id
            LEFT JOIN pages p ON d.page_id = p.id
            WHERE pl.link_type = 'image'
              AND pl.source_type = 'discussion_comment'
              AND pl.target_slug = ?
              AND dc.deleted_at IS NULL
              AND d.deleted_at IS NULL
        `).bind(mediaItem.r2_key).all(),
        // 티켓: source=ticket_comment → 부모 티켓으로 묶어 보여준다.
        db.prepare(`
            SELECT DISTINCT t.id, t.title
            FROM page_links pl
            JOIN ticket_comments tc ON pl.source_page_id = tc.id
            JOIN tickets t ON tc.ticket_id = t.id
            WHERE pl.link_type = 'image'
              AND pl.source_type = 'ticket_comment'
              AND pl.target_slug = ?
              AND tc.deleted_at IS NULL
              AND t.deleted_at IS NULL
        `).bind(mediaItem.r2_key).all(),
    ]);

    // 2차: 본문 부분문자열 fallback (아직 page_links에 인덱싱되지 않은 오래된 문서/포스트/토론/티켓 대응)
    // LIKE 대신 instr() 를 쓰는 이유 — r2_key 에 SQLite LIKE 와일드카드(`%`, `_`)가 포함되거나
    // 패턴이 길어지면 SQLite 가 "LIKE or GLOB pattern too complex" 오류를 던질 수 있다.
    const indexedPageIds = new Set((indexedPages.results || []).map((r: any) => r.id));
    const indexedBlogIds = new Set((indexedBlogs.results || []).map((r: any) => r.id));
    const indexedDiscussionIds = new Set((indexedDiscussions.results || []).map((r: any) => r.id));
    const indexedTicketIds = new Set((indexedTickets.results || []).map((r: any) => r.id));
    const [substrPages, substrBlogs, substrDiscussions, substrTickets] = await Promise.all([
        db.prepare(`
            SELECT id, slug
            FROM pages
            WHERE instr(content, ?) > 0 AND deleted_at IS NULL
        `).bind(mediaItem.r2_key).all(),
        db.prepare(`
            SELECT id, title
            FROM blog_posts
            WHERE instr(content, ?) > 0 AND deleted_at IS NULL
        `).bind(mediaItem.r2_key).all(),
        db.prepare(`
            SELECT DISTINCT d.id, d.title, p.slug AS page_slug
            FROM discussion_comments dc
            JOIN discussions d ON dc.discussion_id = d.id
            LEFT JOIN pages p ON d.page_id = p.id
            WHERE instr(dc.content, ?) > 0
              AND dc.deleted_at IS NULL AND d.deleted_at IS NULL
        `).bind(mediaItem.r2_key).all(),
        db.prepare(`
            SELECT DISTINCT t.id, t.title
            FROM ticket_comments tc
            JOIN tickets t ON tc.ticket_id = t.id
            WHERE instr(tc.content, ?) > 0
              AND tc.deleted_at IS NULL AND t.deleted_at IS NULL
        `).bind(mediaItem.r2_key).all(),
    ]);

    const merged = [
        ...(indexedPages.results || []).map((r: any) => ({ type: 'page', ...r })),
        ...((substrPages.results || []) as any[])
            .filter(r => !indexedPageIds.has(r.id))
            .map(r => ({ type: 'page', ...r })),
        ...(indexedBlogs.results || []).map((r: any) => ({ type: 'blog', ...r })),
        ...((substrBlogs.results || []) as any[])
            .filter(r => !indexedBlogIds.has(r.id))
            .map(r => ({ type: 'blog', ...r })),
        ...(indexedDiscussions.results || []).map((r: any) => ({ type: 'discussion', ...r })),
        ...((substrDiscussions.results || []) as any[])
            .filter(r => !indexedDiscussionIds.has(r.id))
            .map(r => ({ type: 'discussion', ...r })),
        ...(indexedTickets.results || []).map((r: any) => ({ type: 'ticket', ...r })),
        ...((substrTickets.results || []) as any[])
            .filter(r => !indexedTicketIds.has(r.id))
            .map(r => ({ type: 'ticket', ...r })),
    ];

    return c.json({
        media: mediaItem,
        backlinks: merged
    });
});

/**
 * DELETE /media/:id
 * 이미지 삭제 (R2 + DB)
 */
adminRoutes.delete('/media/:id', async (c) => {
    const db = c.env.DB;
    const id = c.req.param('id');

    // DB에서 r2_key/filename 조회 (filename은 이미지 문서 캐시 무효화에 필요)
    const mediaItem = await db.prepare('SELECT r2_key, filename FROM media WHERE id = ?')
        .bind(id)
        .first<{ r2_key: string; filename: string }>();

    if (!mediaItem) {
        return c.json({ error: '이미지를 찾을 수 없습니다.' }, 404);
    }

    // R2에서 파일 삭제
    try {
        await c.env.MEDIA.delete(mediaItem.r2_key);
    } catch (e) {
        console.error('R2 삭제 오류:', e);
    }

    // DB에서 레코드 삭제
    await db.prepare('DELETE FROM media WHERE id = ?').bind(id).run();

    // 이미지 문서 캐시 무효화 (/w/이미지:파일명, /api/w/...)
    c.executionCtx.waitUntil(invalidateImageDocCache(c, mediaItem.filename));

    writeAdminLog(c, 'media_delete', `미디어 삭제: ${mediaItem.r2_key}`, c.get('user')!.id);
    return c.json({ success: true });
});

// ── 관리 로그 조회 ──
adminRoutes.get('/logs', async (c) => {
    const db = c.env.DB;
    const limit = 15;
    const offset = Math.max(0, Number(c.req.query('offset')) || 0);
    const search = c.req.query('search')?.trim() || '';
    const type = c.req.query('type') || 'all';

    let queryStr = `SELECT al.id, al.type, al.log, al.user, al.created_at, u.name as user_name
             FROM admin_log al
             LEFT JOIN users u ON al.user = u.id`;
    let countQueryStr = `SELECT COUNT(*) as count FROM admin_log al
                         LEFT JOIN users u ON al.user = u.id`;
    const params: any[] = [];
    const conditions: string[] = [];

    if (search) {
        conditions.push(`(u.name LIKE ? OR al.log LIKE ?)`);
        params.push(`%${search}%`, `%${search}%`);
    }
    if (type !== 'all') {
        conditions.push(`al.type = ?`);
        params.push(type);
    }

    if (conditions.length > 0) {
        const whereClause = ` WHERE ` + conditions.join(' AND ');
        queryStr += whereClause;
        countQueryStr += whereClause;
    }

    queryStr += ` ORDER BY al.created_at DESC LIMIT ? OFFSET ?`;
    const queryParams = [...params, limit, offset];

    const [logsResult, countResult] = await Promise.all([
        db.prepare(queryStr).bind(...queryParams).all(),
        db.prepare(countQueryStr).bind(...params).first<{ count: number }>()
    ]);

    return c.json({
        logs: logsResult.results,
        total: countResult?.count || 0,
        hasMore: offset + limit < (countResult?.count || 0)
    });
});

// ── 삭제된 문서 목록 조회 ──
adminRoutes.get('/pages/deleted', async (c) => {
    const db = c.env.DB;
    const limit = Math.min(50, Math.max(1, Number(c.req.query('limit')) || 10));
    const offset = Math.max(0, Number(c.req.query('offset')) || 0);
    const search = (c.req.query('search') || '').trim();

    const conditions: string[] = ['deleted_at IS NOT NULL'];
    const params: any[] = [];
    if (search) {
        conditions.push('slug LIKE ?');
        params.push(`%${search}%`);
    }
    const whereClause = ' WHERE ' + conditions.join(' AND ');

    const [pagesResult, countResult] = await Promise.all([
        db.prepare(
            `SELECT id, slug, is_locked, deleted_at, updated_at
             FROM pages${whereClause}
             ORDER BY deleted_at DESC
             LIMIT ? OFFSET ?`
        ).bind(...params, limit, offset).all(),
        db.prepare(`SELECT COUNT(*) as count FROM pages${whereClause}`).bind(...params).first<{ count: number }>()
    ]);

    return c.json({
        pages: pagesResult.results,
        total: countResult?.count || 0,
        hasMore: offset + limit < (countResult?.count || 0)
    });
});


// ── 카테고리 prefix 일괄/자동 적용 규칙 ──
// 슬래시 기반 하위 문서(prefix/...) 묶음에 카테고리를 일괄 적용하거나,
// 같은 prefix 로 새 문서가 생성/이동될 때 자동으로 카테고리가 합집합 적용되도록 규칙 저장.
// 관리자 전용 (이 라우터 자체가 requireAdmin 미들웨어로 보호됨).

const PREFIX_FORBIDDEN_CHARS = /[\x00-\x1F\x7F]/;
const CATEGORY_PATTERN = /^[가-힣a-zA-Z0-9\s,]+$/;

function normalizeCategoryString(s: string): string {
    return s
        .split(',')
        .map(c => c.trim())
        .filter(c => c.length > 0)
        .filter((v, i, a) => a.indexOf(v) === i)
        .join(',');
}

function escapeLike(s: string): string {
    return s.replace(/[\\%_]/g, ch => '\\' + ch);
}

/**
 * GET /category-prefix-rules
 * 자동 카테고리 prefix 규칙 목록
 */
adminRoutes.get('/category-prefix-rules', async (c) => {
    const db = c.env.DB;
    const { results } = await db
        .prepare(
            `SELECT r.id, r.prefix, r.categories, r.created_at, u.name AS created_by_name
             FROM category_prefix_rules r
             LEFT JOIN users u ON u.id = r.created_by
             ORDER BY r.prefix ASC`
        )
        .all();
    return c.json(results);
});

/**
 * POST /category-prefix-rules
 * 규칙 upsert (prefix UNIQUE)
 */
adminRoutes.post('/category-prefix-rules', async (c) => {
    const db = c.env.DB;
    const currentUser = c.get('user')!;
    const body = await c.req.json<{ prefix?: string; categories?: string }>();

    const rawPrefix = typeof body.prefix === 'string' ? body.prefix : '';
    const prefix = rawPrefix.trim().replace(/\/+$/, '');
    if (!prefix) {
        return c.json({ error: 'prefix 를 입력해주세요.' }, 400);
    }
    if (prefix.length > 200) {
        return c.json({ error: 'prefix 는 최대 200자까지 입력할 수 있습니다.' }, 400);
    }
    if (PREFIX_FORBIDDEN_CHARS.test(prefix)) {
        return c.json({ error: 'prefix 에 제어문자를 사용할 수 없습니다.' }, 400);
    }

    const rawCategories = typeof body.categories === 'string' ? body.categories : '';
    if (!CATEGORY_PATTERN.test(rawCategories) || rawCategories.trim() === '') {
        return c.json({ error: '카테고리에는 한글/영문/숫자/공백/쉼표만 사용할 수 있습니다.' }, 400);
    }
    const categories = normalizeCategoryString(rawCategories);
    if (!categories) {
        return c.json({ error: '카테고리를 1개 이상 입력해주세요.' }, 400);
    }

    await db
        .prepare(
            `INSERT INTO category_prefix_rules (prefix, categories, created_by)
             VALUES (?, ?, ?)
             ON CONFLICT(prefix) DO UPDATE SET
               categories = excluded.categories,
               created_by = excluded.created_by,
               created_at = unixepoch()`
        )
        .bind(prefix, categories, currentUser.id)
        .run();

    writeAdminLog(
        c,
        'category_prefix_rule_save',
        `자동 카테고리 규칙 저장: ${prefix} → ${categories}`,
        currentUser.id
    );
    return c.json({ success: true, prefix, categories });
});

/**
 * DELETE /category-prefix-rules/:id
 */
adminRoutes.delete('/category-prefix-rules/:id', async (c) => {
    const db = c.env.DB;
    const id = c.req.param('id');
    const currentUser = c.get('user')!;

    const rule = await db
        .prepare('SELECT prefix FROM category_prefix_rules WHERE id = ?')
        .bind(id)
        .first<{ prefix: string }>();
    const result = await db
        .prepare('DELETE FROM category_prefix_rules WHERE id = ?')
        .bind(id)
        .run();

    if (result.meta.changes === 0) {
        return c.json({ error: '규칙을 찾을 수 없습니다.' }, 404);
    }
    writeAdminLog(
        c,
        'category_prefix_rule_delete',
        `자동 카테고리 규칙 삭제: ${rule?.prefix || id}`,
        currentUser.id
    );
    return c.json({ success: true });
});

/**
 * POST /category-prefix-rules/bulk-apply
 * 본문: { prefix, categories, persist? }
 * - prefix/ 로 시작하는 모든 하위 문서에 categories 를 합집합 적용
 * - persist=true 면 동일 prefix 규칙을 category_prefix_rules 에 upsert (자동 적용용)
 */
adminRoutes.post('/category-prefix-rules/bulk-apply', async (c) => {
    const db = c.env.DB;
    const currentUser = c.get('user')!;
    const body = await c.req.json<{ prefix?: string; categories?: string; persist?: boolean }>();

    const rawPrefix = typeof body.prefix === 'string' ? body.prefix : '';
    const prefix = rawPrefix.trim().replace(/\/+$/, '');
    if (!prefix) {
        return c.json({ error: 'prefix 를 입력해주세요.' }, 400);
    }
    if (prefix.length > 200) {
        return c.json({ error: 'prefix 는 최대 200자까지 입력할 수 있습니다.' }, 400);
    }
    if (PREFIX_FORBIDDEN_CHARS.test(prefix)) {
        return c.json({ error: 'prefix 에 제어문자를 사용할 수 없습니다.' }, 400);
    }

    const rawCategories = typeof body.categories === 'string' ? body.categories : '';
    if (!CATEGORY_PATTERN.test(rawCategories) || rawCategories.trim() === '') {
        return c.json({ error: '카테고리에는 한글/영문/숫자/공백/쉼표만 사용할 수 있습니다.' }, 400);
    }
    const categories = normalizeCategoryString(rawCategories);
    if (!categories) {
        return c.json({ error: '카테고리를 1개 이상 입력해주세요.' }, 400);
    }

    // 대상 페이지 조회 — prefix/% (모든 깊이 포함, 부모 문서 자체는 제외)
    // SQLite 의 LIKE 는 ASCII 에 대해 기본 case-insensitive 이므로 'Docs/%' 가
    // 'docs/Page' 까지 매칭한다. 반면 create/move hook 의 mergeCategoriesFromRules
    // 는 case-sensitive 한 startsWith 로 룰을 적용하므로, 여기서도 동일한 정책으로
    // JS 측 case-sensitive 필터를 한 번 더 걸어 일관성과 scanned 카운트 정확도를 보장한다.
    const escaped = escapeLike(prefix);
    const likePattern = escaped + '/%';
    // Cloudflare D1 의 LIKE/GLOB 패턴은 50바이트 제한이 있다 (UTF-8 한글은 3바이트
    // 이므로 17자만 되어도 한도 초과 가능). 미리 차단해 런타임 오류 대신 명확한
    // 검증 메시지를 돌려준다. 자동 적용 hook 은 JS startsWith 를 쓰므로 영향 없으며,
    // 같은 prefix 로 룰을 저장(POST /category-prefix-rules)하는 것은 여전히 가능하다.
    const patternBytes = new TextEncoder().encode(likePattern).length;
    if (patternBytes > 50) {
        return c.json({
            error: `prefix 가 너무 깁니다 (LIKE 패턴 ${patternBytes}바이트, 한도 50바이트). 더 짧은 prefix 로 시도하거나, 자동 규칙으로만 저장해주세요.`,
        }, 400);
    }
    const { results: rawPages } = await db
        .prepare(
            `SELECT id, slug, category FROM pages
             WHERE deleted_at IS NULL
               AND slug LIKE ? ESCAPE '\\'
             ORDER BY slug ASC`
        )
        .bind(likePattern)
        .all<{ id: number; slug: string; category: string | null }>();
    const prefixWithSlash = prefix + '/';
    const pages = rawPages.filter(p => p.slug.startsWith(prefixWithSlash));

    const ruleForMerge = [{ prefix, categories }];
    const updates: { id: number; slug: string; newCategory: string }[] = [];
    for (const page of pages) {
        const merged = mergeCategoriesFromRules(page.slug, page.category, ruleForMerge);
        if (merged !== (page.category ?? '')) {
            updates.push({ id: page.id, slug: page.slug, newCategory: merged });
        }
    }

    // 일괄 업데이트 (D1 배치)
    if (updates.length > 0) {
        const stmts = [];
        for (const u of updates) {
            const value: string | null = u.newCategory || null;
            stmts.push(
                db.prepare('UPDATE pages SET category = ? WHERE id = ?').bind(value, u.id)
            );
            stmts.push(...buildCategoryOnlyStatements(db, u.id, value));
        }
        // D1 배치 사이즈가 매우 크면 분할 — 대략 한 묶음 200문 기준
        const chunkSize = 200;
        for (let i = 0; i < stmts.length; i += chunkSize) {
            await db.batch(stmts.slice(i, i + chunkSize));
        }
    }

    let ruleSaved = false;
    if (body.persist === true) {
        await db
            .prepare(
                `INSERT INTO category_prefix_rules (prefix, categories, created_by)
                 VALUES (?, ?, ?)
                 ON CONFLICT(prefix) DO UPDATE SET
                   categories = excluded.categories,
                   created_by = excluded.created_by,
                   created_at = unixepoch()`
            )
            .bind(prefix, categories, currentUser.id)
            .run();
        ruleSaved = true;
    }

    // 캐시 무효화 (비동기 백그라운드)
    if (updates.length > 0) {
        c.executionCtx.waitUntil(
            Promise.allSettled([
                ...updates.map(u => invalidatePageCache(c, u.slug)),
                refreshRecentChangesCache(c),
            ])
        );
    }

    writeAdminLog(
        c,
        'category_bulk_apply',
        `하위 문서 카테고리 일괄 적용: ${prefix}/** (대상=${pages.length}, 변경=${updates.length}, categories=${categories}${ruleSaved ? ', 규칙저장' : ''})`,
        currentUser.id
    );

    return c.json({
        scanned: pages.length,
        updated: updates.length,
        ruleSaved,
    });
});

// ── 컬러 팔레트 CRUD ────────────────────────────────────────────────
// 본 라우터 전체가 requireAdmin 미들웨어로 보호되므로 추가 권한 체크 불필요.

/**
 * body 의 raw row 형태 ({ light_bg, light_color, dark_bg, dark_color } — 각 값은
 * string | null) 를 정규화. 명시적으로 null 인 채널은 그대로 NULL 로 저장되고,
 * sibling 폴백은 일어나지 않는다. 관리자 콘솔 UI 가 sparse 팔레트의 채널 단위
 * NULL 보존을 위해 사용한다.
 */
function normalizeRawRowBody(body: any): {
    light_bg: string | null;
    light_color: string | null;
    dark_bg: string | null;
    dark_color: string | null;
    error?: string;
} {
    const out: {
        light_bg: string | null;
        light_color: string | null;
        dark_bg: string | null;
        dark_color: string | null;
    } = { light_bg: null, light_color: null, dark_bg: null, dark_color: null };

    for (const k of ['light_bg', 'light_color', 'dark_bg', 'dark_color'] as const) {
        const v = (body as any)[k];
        if (v === null) {
            out[k] = null;
        } else if (typeof v === 'string') {
            if (!isSafeCssColor(v)) {
                return { ...out, error: `허용되지 않은 색상 값입니다: ${v}` };
            }
            out[k] = v;
        } else {
            // 누락된 키도 null 로 처리.
            out[k] = null;
        }
    }

    if (
        out.light_bg === null && out.light_color === null &&
        out.dark_bg === null && out.dark_color === null
    ) {
        return { ...out, error: 'bg 또는 color 값을 최소 1개 입력해주세요.' };
    }
    return out;
}

/** body 의 light/dark 또는 플랫 {bg,color} 를 정규화. 폴백 정책은 utils/palettes 와 동일. */
function normalizePaletteBody(body: any): {
    light: PaletteVariant;
    dark: PaletteVariant;
    error?: string;
} {
    const v = body ?? {};

    let light: PaletteVariant = {};
    let dark: PaletteVariant = {};

    const hasSplit = (v.light && typeof v.light === 'object') || (v.dark && typeof v.dark === 'object');
    if (hasSplit) {
        if (v.light && typeof v.light === 'object') {
            light = {
                bg: typeof v.light.bg === 'string' ? v.light.bg : undefined,
                color: typeof v.light.color === 'string' ? v.light.color : undefined,
            };
        }
        if (v.dark && typeof v.dark === 'object') {
            dark = {
                bg: typeof v.dark.bg === 'string' ? v.dark.bg : undefined,
                color: typeof v.dark.color === 'string' ? v.dark.color : undefined,
            };
        }
    } else {
        const bg = typeof v.bg === 'string' ? v.bg : undefined;
        const color = typeof v.color === 'string' ? v.color : undefined;
        light = { bg, color };
        dark = { bg, color };
    }

    const finalLight: PaletteVariant = {
        bg: light.bg ?? dark.bg,
        color: light.color ?? dark.color,
    };
    const finalDark: PaletteVariant = {
        bg: dark.bg ?? light.bg,
        color: dark.color ?? light.color,
    };

    if (
        finalLight.bg === undefined && finalLight.color === undefined &&
        finalDark.bg === undefined && finalDark.color === undefined
    ) {
        return { light: finalLight, dark: finalDark, error: 'bg 또는 color 값을 최소 1개 입력해주세요.' };
    }

    for (const v of [finalLight.bg, finalLight.color, finalDark.bg, finalDark.color]) {
        if (v !== undefined && !isSafeCssColor(v)) {
            return { light: finalLight, dark: finalDark, error: `허용되지 않은 색상 값입니다: ${v}` };
        }
    }
    return { light: finalLight, dark: finalDark };
}

/**
 * GET /api/admin/palettes
 * 모든 커스텀 팔레트 raw row 반환 (관리자 콘솔 목록 표시용).
 * sibling 폴백을 거치지 않은 NULL 보존 형태로 반환해 클라이언트가 어느 채널이
 * 실제로 NULL 인지 판별할 수 있게 한다. 편집기는 별도 엔드포인트(/api/palettes)
 * 가 sibling 폴백된 PaletteMap 을 반환한다.
 */
adminRoutes.get('/palettes', async (c) => {
    return c.json({ palettes: await loadAllPaletteRows(c.env.DB) });
});

/**
 * 팔레트 변경/삭제 후, 해당 팔레트를 참조하는 페이지/블로그의 캐시를 무효화.
 *   1) 본문에서 직접 {palette:NAME} 참조 (page_links link_type='palette')
 *   2) 그런 팔레트를 사용하는 틀을 트랜스클루전한 페이지 (link_type='template' → 1단계)
 * /api/w/:slug 응답이 used_palettes 를 본문에 포함해 max-age 86400 캐시되므로,
 * 색상 변경 후 사용자가 다시 열어도 stale 색상이 보일 수 있어 능동적으로 비운다.
 * 깊은 트랜스클루전 체인은 잡지 않는다 — 일반 위키 사용에서 1단계 폴백으로 충분.
 */
async function invalidatePaletteUsers(c: any, name: string): Promise<void> {
    const db = c.env.DB as D1Database;
    try {
        // template_users CTE: 팔레트를 본문에서 직접 참조하는 틀(t1) 의 slug,
        //   그리고 t1 로 redirect 되는 다른 틀(tr) 의 slug 까지 포함. loadPalettesForPage 가
        //   redirect_to 1단계를 따라 팔레트를 수집하므로, 색상 변경 시 redirect 시작
        //   슬러그를 트랜스클루전한 페이지의 캐시도 함께 비워야 stale 색상이 남지 않는다.
        const { results } = await db
            .prepare(`
                WITH template_users AS (
                    SELECT pt.slug AS slug
                    FROM page_links plp
                    JOIN pages pt ON pt.id = plp.source_page_id
                    WHERE plp.source_type = 'page'
                      AND plp.link_type = 'palette'
                      AND plp.target_slug = ?1
                    UNION
                    SELECT tr.slug AS slug
                    FROM pages tr
                    JOIN pages t1 ON t1.slug = tr.redirect_to
                    JOIN page_links plp ON plp.source_page_id = t1.id
                    WHERE plp.source_type = 'page'
                      AND plp.link_type = 'palette'
                      AND plp.target_slug = ?1
                )
                SELECT DISTINCT p.slug FROM pages p
                JOIN page_links pl ON pl.source_page_id = p.id
                WHERE pl.source_type = 'page'
                  AND (
                    (pl.link_type = 'palette' AND pl.target_slug = ?1)
                    OR (pl.link_type = 'template' AND pl.target_slug IN (SELECT slug FROM template_users))
                  )
            `)
            .bind(name)
            .all();

        const slugs = ((results ?? []) as Array<{ slug: string }>).map(r => r.slug);
        if (slugs.length > 0) {
            c.executionCtx.waitUntil(
                Promise.allSettled(slugs.map((s: string) => invalidatePageCache(c, s)))
            );
        }
    } catch (e) {
        console.error('invalidatePaletteUsers failed:', e);
    }
}

/**
 * POST /api/admin/palettes
 * body 지원 형태:
 *   (1) raw row: { name, light_bg, light_color, dark_bg, dark_color } — 각 값은 string|null.
 *       null 은 그대로 NULL 로 저장되며 sibling 폴백이 일어나지 않는다 (sparse 보존).
 *   (2) nested: { name, light: {bg,color}, dark: {bg,color} } — 누락 채널은 sibling 으로 폴백.
 *   (3) flat:   { name, bg, color } — 라이트/다크 모두 동일 값으로 저장.
 * 이름 UNIQUE upsert. 하드코딩 프리셋 이름은 예약돼 거부.
 */
adminRoutes.post('/palettes', async (c) => {
    const db = c.env.DB;
    const currentUser = c.get('user')!;
    const body = await c.req.json<any>().catch(() => null);
    if (!body || typeof body !== 'object') {
        return c.json({ error: '요청 본문이 올바르지 않습니다.' }, 400);
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!PALETTE_NAME_RE.test(name)) {
        return c.json({ error: '팔레트 이름은 영문/숫자/언더스코어/하이픈 1~64자만 사용할 수 있습니다.' }, 400);
    }
    if (RESERVED_PALETTE_NAMES.has(name.toLowerCase())) {
        return c.json({ error: `'${name}' 은 하드코딩 프리셋과 겹치므로 사용할 수 없습니다.` }, 400);
    }

    let lightBg: string | null;
    let lightColor: string | null;
    let darkBg: string | null;
    let darkColor: string | null;

    const isRawForm =
        'light_bg' in body || 'light_color' in body ||
        'dark_bg' in body || 'dark_color' in body;

    if (isRawForm) {
        const norm = normalizeRawRowBody(body);
        if (norm.error) {
            return c.json({ error: norm.error }, 400);
        }
        lightBg = norm.light_bg;
        lightColor = norm.light_color;
        darkBg = norm.dark_bg;
        darkColor = norm.dark_color;
    } else {
        const normalized = normalizePaletteBody(body);
        if (normalized.error) {
            return c.json({ error: normalized.error }, 400);
        }
        lightBg = normalized.light.bg ?? null;
        lightColor = normalized.light.color ?? null;
        darkBg = normalized.dark.bg ?? null;
        darkColor = normalized.dark.color ?? null;
    }

    await db
        .prepare(
            `INSERT INTO palettes (name, light_bg, light_color, dark_bg, dark_color, created_by)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET
               light_bg    = excluded.light_bg,
               light_color = excluded.light_color,
               dark_bg     = excluded.dark_bg,
               dark_color  = excluded.dark_color,
               created_by  = excluded.created_by,
               created_at  = unixepoch()`
        )
        .bind(name, lightBg, lightColor, darkBg, darkColor, currentUser.id)
        .run();

    writeAdminLog(c, 'palette_save', `팔레트 저장: ${name}`, currentUser.id);
    await invalidatePaletteUsers(c, name);
    return c.json({ success: true, name });
});

/**
 * DELETE /api/admin/palettes/:name
 * 단일 팔레트 삭제. page_links 의 link_type='palette' 잔존 행은 그대로 둔다 — 본문 재저장
 * 시 자동 정리되며, 보존하더라도 loadPalettesForPage JOIN 결과가 누락될 뿐 다른 부작용 없음.
 */
adminRoutes.delete('/palettes/:name', async (c) => {
    const db = c.env.DB;
    const currentUser = c.get('user')!;
    const name = c.req.param('name');

    if (!PALETTE_NAME_RE.test(name)) {
        return c.json({ error: '잘못된 팔레트 이름입니다.' }, 400);
    }

    // DELETE 전에 사용 페이지 목록을 먼저 수집 — 삭제 후엔 palette name lookup 이 빈 결과.
    // 단, page_links 의 palette/template 행이 그대로 남으므로 사후 invalidate 도 가능하지만,
    // 의미적 명확성 + 미래에 palettes 와 page_links 동시 정리 가능성을 위해 사전 수집.
    await invalidatePaletteUsers(c, name);

    const result = await db
        .prepare('DELETE FROM palettes WHERE name = ?')
        .bind(name)
        .run();

    if (result.meta.changes === 0) {
        return c.json({ error: '팔레트를 찾을 수 없습니다.' }, 404);
    }

    writeAdminLog(c, 'palette_delete', `팔레트 삭제: ${name}`, currentUser.id);
    return c.json({ success: true });
});


export default adminRoutes;
