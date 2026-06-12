import { Hono, type Context } from 'hono';
import type { Env } from '../types';
import type { RBAC } from '../utils/role';
import { requireAuth } from '../middleware/session';
import { normalizeSlug } from '../utils/slug';
import { safeJSON } from '../utils/json';
import { isWorkspacesEnabled } from '../utils/workspace';
import { getWorkspaceAccessBySlug } from '../utils/workspaceAcl';
import type { WorkspaceAccess } from '../utils/workspaceAcl';
import type { Workspace, WorkspacePage } from '../shared/models';
import { getRevisionContent } from '../utils/r2';
import { saveWorkspacePage } from '../utils/workspacePagePipeline';
import { syncWorkspaceMediaVisibility } from '../utils/workspaceMedia';
import {
    SLUG_FORBIDDEN_CHARS,
    TITLE_FORBIDDEN_CHARS,
    TITLE_MAX_LENGTH,
    normalizeTitleInput,
} from './wiki';
import { mergeEditSummary } from '../utils/editSummary';

/**
 * 워크스페이스 문서의 doc_type(본문 표시 유형) 화이트리스트.
 * 빈 문자열/null 은 NULL(일반 문서). 'presentation' 은 슬라이드 덱(프레젠테이션).
 * 프레젠테이션 모드는 워크스페이스 전용 — 전역 위키 문서에는 존재하지 않는다.
 * 추후 다른 표시 유형(칸반/타임라인 등)을 추가하려면 이 집합에 값을 더한다.
 */
export const ALLOWED_DOC_TYPES = new Set<string>(['presentation']);

/**
 * 워크스페이스 문서 API (/api/ws/:wslug/pages...).
 *
 * 설계 제약 (워크스페이스 격리 — 데이터 무결성 핵심):
 *   - workspace_* 테이블만 사용. 전역 pages/media/page_links 를 절대 건드리지 않는다.
 *   - edit_acl / 카테고리 ACL / 편집 요청 보류 / 주시자 알림 / 전역 캐시 무효화 없음.
 *   - 모든 응답은 `private, no-store` — 엣지 캐시에 절대 적재하지 않는다(비공개 데이터).
 *   - 비멤버/게스트는 ws_public=1 문서만 읽기 가능(라우트 레이어에서 적용 — workspaceAcl 주석 참고).
 *
 * 문서 슬러그는 슬래시를 포함할 수 있으므로 Hono 정규식 파라미터 `:slug{.+}` 를 사용한다.
 * 같은 prefix 를 공유하는 더 구체적인 경로(`/revisions`/`/backlinks` 등 suffix)가 먼저
 * 매칭되도록 등록 순서를 구체 → 일반 순으로 유지한다. 이로 인해 `revisions`/`backlinks`
 * 등으로 끝나는 슬러그의 문서는 단건 GET 경로와 충돌한다(알려진 제약).
 */

const wsPages = new Hono<Env>();

// 기능 토글 가드 + 공통 응답 캐시 정책. 비활성 시 모든 워크스페이스 경로가 404.
wsPages.use('/api/ws/*', async (c, next) => {
    if (!isWorkspacesEnabled(c.env)) {
        return c.json({ error: '워크스페이스 기능이 비활성화되어 있습니다.' }, 404);
    }
    await next();
    // 워크스페이스 데이터는 비공개 — 공유/엣지 캐시 적재 금지.
    c.header('Cache-Control', 'private, no-store');
});

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

/**
 * 워크스페이스 틀 네임스페이스 접두사. 워크스페이스 틀 문서는 전역 위키와 동일하게
 * `틀:이름` 슬러그로 저장한다 — 본문 `{{이름}}` 트랜스클루전이 `extractPageLinks`(shared/links.ts)
 * 에서 `틀:이름` 으로 정규화되어 `workspace_page_links`/검색/본문 fetch 가 일관되게 동작한다.
 */
const WS_TEMPLATE_PREFIX = '틀:';

/**
 * 워크스페이스 문서 슬러그 검증.
 * 전역 슬러그 규칙(SLUG_FORBIDDEN_CHARS)에 더해 `:` 를 금지한다 — 워크스페이스 문서는
 * 평문 슬러그만 사용하며, 전역의 가상 네임스페이스(`이미지:`/`map:`/익스텐션)와의
 * 혼동을 구조적으로 차단한다.
 *
 * 예외: `틀:` 네임스페이스 1개는 허용한다(워크스페이스 자체 틀 저작). `틀:` 로 시작하고
 * 그 이후에 추가 `:` 가 없을 때만 통과시켜, 익스텐션/기타 가상 네임스페이스와의 혼동은
 * 계속 차단한다(`틀:이름`, `틀:이름/하위` 는 허용; `틀:freq:x`, `이미지:x` 는 거부).
 */
