// @ts-nocheck — admin-bulk-manage 페이지 부트스트랩. common.ts 와 동일 사유로 타입검사 비활성.
//
// 이관 규칙(admin-media.ts 와 동일):
//  - common.ts 가 window.* 로 노출하는 공통 전역(loadConfig / currentUser / escapeHtml)은
//    모듈 스코프에서 bare 로 해석되지 않으므로 window.* 로 접근한다.
//  - CDN 전역(Swal)은 그대로 둔다.
//  - HTML onclick 속성에서 호출되는 함수는 파일 끝에서 window.* 로 노출한다.
//    (searchDocs / bulkSoftDelete / bulkHardDelete / bulkMovePreview / bulkMoveRun /
//     reindexStart / reindexStop / reindexResume).
//    마스터/행 체크박스는 #bulkTreePanel 위임으로 처리하므로 인라인 onclick 으로 노출하지 않는다.
//
// 검색 결과를 공유해 (1) 대량 삭제(소프트/하드), (2) 대량 이동(제목 변경) 두 작업을 제공한다.
// (3) 백링크 인덱스 재구축(reindex-backlinks)은 Durable Object 잡으로 실행한다.
//
// API 계약:
//   POST /api/admin/bulk-manage/jobs { type, ...payload }
//   → 200 { ok:true, state } / 409 { ok:false, reason:'already_running', state }
//   GET  /api/admin/bulk-manage/jobs/status → 200 JobState
//   POST /api/admin/bulk-manage/jobs/stop   → 200 { ok:true, state }
//
// JobState: { type, status:'idle'|'running'|'completed'|'error',
//             cursor, total, processed, startedAt, updatedAt, finishedAt,
//             error, result }

interface BulkDoc {
  id: number;
  slug: string;
  title: string | null;
  deleted: boolean;
}

interface JobState {
  type: "reindex-backlinks" | "bulk-move" | "bulk-delete" | "rag-backfill" | null;
  status: "idle" | "running" | "completed" | "error";
  cursor: number;
  total: number;
  processed: number;
  startedAt: number | null;
  updatedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  result: any | null;
}

let lastDocs: BulkDoc[] = [];

// 폴링 중단 플래그 — stopPolling() 호출 또는 컴포넌트 재초기화 시 true 로 설정.
let pollingAborted = false;

document.addEventListener("DOMContentLoaded", async () => {
  await window.loadConfig();
  try {
    const res = await fetch("/api/me");
    if (!res.ok) throw new Error();
    window.currentUser = await res.json();

    // 최고 관리자 전용 — 서버 라우트도 강제하지만 UI 차원에서도 차단.
    if (window.currentUser.role !== "super_admin") {
      Swal.fire(
        "접근 제한",
        "최고 관리자만 접근할 수 있습니다.",
        "error",
      ).then(() => {
        window.location.href = "/";
      });
      return;
    }

    document
      .querySelectorAll("#userAvatar")
      .forEach((el) => (el.src = window.currentUser.picture || ""));
    document
      .querySelectorAll("#userName")
      .forEach((el) => (el.textContent = window.currentUser.name));
  } catch {
    window.location.href = "/login";
    return;
  }

  // RAG 백필 카드는 플러그인이 활성(ragSearchEnabled)일 때만 노출.
  if (window.appConfig?.ragSearchEnabled) {
    const ragCard = document.getElementById("ragBackfillCard");
    if (ragCard) ragCard.style.display = "";
  }

  const input = document.getElementById("bulkSearchInput") as HTMLInputElement;
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchDocs();
  });

  // 체크박스 변경 위임 — 마스터("전체 선택")는 전체 토글, 개별 행은 마스터/카운트 동기화.
  const panel = document.getElementById("bulkTreePanel");
  panel?.addEventListener("change", (e) => {
    const cb = e.target as HTMLInputElement;
    if (cb.classList.contains("bulkcat-master-checkbox")) {
      toggleAllDocs();
      return;
    }
    if (!cb.classList.contains("bulk-check")) return;
    syncMaster();
    updateCount();
  });

  // 페이지 로드 시 실행 중인 잡 확인 → 있으면 폴링 재연결
  try {
    const statusRes = await fetch("/api/admin/bulk-manage/jobs/status");
    if (statusRes.ok) {
      const state: JobState = await statusRes.json();
      if (state.status === "running") {
        setJobButtonsDisabled(true);
        if (state.type === "reindex-backlinks") {
          renderReindexState(state);
          const reindexStatusEl = document.getElementById("reindexStatus");
          if (reindexStatusEl) {
            reindexStatusEl.innerHTML +=
              ' <span class="text-muted small">(페이지 이탈 후에도 서버에서 계속 실행됩니다)</span>';
          }
          pollJobUntilDone(renderReindexState).then((finalState) => {
            renderReindexState(finalState);
            setJobButtonsDisabled(false);
          });
        } else if (state.type === "bulk-delete") {
          const result = document.getElementById("bulkActionResult");
          if (result) {
            result.innerHTML =
              `<span class="text-muted">삭제 작업 진행 중... (${state.processed}/${state.total > 0 ? state.total : "?"})` +
              ' <span class="text-muted small">(페이지 이탈 후에도 서버에서 계속 실행됩니다)</span></span>';
          }
          pollJobUntilDone((s) => {
            if (result) {
              result.innerHTML = `<span class="text-muted">삭제 중... (${s.processed}/${s.total > 0 ? s.total : "?"})</span>`;
            }
          }).then((finalState) => {
            setJobButtonsDisabled(false);
            renderDeleteResult(finalState, result);
            searchDocs();
          });
        } else if (state.type === "bulk-move") {
          const result = document.getElementById("bulkMoveResult");
          if (result) {
            result.innerHTML =
              `<span class="text-muted">이동 작업 진행 중... (${state.processed}/${state.total > 0 ? state.total : "?"})` +
              ' <span class="text-muted small">(페이지 이탈 후에도 서버에서 계속 실행됩니다)</span></span>';
          }
          pollJobUntilDone((s) => {
            if (result) {
              result.innerHTML = `<span class="text-muted">이동 중... (${s.processed}/${s.total > 0 ? s.total : "?"})</span>`;
            }
          }).then((finalState) => {
            setJobButtonsDisabled(false);
            renderMoveResult(finalState, result);
            searchDocs();
          });
        } else if (state.type === "rag-backfill") {
          renderRagBackfillState(state);
          const ragStatusEl = document.getElementById("ragBackfillStatus");
          if (ragStatusEl) {
            ragStatusEl.innerHTML +=
              ' <span class="text-muted small">(페이지 이탈 후에도 서버에서 계속 실행됩니다)</span>';
          }
          pollJobUntilDone(renderRagBackfillState).then((finalState) => {
            renderRagBackfillState(finalState);
            setJobButtonsDisabled(false);
          });
        }
      }
    }
  } catch {
    // 상태 조회 실패는 무시 (서버 미배포 등)
  }
});

