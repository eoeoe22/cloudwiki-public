import type { Env } from '../types';
import { RBAC } from '../utils/role';
import { buildLinksOnlyStatements, movePage } from '../routes/wiki';
import { extractPageLinks } from '../shared/links';
import { getEnabledExtensions } from '../utils/extensions';
import { collectRevisionR2Keys, buildHardDeleteStatements } from '../utils/pageDeletion';
import { ragObjectKey, isRagMirrorEnabled, canCleanupMirror } from '../utils/rag';
import { cleanupUnauthorizedSubscriptions } from '../utils/pageAccessCleanup';
import {
    invalidatePageCache,
    invalidateBacklinkCaches,
    refreshRecentChangesCache,
} from '../utils/cacheInvalidation';

//
// ── 관리자 잡 러너 Durable Object (AdminJobDO) ──────────────────────────────
//
// 과거 "유료 전용"이라는 이유로 롤백됐던 `ReindexBacklinksDO`(역링크 전수 재인덱싱 DO,
// `git show 8540640:src/durable/reindexBacklinks.ts`)를 이식 베이스로, **3종 잡을 처리하는
// 단일 잡 러너**로 일반화한 것이다. SQLite-backed DO 가 Workers 프리 티어에서도 가능해져
// 정식 도입한다. alarm 틱마다 서브리퀘스트 한도가 리셋되므로, 과거 동기 대량 API 가
// 클라이언트 청크(역링크 ON 1건 / OFF 25건)로 쪼개야 했던 D1 호출당 쿼리 한도 제약이
// 모두 사라진다.
//
// 처리 잡 3종:
//   - reindex-backlinks : 모든 일반 문서의 `pages.content` 를 다시 읽어 page_links 재구축.
//   - bulk-move         : 선택 문서들의 slug 를 find→replace 치환해 일괄 이동(제목 변경).
//   - bulk-delete       : 선택 문서들을 소프트/하드 일괄 삭제.
//
// 핵심 설계(과거 구현 패턴 계승):
//   - 싱글턴(`idFromName('global')`), 동시에 1개 잡만(`already_running` 409).
//   - alarm 틱마다 커서를 전진시키는 배치 파이프라인. 틱 간격 1초.
//   - 에러 시 throw 하지 않고 상태에 기록(alarm 자동 재시도 억제) → 운영자가 resume.
//   - 틱 말미 fresh 재읽기로 동시 stop(일시정지) 보호.
//   - 예산 회계: `JOB_SUBREQUEST_BUDGET`(미설정/비정상 시 40). D1 statement 뿐 아니라
//     R2 op·Cache op 도 서브리퀘스트 한도에 포함되므로 "서브리퀘스트 총량" 시맨틱.
//     틱당 최소 1건 진행 보장, 단일 항목이 예산 초과면 skip+기록(무한 stall 방지).
//
// c-shim 한계: bulk-move(movePage)·캐시 무효화 헬퍼는 Hono `c` 에서 `c.env`·
// `c.executionCtx.waitUntil`·`new URL(c.req.url).origin` 만 쓴다(조사 완료). 이를 얇은 shim
// 으로 대체하는데, 캐시 무효화는 `WIKI_PUBLIC_BASE_URL` origin 의 `caches.default` 에 대해
// **colo-local best-effort** 다(기존 Worker 경로와 동일 한계 — DO 가 도는 colo 의 캐시만
// 무효화되고 전 엣지에 전파되지 않는다). TTL 만료/다음 편집으로 자가 치유된다.
//

type Bindings = Env['Bindings'];

const META_KEY = 'job:meta';
const PAYLOAD_KEY = 'job:payload';
const R2QUEUE_KEY = 'job:r2queue';

// 틱 간격(완만한 진행으로 D1/R2 부하 분산).
const TICK_DELAY_MS = 1000;
// reindex 틱당 처리 문서 상한.
const MAX_REINDEX_PER_TICK = 25;
// 예산 미설정/비정상 시의 보수적 기본값(무료 티어 가정).
const DEFAULT_BUDGET = 40;

// 결과 배열 캡(128KB DO value 한도 + 무한 누적 방지).
const CAP_SKIPPED_IDS = 50;       // reindex
const CAP_MISMATCHED_DOCS = 100;  // reindex 불일치(누락/잔여) 상세 리스트
const CAP_DELETE_FAILED = 100;    // bulk-delete
const CAP_MOVE_SKIPPED = 100;     // bulk-move skipped
const CAP_MOVE_ERRORS = 50;       // bulk-move backlink_errors / backlink_partials

export type JobType = 'reindex-backlinks' | 'bulk-move' | 'bulk-delete' | 'rag-backfill';

// Worker 라우트가 그대로 패스스루하고 클라이언트도 이 형태에 의존하는 공개 계약.
export interface JobState {
    type: JobType | null;
    status: 'idle' | 'running' | 'completed' | 'error';
    cursor: number;
    total: number;
    processed: number;
    startedAt: number | null;
    updatedAt: number | null;
    finishedAt: number | null;
    error: string | null;
    result: Record<string, unknown> | null;
}

