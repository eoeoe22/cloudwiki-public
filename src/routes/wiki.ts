import { Hono, type Context } from 'hono';
import type { Env, Page, Revision, User } from '../types';
import { requireAuth, requireAdmin, requirePermission } from '../middleware/session';
import { normalizeSlug, isR2OnlyNamespace, isMapNamespace } from '../utils/slug';
import { buildMapDocument, buildGroupTree, MAP_CACHE_MAX_AGE_SECONDS } from '../utils/mapDocument';
import { safeJSON } from '../utils/json';
import {
    invalidatePageCache,
    invalidateBacklinkCaches,
    refreshRecentChangesCache,
    invalidateRevisionContentCache,
} from '../utils/cacheInvalidation';
import { ROLE_CASE_SQL, enrichRoles, RBAC } from '../utils/role';
import { fetchMediaTags } from '../utils/mediaTags';
import { createNotifications } from '../utils/notification';
import { loadAllPalettes, loadPalettesForPage } from '../utils/palettes';
import {
    cleanupUnauthorizedSubscriptions,
    cleanupOrphanDiscussionMutes,
} from '../utils/pageAccessCleanup';

const wiki = new Hono<Env>();

/** 슬러그에 사용할 수 없는 금지 문자 패턴 ({}, [] 는 트랜스클루전/위키링크 문법과 충돌) */
export const SLUG_FORBIDDEN_CHARS = /[\[\]{}()#%|<>^\x00-\x1F\x7F]/;

/** 대체 title 입력 금지 문자 — 제어문자만 차단. 슬러그와 달리 [], {}, # 등 특수문자 허용. */
export const TITLE_FORBIDDEN_CHARS = /[\x00-\x1F\x7F]/;
export const TITLE_MAX_LENGTH = 100;

/**
 * 문서별 layout_mode 화이트리스트. 빈 문자열/null 은 NULL('자동' = 전역 LAYOUT_MODE).
 * PUT /w/:slug 본문 저장 경로에서 사용. (admin PATCH /flags 의 동명 상수와 동일 의미.)
 */
export const ALLOWED_LAYOUT_MODES = new Set<string>(['presentation']);

/**
 * 클라이언트가 보낸 title 입력을 정규화한다.
 * - undefined / null / 빈 문자열(공백 포함) → null
 * - 그 외 → trim 된 문자열
 */
export function normalizeTitleInput(raw: unknown): string | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return trimmed;
}

/**
 * candidate(슬러그 또는 title 후보) 가 다른 페이지의 slug 또는 title 과 충돌하는지 검사.
 * 호출 경로는 항상 slug 만 매칭하지만, slug↔title / title↔title 동명이인이 존재하면
 * 표시·검색 결과에서 혼란을 일으키므로 사전에 차단한다.
 *
 * 소프트 삭제 페이지도 포함해 검사한다 — `slug UNIQUE` 와 `idx_pages_title_unique`
 * 부분 인덱스 모두 deleted_at 을 조건으로 두지 않기 때문이다. precheck 에서 빠뜨리면
 * 이후 INSERT/UPDATE 가 SQLITE_CONSTRAINT 로 실패하면서 R2 리비전 등 부분 적용이 남는다.
 *
 * @param excludePageId 자기 자신의 page id (UPDATE 흐름) — null 이면 모든 행을 검사 (INSERT).
 */
export async function findConflictingPage(
    db: D1Database,
    candidate: string,
    excludePageId: number | null,
): Promise<{ slug: string; matchedColumn: 'slug' | 'title'; isDeleted: boolean } | null> {
    const row = await db
        .prepare(
            `SELECT slug,
                    CASE WHEN slug = ?1 THEN 'slug' ELSE 'title' END AS matched,
                    deleted_at
             FROM pages
             WHERE (slug = ?1 OR title = ?1)
               AND (?2 IS NULL OR id != ?2)
             LIMIT 1`,
        )
        .bind(candidate, excludePageId)
        .first<{ slug: string; matched: 'slug' | 'title'; deleted_at: number | null }>();
    return row ? { slug: row.slug, matchedColumn: row.matched, isDeleted: !!row.deleted_at } : null;
}

/**
 * 본문 길이/줄 수 메트릭. characters 는 UTF-16 code unit 수,
 * rows 는 개행으로 분리되는 라인 수(빈 본문 0).
 */
export function computePageMetrics(content: string): { rows: number; characters: number } {
    const characters = content.length;
    if (characters === 0) return { rows: 0, characters: 0 };
    let rows = 1;
    for (let i = 0; i < characters; i++) {
        if (content.charCodeAt(i) === 10) rows++;
    }
    return { rows, characters };
}

/**
 * R2-only 네임스페이스 문서는 본문이 외부 익스텐션 페이로드(예: REW 주파수 응답)이며
 * 사용자 가독 텍스트가 아니므로 줄 수/글자 수 통계가 의미가 없다. 이 경우
 * { rows: null, characters: null } 을 반환해 pages.rows / pages.characters 컬럼을
 * NULL 로 저장하도록 한다. 일반 문서는 그대로 computePageMetrics 결과를 돌려준다.
 */
export function computePageMetricsTracked(
    content: string,
    isR2Only: boolean
): { rows: number | null; characters: number | null } {
    if (isR2Only) return { rows: null, characters: null };
    return computePageMetrics(content);
}

/**
 * 문서 content에서 링크를 파싱하여 { target_slug, link_type } 배열을 반환
 */
function extractLinks(content: string): { target_slug: string; link_type: string }[] {
    const links: { target_slug: string; link_type: string }[] = [];
    const seen = new Set<string>();

    // 코드블럭 내부 제외를 위해 코드블럭을 먼저 제거
    const cleaned = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '');

    // 1) [[위키링크]] / [[위키링크|표시명]] / [[위키링크#섹션]]
    const wikiLinkRegex = /\[\[([^\]]+)\]\]/g;
    for (const m of cleaned.matchAll(wikiLinkRegex)) {
        const raw = m[1].trim();
        // '|' 앞부분만 slug로 사용 (표시명 무시)
        // '#' 앞부분만 slug로 사용 (섹션 앵커 무시) — page_links는 문서간 참조 그래프이므로
        // 페이지 내부 섹션 정보를 인덱스에 저장하지 않음
        const slug = raw.split('|')[0].split('#')[0].trim();
        if (!slug) continue; // '[[#로컬앵커]]'처럼 대상 문서가 없는 링크는 제외
        const key = `wikilink:${slug}`;
        if (!seen.has(key)) {
            seen.add(key);
            links.push({ target_slug: slug, link_type: 'wikilink' });
        }
    }

    // 2) {{틀 트랜스클루전}} 또는 {{익스텐션:문서}}
    const templateRegex = /\{\{([^}]+?)\}\}/g;
    for (const m of cleaned.matchAll(templateRegex)) {
        let slug = m[1].trim();
        // '#' 앞부분만 slug로 사용 — wikilink와 동일한 정규화 정책.
        // 슬러그 자체는 '#'을 포함할 수 없으므로(이동 API 입력검증 참고) 항상 안전하게 제거.
        slug = slug.split('#')[0].trim();
        if (!slug) continue;
        // 익스텐션 패턴: 첫 번째 ':' 앞이 익스텐션 이름 (틀/template/템플릿 접두사가 아닌 경우)
        const colonIdx = slug.indexOf(':');
        if (colonIdx > 0 && !slug.startsWith('틀:') && !slug.startsWith('template:') && !slug.startsWith('템플릿:')) {
            // 익스텐션 링크 (예: freq:AirPods_Pro_2)
            const key = `extension:${slug}`;
            if (!seen.has(key)) {
                seen.add(key);
                links.push({ target_slug: slug, link_type: 'extension' });
            }
        } else {
            if (!slug.startsWith('틀:') && !slug.startsWith('template:') && !slug.startsWith('템플릿:')) {
                slug = '틀:' + slug;
            }
            const key = `template:${slug}`;
            if (!seen.has(key)) {
                seen.add(key);
                links.push({ target_slug: slug, link_type: 'template' });
            }
        }
    }

    // 3) 이미지 참조: images/로 시작하는 R2 키를 파싱
    // 마크다운 ![alt](/media/images/...) 또는 HTML <img src="...images/..."> 등
    // 업로더(media.ts FILENAME_FORBIDDEN)는 한글/영숫자뿐 아니라 일본어/한자/악센트
    // 라틴 등 임의 유니코드를 허용하므로, 화이트리스트 대신 URL/마크다운/HTML 경계를
    // 끊는 문자만 블랙리스트로 제외한다. 비탐욕(`+?`)으로 첫 `.확장자`에서 종료.
    const imageRegex = /images\/[^\s\[\]()<>"'\\?#|^]+?\.\w+/g;
    for (const m of cleaned.matchAll(imageRegex)) {
        const r2Key = m[0].trim();
        const key = `image:${r2Key}`;
        if (!seen.has(key)) {
            seen.add(key);
            links.push({ target_slug: r2Key, link_type: 'image' });
        }
    }

    // 4) {palette:이름} 토큰 — 본문이 참조하는 커스텀 팔레트를 page_links 에 인덱싱.
    // 문서 열람 시 loadPalettesForPage 가 이 인덱스를 참고해 실제로 사용된 팔레트만 SSR 한다.
    // 트랜스클루전된 틀의 본문이 참조하는 팔레트는 이 함수가 보지 못하지만 (틀 본문은 다른
    // 문서에 속하므로 그 문서의 page_links 에 자체 인덱싱돼 있음), loadPalettesForPage 가
    // page_links(link_type='template') 를 통해 합집합으로 끌어온다.
    const paletteRegex = /\{palette:\s*([A-Za-z0-9_-]+)\s*\}/g;
    for (const m of cleaned.matchAll(paletteRegex)) {
        const name = m[1];
        const key = `palette:${name}`;
        if (!seen.has(key)) {
            seen.add(key);
            links.push({ target_slug: name, link_type: 'palette' });
        }
    }

    return links;
}

/**
 * 편집된 문서의 알림을 받아야 할 유저 ID 목록을 모은다.
 *
 *  - 직접 주시자: page_watches.page_id = 편집 대상 문서
 *  - 상위 문서 subtree 주시자: 편집 대상의 slug 가 'A/B/C' 라면 'A', 'A/B' 같은
 *    상위 슬러그를 scope='subtree' 로 주시하는 유저 (편집 대상 본인은 'this' 만으로도
 *    위 직접 주시자에 포함되므로 여기서는 prefix 만 고려)
 *  - 카테고리 주시자: 편집 본문에서 파싱된 카테고리 목록 ↔ category_watches
 *    page_categories 테이블은 fire-and-forget 갱신이라 fan-out 시점에 race 가
 *    발생할 수 있으므로 호출자가 새 카테고리 목록을 직접 넘기는 방식을 쓴다.
 *
 * 편집 작성자 본인은 항상 제외된다.
 *
 * 비공개 문서(isPrivate=true) 의 경우 'wiki:private' 권한이 없는 구독자는
 * 알림 대상에서 제외된다. 권한 없는 유저가 카테고리/상위 슬러그를 추측해
 * 비공개 문서 슬러그·요약을 알림으로 받는 정보 노출을 방지한다.
 */
async function collectPageEditWatchers(
    db: D1Database,
    pageId: number,
    slug: string,
    editorId: number,
    categories: string[],
    isPrivate: boolean,
    env: Env['Bindings'],
    rbac: RBAC,
): Promise<number[]> {
    const parents: string[] = [];
    const parts = slug.split('/');
    // 'A/B/C' → ['A', 'A/B'] (자기 자신 'A/B/C' 는 제외 — 직접 주시자 쿼리가 담당)
    for (let i = 1; i < parts.length; i++) {
        parents.push(parts.slice(0, i).join('/'));
    }

    const userIds = new Set<number>();
    try {
        const direct = await db
            .prepare('SELECT user_id FROM page_watches WHERE page_id = ? AND user_id != ?')
            .bind(pageId, editorId)
            .all<{ user_id: number }>();
        for (const r of direct.results) userIds.add(r.user_id);

        if (parents.length > 0) {
            const placeholders = parents.map(() => '?').join(',');
            const subtree = await db
                .prepare(
                    `SELECT DISTINCT pw.user_id
                     FROM page_watches pw
                     JOIN pages p ON pw.page_id = p.id
                     WHERE pw.scope = 'subtree'
                       AND pw.user_id != ?
                       AND p.slug IN (${placeholders})`,
                )
                .bind(editorId, ...parents)
                .all<{ user_id: number }>();
            for (const r of subtree.results) userIds.add(r.user_id);
        }

        if (categories.length > 0) {
            const placeholders = categories.map(() => '?').join(',');
            const cat = await db
                .prepare(
                    `SELECT DISTINCT user_id
                     FROM category_watches
                     WHERE user_id != ? AND category IN (${placeholders})`,
                )
                .bind(editorId, ...categories)
                .all<{ user_id: number }>();
            for (const r of cat.results) userIds.add(r.user_id);
        }
    } catch (e) {
        console.error('collectPageEditWatchers failed:', e);
    }

    if (userIds.size === 0) return [];

    // 비공개 문서: wiki:private 권한이 없는 구독자는 제외한다.
    if (!isPrivate) return Array.from(userIds);

    try {
        const ids = Array.from(userIds);
        const placeholders = ids.map(() => '?').join(',');
        const rows = await db
            .prepare(
                `SELECT u.id, u.email, ${ROLE_CASE_SQL} AS role
                 FROM users u
                 WHERE u.id IN (${placeholders})`,
            )
            .bind(...ids)
            .all<{ id: number; email: string; role: string }>();
        // super_admin 이메일 보정 (DB role 값과 별도로 운영자가 .env 로 격상한 경우)
        enrichRoles(rows.results as any[], 'role', 'email', env);
        return rows.results
            .filter(r => rbac.can(r.role, 'wiki:private'))
            .map(r => r.id);
    } catch (e) {
        console.error('collectPageEditWatchers private filter failed:', e);
        // 안전 기본값: 권한 확인이 실패하면 비공개 문서 알림은 발송하지 않는다.
        return [];
    }
}

/**
 * settings.pending_changes_enabled (사람 편집 보류 리비전 전역 토글) 조회.
 * 컬럼/행이 없으면(=마이그레이션 미적용) 0(비활성)으로 안전 폴백한다.
 */
export async function getPendingChangesEnabled(db: D1Database): Promise<boolean> {
    try {
        const row = await db
            .prepare('SELECT pending_changes_enabled AS v FROM settings WHERE id = 1')
            .first<{ v: number | null }>();
        return row?.v === 1;
    } catch {
        return false;
    }
}

/**
 * 신뢰되지 않은 사용자의 편집을 pending_edits 검토 대기로 보류한다.
 * - revisions/pages 를 건드리지 않으므로 공개 화면은 마지막 승인본을 계속 노출한다.
 * - (author_id, slug) UNIQUE 로 작성자×슬러그당 1건만 유지 — 재제출 시 UPSERT 로 교체.
 * - 검토자(관리자)에게 인앱+푸시 알림, admin Discord 채널 웹훅을 best-effort 발송.
 *   비공개 문서는 본문/제목 노출 방지를 위해 웹훅을 생략한다.
 * 반환: 생성/갱신된 pending_edit.id (UI 응답용).
 */
async function holdPendingEdit(
    c: Context<Env>,
    user: User,
    input: {
        pageId: number | null;
        slug: string;
        action: 'create' | 'update';
        baseRevisionId: number | null;
        baseVersion: number;
        content: string;
        category: string | null;
        redirectTo: string | null;
        title: string | null;
        hasTitleChange: boolean;
        summary: string | null;
        isPrivate: boolean;       // 검토자 접근 게이팅용 (현재 또는 결과가 비공개면 true)
        editAcl: string | null;   // applyEditAcl=true 일 때 승인 시 적용할 직렬화 edit_acl (update 전용)
        applyEditAcl: boolean;    // 이 편집이 edit_acl 을 바꾸려는 경우만 true (direct-save 의 willUpdateEditAcl 과 동일)
        layoutMode: string | null; // applyLayout=true 일 때 승인 시 적용할 layout_mode
        applyLayout: boolean;     // 편집이 layout_mode 를 지정한 경우만 true (direct-save 의 hasLayoutInBody 와 동일; create 는 항상 true)
        categoryAclChoices: string | null; // create 보류본의 원본 category_acl_choices(JSON 문자열). 승인 시 재생용. update 는 불필요(null).
    },
): Promise<number> {
    const db = c.env.DB;
    // (author_id, slug) UNIQUE 충돌 시 최신 내용으로 교체 (UPSERT).
    const row = await db
        .prepare(
            `INSERT INTO pending_edits
                (page_id, slug, action, author_id, base_revision_id, base_version,
                 content, category, redirect_to, title, has_title_change, summary,
                 is_private, edit_acl, apply_edit_acl, layout_mode, apply_layout, category_acl_choices, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
             ON CONFLICT(author_id, slug) DO UPDATE SET
                page_id = excluded.page_id,
                action = excluded.action,
                base_revision_id = excluded.base_revision_id,
                base_version = excluded.base_version,
                content = excluded.content,
                category = excluded.category,
                redirect_to = excluded.redirect_to,
                title = excluded.title,
                has_title_change = excluded.has_title_change,
                summary = excluded.summary,
                is_private = excluded.is_private,
                edit_acl = excluded.edit_acl,
                apply_edit_acl = excluded.apply_edit_acl,
                layout_mode = excluded.layout_mode,
                apply_layout = excluded.apply_layout,
                category_acl_choices = excluded.category_acl_choices,
                updated_at = unixepoch()
             RETURNING id`
        )
        .bind(
            input.pageId,
            input.slug,
            input.action,
            user.id,
            input.baseRevisionId,
            input.baseVersion,
            input.content,
            input.category,
            input.redirectTo,
            input.title,
            input.hasTitleChange ? 1 : 0,
            input.summary,
            input.isPrivate ? 1 : 0,
            input.editAcl,
            input.applyEditAcl ? 1 : 0,
            input.layoutMode,
            input.applyLayout ? 1 : 0,
            input.categoryAclChoices,
        )
        .first<{ id: number }>();
    const pendingEditId = row?.id ?? 0;

    // 검토자(관리자) 알림 — 신뢰 사용자(aged/이전 편집자)는 문서 배너로 발견하므로 폭주를 막고자
    // 인앱/푸시는 관리자에 한정한다. 작성자 본인은 제외.
    c.executionCtx.waitUntil((async () => {
        try {
            const { results } = await db
                .prepare(
                    "SELECT id FROM users WHERE (role = 'admin' OR role = 'super_admin') AND id != ?"
                )
                .bind(user.id)
                .all<{ id: number }>();
            const adminIds = (results || []).map(r => r.id);
            if (adminIds.length === 0) return;
            const link = '/mypage#pending-edits';
            const actionLabel = input.action === 'create' ? '새 문서' : '문서 수정';
            const content = `${user.name}님이 "${input.slug}" ${actionLabel} 편집을 검토 대기로 제출했습니다.`;
            await createNotifications(c.env, c.executionCtx, adminIds.map(uid => ({
                userId: uid,
                type: 'pending_edit',
                content,
                link,
                refId: pendingEditId,
                push: {
                    title: '검토 대기 편집',
                    body: content,
                    url: link,
                    tag: `pending_edit:${pendingEditId}`,
                },
            })));
        } catch (e) {
            console.error('holdPendingEdit notify failed:', e);
        }
    })());

    // Discord admin 채널 웹훅 (비공개 문서는 생략).
    if (!input.isPrivate) {
        dispatchDiscord(c.env, c.executionCtx, pendingEditCreated({
            slug: input.slug,
            action: input.action,
            actor: { name: user.name, picture: user.picture },
            summary: input.summary,
            env: c.env,
        }));
    }

    return pendingEditId;
}

/**
 * page_links 및 page_categories 테이블을 갱신하는 D1 배치 문 생성
 */
export function buildLinkAndCategoryStatements(
    db: D1Database,
    pageId: number,
    content: string,
    category: string | null
): D1PreparedStatement[] {
    const stmts: D1PreparedStatement[] = [];

    // page_links 갱신: 기존 삭제 후 재삽입
    // source_type='page' 필터 + blog=0 양쪽 — 마이그레이션 backfill 이전 legacy
    // 블로그 행(source_type='page' DEFAULT + blog=1) 이 pageId 와 같은 id 일 때
    // 잘못 삭제되지 않도록 blog=0 도 함께 매칭한다. (pages.id, blog_posts.id,
    // discussion_comments.id, ticket_comments.id 가 정수 공간을 공유함)
    stmts.push(db.prepare(
        "DELETE FROM page_links WHERE source_page_id = ? AND source_type = 'page' AND blog = 0"
    ).bind(pageId));
    const links = extractLinks(content);
    for (const link of links) {
        stmts.push(
            db.prepare(
                "INSERT INTO page_links (source_page_id, target_slug, link_type, blog, source_type) VALUES (?, ?, ?, 0, 'page')"
            ).bind(pageId, link.target_slug, link.link_type)
        );
    }

    // page_categories 갱신: 기존 삭제 후 재삽입
    stmts.push(db.prepare('DELETE FROM page_categories WHERE page_id = ?').bind(pageId));
    if (category) {
        const cats = category.split(',').map(c => c.trim()).filter(c => c);
        for (const cat of cats) {
            stmts.push(
                db.prepare('INSERT OR IGNORE INTO page_categories (page_id, category) VALUES (?, ?)')
                    .bind(pageId, cat)
            );
        }
    }

    return stmts;
}

