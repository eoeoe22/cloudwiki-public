import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth } from '../middleware/session';

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
 * POST /api/media
 * 이미지 업로드 (로그인 필수)
 * multipart/form-data, 필드명: file, filename (사용자 지정 파일명)
 */
media.post('/api/media', requireAuth, async (c) => {
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

    // 사용자 지정 파일명 및 보안 필터링
    let customFilename = (formData.get('filename') as string)?.trim();
    if (!customFilename) {
        return c.json({ error: '파일명을 입력해주세요.' }, 400);
    }

    // 보안: 경로 탐색 및 특수문자 제거
    // 1. 경로 관련 문자(/, \, .) 및 특수문자 제거/치환
    // 2. 공백을 하이픈으로 치환
    // 3. 영문, 숫자, 한글, 하이픈, 언더바만 허용
    customFilename = customFilename
        .replace(/[\/\.\\]/g, '') // 경로 구분자 및 마침표 제거
        .replace(/\s+/g, '-')     // 공백을 하이픈으로
        .replace(/[^a-zA-Z0-9가-힣\-_]/g, '') // 허용되지 않는 특수문자 제거
        .slice(0, 100);           // 길이 제한 (DB/R2 안전)

    if (!customFilename) {
        customFilename = 'uploaded_file';
    }

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

    // 중복 파일명 처리: images/customFilename.ext → images/customFilename(1).ext ...
    let finalFilename = customFilename;
    let r2Key = `images/${finalFilename}.${ext}`;

    const existing = await c.env.DB.prepare(
        'SELECT id FROM media WHERE r2_key = ?'
    ).bind(r2Key).first();

    if (existing) {
        // 중복 → 넘버링
        let counter = 1;
        while (true) {
            finalFilename = `${customFilename}(${counter})`;
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
        'INSERT INTO media (r2_key, filename, mime_type, size, uploader_id) VALUES (?, ?, ?, ?, ?)'
    )
        .bind(r2Key, dbFilename, file.type, file.size, user.id)
        .run();

    // 공개 URL 반환
    const publicUrl = `${c.env.MEDIA_PUBLIC_URL}/${r2Key}`;

    return c.json({ url: publicUrl, r2_key: r2Key, filename: dbFilename });
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
