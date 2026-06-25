import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth, requirePermission } from '../middleware/session';
import { fetchMediaTagMap, replaceMediaTags, sanitizeTags } from '../utils/mediaTags';
import { RBAC } from '../utils/role';
import { safeJSON } from '../utils/json';
import { invalidatePageCache } from '../utils/cacheInvalidation';

const media = new Hono<Env>();

// 허용 MIME 타입 (이미지 전용 — 동영상 업로드는 더 이상 허용하지 않는다)
const ALLOWED_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
]);

/**
 * SVG XSS 벡터 거부 패턴.
 * 클라이언트는 업로드 전 DOMPurify로 SVG를 정제하지만, media:upload 권한자가
 * 브라우저 UI를 우회해 POST /api/media 를 직접 호출할 수 있으므로 서버에서도
 * 스크립트 실행으로 이어지는 마크업이 포함된 SVG는 저장하지 않고 거부한다.
 * (서빙 시 default-src 'none' CSP 와 함께 이중 방어를 구성한다.)
 */
const SVG_FORBIDDEN_PATTERNS: { re: RegExp; label: string }[] = [
    { re: /<script[\s/>]/i, label: '<script>' },
    { re: /<foreignObject[\s/>]/i, label: '<foreignObject>' },
    { re: /<!DOCTYPE/i, label: '<!DOCTYPE>' },
    { re: /<!ENTITY/i, label: '<!ENTITY>' },
    // 속성 경계(공백/따옴표/슬래시/태그 시작) 다음에 오는 on* 이벤트 핸들러
    { re: /[\s"'/<]on[a-z]+\s*=/i, label: 'on* 이벤트 핸들러' },
    { re: /javascript:/i, label: 'javascript: URL' },
];

/**
 * 문서 제목 슬러그에서 금지되는 문자와 동일한 규칙을 기본으로 사용하고,
 * 파일 경로 안전을 위해 `/`, `\`, `.`를, URL 안전을 위해 `?`를 추가로 차단한다.
 * (`.`은 확장자 처리가 별도로 이루어지기 때문에 사용자 입력 파일명에 포함되면 안 되고,
 *  `?`는 `/media/${r2_key}` URL에서 쿼리 구분자로 해석되어 객체 조회가 실패한다)
 * 공백류(`\s`)도 금지한다 — 업로드된 URL은 `![alt](/media/...)` 형태로 본문에 주입되며,
 * CommonMark 파서는 괄호로 감싸지 않은 링크 목적지에 공백이 있으면 파싱에 실패하여 이미지가 깨진다.
 */
const FILENAME_FORBIDDEN = /[\[\]()#%|<>^\x00-\x1F\x7F\/\\.?\s"']/;

function validateUploadFilename(name: string): { ok: true; value: string } | { ok: false; error: string } {
    const trimmed = name.trim();
    if (!trimmed) {
        return { ok: false, error: '파일명을 입력해주세요.' };
    }
    if (FILENAME_FORBIDDEN.test(trimmed)) {
        return { ok: false, error: '파일명에 사용할 수 없는 문자가 포함되어 있습니다. ([ ] ( ) # % | < > ^ / \\ . ? " \' 공백 등은 사용할 수 없습니다)' };
    }
    if (trimmed.length > 100) {
        return { ok: false, error: '파일명은 최대 100자까지 입력할 수 있습니다.' };
    }
    return { ok: true, value: trimmed };
}

/**
 * POST /api/media
 * 이미지 업로드 (media:upload 권한 필요)
 * multipart/form-data, 필드명: file, filename (사용자 지정 파일명)
 */
media.post('/api/media', requireAuth, requirePermission('media:upload'), async (c) => {
    const user = c.get('user')!;

    let formData: FormData;
    try {
        formData = await c.req.formData();
    } catch {
        return c.json({ error: '유효하지 않은 요청입니다.' }, 400);
    }

    const input = formData.get('file');
    if (!input || typeof input === 'string') {
        return c.json({ error: '파일이 없습니다.' }, 400);
    }
    const file = input as unknown as File;

    // 사용자 지정 파일명 (문서 제목 슬러그와 동일한 금지 문자 규칙 적용)
    const rawFilename = (formData.get('filename') as string | null) || '';
    const validation = validateUploadFilename(rawFilename);
    if (!validation.ok) {
        return c.json({ error: validation.error }, 400);
    }
    const customFilename = validation.value;

    // 태그 (선택). 문자열(JSON 배열 또는 쉼표구분) 또는 배열로 허용.
    const rawTags = formData.get('tags');
    const tags = sanitizeTags(rawTags);

    // 타입 검증
    if (!ALLOWED_TYPES.has(file.type)) {
        return c.json(
            { error: `허용되지 않는 파일 형식입니다. (허용: ${[...ALLOWED_TYPES].join(', ')})` },
            400
        );
    }

    // 크기 검증 (환경변수 사용, 기본값 15MB)
    const MAX_SIZE = parseInt(c.env.MAX_UPLOAD_SIZE || '15728640', 10);
    if (file.size > MAX_SIZE) {
        const maxSizeMb = MAX_SIZE / (1024 * 1024);
        return c.json({ error: `파일 크기는 ${maxSizeMb}MB 이하만 허용됩니다.` }, 400);
    }

    // SVG 보안 검증: 클라이언트 정제(DOMPurify)를 우회한 직접 호출에 대비해
    // 서버에서도 XSS 벡터가 포함된 SVG는 거부한다. (검증을 위해 본문을 먼저 읽어둔다)
    let svgBody: string | null = null;
    if (file.type === 'image/svg+xml') {
        svgBody = await file.text();
        const hit = SVG_FORBIDDEN_PATTERNS.find((p) => p.re.test(svgBody!));
        if (hit) {
            return c.json(
                { error: `보안상 허용되지 않는 SVG입니다. (${hit.label} 포함)` },
                400
            );
        }
    }

    // 확장자 결정
    const ext = getExtension(file.name, file.type);

    // 중복 파일명 처리: images/customFilename.ext → images/customFilename-2.ext ...
    // 괄호는 금지 문자이므로 하이픈-숫자 접미사를 사용한다.
    let finalFilename = customFilename;
    let r2Key = `images/${finalFilename}.${ext}`;

    const existing = await c.env.DB.prepare(
        'SELECT id FROM media WHERE r2_key = ?'
    ).bind(r2Key).first();

    if (existing) {
        let counter = 2;
        while (true) {
            finalFilename = `${customFilename}-${counter}`;
            r2Key = `images/${finalFilename}.${ext}`;
            const dup = await c.env.DB.prepare(
                'SELECT id FROM media WHERE r2_key = ?'
            ).bind(r2Key).first();
            if (!dup) break;
            counter++;
        }
    }

    // R2 업로드 (SVG는 위에서 읽어 검증한 본문을, 그 외는 원본 스트림을 저장)
    await c.env.MEDIA.put(r2Key, svgBody !== null ? svgBody : file.stream(), {
        httpMetadata: { contentType: file.type },
    });

    // DB 기록 (filename에 확장자 포함 최종 파일명 저장)
    const dbFilename = `${finalFilename}.${ext}`;
    const insertResult = await c.env.DB.prepare(
        'INSERT INTO media (r2_key, filename, mime_type, size, uploader_id, content) VALUES (?, ?, ?, ?, ?, ?)'
    )
        .bind(r2Key, dbFilename, file.type, file.size, user.id, '')
        .run();

    const newMediaId = Number(insertResult.meta?.last_row_id ?? 0);
    if (newMediaId && tags.length > 0) {
        await replaceMediaTags(c.env.DB, newMediaId, tags);
    }

    // 공개 URL 반환
    const publicUrl = `${c.env.MEDIA_PUBLIC_URL}/${r2Key}`;

    return c.json({ url: publicUrl, r2_key: r2Key, filename: dbFilename, tags });
});

/**
 * GET /api/media/search
 * 업로드된 이미지 목록을 검색/페이지네이션하여 반환한다.
 * 에디터의 "기존 이미지 검색" 기능에서 호출되며, 업로드와 동일한 media:upload 권한을 요구한다.
 * 동영상은 제외하고 이미지(mime_type=image/*)만 돌려준다.
 */
media.get('/api/media/search', requireAuth, requirePermission('media:upload'), async (c) => {
    const db = c.env.DB;
    const limit = Math.min(60, Math.max(1, Number(c.req.query('limit')) || 24));
    const offset = Math.max(0, Number(c.req.query('offset')) || 0);
    const search = (c.req.query('q') || '').trim();

    // 태그 필터: tags=쉼표구분 또는 tag=단일. 모두 정제 후 AND 매칭.
    const rawTagInput = c.req.query('tags') ?? c.req.query('tag') ?? '';
    const filterTags = sanitizeTags(rawTagInput);

    const where: string[] = [`m.mime_type LIKE 'image/%'`];
    const params: any[] = [];
    if (search) {
        where.push('m.filename LIKE ?');
        params.push(`%${search}%`);
    }

    let listSql: string;
    let countSql: string;
    let listParams: any[];
    let countParams: any[];

    if (filterTags.length > 0) {
        // 태그 AND 매칭: 모든 태그를 만족하는 media만 (COUNT DISTINCT = 요청 태그 수)
        const tagPlaceholders = filterTags.map(() => '?').join(',');
        const tagJoin = `JOIN media_tags mt ON mt.media_id = m.id AND mt.tag IN (${tagPlaceholders})`;
        const groupHaving = `GROUP BY m.id HAVING COUNT(DISTINCT mt.tag) = ?`;
        const whereSql = `WHERE ${where.join(' AND ')}`;

        listSql = `SELECT m.id, m.r2_key, m.filename, m.mime_type, m.size, m.created_at
                   FROM media m ${tagJoin}
                   ${whereSql}
                   ${groupHaving}
                   ORDER BY m.created_at DESC
                   LIMIT ? OFFSET ?`;
        listParams = [...filterTags, ...params, filterTags.length, limit, offset];

        countSql = `SELECT COUNT(*) as count FROM (
                      SELECT m.id FROM media m ${tagJoin}
                      ${whereSql}
                      ${groupHaving}
                    ) sub`;
        countParams = [...filterTags, ...params, filterTags.length];
    } else {
        const whereSql = `WHERE ${where.join(' AND ')}`;
        listSql = `SELECT m.id, m.r2_key, m.filename, m.mime_type, m.size, m.created_at
                   FROM media m ${whereSql}
                   ORDER BY m.created_at DESC
                   LIMIT ? OFFSET ?`;
        listParams = [...params, limit, offset];

        countSql = `SELECT COUNT(*) as count FROM media m ${whereSql}`;
        countParams = [...params];
    }

    const [listResult, countResult] = await Promise.all([
        db.prepare(listSql).bind(...listParams).all(),
        db.prepare(countSql).bind(...countParams).first<{ count: number }>(),
    ]);

    const rows = (listResult.results || []) as Array<{
        id: number; r2_key: string; filename: string; mime_type: string; size: number; created_at: number;
    }>;
    const tagMap = await fetchMediaTagMap(db, rows.map(r => r.id));

    const publicBase = c.env.MEDIA_PUBLIC_URL;
    const items = rows.map(m => ({
        id: m.id,
        r2_key: m.r2_key,
        filename: m.filename,
        mime_type: m.mime_type,
        size: m.size,
        created_at: m.created_at,
        url: `${publicBase}/${m.r2_key}`,
        tags: tagMap.get(m.id) || [],
    }));

    return c.json({ items, total: countResult?.count || 0 });
});

/**
 * GET /api/media/all
 * /all(모든 문서 보기) 페이지의 이미지 탭 전용 — 업로드된 모든 이미지를 1회 반환한다.
 * /api/media/search 는 업로드 권한(media:upload) 게이트라 공개 열람에 부적합하다. 이미지는
 * /media/<r2_key> 로 이미 공개 서빙되므로 목록도 권한 없이 공개하되, closed 가시성만 게이트한다.
 * 초성 그룹핑/정렬은 클라이언트가 수행하므로 페이지네이션 없이 파일명순 전량 반환한다.
 */
media.get('/api/media/all', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const db = c.env.DB;
    const { results } = await db
        .prepare(
            `SELECT m.id, m.r2_key, m.filename, m.mime_type, m.size, m.created_at
             FROM media m WHERE m.mime_type LIKE 'image/%'
             ORDER BY m.filename COLLATE NOCASE ASC`
        )
        .all<{ id: number; r2_key: string; filename: string; mime_type: string; size: number; created_at: number }>();

    const rows = results || [];
    const publicBase = c.env.MEDIA_PUBLIC_URL;
    // 태그는 /all 이미지 그리드(썸네일·파일명·크기)에서 쓰지 않으므로 조회하지 않는다
    // (필요해지면 search 엔드포인트처럼 fetchMediaTagMap 으로 합치면 된다).
    const items = rows.map(m => ({
        id: m.id,
        r2_key: m.r2_key,
        filename: m.filename,
        mime_type: m.mime_type,
        size: m.size,
        created_at: m.created_at,
        url: `${publicBase}/${m.r2_key}`,
    }));

    return c.json({ items, total: items.length });
});

/**
 * GET /api/media/search-tags
 * 태그 자동완성(최대 8개). 업로드/검색 모달에서 호출된다.
 */
media.get('/api/media/search-tags', requireAuth, requirePermission('media:upload'), async (c) => {
    const db = c.env.DB;
    const q = (c.req.query('q') || '').trim();

    let rows: { tag: string }[];
    if (q.length > 0) {
        const { results } = await db
            .prepare('SELECT DISTINCT tag FROM media_tags WHERE tag >= ? AND tag < ? ORDER BY tag ASC LIMIT 8')
            .bind(q, `${q}\uffff`)
            .all<{ tag: string }>();
        rows = results;
    } else {
        const { results } = await db
            .prepare('SELECT DISTINCT tag FROM media_tags ORDER BY tag ASC LIMIT 8')
            .all<{ tag: string }>();
        rows = results;
    }
    return c.json({ results: rows.map(r => r.tag) });
});

/**
 * GET /api/media/doc/:filename
 * 이미지 문서 조회 — `/w/이미지:파일명` 경로에서 클라이언트가 호출한다.
 * 일반 문서가 아닌 media 테이블을 조회하며, content는 평문으로 반환된다(위키 문법 렌더 없음).
 */
media.get('/api/media/doc/:filename', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const filename = c.req.param('filename');
    const row = await c.env.DB.prepare(
        `SELECT m.id, m.r2_key, m.filename, m.mime_type, m.size, m.content, m.created_at,
                u.name as uploader_name
         FROM media m LEFT JOIN users u ON m.uploader_id = u.id
         WHERE m.filename = ? LIMIT 1`
    ).bind(filename).first<{
        id: number; r2_key: string; filename: string; mime_type: string;
        size: number; content: string; created_at: number; uploader_name: string | null;
    }>();

    if (!row) {
        return c.json({ error: '이미지를 찾을 수 없습니다.' }, 404);
    }

    const tagMap = await fetchMediaTagMap(c.env.DB, [row.id]);

    return c.json({
        id: row.id,
        r2_key: row.r2_key,
        filename: row.filename,
        mime_type: row.mime_type,
        size: row.size,
        content: row.content || '',
        created_at: row.created_at,
        uploader_name: row.uploader_name,
        url: `/media/${row.r2_key}`,
        tags: tagMap.get(row.id) || [],
    });
});

/**
 * GET /api/media/doc/:filename/backlinks
 * 이미지 문서를 사용(참조)하는 문서/블로그 포스트/토론·티켓 댓글 목록 조회.
 * page_links 테이블(link_type='image', target_slug=r2_key) 기반.
 * 비공개/삭제 문서는 관리자만 열람.
 * 응답 항목 형식:
 *   - 위키 문서: { type: 'page', slug, updated_at, is_deleted }
 *   - 블로그 포스트: { type: 'blog', id, title, updated_at, is_deleted }
 *   - 토론 댓글:  { type: 'discussion_comment', discussion_id, discussion_title, page_slug, updated_at, is_deleted }
 *   - 티켓 댓글:  { type: 'ticket_comment', ticket_id, ticket_title, ticket_type, updated_at, is_deleted }
 * 토론은 모든 사용자 열람 가능(소속 페이지 삭제 시 비관리자에게 숨김).
 * 티켓은 작성자 본인 / ticket:manage / type='discussion' && discussion:manage 한정.
 */
media.get('/api/media/doc/:filename/backlinks', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const filename = c.req.param('filename');
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC | undefined;
    const isAdmin = !!(user && rbac && rbac.can(user.role, 'admin:access'));
    const canManageTickets = !!(user && rbac && rbac.can(user.role, 'ticket:manage'));
    const canManageDiscussions = !!(user && rbac && rbac.can(user.role, 'discussion:manage'));
    const canSeePrivate = !!(rbac && rbac.can(user?.role ?? 'guest', 'wiki:private'));

    const mediaRow = await db.prepare('SELECT r2_key FROM media WHERE filename = ? LIMIT 1')
        .bind(filename).first<{ r2_key: string }>();
    if (!mediaRow) {
        return c.json({ error: '이미지를 찾을 수 없습니다.' }, 404);
    }

    let pageQuery = `
        SELECT DISTINCT p.slug, p.updated_at,
            CASE WHEN p.deleted_at IS NOT NULL THEN 1 ELSE 0 END AS is_deleted
        FROM page_links pl
        JOIN pages p ON pl.source_page_id = p.id
        WHERE pl.link_type = 'image'
          AND pl.blog = 0
          AND pl.source_type = 'page'
          AND pl.target_slug = ?
    `;
    if (!isAdmin) {
        pageQuery += ' AND p.deleted_at IS NULL';
    }
    pageQuery += ' ORDER BY p.updated_at DESC LIMIT 100';

    let blogQuery = `
        SELECT DISTINCT b.id, b.title, b.updated_at,
            CASE WHEN b.deleted_at IS NOT NULL THEN 1 ELSE 0 END AS is_deleted
        FROM page_links pl
        JOIN blog_posts b ON pl.source_page_id = b.id
        WHERE pl.link_type = 'image'
          AND pl.blog = 1
          AND pl.target_slug = ?
    `;
    // NOTE: source_type='blog' 필터를 두지 않는 이유 — 마이그레이션 backfill
    // (UPDATE page_links SET source_type='blog' WHERE blog=1) 이 아직 안 돌았더라도
    // 기존 legacy 블로그 역링크가 그대로 잡히도록. blog=1 은 어차피 블로그 INSERT 만
    // 사용하므로 (토론·티켓 댓글 INSERT 는 blog=0) 토론·티켓 행이 새어 들어올 일이 없다.
    if (!isAdmin) {
        blogQuery += ' AND b.deleted_at IS NULL';
    }
    blogQuery += ' ORDER BY b.updated_at DESC LIMIT 100';

    // 토론 댓글: source_page_id = discussion_comments.id
    // 같은 토론을 가리키는 댓글이 여러 개여도 토론 단위로 묶어 한 줄로 표시한다.
    // 토론·소속 페이지 soft-delete 시 비관리자에게는 숨긴다.
    // 비공개 문서(p.is_private=1) 의 토론은 wiki:private 권한이 없는 사용자에게 숨겨,
    // 비공개 문서 제목·슬러그가 이미지 가상 문서를 통해 새어 나가지 않도록 한다.
    let discussionQuery = `
        SELECT
            d.id AS discussion_id,
            d.title AS discussion_title,
            p.slug AS page_slug,
            MAX(dc.created_at) AS updated_at,
            -- 관리자는 soft-delete 된 댓글까지 포함해 조회하므로,
            -- 이미지를 참조하는 살아있는 댓글이 하나도 없으면 토론 자체가 삭제되지 않았더라도 삭제 상태로 표기한다.
            CASE WHEN d.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL
                  OR MIN(CASE WHEN dc.deleted_at IS NULL THEN 0 ELSE 1 END) = 1
                 THEN 1 ELSE 0 END AS is_deleted
        FROM page_links pl
        JOIN discussion_comments dc ON pl.source_page_id = dc.id
        JOIN discussions d ON dc.discussion_id = d.id
        JOIN pages p ON d.page_id = p.id
        WHERE pl.link_type = 'image'
          AND pl.source_type = 'discussion_comment'
          AND pl.target_slug = ?
    `;
    if (!isAdmin) {
        discussionQuery += ' AND dc.deleted_at IS NULL AND d.deleted_at IS NULL AND p.deleted_at IS NULL';
    }
    if (!canSeePrivate) {
        discussionQuery += ' AND p.is_private = 0';
    }
    discussionQuery += ' GROUP BY d.id, d.title, p.slug, d.deleted_at, p.deleted_at ORDER BY updated_at DESC LIMIT 100';

    // 티켓 댓글: source_page_id = ticket_comments.id
    // 접근 권한이 없는 사용자에게는 노출하지 않는다(canAccessTicket 와 동일 규칙).
    // 비로그인 사용자에게는 티켓 역링크를 일체 표시하지 않는다.
    // 접근 권한 술어는 LIMIT 적용 전에 SQL 단에서 거른다 — 그렇지 않으면 접근 가능한 티켓이
    // 동일 이미지를 참조하는 접근 불가 티켓 뒤로 밀려 LIMIT 에 의해 누락될 수 있다.
    const ticketRows: Array<{
        ticket_id: number; ticket_title: string; ticket_type: string;
        updated_at: number; is_deleted: number;
    }> = [];
    if (user) {
        let ticketQuery = `
            SELECT
                t.id AS ticket_id,
                t.title AS ticket_title,
                t.type AS ticket_type,
                MAX(tc.created_at) AS updated_at,
                -- 관리자(ticket:manage)는 soft-delete 된 댓글까지 포함하므로,
                -- 이미지를 참조하는 살아있는 댓글이 하나도 없으면 티켓 자체가 삭제되지 않았더라도 삭제 상태로 표기한다.
                CASE WHEN t.deleted_at IS NOT NULL
                      OR MIN(CASE WHEN tc.deleted_at IS NULL THEN 0 ELSE 1 END) = 1
                     THEN 1 ELSE 0 END AS is_deleted
            FROM page_links pl
            JOIN ticket_comments tc ON pl.source_page_id = tc.id
            JOIN tickets t ON tc.ticket_id = t.id
            WHERE pl.link_type = 'image'
              AND pl.source_type = 'ticket_comment'
              AND pl.target_slug = ?
        `;
        const ticketBinds: unknown[] = [mediaRow.r2_key];
        if (!canManageTickets) {
            // soft-delete 된 행은 ticket:manage 한정.
            ticketQuery += ' AND t.deleted_at IS NULL AND tc.deleted_at IS NULL';
            // 본인 작성 OR (discussion:manage 가 있다면 type='discussion' 도 허용).
            if (canManageDiscussions) {
                ticketQuery += " AND (t.user_id = ? OR t.type = 'discussion')";
            } else {
                ticketQuery += ' AND t.user_id = ?';
            }
            ticketBinds.push(user.id);
        }
        ticketQuery += ' GROUP BY t.id, t.title, t.type, t.deleted_at ORDER BY updated_at DESC LIMIT 100';
        const ticketResult = await db.prepare(ticketQuery).bind(...ticketBinds).all();
        for (const r of (ticketResult.results || []) as any[]) {
            ticketRows.push({
                ticket_id: r.ticket_id,
                ticket_title: r.ticket_title,
                ticket_type: r.ticket_type,
                updated_at: r.updated_at,
                is_deleted: r.is_deleted,
            });
        }
    }

    const [pageResult, blogResult, discussionResult] = await Promise.all([
        db.prepare(pageQuery).bind(mediaRow.r2_key).all(),
        db.prepare(blogQuery).bind(mediaRow.r2_key).all(),
        db.prepare(discussionQuery).bind(mediaRow.r2_key).all(),
    ]);

    const backlinks = [
        ...(pageResult.results || []).map((r: any) => ({ type: 'page', ...r })),
        ...(blogResult.results || []).map((r: any) => ({ type: 'blog', ...r })),
        ...(discussionResult.results || []).map((r: any) => ({ type: 'discussion_comment', ...r })),
        ...ticketRows.map((r) => ({
            type: 'ticket_comment',
            ticket_id: r.ticket_id,
            ticket_title: r.ticket_title,
            ticket_type: r.ticket_type,
            updated_at: r.updated_at,
            is_deleted: r.is_deleted,
        })),
    ];
    return c.json(safeJSON({ backlinks }));
});

