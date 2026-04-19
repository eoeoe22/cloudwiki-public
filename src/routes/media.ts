import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth, requirePermission } from '../middleware/session';

const media = new Hono<Env>();

// 허용 MIME 타입
const ALLOWED_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'video/mp4',
    'video/webm',
    'video/ogg',
]);

/**
 * 문서 제목 슬러그에서 금지되는 문자와 동일한 규칙을 기본으로 사용하고,
 * 파일 경로 안전을 위해 `/`, `\`, `.`를, URL 안전을 위해 `?`를 추가로 차단한다.
 * (`.`은 확장자 처리가 별도로 이루어지기 때문에 사용자 입력 파일명에 포함되면 안 되고,
 *  `?`는 `/media/${r2_key}` URL에서 쿼리 구분자로 해석되어 객체 조회가 실패한다)
 * 공백류(`\s`)도 금지한다 — 업로드된 URL은 `![alt](/media/...)` 형태로 본문에 주입되며,
 * CommonMark 파서는 괄호로 감싸지 않은 링크 목적지에 공백이 있으면 파싱에 실패하여 이미지가 깨진다.
 */
const FILENAME_FORBIDDEN = /[\[\]()#%|<>^\x00-\x1F\x7F\/\\.?\s]/;

function validateUploadFilename(name: string): { ok: true; value: string } | { ok: false; error: string } {
    const trimmed = name.trim();
    if (!trimmed) {
        return { ok: false, error: '파일명을 입력해주세요.' };
    }
    if (FILENAME_FORBIDDEN.test(trimmed)) {
        return { ok: false, error: '파일명에 사용할 수 없는 문자가 포함되어 있습니다. ([ ] ( ) # % | < > ^ / \\ . ? 공백 등은 사용할 수 없습니다)' };
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

    // R2 업로드
    await c.env.MEDIA.put(r2Key, file.stream(), {
        httpMetadata: { contentType: file.type },
    });

    // DB 기록 (filename에 확장자 포함 최종 파일명 저장)
    const dbFilename = `${finalFilename}.${ext}`;
    await c.env.DB.prepare(
        'INSERT INTO media (r2_key, filename, mime_type, size, uploader_id, content) VALUES (?, ?, ?, ?, ?, ?)'
    )
        .bind(r2Key, dbFilename, file.type, file.size, user.id, '')
        .run();

    // 공개 URL 반환
    const publicUrl = `${c.env.MEDIA_PUBLIC_URL}/${r2Key}`;

    return c.json({ url: publicUrl, r2_key: r2Key, filename: dbFilename });
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

    const where: string[] = [`mime_type LIKE 'image/%'`];
    const params: any[] = [];
    if (search) {
        where.push('filename LIKE ?');
        params.push(`%${search}%`);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const listSql = `SELECT id, r2_key, filename, mime_type, size, created_at
                     FROM media ${whereSql}
                     ORDER BY created_at DESC
                     LIMIT ? OFFSET ?`;
    const countSql = `SELECT COUNT(*) as count FROM media ${whereSql}`;

    const [listResult, countResult] = await Promise.all([
        db.prepare(listSql).bind(...params, limit, offset).all(),
        db.prepare(countSql).bind(...params).first<{ count: number }>(),
    ]);

    const publicBase = c.env.MEDIA_PUBLIC_URL;
    const items = (listResult.results || []).map((m: any) => ({
        id: m.id,
        r2_key: m.r2_key,
        filename: m.filename,
        mime_type: m.mime_type,
        size: m.size,
        created_at: m.created_at,
        url: `${publicBase}/${m.r2_key}`,
    }));

    return c.json({ items, total: countResult?.count || 0 });
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
    });
});

/**
 * PUT /api/media/doc/:filename
 * 이미지 문서 content 수정 — 문서 편집 권한(wiki:edit) 보유자가 사용.
 * body: { content: string }
 * 리비전은 남기지 않고 즉시 덮어쓴다.
 */
media.put('/api/media/doc/:filename', requireAuth, requirePermission('wiki:edit'), async (c) => {
    const filename = c.req.param('filename');
    let body: { content?: string };
    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: '유효하지 않은 요청입니다.' }, 400);
    }
    const content = typeof body.content === 'string' ? body.content : '';

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

    // /w/이미지:파일명 SSR 캐시 및 /api/w/이미지:파일명 API 캐시 무효화
    const cache = caches.default;
    const origin = new URL(c.req.url).origin;
    const slug = `이미지:${filename}`;
    const encodedSlug = encodeURIComponent(slug);
    c.executionCtx.waitUntil(Promise.allSettled([
        cache.delete(`${origin}/w/${encodedSlug}`),
        cache.delete(`${origin}/api/w/${encodedSlug}`),
        cache.delete(`${origin}/api/w/${encodedSlug}?redirect=no`),
    ]));

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

    return new Response(object.body, { headers });
});

function getExtension(filename: string, mimeType: string): string {
    const fromName = filename.split('.').pop()?.toLowerCase();
    if (fromName && fromName.length <= 5) return fromName;

    const mimeMap: Record<string, string> = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'video/mp4': 'mp4',
        'video/webm': 'webm',
        'video/ogg': 'ogg',
    };
    return mimeMap[mimeType] || 'bin';
}

export default media;
