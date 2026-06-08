// @ts-nocheck — admin-bulk-manage 페이지 부트스트랩. common.ts 와 동일 사유로 타입검사 비활성.
//
// 이관 규칙(admin-media.ts 와 동일):
//  - common.ts 가 window.* 로 노출하는 공통 전역(loadConfig / currentUser / escapeHtml)은
//    모듈 스코프에서 bare 로 해석되지 않으므로 window.* 로 접근한다.
//  - CDN 전역(Swal)은 그대로 둔다.
//  - HTML onclick 속성에서 호출되는 함수는 파일 끝에서 window.* 로 노출한다.
//    (searchDocs / bulkSoftDelete / bulkHardDelete / bulkMovePreview / bulkMoveRun).
//    마스터/행 체크박스는 #bulkTreePanel 위임으로 처리하므로 인라인 onclick 으로 노출하지 않는다.
//
// 검색 결과를 공유해 (1) 대량 삭제(소프트/하드), (2) 대량 이동(제목 변경) 두 작업을 제공한다.

interface BulkDoc {
  id: number;
  slug: string;
  title: string | null;
  deleted: boolean;
}

let lastDocs: BulkDoc[] = [];

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
});

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

  const softBtn = document.getElementById("bulkSoftBtn") as HTMLButtonElement;
  const hardBtn = document.getElementById("bulkHardBtn") as HTMLButtonElement;
  if (softBtn) softBtn.disabled = true;
  if (hardBtn) hardBtn.disabled = true;
  const result = document.getElementById("bulkActionResult");
  if (result) result.innerHTML = '<span class="text-muted">삭제 중...</span>';

  try {
    const res = await fetch("/api/admin/bulk-manage/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, mode }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "삭제 실패");
    if (result) {
      result.innerHTML = `<div class="alert alert-success py-2 mb-0">${data.deleted}개 문서가 ${hard ? "영구 " : ""}삭제되었습니다.${data.failed ? ` (${data.failed}개 건너뜀)` : ""}</div>`;
    }
    // 목록 갱신.
    await searchDocs();
  } catch (err: any) {
    if (result) {
      result.innerHTML = `<div class="alert alert-danger py-2 mb-0">오류: ${err.message || err}</div>`;
    }
  } finally {
    if (softBtn) softBtn.disabled = false;
    if (hardBtn) hardBtn.disabled = false;
  }
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
    Swal.fire("입력 필요", "‘찾을 내용’을 입력하세요.", "info");
    return null;
  }
  if (find === replace) {
    Swal.fire("확인", "‘찾을 내용’과 ‘바꿀 내용’이 동일합니다.", "info");
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

  // 실제 변경되는 문서만 추려 서버로 보낸다(변경 없는 문서는 청크 예산 낭비 + 서버에서 어차피 건너뜀).
  const changingIds = docs
    .filter((d) => computeNewSlug(d.slug, find, replace) !== d.slug)
    .map((d) => d.id);
  const changed = changingIds.length;
  if (changed === 0) {
    Swal.fire("변경 없음", "선택한 문서 중 ‘찾을 내용’을 포함한 문서가 없습니다.", "info");
    return;
  }

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
  if (moveBtn) moveBtn.disabled = true;
  if (previewBtn) previewBtn.disabled = true;
  const result = document.getElementById("bulkMoveResult");

  // 서버는 D1 의 Worker 호출당 쿼리 한도(유료 1,000) 때문에 한 요청을 제한한다.
  // 무백링크는 BULK_MOVE_MAX(50) 까지 안전하므로 25씩, 역링크 갱신은 문서 1건이 최대
  // ~800쿼리(200-백링크 캡)라 서버가 1건/요청으로 강제하므로 청크도 1로 잡아 순차 호출한다.
  const chunkSize = updateBacklinks ? 1 : 25;
  const esc = window.escapeHtml;

  let totalMoved = 0;
  let totalBacklinks = 0;
  let totalBacklinkUngupdated = 0; // 역링크 호출은 됐으나 일부 소스 미갱신(캡/충돌/읽기실패)
  const allSkips: { slug: string; reason: string }[] = [];
  const allBacklinkErrors: { slug: string; error: string }[] = [];
  const allBacklinkPartials: { slug: string; skipped: number; conflicts: number }[] = [];
  let aborted: string | null = null;

  try {
    for (let i = 0; i < changingIds.length; i += chunkSize) {
      const chunk = changingIds.slice(i, i + chunkSize);
      const done = Math.min(i + chunkSize, changingIds.length);
      if (result) {
        result.innerHTML = `<span class="text-muted">이동 중... (${done}/${changingIds.length})</span>`;
      }
      const res = await fetch("/api/admin/bulk-manage/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: chunk, find, replace, update_backlinks: updateBacklinks }),
      });
      const data = await res.json();
      if (!res.ok) {
        // 이 청크 호출이 실패하면 중단한다. 앞선 청크의 이동은 이미 커밋되어 유지된다.
        aborted = `${esc(data.error || "이동 실패")} (${done - chunk.length + 1}~${done}번째 처리 중단, 앞선 항목은 적용됨)`;
        break;
      }
      totalMoved += data.moved || 0;
      totalBacklinks += data.backlinks_updated || 0;
      totalBacklinkUngupdated += (data.backlinks_skipped || 0) + (data.backlinks_conflicts || 0);
      // "변경 없음" 은 changingIds 만 보내므로 정상적으로는 발생하지 않지만 방어적으로 필터.
      for (const s of (data.skipped || []) as { slug: string; reason: string }[]) {
        if (!/변경 없음/.test(s.reason)) allSkips.push(s);
      }
      for (const e of (data.backlink_errors || []) as { slug: string; error: string }[]) {
        allBacklinkErrors.push(e);
      }
      for (const p of (data.backlink_partials || []) as { slug: string; skipped: number; conflicts: number }[]) {
        allBacklinkPartials.push(p);
      }
    }

    if (result) {
      let html = "";
      const cls = aborted ? "alert-warning" : "alert-success";
      html += `<div class="alert ${cls} py-2 mb-0">`;
      html += `${totalMoved}개 문서가 이동되었습니다.`;
      if (updateBacklinks) html += ` (참조 링크 ${totalBacklinks}건 갱신)`;
      if (allSkips.length > 0) html += ` · ${allSkips.length}개 건너뜀`;
      if (allBacklinkErrors.length > 0) html += ` · 역링크 갱신 실패 ${allBacklinkErrors.length}건`;
      if (totalBacklinkUngupdated > 0) html += ` · 역링크 일부 미갱신 ${totalBacklinkUngupdated}건`;
      html += `</div>`;
      if (aborted) {
        html += `<div class="alert alert-danger py-2 mt-2 mb-0">중단: ${aborted}</div>`;
      }
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
        html += `<div class="bulk-move-skip-box mt-2"><div class="small mb-1">건너뛴 문서</div><ul class="mb-0 small">${items}</ul></div>`;
      }
      result.innerHTML = html;
    }

    // 목록 갱신(슬러그가 바뀌었으므로 재검색). 미리보기 비우기.
    const preview = document.getElementById("bulkMovePreview");
    if (preview) preview.innerHTML = "";
    await searchDocs();
  } catch (err: any) {
    if (result) {
      result.innerHTML = `<div class="alert alert-danger py-2 mb-0">오류: ${err.message || err}</div>`;
    }
  } finally {
    if (moveBtn) moveBtn.disabled = false;
    if (previewBtn) previewBtn.disabled = false;
  }
}

window.searchDocs = searchDocs;
window.bulkSoftDelete = bulkSoftDelete;
window.bulkHardDelete = bulkHardDelete;
window.bulkMovePreview = bulkMovePreview;
window.bulkMoveRun = bulkMoveRun;