/**
 * page_links 만 갱신하는 D1 배치 문 생성 (page_categories 는 건드리지 않음).
 * 리비전 되돌리기처럼 본문은 교체되지만 카테고리(별도 테이블)는 유지해야 하는
 * 경로에서 역링크 추적을 본문과 일치시키기 위해 사용된다.
 */
export function buildLinksOnlyStatements(
    db: D1Database,
    pageId: number,
    content: string
): D1PreparedStatement[] {
    const stmts: D1PreparedStatement[] = [];
    stmts.push(db.prepare(
        "DELETE FROM page_links WHERE source_page_id = ? AND source_type = 'page' AND blog = 0"
    ).bind(pageId));
    const links = extractLinks(content);
    for (const link of links) {
        stmts.push(
            db.prepare(
                "INSERT INTO page_links (source_page_id, target_slug, link_type, blog, source_type) VALUES (?, ?, ?, 0, 'page')"
            ).bind(pageId, link.target_slug, link.link_type)
        );
    }
    return stmts;
}

/**
 * page_categories 만 갱신하는 D1 배치 문 생성 (page_links 는 건드리지 않음).
 * 카테고리 일괄 적용 / 자동 prefix 룰 hook 에서 사용된다.
 */
export function buildCategoryOnlyStatements(
    db: D1Database,
    pageId: number,
    category: string | null
): D1PreparedStatement[] {
    const stmts: D1PreparedStatement[] = [];
    stmts.push(db.prepare('DELETE FROM page_categories WHERE page_id = ?').bind(pageId));
    if (category) {
        const cats = category.split(',').map(c => c.trim()).filter(c => c);
        for (const cat of cats) {
            stmts.push(
                db.prepare('INSERT OR IGNORE INTO page_categories (page_id, category) VALUES (?, ?)')
                    .bind(pageId, cat)
            );
        }
    }
    return stmts;
}

/**
 * 카테고리 문자열(쉼표 구분) 을 trim/공백제거/중복제거 한 배열로 정규화.
 */
export function splitCategoryString(s: string | null | undefined): string[] {
    if (!s) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of s.split(',')) {
        const v = raw.trim();
        if (!v) continue;
        if (seen.has(v)) continue;
        seen.add(v);
        out.push(v);
    }
    return out;
}

/**
 * "카테고리:이름" 슬러그에서 자동 적용할 카테고리명을 반환한다.
 * 카테고리 패턴(한글·영문·숫자·공백만 허용)에 맞지 않으면 null 반환.
 */
function getCategoryDocAutoCategory(slug: string): string | null {
    const prefix = '카테고리:';
    if (!slug.startsWith(prefix)) return null;
    const name = slug.slice(prefix.length).trim();
    if (!name) return null;
    if (!/^[가-힣a-zA-Z0-9\s]+$/.test(name)) return null;
    return name;
}

/**
 * slug 가 룰의 prefix/... 형태에 매칭되면 해당 룰의 카테고리들을 합집합한다.
 * 반환은 새 category 문자열 (쉼표 구분). 기존 카테고리 순서를 보존한 뒤 신규 카테고리만 뒤에 붙인다.
 */
export function mergeCategoriesFromRules(
    slug: string,
    currentCategory: string | null | undefined,
    rules: { prefix: string; categories: string }[]
): string {
    const base = splitCategoryString(currentCategory);
    const seen = new Set<string>(base);
    for (const rule of rules) {
        if (!rule.prefix) continue;
        if (!slug.startsWith(rule.prefix + '/')) continue;
        for (const cat of splitCategoryString(rule.categories)) {
            if (!seen.has(cat)) {
                seen.add(cat);
                base.push(cat);
            }
        }
    }
    return base.join(',');
}

/**
 * 현재 카테고리에서 toRemove 항목들을 차집합으로 제거. 기존 순서를 보존하며,
 * 정규화는 splitCategoryString 정책을 그대로 따른다. 결과가 비면 빈 문자열을
 * 반환하며 호출자가 pages.category 에 NULL 로 매핑한다.
 */
export function subtractCategoryString(
    currentCategory: string | null | undefined,
    toRemove: string | null | undefined
): string {
    const removeSet = new Set(splitCategoryString(toRemove));
    if (removeSet.size === 0) return splitCategoryString(currentCategory).join(',');
    return splitCategoryString(currentCategory)
        .filter(c => !removeSet.has(c))
        .join(',');
}

/**
 * 신규 페이지 생성 시점에 적용되는 prefix 룰 / 카테고리 ACL 머지 로직.
 * `/api/w/:slug PUT(create)` 와 MCP 제출안 승인(create) 가 공유한다.
 *
 * 입력 카테고리·private·edit_acl 에 다음을 차례로 적용해 최종값을 계산한다:
 *   1) `category_prefix_rules` 의 합집합 (slug 가 prefix/ 로 시작하는 모든 룰)
 *   2) "카테고리:이름" 슬러그의 자동 카테고리 prepend
 *   3) `doc_setting_prefix_rules`: is_private/edit_acl(가장 긴 매치) + 카테고리 합집합
 *      - 카테고리 전용 룰(is_private/edit_acl 모두 null)은 longest-match 후보에서 제외
 *      - adminExplicitlySetEditAcl 가 true 면 prefix-rule edit_acl 이 입력값을 덮어쓰지 않는다
 *   4) `category_acl` 템플릿을 effectiveCategory 의 각 카테고리에 머지
 *      - explicitSet(=호출자 입력으로 명시된 카테고리): categoryAclChoices 의 mode 를 따른다
 *        (키 누락이면 적용 안 함; 비관리자의 'overwrite' → 'merge' 다운그레이드)
 *      - prefix-rule 로 자동 추가된 카테고리: 사용자 prompt 불가 → 기본 'merge'
 *
 * 오류는 console.error 후 그 단계만 스킵한다(콜드 스타트 마이그레이션 race 대비).
 */
export async function applyCreatePrefixRulesAndCategoryAcls(
    db: D1Database,
    slug: string,
    input: {
        category: string | null;
        isPrivate: number;
        editAcl: string | null;
        adminExplicitlySetEditAcl: boolean;
        categoryAclChoices: Record<string, unknown> | null;
        isAdmin: boolean;
    }
): Promise<{ effectiveCategory: string | null; finalIsPrivate: number; finalEditAcl: string | null }> {
    let effectiveCategory: string | null = input.category || null;
    let finalIsPrivate = input.isPrivate;
    let finalEditAcl: string | null = input.editAcl;

    // 1. category_prefix_rules 합집합
    try {
        const ruleRows = await db
            .prepare('SELECT prefix, categories FROM category_prefix_rules')
            .all<{ prefix: string; categories: string }>();
        const merged = mergeCategoriesFromRules(slug, effectiveCategory, ruleRows.results || []);
        effectiveCategory = merged || null;
    } catch (e) {
        console.error('category_prefix_rules lookup failed (create):', e);
    }

    // 2. "카테고리:이름" 자동 카테고리 prepend
    const _autoCategory = getCategoryDocAutoCategory(slug);
    if (_autoCategory) {
        const cats = splitCategoryString(effectiveCategory);
        if (!cats.includes(_autoCategory)) cats.unshift(_autoCategory);
        effectiveCategory = cats.join(',');
    }

    // 3. doc_setting_prefix_rules: is_private/edit_acl(longest match) + categories(합집합)
    try {
        await ensureDocSettingPrefixRulesMigration(db);
        const ruleRows = await db
            .prepare('SELECT prefix, is_private, edit_acl, categories FROM doc_setting_prefix_rules')
            .all<{ prefix: string; is_private: number | null; edit_acl: string | null; categories: string | null }>();
        let bestLen = -1;
        let privateOverride: number | null = null;
        let aclOverride: string | null = null;
        for (const r of ruleRows.results || []) {
            if (!slug.startsWith(r.prefix + '/')) continue;
            if (r.is_private === null && r.edit_acl === null) continue;
            if (r.prefix.length > bestLen) {
                bestLen = r.prefix.length;
                privateOverride = r.is_private;
                aclOverride = r.edit_acl;
            }
        }
        if (privateOverride !== null) finalIsPrivate = privateOverride;
        if (aclOverride !== null && finalEditAcl === null && !input.adminExplicitlySetEditAcl) {
            finalEditAcl = serializeEditAcl(parseEditAcl(aclOverride));
        }

        const catRules = (ruleRows.results || [])
            .filter(r => r.categories)
            .map(r => ({ prefix: r.prefix, categories: r.categories as string }));
        if (catRules.length > 0) {
            const merged = mergeCategoriesFromRules(slug, effectiveCategory, catRules);
            effectiveCategory = merged || null;
        }
    } catch (e) {
        console.error('doc_setting_prefix_rules lookup failed (create):', e);
    }

    // 4. category_acl 템플릿 머지
    try {
        const explicitCats = splitCategoryString(input.category);
        const effectiveCats = splitCategoryString(effectiveCategory);
        const explicitSet = new Set(explicitCats);
        const choicesRaw = (input.categoryAclChoices && typeof input.categoryAclChoices === 'object' && !Array.isArray(input.categoryAclChoices))
            ? input.categoryAclChoices
            : null;

        const apply: { name: string; mode: CategoryAclMode }[] = [];
        for (const cat of effectiveCats) {
            if (explicitSet.has(cat)) {
                if (choicesRaw && Object.prototype.hasOwnProperty.call(choicesRaw, cat)) {
                    let mode = normalizeCategoryAclMode(choicesRaw[cat]);
                    if (!input.isAdmin && mode === 'overwrite') mode = 'merge';
                    if (mode !== 'ignore') apply.push({ name: cat, mode });
                }
            } else {
                apply.push({ name: cat, mode: 'merge' });
            }
        }

        if (apply.length > 0) {
            const templates = await getCategoryAclsBatch(db, apply.map(a => a.name));
            let layered: EditAcl | null = parseEditAcl(finalEditAcl);
            let mutated = false;
            for (const a of apply) {
                const tpl = templates.get(a.name);
                if (!tpl) continue;
                layered = applyCategoryAclToPage(layered, tpl, a.mode);
                mutated = true;
            }
            if (mutated) {
                finalEditAcl = serializeEditAcl(layered);
            }
        }
    } catch (e) {
        console.error('category_acl apply failed (create):', e);
    }

    return { effectiveCategory, finalIsPrivate, finalEditAcl };
}

/**
 * 문서 주소 변경 시 사용될 본문 재작성 헬퍼.
 * - 코드블럭(```...```)과 인라인 코드(`...`)는 마스킹하여 보존
 * - `[[oldSlug]]`, `[[oldSlug|표시]]`, `[[oldSlug#섹션]]`, `[[oldSlug#섹션|표시]]`를 새 슬러그로 치환
 * - isTemplateMove === true일 때만 `{{...}}` 치환 (`틀:`, `template:`, `템플릿:` 접두사 변형 포함)
 * - 익스텐션 슬러그(콜론 포함, 틀 접두사 아님)는 `{{namespace:Name}}` 형태 치환
 * - 원문과 결과가 동일하면 호출자가 새 리비전 생성을 생략할 수 있도록 문자열 비교로 판단
 */
