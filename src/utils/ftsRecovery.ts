// FTS5 외부 콘텐츠 인덱스(pages_fts) 손상에 대한 자가복구 헬퍼.
//
// pages_fts 는 `content=pages` 외부 콘텐츠 테이블이라, 인덱스 정합성을 트리거가
// 전달하는 OLD/NEW 값에만 의존한다(검증 불가). 한 번이라도 어긋나면 즉시가 아니라
// 그 세그먼트를 처음 건드리는 동작 시점에 SQLITE_CORRUPT_VTAB
// ("database disk image is malformed")로 드러난다. 특히 문서 저장(UPDATE/INSERT pages)
// 은 FTS 트리거가 섀도 b-tree 를 읽어야 하므로 손상이 저장 실패로 표면화된다.
//
// 손상은 파생 인덱스에 국한되고 원본 pages 는 멀쩡하므로,
// `INSERT INTO pages_fts(pages_fts) VALUES('rebuild')` 로 인덱스를 원본에서
// 재생성하면 데이터 손실 없이 복구된다. 이 모듈은 그 복구를 쓰기 경로에서 자동화한다.

// FTS5 가상 테이블 손상(SQLITE_CORRUPT_VTAB)을 나타내는 D1 에러 메시지 패턴.
const FTS_CORRUPT_RE = /malformed|SQLITE_CORRUPT|disk image/i;

/** 주어진 에러가 FTS 인덱스 손상(malformed/CORRUPT)인지 판별. */
export function isFtsCorruptionError(e: unknown): boolean {
    const msg = String((e as { message?: unknown })?.message ?? e ?? '');
    return FTS_CORRUPT_RE.test(msg);
}

/** pages_fts 인덱스를 원본 pages 테이블에서 재생성한다. */
export async function rebuildPagesFts(db: D1Database): Promise<void> {
    await db.prepare("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')").run();
}

/**
 * 쓰기 작업을 실행하되, FTS 인덱스 손상으로 실패하면 인덱스를 재구축하고 1회 재시도한다.
 *
 * 호출 측 op 은 멱등해야 한다 — D1 의 단일 문장(UPDATE/INSERT)은 트리거 포함 원자적이라
 * 손상으로 throw 되면 전체가 롤백되므로(부분 적용 없음) 재시도가 안전하다. 따라서 op 은
 * 매 호출마다 prepare→bind→run 을 새로 수행하는 클로저로 전달한다.
 *
 * 재구축 후에도 실패하면(=손상이 FTS 인덱스가 아니거나 재구축이 못 고친 경우) 에러를
 * 그대로 재던져 호출자의 기존 정리/에러 매핑 로직이 동작하게 한다.
 */
export async function withFtsRecovery<T>(db: D1Database, op: () => Promise<T>): Promise<T> {
    try {
        return await op();
    } catch (e) {
        if (!isFtsCorruptionError(e)) throw e;
        console.error('FTS5 corruption detected on page write; rebuilding pages_fts and retrying once:', e);
        await rebuildPagesFts(db);
        return await op();
    }
}