// ── 잡별 result 형태(캡 초과분은 카운터로만 집계) ──
interface ReindexResult {
    linksWritten: number;
    skipped: number;
    skippedIds: number[];
    // 인덱스 불일치 감지·수정 집계. 각 문서를 재기록하기 전, 기존 page_links 를
    // 본문에서 재추출한 링크 집합과 비교해 **실제로 교정된**(누락/잔여가 있던) 문서만 센다.
    //   - mismatched   : 기존 인덱스가 본문과 달랐던(=교정된) 문서 수
    //   - linksAdded   : 인덱스에 누락돼 새로 채워진 링크 수(합계)
    //   - linksRemoved : 본문에 없는데 인덱스에 남아 있던(stale) 링크 제거 수(합계)
    //   - mismatchedDocs : 교정된 문서의 slug + 추가/제거 링크 수(캡 적용)
    mismatched: number;
    linksAdded: number;
    linksRemoved: number;
    mismatchedDocs: { slug: string; added: number; removed: number }[];
}
interface BulkDeleteResult {
    requested: number;
    deleted: number;
    failed: number;
    mode: 'soft' | 'hard';
    failedIds: number[];
}
interface RagBackfillResult {
    mirrored: number;   // RAG_BUCKET 에 본문을 반영한 문서 수
    skipped: number;    // 본문이 비어 있거나 put 실패로 건너뛴 문서 수
}
interface BulkMoveResult {
    requested: number;
    moved: number;
    skipped: { slug: string; reason: string }[];
    skipped_overflow: number;
    backlinks_updated: number;
    backlinks_skipped: number;
    backlinks_conflicts: number;
    backlink_errors: { slug: string; error: string }[];
    backlink_partials: { slug: string; skipped: number; conflicts: number }[];
}

// ── 잡별 payload 형태(시작 시 1회 저장) ──
interface BulkDeletePayload {
    ids: number[];
    mode: 'soft' | 'hard';
    actor: { id: number; role: string };
}
interface BulkMovePayload {
    items: { id: number; slug: string }[];
    find: string;
    replace: string;
    updateBacklinks: boolean;
    actor: { id: number; role: string };
}
type ReindexPayload = Record<string, never>;
type RagBackfillPayload = { actor: { id: number; role: string } };
type JobPayload = ReindexPayload | BulkDeletePayload | BulkMovePayload | RagBackfillPayload;

function initialState(): JobState {
    return {
        type: null,
        status: 'idle',
        cursor: 0,
        total: 0,
        processed: 0,
        startedAt: null,
        updatedAt: null,
        finishedAt: null,
        error: null,
        result: null,
    };
}

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
    });
}

export class AdminJobDO {
    constructor(private state: DurableObjectState, private env: Bindings) {}

    // ── 상태 입출력 ──

    private async loadMeta(): Promise<JobState> {
        return (await this.state.storage.get<JobState>(META_KEY)) ?? initialState();
    }

    private async saveMeta(s: JobState): Promise<void> {
        s.updatedAt = Date.now();
        await this.state.storage.put(META_KEY, s);
    }

    private parseBudget(): number {
        const raw = this.env.JOB_SUBREQUEST_BUDGET;
        const n = raw != null ? Number(raw) : NaN;
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BUDGET;
    }

    // ── HTTP 라우팅 ──

