// pending_edits 테이블에 auto_summary 컬럼이 누락된 기존 D1 데이터베이스를 위한
// idempotent 런타임 마이그레이션.
//
// 편집 요약 병합 모델(utils/editSummary.ts)에서 편집 요청은 사용자 입력분(summary)과
// 자동요약분(auto_summary)을 분리해 보관한다. 승인 편집기가 사용자 입력만 미리 채우고,
// 승인 저장 시 자동요약이 한 번 더 합쳐지는 중복을 막기 위함이다.
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

export function resetPendingEditsSummaryMigrationCacheForTests() {
    migrationDone = false;
    migrationInflight = null;
}

export async function ensurePendingEditsSummaryMigration(db: D1Database): Promise<void> {
    if (migrationDone) return;
    if (migrationInflight) return migrationInflight;
    migrationInflight = (async () => {
        try {
            const cols = await db.prepare('PRAGMA table_info(pending_edits)').all<{ name: string }>();
            const have = new Set(cols.results.map(c => c.name));
            if (!have.has('auto_summary')) {
                await db.prepare('ALTER TABLE pending_edits ADD COLUMN auto_summary TEXT').run();
            }
            migrationDone = true;
        } catch (e) {
            migrationInflight = null;
            console.error('ensurePendingEditsSummaryMigration failed:', e);
            return;
        } finally {
            migrationInflight = null;
        }
    })();
    return migrationInflight!;
}
