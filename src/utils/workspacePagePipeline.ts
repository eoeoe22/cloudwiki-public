import type { Context } from 'hono';
import type { Env } from '../types';
import { computePageMetrics } from '../routes/wiki';
import { extractPageLinks } from '../shared/links';
import { uploadWorkspaceRevisionToR2 } from './r2';
import { extractWorkspaceMediaRefs, syncWorkspaceMediaVisibility } from './workspaceMedia';

/**
 * 워크스페이스 문서 저장 파이프라인.
 *
 * 전역 문서 파이프라인(src/utils/pagePipeline)과 동일한 무결성 규율을 따르되,
 * 워크스페이스 설계 제약에 맞춰 의도적으로 단순하다:
 *   - workspace_* 테이블만 사용 — 전역 pages/revisions/page_links 를 절대 건드리지 않는다 (격리 보장).
 *   - edit_acl / 카테고리 ACL / 편집 요청 보류 / 주시자 알림 / 전역 캐시 무효화 없음.
 *   - 응답은 라우트에서 `private, no-store` 로 서빙되므로 엣지 캐시 무효화도 불필요.
 *
 * 무결성 핵심 (admin-mcp 의 applyExistingPageUpdate/applyNewPageInsert 와 동일 규율):
 *   - R2 업로드 → 리비전 INSERT → version-CAS UPDATE 순서.
 *   - CAS 패배(0행 변경) 또는 UPDATE 예외 시 막 만든 리비전 행과 R2 객체를 정리한 뒤
 *     CONCURRENT_MODIFICATION 으로 던진다 — 부분 적용을 남기지 않는다.
 *   - R2 키는 업로드마다 랜덤 토큰을 포함하므로(uploadWorkspaceRevisionToR2 주석 참고)
 *     동일 버전을 계산한 경합 요청의 롤백 delete 가 승리한 리비전 본문을 지우지 못한다.
 */


export interface SaveWorkspacePageInput {
    workspaceId: number;
    /** 호출자가 normalizeSlug + 금지문자 검증을 마친 슬러그 */
    slug: string;
    /** LF 정규화된 본문 */
    content: string;
    authorId: number;
    summary?: string | null;
    /** undefined = 유지, null = 제거, string = 설정 */
    title?: string | null;
    /** undefined = 유지, null/string = 덮어쓰기 */
    redirectTo?: string | null;
    /** undefined = 유지, null/string = 덮어쓰기 (호출자가 ALLOWED_DOC_TYPES 검증) */
    docType?: string | null;
    /** undefined = 유지, 0/1 = 설정 (신규 생성 시 누락이면 0) */
    wsPublic?: number;
    /** 낙관적 락 — 제공됐고 현재 version 과 불일치하면 CONCURRENT_MODIFICATION throw */
    expectedVersion?: number;
}

export interface SaveWorkspacePageResult {
    page_id: number;
    revision_id: number;
    new_version: number;
    rows: number;
    characters: number;
    created: boolean;
}

/** code 프로퍼티를 가진 Error 생성 (라우트가 409 매핑에 사용) */
function codedError(code: 'CONCURRENT_MODIFICATION' | 'SLUG_TAKEN'): Error {
    const err: any = new Error(code);
    err.code = code;
    return err;
}

/**
 * 워크스페이스 문서 저장 (생성/수정 통합 진입점).
 *
 * - (workspace_id, slug) 비삭제 행이 없으면 생성, 있으면 새 리비전으로 갱신.
 * - 생성: INSERT page(version=1) → R2 업로드 → INSERT revision → last_revision_id 갱신.
 *   각 단계 실패 시 직전 산출물을 역순 정리(부분 적용 방지). UNIQUE(workspace_id, slug)
 *   경합(또는 동일 slug 의 소프트 삭제 행 점유)이면 `SLUG_TAKEN` throw.
 * - 수정: version-CAS — R2 업로드 → INSERT revision(page_version=현재+1) →
 *   `UPDATE ... WHERE id=? AND version=?`. 0행 변경(경합 패배)이면 막 만든 리비전/R2
 *   객체를 정리하고 `CONCURRENT_MODIFICATION` throw. expectedVersion 이 제공되면
 *   SELECT 시점 version 과 먼저 대조해 조기 거부한다.
 * - 커밋 후: workspace_page_links 재구축(이 문서의 행 전체 DELETE 후 재INSERT,
 *   워크스페이스 미디어 참조는 link_type='media') + syncWorkspaceMediaVisibility.
 *   둘 다 await 하되 실패는 콘솔 로그만 — 이미 커밋된 본문/리비전을 훼손하지 않는다.
 */
