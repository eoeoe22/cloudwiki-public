import { Hono } from 'hono';
import { requireAdmin } from '../middleware/session';
import { isSuperAdmin, getSuperAdmins } from '../utils/auth';
import type { Env, User } from '../types';

const adminRoutes = new Hono<Env>();

adminRoutes.use('*', requireAdmin);

// ── 관리 로그 기록 헬퍼 ──
function writeAdminLog(c: any, type: string, log: string, userId: number) {
    const db = c.env.DB;
    c.executionCtx.waitUntil(
        db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
            .bind(type, log, userId)
            .run()
            .catch((e: any) => console.error('Failed to write admin log:', e))
    );
}

adminRoutes.get('/users', async (c) => {
    const db = c.env.DB;
    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 50));
    const search = c.req.query('search')?.trim() || '';
    const offset = (page - 1) * limit;

    let queryStr = `SELECT id, google_id, email, name, picture, role, banned_until, created_at FROM users`;
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

    // 세션 KV 캐시 무효화 (사용자 정보가 변경되었으므로)
    c.executionCtx.waitUntil(
        db.prepare('SELECT id FROM sessions WHERE user_id = ? AND expires_at > ?')
            .bind(targetUserId, Math.floor(Date.now() / 1000)).all()
            .then(({ results }) => Promise.all(results.map((s: any) => c.env.KV.delete(`session:${s.id}`))))
            .catch(e => console.error('Failed to invalidate session cache:', e))
    );

    writeAdminLog(c, 'role_change', `유저 #${targetUserId}(${targetUser.name})의 권한을 '${role}'(으)로 변경`, currentUser.id);
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

    // 세션 KV 캐시 무효화 (사용자 정보가 변경되었으므로)
    c.executionCtx.waitUntil(
        db.prepare('SELECT id FROM sessions WHERE user_id = ? AND expires_at > ?')
            .bind(targetUserId, Math.floor(Date.now() / 1000)).all()
            .then(({ results }) => Promise.all(results.map((s: any) => c.env.KV.delete(`session:${s.id}`))))
            .catch(e => console.error('Failed to invalidate session cache:', e))
    );

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

/**
 * PUT /settings
 * 전역 설정 저장
 */