function validatePageSlug(raw: unknown): { ok: true; slug: string } | { ok: false; error: string } {
    if (typeof raw !== 'string') return { ok: false, error: '문서 제목이 필요합니다.' };
    const slug = normalizeSlug(raw);
    if (!slug) return { ok: false, error: '문서 제목을 입력해주세요.' };
    if (SLUG_FORBIDDEN_CHARS.test(slug)) {
        return { ok: false, error: '문서 제목에 사용할 수 없는 문자가 포함되어 있습니다. ([ ] { } # % | < > ^ 등)' };
    }
    // `틀:` 접두 1개만 예외 허용 — 접두사를 떼어낸 나머지에 `:` 가 없어야 한다.
    const isTemplate = slug.startsWith(WS_TEMPLATE_PREFIX);
    const rest = isTemplate ? slug.slice(WS_TEMPLATE_PREFIX.length) : slug;
    if (rest.includes(':')) {
        return { ok: false, error: "워크스페이스 문서 제목에는 ':' 를 사용할 수 없습니다. (틀: 네임스페이스만 예외)" };
    }
    if (isTemplate && !rest) {
        return { ok: false, error: '틀 이름을 입력해주세요.' };
    }
    return { ok: true, slug };
}

/** LIKE 패턴 이스케이프 (ESCAPE '\' 와 함께 사용) */
function escapeLike(s: string): string {
    return s.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

/** (workspace_id, slug) 의 비삭제 문서 조회 */
async function findPage(db: D1Database, workspaceId: number, slug: string): Promise<WorkspacePage | null> {
    return db
        .prepare('SELECT * FROM workspace_pages WHERE workspace_id = ? AND slug = ? AND deleted_at IS NULL')
        .bind(workspaceId, slug)
        .first<WorkspacePage>();
}

// ============================================================
// 목록
// ============================================================

/**
 * GET /api/ws/:wslug/pages — 비삭제 문서 목록.
 * ?prefix= : 해당 슬러그의 하위 문서만 (slug LIKE 'prefix/%')
 * ?top=1   : 최상위 문서만 (슬래시 미포함)
 * ?q=      : slug 부분 일치 검색 (slug-only — title 은 매칭에 참여하지 않음)
 * ?sort=   : 'slug'(이름 오름차순) | 그 외/미지정 = 'updated_at'(최근 수정 내림차순)
 * ?limit=  : 페이지 크기(1~500, 기본 500), ?offset= : 시작 오프셋(기본 0)
 * 응답에 전체 매칭 개수 total 을 함께 반환해 클라이언트 페이지네이션을 지원한다.
 * 비멤버/게스트(canRead=false)에게는 ws_public=1 문서만 노출한다.
 */
wsPages.get('/api/ws/:wslug/pages', async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);

    const conds: string[] = ['workspace_id = ?', 'deleted_at IS NULL'];
    const binds: unknown[] = [workspace.id];
    if (!access.canRead) conds.push('ws_public = 1');

    const prefixRaw = c.req.query('prefix');
    if (prefixRaw) {
        const prefix = normalizeSlug(prefixRaw);
        if (prefix) {
            conds.push("slug LIKE ? ESCAPE '\\'");
            binds.push(escapeLike(prefix) + '/%');
        }
    }
    if (c.req.query('top') === '1') conds.push("slug NOT LIKE '%/%'");

    // 검색: slug 부분 일치. 식별·호출 경로 일관성을 위해 title 은 매칭에 넣지 않는다.
    const qRaw = (c.req.query('q') || '').trim();
    if (qRaw) {
        conds.push("slug LIKE ? ESCAPE '\\'");
        binds.push('%' + escapeLike(qRaw) + '%');
    }

    // 정렬: slug 오름차순 또는 최근 수정 내림차순(기본). 둘 다 slug tie-breaker 로 안정 정렬.
    const orderBy = c.req.query('sort') === 'slug'
        ? 'slug ASC'
        : 'updated_at DESC, slug ASC';

    // 페이지네이션: limit 1~500, offset >= 0.
    const limitRaw = parseInt(c.req.query('limit') || '', 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 500;
    const offsetRaw = parseInt(c.req.query('offset') || '', 10);
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;

    const whereSql = conds.join(' AND ');

    const countRow = await c.env.DB
        .prepare(`SELECT COUNT(*) AS n FROM workspace_pages WHERE ${whereSql}`)
        .bind(...binds)
        .first<{ n: number }>();
    const total = countRow?.n ?? 0;

    const rows = await c.env.DB
        .prepare(
            `SELECT id, slug, title, updated_at, version, ws_public, rows, characters, redirect_to, doc_type
             FROM workspace_pages
             WHERE ${whereSql}
             ORDER BY ${orderBy}
             LIMIT ? OFFSET ?`
        )
        .bind(...binds, limit, offset)
        .all();
    return c.json(safeJSON({ pages: rows.results || [], total }));
});

