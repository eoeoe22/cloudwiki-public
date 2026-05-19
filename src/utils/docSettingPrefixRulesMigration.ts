// doc_setting_prefix_rules 테이블에 categories 컬럼이 누락된 기존 D1 데이터베이스를
// 위한 idempotent 런타임 마이그레이션.
//
// 신선한 환경에서는 migrations/schema.sql 의 CREATE TABLE 이 이미 컬럼/CHECK 를
// 포함하므로 본 함수는 PRAGMA / sqlite_schema 조회만 하고 즉시 종료한다. 기존
// 배포 환경에서는 다음을 순차 적용한다.
//
//   1) ALTER TABLE ADD COLUMN categories TEXT  — 컬럼이 없을 때만.
//   2) 구 CHECK 제약(`is_private IS NOT NULL OR edit_acl IS NOT NULL`) 이 남아 있으면
//      sqlite_schema 의 CREATE TABLE 문자열로 감지해 테이블을 재생성 후 데이터 복사.
//      재생성하지 않으면 categories-only 행 INSERT 가 CHECK 위반으로 실패한다.
//
// SQLite 의 ALTER ADD COLUMN 은 IF NOT EXISTS 를 지원하지 않으므로 PRAGMA table_info
// 로 미리 확인한 뒤 필요한 ALTER 만 실행한다. CHECK 제약 갱신도 SQLite ALTER 로
// 직접 변경할 수 없어 테이블 재생성 패턴(`new → copy → drop → rename`) 으로 한다.
//
// Workers 의 isolate 가 살아있는 동안은 결과를 캐시해 PRAGMA 조회를 한 번만 수행한다.
// 실패 시 캐시를 비워 다음 호출에서 재시도하도록 한다. 콜드 스타트마다 최대 1회만 실행.

let migrationDone = false;
let migrationInflight: Promise<void> | null = null;

export function resetDocSettingPrefixRulesMigrationCacheForTests() {
    migrationDone = false;
    migrationInflight = null;
}

