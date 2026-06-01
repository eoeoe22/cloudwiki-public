// @ts-nocheck — blog.html 인라인 스크립트 이관(동작 보존). common.ts 와 동일 사유로 타입검사 비활성.
//
// 이관 규칙:
//  - common.ts / render.ts 가 window.* 로 노출하는 공통 전역(loadConfig / currentUser /
//    loadTrending / loadRecentChanges / renderWikiContent / appConfig 등)은 모듈 스코프에서
//    bare 식별자로 해석되지 않으므로 모두 window.* 로 접근한다. (특히 `typeof loadTrending`
//    같은 가드도 `typeof window.loadTrending` 로 바꾼다.)
//  - CDN 전역(Swal)은 그대로 둔다.
//  - HTML 의 onclick 속성에서 호출되는 함수(announceBlogPost / unannounceBlogPost /
//    deleteBlogPost / shareNative / shareCopyLink / shareCopyText / shareCopyMarkdown /
//    sharePrint / shareAskClaude / shareAskChatGPT)는 파일 끝에서 window.* 로 노출한다.

const BLOG_LIST_LIMIT = 20;
let blogCurrentOffset = 0;
let blogTotalCount = 0;
let currentBlogPostId = null;
let currentBlogPost = null;

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(unixTs) {
  const d = new Date(unixTs * 1000);
  return d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
}

function showView(id) {
  ['blogLoading', 'blogList', 'blogPost', 'blogError'].forEach(v => {
    document.getElementById(v).classList.add('d-none');
  });
  document.getElementById(id).classList.remove('d-none');
}

// ── 블로그 목록 로드 ──
async function loadBlogList(offset) {
  blogCurrentOffset = offset || 0;
  // 목록 로드는 전용 로딩 뷰 대신 카드 스켈레톤을 목록 자리에 표시해 레이아웃 점프를 줄인다.
  document.getElementById('blogPostsList').innerHTML = window.uiSkeletonCards(4);
  document.getElementById('blogPagination').innerHTML = '';
  showView('blogList');
  try {
    const res = await fetch(`/api/blog?limit=${BLOG_LIST_LIMIT}&offset=${blogCurrentOffset}`);
    if (!res.ok) throw new Error('목록 로드 실패');
    const data = await res.json();
    blogTotalCount = data.total || 0;

    const listEl = document.getElementById('blogPostsList');
    if (!data.posts || data.posts.length === 0) {
      listEl.innerHTML = window.uiEmptyState({ icon: 'bi bi-journal-text', title: '포스트가 없습니다', text: '아직 발행된 블로그 글이 없습니다.' });
    } else {
      listEl.innerHTML = data.posts.map(post => `
        <div class="border-bottom pb-3 mb-3 d-flex gap-3 align-items-start ${post.deleted_at ? 'opacity-50' : ''}">
          <div class="flex-grow-1 min-w-0">
            <a href="/blog/${escHtml(post.id)}" class="text-decoration-none">
              <h5 class="mb-1">${escHtml(post.title)}${post.deleted_at ? ' <span class="badge bg-danger small">삭제됨</span>' : ''}</h5>
            </a>
            <small class="text-muted">${formatDate(post.created_at)}</small>
          </div>
          ${post.thumbnail ? `<a href="/blog/${escHtml(post.id)}" class="flex-shrink-0">
            <img src="${escHtml(post.thumbnail)}" alt="" loading="lazy"
              style="width:120px;height:80px;object-fit:cover;border-radius:6px;display:block;">
          </a>` : ''}
        </div>
      `).join('');
    }

    // 페이지네이션
    const pagEl = document.getElementById('blogPagination');
    pagEl.innerHTML = '';
    if (blogCurrentOffset > 0) {
      const prevBtn = document.createElement('button');
      prevBtn.className = 'btn btn-secondary btn-sm';
      prevBtn.innerHTML = '<i class="bi bi-chevron-left"></i> 이전';
      prevBtn.onclick = () => loadBlogList(blogCurrentOffset - BLOG_LIST_LIMIT);
      pagEl.appendChild(prevBtn);
    }
    if (blogCurrentOffset + BLOG_LIST_LIMIT < blogTotalCount) {
      const nextBtn = document.createElement('button');
      nextBtn.className = 'btn btn-secondary btn-sm';
      nextBtn.innerHTML = '다음 <i class="bi bi-chevron-right"></i>';
      nextBtn.onclick = () => loadBlogList(blogCurrentOffset + BLOG_LIST_LIMIT);
      pagEl.appendChild(nextBtn);
    }

    showView('blogList');
    document.title = '블로그 - ' + (window.appConfig?.wikiName || 'CloudWiki');
  } catch (e) {
    Swal.fire('오류', e.message, 'error');
    showView('blogList');
  }
}

