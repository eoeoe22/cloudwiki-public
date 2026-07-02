// qr_login_sessions 테이블이 누락된 기존 D1 데이터베이스를 위한 idempotent 런타임 마이그레이션.
//
// 신선한 환경에서는 migrations/schema.sql 의 CREATE TABLE 이 이미 테이블을 포함하므로
// 본 함수는 즉시 종료된다. 기존 배포 환경에서는 QR 로그인 라우트가 처음 호출될 때
// CREATE TABLE IF NOT EXISTS 로 테이블과 인덱스를 생성한다(신규 테이블이라 컬럼 ALTER 불필요).
//
// Workers 의 isolate 가 살아있는 동안은 결과를 캐시해 DDL 실행을 콜드 스타트마다 최대 1회로 제한한다.
// 실패 시 캐시를 비워 다음 호출에서 재시도하도록 한다.
//
// 참고: migrations/schema.sql 이 단일 소스이므로, 프로덕션 D1 에는 아래 CREATE 문을 직접 적용하는
// 것이 정석이다. 본 헬퍼는 main 자동 배포 직후 스키마 적용 전이라도 기능이 500 나지 않도록 하는
// 방어선이다(다른 ensure* 런타임 마이그레이션과 동일한 패턴).

let migrationDone = false;
let migrationInflight: Promise<void> | null = null;

export function resetQrLoginMigrationCacheForTests() {
    migrationDone = false;
    migrationInflight = null;
}

export async function ensureQrLoginMigration(db: D1Database): Promise<void> {
    if (migrationDone) return;
    if (migrationInflight) return migrationInflight;
    migrationInflight = (async () => {
        try {
            await db
                .prepare(
                    `CREATE TABLE IF NOT EXISTS qr_login_sessions (
                        token            TEXT PRIMARY KEY,
                        secret_hash      TEXT NOT NULL,
                        status           TEXT NOT NULL DEFAULT 'pending',
                        guest_ua         TEXT,
                        approved_user_id INTEGER,
                        created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
                        expires_at       INTEGER NOT NULL,
                        approved_at      INTEGER,
                        consumed_at      INTEGER,
                        FOREIGN KEY (approved_user_id) REFERENCES users(id)
                    )`
                )
                .run();
            await db
                .prepare('CREATE INDEX IF NOT EXISTS idx_qr_login_expires ON qr_login_sessions(expires_at)')
                .run();
            migrationDone = true;
        } catch (e) {
            // 캐시를 비워 다음 요청에서 재시도. 본 마이그레이션은 best-effort 이며,
            // 테이블 미존재 시 D1 자체가 에러를 던져 호출 측 catch 에 노출된다.
            console.error('ensureQrLoginMigration failed:', e);
        } finally {
            migrationInflight = null;
        }
    })();
    return migrationInflight;
}