export function rewriteContentForRename(
    content: string,
    oldSlug: string,
    newSlug: string
): string {
    if (!content || oldSlug === newSlug) return content;

    // 1) 코드블럭 및 인라인 코드 마스킹 (extractLinks의 cleaned 정책과 일치)
    const fences: string[] = [];
    let masked = content.replace(/```[\s\S]*?```/g, (m) => {
        fences.push(m);
        return `\u0000FENCE${fences.length - 1}\u0000`;
    });
    const inlines: string[] = [];
    masked = masked.replace(/`[^`\n]+`/g, (m) => {
        inlines.push(m);
        return `\u0000INLINE${inlines.length - 1}\u0000`;
    });

    const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const templatePrefixes = ['틀:', 'template:', '템플릿:'];
    const matchedOldPrefix = templatePrefixes.find(p => oldSlug.startsWith(p));
    const matchedNewPrefix = templatePrefixes.find(p => newSlug.startsWith(p));
    const isTemplateMove = Boolean(matchedOldPrefix && matchedNewPrefix);

    const oldHasColon = oldSlug.includes(':');
    const isExtensionMove = oldHasColon && !matchedOldPrefix;

    // 2) [[wikilink]] 치환
    // - 접두사 간에는 별칭이 아니라 서로 다른 문서를 가리키므로(예: `template:Foo`와 `틀:Foo`는
    //   서로 다른 페이지), 정확히 `[[oldSlug ...]]` 형태만 치환한다.
    {
        const re = new RegExp(
            '\\[\\[\\s*' + escapeRe(oldSlug) + '\\s*(#[^\\]|]*)?(\\|[^\\]]*)?\\]\\]',
            'g'
        );
        masked = masked.replace(re, (_m, sec, disp) => {
            const secPart = sec ?? '';
            const dispPart = disp ?? '';
            return `[[${newSlug}${secPart}${dispPart}]]`;
        });
    }

    // 3) {{template}} / {{extension}} 치환
    if (isTemplateMove) {
        // 접두사가 다른 `{{template:Foo}}` / `{{템플릿:Foo}}` 등은 각각 다른 문서를 가리키므로
        // 건드리지 않는다. `{{Foo}}`(접두사 없음)는 파서가 항상 `틀:`을 붙여 해석하므로,
        // `틀:` 네임스페이스 내부 이동일 때에만 bare 형태를 함께 갱신한다.
        const variants: { from: string; to: string }[] = [
            { from: oldSlug, to: newSlug },
        ];
        if (matchedOldPrefix === '틀:' && matchedNewPrefix === '틀:') {
            const oldBase = oldSlug.substring(matchedOldPrefix.length);
            const newBase = newSlug.substring(matchedNewPrefix.length);
            variants.push({ from: oldBase, to: newBase });
        }
        for (const { from, to } of variants) {
            const re = new RegExp(
                '\\{\\{\\s*' + escapeRe(from) + '\\s*(#[^}]*)?\\}\\}',
                'g'
            );
            masked = masked.replace(re, (_m, sec) => {
                const secPart = sec ?? '';
                return `{{${to}${secPart}}}`;
            });
        }
    } else if (isExtensionMove) {
        const re = new RegExp(
            '\\{\\{\\s*' + escapeRe(oldSlug) + '\\s*(#[^}]*)?\\}\\}',
            'g'
        );
        masked = masked.replace(re, (_m, sec) => {
            const secPart = sec ?? '';
            return `{{${newSlug}${secPart}}}`;
        });
    }
    // 일반 문서 이동(Foo → Bar) 시에는 {{Foo}}는 `틀:Foo`를 의미하므로 변환하지 않음

    // 4) 마스킹 역순 복원
    masked = masked.replace(/\u0000INLINE(\d+)\u0000/g, (_m, i) => inlines[Number(i)]);
    masked = masked.replace(/\u0000FENCE(\d+)\u0000/g, (_m, i) => fences[Number(i)]);

    return masked;
}

/**
 * 역링크 문서의 본문을 일괄 재작성한다.
 * - page_links 테이블에서 정확히 oldSlug를 target_slug로 갖는 모든 문서를 찾아
 *   최신 리비전의 본문을 R2에서 가져와 rewriteContentForRename으로 치환하고,
 *   새 리비전 업로드 → revisions INSERT → pages UPDATE(낙관적 잠금) → page_links 재구축 순으로 처리.
 * - 틀 접두사(`틀:`/`template:`/`템플릿:`) 간에는 서로 별칭이 아니므로 교차 접두사 변형은 대상에서 제외한다.
 * - 최대 200개까지만 처리하며, 초과분은 skipped로 반환한다.
 */
async function rewriteBacklinksForRename(
    c: any,
    oldSlug: string,
    newSlug: string,
    user: { id: number; role: string },
    rbac: RBAC
): Promise<{ updated: string[]; skipped: string[]; conflicts: string[]; total: number }> {
    const db: D1Database = c.env.DB;
    const MAX_BACKLINKS = 200;

    // 대상 target_slug: 정확히 oldSlug만 사용한다.
    // `틀:`, `template:`, `템플릿:` 접두사는 이 코드베이스에서 별칭이 아니라 서로 다른 문서를
    // 가리키므로(예: `template:Foo`는 `틀:Foo`와 별개 문서), 다른 접두사를 포함시키면 관계 없는
    // 문서의 링크가 함께 재작성되어 본문이 손상될 수 있다. extractLinks()가 `{{Foo}}`를 항상
    // `틀:Foo`로 저장하므로 `틀:Foo` 이동 시 bare 형태의 틀 호출도 자연스럽게 포함된다.
    const targetSlugs: string[] = [oldSlug];

    const placeholders = targetSlugs.map(() => '?').join(', ');
    // 주의: 이 함수는 move 핸들러가 pages.slug를 newSlug로 UPDATE한 *이후*에 호출된다.
    // 이동된 페이지 자체(now slug=newSlug)도 page_links에 oldSlug를 target_slug로 가진
    // 자기참조 행이 남아 있을 수 있으므로, 그 페이지도 결과에 포함시켜 본문의
    // [[oldSlug]] 자기참조를 [[newSlug]]로 갱신해야 한다. 따라서 slug 기반 제외는 두지 않는다.
    const { results: sourcePages } = await db
        .prepare(`
            SELECT DISTINCT p.id, p.slug, p.version, p.content, p.category,
                p.last_revision_id, p.edit_acl
            FROM page_links pl
            JOIN pages p ON pl.source_page_id = p.id
            WHERE p.deleted_at IS NULL
              AND pl.blog = 0
              AND pl.source_type = 'page'
              AND pl.link_type IN ('wikilink', 'template', 'extension')
              AND pl.target_slug IN (${placeholders})
        `)
        .bind(...targetSlugs)
        .all<{
            id: number; slug: string; version: number; content: string;
            category: string | null; last_revision_id: number | null;
            edit_acl: string | null;
        }>();

    const total = sourcePages.length;
    const updated: string[] = [];
    const skipped: string[] = [];
    const conflicts: string[] = [];

    const targets = sourcePages.slice(0, MAX_BACKLINKS);
    const overflow = sourcePages.slice(MAX_BACKLINKS);
    for (const p of overflow) skipped.push(p.slug);

    const origin = new URL(c.req.url).origin;
    const enabledExtensions = (c.env.ENABLED_EXTENSIONS || '')
        .split(',').map((s: string) => s.trim()).filter(Boolean);

    const isAdmin = rbac.can(user.role, 'admin:access');
    for (const page of targets) {
        // 안전망: edit_acl 에 admin_only 가 있고 비관리자면 스킵 (정상 관리자는 통과)
        if (!isAdmin) {
            const acl = parseEditAcl(page.edit_acl);
            if (acl && acl.flags.includes('admin_only')) {
                skipped.push(page.slug);
                continue;
            }
        }

        // 최신 리비전 본문 추출
        let currentContent = '';
        try {
            if (page.last_revision_id) {
                const rev = await db
                    .prepare('SELECT content, r2_key FROM revisions WHERE id = ?')
                    .bind(page.last_revision_id)
                    .first<{ content: string; r2_key: string | null }>();
                if (rev) {
                    currentContent = await getRevisionContent(c.env.MEDIA, rev, origin);
                } else {
                    currentContent = page.content || '';
                }
            } else {
                currentContent = page.content || '';
            }
        } catch (e) {
            console.error('Failed to read revision for backlink rewrite:', page.slug, e);
            skipped.push(page.slug);
            continue;
        }

        const rewritten = rewriteContentForRename(currentContent, oldSlug, newSlug);

        // 변화 없음: revision 생성 없이 page_links만 재동기화
        if (rewritten === currentContent) {
            try {
                const stmts = buildLinkAndCategoryStatements(db, page.id, rewritten, page.category);
                await db.batch(stmts);
            } catch (e) {
                console.error('Failed to resync page_links:', page.slug, e);
            }
            continue;
        }

        const newVersion = page.version + 1;
        const isR2Only = isR2OnlyNamespace(page.slug, enabledExtensions);

        // 1) R2 업로드
        let r2Key: string;
        try {
            r2Key = await uploadRevisionToR2(c.env.MEDIA, page.id, newVersion, rewritten);
        } catch (e) {
            console.error('R2 upload failed for backlink rewrite:', page.slug, e);
            skipped.push(page.slug);
            continue;
        }

        // 2) revisions INSERT
        let revisionId: number;
        try {
            const revResult = await db
                .prepare(
                    'INSERT INTO revisions (page_id, page_version, content, r2_key, summary, author_id) VALUES (?, ?, ?, ?, ?, ?)'
                )
                .bind(page.id, newVersion, '', r2Key, `[자동] 주소 변경: ${oldSlug} → ${newSlug}`, user.id)
                .run();
            revisionId = revResult.meta.last_row_id as number;
        } catch (e) {
            console.error('revisions INSERT failed for backlink rewrite:', page.slug, e);
            await c.env.MEDIA.delete(r2Key).catch(() => {});
            skipped.push(page.slug);
            continue;
        }

        // 3) pages UPDATE (낙관적 잠금)
        const contentToStore = isR2Only ? '' : rewritten;
        const metrics = computePageMetricsTracked(rewritten, isR2Only);
        let pagesUpdated = 0;
        try {
            const upd = await db
                .prepare(
                    `UPDATE pages
                     SET content = ?, last_revision_id = ?, version = ?,
                         rows = ?, characters = ?, updated_at = unixepoch()
                     WHERE id = ? AND version = ?`
                )
                .bind(contentToStore, revisionId, newVersion, metrics.rows, metrics.characters, page.id, page.version)
                .run();
            pagesUpdated = (upd.meta?.changes ?? (upd as any).changes ?? 0) as number;
        } catch (e) {
            console.error('pages UPDATE failed for backlink rewrite:', page.slug, e);
            pagesUpdated = 0;
        }

        if (!pagesUpdated) {
            // 중간 편집 충돌: 롤백
            await db.prepare('DELETE FROM revisions WHERE id = ?').bind(revisionId).run().catch(() => {});
            await c.env.MEDIA.delete(r2Key).catch(() => {});
            conflicts.push(page.slug);
            continue;
        }

        // 4) page_links / page_categories 재구축
        try {
            const stmts = buildLinkAndCategoryStatements(db, page.id, rewritten, page.category);
            // D1 배치 상한(약 50) 고려해 chunk 분할
            const chunkSize = 40;
            for (let i = 0; i < stmts.length; i += chunkSize) {
                await db.batch(stmts.slice(i, i + chunkSize));
            }
        } catch (e) {
            console.error('Failed to rebuild page_links after rewrite:', page.slug, e);
        }

        updated.push(page.slug);
    }

    // 5) 캐시 일괄 무효화
    if (updated.length > 0) {
        c.executionCtx.waitUntil(
            Promise.allSettled(updated.map(slug => invalidatePageCache(c, slug)))
        );
    }

    // 6) admin_log 기록
    if (updated.length > 0) {
        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind(
                    'doc_move_backlinks',
                    `역링크 일괄 갱신: ${oldSlug} → ${newSlug} (${updated.length}개 갱신, ${skipped.length}개 건너뜀, ${conflicts.length}개 충돌)`,
                    user.id
                )
                .run()
                .catch((e: any) => console.error('Failed to write admin_log for backlinks:', e))
        );
    }

    return { updated, skipped, conflicts, total };
}

import { uploadRevisionToR2, getRevisionContent } from '../utils/r2';
import { loadActiveAnnouncements } from '../utils/announcements';
import type { AnnouncementDTO } from '../shared/api/announcement';
import {
    parseEditAcl,
    serializeEditAcl,
    normalizeEditAcl,
    evaluateEditAcl,
    getEditAclMinAgeDays,
    findPrefixRuleEditAcl,
    isTrustedEditor,
    type EditAcl,
} from '../utils/editAcl';
import { dispatchDiscord } from '../utils/webhook/discord';
import { pendingEditCreated } from '../utils/webhook/events/pendingEdit';
import {
    getCategoryAcl,
    getCategoryAclsBatch,
    isAdminOnlyCategory,
    applyCategoryAclToPage,
    normalizeCategoryAclMode,
    type CategoryAclMode,
} from '../utils/categoryAcl';
import { ensureDocSettingPrefixRulesMigration } from '../utils/docSettingPrefixRulesMigration';
/**
 * GET /config
 * 동적 설정 (위키 이름 등) 반환
 */
wiki.get('/config', async (c) => {
    // 공지 정보 조회 — 삭제된 블로그 포스트와 연동된 항목은 자동 제외.
    let announcements: AnnouncementDTO[] = [];
    if (!(c.env.WIKI_VISIBILITY === 'closed' && !c.get('user'))) {
        try {
            const active = await loadActiveAnnouncements(c.env.DB);
            announcements = active.map(a => ({
                id: a.id,
                title: a.title,
                announcedTime: a.announcedTime,
                url: a.url ?? (a.postId !== null ? `/blog/${a.postId}` : null),
                icon: a.icon,
                postId: a.postId,
            }));
        } catch (e) {
            // 마이그레이션 미적용 등으로 컬럼이 없을 때도 /config 자체는 동작해야 함
            console.error('announcements lookup failed:', e);
        }
    }

    // 모든 커스텀 팔레트를 동봉 — index/blog 의 SSR 경로는 _usedPalettes (사용된 부분집합) 를
    // 우선 사용하므로 이 필드는 사실상 무시되지만, revisions/discussions/tickets/mypage 등
    // SSR _usedPalettes 도 options.palettes 도 없는 비-SSR 렌더 경로는 이 폴백으로 동작한다.
    let palettes: Record<string, unknown> = {};
    try {
        palettes = await loadAllPalettes(c.env.DB);
    } catch (e) {
        console.error('loadAllPalettes for /config failed:', e);
    }

    return c.json({
        wikiName: c.env.WIKI_NAME || 'CloudWiki',
        termsOfServiceSlug: normalizeSlug(c.env.TERMS_OF_SERVICE || ''),
        privacyPolicySlug: normalizeSlug(c.env.PRIVACY_POLICY || ''),
        wikiLogoUrl: c.env.WIKI_LOGO_URL || '',
        wikiFaviconUrl: c.env.WIKI_FAVICON_URL || '',
        wikiVisibility: c.env.WIKI_VISIBILITY === 'closed' ? 'closed' : 'open',
        layoutMode: (c.env.LAYOUT_MODE === 'left-toc' || c.env.LAYOUT_MODE === 'right-toc' || c.env.LAYOUT_MODE === 'docs' || c.env.LAYOUT_MODE === 'wide') ? c.env.LAYOUT_MODE : 'default',
        selectedIconsOnly: c.env.SELECTED_ICONS_ONLY === 'true',
        enableConcurrentEditDetection: c.env.ENABLE_CONCURRENT_EDIT_DETECTION !== 'false',
        turnstileSiteKey: c.env.TURNSTILE_SITE_KEY || '',
        enabledExtensions: (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean),
        mediaPublicUrl: c.env.MEDIA_PUBLIC_URL || '',
        announcements,
        palettes,
    });
});

/**
 * GET /palettes
 * 모든 커스텀 팔레트(palettes 테이블) 반환. 편집기 자동완성/모달과 실시간 미리보기에서 사용.
 * 문서 열람 페이지는 SSR 의 _usedPalettes (사용된 부분집합) 를 쓰므로 호출하지 않는다.
 * WIKI_VISIBILITY='closed' 인 사이트에서는 로그인 사용자에게만 노출.
 */
wiki.get('/palettes', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    return c.json({ palettes: await loadAllPalettes(c.env.DB) });
});

/**
 * GET /w/search-titles
 * 자동완성용 제목 검색 (최대 5개)
 * Query: q (검색어), type (link | template)
 */
wiki.get('/w/search-titles', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const canSeePrivate = rbac.can(user?.role ?? 'guest', 'wiki:private');
    const q = c.req.query('q') || '';
    const type = c.req.query('type') || 'link';
    const exclude = c.req.query('exclude') || '';

    let query = `SELECT slug FROM pages WHERE deleted_at IS NULL`;
    if (!canSeePrivate) query += ' AND is_private = 0';
    const params: any[] = [];

    if (type === 'template') {
        const enabledExtensions = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
        const namespaceLikes = ["slug LIKE '틀:%'", ...enabledExtensions.map(() => "slug LIKE ?")];
        query += ` AND (${namespaceLikes.join(' OR ')})`;
        enabledExtensions.forEach(ext => params.push(`${ext}:%`));
    } else {
        query += " AND slug NOT LIKE '이미지:%'";
    }

    // 틀 자동완성에서 자기 자신 제외
    if (exclude) {
        query += ' AND slug != ?';
        params.push(exclude);
    }

    if (q.length > 0) {
        query += ' AND slug LIKE ?';
        params.push(`%${q}%`);
        query += ' ORDER BY slug ASC';
    } else {
        // 빈 쿼리: 최근 수정 순 반환
        query += ' ORDER BY updated_at DESC';
    }

    query += ' LIMIT 5';

    const { results } = await db.prepare(query).bind(...params).all();
    return c.json({ results });
});


/**
 * GET /w/search-categories
 * 카테고리 자동완성용 검색 (최대 8개)
 * Query: q (검색어)
 */
wiki.get('/w/search-categories', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = !!(user && rbac.can(user.role, 'admin:access'));
    const q = c.req.query('q') || '';

    // 비관리자에게는 admin_only 카테고리(category_acl.edit_acl 에 admin_only 플래그) 를 제외한다.
    // 마이그레이션 호환: category_acl 행 자체가 없는 카테고리는 레거시 admin_categories 도 차단 대상.
    // 단, category_acl 행이 존재하면 그 값이 단일 소스 — admin 이 새 UI 에서 admin_only 를 해제하면
    // 레거시 admin_categories 행이 살아 있어도 잠금이 풀린다.
    const adminFilter = isAdmin
        ? ''
        : ` AND NOT (
            EXISTS (
                SELECT 1 FROM category_acl ca
                 WHERE ca.name = page_categories.category
                   AND ca.edit_acl IS NOT NULL
                   AND ca.edit_acl LIKE '%"admin_only"%'
            )
            OR (
                NOT EXISTS (
                    SELECT 1 FROM category_acl ca2
                     WHERE ca2.name = page_categories.category
                )
                AND EXISTS (
                    SELECT 1 FROM admin_categories ac
                     WHERE ac.name = page_categories.category
                )
            )
          )`;

    let rows: { category: string }[];
    if (q.length > 0) {
        const { results } = await db
            .prepare(`SELECT DISTINCT category FROM page_categories WHERE category LIKE ?${adminFilter} ORDER BY category ASC LIMIT 8`)
            .bind(`%${q}%`)
            .all<{ category: string }>();
        rows = results;
    } else {
        const { results } = await db
            .prepare(`SELECT DISTINCT category FROM page_categories WHERE 1=1${adminFilter} ORDER BY category ASC LIMIT 8`)
            .all<{ category: string }>();
        rows = results;
    }

    return c.json({ results: rows.map(r => r.category) });
});

/**
 * POST /w/check-category
 * 에디터 chip 생성 시 사전 검증.
 * Body: { category: string }
 * 응답: { ok: boolean, reason?: 'admin_only' | 'invalid', edit_acl?: EditAcl | null }
 *  - ok=false 이면 chip 을 UI 에서 제거하고 경고 표시.
 *  - ok=true 이고 edit_acl 이 있으면 클라이언트가 overwrite/merge/ignore 모드를 사용자에게 묻는다.
 */
wiki.post('/w/check-category', requireAuth, async (c) => {
    const db = c.env.DB;
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = rbac.can(user.role, 'admin:access');

    const body = await c.req.json<{ category?: unknown }>().catch(() => ({} as { category?: unknown }));
    const raw = typeof body.category === 'string' ? body.category.trim() : '';
    if (!raw) {
        return c.json({ ok: false, reason: 'invalid' as const });
    }
    if (!/^[가-힣a-zA-Z0-9\s_.-]+$/.test(raw)) {
        return c.json({ ok: false, reason: 'invalid' as const });
    }

    // 새 category_acl 우선, 행이 없으면 레거시 admin_categories 폴백 — isAdminOnlyCategory 와 동일 우선순위.
    // 레거시 행만 있는 카테고리도 비관리자에게 즉시 chip 차단을 노출해야 한다 (서버 save 거부와 일관).
    const acl = await getCategoryAcl(db, raw);
    const effectiveAdminOnly = await isAdminOnlyCategory(db, raw);
    if (effectiveAdminOnly && !isAdmin) {
        return c.json({ ok: false, reason: 'admin_only' as const });
    }

    // 응답 ACL: category_acl 행이 있으면 그 값, 없는데 레거시로 admin_only 판정된 경우 합성.
    const effectiveAcl = acl ?? (effectiveAdminOnly ? { flags: ['admin_only' as const] } : null);
    return c.json({ ok: true, edit_acl: effectiveAcl });
});


/**
 * GET /w/recent-changes
 * 위키 전체에서 가장 최근에 수정된 문서 10개
 */
wiki.get('/w/recent-changes', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const canSeePrivate = rbac.can(user?.role ?? 'guest', 'wiki:private');

    // 비공개 페이지 열람 권한이 있는 응답은 캐시하지 않는다 (퍼블릭 캐시 누출 방지)
    const cache = caches.default;
    const cacheKey = c.req.url;
    if (!canSeePrivate) {
        const cached = await cache.match(cacheKey);
        if (cached) {
            return new Response(cached.body, cached);
        }
    }

    const privateFilter = canSeePrivate ? '' : ' AND p.is_private = 0';
    const { results } = await db.prepare(`
        SELECT p.slug, p.updated_at, u.name as author_name
        FROM pages p
        LEFT JOIN revisions r ON p.last_revision_id = r.id
        LEFT JOIN users u ON r.author_id = u.id
        WHERE p.deleted_at IS NULL${privateFilter}
        ORDER BY p.updated_at DESC LIMIT 10
    `).all();

    const body = JSON.stringify(safeJSON({ changes: results }));
    // 비공개 페이지를 볼 수 있는 응답은 중간 캐시/브라우저가 저장하지 못하도록 Cache-Control 자체를 private/no-store 로 둔다.
    const response = new Response(body, {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Cache-Control': canSeePrivate ? 'private, no-store' : 'public, max-age=60',
        },
    });
    if (!canSeePrivate) {
        c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
});

/**
 * GET /w/admin-categories
 * 관리자 전용 카테고리(category_acl.edit_acl 에 admin_only 플래그 포함) 목록.
 * 편집 페이지에서 UI 표시용으로 조회한다 (admin_categories 화이트리스트 시절의 호환 엔드포인트).
 *
 * 마이그레이션 호환: category_acl 행이 없는 admin_categories 의 카테고리도 함께 노출.
 * 단 category_acl 행이 있는 카테고리는 그 행을 단일 소스로 사용 — admin 이 새 UI 에서 admin_only 를
 * 해제하면 레거시 admin_categories 행이 살아 있어도 목록에 포함되지 않는다.
 * 운영 환경에서 흡수 마이그레이션 + DROP admin_categories 완료 후 두 번째 SELECT 절은 제거 가능.
 */
wiki.get('/w/admin-categories', async (c) => {
    const db = c.env.DB;
    const { results } = await db
        .prepare(`
            SELECT name FROM category_acl
              WHERE edit_acl IS NOT NULL AND edit_acl LIKE '%"admin_only"%'
            UNION
            SELECT name FROM admin_categories
              WHERE NOT EXISTS (
                  SELECT 1 FROM category_acl ca WHERE ca.name = admin_categories.name
              )
            ORDER BY name ASC
        `)
        .all<{ name: string }>();
    return c.json({ categories: (results || []).map(r => r.name) });
});

/**
 * GET /w/templates
 * 템플릿 목록 (slug가 '템플릿:'으로 시작하는 문서들만)
 */
wiki.get('/w/templates', async (c) => {
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const canSeePrivate = rbac.can(user?.role ?? 'guest', 'wiki:private');
    const privateFilter = canSeePrivate ? '' : ' AND is_private = 0';
    const q = c.req.query('q');

    if (q) {
        const { results } = await db
            .prepare(`SELECT slug FROM pages WHERE slug LIKE '템플릿:%' AND slug LIKE ? AND deleted_at IS NULL${privateFilter} ORDER BY created_at DESC`)
            .bind(`%${q}%`)
            .all();
        return c.json({ templates: results });
    } else {
        const { results } = await db
            .prepare(`SELECT slug FROM pages WHERE slug LIKE '템플릿:%' AND deleted_at IS NULL${privateFilter} ORDER BY created_at DESC LIMIT 10`)
            .all();
        return c.json({ templates: results });
    }
});

/**
 * GET /random
 * 단일 랜덤 문서 반환 (접근 가능한 문서 중)
 */
wiki.get('/w/random', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const canSeePrivate = rbac.can(user?.role ?? 'guest', 'wiki:private');
    let query = `
        SELECT slug
        FROM pages
        WHERE deleted_at IS NULL
    `;
    if (!canSeePrivate) query += ' AND is_private = 0';
    // 관리자 페이지, 틀, 이미지, 카테고리 등 배제
    query += " AND slug NOT LIKE '이미지:%' AND slug NOT LIKE '틀:%' AND slug NOT LIKE 'template:%' AND slug NOT LIKE '템플릿:%' AND slug NOT LIKE '카테고리:%'";

    query += ' ORDER BY RANDOM() LIMIT 1';

    const page = await db.prepare(query).first<{ slug: string }>();

    if (!page) {
        return c.json({ error: '랜덤 문서를 찾을 수 없습니다.' }, 404);
    }

    return c.json(safeJSON({ slug: page.slug }));
});

/**
 * GET /w/recent-revisions
 * 위키 전체에서 가장 최근 리비전 내역 (모든 문서 대상)
 * - 삭제되지 않은 문서의 리비전만 표시
 * Query: offset (기본 0), limit (기본 10, 최대 50)
 */
wiki.get('/w/recent-revisions', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const canSeePrivate = rbac.can(user?.role ?? 'guest', 'wiki:private');
    const privateFilter = canSeePrivate ? '' : ' AND p.is_private = 0';
    const isAdmin = !!user && rbac.can(user.role, 'admin:access');
    // 비관리자에게는 삭제된 리비전 자체가 존재하지 않는 것처럼 가린다.
    const revDeletedFilter = isAdmin ? '' : ' AND r.deleted_at IS NULL';
    const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10));
    const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '10', 10)));

    const adminCols = isAdmin ? ', r.deleted_at, r.purged_at' : '';
    const listQuery = `
        SELECT r.id, r.page_id, r.page_version, r.summary, r.created_at,
               p.slug,
               u.id as author_id, u.name as author_name, u.picture as author_picture,
               ${ROLE_CASE_SQL} as author_role,
               u.email as _author_email${adminCols}
        FROM revisions r
        JOIN pages p ON r.page_id = p.id
        LEFT JOIN users u ON r.author_id = u.id
        WHERE p.deleted_at IS NULL${privateFilter}${revDeletedFilter}
        ORDER BY r.created_at DESC LIMIT ? OFFSET ?`;
    const countQuery = `
        SELECT COUNT(*) as total
        FROM revisions r
        JOIN pages p ON r.page_id = p.id
        WHERE p.deleted_at IS NULL${privateFilter}${revDeletedFilter}`;

    const [listResult, countResult] = await db.batch([
        db.prepare(listQuery).bind(limit, offset),
        db.prepare(countQuery),
    ]);

    const results = listResult.results;
    const rawTotal = (countResult.results[0] as any)?.total;
    const parsedTotal = Number(rawTotal);
    const total = Number.isFinite(parsedTotal) ? parsedTotal : 0;

    enrichRoles(results, 'author_role', '_author_email', c.env);

    return c.json(safeJSON({ revisions: results, total, has_more: offset + results.length < total }));
});

/**
 * GET /w/all-pages
 * 모든 문서 목록 (정렬 + 페이지네이션)
 * Query: offset (기본 0), limit (기본 20, 최대 50),
 *        sort (slug_asc, slug_desc, created_asc, created_desc,
 *              updated_asc, updated_desc, category_asc, category_desc,
 *              chars_desc, chars_asc)
 */
wiki.get('/w/all-pages', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const canSeePrivate = rbac.can(user?.role ?? 'guest', 'wiki:private');
    const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10));
    const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
    const sort = c.req.query('sort') || 'slug_asc';

    const sortMap: Record<string, string> = {
        slug_asc: 'p.slug COLLATE NOCASE ASC',
        slug_desc: 'p.slug COLLATE NOCASE DESC',
        created_asc: 'p.created_at ASC',
        created_desc: 'p.created_at DESC',
        updated_asc: 'p.updated_at ASC',
        updated_desc: 'p.updated_at DESC',
        category_asc: 'p.category COLLATE NOCASE ASC, p.slug COLLATE NOCASE ASC',
        category_desc: 'p.category COLLATE NOCASE DESC, p.slug COLLATE NOCASE ASC',
        chars_desc: 'COALESCE(p.characters, 0) DESC, p.slug COLLATE NOCASE ASC',
        chars_asc: 'COALESCE(p.characters, 0) ASC, p.slug COLLATE NOCASE ASC',
    };
    const orderBy = sortMap[sort] || sortMap['slug_asc'];

    const whereClause = 'p.deleted_at IS NULL'
        + (canSeePrivate ? '' : ' AND p.is_private = 0')
        + (sort === 'chars_asc' ? ' AND p.characters IS NOT NULL' : '');

    const countQuery = `SELECT COUNT(*) as total FROM pages p WHERE ${whereClause}`;
    const listQuery = `SELECT p.slug, p.category, p.created_at, p.updated_at, p.characters FROM pages p WHERE ${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;

    const [countResult, listResult] = await db.batch([
        db.prepare(countQuery),
        db.prepare(listQuery).bind(limit, offset),
    ]);

    const rawTotal = (countResult.results[0] as any)?.total;
    const parsedTotal = Number(rawTotal);
    const total = Number.isFinite(parsedTotal) ? parsedTotal : 0;
    const results = listResult.results;

    return c.json(safeJSON({ pages: results, total }));
});

/**
 * GET /w/wiki-stats
 * 위키 통계 (문서 개수, 편집 횟수)
 * sqlite_sequence 테이블의 pages, revisions 데이터 참조
 */
wiki.get('/w/wiki-stats', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const db = c.env.DB;

    const [pageCountRow, revisionCountRow] = await Promise.all([
        db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'pages'`).first<{ seq: number }>(),
        db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'revisions'`).first<{ seq: number }>(),
    ]);

    return c.json({
        page_count: pageCountRow?.seq ?? 0,
        revision_count: revisionCountRow?.seq ?? 0,
    });
});

/**
 * GET /w/:slug
 * 문서 조회 (공개)
 * - 리다이렉트 처리: 문서가 없고 리다이렉트가 존재하면 대상 문서 반환 (redirected_from 포함)
 * - 비공개 문서: 관리자만 접근 가능
 */
