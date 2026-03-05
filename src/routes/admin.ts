import { Hono } from 'hono';
import { requireAdmin } from '../middleware/session';
import { isSuperAdmin, getSuperAdmins } from '../utils/auth';
import type { Env, User } from '../types';

const adminRoutes = new Hono<Env>();

adminRoutes.use('*', requireAdmin);

adminRoutes.get('/users', async (c) => {
    const db = c.env.DB;
    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 50));
    const search = c.req.query('search')?.trim() || '';
    const offset = (page - 1) * limit;

    let queryStr = `SELECT id, google_id, email, name, picture, role, banned_until, created_at FROM users`;
    let countQueryStr = `SELECT COUNT(*) as count FROM users`;
    const params: any[] = [];

    if (search) {
        const searchCondition = ` WHERE name LIKE ? OR email LIKE ?`;
        queryStr += searchCondition;
        countQueryStr += searchCondition;
        params.push(`%${search}%`, `%${search}%`);
    }

    queryStr += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
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
    if (currentUser.role !== 'super_admin') {
        return c.json({ error: '관리자 임명/해제는 최고 관리자만 가능합니다.' }, 403);
    }

    await db.prepare(`UPDATE users SET role = ? WHERE id = ?`).bind(role, targetUserId).run();
    return c.json({ success: true });
});

adminRoutes.put('/users/:id/ban', async (c) => {
    const db = c.env.DB;
    const targetUserId = c.req.param('id');
    const { days } = await c.req.json();
    const currentUser = c.get('user')!;

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

    if (currentUser.role === 'admin' && targetUser.role === 'admin') {
        return c.json({ error: '관리자는 다른 관리자를 차단할 수 없습니다.' }, 403);
    }

    const now = Math.floor(Date.now() / 1000);
    // days가 0이면 차단 해제 (null)
    const bannedUntil = days === 0 ? null : now + (days * 24 * 60 * 60);

    await db.prepare(`UPDATE users SET banned_until = ? WHERE id = ?`).bind(bannedUntil, targetUserId).run();

    // 차단 시 알림 생성
    if (days > 0) {
        try {
            await db.prepare(
                'INSERT INTO notifications (user_id, type, content) VALUES (?, ?, ?)'
            ).bind(
                Number(targetUserId),
                'banned',
                `관리자에 의해 ${days}일간 차단되었습니다.`
            ).run();
        } catch (e) {
            console.error('Failed to create ban notification:', e);
        }
    }

    return c.json({ success: true, banned_until: bannedUntil });
});


// ── 위키 전역 설정 관리 ──

/**
 * GET /settings
 * 전역 설정 조회
 */
adminRoutes.get('/settings', async (c) => {
    const db = c.env.DB;
    const row = await db.prepare('SELECT * FROM settings WHERE id = 1').first();
    if (!row) {
        return c.json({ namechange_ratelimit: 0, allow_direct_message: 0 });
    }
    return c.json(row);
});

/**
 * PUT /settings
 * 전역 설정 저장
 */
adminRoutes.put('/settings', async (c) => {
    const db = c.env.DB;
    const body = await c.req.json<{ namechange_ratelimit?: number; allow_direct_message?: number }>();

    if (body.namechange_ratelimit !== undefined) {
        const val = Number(body.namechange_ratelimit);
        if (isNaN(val) || (val < -1)) {
            return c.json({ error: '-1 이상의 정수를 입력하세요.' }, 400);
        }
        await db.prepare('UPDATE settings SET namechange_ratelimit = ? WHERE id = 1')
            .bind(val)
            .run();
    }

    if (body.allow_direct_message !== undefined) {
        const val = body.allow_direct_message ? 1 : 0;
        await db.prepare('UPDATE settings SET allow_direct_message = ? WHERE id = 1')
            .bind(val)
            .run();
    }

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

    const result = await db.prepare('DELETE FROM admin_categories WHERE id = ?')
        .bind(id)
        .run();

    if (result.meta.changes === 0) {
        return c.json({ error: '카테고리를 찾을 수 없습니다.' }, 404);
    }

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

    let queryStr = `SELECT m.id, m.r2_key, m.filename, m.mime_type, m.size, m.created_at, u.name as uploader_name
                    FROM media m LEFT JOIN users u ON m.uploader_id = u.id`;
    let countQueryStr = `SELECT COUNT(*) as count FROM media`;
    const params: any[] = [];

    if (search) {
        queryStr += ` WHERE m.filename LIKE ?`;
        countQueryStr += ` WHERE filename LIKE ?`;
        params.push(`%${search}%`);
    }

    queryStr += ` ORDER BY m.created_at DESC LIMIT ? OFFSET ?`;
    const queryParams = [...params, limit, offset];

    const [mediaResult, countResult] = await Promise.all([
        db.prepare(queryStr).bind(...queryParams).all(),
        db.prepare(countQueryStr).bind(...params).first<{ count: number }>()
    ]);

    return c.json({
        media: mediaResult.results,
        total: countResult?.count || 0
    });
});

/**
 * GET /media/:id/backlinks
 * 특정 이미지가 사용된 문서 목록(역링크) 조회
 */
adminRoutes.get('/media/:id/backlinks', async (c) => {
    const db = c.env.DB;
    const id = c.req.param('id');

    // DB에서 r2_key 조회
    const mediaItem = await db.prepare('SELECT r2_key, filename FROM media WHERE id = ?')
        .bind(id)
        .first<{ r2_key: string, filename: string }>();

    if (!mediaItem) {
        return c.json({ error: '이미지를 찾을 수 없습니다.' }, 404);
    }

    // pages 테이블에서 content에 r2_key가 포함된 문서 검색
    // soft delete된 문서는 제외
    const query = `
        SELECT id, slug, title
        FROM pages
        WHERE content LIKE ? AND deleted_at IS NULL
    `;
    const searchPattern = `%${mediaItem.r2_key}%`;
    const pagesResult = await db.prepare(query).bind(searchPattern).all();

    return c.json({
        media: mediaItem,
        backlinks: pagesResult.results
    });
});

/**
 * DELETE /media/:id
 * 이미지 삭제 (R2 + DB)
 */
adminRoutes.delete('/media/:id', async (c) => {
    const db = c.env.DB;
    const id = c.req.param('id');

    // DB에서 r2_key 조회
    const mediaItem = await db.prepare('SELECT r2_key FROM media WHERE id = ?')
        .bind(id)
        .first<{ r2_key: string }>();

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

    return c.json({ success: true });
});

/**
 * GET /sidebar-config
 * 사이드바 설정 조회
 */
adminRoutes.get('/sidebar-config', async (c) => {
    try {
        const configStr = await c.env.KV.get('sidebar_config');
        const config = configStr ? JSON.parse(configStr) : [];
        return c.json(config);
    } catch (e) {
        return c.json({ error: '설정을 불러오지 못했습니다.' }, 500);
    }
});

/**
 * POST /sidebar-config
 * 사이드바 설정 저장
 */
adminRoutes.post('/sidebar-config', async (c) => {
    try {
        const config = await c.req.json();
        if (!Array.isArray(config)) {
            return c.json({ error: '올바른 형식이 아닙니다.' }, 400);
        }
        await c.env.KV.put('sidebar_config', JSON.stringify(config));
        return c.json({ success: true });
    } catch (e) {
        return c.json({ error: '설정을 저장하지 못했습니다.' }, 500);
    }
});

export default adminRoutes;