/**
 * PUT /api/media/doc/:filename
 * 이미지 문서 content 수정 — 문서 편집 권한(wiki:edit) 보유자가 사용.
 * body: { content: string }
 * 리비전은 남기지 않고 즉시 덮어쓴다.
 */
media.put('/api/media/doc/:filename', requireAuth, requirePermission('wiki:edit'), async (c) => {
    const filename = c.req.param('filename');
    let body: { content?: string; tags?: unknown };
    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: '유효하지 않은 요청입니다.' }, 400);
    }
    // CRLF/CR → LF 정규화. 클라이언트에서 \r 가 섞여 들어와도 렌더 파이프라인이
    // 일관되게 동작하도록 저장 시점에 정규화한다.
    const content = typeof body.content === 'string' ? body.content.replace(/\r\n?/g, '\n') : '';

    // 길이 제한 (과도한 저장 방지)
    if (content.length > 20000) {
        return c.json({ error: '본문은 최대 20000자까지 입력할 수 있습니다.' }, 400);
    }

    const row = await c.env.DB.prepare('SELECT id FROM media WHERE filename = ? LIMIT 1')
        .bind(filename).first<{ id: number }>();
    if (!row) {
        return c.json({ error: '이미지를 찾을 수 없습니다.' }, 404);
    }

    await c.env.DB.prepare('UPDATE media SET content = ? WHERE id = ?')
        .bind(content, row.id).run();

    // 태그 필드가 요청에 포함된 경우에만 교체. (undefined면 기존 태그 유지)
    if (body.tags !== undefined) {
        const tags = sanitizeTags(body.tags);
        await replaceMediaTags(c.env.DB, row.id, tags);
    }

    // /w/이미지:파일명 SSR 캐시 및 /api/w/이미지:파일명 API 캐시 무효화
    c.executionCtx.waitUntil(invalidatePageCache(c, `이미지:${filename}`));

    return c.json({ success: true });
});