// ── 블로그 포스트 열람 ──
async function loadBlogPost(id) {
  showView('blogLoading');
  currentBlogPostId = id;
  try {
    const res = await fetch(`/api/blog/${id}`);
    if (!res.ok) { showView('blogError'); return; }
    const post = await res.json();
    currentBlogPost = post;

    document.getElementById('blogPostTitle').textContent = post.title;
    document.getElementById('blogPostDate').textContent = formatDate(post.created_at);
    document.getElementById('blogPostEditBtn').href = `/blog-edit?id=${post.id}`;
    document.title = escHtml(post.title) + ' - ' + (window.appConfig?.wikiName || 'CloudWiki');

    // 현재 공지 발행 여부 동기화
    syncAnnounceButtons(post.id);

    // 위키 문법 렌더링
    await window.renderWikiContent(post.content || '', post.title, 'blogPostContent', { palettes: post.used_palettes || null });

    showView('blogPost');
  } catch (e) {
    showView('blogError');
  }
}

// ── 공지 발행/취소 ──
function syncAnnounceButtons(postId) {
  const list = Array.isArray(window.appConfig?.announcements) ? window.appConfig.announcements : [];
  const isCurrent = list.some(a => Number(a.postId) === Number(postId));
  const a = document.getElementById('blogPostAnnounceBtn');
  const u = document.getElementById('blogPostUnannounceBtn');
  if (!a || !u) return;
  a.classList.toggle('d-none', isCurrent);
  u.classList.toggle('d-none', !isCurrent);
}

// 공지 발행 다이얼로그 — 제목 + 아이콘 선택 지원
let announceIconClass = null;