adminRoutes.put('/settings', async (c) => {
    const db = c.env.DB;
    const body = await c.req.json<{ 
        namechange_ratelimit?: number; 
        allow_direct_message?: number;
        signup_policy?: string;
    }>();

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

    if (body.signup_policy !== undefined) {
        const val = body.signup_policy;
        if (val !== 'open' && val !== 'approval') {
            return c.json({ error: '회원가입 정책은 "open" 또는 "approval"만 가능합니다.' }, 400);
        }
        await db.prepare('UPDATE settings SET signup_policy = ? WHERE id = 1')
            .bind(val)
            .run();
    }

    writeAdminLog(c, 'settings', `위키 설정 변경: ${JSON.stringify(body)}`, c.get('user')!.id);
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
        .first<{ id: number; google_id: string; email: string; name: string; picture: string; status: string }>();

    if (!request) {
        return c.json({ error: '가입 신청을 찾을 수 없습니다.' }, 404);
    }
    if (request.status !== 'pending') {
        return c.json({ error: '이미 처리된 신청입니다.' }, 400);
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
    await db.prepare(
        'INSERT INTO users (google_id, email, name, picture) VALUES (?, ?, ?, ?)'
    ).bind(request.google_id, request.email, finalName, request.picture).run();

    // 신청 상태 업데이트
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(
        'UPDATE signup_requests SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?'
    ).bind('approved', currentUser.id, now, requestId).run();

    // 해당 신청 관련 모든 관리자 알림 삭제
    await db.prepare(
        "DELETE FROM notifications WHERE type = 'signup_request' AND ref_id = ?"
    ).bind(requestId).run();

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

// ── 미디어 쓰레기 수집기 (Garbage Collector) ──

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

    // page_links에서 image 타입으로 참조되는 r2_key 집합
    const linkedResult = await db.prepare(
        `SELECT DISTINCT target_slug FROM page_links WHERE link_type = 'image'`
    ).all();
    const linkedKeys = new Set((linkedResult.results || []).map((r: any) => r.target_slug));

    // 미사용 후보: page_links에 없는 것들
    const candidates = (allMedia.results as any[]).filter(m => !linkedKeys.has(m.r2_key));

    if (candidates.length === 0) {
        return c.json({ unused: [], total_media: allMedia.results.length, unused_count: 0 });
    }

    // LIKE fallback으로 실제 content에서도 참조 여부 확인
    const unused: any[] = [];
    for (const media of candidates) {
        const found = await db.prepare(
            `SELECT 1 FROM pages WHERE content LIKE ? AND deleted_at IS NULL LIMIT 1`
        ).bind(`%${media.r2_key}%`).first();

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
    const errors: string[] = [];

    for (const id of ids) {
        const mediaItem = await db.prepare('SELECT r2_key, filename FROM media WHERE id = ?')
            .bind(id)
            .first<{ r2_key: string, filename: string }>();

        if (!mediaItem) {
            errors.push(`ID ${id}: 이미지를 찾을 수 없음`);
            continue;
        }

        // 삭제 전 실제 사용 여부 재확인 (race condition 방지)
        const stillUsed = await db.prepare(
            `SELECT 1 FROM pages WHERE content LIKE ? AND deleted_at IS NULL LIMIT 1`
        ).bind(`%${mediaItem.r2_key}%`).first();

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
    }

    if (deleted.length > 0) {
        writeAdminLog(c, 'media_gc', `쓰레기 수집: ${deleted.length}개 미사용 이미지 삭제`, user.id);
    }

    return c.json({
        success: true,
        deleted_count: deleted.length,
        errors
    });
});

/**
 * GET /media/:id/backlinks
 * 특정 이미지가 사용된 문서 목록(역링크) 조회
 * page_links 테이블(link_type='image') 기반 조회 + LIKE fallback
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

    // 1차: page_links 테이블에서 인덱스 기반 조회
    const indexedResult = await db.prepare(`
        SELECT DISTINCT p.id, p.slug, p.title
        FROM page_links pl
        JOIN pages p ON pl.source_page_id = p.id
        WHERE pl.link_type = 'image'
          AND pl.target_slug = ?
          AND p.deleted_at IS NULL
    `).bind(mediaItem.r2_key).all();

    // 2차: LIKE fallback (아직 page_links에 인덱싱되지 않은 오래된 문서 대응)
    const indexedIds = new Set((indexedResult.results || []).map((r: any) => r.id));
    const likeResult = await db.prepare(`
        SELECT id, slug, title
        FROM pages
        WHERE content LIKE ? AND deleted_at IS NULL
    `).bind(`%${mediaItem.r2_key}%`).all();

    // 두 결과 병합 (중복 제거)
    const merged = [...(indexedResult.results || [])];
    for (const row of (likeResult.results || []) as any[]) {
        if (!indexedIds.has(row.id)) {
            merged.push(row);
        }
    }

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

    writeAdminLog(c, 'media_delete', `미디어 삭제: ${mediaItem.r2_key}`, c.get('user')!.id);
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
        writeAdminLog(c, 'sidebar_config', `사이드바 설정 변경 (${config.length}개 항목)`, c.get('user')!.id);
        return c.json({ success: true });
    } catch (e) {
        return c.json({ error: '설정을 저장하지 못했습니다.' }, 500);
    }
});

/**
 * GET /footer-config
 * 푸터 설정 조회
 */
adminRoutes.get('/footer-config', async (c) => {
    try {
        const configStr = await c.env.KV.get('footer_config');
        const config = configStr ? JSON.parse(configStr) : [];
        return c.json(config);
    } catch (e) {
        return c.json({ error: '설정을 불러오지 못했습니다.' }, 500);
    }
});

/**
 * POST /footer-config
 * 푸터 설정 저장
 */
adminRoutes.post('/footer-config', async (c) => {
    try {
        const config = await c.req.json();
        if (!Array.isArray(config)) {
            return c.json({ error: '올바른 형식이 아닙니다.' }, 400);
        }
        await c.env.KV.put('footer_config', JSON.stringify(config));
        writeAdminLog(c, 'footer_config', `푸터 설정 변경 (${config.length}개 항목)`, c.get('user')!.id);
        return c.json({ success: true });
    } catch (e) {
        return c.json({ error: '설정을 저장하지 못했습니다.' }, 500);
    }
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

    const [pagesResult, countResult] = await Promise.all([
        db.prepare(
            `SELECT id, slug, title, is_private, is_locked, deleted_at, updated_at
             FROM pages
             WHERE deleted_at IS NOT NULL
             ORDER BY deleted_at DESC
             LIMIT ? OFFSET ?`
        ).bind(limit, offset).all(),
        db.prepare('SELECT COUNT(*) as count FROM pages WHERE deleted_at IS NOT NULL').first<{ count: number }>()
    ]);

    return c.json({
        pages: pagesResult.results,
        total: countResult?.count || 0,
        hasMore: offset + limit < (countResult?.count || 0)
    });
});

export default adminRoutes;