wiki.get('/w/:slug', async (c) => {
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const slug = c.req.param('slug');
    const db = c.env.DB;
    const user = c.get('user');
    const cache = caches.default;
    const cacheKey = c.req.url;
    const nocache = c.req.query('nocache') === 'true';

    // "map:<base>" 슬러그는 실제 문서가 아니라 가상 트리 뷰. 권한자에게는 비공개 자식이 보이지만
    // 비로그인 응답이 글로벌 캐시에 들어가 있을 수 있어, map: 슬러그의 cache.match 는 비로그인 요청
    // (`!user`) 에서만 수행한다. 그래야 권한자가 anonymous 캐시에 갇히지 않는다.
    if (isMapNamespace(slug)) {
        const rbac = c.get('rbac') as RBAC;
        const isAdmin = !!user && rbac.can(user.role, 'admin:access');
        // SPA 라우터가 ?perms=1 로 호출할 때도 SSR 분기와 동일하게 처리. 비관리자가 쿼리를 강제로 켜도 무시.
        const permsQueryRaw = c.req.query('perms');
        const showPerms = isAdmin && permsQueryRaw === '1';
        // 비로그인 사용자의 ?perms=1 요청으로 캐시가 오염되지 않도록 perms 쿼리가 있으면 글로벌 매치를 건너뛴다.
        if (!user && !nocache && permsQueryRaw == null) {
            const cached = await cache.match(cacheKey);
            if (cached) return new Response(cached.body, cached);
        }
        const canSeePrivate = rbac.can(user?.role ?? 'guest', 'wiki:private');
        const baseSlug = slug.substring('map:'.length);
        const mapResult = await buildMapDocument({ db, baseSlug, canSeePrivate, showPerms });
        const mapDoc = {
            slug,
            title: slug,
            is_map_doc: true,
            _ssrShowPerms: showPerms,
            content: mapResult.markdown,
            created_at: 0,
            updated_at: 0,
        };
        const safeForSharedCache = !user && !mapResult.hasPrivateChildren && !showPerms;
        if (safeForSharedCache && !nocache) {
            // map: 캐시는 자식 mutation 시 자동 무효화되지 않으므로 staleness 윈도우를 짧게 유지.
            const fresh = c.json(mapDoc, 200, { 'Cache-Control': `public, max-age=${MAP_CACHE_MAX_AGE_SECONDS}` });
            c.executionCtx.waitUntil(cache.put(cacheKey, fresh.clone()));
            return fresh;
        }
        return c.json(mapDoc, 200, { 'Cache-Control': 'private, no-store' });
    }

    // 캐시 확인 (map: 분기는 위에서 자체적으로 처리했으므로 이 시점에는 일반 슬러그만 남는다)
    let response = await cache.match(cacheKey);
    if (response && !nocache) {
        // 캐시된 응답은 불변(immutable)이므로, 전역 미들웨어가 헤더를 수정할 수 있도록 복제하여 반환
        return new Response(response.body, response);
    }

    // "이미지:파일명" 슬러그는 media 테이블에서 먼저 조회해 이미지 문서로 반환한다.
    // 대응되는 미디어가 없으면 레거시 pages 엔트리가 존재할 수 있으므로 일반 문서 조회로 폴스루한다.
    if (slug.startsWith('이미지:')) {
        const filename = slug.substring('이미지:'.length);
        const mediaRow = await db.prepare(
            `SELECT m.id, m.r2_key, m.filename, m.mime_type, m.size, m.content, m.created_at,
                    u.name as uploader_name
             FROM media m LEFT JOIN users u ON m.uploader_id = u.id
             WHERE m.filename = ? LIMIT 1`
        ).bind(filename).first<{
            id: number; r2_key: string; filename: string; mime_type: string;
            size: number; content: string; created_at: number; uploader_name: string | null;
        }>();

        if (mediaRow) {
            const tags = await fetchMediaTags(db, mediaRow.id);

            const imageDoc = {
                slug,
                is_image_doc: true,
                media: {
                    id: mediaRow.id,
                    r2_key: mediaRow.r2_key,
                    filename: mediaRow.filename,
                    mime_type: mediaRow.mime_type,
                    size: mediaRow.size,
                    uploader_name: mediaRow.uploader_name,
                    url: `/media/${mediaRow.r2_key}`,
                    tags,
                },
                content: mediaRow.content || '',
                updated_at: mediaRow.created_at,
                created_at: mediaRow.created_at,
            };

            if (!nocache) {
                response = c.json(imageDoc, 200, { 'Cache-Control': 'public, max-age=86400' });
                c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
                return response;
            }
            return c.json(imageDoc);
        }
        // mediaRow 부재 시 아래 일반 pages 조회로 폴스루 (legacy 이미지: 슬러그 호환)
    }

    let page = await db
        .prepare('SELECT * FROM pages WHERE slug = ?')
        .bind(slug)
        .first<Page>();

    const rbac = c.get("rbac") as RBAC;
    const isAdmin = user && rbac.can(user.role, 'admin:access');
    const canSeePrivate = rbac.can(user?.role ?? 'guest', 'wiki:private');

    // 비공개 문서는 wiki:private 권한이 없는 사용자에게는 본문/메타데이터를 노출하지 않고
    // "비공개 문서" 안내만 전달한다. 삭제 분기보다 먼저 평가해 비공개·삭제 동시 상태에서
    // 비공개 사실이 우선 노출되도록 한다.
    if (page && page.is_private === 1 && !canSeePrivate) {
        return c.json(
            { error: '비공개 문서입니다.', is_private: true },
            403,
            { 'Cache-Control': 'private, no-store' }
        );
    }

    if (page && page.deleted_at && !isAdmin) {
        return c.json(
            { error: '삭제된 문서입니다.', is_deleted: true },
            410,
            { 'Cache-Control': 'no-store, must-revalidate' }
        );
    }

    // 원본(리다이렉트 이전) 슬러그의 비공개 여부 기록.
    // private 슬러그가 public 으로 리다이렉트되어 page 가 public 대상으로 교체되면 이후 캐시 분기에서
    // page.is_private === 0 으로 보이기 때문에, 캐시 키(URL=원본 슬러그)에 public 응답이 저장돼
    // 권한 없는 후속 요청이 200 을 받아 "비공개 슬러그가 존재함" 이 누출된다. 별도로 추적해 차단.
    const sourceWasPrivate = !!(page && page.is_private === 1);

    let redirectedFrom: string | null = null;
    const redirectParam = c.req.query('redirect');

    // 문서 내 리다이렉트 설정 확인 (soft redirect)
    if (page && page.redirect_to && redirectParam !== 'no') {
        const targetSlug = page.redirect_to;
        let targetPage = await db
            .prepare('SELECT * FROM pages WHERE slug = ?')
            .bind(targetSlug)
            .first<Page>();

        if (targetPage && targetPage.deleted_at && !isAdmin) {
            targetPage = null;
        }

        if (targetPage && targetPage.is_private === 1 && !canSeePrivate) {
            targetPage = null;
        }

        if (targetPage) {
            page = targetPage;
            redirectedFrom = slug;
        }
        // 만약 대상 문서가 없으면, 원래 문서를 그대로 보여줍니다.
    }

    if (!page) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    // R2-only 네임스페이스인 경우, 본문이 비어있다면 최신 리비전에서 본문을 가져옵니다.
    const origin = new URL(c.req.url).origin;
    const enabledExtensionsRead = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
    if (isR2OnlyNamespace(page.slug, enabledExtensionsRead) && (!page.content || page.content === '')) {
        if (page.last_revision_id) {
            const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(page.last_revision_id).first<{ content: string, r2_key: string | null }>();
            if (lastRev) {
                page.content = await getRevisionContent(c.env.MEDIA, lastRev, origin);
            }
        }
    }

    // 본문이 참조하는 커스텀 팔레트만 응답에 동봉 (SPA 네비게이션 시에도 정확한 팔레트로
    // 렌더되도록 — SSR 의 _usedPalettes 는 초기 페이지 첫 로드에만 유효하다).
    let usedPalettes: Record<string, unknown> = {};
    // 응답이 공유 캐시(Cloudflare edge)에 저장될 조건: 공개 페이지이고 !nocache.
    // 캐시 가능 응답은 사용자 권한별로 갈라지지 않아야 하므로, canSeePrivate 효과는
    // 비-캐시 응답(비공개 페이지 / nocache=true) 에서만 적용한다.
    const willShareCache = !(page.is_private === 1 || sourceWasPrivate) && !nocache;
    const palettePerm = canSeePrivate && !willShareCache;
    try {
        // page.content 를 함께 넘겨 page_links 인덱스가 아직 비동기로 갱신 중일 때도
        // 본문이 참조한 팔레트가 누락되지 않게 폴백.
        usedPalettes = await loadPalettesForPage(db, page.id, page.content, palettePerm);
    } catch (e) {
        console.error('loadPalettesForPage failed:', e);
    }

    const result = safeJSON({ ...page, redirected_from: redirectedFrom, used_palettes: usedPalettes });

    // 비공개 페이지는 권한 있는 사용자에게만 노출되므로, 공유 캐시/브라우저 캐시에 저장되지 않도록 한다.
    // sourceWasPrivate 가 true 이면 리다이렉트로 page 가 public 으로 바뀌어도 캐시 키(원본 private 슬러그)에 저장하면 안 된다.
    if (page.is_private === 1 || sourceWasPrivate) {
        response = c.json(result, 200, { 'Cache-Control': 'private, no-store' });
    } else if (!nocache) {
        response = c.json(result, 200, { 'Cache-Control': 'public, max-age=86400' });
        c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
    } else {
        response = c.json(result);
    }

    return response;
});

/**
 * PUT /w/:slug
 * 문서 생성 또는 수정 (로그인 필수)
 * Body: { content, summary, expected_version? }
 * - 슬러그(URL 파라미터)가 곧 문서의 식별자이자 표시 이름이다.
 *   요청 본문에 별도 title 필드는 없다(있어도 무시).
 */
/**
 * GET /w/:slug/edit-permission
 * 편집 페이지 진입 시점 ACL 사전 검사.
 *
 * - 페이지가 존재하면 그 행의 edit_acl, 없으면 doc_setting_prefix_rules 의 prefix 룰 ACL 을 평가.
 * - 관리자(admin:access) 는 항상 allowed=true.
 * - 비로그인 사용자는 그대로 401 (편집 진입 자체가 막혀야 하므로 wiki:edit 권한도 함께 검사).
 *
 * 응답 형식:
 *   { allowed, reason?, acl: EditAcl | null, source: 'page'|'prefix_rule'|'none', min_age_days, is_private }
 *
 * 저장 단계(PUT) 가드는 그대로 유지된다 — 본 엔드포인트는 UX 보조용.
 */
wiki.get('/w/:slug/edit-permission', requireAuth, async (c) => {
    const slug = normalizeSlug(c.req.param('slug'));
    if (!slug) return c.json({ error: '문서 제목이 비어 있습니다.' }, 400);

    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;

    // 기본 권한 — wiki:edit 가 없으면 그 자체로 차단 (관리자 admin:access 는 우회).
    const isAdmin = rbac.can(user.role, 'admin:access');
    if (!rbac.can(user.role, 'wiki:edit') && !isAdmin) {
        return c.json({
            allowed: false,
            reason: 'no_permission',
            acl: null,
            source: 'none',
            min_age_days: 0,
            is_private: 0,
        });
    }

    // PUT 가드와 동일한 슬러그-수준 차단 (페이지 존재 여부와 무관) — 진입 검사가 통과한 뒤
    // 저장 단계에서 같은 사유로 거부당해 본문이 날아가는 것을 막는다.

    // 1) 메인 문서는 관리자만 편집 가능.
    const mainSlug = normalizeSlug(c.env.WIKI_NAME || 'CloudWiki').toLowerCase();
    if (slug.toLowerCase() === mainSlug && !isAdmin) {
        return c.json({
            allowed: false,
            reason: 'main_page',
            acl: null,
            source: 'none',
            min_age_days: 0,
            is_private: 0,
        });
    }

    // 2) "이미지:" 네임스페이스 — 일반 편집 흐름으로 다룰 수 없다.
    if (slug.startsWith('이미지:')) {
        return c.json({
            allowed: false,
            reason: 'image_namespace',
            acl: null,
            source: 'none',
            min_age_days: 0,
            is_private: 0,
        });
    }

    // 3) "map:" 네임스페이스 — 가상 뷰 전용이므로 일반 편집 흐름으로 다룰 수 없다.
    if (slug.startsWith('map:')) {
        return c.json({
            allowed: false,
            reason: 'map_namespace',
            acl: null,
            source: 'none',
            min_age_days: 0,
            is_private: 0,
        });
    }

    const page = await db
        .prepare('SELECT id, is_private, edit_acl, deleted_at FROM pages WHERE slug = ?')
        .bind(slug)
        .first<{ id: number; is_private: number; edit_acl: string | null; deleted_at: number | null }>();

    const minAge = await getEditAclMinAgeDays(db);

    // 소프트 삭제된 페이지는 PUT 경로에서 비관리자에게 410 으로 거부되고, 관리자도 같은 슬러그
    // INSERT 가 UNIQUE 제약으로 막힌다 (복원은 별도 POST /restore 경로). 신규 생성 케이스로 빠지면
    // 진입 검사가 통과해 본문 작성 후 저장 단계에서 작업이 날아가므로 명시적으로 거부한다.
    if (page && page.deleted_at) {
        return c.json({
            allowed: false,
            reason: 'deleted',
            acl: null,
            source: 'page',
            min_age_days: minAge,
            is_private: page.is_private,
        });
    }

    if (page && !page.deleted_at) {
        const acl = parseEditAcl(page.edit_acl);
        const hasAdminOnly = !!acl && acl.flags.includes('admin_only');

        // 관리자는 admin_only 가 없는 ACL 은 우회. admin_only 가 있으면 evaluateEditAcl 이 통과시킨다.
        if (isAdmin && !hasAdminOnly) {
            return c.json({
                allowed: true,
                acl,
                source: page.edit_acl ? 'page' : 'none',
                min_age_days: minAge,
                is_private: page.is_private,
            });
        }
        if (page.is_private === 1 && !rbac.can(user.role, 'wiki:private')) {
            return c.json({
                allowed: false,
                reason: 'private',
                acl: null,
                source: 'page',
                min_age_days: minAge,
                is_private: 1,
            });
        }
        if (acl && acl.flags.length > 0) {
            const ev = await evaluateEditAcl(db, acl, user, page.id, minAge, isAdmin);
            return c.json({
                allowed: ev.allowed,
                reason: ev.allowed ? undefined : (ev.decisive === 'admin_only' ? 'admin_only' : 'edit_acl'),
                decisive: ev.decisive,
                acl,
                source: 'page',
                min_age_days: minAge,
                is_private: page.is_private,
            });
        }
        return c.json({
            allowed: true,
            acl: null,
            source: 'none',
            min_age_days: minAge,
            is_private: page.is_private,
        });
    }

    // 페이지 미존재 — 신규 생성 케이스. prefix 룰 ACL 평가.
    const ruleAcl = await findPrefixRuleEditAcl(db, slug);
    const ruleHasAdminOnly = !!ruleAcl && ruleAcl.flags.includes('admin_only');
    if (!ruleAcl || ruleAcl.flags.length === 0 || (isAdmin && !ruleHasAdminOnly)) {
        return c.json({
            allowed: true,
            acl: ruleAcl,
            source: ruleAcl ? 'prefix_rule' : 'none',
            min_age_days: minAge,
            is_private: 0,
        });
    }
    // 신규 문서이므로 page_editor 는 항상 false (pageId=null).
    const ev = await evaluateEditAcl(db, ruleAcl, user, null, minAge, isAdmin);
    return c.json({
        allowed: ev.allowed,
        reason: ev.allowed ? undefined : (ev.decisive === 'admin_only' ? 'admin_only' : 'edit_acl'),
        decisive: ev.decisive,
        acl: ruleAcl,
        source: 'prefix_rule',
        min_age_days: minAge,
        is_private: 0,
    });
});

