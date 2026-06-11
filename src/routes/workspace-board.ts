import { Hono, type Context } from 'hono';
import type { Env } from '../types';
import type { RBAC } from '../utils/role';
import { requireAuth } from '../middleware/session';
import { safeJSON } from '../utils/json';
import { isWorkspacesEnabled } from '../utils/workspace';
import { getWorkspaceAccessBySlug } from '../utils/workspaceAcl';
import type { WorkspaceAccess } from '../utils/workspaceAcl';
import type { Workspace } from '../shared/models';

/**
 * 워크스페이스 게시판 API (/api/ws/:wslug/board...).
 *
 * 설계 제약 (워크스페이스 격리):
 *   - 워크스페이스당 단일 게시판. workspace_board_posts / workspace_board_comments 만 사용.
 *   - 리비전 없음(게시글 수정은 in-place). 전역 데이터·링크 인덱싱·캐시 무효화 없음.
 *   - 모든 응답은 `private, no-store` — 비공개 데이터.
 *
 * 권한:
 *   - 읽기(목록/상세): canRead
 *   - 작성(게시글/댓글): canWrite
 *   - 수정/삭제(게시글/댓글): 작성자 본인 또는 canManage
 */

const wsBoard = new Hono<Env>();

const BOARD_PAGE_SIZE = 20;
const TITLE_MAX_LENGTH = 200;
const CONTENT_MAX_LENGTH = 50000;
const COMMENT_MAX_LENGTH = 5000;

// 기능 토글 가드 + 공통 응답 캐시 정책.
wsBoard.use('/api/ws/:wslug/board', async (c, next) => {
    if (!isWorkspacesEnabled(c.env)) {
        return c.json({ error: '워크스페이스 기능이 비활성화되어 있습니다.' }, 404);
    }
    await next();
    c.header('Cache-Control', 'private, no-store');
});
wsBoard.use('/api/ws/:wslug/board/*', async (c, next) => {
    if (!isWorkspacesEnabled(c.env)) {
        return c.json({ error: '워크스페이스 기능이 비활성화되어 있습니다.' }, 404);
    }
    await next();
    c.header('Cache-Control', 'private, no-store');
});

/** :wslug 로 워크스페이스 + 접근 권한 해석. workspace null 이면 호출 측에서 404. */
async function resolveWs(c: Context<Env>): Promise<{ workspace: Workspace | null; access: WorkspaceAccess }> {
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    return getWorkspaceAccessBySlug(c.env.DB, c.req.param('wslug') || '', user, rbac);
}

/** 읽기 거부 응답 — 게스트는 401, 로그인 사용자는 403. */
function denyRead(c: Context<Env>) {
    if (!c.get('user')) return c.json({ error: '로그인이 필요합니다.' }, 401);
    return c.json({ error: '이 워크스페이스를 열람할 권한이 없습니다.' }, 403);
}

/** 워크스페이스 소속의 비삭제 게시글 조회. 다른 워크스페이스 글이면 null(격리). */
async function findPost(db: D1Database, workspaceId: number, postId: number) {
    return db
        .prepare(
            'SELECT * FROM workspace_board_posts WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL'
        )
        .bind(postId, workspaceId)
        .first<{ id: number; workspace_id: number; title: string; content: string; author_id: number | null; created_at: number; updated_at: number }>();
}

// ============================================================
// 게시글 목록
// ============================================================

/**
 * GET /api/ws/:wslug/board/posts — 게시글 목록 (canRead, 페이지네이션).
 * ?page=N (1-based). 응답: { posts, total, page, pageSize }
 * 각 글에 comment_count(비삭제 댓글 수) 서브쿼리 + author 의 id/name JOIN.
 */
