import { Hono } from 'hono';
import type { Env, Page, Revision } from '../types';
import { requireAuth, requireAdmin, requirePermission } from '../middleware/session';
import { normalizeSlug, isR2OnlyNamespace } from '../utils/slug';
import { matchAdminNamespace } from '../utils/adminNamespace';
import { safeJSON } from '../utils/json';
import { ROLE_CASE_SQL, enrichRoles, RBAC } from '../utils/role';
import { fetchMediaTags } from '../utils/mediaTags';
import { createNotifications } from '../utils/notification';

const wiki = new Hono<Env>();

/** 슬러그에 사용할 수 없는 금지 문자 패턴 ({}, [] 는 트랜스클루전/위키링크 문법과 충돌) */
export const SLUG_FORBIDDEN_CHARS = /[\[\]{}()#%|<>^\x00-\x1F\x7F]/;

// ── 커스텀 팔레트 파서 ──
// PALETTES 환경변수(JSON 문자열)를 정규화된 팔레트 맵으로 변환.
// 플랫 형태({bg,color})는 light/dark 공통 사용, 분리 형태({light,dark})는 각 모드별 적용.
// 유효한 엔트리만 통과시키며 파싱 실패 시 빈 객체 반환(프론트엔드에서 조용히 무시).
function parseCustomPalettes(raw: string | undefined): Record<string, { light: { bg?: string; color?: string }; dark: { bg?: string; color?: string } }> {
    if (!raw) return {};
    let parsed: any;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const result: Record<string, { light: { bg?: string; color?: string }; dark: { bg?: string; color?: string } }> = {};
    for (const [name, value] of Object.entries(parsed)) {
        if (!name) continue;
        if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
        if (!value || typeof value !== 'object') continue;
        const v = value as any;

        const hasSplit = (v.light && typeof v.light === 'object') || (v.dark && typeof v.dark === 'object');
        if (hasSplit) {
            const light = (v.light && typeof v.light === 'object') ? { bg: typeof v.light.bg === 'string' ? v.light.bg : undefined, color: typeof v.light.color === 'string' ? v.light.color : undefined } : {};
            const dark = (v.dark && typeof v.dark === 'object') ? { bg: typeof v.dark.bg === 'string' ? v.dark.bg : undefined, color: typeof v.dark.color === 'string' ? v.dark.color : undefined } : {};
            // 한쪽만 정의된 경우 반대편으로 폴백
            const finalLight = { bg: light.bg ?? dark.bg, color: light.color ?? dark.color };
            const finalDark = { bg: dark.bg ?? light.bg, color: dark.color ?? light.color };
            if (
                finalLight.bg === undefined &&
                finalLight.color === undefined &&
                finalDark.bg === undefined &&
                finalDark.color === undefined
            ) continue;
            result[name] = { light: finalLight, dark: finalDark };
        } else {
            const bg = typeof v.bg === 'string' ? v.bg : undefined;
            const color = typeof v.color === 'string' ? v.color : undefined;
            if (bg === undefined && color === undefined) continue;
            result[name] = { light: { bg, color }, dark: { bg, color } };
        }
    }
    return result;
}

/**
 * 최근 변경 캐시를 즉시 새 데이터로 갱신
 * (delete 후 재요청 대기 대신, 직접 put하여 즉시 반영)
 */
export async function refreshRecentChangesCache(c: any) {
    const db = c.env.DB;
    const origin = new URL(c.req.url).origin;
    const cacheUrl = `${origin}/api/w/recent-changes`;
    const cache = caches.default;

    // 캐시는 비공개 페이지 열람 권한이 없는 익명/일반 응답에만 저장된다.
    const { results } = await db.prepare(`
        SELECT p.slug, p.updated_at, u.name as author_name
        FROM pages p
        LEFT JOIN revisions r ON p.last_revision_id = r.id
        LEFT JOIN users u ON r.author_id = u.id
        WHERE p.deleted_at IS NULL AND p.is_private = 0
        ORDER BY p.updated_at DESC LIMIT 10
    `).all();

    const body = JSON.stringify(safeJSON({ changes: results }));
    const response = new Response(body, {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Cache-Control': 'public, max-age=60',
        },
    });
    await cache.put(cacheUrl, response);
}

