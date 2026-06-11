// @ts-nocheck — 문서 구조(브레드크럼) 네비게이션 공유 모듈.
// 전역 위키 문서 조회(index.ts)와 워크스페이스 문서 조회(ws-doc.ts)가 공유한다.
// 양쪽 셸이 동일한 DOM 마커(#parentDocsNav / #parentDocsSiblings / #parentDocsNavWrapper /
// #parentDocsNavDivider)를 쓰므로, 차이가 나는 부분(문서 링크 경로·하위문서 API·네비게이션·
// 하위문서 생성 권한)만 ArticleContext 로 주입받는다. 동작은 과거 index.ts 의
// renderParentDocsNav + 형제 패널 헬퍼와 동일하다.

import type { ArticleContext } from './context';

/**
 * 브레드크럼 네비게이터 인스턴스를 만든다. 형제 패널의 요청 시퀀스/활성 버튼 상태를
 * 인스턴스 내부에 캡슐화해 호출 측은 render(slug) / close() 만 쓰면 된다.
 */
export function createBreadcrumbNav(ctx: ArticleContext) {
  let siblingsReqSeq = 0;
  let siblingsActiveBtn: HTMLElement | null = null;

  function positionSiblings(btn: HTMLElement) {
    const panelEl = document.getElementById('parentDocsSiblings');
    const wrapperEl = document.getElementById('parentDocsNavWrapper');
    if (!panelEl || !wrapperEl) return;
    const anchorEl = btn.closest('.parent-docs-segment') || btn;
    const wrapperRect = wrapperEl.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const anchorRect = (anchorEl as HTMLElement).getBoundingClientRect();

    panelEl.style.position = 'absolute';
    panelEl.style.top = `${Math.round(btnRect.bottom - wrapperRect.top + 4)}px`;

    const desiredLeft = anchorRect.left - wrapperRect.left;
    const panelW = panelEl.offsetWidth || 192;
    const viewportW = document.documentElement.clientWidth;
    const maxLeftViewport = viewportW - panelW - 8;
    const maxLeftRelative = Math.max(0, maxLeftViewport - wrapperRect.left);
    panelEl.style.left = `${Math.round(Math.min(desiredLeft, maxLeftRelative))}px`;
  }

  function onOutsideClick(ev: Event) {
    const panelEl = document.getElementById('parentDocsSiblings');
    if (panelEl && panelEl.contains(ev.target as Node)) return;
    if (siblingsActiveBtn && siblingsActiveBtn.contains(ev.target as Node)) return;
    close();
  }
  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      const triggerBtn = siblingsActiveBtn;
      close();
      if (triggerBtn) triggerBtn.focus();
    }
  }
  function onViewportChange() {
    if (siblingsActiveBtn) positionSiblings(siblingsActiveBtn);
  }

  function close() {
    const panelEl = document.getElementById('parentDocsSiblings');
    const parentDocsEl = document.getElementById('parentDocsNav');
    if (parentDocsEl) {
      parentDocsEl.querySelectorAll('.parent-docs-chevron').forEach((b) => {
        b.classList.remove('active');
        b.setAttribute('aria-expanded', 'false');
      });
    }
    if (panelEl) {
      panelEl.classList.add('d-none');
      panelEl.innerHTML = '';
    }
    siblingsActiveBtn = null;
    siblingsReqSeq++; // 진행 중 응답 무효화
    document.removeEventListener('click', onOutsideClick, true);
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('resize', onViewportChange);
  }

  async function toggleSiblings(btn: HTMLElement) {
    const panelEl = document.getElementById('parentDocsSiblings');
    if (!panelEl) return;
    const parentSlug = btn.dataset.parent || '';
    const currentName = btn.dataset.current || '';
    const wasActive = btn.classList.contains('active');

    close(); // 다른 chevron 도 함께 비활성화

    if (wasActive) return; // 같은 chevron 재클릭 → 닫기만

    const reqId = ++siblingsReqSeq;
    siblingsActiveBtn = btn;
    btn.classList.add('active');
    btn.setAttribute('aria-expanded', 'true');

    panelEl.classList.remove('d-none');
    panelEl.setAttribute('role', 'menu');
    panelEl.innerHTML = `<span class="parent-docs-siblings-status"><span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>불러오는 중...</span>`;
    positionSiblings(btn);

    document.addEventListener('click', onOutsideClick, true);
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('resize', onViewportChange);

    try {
      const res = await fetch(ctx.subdocsUrl(parentSlug, true));
      if (reqId !== siblingsReqSeq) return;
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      if (reqId !== siblingsReqSeq) return;
      const docs = (data.subdocs || []).filter((d) => {
        const rel = d.slug.substring(parentSlug.length + 1);
        return rel !== currentName;
      });

      if (docs.length === 0) {
        panelEl.innerHTML = `<span class="parent-docs-siblings-status fst-italic">동일 단계 문서가 없습니다</span>`;
        positionSiblings(btn);
        return;
      }

      const items = docs.map((d) => {
        const rel = d.slug.substring(parentSlug.length + 1);
        return `<a href="${ctx.docHref(d.slug)}" role="menuitem" class="parent-docs-sibling-item article-nav-link" title="${window.escapeHtml(d.slug)}">${window.escapeHtml(rel)}</a>`;
      }).join('');
      panelEl.innerHTML = items;
      panelEl.querySelectorAll('.article-nav-link').forEach((link) => {
        link.addEventListener('click', function (event) {
          event.preventDefault();
          const href = (this as HTMLAnchorElement).getAttribute('href');
          close();
          ctx.navigate(href);
        });
      });
      positionSiblings(btn);
    } catch (err) {
      if (reqId !== siblingsReqSeq) return;
      console.error(err);
      panelEl.innerHTML = `<span class="parent-docs-siblings-status">불러오기 실패</span>`;
      positionSiblings(btn);
    }
  }

  /**
   * 문서 구조(브레드크럼) 렌더. actionSlug 의 '/' 분할만으로 동작하므로 문서 존재 여부와 무관.
   * (전역 위키는 콜론 슬러그에서 하위문서 생성 버튼 억제 — canCreateSubdoc 가 판단)
   */
  function render(actionSlug: string) {
    const parentDocsEl = document.getElementById('parentDocsNav');
    if (!parentDocsEl) return;
    close();
    const parts = actionSlug.split('/');
    const segments: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const isCurrent = i === parts.length - 1;
      const segSlug = parts.slice(0, i + 1).join('/');
      const parentSlug = i === 0 ? '' : parts.slice(0, i).join('/');
      const labelHtml = isCurrent
        ? `<span class="parent-docs-current fw-semibold">${window.escapeHtml(parts[i])}</span>`
        : `<a href="${ctx.docHref(segSlug)}" class="text-decoration-none article-nav-link">${window.escapeHtml(parts[i])}</a>`;
      const chevronHtml = i === 0
        ? ''
        : ` <button type="button" class="btn btn-link btn-sm p-0 align-baseline parent-docs-chevron" data-parent="${window.escapeHtml(parentSlug)}" data-current="${window.escapeHtml(parts[i])}" data-level="${i}" title="동일 단계 문서 보기" aria-label="동일 단계 문서 보기" aria-expanded="false"><i class="bi bi-chevron-down"></i></button>`;
      segments.push(`<span class="parent-docs-segment">${labelHtml}${chevronHtml}</span>`);
    }

    const canCreate = ctx.canCreateSubdoc(actionSlug);
    const subdocButtonHtml = canCreate
      ? ` <span class="text-muted mx-1">/</span> <button type="button" class="btn btn-link btn-sm p-0 align-baseline parent-docs-create" data-slug="${window.escapeHtml(actionSlug)}" title="하위 문서 생성" aria-label="하위 문서 생성"><i class="bi bi-pencil-square"></i></button>`
      : '';

    parentDocsEl.innerHTML = `<span class="text-muted me-1">문서 구조:</span>${segments.join(' <span class="text-muted mx-1">/</span> ')}${subdocButtonHtml}`;
    parentDocsEl.querySelectorAll('.article-nav-link').forEach((link) => {
      link.addEventListener('click', function (event) {
        event.preventDefault();
        ctx.navigate((this as HTMLAnchorElement).getAttribute('href'));
      });
    });
    const createSubdocBtn = parentDocsEl.querySelector('.parent-docs-create');
    if (createSubdocBtn) {
      createSubdocBtn.addEventListener('click', function () {
        ctx.onCreateSubdoc((this as HTMLElement).dataset.slug);
      });
    }
    parentDocsEl.querySelectorAll('.parent-docs-chevron').forEach((btn) => {
      btn.addEventListener('click', function () {
        toggleSiblings(this as HTMLElement);
      });
    });
    parentDocsEl.classList.remove('d-none');
    document.getElementById('parentDocsNavDivider')?.classList.remove('d-none');
  }

  return { render, close };
}
