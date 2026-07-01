// @ts-nocheck — 문서 구조(목차)·읽기/Raw 모드 공유 컨트롤러(전역 위키·워크스페이스 공용).
// 두 셸이 동일한 DOM 마커를 쓰므로 ID 는 고정이다:
//   본문 #articleContent / 문서 래퍼 #articlePage / 목차 소스 #tocNav /
//   플로팅 목차 #tocFloatingPanel·#tocFloatingNav / 사이드바 목차 #wikiTocSidebarNav·
//   #wikiTocSidebarRightNav / FAB 그룹 #scrollFabGroup / 읽기·Raw 종료 FAB.
// 스크롤스파이/플로팅/모드 상태는 인스턴스에 캡슐화한다. 프레젠테이션 문서의 읽기 모드
// 토글 시 재렌더만 셸별로 다르므로 onReadingModeToggled 콜백으로 위임한다.
// 동작은 과거 index.ts 의 목차/읽기/Raw 모드 블록과 동일하다.

export interface TocControllerOptions {
  /** 읽기 모드 토글 직후 호출(프레젠테이션 문서 재렌더 등 셸별 후처리). */
  onReadingModeToggled?: (active: boolean) => void;
}

export function createTocController(opts: TocControllerOptions = {}) {
  let spyLastId: string | null = null;
  let spyAttached = false;

  // ── 목차 사이드바 채우기 (헤딩 번호 포함) ──
  function populateSidebar(sidebarId: string, navId: string): boolean {
    const sidebar = document.getElementById(sidebarId);
    const nav = document.getElementById(navId);
    if (!sidebar || !nav) return false;
    const contentEl = document.getElementById('articleContent');
    const realHeadings = contentEl
      ? Array.from(contentEl.querySelectorAll(
          'h1:not(.accordion-header), h2:not(.accordion-header), h3:not(.accordion-header), h4:not(.accordion-header)'))
          .filter((h) => !h.closest('.wiki-footnotes'))
      : [];
    if (!realHeadings.length) {
      sidebar.classList.add('d-none');
      nav.innerHTML = '';
      return false;
    }
    let html = (contentEl && typeof window.buildTocOlHtml === 'function')
      ? window.buildTocOlHtml(contentEl, true)
      : '';
    if (!html) {
      const src = document.getElementById('tocNav');
      html = src ? src.innerHTML.trim() : '';
    }
    if (!html) {
      sidebar.classList.add('d-none');
      nav.innerHTML = '';
      return false;
    }
    nav.innerHTML = html;
    sidebar.classList.remove('d-none');
    return true;
  }

  // ── 플로팅 목차 패널 ──
  function toggleFloating() {
    const panel = document.getElementById('tocFloatingPanel');
    const tocSource = document.getElementById('tocNav');
    const floatingNav = document.getElementById('tocFloatingNav');
    if (!panel || !floatingNav) return;
    const isVisible = panel.classList.contains('visible');

    if (!isVisible) {
      if (!tocSource || !tocSource.innerHTML.trim()) return;
      floatingNav.innerHTML = tocSource.innerHTML;
      floatingNav.querySelectorAll('a').forEach((a) => {
        a.addEventListener('click', () => {
          panel.classList.remove('visible');
        });
      });
      spyLastId = null;
      updateActive();
    }
    panel.classList.toggle('visible');
  }

  // ── 스크롤 스파이 ──
  function findCurrentHeadingId(): string | null {
    const articleContent = document.getElementById('articleContent');
    if (!articleContent) return null;
    const headings = articleContent.querySelectorAll('h1, h2, h3, h4');
    if (!headings.length) return null;

    const offset = 120;
    let currentId: string | null = null;
    for (const h of headings) {
      if (!h.id) continue;
      const rect = h.getBoundingClientRect();
      if (rect.top - offset <= 0) {
        currentId = h.id;
      } else {
        break;
      }
    }
    if (!currentId) {
      for (const h of headings) {
        if (h.id) { currentId = h.id; break; }
      }
    }
    return currentId;
  }

  function updateActive() {
    const articlePage = document.getElementById('articlePage');
    if (!articlePage || articlePage.classList.contains('d-none')) return;
    const currentId = findCurrentHeadingId();
    if (!currentId) return;
    if (currentId === spyLastId) return;
    spyLastId = currentId;

    ['tocNav', 'tocFloatingNav', 'wikiTocSidebarNav', 'wikiTocSidebarRightNav'].forEach((navId) => {
      const nav = document.getElementById(navId);
      if (!nav) return;
      nav.querySelectorAll('a.toc-active').forEach((a) => a.classList.remove('toc-active'));
      nav.querySelectorAll('a').forEach((a) => {
        const href = a.getAttribute('href') || '';
        if (href.slice(1) === currentId) a.classList.add('toc-active');
      });
    });

    const floatingNav = document.getElementById('tocFloatingNav');
    const panel = document.getElementById('tocFloatingPanel');
    if (floatingNav && panel && panel.classList.contains('visible')) {
      const activeLink = floatingNav.querySelector('a.toc-active');
      if (activeLink) {
        const navRect = floatingNav.getBoundingClientRect();
        const linkRect = activeLink.getBoundingClientRect();
        if (linkRect.top < navRect.top || linkRect.bottom > navRect.bottom) {
          activeLink.scrollIntoView({ block: 'nearest' });
        }
      }
    }
  }

  /** 렌더 직후/레이아웃 변동 시 스파이 재계산(여러 프레임 보정). */
  function refresh() {
    spyLastId = null;
    updateActive();
    [90, 200, 340, 450].forEach((d) => setTimeout(() => {
      spyLastId = null;
      updateActive();
    }, d));
  }

  function interceptTocLinkClick(e: Event) {
    const a = (e.target as Element).closest && (e.target as Element).closest('a[href^="#"]');
    if (!a) return;
    const hash = a.getAttribute('href');
    if (!hash || hash.length < 2) return;
    let id: string;
    try { id = decodeURIComponent(hash.slice(1)); } catch (_) { id = hash.slice(1); }
    const target = id && typeof window._resolveAnchorTarget === 'function'
      ? window._resolveAnchorTarget(id)
      : (id ? document.getElementById(id) : null);
    if (!target) return;
    e.preventDefault();
    history.pushState(null, '', hash);
    if (typeof window._scrollToElementWithAncestors === 'function') {
      window._scrollToElementWithAncestors(target, { behavior: 'smooth', block: 'start' });
    } else {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function attachLinkInterceptors() {
    ['tocNav', 'tocFloatingNav', 'wikiTocSidebarNav'].forEach((navId) => {
      const nav = document.getElementById(navId);
      if (nav && !nav._tocLinkIntercepted) {
        nav.addEventListener('click', interceptTocLinkClick);
        nav._tocLinkIntercepted = true;
      }
    });
  }

  /** 스크롤 스파이 + 링크 인터셉터 + FAB 가시성 옵저버 부착(멱등). */
  function attachSpy() {
    attachLinkInterceptors();
    if (spyAttached) return;
    spyAttached = true;

    let ticking = false;
    const handler = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        updateActive();
        ticking = false;
      });
    };
    // 스크롤·리사이즈 모두에서 활성 헤딩 재계산(리사이즈/방향전환 시 좌표 변동 반영).
    window.addEventListener('scroll', handler, { passive: true });
    window.addEventListener('resize', handler, { passive: true });

    // 스크롤 FAB 그룹 표시/숨김 — 200px 이상 스크롤하면 노출(읽기/Raw 모드 중에는 유지).
    const fabGroup = document.getElementById('scrollFabGroup');
    if (fabGroup) {
      window.addEventListener('scroll', () => {
        if (window.scrollY > 200) {
          fabGroup.classList.add('visible');
        } else if (!document.body.classList.contains('reading-mode') && !document.body.classList.contains('raw-mode')) {
          fabGroup.classList.remove('visible');
        }
      }, { passive: true });
    }

    document.addEventListener('transitionend', (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (e.propertyName && e.propertyName !== 'grid-template-rows') return;
      if (t.classList && t.classList.contains('wiki-section-body')) refresh();
    });
    document.addEventListener('toggle', (e) => {
      const t = e.target as Element;
      if (t && t.tagName === 'DETAILS') refresh();
    }, true);

    const tocCollapse = document.getElementById('collapseTOC');
    if (tocCollapse) {
      ['show.bs.collapse', 'hide.bs.collapse', 'shown.bs.collapse', 'hidden.bs.collapse'].forEach((ev) =>
        tocCollapse.addEventListener(ev, refresh));
    }

    // 문서 페이지가 아니거나 목차가 없으면 TOC FAB 숨김.
    const observer = new MutationObserver(() => {
      const tocBtn = document.getElementById('tocFabBtn');
      const tocSource = document.getElementById('tocNav');
      const articlePage = document.getElementById('articlePage');
      if (tocBtn) {
        const hasToc = tocSource && tocSource.innerHTML.trim();
        const isArticle = articlePage && !articlePage.classList.contains('d-none');
        (tocBtn as HTMLElement).style.display = (hasToc && isArticle) ? '' : 'none';
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

    updateActive();
  }

  // ── 읽기 모드 ──
  function applyReadingUi(active: boolean) {
    const exitBtn = document.getElementById('readingModeExitFab');
    const fabGroup = document.getElementById('scrollFabGroup');
    if (!exitBtn || !fabGroup) return;
    if (active) {
      exitBtn.classList.remove('d-none');
      fabGroup.classList.add('visible');
    } else {
      exitBtn.classList.add('d-none');
      if (window.scrollY <= 200 && !document.body.classList.contains('raw-mode')) {
        fabGroup.classList.remove('visible');
      }
    }
  }

  function toggleReadingMode() {
    if (document.body.classList.contains('raw-mode')) {
      exitRawMode();
    }
    const active = document.body.classList.toggle('reading-mode');
    applyReadingUi(active);
    try {
      if (active) localStorage.setItem('readingMode', '1');
      else localStorage.removeItem('readingMode');
    } catch (e) { /* noop */ }
    if (typeof opts.onReadingModeToggled === 'function') opts.onReadingModeToggled(active);
  }

  function restoreReadingMode() {
    try {
      if (localStorage.getItem('readingMode') === '1') {
        document.body.classList.add('reading-mode');
        applyReadingUi(true);
      }
    } catch (e) { /* noop */ }
  }

  // ── Raw 보기 모드 ──
  function applyRawUi(active: boolean) {
    const exitBtn = document.getElementById('rawModeExitFab');
    const fabGroup = document.getElementById('scrollFabGroup');
    if (!exitBtn || !fabGroup) return;
    if (active) {
      exitBtn.classList.remove('d-none');
      fabGroup.classList.add('visible');
    } else {
      exitBtn.classList.add('d-none');
      if (window.scrollY <= 200 && !document.body.classList.contains('reading-mode')) {
        fabGroup.classList.remove('visible');
      }
    }
  }

  function exitRawMode() {
    if (document.body.classList.contains('raw-mode')) {
      document.body.classList.remove('raw-mode');
    }
    applyRawUi(false);
  }

  function toggleRawMode() {
    if (document.body.classList.contains('reading-mode')) {
      document.body.classList.remove('reading-mode');
      applyReadingUi(false);
      try { localStorage.removeItem('readingMode'); } catch (e) { /* noop */ }
    }
    const active = document.body.classList.toggle('raw-mode');
    applyRawUi(active);
    if (active) window.scrollTo({ top: 0, behavior: 'auto' });
  }

  return {
    populateSidebar,
    toggleFloating,
    attachSpy,
    refresh,
    toggleReadingMode,
    restoreReadingMode,
    toggleRawMode,
    exitRawMode,
  };
}
