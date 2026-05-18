/**
 * 커스텀 컬러 팔레트 DB 조회 + 검증 유틸.
 *
 * 하드코딩 프리셋(primary/secondary/success/info/warning/danger/muted) 은
 * 클라이언트 src/client/render.ts 의 WIKI_HARDCODED_PALETTES 단일 소스에서 관리.
 * 이 모듈은 그 위에 머지되는 사용자 정의 팔레트만 다룬다.
 */

export interface PaletteVariant {
    bg?: string;
    color?: string;
}

export interface PaletteDefinition {
    light: PaletteVariant;
    dark: PaletteVariant;
}

export type PaletteMap = Record<string, PaletteDefinition>;

/**
 * DB row 형태 (palettes 테이블). NULL 컬럼은 그대로 null 로 유지된다.
 * 관리자 콘솔이 이 raw 형태를 사용해 어느 채널이 실제로 NULL 인지 판별한다
 * (loadAllPalettes 가 반환하는 PaletteMap 은 sibling 폴백을 거친 상태라
 * 한쪽만 NULL 인 채널을 구분할 수 없음).
 */
export interface PaletteRow {
    name: string;
    light_bg: string | null;
    light_color: string | null;
    dark_bg: string | null;
    dark_color: string | null;
}

/** 팔레트 이름 규칙: 영숫자/언더스코어/하이픈, 1~64자. */
export const PALETTE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 안전한 CSS 색상 문자열인지 검증. 클라이언트 _isSafeCssColor (render.ts) 와
 * 동일한 위험 키워드 차단 정책을 사용한다. CSS.supports 가 없는 서버 환경이므로
 * 화이트리스트 정규식만 사용.
 */
export function isSafeCssColor(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const lower = value.toLowerCase().replace(/\s/g, '');
    if (!lower) return false;
    if (lower.includes('url(') || lower.includes('expression(')) return false;
    if (lower.includes('var(') || lower.includes('env(')) return false;
    return /^(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(rgb|hsl)a?\([0-9,.\s/%]+\))$/.test(value);
}

/** 하드코딩 프리셋과 이름 충돌을 막기 위한 예약 이름 (소문자 비교). */
export const RESERVED_PALETTE_NAMES = new Set([
    'primary', 'secondary', 'success', 'info', 'warning', 'danger', 'muted',
]);

/** palettes 행 → PaletteDefinition 변환. light/dark 한쪽이 비면 반대편으로 폴백. */
function rowToDef(row: PaletteRow): PaletteDefinition | null {
    const light: PaletteVariant = {
        bg: row.light_bg ?? row.dark_bg ?? undefined,
        color: row.light_color ?? row.dark_color ?? undefined,
    };
    const dark: PaletteVariant = {
        bg: row.dark_bg ?? row.light_bg ?? undefined,
        color: row.dark_color ?? row.light_color ?? undefined,
    };
    if (light.bg === undefined && light.color === undefined &&
        dark.bg === undefined && dark.color === undefined) {
        return null;
    }
    return { light, dark };
}

/** 모든 커스텀 팔레트를 맵으로 반환. 편집기에서 사용 (sibling 폴백 적용된 PaletteMap). */
export async function loadAllPalettes(db: D1Database): Promise<PaletteMap> {
    const { results } = await db
        .prepare('SELECT name, light_bg, light_color, dark_bg, dark_color FROM palettes')
        .all<PaletteRow>();
    const out: PaletteMap = {};
    for (const row of results ?? []) {
        const def = rowToDef(row);
        if (def) out[row.name] = def;
    }
    return out;
}

/**
 * 모든 커스텀 팔레트 raw row 를 반환. 관리자 콘솔에서 어느 채널이 실제로
 * NULL 인지 보존해야 할 때 사용 — 편집 시 의도적으로 sparse 한 팔레트의
 * 채널을 sibling 값으로 덮어쓰는 회귀를 방지한다.
 */
export async function loadAllPaletteRows(db: D1Database): Promise<PaletteRow[]> {
    const { results } = await db
        .prepare('SELECT name, light_bg, light_color, dark_bg, dark_color FROM palettes ORDER BY name')
        .all<PaletteRow>();
    return results ?? [];
}