wiki.put('/w/:slug', requireAuth, requirePermission('wiki:edit'), async (c) => {
    const slug = normalizeSlug(c.req.param('slug'));

    // 슬러그가 비어 있으면 거부 (normalizeSlug 가 앞뒤 슬래시/공백을 모두 떼어낸 결과)
    if (!slug) {
        return c.json({ error: '문서 제목이 비어 있습니다.' }, 400);
    }

    // 슬러그 유효성 검사: 금지 문자 포함 여부
    if (SLUG_FORBIDDEN_CHARS.test(slug)) {
        return c.json({ error: '제목에 사용할 수 없는 특수문자가 포함되어 있습니다.' }, 400);
    }

    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const body = await c.req.json<{
        content: string;
        summary?: string;
        category?: string;
        is_private?: number;
        edit_acl?: unknown;
        redirect_to?: string;
        expected_version?: number;
        turnstileToken?: string;
        title?: string | null;
        /**
         * 문서 레이아웃 모드. 'presentation' 등 화이트리스트 값 또는 null('자동' = 전역 LAYOUT_MODE).
         * 본문 저장과 함께 동일 PUT 으로 전송되며, 일반 사용자도 설정할 수 있다(권한 게이트 없음 — 표시 전용).
         * 키 자체가 누락되면 기존 값을 유지한다.
         */
        layout_mode?: string | null;
        /**
         * 신규 적용 카테고리에 대한 ACL 머지 모드.
         * 키: 카테고리명, 값: 'overwrite' | 'merge' | 'ignore'.
         * 에디터 chip 생성 시점에 사용자가 선택한 값을 전송한다.
         * 키 자체가 누락된 경우 = 레거시 클라이언트 → 명시적 카테고리에 대한 자동 ACL 적용 비활성.
         */
        category_acl_choices?: Record<string, unknown>;
    }>();

    // 대체 title 검증 — slug 와 별개로 모든 특수문자 허용하되 제어문자만 차단.
    // body 에 title 키가 명시되어 있을 때만 변경 의도로 해석한다. (undefined = 기존값 유지)
    // 잘못된 타입(숫자/객체 등) 은 null 로 정규화 후 "기존 title 삭제" 로 처리되면 데이터가
    // 조용히 손실되므로, title 키가 있을 때는 string | null 만 허용하고 그 외엔 400.
    const hasTitleInBody = Object.prototype.hasOwnProperty.call(body, 'title');
    if (hasTitleInBody && body.title !== null && typeof body.title !== 'string') {
        return c.json({ error: '대체 제목은 문자열 또는 null 이어야 합니다.' }, 400);
    }
    const requestedTitle = hasTitleInBody ? normalizeTitleInput(body.title) : undefined;
    if (requestedTitle && TITLE_FORBIDDEN_CHARS.test(requestedTitle)) {
        return c.json({ error: '대체 제목에 제어문자는 사용할 수 없습니다.' }, 400);
    }
    if (requestedTitle && requestedTitle.length > TITLE_MAX_LENGTH) {
        return c.json({ error: `대체 제목은 ${TITLE_MAX_LENGTH}자 이하여야 합니다.` }, 400);
    }

    // layout_mode 검증 — body 에 키가 명시된 경우에만 변경 의도로 해석한다(undefined = 기존값 유지).
    // 빈 문자열/null 은 NULL('자동' = 전역 LAYOUT_MODE 따름). 그 외엔 화이트리스트(PRESENTATION 등) 만 허용.
    // 표시 전용 메타이므로 별도 권한 게이트 없이 편집 권한자(wiki:edit) 면 누구나 설정 가능하다.
    const hasLayoutInBody = Object.prototype.hasOwnProperty.call(body, 'layout_mode');
    let requestedLayout: string | null | undefined;
    if (hasLayoutInBody) {
        const v = body.layout_mode;
        if (v === null || v === '' || typeof v === 'undefined') {
            requestedLayout = null;
        } else if (typeof v === 'string' && ALLOWED_LAYOUT_MODES.has(v)) {
            requestedLayout = v;
        } else {
            return c.json({ error: `layout_mode 허용 값: null | ${[...ALLOWED_LAYOUT_MODES].join(' | ')}` }, 400);
        }
    }

    // Turnstile 검증
    if (c.env.TURNSTILE_SECRET_KEY) {
        const token = body.turnstileToken;
        if (!token) {
            return c.json({ error: 'Turnstile 검증이 필요합니다.' }, 403);
        }
        // idempotency_key 를 양쪽 시도에 동일하게 전달해 첫 요청이 Cloudflare에 도달 후
        // 응답이 손실된 경우에도 재시도가 캐시된 성공 결과를 받을 수 있도록 한다.
        const idempotencyKey = crypto.randomUUID();
        const makeTsFormData = () => {
            const fd = new FormData();
            fd.append('secret', c.env.TURNSTILE_SECRET_KEY!);
            fd.append('response', token);
            fd.append('remoteip', c.req.header('cf-connecting-ip') || '');
            fd.append('idempotency_key', idempotencyKey);
            return fd;
        };
        // siteverify 는 간헐적 네트워크 오류가 발생할 수 있으므로 fetch 실패 시 1회 재시도.
        // success: false 는 토큰 소비 후 실패일 수 있어 재시도하지 않는다.
        let tsData: { success: boolean };
        try {
            const tsRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
                method: 'POST',
                body: makeTsFormData(),
            });
            tsData = await tsRes.json<{ success: boolean }>();
        } catch {
            // 네트워크 오류 시 1회 재시도
            try {
                const tsRes2 = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
                    method: 'POST',
                    body: makeTsFormData(),
                });
                tsData = await tsRes2.json<{ success: boolean }>();
            } catch {
                return c.json({ error: 'Turnstile 검증에 실패했습니다. 다시 시도해주세요.' }, 403);
            }
        }
        if (!tsData!.success) {
            return c.json({ error: 'Turnstile 검증에 실패했습니다. 다시 시도해주세요.' }, 403);
        }
    }

    const isAdmin = rbac.can(user.role, 'admin:access');
    const db = c.env.DB;

    // 메인 문서는 관리자만 편집 가능 (slug 기준 판단)
    const mainSlug = normalizeSlug(c.env.WIKI_NAME || 'CloudWiki').toLowerCase();
    if (normalizeSlug(slug).toLowerCase() === mainSlug) {
        if (!isAdmin) {
            return c.json({ error: '메인 문서는 관리자만 편집할 수 있습니다.' }, 403);
        }
    }

    // "이미지:" 접두사 문서는 media 테이블 기반의 이미지 문서 전용이며,
    // content 수정은 /api/media/doc/:filename 엔드포인트로만 가능하다.
    if (slug.startsWith('이미지:')) {
        return c.json({ error: '"이미지:"는 이미지 문서 전용 네임스페이스이므로 일반 문서 제목으로 사용할 수 없습니다.' }, 403);
    }

    // "map:" 접두사 문서는 하위 문서 트리를 합성해 보여주는 가상 뷰 전용이므로
    // 일반 문서로 생성/수정할 수 없다.
    if (slug.startsWith('map:')) {
        return c.json({ error: '"map:"은 지도 뷰 전용 네임스페이스이므로 일반 문서 제목으로 사용할 수 없습니다.' }, 403);
    }

    // "카테고리:이름" 슬러그는 자동 카테고리를 항상 포함시킨다 (제거 불가).
    // admin-only 체크보다 먼저 수행해 자동 주입된 카테고리도 동일하게 검증받도록 한다.
    const _autoCategory = getCategoryDocAutoCategory(slug);
    if (_autoCategory) {
        const cats = splitCategoryString(body.category);
        if (!cats.includes(_autoCategory)) cats.unshift(_autoCategory);
        body.category = cats.join(',');
        // 서버가 강제하는 카테고리이므로 클라이언트 값(ignore/배열 등)을 신뢰하지 않고 항상 'merge' 로 덮어쓴다.
        // 배열 등 비-plain 객체가 들어오면 나중의 ACL 머지 로직이 Array.isArray 로 걸러내므로 교체한다.
        if (!body.category_acl_choices || typeof body.category_acl_choices !== 'object' || Array.isArray(body.category_acl_choices)) {
            body.category_acl_choices = {};
        }
        body.category_acl_choices[_autoCategory] = 'merge';
    }

    // 관리자 전용 카테고리 검증 — category_acl 의 admin_only 플래그 기준 (구 admin_categories 화이트리스트 대체).
    if (body.category && !isAdmin) {
        const cats = body.category.split(',').map(c => c.trim()).filter(c => c);
        for (const cat of cats) {
            if (await isAdminOnlyCategory(db, cat)) {
                return c.json({ error: `"${cat}" 카테고리는 관리자만 적용할 수 있습니다.` }, 403);
            }
        }
    }

    if (body.content === undefined) {
        return c.json({ error: 'content는 필수입니다.' }, 400);
    }
    if (typeof body.content !== 'string') {
        return c.json({ error: 'content는 문자열이어야 합니다.' }, 400);
    }

    // CRLF/CR → LF 정규화. 클라이언트 환경(Windows 클립보드, 외부 임포트 등)에서
    // \r 가 섞여 들어오면 렌더 파이프라인의 펜스/`:::`/폴드 정규식이 깨진다.
    // 저장 시점에 한 번만 정규화하면 이후 모든 읽기 경로가 안전해진다.
    body.content = body.content.replace(/\r\n?/g, '\n');

    // 보안: 카테고리 특수문자 금지 (한글, 영문, 숫자, 공백, 쉼표만 허용)
    if (body.category) {
        const categoryPattern = /^[가-힣a-zA-Z0-9\s,]+$/;
        if (!categoryPattern.test(body.category)) {
            return c.json({ error: '카테고리에는 특수문자를 사용할 수 없습니다.' }, 400);
        }
    }

    // 보안: 편집 요약 최대 255자 제한
    if (body.summary && body.summary.length > 255) {
        return c.json({ error: '편집 요약은 최대 255자까지 입력할 수 있습니다.' }, 400);
    }

    const existing = await db
        .prepare('SELECT id, version, is_private, edit_acl, redirect_to, content, deleted_at, title, last_revision_id FROM pages WHERE slug = ?')
        .bind(slug)
        .first<{ id: number; version: number; is_private: number; edit_acl: string | null; redirect_to: string | null; content: string; deleted_at: number | null; title: string | null; last_revision_id: number | null }>();

    // edit_acl body 입력 검증 (관리자만 반영). 비관리자는 기존 값 마스킹.
    let requestedEditAcl: { provided: boolean; value: EditAcl | null } = { provided: false, value: null };
    if (Object.prototype.hasOwnProperty.call(body, 'edit_acl')) {
        const norm = normalizeEditAcl(body.edit_acl);
        if ('error' in norm) {
            return c.json({ error: norm.error }, 400);
        }
        requestedEditAcl = { provided: true, value: norm.value };
    }

    // 신규 title 이 다른 페이지의 slug 또는 title 과 충돌하면 거부.
    // (자기 자신의 slug 와 같은 값을 title 로 적는 것도 의미가 없으므로 차단된다 — 그 경우 그냥 title 을 비우면 동일 표시.)
    // 소프트 삭제 행도 충돌로 인정 — UNIQUE 인덱스가 deleted_at 무관하게 강제하기 때문.
    if (requestedTitle) {
        const selfId = existing?.id ?? null;
        const conflict = await findConflictingPage(db, requestedTitle, selfId);
        if (conflict) {
            const deletedSuffix = conflict.isDeleted ? ' (소프트 삭제 상태 — 관리자가 복원 또는 영구 삭제해야 재사용 가능)' : '';
            const msg = conflict.matchedColumn === 'slug'
                ? `'${requestedTitle}' 는 이미 다른 문서의 제목으로 사용 중입니다.${deletedSuffix}`
                : `'${requestedTitle}' 는 이미 다른 문서의 대체 제목으로 사용 중입니다.${deletedSuffix}`;
            return c.json({ error: msg }, 409);
        }
    }

    // 신규 슬러그 자체가 다른 문서의 title 과 충돌하는지 검사 (생성 흐름 한정).
    // 기존 문서면 slug 자체는 바뀌지 않으므로 검사 불필요.
    // (slug-slug 소프트 삭제 충돌은 기존 existing 분기에서 별도 안내 메시지로 처리.)
    if (!existing) {
        const slugTitleConflict = await findConflictingPage(db, slug, null);
        if (slugTitleConflict && slugTitleConflict.matchedColumn === 'title') {
            const deletedSuffix = slugTitleConflict.isDeleted ? ' (소프트 삭제 상태)' : '';
            return c.json({ error: `'${slug}' 는 이미 다른 문서의 대체 제목과 같아 제목으로 사용할 수 없습니다.${deletedSuffix}` }, 409);
        }
    }

    // 삭제된 문서는 권한자(admin:access)만 복원할 수 있고 일반 사용자의 편집은 불가.
    // 일반 사용자가 동일 슬러그로 새 문서를 만들지 못하도록 명시적으로 차단한다.
    if (existing && existing.deleted_at && !isAdmin) {
        return c.json({ error: '삭제된 문서는 편집할 수 없습니다.', is_deleted: true }, 410);
    }

    let finalIsPrivate = 0;
    let finalEditAcl: string | null = null;

    if (existing && !existing.deleted_at) {
        // expected_version === 0 은 "신규 생성 전용" 시멘틱이다. 기존 문서가 존재하면
        // 본문 일치 여부와 무관하게 충돌로 처리해, 섹션 분리 등 race-condition 차단이
        // 필요한 호출자가 결정론적으로 거부 응답을 받도록 한다.
        if (body.expected_version === 0) {
            return c.json(
                { error: '같은 제목의 문서가 이미 존재합니다.', current_version: existing.version },
                409
            );
        }

        // 비공개 문서는 wiki:private 권한 없으면 편집 불가 (조회 단계에서도 막혀야 하지만 안전망)
        if (existing.is_private === 1 && !rbac.can(user.role, 'wiki:private')) {
            return c.json({ error: '비공개 문서는 편집할 수 없습니다.', is_private: true }, 403);
        }

        // edit_acl 평가 — admin_only 플래그가 없으면 관리자는 우회. 비공개 단계를 통과한 뒤 검사한다.
        const aclParsed = parseEditAcl(existing.edit_acl);
        if (aclParsed && aclParsed.flags.length > 0) {
            const hasAdminOnly = aclParsed.flags.includes('admin_only');
            if (!isAdmin || hasAdminOnly) {
                const minAge = await getEditAclMinAgeDays(db);
                const ev = await evaluateEditAcl(db, aclParsed, user, existing.id, minAge, isAdmin);
                if (!ev.allowed) {
                    const isAdminOnlyFail = ev.decisive === 'admin_only';
                    return c.json({
                        error: isAdminOnlyFail
                            ? '이 문서는 관리자만 편집할 수 있습니다.'
                            : '이 문서를 편집할 권한이 부족합니다.',
                        edit_acl: aclParsed,
                        min_age_days: minAge,
                    }, 403);
                }
            }
        }

        // 권한에 따른 비공개 상태 결정
        finalIsPrivate = rbac.can(user.role, 'wiki:private') ? (body.is_private ?? existing.is_private) : existing.is_private;
        // edit_acl 은 관리자(admin:access)만 변경 가능, 그리고 body 에 명시적으로 보낸 경우에만 갱신한다.
        // 평범한 본문 저장이 request 시작 시점에 읽은 stale 값을 UPDATE 절에서 다시 써버려 admin 의 ACL 갱신을
        // silent 하게 되돌리는 race 를 방지. 변경 의도가 없는 경우 column 자체를 UPDATE 에서 제외한다.
        const adminExplicitlySetEditAcl = isAdmin && requestedEditAcl.provided;
        let layeredAcl: EditAcl | null = adminExplicitlySetEditAcl
            ? requestedEditAcl.value
            : parseEditAcl(existing.edit_acl);

        // 카테고리 ACL 머지 — 사용자가 chip 을 "새로 추가" 한 시점에 선택한 모드만 적용.
        // category_acl_choices 키 자체가 없으면 (레거시 클라이언트) 자동 적용 건너뜀.
        //
        // 보안 1: 이미 페이지에 속한 카테고리에 대한 choice 는 무시한다. 그렇지 않으면 비관리자가
        // body.category 를 그대로 두고 choices 만 위조해 (e.g. {"ExistingCat":"overwrite"})
        // 페이지 edit_acl 을 임의로 갈아치울 수 있어 관리자만 변경 가능한 edit_acl 정책을 우회한다.
        //
        // 보안 2: 비관리자의 'overwrite' 모드는 'merge' 로 다운그레이드한다. overwrite 는 관리자가 설정한
        // 강한 ACL 을 카테고리 템플릿(약한 ACL) 로 통째 교체할 수 있어 ACL 약화를 일으킨다.
        // merge 는 flag 합집합(AND 평가)이므로 결과는 절대 약해지지 않는다.
        let categoryAclMutated = false;
        if (body.category_acl_choices && typeof body.category_acl_choices === 'object' && !Array.isArray(body.category_acl_choices)) {
            const choices = body.category_acl_choices as Record<string, unknown>;
            const explicitCats = splitCategoryString(body.category);
            // 현재 페이지에 이미 적용된 카테고리 목록을 조회해 "이번 요청에서 신규 추가된" 것만 후보로 삼는다.
            const existingCatRows = await db
                .prepare('SELECT category FROM page_categories WHERE page_id = ?')
                .bind(existing.id)
                .all<{ category: string }>();
            const existingCatSet = new Set((existingCatRows.results || []).map(r => r.category));
            const newlyAdded = explicitCats.filter(c => !existingCatSet.has(c));
            const targets = newlyAdded.filter(c => Object.prototype.hasOwnProperty.call(choices, c));
            if (targets.length > 0) {
                const templates = await getCategoryAclsBatch(db, targets);
                for (const cat of targets) {
                    const tpl = templates.get(cat);
                    if (!tpl) continue;
                    let mode: CategoryAclMode = normalizeCategoryAclMode(choices[cat]);
                    if (!isAdmin && mode === 'overwrite') mode = 'merge';
                    if (mode === 'ignore') continue;
                    layeredAcl = applyCategoryAclToPage(layeredAcl, tpl, mode);
                    categoryAclMutated = true;
                }
            }
        }

        const willUpdateEditAcl = adminExplicitlySetEditAcl || categoryAclMutated;
        finalEditAcl = willUpdateEditAcl ? serializeEditAcl(layeredAcl) : existing.edit_acl;

        // ── 기존 문서 수정 ──
        // Optimistic Locking 체크
        if (body.expected_version !== undefined && body.expected_version !== existing.version) {
            // 내용이 완전히 동일하면 충돌로 보지 않고 진행 (Idempotent).
            // 레거시 저장 본문은 CRLF 일 수 있으므로 비교 양쪽을 LF 로 정규화한다.
            // (요청 본문은 이미 위에서 정규화됨)
            const existingNormalized = (existing.content || '').replace(/\r\n?/g, '\n');
            if (body.content !== existingNormalized) {
                return c.json(
                    {
                        error: '편집 충돌이 발생했습니다. 다른 사용자가 문서를 수정했습니다.',
                        current_version: existing.version,
                        content: existingNormalized
                    },
                    409
                );
            }
        }

        const newVersion = existing.version + 1;

        // R2-only 네임스페이스 여부 확인
        const enabledExtensionsEdit = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
        const isR2Only = isR2OnlyNamespace(slug, enabledExtensionsEdit);

        // Optimistic Locking 체크 시, R2-only 문서인 경우 R2에서 실제 본문을 가져와 비교
        if (body.expected_version !== undefined && body.expected_version !== existing.version) {
            let currentActualContent = existing.content;
            if (isR2Only && (!currentActualContent || currentActualContent === '')) {
                if (existing.id) {
                    const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE page_id = ? AND page_version = ?').bind(existing.id, existing.version).first<{ content: string, r2_key: string | null }>();
                    if (lastRev) {
                        currentActualContent = await getRevisionContent(c.env.MEDIA, lastRev, new URL(c.req.url).origin);
                    }
                }
            }
            // 레거시 저장본은 CRLF 일 수 있으므로 비교/응답 양쪽을 LF 로 정규화.
            const currentNormalized = (currentActualContent || '').replace(/\r\n?/g, '\n');

            // 내용이 완전히 동일하면 충돌로 보지 않고 진행 (Idempotent)
            if (body.content !== currentNormalized) {
                return c.json(
                    {
                        error: '편집 충돌이 발생했습니다. 다른 사용자가 문서를 수정했습니다.',
                        current_version: existing.version,
                        content: currentNormalized
                    },
                    409
                );
            }
        }

        // ── 사람 편집 보류(pending changes) 분기 ──
        // 전역 토글이 켜져 있고 편집자가 신뢰되지 않으면(비-aged·이 문서 미편집·비관리자)
        // 즉시 리비전을 만들지 않고 검토 대기로 보류한다. 공개 화면은 마지막 승인본을 유지.
        // ACL·비공개·동시편집 검증을 모두 통과한 직후 분기하므로, 보류본도 동일 사전조건을 만족한다.
        if (await getPendingChangesEnabled(db)) {
            const minAge = await getEditAclMinAgeDays(db);
            if (!(await isTrustedEditor(db, user, existing.id, minAge, isAdmin))) {
                const finalTitleHold = hasTitleInBody ? requestedTitle ?? null : existing.title;
                const pendingEditId = await holdPendingEdit(c, user, {
                    pageId: existing.id,
                    slug,
                    action: 'update',
                    baseRevisionId: existing.last_revision_id,
                    baseVersion: existing.version,
                    content: body.content,
                    category: body.category || null,
                    redirectTo: body.redirect_to || null,
                    title: finalTitleHold,
                    hasTitleChange: hasTitleInBody,
                    summary: body.summary ?? null,
                    // 현재 페이지 또는 이번 편집 결과가 비공개면 비공개로 게이팅(둘 중 하나라도 비공개면 비공개 문서 본문 노출 방지).
                    isPrivate: existing.is_private === 1 || finalIsPrivate === 1,
                    // direct-save 가 edit_acl 을 쓰는 경우(willUpdateEditAcl: 카테고리 ACL 머지 등)만 승인 시 적용.
                    editAcl: finalEditAcl,
                    applyEditAcl: willUpdateEditAcl,
                    // direct-save 는 body 에 layout_mode 키가 있을 때만 layout_mode 를 쓴다(hasLayoutInBody).
                    layoutMode: hasLayoutInBody ? (requestedLayout ?? null) : null,
                    applyLayout: hasLayoutInBody,
                    // update 의 카테고리 ACL 머지 결과는 edit_acl 로 이미 캡처되므로 choices 재생 불필요.
                    categoryAclChoices: null,
                });
                return c.json(safeJSON({ pending: true, slug, pending_edit_id: pendingEditId }));
            }
        }

        // 1. 리비전 본문을 R2에 먼저 업로드
        let r2Key: string;
        try {
            r2Key = await uploadRevisionToR2(c.env.MEDIA, existing.id, newVersion, body.content);
        } catch (e) {
            console.error('R2 revision upload failed:', e);
            return c.json({ error: '리비전 저장에 실패했습니다. 잠시 후 다시 시도해주세요.' }, 500);
        }

        // 2. D1에 리비전 메타데이터 삽입 (content는 빈 문자열, r2_key 저장)
        let revisionId: number;
        try {
            const revResult = await db
                .prepare(
                    'INSERT INTO revisions (page_id, page_version, content, r2_key, summary, author_id) VALUES (?, ?, ?, ?, ?, ?)'
                )
                .bind(existing.id, newVersion, '', r2Key, body.summary ?? null, user.id)
                .run();
            revisionId = revResult.meta.last_row_id;
        } catch (e) {
            // D1 실패 시 업로드한 R2 파일 롤백
            await c.env.MEDIA.delete(r2Key).catch(() => {});
            console.error('D1 revision insert failed:', e);
            return c.json({ error: '리비전 저장에 실패했습니다. 잠시 후 다시 시도해주세요.' }, 500);
        }

        // 3. 페이지 업데이트 (pages.content는 R2-only가 아닐 때만 최신 본문 유지)
        const contentToStore = isR2Only ? '' : body.content;
        const metrics = computePageMetricsTracked(body.content, isR2Only);
        // title: body 에 명시된 경우만 변경(기존 유지). normalizeTitleInput 결과(null) 가
        // 명시된 경우 NULL 로 저장돼 슬러그가 다시 표시 이름으로 노출된다.
        const finalTitle = hasTitleInBody ? requestedTitle ?? null : existing.title;
        try {
            // SET 절을 동적으로 구성한다. edit_acl 은 admin 이 명시적으로 변경 요청한 경우에만,
            // layout_mode 는 body 에 키가 명시된 경우에만 포함한다(그 외 케이스는 column 을 손대지 않아
            // 다른 경로의 갱신을 stale 값으로 덮어쓰는 race 를 회피). 바인드 순서는 placeholder 순서와 일치.
            const setClauses: string[] = ['content = ?', 'title = ?', 'category = ?', 'is_private = ?'];
            const setBinds: (string | number | null)[] = [contentToStore, finalTitle, body.category || null, finalIsPrivate];
            if (willUpdateEditAcl) {
                setClauses.push('edit_acl = ?');
                setBinds.push(finalEditAcl);
            }
            if (hasLayoutInBody) {
                setClauses.push('layout_mode = ?');
                setBinds.push(requestedLayout ?? null);
            }
            setClauses.push('redirect_to = ?', 'last_revision_id = ?', 'version = ?', 'rows = ?', 'characters = ?', 'updated_at = unixepoch()');
            setBinds.push(body.redirect_to || null, revisionId, newVersion, metrics.rows, metrics.characters);
            const updateSql = `UPDATE pages SET ${setClauses.join(', ')} WHERE id = ?`;
            await db.prepare(updateSql).bind(...setBinds, existing.id).run();
        } catch (e: any) {
            // UPDATE 실패 시 (예: title 의 idx_pages_title_unique race) 막 만든 리비전 / R2 객체를 정리해
            // 고아 본문이 남지 않게 한다. UNIQUE 위반(SQLITE_CONSTRAINT) 은 409 로 매핑, 그 외는 500.
            await db.prepare('DELETE FROM revisions WHERE id = ?').bind(revisionId).run().catch(() => {});
            await c.env.MEDIA.delete(r2Key).catch(() => {});
            const msg = String(e?.message || e);
            if (/UNIQUE|constraint/i.test(msg) && /title/i.test(msg)) {
                console.error('D1 page UPDATE failed due to title UNIQUE race:', e);
                return c.json({ error: '대체 제목이 다른 문서와 충돌했습니다. 잠시 후 다시 시도해주세요.' }, 409);
            }
            console.error('D1 page UPDATE failed:', e);
            return c.json({ error: '문서 저장에 실패했습니다. 잠시 후 다시 시도해주세요.' }, 500);
        }

        // page_links, page_categories 갱신 (비동기)
        const linkCatStmts = buildLinkAndCategoryStatements(db, existing.id, body.content, body.category || null);
        c.executionCtx.waitUntil(db.batch(linkCatStmts).catch(e => console.error('Failed to update links/categories:', e)));

        // 주시자에게 알림 발송 (비동기)
        // fan-out 대상:
        //   1) page_watches: 정확히 이 문서를 주시하는 유저 (scope 무관)
        //   2) page_watches scope='subtree': 이 문서의 상위 문서(slug prefix 매치) 를
        //      subtree 로 주시하는 유저
        //   3) category_watches: 이 문서가 속한 카테고리(= body.category) 를 주시하는 유저
        //      page_categories 가 비동기로 갱신되므로 그 테이블을 읽지 않고
        //      방금 저장한 본문의 카테고리 목록을 직접 넘긴다.
        const editedCategories = (body.category || '')
            .split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0);
        c.executionCtx.waitUntil(
            collectPageEditWatchers(
                db,
                existing.id,
                slug,
                user.id,
                editedCategories,
                finalIsPrivate === 1,
                c.env,
                rbac,
            )
                .then(async watchers => {
                    if (watchers.length === 0) return;
                    const watchLink = `/w/${encodeURIComponent(slug)}?mode=revisions&diff=${revisionId}`;
                    const rawSummary = (body.summary ?? '').trim();
                    const truncatedSummary = [...rawSummary].length > 15
                        ? [...rawSummary].slice(0, 15).join('') + '...'
                        : rawSummary;
                    const summarySuffix = truncatedSummary ? ` (${truncatedSummary})` : '';
                    const notifContent = `${user.name}님이 "${slug}" 문서를 편집했습니다.${summarySuffix}`;
                    await createNotifications(c.env, c.executionCtx, watchers.map(uid => ({
                        userId: uid,
                        type: 'page_watch',
                        content: notifContent,
                        link: watchLink,
                        push: {
                            title: `${slug}`,
                            body: notifContent,
                            url: watchLink,
                            tag: `page_watch:${existing.id}`,
                        },
                    })));
                })
                .catch(e => console.error('Failed to notify watchers:', e))
        );

        // 캐시 무효화 (API + SSR) + 최근 변경 즉시 갱신
        // 콜론이 포함된 문서(틀, 익스텐션 등)인 경우 역링크 문서 캐시도 함께 무효화
        c.executionCtx.waitUntil(Promise.allSettled([
            invalidatePageCache(c, slug),
            refreshRecentChangesCache(c),
            invalidateBacklinkCaches(c, slug, db),
        ]));

        return c.json(safeJSON({ slug, version: newVersion, revision_id: revisionId }));
    } else {
        finalIsPrivate = rbac.can(user.role, 'wiki:private') ? (body.is_private ?? 0) : 0;
        // edit_acl 은 관리자만 직접 지정 가능. 비관리자가 만든 신규 문서는 NULL 로 시작(아래 prefix 룰이 덮어쓸 수 있음).
        finalEditAcl = isAdmin
            ? (requestedEditAcl.provided ? serializeEditAcl(requestedEditAcl.value) : null)
            : null;

        // ── 새 문서 생성 ──
        const enabledExtensionsCreate = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
        const isR2Only = isR2OnlyNamespace(slug, enabledExtensionsCreate);
        const contentToStore = isR2Only ? '' : body.content;

        // 자동 prefix 룰 / 카테고리 ACL 머지 — MCP 제출안 승인(create) 과 공유되는 헬퍼.
        // - is_private / edit_acl 은 관리자가 작성한 prefix 룰이므로 생성자 RBAC 검사를 우회해 강제 적용한다.
        //   비관리자의 body.is_private 입력은 위에서 이미 0 으로 마스크되어 있으므로 추가 처리 불필요.
        // - edit_acl 은 관리자가 body 에 키를 명시한 경우(requestedEditAcl.provided=true) 그 의도를 보존한다.
        const adminExplicitlySetEditAcl = isAdmin && requestedEditAcl.provided;
        const categoryAclChoicesRaw = (body.category_acl_choices && typeof body.category_acl_choices === 'object' && !Array.isArray(body.category_acl_choices))
            ? (body.category_acl_choices as Record<string, unknown>)
            : null;
        const prefixed = await applyCreatePrefixRulesAndCategoryAcls(db, slug, {
            category: body.category || null,
            isPrivate: finalIsPrivate,
            editAcl: finalEditAcl,
            adminExplicitlySetEditAcl,
            categoryAclChoices: categoryAclChoicesRaw,
            isAdmin: !!isAdmin,
        });
        let effectiveCategory = prefixed.effectiveCategory;
        finalIsPrivate = prefixed.finalIsPrivate;
        finalEditAcl = prefixed.finalEditAcl;

        // 새 ACL 이 적용된 신규 페이지를 생성하기 전에, 생성자(비관리자)가 그 ACL 을 통과하는지 검증한다.
        // 신규 페이지이므로 page_editor 플래그는 항상 false 로 평가 (pageId=null).
        // 관리자(admin:access)는 admin_only 가 없는 ACL 을 우회 — admin:access 는 자기 자신이 직접 작성한
        // ACL 도 만족하지 못할 수 있으므로 관리자 우회가 없으면 신규 ACL 자체를 만들 수 없게 된다.
        if (finalEditAcl) {
            const aclForCreate = parseEditAcl(finalEditAcl);
            if (aclForCreate && aclForCreate.flags.length > 0) {
                const hasAdminOnly = aclForCreate.flags.includes('admin_only');
                if (!isAdmin || hasAdminOnly) {
                    const minAge = await getEditAclMinAgeDays(db);
                    const ev = await evaluateEditAcl(db, aclForCreate, user, null, minAge, isAdmin);
                    if (!ev.allowed) {
                        const isAdminOnlyFail = ev.decisive === 'admin_only';
                        return c.json({
                            error: isAdminOnlyFail
                                ? '이 슬러그로 시작하는 문서는 관리자만 새로 생성할 수 있습니다.'
                                : '이 슬러그로 시작하는 문서는 ACL 정책상 새로 생성할 수 없습니다.',
                            edit_acl: aclForCreate,
                            min_age_days: minAge,
                        }, 403);
                    }
                }
            }
        }

        // ── 사람 편집 보류(pending changes) 분기 (신규 문서 생성) ──
        // 전역 토글이 켜져 있고 생성자가 신뢰되지 않으면 페이지를 만들지 않고 보류한다.
        // pageId=null·base_version=0 으로 저장하며, 승인 시 applyNewPageInsert 가 prefix/카테고리 ACL 을 재적용한다.
        // 보류본은 body.category(raw) 를 저장하고, 승인 시점에 prefix 룰을 다시 평가한다.
        if (await getPendingChangesEnabled(db)) {
            const minAge = await getEditAclMinAgeDays(db);
            if (!(await isTrustedEditor(db, user, null, minAge, isAdmin))) {
                const pendingEditId = await holdPendingEdit(c, user, {
                    pageId: null,
                    slug,
                    action: 'create',
                    baseRevisionId: null,
                    baseVersion: 0,
                    content: body.content,
                    category: body.category || null,
                    redirectTo: body.redirect_to || null,
                    title: requestedTitle ?? null,
                    hasTitleChange: !!requestedTitle,
                    summary: body.summary ?? null,
                    isPrivate: finalIsPrivate === 1,
                    // create 승인은 applyNewPageInsert 가 prefix/카테고리 ACL 을 재평가하므로 저장된 edit_acl 을 쓰지 않는다.
                    editAcl: null,
                    applyEditAcl: false,
                    // direct-create 는 항상 layout_mode 를 INSERT 하므로 보류 create 도 항상 적용한다.
                    layoutMode: requestedLayout ?? null,
                    applyLayout: true,
                    // direct-create 가 받은 category_acl_choices 를 그대로 저장해 승인 시 재생(ignore/merge 등 보존).
                    categoryAclChoices: categoryAclChoicesRaw ? JSON.stringify(categoryAclChoicesRaw) : null,
                });
                return c.json(safeJSON({ pending: true, slug, pending_edit_id: pendingEditId, created: false }));
            }
        }

        const metrics = computePageMetricsTracked(body.content, isR2Only);
        const newDocTitle = requestedTitle ?? null;
        let pageResult;
        try {
            pageResult = await db
                .prepare(
                    'INSERT INTO pages (slug, title, content, category, is_private, edit_acl, redirect_to, rows, characters, layout_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                )
                .bind(slug, newDocTitle, contentToStore, effectiveCategory, finalIsPrivate, finalEditAcl, body.redirect_to || null, metrics.rows, metrics.characters, requestedLayout ?? null)
                .run();
        } catch (e: any) {
            // UNIQUE race (slug 의 UNIQUE 또는 idx_pages_title_unique) — precheck 와 INSERT 사이에
            // 다른 요청이 같은 slug/title 을 가져간 경우. 500 대신 409 로 매핑해 클라이언트가 재시도 안내.
            const msg = String(e?.message || e);
            if (/UNIQUE|constraint/i.test(msg)) {
                console.error('Page INSERT failed due to UNIQUE race:', e);
                if (/title/i.test(msg)) {
                    return c.json({ error: '대체 제목이 다른 문서와 충돌했습니다. 잠시 후 다시 시도해주세요.' }, 409);
                }
                return c.json({ error: '같은 제목의 문서가 동시에 생성되었습니다. 다시 시도해주세요.' }, 409);
            }
            throw e;
        }

        const pageId = pageResult.meta.last_row_id;

        // 첫 리비전 생성
        // 1. R2 업로드
        let firstR2Key: string;
        try {
            firstR2Key = await uploadRevisionToR2(c.env.MEDIA, pageId, 1, body.content);
        } catch (e) {
            // R2 실패 시 방금 생성한 페이지 롤백
            await db.prepare('DELETE FROM pages WHERE id = ?').bind(pageId).run().catch(() => {});
            console.error('R2 first revision upload failed:', e);
            return c.json({ error: '리비전 저장에 실패했습니다. 잠시 후 다시 시도해주세요.' }, 500);
        }

        // 2. D1 리비전 삽입
        let revisionId: number;
        try {
            const revResult = await db
                .prepare(
                    'INSERT INTO revisions (page_id, page_version, content, r2_key, summary, author_id) VALUES (?, ?, ?, ?, ?, ?)'
                )
                .bind(pageId, 1, '', firstR2Key, body.summary ?? null, user.id)
                .run();
            revisionId = revResult.meta.last_row_id;
        } catch (e) {
            await c.env.MEDIA.delete(firstR2Key).catch(() => {});
            await db.prepare('DELETE FROM pages WHERE id = ?').bind(pageId).run().catch(() => {});
            console.error('D1 first revision insert failed:', e);
            return c.json({ error: '리비전 저장에 실패했습니다. 잠시 후 다시 시도해주세요.' }, 500);
        }

        // last_revision_id 업데이트
        await db
            .prepare('UPDATE pages SET last_revision_id = ? WHERE id = ?')
            .bind(revisionId, pageId)
            .run();

        // page_links, page_categories 갱신 (비동기)
        const linkCatStmts = buildLinkAndCategoryStatements(db, pageId, body.content, effectiveCategory);
        c.executionCtx.waitUntil(db.batch(linkCatStmts).catch(e => console.error('Failed to update links/categories:', e)));

        // 캐시 무효화 (API + SSR) + 최근 변경 즉시 갱신
        // 콜론이 포함된 문서(틀, 익스텐션 등)인 경우 역링크 문서 캐시도 함께 무효화
        c.executionCtx.waitUntil(Promise.allSettled([
            invalidatePageCache(c, slug),
            refreshRecentChangesCache(c),
            invalidateBacklinkCaches(c, slug, db),
        ]));

        return c.json(safeJSON({ slug, version: 1, revision_id: revisionId }), 201);
    }
});

