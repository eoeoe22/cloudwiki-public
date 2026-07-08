// users 테이블에 mcp_instant_apply 컬럼이 누락된 기존 D1 데이터베이스를 위한 idempotent
// 런타임 마이그레이션. (mcpDraftsMigration 과 동일 패턴)
//
// users 는 세션 미들웨어·MCP Bearer 인증 등 매 요청 핫패스에서 SELECT 되므로, 컬럼을
// 참조하는 SELECT 이전에 반드시 이 마이그레이션을 보장해야 한다. 신선한 환경에서는
// migrations/schema.sql 의 CREATE TABLE 이 이미 컬럼을 포함하므로 PRAGMA 조회만 하고
// 즉시 종료한다. 기존 배포 환경에서는 ALTER TABLE 로 컬럼을 추가한다.
//
// Workers 의 isolate 가 살아있는 동안은 결과를 캐시해 PRAGMA 조회를 한 번만 수행한다.
// 실패 시 캐시를 비워 다음 호출에서 재시도하도록 한다.

let migrationDone = false;
let migrationInflight: Promise<void> | null = null;

export function resetMcpInstantApplyMigrationCacheForTests() {
    migrationDone = false;
    migrationInflight = null;
}

export async function ensureMcpInstantApplyMigration(db: D1Database): Promise<void> {
    if (migrationDone) return;
    if (migrationInflight) return migrationInflight;
    migrationInflight = (async () => {
        try {
            const cols = await db.prepare('PRAGMA table_info(users)').all<{ name: string }>();
            const have = new Set(cols.results.map(c => c.name));
            if (!have.has('mcp_instant_apply')) {
                await db.prepare('ALTER TABLE users ADD COLUMN mcp_instant_apply INTEGER NOT NULL DEFAULT 0').run();
            }
            migrationDone = true;
        } catch (e) {
            migrationInflight = null;
            console.error('ensureMcpInstantApplyMigration failed:', e);
            return;
        } finally {
            migrationInflight = null;
        }
    })();
    return migrationInflight!;
}
