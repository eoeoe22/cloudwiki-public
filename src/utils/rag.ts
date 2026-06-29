// RAG(Cloudflare AI Search / 구 AutoRAG) 보조 검색 플러그인 — 단일 격리 모듈.
//
// 이 모듈은 두 가지 책임을 한 곳에 모은다:
//   1) 미러링: 문서의 "현행 본문"을 인덱싱 전용 R2 버킷(RAG_BUCKET)에 best-effort 로 반영한다.
//      Cloudflare 대시보드에서 이 버킷을 AI Search 데이터 소스로 등록해 두면 인덱싱이
//      자동 관리된다(코드는 미러링까지만 담당).
//   2) 질의: env.AI.autorag(<instance>).search(...) 로 본문을 의미 기반 검색한다.
//
// AI Search 바인딩 API 는 과도기(레거시 env.AI.autorag() ↔ 신규 [[ai_search]] 인스턴스
// 바인딩)다. 여기 한 모듈에서만 호출부를 두어, 추후 신규 API 로 교체하더라도 ragSearchBody
// 한 함수 안에서 끝나게 한다. 응답도 두 형태(data[].filename / chunks[].item.key)를 모두 받는다.
//
// 플러그인 토글은 배포 시점 env 변수(RAG_SEARCH_ENABLED)다. 미러/검색 각각은 필요한 바인딩이
// 갖춰져야만 실제로 동작하며, 미구성 시 모든 함수가 안전하게 no-op/빈 결과를 반환한다.

// ── AI Search(AutoRAG) 바인딩의 최소 구조 타입 ──
// workers-types 버전에 autorag() 정의가 없을 수도 있으므로 직접 구조 타입을 둔다.
export interface RagAutoragSearchResponse {
    // 레거시 AutoRAG search() 응답.
    data?: Array<{
        filename?: string;
        file_id?: string;
        score?: number;
        content?: Array<{ text?: string }>;
    }>;
    // 신규 AI Search search() 응답.
    chunks?: Array<{
        score?: number;
        text?: string;
        item?: { key?: string };
    }>;
}

export interface RagAutoragInstance {
    search(opts: {
        query: string;
        max_num_results?: number;
        rewrite_query?: boolean;
        ranking_options?: { score_threshold?: number };
    }): Promise<RagAutoragSearchResponse>;
}

export interface RagAiBinding {
    autorag(name: string): RagAutoragInstance;
}

// c.env(Env['Bindings']) 와 구조적으로 호환되는 최소 환경 타입.
// types.ts ↔ rag.ts 순환 의존을 피하기 위해 Env 전체를 import 하지 않는다.
export interface RagEnv {
    RAG_BUCKET?: R2Bucket;
    AI?: RagAiBinding;
    RAG_SEARCH_ENABLED?: string;
    RAG_AUTORAG_NAME?: string;
}

// executionCtx 의 waitUntil 만 쓰는 최소 타입(없으면 fire-and-forget).
type WaitCtx = { waitUntil?: (p: Promise<unknown>) => void } | undefined | null;

export interface RagSearchHit {
    slug: string;
    score: number;
    snippet: string;
}

const RAG_KEY_SUFFIX = '.md';
const RAG_CONTENT_TYPE = 'text/markdown; charset=utf-8';
// AI Search max_num_results 상한.
const RAG_MAX_RESULTS_CAP = 50;

/** 플러그인 마스터 스위치. */
function masterEnabled(env: RagEnv): boolean {
    return env.RAG_SEARCH_ENABLED === 'true';
}

/** 미러링 가능 여부 — 마스터 스위치 ON + RAG_BUCKET 구성. */
export function isRagMirrorEnabled(env: RagEnv): boolean {
    return masterEnabled(env) && !!env.RAG_BUCKET;
}

/** RAG 본문 검색 가능 여부 — 마스터 스위치 ON + AI 바인딩 + 인스턴스 이름 구성. */
export function isRagSearchEnabled(env: RagEnv): boolean {
    return masterEnabled(env) && !!env.AI && !!env.RAG_AUTORAG_NAME;
}

/**
 * 미러 정리(삭제) 가능 여부 — RAG_BUCKET 만 있으면 된다(마스터 스위치 무관).
 * 플러그인을 끈 뒤에도 이미 만들어진 미러가 R2 에 남아 있을 수 있으므로, 영구 삭제 시 고아
 * 객체를 정리하는 것은 스위치 상태와 무관하게 항상 안전·바람직하다(신규 미러 생성과 분리).
 */
export function canCleanupMirror(env: RagEnv): boolean {
    return !!env.RAG_BUCKET;
}

/**
 * slug → R2 객체 키. encodeURIComponent 로 '/'·공백·한글 등을 안전한 평면 키로 만든다(서브폴더 없음).
 * AI Search 가 돌려주는 filename/ key 가 곧 이 값이므로, slugFromRagKey 로 무손실 역변환된다.
 */
export function ragObjectKey(slug: string): string {
    return encodeURIComponent(slug) + RAG_KEY_SUFFIX;
}