/**
 * GET /w/category/:category
 * 카테고리별 문서 목록 (page_categories 테이블 기반)
 * - 그룹핑/정렬/페이지네이션은 모두 클라이언트가 수행하므로 서버는 전체 행을 단일 응답으로 반환
 *   (SQLite 정렬은 ASCII 기반 NOCASE 라 한글/일본어/알파벳 혼합 그룹 순서와 일치시키기 어렵다)
 */
wiki.get('/w/category/:category', async (c) => {
    const category = c.req.param('category');
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const canSeePrivate = rbac.can(user?.role ?? 'guest', 'wiki:private');
    const privateFilter = canSeePrivate ? '' : ' AND p.is_private = 0';

    const query = `
        SELECT p.slug, p.updated_at
        FROM page_categories pc
        JOIN pages p ON pc.page_id = p.id
        WHERE p.deleted_at IS NULL${privateFilter}
          AND pc.category = ?
        ORDER BY p.slug ASC
    `;

    const { results } = await db
        .prepare(query)
        .bind(category)
        .all();

    return c.json(safeJSON({ pages: results, total: results.length }));
});

/**
 * GET /w/:slug/revisions
 * 리비전 목록
 */
wiki.get('/w/:slug/revisions', async (c) => {
    const slug = c.req.param('slug');
    const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10));
    const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '10', 10)));
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = user && rbac.can(user.role, 'admin:access');

    const canSeePrivate = rbac.can(user?.role ?? 'guest', 'wiki:private');
    const page = await db
        .prepare('SELECT id, deleted_at, is_private FROM pages WHERE slug = ?')
        .bind(slug)
        .first<{ id: number; deleted_at: number | null; is_private: number }>();

    if (!page || (page.deleted_at && !isAdmin)) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    if (page.is_private === 1 && !canSeePrivate) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    // 비관리자에게는 삭제된 리비전 행 자체가 존재하지 않는 것처럼 가린다.
    const revDeletedFilter = isAdmin ? '' : ' AND r.deleted_at IS NULL';
    const countDeletedFilter = isAdmin ? '' : ' AND deleted_at IS NULL';
    // fully_purged: 백엔드 하드 삭제 핸들러의 "완전히 정리됨" 가드와 동일 식.
    // 부분 실패 상태(r2_key 남음 또는 content 남음)면 false 가 되어 UI 가 retry 버튼을 노출.
    const adminCols = isAdmin
        ? `, r.deleted_at, r.purged_at,
           (CASE WHEN r.purged_at IS NOT NULL AND r.r2_key IS NULL AND r.content = '' THEN 1 ELSE 0 END) AS fully_purged`
        : '';

    const [countResult, listResult] = await db.batch([
        db.prepare(`SELECT COUNT(*) as total FROM revisions WHERE page_id = ?${countDeletedFilter}`).bind(page.id),
        db
            .prepare(
                `SELECT r.id, r.page_version, r.summary, r.created_at, u.id as author_id, u.name as author_name, u.picture as author_picture,
                        ${ROLE_CASE_SQL} as author_role,
                        u.email as _author_email${adminCols}
           FROM revisions r
           LEFT JOIN users u ON r.author_id = u.id
           WHERE r.page_id = ?${revDeletedFilter}
           ORDER BY r.created_at DESC
           LIMIT ? OFFSET ?`
            )
            .bind(page.id, limit, offset),
    ]);

    const rawTotal = (countResult.results[0] as any)?.total;
    const parsedTotal = Number(rawTotal);
    const total = Number.isFinite(parsedTotal) ? parsedTotal : 0;

    enrichRoles(listResult.results, 'author_role', '_author_email', c.env);

    // 최신 리비전은 삭제 불가 — 클라이언트가 액션 버튼을 비활성화 할 수 있도록 동봉.
    const lastRevisionId = isAdmin
        ? (await db.prepare('SELECT last_revision_id FROM pages WHERE id = ?').bind(page.id)
            .first<{ last_revision_id: number | null }>())?.last_revision_id ?? null
        : null;

    return c.json(safeJSON({
        revisions: listResult.results,
        total,
        is_admin_view: isAdmin,
        last_revision_id: lastRevisionId,
        can_hard_delete: !!user && rbac.can(user.role, '*'),
    }));
});

/**
 * GET /w/:slug/revisions/:id
 * 특정 리비전 내용
 */
wiki.get('/w/:slug/revisions/:id', async (c) => {
    const revId = parseInt(c.req.param('id'));
    const slug = c.req.param('slug');
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = user && rbac.can(user.role, 'admin:access');
    const canSeePrivate = rbac.can(user?.role ?? 'guest', 'wiki:private');

    const page = await db
        .prepare('SELECT id, deleted_at, is_private FROM pages WHERE slug = ?')
        .bind(slug)
        .first<{ id: number; deleted_at: number | null; is_private: number }>();

    if (!page || (page.deleted_at && !isAdmin)) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    if (page.is_private === 1 && !canSeePrivate) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    const revision = await db
        .prepare(
            `SELECT r.id, r.page_id, r.page_version, r.content, r.r2_key, r.summary, r.author_id, r.created_at,
                    r.deleted_at, r.purged_at,
                    u.name as author_name
       FROM revisions r
       LEFT JOIN users u ON r.author_id = u.id
       WHERE r.id = ? AND r.page_id = ?`
        )
        .bind(revId, page.id)
        .first<{ id: number; page_id: number; page_version: number | null; content: string; r2_key: string | null; summary: string | null; author_id: number | null; created_at: number; deleted_at: number | null; purged_at: number | null; author_name: string | null }>();

    if (!revision) {
        return c.json({ error: '리비전을 찾을 수 없습니다.' }, 404);
    }

    // 비관리자에게는 삭제된 리비전이 존재하지 않는 것처럼 보여야 한다.
    if (revision.deleted_at && !isAdmin) {
        return c.json({ error: '리비전을 찾을 수 없습니다.' }, 404);
    }

    // 하드 삭제된 리비전은 R2 본문이 없으므로 빈 본문으로 반환 (관리자 전용 경로).
    if (revision.purged_at) {
        return c.json(safeJSON({
            ...revision,
            content: '',
            purged: true,
        }));
    }

    // r2_key가 있으면 R2에서 본문 조회
    const origin = new URL(c.req.url).origin;
    const content = await getRevisionContent(c.env.MEDIA, revision, origin);

    return c.json(safeJSON({ ...revision, content }));
});

/**
 * GET /w/:slug/revisions/:id/diff
 * 특정 리비전과 이전 리비전의 내용을 비교용으로 반환
 */
wiki.get('/w/:slug/revisions/:id/diff', async (c) => {
    const revId = parseInt(c.req.param('id'));
    const slug = c.req.param('slug');
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = user && rbac.can(user.role, 'admin:access');
    const canSeePrivate = rbac.can(user?.role ?? 'guest', 'wiki:private');

    const page = await db
        .prepare('SELECT id, deleted_at, is_private FROM pages WHERE slug = ?')
        .bind(slug)
        .first<{ id: number; deleted_at: number | null; is_private: number }>();

    if (!page || (page.deleted_at && !isAdmin)) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    if (page.is_private === 1 && !canSeePrivate) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    // 해당 리비전 조회
    const revision = await db
        .prepare(
            `SELECT id, page_version, content, r2_key, page_id, created_at, deleted_at, purged_at
       FROM revisions
       WHERE id = ? AND page_id = ?`
        )
        .bind(revId, page.id)
        .first<{ id: number; page_version: number | null; content: string; r2_key: string | null; page_id: number; created_at: number; deleted_at: number | null; purged_at: number | null }>();

    if (!revision || (revision.deleted_at && !isAdmin)) {
        return c.json({ error: '리비전을 찾을 수 없습니다.' }, 404);
    }

    // 바로 이전 리비전 조회 — 비관리자에게는 살아있는(=deleted_at IS NULL) 직전 리비전과
    // 짝지어 연속 삭제된 리비전을 자동으로 건너뛴다.
    const prevQuery = isAdmin
        ? `SELECT id, page_version, content, r2_key, deleted_at, purged_at FROM revisions
           WHERE page_id = ? AND id < ?
           ORDER BY id DESC LIMIT 1`
        : `SELECT id, page_version, content, r2_key, deleted_at, purged_at FROM revisions
           WHERE page_id = ? AND id < ? AND deleted_at IS NULL
           ORDER BY id DESC LIMIT 1`;
    const prevRevision = await db
        .prepare(prevQuery)
        .bind(revision.page_id, revId)
        .first<{ id: number; page_version: number | null; content: string; r2_key: string | null; deleted_at: number | null; purged_at: number | null }>();

    // R2 or D1에서 본문 조회 — 하드 삭제된(purged) 리비전은 본문이 비어있으므로 R2 호출을 건너뛴다.
    const origin = new URL(c.req.url).origin;
    const fetchContent = (rev: { content: string; r2_key: string | null; purged_at: number | null }) =>
        rev.purged_at ? Promise.resolve('') : getRevisionContent(c.env.MEDIA, rev, origin);
    const [newContent, oldContent] = await Promise.all([
        fetchContent(revision),
        prevRevision ? fetchContent(prevRevision) : Promise.resolve(''),
    ]);

    return c.json(safeJSON({
        old_content: oldContent,
        new_content: newContent,
        old_revision_id: prevRevision?.id ?? null,
        new_revision_id: revision.id,
        old_page_version: prevRevision?.page_version ?? null,
        new_page_version: revision.page_version ?? null,
    }));
});

/**
 * GET /w/:slug/subdocs
 * 하위 문서 목록 (제목이 '{slug}/'로 시작하는 문서들)
 * - ?immediate=1 → 바로 아래 단계 자식만 (slug/A 만, slug/A/B 제외)
 */