/**
 * GET /api/ws/:wslug/search-titles — 인라인 자동완성용 제목/틀 검색 (최대 5개).
 * 전역 위키 `GET /w/search-titles` (routes/wiki.ts) 의 워크스페이스 대응판으로, 자동완성
 * 클라이언트(edit/autocomplete.ts)가 컨텍스트만 바꿔 그대로 재사용할 수 있도록 동일한
 * 응답 형태(`{ results: [{ slug }] }`)를 돌려준다.
 *
 * Query:
 *   q       : slug 부분 일치(slug-only — title 은 매칭에 넣지 않는다, 식별·호출 경로 일관성).
 *   type    : 'template' → `틀:%` 만 / 그 외(기본 'link') → `틀:%` 제외. 워크스페이스는 익스텐션
 *             설정이 없으므로 전역과 달리 익스텐션 네임스페이스는 검색 대상에 넣지 않는다.
 *   exclude : 자기 자신 슬러그 제외(틀 자동완성에서 자기 참조 방지).
 * 비멤버/게스트(canRead=false)에게는 ws_public=1 문서만 노출(목록 엔드포인트와 동일 게이팅).
 */
wsPages.get('/api/ws/:wslug/search-titles', async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);

    const conds: string[] = ['workspace_id = ?', 'deleted_at IS NULL'];
    const binds: unknown[] = [workspace.id];
    if (!access.canRead) conds.push('ws_public = 1');

    const type = c.req.query('type') === 'template' ? 'template' : 'link';
    if (type === 'template') {
        conds.push("slug LIKE ? ESCAPE '\\'");
        binds.push(escapeLike(WS_TEMPLATE_PREFIX) + '%');
    } else {
        conds.push("slug NOT LIKE ? ESCAPE '\\'");
        binds.push(escapeLike(WS_TEMPLATE_PREFIX) + '%');
    }

    const exclude = (c.req.query('exclude') || '').trim();
    if (exclude) {
        conds.push('slug != ?');
        binds.push(normalizeSlug(exclude));
    }

    const qRaw = (c.req.query('q') || '').trim();
    if (qRaw) {
        conds.push("slug LIKE ? ESCAPE '\\'");
        binds.push('%' + escapeLike(qRaw) + '%');
    }

    // 빈 쿼리: 최근 수정 순. 검색어 있으면 slug 오름차순(전역 search-titles 와 동일 정책).
    const orderBy = qRaw ? 'slug ASC' : 'updated_at DESC, slug ASC';

    const rows = await c.env.DB
        .prepare(
            `SELECT slug FROM workspace_pages
             WHERE ${conds.join(' AND ')}
             ORDER BY ${orderBy}
             LIMIT 5`
        )
        .bind(...binds)
        .all();
    return c.json(safeJSON({ results: rows.results || [] }));
});

// ============================================================
// 문서별 부속 경로 (단건 GET 보다 먼저 등록 — :slug{.+} 가 슬래시를 탐욕 매칭하므로
// 구체 suffix 경로를 앞에 두어야 한다)
// ============================================================

/**
 * GET /api/ws/:wslug/pages/:slug{.+}/revisions — 리비전 목록 (최신순, 페이지네이션).
 * Query: offset (기본 0), limit (기본 10, 최대 50). 전역 위키 /w/:slug/revisions 와 동일한
 * 응답 형태(`{ revisions, total, last_revision_id }`)를 돌려줘 리비전 페이지 클라이언트를 공유한다.
 * 멤버(canRead) 또는 ws_public=1 문서. 워크스페이스는 리비전 소프트/하드 삭제 개념이 없으므로
 * is_admin_view/can_hard_delete 는 노출하지 않는다.
 */
wsPages.get('/api/ws/:wslug/pages/:slug{.+}/revisions', async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    const slug = normalizeSlug(c.req.param('slug'));
    const page = await findPage(c.env.DB, workspace.id, slug);
    if (!page) return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    if (!access.canRead && page.ws_public !== 1) return denyRead(c);

    // 비정상 입력(?offset=abc 등)은 parseInt → NaN 이 LIMIT/OFFSET 바인딩으로 흘러 D1 500 을 유발하므로
    // Number.isFinite 로 검증 후 기본값(offset 0, limit 10)으로 폴백한다.
    const offsetRaw = parseInt(c.req.query('offset') || '0', 10);
    const limitRaw = parseInt(c.req.query('limit') || '10', 10);
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;
    const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 10;

    const [countResult, listResult] = await c.env.DB.batch([
        c.env.DB.prepare('SELECT COUNT(*) as total FROM workspace_revisions WHERE page_id = ? AND deleted_at IS NULL').bind(page.id),
        c.env.DB.prepare(
            `SELECT r.id, r.page_version, r.summary, r.author_id, u.name AS author_name, r.created_at
             FROM workspace_revisions r
             LEFT JOIN users u ON u.id = r.author_id
             WHERE r.page_id = ? AND r.deleted_at IS NULL
             ORDER BY r.page_version DESC, r.id DESC
             LIMIT ? OFFSET ?`
        ).bind(page.id, limit, offset),
    ]);

    const rawTotal = (countResult.results[0] as any)?.total;
    const parsedTotal = Number(rawTotal);
    const total = Number.isFinite(parsedTotal) ? parsedTotal : 0;

    return c.json(safeJSON({
        slug: page.slug,
        version: page.version,
        revisions: listResult.results || [],
        total,
        last_revision_id: page.last_revision_id ?? null,
        // 되돌리기 버튼 노출 게이팅용 — 되돌리기 엔드포인트는 canWrite 를 요구한다.
        can_write: access.canWrite,
    }));
});