wsBoard.get('/api/ws/:wslug/board/posts', requireAuth, async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canRead) return denyRead(c);

    let page = Number(c.req.query('page')) || 1;
    if (!Number.isInteger(page) || page < 1) page = 1;
    const offset = (page - 1) * BOARD_PAGE_SIZE;

    const countRow = await c.env.DB
        .prepare('SELECT COUNT(*) AS n FROM workspace_board_posts WHERE workspace_id = ? AND deleted_at IS NULL')
        .bind(workspace.id)
        .first<{ n: number }>();
    const total = Number(countRow?.n || 0);

    const rows = await c.env.DB
        .prepare(
            `SELECT p.id, p.title, p.author_id, p.created_at, p.updated_at,
                    u.name AS author_name,
                    (SELECT COUNT(*) FROM workspace_board_comments cm
                       WHERE cm.post_id = p.id AND cm.deleted_at IS NULL) AS comment_count
             FROM workspace_board_posts p
             LEFT JOIN users u ON u.id = p.author_id
             WHERE p.workspace_id = ? AND p.deleted_at IS NULL
             ORDER BY p.created_at DESC, p.id DESC
             LIMIT ? OFFSET ?`
        )
        .bind(workspace.id, BOARD_PAGE_SIZE, offset)
        .all();

    return c.json(safeJSON({
        posts: rows.results || [],
        total,
        page,
        pageSize: BOARD_PAGE_SIZE,
        can_write: access.canWrite,
    }));
});

/**
 * POST /api/ws/:wslug/board/posts — 게시글 작성 (canWrite).
 * body: { title: string, content?: string }
 */
wsBoard.post('/api/ws/:wslug/board/posts', requireAuth, async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canWrite) return c.json({ error: '이 워크스페이스에 글을 쓸 권한이 없습니다.' }, 403);
    const user = c.get('user')!;

    const body = await c.req.json().catch(() => null) as { title?: unknown; content?: unknown } | null;
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title) return c.json({ error: '제목을 입력해주세요.' }, 400);
    if (title.length > TITLE_MAX_LENGTH) {
        return c.json({ error: `제목은 최대 ${TITLE_MAX_LENGTH}자까지 입력할 수 있습니다.` }, 400);
    }
    if ('content' in (body || {}) && body!.content != null && typeof body!.content !== 'string') {
        return c.json({ error: 'content 형식이 올바르지 않습니다.' }, 400);
    }
    const content = typeof body?.content === 'string' ? body.content.replace(/\r\n?/g, '\n') : '';
    if (content.length > CONTENT_MAX_LENGTH) {
        return c.json({ error: `본문은 최대 ${CONTENT_MAX_LENGTH}자까지 입력할 수 있습니다.` }, 400);
    }

    const res = await c.env.DB
        .prepare('INSERT INTO workspace_board_posts (workspace_id, title, content, author_id) VALUES (?, ?, ?, ?)')
        .bind(workspace.id, title, content, user.id)
        .run();
    return c.json(safeJSON({ ok: true, id: res.meta.last_row_id }));
});

// ============================================================
// 게시글 단건 + 댓글
// ============================================================

/**
 * GET /api/ws/:wslug/board/posts/:id — 게시글 상세 + 댓글 목록 (canRead).
 * 응답: { post, comments }. comments 에 각 댓글 author 의 id/name JOIN.
 */
wsBoard.get('/api/ws/:wslug/board/posts/:id', requireAuth, async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canRead) return denyRead(c);

    const postId = Number(c.req.param('id'));
    if (!Number.isInteger(postId) || postId <= 0) return c.json({ error: '게시글을 찾을 수 없습니다.' }, 404);

    const post = await c.env.DB
        .prepare(
            `SELECT p.id, p.title, p.content, p.author_id, p.created_at, p.updated_at, u.name AS author_name
             FROM workspace_board_posts p
             LEFT JOIN users u ON u.id = p.author_id
             WHERE p.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL`
        )
        .bind(postId, workspace.id)
        .first();
    if (!post) return c.json({ error: '게시글을 찾을 수 없습니다.' }, 404);

    const comments = await c.env.DB
        .prepare(
            `SELECT cm.id, cm.post_id, cm.author_id, cm.content, cm.created_at, u.name AS author_name
             FROM workspace_board_comments cm
             JOIN workspace_board_posts p ON p.id = cm.post_id
             LEFT JOIN users u ON u.id = cm.author_id
             WHERE cm.post_id = ? AND p.workspace_id = ? AND cm.deleted_at IS NULL
             ORDER BY cm.created_at ASC, cm.id ASC`
        )
        .bind(postId, workspace.id)
        .all();

    return c.json(safeJSON({
        post,
        comments: comments.results || [],
        can_write: access.canWrite,
        can_manage: access.canManage,
    }));
});

