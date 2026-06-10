import type { WorkspaceMedia } from '../shared/models';

/**
 * 워크스페이스 미디어 공유 헬퍼 (leaf 유틸 — 라우트를 import 하지 않는다).
 *
 * - R2 키/서빙 경로 빌더: 전역 미디어(`images/...`, `/media/...`)와 완전히 분리된
 *   워크스페이스 전용 네임스페이스(`ws-media/...`, `/wsmedia/...`)를 단일 소스로 정의한다.
 * - 본문 내 미디어 참조 추출: 워크스페이스 문서 본문이 참조하는 미디어 파일명을 스캔.
 * - ws_public 동기화: "미디어는 비삭제 ws_public=1 문서가 참조할 때만 공개" 불변식을
 *   문서 저장/공개 토글 때마다 재계산한다.
 * - GC 후보 조회: 어떤 문서(공개/비공개 불문)도 참조하지 않는 미디어 목록.
 */

/**
 * 워크스페이스 미디어의 R2 저장 키.
 * 전역 미디어(`images/{filename}`)와 분리된 네임스페이스 — 워크스페이스 격리를
 * 저장소 레벨에서도 보장한다.
 */
export function wsMediaR2Key(workspaceId: number, filename: string): string {
    return `ws-media/${workspaceId}/${filename}`;
}

/**
 * 워크스페이스 미디어의 서빙 경로.
 * 워크스페이스 id 기반 경로라 워크스페이스 슬러그가 바뀌어도 본문 내 링크가 깨지지 않는다.
 */
export function wsMediaServePath(workspaceId: number, filename: string): string {
    return `/wsmedia/${workspaceId}/${filename}`;
}

/**
 * 본문에서 워크스페이스 미디어 참조 파일명을 추출한다.
 *
 * 매칭 형태:
 *   - `/wsmedia/{workspaceId}/{filename}` (마크다운 `![alt](/wsmedia/1/a.png)`, 절대 URL 포함)
 *   - bare `wsmedia/{workspaceId}/{filename}` (앞에 단어 문자가 붙은 오탐은 lookbehind 로 차단)
 *
 * 파일명 패턴은 전역 이미지 참조 추출(wiki.ts extractLinks)과 동일 발상 —
 * URL/마크다운/HTML 경계를 끊는 문자만 블랙리스트로 제외하고, 비탐욕(`+?`)으로
 * 첫 `.확장자` 에서 종료한다(업로드 파일명은 항상 `{이름}.{확장자}` 형태).
 * 한글 등 유니코드 파일명이 URL 인코딩된 경우를 위해 디코딩 변형도 함께 수집한다.
 *
 * 주의: 다른 워크스페이스 id 의 참조는 무시한다 (워크스페이스 격리).
 */
