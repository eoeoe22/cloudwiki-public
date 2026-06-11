import { Hono, type Context } from 'hono';
import type { Env } from '../types';
import type { RBAC } from '../utils/role';
import { requireAuth } from '../middleware/session';
import { isWorkspacesEnabled } from '../utils/workspace';
import { getWorkspaceAccess, getWorkspaceAccessBySlug } from '../utils/workspaceAcl';
import type { WorkspaceAccess } from '../utils/workspaceAcl';
import type { Workspace, WorkspaceMedia } from '../shared/models';
import {
    wsMediaR2Key,
    wsMediaServePath,
    findUnreferencedWorkspaceMedia,
} from '../utils/workspaceMedia';

/**
 * 워크스페이스 미디어 API (/api/ws/:wslug/media...) 및 접근 제어 서빙(/wsmedia/...).
 *
 * 설계 제약 (워크스페이스 격리):
 *   - workspace_media 테이블 + `ws-media/{id}/...` R2 네임스페이스만 사용. 전역 media
 *     테이블/`images/...` 키를 절대 건드리지 않는다.
 *   - 모든 JSON 응답은 `private, no-store` — 비공개 데이터라 공유/엣지 캐시 적재 금지.
 *   - 비멤버/게스트는 ws_public=1 미디어만 서빙 경로로 열람 가능(라우트 레이어에서 적용).
 *
 * media.ts 의 업로드/SVG 검증/파일명 규칙/서빙 헤더를 로컬에 복제해 동일 동작을 유지하되,
 * 전역 media 내부를 export 로 끌어오지 않는다(워크스페이스 라우트는 leaf 격리).
 */

const wsMedia = new Hono<Env>();

// 허용 MIME 타입 (이미지 전용 — media.ts ALLOWED_TYPES 와 동일)
const ALLOWED_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
]);

/**
 * SVG XSS 벡터 거부 패턴 (media.ts SVG_FORBIDDEN_PATTERNS 와 동일).
 * canWrite 권한자가 브라우저 UI(DOMPurify)를 우회해 직접 POST 할 수 있으므로
 * 서버에서도 스크립트 실행으로 이어지는 마크업이 포함된 SVG 는 저장하지 않는다.
 */
