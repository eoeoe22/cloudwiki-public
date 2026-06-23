// revisions 테이블에 is_virtual 컬럼이 누락된 기존 D1 데이터베이스를 위한
// idempotent 런타임 마이그레이션.
//
// is_virtual: 본문이 바뀌지 않은 비-본문 변경(편집 ACL 변경, 비공개 플래그 변경,
// 주소(slug) 이동)을 편집 요약으로만 기록하는 가상 리비전 플래그. 리비전 목록/열람/
// 비교/되돌리기/삭제 및 전역 최근 리비전 쿼리가 이 컬럼을 참조하므로, 컬럼이 없는
// 레거시 환경에서는 `no such column: is_virtual` 로 실패한다.
//
// 신선한 환경에서는 migrations/schema.sql 의 CREATE TABLE 이 이미 컬럼을 포함하므로
// 본 함수는 PRAGMA 조회만 하고 즉시 종료한다. 기존 배포 환경에서는 ALTER TABLE 로
// 컬럼을 추가한다. SQLite 의 ALTER ADD COLUMN 은 IF NOT EXISTS 를 지원하지 않으므로
// PRAGMA table_info 로 미리 확인한 뒤 필요한 ALTER 만 실행한다.
//
// Workers 의 isolate 가 살아있는 동안은 결과를 캐시해 PRAGMA 조회를 한 번만 수행한다.
// 실패 시 캐시를 비워 다음 호출에서 재시도하도록 한다. 콜드 스타트마다 최대 1회만 실행.

let migrationDone = false;
let migrationInflight: Promise<void> | null = null;

export function resetRevisionsVirtualMigrationCacheForTests() {
    migrationDone = false;
    migrationInflight = null;
}

export async function ensureRevisionsVirtualMigration(db: D1Database): Promise<void> {
    if (migrationDone) return;
    if (migrationInflight) return migrationInflight;
    migrationInflight = (async () => {
        try {
            const cols = await db.prepare('PRAGMA table_info(revisions)').all<{ name: string }>();
            const have = new Set(cols.results.map(c => c.name));
            if (!have.has('is_virtual')) {
                await db.prepare('ALTER TABLE revisions ADD COLUMN is_virtual INTEGER NOT NULL DEFAULT 0').run();
            }
            migrationDone = true;
        } catch (e) {
            migrationInflight = null;
            console.error('ensureRevisionsVirtualMigration failed:', e);
            return;
        } finally {
            migrationInflight = null;
        }
    })();
    return migrationInflight!;
}