wiki.get('/w/:slug/subdocs', async (c) => {
    const slug = c.req.param('slug');
    const immediate = c.req.query('immediate') === '1';
    // public_only=1 → 열람 권한과 무관하게 비공개 문서를 항상 제외한다.
    // (예: 에디터의 "하위 문서 구조 삽입"은 결과 링크가 모든 독자에게 노출되므로 공개 문서만 삽입)
    const publicOnly = c.req.query('public_only') === '1';
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const canSeePrivate = !publicOnly && rbac.can(user?.role ?? 'guest', 'wiki:private');
    const privateFilter = canSeePrivate ? '' : ' AND is_private = 0';

    if (immediate) {
        // LIKE 와일드카드(%, _, \) 가 슬러그에 포함되어 있을 때 임의 매칭되지 않도록 이스케이프
        const escaped = slug.replace(/[\\%_]/g, (ch) => '\\' + ch);
        const query = `
            SELECT slug, updated_at
            FROM pages
            WHERE deleted_at IS NULL${privateFilter}
              AND slug LIKE ? ESCAPE '\\'
              AND slug NOT LIKE ? ESCAPE '\\'
            ORDER BY slug ASC LIMIT 200
        `;
        const { results } = await db
            .prepare(query)
            .bind(escaped + '/%', escaped + '/%/%')
            .all();
        return c.json(safeJSON({ subdocs: results }));
    }

    const query = `
        SELECT slug, updated_at
        FROM pages
        WHERE deleted_at IS NULL${privateFilter}
          AND slug LIKE ?
        ORDER BY slug ASC LIMIT 200
    `;

    const { results } = await db
        .prepare(query)
        .bind(slug + '/%')
        .all();

    return c.json(safeJSON({ subdocs: results }));
});

/**
 * GET /w/:slug/nav-tree
 * docs 레이아웃 좌측 그룹 nav 사이드바용 트리. 그룹 루트는 슬러그 첫 세그먼트(`slug.split('/')[0]`).
 * - 콜론 네임스페이스(`틀:`/`이미지:`)는 '/' 로 끊기지 않아 그대로 그룹 루트에 포함된다.
 * - `map:` 가상 슬러그는 빈 트리를 반환해 클라이언트가 nav 를 숨기도록 한다.
 * - 응답에 isCurrent 는 포함하지 않는다 — 같은 그룹의 문서들이 캐시를 공유하도록, 현재 문서
 *   하이라이트는 클라이언트가 slug 매칭으로 처리한다. (캐시/권한 정책은 map: 분기와 동일)
 */
wiki.get('/w/:slug/nav-tree', async (c) => {
    // 비공개 위키(WIKI_VISIBILITY=closed)에서는 비로그인 사용자가 그룹 트리로 슬러그 구조를
    // 열람·열거할 수 없도록 캐시/DB 접근 전에 차단한다 (/api/w/:slug 등 다른 읽기 API 와 동일).
    if (c.env.WIKI_VISIBILITY === 'closed' && !c.get('user')) {
        return c.json({ error: '로그인이 필요합니다.' }, 401);
    }
    const slug = c.req.param('slug');
    const db = c.env.DB;
    const user = c.get('user');
    const cache = caches.default;
    const cacheKey = c.req.url;

    // map: 가상 문서는 그 자체가 트리 뷰이므로 그룹 nav 를 만들지 않는다.
    if (isMapNamespace(slug)) {
        return c.json(safeJSON({ groupRoot: null, truncated: false, root: null }), 200, { 'Cache-Control': 'private, no-store' });
    }

    const groupRoot = slug.split('/')[0];

    // map: 분기와 동일하게, 비로그인 요청에서만 글로벌 캐시를 조회한다(권한자가 anonymous 캐시에 갇히지 않도록).
    if (!user) {
        const cached = await cache.match(cacheKey);
        if (cached) return new Response(cached.body, cached);
    }

    const rbac = c.get('rbac') as RBAC;
    const canSeePrivate = rbac.can(user?.role ?? 'guest', 'wiki:private');
    const result = await buildGroupTree({ db, baseSlug: groupRoot, canSeePrivate });
    const payload = safeJSON({ groupRoot, truncated: result.truncated, root: result.root });

    const safeForSharedCache = !user && !result.hasPrivateChildren;
    if (safeForSharedCache) {
        // 자식 mutation 시 자동 무효화되지 않으므로 staleness 윈도우를 짧게 유지 (map: 와 동일).
        const fresh = c.json(payload, 200, { 'Cache-Control': `public, max-age=${MAP_CACHE_MAX_AGE_SECONDS}` });
        c.executionCtx.waitUntil(cache.put(cacheKey, fresh.clone()));
        return fresh;
    }
    return c.json(payload, 200, { 'Cache-Control': 'private, no-store' });
});

/**
 * GET /w/:slug/backlinks
 * 이 문서를 참조하는 문서 목록 (page_links 테이블 기반)
 * - 문서 링크: [[slug]] → link_type = 'wikilink'
 * - 틀 트랜스클루전: {{slug}} → link_type = 'template'
 */
wiki.get('/w/:slug/backlinks', async (c) => {
    const slug = c.req.param('slug');
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const isAdmin = user && rbac.can(user.role, 'admin:access');

    // page_links 테이블에서 target_slug로 검색
    const targetSlugs: string[] = [slug];

    // 틀 접두사인 경우 접두사 없는 이름으로도 검색
    const templatePrefixes = ['틀:', 'template:', '템플릿:'];
    for (const prefix of templatePrefixes) {
        if (slug.startsWith(prefix)) {
            const templateName = slug.substring(prefix.length);
            targetSlugs.push(templateName);
            break;
        }
    }

    const placeholders = targetSlugs.map(() => '?').join(', ');
    // page_links.target_slug는 extractLinks()가 '#섹션'을 제거한 뒤 저장하므로
    // 단순 IN 매칭만으로 섹션 앵커를 포함한 모든 위키링크가 포착됨
    // 관리자: soft delete된 문서도 is_deleted 플래그와 함께 반환
    // 일반 사용자: soft delete된 문서 제외 (접근 불가 + 메타데이터 노출 방지)
    let query = `
        SELECT DISTINCT p.slug, p.updated_at,
            CASE WHEN p.deleted_at IS NOT NULL THEN 1 ELSE 0 END AS is_deleted
        FROM page_links pl
        JOIN pages p ON pl.source_page_id = p.id
        WHERE p.slug != ?
          AND pl.blog = 0
          AND pl.source_type = 'page'
          AND pl.link_type IN ('wikilink', 'template', 'extension')
          AND pl.target_slug IN (${placeholders})
    `;
    if (!isAdmin) {
        query += ' AND p.deleted_at IS NULL';
    }
    const canSeePrivate = rbac.can(user?.role ?? 'guest', 'wiki:private');
    if (!canSeePrivate) {
        query += ' AND p.is_private = 0';
    }
    query += ' ORDER BY p.updated_at DESC LIMIT 100';

    const backlinks = await db
        .prepare(query)
        .bind(slug, ...targetSlugs)
        .all();

    return c.json(safeJSON({ backlinks: backlinks.results }));
});

/**
 * DELETE /w/:slug
 * 문서 삭제 (관리자 전용)
 * - super_admin: ?hard=true 시 영구 삭제 (문서, 리비전, 리다이렉트)
 * - admin/super_admin: Soft Delete
 * - "이미지:" 접두사 문서는 media 테이블로 관리되므로 이 라우트 대상이 아님.
 *   이미지 삭제는 관리자 페이지(/admin-media)에서 수행한다.
 */
wiki.delete('/w/:slug', requireAuth, async (c) => {
    const slug = c.req.param('slug');
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;
    const hard = c.req.query('hard') === 'true';

    const isAdmin = rbac.can(user.role, 'admin:access');

    // Fetch page first to check permissions
    const page = await db.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL')
        .bind(slug).first<{ id: number }>();

    if (!page) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    if (hard) {
        if (!rbac.can(user.role, '*')) {
            return c.json({ error: '영구 삭제는 최고 관리자만 가능합니다.' }, 403);
        }

        // 리비전 R2 파일 삭제
        const revisionKeys = await db.prepare('SELECT r2_key FROM revisions WHERE page_id = ? AND r2_key IS NOT NULL')
            .bind(page.id).all<{ r2_key: string }>();
        if (revisionKeys.results.length > 0) {
            await Promise.all(revisionKeys.results.map(r => c.env.MEDIA.delete(r.r2_key)));
        }

        // Hard Delete Transaction
        const batch = [
            // source_type='page' + blog=0 양쪽 필터 — 마이그레이션 backfill 이전 legacy
            // 블로그 행(source_type='page' DEFAULT + blog=1) 이 page.id 와 같은 id 일 때
            // 잘못 삭제되지 않도록 한다.
            db.prepare(
                "DELETE FROM page_links WHERE source_page_id = ? AND source_type = 'page' AND blog = 0"
            ).bind(page.id),
            db.prepare('DELETE FROM page_categories WHERE page_id = ?').bind(page.id),
            // discussions 자체는 hard delete 가 정리하지 않으므로 discussion_mutes 의
            // orphan row 를 명시적으로 정리. page_watches 는 FK ON DELETE CASCADE 로 자동.
            cleanupOrphanDiscussionMutes(db, page.id),
            db.prepare('DELETE FROM revisions WHERE page_id = ?').bind(page.id),
            db.prepare('DELETE FROM pages WHERE id = ?').bind(page.id)
        ];
        await db.batch(batch);

        // 캐시 무효화 (API + SSR) + 최근 변경 즉시 갱신
        // 틀: 등 콜론 포함 문서인 경우 역링크 문서 캐시도 함께 무효화
        c.executionCtx.waitUntil(Promise.allSettled([
            invalidatePageCache(c, slug),
            refreshRecentChangesCache(c),
            invalidateBacklinkCaches(c, slug, db),
        ]));

        // 관리자 로그 기록
        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind('hard_delete', `문서 영구 삭제: ${slug}`, user.id)
                .run().catch((e: any) => console.error('Failed to write admin log:', e))
        );

        return c.json({ message: '문서가 영구 삭제되었습니다.' });
    } else {
        // Soft delete requires wiki:delete permission
        if (!rbac.can(user.role, 'wiki:delete')) {
            return c.json({ error: '문서 삭제 권한이 없습니다.' }, 403);
        }

        // Soft Delete
        await db.prepare('UPDATE pages SET deleted_at = unixepoch() WHERE id = ?')
            .bind(page.id)
            .run();

        // 소프트삭제 후 권한 없는 유저의 stale 주시·토론 mute 정리.
        // 'deleted' 모드는 admin:access 권한 보유자만 유지한다.
        await cleanupUnauthorizedSubscriptions(db, c.env, rbac, page.id, 'deleted');

        // 캐시 무효화 (API + SSR) + 최근 변경 즉시 갱신
        // 틀: 등 콜론 포함 문서인 경우 역링크 문서 캐시도 함께 무효화
        c.executionCtx.waitUntil(Promise.allSettled([
            invalidatePageCache(c, slug),
            refreshRecentChangesCache(c),
            invalidateBacklinkCaches(c, slug, db),
        ]));

        // 관리자 로그 기록
        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind('soft_delete', `문서 삭제: ${slug}`, user.id)
                .run().catch((e: any) => console.error('Failed to write admin log:', e))
        );

        return c.json({ message: '문서가 삭제되었습니다.' });
    }
});

/**
 * POST /w/:slug/restore
 * 문서 복원 (관리자 전용)
 * - Soft Delete된 문서를 복구
 */
wiki.post('/w/:slug/restore', requireAuth, async (c) => {
    const slug = c.req.param('slug');
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;

    if (!rbac.can(user.role, 'wiki:delete')) {
        return c.json({ error: '권한이 없습니다.' }, 403);
    }

    // "이미지:" / "map:" 예약 네임스페이스는 일반 페이지로 복원될 수 없다.
    // 복원되면 가상 뷰 로직과 충돌해 접근 불가 페이지가 네임스페이스를 점유한다.
    if (slug.startsWith('이미지:')) {
        return c.json({ error: '"이미지:" 네임스페이스는 일반 문서로 복원할 수 없습니다.' }, 400);
    }
    if (slug.startsWith('map:')) {
        return c.json({ error: '"map:" 네임스페이스는 가상 트리 뷰 전용이므로 복원할 수 없습니다.' }, 400);
    }

    const page = await db.prepare('SELECT id, deleted_at FROM pages WHERE slug = ?').bind(slug).first<{ id: number; deleted_at: number | null }>();

    if (!page) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    if (!page.deleted_at) {
        return c.json({ error: '문서가 삭제된 상태가 아닙니다.' }, 400);
    }

    // 복원 (deleted_at 해제)
    await db.prepare('UPDATE pages SET deleted_at = NULL WHERE id = ?').bind(page.id).run();

    // 관리자 로그 기록
    c.executionCtx.waitUntil(
        db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
            .bind('restore', `문서 복원: ${slug}`, user.id)
            .run().catch((e: any) => console.error('Failed to write admin log:', e))
    );

    // 캐시 무효화 (API + SSR) + 최근 변경 즉시 갱신
    // 틀: 등 콜론 포함 문서인 경우 역링크 문서 캐시도 함께 무효화
    c.executionCtx.waitUntil(Promise.allSettled([
        invalidatePageCache(c, slug),
        refreshRecentChangesCache(c),
        invalidateBacklinkCaches(c, slug, db),
    ]));

    return c.json({ message: '문서가 복원되었습니다.' });
});

/**
 * POST /w/:slug/move
 * 문서 이동 (이름 변경) — 관리자 전용
 * - 기존 문서 이름(slug)을 새로운 이름으로 변경
 * - 기존 문서에 리디렉션을 생성하지 않음
 * - Backlinks FROM this page are updated to reflect the new source slug
 * - update_backlinks: true인 경우, 이 문서를 가리키던 역링크 문서들의 본문도 일괄 재작성
 */
wiki.post('/w/:slug/move', requireAdmin, async (c) => {
    const currentSlug = c.req.param('slug');
    const { new_slug, update_backlinks } = await c.req.json<{ new_slug: string; update_backlinks?: boolean }>();
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;

    if (!new_slug || new_slug.trim().length === 0) {
        return c.json({ error: '새 문서 이름을 입력해주세요.' }, 400);
    }

    // 앞뒤 공백 + 앞뒤 슬래시 제거 (슬래시는 하위 문서 구분자로만 유의미)
    const trimmedNewSlug = normalizeSlug(new_slug);
    if (!trimmedNewSlug) {
        return c.json({ error: '새 문서 이름을 입력해주세요.' }, 400);
    }

    // 동일 슬러그로의 no-op 이동 차단. findConflictingPage 는 page.id 를 제외하므로 자기 자신을
    // 잡아내지 않아, 그대로 두면 admin_log 와 백링크 재작성이 무의미하게 실행된다.
    if (trimmedNewSlug === currentSlug) {
        return c.json({ error: '새 문서 이름이 기존 이름과 동일합니다.' }, 400);
    }

    // 보안: 슬러그 금지 문자 점검
    if (SLUG_FORBIDDEN_CHARS.test(trimmedNewSlug)) {
        return c.json({ error: '제목에 사용할 수 없는 특수문자가 포함되어 있습니다.' }, 400);
    }

    // "이미지:" 네임스페이스는 media 테이블 기반 이미지 문서 전용이므로 이동 대상/출처가 될 수 없다
    if (currentSlug.startsWith('이미지:') || trimmedNewSlug.startsWith('이미지:')) {
        return c.json({ error: '"이미지:" 네임스페이스는 이미지 문서 전용이며, 일반 문서 이동 대상이 될 수 없습니다.' }, 400);
    }

    // "map:" 네임스페이스는 가상 트리 뷰 전용이므로 이동 대상/출처가 될 수 없다
    if (currentSlug.startsWith('map:') || trimmedNewSlug.startsWith('map:')) {
        return c.json({ error: '"map:" 네임스페이스는 가상 트리 뷰 전용이며, 일반 문서 이동 대상이 될 수 없습니다.' }, 400);
    }

    // 네임스페이스 이동 제한: 콜론이 포함된 문서는 다른 네임스페이스로 이동 불가
    const isNamespaceDocument = currentSlug.includes(':');
    const currentNamespace = isNamespaceDocument ? currentSlug.split(':')[0] : '';
    const newNamespace = trimmedNewSlug.includes(':') ? trimmedNewSlug.split(':')[0] : '';
    if (isNamespaceDocument && currentNamespace !== newNamespace) {
        return c.json({ error: '네임스페이스가 있는 문서는 다른 네임스페이스로 이동할 수 없습니다.' }, 400);
    }

    // 페이지 먼저 조회 — 충돌 검사에서 자기 자신을 제외해야 한다 (rename to same slug 등 idempotent 호출 안전망).
    const page = await db.prepare('SELECT id, category, is_private, edit_acl FROM pages WHERE slug = ? AND deleted_at IS NULL').bind(currentSlug).first<{ id: number, category: string | null, is_private: number, edit_acl: string | null }>();
    if (!page) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    // new_slug 가 다른 페이지의 slug 또는 title 과 충돌하는지 검사.
    // 소프트 삭제 행도 포함 — pages.slug UNIQUE 와 idx_pages_title_unique 둘 다 deleted_at 무관하게 강제.
    const moveConflict = await findConflictingPage(db, trimmedNewSlug, page.id);
    if (moveConflict) {
        const deletedSuffix = moveConflict.isDeleted ? ' (소프트 삭제 상태)' : '';
        const msg = moveConflict.matchedColumn === 'slug'
            ? `이미 존재하는 문서 이름입니다.${deletedSuffix}`
            : `'${trimmedNewSlug}' 는 이미 다른 문서의 대체 제목과 같아 사용할 수 없습니다.${deletedSuffix}`;
        return c.json({ error: msg }, 409);
    }

    if (page.is_private === 1 && !rbac.can(user.role, 'wiki:private')) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    // admin_only ACL 문서 이동은 관리자만 가능. (구 is_locked 분기 대체)
    const moveIsAdmin = rbac.can(user.role, 'admin:access');
    if (!moveIsAdmin) {
        const aclMove = parseEditAcl(page.edit_acl);
        if (aclMove && aclMove.flags.includes('admin_only')) {
            return c.json({ error: '관리자 전용 문서는 관리자만 이동할 수 있습니다.' }, 403);
        }
    }

    // Update Page Slug — pages_slug_vs_title_update / slug UNIQUE 트리거가 race 를 잡으면 409.
    try {
        await db.prepare('UPDATE pages SET slug = ? WHERE id = ?')
            .bind(trimmedNewSlug, page.id)
            .run();
    } catch (e: any) {
        const msg = String(e?.message || e);
        if (/UNIQUE|constraint/i.test(msg)) {
            console.error('Page slug UPDATE failed due to UNIQUE race:', e);
            return c.json({ error: '새 제목이 다른 문서와 충돌합니다. 다시 시도해주세요.' }, 409);
        }
        throw e;
    }

    // 자동 카테고리 prefix 룰: 새 slug 가 룰에 매칭되면 카테고리 합집합 적용
    try {
        const ruleRows = await db
            .prepare('SELECT prefix, categories FROM category_prefix_rules')
            .all<{ prefix: string; categories: string }>();
        const merged = mergeCategoriesFromRules(trimmedNewSlug, page.category, ruleRows.results || []);
        const mergedValue = merged || null;
        if (mergedValue !== (page.category ?? null)) {
            const stmts: D1PreparedStatement[] = [
                db.prepare('UPDATE pages SET category = ? WHERE id = ?').bind(mergedValue, page.id),
                ...buildCategoryOnlyStatements(db, page.id, mergedValue),
            ];
            await db.batch(stmts);
        }
    } catch (e) {
        console.error('category_prefix_rules apply failed (move):', e);
    }

    // 관리자 로그 기록
    c.executionCtx.waitUntil(
        db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
            .bind('doc_move', `문서 이름변경: ${currentSlug} → ${trimmedNewSlug}`, user.id)
            .run().catch((e: any) => console.error('Failed to write admin log:', e))
    );

    // 역링크 본문 일괄 재작성 (옵션)
    let backlinksResult: { updated: string[]; skipped: string[]; conflicts: string[]; total: number } | undefined;
    let backlinksError: string | undefined;
    if (update_backlinks === true) {
        try {
            backlinksResult = await rewriteBacklinksForRename(c, currentSlug, trimmedNewSlug, user, rbac);
        } catch (e) {
            // 이동 자체는 이미 커밋되었으므로 200을 반환하되, 실패 사실을 응답 본문으로 명시해
            // 관리자가 역링크가 갱신되지 않았음을 인지할 수 있게 한다.
            console.error('rewriteBacklinksForRename failed:', e);
            backlinksError = e instanceof Error ? e.message : String(e);
            // 관리자 로그에도 실패 기록 남김
            c.executionCtx.waitUntil(
                db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                    .bind(
                        'doc_move_backlinks_error',
                        `역링크 일괄 갱신 실패: ${currentSlug} → ${trimmedNewSlug} (${backlinksError})`,
                        user.id
                    )
                    .run().catch((logErr: any) => console.error('Failed to write admin_log for backlinks error:', logErr))
            );
        }
    }

    // 캐시 무효화 (API + SSR) + 최근 변경 즉시 갱신
    // 틀: 등 콜론 포함 문서인 경우 이동 전 슬러그의 역링크 문서 캐시도 함께 무효화
    c.executionCtx.waitUntil(Promise.allSettled([
        invalidatePageCache(c, currentSlug),
        invalidatePageCache(c, trimmedNewSlug),
        refreshRecentChangesCache(c),
        invalidateBacklinkCaches(c, currentSlug, db),
    ]));

    const response: {
        message: string;
        new_slug: string;
        backlinks?: { updated: number; skipped: string[]; conflicts: string[]; total: number };
        backlinks_error?: string;
    } = { message: '문서가 이동되었습니다.', new_slug: trimmedNewSlug };

    if (backlinksResult) {
        response.backlinks = {
            updated: backlinksResult.updated.length,
            skipped: backlinksResult.skipped,
            conflicts: backlinksResult.conflicts,
            total: backlinksResult.total,
        };
    }
    if (backlinksError) {
        response.backlinks_error = backlinksError;
    }

    return c.json(response);
});