const SVG_FORBIDDEN_PATTERNS: { re: RegExp; label: string }[] = [
    { re: /<script[\s/>]/i, label: '<script>' },
    { re: /<foreignObject[\s/>]/i, label: '<foreignObject>' },
    { re: /<!DOCTYPE/i, label: '<!DOCTYPE>' },
    { re: /<!ENTITY/i, label: '<!ENTITY>' },
    { re: /[\s"'/<]on[a-z]+\s*=/i, label: 'on* 이벤트 핸들러' },
    { re: /javascript:/i, label: 'javascript: URL' },
];

/**
 * 업로드 파일명 금지 문자 (media.ts FILENAME_FORBIDDEN 기반).
 * 추가로 따옴표 `'` `"` 도 금지한다 — 본문 내 미디어 참조 추출
 * (workspaceMedia.ts extractWorkspaceMediaRefs)의 파일명 경계 블랙리스트가 `'`/`"` 에서
 * 매칭을 끊으므로, 이를 포함한 파일명은 참조 추출이 누락돼 ws_public 동기화 실패 및
 * GC 오삭제(데이터 손실)로 이어진다. 저장 가능한 파일명이 항상 추출 경로로 왕복되도록
 * 업로드 단계에서 차단한다.
 */
const FILENAME_FORBIDDEN = /[\[\]()#%|<>^\x00-\x1F\x7F\/\\.?\s'"]/;

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
 * 확장자 결정 (media.ts getExtension 기반).
 * media.ts 와 달리 파일명 유래 확장자를 `^\w+$`(영숫자/밑줄)로 제한한다 — 확장자는
 * 검증되지 않은 multipart `file.name` 에서 오므로, 따옴표·하이픈 등 본문 미디어 참조
 * 추출기(workspaceMedia.ts)의 경계 문자가 끼면 저장 파일명이 추출 경로로 왕복되지 못해
 * ws_public 동기화 누락·GC 오삭제(데이터 손실)로 이어진다. 부적합하면 MIME 유래 안전
 * 확장자로 폴백한다(허용 타입이 이미지 5종으로 제한돼 항상 `\w+` 확장자를 보장).
 */
function getExtension(filename: string, mimeType: string): string {
    const fromName = filename.split('.').pop()?.toLowerCase();
    if (fromName && fromName.length <= 5 && /^\w+$/.test(fromName)) return fromName;

    const mimeMap: Record<string, string> = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/svg+xml': 'svg',
    };
    return mimeMap[mimeType] || 'bin';
}

/** :wslug 로 워크스페이스 + 접근 권한을 해석한다. workspace null 이면 호출 측에서 404. */
async function resolveWs(c: Context<Env>): Promise<{ workspace: Workspace | null; access: WorkspaceAccess }> {
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    return getWorkspaceAccessBySlug(c.env.DB, c.req.param('wslug') || '', user, rbac);
}

/** 읽기 거부 응답 — 게스트는 401(로그인 유도), 로그인 사용자는 403. */
function denyRead(c: Context<Env>) {
    if (!c.get('user')) return c.json({ error: '로그인이 필요합니다.' }, 401);
    return c.json({ error: '이 워크스페이스를 열람할 권한이 없습니다.' }, 403);
}

// 기능 토글 가드 + 공통 응답 캐시 정책. 비활성 시 모든 API 워크스페이스 경로가 404.
wsMedia.use('/api/ws/*', async (c, next) => {
    if (!isWorkspacesEnabled(c.env)) {
        return c.json({ error: '워크스페이스 기능이 비활성화되어 있습니다.' }, 404);
    }
    await next();
    // 워크스페이스 데이터는 비공개 — 공유/엣지 캐시 적재 금지.
    c.header('Cache-Control', 'private, no-store');
});

/**
 * POST /api/ws/:wslug/media
 * 워크스페이스 미디어 업로드 (canWrite 필요). multipart/form-data: file, filename.
 */
wsMedia.post('/api/ws/:wslug/media', requireAuth, async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canWrite) return c.json({ error: '이 워크스페이스에 업로드할 권한이 없습니다.' }, 403);
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

    // 크기 검증 (media.ts 와 동일, 기본 15MB)
    const MAX_SIZE = parseInt(c.env.MAX_UPLOAD_SIZE || '15728640', 10);
    if (file.size > MAX_SIZE) {
        const maxSizeMb = MAX_SIZE / (1024 * 1024);
        return c.json({ error: `파일 크기는 ${maxSizeMb}MB 이하만 허용됩니다.` }, 400);
    }

    // SVG 보안 검증: 클라이언트 정제(DOMPurify) 우회 직접 호출에 대비.
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

    // 중복 파일명 처리: 이 워크스페이스 내 workspace_media 행과만 충돌 검사 (워크스페이스 격리).
    let finalFilename = customFilename;
    let r2Key = wsMediaR2Key(workspace.id, `${finalFilename}.${ext}`);

    const existing = await c.env.DB.prepare(
        'SELECT id FROM workspace_media WHERE workspace_id = ? AND r2_key = ?'
    ).bind(workspace.id, r2Key).first();

    if (existing) {
        let counter = 2;
        while (true) {
            finalFilename = `${customFilename}-${counter}`;
            r2Key = wsMediaR2Key(workspace.id, `${finalFilename}.${ext}`);
            const dup = await c.env.DB.prepare(
                'SELECT id FROM workspace_media WHERE workspace_id = ? AND r2_key = ?'
            ).bind(workspace.id, r2Key).first();
            if (!dup) break;
            counter++;
        }
    }

    // R2 업로드 (SVG 는 위에서 읽어 검증한 본문을, 그 외는 원본 스트림을 저장)
    await c.env.MEDIA.put(r2Key, svgBody !== null ? svgBody : file.stream(), {
        httpMetadata: { contentType: file.type },
    });

    // DB 기록 (filename 에 확장자 포함 최종 파일명 저장, ws_public 기본 0)
    const dbFilename = `${finalFilename}.${ext}`;
    const insertResult = await c.env.DB.prepare(
        'INSERT INTO workspace_media (workspace_id, r2_key, filename, mime_type, size, uploader_id, ws_public) VALUES (?, ?, ?, ?, ?, ?, 0)'
    )
        .bind(workspace.id, r2Key, dbFilename, file.type, file.size, user.id)
        .run();

    const id = Number(insertResult.meta?.last_row_id ?? 0);

    // url 은 워크스페이스 id 기반 서빙 경로 — 슬러그 변경에 안전하고 본문 링크/공개 스캐너가 인식한다.
    return c.json({
        ok: true,
        url: wsMediaServePath(workspace.id, dbFilename),
        filename: dbFilename,
        id,
    });
});

