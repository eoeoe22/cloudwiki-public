// 관리자 전용 MCP 서버 (/api/admin-mcp)
//
// 공개 MCP (/api/mcp) 와 별개로 운영되며, OAuth 2.1 으로 발급된 액세스 토큰을
// Authorization: Bearer 헤더로 받는다. 토큰의 user_id 가 admin:access 권한을
// 가진 사용자여야만 도구가 호출된다.
//
// 노출 도구:
//   - 읽기: 공개 MCP 의 기초 읽기 도구 (batch / 블로그 도구 제외)
//   - 편집: create_or_update_page, delete_page, restore_page, move_page
//
// 편집 도구는 wiki.ts 의 PUT /w/:slug, DELETE /w/:slug, POST /w/:slug/restore,
// POST /w/:slug/move 와 동일한 동작을 수행한다 — 동일한 헬퍼(buildLinkAndCategoryStatements,
// invalidatePageCache 등)를 재사용해 FTS 트리거, 역링크 인덱스, 캐시 무효화가 일관되게
// 적용되도록 한다.
import { Hono, Context } from 'hono';
import { cors } from 'hono/cors';
import type { Env, User } from '../types';
import { RBAC } from '../utils/role';
import { uploadRevisionToR2, getRevisionContent } from '../utils/r2';
import { isR2OnlyNamespace, normalizeSlug } from '../utils/slug';
import { sha256Hex, OAUTH_SCOPE_ADMIN_MCP } from '../utils/oauth';
import { isSuperAdmin } from '../utils/auth';
import {
    MCP_TOOL_DEFS_ADMIN_READ,
    buildInformationIntro,
    dispatchReadTool,
    type McpToolDef,
    type ToolResult,
} from '../utils/mcpDispatch';
import {
    SLUG_FORBIDDEN_CHARS,
    computePageMetrics,
    buildLinkAndCategoryStatements,
    rewriteContentForRename,
    invalidatePageCache,
    refreshRecentChangesCache,
    invalidateBacklinkCaches,
} from './wiki';

const adminMcp = new Hono<Env>();

// ────────────────────────────────────────────────────────────────
// 어드민 편집 도구 정의
// ────────────────────────────────────────────────────────────────

const ADMIN_EDIT_TOOL_DEFS: McpToolDef[] = [
    {
        name: 'create_or_update_page',
        description: '위키 문서를 생성하거나 기존 문서를 덮어씁니다. content 는 마크다운/위키 문법 기반의 전체 본문입니다. summary 는 편집 요약(255자 이하). category 는 쉼표로 구분된 카테고리 목록(특수문자 불가). is_locked 가 true 면 관리자 전용으로 잠그고, redirect_to 를 지정하면 다른 슬러그로의 리다이렉트로 만듭니다. 부분 수정이 아닌 전체 본문 교체이므로, 일부만 바꾸려면 read_document 로 먼저 전체 본문을 받아 수정한 뒤 그대로 전달해야 합니다.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: '문서 슬러그(=제목)' },
                content: { type: 'string', description: '문서 전체 본문 (마크다운/위키 문법)' },
                summary: { type: 'string', description: '편집 요약 (선택, 최대 255자)' },
                category: { type: 'string', description: '쉼표로 구분된 카테고리 (선택, 한글/영숫자/공백/쉼표만 허용)' },
                is_locked: { type: 'boolean', description: '관리자 전용 잠금 여부 (선택)' },
                redirect_to: { type: 'string', description: '리다이렉트 대상 슬러그 (선택)' }
            },
            required: ['title', 'content']
        }
    },
    {
        name: 'delete_page',
        description: '위키 문서를 삭제합니다. 기본은 소프트 삭제(deleted_at 설정)로, restore_page 로 복원 가능합니다. hard=true 일 때만 D1/R2 에서 영구 삭제하며, 이 경우 최고 관리자(super_admin) 권한이 필요합니다.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: '삭제할 문서 슬러그' },
                hard: { type: 'boolean', description: 'true 시 영구 삭제 (super_admin 만 가능)' }
            },
            required: ['title']
        }
    },
    {
        name: 'restore_page',
        description: '소프트 삭제된 문서를 복원합니다 (deleted_at 해제).',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: '복원할 문서 슬러그' }
            },
            required: ['title']
        }
    },
    {
        name: 'move_page',
        description: '문서 슬러그를 변경합니다 (이름 이동). 기본적으로 이 문서가 가진 위키링크/틀 참조는 새 슬러그 기준으로 재작성되며, 새 리비전이 추가됩니다. update_backlinks=true 면 이 문서를 가리키던 다른 문서들의 본문도 일괄 재작성됩니다 (각 문서마다 새 리비전 생성).',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: '현재 문서 슬러그' },
                new_title: { type: 'string', description: '새 문서 슬러그' },
                update_backlinks: { type: 'boolean', description: '역링크 문서 본문도 함께 재작성할지 (선택, 기본 false)' }
            },
            required: ['title', 'new_title']
        }
    }
];