// ── 공용 잡 헬퍼 ──

/**
 * 잡을 제출한다.
 * 409 (already_running) 이면 Swal 안내 후 null 반환.
 * 성공이면 초기 JobState 를 반환.
 * 그 외 오류는 throw 한다.
 */
async function submitJob(body: object): Promise<JobState | null> {
  const res = await fetch("/api/admin/bulk-manage/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (res.status === 409) {
    // 이미 실행 중인 잡 있음 — 사용자에게 안내
    Swal.fire({
      title: "잡 이미 실행 중",
      html: "현재 다른 대량 작업이 실행 중입니다.<br>완료되거나 중지될 때까지 새 작업을 시작할 수 없습니다.",
      icon: "warning",
    });
    return null;
  }
  if (!res.ok) {
    throw new Error(data.error || "잡 제출 실패");
  }
  return data.state as JobState;
}

/**
 * 1.5초 간격으로 GET /status 를 폴링한다.
 * running 상태인 동안 onTick(state) 을 호출하고,
 * completed / error / idle 이 되면 최종 state 를 resolve 한다.
 * 연속 fetch 실패 5회 시 중단 안내 후 마지막으로 알려진 state 를 resolve 한다.
 */
async function pollJobUntilDone(onTick: (state: JobState) => void): Promise<JobState> {
  pollingAborted = false;
  let failCount = 0;
  let lastKnown: JobState = { type: null, status: "idle", cursor: 0, total: 0, processed: 0, startedAt: null, updatedAt: null, finishedAt: null, error: null, result: null };

  return new Promise((resolve) => {
    const tick = async () => {
      if (pollingAborted) {
        resolve(lastKnown);
        return;
      }
      try {
        const res = await fetch("/api/admin/bulk-manage/jobs/status");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const state: JobState = await res.json();
        lastKnown = state;
        failCount = 0;
        if (state.status === "running") {
          onTick(state);
          setTimeout(tick, 1500);
        } else {
          resolve(state);
        }
      } catch {
        failCount++;
        if (failCount >= 5) {
          Swal.fire({
            title: "상태 조회 실패",
            text: "잡 상태를 조회할 수 없습니다. 네트워크를 확인하고 페이지를 새로고침해 주세요.",
            icon: "error",
          });
          resolve(lastKnown);
        } else {
          setTimeout(tick, 1500);
        }
      }
    };
    setTimeout(tick, 1500);
  });
}

/** 폴링을 즉시 중단한다(다음 tick 이전에 resolve 처리됨). */
function stopPolling() {
  pollingAborted = true;
}

