// @ts-nocheck — discussions.html 인라인 스크립트 이관(동작 보존). common.ts 와 동일 사유로 타입검사 비활성.
//
// 이관 규칙:
//  - common.ts / render.ts / discussion-edit/editor.ts 가 window.* 로 노출하는 공통 전역
//    (loadConfig / checkAuth / currentUser / escapeHtml / renderUserRoleIcon /
//    initRoleIconPopovers / appConfig / loadNotificationCount / createMiniEditor /
//    renderWikiContent)은 모듈 스코프에서 bare 식별자로 해석되지 않으므로 모두 window.* 로 접근한다.
//  - CDN/표준 전역(Swal 등)은 그대로 둔다.
//  - 블록 안에서 직접 정의된 getRelativeTime 등은 window 동명 전역이 있어도 로컬 정의를 그대로 사용한다.
//  - HTML 의 onclick 속성(정적 HTML + innerHTML 문자열)에서 호출되는 함수
//    (showNewDiscussionForm / filterDiscussions / submitNewDiscussion / submitComment /
//    cancelReply / changeDiscussionStatus / deleteDiscussion / toggleDiscussionMute /
//    startReply / deleteComment)는 파일 끝에서 window.* 로 노출한다.

    // ── 전역 상태 ──
    let currentSlug = null;
    let currentDiscussionPageId = null;
    let currentThreadId = null;
    let currentDiscussionFilter = '';

    // 미니 에디터 핸들 (한 페이지에 본문/댓글 두 인스턴스 — 충돌 없음)
    let newDiscussionEditor = null;
    let commentEditor = null;

    /** 미니 에디터 모듈 로드 대기. discussion-edit.js 는 deferred ES 모듈이므로 평가
     *  순서 보장이 어렵다. window.createMiniEditor 폴링으로 안전하게 대기. */
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

    // ── URL 파싱 ──
    function parseUrl() {
      const path = window.location.pathname;
      if (!path.startsWith('/w/')) return null;
      let slug;
      try { slug = decodeURIComponent(path.substring(3)); } catch { slug = path.substring(3); }
      const params = new URLSearchParams(window.location.search);
      const idParam = params.get('id');

      if (idParam === null) {
        return { slug, threadId: null };
      }

      if (!/^[1-9]\d*$/.test(idParam)) {
        return null;
      }

      const threadId = Number(idParam);
      return { slug, threadId };
    }

    // ── 초기화 ──
    document.addEventListener('DOMContentLoaded', async () => {
      await window.loadConfig();
      await window.checkAuth();

      const parsed = parseUrl();
      if (!parsed) {
        document.getElementById('loading').classList.add('d-none');
        Swal.fire('오류', '잘못된 URL입니다.', 'error');
        return;
      }

      currentSlug = parsed.slug;

      if (parsed.threadId) {
        showDiscussionThread(parsed.slug, parsed.threadId);
      } else {
        showDiscussionList(parsed.slug);
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
      document.getElementById('discussionListPage').classList.add('d-none');
      document.getElementById('discussionThreadPage').classList.add('d-none');
    }

    // ══════════════════════════════════════════
    // ── 토론 목록 ──
    // ══════════════════════════════════════════
    async function showDiscussionList(slug, filter) {
      currentDiscussionFilter = filter || '';

      try {
        const pageRes = await fetch(`/api/w/${encodeURIComponent(slug)}`);
        if (!pageRes.ok) throw new Error('문서를 찾을 수 없습니다.');
        const pageData = await pageRes.json();
        currentDiscussionPageId = pageData.id;

        document.getElementById('discussionPageTitle').textContent = pageData.slug;
        document.getElementById('discussionBackLink').href = `/w/${encodeURIComponent(slug)}`;

        // 로그인 여부에 따라 새 토론 버튼 표시
        if (window.currentUser && window.currentUser.role !== 'banned') {
          document.getElementById('newDiscussionBtn').classList.remove('d-none');
        }

        // 토론 목록 가져오기
        let url = `/api/discussions/${pageData.id}`;
        if (currentDiscussionFilter) url += `?status=${currentDiscussionFilter}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('토론 목록 로딩 실패');
        const data = await res.json();

        const listEl = document.getElementById('discussionsList');
        if (!data.discussions || data.discussions.length === 0) {
          listEl.innerHTML = '<div class="text-muted text-center py-5">토론이 없습니다. 새 토론을 시작해보세요!</div>';
        } else {
          listEl.innerHTML = data.discussions.map(d => {
            const statusBadge = d.status === 'open'
              ? '<span class="badge bg-success">열림</span>'
              : '<span class="badge bg-secondary">닫힘</span>';
            const date = getRelativeTime(d.created_at);
            return `
              <div class="discussion-item d-flex flex-column py-3 px-3 px-md-4 mb-3 position-relative shadow-sm" style="border-radius: 12px; transition: transform 0.2s, box-shadow 0.2s;">
                <div class="discussion-item-main w-100">
                  <div class="discussion-item-title d-flex align-items-start gap-2 mb-2">
                    <div class="flex-shrink-0 mt-1">${statusBadge}</div>
                    <div class="fs-5 fw-bold" style="line-height: 1.4;">
                      <a href="/w/${encodeURIComponent(slug)}?mode=discussions&id=${d.id}" class="stretched-link text-decoration-none" style="color: var(--wiki-text) !important; word-break: keep-all; overflow-wrap: anywhere;">${window.escapeHtml(d.title)}</a>
                    </div>
                  </div>
                  <div class="discussion-item-meta d-flex flex-wrap gap-3 text-muted mt-2" style="font-size: 0.85rem;">
                    <span class="d-flex align-items-center gap-1"><i class="bi bi-person"></i> ${d.author_id ? `<a href="/profile/${d.author_id}" class="discussion-author-link text-decoration-none fw-semibold position-relative" style="z-index: 2;" onclick="event.stopPropagation()">${window.escapeHtml(d.author_name || '알 수 없음')}${window.renderUserRoleIcon(d.author_role)}</a>` : `<span class="fw-semibold">${window.escapeHtml(d.author_name || '알 수 없음')}${window.renderUserRoleIcon(d.author_role)}</span>`}</span>
                    <span class="d-flex align-items-center gap-1"><i class="bi bi-clock"></i> ${date}</span>
                    <span class="d-flex align-items-center gap-1"><i class="bi bi-chat-dots"></i> ${d.comment_count || 0}</span>
                  </div>
                </div>
              </div>
            `;
          }).join('');
        }

        hideAllPages();
        document.getElementById('newDiscussionForm').classList.add('d-none');
        document.getElementById('discussionListPage').classList.remove('d-none');
        document.title = `토론 - ${pageData.slug} - ${window.appConfig.wikiName}`;
        window.initRoleIconPopovers(document.getElementById('discussionsList'));

      } catch (err) {
        console.error(err);
        hideAllPages();
        Swal.fire('오류', err.message, 'error');
      }
    }

    function filterDiscussions(btn, status) {
      btn.closest('.btn-group').querySelectorAll('.btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      showDiscussionList(currentSlug, status);
    }

    async function showNewDiscussionForm() {
      if (!window.currentUser) {
        Swal.fire('로그인 필요', '토론을 시작하려면 로그인해주세요.', 'info');
        return;
      }
      document.getElementById('newDiscussionForm').classList.remove('d-none');
      document.getElementById('newDiscussionTitle').value = '';
      // fallback textarea 도 비워둔다 (이전 시도 잔존 방지)
      const fallback = document.getElementById('newDiscussionContentFallback');
      fallback.value = '';

      // 미니 에디터를 lazy-init. 로드 실패 시 fallback textarea 가 보이는 상태로 둠.
      const create = await waitForMiniEditor();
      if (create) {
        const rootEl = document.getElementById('newDiscussionContent');
        if (!newDiscussionEditor) {
          try {
            // CM6 로드를 기다리는 동안 사용자가 fallback 에 입력했을 수 있으므로
            // 그 텍스트를 에디터로 옮긴 뒤 fallback 을 숨긴다 (데이터 손실 방지).
            const carryOver = fallback.value;
            newDiscussionEditor = await create(rootEl, {
              initialValue: carryOver,
              placeholder: '토론 내용을 입력하세요 (위키 문법 지원)',
            });
            fallback.classList.add('d-none');
            fallback.value = '';
          } catch (e) {
            console.error('mini editor init failed', e);
            // fallback textarea 가 그대로 보임 — 입력 차단되지 않음
          }
        } else {
          newDiscussionEditor.setValue('');
        }
      }
      document.getElementById('newDiscussionTitle').focus();
    }

    /** 미니 에디터 본문, 없으면 fallback textarea 값을 반환 */
    function getNewDiscussionContent() {
      if (newDiscussionEditor) return newDiscussionEditor.getValue();
      return document.getElementById('newDiscussionContentFallback').value;
    }

    async function submitNewDiscussion() {
      const title = document.getElementById('newDiscussionTitle').value.trim();
      const content = getNewDiscussionContent().trim();

      if (!title) { Swal.fire('알림', '토론 제목을 입력하세요.', 'warning'); return; }
      if (!content) { Swal.fire('알림', '토론 내용을 입력하세요.', 'warning'); return; }

      try {
        const res = await fetch(`/api/discussions/${currentDiscussionPageId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, content })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '토론 생성 실패');

        Swal.fire('성공', '새 토론이 생성되었습니다.', 'success').then(() => {
          window.location.href = `/w/${encodeURIComponent(currentSlug)}?mode=discussions&id=${data.id}`;
        });
      } catch (err) {
        Swal.fire('오류', err.message, 'error');
      }
    }

    // ══════════════════════════════════════════
    // ── 토론 스레드 상세 ──
    // ══════════════════════════════════════════
    async function showDiscussionThread(slug, threadId) {
      currentThreadId = threadId;

      try {
        const res = await fetch(`/api/discussions/thread/${threadId}`);
        if (!res.ok) throw new Error('토론을 불러올 수 없습니다.');
        const data = await res.json();
        const discussion = data.discussion;
        const comments = data.comments;

        // 제목
        document.getElementById('threadTitle').innerHTML =
          `<i class="bi bi-chat-dots"></i> ${window.escapeHtml(discussion.title)}`;

        // 뒤로가기
        document.getElementById('threadBackLink').href = `/w/${encodeURIComponent(slug)}?mode=discussions`;

        // 메타 정보
        const statusBadge = discussion.status === 'open'
          ? '<span class="badge bg-success px-2 py-1 fs-6">열림</span>'
          : '<span class="badge bg-secondary px-2 py-1 fs-6">닫힘</span>';
        const date = new Date(discussion.created_at * 1000).toLocaleString('ko-KR');
        document.getElementById('threadMeta').innerHTML = `
          <div class="d-flex align-items-center gap-2">${statusBadge}</div>
          <div class="d-flex flex-wrap align-items-center gap-3 ms-md-4 w-100">
            <span class="text-muted d-flex align-items-center gap-2"><i class="bi bi-person-fill fs-5"></i> 작성자: ${discussion.author_id ? `<a href="/profile/${discussion.author_id}" class="discussion-author-link text-decoration-none fw-semibold">${window.escapeHtml(discussion.author_name || '알 수 없음')}${window.renderUserRoleIcon(discussion.author_role)}</a>` : `<span class="fw-semibold">${window.escapeHtml(discussion.author_name || '알 수 없음')}${window.renderUserRoleIcon(discussion.author_role)}</span>`}</span>
            <span class="text-muted ms-auto d-flex align-items-center gap-2 small"><i class="bi bi-clock-history"></i> ${date}</span>
          </div>
        `;
        window.initRoleIconPopovers(document.getElementById('threadMeta'));

        // 액션 버튼들
        let actionsHtml = '';
        if (window.currentUser) {
          const userRole = window.currentUser.role;
          const isAuthor = discussion.author_id === window.currentUser.id;
          const isDiscManager = ['discussion_manager', 'admin', 'super_admin'].includes(userRole);
          const isAdmin = ['admin', 'super_admin'].includes(userRole);
          const isSuperAdmin = userRole === 'super_admin';

          if (isAuthor || isDiscManager) {
            if (discussion.status === 'open') {
              actionsHtml += `<button class="btn btn-outline-danger btn-sm" onclick="changeDiscussionStatus(${threadId}, 'closed')">
                <i class="bi bi-x-circle"></i> 토론 닫기</button>`;
            } else {
              actionsHtml += `<button class="btn btn-outline-success btn-sm" onclick="changeDiscussionStatus(${threadId}, 'open')">
                <i class="bi bi-arrow-counterclockwise"></i> 토론 다시 열기</button>`;
            }
          }

          if (isAdmin && !discussion.deleted_at) {
            actionsHtml += `<button class="btn btn-outline-danger btn-sm" onclick="deleteDiscussion(${threadId}, false)">
              <i class="bi bi-trash"></i> 삭제</button>`;
          }

          if (isSuperAdmin) {
            actionsHtml += `<button class="btn btn-danger btn-sm" onclick="deleteDiscussion(${threadId}, true)">
              <i class="bi bi-trash-fill"></i> 완전 삭제</button>`;
          }
        }
        // 알림 뮤트 토글 버튼 (로그인 유저만)
        if (window.currentUser && window.currentUser.role !== 'banned') {
          actionsHtml += `<button class="btn btn-outline-secondary btn-sm" id="muteToggleBtn" onclick="toggleDiscussionMute(${threadId})">
            <i class="bi bi-bell"></i> <span id="muteToggleLabel">알림 켜짐</span>
          </button>`;
        }

        document.getElementById('threadActions').innerHTML = actionsHtml;

        // 뮤트 상태 로드
        if (window.currentUser && window.currentUser.role !== 'banned') {
          loadMuteStatus(threadId);
        }

        // 댓글 렌더링
        const commentsEl = document.getElementById('commentsList');
        commentsEl.innerHTML = comments.map(c => renderComment(c, discussion)).join('');
        window.initRoleIconPopovers(commentsEl);

        // 각 댓글 본문에 위키 문법 렌더링 (삭제된 댓글 제외)
        for (const c of comments) {
          if (!c.deleted_at) {
            // 병렬로 시작하되 await 하지 않음 — 화면 그리기 우선
            renderCommentBody(c.content, `discussion-body-${c.id}`);
          }
        }

        // 댓글 폼 표시 여부
        const commentFormEl = document.getElementById('commentForm');
        if (discussion.status === 'closed' || !window.currentUser || window.currentUser.role === 'banned') {
          commentFormEl.classList.add('d-none');
        } else {
          commentFormEl.classList.remove('d-none');
          // 미니 에디터 lazy-init (await 하지 않음 — 비동기 로드 동안 다른 UI 가 막히지 않게)
          ensureCommentEditor();
        }
        cancelReply();

        hideAllPages();
        document.getElementById('discussionThreadPage').classList.remove('d-none');
        document.title = `${discussion.title} - 토론 - ${window.appConfig.wikiName}`;

        // 해당 토론 관련 알림 일괄 삭제 (로그인 유저만, 백그라운드 처리)
        if (window.currentUser) {
          const newFormatLink = `/w/${encodeURIComponent(slug)}?mode=discussions&id=${threadId}`;
          const legacyFormatLink = `/w/${encodeURIComponent(slug)}/discussions/${threadId}`;
          for (const notifLink of [newFormatLink, legacyFormatLink]) {
            fetch('/api/notifications/by-link', {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ link: notifLink })
            }).then(res => {
              if (res.ok) window.loadNotificationCount();
            }).catch(() => { /* 무시 */ });
          }
        }

      } catch (err) {
        console.error(err);
        hideAllPages();
        Swal.fire('오류', err.message, 'error');
      }
    }

    function renderComment(c, discussion) {
      const isDeleted = !!c.deleted_at;
      const date = new Date(c.created_at * 1000).toLocaleString('ko-KR');

      let quoteHtml = '';
      if (c.parent_id && c.quoted_content) {
        quoteHtml = `
          <div class="discussion-quote px-3 py-2 mb-3 bg-secondary bg-opacity-10 border-start border-primary border-4 rounded-end w-100">
            <div class="discussion-quote-author fw-bold mb-1" style="font-size: 0.85rem;"><i class="bi bi-reply-fill text-primary"></i> ${window.escapeHtml(c.quoted_author_name || '알 수 없음')}님에게 답글:</div>
            <div class="discussion-quote-text text-muted" style="font-size: 0.9rem; line-height: 1.4;">${window.escapeHtml(c.quoted_content || '')}</div>
          </div>
        `;
      }

      // 본문은 위키 렌더링이 비동기이므로 빈 컨테이너만 박아두고 호출자가 별도 렌더.
      // 삭제된 댓글만 즉시 표시.
      let contentHtml;
      if (isDeleted) {
        contentHtml = '<span class="text-muted fst-italic">삭제된 댓글입니다.</span>';
      } else {
        contentHtml = '';
      }

      let commentActions = '';
      if (!isDeleted && window.currentUser && window.currentUser.role !== 'banned' && discussion.status === 'open') {
        commentActions += `<button class="btn btn-sm btn-link text-muted" data-id="${c.id}" data-author="${window.escapeHtml(c.author_name || '알 수 없음')}" data-content="${window.escapeHtml((c.content || '').substring(0, 100))}" onclick="startReply(+this.dataset.id, this.dataset.author, this.dataset.content)">
          <i class="bi bi-reply"></i> 답글
        </button>`;
      }
      if (!isDeleted && window.currentUser) {
        const isAdmin = ['admin', 'super_admin'].includes(window.currentUser.role);
        const isSuperAdmin = window.currentUser.role === 'super_admin';
        if (isAdmin) {
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
        <div class="discussion-comment ${isDeleted ? 'discussion-comment-deleted' : ''} p-3 p-md-4 mb-4 shadow-sm w-100" style="border-radius: 12px; background: var(--wiki-card-bg); border: 1px solid var(--wiki-border);" id="comment-${c.id}">
          <div class="discussion-comment-header d-flex flex-column flex-sm-row justify-content-between align-items-start align-items-sm-center mb-3 pb-2 border-bottom border-secondary border-opacity-25 w-100">
            <span class="discussion-comment-author d-flex align-items-center gap-2 fw-bold w-100 w-sm-auto mb-2 mb-sm-0" style="font-size: 1.05rem;">
              ${c.author_id ? `<a href="/profile/${c.author_id}" class="discussion-author-link text-decoration-none d-flex align-items-center gap-2">${c.author_picture ? `<img src="${c.author_picture}" class="discussion-comment-avatar rounded-circle border object-fit-cover" style="width: 32px; height: 32px;" alt="" loading="lazy">` : '<i class="bi bi-person-circle fs-3 text-secondary"></i>'}${window.escapeHtml(c.author_name || '알 수 없음')}${window.renderUserRoleIcon(c.author_role)}</a>` : `<span class="d-flex align-items-center gap-2">${c.author_picture ? `<img src="${c.author_picture}" class="discussion-comment-avatar rounded-circle border object-fit-cover" style="width: 32px; height: 32px;" alt="" loading="lazy">` : '<i class="bi bi-person-circle fs-3 text-secondary"></i>'}${window.escapeHtml(c.author_name || '알 수 없음')}${window.renderUserRoleIcon(c.author_role)}</span>`}
            </span>
            <span class="discussion-comment-date text-muted mt-1 mt-sm-0 ms-sm-auto" style="font-size: 0.85rem;"><i class="bi bi-clock-history"></i> ${date}</span>
          </div>
          ${quoteHtml}
          <div class="discussion-comment-body wiki-content mb-3 fs-6 w-100" id="discussion-body-${c.id}" style="line-height: 1.7; color: var(--wiki-text); word-break: keep-all; overflow-wrap: anywhere;">${contentHtml}</div>
          <div class="discussion-comment-actions d-flex flex-wrap align-items-center justify-content-end gap-2 pt-2 border-top border-secondary border-opacity-10">${commentActions}</div>
        </div>
      `;
    }

    // ── 답글 ──
    function startReply(parentId, authorName, preview) {
      document.getElementById('replyParentId').value = parentId;
      const quoteEl = document.getElementById('replyQuote');
      quoteEl.innerHTML = `
        <div class="discussion-quote px-3 py-2 mb-3 bg-secondary bg-opacity-10 border-start border-primary border-4 rounded-end w-100">
          <div class="discussion-quote-author fw-bold mb-1" style="font-size: 0.85rem;"><i class="bi bi-reply-fill text-primary"></i> ${window.escapeHtml(authorName)}님에게 답글:</div>
          <div class="discussion-quote-text text-muted" style="font-size: 0.9rem; line-height: 1.4;">${window.escapeHtml(preview)}${preview.length >= 100 ? '...' : ''}</div>
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

    function cancelReply() {
      document.getElementById('replyParentId').value = '';
      document.getElementById('replyQuote').classList.add('d-none');
      document.getElementById('cancelReplyBtn').classList.add('d-none');
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

    async function submitComment() {
      const content = getCommentContent().trim();
      const parentId = document.getElementById('replyParentId').value;

      if (!content) { Swal.fire('알림', '댓글 내용을 입력하세요.', 'warning'); return; }

      try {
        const body = { content };
        if (parentId) body.parent_id = Number(parentId);

        const res = await fetch(`/api/discussions/thread/${currentThreadId}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '댓글 작성 실패');

        clearCommentContent();
        cancelReply();
        // 스레드 새로고침
        showDiscussionThread(currentSlug, currentThreadId);
      } catch (err) {
        Swal.fire('오류', err.message, 'error');
      }
    }

    /** 댓글 폼 미니 에디터 lazy-init — 토론 스레드 진입 시 한 번.
     *  이미 초기화되어 있으면 본문만 비운다. 로드/마운트 실패 시 fallback textarea 사용. */
    async function ensureCommentEditor() {
      if (commentEditor) {
        commentEditor.setValue('');
        return;
      }
      // fallback textarea 도 빈 상태로
      const fb = document.getElementById('commentContentFallback');
      if (fb) fb.value = '';

      const create = await waitForMiniEditor();
      if (!create) return; // fallback textarea 가 그대로 보임
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

    // ── 토론 상태 변경 ──
    async function changeDiscussionStatus(threadId, status) {
      const label = status === 'closed' ? '닫기' : '다시 열기';
      const result = await Swal.fire({
        title: `토론 ${label}`,
        text: `정말 이 토론을 ${label}하시겠습니까?`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: label,
        cancelButtonText: '취소'
      });

      if (!result.isConfirmed) return;

      try {
        const res = await fetch(`/api/discussions/thread/${threadId}/status`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '상태 변경 실패');

        showDiscussionThread(currentSlug, threadId);
      } catch (err) {
        Swal.fire('오류', err.message, 'error');
      }
    }

    // ── 토론 삭제 ──
    async function deleteDiscussion(threadId, hard) {
      const label = hard ? '완전 삭제 (복구 불가)' : '삭제';
      const result = await Swal.fire({
        title: `토론 ${label}`,
        text: hard ? '이 토론과 모든 댓글이 영구적으로 삭제됩니다.' : '이 토론을 삭제하시겠습니까?',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        confirmButtonText: label,
        cancelButtonText: '취소'
      });

      if (!result.isConfirmed) return;

      try {
        const url = hard
          ? `/api/discussions/thread/${threadId}/hard`
          : `/api/discussions/thread/${threadId}`;
        const res = await fetch(url, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '삭제 실패');

        Swal.fire('삭제됨', '토론이 삭제되었습니다.', 'success').then(() => {
          window.location.href = `/w/${encodeURIComponent(currentSlug)}?mode=discussions`;
        });
      } catch (err) {
        Swal.fire('오류', err.message, 'error');
      }
    }

    // ── 토론 알림 뮤트 ──
    async function loadMuteStatus(threadId) {
      try {
        const res = await fetch(`/api/discussions/thread/${threadId}/mute`);
        if (!res.ok) return;
        const data = await res.json();
        updateMuteButton(data.muted);
      } catch (e) { /* 무시 */ }
    }

    function updateMuteButton(muted) {
      const btn = document.getElementById('muteToggleBtn');
      const label = document.getElementById('muteToggleLabel');
      if (!btn || !label) return;
      if (muted) {
        btn.classList.remove('btn-outline-secondary');
        btn.classList.add('btn-outline-warning');
        btn.querySelector('i').className = 'bi bi-bell-slash';
        label.textContent = '알림 꺼짐';
      } else {
        btn.classList.remove('btn-outline-warning');
        btn.classList.add('btn-outline-secondary');
        btn.querySelector('i').className = 'bi bi-bell';
        label.textContent = '알림 켜짐';
      }
    }

    async function toggleDiscussionMute(threadId) {
      try {
        const res = await fetch(`/api/discussions/thread/${threadId}/mute`, { method: 'POST' });
        if (!res.ok) throw new Error();
        const data = await res.json();
        updateMuteButton(data.muted);
      } catch (e) {
        Swal.fire('오류', '알림 설정 변경에 실패했습니다.', 'error');
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
          ? `/api/discussions/comment/${commentId}/hard`
          : `/api/discussions/comment/${commentId}`;
        const res = await fetch(url, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '삭제 실패');

        showDiscussionThread(currentSlug, currentThreadId);
      } catch (err) {
        Swal.fire('오류', err.message, 'error');
      }
    }

    // ── HTML on* 속성(정적 HTML + innerHTML 문자열)에서 호출되므로 window 로 노출한다. ──
    window.showNewDiscussionForm = showNewDiscussionForm;
    window.filterDiscussions = filterDiscussions;
    window.submitNewDiscussion = submitNewDiscussion;
    window.submitComment = submitComment;
    window.cancelReply = cancelReply;
    window.changeDiscussionStatus = changeDiscussionStatus;
    window.deleteDiscussion = deleteDiscussion;
    window.toggleDiscussionMute = toggleDiscussionMute;
    window.startReply = startReply;
    window.deleteComment = deleteComment;
