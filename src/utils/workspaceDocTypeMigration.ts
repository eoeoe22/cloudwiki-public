// workspace_pages 의 `view_mode` 컬럼을 `doc_type` 으로 이름 변경하는 idempotent 런타임
// 마이그레이션. 프레젠테이션 모드를 워크스페이스 전용으로 이관하면서 컬럼을 일반화(`doc_type`)
// 한 변경에 대응한다.
//
// 메인 브랜치가 Cloudflare Workers 에 자동 배포되므로, 새 코드가 `doc_type` 을 INSERT/UPDATE
// 하는 시점과 운영자가 수동 ALTER 를 적용하는 시점 사이에 `no such column: doc_type` 실패 창이
// 생긴다. 이를 막기 위해 기존 `workspaceMembersStatusMigration` 패턴을 따라 런타임에서 한 번만
// 컬럼을 정리한다:
//   - 이미 `doc_type` 이 있으면(신선한 schema.sql 또는 이미 마이그레이션됨) PRAGMA 조회 후 종료.
//   - `view_mode` 만 있으면 RENAME COLUMN 으로 값까지 보존해 `doc_type` 으로 이름 변경.
//   - 둘 다 없으면(이론상 비정상) 방어적으로 `doc_type` 컬럼을 추가.
//
// SQLite 의 ALTER 는 IF NOT EXISTS 를 지원하지 않으므로 PRAGMA table_info 로 미리 확인한다.
// isolate 가 사는 동안 결과를 캐시해 PRAGMA 조회를 1회로 줄이고, 실패 시 캐시를 비워 재시도한다.

let migrationDone = false;
let migrationInflight: Promise<void> | null = null;

export function resetWorkspaceDocTypeMigrationCacheForTests() {
    migrationDone = false;
    migrationInflight = null;
}

export async function ensureWorkspaceDocTypeMigration(db: D1Database): Promise<void> {
    if (migrationDone) return;
    if (migrationInflight) return migrationInflight;
    migrationInflight = (async () => {
        try {
            const cols = await db.prepare('PRAGMA table_info(workspace_pages)').all<{ name: string }>();
            const have = new Set(cols.results.map(c => c.name));
            if (!have.has('doc_type')) {
                if (have.has('view_mode')) {
                    // 값 보존 이름 변경(기존 프레젠테이션 문서의 플래그 유지).
                    await db.prepare('ALTER TABLE workspace_pages RENAME COLUMN view_mode TO doc_type').run();
                } else {
                    // 방어적: 두 컬럼 모두 없으면 새로 추가.
                    await db.prepare('ALTER TABLE workspace_pages ADD COLUMN doc_type TEXT').run();
                }
            }
            migrationDone = true;
        } catch (e) {
            // 캐시를 비워 다음 요청에서 재시도. best-effort.
            migrationInflight = null;
            console.error('ensureWorkspaceDocTypeMigration failed:', e);
            return;
        } finally {
            migrationInflight = null;
        }
    })();
    return migrationInflight!;
}
