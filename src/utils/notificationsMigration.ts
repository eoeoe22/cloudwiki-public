// notifications 테이블에 read_at 컬럼이 누락된 기존 D1 데이터베이스를 위한 idempotent
// 런타임 마이그레이션. 읽음·보관 모델(읽음 상태 + 90일 보존) 도입에 따라 추가됐다.
//
// 신선한 환경에서는 migrations/schema.sql 의 CREATE TABLE 이 이미 read_at 을 포함하므로
// 본 함수는 PRAGMA 조회만 하고 즉시 종료한다. 기존 배포 환경에서는 ALTER TABLE 로
// read_at 컬럼을 추가하고 안 읽은 알림 카운트용 부분 인덱스 및 90일 보존 정리용 인덱스를
// 생성한다. SQLite 의 ALTER ADD COLUMN 은 IF NOT EXISTS 를 지원하지 않으므로 PRAGMA
// table_info 로 미리 확인한 뒤 필요한 ALTER 만 실행한다.
//
// Workers 의 isolate 가 살아있는 동안은 결과를 캐시해 PRAGMA 조회를 한 번만 수행한다.
// 실패 시 캐시를 비워 다음 호출에서 재시도하도록 한다. 콜드 스타트마다 최대 1회만 실행.

let migrationDone = false;
let migrationInflight: Promise<void> | null = null;

export function resetNotificationsMigrationCacheForTests() {
    migrationDone = false;
    migrationInflight = null;
}

export async function ensureNotificationsMigration(db: D1Database): Promise<void> {
    if (migrationDone) return;
    if (migrationInflight) return migrationInflight;
    migrationInflight = (async () => {
        try {
            const cols = await db.prepare('PRAGMA table_info(notifications)').all<{ name: string }>();
            const have = new Set(cols.results.map(c => c.name));
            // ALTER 는 DDL — D1 에서 batch 안에 넣지 못하므로 순차 실행한다.
            if (!have.has('read_at')) {
                await db.prepare('ALTER TABLE notifications ADD COLUMN read_at INTEGER').run();
            }
            // 부분/일반 인덱스는 IF NOT EXISTS 가 정상 동작 — idempotent.
            await db.prepare(
                'CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL'
            ).run();
            await db.prepare(
                'CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at)'
            ).run();
            migrationDone = true;
        } catch (e) {
            // 캐시를 비워 다음 요청에서 재시도. best-effort 이며 read_at 미존재 시 D1 자체가
            // 에러를 던지므로 호출 측 catch 가 노출된다.
            migrationInflight = null;
            console.error('ensureNotificationsMigration failed:', e);
            return;
        } finally {
            migrationInflight = null;
        }
    })();
    return migrationInflight!;
}