/**
 * GET /api/ws/:wslug/pages/:slug{.+}/backlinks — 이 문서를 참조하는 비삭제 문서 목록.
 * 역링크는 다른(비공개일 수 있는) 문서의 존재를 드러내므로 멤버(canRead) 전용.
 */
wsPages.get('/api/ws/:wslug/pages/:slug{.+}/backlinks', async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canRead) return denyRead(c);
    const slug = normalizeSlug(c.req.param('slug'));

    const rows = await c.env.DB
        .prepare(
            `SELECT DISTINCT p.slug, p.title
             FROM workspace_page_links l
             JOIN workspace_pages p ON p.id = l.source_page_id AND p.deleted_at IS NULL
             WHERE l.workspace_id = ? AND l.target_slug = ?
             ORDER BY p.slug ASC`
        )
        .bind(workspace.id, slug)
        .all();
    return c.json(safeJSON({ slug, backlinks: rows.results || [] }));
});

/**
 * GET /api/ws/:wslug/pages/:slug{.+}/subdocs — 하위 문서 목록 (slug LIKE '{slug}/%').
 * - ?immediate=1 → 바로 아래 단계 자식만 (slug/A 만, slug/A/B 제외)
 * 전역 위키 `/w/:slug/subdocs` 와 동일한 응답 형태(`{ subdocs: [{slug, title}] }`)를 돌려준다 —
 * 브레드크럼 형제 내비·문서 구조 보기 모달이 전역 위키와 같은 클라이언트 경로를 공유하기 위함.
 * 하위 문서 구조는 (비공개일 수 있는) 다른 문서의 존재를 드러내므로 멤버(canRead) 전용이되,
 * 게스트/비멤버에게는 목록 엔드포인트와 동일하게 ws_public=1 문서만 노출한다.
 */
wsPages.get('/api/ws/:wslug/pages/:slug{.+}/subdocs', async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    const slug = normalizeSlug(c.req.param('slug'));
    const immediate = c.req.query('immediate') === '1';

    const conds: string[] = ['workspace_id = ?', 'deleted_at IS NULL'];
    const binds: unknown[] = [workspace.id];
    if (!access.canRead) conds.push('ws_public = 1');

    const escaped = escapeLike(slug);
    if (immediate) {
        conds.push("slug LIKE ? ESCAPE '\\'");
        conds.push("slug NOT LIKE ? ESCAPE '\\'");
        binds.push(escaped + '/%', escaped + '/%/%');
    } else {
        conds.push("slug LIKE ? ESCAPE '\\'");
        binds.push(escaped + '/%');
    }

    const rows = await c.env.DB
        .prepare(
            `SELECT slug, title, updated_at
             FROM workspace_pages
             WHERE ${conds.join(' AND ')}
             ORDER BY slug ASC LIMIT 200`
        )
        .bind(...binds)
        .all();
    return c.json(safeJSON({ subdocs: rows.results || [] }));
});

/**
 * POST /api/ws/:wslug/pages/:slug{.+}/move — 문서 슬러그 변경 (canWrite).
 * body: { new_slug }
 *
 * 대상 문서와 그 하위 문서(`slug LIKE 'old/%'`)를 **함께** 이동한다(폴더 이름변경).
 * D1 은 다중 문서를 묶는 트랜잭션을 지원하지 않으므로 "사전검증 → batch 적용" 방식이다:
 *   1) 대상 + 하위 문서를 수집하고 각 목적 슬러그를 계산·검증한다(서로 중복도 차단).
 *   2) 자기 자신/하위 경로로의 이동을 차단한다.
 *   3) 얕은 깊이(슬러그 세그먼트 수) 오름차순으로 정렬한 뒤 `batch`(암시적 트랜잭션)로
 *      일괄 UPDATE 한다. 잔여 UNIQUE 위반(무관한 기존 문서·소프트 삭제 행 점유)은 409.
 * 별도 IN(...) 충돌 사전확인은 두지 않는다 — 하위 문서가 많으면 D1 의 bound-parameter
 * 한도(~100)에 걸리고, batch 의 원자적 롤백이 동일하게 충돌을 409 로 보장하기 때문이다.
 * 리비전을 만들지 않으며, 이 문서를 가리키는 다른 문서의 [[옛슬러그]] 참조 재작성은
 * 범위 밖이다(역링크는 옛 슬러그를 계속 가리킴 — 단건 move 와 동일 정책).
 */
