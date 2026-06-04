// @ts-nocheck — admin.html 인라인 스크립트 이관(동작 보존). common.ts 와 동일 사유로 타입검사 비활성.
//
// 이관 규칙:
//  - common.ts / icon-picker.ts / admin-palettes.ts 가 window.* 로 노출하는 공통 전역
//    (loadConfig / currentUser / escapeHtml / loadPaletteList / pickWikiIcon 등)은 모듈
//    스코프에서 bare 식별자로 해석되지 않으므로 window.* 로 접근한다. 특히 template literal
//    안의 `${escapeHtml(...)}` 는 문자열 빌드 시점(모듈 스코프)에서 즉시 평가되므로
//    `window.escapeHtml` 로 바꾼다. (반면 on* 속성 문자열 안의 핸들러 호출 — 예:
//    onclick="promptBan(...)" — 은 나중에 전역 스코프에서 실행되므로 bare 로 두고 파일 끝에서
//    window.* 로 노출한다.)
//  - CDN/표준 전역(Swal, bootstrap)은 그대로 둔다.
//  - HTML on* 속성(정적 + innerHTML 생성 문자열)에서 호출되는 블록 정의 함수는 파일 끝에서
//    window.* 로 노출한다.

      // ── 탭 전환 로직 ──
      function showTab(tabId) {
        document
          .querySelectorAll(".tab-pane")
          .forEach((p) => p.classList.remove("active"));
        document.getElementById(tabId).classList.add("active");

        document.querySelectorAll(".admin-nav-item").forEach((item) => {
          const onclick = item.getAttribute("onclick");
          if (onclick && onclick.includes(tabId)) {
            item.classList.add("active");
          } else {
            item.classList.remove("active");
          }
        });

        if (tabId === "tab-users" && !userListLoaded) toggleUserList();
        if (tabId === "tab-content" && !deletedPagesLoaded) loadDeletedPages(1);
        if (tabId === "tab-stats" && !adminLogLoaded) loadAdminLogs();
      }

      document.addEventListener("DOMContentLoaded", async () => {
        await window.loadConfig();

        if (!window.currentUser) {
          window.location.href = "/login";
          return;
        }

        if (
          window.currentUser.role !== "admin" &&
          window.currentUser.role !== "super_admin"
        ) {
          Swal.fire("접근 제한", "관리자만 접근할 수 있습니다.", "error").then(
            () => {
              window.location.href = "/";
            },
          );
          return;
        }

        // 프로필 정보 동적 바인딩
        const profileCard = document.getElementById("adminProfileCard");
        const avatarSlot = document.getElementById("adminAvatarSlot");
        const nameSlot = document.getElementById("adminNameSlot");
        const roleSlot = document.getElementById("adminRoleSlot");
        if (profileCard && window.currentUser) {
          profileCard.style.display = "";
          if (window.currentUser.picture) {
            const img = document.createElement("img");
            img.src = window.currentUser.picture;
            img.className = "rounded-circle";
            img.width = 32;
            img.height = 32;
            avatarSlot.innerHTML = "";
            avatarSlot.appendChild(img);
          }
          nameSlot.textContent = window.currentUser.name;
          let roleBadge = '<span class="badge bg-secondary">User</span>';
          if (window.currentUser.role === 'super_admin') {
            roleBadge = '<span class="badge bg-dark">최고 관리자</span>';
          } else if (window.currentUser.role === 'admin') {
            roleBadge = '<span class="badge bg-primary">관리자</span>';
          }
          roleSlot.innerHTML = roleBadge;
        }

        // 문서 대량 삭제는 최고 관리자 전용 — 빠른 링크를 해당 권한자에게만 노출.
        if (window.currentUser.role === 'super_admin') {
          const bulkLink = document.getElementById("bulkDeleteQuickLink");
          if (bulkLink) bulkLink.style.display = "";
        }

        // 실시간 가입 대기 배지 및 메트릭 업데이트 (관리자 권한 확인 성공 후에만 실행)
        updateSidebarSignupBadge();

        loadCategories();
        document.getElementById("categoryAclSort")?.addEventListener("change", () => {
          catAclPage = 1;
          renderCatAclList();
        });
        loadWikiSettings();
        loadSignupPolicy();
        loadDashStats();
        if (typeof window.loadPaletteList === "function") {
          window.loadPaletteList();
        }
      });

      async function loadDashStats() {
        try {
          const res = await fetch("/api/admin/analytics/overview?period=7d");
          if (!res.ok) return;
          const data = await res.json();
          if (data.summary) {
            document.getElementById("analyticsSummaryCard").style.display = "";
            document.getElementById("dashTotalViews").textContent = Number(
              data.summary.sampled_views || data.summary.total_views || 0,
            ).toLocaleString();
            document.getElementById("dashCountries").textContent = Number(
              data.summary.unique_countries || 0,
            ).toLocaleString();
            renderMiniChart("dashDailyChart", data.daily || []);
          }
          // 대시보드 로드 시 배지 갱신
          updateSidebarSignupBadge();
        } catch (e) {}
      }

      function renderMiniChart(id, data) {
        const container = document.getElementById(id);
        if (!data || data.length === 0) return;
        const maxVal = Math.max(...data.map((d) => Number(d.views || 0)), 1);
        let html = '<div class="d-flex align-items-end gap-1 h-100">';
        data.forEach((d) => {
          const pct = (Number(d.views || 0) / maxVal) * 100;
          html += `<div style="flex:1; height:${Math.max(pct, 5)}%; background:var(--wiki-primary); border-radius:2px;" title="${d.date}: ${d.views}"></div>`;
        });
        html += "</div>";
        container.innerHTML = html;
      }

      // ── 유저 관리 ──
      var userCurrentPage = 1,
        currentSearch = "",
        userListLoaded = false,
        userHasMore = false;
      function toggleUserList() {
        userListLoaded = true;
        loadUsers(1, "");
      }
      async function loadUsers(page = 1, search = "", append = false) {
        try {
          userCurrentPage = page;
          currentSearch = search;
          const role = document.getElementById("userRoleFilter").value;
          const params = new URLSearchParams({
            page,
            limit: 15,
            role,
            sort: "desc",
          });
          if (search) params.append("search", search);
          const res = await fetch(`/api/admin/users?${params.toString()}`);
          const data = await res.json();
          renderUsers(data.users, append);
          userHasMore = page < data.totalPages;
          document.getElementById("userLoadMoreWrapper").style.display =
            userHasMore ? "" : "none";
        } catch (err) {
          Swal.fire("오류", err.message, "error");
        }
      }
      function loadMoreUsers() {
        loadUsers(userCurrentPage + 1, currentSearch, true);
      }
      function searchUsers() {
        loadUsers(1, document.getElementById("userSearchInput").value.trim());
      }
      function renderUsers(users, append = false) {
        const tbody = document.getElementById("userTableBody");
        const html = (users || [])
          .map((u) => {
            const profile = u.picture
              ? `<img src="${u.picture}" class="rounded-circle" width="28" height="28">`
              : `<i class="mdi mdi-account-circle fs-4 text-secondary"></i>`;
            const joinDate = new Date(u.created_at * 1000).toLocaleDateString(
              "ko-KR",
            );
            const isDeleted = u.role === "deleted";
            let roleBadge = `<span class="badge bg-secondary">${u.role}</span>`;
            if (u.role === "super_admin")
              roleBadge = '<span class="badge bg-dark">최고 관리자</span>';
            else if (u.role === "admin")
              roleBadge = '<span class="badge bg-primary">관리자</span>';
            else if (u.role === "discussion_manager")
              roleBadge = '<span class="badge bg-success">토론 관리자</span>';

            let roleSelect = "";
            if (
              window.currentUser.role === "super_admin" &&
              u.role !== "super_admin"
            ) {
              roleSelect = `<select class="form-select form-select-sm w-auto d-inline" onchange="changeRole(${u.id}, this.value)">
                        <option value="user" ${u.role === "user" ? "selected" : ""}>유저</option>
                        <option value="discussion_manager" ${u.role === "discussion_manager" ? "selected" : ""}>토론 관리자</option>
                        <option value="admin" ${u.role === "admin" ? "selected" : ""}>관리자</option>
                    </select>`;
            } else roleSelect = roleBadge;

            return `<tr>
                    <td>${profile}</td>
                    <td><a href="/profile/${u.id}" class="text-decoration-none fw-bold ${isDeleted ? "text-muted" : ""}">${window.escapeHtml(u.name)}</a></td>
                    <td>${roleSelect}</td>
                    <td>${u.banned_until ? '<span class="badge bg-danger">차단됨</span>' : '<span class="badge bg-success">정상</span>'}</td>
                    <td class="small text-muted">${joinDate}</td>
                    <td><button class="btn btn-xs btn-outline-danger" onclick="promptBan(${u.id}, '${window.escapeHtml(u.name)}')">${u.banned_until ? "해제" : "차단"}</button></td>
                </tr>`;
          })
          .join("");
        if (append) tbody.insertAdjacentHTML("beforeend", html);
        else
          tbody.innerHTML =
            html ||
            `<tr><td colspan="6">${window.uiEmptyState({ compact: true, icon: 'bi bi-inbox', title: '결과가 없습니다' })}</td></tr>`;
      }
      async function changeRole(id, role) {
        const res = await fetch(`/api/admin/users/${id}/role`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role }),
        });
        if (res.ok)
          Swal.fire({
            icon: "success",
            title: "변경됨",
            toast: true,
            position: "top-end",
            timer: 1500,
            showConfirmButton: false,
          });
      }
      async function promptBan(id, name) {
        const { value: days } = await Swal.fire({
          title: `${name} 차단`,
          input: "number",
          inputLabel: "일수 (0=해제)",
          inputValue: 7,
          showCancelButton: true,
        });
        if (days !== undefined) {
          const res = await fetch(`/api/admin/users/${id}/ban`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ days: Number(days) }),
          });
          if (res.ok) loadUsers(1, currentSearch);
        }
      }

      // ── 위키 설정 ──
      async function loadWikiSettings() {
        try {
          const res = await fetch("/api/admin/settings");
          const s = await res.json();
          const rl = parseInt(s.namechange_ratelimit, 10);
          if (rl === 0)
            document.getElementById("namechangeUnlimited").checked = true;
          else if (rl === -1)
            document.getElementById("namechangeDisabled").checked = true;
          else {
            document.getElementById("namechangeCooldown").checked = true;
            document.getElementById("cooldownDaysInput").value = rl;
            document.getElementById("cooldownDaysWrapper").style.display = "";
          }
          document.getElementById("allowDmSwitch").checked =
            s.allow_direct_message === 1;
          const policyId =
            s.signup_policy === "approval"
              ? "Approval"
              : s.signup_policy === "blocked"
                ? "Blocked"
                : "Open";
          document.getElementById("signupPolicy" + policyId).checked = true;

          // 편집 ACL 가입일 임계값
          const minAgeEl = document.getElementById("editAclMinAgeInput");
          if (minAgeEl) {
            const v = typeof s.edit_acl_min_age_days === "number"
              ? s.edit_acl_min_age_days : 0;
            minAgeEl.value = String(v);
          }

          // 사람 편집 보류(검토 대기) 전역 토글
          const pendingEl = document.getElementById("pendingChangesEnabledInput");
          if (pendingEl) {
            pendingEl.checked = s.pending_changes_enabled === 1 || s.pending_changes_enabled === true;
          }

          // MCP 설정 로드
          const mcp = s.mcp_mode || "disabled";
          const b = document.getElementById("mcpModeDisplay");
          if (b) {
            b.textContent =
              mcp === "open" ? "Open (전체 개방)" : "Disabled (차단)";
            b.className =
              "badge " + (mcp === "open" ? "bg-success" : "bg-secondary");
          }
          if (mcp === "open") {
            document.getElementById("mcpServerUrlBox").style.display = "";
            document.getElementById("mcpServerUrlInput").value =
              window.location.origin + "/api/mcp";
          } else {
            document.getElementById("mcpServerUrlBox").style.display = "none";
          }

          // 공지 목록 로드는 별도 호출
          loadAnnouncements();
        } catch (e) {
          console.error("Settings load failed", e);
        }
      }

      // ── 사이트 공지 관리 ──
      let annNewIconClass = null; // 신규 발행 폼의 선택된 아이콘 class (null = 기본)
      let annEditIconClass = null; // 수정 모달의 선택된 아이콘 class
      let announcementsCache = []; // 마지막으로 로드한 공지 배열 (수정 모달이 참조)

      function setIconPreview(previewId, labelId, iconClass) {
        const preview = document.getElementById(previewId);
        const label = document.getElementById(labelId);
        if (preview) preview.className = iconClass || "mdi mdi-bullhorn";
        if (label)
          label.textContent = iconClass
            ? iconClass.replace(/^(mdi mdi-|bi bi-)/, "")
            : "기본";
      }

      async function loadAnnouncements() {
        const tbody = document.getElementById("announcementsTbody");
        if (!tbody) return;
        try {
          const res = await fetch("/api/admin/announcements");
          if (!res.ok) throw new Error("목록 조회 실패");
          const data = await res.json();
          renderAnnouncementsTable(data.announcements || []);
        } catch (e) {
          tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger">불러오기 실패: ${window.escapeHtml(e.message)}</td></tr>`;
        }
      }

      function renderAnnouncementsTable(list) {
        announcementsCache = list;
        const tbody = document.getElementById("announcementsTbody");
        if (!tbody) return;
        if (!list.length) {
          tbody.innerHTML =
            `<tr><td colspan="5">${window.uiEmptyState({ compact: true, icon: 'bi bi-megaphone', title: '발행된 공지가 없습니다' })}</td></tr>`;
          return;
        }
        tbody.innerHTML = list
          .map((a, i) => {
            const iconCls = a.icon || "mdi mdi-bullhorn";
            const linkHtml = a.url
              ? `<a href="${window.escapeHtml(a.url)}" target="_blank" rel="noopener" class="text-decoration-none">${window.escapeHtml(a.url)}</a>`
              : '<span class="text-muted">(텍스트 전용)</span>';
            const postHtml = a.postId
              ? `<div class="small text-muted">blog#${a.postId}${a.postDeleted ? ' <span class="badge bg-danger ms-1">삭제됨</span>' : ""}${a.postTitle ? " — " + window.escapeHtml(a.postTitle) : ""}</div>`
              : "";
            const time = a.announcedTime
              ? new Date(a.announcedTime * 1000).toLocaleString("ko-KR")
              : "";
            const isFirst = i === 0;
            const isLast = i === list.length - 1;
            return (
              `<tr data-id="${a.id}">` +
              `<td class="text-center"><i class="${window.escapeHtml(iconCls)}" style="font-size:1.2rem;"></i></td>` +
              `<td><div class="fw-semibold">${window.escapeHtml(a.title || "(제목 없음)")}</div>${postHtml}</td>` +
              `<td class="small text-break">${linkHtml}</td>` +
              `<td class="small">${window.escapeHtml(time)}</td>` +
              `<td class="text-end">` +
              `<div class="btn-group btn-group-sm" role="group">` +
              `<button class="btn btn-outline-secondary" ${isFirst ? "disabled" : ""} onclick="moveAnnouncement(${a.id}, 'up')" title="위로"><i class="bi bi-arrow-up"></i></button>` +
              `<button class="btn btn-outline-secondary" ${isLast ? "disabled" : ""} onclick="moveAnnouncement(${a.id}, 'down')" title="아래로"><i class="bi bi-arrow-down"></i></button>` +
              `<button class="btn btn-outline-primary" onclick="openAnnouncementEdit(${a.id})" title="수정"><i class="bi bi-pencil"></i></button>` +
              `<button class="btn btn-outline-danger" onclick="deleteAnnouncement(${a.id})" title="철회"><i class="bi bi-trash"></i></button>` +
              `</div>` +
              `</td>` +
              `</tr>`
            );
          })
          .join("");
      }

      async function pickIconViaModal() {
        if (typeof window.pickWikiIcon !== "function") {
          Swal.fire("오류", "아이콘 피커가 로드되지 않았습니다.", "error");
          return null;
        }
        return await window.pickWikiIcon();
      }

      async function createAnnouncement() {
        const title = document.getElementById("annNewTitle").value.trim();
        const url = document.getElementById("annNewUrl").value.trim();
        if (!title) {
          Swal.fire("입력 필요", "제목을 입력하세요.", "warning");
          return;
        }
        const body = { title, icon: annNewIconClass || null };
        if (url) body.url = url;
        try {
          const res = await fetch("/api/admin/announcements", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || "발행 실패");
          Swal.fire({
            icon: "success",
            title: "공지가 발행되었습니다.",
            toast: true,
            position: "top-end",
            timer: 1500,
            showConfirmButton: false,
          });
          document.getElementById("annNewTitle").value = "";
          document.getElementById("annNewUrl").value = "";
          annNewIconClass = null;
          setIconPreview("annNewIconPreview", "annNewIconLabel", null);
          await loadAnnouncements();
          // 헤더 배너 즉시 반영
          await window.loadConfig();
        } catch (e) {
          Swal.fire("오류", e.message || "발행 실패", "error");
        }
      }

      async function deleteAnnouncement(id) {
        const ok = await Swal.fire({
          title: "공지를 철회하시겠습니까?",
          icon: "warning",
          showCancelButton: true,
          confirmButtonText: "철회",
          cancelButtonText: "취소",
          confirmButtonColor: "#d33",
        });
        if (!ok.isConfirmed) return;
        try {
          const res = await fetch(`/api/admin/announcements/${id}`, {
            method: "DELETE",
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || "철회 실패");
          }
          await loadAnnouncements();
          await window.loadConfig();
        } catch (e) {
          Swal.fire("오류", e.message || "철회 실패", "error");
        }
      }

      async function moveAnnouncement(id, direction) {
        try {
          const res = await fetch(`/api/admin/announcements/${id}/move`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ direction }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || "이동 실패");
          }
          await loadAnnouncements();
          await window.loadConfig();
        } catch (e) {
          Swal.fire("오류", e.message || "이동 실패", "error");
        }
      }

      function openAnnouncementEdit(id) {
        const ann = announcementsCache.find((a) => Number(a.id) === Number(id));
        if (!ann) return;
        document.getElementById("annEditId").value = ann.id;
        document.getElementById("annEditTitle").value = ann.title || "";
        annEditIconClass = ann.icon || null;
        setIconPreview(
          "annEditIconPreview",
          "annEditIconLabel",
          annEditIconClass,
        );
        const modal = bootstrap.Modal.getOrCreateInstance(
          document.getElementById("announcementEditModal"),
        );
        modal.show();
      }

      async function submitAnnouncementEdit() {
        const id = Number(document.getElementById("annEditId").value);
        const title = document.getElementById("annEditTitle").value.trim();
        if (!title) {
          Swal.fire("입력 필요", "제목을 입력하세요.", "warning");
          return;
        }
        try {
          const res = await fetch(`/api/admin/announcements/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, icon: annEditIconClass || null }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || "수정 실패");
          }
          bootstrap.Modal.getOrCreateInstance(
            document.getElementById("announcementEditModal"),
          ).hide();
          await loadAnnouncements();
          await window.loadConfig();
        } catch (e) {
          Swal.fire("오류", e.message || "수정 실패", "error");
        }
      }

      // 폼 / 모달 이벤트 바인딩 (DOM 준비 후 단 한 번)
      document.addEventListener("DOMContentLoaded", () => {
        const submitBtn = document.getElementById("annNewSubmit");
        if (submitBtn) submitBtn.addEventListener("click", createAnnouncement);
        const iconBtn = document.getElementById("annNewIconBtn");
        if (iconBtn)
          iconBtn.addEventListener("click", async () => {
            const picked = await pickIconViaModal();
            // null = '아이콘 없음' 또는 취소 → 기본 아이콘으로 두려면 그대로 null.
            annNewIconClass = picked;
            setIconPreview("annNewIconPreview", "annNewIconLabel", picked);
          });
        const iconClearBtn = document.getElementById("annNewIconClearBtn");
        if (iconClearBtn)
          iconClearBtn.addEventListener("click", () => {
            annNewIconClass = null;
            setIconPreview("annNewIconPreview", "annNewIconLabel", null);
          });
        const editSubmit = document.getElementById("annEditSubmit");
        if (editSubmit)
          editSubmit.addEventListener("click", submitAnnouncementEdit);
        const editIconBtn = document.getElementById("annEditIconBtn");
        if (editIconBtn)
          editIconBtn.addEventListener("click", async () => {
            const picked = await pickIconViaModal();
            annEditIconClass = picked;
            setIconPreview("annEditIconPreview", "annEditIconLabel", picked);
          });
        const editIconClearBtn = document.getElementById("annEditIconClearBtn");
        if (editIconClearBtn)
          editIconClearBtn.addEventListener("click", () => {
            annEditIconClass = null;
            setIconPreview("annEditIconPreview", "annEditIconLabel", null);
          });
      });

      async function copyMcpUrl(inputId) {
        const input = document.getElementById(inputId || "mcpServerUrlInput");
        if (!input) return;
        try {
          await navigator.clipboard.writeText(input.value);
          Swal.fire({
            icon: "success",
            title: "복사됨",
            toast: true,
            position: "top-end",
            showConfirmButton: false,
            timer: 1500,
          });
        } catch (e) {
          input.select();
          document.execCommand("copy");
          Swal.fire({
            icon: "success",
            title: "복사됨",
            toast: true,
            position: "top-end",
            showConfirmButton: false,
            timer: 1500,
          });
        }
      }
      document
        .querySelectorAll('input[name="namechangePolicy"]')
        .forEach((r) => {
          r.addEventListener("change", (e) => {
            document.getElementById("cooldownDaysWrapper").style.display =
              e.target.value === "custom" ? "" : "none";
          });
        });
      async function saveWikiSettings() {
        const p = document.querySelector(
          'input[name="namechangePolicy"]:checked',
        ).value;
        const rl =
          p === "custom"
            ? parseInt(document.getElementById("cooldownDaysInput").value)
            : parseInt(p);
        const minAgeRaw = document.getElementById("editAclMinAgeInput");
        const minAgeVal = minAgeRaw ? parseInt(minAgeRaw.value, 10) : 0;
        const body = {
          namechange_ratelimit: rl,
          allow_direct_message: document.getElementById("allowDmSwitch").checked
            ? 1
            : 0,
          signup_policy: document.querySelector(
            'input[name="signupPolicy"]:checked',
          ).value,
          edit_acl_min_age_days: Number.isFinite(minAgeVal) && minAgeVal >= 0 ? minAgeVal : 0,
          pending_changes_enabled: document.getElementById("pendingChangesEnabledInput")?.checked
            ? 1
            : 0,
        };
        const res = await fetch("/api/admin/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok)
          Swal.fire({
            icon: "success",
            title: "저장 완료",
            toast: true,
            position: "top-end",
            timer: 1500,
            showConfirmButton: false,
          });
      }

      // ── 가입 신청 ──

      // ── 실시간 가입 대기 배지 및 대시보드 메트릭 업데이트 ──
      async function updateSidebarSignupBadge() {
        try {
          const res = await fetch("/api/admin/signup-requests?status=pending&limit=1");
          if (res.ok) {
            const data = await res.json();
            const count = data.total || 0;
            const badge = document.getElementById("sidebarSignupBadge");
            const dashBadge = document.getElementById("dashSignupRequests");
            if (badge) {
              if (count > 0) {
                badge.textContent = count;
                badge.style.display = "";
              } else {
                badge.style.display = "none";
              }
            }
            if (dashBadge) {
              dashBadge.textContent = count;
            }
          }
        } catch (e) {
          console.error("Failed to load signup request count for sidebar badge", e);
        }
      }

      async function loadSignupPolicy() {
        const res = await fetch("/api/auth/signup-policy");
        const data = await res.json();
        if (data.policy === "approval") {
          document.getElementById("signupRequestsCard").style.display = "";
          document.getElementById("dashSignupCard")?.removeAttribute("style");
          loadSignupRequests();
        } else {
          const dashSignupCard = document.getElementById("dashSignupCard");
          if (dashSignupCard) dashSignupCard.style.display = "none";
          // 가입 승인 대기 카드를 숨겼으므로 나머지 3개 카드가 공간을 꽉 채우도록 col-lg-4 로 조정한다.
          document.querySelectorAll(".dash-metric-card-wrapper").forEach(el => {
            el.classList.remove("col-lg-3");
            el.classList.add("col-lg-4");
          });
        }
      }
      var signupRequestsOffset = 0;
      async function loadSignupRequests(append = false) {
        if (!append) signupRequestsOffset = 0;
        const status = document.getElementById("signupStatusFilter").value;
        const res = await fetch(
          `/api/admin/signup-requests?status=${status}&limit=10&offset=${signupRequestsOffset}`,
        );
        const data = await res.json();
        renderSignupRequests(data.requests, append);
        document.getElementById("signupRequestsLoadMore").style.display =
          data.hasMore ? "" : "none";
      }
      function loadMoreSignupRequests() {
        signupRequestsOffset += 10;
        loadSignupRequests(true);
      }
      function renderSignupRequests(reqs, append) {
        const tbody = document.getElementById("signupRequestsBody");
        const html = (reqs || [])
          .map(
            (r) => `<tr>
                <td>${r.picture ? `<img src="${r.picture}" width="24" height="24" class="rounded-circle">` : "-"}</td>
                <td class="fw-bold small">${window.escapeHtml(r.name)}</td>
                <td class="small">${window.escapeHtml(r.email)}</td>
                <td><span class="badge bg-info">${r.status}</span></td>
                <td>
                    <button class="btn btn-xs btn-outline-success" onclick="approveSignup(${r.id})">승인</button>
                    <button class="btn btn-xs btn-outline-danger" onclick="rejectSignup(${r.id})">거절</button>
                </td>
            </tr>`,
          )
          .join("");
        if (append) tbody.insertAdjacentHTML("beforeend", html);
        else
          tbody.innerHTML =
            html ||
            `<tr><td colspan="5">${window.uiEmptyState({ compact: true, icon: 'bi bi-inbox', title: '신청이 없습니다' })}</td></tr>`;
      }
      async function approveSignup(id) {
        try {
          const res = await fetch(`/api/admin/signup-requests/${id}/approve`, {
            method: "PUT",
          });
          if (res.ok) {
            loadSignupRequests();
            updateSidebarSignupBadge();
          } else {
            const data = await res.json().catch(() => ({}));
            Swal.fire(
              "오류",
              data.error || "승인 처리 중 오류가 발생했습니다.",
              "error",
            );
          }
        } catch (err) {
          Swal.fire("오류", err.message, "error");
        }
      }
      async function rejectSignup(id) {
        try {
          const res = await fetch(`/api/admin/signup-requests/${id}/reject`, {
            method: "PUT",
          });
          if (res.ok) {
            loadSignupRequests();
            updateSidebarSignupBadge();
          } else {
            const data = await res.json().catch(() => ({}));
            Swal.fire(
              "오류",
              data.error || "거절 처리 중 오류가 발생했습니다.",
              "error",
            );
          }
        } catch (err) {
          Swal.fire("오류", err.message, "error");
        }
      }

      // ── 삭제된 문서 ──
      var deletedPagesLoaded = false,
        deletedPagesPage = 1,
        deletedPagesTotal = 0,
        deletedPagesSearchTerm = "";
      const DELETED_PAGES_PAGE_SIZE = 10;

      async function loadDeletedPages(page = 1) {
        try {
          deletedPagesLoaded = true;
          deletedPagesPage = page;
          const params = new URLSearchParams({
            limit: DELETED_PAGES_PAGE_SIZE,
            offset: (page - 1) * DELETED_PAGES_PAGE_SIZE,
          });
          if (deletedPagesSearchTerm)
            params.set("search", deletedPagesSearchTerm);
          const res = await fetch(`/api/admin/pages/deleted?${params}`);
          if (!res.ok) throw new Error("목록을 불러오지 못했습니다.");
          const data = await res.json();
          deletedPagesTotal = data.total || 0;
          const html = (data.pages || [])
            .map((p) => {
              const slugAttr = JSON.stringify(p.slug).replace(/"/g, "&quot;");
              return `<tr>
                <td>
                  <div class="fw-bold small">${window.escapeHtml(p.slug)}</div>
                </td>
                <td class="small text-muted">${new Date(p.deleted_at * 1000).toLocaleString()}</td>
                <td>
                  <a href="/w/${encodeURIComponent(p.slug)}" target="_blank" rel="noopener" class="btn btn-xs btn-outline-secondary me-1" title="새 탭으로 열기" aria-label="새 탭으로 열기"><i class="mdi mdi-open-in-new"></i></a>
                  <button class="btn btn-xs btn-outline-success" onclick="restorePage(${slugAttr})">복원</button>
                </td>
            </tr>`;
            })
            .join("");
          const tbody = document.getElementById("deletedPagesBody");
          tbody.innerHTML =
            html ||
            `<tr><td colspan="3">${window.uiEmptyState({ compact: true, icon: 'bi bi-trash', title: '삭제된 문서가 없습니다' })}</td></tr>`;
          document.getElementById("deletedPagesTotal").textContent =
            deletedPagesTotal > 0 ? `총 ${deletedPagesTotal}건` : "";
          renderDeletedPagesPagination();
        } catch (err) {
          Swal.fire("오류", err.message, "error");
        }
      }

      function searchDeletedPages() {
        deletedPagesSearchTerm = document
          .getElementById("deletedPagesSearch")
          .value.trim();
        loadDeletedPages(1);
      }

      function resetDeletedPagesSearch() {
        document.getElementById("deletedPagesSearch").value = "";
        deletedPagesSearchTerm = "";
        loadDeletedPages(1);
      }

      function goToDeletedPagesPage(page) {
        const totalPages = Math.max(
          1,
          Math.ceil(deletedPagesTotal / DELETED_PAGES_PAGE_SIZE),
        );
        const target = Math.min(Math.max(1, page), totalPages);
        if (target === deletedPagesPage) return;
        loadDeletedPages(target);
      }

      function getDeletedPagesPageNumbers(current, total) {
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

      function renderDeletedPagesPagination() {
        const container = document.getElementById("deletedPagesPagination");
        if (!deletedPagesTotal) {
          container.innerHTML = "";
          return;
        }
        const totalPages = Math.max(
          1,
          Math.ceil(deletedPagesTotal / DELETED_PAGES_PAGE_SIZE),
        );
        const pages = getDeletedPagesPageNumbers(deletedPagesPage, totalPages);
        const isFirst = deletedPagesPage === 1;
        const isLast = deletedPagesPage === totalPages;
        let html =
          '<ul class="pagination pagination-sm justify-content-center mb-0 flex-wrap">';
        html += `<li class="page-item ${isFirst ? "disabled" : ""}"><button type="button" class="page-link" onclick="goToDeletedPagesPage(1)" ${isFirst ? "disabled" : ""} aria-label="처음"><i class="mdi mdi-chevron-double-left"></i></button></li>`;
        html += `<li class="page-item ${isFirst ? "disabled" : ""}"><button type="button" class="page-link" onclick="goToDeletedPagesPage(${deletedPagesPage - 1})" ${isFirst ? "disabled" : ""} aria-label="이전"><i class="mdi mdi-chevron-left"></i></button></li>`;
        for (const p of pages) {
          if (p === "...") {
            html +=
              '<li class="page-item disabled"><span class="page-link">…</span></li>';
          } else {
            const active = p === deletedPagesPage ? "active" : "";
            html += `<li class="page-item ${active}"><button type="button" class="page-link" onclick="goToDeletedPagesPage(${p})">${p}</button></li>`;
          }
        }
        html += `<li class="page-item ${isLast ? "disabled" : ""}"><button type="button" class="page-link" onclick="goToDeletedPagesPage(${deletedPagesPage + 1})" ${isLast ? "disabled" : ""} aria-label="다음"><i class="mdi mdi-chevron-right"></i></button></li>`;
        html += `<li class="page-item ${isLast ? "disabled" : ""}"><button type="button" class="page-link" onclick="goToDeletedPagesPage(${totalPages})" ${isLast ? "disabled" : ""} aria-label="마지막"><i class="mdi mdi-chevron-double-right"></i></button></li>`;
        html += "</ul>";
        container.innerHTML = html;
      }

      async function restorePage(slug) {
        const confirm = await Swal.fire({
          title: "문서를 복원하시겠습니까?",
          text: slug,
          icon: "question",
          showCancelButton: true,
          confirmButtonText: "복원",
          cancelButtonText: "취소",
        });
        if (!confirm.isConfirmed) return;
        try {
          const res = await fetch(
            `/api/w/${encodeURIComponent(slug)}/restore`,
            { method: "POST" },
          );
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || "복원에 실패했습니다.");
          }
          Swal.fire({
            icon: "success",
            title: "복원 완료",
            toast: true,
            position: "top-end",
            timer: 1500,
            showConfirmButton: false,
          });
          loadDeletedPages(1);
        } catch (err) {
          Swal.fire("오류", err.message, "error");
        }
      }

      // ── 카테고리 ACL ──
      const CAT_ACL_PAGE_SIZE = 20;
      const CAT_ACL_FLAG_LABELS = { aged: "가입 N일", page_editor: "본 문서 편집이력", any_editor: "임의 편집이력", admin_only: "관리자 전용" };
      let catAclAllItems = [];
      let catAclPage = 1;

      function getCatAclSort() {
        return document.getElementById("categoryAclSort")?.value || "name_asc";
      }

      function sortedCatAclItems() {
        const sort = getCatAclSort();
        const arr = [...catAclAllItems];
        if (sort === "name_asc") arr.sort((a, b) => a.name.localeCompare(b.name, "ko"));
        else if (sort === "name_desc") arr.sort((a, b) => b.name.localeCompare(a.name, "ko"));
        else if (sort === "pages_desc") arr.sort((a, b) => (b.page_count - a.page_count) || a.name.localeCompare(b.name, "ko"));
        else if (sort === "created_desc") arr.sort((a, b) => (b.created_at - a.created_at) || a.name.localeCompare(b.name, "ko"));
        return arr;
      }

      function renderCatAclPagination(totalPages) {
        const nav = document.getElementById("categoryAclPagination");
        if (totalPages <= 1) { nav.innerHTML = ""; return; }
        const cur = catAclPage;
        const pages = [];
        for (let p = 1; p <= totalPages; p++) {
          if (p === 1 || p === totalPages || (p >= cur - 2 && p <= cur + 2)) {
            pages.push(p);
          } else if (pages[pages.length - 1] !== "…") {
            pages.push("…");
          }
        }
        nav.innerHTML = `<ul class="pagination pagination-sm justify-content-center mb-0">${
          pages.map(p =>
            p === "…"
              ? `<li class="page-item disabled"><span class="page-link">…</span></li>`
              : `<li class="page-item ${p === cur ? "active" : ""}"><button type="button" class="page-link cat-acl-page-btn" data-page="${p}">${p}</button></li>`
          ).join("")
        }</ul>`;
        nav.querySelectorAll(".cat-acl-page-btn").forEach(btn => {
          btn.addEventListener("click", () => {
            catAclPage = parseInt(btn.getAttribute("data-page"));
            renderCatAclList();
          });
        });
      }

      function renderCatAclList() {
        const container = document.getElementById("categoryAclSummary");
        const sorted = sortedCatAclItems();
        const totalPages = Math.max(1, Math.ceil(sorted.length / CAT_ACL_PAGE_SIZE));
        catAclPage = Math.min(catAclPage, totalPages);
        const slice = sorted.slice((catAclPage - 1) * CAT_ACL_PAGE_SIZE, catAclPage * CAT_ACL_PAGE_SIZE);

        if (slice.length === 0) {
          container.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-shield-lock', title: '등록된 카테고리 ACL이 없습니다' });
        } else {
          container.innerHTML = slice.map(it => {
            const flags = (it.edit_acl && it.edit_acl.flags) || [];
            const adminOnly = flags.includes("admin_only");
            const summary = flags.length
              ? flags.map(f => CAT_ACL_FLAG_LABELS[f] || f).join(" + ")
              : "비활성";
            const href = "/w/" + encodeURIComponent("카테고리:" + it.name);
            return `<a href="${href}" class="list-group-item list-group-item-action d-flex justify-content-between align-items-center py-2">
              <div>
                <code>${window.escapeHtml(it.name)}</code>
                <span class="badge ${adminOnly ? "bg-danger" : "bg-secondary"} ms-2">${window.escapeHtml(summary)}</span>
              </div>
              <span class="text-muted small">${it.page_count}개 문서</span>
            </a>`;
          }).join("");
        }
        renderCatAclPagination(totalPages);
      }

      async function loadCategories() {
        const container = document.getElementById("categoryAclSummary");
        try {
          const res = await fetch("/api/admin/category-acl");
          if (!res.ok) throw new Error(`(${res.status})`);
          const data = await res.json();
          catAclAllItems = (data && data.items) || [];
          catAclPage = 1;
          renderCatAclList();
        } catch (e) {
          container.innerHTML = `<div class="p-3 text-center text-danger small">목록 조회 실패: ${window.escapeHtml(String(e))}</div>`;
        }
      }

      // ── 통계 및 로그 ──
      let adminLogLoaded = false,
        adminLogPage = 1,
        adminLogTotal = 0;
      const ADMIN_LOG_PAGE_SIZE = 15;

      async function loadAdminLogs(page = 1) {
        try {
          adminLogLoaded = true;
          adminLogPage = page;
          const search =
            document.getElementById("adminLogSearch")?.value.trim() || "";
          const type = document.getElementById("adminLogType")?.value || "all";
          const params = new URLSearchParams({
            offset: (page - 1) * ADMIN_LOG_PAGE_SIZE,
          });
          if (search) params.set("search", search);
          if (type && type !== "all") params.set("type", type);
          const res = await fetch(`/api/admin/logs?${params}`);
          if (!res.ok) throw new Error("로그를 불러오지 못했습니다.");
          const data = await res.json();
          adminLogTotal = data.total || 0;
          const html = (data.logs || [])
            .map(
              (log) => `<tr>
                <td class="small text-muted">${new Date(log.created_at * 1000).toLocaleString()}</td>
                <td><span class="badge bg-secondary">${window.escapeHtml(log.type)}</span></td>
                <td class="small">${window.escapeHtml(log.log)}</td>
                <td class="small">${window.escapeHtml(log.user_name || "Admin")}</td>
            </tr>`,
            )
            .join("");
          document.getElementById("adminLogBody").innerHTML =
            html ||
            `<tr><td colspan="4">${window.uiEmptyState({ compact: true, icon: 'bi bi-inbox', title: '로그가 없습니다' })}</td></tr>`;
          document.getElementById("adminLogTotal").textContent =
            adminLogTotal > 0 ? `총 ${adminLogTotal}건` : "";
          renderAdminLogPagination();
        } catch (err) {
          Swal.fire("오류", err.message, "error");
        }
      }

      function goToAdminLogPage(page) {
        const totalPages = Math.max(
          1,
          Math.ceil(adminLogTotal / ADMIN_LOG_PAGE_SIZE),
        );
        const target = Math.min(Math.max(1, page), totalPages);
        if (target === adminLogPage) return;
        loadAdminLogs(target);
      }

      function renderAdminLogPagination() {
        const container = document.getElementById("adminLogPagination");
        if (!adminLogTotal) {
          container.innerHTML = "";
          return;
        }
        const totalPages = Math.max(
          1,
          Math.ceil(adminLogTotal / ADMIN_LOG_PAGE_SIZE),
        );
        const pages = getDeletedPagesPageNumbers(adminLogPage, totalPages);
        const isFirst = adminLogPage === 1;
        const isLast = adminLogPage === totalPages;
        let html =
          '<ul class="pagination pagination-sm justify-content-center mb-0 flex-wrap">';
        html += `<li class="page-item ${isFirst ? "disabled" : ""}"><button type="button" class="page-link" onclick="goToAdminLogPage(1)" ${isFirst ? "disabled" : ""} aria-label="처음"><i class="mdi mdi-chevron-double-left"></i></button></li>`;
        html += `<li class="page-item ${isFirst ? "disabled" : ""}"><button type="button" class="page-link" onclick="goToAdminLogPage(${adminLogPage - 1})" ${isFirst ? "disabled" : ""} aria-label="이전"><i class="mdi mdi-chevron-left"></i></button></li>`;
        for (const p of pages) {
          if (p === "...") {
            html +=
              '<li class="page-item disabled"><span class="page-link">…</span></li>';
          } else {
            const active = p === adminLogPage ? "active" : "";
            html += `<li class="page-item ${active}"><button type="button" class="page-link" onclick="goToAdminLogPage(${p})">${p}</button></li>`;
          }
        }
        html += `<li class="page-item ${isLast ? "disabled" : ""}"><button type="button" class="page-link" onclick="goToAdminLogPage(${adminLogPage + 1})" ${isLast ? "disabled" : ""} aria-label="다음"><i class="mdi mdi-chevron-right"></i></button></li>`;
        html += `<li class="page-item ${isLast ? "disabled" : ""}"><button type="button" class="page-link" onclick="goToAdminLogPage(${totalPages})" ${isLast ? "disabled" : ""} aria-label="마지막"><i class="mdi mdi-chevron-double-right"></i></button></li>`;
        html += "</ul>";
        container.innerHTML = html;
      }

      async function loadAnalyticsDashboard() {
        document.getElementById("analyticsLoadBtn").style.display = "none";
        document.getElementById("analyticsRealContent").style.display = "";
        refreshAnalytics();
      }
      async function refreshAnalytics() {
        const p = "7d";
        const [o, pg, t, ref, cou, dev, sea, err, perf] = await Promise.all([
          fetch(`/api/admin/analytics/overview?period=${p}`).then((r) =>
            r.json(),
          ),
          fetch(`/api/admin/analytics/pages?period=${p}`).then((r) => r.json()),
          fetch(`/api/admin/analytics/trending?hours=24`).then((r) => r.json()),
          fetch(`/api/admin/analytics/referrers?period=${p}`).then((r) =>
            r.json(),
          ),
          fetch(`/api/admin/analytics/countries?period=${p}`).then((r) =>
            r.json(),
          ),
          fetch(`/api/admin/analytics/devices?period=${p}`).then((r) =>
            r.json(),
          ),
          fetch(`/api/admin/analytics/searches?period=${p}`).then((r) =>
            r.json(),
          ),
          fetch(`/api/admin/analytics/errors?period=${p}`).then((r) =>
            r.json(),
          ),
          fetch(`/api/admin/analytics/performance?period=${p}`).then((r) =>
            r.json(),
          ),
        ]);
        renderMiniChart("dailyChart", o.daily || []);
        renderAnalyticsList(
          "topPagesContainer",
          pg.pages?.map((x) => ({ label: x.slug, value: x.views })),
        );
        renderAnalyticsList(
          "trendingContainer",
          t.trending?.map((x) => ({ label: x.slug, value: x.views })),
        );
        renderAnalyticsList(
          "referrersContainer",
          ref.referrers?.map((x) => ({ label: x.referer, value: x.views })),
        );
        renderAnalyticsList(
          "countriesContainer",
          cou.countries?.map((x) => ({ label: x.country, value: x.views })),
        );
        renderAnalyticsList(
          "devicesContainer",
          dev.devices?.map((x) => ({ label: x.device, value: x.views })),
        );
        renderAnalyticsList(
          "searchesContainer",
          sea.searches?.map((x) => ({ label: x.query, value: x.count })),
        );

        // Render Errors
        const errBody = document.getElementById("errorsContainerBody");
        if (!err.errors || err.errors.length === 0) {
          errBody.innerHTML =
            `<tr><td colspan="4">${window.uiEmptyState({ compact: true, icon: 'bi bi-check-circle', title: '에러가 없습니다' })}</td></tr>`;
        } else {
          errBody.innerHTML = err.errors
            .map(
              (e) => `
                    <tr>
                        <td>${window.escapeHtml(e.path)}</td>
                        <td>${window.escapeHtml(e.error_message)}</td>
                        <td><span class="badge ${e.status_code >= 500 ? "bg-danger" : "bg-warning text-dark"}">${e.status_code}</span></td>
                        <td>${e.count}</td>
                    </tr>
                `,
            )
            .join("");
        }

        // Render Performance
        const perfContainer = document.getElementById("performanceContainer");
        if (!perf.summary) {
          perfContainer.innerHTML =
            window.uiEmptyState({ compact: true, icon: 'bi bi-bar-chart', title: '데이터가 없습니다' });
        } else {
          perfContainer.innerHTML = `                    <div class="admin-metric-card">
                        <div class="text-muted mb-1">평균 (Avg)</div>
                        <div class="fw-bold">${Math.round(perf.summary.avg_response_ms || 0)} ms</div>
                    </div>
                    <div class="admin-metric-card">
                        <div class="text-muted mb-1">p95</div>
                        <div class="fw-bold">${Math.round(perf.summary.p95_response_ms || 0)} ms</div>
                    </div>
                    <div class="admin-metric-card">
                        <div class="text-muted mb-1">p99</div>
                        <div class="fw-bold">${Math.round(perf.summary.p99_response_ms || 0)} ms</div>
                    </div>
                `;
        }
      }
      function renderAnalyticsList(id, items) {
        const el = document.getElementById(id);
        if (!items || items.length === 0) {
          el.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-bar-chart', title: '데이터가 없습니다' });
          return;
        }
        const max = Math.max(...items.map((i) => i.value), 1);
        el.innerHTML = items
          .slice(0, 5)
          .map(
            (i) => `
                <div class="mb-2">
                    <div class="d-flex justify-content-between small mb-1"><span class="text-truncate" style="max-width:80%">${window.escapeHtml(i.label)}</span><span>${i.value}</span></div>
                    <div class="progress" style="height:3px;"><div class="progress-bar" style="width:${(i.value / max) * 100}%"></div></div>
                </div>
            `,
          )
          .join("");
      }

// ── HTML on* 속성(정적 + innerHTML 생성 문자열)에서 호출되는 함수 window 노출 ──
window.showTab = showTab;
window.loadMoreUsers = loadMoreUsers;
window.searchUsers = searchUsers;
window.changeRole = changeRole;
window.promptBan = promptBan;
window.saveWikiSettings = saveWikiSettings;
window.copyMcpUrl = copyMcpUrl;
window.moveAnnouncement = moveAnnouncement;
window.openAnnouncementEdit = openAnnouncementEdit;
window.deleteAnnouncement = deleteAnnouncement;
window.loadSignupRequests = loadSignupRequests;
window.loadMoreSignupRequests = loadMoreSignupRequests;
window.approveSignup = approveSignup;
window.rejectSignup = rejectSignup;
window.searchDeletedPages = searchDeletedPages;
window.resetDeletedPagesSearch = resetDeletedPagesSearch;
window.goToDeletedPagesPage = goToDeletedPagesPage;
window.restorePage = restorePage;
window.loadAdminLogs = loadAdminLogs;
window.goToAdminLogPage = goToAdminLogPage;
window.loadAnalyticsDashboard = loadAnalyticsDashboard;
window.refreshAnalytics = refreshAnalytics;