/**
 * PATCH /api/ws/:wslug/board/posts/:id — 게시글 수정 (작성자 본인 또는 canManage).
 * body: { title?, content? }
 */
wsBoard.patch('/api/ws/:wslug/board/posts/:id', requireAuth, async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canRead) return denyRead(c);
    const user = c.get('user')!;

    const postId = Number(c.req.param('id'));
    if (!Number.isInteger(postId) || postId <= 0) return c.json({ error: '게시글을 찾을 수 없습니다.' }, 404);

    const post = await findPost(c.env.DB, workspace.id, postId);
    if (!post) return c.json({ error: '게시글을 찾을 수 없습니다.' }, 404);
    if (post.author_id !== user.id && !access.canManage) {
        return c.json({ error: '이 게시글을 수정할 권한이 없습니다.' }, 403);
    }

    const body = await c.req.json().catch(() => null) as { title?: unknown; content?: unknown } | null;
    if (!body || typeof body !== 'object') return c.json({ error: '유효하지 않은 요청입니다.' }, 400);

    const sets: string[] = [];
    const binds: unknown[] = [];

    if ('title' in body) {
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title) return c.json({ error: '제목을 입력해주세요.' }, 400);
        if (title.length > TITLE_MAX_LENGTH) {
            return c.json({ error: `제목은 최대 ${TITLE_MAX_LENGTH}자까지 입력할 수 있습니다.` }, 400);
        }
        sets.push('title = ?');
        binds.push(title);
    }
    if ('content' in body) {
        if (typeof body.content !== 'string') {
            return c.json({ error: 'content 형식이 올바르지 않습니다.' }, 400);
        }
        const content = body.content.replace(/\r\n?/g, '\n');
        if (content.length > CONTENT_MAX_LENGTH) {
            return c.json({ error: `본문은 최대 ${CONTENT_MAX_LENGTH}자까지 입력할 수 있습니다.` }, 400);
        }
        sets.push('content = ?');
        binds.push(content);
    }
    if (!sets.length) return c.json({ error: '변경할 내용이 없습니다.' }, 400);

    sets.push('updated_at = unixepoch()');
    binds.push(postId, workspace.id);

    const patchRes = await c.env.DB
        .prepare(`UPDATE workspace_board_posts SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`)
        .bind(...binds)
        .run();
    if (!patchRes.meta.changes) return c.json({ error: '게시글을 찾을 수 없습니다.' }, 404);
    return c.json({ ok: true });
});

/**
 * DELETE /api/ws/:wslug/board/posts/:id — 게시글 소프트 삭제 (작성자 본인 또는 canManage).
 * 댓글은 보존(소프트 삭제만, 본문이 안 보이므로 노출 안 됨).
 */
wsBoard.delete('/api/ws/:wslug/board/posts/:id', requireAuth, async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canRead) return denyRead(c);
    const user = c.get('user')!;

    const postId = Number(c.req.param('id'));
    if (!Number.isInteger(postId) || postId <= 0) return c.json({ error: '게시글을 찾을 수 없습니다.' }, 404);

    const post = await findPost(c.env.DB, workspace.id, postId);
    if (!post) return c.json({ error: '게시글을 찾을 수 없습니다.' }, 404);
    if (post.author_id !== user.id && !access.canManage) {
        return c.json({ error: '이 게시글을 삭제할 권한이 없습니다.' }, 403);
    }

    await c.env.DB
        .prepare('UPDATE workspace_board_posts SET deleted_at = unixepoch() WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL')
        .bind(postId, workspace.id)
        .run();
    return c.json({ ok: true });
});