export function extractWorkspaceMediaRefs(content: string, workspaceId: number): Set<string> {
    const refs = new Set<string>();
    if (!content) return refs;
    // 앞이 `/` 이면 무조건 허용(절대 경로·절대 URL), bare 형태는 단어 문자 직후를 제외.
    const re = /(?:\/|(?<![\w.-]))wsmedia\/(\d+)\/([^\s\[\]()<>"'\\?#|^]+?\.\w+)/g;
    for (const m of content.matchAll(re)) {
        if (parseInt(m[1], 10) !== workspaceId) continue;
        const raw = m[2];
        refs.add(raw);
        // URL 인코딩된 파일명(한글 등)은 디코딩한 원본 파일명으로도 수집.
        try {
            const decoded = decodeURIComponent(raw);
            if (decoded !== raw) refs.add(decoded);
        } catch {
            // malformed escape — raw 만 유지
        }
    }
    return refs;
}

/**
 * 워크스페이스 문서들이 참조하는 미디어 파일명 집합을 계산한다.
 * @param scope
 *   - `'public'`: 비삭제 ws_public=1 문서만 대상 (공개 연동/가시성 계산)
 *   - `'gc'`: **소프트 삭제 포함 전체 문서** 대상 (GC 삭제 후보 판정). 소프트 삭제된
 *     문서가 참조하는 미디어는 "참조됨"으로 간주해 GC 대상에서 제외한다 — 문서 복구
 *     여지를 보존하고, 추출 누락으로 인한 참조 미디어의 우발적 삭제를 방지한다.
 */
async function collectReferencedFilenames(
    db: D1Database,
    workspaceId: number,
    scope: 'public' | 'gc'
): Promise<Set<string>> {
    const where = scope === 'public'
        ? 'workspace_id = ? AND deleted_at IS NULL AND ws_public = 1'
        : 'workspace_id = ?';
    const pages = await db
        .prepare(`SELECT content FROM workspace_pages WHERE ${where}`)
        .bind(workspaceId)
        .all<{ content: string }>();
    const referenced = new Set<string>();
    for (const row of pages.results || []) {
        for (const f of extractWorkspaceMediaRefs(row.content || '', workspaceId)) {
            referenced.add(f);
        }
    }
    return referenced;
}

/**
 * 워크스페이스 미디어의 ws_public 을 전수 재계산한다.
 *
 * 불변식: 미디어는 **비삭제 ws_public=1 워크스페이스 문서가 하나라도 참조할 때만** 공개(1),
 * 그 외에는 비공개(0). 문서 저장/소프트 삭제/공개 토글 직후마다 호출해 동기화한다.
 *
 * 효율: 미디어 파일명 + 공개 문서 본문을 각 1쿼리로 적재해 참조 집합을 JS 에서 계산하고,
 * ws_public 값이 실제로 바뀌는 행만 IN 절 배치 UPDATE 한다 (무변경이면 쿼리 0).
 */
export async function syncWorkspaceMediaVisibility(db: D1Database, workspaceId: number): Promise<void> {
    const media = await db
        .prepare('SELECT id, filename, ws_public FROM workspace_media WHERE workspace_id = ?')
        .bind(workspaceId)
        .all<{ id: number; filename: string; ws_public: number }>();
    const rows = media.results || [];
    if (rows.length === 0) return;

    const referenced = await collectReferencedFilenames(db, workspaceId, 'public');

    const toPublic: number[] = [];
    const toPrivate: number[] = [];
    for (const m of rows) {
        const shouldBePublic = referenced.has(m.filename) ? 1 : 0;
        if (shouldBePublic === (m.ws_public ? 1 : 0)) continue;
        (shouldBePublic ? toPublic : toPrivate).push(m.id);
    }
    if (toPublic.length === 0 && toPrivate.length === 0) return;

    const stmts: D1PreparedStatement[] = [];
    if (toPublic.length > 0) {
        stmts.push(
            db.prepare(
                `UPDATE workspace_media SET ws_public = 1 WHERE id IN (${toPublic.map(() => '?').join(',')})`
            ).bind(...toPublic)
        );
    }
    if (toPrivate.length > 0) {
        stmts.push(
            db.prepare(
                `UPDATE workspace_media SET ws_public = 0 WHERE id IN (${toPrivate.map(() => '?').join(',')})`
            ).bind(...toPrivate)
        );
    }
    await db.batch(stmts);
}

/**
 * 어떤 워크스페이스 문서(공개/비공개·소프트 삭제 불문)도 참조하지 않는 미디어 목록.
 * 미디어 가비지 컬렉션(GC) 도구의 삭제 후보 산출용 — 실제 삭제는 호출 측 책임.
 * 소프트 삭제된 문서의 참조도 "참조됨"으로 쳐서(scope='gc') 복구 여지/데이터 손실을 보호한다.
 */
export async function findUnreferencedWorkspaceMedia(
    db: D1Database,
    workspaceId: number
): Promise<WorkspaceMedia[]> {
    const media = await db
        .prepare('SELECT * FROM workspace_media WHERE workspace_id = ?')
        .bind(workspaceId)
        .all<WorkspaceMedia>();
    const rows = media.results || [];
    if (rows.length === 0) return [];

    const referenced = await collectReferencedFilenames(db, workspaceId, 'gc');
    return rows.filter((m) => !referenced.has(m.filename));
}
