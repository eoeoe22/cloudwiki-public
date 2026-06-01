// @ts-nocheck — tickets.html 인라인 스크립트 이관(동작 보존). common.ts 와 동일 사유로 타입검사 비활성.
//
// 이관 규칙:
//  - common.ts / render.ts / discussion-edit.ts 가 window.* 로 노출하는 공통 전역
//    (loadConfig / checkAuth / currentUser / appConfig / escapeHtml /
//    renderWikiContent / renderUserRoleIcon / initRoleIconPopovers /
//    loadNotificationCount / createMiniEditor)은 모듈 스코프에서 bare 식별자로
//    해석되지 않으므로 모두 window.* 로 접근한다.
//  - CDN 전역(Swal)은 그대로 둔다.
//  - HTML 의 onclick 속성에서 호출되는 함수(showNewTicketForm / filterTickets /
//    applyTypeFilter / loadMoreTickets / submitNewTicket / changeTicketStatus /
//    deleteTicket / deleteComment / startReply / submitComment / cancelReply)는
//    파일 끝에서 window.* 로 노출한다.

    // ── 전역 상태 ──
    let currentTicketId = null;
    let currentStatusFilter = '';
    let currentTypeFilter = '';
    let currentPage = 1;
    let allTickets = [];

    // 미니 에디터 핸들 (본문/댓글 두 인스턴스)
    let newTicketEditor = null;
    let commentEditor = null;

    /** 미니 에디터 모듈 로드 대기 */
    async function waitForMiniEditor() {
      for (let i = 0; i < 60 && !window.createMiniEditor; i++) {
        await new Promise(r => setTimeout(r, 50));
      }
      return window.createMiniEditor;
    }

    /** 댓글 본문(=한 row)을 컨테이너에 위키 문법으로 렌더. 트랜스클루전/익스텐션/헤딩번호 비활성.
     *  render.js / 그 CDN 의존성이 로드되지 않은 환경에서는 plain-text(+개행)로 폴백해
     *  본문이 사라지지 않도록 한다. */
    async function renderCommentBody(content, containerId) {
      if (!window.renderWikiContent) {
        const el = document.getElementById(containerId);
        if (el) el.innerHTML = window.escapeHtml(content || '').replace(/\n/g, '<br>');
        return;
      }
      await window.renderWikiContent(content || '', null, containerId, {
        skipTransclusion: true,
        skipExtensions: true,
        skipHeadingNumbers: true,
      });
    }

    const typeLabels = {
      general: '일반',
      document: '문서',
      discussion: '토론',
      account: '계정'
    };

    const typeBadgeClasses = {
      general: 'bg-primary',
      document: 'bg-info',
      discussion: 'bg-warning text-dark',
      account: 'bg-dark'
    };

    // ── URL 파싱 ──
    function parseUrl() {
      const path = window.location.pathname;
      // /tickets/:id
      let m = path.match(/^\/tickets\/([0-9]+)$/);
      if (m) return { ticketId: Number(m[1]) };
      // /tickets
      if (path === '/tickets') return { ticketId: null };
      return null;
    }

    // ── 초기화 ──
    document.addEventListener('DOMContentLoaded', async () => {
      await window.loadConfig();
      await window.checkAuth();

      if (!window.currentUser) {
        document.getElementById('loading').classList.add('d-none');
        Swal.fire('로그인 필요', '티켓 문의를 이용하려면 로그인해주세요.', 'info').then(() => {
          window.location.href = '/';
        });
        return;
      }

      const parsed = parseUrl();
      if (!parsed) {
        document.getElementById('loading').classList.add('d-none');
        Swal.fire('오류', '잘못된 URL입니다.', 'error');
        return;
      }

      if (parsed.ticketId) {
        showTicketDetail(parsed.ticketId);
      } else {
        showTicketList();
      }
    });

    // ── 유틸리티 ──
    function getRelativeTime(unixTs) {
      const now = Math.floor(Date.now() / 1000);
      const diff = now - unixTs;
      if (diff < 60) return '방금 전';
      if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
      if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
      if (diff < 604800) return `${Math.floor(diff / 86400)}일 전`;
      return new Date(unixTs * 1000).toLocaleDateString('ko-KR');
    }

    function hideAllPages() {
      document.getElementById('loading').classList.add('d-none');
      document.getElementById('ticketListPage').classList.add('d-none');
      document.getElementById('ticketDetailPage').classList.add('d-none');
    }

    function isAdmin() {
      return window.currentUser && ['admin', 'super_admin'].includes(window.currentUser.role);
    }

    function isManagerOrAbove() {
      return window.currentUser && ['discussion_manager', 'admin', 'super_admin'].includes(window.currentUser.role);
    }

    // ══════════════════════════════════════════
    // ── 티켓 목록 ──
    // ══════════════════════════════════════════
    async function showTicketList() {
      currentPage = 1;
      allTickets = [];

      // 새 문의 버튼 표시
      if (window.currentUser && window.currentUser.role !== 'banned') {
        document.getElementById('newTicketBtn').classList.remove('d-none');
      }

      // 관리자에게만 유형 필터 표시
      if (isManagerOrAbove()) {
        document.getElementById('typeFilter').classList.remove('d-none');
      }

      await loadTickets(false);

      hideAllPages();
      document.getElementById('newTicketForm').classList.add('d-none');
      document.getElementById('ticketListPage').classList.remove('d-none');
      document.title = `티켓 문의 - ${window.appConfig.wikiName}`;
    }

    async function loadTickets(append) {
      try {
        let url = `/api/tickets?page=${currentPage}`;
        if (currentStatusFilter) url += `&status=${currentStatusFilter}`;
        if (currentTypeFilter) url += `&type=${currentTypeFilter}`;

        const res = await fetch(url);
        if (!res.ok) throw new Error('티켓 목록 로딩 실패');
        const data = await res.json();

        if (append) {
          allTickets = allTickets.concat(data.tickets);
        } else {
          allTickets = data.tickets;
        }

        renderTicketList();

        // 페이지네이션
        const paginationEl = document.getElementById('ticketPagination');
        if (data.hasMore) {
          paginationEl.classList.remove('d-none');
        } else {
          paginationEl.classList.add('d-none');
        }

      } catch (err) {
        console.error(err);
        Swal.fire('오류', err.message, 'error');
      }
    }

    function renderTicketList() {
      const listEl = document.getElementById('ticketsList');
      if (!allTickets || allTickets.length === 0) {
        listEl.innerHTML = window.uiEmptyState({ icon: 'bi bi-ticket-perforated', title: '티켓이 없습니다' });
        return;
      }

      listEl.innerHTML = allTickets.map(t => {
        const statusBadge = t.status === 'open'
          ? '<span class="badge bg-success">열림</span>'
          : '<span class="badge bg-secondary">닫힘</span>';
        const typeBadge = `<span class="badge ${typeBadgeClasses[t.type] || 'bg-primary'}">${typeLabels[t.type] || t.type}</span>`;
        const date = getRelativeTime(t.created_at);
        const deletedBadge = t.deleted_at ? '<span class="badge bg-danger">삭제됨</span>' : '';

        return `
          <a href="/tickets/${t.id}" class="discussion-item">
            <div class="d-flex justify-content-between align-items-start">
              <div class="discussion-item-main">
                <div class="discussion-item-title">
                  ${statusBadge} ${typeBadge} ${deletedBadge}
                  <span class="text-muted small">#${t.id}</span>
                  <span>${window.escapeHtml(t.title)}</span>
                </div>
                <div class="discussion-item-meta">
                  <span><i class="bi bi-person"></i> ${window.escapeHtml(t.user_name || '알 수 없음')}${window.renderUserRoleIcon(t.user_role)}</span>
                  <span><i class="bi bi-clock"></i> ${date}</span>
                  <span><i class="bi bi-chat"></i> ${t.comment_count || 0}개 댓글</span>
                </div>
              </div>
            </div>
          </a>
        `;
      }).join('');
      window.initRoleIconPopovers(listEl);
    }

    function filterTickets(btn, filterType, value) {
      if (filterType === 'status') {
        btn.closest('.btn-group').querySelectorAll('.btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentStatusFilter = value;
      }
      currentPage = 1;
      allTickets = [];
      loadTickets(false);
    }

    function applyTypeFilter() {
      currentTypeFilter = document.getElementById('typeFilter').value;
      currentPage = 1;
      allTickets = [];
      loadTickets(false);
    }

    function loadMoreTickets() {
      currentPage++;
      loadTickets(true);
    }

    // ── 새 티켓 작성 ──
    async function showNewTicketForm() {
      if (!window.currentUser) {
        Swal.fire('로그인 필요', '문의를 작성하려면 로그인해주세요.', 'info');
        return;
      }
      document.getElementById('newTicketForm').classList.remove('d-none');
      document.getElementById('newTicketTitle').value = '';
      document.getElementById('newTicketType').value = 'general';
      // fallback textarea 도 빈 상태로
      document.getElementById('newTicketContentFallback').value = '';

      // 미니 에디터 lazy-init. 로드 실패 시 fallback textarea 가 보이는 상태로 둠.
      const create = await waitForMiniEditor();
      if (create) {
        const rootEl = document.getElementById('newTicketContent');
        const fallback = document.getElementById('newTicketContentFallback');
        if (!newTicketEditor) {
          try {
            // CM6 로드를 기다리는 동안 사용자가 fallback 에 입력했을 수 있으므로
            // 그 텍스트를 에디터로 옮긴 뒤 fallback 을 숨긴다 (데이터 손실 방지).
            const carryOver = fallback.value;
            newTicketEditor = await create(rootEl, {
              initialValue: carryOver,
              placeholder: '문의 내용을 입력하세요 (위키 문법 지원)',
            });
            fallback.classList.add('d-none');
            fallback.value = '';
          } catch (e) {
            console.error('mini editor init failed', e);
            // fallback textarea 가 그대로 보임 — 입력 차단되지 않음
          }
        } else {
          newTicketEditor.setValue('');
        }
      }
      document.getElementById('newTicketTitle').focus();
    }

    /** 미니 에디터 본문, 없으면 fallback textarea 값을 반환 */
    function getNewTicketContent() {
      if (newTicketEditor) return newTicketEditor.getValue();
      return document.getElementById('newTicketContentFallback').value;
    }

    async function submitNewTicket() {
      const title = document.getElementById('newTicketTitle').value.trim();
      const content = getNewTicketContent().trim();
      const type = document.getElementById('newTicketType').value;

      if (!title) { Swal.fire('알림', '문의 제목을 입력하세요.', 'warning'); return; }
      if (!content) { Swal.fire('알림', '문의 내용을 입력하세요.', 'warning'); return; }

      try {
        const res = await fetch('/api/tickets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, content, type })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '티켓 생성 실패');

        Swal.fire('성공', '문의가 접수되었습니다.', 'success').then(() => {
          window.location.href = `/tickets/${data.id}`;
        });
      } catch (err) {
        Swal.fire('오류', err.message, 'error');
      }
    }

    // ══════════════════════════════════════════
    // ── 티켓 상세 ──
    // ══════════════════════════════════════════
    async function showTicketDetail(ticketId) {
      currentTicketId = ticketId;

      try {
        const res = await fetch(`/api/tickets/${ticketId}`);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || '티켓을 불러올 수 없습니다.');
        }
        const data = await res.json();
        const ticket = data.ticket;
        const comments = data.comments;

        // 제목
        document.getElementById('ticketTitle').innerHTML =
          `<i class="bi bi-ticket-detailed"></i> #${ticket.id} ${window.escapeHtml(ticket.title)}`;

        // 메타 정보
        const statusBadge = ticket.status === 'open'
          ? '<span class="badge bg-success">열림</span>'
          : '<span class="badge bg-secondary">닫힘</span>';
        const typeBadge = `<span class="badge ${typeBadgeClasses[ticket.type] || 'bg-primary'}">${typeLabels[ticket.type] || ticket.type}</span>`;
        const date = new Date(ticket.created_at * 1000).toLocaleString('ko-KR');
        const deletedBadge = ticket.deleted_at ? '<span class="badge bg-danger">삭제됨</span>' : '';

        document.getElementById('ticketMeta').innerHTML = `
          ${statusBadge} ${typeBadge} ${deletedBadge}
          <span class="text-muted small">작성자: ${window.escapeHtml(ticket.user_name || '알 수 없음')}${window.renderUserRoleIcon(ticket.user_role)}</span>
          <span class="text-muted small">${date}</span>
        `;
        window.initRoleIconPopovers(document.getElementById('ticketMeta'));

        // 액션 버튼들
        let actionsHtml = '';
        if (window.currentUser) {
          const isAuthor = ticket.user_id === window.currentUser.id;
          const userIsAdmin = isAdmin();
          const isSuperAdmin = window.currentUser.role === 'super_admin';

          if (isAuthor || userIsAdmin) {
            if (ticket.status === 'open') {
              actionsHtml += `<button class="btn btn-outline-danger btn-sm" onclick="changeTicketStatus(${ticketId}, 'closed')">
                <i class="bi bi-x-circle"></i> 문의 닫기</button>`;
            } else {
              actionsHtml += `<button class="btn btn-outline-success btn-sm" onclick="changeTicketStatus(${ticketId}, 'open')">
                <i class="bi bi-arrow-counterclockwise"></i> 문의 다시 열기</button>`;
            }
          }

          if (userIsAdmin && !ticket.deleted_at) {
            actionsHtml += `<button class="btn btn-outline-danger btn-sm" onclick="deleteTicket(${ticketId}, false)">
              <i class="bi bi-trash"></i> 삭제</button>`;
          }

          if (isSuperAdmin) {
            actionsHtml += `<button class="btn btn-danger btn-sm" onclick="deleteTicket(${ticketId}, true)">
              <i class="bi bi-trash-fill"></i> 완전 삭제</button>`;
          }
        }
        document.getElementById('ticketActions').innerHTML = actionsHtml;

        // 댓글 렌더링
        const commentsEl = document.getElementById('commentsList');
        commentsEl.innerHTML = comments.map(c => renderComment(c, ticket)).join('');
        window.initRoleIconPopovers(commentsEl);

        // 각 댓글 본문에 위키 문법 렌더링 (삭제된 댓글 제외)
        for (const c of comments) {
          if (!c.deleted_at) {
            renderCommentBody(c.content, `ticket-body-${c.id}`);
          }
        }

        // 댓글 폼 표시 여부
        const commentFormEl = document.getElementById('commentForm');
        if (ticket.status === 'closed' || ticket.deleted_at || !window.currentUser || window.currentUser.role === 'banned') {
          commentFormEl.classList.add('d-none');
        } else {
          commentFormEl.classList.remove('d-none');
          // 미니 에디터 lazy-init
          ensureCommentEditor();
        }
        cancelReply();

        hideAllPages();
        document.getElementById('ticketDetailPage').classList.remove('d-none');
        document.title = `#${ticket.id} ${ticket.title} - 티켓 - ${window.appConfig.wikiName}`;

        // 해당 티켓 관련 알림 일괄 삭제
        if (window.currentUser) {
          const notifLink = `/tickets/${ticketId}`;
          fetch('/api/notifications/by-link', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ link: notifLink })
          }).then(res => {
            if (res.ok) window.loadNotificationCount();
          }).catch(() => { });
        }

      } catch (err) {
        console.error(err);
        hideAllPages();
        Swal.fire('오류', err.message, 'error');
      }
    }

    function renderComment(c, ticket) {
      const isDeleted = !!c.deleted_at;
      const date = new Date(c.created_at * 1000).toLocaleString('ko-KR');

      // 역할 아이콘
      const authorRoleIcon = window.renderUserRoleIcon(c.author_role);

      let quoteHtml = '';
      if (c.parent_id && c.quoted_content) {
        quoteHtml = `
          <div class="discussion-quote">
            <div class="discussion-quote-author"><i class="bi bi-reply"></i> ${window.escapeHtml(c.quoted_author_name || '알 수 없음')}:</div>
            <div class="discussion-quote-text">${window.escapeHtml(c.quoted_content || '')}</div>
          </div>
        `;
      }

      // 본문은 위키 렌더링이 비동기이므로 빈 컨테이너만 박아두고 호출자가 별도 렌더.
      let contentHtml;
      if (isDeleted) {
        contentHtml = '<span class="text-muted fst-italic">삭제된 댓글입니다.</span>';
      } else {
        contentHtml = '';
      }

      let commentActions = '';
      if (!isDeleted && window.currentUser && window.currentUser.role !== 'banned' && ticket.status === 'open' && !ticket.deleted_at) {
        commentActions += `<button class="btn btn-sm btn-link text-muted" data-id="${c.id}" data-author="${window.escapeHtml(c.author_name || '알 수 없음')}" data-content="${window.escapeHtml((c.content || '').substring(0, 100))}" onclick="startReply(+this.dataset.id, this.dataset.author, this.dataset.content)">
          <i class="bi bi-reply"></i> 답글
        </button>`;
      }
      if (!isDeleted && window.currentUser) {
        const userIsAdmin = isAdmin();
        const isSuperAdmin = window.currentUser.role === 'super_admin';
        if (userIsAdmin) {
          commentActions += `<button class="btn btn-sm btn-link text-danger" onclick="deleteComment(${c.id}, false)">
            <i class="bi bi-trash"></i>
          </button>`;
        }
        if (isSuperAdmin) {
          commentActions += `<button class="btn btn-sm btn-link text-danger" onclick="deleteComment(${c.id}, true)">
            <i class="bi bi-trash-fill"></i>
          </button>`;
        }
      }

      return `
        <div class="discussion-comment ${isDeleted ? 'discussion-comment-deleted' : ''}" id="comment-${c.id}">
          <div class="discussion-comment-header">
            <span class="discussion-comment-author">
              ${c.author_picture ? `<img src="${c.author_picture}" class="discussion-comment-avatar" alt="" loading="lazy">` : ''}
              ${window.escapeHtml(c.author_name || '알 수 없음')}${authorRoleIcon}
            </span>
            <span class="discussion-comment-date text-muted small">${date}</span>
          </div>
          ${quoteHtml}
          <div class="discussion-comment-body wiki-content" id="ticket-body-${c.id}">${contentHtml}</div>
          <div class="discussion-comment-actions">${commentActions}</div>
        </div>
      `;
    }

    // ── 답글 ──
    function startReply(parentId, authorName, preview) {
      document.getElementById('replyParentId').value = parentId;
      const quoteEl = document.getElementById('replyQuote');
      quoteEl.innerHTML = `
        <div class="discussion-quote">
          <div class="discussion-quote-author"><i class="bi bi-reply"></i> ${window.escapeHtml(authorName)}에게 답글:</div>
          <div class="discussion-quote-text">${window.escapeHtml(preview)}${preview.length >= 100 ? '...' : ''}</div>
        </div>
      `;
      quoteEl.classList.remove('d-none');
      document.getElementById('cancelReplyBtn').classList.remove('d-none');
      if (commentEditor) {
        commentEditor.focus();
      } else {
        document.getElementById('commentContentFallback').focus();
      }
      document.getElementById('commentForm').scrollIntoView({ behavior: 'smooth' });
    }

    /** 댓글 본문: 미니 에디터가 마운트되었으면 그 값, 아니면 fallback textarea 값 */
    function getCommentContent() {
      if (commentEditor) return commentEditor.getValue();
      return document.getElementById('commentContentFallback').value;
    }
    function clearCommentContent() {
      if (commentEditor) commentEditor.setValue('');
      const fb = document.getElementById('commentContentFallback');
      if (fb) fb.value = '';
    }

    /** 댓글 폼 미니 에디터 lazy-init — 티켓 상세 진입 시 한 번.
     *  이미 초기화되어 있으면 본문만 비운다. 로드/마운트 실패 시 fallback textarea 사용. */
    async function ensureCommentEditor() {
      if (commentEditor) {
        commentEditor.setValue('');
        return;
      }
      const fb = document.getElementById('commentContentFallback');
      if (fb) fb.value = '';

      const create = await waitForMiniEditor();
      if (!create) return;
      const rootEl = document.getElementById('commentContent');
      if (!rootEl) return;
      try {
        // CM6 로드 중 사용자가 fallback 에 입력했을 수 있으므로 그 값을 에디터로 이관.
        const carryOver = fb ? fb.value : '';
        commentEditor = await create(rootEl, {
          initialValue: carryOver,
          placeholder: '댓글을 입력하세요 (위키 문법 지원)',
        });
        if (fb) { fb.classList.add('d-none'); fb.value = ''; }
      } catch (e) {
        console.error('mini editor init failed', e);
      }
    }

    function cancelReply() {
      document.getElementById('replyParentId').value = '';
      document.getElementById('replyQuote').classList.add('d-none');
      document.getElementById('cancelReplyBtn').classList.add('d-none');
    }

    async function submitComment() {
      const content = getCommentContent().trim();
      const parentId = document.getElementById('replyParentId').value;

      if (!content) { Swal.fire('알림', '댓글 내용을 입력하세요.', 'warning'); return; }

      try {
        const body = { content };
        if (parentId) body.parent_id = Number(parentId);

        const res = await fetch(`/api/tickets/${currentTicketId}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '댓글 작성 실패');

        clearCommentContent();
        cancelReply();
        showTicketDetail(currentTicketId);
      } catch (err) {
        Swal.fire('오류', err.message, 'error');
      }
    }

    // ── 티켓 상태 변경 ──
    async function changeTicketStatus(ticketId, status) {
      const label = status === 'closed' ? '닫기' : '다시 열기';
      const result = await Swal.fire({
        title: `문의 ${label}`,
        text: `정말 이 문의를 ${label}하시겠습니까?`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: label,
        cancelButtonText: '취소'
      });

      if (!result.isConfirmed) return;

      try {
        const res = await fetch(`/api/tickets/${ticketId}/status`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '상태 변경 실패');

        showTicketDetail(ticketId);
      } catch (err) {
        Swal.fire('오류', err.message, 'error');
      }
    }

    // ── 티켓 삭제 ──
    async function deleteTicket(ticketId, hard) {
      const label = hard ? '완전 삭제 (복구 불가)' : '삭제';
      const result = await Swal.fire({
        title: `문의 ${label}`,
        text: hard ? '이 문의와 모든 댓글이 영구적으로 삭제됩니다.' : '이 문의를 삭제하시겠습니까?',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        confirmButtonText: label,
        cancelButtonText: '취소'
      });

      if (!result.isConfirmed) return;

      try {
        const url = hard
          ? `/api/tickets/${ticketId}/hard`
          : `/api/tickets/${ticketId}`;
        const res = await fetch(url, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '삭제 실패');

        Swal.fire('삭제됨', '문의가 삭제되었습니다.', 'success').then(() => {
          window.location.href = '/tickets';
        });
      } catch (err) {
        Swal.fire('오류', err.message, 'error');
      }
    }

    // ── 댓글 삭제 ──
    async function deleteComment(commentId, hard) {
      const label = hard ? '완전 삭제' : '삭제';
      const result = await Swal.fire({
        title: `댓글 ${label}`,
        text: hard ? '이 댓글이 영구적으로 삭제됩니다.' : '이 댓글을 삭제하시겠습니까?',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        confirmButtonText: label,
        cancelButtonText: '취소'
      });

      if (!result.isConfirmed) return;

      try {
        const url = hard
          ? `/api/tickets/comment/${commentId}/hard`
          : `/api/tickets/comment/${commentId}`;
        const res = await fetch(url, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '삭제 실패');

        showTicketDetail(currentTicketId);
      } catch (err) {
        Swal.fire('오류', err.message, 'error');
      }
    }

// ── HTML on* 속성에서 호출되므로 window 로 노출한다. ──
window.showNewTicketForm = showNewTicketForm;
window.filterTickets = filterTickets;
window.applyTypeFilter = applyTypeFilter;
window.loadMoreTickets = loadMoreTickets;
window.submitNewTicket = submitNewTicket;
window.changeTicketStatus = changeTicketStatus;
window.deleteTicket = deleteTicket;
window.deleteComment = deleteComment;
window.startReply = startReply;
window.submitComment = submitComment;
window.cancelReply = cancelReply;