wsPages.post('/api/ws/:wslug/pages/:slug{.+}/move', requireAuth, async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canWrite) return c.json({ error: '이 워크스페이스의 문서를 수정할 권한이 없습니다.' }, 403);

    const slug = normalizeSlug(c.req.param('slug'));
    const body = await c.req.json().catch(() => null) as { new_slug?: unknown } | null;
    const validated = validatePageSlug(body?.new_slug);
    if (!validated.ok) return c.json({ error: validated.error }, 400);
    const newSlug = validated.slug;

    const page = await findPage(c.env.DB, workspace.id, slug);
    if (!page) return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    if (newSlug === slug) return c.json({ error: '현재 제목과 동일합니다.' }, 400);
    // 자기 자신의 하위 경로로 이동 불가 — 옛/새 슬러그 공간이 겹쳐 중간 상태 충돌이 생긴다.
    if (newSlug.startsWith(slug + '/')) {
        return c.json({ error: '문서를 자기 자신의 하위 경로로 이동할 수 없습니다.' }, 400);
    }

    // ① 대상 + 하위 문서 수집 (slug 자신 또는 'slug/' prefix).
    const subPattern = escapeLike(slug) + '/%';
    const affectedRes = await c.env.DB
        .prepare("SELECT id, slug FROM workspace_pages WHERE workspace_id = ? AND (slug = ? OR slug LIKE ? ESCAPE '\\') AND deleted_at IS NULL")
        .bind(workspace.id, slug, subPattern)
        .all<{ id: number; slug: string }>();
    const affected = affectedRes.results || [];
    if (!affected.length) return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);

    // 얕은 깊이 먼저 처리되도록 정렬. 목적지가 조상인 "상위로 이동"(예: a/rest → a, 자식
    // a/rest/rest 포함)에서는 일부 목적 슬러그가 다른 대상의 *옛* 슬러그와 겹치는데, 부모를
    // 먼저 비워야 자식이 그 자리를 재점유할 때 UNIQUE 위반(거짓 409)이 나지 않는다. 겹침은
    // 항상 이 상위 이동에서만 생기므로(목적지가 자기 하위인 경우는 위에서 차단) 오름차순이면 충분.
    affected.sort((a, b) => a.slug.split('/').length - b.slug.split('/').length);

    // ② 각 목적 슬러그 계산·검증 (prefix 치환).
    const updates: { id: number; to: string }[] = [];
    const targetSet = new Set<string>();
    for (const row of affected) {
        const suffix = row.slug.slice(slug.length); // 대상 자신은 '', 하위 문서는 '/...'
        const v = validatePageSlug(newSlug + suffix);
        if (!v.ok) {
            return c.json({ error: `'${row.slug}' 의 새 경로가 유효하지 않습니다: ${v.error}` }, 400);
        }
        if (targetSet.has(v.slug)) {
            return c.json({ error: '이동 결과 슬러그가 서로 중복됩니다.' }, 400);
        }
        targetSet.add(v.slug);
        updates.push({ id: row.id, to: v.slug });
    }

    // ③ batch 일괄 UPDATE(위에서 얕은 깊이 순으로 정렬됨). 대상 간 자리 겹침은 정렬로
    //    해소되므로, 남는 UNIQUE 위반은 무관한 기존 문서(또는 같은 slug 의 소프트 삭제 행)와의
    //    충돌뿐 — batch 의 암시적 트랜잭션(부분 적용 없이 전체 롤백)에 의존해 409 로 매핑한다.
    try {
        await c.env.DB.batch(
            updates.map((u) =>
                c.env.DB
                    .prepare('UPDATE workspace_pages SET slug = ?, updated_at = unixepoch() WHERE id = ? AND deleted_at IS NULL')
                    .bind(u.to, u.id)
            )
        );
    } catch (e: any) {
        const msg = String(e?.message || e);
        if (/UNIQUE|constraint/i.test(msg)) {
            return c.json({ error: '이미 사용 중인 제목입니다.', code: 'SLUG_TAKEN' }, 409);
        }
        throw e;
    }
    return c.json({ ok: true, slug: newSlug, moved: updates.length });
});

/**
 * POST /api/ws/:wslug/pages/:slug{.+}/revert — 지정 리비전 본문으로 되돌리기 (canWrite).
 * body: { revision_id }
 * 새 리비전을 만드는 정방향 되돌리기 — 히스토리를 지우지 않는다.
 */
wsPages.post('/api/ws/:wslug/pages/:slug{.+}/revert', requireAuth, async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canWrite) return c.json({ error: '이 워크스페이스의 문서를 수정할 권한이 없습니다.' }, 403);
    const user = c.get('user')!;

    const slug = normalizeSlug(c.req.param('slug'));
    const page = await findPage(c.env.DB, workspace.id, slug);
    if (!page) return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);

    const body = await c.req.json().catch(() => null) as { revision_id?: unknown } | null;
    const revisionId = Number(body?.revision_id);
    if (!Number.isInteger(revisionId) || revisionId <= 0) {
        return c.json({ error: 'revision_id 가 필요합니다.' }, 400);
    }

    const rev = await c.env.DB
        .prepare('SELECT id, page_id, page_version, content, r2_key, deleted_at, purged_at FROM workspace_revisions WHERE id = ?')
        .bind(revisionId)
        .first<{ id: number; page_id: number; page_version: number | null; content: string; r2_key: string | null; deleted_at: number | null; purged_at: number | null }>();
    if (!rev || rev.page_id !== page.id || rev.deleted_at) {
        return c.json({ error: '리비전을 찾을 수 없습니다.' }, 404);
    }
    if (rev.purged_at) {
        return c.json({ error: '본문이 제거된 리비전으로는 되돌릴 수 없습니다.' }, 400);
    }

    const origin = new URL(c.req.url).origin;
    let content = await getRevisionContent(c.env.MEDIA, rev, origin);
    content = content.replace(/\r\n?/g, '\n');

    try {
        const result = await saveWorkspacePage(c, {
            workspaceId: workspace.id,
            slug: page.slug,
            content,
            authorId: user.id,
            summary: `r${rev.page_version ?? rev.id} 리비전으로 되돌리기`,
        });
        return c.json(safeJSON({
            ok: true,
            page_id: result.page_id,
            revision_id: result.revision_id,
            version: result.new_version,
        }));
    } catch (e: any) {
        if (e?.code === 'CONCURRENT_MODIFICATION') {
            return c.json({ error: '다른 사용자가 동시에 문서를 수정했습니다. 다시 시도해주세요.', code: 'CONCURRENT_MODIFICATION' }, 409);
        }
        throw e;
    }
});