/**
 * 본문 텍스트에서 {palette:이름} 토큰의 이름을 추출. wiki.ts extractLinks() palette
 * 분기와 동일한 정규식·정책. 코드블록은 비교적 덜 빈번한 경로라 여기서는 단순화한다
 * (caller 가 raw page 본문을 그대로 넘기는 경우, 코드블록 안의 토큰까지 잡힐 수 있지만
 * 잘못된 매칭이 발생해도 빈 결과보다는 안전 — 미사용 팔레트가 SSR 페이로드에 끼는 정도).
 */
export function extractPaletteNamesFromContent(content: string): string[] {
    if (!content) return [];
    const seen = new Set<string>();
    const paletteRegex = /\{palette:\s*([A-Za-z0-9_-]+)\s*\}/g;
    for (const m of content.matchAll(paletteRegex)) {
        seen.add(m[1]);
    }
    return [...seen];
}

/**
 * 본문에서 {{틀명}} 트랜스클루전 대상 slug 를 추출. wiki.ts extractLinks() 와
 * blog.ts extractBlogTemplateLinks 의 template 분기와 동일한 정규화 정책.
 * loadPalettes* 의 폴백에서 page_links template 인덱스가 비어있을 때 (저장 직후
 * 또는 레거시 블로그) content 로부터 직접 트랜스클루전 대상 slug 를 얻기 위함.
 */
export function extractTemplateSlugsFromContent(content: string): string[] {
    if (!content) return [];
    const seen = new Set<string>();
    const templateRegex = /\{\{([^}]+?)\}\}/g;
    for (const m of content.matchAll(templateRegex)) {
        let slug = m[1].trim().split('#')[0].trim();
        if (!slug) continue;
        const colonIdx = slug.indexOf(':');
        // 익스텐션 호출 (`freq:foo` 등) 은 트랜스클루전이 아니므로 제외
        if (colonIdx > 0 && !slug.startsWith('틀:') && !slug.startsWith('template:') && !slug.startsWith('템플릿:')) {
            continue;
        }
        if (!slug.startsWith('틀:') && !slug.startsWith('template:') && !slug.startsWith('템플릿:')) {
            slug = '틀:' + slug;
        }
        seen.add(slug);
    }
    return [...seen];
}

/**
 * 트랜스클루전된 틀 slug 목록을 받아, 그 틀들이 (redirect 따라가서) 참조하는 팔레트
 * 이름의 합집합을 반환. SQL JOIN 정책은 loadPalettesForPage 의 메인 쿼리와 동일.
 *   - p1.deleted_at IS NULL (삭제는 모두 차단)
 *   - canSeePrivate=false 일 때만 p1/p2.is_private = 0 가드 추가
 *   - redirect_to 추적 1단계
 */
async function loadPaletteNamesForTemplates(
    db: D1Database,
    templateSlugs: string[],
    canSeePrivate: boolean,
): Promise<string[]> {
    if (templateSlugs.length === 0) return [];
    const out = new Set<string>();
    const chunkSize = 50;
    const p1Visibility = canSeePrivate ? '' : ' AND p1.is_private = 0';
    const p2Visibility = canSeePrivate ? '' : ' AND p2.is_private = 0';
    for (let i = 0; i < templateSlugs.length; i += chunkSize) {
        const chunk = templateSlugs.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(',');
        const { results } = await db
            .prepare(`
                SELECT DISTINCT pl2.target_slug
                FROM pages p1
                LEFT JOIN pages p2 ON p1.redirect_to IS NOT NULL AND p2.slug = p1.redirect_to
                    AND p2.deleted_at IS NULL${p2Visibility}
                JOIN page_links pl2 ON pl2.source_page_id = COALESCE(p2.id, p1.id)
                    AND pl2.source_type = 'page'
                    AND pl2.link_type = 'palette'
                WHERE p1.slug IN (${placeholders})
                  AND p1.deleted_at IS NULL${p1Visibility}
            `)
            .bind(...chunk)
            .all<{ target_slug: string }>();
        for (const r of results ?? []) out.add(r.target_slug);
    }
    return [...out];
}

/**
 * 이름 목록으로 팔레트를 조회. D1 SQL 매개변수 갯수 제한을 의식해 chunk 분할.
 */
