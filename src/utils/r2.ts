/**
 * R2 Hybrid Storage Utils
 */

import { ensureRevisionsVirtualMigration } from './revisionsVirtualMigration';

/**
 * 리비전 본문을 R2에 업로드하고 r2_key를 반환.
 * Key 형식: revisions/{pageId}/{pageVersion}-{token}.md
 *
 * 토큰(업로드마다 랜덤)은 동시성 안전을 위한 것이다. 같은 base 버전을 읽은 두 저장 요청은
 * 동일한 pageVersion(=base+1)을 계산하므로, 토큰이 없으면 같은 키에 업로드해 서로의 본문을
 * 덮어쓰고, 낙관적 락(version-CAS)에서 패배한 요청의 롤백 delete 가 승리한 리비전의 본문까지
 * 지워버릴 수 있다. 키를 업로드마다 유일하게 만들면 각 요청은 자신의 객체만 쓰고/지우므로
 * 경합이 데이터 손실로 이어지지 않는다(불변 캐시 가정도 실제로 성립). 읽기 경로는 항상 DB 의
 * revisions.r2_key 값을 사용하므로 토큰 추가는 투명하다(키를 재구성하는 코드는 없음).
 */
export async function uploadRevisionToR2(
    bucket: R2Bucket,
    pageId: number,
    pageVersion: number,
    content: string
): Promise<string> {
    const token = crypto.randomUUID().slice(0, 8);
    const r2Key = `revisions/${pageId}/${pageVersion}-${token}.md`;
    await bucket.put(r2Key, content, {
        httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
    });
    return r2Key;
}

/**
 * 가상 리비전(virtual revision)을 편집 이력에 기록한다.
 *
 * 본문이 바뀌지 않은 비-본문 변경(편집 ACL 변경, 비공개 플래그 변경, 주소(slug) 이동 등)을
 * 편집 요약 메시지로만 남기는 용도이다. R2 스냅샷을 만들지 않으며(r2_key=NULL, content=''),
 * page_version 도 NULL 로 두고 pages.version / pages.last_revision_id 는 건드리지 않는다.
 * is_virtual=1 로 표시되어 열람/비교/되돌리기/삭제 경로에서 모두 차단된다.
 *
 * 호출부는 try/catch 로 감싸 기록 실패가 원래 변경(ACL/이동)을 깨지 않게 한다.
 */
export function buildVirtualRevisionStatement(
    db: D1Database,
    pageId: number,
    summary: string,
    authorId: number | null
): D1PreparedStatement {
    return db
        .prepare(
            `INSERT INTO revisions (page_id, page_version, content, r2_key, summary, author_id, is_virtual)
             VALUES (?, NULL, '', NULL, ?, ?, 1)`
        )
        .bind(pageId, summary, authorId);
}

export async function insertVirtualRevision(
    db: D1Database,
    pageId: number,
    summary: string,
    authorId: number | null
): Promise<void> {
    // 레거시 DB(is_virtual 컬럼 부재) 대비 idempotent 마이그레이션 보장 후 INSERT.
    await ensureRevisionsVirtualMigration(db);
    await buildVirtualRevisionStatement(db, pageId, summary, authorId).run();
}

/**
 * R2에서 리비전 본문을 가져오며 Cache API로 영구 캐시.
 * 리비전은 불변(Immutable)이므로 max-age=31536000, immutable 적용.
 */
export async function fetchRevisionFromR2(
    bucket: R2Bucket,
    r2Key: string,
    origin: string
): Promise<string> {
    const cacheKey = `${origin}/__r2_revision__/${r2Key}`;
    const cache = (caches as any).default; // Cloudflare Workers caches

    const cached = await cache.match(cacheKey);
    if (cached) return cached.text();

    const obj = await bucket.get(r2Key);
    if (!obj) throw new Error(`R2 revision not found: ${r2Key}`);
    const content = await obj.text();

    // 비동기로 캐시 저장 (응답을 블로킹하지 않음)
    cache.put(
        cacheKey,
        new Response(content, {
            headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
        })
    );

    return content;
}

/**
 * DB 레코드에서 리비전 본문 반환.
 * r2_key가 있으면 R2에서, 없으면 content 필드에서 직접 반환 (하위 호환).
 */
export async function getRevisionContent(
    bucket: R2Bucket,
    revision: { content: string; r2_key?: string | null },
    origin: string
): Promise<string> {
    if (revision.r2_key) {
        return fetchRevisionFromR2(bucket, revision.r2_key, origin);
    }
    return revision.content;
}