/**
 * PATCH /api/ws/:wslug/pages/:slug{.+}/visibility — 문서 공개 토글 (canWrite).
 * body: { ws_public: 0 | 1 }
 * 토글 후 워크스페이스 미디어 공개 연동(ws_public=1 문서가 참조하는 미디어만 공개)을 재계산한다.
 */
wsPages.patch('/api/ws/:wslug/pages/:slug{.+}/visibility', requireAuth, async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canWrite) return c.json({ error: '이 워크스페이스의 문서를 수정할 권한이 없습니다.' }, 403);

    const slug = normalizeSlug(c.req.param('slug'));
    const body = await c.req.json().catch(() => null) as { ws_public?: unknown } | null;
    const raw = body?.ws_public;
    if (raw !== 0 && raw !== 1) {
        return c.json({ error: 'ws_public 은 0 또는 1 이어야 합니다.' }, 400);
    }

    const result = await c.env.DB
        .prepare('UPDATE workspace_pages SET ws_public = ? WHERE workspace_id = ? AND slug = ? AND deleted_at IS NULL')
        .bind(raw, workspace.id, slug)
        .run();
    if (!result.meta.changes) return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);

    try {
        await syncWorkspaceMediaVisibility(c.env.DB, workspace.id);
    } catch (e) {
        console.error('workspace media visibility sync failed:', e);
    }
    return c.json({ ok: true, ws_public: raw });
});

// ============================================================
// 리비전 단건 (pages 경로와 prefix 가 다르므로 등록 위치 무관하지만 가독성을 위해 여기)
// ============================================================

/**
 * GET /api/ws/:wslug/revisions/:id — 리비전 본문 조회.
 * 리비전의 문서가 이 워크스페이스 소속이 아니면 404 (워크스페이스 간 열거 차단).
 * 멤버(canRead) 또는 해당 문서가 ws_public=1 인 경우 허용(목록/본문 경로와 일관).
 */
wsPages.get('/api/ws/:wslug/revisions/:id', async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    const revisionId = Number(c.req.param('id'));
    if (!Number.isInteger(revisionId) || revisionId <= 0) {
        return c.json({ error: '리비전을 찾을 수 없습니다.' }, 404);
    }

    const rev = await c.env.DB
        .prepare(
            `SELECT r.id, r.page_id, r.page_version, r.content, r.r2_key, r.summary, r.author_id, r.created_at,
                    r.deleted_at, r.purged_at,
                    p.workspace_id, p.slug, p.ws_public, p.deleted_at AS page_deleted_at
             FROM workspace_revisions r
             JOIN workspace_pages p ON p.id = r.page_id
             WHERE r.id = ?`
        )
        .bind(revisionId)
        .first<{
            id: number; page_id: number; page_version: number | null; content: string; r2_key: string | null;
            summary: string | null; author_id: number | null; created_at: number;
            deleted_at: number | null; purged_at: number | null;
            workspace_id: number; slug: string; ws_public: number; page_deleted_at: number | null;
        }>();
    // 다른 워크스페이스의 리비전은 존재하지 않는 것처럼 404 (id 열거로 격리 우회 차단)
    if (!rev || rev.workspace_id !== workspace.id) {
        return c.json({ error: '리비전을 찾을 수 없습니다.' }, 404);
    }
    const publicReadable = rev.ws_public === 1 && rev.page_deleted_at === null;
    if (!access.canRead && !publicReadable) return denyRead(c);
    if (rev.deleted_at) return c.json({ error: '리비전을 찾을 수 없습니다.' }, 404);

    const origin = new URL(c.req.url).origin;
    const content = rev.purged_at
        ? ''
        : await getRevisionContent(c.env.MEDIA, { content: rev.content, r2_key: rev.r2_key }, origin);
    return c.json(safeJSON({
        id: rev.id,
        page_id: rev.page_id,
        slug: rev.slug,
        page_version: rev.page_version,
        summary: rev.summary,
        author_id: rev.author_id,
        created_at: rev.created_at,
        purged: !!rev.purged_at,
        content,
    }));
});

