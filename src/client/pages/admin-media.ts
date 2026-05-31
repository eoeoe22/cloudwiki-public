// @ts-nocheck — admin-media.html 인라인 스크립트 이관(동작 보존). common.ts 와 동일 사유로 타입검사 비활성.
//
// 이관 규칙:
//  - common.ts 가 window.* 로 노출하는 공통 전역(loadConfig / currentUser /
//    escapeHtml / mountMediaTagInput)은 모듈 스코프에서 bare 식별자로 해석되지
//    않으므로 모두 window.* 로 접근한다.
//  - CDN 전역(Swal)은 그대로 둔다.
//  - HTML 의 onclick / onchange 속성(정적 HTML + innerHTML 생성 문자열 양쪽)에서
//    호출되는 함수는 파일 끝에서 window.* 로 노출한다.
//    (runGarbageCollector / gcSelectAll / gcDeselectAll / gcDeleteSelected /
//     changeMediaSort / searchMedia / goToMediaPage / trackBacklinks / deleteMedia)

document.addEventListener("DOMContentLoaded", async () => {
  await window.loadConfig();
  try {
    const res = await fetch("/api/me");
    if (!res.ok) throw new Error();
    window.currentUser = await res.json();

    if (
      window.currentUser.role !== "admin" &&
      window.currentUser.role !== "super_admin"
    ) {
      Swal.fire(
        "접근 제한",
        "관리자만 접근할 수 있습니다.",
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

    mediaTagWidget = window.mountMediaTagInput({
      container: document.getElementById("mediaTagContainer"),
      input: document.getElementById("mediaTagInput"),
      initial: [],
    });
    mediaTagWidget.setOnChange(() => {
      mediaTagFilter = mediaTagWidget.getTags();
      loadMedia(1);
    });

    loadMedia();
  } catch (e) {
    window.location.href = "/login";
  }
});

// ── 이미지(미디어) 관리 ──
var mediaPage = 1;
var mediaPageSize = 10;
var mediaSearch = "";
var mediaSort = "date_desc";
var mediaTotal = 0;
var mediaItems = [];
var mediaTagFilter = [];
var mediaTagWidget = null;

async function loadMedia(page = 1) {
  try {
    mediaPage = Math.max(1, page);
    const offset = (mediaPage - 1) * mediaPageSize;

    const params = new URLSearchParams({
      limit: mediaPageSize,
      offset: offset,
      sort: mediaSort,
    });
    if (mediaSearch) params.append("search", mediaSearch);
    if (mediaTagFilter && mediaTagFilter.length > 0) {
      params.append("tags", mediaTagFilter.join(","));
    }

    document.getElementById("mediaList").innerHTML =
      '<div class="text-center text-muted py-3">불러오는 중...</div>';

    const res = await fetch(`/api/admin/media?${params.toString()}`);
    if (!res.ok) throw new Error("이미지 목록 로딩 실패");
    const data = await res.json();

    mediaTotal = data.total;
    mediaItems = data.media || [];

    const totalPages = Math.max(1, Math.ceil(mediaTotal / mediaPageSize));
    if (mediaPage > totalPages && mediaTotal > 0) {
      return loadMedia(totalPages);
    }

    renderMedia();
  } catch (err) {
    document.getElementById("mediaList").innerHTML =
      '<div class="text-center text-danger py-3">이미지 목록을 불러올 수 없습니다.</div>';
    document.getElementById("mediaPagination").innerHTML = "";
    document.getElementById("mediaTotalInfo").textContent = "";
  }
}

function searchMedia() {
  mediaSearch = document.getElementById("mediaSearchInput").value.trim();
  loadMedia(1);
}

function changeMediaSort() {
  mediaSort = document.getElementById("mediaSortSelect").value;
  loadMedia(1);
}

document
  .getElementById("mediaSearchInput")
  .addEventListener("keypress", (e) => {
    if (e.key === "Enter") searchMedia();
  });

function goToMediaPage(page) {
  const totalPages = Math.max(1, Math.ceil(mediaTotal / mediaPageSize));
  const target = Math.min(Math.max(1, page), totalPages);
  if (target === mediaPage) return;
  loadMedia(target);
  document
    .getElementById("mediaList")
    .scrollIntoView({ behavior: "smooth", block: "start" });
}

function getMediaPageNumbers(current, total) {
  const pages = [];
  if (total <= 7) {
    for (let i = 1; i <= total; i++) pages.push(i);
    return pages;
  }
  pages.push(1);
  if (current > 3) pages.push("...");
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  for (let i = start; i <= end; i++) pages.push(i);
  if (current < total - 2) pages.push("...");
  pages.push(total);
  return pages;
}

function renderMediaPagination() {
  const container = document.getElementById("mediaPagination");
  if (mediaTotal === 0) {
    container.innerHTML = "";
    return;
  }
  const totalPages = Math.max(1, Math.ceil(mediaTotal / mediaPageSize));
  const pages = getMediaPageNumbers(mediaPage, totalPages);
  const isFirst = mediaPage === 1;
  const isLast = mediaPage === totalPages;

  let html =
    '<ul class="pagination pagination-sm justify-content-center mb-0 flex-wrap">';
  html += `<li class="page-item ${isFirst ? "disabled" : ""}"><button type="button" class="page-link" onclick="goToMediaPage(1)" ${isFirst ? "disabled" : ""} aria-label="처음"><i class="mdi mdi-chevron-double-left"></i></button></li>`;
  html += `<li class="page-item ${isFirst ? "disabled" : ""}"><button type="button" class="page-link" onclick="goToMediaPage(${mediaPage - 1})" ${isFirst ? "disabled" : ""} aria-label="이전"><i class="mdi mdi-chevron-left"></i></button></li>`;
  for (const p of pages) {
    if (p === "...") {
      html +=
        '<li class="page-item disabled"><span class="page-link">…</span></li>';
    } else {
      const active = p === mediaPage ? "active" : "";
      html += `<li class="page-item ${active}"><button type="button" class="page-link" onclick="goToMediaPage(${p})">${p}</button></li>`;
    }
  }
  html += `<li class="page-item ${isLast ? "disabled" : ""}"><button type="button" class="page-link" onclick="goToMediaPage(${mediaPage + 1})" ${isLast ? "disabled" : ""} aria-label="다음"><i class="mdi mdi-chevron-right"></i></button></li>`;
  html += `<li class="page-item ${isLast ? "disabled" : ""}"><button type="button" class="page-link" onclick="goToMediaPage(${totalPages})" ${isLast ? "disabled" : ""} aria-label="마지막"><i class="mdi mdi-chevron-double-right"></i></button></li>`;
  html += "</ul>";
  container.innerHTML = html;
}

function renderMedia() {
  const listEl = document.getElementById("mediaList");
  const totalInfo = document.getElementById("mediaTotalInfo");

  if (!mediaItems || mediaItems.length === 0) {
    listEl.innerHTML =
      '<div class="text-center text-muted py-3">이미지가 없습니다.</div>';
    document.getElementById("mediaPagination").innerHTML = "";
    totalInfo.textContent = "";
    return;
  }

  listEl.innerHTML = mediaItems
    .map((m) => {
      const isVideo = m.mime_type && m.mime_type.startsWith("video/");
      const publicUrl = m.r2_key ? `/media/${m.r2_key}` : "";
      const preview = isVideo
        ? `<video src="${publicUrl}" muted></video>`
        : `<img src="${publicUrl}" alt="${window.escapeHtml(m.filename)}" loading="lazy">`;

      const sizeStr =
        m.size < 1024
          ? `${m.size} B`
          : m.size < 1024 * 1024
            ? `${(m.size / 1024).toFixed(1)} KB`
            : `${(m.size / (1024 * 1024)).toFixed(1)} MB`;

      const uploadDate = m.created_at
        ? new Date(m.created_at * 1000).toLocaleString("ko-KR")
        : "알 수 없음";

      const uploaderName = m.uploader_name
        ? window.escapeHtml(m.uploader_name)
        : "알 수 없음";

      const tagsHtml =
        m.tags && m.tags.length > 0
          ? `<div class="media-item-tags">${m.tags.map((t) => `<span class="media-item-tag">${window.escapeHtml(t)}</span>`).join("")}</div>`
          : "";

      return `
                    <div class="media-item" id="media-item-${m.id}">
                        ${preview}
                        <div class="media-item-info">
                            <a class="filename" href="/w/${encodeURIComponent(`이미지:${m.filename}`)}" title="${window.escapeHtml(m.filename)} 문서로 이동">${window.escapeHtml(m.filename)}</a>
                            <div class="meta">${sizeStr} · ${uploadDate} · 업로더: ${uploaderName}</div>
                            ${tagsHtml}
                        </div>
                        <div class="d-flex gap-2">
                            <button class="btn btn-sm btn-outline-info" data-id="${m.id}" data-filename="${window.escapeHtml(m.filename)}" onclick="trackBacklinks(+this.dataset.id, this.dataset.filename)"
                                title="역링크 추적">
                                <i class="mdi mdi-link-variant"></i> 역링크 추적
                            </button>
                            <button class="btn btn-sm btn-outline-danger" data-id="${m.id}" data-filename="${window.escapeHtml(m.filename)}" onclick="deleteMedia(+this.dataset.id, this.dataset.filename)"
                                title="삭제">
                                <i class="mdi mdi-delete"></i> 삭제
                            </button>
                        </div>
                    </div>
                `;
    })
    .join("");

  const totalPages = Math.max(1, Math.ceil(mediaTotal / mediaPageSize));
  const rangeStart = (mediaPage - 1) * mediaPageSize + 1;
  const rangeEnd = (mediaPage - 1) * mediaPageSize + mediaItems.length;
  totalInfo.textContent = `총 ${mediaTotal}개 · ${rangeStart}-${rangeEnd}번 표시 · 페이지 ${mediaPage}/${totalPages}`;

  renderMediaPagination();
}

async function deleteMedia(id, filename) {
  const result = await Swal.fire({
    title: "이미지 삭제",
    text: `"${filename}" 이미지를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.`,
    icon: "warning",
    showCancelButton: true,
    confirmButtonText: "삭제",
    cancelButtonText: "취소",
    confirmButtonColor: "#d33",
  });

  if (result.isConfirmed) {
    try {
      const res = await fetch(`/api/admin/media/${id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "삭제 실패");

      await loadMedia(mediaPage);

      Swal.fire({
        icon: "success",
        title: "삭제됨",
        showConfirmButton: false,
        timer: 1000,
      });
    } catch (err) {
      Swal.fire("오류", err.message, "error");
    }
  }
}

// ── 쓰레기 수집기 ──
var gcItems = [];

async function runGarbageCollector() {
  const gcBody = document.getElementById("gcBody");
  const gcStatus = document.getElementById("gcStatus");
  const gcList = document.getElementById("gcList");
  const gcActions = document.getElementById("gcActions");
  const gcRunBtn = document.getElementById("gcRunBtn");

  gcBody.style.display = "block";
  gcActions.style.display = "none";
  gcList.innerHTML = "";
  gcStatus.innerHTML =
    '<div class="spinner-border spinner-border-sm text-warning" role="status"></div> 미사용 이미지를 검색하는 중... (시간이 걸릴 수 있습니다)';
  gcRunBtn.disabled = true;

  try {
    const res = await fetch("/api/admin/media/gc");
    if (!res.ok) throw new Error("검색 실패");
    const data = await res.json();

    gcItems = data.unused || [];

    if (gcItems.length === 0) {
      gcStatus.innerHTML =
        '<div class="alert alert-success mb-0"><i class="mdi mdi-check-circle"></i> 미사용 이미지가 없습니다. 모든 이미지가 문서에서 사용 중입니다.</div>';
      return;
    }

    gcStatus.innerHTML = `<div class="alert alert-warning mb-0"><i class="mdi mdi-alert"></i> 전체 ${data.total_media}개 이미지 중 <strong>${data.unused_count}개</strong>가 어떤 문서에서도 사용되지 않고 있습니다.</div>`;

    gcList.innerHTML = gcItems
      .map((m) => {
        const isVideo = m.mime_type && m.mime_type.startsWith("video/");
        const publicUrl = m.r2_key ? `/media/${m.r2_key}` : "";
        const preview = isVideo
          ? `<video src="${publicUrl}" muted style="width:60px;height:60px;object-fit:cover;border-radius:6px;"></video>`
          : `<img src="${publicUrl}" alt="${window.escapeHtml(m.filename)}" loading="lazy" style="width:60px;height:60px;object-fit:cover;border-radius:6px;">`;

        const sizeStr =
          m.size < 1024
            ? `${m.size} B`
            : m.size < 1024 * 1024
              ? `${(m.size / 1024).toFixed(1)} KB`
              : `${(m.size / (1024 * 1024)).toFixed(1)} MB`;

        const uploadDate = m.created_at
          ? new Date(m.created_at * 1000).toLocaleString("ko-KR")
          : "알 수 없음";

        const uploaderName = m.uploader_name
          ? window.escapeHtml(m.uploader_name)
          : "알 수 없음";

        return `
                            <div class="media-item" style="border-color: var(--wiki-warning);">
                                <input type="checkbox" class="form-check-input gc-check" data-id="${m.id}" checked style="flex-shrink:0;">
                                ${preview}
                                <div class="media-item-info">
                                    <a class="filename" href="/w/${encodeURIComponent(`이미지:${m.filename}`)}" title="${window.escapeHtml(m.filename)} 문서로 이동">${window.escapeHtml(m.filename)}</a>
                                    <div class="meta">${sizeStr} · ${uploadDate} · 업로더: ${uploaderName}</div>
                                </div>
                                <button class="btn btn-sm btn-outline-info" onclick="trackBacklinks(${m.id}, '${window.escapeHtml(m.filename)}')" title="역링크 확인">
                                    <i class="mdi mdi-link-variant"></i>
                                </button>
                            </div>`;
      })
      .join("");

    gcActions.style.display = "block";
  } catch (err) {
    gcStatus.innerHTML = `<div class="alert alert-danger mb-0">오류: ${err.message}</div>`;
  } finally {
    gcRunBtn.disabled = false;
  }
}

function gcSelectAll() {
  document
    .querySelectorAll(".gc-check")
    .forEach((cb) => (cb.checked = true));
}

function gcDeselectAll() {
  document
    .querySelectorAll(".gc-check")
    .forEach((cb) => (cb.checked = false));
}

async function gcDeleteSelected() {
  const selectedIds = Array.from(
    document.querySelectorAll(".gc-check:checked"),
  ).map((cb) => Number(cb.dataset.id));

  if (selectedIds.length === 0) {
    Swal.fire("알림", "삭제할 이미지를 선택해주세요.", "info");
    return;
  }

  const result = await Swal.fire({
    title: "미사용 이미지 삭제",
    html: `선택된 <strong>${selectedIds.length}개</strong> 이미지를 영구 삭제하시겠습니까?<br><small class="text-muted">이 작업은 되돌릴 수 없습니다.</small>`,
    icon: "warning",
    showCancelButton: true,
    confirmButtonText: "삭제",
    cancelButtonText: "취소",
    confirmButtonColor: "#d33",
  });

  if (!result.isConfirmed) return;

  const gcDeleteBtn = document.getElementById("gcDeleteBtn");
  gcDeleteBtn.disabled = true;
  gcDeleteBtn.innerHTML =
    '<span class="spinner-border spinner-border-sm"></span> 삭제 중...';

  try {
    const res = await fetch("/api/admin/media/gc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: selectedIds }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "삭제 실패");

    let msg = `${data.deleted_count}개 이미지가 삭제되었습니다.`;
    if (data.errors && data.errors.length > 0) {
      msg += `\n\n경고:\n${data.errors.join("\n")}`;
    }

    Swal.fire({
      icon: data.deleted_count > 0 ? "success" : "warning",
      title: "쓰레기 수집 완료",
      text: msg,
      confirmButtonText: "확인",
    });

    // 메인 목록 현재 페이지 재로드
    await loadMedia(mediaPage);

    // GC 결과 다시 검색
    runGarbageCollector();
  } catch (err) {
    Swal.fire("오류", err.message, "error");
  } finally {
    gcDeleteBtn.disabled = false;
    gcDeleteBtn.innerHTML =
      '<i class="mdi mdi-delete-forever"></i> 선택 항목 삭제';
  }
}

async function trackBacklinks(id, filename) {
  try {
    Swal.fire({
      title: "역링크 추적 중...",
      text: "잠시만 기다려주세요.",
      allowOutsideClick: false,
      didOpen: () => {
        Swal.showLoading();
      },
    });

    const res = await fetch(`/api/admin/media/${id}/backlinks`);
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "역링크 추적 실패");
    }
    const data = await res.json();

    let htmlContent = "";
    if (data.backlinks && data.backlinks.length > 0) {
      htmlContent =
        '<ul class="list-group text-start mt-3" style="max-height: 300px; overflow-y: auto;">';
      data.backlinks.forEach((item) => {
        if (item.type === "blog") {
          htmlContent += `
                                <li class="list-group-item d-flex justify-content-between align-items-center">
                                    <a href="/blog/${encodeURIComponent(item.id)}" target="_blank" class="text-decoration-none">
                                        ${window.escapeHtml(item.title || `#${item.id}`)}
                                    </a>
                                    <span class="badge bg-info rounded-pill">블로그</span>
                                </li>`;
        } else if (item.type === "discussion") {
          // 토론: page_slug 가 있으면 /w/:slug?mode=discussions&id=:id 로 링크, 없으면 텍스트만
          const inner = item.page_slug
            ? `<a href="/w/${encodeURIComponent(item.page_slug)}?mode=discussions&id=${item.id}" target="_blank" class="text-decoration-none">${window.escapeHtml(item.title || `#${item.id}`)}</a>`
            : `<span>${window.escapeHtml(item.title || `#${item.id}`)}</span>`;
          htmlContent += `
                                <li class="list-group-item d-flex justify-content-between align-items-center">
                                    ${inner}
                                    <span class="badge bg-warning text-dark rounded-pill">토론</span>
                                </li>`;
        } else if (item.type === "ticket") {
          htmlContent += `
                                <li class="list-group-item d-flex justify-content-between align-items-center">
                                    <a href="/tickets/${item.id}" target="_blank" class="text-decoration-none">
                                        ${window.escapeHtml(item.title || `#${item.id}`)}
                                    </a>
                                    <span class="badge bg-secondary rounded-pill">티켓</span>
                                </li>`;
        } else {
          htmlContent += `
                                <li class="list-group-item d-flex justify-content-between align-items-center">
                                    <a href="/w/${encodeURIComponent(item.slug)}" target="_blank" class="text-decoration-none">
                                        ${window.escapeHtml(item.slug)}
                                    </a>
                                    <span class="badge bg-secondary rounded-pill">문서</span>
                                </li>`;
        }
      });
      htmlContent += "</ul>";
    } else {
      htmlContent =
        '<div class="alert alert-info mt-3 mb-0">이 이미지를 사용 중인 문서가 없습니다.</div>';
    }

    Swal.fire({
      title: "역링크 추적 결과",
      html:
        `<strong>${window.escapeHtml(filename)}</strong> 사용 문서 목록<br>` +
        htmlContent,
      width: "600px",
      confirmButtonText: "닫기",
    });
  } catch (err) {
    Swal.fire("오류", err.message, "error");
  }
}

// HTML onclick / onchange 속성(정적 HTML + innerHTML 생성 문자열)에서 호출되므로 window 로 노출한다.
window.runGarbageCollector = runGarbageCollector;
window.gcSelectAll = gcSelectAll;
window.gcDeselectAll = gcDeselectAll;
window.gcDeleteSelected = gcDeleteSelected;
window.changeMediaSort = changeMediaSort;
window.searchMedia = searchMedia;
window.goToMediaPage = goToMediaPage;
window.trackBacklinks = trackBacklinks;
window.deleteMedia = deleteMedia;