export async function ensureDocSettingPrefixRulesMigration(db: D1Database): Promise<void> {
    if (migrationDone) return;
    if (migrationInflight) return migrationInflight;
    migrationInflight = (async () => {
        try {
            // 0) 크래시 복구: 이전 마이그레이션이 DROP main 직후 RENAME _new 직전에 중단되면
            //    _new 만 남고 main 이 없는 상태가 된다. 이 경우 _new 를 main 으로 승격해 복구한다.
            const mainExists = await db
                .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='doc_setting_prefix_rules'")
                .first<{ name: string }>();
            if (!mainExists) {
                const newExists = await db
                    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='doc_setting_prefix_rules_new'")
                    .first<{ name: string }>();
                if (newExists) {
                    try {
                        await db.prepare('ALTER TABLE doc_setting_prefix_rules_new RENAME TO doc_setting_prefix_rules').run();
                    } catch (e) {
                        // 동시 isolate 가 먼저 rename 했을 수 있음 — 무해.
                        console.warn('docSettingPrefixRulesMigration: recovery rename raced:', e);
                    }
                }
                // 둘 다 없으면 본 마이그레이션이 처리할 수 있는 일이 없다 — schema.sql 의 CREATE TABLE 이 적용되어야 함.
            }

            // 1) categories 컬럼 추가 (없을 때만)
            const cols = await db.prepare('PRAGMA table_info(doc_setting_prefix_rules)').all<{ name: string }>();
            const have = new Set(cols.results.map(c => c.name));
            if (!have.has('categories')) {
                try {
                    await db.prepare('ALTER TABLE doc_setting_prefix_rules ADD COLUMN categories TEXT').run();
                } catch (e) {
                    // 동시 isolate 가 먼저 추가했으면 'duplicate column' — 검증 후 무시.
                    const recheck = await db.prepare('PRAGMA table_info(doc_setting_prefix_rules)').all<{ name: string }>();
                    if (!new Set(recheck.results.map(c => c.name)).has('categories')) throw e;
                }
            }

            // 2) CHECK 제약이 categories 를 포함하는지 검사 — sqlite_schema 의 CREATE TABLE SQL 을 본다.
            //    구 CHECK 면 테이블을 재생성한다. 새 CHECK 거나 CHECK 자체가 없으면 통과.
            const schemaRow = await db
                .prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='doc_setting_prefix_rules'")
                .first<{ sql: string | null }>();
            const ddl = schemaRow?.sql ?? '';
            const checkHasCategories = /categories\s+IS\s+NOT\s+NULL/i.test(ddl);
            const hasCheckClause = /\bCHECK\s*\(/i.test(ddl);
            if (hasCheckClause && !checkHasCategories) {
                // 테이블 재생성. D1 의 batch 는 DDL 을 트랜잭션으로 묶지 못하므로 순차 실행 — 두 isolate 가
                // 동시에 cold-start 하면 한쪽이 다른 쪽이 채우는 중인 _new 를 잘못 DROP 할 수 있다.
                // 해결: `CREATE TABLE _new` 를 `IF NOT EXISTS` 없이 호출해 cross-isolate lock 으로 활용.
                // 실패하면 다른 isolate 가 마이그레이션 중이라는 의미 — 작업을 중단하고 그 isolate 가 끝내도록 둔다.
                // (다음 콜드 스타트 호출은 캐시가 초기화되므로 재시도된다.)
                try {
                    await db
                        .prepare(
                            `CREATE TABLE doc_setting_prefix_rules_new (
                                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                                prefix     TEXT NOT NULL UNIQUE,
                                is_private INTEGER,
                                edit_acl   TEXT,
                                categories TEXT,
                                created_at INTEGER DEFAULT (unixepoch()),
                                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                                CHECK (is_private IS NOT NULL OR edit_acl IS NOT NULL OR categories IS NOT NULL)
                            )`
                        )
                        .run();
                } catch (e) {
                    // _new 가 이미 존재 — 동시 마이그레이션 중이거나 이전 시도의 미완 잔재.
                    // 즉시 반환하면 호출자(POST/bulk persist)가 구 CHECK 가 적용된 main 에 categories-only
                    // 행을 INSERT 했다가 CHECK 위반으로 실패할 수 있다. 다른 isolate 가 RENAME 까지 끝내
                    // CHECK 가 갱신될 때까지 폴링한다 (deadline 까지 idempotent 재검사).
                    console.warn('docSettingPrefixRulesMigration: _new exists — polling for concurrent migration to finish');
                    const deadline = Date.now() + 5000;
                    while (Date.now() < deadline) {
                        await new Promise(r => setTimeout(r, 150));
                        const row = await db
                            .prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='doc_setting_prefix_rules'")
                            .first<{ sql: string | null }>();
                        if (/categories\s+IS\s+NOT\s+NULL/i.test(row?.sql ?? '')) {
                            migrationDone = true;
                            return;
                        }
                    }
                    // 타임아웃 — orphan _new 가능성. migrationDone 을 세팅하지 않아 다음 콜드 스타트 호출이
                    // 재시도하게 한다. 운영자가 수동으로 _new 를 DROP 해야 회복되지만, 그 사이 main 은 무손상.
                    console.warn('docSettingPrefixRulesMigration: timed out waiting — _new likely orphaned');
                    migrationInflight = null;
                    return;
                }

                // 이 시점부터 _new 의 단독 소유권은 우리에게 있다 — 안전하게 진행.
                await db
                    .prepare(
                        `INSERT INTO doc_setting_prefix_rules_new
                            (id, prefix, is_private, edit_acl, categories, created_at, created_by)
                         SELECT id, prefix, is_private, edit_acl, categories, created_at, created_by
                         FROM doc_setting_prefix_rules`
                    )
                    .run();
                await db.prepare('DROP TABLE doc_setting_prefix_rules').run();
                await db.prepare('ALTER TABLE doc_setting_prefix_rules_new RENAME TO doc_setting_prefix_rules').run();
            }

            migrationDone = true;
        } catch (e) {
            // 캐시를 비워 다음 요청에서 재시도. 실패 시 호출 측이 컬럼 미존재 에러를 만나면
            // 그 catch 에서 노출되므로 본 함수에서는 throw 하지 않는다 (best-effort).
            migrationInflight = null;
            console.error('ensureDocSettingPrefixRulesMigration failed:', e);
            return;
        } finally {
            migrationInflight = null;
        }
    })();
    return migrationInflight!;
}