/**
 * GET /api/ws/:wslug/media
 * 워크스페이스 미디어 목록 (canRead 필요), 최신순. ?limit (기본 100, 최대 200), ?offset (기본 0).
 * 미디어 관리 페이지(ws-media)는 200개를 초과하는 워크스페이스에서도 전체를 다뤄야 하므로
 * offset 으로 페이지를 끝까지 순회해 모든 미디어를 가져올 수 있다(한 페이지가 limit 미만이면 끝).
 */
wsMedia.get('/api/ws/:wslug/media', async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canRead) return denyRead(c);

    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 100));
    const offset = Math.max(0, Number(c.req.query('offset')) || 0);
    const rows = await c.env.DB.prepare(
        'SELECT id, filename, mime_type, size, ws_public, created_at FROM workspace_media WHERE workspace_id = ? ORDER BY id DESC LIMIT ? OFFSET ?'
    ).bind(workspace.id, limit, offset).all<Omit<WorkspaceMedia, 'workspace_id' | 'r2_key' | 'uploader_id'>>();

    const items = (rows.results || []).map((m) => ({
        ...m,
        url: wsMediaServePath(workspace.id, m.filename),
    }));
    return c.json({ ok: true, items });
});

/**
 * DELETE /api/ws/:wslug/media/:id
 * 워크스페이스 미디어 단건 삭제 (canWrite 필요). R2 객체 + DB 행 삭제.
 */
wsMedia.delete('/api/ws/:wslug/media/:id', requireAuth, async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canWrite) return c.json({ error: '이 워크스페이스에서 삭제할 권한이 없습니다.' }, 403);

    const id = parseInt(c.req.param('id') || '', 10);
    if (!Number.isFinite(id)) return c.json({ error: '잘못된 요청입니다.' }, 400);

    const row = await c.env.DB.prepare(
        'SELECT id, r2_key FROM workspace_media WHERE id = ? AND workspace_id = ?'
    ).bind(id, workspace.id).first<{ id: number; r2_key: string }>();
    if (!row) return c.json({ error: '미디어를 찾을 수 없습니다.' }, 404);

    await c.env.MEDIA.delete(row.r2_key);
    await c.env.DB.prepare('DELETE FROM workspace_media WHERE id = ?').bind(row.id).run();

    return c.json({ ok: true });
});

/**
 * GET /api/ws/:wslug/media/gc
 * 미참조(어떤 비삭제 문서도 참조하지 않는) 미디어 목록 (canManage 필요).
 */
wsMedia.get('/api/ws/:wslug/media/gc', requireAuth, async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canManage) return c.json({ error: '이 작업을 수행할 권한이 없습니다.' }, 403);

    const unreferenced = await findUnreferencedWorkspaceMedia(c.env.DB, workspace.id);
    const items = unreferenced.map((m) => ({
        id: m.id,
        filename: m.filename,
        size: m.size,
        created_at: m.created_at,
        url: wsMediaServePath(workspace.id, m.filename),
    }));
    return c.json({ ok: true, items });
});

/**
 * POST /api/ws/:wslug/media/gc
 * 미참조 미디어 가비지 컬렉션 (canManage 필요). body 선택 { ids?: number[] }.
 * ids 지정 시 미참조 집합과 교집합만 삭제(참조 파일은 절대 삭제 안 함). 미지정 시 전부 삭제.
 */