const ADMIN_TOOL_DEFS: McpToolDef[] = [...MCP_TOOL_DEFS_ADMIN_READ, ...ADMIN_EDIT_TOOL_DEFS];

// ────────────────────────────────────────────────────────────────
// CORS / 인증 미들웨어
// ────────────────────────────────────────────────────────────────

adminMcp.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'MCP-Protocol-Version'],
    maxAge: 86400,
}));

function unauthorized(c: Context<Env>, description: string) {
    const origin = new URL(c.req.url).origin;
    const resourceMetadata = `${origin}/.well-known/oauth-protected-resource`;
    c.header('WWW-Authenticate', `Bearer realm="admin-mcp", error="invalid_token", error_description="${description}", resource_metadata="${resourceMetadata}"`);
    return c.json({ error: 'invalid_token', error_description: description }, 401);
}

interface AuthContext {
    user: User;
    tokenId: number;
    scope: string;
}

async function authenticateBearer(c: Context<Env>): Promise<AuthContext | Response> {
    const authHeader = c.req.header('Authorization') || '';
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
        return unauthorized(c, 'Bearer token required');
    }
    const token = authHeader.slice(7).trim();
    if (!token) return unauthorized(c, 'Empty bearer token');

    const tokenHash = await sha256Hex(token);
    const row = await c.env.DB
        .prepare(
            `SELECT t.id, t.user_id, t.scope, t.access_expires_at, t.revoked_at,
                    u.id AS uid, u.provider, u.uid AS provider_uid, u.email, u.name, u.picture, u.role, u.banned_until, u.last_namechange, u.created_at
             FROM oauth_tokens t
             JOIN users u ON t.user_id = u.id
             WHERE t.access_token_hash = ?`
        )
        .bind(tokenHash)
        .first<{
            id: number; user_id: number; scope: string | null; access_expires_at: number; revoked_at: number | null;
            uid: number; provider: string; provider_uid: string; email: string; name: string; picture: string | null;
            role: string; banned_until: number | null; last_namechange: number | null; created_at: number;
        }>();

    if (!row) return unauthorized(c, 'Token not found');
    const now = Math.floor(Date.now() / 1000);
    if (row.revoked_at) return unauthorized(c, 'Token revoked');
    if (row.access_expires_at < now) return unauthorized(c, 'Token expired');

    const scope = row.scope || OAUTH_SCOPE_ADMIN_MCP;
    if (!scope.split(/\s+/).includes(OAUTH_SCOPE_ADMIN_MCP)) {
        return unauthorized(c, `scope=${OAUTH_SCOPE_ADMIN_MCP} required`);
    }

    // 권한 재검증: super_admin 보정 + ban 처리
    let effectiveRole = row.role;
    if (isSuperAdmin(row.email, c.env)) {
        effectiveRole = 'super_admin';
    } else if (row.banned_until && row.banned_until > now) {
        effectiveRole = 'banned';
    } else if (row.role === 'banned') {
        effectiveRole = 'user';
    }

    const rbac = c.get('rbac') as RBAC;
    if (!rbac.can(effectiveRole, 'admin:access')) {
        return unauthorized(c, 'admin access required');
    }

    const user: User = {
        id: row.uid,
        provider: row.provider,
        uid: row.provider_uid,
        email: row.email,
        name: row.name,
        picture: row.picture,
        role: effectiveRole as User['role'],
        banned_until: row.banned_until,
        last_namechange: row.last_namechange,
        created_at: row.created_at,
    };
    c.set('user', user);

    // 토큰 사용 시각 갱신 (best-effort)
    c.executionCtx.waitUntil(
        c.env.DB.prepare('UPDATE oauth_tokens SET last_used_at = unixepoch() WHERE id = ?')
            .bind(row.id).run().catch(() => {})
    );

    return { user, tokenId: row.id, scope };
}