export async function saveWorkspacePage(
    c: Context<Env>,
    input: SaveWorkspacePageInput
): Promise<SaveWorkspacePageResult> {
    const db = c.env.DB;
    const metrics = computePageMetrics(input.content);
    const summary = input.summary ?? null;

    const page = await db
        .prepare(
            'SELECT id, version FROM workspace_pages WHERE workspace_id = ? AND slug = ? AND deleted_at IS NULL'
        )
        .bind(input.workspaceId, input.slug)
        .first<{ id: number; version: number }>();

    let pageId: number;
    let revisionId: number;
    let newVersion: number;
    let created: boolean;

    if (!page) {
        // ===== 생성 경로 =====
        created = true;
        newVersion = 1;
        let pageResult: D1Result;
        try {
            pageResult = await db
                .prepare(
                    `INSERT INTO workspace_pages
                        (workspace_id, slug, title, content, version, redirect_to, doc_type, ws_public, rows, characters)
                     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
                )
                .bind(
                    input.workspaceId,
                    input.slug,
                    input.title === undefined ? null : input.title,
                    input.content,
                    input.redirectTo === undefined ? null : input.redirectTo,
                    input.docType === undefined ? null : input.docType,
                    input.wsPublic === undefined ? 0 : (input.wsPublic ? 1 : 0),
                    metrics.rows,
                    metrics.characters
                )
                .run();
        } catch (e: any) {
            // UNIQUE(workspace_id, slug) — precheck~INSERT 사이 경합, 또는 같은 slug 의
            // 소프트 삭제 행이 슬롯을 점유 중(UNIQUE 가 deleted_at 을 조건으로 두지 않음).
            const msg = String(e?.message || e);
            if (/UNIQUE|constraint/i.test(msg)) throw codedError('SLUG_TAKEN');
            throw e;
        }
        pageId = pageResult.meta.last_row_id;

        let r2Key: string;
        try {
            r2Key = await uploadWorkspaceRevisionToR2(c.env.MEDIA, input.workspaceId, pageId, 1, input.content);
        } catch (e) {
            await db.prepare('DELETE FROM workspace_pages WHERE id = ?').bind(pageId).run().catch(() => {});
            throw e;
        }
        try {
            const revResult = await db
                .prepare(
                    'INSERT INTO workspace_revisions (page_id, page_version, content, r2_key, summary, author_id) VALUES (?, ?, ?, ?, ?, ?)'
                )
                .bind(pageId, 1, '', r2Key, summary, input.authorId)
                .run();
            revisionId = revResult.meta.last_row_id;
        } catch (e) {
            await c.env.MEDIA.delete(r2Key).catch(() => {});
            await db.prepare('DELETE FROM workspace_pages WHERE id = ?').bind(pageId).run().catch(() => {});
            throw e;
        }
        await db
            .prepare('UPDATE workspace_pages SET last_revision_id = ? WHERE id = ?')
            .bind(revisionId, pageId)
            .run();
    } else {
        // ===== 수정 경로 (version-CAS 낙관적 락) =====
        created = false;
        pageId = page.id;
        if (input.expectedVersion !== undefined && input.expectedVersion !== page.version) {
            throw codedError('CONCURRENT_MODIFICATION');
        }
        newVersion = page.version + 1;

        const r2Key = await uploadWorkspaceRevisionToR2(
            c.env.MEDIA, input.workspaceId, pageId, newVersion, input.content
        );
        try {
            const revResult = await db
                .prepare(
                    'INSERT INTO workspace_revisions (page_id, page_version, content, r2_key, summary, author_id) VALUES (?, ?, ?, ?, ?, ?)'
                )
                .bind(pageId, newVersion, '', r2Key, summary, input.authorId)
                .run();
            revisionId = revResult.meta.last_row_id;
        } catch (e) {
            await c.env.MEDIA.delete(r2Key).catch(() => {});
            throw e;
        }

        // title/redirect_to/doc_type/ws_public: undefined 면 SET 절 자체를 생략해 기존 값 유지.
        const setClauses: string[] = ['content = ?'];
        const bindings: unknown[] = [input.content];
        if (input.title !== undefined) {
            setClauses.push('title = ?');
            bindings.push(input.title);
        }
        if (input.redirectTo !== undefined) {
            setClauses.push('redirect_to = ?');
            bindings.push(input.redirectTo);
        }
        if (input.docType !== undefined) {
            setClauses.push('doc_type = ?');
            bindings.push(input.docType);
        }
        if (input.wsPublic !== undefined) {
            setClauses.push('ws_public = ?');
            bindings.push(input.wsPublic ? 1 : 0);
        }
        setClauses.push(
            'last_revision_id = ?', 'version = ?', 'rows = ?', 'characters = ?', 'updated_at = unixepoch()'
        );
        bindings.push(revisionId, newVersion, metrics.rows, metrics.characters);
        bindings.push(pageId, page.version);

        let updResult: D1Result;
        try {
            updResult = await db
                .prepare(`UPDATE workspace_pages SET ${setClauses.join(', ')} WHERE id = ? AND version = ?`)
                .bind(...bindings)
                .run();
        } catch (e) {
            await db.prepare('DELETE FROM workspace_revisions WHERE id = ?').bind(revisionId).run().catch(() => {});
            await c.env.MEDIA.delete(r2Key).catch(() => {});
            throw e;
        }
        if (!updResult.meta.changes) {
            // CAS 패배 — SELECT 이후 다른 커밋이 version 을 올림. 막 만든 리비전/R2 정리.
            await db.prepare('DELETE FROM workspace_revisions WHERE id = ?').bind(revisionId).run().catch(() => {});
            await c.env.MEDIA.delete(r2Key).catch(() => {});
            throw codedError('CONCURRENT_MODIFICATION');
        }
    }

    // ===== 커밋 후 색인/동기화 (best-effort — 본문 커밋은 이미 완료) =====
    try {
        const links = extractPageLinks(input.content);
        const mediaSeen = new Set<string>();
        const stmts: D1PreparedStatement[] = [
            db.prepare('DELETE FROM workspace_page_links WHERE source_page_id = ?').bind(pageId),
        ];
        const insertLink = db.prepare(
            'INSERT INTO workspace_page_links (source_page_id, target_slug, link_type, workspace_id) VALUES (?, ?, ?, ?)'
        );
        for (const l of links) {
            stmts.push(insertLink.bind(pageId, l.target_slug, l.link_type, input.workspaceId));
        }
        // 워크스페이스 미디어 참조(/wsmedia/{wsId}/{filename}) — link_type='media', target=파일명.
        for (const filename of extractWorkspaceMediaRefs(input.content, input.workspaceId)) {
            if (mediaSeen.has(filename)) continue;
            mediaSeen.add(filename);
            stmts.push(insertLink.bind(pageId, filename, 'media', input.workspaceId));
        }
        await db.batch(stmts);
    } catch (e) {
        console.error('workspace page_links rebuild failed:', e);
    }
    try {
        await syncWorkspaceMediaVisibility(db, input.workspaceId);
    } catch (e) {
        console.error('workspace media visibility sync failed:', e);
    }

    return {
        page_id: pageId,
        revision_id: revisionId,
        new_version: newVersion,
        rows: metrics.rows,
        characters: metrics.characters,
        created,
    };
}