async function announceBlogPost() {
  if (!currentBlogPostId) return;
  const defaultTitle = document.getElementById('blogPostTitle')?.textContent?.trim() || '';
  announceIconClass = null;

  const renderIconLabel = (cls) => {
    if (!cls) return '<i class="mdi mdi-bullhorn"></i> 기본';
    return `<i class="${cls}"></i> ${cls.replace(/^(mdi mdi-|bi bi-)/, '')}`;
  };

  const result = await Swal.fire({
    title: '공지로 발행',
    html: `
      <div class="text-start">
        <label class="form-label small mb-1">배너 제목</label>
        <input id="announceTitleInput" type="text" class="form-control mb-3" maxlength="200" value="${escHtml(defaultTitle)}">
        <label class="form-label small mb-1">아이콘</label>
        <div class="d-flex gap-2 align-items-center">
          <button type="button" id="announceIconBtn" class="btn btn-outline-secondary btn-sm flex-grow-1">
            <span id="announceIconLabel">${renderIconLabel(null)}</span>
          </button>
          <button type="button" id="announceIconClearBtn" class="btn btn-outline-secondary btn-sm" title="기본 아이콘으로 초기화">
            <i class="bi bi-x"></i>
          </button>
        </div>
      </div>
    `,
    showCancelButton: true,
    confirmButtonText: '발행',
    cancelButtonText: '취소',
    didOpen: () => {
      const iconBtn = document.getElementById('announceIconBtn');
      const iconLabel = document.getElementById('announceIconLabel');
      const iconClearBtn = document.getElementById('announceIconClearBtn');
      if (iconBtn) iconBtn.addEventListener('click', async () => {
        if (typeof window.pickWikiIcon !== 'function') return;
        const picked = await window.pickWikiIcon();
        announceIconClass = picked;
        if (iconLabel) iconLabel.innerHTML = renderIconLabel(picked);
      });
      if (iconClearBtn) iconClearBtn.addEventListener('click', () => {
        announceIconClass = null;
        if (iconLabel) iconLabel.innerHTML = renderIconLabel(null);
      });
    },
    preConfirm: () => {
      const titleEl = document.getElementById('announceTitleInput');
      const t = (titleEl?.value || '').trim();
      if (!t) { Swal.showValidationMessage('제목을 입력하세요.'); return false; }
      if (t.length > 200) { Swal.showValidationMessage('200자 이하로 입력하세요.'); return false; }
      return { title: t, icon: announceIconClass };
    },
  });
  if (!result.isConfirmed) return;

  const { title, icon } = result.value || {};
  try {
    const res = await fetch(`/api/blog/${currentBlogPostId}/announce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, icon: icon || null }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || '발행 실패');
    }
    Swal.fire({ icon: 'success', title: '공지로 발행됨', toast: true, position: 'top-end', timer: 1500, showConfirmButton: false });
    await window.loadConfig();
    syncAnnounceButtons(currentBlogPostId);
  } catch (e) {
    Swal.fire('오류', e.message, 'error');
  }
}

async function unannounceBlogPost() {
  try {
    const res = await fetch('/api/blog/announcement/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId: currentBlogPostId }),
    });
    if (!res.ok) throw new Error('취소 실패');
    Swal.fire({ icon: 'success', title: '공지 취소됨', toast: true, position: 'top-end', timer: 1500, showConfirmButton: false });
    await window.loadConfig();
    syncAnnounceButtons(currentBlogPostId);
  } catch (e) {
    Swal.fire('오류', e.message, 'error');
  }
}

// ── 블로그 포스트 삭제 ──
async function deleteBlogPost() {
  if (!currentBlogPostId) return;
  const result = await Swal.fire({
    title: '포스트를 삭제하시겠습니까?',
    text: '삭제된 포스트는 관리자만 볼 수 있습니다.',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: '삭제',
    cancelButtonText: '취소',
    confirmButtonColor: '#d33',
  });
  if (!result.isConfirmed) return;

  try {
    const res = await fetch(`/api/blog/${currentBlogPostId}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || '삭제 실패');
    }
    await Swal.fire({ icon: 'success', title: '삭제되었습니다.', timer: 1500, showConfirmButton: false });
    window.location.href = '/blog';
  } catch (e) {
    Swal.fire('오류', e.message, 'error');
  }
}

// ── 공유하기 기능 ──
function getShareTitle() {
  return currentBlogPost && currentBlogPost.title ? currentBlogPost.title : document.title;
}

async function shareNative() {
  const cleanUrl = window.location.origin + window.location.pathname;
  const wikiName = typeof window.appConfig !== 'undefined' && window.appConfig.wikiName ? window.appConfig.wikiName : 'CloudWiki';
  const postTitle = getShareTitle();
  try {
    await navigator.share({
      title: `${wikiName} - ${postTitle}`,
      text: `${wikiName} - ${postTitle}`,
      url: cleanUrl
    });
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('공유 실패:', err);
    }
  }
}

async function shareCopyLink() {
  const cleanUrl = window.location.origin + window.location.pathname;
  try {
    await navigator.clipboard.writeText(cleanUrl);
    Swal.fire({ icon: 'success', title: '복사 완료', text: '포스트 링크가 클립보드에 복사되었습니다.', toast: true, position: 'top-end', timer: 1500, showConfirmButton: false });
  } catch (err) {
    console.error('복사 실패:', err);
    Swal.fire('오류', '클립보드 복사에 실패했습니다.', 'error');
  }
}