// ────────────────────────────────────────────────────────────────
// 편집 도구 디스패처
// ────────────────────────────────────────────────────────────────

function asTextResult(text: string, isError = false): ToolResult {
    return { content: [{ type: 'text', text }], isError };
}

async function dispatchAdminEditTool(c: Context<Env>, user: User, toolName: string, args: any): Promise<ToolResult | null> {
    const db = c.env.DB;
    const rbac = c.get('rbac') as RBAC;

    if (toolName === 'create_or_update_page') {
        // 위임 admin 역할이 wiki:edit 없이 admin:access 만 가진 케이스에서도
        // wiki PUT /w/:slug 와 동일하게 wiki:edit 권한을 요구한다 (기본 역할에서는 admin
        // 이 user 를 상속하므로 자동으로 통과되지만, ROLE_PERMISSIONS_JSON 으로 권한이
        // 분리된 환경에서 우회를 막는다).
        if (!rbac.can(user.role, 'wiki:edit')) {
            return asTextResult('Error: wiki:edit 권한이 필요합니다.', true);
        }
        const slug = String(args.title || '').trim();
        if (!slug) return asTextResult('Error: title 이 필요합니다.', true);
        if (SLUG_FORBIDDEN_CHARS.test(slug)) return asTextResult('Error: 슬러그에 사용할 수 없는 특수문자가 포함되어 있습니다.', true);
        if (slug.startsWith('이미지:')) return asTextResult('Error: "이미지:" 네임스페이스는 admin-mcp 로 편집할 수 없습니다 (이미지 문서 전용).', true);
        if (typeof args.content !== 'string') return asTextResult('Error: content 는 문자열이어야 합니다.', true);
        if (args.summary && typeof args.summary === 'string' && args.summary.length > 255) {
            return asTextResult('Error: summary 는 최대 255자입니다.', true);
        }
        if (args.category && typeof args.category === 'string') {
            if (!/^[가-힣a-zA-Z0-9\s,]+$/.test(args.category)) {
                return asTextResult('Error: category 에는 특수문자를 사용할 수 없습니다.', true);
            }
        }

        const content = args.content.replace(/\r\n?/g, '\n');
        const category = (args.category && typeof args.category === 'string') ? args.category : null;
        const redirectTo = (args.redirect_to && typeof args.redirect_to === 'string') ? args.redirect_to : null;
        const summary = (typeof args.summary === 'string') ? args.summary : null;
        const requestedLock = typeof args.is_locked === 'boolean' ? (args.is_locked ? 1 : 0) : null;

        const existing = await db
            .prepare('SELECT id, version, is_locked FROM pages WHERE slug = ? AND deleted_at IS NULL')
            .bind(slug)
            .first<{ id: number; version: number; is_locked: number }>();

        const enabledExt = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
        const isR2Only = isR2OnlyNamespace(slug, enabledExt);
        const metrics = computePageMetrics(content);

        let pageId: number;
        let newVersion: number;
        let revisionId: number;
        let finalIsLocked: number;
        let createdNew = false;

        if (existing) {
            // 잠긴 문서는 wiki:lock 권한자(=admin 이상)만 편집 가능. admin:access 만으로
            // 통과시키면 토론 매니저 같은 위임 역할이 잠금을 우회할 수 있다.
            if (existing.is_locked === 1 && !rbac.can(user.role, 'wiki:lock')) {
                return asTextResult('Error: 잠긴 문서는 wiki:lock 권한이 있어야 편집할 수 있습니다.', true);
            }
            pageId = existing.id;
            newVersion = existing.version + 1;
            finalIsLocked = requestedLock !== null
                ? (rbac.can(user.role, 'wiki:lock') ? requestedLock : existing.is_locked)
                : existing.is_locked;

            let r2Key: string;
            try {
                r2Key = await uploadRevisionToR2(c.env.MEDIA, pageId, newVersion, content);
            } catch (e: any) {
                return asTextResult(`Error: 리비전 R2 업로드 실패 (${e?.message || e})`, true);
            }
            try {
                const revResult = await db
                    .prepare('INSERT INTO revisions (page_id, page_version, content, r2_key, summary, author_id) VALUES (?, ?, ?, ?, ?, ?)')
                    .bind(pageId, newVersion, '', r2Key, summary, user.id)
                    .run();
                revisionId = revResult.meta.last_row_id;
            } catch (e: any) {
                await c.env.MEDIA.delete(r2Key).catch(() => {});
                return asTextResult(`Error: 리비전 D1 저장 실패 (${e?.message || e})`, true);
            }

            const contentToStore = isR2Only ? '' : content;
            await db
                .prepare(
                    `UPDATE pages
                     SET content = ?, category = ?, is_locked = ?, redirect_to = ?, last_revision_id = ?,
                         version = ?, rows = ?, characters = ?, updated_at = unixepoch()
                     WHERE id = ?`
                )
                .bind(contentToStore, category, finalIsLocked, redirectTo, revisionId, newVersion, metrics.rows, metrics.characters, pageId)
                .run();
        } else {
            createdNew = true;
            finalIsLocked = requestedLock !== null && rbac.can(user.role, 'wiki:lock') ? requestedLock : 0;
            const contentToStore = isR2Only ? '' : content;
            const pageResult = await db
                .prepare('INSERT INTO pages (slug, content, category, is_locked, redirect_to, rows, characters) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .bind(slug, contentToStore, category, finalIsLocked, redirectTo, metrics.rows, metrics.characters)
                .run();
            pageId = pageResult.meta.last_row_id;
            newVersion = 1;

            let firstR2Key: string;
            try {
                firstR2Key = await uploadRevisionToR2(c.env.MEDIA, pageId, 1, content);
            } catch (e: any) {
                await db.prepare('DELETE FROM pages WHERE id = ?').bind(pageId).run().catch(() => {});
                return asTextResult(`Error: 신규 리비전 R2 업로드 실패 (${e?.message || e})`, true);
            }
            try {
                const revResult = await db
                    .prepare('INSERT INTO revisions (page_id, page_version, content, r2_key, summary, author_id) VALUES (?, ?, ?, ?, ?, ?)')
                    .bind(pageId, 1, '', firstR2Key, summary, user.id)
                    .run();
                revisionId = revResult.meta.last_row_id;
            } catch (e: any) {
                await c.env.MEDIA.delete(firstR2Key).catch(() => {});
                await db.prepare('DELETE FROM pages WHERE id = ?').bind(pageId).run().catch(() => {});
                return asTextResult(`Error: 신규 리비전 D1 저장 실패 (${e?.message || e})`, true);
            }
            await db.prepare('UPDATE pages SET last_revision_id = ? WHERE id = ?').bind(revisionId, pageId).run();
        }

        const linkCatStmts = buildLinkAndCategoryStatements(db, pageId, content, category);
        c.executionCtx.waitUntil(db.batch(linkCatStmts).catch(e => console.error('admin-mcp link/cat batch failed:', e)));
        c.executionCtx.waitUntil(Promise.allSettled([
            invalidatePageCache(c, slug),
            refreshRecentChangesCache(c),
            invalidateBacklinkCaches(c, slug, db),
        ]));

        const result = {
            slug,
            version: newVersion,
            revision_id: revisionId,
            created: createdNew,
            is_locked: finalIsLocked === 1,
            rows: metrics.rows,
            characters: metrics.characters,
        };
        return asTextResult(JSON.stringify(result, null, 2));
    }

    if (toolName === 'delete_page') {
        const slug = String(args.title || '').trim();
        if (!slug) return asTextResult('Error: title 이 필요합니다.', true);
        const hard = args.hard === true;

        const page = await db
            .prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL')
            .bind(slug)
            .first<{ id: number }>();
        if (!page) return asTextResult('Error: 문서를 찾을 수 없거나 이미 삭제된 상태입니다.', true);

        if (hard) {
            if (!rbac.can(user.role, '*')) return asTextResult('Error: 영구 삭제는 super_admin 만 가능합니다.', true);
            const revisionKeys = await db.prepare('SELECT r2_key FROM revisions WHERE page_id = ? AND r2_key IS NOT NULL').bind(page.id).all<{ r2_key: string }>();
            if (revisionKeys.results.length > 0) {
                await Promise.all(revisionKeys.results.map(r => c.env.MEDIA.delete(r.r2_key)));
            }
            await db.batch([
                db.prepare('DELETE FROM page_links WHERE source_page_id = ? AND blog = 0').bind(page.id),
                db.prepare('DELETE FROM page_categories WHERE page_id = ?').bind(page.id),
                db.prepare('DELETE FROM revisions WHERE page_id = ?').bind(page.id),
                db.prepare('DELETE FROM pages WHERE id = ?').bind(page.id),
            ]);
            c.executionCtx.waitUntil(
                db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                    .bind('hard_delete', `[admin-mcp] 문서 영구 삭제: ${slug}`, user.id)
                    .run().catch(() => {})
            );
        } else {
            if (!rbac.can(user.role, 'wiki:delete')) return asTextResult('Error: 문서 삭제 권한이 없습니다.', true);
            await db.prepare('UPDATE pages SET deleted_at = unixepoch() WHERE id = ?').bind(page.id).run();
            c.executionCtx.waitUntil(
                db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                    .bind('soft_delete', `[admin-mcp] 문서 삭제: ${slug}`, user.id)
                    .run().catch(() => {})
            );
        }
        c.executionCtx.waitUntil(Promise.allSettled([
            invalidatePageCache(c, slug),
            refreshRecentChangesCache(c),
            invalidateBacklinkCaches(c, slug, db),
        ]));
        return asTextResult(JSON.stringify({ slug, deleted: true, hard }, null, 2));
    }

    if (toolName === 'restore_page') {
        const slug = String(args.title || '').trim();
        if (!slug) return asTextResult('Error: title 이 필요합니다.', true);
        if (!rbac.can(user.role, 'wiki:delete')) return asTextResult('Error: 복원 권한이 없습니다.', true);

        const page = await db.prepare('SELECT id, deleted_at FROM pages WHERE slug = ?').bind(slug).first<{ id: number; deleted_at: number | null }>();
        if (!page) return asTextResult('Error: 문서를 찾을 수 없습니다.', true);
        if (!page.deleted_at) return asTextResult('Error: 문서가 삭제 상태가 아닙니다.', true);

        await db.prepare('UPDATE pages SET deleted_at = NULL WHERE id = ?').bind(page.id).run();
        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind('restore', `[admin-mcp] 문서 복원: ${slug}`, user.id)
                .run().catch(() => {})
        );
        c.executionCtx.waitUntil(Promise.allSettled([
            invalidatePageCache(c, slug),
            refreshRecentChangesCache(c),
            invalidateBacklinkCaches(c, slug, db),
        ]));
        return asTextResult(JSON.stringify({ slug, restored: true }, null, 2));
    }

    if (toolName === 'move_page') {
        const oldSlug = String(args.title || '').trim();
        const newSlug = String(args.new_title || '').trim();
        if (!oldSlug || !newSlug) return asTextResult('Error: title 과 new_title 이 모두 필요합니다.', true);
        if (oldSlug === newSlug) return asTextResult('Error: 동일한 슬러그로는 이동할 수 없습니다.', true);
        if (SLUG_FORBIDDEN_CHARS.test(newSlug)) return asTextResult('Error: 새 슬러그에 사용할 수 없는 특수문자가 포함되어 있습니다.', true);
        if (oldSlug.startsWith('이미지:') || newSlug.startsWith('이미지:')) {
            return asTextResult('Error: "이미지:" 네임스페이스는 이동 대상이 될 수 없습니다.', true);
        }

        // 네임스페이스 이동 제한: 콜론이 포함된 문서(틀:, template:, 카테고리: 등)는
        // 동일 네임스페이스 내에서만 이동할 수 있다. wiki.ts 의 POST /w/:slug/move 와 동일 정책.
        const isNamespaceDocument = oldSlug.includes(':');
        const currentNamespace = isNamespaceDocument ? oldSlug.split(':')[0] : '';
        const newNamespace = newSlug.includes(':') ? newSlug.split(':')[0] : '';
        if (isNamespaceDocument && currentNamespace !== newNamespace) {
            return asTextResult('Error: 네임스페이스가 있는 문서는 다른 네임스페이스로 이동할 수 없습니다.', true);
        }

        const updateBacklinks = args.update_backlinks === true;

        const page = await db
            .prepare('SELECT id, version, content, category, last_revision_id, is_locked FROM pages WHERE slug = ? AND deleted_at IS NULL')
            .bind(oldSlug)
            .first<{ id: number; version: number; content: string; category: string | null; last_revision_id: number | null; is_locked: number }>();
        if (!page) return asTextResult('Error: 문서를 찾을 수 없거나 삭제된 상태입니다.', true);

        // 잠긴 문서 이동은 wiki:lock 권한 필요. wiki.ts 의 POST /w/:slug/move 와 동일.
        if (page.is_locked === 1 && !rbac.can(user.role, 'wiki:lock')) {
            return asTextResult('Error: 잠긴 문서는 wiki:lock 권한이 있어야 이동할 수 있습니다.', true);
        }

        const conflict = await db.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL').bind(newSlug).first();
        if (conflict) return asTextResult('Error: 새 슬러그가 이미 존재합니다.', true);

        const enabledExt = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
        const isR2Only = isR2OnlyNamespace(oldSlug, enabledExt);
        let currentContent = page.content;
        if (isR2Only && (!currentContent || currentContent === '') && page.last_revision_id) {
            const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(page.last_revision_id).first<{ content: string; r2_key: string | null }>();
            if (lastRev) currentContent = await getRevisionContent(c.env.MEDIA, lastRev, new URL(c.req.url).origin);
        }

        const rewritten = rewriteContentForRename(currentContent, oldSlug, newSlug);
        const contentChanged = rewritten !== currentContent;
        // 본문 재작성이 필요할 때만 새 리비전을 만들고 version 을 올린다. 자기 자신을 참조하지
        // 않는 문서는 슬러그만 바뀌므로 version/last_revision_id 가 그대로 유지되며,
        // 응답에서도 보고된 version 이 실제 저장 상태와 일치해야 optimistic locking 이 깨지지 않는다.
        let newVersion = page.version;
        let newRevisionId = page.last_revision_id;

        if (contentChanged) {
            newVersion = page.version + 1;
            const r2Key = await uploadRevisionToR2(c.env.MEDIA, page.id, newVersion, rewritten);
            const revResult = await db
                .prepare('INSERT INTO revisions (page_id, page_version, content, r2_key, summary, author_id) VALUES (?, ?, ?, ?, ?, ?)')
                .bind(page.id, newVersion, '', r2Key, `[move] ${oldSlug} → ${newSlug}`, user.id)
                .run();
            newRevisionId = revResult.meta.last_row_id;
            const newIsR2Only = isR2OnlyNamespace(newSlug, enabledExt);
            const contentToStore = newIsR2Only ? '' : rewritten;
            const metrics = computePageMetrics(rewritten);
            await db
                .prepare('UPDATE pages SET slug = ?, content = ?, last_revision_id = ?, version = ?, rows = ?, characters = ?, updated_at = unixepoch() WHERE id = ?')
                .bind(newSlug, contentToStore, newRevisionId, newVersion, metrics.rows, metrics.characters, page.id)
                .run();
            const linkCatStmts = buildLinkAndCategoryStatements(db, page.id, rewritten, page.category);
            c.executionCtx.waitUntil(db.batch(linkCatStmts).catch(e => console.error('admin-mcp move link/cat batch failed:', e)));
        } else {
            await db.prepare('UPDATE pages SET slug = ?, updated_at = unixepoch() WHERE id = ?').bind(newSlug, page.id).run();
        }

        const updatedSlugs: string[] = [];
        const skippedLockedSlugs: string[] = [];
        if (updateBacklinks) {
            const { results: backlinks } = await db
                .prepare(`
                    SELECT DISTINCT p.id, p.slug, p.version, p.content, p.category, p.last_revision_id, p.is_locked
                    FROM page_links pl
                    JOIN pages p ON pl.source_page_id = p.id
                    WHERE pl.blog = 0 AND pl.target_slug = ? AND p.deleted_at IS NULL AND p.id != ?
                `)
                .bind(oldSlug, page.id)
                .all<{ id: number; slug: string; version: number; content: string; category: string | null; last_revision_id: number | null; is_locked: number }>();

            const canEditLocked = rbac.can(user.role, 'wiki:lock');
            for (const bl of backlinks) {
                // 잠긴 역링크 문서는 wiki:lock 보유자만 재작성 가능. wiki.ts 의
                // rewriteBacklinksForRename 과 동일한 정책으로, 잠금 우회를 통한 간접 편집을 차단.
                if (bl.is_locked === 1 && !canEditLocked) {
                    skippedLockedSlugs.push(bl.slug);
                    continue;
                }
                const blIsR2 = isR2OnlyNamespace(bl.slug, enabledExt);
                let blContent = bl.content;
                if (blIsR2 && (!blContent || blContent === '') && bl.last_revision_id) {
                    const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(bl.last_revision_id).first<{ content: string; r2_key: string | null }>();
                    if (lastRev) blContent = await getRevisionContent(c.env.MEDIA, lastRev, new URL(c.req.url).origin);
                }
                const blRewritten = rewriteContentForRename(blContent, oldSlug, newSlug);
                if (blRewritten === blContent) continue;
                const blNewVer = bl.version + 1;
                const blR2Key = await uploadRevisionToR2(c.env.MEDIA, bl.id, blNewVer, blRewritten);
                const blRev = await db
                    .prepare('INSERT INTO revisions (page_id, page_version, content, r2_key, summary, author_id) VALUES (?, ?, ?, ?, ?, ?)')
                    .bind(bl.id, blNewVer, '', blR2Key, `[move-backlink] ${oldSlug} → ${newSlug}`, user.id)
                    .run();
                const blMetrics = computePageMetrics(blRewritten);
                const blContentToStore = blIsR2 ? '' : blRewritten;
                await db
                    .prepare('UPDATE pages SET content = ?, last_revision_id = ?, version = ?, rows = ?, characters = ?, updated_at = unixepoch() WHERE id = ?')
                    .bind(blContentToStore, blRev.meta.last_row_id, blNewVer, blMetrics.rows, blMetrics.characters, bl.id)
                    .run();
                const stmts = buildLinkAndCategoryStatements(db, bl.id, blRewritten, bl.category);
                c.executionCtx.waitUntil(db.batch(stmts).catch(e => console.error('admin-mcp move backlink batch failed:', e)));
                updatedSlugs.push(bl.slug);
            }
        }

        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind('move', `[admin-mcp] 문서 이동: ${oldSlug} → ${newSlug}${updateBacklinks ? ` (역링크 ${updatedSlugs.length}개 갱신)` : ''}`, user.id)
                .run().catch(() => {})
        );
        c.executionCtx.waitUntil(Promise.allSettled([
            invalidatePageCache(c, oldSlug),
            invalidatePageCache(c, newSlug),
            refreshRecentChangesCache(c),
            invalidateBacklinkCaches(c, oldSlug, db),
            invalidateBacklinkCaches(c, newSlug, db),
            ...updatedSlugs.map(s => invalidatePageCache(c, s)),
        ]));

        return asTextResult(JSON.stringify({
            old_slug: oldSlug,
            new_slug: newSlug,
            content_rewritten: contentChanged,
            new_version: newVersion,
            updated_backlinks: updatedSlugs.length,
            updated_backlink_slugs: updatedSlugs,
            skipped_locked_backlinks: skippedLockedSlugs,
        }, null, 2));
    }

    return null;
}