wsMedia.post('/api/ws/:wslug/media/gc', requireAuth, async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canManage) return c.json({ error: '이 작업을 수행할 권한이 없습니다.' }, 403);

    let body: { ids?: unknown } = {};
    try {
        body = (await c.req.json()) as { ids?: unknown };
    } catch {
        // 본문 없음/비JSON 은 전체 삭제로 해석.
    }

    const unreferenced = await findUnreferencedWorkspaceMedia(c.env.DB, workspace.id);
    let targets = unreferenced;
    if (Array.isArray(body.ids)) {
        // 안전: ids 는 항상 미참조 집합과 교집합 (참조 파일은 절대 삭제하지 않는다).
        const wanted = new Set(
            body.ids.map((v) => Number(v)).filter((n) => Number.isFinite(n))
        );
        targets = unreferenced.filter((m) => wanted.has(m.id));
    }

    if (targets.length === 0) return c.json({ ok: true, deleted: 0 });

    // R2 객체는 개별 삭제, DB 행은 배치 삭제.
    await Promise.all(targets.map((m) => c.env.MEDIA.delete(m.r2_key)));
    await c.env.DB.batch(
        targets.map((m) => c.env.DB.prepare('DELETE FROM workspace_media WHERE id = ?').bind(m.id))
    );

    return c.json({ ok: true, deleted: targets.length });
});

/**
 * GET /wsmedia/:wsid/:filename{.+}
 * 접근 제어 R2 서빙 (API 아님). :wsid 는 워크스페이스 숫자 id.
 * ws_public=1 미디어는 누구나, 그 외는 canRead 멤버만 열람. 게스트 401 / 비멤버 403.
 */
wsMedia.get('/wsmedia/:wsid/:filename{.+}', async (c) => {
    if (!isWorkspacesEnabled(c.env)) {
        return c.json({ error: '워크스페이스 기능이 비활성화되어 있습니다.' }, 404);
    }

    const wsid = parseInt(c.req.param('wsid') || '', 10);
    if (!Number.isFinite(wsid)) return c.json({ error: '잘못된 경로입니다.' }, 400);

    let filename: string;
    try {
        filename = decodeURIComponent(c.req.param('filename') || '');
    } catch {
        return c.json({ error: '잘못된 경로입니다.' }, 400);
    }
    if (!filename) return c.json({ error: '잘못된 경로입니다.' }, 400);

    const media = await c.env.DB.prepare(
        'SELECT r2_key, mime_type, ws_public FROM workspace_media WHERE workspace_id = ? AND filename = ?'
    ).bind(wsid, filename).first<{ r2_key: string; mime_type: string; ws_public: number }>();
    if (!media) return c.json({ error: '파일을 찾을 수 없습니다.' }, 404);

    // 워크스페이스 존재(비삭제) 확인 + 멤버십 기반 접근 평가.
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const access = await getWorkspaceAccess(c.env.DB, wsid, user, rbac);

    const allowed = media.ws_public === 1 || access.canRead;
    if (!allowed) {
        if (!user) return c.json({ error: '로그인이 필요합니다.' }, 401);
        return c.json({ error: '이 파일을 열람할 권한이 없습니다.' }, 403);
    }

    const object = await c.env.MEDIA.get(media.r2_key);
    if (!object) return c.json({ error: '파일을 찾을 수 없습니다.' }, 404);

    const headers = new Headers();
    const rawType = media.mime_type || '';
    const contentType = ALLOWED_TYPES.has(rawType) ? rawType : 'application/octet-stream';
    headers.set('Content-Type', contentType);
    headers.set('X-Content-Type-Options', 'nosniff');
    if (!ALLOWED_TYPES.has(rawType)) {
        headers.set('Content-Disposition', 'attachment');
    }
    // SVG 는 서빙 시에도 스크립트 실행을 CSP 로 차단(업로드 검증과 이중 방어).
    if (contentType === 'image/svg+xml') {
        headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    }
    // ws_public 은 짧게 공유 캐시 허용, 그 외는 비공개 캐시 금지.
    headers.set('Cache-Control', media.ws_public === 1 ? 'public, max-age=60' : 'private, no-store');
    // 워크스페이스 미디어는 링크 전용 — 검색 색인 금지.
    headers.set('X-Robots-Tag', 'noindex');

    return new Response(object.body, { headers });
});

export default wsMedia;