/**
 * 문서의 캐시를 무효화하는 유틸리티 함수
 */
export function invalidatePageCache(c: any, slug: string) {
    const origin = new URL(c.req.url).origin;
    const cache = caches.default;
    // encodeURIComponent는 ':'를 %3A로 인코딩하지만 브라우저는 URL 경로의 ':'를 인코딩하지 않는 경우도 있다.
    // 두 변형(%3A 인코딩 / ':' 그대로)을 모두 삭제해 어느 쪽으로 캐시됐더라도 확실히 무효화한다.
    const encodedPath = encodeURIComponent(slug);
    const paths = slug.includes(':')
        ? [encodedPath, encodedPath.replace(/%3A/g, ':')]
        : [encodedPath];

    return Promise.allSettled(
        paths.flatMap(path => [
            cache.delete(`${origin}/api/w/${path}`),
            cache.delete(`${origin}/api/w/${path}?redirect=no`),
            cache.delete(`${origin}/w/${path}`)
        ])
    );
}

/**
 * 콜론이 포함된 문서(틀, 익스텐션 등)가 변경될 때
 * 해당 문서를 참조하는 모든 문서의 캐시를 무효화
 */
export async function invalidateBacklinkCaches(c: any, slug: string, db: D1Database): Promise<void> {
    if (!slug.includes(':')) return;

    const targetSlugs: string[] = [slug];
    const templatePrefixes = ['틀:', 'template:', '템플릿:'];
    const matchedPrefix = templatePrefixes.find(p => slug.startsWith(p));
    if (matchedPrefix) {
        // extractLinks()는 {{Foo}}를 항상 '틀:Foo'로 저장하므로,
        // template:Foo / 템플릿:Foo 문서 편집 시에도 '틀:Foo' 변형을 포함해야 함 (반대도 동일)
        const baseName = slug.substring(matchedPrefix.length);
        for (const prefix of templatePrefixes) {
            const variant = prefix + baseName;
            if (!targetSlugs.includes(variant)) targetSlugs.push(variant);
        }
        // 접두사 없는 이름({{Foo}} 방식으로 저장된 경우)도 포함
        if (!targetSlugs.includes(baseName)) targetSlugs.push(baseName);
    }

    const placeholders = targetSlugs.map(() => '?').join(', ');
    const { results } = await db
        .prepare(`
            SELECT DISTINCT p.slug
            FROM page_links pl
            JOIN pages p ON pl.source_page_id = p.id
            WHERE p.deleted_at IS NULL
              AND pl.blog = 0
              AND pl.source_type = 'page'
              AND pl.target_slug IN (${placeholders})
        `)
        .bind(...targetSlugs)
        .all<{ slug: string }>();

    if (results.length === 0) return;
    await Promise.allSettled(results.map((row: { slug: string }) => invalidatePageCache(c, row.slug)));
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
                p.last_revision_id, p.is_locked
            FROM page_links pl
            JOIN pages p ON pl.source_page_id = p.id
            WHERE p.deleted_at IS NULL
              AND pl.blog = 0
              AND pl.source_type = 'page'
              AND pl.target_slug IN (${placeholders})
        `)
        .bind(...targetSlugs)
        .all<{
            id: number; slug: string; version: number; content: string;
            category: string | null; last_revision_id: number | null;
            is_locked: number;
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

    for (const page of targets) {
        // 안전망: 권한이 없는 경우 스킵 (정상 관리자는 통과)
        if (page.is_locked === 1 && !rbac.can(user.role, 'wiki:lock')) {
            skipped.push(page.slug);
            continue;
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

    return c.json({
        wikiName: c.env.WIKI_NAME || 'CloudWiki',
        wikiLogoUrl: c.env.WIKI_LOGO_URL || '',
        wikiFaviconUrl: c.env.WIKI_FAVICON_URL || '',
        selectedIconsOnly: c.env.SELECTED_ICONS_ONLY === 'true',
        enableConcurrentEditDetection: c.env.ENABLE_CONCURRENT_EDIT_DETECTION !== 'false',
        turnstileSiteKey: c.env.TURNSTILE_SITE_KEY || '',
        enabledExtensions: (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean),
        palettes: parseCustomPalettes(c.env.PALETTES),
        mediaPublicUrl: c.env.MEDIA_PUBLIC_URL || '',
        announcements,
    });
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
    const q = c.req.query('q') || '';

    let rows: { category: string }[];
    if (q.length > 0) {
        const { results } = await db
            .prepare('SELECT DISTINCT category FROM page_categories WHERE category LIKE ? ORDER BY category ASC LIMIT 8')
            .bind(`%${q}%`)
            .all<{ category: string }>();
        rows = results;
    } else {
        const { results } = await db
            .prepare('SELECT DISTINCT category FROM page_categories ORDER BY category ASC LIMIT 8')
            .all<{ category: string }>();
        rows = results;
    }

    return c.json({ results: rows.map(r => r.category) });
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
 * 관리자 전용 카테고리 목록 (공개 - 편집 페이지에서 사용)
 */
wiki.get('/w/admin-categories', async (c) => {
    const db = c.env.DB;
    const { results } = await db
        .prepare('SELECT name FROM admin_categories ORDER BY name ASC')
        .all();
    return c.json({ categories: results.map((r: any) => r.name) });
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

    // 캐시 확인
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

    const result = safeJSON({ ...page, redirected_from: redirectedFrom });

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
wiki.put('/w/:slug', requireAuth, requirePermission('wiki:edit'), async (c) => {
    const slug = normalizeSlug(c.req.param('slug'));

    // 슬러그가 비어 있으면 거부 (normalizeSlug 가 앞뒤 슬래시/공백을 모두 떼어낸 결과)
    if (!slug) {
        return c.json({ error: '문서 제목이 비어 있습니다.' }, 400);
    }

    // 슬러그 유효성 검사: 금지 문자 포함 여부
    if (SLUG_FORBIDDEN_CHARS.test(slug)) {
        return c.json({ error: '슬러그에 사용할 수 없는 특수문자가 포함되어 있습니다.' }, 400);
    }

    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    const body = await c.req.json<{
        content: string;
        summary?: string;
        category?: string;
        is_locked?: number;
        is_private?: number;
        redirect_to?: string;
        expected_version?: number;
        turnstileToken?: string;
    }>();

    // Turnstile 검증
    if (c.env.TURNSTILE_SECRET_KEY) {
        const token = body.turnstileToken;
        if (!token) {
            return c.json({ error: 'Turnstile 검증이 필요합니다.' }, 403);
        }
        const formData = new FormData();
        formData.append('secret', c.env.TURNSTILE_SECRET_KEY);
        formData.append('response', token);
        formData.append('remoteip', c.req.header('cf-connecting-ip') || '');
        const tsRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            body: formData,
        });
        const tsData = await tsRes.json<{ success: boolean }>();
        if (!tsData.success) {
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
        return c.json({ error: '"이미지:"는 이미지 문서 전용 네임스페이스이므로 일반 문서 슬러그로 사용할 수 없습니다.' }, 403);
    }

    // 관리자 전용 네임스페이스(prefix) 검증
    if (!isAdmin) {
        const adminPrefix = await matchAdminNamespace(db, slug);
        if (adminPrefix) {
            return c.json({ error: `"${adminPrefix}" 로 시작하는 문서는 관리자만 편집할 수 있습니다.` }, 403);
        }
    }

    // 관리자 전용 카테고리 검증 (쉼표 구분 지원)
    if (body.category && !isAdmin) {
        const cats = body.category.split(',').map(c => c.trim()).filter(c => c);
        for (const cat of cats) {
            const adminCat = await db
                .prepare('SELECT id FROM admin_categories WHERE name = ?')
                .bind(cat)
                .first();
            if (adminCat) {
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
        .prepare('SELECT id, version, is_locked, is_private, redirect_to, content, deleted_at FROM pages WHERE slug = ?')
        .bind(slug)
        .first<{ id: number; version: number; is_locked: number; is_private: number; redirect_to: string | null; content: string; deleted_at: number | null }>();

    // 삭제된 문서는 권한자(admin:access)만 복원할 수 있고 일반 사용자의 편집은 불가.
    // 일반 사용자가 동일 슬러그로 새 문서를 만들지 못하도록 명시적으로 차단한다.
    if (existing && existing.deleted_at && !isAdmin) {
        return c.json({ error: '삭제된 문서는 편집할 수 없습니다.', is_deleted: true }, 410);
    }

    let finalIsLocked = 0;
    let finalIsPrivate = 0;

    if (existing && !existing.deleted_at) {
        // expected_version === 0 은 "신규 생성 전용" 시멘틱이다. 기존 문서가 존재하면
        // 본문 일치 여부와 무관하게 충돌로 처리해, 섹션 분리 등 race-condition 차단이
        // 필요한 호출자가 결정론적으로 거부 응답을 받도록 한다.
        if (body.expected_version === 0) {
            return c.json(
                { error: '같은 슬러그의 문서가 이미 존재합니다.', current_version: existing.version },
                409
            );
        }

        // 기존 문서가 잠겨있을 경우
        if (existing.is_locked === 1 && !rbac.can(user.role, 'wiki:lock')) {
            return c.json({ error: '이 문서는 관리자만 편집할 수 있습니다.' }, 403);
        }

        // 비공개 문서는 wiki:private 권한 없으면 편집 불가 (조회 단계에서도 막혀야 하지만 안전망)
        if (existing.is_private === 1 && !rbac.can(user.role, 'wiki:private')) {
            return c.json({ error: '비공개 문서는 편집할 수 없습니다.', is_private: true }, 403);
        }

        // 권한에 따른 잠금 상태 결정
        finalIsLocked = rbac.can(user.role, 'wiki:lock') ? (body.is_locked ?? existing.is_locked) : existing.is_locked;
        finalIsPrivate = rbac.can(user.role, 'wiki:private') ? (body.is_private ?? existing.is_private) : existing.is_private;

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
        await db
            .prepare(
                `UPDATE pages
         SET content = ?, category = ?, is_locked = ?, is_private = ?, redirect_to = ?, last_revision_id = ?,
             version = ?, rows = ?, characters = ?, updated_at = unixepoch()
         WHERE id = ?`
            )
            .bind(contentToStore, body.category || null, finalIsLocked, finalIsPrivate, body.redirect_to || null, revisionId, newVersion, metrics.rows, metrics.characters, existing.id)
            .run();

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
        finalIsLocked = rbac.can(user.role, 'wiki:lock') ? (body.is_locked ?? 0) : 0;
        finalIsPrivate = rbac.can(user.role, 'wiki:private') ? (body.is_private ?? 0) : 0;

        // ── 새 문서 생성 ──
        const enabledExtensionsCreate = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
        const isR2Only = isR2OnlyNamespace(slug, enabledExtensionsCreate);
        const contentToStore = isR2Only ? '' : body.content;

        const metrics = computePageMetricsTracked(body.content, isR2Only);
        const pageResult = await db
            .prepare(
                'INSERT INTO pages (slug, content, category, is_locked, is_private, redirect_to, rows, characters) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            )
            .bind(slug, contentToStore, body.category || null, finalIsLocked, finalIsPrivate, body.redirect_to || null, metrics.rows, metrics.characters)
            .run();

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
        const linkCatStmts = buildLinkAndCategoryStatements(db, pageId, body.content, body.category || null);
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
 */
wiki.get('/w/category/:category', async (c) => {
    const category = c.req.param('category');
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const canSeePrivate = rbac.can(user?.role ?? 'guest', 'wiki:private');
    const privateFilter = canSeePrivate ? '' : ' AND p.is_private = 0';

    const query = `
        SELECT p.slug, p.is_locked, p.updated_at
        FROM page_categories pc
        JOIN pages p ON pc.page_id = p.id
        WHERE p.deleted_at IS NULL${privateFilter}
          AND pc.category = ?
        ORDER BY p.updated_at DESC
    `;

    const { results } = await db
        .prepare(query)
        .bind(category)
        .all();

    return c.json(safeJSON({ pages: results }));
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
    const db = c.env.DB;
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC;
    const canSeePrivate = rbac.can(user?.role ?? 'guest', 'wiki:private');
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
        SELECT DISTINCT p.slug, p.updated_at, p.is_locked,
            CASE WHEN p.deleted_at IS NOT NULL THEN 1 ELSE 0 END AS is_deleted
        FROM page_links pl
        JOIN pages p ON pl.source_page_id = p.id
        WHERE p.slug != ?
          AND pl.blog = 0
          AND pl.source_type = 'page'
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
    const page = await db.prepare('SELECT id, is_locked FROM pages WHERE slug = ? AND deleted_at IS NULL')
        .bind(slug).first<{ id: number; is_locked: number }>();

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

    // 보안: 슬러그 금지 문자 점검
    if (SLUG_FORBIDDEN_CHARS.test(trimmedNewSlug)) {
        return c.json({ error: '슬러그에 사용할 수 없는 특수문자가 포함되어 있습니다.' }, 400);
    }

    // "이미지:" 네임스페이스는 media 테이블 기반 이미지 문서 전용이므로 이동 대상/출처가 될 수 없다
    if (currentSlug.startsWith('이미지:') || trimmedNewSlug.startsWith('이미지:')) {
        return c.json({ error: '"이미지:" 네임스페이스는 이미지 문서 전용이며, 일반 문서 이동 대상이 될 수 없습니다.' }, 400);
    }

    // 네임스페이스 이동 제한: 콜론이 포함된 문서는 다른 네임스페이스로 이동 불가
    const isNamespaceDocument = currentSlug.includes(':');
    const currentNamespace = isNamespaceDocument ? currentSlug.split(':')[0] : '';
    const newNamespace = trimmedNewSlug.includes(':') ? trimmedNewSlug.split(':')[0] : '';
    if (isNamespaceDocument && currentNamespace !== newNamespace) {
        return c.json({ error: '네임스페이스가 있는 문서는 다른 네임스페이스로 이동할 수 없습니다.' }, 400);
    }

    // new_slug validation logic same as create (e.g. valid chars) - skip for brevity or assume client sends valid slug
    // Check if target exists
    const targetExists = await db.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL').bind(trimmedNewSlug).first();
    if (targetExists) {
        return c.json({ error: '이미 존재하는 문서 이름입니다.' }, 409);
    }

    const page = await db.prepare('SELECT id, is_locked, is_private FROM pages WHERE slug = ? AND deleted_at IS NULL').bind(currentSlug).first<{ id: number, is_locked: number, is_private: number }>();
    if (!page) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    if (page.is_private === 1 && !rbac.can(user.role, 'wiki:private')) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    if (page.is_locked === 1 && !rbac.can(user.role, 'wiki:lock')) {
        return c.json({ error: '잠긴 문서는 관리자만 이동할 수 있습니다.' }, 403);
    }

    // Update Page Slug (slug 가 곧 표시 이름이므로 별도 title 업데이트 불필요)
    await db.prepare('UPDATE pages SET slug = ? WHERE id = ?')
        .bind(trimmedNewSlug, page.id)
        .run();

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

    const page = await db.prepare('SELECT id, version, is_locked, is_private FROM pages WHERE slug = ? AND deleted_at IS NULL')
        .bind(slug).first<{ id: number, version: number, is_locked: number, is_private: number }>();

    if (!page) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    const isAdmin = rbac.can(user.role, 'admin:access');

    if (page.is_private === 1 && !rbac.can(user.role, 'wiki:private')) {
        return c.json({ error: '문서를 찾을 수 없습니다.' }, 404);
    }

    // 관리자 전용 네임스페이스 검증
    if (!isAdmin) {
        const adminPrefix = await matchAdminNamespace(db, slug);
        if (adminPrefix) {
            return c.json({ error: `"${adminPrefix}" 로 시작하는 문서는 관리자만 되돌릴 수 있습니다.` }, 403);
        }
    }

    if (page.is_locked === 1 && !rbac.can(user.role, 'wiki:lock')) {
        return c.json({ error: '잠긴 문서는 관리자만 되돌릴 수 있습니다.' }, 403);
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

    // 캐시 무효화 (API + SSR) + 최근 변경 즉시 갱신
    c.executionCtx.waitUntil(Promise.allSettled([
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
        const origin = new URL(c.req.url).origin;
        const cacheKey = `${origin}/__r2_revision__/${revision.r2_key}`;
        await (caches as any).default.delete(cacheKey).catch(() => {});
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