// ────────────────────────────────────────────────────────────────
// JSON-RPC 핸들러
// ────────────────────────────────────────────────────────────────

async function handleAdminJsonRpc(c: Context<Env>, body: any, user: User) {
    const { jsonrpc, method, params, id } = body;
    if (jsonrpc !== '2.0') return { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: id || null };

    if (method === 'initialize') {
        return {
            jsonrpc: '2.0', id,
            result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {}, logging: {} },
                serverInfo: { name: 'cloudwiki-admin-mcp', version: '1.0.0' }
            }
        };
    }
    if (method === 'notifications/initialized') return null;

    if (method === 'tools/list') {
        const intro = buildInformationIntro(c, MCP_TOOL_DEFS_ADMIN_READ);
        const editIntro = `\n\n## 관리자 편집 도구\n\n다음 도구로 위키 문서를 직접 편집할 수 있습니다 (현재 인증된 관리자: ${user.name}).\n${ADMIN_EDIT_TOOL_DEFS.map(t => `- ${t.name}`).join('\n')}\n\n편집 도구는 모든 변경을 새 리비전으로 기록하며 admin_log 에 [admin-mcp] 접두로 남깁니다.`;
        const toolNames = ADMIN_TOOL_DEFS.map(t => t.name).join(', ');
        const informationDescription = `${intro}${editIntro}\n\n사용 가능한 MCP 도구: ${toolNames}.`;
        return {
            jsonrpc: '2.0', id,
            result: {
                tools: [
                    {
                        name: 'information',
                        description: informationDescription,
                        inputSchema: { type: 'object', properties: {}, required: [] }
                    },
                    ...ADMIN_TOOL_DEFS,
                ]
            }
        };
    }

    if (method === 'tools/call') {
        const toolName = params?.name;
        const args = params?.arguments || {};
        try {
            const readResult = await dispatchReadTool(c, toolName, args, MCP_TOOL_DEFS_ADMIN_READ);
            if (readResult) return { jsonrpc: '2.0', id, result: readResult };

            const editResult = await dispatchAdminEditTool(c, user, toolName, args);
            if (editResult) return { jsonrpc: '2.0', id, result: editResult };

            return { jsonrpc: '2.0', error: { code: -32601, message: `Tool not found: ${toolName}` }, id };
        } catch (e: any) {
            return { jsonrpc: '2.0', error: { code: -32000, message: e?.message || String(e) }, id };
        }
    }

    return { jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id };
}

// ────────────────────────────────────────────────────────────────
// 라우트
// ────────────────────────────────────────────────────────────────

adminMcp.get('/', (c) => {
    // 인증 없는 GET 은 메타데이터 디스커버리 힌트만 반환 (RFC 9728)
    const auth = c.req.header('Authorization') || '';
    if (!auth) {
        const origin = new URL(c.req.url).origin;
        c.header('WWW-Authenticate', `Bearer realm="admin-mcp", resource_metadata="${origin}/.well-known/oauth-protected-resource"`);
        return c.json({
            error: 'unauthorized',
            error_description: 'Bearer token required. Initiate OAuth 2.1 authorization at /.well-known/oauth-authorization-server.',
        }, 401);
    }
    return c.json({ mcp: true, version: '1.0.0', transport: 'http', endpoint: new URL(c.req.url).origin + '/api/admin-mcp' });
});

adminMcp.post('/', async (c) => {
    const auth = await authenticateBearer(c);
    if (auth instanceof Response) return auth;
    const body = await c.req.json();
    const response = await handleAdminJsonRpc(c, body, auth.user);
    if (response === null) return c.body(null, 204);
    return c.json(response);
});

export default adminMcp;