/**
 * GET /api/ws/:wslug/revisions/:id/diff — 지정 리비전과 직전 리비전 본문 비교용 반환.
 * 전역 위키 /w/:slug/revisions/:id/diff 와 동일한 응답 형태로, 리비전 페이지의 비교(diff) 모달이
 * 같은 클라이언트 경로를 공유한다. 멤버(canRead) 또는 해당 문서가 ws_public=1 인 경우 허용.
 */
wsPages.get('/api/ws/:wslug/revisions/:id/diff', async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    const revisionId = Number(c.req.param('id'));
    if (!Number.isInteger(revisionId) || revisionId <= 0) {
        return c.json({ error: '리비전을 찾을 수 없습니다.' }, 404);
    }

    const rev = await c.env.DB
        .prepare(
            `SELECT r.id, r.page_id, r.page_version, r.content, r.r2_key, r.deleted_at, r.purged_at,
                    p.workspace_id, p.ws_public, p.deleted_at AS page_deleted_at
             FROM workspace_revisions r
             JOIN workspace_pages p ON p.id = r.page_id
             WHERE r.id = ?`
        )
        .bind(revisionId)
        .first<{
            id: number; page_id: number; page_version: number | null; content: string; r2_key: string | null;
            deleted_at: number | null; purged_at: number | null;
            workspace_id: number; ws_public: number; page_deleted_at: number | null;
        }>();
    if (!rev || rev.workspace_id !== workspace.id || rev.deleted_at) {
        return c.json({ error: '리비전을 찾을 수 없습니다.' }, 404);
    }
    const publicReadable = rev.ws_public === 1 && rev.page_deleted_at === null;
    if (!access.canRead && !publicReadable) return denyRead(c);

    // 직전 리비전(같은 문서, 더 낮은 id 중 최신).
    const prevRev = await c.env.DB
        .prepare(
            `SELECT id, page_version, content, r2_key, purged_at FROM workspace_revisions
             WHERE page_id = ? AND id < ? AND deleted_at IS NULL
             ORDER BY id DESC LIMIT 1`
        )
        .bind(rev.page_id, revisionId)
        .first<{ id: number; page_version: number | null; content: string; r2_key: string | null; purged_at: number | null }>();

    const origin = new URL(c.req.url).origin;
    const fetchContent = (r: { content: string; r2_key: string | null; purged_at: number | null }) =>
        r.purged_at ? Promise.resolve('') : getRevisionContent(c.env.MEDIA, { content: r.content, r2_key: r.r2_key }, origin);
    const [newContent, oldContent] = await Promise.all([
        fetchContent(rev),
        prevRev ? fetchContent(prevRev) : Promise.resolve(''),
    ]);

    return c.json(safeJSON({
        old_content: oldContent,
        new_content: newContent,
        old_revision_id: prevRev?.id ?? null,
        new_revision_id: rev.id,
        old_page_version: prevRev?.page_version ?? null,
        new_page_version: rev.page_version ?? null,
    }));
});

// ============================================================
// 문서 단건 CRUD (일반 :slug{.+} — suffix 경로들 뒤에 등록)
// ============================================================

/**
 * GET /api/ws/:wslug/pages/:slug{.+} — 문서 단건 조회 (본문 포함).
 * 멤버(canRead) 또는 ws_public=1 문서(읽기 전용). redirect_to 는 자동 추적하지 않고
 * 필드로 반환한다 — 클라이언트가 따라간다.
 */
wsPages.get('/api/ws/:wslug/pages/:slug{.+}', async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    const slug = normalizeSlug(c.req.param('slug'));
    const page = await findPage(c.env.DB, workspace.id, slug);
    if (!page) return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    if (!access.canRead && page.ws_public !== 1) return denyRead(c);

    return c.json(safeJSON({
        ...page,
        can_write: access.canWrite,
        can_read: access.canRead,
    }));
});

/**
 * PUT /api/ws/:wslug/pages/:slug{.+} — 문서 생성/수정 (canWrite).
 * body: { content (필수), summary?, title?, redirect_to?, doc_type?, ws_public?, expected_version? }
 * title/redirect_to/doc_type/ws_public 은 본문에 키가 없으면 기존 값 유지.
 * expected_version 불일치 / 슬러그 경합 → 409 (code: CONCURRENT_MODIFICATION / SLUG_TAKEN).
 */
