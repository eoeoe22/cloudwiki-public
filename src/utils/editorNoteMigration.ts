// pages 테이블에 editor_note 컬럼이 누락된 기존 D1 데이터베이스를 위한
// idempotent 런타임 마이그레이션.
//
// editor_note: 편집자 전용 메모. 일반 열람·MCP read_document 에는 노출되지 않고
// 편집기 로딩 시에만 응답에 포함된다. 리비전으로 추적되지 않으며, 편집 메모만
// 변경 시 가상 리비전(is_virtual=1)으로 기록된다.
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

export function resetEditorNoteMigrationCacheForTests() {
    migrationDone = false;
    migrationInflight = null;
}

export async function ensureEditorNoteMigration(db: D1Database): Promise<void> {
    if (migrationDone) return;
    if (migrationInflight) return migrationInflight;
    migrationInflight = (async () => {
        try {
            const cols = await db.prepare('PRAGMA table_info(pages)').all<{ name: string }>();
            const have = new Set(cols.results.map(c => c.name));
            if (!have.has('editor_note')) {
                await db.prepare('ALTER TABLE pages ADD COLUMN editor_note TEXT').run();
            }
            migrationDone = true;
        } catch (e) {
            migrationInflight = null;
            console.error('ensureEditorNoteMigration failed:', e);
            return;
        } finally {
            migrationInflight = null;
        }
    })();
    return migrationInflight!;
}