    async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        if (req.method === 'POST' && url.pathname === '/start') return this.handleStart(req);
        if (req.method === 'POST' && url.pathname === '/stop') return this.handleStop();
        if (req.method === 'GET' && url.pathname === '/status') return json(await this.statusPayload());
        return new Response('Not found', { status: 404 });
    }

    // meta + result 병합 단일 JSON.
    private async statusPayload(): Promise<JobState> {
        return await this.loadMeta();
    }

    private async handleStart(req: Request): Promise<Response> {
        const s = await this.loadMeta();
        if (s.status === 'running') {
            return json({ ok: false, reason: 'already_running', state: s }, 409);
        }

        const body = (await req.json().catch(() => ({}))) as {
            type?: JobType;
            payload?: JobPayload;
            resume?: boolean;
        };
        const type = body.type;
        if (type !== 'reindex-backlinks' && type !== 'bulk-move' && type !== 'bulk-delete' && type !== 'rag-backfill') {
            return json({ ok: false, reason: 'invalid_type' }, 400);
        }

        // resume: 직전 error 또는 stop(idle) 상태에서, 같은 type 일 때만 커서·카운터를
        // 보존하고 이어서 재개한다(stop 은 사실상 일시정지). 그 외 start 는 초기화 후 시작.
        const canResume =
            body.resume === true &&
            (s.status === 'error' || s.status === 'idle') &&
            s.type === type;

        let next: JobState;
        if (canResume) {
            next = { ...s, status: 'running', error: null, finishedAt: null };
        } else {
            // 새 잡: payload 검증·저장 + total 산정 + result 초기화.
            const prep = await this.prepareStart(type, body.payload);
            if (prep instanceof Response) return prep;
            next = {
                ...initialState(),
                type,
                status: 'running',
                total: prep.total,
                startedAt: Date.now(),
                result: prep.result as unknown as Record<string, unknown>,
            };
            await this.state.storage.put(PAYLOAD_KEY, prep.payload);
            await this.state.storage.delete(R2QUEUE_KEY);
        }

        await this.saveMeta(next);
        await this.state.storage.setAlarm(Date.now()); // 즉시 첫 배치.
        return json({ ok: true, state: next });
    }

    // 새 잡 시작 준비: payload 정규화·검증, total 계산, result 초기화.
    private async prepareStart(
        type: JobType,
        payload: JobPayload | undefined,
    ): Promise<{ payload: JobPayload; total: number; result: object } | Response> {
        if (type === 'reindex-backlinks') {
            const total = await this.countReindexTargets();
            const result: ReindexResult = {
                linksWritten: 0,
                skipped: 0,
                skippedIds: [],
                mismatched: 0,
                linksAdded: 0,
                linksRemoved: 0,
                mismatchedDocs: [],
            };
            return { payload: {}, total, result };
        }
        if (type === 'rag-backfill') {
            // RAG 미러링이 가능한 환경(플러그인 ON + RAG_BUCKET 구성)이어야 한다.
            if (!isRagMirrorEnabled(this.env)) {
                return json({ ok: false, reason: 'rag_disabled' }, 400);
            }
            const total = await this.countRagBackfillTargets();
            const result: RagBackfillResult = { mirrored: 0, skipped: 0 };
            return { payload: (payload as RagBackfillPayload) ?? { actor: { id: 0, role: '' } }, total, result };
        }
        if (type === 'bulk-delete') {
            const p = payload as BulkDeletePayload | undefined;
            if (!p || !Array.isArray(p.ids) || p.ids.length === 0 || (p.mode !== 'soft' && p.mode !== 'hard') || !p.actor) {
                return json({ ok: false, reason: 'invalid_payload' }, 400);
            }
            const result: BulkDeleteResult = {
                requested: p.ids.length,
                deleted: 0,
                failed: 0,
                mode: p.mode,
                failedIds: [],
            };
            return { payload: p, total: p.ids.length, result };
        }
        // bulk-move
        const p = payload as BulkMovePayload | undefined;
        if (!p || !Array.isArray(p.items) || p.items.length === 0 || !p.find || !p.actor) {
            return json({ ok: false, reason: 'invalid_payload' }, 400);
        }
        const result: BulkMoveResult = {
            requested: p.items.length,
            moved: 0,
            skipped: [],
            skipped_overflow: 0,
            backlinks_updated: 0,
            backlinks_skipped: 0,
            backlinks_conflicts: 0,
            backlink_errors: [],
            backlink_partials: [],
        };
        return { payload: p, total: p.items.length, result };
    }

    // stop = 일시정지(idle). 진행 중인 alarm 틱이 있으면 "즉시"가 아니라 **현재 처리 중인
    // 항목까지 완료한 뒤 항목 경계에서** 멈춘다 — 각 항목 직후의 checkpoint/틱 말미의
    // finishTick 이 fresh 재읽기로 idle 을 감지해 루프 중단·재스케줄 안 함. 이미 D1 에
    // 커밋된 해당 항목의 변경은 유지된다(resume 시 다음 항목부터).
    private async handleStop(): Promise<Response> {
        const s = await this.loadMeta();
        s.status = 'idle';
        await this.saveMeta(s);
        await this.state.storage.deleteAlarm();
        return json({ ok: true, state: s });
    }

    // ── alarm 디스패치 ──

    async alarm(): Promise<void> {
        const s = await this.loadMeta();
        if (s.status !== 'running') return; // stop/완료 후의 잔여 alarm 방어.

        try {
            if (s.type === 'reindex-backlinks') {
                await this.tickReindex(s);
            } else if (s.type === 'bulk-delete') {
                await this.tickBulkDelete(s);
            } else if (s.type === 'bulk-move') {
                await this.tickBulkMove(s);
            } else if (s.type === 'rag-backfill') {
                await this.tickRagBackfill(s);
            } else {
                // 알 수 없는 type — 방어적으로 종료.
                s.status = 'error';
                s.error = 'unknown job type';
                await this.saveMeta(s);
                await this.state.storage.deleteAlarm();
            }
        } catch (e: unknown) {
            // 에러 시 자동 재시도하지 않고 상태에 기록한다(throw 안 함 → alarm 자동 재시도 억제).
            // 운영자가 /status 로 원인을 확인한 뒤 {resume:true} 로 마지막 커서부터 재개할 수 있다.
            s.status = 'error';
            s.error = e instanceof Error ? e.message : String(e);
            await this.saveMeta(s);
        }
    }

    // 틱 종료 공통 처리: 동시 stop 보호(fresh 재읽기) 후 진행분 저장 + 재예약/완료.
    // 진행 카운터(cursor/processed/result)는 항상 보존하고, stop 이 끼어들었으면 상태는
    // 덮어쓰지 않으며 재스케줄도 하지 않는다.
    private async finishTick(s: JobState, done: boolean): Promise<void> {
        const fresh = await this.loadMeta();
        if (fresh.status !== 'running') {
            fresh.cursor = s.cursor;
            fresh.processed = s.processed;
            fresh.result = s.result;
            await this.saveMeta(fresh);
            return;
        }
        if (done) {
            s.status = 'completed';
            s.finishedAt = Date.now();
            await this.saveMeta(s);
            await this.state.storage.deleteAlarm();
            return;
        }
        await this.saveMeta(s);
        await this.state.storage.setAlarm(Date.now() + TICK_DELAY_MS);
    }

    // 항목 처리 직후 호출하는 내구 체크포인트. alarm 은 인프라 크래시/DO eviction 시
    // at-least-once 로 재시도되는데, 커서를 틱 말미에만 저장하면 "외부 D1 커밋은 됐는데
    // 커서는 메모리에만 있던" 항목들이 재실행된다 — hard delete 는 이미 지워진 문서가
    // 거짓 failed 로 집계되고, bulk-move 는 find 가 newSlug 에 다시 매칭되면 **이중 치환**
    // 될 수 있다. 항목마다 커서·카운터를 즉시 저장해 이 윈도우를 항목 1건 수준으로 줄인다.
    // finishTick 과 동일하게 fresh 재읽기로 동시 stop(일시정지)을 존중한다 — stop 이
    // 끼어들었으면 진행 카운터만 병합 저장하고 false 를 반환해 호출 측이 루프를 즉시
    // 중단한다(= stop 은 항목 경계에서 적용. 재스케줄도 하지 않는다).
    private async checkpoint(s: JobState): Promise<boolean> {
        const fresh = await this.loadMeta();
        if (fresh.status !== 'running') {
            fresh.cursor = s.cursor;
            fresh.processed = s.processed;
            fresh.result = s.result;
            await this.saveMeta(fresh);
            return false;
        }
        await this.saveMeta(s);
        return true;
    }

    // ── reindex 틱 ──

    // 본문이 `pages.content` 에 있지 않은 네임스페이스 제외 SQL 조각 + 바인드.
    //  - `이미지:`/`map:` 은 실제 문서가 아닌 가상/예약 네임스페이스.
    //  - 활성 익스텐션 네임스페이스(`freq:`/`stock:` 등)는 `pages.content` 가 빈 문자열이라
    //    포함하면 빈 content 로 재인덱싱돼 역링크가 전부 삭제된다(데이터 손실). 모두 제외한다.
    private reindexExclusion(): { clause: string; binds: string[] } {
        const namespaces = ['이미지', 'map', ...getEnabledExtensions(this.env)];
        const uniq = [...new Set(namespaces.filter((n) => n))];
        const clause = uniq.map(() => "slug NOT LIKE ? ESCAPE '\\'").join(' AND ');
        const binds = uniq.map((ns) => `${ns.replace(/[\\%_]/g, '\\$&')}:%`);
        return { clause, binds };
    }

    private async countReindexTargets(): Promise<number> {
        const { clause, binds } = this.reindexExclusion();
        const row = await this.env.DB.prepare(
            `SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL AND ${clause}`,
        ).bind(...binds).first<{ n: number }>();
        return row?.n ?? 0;
    }

    // 인덱스 불일치 비교용 키. link_type 은 고정 소집합(wikilink/template/extension/
    // image/palette)으로 ':' 을 포함하지 않지만 target_slug 는 임의 문자열이라 널바이트로 구분한다.
    private linkKey(type: string, slug: string): string {
        return `${type}\u0000${slug}`;
    }

    private async tickReindex(s: JobState): Promise<void> {
        const budget = this.parseBudget();
        const result = s.result as unknown as ReindexResult;
        // 배포 이전에 시작·일시정지된 잡을 재개할 때 result 에 신규 불일치 필드가 없을 수
        // 있어 보정한다(없으면 += 가 NaN 이 되고 mismatchedDocs.push 가 throw 함).
        result.mismatched ??= 0;
        result.linksAdded ??= 0;
        result.linksRemoved ??= 0;
        result.mismatchedDocs ??= [];
        const { clause, binds } = this.reindexExclusion();

        // version 도 함께 읽어 동시 편집 감지에 쓴다(쓰기 후 재확인). slug 는 불일치 문서
        // 리스트 표기용(사용자가 "어디가 누락됐는지" 확인).
        const { results } = await this.env.DB.prepare(
            `SELECT id, slug, content, version FROM pages
              WHERE id > ? AND deleted_at IS NULL AND ${clause}
              ORDER BY id ASC
              LIMIT ?`,
        ).bind(s.cursor, ...binds, MAX_REINDEX_PER_TICK)
            .all<{ id: number; slug: string; content: string | null; version: number | null }>();

        if (!results || results.length === 0) {
            await this.finishTick(s, true); // 대상 소진 → 완료.
            return;
        }

        // 이번 틱 대상들의 기존 page_links 를 한 번에 읽어(서브리퀘스트 1건) 문서별 링크 집합을
        // 만든다. 재기록 전 스냅샷이므로 아래 루프의 쓰기와 경쟁하지 않는다. 재추출한 링크와
        // 비교해 누락/잔여(=인덱스가 본문과 어긋난 부분)를 문서 단위로 집계한다.
        const ids = results.map((r) => r.id);
        const placeholders = ids.map(() => '?').join(',');
        const { results: oldLinkRows } = await this.env.DB.prepare(
            `SELECT source_page_id AS id, target_slug, link_type FROM page_links
              WHERE source_type = 'page' AND blog = 0 AND source_page_id IN (${placeholders})`,
        ).bind(...ids).all<{ id: number; target_slug: string; link_type: string }>();

        const oldByPage = new Map<number, Set<string>>();
        for (const lr of oldLinkRows ?? []) {
            let set = oldByPage.get(lr.id);
            if (!set) { set = new Set<string>(); oldByPage.set(lr.id, set); }
            set.add(this.linkKey(lr.link_type, lr.target_slug));
        }
        const EMPTY_LINKS: Set<string> = new Set();

        // 기본 쿼리 2건: 대상 문서 SELECT + 기존 page_links 배치 SELECT(불일치 비교용).
        let queryCount = 2;
        let pagesThisTick = 0;
        for (const row of results) {
            const stmts = buildLinksOnlyStatements(this.env.DB, row.id, row.content || '');
            const cost = stmts.length + 1; // 쓰기 + version 재확인 1건.

            // 단일 문서가 한 틱 예산조차 넘으면(>~budget 링크) skip+기록(무한 stall 방지).
            if (pagesThisTick === 0 && queryCount + cost > budget) {
                s.cursor = row.id;
                result.skipped += 1;
                if (result.skippedIds.length < CAP_SKIPPED_IDS) result.skippedIds.push(row.id);
                pagesThisTick += 1;
                if (!(await this.checkpoint(s))) return;
                continue;
            }
            // 최소 1문서는 처리해 진행을 보장하되, 다음 문서로 예산을 넘기면 이번 틱 종료.
            if (pagesThisTick > 0 && queryCount + cost > budget) break;

            // 불일치 진단: 재추출한 링크 집합 vs 기존 인덱스 집합(둘 다 extractPageLinks 기준으로
            // 중복 제거된 집합). added=인덱스에 없던 링크, removed=본문에 없는데 남아 있던 링크.
            // 여기서는 읽기만 하고(로컬 변수), result 반영은 batch 성공 후로 미룬다 — 쓰기 전에
            // result 를 증가시키면 batch 실패 시 alarm 이 커서 미전진 상태로 증가분을 저장해,
            // 재개 시 같은 행을 다시 세거나(이중 집계) 일어나지 않은 교정을 보고하게 된다.
            const oldSet = oldByPage.get(row.id) ?? EMPTY_LINKS;
            const newSet = new Set<string>();
            let added = 0;
            for (const l of extractPageLinks(row.content || '')) {
                const k = this.linkKey(l.link_type, l.target_slug);
                newSet.add(k);
                if (!oldSet.has(k)) added += 1;
            }
            let removed = 0;
            for (const k of oldSet) if (!newSet.has(k)) removed += 1;

            await this.env.DB.batch(stmts);
            queryCount += stmts.length;
            result.linksWritten += stmts.length - 1; // 선두 DELETE 1개 제외.

            // 재기록이 커밋된 뒤에만 불일치 집계를 result 에 병합한다(linksWritten 과 동일 시점).
            if (added > 0 || removed > 0) {
                result.mismatched += 1;
                result.linksAdded += added;
                result.linksRemoved += removed;
                if (result.mismatchedDocs.length < CAP_MISMATCHED_DOCS) {
                    result.mismatchedDocs.push({ slug: row.slug, added, removed });
                }
            }

            // 동시 편집 보호: 쓰기 직후 version 재확인 → 바뀌었으면 최신 본문으로 1회 재작성.
            queryCount += 1;
            const after = await this.env.DB
                .prepare('SELECT content, version FROM pages WHERE id = ?')
                .bind(row.id)
                .first<{ content: string | null; version: number | null }>();
            if (after && after.version !== row.version) {
                const stmts2 = buildLinksOnlyStatements(this.env.DB, row.id, after.content || '');
                if (stmts2.length + 1 <= budget && queryCount + stmts2.length <= budget) {
                    await this.env.DB.batch(stmts2);
                    queryCount += stmts2.length;
                    result.linksWritten += stmts2.length - 1;
                }
            }

            s.cursor = row.id;
            s.processed += 1;
            pagesThisTick += 1;
            if (!(await this.checkpoint(s))) return;
        }

        await this.finishTick(s, false);
    }

    // ── rag-backfill 틱 ──
    //
    // RAG 플러그인을 켠 뒤, 미러링은 "다음 편집 시점"부터 적용되므로 켜기 전부터 있던 문서는
    // 인덱스에 없다. 이 잡은 전 문서를 한 번 훑어 현행 본문을 RAG_BUCKET 에 채워 넣는 일회성 백필이다.
    // ACL 무관 전 문서를 인덱싱한다(비공개 포함) — 검색 결과의 비공개 필터링은 조회 시점에 수행된다.
    // 본문이 비어 있는 문서(R2-only 익스텐션 네임스페이스 등)는 건너뛴다.

    private async countRagBackfillTargets(): Promise<number> {
        const row = await this.env.DB.prepare(
            'SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL',
        ).first<{ n: number }>();
        return row?.n ?? 0;
    }

    private async tickRagBackfill(s: JobState): Promise<void> {
        if (!isRagMirrorEnabled(this.env)) {
            s.status = 'error';
            s.error = 'RAG 미러링이 비활성화되어 있습니다(RAG_SEARCH_ENABLED / RAG_BUCKET 확인).';
            await this.saveMeta(s);
            await this.state.storage.deleteAlarm();
            return;
        }
        const budget = this.parseBudget();
        const result = s.result as unknown as RagBackfillResult;
        const bucket = this.env.RAG_BUCKET!;

        // 틱당 처리 상한: SELECT 1건 + put N건 ≤ 예산.
        const perTick = Math.max(1, Math.min(50, budget - 1));

        const { results } = await this.env.DB.prepare(
            `SELECT id, slug, content FROM pages
              WHERE id > ? AND deleted_at IS NULL
              ORDER BY id ASC
              LIMIT ?`,
        ).bind(s.cursor, perTick).all<{ id: number; slug: string; content: string | null }>();

        if (!results || results.length === 0) {
            await this.finishTick(s, true); // 대상 소진 → 완료.
            return;
        }

        for (const row of results) {
            const body = row.content || '';
            try {
                if (body.length > 0) {
                    await bucket.put(ragObjectKey(row.slug), body, {
                        httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
                    });
                    result.mirrored += 1;
                } else {
                    result.skipped += 1;
                }
            } catch (e) {
                console.error('rag backfill put failed:', row.slug, e);
                result.skipped += 1;
            }
            s.cursor = row.id;
            s.processed += 1;
            if (!(await this.checkpoint(s))) return;
        }

        await this.finishTick(s, false);
    }

    // ── bulk-delete 틱 ──

    private async tickBulkDelete(s: JobState): Promise<void> {
        const budget = this.parseBudget();
        const payload = (await this.state.storage.get<BulkDeletePayload>(PAYLOAD_KEY))!;
        const result = s.result as unknown as BulkDeleteResult;
        const db = this.env.DB;
        const rbac = new RBAC();
        const sink: Promise<unknown>[] = [];
        const shim = this.makeShim(sink);

        let used = 0; // 서브리퀘스트 회계.

        // 하드 삭제 잔여 R2 키 드레인(이전 틱에서 예산 부족으로 적재된 것).
        if (payload.mode === 'hard') {
            const queued = (await this.state.storage.get<string[]>(R2QUEUE_KEY)) ?? [];
            if (queued.length > 0) {
                const drain: string[] = [];
                while (queued.length > 0 && used < budget) {
                    drain.push(queued.shift()!);
                    used += 1;
                }
                if (drain.length > 0) {
                    await Promise.allSettled(drain.map((k) => this.env.MEDIA.delete(k)));
                }
                await this.state.storage.put(R2QUEUE_KEY, queued);
                if (queued.length > 0) {
                    // 아직 드레인 못 한 키가 남으면 이번 틱은 여기까지.
                    await this.finishTick(s, false);
                    return;
                }
            }
        }

        const SOFT_COST = 12; // 소프트 ~12 서브리퀘스트/건(UPDATE + 구독 정리 + 캐시).
        const affected: string[] = [];
        // 틱 내 처리 건수. 진행 보장 가드는 누적 s.processed 가 아니라 **이 틱** 기준이어야
        // 한다 — 누적값을 쓰면 2번째 틱부터 항상 >0 이라, 예산보다 비싼 항목(예: 리비전이
        // 많은 하드 삭제)을 만났을 때 커서가 영원히 전진하지 못하는 무한 루프가 된다.
        let handledThisTick = 0;

        // cursor = ids 인덱스. 항목별 보수적 예산 회계로 진행.
        while (s.cursor < payload.ids.length) {
            const id = payload.ids[s.cursor];

            // 실행 시점 재해석. `이미지:`/`map:` slug 는 대상에서 제외(스캔에서 거름).
            const page = await db
                .prepare(
                    `SELECT id, slug, deleted_at FROM pages
                      WHERE id = ?
                        AND slug NOT LIKE '이미지:%'
                        AND slug NOT LIKE 'map:%'`,
                )
                .bind(id)
                .first<{ id: number; slug: string; deleted_at: number | null }>();
            used += 1;

            if (!page) {
                // 미발견/예약 네임스페이스 → 실패로 집계하고 커서 전진.
                result.failed += 1;
                if (result.failedIds.length < CAP_DELETE_FAILED) result.failedIds.push(id);
                s.cursor += 1;
                handledThisTick += 1;
                if (!(await this.checkpoint(s))) {
                    await Promise.allSettled(sink);
                    return;
                }
                continue;
            }

            if (payload.mode === 'soft') {
                // 항목당 예산이 부족하면 이번 틱 종료(틱당 최소 1건은 진행 보장).
                if (handledThisTick > 0 && used + SOFT_COST > budget) break;
                if (page.deleted_at != null) {
                    // 이미 삭제됨 → 변경 없음(실패 아님). 커서만 전진.
                    s.cursor += 1;
                    s.processed += 1;
                    handledThisTick += 1;
                    if (!(await this.checkpoint(s))) {
                        await Promise.allSettled(sink);
                        return;
                    }
                    continue;
                }
                // hard 경로와 대칭으로 항목별 try/catch — 한 항목의 실패가 잡 전체 error 로
                // 번지지 않게 failed 로 격리하고 다음 항목으로 진행한다.
                try {
                    await db.prepare('UPDATE pages SET deleted_at = unixepoch() WHERE id = ?').bind(page.id).run();
                    await cleanupUnauthorizedSubscriptions(db, this.env, rbac, page.id, 'deleted');
                    affected.push(page.slug);
                    sink.push(Promise.resolve(invalidatePageCache(shim, page.slug)).catch(() => {}));
                    result.deleted += 1;
                } catch (e) {
                    console.error('bulk soft delete failed:', e);
                    result.failed += 1;
                    if (result.failedIds.length < CAP_DELETE_FAILED) result.failedIds.push(id);
                }
                used += SOFT_COST;
                s.cursor += 1;
                s.processed += 1;
                handledThisTick += 1;
            } else {
                // hard: 페이지 1건 단위. 비용 = batch statement 수(헬퍼에서 동적 산출) + R2 키 수 + 캐시 ~8.
                const keys = await collectRevisionR2Keys(db, [page.id]);
                used += 1;
                const stmts = buildHardDeleteStatements(db, page.id);
                const estimate = stmts.length + keys.length + 8;
                // 틱 첫 항목이면 추정치가 예산을 넘어도 진행한다(진행 보장) — R2 키 초과분은
                // 어차피 아래에서 큐에 적재돼 다음 틱에 드레인되므로 안전하다.
                if (handledThisTick > 0 && used + estimate > budget) {
                    // 이 항목은 다음 틱으로(커서 미전진, collectRevisionR2Keys 만 소비).
                    break;
                }
                try {
                    await db.batch(stmts);
                    used += stmts.length;
                    result.deleted += 1;
                    affected.push(page.slug);
                    // RAG 미러 정리: D1 영구 삭제가 성공한 경우에만 인덱싱 미러를 제거한다(버킷만 있으면
                    // 스위치 무관). 단건 하드 삭제(wiki.ts / admin-mcp)의 removePageMirror 와 동일한 보장.
                    // (batch 실패 시엔 문서가 D1 에 남으므로 미러를 지우면 안 됨 → try 내부에 둔다.)
                    if (canCleanupMirror(this.env)) {
                        sink.push(this.env.RAG_BUCKET!.delete(ragObjectKey(page.slug)).catch(() => {}));
                    }
                    // R2 삭제: 예산 내에서만 즉시 삭제, 초과분은 큐에 적재해 다음 틱 드레인.
                    let ki = 0;
                    const now: string[] = [];
                    while (ki < keys.length && used < budget) {
                        now.push(keys[ki]);
                        used += 1;
                        ki += 1;
                    }
                    if (now.length > 0) {
                        await Promise.allSettled(now.map((k) => this.env.MEDIA.delete(k)));
                    }
                    if (ki < keys.length) {
                        const queued = (await this.state.storage.get<string[]>(R2QUEUE_KEY)) ?? [];
                        queued.push(...keys.slice(ki));
                        await this.state.storage.put(R2QUEUE_KEY, queued);
                    }
                } catch (e) {
                    console.error('bulk hard delete failed:', e);
                    result.failed += 1;
                    if (result.failedIds.length < CAP_DELETE_FAILED) result.failedIds.push(id);
                }
                sink.push(Promise.resolve(invalidatePageCache(shim, page.slug)).catch(() => {}));
                if (page.slug.includes(':')) {
                    sink.push(Promise.resolve(invalidateBacklinkCaches(shim, page.slug, db)).catch(() => {}));
                }
                s.cursor += 1;
                s.processed += 1;
                handledThisTick += 1;
            }

            // 항목 경계 내구 체크포인트(at-least-once 재시도 시 이중 집계 방지 + stop 존중).
            if (!(await this.checkpoint(s))) {
                await Promise.allSettled(sink);
                return;
            }
        }

        if (affected.length > 0) {
            sink.push(Promise.resolve(refreshRecentChangesCache(shim)).catch(() => {}));
        }

        const done = s.cursor >= payload.ids.length;
        if (done) {
            // 완료 시 admin_log 1건.
            sink.push(
                db
                    .prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                    .bind(
                        payload.mode === 'hard' ? 'bulk_hard_delete' : 'bulk_soft_delete',
                        `문서 대량 ${payload.mode === 'hard' ? '영구 ' : ''}삭제: ${result.deleted}/${result.requested}건`,
                        payload.actor.id,
                    )
                    .run()
                    .catch((e: unknown) => console.error('admin log failed:', e)),
            );
        }

        await Promise.allSettled(sink);
        await this.finishTick(s, done);
    }

    // ── bulk-move 틱 ──

    private async tickBulkMove(s: JobState): Promise<void> {
        const budget = this.parseBudget();
        const payload = (await this.state.storage.get<BulkMovePayload>(PAYLOAD_KEY))!;
        const result = s.result as unknown as BulkMoveResult;
        const db = this.env.DB;
        const rbac = new RBAC();
        const sink: Promise<unknown>[] = [];
        const shim = this.makeShim(sink);

        // 틱당 건수: 역링크 ON 은 1건(문서당 최대 ~800쿼리), OFF 는 예산 기반.
        const perTick = payload.updateBacklinks ? 1 : Math.max(1, Math.min(20, Math.floor(budget / 30)));

        let handled = 0;
        while (s.cursor < payload.items.length && handled < perTick) {
            const item = payload.items[s.cursor];

            try {
                // 실행 시점 재해석(미발견/삭제 → skipped).
                const page = await db
                    .prepare('SELECT id, slug, deleted_at FROM pages WHERE id = ?')
                    .bind(item.id)
                    .first<{ id: number; slug: string; deleted_at: number | null }>();

                if (!page) {
                    this.recordMoveSkip(result, item.slug || `#${item.id}`, '문서를 찾을 수 없습니다.');
                    s.cursor += 1;
                    s.processed += 1;
                    handled += 1;
                    if (!(await this.checkpoint(s))) {
                        await Promise.allSettled(sink);
                        return;
                    }
                    continue;
                }
                if (page.deleted_at != null) {
                    this.recordMoveSkip(result, page.slug, '삭제된 문서는 이동할 수 없습니다.');
                    s.cursor += 1;
                    s.processed += 1;
                    handled += 1;
                    if (!(await this.checkpoint(s))) {
                        await Promise.allSettled(sink);
                        return;
                    }
                    continue;
                }

                // 멱등 가드: item.slug 는 제출 시점의 **이동 전 원본** slug 스냅샷이다.
                // "movePage 의 slug UPDATE 가 D1 에 커밋된 뒤, checkpoint 저장 전" 윈도우에서
                // 크래시/eviction 으로 alarm 이 같은 항목을 재시도하면 page.slug 는 이미
                // newSlug 다. 이때 find 가 newSlug 에도 매칭되면 이중 치환(데이터 손상)이
                // 나므로, 현재 slug 가 기대한 원본과 다르면(=이미 이동됐거나 외부에서 변경됨)
                // 재처리하지 않고 skip 한다. 정상 1회 처리 시엔 page.slug === item.slug 라 무영향.
                if (page.slug !== item.slug) {
                    this.recordMoveSkip(result, page.slug, '이미 이동됨 또는 외부에서 변경됨 (건너뜀)');
                    s.cursor += 1;
                    s.processed += 1;
                    handled += 1;
                    if (!(await this.checkpoint(s))) {
                        await Promise.allSettled(sink);
                        return;
                    }
                    continue;
                }

                const newSlug = page.slug.split(payload.find).join(payload.replace);
                if (newSlug === page.slug) {
                    this.recordMoveSkip(result, page.slug, '변경 없음 (찾을 내용 미포함)');
                    s.cursor += 1;
                    s.processed += 1;
                    handled += 1;
                    if (!(await this.checkpoint(s))) {
                        await Promise.allSettled(sink);
                        return;
                    }
                    continue;
                }

                const outcome = await movePage(shim, page.slug, newSlug, payload.actor, rbac, {
                    updateBacklinks: payload.updateBacklinks,
                });
                if (!outcome.ok) {
                    this.recordMoveSkip(result, page.slug, outcome.error || '이동 실패');
                } else {
                    const blUpdated = outcome.backlinks?.updated ?? 0;
                    const blSkipped = outcome.backlinks?.skipped?.length ?? 0;
                    const blConflicts = outcome.backlinks?.conflicts?.length ?? 0;
                    result.backlinks_updated += blUpdated;
                    result.backlinks_skipped += blSkipped;
                    result.backlinks_conflicts += blConflicts;
                    // 이동 성공 + 역링크 재작성 전체 throw 실패.
                    if (outcome.backlinks_error && result.backlink_errors.length < CAP_MOVE_ERRORS) {
                        result.backlink_errors.push({ slug: outcome.new_slug!, error: outcome.backlinks_error });
                    }
                    // 이동·역링크 호출은 됐으나 일부 소스만 미갱신(캡/충돌/읽기 실패).
                    if ((blSkipped > 0 || blConflicts > 0) && result.backlink_partials.length < CAP_MOVE_ERRORS) {
                        result.backlink_partials.push({ slug: outcome.new_slug!, skipped: blSkipped, conflicts: blConflicts });
                    }
                    result.moved += 1;
                }
            } catch (e) {
                // 항목별 예외는 skipped 기록 후 커서 전진(잡 전체 error 아님).
                this.recordMoveSkip(result, item.slug || `#${item.id}`, e instanceof Error ? e.message : String(e));
            }

            s.cursor += 1;
            s.processed += 1;
            handled += 1;
            // 항목 경계 내구 체크포인트 — movePage 의 slug UPDATE 는 D1 에 즉시 커밋되므로,
            // 커서를 틱 말미에만 저장하면 크래시 재시도 시 같은 항목이 재처리돼 find 가
            // newSlug 에 다시 매칭되는 경우 **이중 치환**될 수 있다(데이터 손상). 즉시 저장.
            if (!(await this.checkpoint(s))) {
                await Promise.allSettled(sink);
                return;
            }
        }

        const done = s.cursor >= payload.items.length;
        if (done) {
            const partialTotal = result.backlinks_skipped + result.backlinks_conflicts;
            sink.push(
                db
                    .prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                    .bind(
                        'bulk_move',
                        `문서 대량 이동(제목 변경): "${payload.find}" → "${payload.replace}" (${result.moved}/${result.requested}건 이동, 역링크 ${result.backlinks_updated}건 갱신` +
                            `${result.backlink_errors.length ? `, 역링크 실패 ${result.backlink_errors.length}건` : ''}` +
                            `${partialTotal ? `, 역링크 미갱신 ${partialTotal}건` : ''})`,
                        payload.actor.id,
                    )
                    .run()
                    .catch((e: unknown) => console.error('admin log failed:', e)),
            );
        }

        await Promise.allSettled(sink);
        await this.finishTick(s, done);
    }

    private recordMoveSkip(result: BulkMoveResult, slug: string, reason: string): void {
        if (result.skipped.length < CAP_MOVE_SKIPPED) {
            result.skipped.push({ slug, reason });
        } else {
            result.skipped_overflow += 1;
        }
    }

    // ── c-shim ──
    //
    // movePage·캐시 무효화 헬퍼가 Hono `c` 에서 쓰는 표면(`c.env`·`c.executionCtx.waitUntil`·
    // `new URL(c.req.url).origin`)만 채운 얇은 shim. waitUntil 로 들어온 promise 는 sink 에 모아
    // 틱 말미 `Promise.allSettled` 로 회수한다(alarm 종료 시 promise 취소 방지). req.url 의 origin
    // 은 `WIKI_PUBLIC_BASE_URL`(미설정 시 더미)에서 도출 — 캐시 무효화는 colo-local best-effort.
    private makeShim(sink: Promise<unknown>[]): any {
        const base = (this.env.WIKI_PUBLIC_BASE_URL || 'https://do.invalid').replace(/\/$/, '');
        return {
            env: this.env,
            executionCtx: {
                waitUntil: (p: Promise<unknown>) => sink.push(Promise.resolve(p).catch(() => {})),
            },
            req: { url: `${base}/` },
        };
    }
}