/**
 * POST /w/:slug/revert
 * 문서 되돌리기
 */
wiki.post('/w/:slug/revert', requireAuth, async (c) => {
    const slug = c.req.param('slug');
    const { revision_id } = await c.req.json<{ revision_id: number }>();
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;

    const page = await db.prepare('SELECT id, version, is_private, edit_acl FROM pages WHERE slug = ? AND deleted_at IS NULL')
        .bind(slug).first<{ id: number, version: number, is_private: number, edit_acl: string | null }>();

    if (!page) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    const isAdmin = rbac.can(user.role, 'admin:access');

    if (page.is_private === 1 && !rbac.can(user.role, 'wiki:private')) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    // admin_only ACL 문서 되돌리기는 관리자만 가능. (구 is_locked 분기 대체)
    if (!isAdmin) {
        const aclRevert = parseEditAcl(page.edit_acl);
        if (aclRevert && aclRevert.flags.includes('admin_only')) {
            return c.json({ error: '관리자 전용 문서는 관리자만 되돌릴 수 있습니다.' }, 403);
        }
    }

    const targetRevision = await db.prepare('SELECT content, r2_key, page_version, deleted_at, purged_at FROM revisions WHERE id = ? AND page_id = ?')
        .bind(revision_id, page.id).first<{ content: string; r2_key: string | null; page_version: number | null; deleted_at: number | null; purged_at: number | null }>();

    if (!targetRevision) {
        return c.json({ error: '해당 리비전을 찾을 수 없습니다.' }, 404);
    }

    // 숨겨진/영구 삭제된 리비전으로의 되돌리기는 redaction 우회 통로가 된다.
    //   - 비관리자: 존재 자체를 가려야 하므로 404.
    //   - 관리자: 본문이 의도적으로 가려진(또는 R2 에서 영구 삭제된) 상태이므로 명시적으로 거부.
    //             되살리려면 별도 unhide 흐름이 필요하며 이 PR 범위 밖.
    if (targetRevision.purged_at) {
        return isAdmin
            ? c.json({ error: '본문이 영구 삭제된 리비전으로는 되돌릴 수 없습니다.' }, 409)
            : c.json({ error: '해당 리비전을 찾을 수 없습니다.' }, 404);
    }
    if (targetRevision.deleted_at) {
        return isAdmin
            ? c.json({ error: '숨겨진 리비전으로는 되돌릴 수 없습니다. 먼저 숨김을 해제해야 합니다.' }, 409)
            : c.json({ error: '해당 리비전을 찾을 수 없습니다.' }, 404);
    }

    // 되돌릴 리비전의 본문을 R2 또는 D1에서 조회
    const origin = new URL(c.req.url).origin;
    let revertContent: string;
    try {
        revertContent = await getRevisionContent(c.env.MEDIA, targetRevision, origin);
    } catch (e) {
        console.error('Failed to fetch revert target content:', e);
        return c.json({ error: '리비전 본문을 불러오지 못했습니다.' }, 500);
    }

    // 레거시 리비전이 CRLF 를 포함할 수 있으므로 새 리비전으로 쌓기 전에 LF 로 정규화.
    revertContent = revertContent.replace(/\r\n?/g, '\n');

    // 새 리비전 생성 (리비전 이력은 선형으로 계속 쌓임)
    const newVersion = page.version + 1;
    const targetVersionLabel = targetRevision.page_version != null ? `v${targetRevision.page_version}` : `#${revision_id}`;
    const summary = `${targetVersionLabel}으로 되돌리기`;

    // 1. R2에 새 리비전 본문 업로드
    let newR2Key: string;
    try {
        newR2Key = await uploadRevisionToR2(c.env.MEDIA, page.id, newVersion, revertContent);
    } catch (e) {
        console.error('R2 revert upload failed:', e);
        return c.json({ error: '리비전 저장에 실패했습니다. 잠시 후 다시 시도해주세요.' }, 500);
    }

    // 2. D1에 새 리비전 레코드 삽입
    let newRevId: number;
    try {
        const revResult = await db.prepare('INSERT INTO revisions (page_id, page_version, content, r2_key, summary, author_id) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(page.id, newVersion, '', newR2Key, summary, user.id)
            .run();
        newRevId = revResult.meta.last_row_id;
    } catch (e) {
        await c.env.MEDIA.delete(newR2Key).catch(() => {});
        console.error('D1 revert revision insert failed:', e);
        return c.json({ error: '리비전 저장에 실패했습니다. 잠시 후 다시 시도해주세요.' }, 500);
    }

    const enabledExtensionsRevert = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
    const isR2OnlyRevert = isR2OnlyNamespace(slug, enabledExtensionsRevert);
    const contentToStore = isR2OnlyRevert ? '' : revertContent;
    const revertMetrics = computePageMetricsTracked(revertContent, isR2OnlyRevert);
    await db.prepare('UPDATE pages SET content = ?, last_revision_id = ?, version = ?, rows = ?, characters = ?, updated_at = unixepoch() WHERE id = ?')
        .bind(contentToStore, newRevId, newVersion, revertMetrics.rows, revertMetrics.characters, page.id)
        .run();

    // page_links 재구성: 되돌린 본문 기준으로 역링크 추적을 동기화한다.
    // (카테고리는 별도 테이블이며 리비전 본문에 포함되지 않으므로 건드리지 않는다.)
    const revertLinkStmts = buildLinksOnlyStatements(db, page.id, revertContent);

    // 캐시 무효화 (API + SSR) + 최근 변경 즉시 갱신
    c.executionCtx.waitUntil(Promise.allSettled([
        db.batch(revertLinkStmts).catch(e => console.error('Failed to update links on revert:', e)),
        invalidatePageCache(c, slug),
        refreshRecentChangesCache(c),
    ]));

    return c.json({ message: '문서가 되돌려졌습니다.', version: newVersion });
});

/**
 * 리비전 단위 삭제 — 공용 페이지/리비전 검증 및 권한 체크.
 * 페이지 단위 삭제(wiki:delete / *) 와 동일 정책을 사용하며, 추가로 최신 리비전은
 * 절대 삭제하지 못하도록 막아 pages.last_revision_id / content / version 일관성을 유지한다.
 */
async function loadRevisionForDeletion(
    c: any,
    slug: string,
    revId: number
): Promise<
    | { ok: true; page: { id: number; last_revision_id: number | null; is_private: number }; revision: { id: number; page_id: number; page_version: number | null; content: string; r2_key: string | null; deleted_at: number | null; purged_at: number | null } }
    | { ok: false; response: Response }
> {
    const db = c.env.DB as D1Database;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const canSeePrivate = rbac.can(user?.role ?? 'guest', 'wiki:private');

    // 페이지가 이미 soft-delete 되어 있으면 리비전 단위 변경을 차단한다 (페이지 단위 삭제 정책과 동일).
    // 정리가 필요하면 먼저 페이지를 복원해야 한다.
    const page = await db
        .prepare('SELECT id, last_revision_id, is_private, deleted_at FROM pages WHERE slug = ?')
        .bind(slug)
        .first<{ id: number; last_revision_id: number | null; is_private: number; deleted_at: number | null }>();

    if (!page) {
        return { ok: false, response: c.json({ error: '문서를 찾을 수 없습니다.' }, 404) };
    }
    if (page.deleted_at) {
        return { ok: false, response: c.json({ error: '삭제된 문서의 리비전은 정리할 수 없습니다. 먼저 문서를 복원하세요.' }, 409) };
    }
    if (page.is_private === 1 && !canSeePrivate) {
        return { ok: false, response: c.json({ error: '문서를 찾을 수 없습니다.' }, 404) };
    }

    const revision = await db
        .prepare('SELECT id, page_id, page_version, content, r2_key, deleted_at, purged_at FROM revisions WHERE id = ? AND page_id = ?')
        .bind(revId, page.id)
        .first<{ id: number; page_id: number; page_version: number | null; content: string; r2_key: string | null; deleted_at: number | null; purged_at: number | null }>();

    if (!revision) {
        return { ok: false, response: c.json({ error: '리비전을 찾을 수 없습니다.' }, 404) };
    }
    if (page.last_revision_id === revision.id) {
        return { ok: false, response: c.json({ error: '최신 리비전은 삭제할 수 없습니다. 먼저 되돌리기를 한 뒤 시도하세요.' }, 409) };
    }
    return { ok: true, page, revision };
}

/**
 * POST /w/:slug/revisions/:id/delete
 * 리비전 단위 소프트 삭제 — 권한 없는 사용자에게 해당 리비전이 처음부터 없었던 것처럼 가린다.
 * 편집 요약은 DB 에 보존되어 관리자에게만 노출된다.
 */
wiki.post('/w/:slug/revisions/:id/delete', requireAuth, requirePermission('wiki:delete'), async (c) => {
    const slug = c.req.param('slug');
    const revId = parseInt(c.req.param('id'), 10);
    const user = c.get('user')!;
    const db = c.env.DB;

    if (!Number.isFinite(revId) || revId <= 0) {
        return c.json({ error: '리비전 id 가 올바르지 않습니다.' }, 400);
    }

    const loaded = await loadRevisionForDeletion(c, slug, revId);
    if (!loaded.ok) return loaded.response;
    const { revision } = loaded;

    if (revision.deleted_at) {
        return c.json({ error: '이미 삭제된 리비전입니다.' }, 409);
    }

    await db.prepare('UPDATE revisions SET deleted_at = unixepoch() WHERE id = ?').bind(revId).run();

    const versionLabel = revision.page_version != null ? `v${revision.page_version}` : `#${revId}`;
    c.executionCtx.waitUntil(Promise.allSettled([
        refreshRecentChangesCache(c),
        db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
            .bind('revision_soft_delete', `리비전 소프트 삭제: ${slug} ${versionLabel} (rev #${revId})`, user.id)
            .run().catch((e: any) => console.error('Failed to write admin log:', e)),
    ]));

    return c.json({ message: '리비전이 삭제되었습니다.' });
});

/**
 * DELETE /w/:slug/revisions/:id
 * 리비전 단위 하드 삭제 — R2 본문을 제거하고 r2_key/content 컬럼을 비운다.
 * row 자체와 summary/author_id/page_version/created_at 은 보존하므로 관리자 응답에서는
 * "(본문 영구 삭제됨)" 마커와 함께 표시된다. 일반 사용자에게는 자연스럽게 가려진다.
 * 최고 관리자(`*`) 전용 — 페이지 hard delete 와 동일 권한 정책.
 */
wiki.delete('/w/:slug/revisions/:id', requireAuth, async (c) => {
    const slug = c.req.param('slug');
    const revId = parseInt(c.req.param('id'), 10);
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;

    if (!rbac.can(user.role, '*')) {
        return c.json({ error: '리비전 영구 삭제는 최고 관리자만 가능합니다.' }, 403);
    }
    if (!Number.isFinite(revId) || revId <= 0) {
        return c.json({ error: '리비전 id 가 올바르지 않습니다.' }, 400);
    }

    const loaded = await loadRevisionForDeletion(c, slug, revId);
    if (!loaded.ok) return loaded.response;
    const { revision } = loaded;

    // 이미 완전히 정리된 경우만 409. r2_key 가 남아 있거나 content 에 본문 텍스트가
    // 남아 있으면(=legacy D1-backed 리비전의 메타 정리 단계가 미완료) 멱등 재시도
    // 경로로 진입한다.
    if (revision.purged_at && !revision.r2_key && revision.content === '') {
        return c.json({ error: '이미 영구 삭제된 리비전입니다.' }, 409);
    }

    // 분산 트랜잭션 (D1 + R2) 순서 — 각 단계 실패 시 read 경로가 절대 stale R2 객체를
    // 건드리지 않도록 보장하면서 멱등 재시도가 가능하도록 설계:
    //
    //   1) Pre-mark intent: purged_at 만 먼저 설정. 이 시점에 read/diff/admin-mcp
    //      경로는 모두 `purged_at` 체크로 R2 호출을 건너뛰고 빈 본문을 반환하므로,
    //      이후 R2 단계가 어떻게 끝나든 사용자에게 stale 콘텐츠가 노출되지 않는다.
    //   2) R2 본문 삭제: 실패 시 502 로 중단. purged_at 가 살아있으므로 read 는 안전.
    //      사용자가 다시 DELETE 를 호출하면 위 가드(`purged_at && !r2_key`)가 통과시켜
    //      이 경로로 재진입한다.
    //   3) Workers Cache API 무효화 (PoP-local 베스트에포트). 다른 PoP 의 cached 엔트리는
    //      남아있을 수 있으나, 아래 r2_key = NULL 이후 getRevisionContent 가 더 이상
    //      그 캐시 키를 구성하지 않으므로 도달 불가능한 고아 엔트리가 된다.
    //   4) 메타 정리: r2_key/content 비움. 실패해도 read 경로는 1) 의 purged_at 로
    //      이미 안전하며, 재시도 시 R2 delete 는 멱등(이미 없으면 no-op).
    try {
        await db.prepare(
            `UPDATE revisions
             SET deleted_at = COALESCE(deleted_at, unixepoch()),
                 purged_at  = COALESCE(purged_at, unixepoch())
             WHERE id = ?`
        ).bind(revId).run();
    } catch (e) {
        console.error('Hard delete pre-mark failed:', revId, e);
        return c.json({ error: '삭제 마킹에 실패했습니다. 잠시 후 다시 시도하세요.' }, 500);
    }

    if (revision.r2_key) {
        try {
            await c.env.MEDIA.delete(revision.r2_key);
        } catch (e) {
            console.error('R2 hard delete failed:', revision.r2_key, e);
            return c.json({ error: 'R2 본문 삭제에 실패했습니다. 잠시 후 다시 시도하세요.' }, 502);
        }
        await invalidateRevisionContentCache(c, revision.r2_key).catch(() => {});
    }

    try {
        await db.prepare(
            `UPDATE revisions SET r2_key = NULL, content = '' WHERE id = ?`
        ).bind(revId).run();
    } catch (e) {
        // 메타 정리 실패 — R2 객체는 이미 사라졌고 purged_at 가 read 경로를 차단하므로
        // 데이터 일관성 위험은 없다. 다음 재시도 호출에서 같은 UPDATE 가 멱등 실행된다.
        console.error('Hard delete metadata cleanup failed (will retry on next call):', revId, e);
        return c.json({ error: '메타데이터 정리에 실패했습니다. 잠시 후 다시 시도하세요.' }, 500);
    }

    const versionLabel = revision.page_version != null ? `v${revision.page_version}` : `#${revId}`;
    c.executionCtx.waitUntil(Promise.allSettled([
        refreshRecentChangesCache(c),
        db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
            .bind('revision_hard_delete', `리비전 영구 삭제: ${slug} ${versionLabel} (rev #${revId})`, user.id)
            .run().catch((e: any) => console.error('Failed to write admin log:', e)),
    ]));

    return c.json({ message: '리비전이 영구 삭제되었습니다.' });
});

/**
 * GET /w/:slug/watch
 * 현재 유저의 주시 상태 조회
 *
 * 응답: { watching: boolean, scope: 'this' | 'subtree' | null }
 *  - watching=false 일 때 scope 는 null.
 */
wiki.get('/w/:slug/watch', requireAuth, async (c) => {
    const slug = c.req.param('slug');
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;
    const canSeePrivate = rbac.can(user.role, 'wiki:private');
    const privateFilter = canSeePrivate ? '' : ' AND is_private = 0';

    const page = await db.prepare(`SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL${privateFilter}`)
        .bind(slug).first<{ id: number }>();
    if (!page) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    const watch = await db.prepare('SELECT scope FROM page_watches WHERE user_id = ? AND page_id = ?')
        .bind(user.id, page.id).first<{ scope: string }>();

    return c.json({ watching: !!watch, scope: watch?.scope ?? null });
});

/**
 * POST /w/:slug/watch
 * 문서 주시 토글 (로그인 필수)
 *
 * 요청 본문(JSON, 선택): { scope: 'this' | 'subtree', action?: 'set' | 'toggle' }
 *  - scope: 'this'    — 해당 문서만 구독 (기본값)
 *  - scope: 'subtree' — 해당 문서 + 하위 문서까지 구독
 *  - action='set': 항상 해당 scope 로 설정 (기존이 있으면 갱신, 없으면 생성)
 *  - action='toggle' (기본): 같은 scope 면 해제, 다른 scope 면 갱신, 없으면 생성
 *
 * 응답: { watching: boolean, scope: 'this' | 'subtree' | null }
 */
wiki.post('/w/:slug/watch', requireAuth, async (c) => {
    const slug = c.req.param('slug');
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const db = c.env.DB;
    const canSeePrivate = rbac.can(user.role, 'wiki:private');
    const privateFilter = canSeePrivate ? '' : ' AND is_private = 0';

    let body: { scope?: string; action?: string } = {};
    try { body = await c.req.json(); } catch { /* 빈 본문 허용 */ }
    const requestedScope = body.scope === 'subtree' ? 'subtree' : 'this';
    const action = body.action === 'set' ? 'set' : 'toggle';

    const page = await db.prepare(`SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL${privateFilter}`)
        .bind(slug).first<{ id: number }>();
    if (!page) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    const existing = await db.prepare('SELECT scope FROM page_watches WHERE user_id = ? AND page_id = ?')
        .bind(user.id, page.id).first<{ scope: string }>();

    if (action === 'set') {
        if (existing) {
            if (existing.scope !== requestedScope) {
                await db.prepare('UPDATE page_watches SET scope = ? WHERE user_id = ? AND page_id = ?')
                    .bind(requestedScope, user.id, page.id).run();
            }
        } else {
            await db.prepare('INSERT INTO page_watches (user_id, page_id, scope) VALUES (?, ?, ?)')
                .bind(user.id, page.id, requestedScope).run();
        }
        return c.json({ watching: true, scope: requestedScope });
    }

    // toggle
    if (existing) {
        if (existing.scope === requestedScope) {
            await db.prepare('DELETE FROM page_watches WHERE user_id = ? AND page_id = ?')
                .bind(user.id, page.id).run();
            return c.json({ watching: false, scope: null });
        }
        await db.prepare('UPDATE page_watches SET scope = ? WHERE user_id = ? AND page_id = ?')
            .bind(requestedScope, user.id, page.id).run();
        return c.json({ watching: true, scope: requestedScope });
    }

    await db.prepare('INSERT INTO page_watches (user_id, page_id, scope) VALUES (?, ?, ?)')
        .bind(user.id, page.id, requestedScope).run();
    return c.json({ watching: true, scope: requestedScope });
});

/**
 * GET /w/category/:category/watch
 * 카테고리 주시 상태 조회 (로그인 필수)
 */
wiki.get('/w/category/:category/watch', requireAuth, async (c) => {
    const category = c.req.param('category');
    const user = c.get('user')!;
    const db = c.env.DB;
    const row = await db.prepare('SELECT 1 FROM category_watches WHERE user_id = ? AND category = ?')
        .bind(user.id, category).first();
    return c.json({ watching: !!row });
});

/**
 * POST /w/category/:category/watch
 * 카테고리 주시 토글 (로그인 필수)
 */
wiki.post('/w/category/:category/watch', requireAuth, async (c) => {
    const category = c.req.param('category');
    const user = c.get('user')!;
    const db = c.env.DB;
    if (!category || category.length > 200) {
        return c.json({ error: '카테고리가 올바르지 않습니다.' }, 400);
    }
    const existing = await db.prepare('SELECT 1 FROM category_watches WHERE user_id = ? AND category = ?')
        .bind(user.id, category).first();
    if (existing) {
        await db.prepare('DELETE FROM category_watches WHERE user_id = ? AND category = ?')
            .bind(user.id, category).run();
        return c.json({ watching: false });
    }
    await db.prepare('INSERT INTO category_watches (user_id, category) VALUES (?, ?)')
        .bind(user.id, category).run();
    return c.json({ watching: true });
});

/**
 * POST /w/:slug/editing
 * 편집 하트비트 전송 (로그인 필수)
 * - KV에 편집 중 상태를 기록 (TTL 80초)
 */
wiki.post('/w/:slug/editing', requireAuth, async (c) => {
    if (c.env.ENABLE_CONCURRENT_EDIT_DETECTION === 'false') {
        return c.json({ ok: true, disabled: true });
    }
    const slug = c.req.param('slug');
    const user = c.get('user')!;
    const kv = c.env.KV;

    const key = `editing:${slug}:${user.id}`;
    const value = JSON.stringify({ name: user.name, picture: user.picture || '' });

    // 하트비트 주기가 50초이므로, TTL은 80초 정도로 설정하여 여유를 둠
    await kv.put(key, value, { expirationTtl: 80 });

    return c.json({ ok: true });
});

/**
 * GET /w/:slug/editors
 * 현재 편집 중인 사용자 목록 (로그인 필수)
 * - 자기 자신은 제외
 */
wiki.get('/w/:slug/editors', requireAuth, async (c) => {
    const slug = c.req.param('slug');
    const user = c.get('user')!;
    const kv = c.env.KV;

    const prefix = `editing:${slug}:`;
    const list = await kv.list({ prefix });

    const editors: { name: string; picture: string }[] = [];

    for (const key of list.keys) {
        // 자기 자신 제외
        const userId = key.name.replace(prefix, '');
        if (userId === String(user.id)) continue;

        const value = await kv.get(key.name);
        if (value) {
            try {
                editors.push(JSON.parse(value));
            } catch { }
        }
    }

    return c.json({ editors });
});


export default wiki;