async function shareCopyText() {
  const content = document.getElementById('blogPostContent');
  if (!content) return;
  try {
    const postTitle = getShareTitle();
    const textWithTitle = postTitle ? postTitle + '\n' + content.innerText : content.innerText;
    await navigator.clipboard.writeText(textWithTitle);
    Swal.fire({ icon: 'success', title: '복사 완료', text: '포스트 내용이 클립보드에 복사되었습니다.', toast: true, position: 'top-end', timer: 1500, showConfirmButton: false });
  } catch (err) {
    console.error('복사 실패:', err);
    Swal.fire('오류', '클립보드 복사에 실패했습니다.', 'error');
  }
}

async function shareCopyMarkdown() {
  if (!currentBlogPost || typeof currentBlogPost.content !== 'string') {
    Swal.fire('오류', '포스트 내용을 가져올 수 없습니다.', 'error');
    return;
  }
  try {
    let resolvedContent = currentBlogPost.content;
    if (typeof window.resolveTransclusionsForMarkdown === 'function') {
      resolvedContent = await window.resolveTransclusionsForMarkdown(
        currentBlogPost.content,
        currentBlogPost.title || ''
      );
    }
    const postTitle = getShareTitle();
    const markdownWithTitle = postTitle ? postTitle + '\n\n' + resolvedContent : resolvedContent;
    await navigator.clipboard.writeText(markdownWithTitle);
    Swal.fire({ icon: 'success', title: '복사 완료', text: '마크다운 원문이 클립보드에 복사되었습니다.', toast: true, position: 'top-end', timer: 1500, showConfirmButton: false });
  } catch (err) {
    console.error('복사 실패:', err);
    Swal.fire('오류', '클립보드 복사에 실패했습니다.', 'error');
  }
}

function sharePrint() {
  window.print();
}

function shareAskClaude() {
  const cleanUrl = window.location.origin + window.location.pathname;
  const prompt = '다음 블로그 페이지를 읽고 내용에 대한 질문에 답해줘: ' + cleanUrl;
  window.open('https://claude.ai/new?q=' + encodeURIComponent(prompt), '_blank');
}

function shareAskChatGPT() {
  const cleanUrl = window.location.origin + window.location.pathname;
  const prompt = '다음 블로그 페이지를 읽고 내용에 대한 질문에 답해줘: ' + cleanUrl;
  window.open('https://chatgpt.com/?q=' + encodeURIComponent(prompt), '_blank');
}

// ── 초기화 ──
document.addEventListener('DOMContentLoaded', async () => {
  await window.loadConfig();

  // 사이드바: 실시간 트렌딩 / 최근 변경
  if (typeof window.loadTrending === 'function') window.loadTrending();
  if (typeof window.loadRecentChanges === 'function') window.loadRecentChanges();

  // 관리자 UI 표시
  const user = window.currentUser;
  if (user && (user.role === 'admin' || user.role === 'super_admin')) {
    document.getElementById('blogAdminActions').classList.remove('d-none');
    document.getElementById('blogPostAdminActions').classList.remove('d-none');
  }

  // URL 기반 라우팅
  const match = window.location.pathname.match(/^\/blog\/(\d+)$/);
  if (match) {
    await loadBlogPost(match[1]);
  } else {
    await loadBlogList(0);
  }
});

// HTML onclick 속성에서 호출되므로 window 로 노출한다.
window.announceBlogPost = announceBlogPost;
window.unannounceBlogPost = unannounceBlogPost;
window.deleteBlogPost = deleteBlogPost;
window.shareNative = shareNative;
window.shareCopyLink = shareCopyLink;
window.shareCopyText = shareCopyText;
window.shareCopyMarkdown = shareCopyMarkdown;
window.sharePrint = sharePrint;
window.shareAskClaude = shareAskClaude;
window.shareAskChatGPT = shareAskChatGPT;