/** 현재 실행 중인 잡을 중지(일시정지)한다. */
async function stopJob(): Promise<JobState | null> {
  try {
    const res = await fetch("/api/admin/bulk-manage/jobs/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "중지 실패");
    stopPolling();
    return data.state as JobState;
  } catch (err: any) {
    Swal.fire("중지 실패", err.message || "알 수 없는 오류", "error");
    return null;
  }
}

/**
 * 잡 실행 중에는 모든 실행 버튼을 비활성화한다.
 * 완료/중지 시 복원한다.
 */
function setJobButtonsDisabled(disabled: boolean) {
  const ids = [
    "bulkSoftBtn", "bulkHardBtn",
    "bulkMoveBtn", "bulkMovePreviewBtn",
    "reindexStartBtn", "reindexResumeBtn",
    "ragBackfillStartBtn", "ragBackfillResumeBtn",
  ];
  for (const id of ids) {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (el) el.disabled = disabled;
  }
  // 중지 버튼은 반대 — 실행 중에만 활성
  const stopBtn = document.getElementById("reindexStopBtn") as HTMLButtonElement | null;
  if (stopBtn) stopBtn.disabled = !disabled;
  const ragStopBtn = document.getElementById("ragBackfillStopBtn") as HTMLButtonElement | null;
  if (ragStopBtn) ragStopBtn.disabled = !disabled;
}

// ── 대량 삭제 ──

async function runBulkDelete(mode: "soft" | "hard") {
  const ids = getSelectedIds();
  if (ids.length === 0) {
    Swal.fire("선택 없음", "삭제할 문서를 선택하세요.", "info");
    return;
  }

  const hard = mode === "hard";
  const confirmRes = await Swal.fire({
    title: hard ? "영구 삭제 확인" : "문서 삭제 확인",
    html: hard
      ? `선택한 <strong>${ids.length}개</strong> 문서를 <strong class="text-danger">영구 삭제</strong>합니다.<br>토론·리비전·주시 설정까지 모두 제거되며 <strong>되돌릴 수 없습니다.</strong>`
      : `선택한 <strong>${ids.length}개</strong> 문서를 삭제합니다. (나중에 복원할 수 있습니다.)`,
    icon: "warning",
    showCancelButton: true,
    confirmButtonText: hard ? "영구 삭제" : "삭제",
    cancelButtonText: "취소",
    confirmButtonColor: hard ? "#dc3545" : undefined,
  });
  if (!confirmRes.isConfirmed) return;

  const result = document.getElementById("bulkActionResult");
  if (result) result.innerHTML = '<span class="text-muted">잡 제출 중...</span>';

  setJobButtonsDisabled(true);

  try {
    const initState = await submitJob({ type: "bulk-delete", ids, mode });
    if (!initState) {
      // already_running — submitJob 내에서 안내 처리됨
      setJobButtonsDisabled(false);
      return;
    }

    if (result) {
      result.innerHTML = `<span class="text-muted">삭제 중... (0/${ids.length})</span>`;
    }

    const finalState = await pollJobUntilDone((state) => {
      if (result) {
        result.innerHTML = `<span class="text-muted">삭제 중... (${state.processed}/${state.total > 0 ? state.total : ids.length})</span>`;
      }
    });

    renderDeleteResult(finalState, result);
    await searchDocs();
  } catch (err: any) {
    if (result) {
      result.innerHTML = `<div class="alert alert-danger py-2 mb-0">오류: ${err.message || err}</div>`;
    }
  } finally {
    setJobButtonsDisabled(false);
  }
}

function renderDeleteResult(state: JobState, container: HTMLElement | null) {
  if (!container) return;
  const r = state.result || {};
  const hard = r.mode === "hard";
  if (state.status === "error") {
    container.innerHTML = `<div class="alert alert-danger py-2 mb-0">잡 오류: ${window.escapeHtml(state.error || "알 수 없는 오류")}</div>`;
    return;
  }
  const deleted = r.deleted ?? 0;
  const failed = r.failed ?? 0;
  container.innerHTML =
    `<div class="alert alert-success py-2 mb-0">${deleted}개 문서가 ${hard ? "영구 " : ""}삭제되었습니다.${failed ? ` (${failed}개 건너뜀)` : ""}</div>`;
}

function bulkSoftDelete() {
  runBulkDelete("soft");
}
function bulkHardDelete() {
  runBulkDelete("hard");
}

// ── 대량 이동 (제목 변경) ──

/** 서버와 동일한 치환 규칙: slug 안의 모든 find occurrence 를 replace 로 치환. */
function computeNewSlug(slug: string, find: string, replace: string): string {
  if (!find) return slug;
  return slug.split(find).join(replace);
}

/** find/replace 입력을 읽어 검증한다. 실패 시 null 반환(+ 안내 표시). */
function readMoveInputs(): { find: string; replace: string; updateBacklinks: boolean } | null {
  const find = (document.getElementById("bulkMoveFind") as HTMLInputElement)?.value || "";
  const replace = (document.getElementById("bulkMoveReplace") as HTMLInputElement)?.value || "";
  const updateBacklinks = (document.getElementById("bulkMoveBacklinks") as HTMLInputElement)?.checked;
  if (!find) {
    Swal.fire("입력 필요", "'찾을 내용'을 입력하세요.", "info");
    return null;
  }
  if (find === replace) {
    Swal.fire("확인", "'찾을 내용'과 '바꿀 내용'이 동일합니다.", "info");
    return null;
  }
  return { find, replace, updateBacklinks: !!updateBacklinks };
}

/** 선택 문서들의 치환 결과(old → new)를 표로 미리 보여준다. 변경 없는 문서는 회색 표시. */
function bulkMovePreview() {
  const docs = getSelectedDocs();
  const preview = document.getElementById("bulkMovePreview");
  if (!preview) return;
  if (docs.length === 0) {
    Swal.fire("선택 없음", "이동할 문서를 선택하세요.", "info");
    return;
  }
  const inputs = readMoveInputs();
  if (!inputs) return;
  const { find, replace } = inputs;
  const esc = window.escapeHtml;

  let changed = 0;
  const rows = docs.map((d) => {
    const newSlug = computeNewSlug(d.slug, find, replace);
    const isChange = newSlug !== d.slug;
    if (isChange) changed++;
    const arrow = isChange
      ? `<i class="mdi mdi-arrow-right text-muted mx-1"></i><span class="bulk-move-newslug">${esc(newSlug)}</span>`
      : '<span class="text-muted ms-2">(변경 없음)</span>';
    return `<li class="${isChange ? "" : "text-muted"}"><code>${esc(d.slug)}</code>${arrow}</li>`;
  }).join("");

  preview.innerHTML = `
    <div class="bulk-move-preview-box">
      <div class="small mb-2">미리보기 — 변경 대상 <strong>${changed}</strong>개 / 선택 ${docs.length}개</div>
      <ul class="bulk-move-preview-list">${rows}</ul>
    </div>`;
}

async function bulkMoveRun() {
  const docs = getSelectedDocs();
  if (docs.length === 0) {
    Swal.fire("선택 없음", "이동할 문서를 선택하세요.", "info");
    return;
  }
  const inputs = readMoveInputs();
  if (!inputs) return;
  const { find, replace, updateBacklinks } = inputs;

  // 실제 변경되는 문서만 추려 서버로 보낸다(변경 없는 문서는 예산 낭비 + 서버에서 어차피 건너뜀).
  const changingDocs = docs.filter((d) => computeNewSlug(d.slug, find, replace) !== d.slug);
  const changed = changingDocs.length;
  if (changed === 0) {
    Swal.fire("변경 없음", "선택한 문서 중 '찾을 내용'을 포함한 문서가 없습니다.", "info");
    return;
  }
  const changingIds = changingDocs.map((d) => d.id);

  const confirmRes = await Swal.fire({
    title: "문서 대량 이동 확인",
    html:
      `선택한 문서 중 <strong>${changed}개</strong>의 주소(slug)에서 ` +
      `<code>${window.escapeHtml(find)}</code> → <code>${window.escapeHtml(replace)}</code> 로 치환해 이동합니다.` +
      (updateBacklinks
        ? "<br>각 문서를 가리키는 <strong>참조 링크 본문도 함께 갱신</strong>합니다."
        : "<br>참조 링크 본문은 갱신하지 않습니다.") +
      "<br><span class='text-muted small'>이동은 되돌릴 수 없습니다(다시 이동으로 복구 가능).</span>",
    icon: "warning",
    showCancelButton: true,
    confirmButtonText: "이동 실행",
    cancelButtonText: "취소",
  });
  if (!confirmRes.isConfirmed) return;

  const moveBtn = document.getElementById("bulkMoveBtn") as HTMLButtonElement;
  const previewBtn = document.getElementById("bulkMovePreviewBtn") as HTMLButtonElement;
  const result = document.getElementById("bulkMoveResult");

  setJobButtonsDisabled(true);
  if (result) result.innerHTML = '<span class="text-muted">잡 제출 중...</span>';

  try {
    const initState = await submitJob({
      type: "bulk-move",
      ids: changingIds,
      find,
      replace,
      update_backlinks: updateBacklinks,
    });
    if (!initState) {
      setJobButtonsDisabled(false);
      return;
    }

    if (result) {
      result.innerHTML = `<span class="text-muted">이동 중... (0/${changed})</span>`;
    }

    const finalState = await pollJobUntilDone((state) => {
      if (result) {
        result.innerHTML = `<span class="text-muted">이동 중... (${state.processed}/${state.total > 0 ? state.total : changed})</span>`;
      }
    });

    renderMoveResult(finalState, result);

    // 목록 갱신(슬러그가 바뀌었으므로 재검색). 미리보기 비우기.
    const preview = document.getElementById("bulkMovePreview");
    if (preview) preview.innerHTML = "";
    await searchDocs();
  } catch (err: any) {
    if (result) {
      result.innerHTML = `<div class="alert alert-danger py-2 mb-0">오류: ${err.message || err}</div>`;
    }
  } finally {
    setJobButtonsDisabled(false);
  }
}

function renderMoveResult(state: JobState, container: HTMLElement | null) {
  if (!container) return;
  const esc = window.escapeHtml;
  const r = state.result || {};

  if (state.status === "error") {
    container.innerHTML = `<div class="alert alert-danger py-2 mb-0">잡 오류: ${esc(state.error || "알 수 없는 오류")}</div>`;
    return;
  }

  const totalMoved = r.moved ?? 0;
  const totalBacklinks = r.backlinks_updated ?? 0;
  const totalBacklinkUngupdated = (r.backlinks_skipped ?? 0) + (r.backlinks_conflicts ?? 0);
  const allSkips: { slug: string; reason: string }[] = r.skipped || [];
  const skippedOverflow: number = r.skipped_overflow ?? 0;
  const allBacklinkErrors: { slug: string; error: string }[] = r.backlink_errors || [];
  const allBacklinkPartials: { slug: string; skipped: number; conflicts: number }[] = r.backlink_partials || [];

  let html = "";
  const cls = state.status === "completed" ? "alert-success" : "alert-warning";
  html += `<div class="alert ${cls} py-2 mb-0">`;
  html += `${totalMoved}개 문서가 이동되었습니다.`;
  if (totalBacklinks > 0) html += ` (참조 링크 ${totalBacklinks}건 갱신)`;
  const displaySkips = allSkips.length + skippedOverflow;
  if (displaySkips > 0) html += ` · ${allSkips.length}개 건너뜀${skippedOverflow > 0 ? ` (외 ${skippedOverflow}건)` : ""}`;
  if (allBacklinkErrors.length > 0) html += ` · 역링크 갱신 실패 ${allBacklinkErrors.length}건`;
  if (totalBacklinkUngupdated > 0) html += ` · 역링크 일부 미갱신 ${totalBacklinkUngupdated}건`;
  html += `</div>`;

  if (allBacklinkErrors.length > 0) {
    const items = allBacklinkErrors
      .map((e) => `<li><code>${esc(e.slug)}</code> — ${esc(e.error)}</li>`)
      .join("");
    html += `<div class="bulk-move-skip-box mt-2"><div class="small mb-1">이동은 성공했지만 참조 링크 갱신에 실패한 문서 (참조가 옛 주소로 남아 있을 수 있음)</div><ul class="mb-0 small">${items}</ul></div>`;
  }
  if (allBacklinkPartials.length > 0) {
    const items = allBacklinkPartials
      .map((p) => {
        const parts = [];
        if (p.conflicts > 0) parts.push(`충돌 ${p.conflicts}`);
        if (p.skipped > 0) parts.push(`건너뜀 ${p.skipped}`);
        return `<li><code>${esc(p.slug)}</code> — 참조 링크 ${parts.join(", ")}건 미갱신</li>`;
      })
      .join("");
    html += `<div class="bulk-move-skip-box mt-2"><div class="small mb-1">참조 링크 일부가 갱신되지 않은 문서 (200개 초과·동시 편집 충돌·읽기 실패 등 — 해당 참조는 옛 주소로 남아 있을 수 있음)</div><ul class="mb-0 small">${items}</ul></div>`;
  }
  if (allSkips.length > 0) {
    const items = allSkips
      .map((s) => `<li><code>${esc(s.slug)}</code> — ${esc(s.reason)}</li>`)
      .join("");
    const overflowNote = skippedOverflow > 0 ? `<div class="small mt-1 text-muted">외 ${skippedOverflow}건 (결과 캡 초과로 상세 생략)</div>` : "";
    html += `<div class="bulk-move-skip-box mt-2"><div class="small mb-1">건너뛴 문서</div><ul class="mb-0 small">${items}</ul>${overflowNote}</div>`;
  }

  container.innerHTML = html;
}

// ── 백링크 재인덱싱 ──

/**
 * 재인덱싱 진행 UI 를 JobState 로 갱신한다.
 * 진행 바(#reindexProgress), 상태 텍스트(#reindexStatus), 버튼 3개(#reindexStartBtn / StopBtn / ResumeBtn).
 */
function renderReindexState(state: JobState) {
  const progressEl = document.getElementById("reindexProgress") as HTMLElement | null;
  const statusEl = document.getElementById("reindexStatus") as HTMLElement | null;
  const startBtn = document.getElementById("reindexStartBtn") as HTMLButtonElement | null;
  const stopBtn = document.getElementById("reindexStopBtn") as HTMLButtonElement | null;
  const resumeBtn = document.getElementById("reindexResumeBtn") as HTMLButtonElement | null;

  const isRunning = state.status === "running";
  const isIdle = state.status === "idle";
  const isCompleted = state.status === "completed";
  const isError = state.status === "error";

  // 진행 바 업데이트
  if (progressEl) {
    const pct = state.total > 0 ? Math.round((state.processed / state.total) * 100) : 0;
    const barEl = progressEl.querySelector(".progress-bar") as HTMLElement | null;
    if (barEl) {
      barEl.style.width = `${pct}%`;
      barEl.setAttribute("aria-valuenow", String(pct));
      barEl.textContent = `${pct}%`;
    }
    progressEl.style.display = isRunning || isCompleted ? "" : "none";
  }

  // 상태 텍스트
  if (statusEl) {
    if (isRunning) {
      const r = state.result || {};
      const written = r.linksWritten ?? 0;
      const skipped = r.skipped ?? 0;
      const mismatched = r.mismatched ?? 0;
      statusEl.innerHTML = `<span class="text-muted">재인덱싱 중... (${state.processed}/${state.total > 0 ? state.total : "?"}) — 불일치 ${mismatched}개 문서 수정, 링크 ${written}건 기록${skipped ? `, ${skipped}건 건너뜀` : ""}</span>`;
    } else if (isCompleted) {
      const r = state.result || {};
      const written = r.linksWritten ?? 0;
      const skipped = r.skipped ?? 0;
      const skippedIds: number[] = r.skippedIds || [];
      const mismatched = r.mismatched ?? 0;
      const linksAdded = r.linksAdded ?? 0;
      const linksRemoved = r.linksRemoved ?? 0;
      const mismatchedDocs: { slug: string; added: number; removed: number }[] =
        r.mismatchedDocs || [];
      const esc = window.escapeHtml;

      let html = `<span class="text-success">✓ 완료 — 총 ${state.processed}개 문서 처리${skipped ? `, ${skipped}건 건너뜀` : ""}</span>`;

      if (mismatched > 0) {
        // 몇 개 문서를 교정했고 링크 몇 건을 채웠/제거했는지 요약.
        html +=
          `<div class="mt-1">인덱스 불일치 <strong>${mismatched}</strong>개 문서 수정 —` +
          ` 누락 링크 ${linksAdded}건 추가 · 잔여 링크 ${linksRemoved}건 제거 (전체 ${written}건 재기록)</div>`;
        // 어느 문서가 어긋나 있었는지 목록으로 표시(+추가/−제거).
        if (mismatchedDocs.length > 0) {
          const items = mismatchedDocs
            .map((d) => {
              const parts: string[] = [];
              if (d.added > 0) parts.push(`+${d.added}`);
              if (d.removed > 0) parts.push(`−${d.removed}`);
              return `<li><a href="/w/${encodeURIComponent(d.slug)}" target="_blank" rel="noopener">${esc(d.slug)}</a> <span class="text-muted">(${parts.join(", ")})</span></li>`;
            })
            .join("");
          const overflow =
            mismatched > mismatchedDocs.length
              ? `<div class="text-muted small mt-1">…외 ${mismatched - mismatchedDocs.length}개 문서 생략</div>`
              : "";
          html += `<div class="bulk-move-skip-box mt-2"><div class="small mb-1">수정된 문서 (누락/잔여 링크)</div><ul class="mb-0 small">${items}</ul>${overflow}</div>`;
        }
      } else if (skipped > 0) {
        // 건너뛴 문서는 비교·교정 대상이 아니므로 "전체 일치" 로 단정하지 않는다.
        html += `<div class="mt-1 text-muted">처리한 문서는 모두 인덱스가 본문과 일치했습니다 (건너뛴 문서는 미검증 — 아래 목록).</div>`;
      } else {
        html += `<div class="mt-1 text-muted">모든 문서의 백링크 인덱스가 본문과 일치합니다 (수정 없음).</div>`;
      }

      if (skippedIds.length > 0) {
        html += `<div class="bulk-move-skip-box mt-2 small"><div class="mb-1">건너뛴 문서 ID (오류 또는 최소 크기 미달)</div><div class="text-muted">${esc(skippedIds.join(", "))}</div></div>`;
      }
      statusEl.innerHTML = html;
    } else if (isError) {
      statusEl.innerHTML = `<span class="text-danger">오류: ${window.escapeHtml(state.error || "알 수 없는 오류")}</span>`;
    } else if (isIdle && state.processed > 0) {
      // 일시정지 상태 (processed > 0 이면 중단된 것)
      statusEl.innerHTML = `<span class="text-muted">일시정지됨 — ${state.processed}개 처리 완료 (재개 가능)</span>`;
    } else {
      statusEl.innerHTML = "";
    }
  }

  // 버튼 show/hide
  if (startBtn) {
    startBtn.style.display = isIdle && state.processed === 0 ? "" : "none";
  }
  if (stopBtn) {
    stopBtn.style.display = isRunning ? "" : "none";
    if (stopBtn) stopBtn.disabled = false;
  }
  if (resumeBtn) {
    // idle 이고 이전 진행 있거나 error 상태일 때 재개 표시
    resumeBtn.style.display = (isIdle && state.processed > 0) || isError ? "" : "none";
  }
}

async function reindexStart() {
  setJobButtonsDisabled(true);
  const statusEl = document.getElementById("reindexStatus");
  if (statusEl) statusEl.innerHTML = '<span class="text-muted">잡 제출 중...</span>';

  try {
    const initState = await submitJob({ type: "reindex-backlinks" });
    if (!initState) {
      setJobButtonsDisabled(false);
      if (statusEl) statusEl.innerHTML = "";
      return;
    }
    renderReindexState(initState);
    const finalState = await pollJobUntilDone(renderReindexState);
    renderReindexState(finalState);
  } catch (err: any) {
    if (statusEl) statusEl.innerHTML = `<span class="text-danger">오류: ${window.escapeHtml(err.message || String(err))}</span>`;
  } finally {
    setJobButtonsDisabled(false);
  }
}

async function reindexStop() {
  const stopBtn = document.getElementById("reindexStopBtn") as HTMLButtonElement | null;
  if (stopBtn) stopBtn.disabled = true;
  const state = await stopJob();
  if (state) {
    renderReindexState(state);
  }
  setJobButtonsDisabled(false);
}

async function reindexResume() {
  setJobButtonsDisabled(true);
  const statusEl = document.getElementById("reindexStatus");
  if (statusEl) statusEl.innerHTML = '<span class="text-muted">잡 재개 중...</span>';

  try {
    const initState = await submitJob({ type: "reindex-backlinks", resume: true });
    if (!initState) {
      setJobButtonsDisabled(false);
      if (statusEl) statusEl.innerHTML = "";
      return;
    }
    renderReindexState(initState);
    const finalState = await pollJobUntilDone(renderReindexState);
    renderReindexState(finalState);
  } catch (err: any) {
    if (statusEl) statusEl.innerHTML = `<span class="text-danger">오류: ${window.escapeHtml(err.message || String(err))}</span>`;
  } finally {
    setJobButtonsDisabled(false);
  }
}

// ── RAG 인덱스 백필 ──

/**
 * RAG 백필 진행 UI 를 JobState 로 갱신한다.
 * 진행 바(#ragBackfillProgress), 상태 텍스트(#ragBackfillStatus), 버튼 3개.
 */
function renderRagBackfillState(state: JobState) {
  const progressEl = document.getElementById("ragBackfillProgress") as HTMLElement | null;
  const statusEl = document.getElementById("ragBackfillStatus") as HTMLElement | null;
  const startBtn = document.getElementById("ragBackfillStartBtn") as HTMLButtonElement | null;
  const stopBtn = document.getElementById("ragBackfillStopBtn") as HTMLButtonElement | null;
  const resumeBtn = document.getElementById("ragBackfillResumeBtn") as HTMLButtonElement | null;

  const isRunning = state.status === "running";
  const isIdle = state.status === "idle";
  const isCompleted = state.status === "completed";
  const isError = state.status === "error";

  if (progressEl) {
    const pct = state.total > 0 ? Math.round((state.processed / state.total) * 100) : 0;
    const barEl = progressEl.querySelector(".progress-bar") as HTMLElement | null;
    if (barEl) {
      barEl.style.width = `${pct}%`;
      barEl.setAttribute("aria-valuenow", String(pct));
      barEl.textContent = `${pct}%`;
    }
    progressEl.style.display = isRunning || isCompleted ? "" : "none";
  }

  if (statusEl) {
    const r = state.result || {};
    const mirrored = r.mirrored ?? 0;
    const skipped = r.skipped ?? 0;
    if (isRunning) {
      statusEl.innerHTML = `<span class="text-muted">백필 중... (${state.processed}/${state.total > 0 ? state.total : "?"}) — 미러 ${mirrored}건, ${skipped}건 건너뜀</span>`;
    } else if (isCompleted) {
      statusEl.innerHTML = `<span class="text-success">✓ 완료 — 미러 ${mirrored}건, ${skipped}건 건너뜀 (총 ${state.processed}개 문서 처리)</span>`;
    } else if (isError) {
      statusEl.innerHTML = `<span class="text-danger">오류: ${window.escapeHtml(state.error || "알 수 없는 오류")}</span>`;
    } else if (isIdle && state.processed > 0) {
      statusEl.innerHTML = `<span class="text-muted">일시정지됨 — ${state.processed}개 처리 완료 (재개 가능)</span>`;
    } else {
      statusEl.innerHTML = "";
    }
  }

  if (startBtn) startBtn.style.display = isIdle && state.processed === 0 ? "" : "none";
  if (stopBtn) { stopBtn.style.display = isRunning ? "" : "none"; stopBtn.disabled = false; }
  if (resumeBtn) resumeBtn.style.display = (isIdle && state.processed > 0) || isError ? "" : "none";
}

async function ragBackfillStart() {
  setJobButtonsDisabled(true);
  const statusEl = document.getElementById("ragBackfillStatus");
  if (statusEl) statusEl.innerHTML = '<span class="text-muted">잡 제출 중...</span>';
  try {
    const initState = await submitJob({ type: "rag-backfill" });
    if (!initState) {
      setJobButtonsDisabled(false);
      if (statusEl) statusEl.innerHTML = "";
      return;
    }
    renderRagBackfillState(initState);
    const finalState = await pollJobUntilDone(renderRagBackfillState);
    renderRagBackfillState(finalState);
  } catch (err: any) {
    if (statusEl) statusEl.innerHTML = `<span class="text-danger">오류: ${window.escapeHtml(err.message || String(err))}</span>`;
  } finally {
    setJobButtonsDisabled(false);
  }
}

async function ragBackfillStop() {
  const stopBtn = document.getElementById("ragBackfillStopBtn") as HTMLButtonElement | null;
  if (stopBtn) stopBtn.disabled = true;
  const state = await stopJob();
  if (state) renderRagBackfillState(state);
  setJobButtonsDisabled(false);
}

async function ragBackfillResume() {
  setJobButtonsDisabled(true);
  const statusEl = document.getElementById("ragBackfillStatus");
  if (statusEl) statusEl.innerHTML = '<span class="text-muted">잡 재개 중...</span>';
  try {
    const initState = await submitJob({ type: "rag-backfill", resume: true });
    if (!initState) {
      setJobButtonsDisabled(false);
      if (statusEl) statusEl.innerHTML = "";
      return;
    }
    renderRagBackfillState(initState);
    const finalState = await pollJobUntilDone(renderRagBackfillState);
    renderRagBackfillState(finalState);
  } catch (err: any) {
    if (statusEl) statusEl.innerHTML = `<span class="text-danger">오류: ${window.escapeHtml(err.message || String(err))}</span>`;
  } finally {
    setJobButtonsDisabled(false);
  }
}

// ── 검색 ──

async function searchDocs() {
  const input = document.getElementById("bulkSearchInput") as HTMLInputElement;
  const q = (input?.value || "").trim();
  const info = document.getElementById("bulkSearchInfo");
  const card = document.getElementById("bulkResultCard");
  if (!q) {
    if (info) info.textContent = "검색어를 입력하세요.";
    return;
  }
  const includeTitle = (document.getElementById("bulkTitleToggle") as HTMLInputElement)?.checked;
  if (info) info.textContent = "검색 중...";

  try {
    const url = `/api/admin/bulk-manage/search?q=${encodeURIComponent(q)}${includeTitle ? "&title=1" : ""}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "검색 실패");

    lastDocs = data.documents || [];
    if (lastDocs.length === 0) {
      if (info) info.textContent = "일치하는 문서가 없습니다.";
      if (card) card.style.display = "none";
      return;
    }
    if (info) {
      info.textContent = `${lastDocs.length}개 문서 검색됨${data.capped ? ` (최대 ${lastDocs.length}개까지만 표시됩니다. 검색어를 더 좁혀주세요.)` : ""}`;
    }
    renderList(lastDocs);
    if (card) card.style.display = "";
    // 이전 작업 결과/미리보기 초기화.
    const actionResult = document.getElementById("bulkActionResult");
    if (actionResult) actionResult.innerHTML = "";
    const movePreview = document.getElementById("bulkMovePreview");
    if (movePreview) movePreview.innerHTML = "";
    const moveResult = document.getElementById("bulkMoveResult");
    if (moveResult) moveResult.innerHTML = "";
  } catch (err: any) {
    if (info) info.textContent = `오류: ${err.message || err}`;
  }
}

/**
 * 검색 결과 문서를 카테고리/ACL 일괄 관리 모달(bulk-category.ts)과 동일한
 * 체크박스 UI 로 렌더한다 — sticky "전체 선택" 마스터 행 + `.bulkcat-subpages-table`
 * 평면 표, 결과 집합 내 상대 깊이만큼 `--bulkcat-depth` 들여쓰기. 캐스케이드/가상 폴더
 * 노드는 없으며, 각 행은 독립적으로 선택한다(마스터만 전체 토글).
 */
function renderList(docs: BulkDoc[]) {
  const panel = document.getElementById("bulkTreePanel");
  if (!panel) return;
  const esc = window.escapeHtml;

  // 결과 집합 안에서만 부모/자식 관계를 따져 상대 깊이와 표시 경로를 계산한다.
  // (검색에 걸리지 않은 중간 경로는 무시 — 가상 폴더 행을 만들지 않는다.)
  const sorted = [...docs].sort((a, b) =>
    a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0,
  );
  const depthBySlug = new Map<string, number>();

  const rows = sorted.map((d) => {
    let ancestor: BulkDoc | null = null;
    for (const o of sorted) {
      if (o === d) continue;
      if (d.slug.startsWith(o.slug + "/")) {
        if (!ancestor || o.slug.length > ancestor.slug.length) ancestor = o;
      }
    }
    const depth = ancestor ? (depthBySlug.get(ancestor.slug) ?? 0) + 1 : 0;
    depthBySlug.set(d.slug, depth);
    const display = ancestor ? d.slug.slice(ancestor.slug.length + 1) : d.slug;

    const deletedBadge = d.deleted
      ? '<span class="bulkcat-cat-chip is-danger">삭제됨</span>'
      : "";
    const titleHint = d.title
      ? `<span class="bulkcat-cat-chip">${esc(d.title)}</span>`
      : "";
    const cats = deletedBadge || titleHint
      ? `<span class="bulkcat-row-categories">${deletedBadge}${titleHint}</span>`
      : '<span class="bulkcat-row-categories bulkcat-row-categories-empty">—</span>';

    // slug 에 ?/# 등 URL 예약문자가 포함될 수 있으므로 encodeURIComponent 로 인코딩
    // (코드베이스 다른 문서 링크와 동일 규약). 인코딩 결과는 속성 안전이라 추가 esc 불필요.
    return `
      <tr data-page-id="${d.id}" style="--bulkcat-depth: ${depth};">
        <td>
          <div class="bulkcat-row-label">
            <input type="checkbox" class="form-check-input bulk-check" data-id="${d.id}" data-slug="${esc(d.slug)}" />
            <a href="/w/${encodeURIComponent(d.slug)}" target="_blank" rel="noopener" class="bulkcat-slug bulk-node-link">${esc(display)}</a>
          </div>
        </td>
        <td class="bulkcat-row-cats-cell">${cats}</td>
      </tr>`;
  }).join("");

  panel.innerHTML = `
    <div class="bulkcat-master-row">
      <label class="bulkcat-master-label">
        <input type="checkbox" class="form-check-input bulkcat-master-checkbox" id="bulkMasterCheck" />
        <span class="bulkcat-master-text">전체 선택</span>
      </label>
      <span class="bulkcat-master-count">${docs.length}개</span>
    </div>
    <table class="bulkcat-subpages-table"><tbody>${rows}</tbody></table>
  `;
  updateCount();
  syncMaster();
}

function syncMaster() {
  const master = document.getElementById("bulkMasterCheck") as HTMLInputElement;
  if (!master) return;
  const all = document.querySelectorAll("#bulkTreePanel .bulk-check[data-id]");
  let allChecked = all.length > 0;
  let any = false;
  all.forEach((el) => {
    if ((el as HTMLInputElement).checked) any = true;
    else allChecked = false;
  });
  master.disabled = all.length === 0;
  master.checked = allChecked;
  master.indeterminate = !allChecked && any;
}

function toggleAllDocs() {
  const master = document.getElementById("bulkMasterCheck") as HTMLInputElement;
  const checked = master?.checked;
  document.querySelectorAll("#bulkTreePanel .bulk-check").forEach((el) => {
    (el as HTMLInputElement).checked = checked;
  });
  if (master) master.indeterminate = false;
  updateCount();
}

function getSelectedIds(): number[] {
  return Array.from(
    document.querySelectorAll("#bulkTreePanel .bulk-check[data-id]:checked"),
  ).map((el) => Number((el as HTMLInputElement).dataset.id));
}

/** 선택된 행의 {id, slug} 목록 — 이동 미리보기에서 slug 치환 결과를 계산하는 데 쓴다. */
function getSelectedDocs(): { id: number; slug: string }[] {
  return Array.from(
    document.querySelectorAll("#bulkTreePanel .bulk-check[data-id]:checked"),
  ).map((el) => ({
    id: Number((el as HTMLInputElement).dataset.id),
    slug: (el as HTMLInputElement).dataset.slug || "",
  }));
}

function updateCount() {
  const el = document.getElementById("bulkSelectedCount");
  if (el) el.textContent = `${getSelectedIds().length}개 선택됨`;
}

// ── window 노출 ──

window.searchDocs = searchDocs;
window.bulkSoftDelete = bulkSoftDelete;
window.bulkHardDelete = bulkHardDelete;
window.bulkMovePreview = bulkMovePreview;
window.bulkMoveRun = bulkMoveRun;
window.reindexStart = reindexStart;
window.reindexStop = reindexStop;
window.reindexResume = reindexResume;
window.ragBackfillStart = ragBackfillStart;
window.ragBackfillStop = ragBackfillStop;
window.ragBackfillResume = ragBackfillResume;