export async function loadPalettesByNames(db: D1Database, names: string[]): Promise<PaletteMap> {
    if (names.length === 0) return {};
    const out: PaletteMap = {};
    const chunkSize = 50;
    for (let i = 0; i < names.length; i += chunkSize) {
        const chunk = names.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(',');
        const { results } = await db
            .prepare(`SELECT name, light_bg, light_color, dark_bg, dark_color FROM palettes WHERE name IN (${placeholders})`)
            .bind(...chunk)
            .all<PaletteRow>();
        for (const row of results ?? []) {
            const def = rowToDef(row);
            if (def) out[row.name] = def;
        }
    }
    return out;
}

/**
 * 특정 pageId 가 (a) 본인 본문에서 직접 참조 + (b) 트랜스클루전한 틀이 참조하는
 * 팔레트 합집합만 로드한다. page_links 의 link_type='palette' / link_type='template'
 * 두 줄기를 합쳐 한 번의 쿼리로 조회.
 *
 * 트랜스클루전 깊이는 1단계까지만 따른다 (틀 안의 틀 안의 팔레트는 누락 가능).
 * 일반 위키 사용에선 충분하며 더 깊은 추적은 비용 대비 효과가 낮다.
 *
 * canSeePrivate: 호출자가 wiki:private 권한을 가지면 true. 클라이언트 렌더러는
 * /api/w/:slug 를 통해 비공개 틀 본문을 가져올 때 동일 권한 검사를 통과하므로,
 * 권한이 있는 사용자에게는 비공개 틀이 펼쳐진다. 그 경우 _usedPalettes 에도
 * 비공개 틀이 참조하는 팔레트를 포함해야 색상이 정상 적용된다. 비권한 사용자는
 * 기존대로 is_private=0 인 틀만 통과시켜 메타데이터 누출을 막는다.
 *
 * content 가 주어지면 본문에서 직접 참조한 팔레트는 page_links 인덱스를 거치지 않고
 * 즉시 이름을 추출해 합친다 — 저장 직후 page_links 갱신이 waitUntil 로 비동기 처리되는
 * 동안 첫 읽기에서 stale 인덱스가 빈 결과를 돌려주는 윈도우를 메운다 (P2 보강).
 * 트랜스클루전된 틀의 팔레트는 여전히 page_links 인덱스에 의존한다 — 그 데이터는
 * 별도 문서(틀)의 저장 시점에 색인되어 있어 본 페이지 저장과 무관.
 */
export async function loadPalettesForPage(
    db: D1Database,
    pageId: number,
    content?: string,
    canSeePrivate: boolean = false,
): Promise<PaletteMap> {
    const p1Visibility = canSeePrivate ? '' : ' AND p1.is_private = 0';
    const p2Visibility = canSeePrivate ? '' : ' AND p2.is_private = 0';
    const { results } = await db
        .prepare(`
            SELECT DISTINCT pal.name, pal.light_bg, pal.light_color, pal.dark_bg, pal.dark_color
            FROM palettes pal
            WHERE pal.name IN (
                SELECT target_slug FROM page_links
                WHERE source_page_id = ?1 AND source_type = 'page' AND link_type = 'palette'
                UNION
                -- 트랜스클루전된 틀이 참조하는 팔레트. 틀 페이지가 redirect_to 로 다른
                -- 문서를 가리킬 경우 렌더러는 redirect 타겟의 본문을 펼치므로 (resolveTransclusions),
                -- pl2 의 소스는 redirect 타겟 페이지(p2)의 id 를 우선하고, redirect 없으면
                -- 원본 페이지(p1)의 id 를 사용한다.
                --
                -- 가시성 필터: 삭제된 틀은 항상 차단. is_private 은 canSeePrivate 가
                -- false 일 때만 차단해, 권한자에게 비공개 틀의 팔레트가 누락되지 않게 한다.
                SELECT pl2.target_slug FROM page_links pl1
                JOIN pages p1 ON p1.slug = pl1.target_slug
                    AND p1.deleted_at IS NULL${p1Visibility}
                LEFT JOIN pages p2 ON p1.redirect_to IS NOT NULL AND p2.slug = p1.redirect_to
                    AND p2.deleted_at IS NULL${p2Visibility}
                JOIN page_links pl2 ON pl2.source_page_id = COALESCE(p2.id, p1.id)
                    AND pl2.source_type = 'page'
                WHERE pl1.source_page_id = ?1
                  AND pl1.source_type = 'page'
                  AND pl1.link_type = 'template'
                  AND pl2.link_type = 'palette'
            )
        `)
        .bind(pageId)
        .all<PaletteRow>();
    const out: PaletteMap = {};
    for (const row of results ?? []) {
        const def = rowToDef(row);
        if (def) out[row.name] = def;
    }

    // content 기반 폴백 (저장 직후 인덱스 갱신 윈도우 / 레거시 블로그처럼 template
    // 인덱스가 비어있는 경우 양쪽 보강):
    //   1) 본문이 직접 참조하는 {palette:NAME} 토큰 — page_links palette 분기 폴백.
    //   2) 본문이 {{틀:Foo}} 로 트랜스클루전하는 틀이 참조하는 팔레트 — page_links
    //      template 분기 폴백 (레거시 데이터는 이 행이 없을 수 있음).
    if (content) {
        const direct = extractPaletteNamesFromContent(content);
        const templateSlugs = extractTemplateSlugsFromContent(content);
        const fromTemplates = await loadPaletteNamesForTemplates(db, templateSlugs, canSeePrivate);
        const candidates = new Set<string>([...direct, ...fromTemplates]);
        const missing = [...candidates].filter(n => !(n in out));
        if (missing.length > 0) {
            const more = await loadPalettesByNames(db, missing);
            Object.assign(out, more);
        }
    }
    return out;
}