/** R2 객체 키(=AI Search filename) → slug. 형식이 어긋나면 null. */
export function slugFromRagKey(key: string | undefined | null): string | null {
    if (!key) return null;
    // 키 경로에 폴더가 섞여 들어와도 마지막 세그먼트만 사용한다(방어적).
    const base = key.slice(key.lastIndexOf('/') + 1);
    const enc = base.endsWith(RAG_KEY_SUFFIX) ? base.slice(0, -RAG_KEY_SUFFIX.length) : base;
    try {
        const slug = decodeURIComponent(enc);
        return slug.length > 0 ? slug : null;
    } catch {
        return null;
    }
}

/** waitUntil 이 있으면 등록, 없으면 fire-and-forget. 항상 에러를 삼킨다(best-effort). */
function schedule(ctx: WaitCtx, p: Promise<unknown>): void {
    const safe = Promise.resolve(p).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(safe);
    else void safe;
}

/**
 * 문서의 현행 본문을 RAG_BUCKET 에 미러링(put). best-effort — 실패해도 원래 본문 저장을
 * 막지 않으며(호출부는 본문 저장 성공 이후 호출), 에러는 로깅 후 삼킨다.
 */
export function mirrorPageBody(env: RagEnv, ctx: WaitCtx, slug: string, content: string): void {
    if (!isRagMirrorEnabled(env)) return;
    const key = ragObjectKey(slug);
    schedule(
        ctx,
        env.RAG_BUCKET!.put(key, content ?? '', { httpMetadata: { contentType: RAG_CONTENT_TYPE } })
            .then(() => undefined)
            .catch((e) => console.error('[rag] mirror put failed:', slug, e)),
    );
}

/**
 * RAG_BUCKET 에서 문서 미러를 제거(delete). best-effort.
 * 정리 작업이므로 마스터 스위치가 꺼진 뒤에도 버킷만 있으면 실행한다(고아 객체 방지).
 */
export function removePageMirror(env: RagEnv, ctx: WaitCtx, slug: string): void {
    if (!canCleanupMirror(env)) return;
    schedule(
        ctx,
        env.RAG_BUCKET!.delete(ragObjectKey(slug)).catch((e) =>
            console.error('[rag] mirror delete failed:', slug, e),
        ),
    );
}

/**
 * slug 변경(이동/이름변경) 시 미러 키를 이전→신규로 옮긴다(get→put→delete). best-effort.
 * 이전 객체가 없으면(아직 인덱싱 전) 아무 것도 하지 않는다 — 신규 slug 는 다음 편집에서 채워진다.
 */
export function renamePageMirror(env: RagEnv, ctx: WaitCtx, oldSlug: string, newSlug: string): void {
    if (!isRagMirrorEnabled(env)) return;
    const bucket = env.RAG_BUCKET!;
    const task = (async () => {
        const oldKey = ragObjectKey(oldSlug);
        const obj = await bucket.get(oldKey);
        if (!obj) return;
        const body = await obj.text();
        await bucket.put(ragObjectKey(newSlug), body, { httpMetadata: { contentType: RAG_CONTENT_TYPE } });
        await bucket.delete(oldKey);
    })().catch((e) => console.error('[rag] mirror rename failed:', oldSlug, '->', newSlug, e));
    schedule(ctx, task);
}

function firstChunkText(content: Array<{ text?: string }> | undefined): string {
    if (!Array.isArray(content)) return '';
    for (const c of content) {
        if (c && typeof c.text === 'string' && c.text.length > 0) return c.text;
    }
    return '';
}

/**
 * RAG 본문 검색. AI Search 를 질의해 slug 별 최고 score 결과를 score 내림차순으로 반환한다.
 * ACL 무관 전 문서가 인덱싱돼 있으므로, 비공개/삭제 필터링은 호출부(D1 사후 조회)가 담당한다.
 *
 * 검색 비활성(isRagSearchEnabled=false)이면 빈 배열. 그 외 질의 실패는 throw 하므로 호출부가
 * 잡아 FTS 로 폴백한다.
 */
export async function ragSearchBody(
    env: RagEnv,
    query: string,
    maxNumResults = 30,
): Promise<RagSearchHit[]> {
    const trimmed = (query || '').trim();
    if (!isRagSearchEnabled(env) || !trimmed) return [];

    const instance = env.AI!.autorag(env.RAG_AUTORAG_NAME!);
    const res = await instance.search({
        query: trimmed,
        max_num_results: Math.min(RAG_MAX_RESULTS_CAP, Math.max(1, maxNumResults)),
        rewrite_query: false,
    });

    // slug 별 최고 score 1건만 유지(한 문서가 여러 청크로 매치될 수 있음).
    const best = new Map<string, RagSearchHit>();
    const consider = (key: string | undefined, score: number | undefined, text: string) => {
        const slug = slugFromRagKey(key);
        if (!slug) return;
        const s = typeof score === 'number' ? score : 0;
        const prev = best.get(slug);
        if (!prev) {
            best.set(slug, { slug, score: s, snippet: text });
        } else if (s > prev.score) {
            best.set(slug, { slug, score: s, snippet: text || prev.snippet });
        }
    };

    if (Array.isArray(res?.data)) {
        for (const d of res.data) consider(d.filename ?? d.file_id, d.score, firstChunkText(d.content));
    }
    if (Array.isArray(res?.chunks)) {
        for (const ch of res.chunks) consider(ch.item?.key, ch.score, ch.text ?? '');
    }

    return [...best.values()].sort((a, b) => b.score - a.score);
}