// ============================================================
// 댓글
// ============================================================

/**
 * POST /api/ws/:wslug/board/posts/:id/comments — 댓글 작성 (canWrite).
 * body: { content: string }
 */
wsBoard.post('/api/ws/:wslug/board/posts/:id/comments', requireAuth, async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canWrite) return c.json({ error: '댓글을 쓸 권한이 없습니다.' }, 403);
    const user = c.get('user')!;

    const postId = Number(c.req.param('id'));
    if (!Number.isInteger(postId) || postId <= 0) return c.json({ error: '게시글을 찾을 수 없습니다.' }, 404);

    const post = await findPost(c.env.DB, workspace.id, postId);
    if (!post) return c.json({ error: '게시글을 찾을 수 없습니다.' }, 404);

    const body = await c.req.json().catch(() => null) as { content?: unknown } | null;
    const content = typeof body?.content === 'string' ? body.content.replace(/\r\n?/g, '\n').trim() : '';
    if (!content) return c.json({ error: '댓글 내용을 입력해주세요.' }, 400);
    if (content.length > COMMENT_MAX_LENGTH) {
        return c.json({ error: `댓글은 최대 ${COMMENT_MAX_LENGTH}자까지 입력할 수 있습니다.` }, 400);
    }

    const res = await c.env.DB
        .prepare('INSERT INTO workspace_board_comments (post_id, author_id, content) VALUES (?, ?, ?)')
        .bind(postId, user.id, content)
        .run();
    return c.json(safeJSON({ ok: true, id: res.meta.last_row_id }));
});

/**
 * DELETE /api/ws/:wslug/board/posts/:id/comments/:cid — 댓글 소프트 삭제
 * (작성자 본인 또는 canManage).
 */
wsBoard.delete('/api/ws/:wslug/board/posts/:id/comments/:cid', requireAuth, async (c) => {
    const { workspace, access } = await resolveWs(c);
    if (!workspace) return c.json({ error: '워크스페이스를 찾을 수 없습니다.' }, 404);
    if (!access.canRead) return denyRead(c);
    const user = c.get('user')!;

    const postId = Number(c.req.param('id'));
    const commentId = Number(c.req.param('cid'));
    if (!Number.isInteger(postId) || postId <= 0) return c.json({ error: '게시글을 찾을 수 없습니다.' }, 404);
    if (!Number.isInteger(commentId) || commentId <= 0) return c.json({ error: '댓글을 찾을 수 없습니다.' }, 404);

    // 댓글이 이 워크스페이스의 해당 게시글 소속인지 JOIN 으로 확인(격리).
    const comment = await c.env.DB
        .prepare(
            `SELECT cm.id, cm.author_id
             FROM workspace_board_comments cm
             JOIN workspace_board_posts p ON p.id = cm.post_id
             WHERE cm.id = ? AND cm.post_id = ? AND p.workspace_id = ? AND cm.deleted_at IS NULL`
        )
        .bind(commentId, postId, workspace.id)
        .first<{ id: number; author_id: number | null }>();
    if (!comment) return c.json({ error: '댓글을 찾을 수 없습니다.' }, 404);
    if (comment.author_id !== user.id && !access.canManage) {
        return c.json({ error: '이 댓글을 삭제할 권한이 없습니다.' }, 403);
    }

    const delRes = await c.env.DB
        .prepare('UPDATE workspace_board_comments SET deleted_at = unixepoch() WHERE id = ? AND deleted_at IS NULL')
        .bind(commentId)
        .run();
    if (!delRes.meta.changes) return c.json({ error: '댓글을 찾을 수 없습니다.' }, 404);
    return c.json({ ok: true });
});

export default wsBoard;
