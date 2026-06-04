// @ts-nocheck — admin-bulk-delete 페이지 부트스트랩. common.ts 와 동일 사유로 타입검사 비활성.
//
// 이관 규칙(admin-media.ts 와 동일):
//  - common.ts 가 window.* 로 노출하는 공통 전역(loadConfig / currentUser / escapeHtml)은
//    모듈 스코프에서 bare 로 해석되지 않으므로 window.* 로 접근한다.
//  - CDN 전역(Swal)은 그대로 둔다.
//  - HTML onclick 속성에서 호출되는 함수는 파일 끝에서 window.* 로 노출한다.
//    (searchDocs / bulkSoftDelete / bulkHardDelete). 마스터/행 체크박스는
//    #bulkTreePanel 위임으로 처리하므로 인라인 onclick 으로 노출하지 않는다.

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
    const url = `/api/admin/bulk-delete/search?q=${encodeURIComponent(q)}${includeTitle ? "&title=1" : ""}`;
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
    const actionResult = document.getElementById("bulkActionResult");
    if (actionResult) actionResult.innerHTML = "";
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

function updateCount() {
  const el = document.getElementById("bulkSelectedCount");
  if (el) el.textContent = `${getSelectedIds().length}개 선택됨`;
}

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
    const res = await fetch("/api/admin/bulk-delete", {
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

window.searchDocs = searchDocs;
window.bulkSoftDelete = bulkSoftDelete;
window.bulkHardDelete = bulkHardDelete;
