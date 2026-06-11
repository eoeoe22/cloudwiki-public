// @ts-nocheck — 역링크 섹션(본문 하단) 공유 모듈(전역 위키·워크스페이스 공용).
// #backlinksSection / #backlinksList 마커를 채운다. 역링크 API 경로·문서 링크 경로·
// 네비게이션만 ArticleContext 로 주입받는다. 블로그/토론/티켓 역링크 타입은 전역 위키
// 응답에만 존재하므로(워크스페이스는 {slug,title} 만) 워크스페이스에서는 자연히 일반
// 문서 분기만 탄다. 동작은 과거 index.ts 의 loadBacklinks 와 동일.

import type { ArticleContext } from './context';

/**
 * 역링크를 불러와 섹션을 채운다. url 을 직접 주면(이미지 문서 등) 그 경로를, 아니면
 * ctx.backlinksUrl(slug) 를 호출한다. 역링크가 있으면 true, 없거나 실패면 false.
 */
export async function renderBacklinks(ctx: ArticleContext, opts: { slug?: string; url?: string }): Promise<boolean> {
  const section = document.getElementById('backlinksSection');
  const list = document.getElementById('backlinksList');
  if (!section || !list) return false;
  const fetchUrl = opts.url || ctx.backlinksUrl(opts.slug);

  try {
    const res = await fetch(fetchUrl);
    if (!res.ok) {
      section.classList.add('d-none');
      return false;
    }
    const data = await res.json();
    if (data.backlinks && data.backlinks.length > 0) {
      list.innerHTML = data.backlinks.map((bl) => {
        const date = bl.updated_at ? new Date(bl.updated_at * 1000).toLocaleString('ko-KR') : '';
        const deletedBadge = bl.is_deleted ? ' <span class="badge bg-secondary ms-1">삭제됨</span>' : '';
        if (bl.type === 'blog') {
          const blogTitle = bl.title || `#${bl.id}`;
          return `
            <a href="/blog/${encodeURIComponent(bl.id)}" class="list-group-item list-group-item-action d-flex justify-content-between align-items-center">
                <div>
                    <span class="badge bg-info me-2">블로그</span>
                    <span class="fw-bold">${window.escapeHtml(blogTitle)}</span>${deletedBadge}
                </div>
                <small class="text-muted">${date}</small>
            </a>`;
        }
        if (bl.type === 'discussion_comment') {
          const dTitle = bl.discussion_title || `#${bl.discussion_id}`;
          const href = `/w/${encodeURIComponent(bl.page_slug)}?mode=discussions&id=${encodeURIComponent(bl.discussion_id)}`;
          return `
            <a href="${href}" class="list-group-item list-group-item-action d-flex justify-content-between align-items-center">
                <div>
                    <span class="badge bg-warning text-dark me-2">토론</span>
                    <span class="fw-bold">${window.escapeHtml(dTitle)}</span>
                    <small class="text-muted ms-2">${window.escapeHtml(bl.page_slug)}</small>${deletedBadge}
                </div>
                <small class="text-muted">${date}</small>
            </a>`;
        }
        if (bl.type === 'ticket_comment') {
          const tTitle = bl.ticket_title || `#${bl.ticket_id}`;
          return `
            <a href="/tickets/${encodeURIComponent(bl.ticket_id)}" class="list-group-item list-group-item-action d-flex justify-content-between align-items-center">
                <div>
                    <span class="badge bg-success me-2">티켓</span>
                    <span class="fw-bold">${window.escapeHtml(tTitle)}</span>${deletedBadge}
                </div>
                <small class="text-muted">${date}</small>
            </a>`;
        }
        // 일반 문서 역링크 — 전역·워크스페이스 공용. title 이 있으면 표시(워크스페이스),
        // 없으면 slug(전역 위키)로 폴백. 클릭은 article-backlink-link 핸들러가 처리.
        const label = bl.title || bl.slug;
        return `
          <a href="${ctx.docHref(bl.slug)}" class="article-backlink-link list-group-item list-group-item-action d-flex justify-content-between align-items-center">
              <div>
                  <span class="fw-bold">${window.escapeHtml(label)}</span>
                  ${deletedBadge}
              </div>
              <small class="text-muted">${date}</small>
          </a>`;
      }).join('');
      list.querySelectorAll('a.article-backlink-link').forEach((a) => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          ctx.navigate(a.getAttribute('href'));
        });
      });
      section.classList.remove('d-none');
      return true;
    }
    list.innerHTML = '<div class="text-muted text-center py-3">이 문서를 참조하는 문서가 없습니다.</div>';
    section.classList.add('d-none');
    return false;
  } catch (e) {
    section.classList.add('d-none');
    return false;
  }
}