wsPages.put('/api/ws/:wslug/pages/:slug{.+}', requireAuth, async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canWrite) return c.json({ error: '이 워크스페이스의 문서를 수정할 권한이 없습니다.' }, 403);
    const user = c.get('user')!;

    const validated = validatePageSlug(c.req.param('slug'));
    if (!validated.ok) return c.json({ error: validated.error }, 400);
    const slug = validated.slug;

    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
        return c.json({ error: '유효하지 않은 요청입니다.' }, 400);
    }
    if (typeof body.content !== 'string') {
        return c.json({ error: 'content 가 필요합니다.' }, 400);
    }
    const content = body.content.replace(/\r\n?/g, '\n');

    // summary: 사용자 입력분(body.summary)과 자동요약분(body.auto_summary)을 분리 전송받아
    // "<사용자입력> / <자동요약>" 으로 병합한다(위키 직접 저장과 동일 규칙). 사용자 입력분만 255자
    // 제한, 자동요약분은 제한 없음, 최종 병합 결과는 SUMMARY_DB_MAX 에서 잘라낸다.
    const summary = mergeEditSummary(
        typeof body.summary === 'string' ? body.summary : null,
        typeof body.auto_summary === 'string' ? body.auto_summary : null,
    );

    // title: 키 부재 = 유지(undefined). null/빈 문자열 = 제거. 문자열 = 설정.
    let title: string | null | undefined = undefined;
    if ('title' in body) {
        if (body.title !== null && body.title !== undefined && typeof body.title !== 'string') {
            return c.json({ error: 'title 형식이 올바르지 않습니다.' }, 400);
        }
        title = normalizeTitleInput(body.title);
        if (title !== null) {
            if (TITLE_FORBIDDEN_CHARS.test(title)) {
                return c.json({ error: '제목에 사용할 수 없는 문자가 포함되어 있습니다.' }, 400);
            }
            if (title.length > TITLE_MAX_LENGTH) {
                return c.json({ error: `제목은 최대 ${TITLE_MAX_LENGTH}자까지 입력할 수 있습니다.` }, 400);
            }
        }
    }

    // redirect_to: 키 부재 = 유지. null/빈 문자열 = 제거. 문자열 = 워크스페이스 내 슬러그로 검증.
    let redirectTo: string | null | undefined = undefined;
    if ('redirect_to' in body) {
        if (body.redirect_to === null || body.redirect_to === '') {
            redirectTo = null;
        } else {
            const v = validatePageSlug(body.redirect_to);
            if (!v.ok) return c.json({ error: `redirect_to: ${v.error}` }, 400);
            redirectTo = v.slug;
        }
    }

    // doc_type: 키 부재 = 유지. null/빈 문자열 = NULL(일반 문서). 그 외 ALLOWED_DOC_TYPES 화이트리스트.
    let docType: string | null | undefined = undefined;
    if ('doc_type' in body) {
        if (body.doc_type === null || body.doc_type === '') {
            docType = null;
        } else if (typeof body.doc_type === 'string' && ALLOWED_DOC_TYPES.has(body.doc_type)) {
            docType = body.doc_type;
        } else {
            return c.json({ error: '유효하지 않은 doc_type 입니다.' }, 400);
        }
    }

    // ws_public: 키 부재 = 유지. 0/1 만 허용.
    let wsPublic: number | undefined = undefined;
    if ('ws_public' in body) {
        if (body.ws_public !== 0 && body.ws_public !== 1) {
            return c.json({ error: 'ws_public 은 0 또는 1 이어야 합니다.' }, 400);
        }
        wsPublic = body.ws_public;
    }

    // expected_version: 낙관적 락 base 버전 (수정 시 권장)
    let expectedVersion: number | undefined = undefined;
    if ('expected_version' in body && body.expected_version !== null && body.expected_version !== undefined) {
        const n = Number(body.expected_version);
        if (!Number.isInteger(n) || n < 1) {
            return c.json({ error: 'expected_version 형식이 올바르지 않습니다.' }, 400);
        }
        expectedVersion = n;
    }

    try {
        const result = await saveWorkspacePage(c, {
            workspaceId: workspace.id,
            slug,
            content,
            authorId: user.id,
            summary,
            title,
            redirectTo,
            docType,
            wsPublic,
            expectedVersion,
        });
        return c.json(safeJSON({
            ok: true,
            page_id: result.page_id,
            revision_id: result.revision_id,
            version: result.new_version,
            created: result.created,
        }));
    } catch (e: any) {
        if (e?.code === 'CONCURRENT_MODIFICATION') {
            return c.json({ error: '다른 사용자가 동시에 문서를 수정했습니다. 최신 내용을 확인 후 다시 저장해주세요.', code: 'CONCURRENT_MODIFICATION' }, 409);
        }
        if (e?.code === 'SLUG_TAKEN') {
            return c.json({ error: '이미 사용 중인 제목입니다. (삭제된 문서가 점유 중일 수 있습니다)', code: 'SLUG_TAKEN' }, 409);
        }
        throw e;
    }
});

/**
 * DELETE /api/ws/:wslug/pages/:slug{.+} — 소프트 삭제 (canWrite).
 * 리비전/링크 행은 보존한다(복구 여지). 삭제 후 미디어 공개 연동을 재계산한다.
 */
wsPages.delete('/api/ws/:wslug/pages/:slug{.+}', requireAuth, async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canWrite) return c.json({ error: '이 워크스페이스의 문서를 수정할 권한이 없습니다.' }, 403);

    const slug = normalizeSlug(c.req.param('slug'));
    const result = await c.env.DB
        .prepare('UPDATE workspace_pages SET deleted_at = unixepoch() WHERE workspace_id = ? AND slug = ? AND deleted_at IS NULL')
        .bind(workspace.id, slug)
        .run();
    if (!result.meta.changes) return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);

    try {
        await syncWorkspaceMediaVisibility(c.env.DB, workspace.id);
    } catch (e) {
        console.error('workspace media visibility sync failed:', e);
    }
    return c.json({ ok: true });
});

export default wsPages;
