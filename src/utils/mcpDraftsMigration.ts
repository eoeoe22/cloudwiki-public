// mcp_drafts 테이블에 submitted_at / submitted_summary 컬럼이 누락된 기존 D1
// 데이터베이스를 위한 idempotent 런타임 마이그레이션.
//
// 신선한 환경에서는 migrations/schema.sql 의 CREATE TABLE 이 이미 컬럼을 포함하므로
// 본 함수는 PRAGMA 조회만 하고 즉시 종료한다. 기존 배포 환경에서는 ALTER TABLE 로
// 컬럼을 추가하고 부분 인덱스를 생성한다. SQLite 의 ALTER ADD COLUMN 은 IF NOT EXISTS
// 를 지원하지 않으므로 PRAGMA table_info 로 미리 확인한 뒤 필요한 ALTER 만 실행한다.
//
// Workers 의 isolate 가 살아있는 동안은 결과를 캐시해 PRAGMA 조회를 한 번만 수행한다.
// 실패 시 캐시를 비워 다음 호출에서 재시도하도록 한다. 콜드 스타트마다 최대 1회만 실행.

let migrationDone = false;
let migrationInflight: Promise<void> | null = null;

export function resetMcpDraftsMigrationCacheForTests() {
    migrationDone = false;
    migrationInflight = null;
}

export async function ensureMcpDraftsMigration(db: D1Database): Promise<void> {
    if (migrationDone) return;
    if (migrationInflight) return migrationInflight;
    migrationInflight = (async () => {
        try {
            const cols = await db.prepare('PRAGMA table_info(mcp_drafts)').all<{ name: string }>();
            const have = new Set(cols.results.map(c => c.name));
            // ALTER 는 DDL — D1 에서 batch 안에 넣지 못하므로 순차 실행한다.
            if (!have.has('submitted_at')) {
                await db.prepare('ALTER TABLE mcp_drafts ADD COLUMN submitted_at INTEGER').run();
            }
            if (!have.has('submitted_summary')) {
                await db.prepare('ALTER TABLE mcp_drafts ADD COLUMN submitted_summary TEXT').run();
            }
            if (!have.has('title')) {
                await db.prepare('ALTER TABLE mcp_drafts ADD COLUMN title TEXT').run();
            }
            if (!have.has('has_title_change')) {
                await db.prepare('ALTER TABLE mcp_drafts ADD COLUMN has_title_change INTEGER NOT NULL DEFAULT 0').run();
            }
            if (!have.has('editor_note')) {
                await db.prepare('ALTER TABLE mcp_drafts ADD COLUMN editor_note TEXT').run();
            }
            // 부분 인덱스는 IF NOT EXISTS 가 정상 동작 — idempotent.
            await db.prepare(
                'CREATE INDEX IF NOT EXISTS idx_mcp_drafts_submitted ON mcp_drafts(user_id, submitted_at) WHERE submitted_at IS NOT NULL'
            ).run();
            migrationDone = true;
        } catch (e) {
            // 캐시를 비워 다음 요청에서 재시도. 실패가 누적되면 호출 측에 throw 해도 되지만,
            // 본 마이그레이션은 best-effort 이며 본격적인 컬럼 미존재 시 D1 자체가 에러를 던지므로
            // 호출 측 catch 가 노출된다.
            migrationInflight = null;
            console.error('ensureMcpDraftsMigration failed:', e);
            return;
        } finally {
            migrationInflight = null;
        }
    })();
    return migrationInflight!;
}