/**
 * GET /media/*
 * R2에서 이미지를 제공 (공개)
 */
media.get('/media/*', async (c) => {
    const key = c.req.path.replace('/media/', '');

    // 보안: images/ 경로 외 접근 차단
    if (!key.startsWith('images/')) {
        return c.json({ error: '접근이 거부되었습니다.' }, 403);
    }

    // 보안: Path Traversal 방지
    if (key.includes('..')) {
        return c.json({ error: '잘못된 경로입니다.' }, 400);
    }

    const object = await c.env.MEDIA.get(key);
    if (!object) {
        return c.json({ error: '파일을 찾을 수 없습니다.' }, 404);
    }

    const headers = new Headers();
    // Content-Type 강제: 허용된 MIME 타입만 원래 타입으로 서빙
    const rawType = object.httpMetadata?.contentType || '';
    const contentType = ALLOWED_TYPES.has(rawType) ? rawType : 'application/octet-stream';
    headers.set('Content-Type', contentType);
    headers.set('X-Content-Type-Options', 'nosniff');
    // 허용되지 않는 타입은 다운로드 강제
    if (!ALLOWED_TYPES.has(rawType)) {
        headers.set('Content-Disposition', 'attachment');
    }
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    // SVG는 클라이언트 업로드 전 DOMPurify로 정제되지만, 우회 공격 방어를 위해
    // 서빙 시에도 스크립트 실행을 CSP로 차단한다.
    if (contentType === 'image/svg+xml') {
        headers.set('Content-Security-Policy', "default-src 'none'");
    }

    return new Response(object.body, { headers });
});

function getExtension(filename: string, mimeType: string): string {
    const fromName = filename.split('.').pop()?.toLowerCase();
    // 확장자는 r2_key(`images/<name>.<ext>`)에 그대로 들어가 URL·HTML 속성에 주입되므로
    // 영숫자만 허용한다. 비정상 확장자는 MIME 타입 기반 매핑으로 대체한다.
    if (fromName && fromName.length <= 5 && /^[a-z0-9]+$/.test(fromName)) return fromName;

    const mimeMap: Record<string, string> = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/svg+xml': 'svg',
    };
    return mimeMap[mimeType] || 'bin';
}

export default media;