/**
 * blog_posts 본문이 참조하는 팔레트 (page_links source_type='blog', source_page_id=blogId).
 * 트랜스클루전 깊이 1까지 동일하게 따라간다.
 *
 * canSeePrivate / content 폴백 정책은 loadPalettesForPage 와 동일.
 */
export async function loadPalettesForBlogPost(
    db: D1Database,
    blogId: number,
    content?: string,
    canSeePrivate: boolean = false,
): Promise<PaletteMap> {
    const p1Visibility = canSeePrivate ? '' : ' AND p1.is_private = 0';
    const p2Visibility = canSeePrivate ? '' : ' AND p2.is_private = 0';
    const { results } = await db
        .prepare(`
            SELECT DISTINCT pal.name, pal.light_bg, pal.light_color, pal.dark_bg, pal.dark_color
            FROM palettes pal
            WHERE pal.name IN (
                SELECT target_slug FROM page_links
                WHERE source_page_id = ?1 AND source_type = 'blog' AND link_type = 'palette'
                UNION
                -- redirect_to / 가시성 정책은 wiki 변형(loadPalettesForPage) 과 동일.
                SELECT pl2.target_slug FROM page_links pl1
                JOIN pages p1 ON p1.slug = pl1.target_slug
                    AND p1.deleted_at IS NULL${p1Visibility}
                LEFT JOIN pages p2 ON p1.redirect_to IS NOT NULL AND p2.slug = p1.redirect_to
                    AND p2.deleted_at IS NULL${p2Visibility}
                JOIN page_links pl2 ON pl2.source_page_id = COALESCE(p2.id, p1.id)
                    AND pl2.source_type = 'page'
                WHERE pl1.source_page_id = ?1
                  AND pl1.source_type = 'blog'
                  AND pl1.link_type = 'template'
                  AND pl2.link_type = 'palette'
            )
        `)
        .bind(blogId)
        .all<PaletteRow>();
    const out: PaletteMap = {};
    for (const row of results ?? []) {
        const def = rowToDef(row);
        if (def) out[row.name] = def;
    }

    // content 기반 폴백 — wiki 변형과 동일하게 직접 참조 + 트랜스클루전된 틀 양쪽을
    // 모두 보강한다. 레거시 블로그(template 인덱스 행이 없는 포스트) 와 저장 직후
    // 비동기 인덱스 갱신 윈도우에서 누락이 발생하지 않도록 두 분기 모두 폴백.
    if (content) {
        const direct = extractPaletteNamesFromContent(content);
        const templateSlugs = extractTemplateSlugsFromContent(content);
        const fromTemplates = await loadPaletteNamesForTemplates(db, templateSlugs, canSeePrivate);
        const candidates = new Set<string>([...direct, ...fromTemplates]);
        const missing = [...candidates].filter(n => !(n in out));
        if (missing.length > 0) {
            const more = await loadPalettesByNames(db, missing);
            Object.assign(out, more);
        }
    }
    return out;
}
