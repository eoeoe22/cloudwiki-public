// @ts-nocheck — index.html 인라인 스크립트 이관(동작 보존). common.ts 와 동일 사유로 타입검사 비활성.
//
// 이관 규칙:
//  - index.html 은 classic <script> 전역 스코프를 공유하는 인라인 블록이 2개였다.
//    (블록A: 메인 라우팅/렌더/검색, 블록B: 읽기 모드/플로팅 목차) 두 블록이 서로의
//    전역 함수를 참조하므로 동작 보존을 위해 블록A 본문 다음에 블록B 본문을 그대로
//    이어붙여 하나의 모듈로 병합한다.
//  - common.js / render.js 가 window.* 로 노출하는 공통 전역(loadConfig / checkAuth /
//    loadTrending / loadRecentChanges / currentUser / appConfig / escapeHtml /
//    renderWikiContent / resolveTransclusionsForMarkdown / mountMediaTagInput)은 모듈
//    스코프에서 bare 식별자로 해석되지 않으므로 모두 window.* 로 접근한다. (특히
//    `typeof appConfig` 는 모듈 스코프에서 window 에 값이 있어도 'undefined' 가 되므로
//    `typeof window.appConfig`)
//  - render.js 의 _scrollToElementWithAncestors 도 window 에 노출되지 않으므로
//    `typeof window._scrollToElementWithAncestors === 'function'` 가드로 접근한다
//    (원본 classic 스크립트에서도 모듈 함수라 false 로 평가되어 fallback 이 돌던 동작 보존).
//  - HTML 의 on* 속성에서 호출되는, 이 블록이 정의한 함수들은 파일 끝에서 window.* 로 노출한다.

    // ── SSR 데이터 로드 ──
    let ssrData = null;
    (function () {
      const el = document.getElementById('ssr-data');
      if (el) {
        try { ssrData = JSON.parse(el.textContent); } catch (e) { }
      }
    })();

    // ── 전역 상태 ──
    let currentSlug = null;
    let currentPage = null;

    // ── 초기화 ──
    document.addEventListener('DOMContentLoaded', async () => {
      await Promise.all([window.loadConfig(), window.checkAuth()]);

      // URL 파라미터 기반 안내/에러 메시지 표시
      const urlParams = new URLSearchParams(window.location.search);
      const errorParam = urlParams.get('error');
      const infoParam = urlParams.get('info');
      if (errorParam || infoParam) {
        const messages = {
          'deleted_account': { icon: 'error', title: '접근 불가', text: '탈퇴한 계정입니다.' },
          'signup_pending': { icon: 'info', title: '가입 대기 중', text: '가입 신청이 대기 중입니다. 관리자 승인을 기다려주세요.' },
          'signup_blocked': { icon: 'error', title: '가입 차단', text: '가입이 차단된 계정입니다. 관리자에게 문의하세요.' },
          'email_domain_not_allowed': { icon: 'error', title: '가입 불가', text: '해당 이메일 도메인은 가입이 허용되지 않습니다.' },
          'signup_submitted': { icon: 'success', title: '가입 신청 완료', text: '가입 신청이 접수되었습니다. 관리자 승인 후 이용 가능합니다.' },
        };
        const key = errorParam || infoParam;
        const msg = messages[key];
        if (msg) {
          Swal.fire(msg);
          // URL에서 파라미터 제거
          window.history.replaceState({}, '', '/');
        }
      }

      route();
      _initialLoadDone = true;
      // left-toc/docs 모드: 우측 사이드바의 트렌딩/최근 변경 섹션을 본문 하단으로 이동.
      // (loadTrending/loadRecentChanges 는 ID 로 자식 요소만 채우므로 부모 이동과 무관)
      relocateRightSidebarBelowArticle();
      window.loadTrending();
      window.loadRecentChanges();

      // 브라우저 뒤로/앞으로 버튼 처리
      window.addEventListener('popstate', () => {
        const currentPath = window.location.pathname;
        const currentSearch = window.location.search;
        // 경로/쿼리가 그대로고 해시만 바뀐 경우(같은 페이지 섹션 이동) → 재페치/재렌더 없이 스크롤만
        if (currentPath === _lastPath && currentSearch === _lastSearch) {
          if (window.location.hash) {
            scrollToHash();
          } else {
            window.scrollTo({ top: 0, behavior: 'instant' });
          }
          return;
        }
        _lastPath = currentPath;
        _lastSearch = currentSearch;
        if (!window.location.hash) {
          window.scrollTo({ top: 0, behavior: 'instant' });
        }
        route();
      });

      // 스크롤 FAB 표시/숨김
      const scrollFabGroup = document.getElementById('scrollFabGroup');
      window.addEventListener('scroll', () => {
        if (window.scrollY > 200) {
          scrollFabGroup.classList.add('visible');
        } else if (!document.body.classList.contains('reading-mode') && !document.body.classList.contains('raw-mode')) {
          scrollFabGroup.classList.remove('visible');
        }
      }, { passive: true });
    });

    // ── 라우팅 ──
    function route() {
      const path = window.location.pathname;
      // SPA 네비게이션(다른 문서/페이지) 진입 시 이전 프레젠테이션 덱을 해체한다.
      // 같은 문서 내 슬라이드 해시(#/N) 이동은 popstate early-return 으로 route() 를
      // 호출하지 않으므로, 여기서 정리해도 활성 덱의 body 클래스/키보드·해시 상태가 보존된다.
      // (hideAllPages() 는 정상 로드 경로에서 렌더 이후 호출되므로 거기서 해체하면 안 된다.)
      if (typeof window.teardownPresentation === 'function') {
        try { window.teardownPresentation(); } catch (e) { /* noop */ }
      }
      if (!_initialLoadDone) hideAllPages();

      if (path === '/' || path === '') {
        showHome();
      } else if (path.startsWith('/w/')) {
        const params = new URLSearchParams(window.location.search);
        const mode = params.get('mode');
        if (mode === 'discussions' || mode === 'revisions') {
          // 토론/리비전 페이지 → 별도 HTML로 이동
          window.location.href = path + window.location.search;
          return;
        }
        let slug = path.substring(3);
        try {
          slug = decodeURIComponent(slug);
        } catch (e) {
          // malformed percent-encoding이 있어도 라우터가 깨지지 않도록 원본 slug를 사용
        }
        showArticle(slug);
      } else if (path === '/search') {
        window.location.href = '/search' + window.location.search;
      }
    }

    let _initialLoadDone = false;
    // popstate에서 해시만 바뀐 경우(같은 페이지 섹션 이동)를 감지하기 위한 직전 경로/쿼리
    let _lastPath = window.location.pathname;
    let _lastSearch = window.location.search;

    // docs 레이아웃 좌측 그룹 nav 상태:
    // 같은 그룹 내 SPA 이동 시 refetch 를 피하기 위한 모듈 캐시. 현재 문서 강조는 매번 다시 계산.
    let _groupNavCache: { groupRoot: string | null; root: any; truncated: boolean } = { groupRoot: null, root: null, truncated: false };
    // SPA 네비게이션 경합 시 오래된 응답이 최신 트리를 덮어쓰지 않도록 하는 요청 시퀀스. hideAllPages 가 증가시킨다.
    let __groupNavReqSeq = 0;

    function hideAllPages() {
      document.getElementById('loading').classList.add('d-none');
      document.getElementById('spaProgressBar').classList.add('d-none');
      document.getElementById('homePage').classList.add('d-none');
      document.getElementById('articlePage').classList.add('d-none');
      document.getElementById('notFoundPage').classList.add('d-none');
      document.getElementById('deletedPage').classList.add('d-none');
      document.getElementById('privatePage').classList.add('d-none');
      document.getElementById('categoryPage').classList.add('d-none');
      // 레이아웃 사이드바(left-toc 좌측 목차 / docs 좌측 그룹 트리·우측 목차)는 #articlePage 한정.
      // 페이지 전환 시 일단 모두 숨기고, 문서 렌더 후 syncSidebarsForLayout() 에서 다시 노출 여부 결정.
      ['wikiTocSidebar', 'wikiNavSidebar', 'wikiTocSidebarRight'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('d-none');
      });
      // docs 하단 이전/다음 푸터(#docsPageNav)는 .wiki-article 내부라 페이지 전환에도 남는다.
      // 일반 docs 문서는 syncSidebarsForLayout() 에서 다시 칠하지만, 이미지/map: 문서 분기는
      // syncSidebarsForLayout 을 호출하지 않으므로 여기서 초기화해 stale 한 prev/next 가
      // 남지 않도록 한다.
      const docsPageNav = document.getElementById('docsPageNav');
      if (docsPageNav) {
        docsPageNav.classList.add('d-none');
        docsPageNav.innerHTML = '';
      }
      // 진행 중인 그룹 nav 요청을 무효화한다. 모든 페이지 전환(article/home/404/map/image)이
      // hideAllPages 를 거치므로, 느린 /nav-tree 응답이 전환 후 도착해 숨긴 사이드바를 다시
      // 노출(paintGroupNav)하는 race 를 막는다.
      __groupNavReqSeq++;
    }

    // left-toc/docs 모드일 때 우측 사이드바(#wikiSidebar) 의 트렌딩/최근 변경 섹션 두 블록을
    // 본문 #articlePage > .wiki-article 다음 형제로 옮긴다. 한 번만 실행되면 충분.
    // (loadTrending/loadRecentChanges 는 자식 ID 로만 채우므로 부모 이동과 무관)
    // docs 모드도 우측 사이드바를 CSS 로 숨기므로, 동일하게 본문 하단으로 옮겨 노출한다.
    let _rightSidebarRelocated = false;
    function relocateRightSidebarBelowArticle() {
      if (_rightSidebarRelocated) return;
      const mode = window.appConfig?.layoutMode;
      if (mode !== 'left-toc' && mode !== 'right-toc' && mode !== 'docs' && mode !== 'wide') return;
      const sidebar = document.getElementById('wikiSidebar');
      const articlePage = document.getElementById('articlePage');
      if (!sidebar || !articlePage) return;
      const wikiArticle = articlePage.querySelector('.wiki-article');
      if (!wikiArticle) return;
      const trendingParent = document.getElementById('trendingListPc')?.closest('.mb-4');
      const recentParent = document.getElementById('recentChangesListPc')?.closest('.mb-4');
      if (!trendingParent && !recentParent) return;
      const container = document.createElement('div');
      container.className = 'wiki-sidebar-bottom-relocated';

      // 커스텀 사이드바는 모바일 오프캔버스 메뉴(#mobileSidebar)의 소스이므로 옮기지 않고
      // 복제해 본문 하단에 추가한다(PC 전용 노출, CSS 로 모바일 숨김). SSR 단계에서
      // #custom-sidebar-content placeholder 는 <li> 항목들로 치환되어 사라지므로(ssr.ts),
      // 안정적인 부모 컨테이너 #sidebar-nav-list 의 내용을 복제 소스로 쓴다.
      // 실제 커스텀 항목(<li>)이 있을 때만 복제한다 — SSR 미주입 폴백 경로에서 #sidebar-nav-list
      // 가 빈 placeholder 만 담고 있는 경우 빈 카드가 생기지 않도록.
      // 하단 배치 순서: 커스텀 사이드바 → 트렌딩 → 최근 변경.
      const customSrc = document.getElementById('sidebar-nav-list');
      if (customSrc && customSrc.querySelector('li')) {
        const customBlock = document.createElement('div');
        customBlock.className = 'wiki-sidebar-bottom-custom';
        const ul = document.createElement('ul');
        ul.className = 'navbar-nav';
        ul.innerHTML = customSrc.innerHTML;
        customBlock.appendChild(ul);
        container.appendChild(customBlock);
      }

      if (trendingParent) container.appendChild(trendingParent);
      if (recentParent) container.appendChild(recentParent);

      wikiArticle.insertAdjacentElement('afterend', container);
      _rightSidebarRelocated = true;
    }

    // 렌더된 본문(#articleContent)의 헤딩 번호를 포함한 목차 HTML 을 지정한 목차 사이드바에 채운다.
    // 헤딩이 없으면 사이드바를 숨기고 false 반환. (left-toc 좌측 사이드바·docs 우측 사이드바 공용)
    function populateTocSidebar(sidebarId: string, navId: string): boolean {
      const sidebar = document.getElementById(sidebarId);
      const nav = document.getElementById(navId);
      if (!sidebar || !nav) return false;
      // 목차 사이드바는 헤딩 번호를 포함해 생성한다(#tocNav 는 번호가 없으므로 복제하지 않는다).
      // 렌더된 본문(articleContent)의 .wiki-heading-num 스팬을 읽어 번호 prefix 를 붙인다.
      const contentEl = document.getElementById('articleContent');
      // 각주 섹션 헤딩(<h4>각주</h4>, .wiki-footnotes 내부)은 자동 생성되는 것이므로 실제 목차
      // 항목으로 치지 않는다. 각주 헤딩만 있고 다른 헤딩이 없으면 목차 없음으로 간주해 사이드바를 숨긴다.
      // (buildTocOlHtml 와 동일하게 .accordion-header 도 제외하고 h1~h4 만 센다.)
      const realHeadings = contentEl
        ? Array.from(contentEl.querySelectorAll(
            'h1:not(.accordion-header), h2:not(.accordion-header), h3:not(.accordion-header), h4:not(.accordion-header)'))
            .filter(h => !h.closest('.wiki-footnotes'))
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
        // 헬퍼 미가용 등 예외 상황에서는 번호 없는 #tocNav 복제로 폴백.
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

    // 문서 렌더 후 #tocNav 내용을 좌측 사이드바에 복제하고 노출 여부를 결정.
    // (left-toc 모드 + 헤딩이 있는 문서에서만 노출)
    function syncLeftTocSidebar() {
      if (window.appConfig?.layoutMode !== 'left-toc') {
        const leftTocSidebar = document.getElementById('wikiTocSidebar');
        const leftTocNav = document.getElementById('wikiTocSidebarNav');
        if (leftTocSidebar) leftTocSidebar.classList.add('d-none');
        if (leftTocNav) leftTocNav.innerHTML = '';
        return;
      }
      populateTocSidebar('wikiTocSidebar', 'wikiTocSidebarNav');
    }

    // ── docs 레이아웃: 좌측 그룹 문서 트리 + 우측 문서내 목차 ──
    function renderGroupTreeNode(node: any, currentSlug: string): string {
      const isCurrent = node.slug === currentSlug;
      const label = node.hasDoc
        ? `<a href="/w/${encodeURIComponent(node.slug)}" class="wiki-spa-link${isCurrent ? ' nav-current' : ''}"${isCurrent ? ' aria-current="page"' : ''} title="${window.escapeHtml(node.slug)}">${window.escapeHtml(node.name)}</a>`
        : `<span class="nav-nodoc">${window.escapeHtml(node.name)}</span>`;
      let childrenHtml = '';
      if (node.children && node.children.length) {
        childrenHtml = '<ul>' + node.children.map((c: any) => renderGroupTreeNode(c, currentSlug)).join('') + '</ul>';
      }
      return `<li>${label}${childrenHtml}</li>`;
    }

    // 그룹 트리를 사이드바 표시 순서(pre-order DFS, descendant 수→이름 정렬은 서버가 이미 적용)
    // 그대로 평탄화한다. 실제 문서가 있는 노드(hasDoc)만 모아 prev/next 탐색에 쓰므로
    // 경로상 중간 노드(문서 없음)는 자동으로 건너뛰어진다.
    function flattenDocTree(root: any): { slug: string; name: string }[] {
      const out: { slug: string; name: string }[] = [];
      function walk(node: any) {
        if (!node) return;
        if (node.hasDoc) out.push({ slug: node.slug, name: node.name });
        if (node.children) for (const c of node.children) walk(c);
      }
      walk(root);
      return out;
    }

    // 본문 하단 이전/다음 문서 네비게이션 렌더 (docs 레이아웃 전용).
    // 평탄화한 트리에서 현재 문서의 위치를 찾아 직전/직후 문서를 버튼으로 노출한다.
    // 첫 문서면 이전 버튼을, 마지막 문서면 다음 버튼을 생략한다.
    function paintDocNavFooter(root: any, currentSlug: string) {
      const container = document.getElementById('docsPageNav');
      if (!container) return;
      const clear = () => { container.classList.add('d-none'); container.innerHTML = ''; };
      if (!root || !currentSlug) { clear(); return; }
      const flat = flattenDocTree(root);
      const idx = flat.findIndex(n => n.slug === currentSlug);
      if (idx === -1) { clear(); return; }
      const prev = idx > 0 ? flat[idx - 1] : null;
      const next = idx < flat.length - 1 ? flat[idx + 1] : null;
      if (!prev && !next) { clear(); return; }

      const linkHtml = (doc: { slug: string; name: string }, dir: 'prev' | 'next') => {
        const isPrev = dir === 'prev';
        const dirLabel = isPrev ? '이전 문서' : '다음 문서';
        const icon = isPrev
          ? '<i class="bi bi-chevron-left"></i>'
          : '<i class="bi bi-chevron-right"></i>';
        const inner = isPrev
          ? `${icon}<span class="docs-page-nav-text"><span class="docs-page-nav-dir">${dirLabel}</span><span class="docs-page-nav-title">${window.escapeHtml(doc.name)}</span></span>`
          : `<span class="docs-page-nav-text"><span class="docs-page-nav-dir">${dirLabel}</span><span class="docs-page-nav-title">${window.escapeHtml(doc.name)}</span></span>${icon}`;
        return `<a href="/w/${encodeURIComponent(doc.slug)}" class="docs-page-nav-link docs-page-nav-${dir} wiki-spa-link" title="${window.escapeHtml(doc.slug)}">${inner}</a>`;
      };

      // 한쪽만 있을 때도 다음 버튼이 우측에 정렬되도록 빈 자리(placeholder)를 둔다.
      const prevHtml = prev ? linkHtml(prev, 'prev') : '<span class="docs-page-nav-spacer"></span>';
      const nextHtml = next ? linkHtml(next, 'next') : '<span class="docs-page-nav-spacer"></span>';
      container.innerHTML = prevHtml + nextHtml;
      container.querySelectorAll('.wiki-spa-link').forEach(link => {
        link.addEventListener('click', function (this: HTMLAnchorElement, event) {
          event.preventDefault();
          navigateTo(this.getAttribute('href'));
        });
      });
      container.classList.remove('d-none');
    }

    function paintGroupNav(root: any, groupRoot: string, truncated: boolean, currentSlug: string) {
      paintDocNavFooter(root, currentSlug);
      const sidebar = document.getElementById('wikiNavSidebar');
      const nav = document.getElementById('wikiNavSidebarTree');
      if (!sidebar || !nav) return;
      if (!root) {
        sidebar.classList.add('d-none');
        nav.innerHTML = '';
        return;
      }
      const groupLabel = document.getElementById('wikiNavSidebarGroup');
      if (groupLabel) groupLabel.textContent = groupRoot || '문서';
      let html = '<ul>' + renderGroupTreeNode(root, currentSlug) + '</ul>';
      if (truncated) html += `<div class="nav-truncated">... (하위 문서가 많아 일부 생략됨)</div>`;
      nav.innerHTML = html;
      nav.querySelectorAll('.wiki-spa-link').forEach(link => {
        link.addEventListener('click', function (this: HTMLAnchorElement, event) {
          event.preventDefault();
          navigateTo(this.getAttribute('href'));
        });
      });
      sidebar.classList.remove('d-none');
    }

    // 그룹 루트(슬러그 첫 세그먼트)의 하위 문서 트리를 좌측 사이드바에 렌더. 현재 문서를 강조한다.
    async function renderGroupNav(currentSlug: string) {
      const sidebar = document.getElementById('wikiNavSidebar');
      const nav = document.getElementById('wikiNavSidebarTree');
      if (!sidebar || !nav) return;
      // map: 가상 문서·이미지 문서·빈 슬러그는 자체 트리/표지가 있거나 그룹이 무의미하므로 nav 를 숨긴다.
      if (!currentSlug || (currentPage && (currentPage.is_map_doc || currentPage.is_image_doc))) {
        sidebar.classList.add('d-none');
        nav.innerHTML = '';
        paintDocNavFooter(null, '');
        return;
      }
      const groupRoot = currentSlug.split('/')[0];
      // 같은 그룹이면 refetch 없이 현재 문서 강조만 다시 칠한다.
      if (_groupNavCache.groupRoot === groupRoot && _groupNavCache.root) {
        paintGroupNav(_groupNavCache.root, groupRoot, _groupNavCache.truncated, currentSlug);
        return;
      }
      const reqId = ++__groupNavReqSeq;
      try {
        const res = await fetch(`/api/w/${encodeURIComponent(groupRoot)}/nav-tree`);
        if (reqId !== __groupNavReqSeq) return; // 더 최신 네비게이션이 진행 중 → 폐기
        if (!res.ok) throw new Error('failed');
        const data = await res.json();
        if (reqId !== __groupNavReqSeq) return;
        if (!data || !data.root) {
          sidebar.classList.add('d-none');
          nav.innerHTML = '';
          paintDocNavFooter(null, '');
          return;
        }
        _groupNavCache = { groupRoot, root: data.root, truncated: !!data.truncated };
        paintGroupNav(data.root, groupRoot, !!data.truncated, currentSlug);
      } catch (err) {
        if (reqId !== __groupNavReqSeq) return;
        console.error(err);
        sidebar.classList.add('d-none');
        nav.innerHTML = '';
        paintDocNavFooter(null, '');
      }
    }

    // docs 모드: 우측 문서내 목차 + 좌측 그룹 트리 동기화.
    function syncDocsLayout() {
      populateTocSidebar('wikiTocSidebarRight', 'wikiTocSidebarRightNav');
      const slug = currentPage && currentPage.slug ? currentPage.slug : '';
      renderGroupNav(slug);
    }

    // right-toc 모드: left-toc 와 동일하되 목차를 우측 사이드바(#wikiTocSidebarRight)에 채운다.
    // 좌측 그룹 트리는 없으므로 docs 와 달리 renderGroupNav 는 호출하지 않는다.
    function syncRightTocSidebar() {
      populateTocSidebar('wikiTocSidebarRight', 'wikiTocSidebarRightNav');
    }

    // 레이아웃 모드별 사이드바 동기화 디스패처. (default 는 무동작)
    function syncSidebarsForLayout() {
      const mode = window.appConfig?.layoutMode;
      if (mode === 'left-toc') {
        syncLeftTocSidebar();
      } else if (mode === 'right-toc') {
        syncRightTocSidebar();
      } else if (mode === 'docs') {
        syncDocsLayout();
      }
    }

    function showLoading() {
      if (_initialLoadDone) {
        // SPA 네비게이션: 기존 문서 유지 + 프로그레스 바
        document.getElementById('spaProgressBar').classList.remove('d-none');
      } else {
        // 최초 로드: 스피너
        hideAllPages();
        document.getElementById('loading').classList.remove('d-none');
      }
    }

    // ── 홈(환영 페이지 대신 /w/[WIKI_NAME] 으로 이동) ──
    async function showHome() {
      const wikiName = typeof window.appConfig !== 'undefined' && window.appConfig.wikiName ? window.appConfig.wikiName : 'CloudWiki';
      navigateTo(`/w/${encodeURIComponent(wikiName)}`);
    }

    // ── 문서 보기 ──
    async function scrollToBacklinks() {
      const section = document.getElementById('backlinksSection');
      const list = document.getElementById('backlinksList');

      if (!section.classList.contains('d-none')) {
        section.scrollIntoView({ behavior: 'smooth' });
        return;
      }

      const loaded = await loadBacklinks(currentSlug);
      if (loaded) {
        section.scrollIntoView({ behavior: 'smooth' });
      } else {
        Swal.fire({
          icon: 'info',
          title: '역링크',
          text: '이 문서를 참조하는 역링크가 없습니다.',
          timer: 2000,
          showConfirmButton: false
        });
      }
    }

    async function showSubdocs(slug) {
      // 하위 문서인 경우 최상위 문서를 기준으로 탐색
      const topSlug = slug.includes('/') ? slug.split('/')[0] : slug;

      try {
        const res = await fetch(`/api/w/${encodeURIComponent(topSlug)}/subdocs`);
        const data = await res.json();
        const subdocs = data.subdocs || [];

        if (subdocs.length === 0) {
          Swal.fire('문서 구조', '하위 문서가 없습니다.', 'info');
          return;
        }

        // 트리 구조 빌드
        const tree = {};
        for (const doc of subdocs) {
          // slug에서 최상위 문서 prefix 제거
          const relative = doc.slug.substring(topSlug.length + 1); // "스마트폰/갤럭시S"
          const parts = relative.split('/');
          let node = tree;
          for (const part of parts) {
            if (!node[part]) node[part] = { _children: {}, _doc: null };
            node = node[part]._children;
          }
          // 마지막 노드에 문서 정보 저장
          let target = tree;
          for (let i = 0; i < parts.length; i++) {
            if (i === parts.length - 1) {
              target[parts[i]]._doc = doc;
            } else {
              target = target[parts[i]]._children;
            }
          }
        }

        function annotateDescendants(children) {
          let total = 0;
          for (const key of Object.keys(children)) {
            const sub = annotateDescendants(children[key]._children);
            children[key]._descendants = sub;
            total += 1 + sub;
          }
          return total;
        }
        annotateDescendants(tree);

        function sortEntries(nodes) {
          return Object.keys(nodes).sort((a, b) => {
            const ca = nodes[a]._descendants;
            const cb = nodes[b]._descendants;
            if (ca !== cb) return ca - cb;
            return a.localeCompare(b);
          });
        }

        function renderTree(nodes, parentPrefix) {
          const entries = sortEntries(nodes);
          let html = '';
          entries.forEach((key, idx) => {
            const node = nodes[key];
            const isLast = idx === entries.length - 1;
            const hasChildren = Object.keys(node._children).length > 0;
            const connector = isLast ? '└── ' : '├── ';
            const childPrefix = parentPrefix + (isLast ? '    ' : '│   ');

            if (node._doc) {
              html += `<div style="font-family:monospace;white-space:pre;line-height:1.6;">${parentPrefix}${connector}` +
                `<a href="/w/${encodeURIComponent(node._doc.slug)}" onclick="Swal.close();navigateTo(this.href);return false;" class="text-decoration-none">${window.escapeHtml(key)}</a></div>`;
            } else {
              html += `<div style="font-family:monospace;white-space:pre;line-height:1.6;">${parentPrefix}${connector}${window.escapeHtml(key)}</div>`;
            }

            if (hasChildren) {
              html += renderTree(node._children, childPrefix);
            }
          });
          return html;
        }

        function renderPlain(nodes, parentPrefix) {
          const entries = sortEntries(nodes);
          let text = '';
          entries.forEach((key, idx) => {
            const node = nodes[key];
            const isLast = idx === entries.length - 1;
            const hasChildren = Object.keys(node._children).length > 0;
            const connector = isLast ? '└── ' : '├── ';
            const childPrefix = parentPrefix + (isLast ? '    ' : '│   ');
            text += parentPrefix + connector + key + '\n';
            if (hasChildren) {
              text += renderPlain(node._children, childPrefix);
            }
          });
          return text;
        }

        function renderMarkdown(nodes, parentPrefix) {
          const entries = sortEntries(nodes);
          let md = '';
          entries.forEach((key, idx) => {
            const node = nodes[key];
            const isLast = idx === entries.length - 1;
            const hasChildren = Object.keys(node._children).length > 0;
            const connector = isLast ? '└── ' : '├── ';
            const childPrefix = parentPrefix + (isLast ? '    ' : '│   ');
            if (node._doc) {
              md += `${parentPrefix}${connector}[[${node._doc.slug}|${key}]]\n`;
            } else {
              md += `${parentPrefix}${connector}${key}\n`;
            }
            if (hasChildren) {
              md += renderMarkdown(node._children, childPrefix);
            }
          });
          return md;
        }

        const topTitle = decodeURIComponent(topSlug);

        // 루트 문서 포함
        let treeHtml = `<div style="font-family:monospace;white-space:pre;line-height:1.6;"><a href="/w/${encodeURIComponent(topSlug)}" onclick="Swal.close();navigateTo(this.href);return false;" class="text-decoration-none fw-bold">${window.escapeHtml(topTitle)}</a></div>`;
        treeHtml += renderTree(tree, '');

        const plainText = topTitle + '\n' + renderPlain(tree, '');
        const markdown = `[[${topSlug}]]\n` + renderMarkdown(tree, '');

        window.__subdocsCopyData = { plain: plainText, md: markdown };

        const buttonsHtml = `
          <div class="d-flex gap-2 mb-3 justify-content-end">
            <button type="button" class="btn btn-sm btn-outline-secondary" onclick="copySubdocsPopup(this, 'plain')"><i class="bi bi-copy"></i> 텍스트 복사</button>
            <button type="button" class="btn btn-sm btn-outline-secondary" onclick="copySubdocsPopup(this, 'md')"><i class="bi bi-markdown"></i> 마크다운 복사</button>
          </div>`;

        Swal.fire({
          title: '문서 구조',
          html: `${buttonsHtml}<div class="text-start">${treeHtml}</div>`,
          width: 600,
          confirmButtonText: '닫기',
          customClass: { htmlContainer: 'text-start' }
        });
      } catch (err) {
        console.error(err);
        Swal.fire('오류', '하위 문서를 불러오는 데 실패했습니다.', 'error');
      }
    }

    async function copySubdocsPopup(btn, format) {
      const data = window.__subdocsCopyData;
      if (!data) return;
      const text = format === 'md' ? data.md : data.plain;
      try {
        await navigator.clipboard.writeText(text);
        const original = btn.innerHTML;
        btn.innerHTML = '<i class="bi bi-check2"></i> 복사됨';
        btn.classList.remove('btn-outline-secondary');
        btn.classList.add('btn-success');
        setTimeout(() => {
          btn.innerHTML = original;
          btn.classList.remove('btn-success');
          btn.classList.add('btn-outline-secondary');
        }, 1500);
      } catch (err) {
        console.error('복사 실패:', err);
      }
    }

    // 대체 title 이 설정된 문서에서 h1 아래에 표시되는 실제 슬러그 라벨.
    // slug=null 이면 라벨을 숨긴다 (title 미설정 문서 또는 비-문서 페이지에서 호출).
    // 정책 문서(이용약관/개인정보처리방침) 안내 배너 토글.
    // slug 가 wrangler.toml 의 TERMS_OF_SERVICE/PRIVACY_POLICY 와 일치하면 안내 문구를 노출,
    // 아니면 숨긴다. config 슬러그는 /api/config 에서 서버측 normalizeSlug 로 정규화되어 오므로
    // 여기서도 동일 정책(앞뒤 공백 + 앞뒤 슬래시 제거)으로 정규화해 비교한다(대소문자 구분).
    function renderPolicyDocBanner(slug) {
      const bannerEl = document.getElementById('policyDocBanner');
      const textEl = document.getElementById('policyDocBannerText');
      if (!bannerEl || !textEl) return;
      bannerEl.classList.add('d-none');
      const cfg = window.appConfig || {};
      const curSlug = (slug || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
      if (!curSlug) return;
      let policyLabel = '';
      if (cfg.termsOfServiceSlug && curSlug === cfg.termsOfServiceSlug) policyLabel = '이용약관';
      else if (cfg.privacyPolicySlug && curSlug === cfg.privacyPolicySlug) policyLabel = '개인정보처리방침';
      if (!policyLabel) return;
      const wikiName = cfg.wikiName || 'CloudWiki';
      textEl.textContent = `이 문서는 ${wikiName}의 ${policyLabel} 문서입니다.`;
      bannerEl.classList.remove('d-none');
    }

    function renderSlugLabel(slug) {
      const el = document.getElementById('articleSlugLabel');
      if (!el) return;
      if (!slug) {
        el.hidden = true;
        el.innerHTML = '';
        return;
      }
      el.hidden = false;
      el.innerHTML = '';
      const code = document.createElement('code');
      code.className = 'text-muted';
      code.textContent = slug;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-sm btn-link text-muted p-0 ms-1 wiki-slug-copy-btn';
      btn.title = '제목 복사';
      btn.setAttribute('aria-label', '제목 복사');
      btn.innerHTML = '<i class="bi bi-clipboard" aria-hidden="true"></i>';
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(slug);
          const icon = btn.querySelector('i');
          if (icon) {
            icon.className = 'bi bi-check2';
            setTimeout(() => { icon.className = 'bi bi-clipboard'; }, 1500);
          }
          Swal.fire({
            icon: 'success',
            title: '제목이 복사되었습니다',
            toast: true,
            position: 'top-end',
            timer: 2000,
            showConfirmButton: false,
          });
        } catch (e) {
          console.error('슬러그 복사 실패:', e);
        }
      });
      el.appendChild(code);
      el.appendChild(btn);
    }

    async function showArticle(slug) {
      showLoading();
      currentSlug = slug;
      // 커맨드 팔레트 편집 단축키용 정식 편집 대상 초기화 — 일반 문서 분기에서만 다시 설정한다
      // (이미지/map/카테고리 폴백/없음/비공개/삭제 화면은 null 유지 → 편집 액션·`e` 비활성).
      window.currentArticleEdit = null;

      // Raw 보기 모드 초기화 — 모든 early-return 분기(404 카테고리 폴백, 403, 410 등) 이전에 수행
      // 이전 문서에서 활성화된 raw-mode 가 남아 있으면 body.raw-mode 스타일이 다음 페이지의
      // .wiki-content 를 숨기고 #articleRawContent 에 이전 문서의 본문이 노출될 수 있음
      _exitRawMode();
      const _rawElReset = document.getElementById('articleRawContent');
      if (_rawElReset) _rawElReset.textContent = '';

      // 목차 섹션 및 FAB 초기화 (이전 익스텐션 문서에서 숨겨진 경우 복원)
      document.getElementById('wikiAccordion').classList.remove('d-none');
      const _tocFabBtn = document.getElementById('tocFabBtn');
      if (_tocFabBtn) _tocFabBtn.classList.remove('d-none');

      // 공유하기 드롭다운 초기화 (이전 익스텐션 문서에서 숨겨진 경우 복원)
      ['shareItemCopyText', 'shareItemCopyMarkdown', 'shareItemPrint',
        'shareAiDivider', 'shareItemAskClaude', 'shareItemAskChatGPT'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('d-none');
      });

      try {
        let page;

        // SSR 데이터가 있고, 현재 slug와 일치하면 API 호출 없이 사용
        if (ssrData && ssrData._ssrSlug === slug) {
          if (ssrData._ssrNotFound) {
            if (ssrData._ssrPrivate) {
              hideAllPages();
              document.getElementById('privatePage').classList.remove('d-none');
              document.getElementById('privateSlug').textContent = `"${decodeURIComponent(slug)}" 문서는 비공개 상태입니다.`;
              document.title = `비공개 문서 - ${window.appConfig.wikiName}`;

              if (typeof window.__sidebarLayoutUpdate === 'function') window.__sidebarLayoutUpdate();
              return;
            }
            if (ssrData._ssrDeleted) {
              hideAllPages();
              document.getElementById('deletedPage').classList.remove('d-none');
              document.getElementById('deletedSlug').textContent = `"${decodeURIComponent(slug)}" 문서는 삭제되었습니다.`;
              document.title = `삭제된 문서 - ${window.appConfig.wikiName}`;

              // 삭제된 문서 화면이 보이도록 렌더링 강제 업데이트
              if (typeof window.__sidebarLayoutUpdate === 'function') window.__sidebarLayoutUpdate();
              // page_missing(대상 삭제)·slug_soft_deleted 요청도 이 화면에서 검토(주로 반려)할 수 있게 노출.
              surfaceEditRequestsOn('deletedPageEditRequest', slug);
              return;
            }

            // 카테고리 문서 체크
            const decodedSlug = decodeURIComponent(slug);
            if (decodedSlug.startsWith('카테고리:')) {
              await showCategoryArticle(slug, decodedSlug);
              return;
            }

            hideAllPages();
            document.getElementById('notFoundPage').classList.remove('d-none');
            document.getElementById('notFoundSlug').textContent =
              `"${decodeURIComponent(slug)}" 문서가 아직 존재하지 않습니다.`;
            document.getElementById('createPageBtn').onclick = () => {
              window.location.href = `/edit?slug=${encodeURIComponent(slug)}`;
            };
            surfaceEditRequestsOn('notFoundEditRequest', slug);
            document.title = `문서 없음 - ${window.appConfig.wikiName}`;
            return;
          }
          page = ssrData;
          // SSR 데이터는 한 번만 사용 (이후 클라이언트 네비게이션 시에는 API 호출)
          ssrData = null;
        } else {
          // 클라이언트 사이드 네비게이션 — API로 문서 로드
          const search = window.location.search;
          const res = await fetch(`/api/w/${encodeURIComponent(slug)}${search}`);

          if (res.status === 410) {
            hideAllPages();
            document.getElementById('deletedPage').classList.remove('d-none');
            document.getElementById('deletedSlug').textContent = `"${decodeURIComponent(slug)}" 문서는 삭제되었습니다.`;
            document.title = `삭제된 문서 - ${window.appConfig.wikiName}`;

            // 삭제된 문서 화면이 보이도록 렌더링 강제 업데이트
            if (typeof window.__sidebarLayoutUpdate === 'function') window.__sidebarLayoutUpdate();
            // page_missing(대상 삭제)·slug_soft_deleted 요청도 이 화면에서 검토(주로 반려)할 수 있게 노출.
            surfaceEditRequestsOn('deletedPageEditRequest', slug);
            return;
          }

          if (res.status === 404) {
            const decodedSlug = decodeURIComponent(slug);
            if (decodedSlug.startsWith('카테고리:')) {
              await showCategoryArticle(slug, decodedSlug);
              return;
            }

            hideAllPages();
            document.getElementById('notFoundPage').classList.remove('d-none');
            document.getElementById('notFoundSlug').textContent =
              `"${decodeURIComponent(slug)}" 문서가 아직 존재하지 않습니다.`;
            document.getElementById('createPageBtn').onclick = () => {
              window.location.href = `/edit?slug=${encodeURIComponent(slug)}`;
            };
            surfaceEditRequestsOn('notFoundEditRequest', slug);
            document.title = `문서 없음 - ${window.appConfig.wikiName}`;
            return;
          }

          if (res.status === 403) {
            hideAllPages();
            document.getElementById('privatePage').classList.remove('d-none');
            document.getElementById('privateSlug').textContent = `"${decodeURIComponent(slug)}" 문서는 비공개 상태입니다.`;
            document.title = `비공개 문서 - ${window.appConfig.wikiName}`;

            if (typeof window.__sidebarLayoutUpdate === 'function') window.__sidebarLayoutUpdate();
            return;
          }

          if (!res.ok) throw new Error('문서 로딩 실패');
          page = await res.json();
        }

        // 이미지 문서 분기: 일반 문서 렌더링을 건너뛰고 전용 UI로 표시
        if (page && page.is_image_doc) {
          await showImageDocument(slug, page);
          return;
        }

        // map: 가상 문서 분기: 서버가 합성한 트리 마크다운을 일반 렌더 파이프라인으로 표시하되,
        // 편집/이력/토론 등 모든 액션은 비활성화한다 (실제 페이지가 아님).
        if (page && page.is_map_doc) {
          await showMapDocument(slug, page);
          return;
        }

        currentPage = page;
        applyShareAiVisibility(page);

        // 커맨드 팔레트 최근 방문 문서 기록 (일반 위키 문서 한정 — 이미지/map/카테고리 문서는
        // 위 분기에서 이미 return 되었거나 recordRecentDoc 내부에서 가상 네임스페이스로 제외됨).
        // 비공개 문서는 공유 localStorage(recentVisitedDocs)에 남기지 않는다 — 로그아웃/타 계정이
        // 같은 브라우저에서 팔레트를 열 때 /api/search/suggest 로는 발견 불가한 비공개 제목/슬러그가
        // 권한 검사 없이 노출되는 메타데이터 누출을 막기 위함.
        if (!page.is_private) window.recordRecentDoc?.(page.slug, page.title);

        // 표시 이름: title 이 있으면 그것을, 없으면 slug. 모든 호출(링크/API) 은 항상 page.slug 기준.
        const displayName = page.title || page.slug;
        document.title = `${displayName} - ${window.appConfig.wikiName}`;
        document.getElementById('articleTitle').textContent = displayName;
        renderSlugLabel(page.title ? page.slug : null);

        // 리다이렉트 안내
        const redirectMsgEl = document.getElementById('redirectMessage');
        redirectMsgEl.innerHTML = '';
        if (page.redirected_from) {
          redirectMsgEl.innerHTML = `
            <div class="alert alert-info py-1 px-2 mb-2 d-inline-block small">
            <i class="bi bi-arrow-return-right"></i>
            "${window.escapeHtml(page.redirected_from)}" 문서에서 넘어옴
            (<a href="/w/${encodeURIComponent(page.redirected_from)}?redirect=no" class="alert-link" onclick="navigateTo(this.getAttribute('href')); return false;">편집</a>)
            </div>
          `;
        }

        // 메타 정보
        const updatedDate = new Date(page.updated_at * 1000).toLocaleString('ko-KR');

        let badgesHtml = '';
        if (page.category) {
          const cats = page.category.split(',').map(c => c.trim()).filter(c => c);
          cats.forEach(cat => {
            badgesHtml += `<a href="#" data-cat="${window.escapeHtml(cat)}" onclick="showCategory(this.dataset.cat); return false;" class="badge bg-secondary text-decoration-none ms-2"><i class="bi bi-folder"></i> ${window.escapeHtml(cat)}</a>`;
          });
        }
        // edit_acl 에 플래그가 있으면 "편집 잠금" 배지 표시. 구 is_locked / 관리자 전용 배지 대체.
        // 호버 시 부트스트랩 popover 로 요구 권한 목록을 노출한다.
        let _aclFlags = [];
        try {
          const _acl = page.edit_acl ? JSON.parse(page.edit_acl) : null;
          if (_acl && Array.isArray(_acl.flags)) _aclFlags = _acl.flags;
        } catch { /* ignore */ }
        const _ACL_FLAG_LABELS = {
          aged: '가입 N일 이상',
          page_editor: '본 문서 편집 이력',
          any_editor: '임의 문서 편집 이력',
          admin_only: '관리자 전용',
        };
        const _ACL_FLAG_ORDER = ['aged', 'page_editor', 'any_editor', 'admin_only'];
        const _validAclFlags = _ACL_FLAG_ORDER.filter(f => _aclFlags.includes(f));
        if (_validAclFlags.length > 0) {
          const _popoverContent = '<ul class="mb-0 ps-3">'
            + _validAclFlags.map(f => `<li>${window.escapeHtml(_ACL_FLAG_LABELS[f])}</li>`).join('')
            + '</ul>';
          badgesHtml += `<span class="badge bg-danger ms-2 edit-lock-badge" tabindex="0" data-bs-toggle="popover" data-bs-trigger="hover focus" data-bs-placement="top" data-bs-html="true" data-bs-content="${window.escapeHtml(_popoverContent)}" style="cursor:help;"><i class="bi bi-lock-fill"></i> 편집 잠금</span>`;
        }
        if (page.is_private) {
          badgesHtml += `<span class="badge bg-danger ms-2"><i class="bi bi-eye-slash-fill"></i> 비공개 문서</span>`;
        }
        if (page.deleted_at) {
          badgesHtml += `<span class="badge bg-danger ms-2"><i class="bi bi-trash"></i> 삭제됨</span>`;
        }

        // SPA 네비게이션으로 articleMeta 가 통째로 갈리기 전, 직전 렌더에서 띄운
        // 편집 잠금 popover 인스턴스를 정리한다. dispose 를 건너뛰면 트리거 요소가
        // 사라진 뒤에도 body 에 orphan popover 가 남을 수 있다 (Bootstrap 경고).
        const _prevMeta = document.getElementById('articleMeta');
        if (_prevMeta && typeof bootstrap !== 'undefined') {
          _prevMeta.querySelectorAll('.edit-lock-badge[data-bs-toggle="popover"]').forEach(el => {
            if (el._lockPopover) {
              try { el._lockPopover.dispose(); } catch { /* ignore */ }
              el._lockPopover = null;
            }
          });
        }

        const isAdmin = window.currentUser && (window.currentUser.role === 'admin' || window.currentUser.role === 'super_admin');
        let viewCountBtnHtml = '';
        if (!page.is_private && isAdmin) {
          viewCountBtnHtml = `
            <button type="button" class="view-count-toggle" data-slug="${window.escapeHtml(page.slug)}" onclick="loadPageViewCount(this)" title="조회수 확인" aria-label="조회수 확인">
              <i class="bi bi-eye" aria-hidden="true"></i><span class="view-count-label"> 조회수</span>
            </button>
          `;
        }

        document.getElementById('articleMeta').innerHTML = `
      <span class="meta-item">마지막 수정 : ${updatedDate}</span>
      <span class="meta-item">v${page.version}</span>
      ${badgesHtml}
      ${viewCountBtnHtml}
      <button type="button" class="reading-mode-toggle" onclick="toggleReadingMode()" title="읽기 모드" aria-label="읽기 모드">
        <i class="bi bi-book" aria-hidden="true"></i><span class="reading-mode-toggle-label d-none d-sm-inline"> 읽기 모드</span>
      </button>
    `;

        // 편집 잠금 배지 popover 초기화 — 마우스 오버/포커스 시 요구 권한 표시.
        if (typeof bootstrap !== 'undefined') {
          document.querySelectorAll('#articleMeta .edit-lock-badge[data-bs-toggle="popover"]').forEach(el => {
            if (!el._lockPopover) {
              el._lockPopover = new bootstrap.Popover(el, {
                trigger: 'hover focus',
                container: 'body',
                animation: false,
                html: true,
              });
            }
          });
        }

        // MCP 편집 승인 대기 배너 — 로그인 유저 본인이 이 문서에 제출한 MCP 편집안이
        // 있을 때만 노출. (사용자×문서당 최대 1건 제약 — mcp_drafts UNIQUE(user_id, slug).)
        // SPA 네비게이션 race 회피를 위해 응답 시점에 currentPage 슬러그를 재확인한다.
        const _mcpBanner = document.getElementById('mcpSubmissionBanner');
        if (_mcpBanner) _mcpBanner.style.display = 'none';
        if (window.currentUser && _mcpBanner) {
          const _bannerSlug = page.slug;
          fetch('/api/mcp-submissions/count?slug=' + encodeURIComponent(_bannerSlug))
            .then(r => r.ok ? r.json() : { count: 0 })
            .then(data => {
              if (!data || !data.count) return;
              if (!currentPage || currentPage.slug !== _bannerSlug) return;
              _mcpBanner.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:0.75rem;padding:0.65rem 1rem;margin:0.5rem 0 1rem;border:1px solid #ffc107;background:rgba(255,193,7,0.10);border-radius:10px;font-size:0.95rem;';
              _mcpBanner.innerHTML = `
                <span><i class="bi bi-plug"></i> MCP 서버로 제출된 편집안이 존재합니다.</span>
                <a href="/mypage#mcp-submissions" class="btn btn-sm btn-warning"><i class="bi bi-eye"></i> 검토하기</a>
              `;
            })
            .catch(() => { });
        }

        // (편집 요청 배지/드롭다운은 articleEditBtn 렌더 이후로 이동 — surfaceArticleEditRequests 참조)
        const _pendingBanner = document.getElementById('pendingEditBanner');
        if (_pendingBanner) _pendingBanner.style.display = 'none';

        // 조회수는 이제 사용자가 조회수 확인 버튼을 클릭할 때만 로드됩니다 (loadPageViewCount 함수 참조).

        // redirect를 통해 문서를 조회한 경우, 액션 버튼에 실제 문서의 slug를 사용
        const actionSlug = page.slug || slug;

        // 액션 버튼
        const _hasColon = actionSlug.includes(':');

        // 편집 권한 확인
        const _aclAdminOnly = _aclFlags.includes('admin_only');
        const canEdit = window.currentUser && (isAdmin || !_aclAdminOnly);

        // 커맨드 팔레트 편집 단축키(`e`/"현재 문서 편집")용 정식 편집 대상 노출.
        // actionSlug 는 리다이렉트 시 canonical page.slug 이며, 편집 불가 시 null 로 비활성화한다.
        window.currentArticleEdit = canEdit ? { slug: actionSlug } : null;

        // 메인 액션 (편집, 이력, 토론)
        const mainActionsHtml = `
          <a id="articleEditBtn" href="/edit?slug=${encodeURIComponent(actionSlug)}"
             class="btn btn-outline-secondary ${canEdit ? '' : 'disabled'}"
             ${canEdit ? '' : 'tabindex="-1" aria-disabled="true"'}
             title="${canEdit ? '이 문서 편집' : '이 문서는 관리자만 편집할 수 있습니다'}"
             aria-label="${canEdit ? '편집' : '편집 (잠김)'}">
            <i class="bi bi-pencil" aria-hidden="true"></i><span class="d-none d-sm-inline"> 편집</span>
          </a>
          <a href="/w/${encodeURIComponent(actionSlug)}?mode=revisions" class="btn btn-outline-secondary" aria-label="이력">
            <i class="bi bi-clock-history" aria-hidden="true"></i><span class="d-none d-sm-inline"> 이력</span>
          </a>
          <a href="/w/${encodeURIComponent(actionSlug)}?mode=discussions" class="btn btn-outline-secondary" aria-label="토론">
            <i class="bi bi-chat-dots" aria-hidden="true"></i><span class="d-none d-sm-inline"> 토론</span>
          </a>
        `;
        document.getElementById('articleMainActions').innerHTML = mainActionsHtml;

        // 편집 요청 배지/드롭다운 — articleEditBtn 이 렌더된 뒤 실행해야 교체 대상이 존재한다.
        // 검토 가능한 편집 요청이 있고(서버 count>0, 검토 권한자 한정) 이 문서를 편집할 수 있는 사용자에게만
        // 노출(admin_only 잠금 문서는 제외 — 승인은 서버에서 ACL 재평가하므로 UI 도 일치). 상단 배너도 같은 검토 UI.
        const _canReviewEdit = window.currentUser && (isAdmin || !_aclAdminOnly);
        if (_canReviewEdit) {
          const _pendingSlug = page.slug;
          const _editSlug = actionSlug;
          fetch('/api/pending-edits/count?slug=' + encodeURIComponent(_pendingSlug))
            .then(r => r.ok ? r.json() : { count: 0 })
            .then(data => {
              if (!data || !data.count) return;
              if (!currentPage || currentPage.slug !== _pendingSlug) return;
              if (_pendingBanner) {
                _pendingBanner.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:0.75rem;padding:0.65rem 1rem;margin:0.5rem 0 1rem;border:1px solid #38BDF8;background:rgba(56,189,248,0.10);border-radius:10px;font-size:0.95rem;';
                _pendingBanner.innerHTML = `
                  <span><i class="bi bi-hourglass-split"></i> 검토 대기 중인 편집 요청이 ${data.count}건 있습니다.</span>
                  <button type="button" class="btn btn-sm" style="background:#38BDF8;color:#06283d;"><i class="bi bi-eye"></i> 검토하기</button>
                `;
                const bannerBtn = _pendingBanner.querySelector('button');
                if (bannerBtn) bannerBtn.addEventListener('click', () => reviewEditRequests(_pendingSlug));
              }
              // 편집 버튼 → 드롭다운(문서 편집하기 / 편집 요청 확인하기 N건). 하늘색 배지.
              const editBtn = document.getElementById('articleEditBtn');
              if (editBtn && !document.getElementById('articleEditGroup')) {
                const group = document.createElement('div');
                group.className = 'btn-group';
                group.id = 'articleEditGroup';
                group.innerHTML = `
                  <button type="button" class="btn btn-outline-secondary dropdown-toggle" data-bs-toggle="dropdown" aria-expanded="false" title="편집" aria-label="편집">
                    <i class="bi bi-pencil" aria-hidden="true"></i><span class="d-none d-sm-inline"> 편집</span>
                    <span class="badge rounded-pill ms-1" style="background:#38BDF8;color:#06283d;">${data.count}</span>
                  </button>
                  <ul class="dropdown-menu">
                    <li><a class="dropdown-item" href="/edit?slug=${encodeURIComponent(_editSlug)}"><i class="bi bi-pencil-square"></i> 문서 편집하기</a></li>
                    <li><button class="dropdown-item" type="button" id="reviewEditRequestsItem"><i class="bi bi-list-check"></i> 편집 요청 확인하기 (${data.count}건)</button></li>
                  </ul>
                `;
                editBtn.replaceWith(group);
                const reviewItem = group.querySelector('#reviewEditRequestsItem');
                if (reviewItem) reviewItem.addEventListener('click', () => reviewEditRequests(_pendingSlug));
              }
            })
            .catch(() => { });
        }

        // 더보기 액션
        let moreActionsHtml = `
          <li><button class="dropdown-item" type="button" onclick="scrollToBacklinks(); return false;">
            <i class="bi bi-link-45deg"></i> 역링크
          </button></li>
          <li><button class="dropdown-item" type="button" onclick="toggleRawMode(); return false;">
            <i class="bi bi-code-slash"></i> Raw 보기
          </button></li>
          <li><hr class="dropdown-divider"></li>
          <li><button class="dropdown-item${_hasColon ? ' disabled' : ''}" ${_hasColon ? 'disabled' : `data-slug="${window.escapeHtml(actionSlug)}" onclick="showSubdocs(this.dataset.slug); return false;"`}>
            <i class="bi bi-diagram-3"></i> 문서 구조 보기
          </button></li>
        `;

        if (window.currentUser) {
          moreActionsHtml += `
          <li>
            <button class="dropdown-item" id="watchToggleBtn" data-slug="${window.escapeHtml(actionSlug)}" onclick="openWatchMenu(this.dataset.slug); return false;">
              <i class="bi bi-eye"></i> <span id="watchToggleText">주시하기</span>
            </button>
          </li>
          `;

          // 카테고리 문서('카테고리:xxx') 인 경우 — 해당 카테고리에 속한 모든 문서의 편집을
          // 구독할 수 있는 별도 항목을 노출한다.
          const _decodedActionSlug = decodeURIComponent(actionSlug);
          if (_decodedActionSlug.startsWith('카테고리:')) {
            const _catName = _decodedActionSlug.slice('카테고리:'.length);
            moreActionsHtml += `
            <li>
              <button class="dropdown-item" id="catWatchBtn" data-category="${window.escapeHtml(_catName)}" onclick="toggleCategoryWatch(this.dataset.category); return false;">
                <i class="bi bi-folder"></i> <span id="catWatchText">카테고리 주시</span>
              </button>
            </li>
            `;
          }

          if (canEdit) {
            if (page.deleted_at && isAdmin) {
              moreActionsHtml += `
              <li><hr class="dropdown-divider"></li>
              <li><button class="dropdown-item text-success" data-slug="${window.escapeHtml(actionSlug)}" onclick="restorePage(this.dataset.slug); return false;">
                <i class="bi bi-arrow-counterclockwise"></i> 문서 복원
              </button></li>
              <li><button class="dropdown-item text-danger" data-slug="${window.escapeHtml(actionSlug)}" onclick="confirmHardDelete(this.dataset.slug); return false;">
                <i class="bi bi-trash-fill"></i> 영구 삭제 (최고 관리자)
              </button></li>
              `;
            } else if (!page.deleted_at) {
              if (isAdmin) {
                const _isCategoryPage = _decodedActionSlug.startsWith('카테고리:');
                const _categoryName = _isCategoryPage ? _decodedActionSlug.slice('카테고리:'.length) : '';
                const _permButton = _isCategoryPage
                  ? `<li><button class="dropdown-item" data-category="${window.escapeHtml(_categoryName)}" onclick="window.openCategoryAclModal && window.openCategoryAclModal(this.dataset.category); return false;">
                <i class="bi bi-shield-lock"></i> 권한 관리
              </button></li>`
                  : `<li><button class="dropdown-item" data-slug="${window.escapeHtml(actionSlug)}" onclick="window.openPermissionsModal && window.openPermissionsModal(this.dataset.slug); return false;">
                <i class="bi bi-shield-lock"></i> 권한 관리
              </button></li>`;
                moreActionsHtml += `
              <li><hr class="dropdown-divider"></li>
              ${_permButton}
              <li><button class="dropdown-item" data-slug="${window.escapeHtml(actionSlug)}" onclick="promptMove(this.dataset.slug); return false;">
                <i class="bi bi-arrows-move"></i> 문서 주소 변경
              </button></li>
              <li><button class="dropdown-item text-danger" data-slug="${window.escapeHtml(actionSlug)}" onclick="confirmDelete(this.dataset.slug); return false;">
                <i class="bi bi-trash"></i> 삭제
              </button></li>
                `;
              }
            }
          }
        }
        document.getElementById('articleMoreActions').innerHTML = moreActionsHtml;

        // 주시 상태 확인 (로그인 시)
        if (window.currentUser && document.getElementById('watchToggleBtn')) {
          loadWatchStatus(actionSlug);
        }
        if (window.currentUser && document.getElementById('catWatchBtn')) {
          const _decodedSlug = decodeURIComponent(actionSlug);
          if (_decodedSlug.startsWith('카테고리:')) {
            loadCategoryWatchStatus(_decodedSlug.slice('카테고리:'.length));
          }
        }

        // Raw 보기용 원본 컨텐츠 갱신 — showArticle 진입 시 이미 _exitRawMode() 로 상태를 초기화했으므로
        // 여기서는 새 문서 본문만 반영하면 됨
        const rawEl = document.getElementById('articleRawContent');
        if (rawEl) rawEl.textContent = page.content || '';

        // Markdown → HTML 렌더링 (common.js의 renderWikiContent 모듈 사용)
        // 익스텐션 데이터 문서(freq: 등)는 마크다운 렌더링 비활성화 — 익스텐션 렌더러로 표시
        const decodedSlugForExt = decodeURIComponent(slug);
        const enabledExts = (window.appConfig && window.appConfig.enabledExtensions) || [];
        const extPrefix = enabledExts.find(ext => decodedSlugForExt.startsWith(ext + ':'));
        if (extPrefix) {
          // 목차 섹션 전체 숨기기 (아코디언, 플로팅 FAB)
          document.getElementById('wikiAccordion').classList.add('d-none');
          const tocFabBtn = document.getElementById('tocFabBtn');
          if (tocFabBtn) tocFabBtn.classList.add('d-none');
          // 익스텐션 문서는 renderWikiContent 를 거치지 않아 generateTOC() 의 #tocNav 비움
          // 처리가 일어나지 않는다. 이전 문서의 TOC 가 남아 있으면 left-toc 모드의
          // syncLeftTocSidebar() 가 stale 한 목차를 좌측 사이드바에 복제하므로 직접 비운다.
          const _staleTocNav = document.getElementById('tocNav');
          if (_staleTocNav) _staleTocNav.innerHTML = '';

          // 공유하기 드롭다운에서 텍스트/마크다운 복사 및 인쇄 버튼 숨기기
          ['shareItemCopyText', 'shareItemCopyMarkdown', 'shareItemPrint'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.add('d-none');
          });

          const contentEl = document.getElementById('articleContent');
          const rawId = `ext-raw-collapse-${Date.now()}`;
          contentEl.innerHTML = `
            <div class="wiki-ext-doc-view">
              <div class="wiki-ext-doc-rendered" id="ext-doc-rendered"></div>
              <div class="wiki-ext-doc-raw-toggle mt-3">
                <button class="btn btn-sm btn-outline-secondary wiki-ext-raw-toggle-btn" type="button"
                  data-bs-toggle="collapse" data-bs-target="#${rawId}" aria-expanded="false" aria-controls="${rawId}">
                  <i class="bi bi-database"></i> Raw 데이터 보기
                </button>
              </div>
              <div class="collapse mt-2" id="${rawId}">
                <div class="wiki-ext-raw-data">
                  <div class="wiki-ext-raw-badge"><i class="bi bi-database"></i> ${window.escapeHtml(extPrefix)} raw 데이터</div>
                  <pre class="wiki-ext-raw-pre" id="ext-raw-pre"></pre>
                </div>
              </div>
            </div>`;

          // raw 데이터는 버튼 클릭 시에만 삽입 (지연 로드)
          const rawToggleBtn = contentEl.querySelector('.wiki-ext-raw-toggle-btn');
          const rawPreEl = contentEl.querySelector('#ext-raw-pre');
          let rawLoaded = false;
          rawToggleBtn.addEventListener('click', () => {
            if (!rawLoaded) {
              rawPreEl.textContent = page.content || '';
              rawLoaded = true;
            }
          });

          // 익스텐션 렌더러 호출 (비동기 로드 대기 포함)
          const renderedEl = document.getElementById('ext-doc-rendered');
          const extData = { content: page.content || '', slug: decodedSlugForExt };
          function _tryRenderExtDoc(retries) {
            if (!renderedEl || !renderedEl.isConnected) {
              return;
            }
            const renderer = window._extensionRenderers && window._extensionRenderers[extPrefix];
            if (renderer) {
              renderer(renderedEl, extData);
            } else if (retries > 0 && renderedEl.isConnected) {
              setTimeout(() => _tryRenderExtDoc(retries - 1), 200);
            } else if (renderedEl.isConnected) {
              renderedEl.innerHTML = `<div class="alert alert-warning"><i class="bi bi-exclamation-triangle"></i> ${window.escapeHtml(extPrefix)} 렌더러를 찾을 수 없습니다.</div>`;
            }
          }
          _tryRenderExtDoc(15);
        } else if (
          page.view_mode === 'presentation'
          && !document.body.classList.contains('reading-mode')
          && typeof window.renderPresentation === 'function'
        ) {
          // 프레젠테이션 문서: 본문을 `---` 기준으로 슬라이드 분할해 위키 레이아웃 안에서 인라인 덱으로 표시.
          // 헤더/사이드바/푸터는 그대로 유지되며, 컨트롤 바의 "전체화면" 버튼으로 풀스크린 발표 모드 진입.
          // 읽기 모드가 활성이면(위 조건에서 제외) 일반 렌더 경로로 폴백해 단일 문서처럼 본다.
          await window.renderPresentation(page.content || '', slug, 'articleContent', {
            palettes: page.used_palettes || null,
          });
        } else {
          await window.renderWikiContent(page.content || '', slug, 'articleContent', {
            showCategory: true,
            tocContainerId: 'tocContainer',
            tocNavId: 'tocNav',
            // 인라인 목차 카드는 항상 생성한다. left-toc 모드에선 좌측 사이드바와 함께
            // 둘 다 렌더하고 CSS(viewport)로 택일한다 — PC 는 좌측 사이드바, 모바일은
            // 인라인 카드(기본 모드와 동일).
            inlineTocLayout: true,
            collapsibleSections: true,
            enableSectionEdit: true,
            canEdit: canEdit,
            sectionEditSlug: actionSlug,
            palettes: page.used_palettes || null
          });
        }

        // 틀(Template) 문서인 경우 자동으로 역링크 로드
        // 템플릿: 접두사는 역링크 추적이 불가능하므로 섹션 노출 안 함
        const decodedSlug = decodeURIComponent(slug);
        const trackableTemplatePrefixes = ['틀:', 'template:'];
        const isTemplate = trackableTemplatePrefixes.some(p => decodedSlug.toLowerCase().startsWith(p.toLowerCase()));
        if (isTemplate) {
          document.querySelector('#backlinksSection h5').innerHTML = '<i class="bi bi-link-45deg"></i> 이 틀을 사용하는 문서';
          await loadBacklinks(slug);
        } else {
          document.querySelector('#backlinksSection h5').innerHTML = '<i class="bi bi-link-45deg"></i> 이 문서를 참조하는 문서';
          document.getElementById('backlinksSection').classList.add('d-none');
          document.getElementById('backlinksList').innerHTML = '';
        }

        // 토론 배너: 열린 토론이 있으면 표시
        const bannerEl = document.getElementById('discussionBanner');
        const bannerLinkEl = document.getElementById('discussionBannerLink');
        bannerEl.classList.add('d-none');
        try {
          const discRes = await fetch(`/api/discussions/${page.id}?status=open`);
          if (discRes.ok) {
            const discData = await discRes.json();
            if (discData.discussions && discData.discussions.length > 0) {
              bannerLinkEl.href = `/w/${encodeURIComponent(actionSlug)}?mode=discussions`;
              bannerEl.classList.remove('d-none');
            }
          }
        } catch (e) {
          // 배너 로딩 실패는 조용히 무시
        }

        // 정책 문서 안내 배너: 현재 문서가 이용약관/개인정보처리방침이면 표시
        renderPolicyDocBanner(page.slug);

        // 문서 구조 네비게이션 (최상위 문서 포함, 하위 문서 생성 버튼 노출)
        const parentDocsEl = document.getElementById('parentDocsNav');
        closeParentDocsSiblings();
        const parts = actionSlug.split('/');
        const segments = [];
        for (let i = 0; i < parts.length; i++) {
          const isCurrent = (i === parts.length - 1);
          const segSlug = parts.slice(0, i + 1).join('/');
          const parentSlug = i === 0 ? '' : parts.slice(0, i).join('/');
          const labelHtml = isCurrent
            ? `<span class="parent-docs-current fw-semibold">${window.escapeHtml(parts[i])}</span>`
            : `<a href="/w/${encodeURIComponent(segSlug)}" class="text-decoration-none wiki-spa-link">${window.escapeHtml(parts[i])}</a>`;
          // 최상위(i=0)는 화살표 없음. 그 외(중간/현재)에는 chevron 토글 부착
          const chevronHtml = i === 0
            ? ''
            : ` <button type="button" class="btn btn-link btn-sm p-0 align-baseline parent-docs-chevron" data-parent="${window.escapeHtml(parentSlug)}" data-current="${window.escapeHtml(parts[i])}" data-level="${i}" title="동일 단계 문서 보기" aria-label="동일 단계 문서 보기" aria-expanded="false"><i class="bi bi-chevron-down"></i></button>`;
          segments.push(`<span class="parent-docs-segment">${labelHtml}${chevronHtml}</span>`);
        }

        const canCreateSubdoc = !!(window.currentUser && window.currentUser.permissions && window.currentUser.permissions['wiki:edit']) && !actionSlug.includes(':');
        const subdocButtonHtml = canCreateSubdoc
          ? ` <span class="text-muted mx-1">/</span> <button type="button" class="btn btn-link btn-sm p-0 align-baseline parent-docs-create" data-slug="${window.escapeHtml(actionSlug)}" title="하위 문서 생성" aria-label="하위 문서 생성"><i class="bi bi-pencil-square"></i></button>`
          : '';

        parentDocsEl.innerHTML = `<span class="text-muted me-1">문서 구조:</span>${segments.join(' <span class="text-muted mx-1">/</span> ')}${subdocButtonHtml}`;
        parentDocsEl.querySelectorAll('.wiki-spa-link').forEach(link => {
          link.addEventListener('click', function (event) {
            event.preventDefault();
            navigateTo(this.getAttribute('href'));
          });
        });
        const createSubdocBtn = parentDocsEl.querySelector('.parent-docs-create');
        if (createSubdocBtn) {
          createSubdocBtn.addEventListener('click', function () {
            createSubdoc(this.dataset.slug);
          });
        }
        parentDocsEl.querySelectorAll('.parent-docs-chevron').forEach(btn => {
          btn.addEventListener('click', function () {
            toggleParentDocsSiblings(this);
          });
        });
        parentDocsEl.classList.remove('d-none');
        document.getElementById('parentDocsNavDivider').classList.remove('d-none');

        hideAllPages();
        document.getElementById('articlePage').classList.remove('d-none');
        // 사이드바 동기화는 hideAllPages 이후에 수행해야 한다 — hideAllPages 가 레이아웃 사이드바에
        // d-none 을 다시 부여하므로 그 전에 sync 해도 즉시 덮어써진다.
        syncSidebarsForLayout();
        if (typeof window.__sidebarLayoutUpdate === 'function') window.__sidebarLayoutUpdate();

        // 페이지가 d-none을 벗어난 다음 프레임에 해시 스크롤 수행 (초기 진입 시 hideAllPages
        // 이후 articlePage가 노출되기 전이라 scrollIntoView가 no-op이 되는 문제 방지)
        // 해시(섹션 앵커)가 우선. 해시가 없고 검색 결과에서 진입(?highlight=)한 경우엔
        // 매칭 단어로 스크롤·하이라이트한다.
        if (window.location.hash) {
          requestAnimationFrame(() => scrollToHash());
        } else {
          requestAnimationFrame(() => highlightSearchMatch());
        }

      } catch (err) {
        console.error(err);
        Swal.fire('오류', '문서를 불러오는 데 실패했습니다.', 'error');
        hideAllPages();
      }
    }

    // ── 하위 문서 생성 (문서 구조 네비게이션의 펜 버튼) ──
    async function createSubdoc(parentSlug) {
      if (!window.currentUser) {
        Swal.fire('알림', '로그인 후 하위 문서를 만들 수 있습니다.', 'info');
        return;
      }
      if (!(window.currentUser.permissions && window.currentUser.permissions['wiki:edit'])) {
        Swal.fire('권한 없음', '하위 문서를 만들 권한이 없습니다.', 'error');
        return;
      }
      const { value: subTitle } = await Swal.fire({
        title: '하위 문서 생성',
        input: 'text',
        inputLabel: `"${parentSlug}" 아래에 만들 하위 문서 이름`,
        inputPlaceholder: '하위 문서 이름',
        showCancelButton: true,
        confirmButtonText: '생성',
        cancelButtonText: '취소',
        inputValidator: (value) => {
          const trimmed = value ? value.trim() : '';
          if (!trimmed) return '이름을 입력해주세요.';
          if (trimmed.includes('/')) return '슬래시(/)는 포함할 수 없습니다.';
          if (trimmed.includes(':')) return '콜론(:)은 포함할 수 없습니다.';
        }
      });
      const trimmed = subTitle ? subTitle.trim() : '';
      if (!trimmed) return;
      const newSlug = `${parentSlug}/${trimmed}`;
      window.location.href = `/edit?slug=${encodeURIComponent(newSlug)}`;
    }

    // ── 문서 구조 chevron 토글: 동일 단계 문서 드롭다운 ──
    // 패널은 breadcrumb 와 wrapper 안에서 형제 노드로 둔다 (wrapper 가
    // position: relative). breadcrumb 의 innerHTML 가 재구성될 때 패널이
    // 함께 지워지지 않도록 별도 노드로 유지한다. wrapper 가 스크롤/리플로우
    // 될 때 함께 움직이므로 별도의 scroll 추적 로직은 필요 없다.
    let __parentDocsSiblingsReqSeq = 0;
    let __parentDocsSiblingsActiveBtn = null;
    function positionParentDocsSiblings(btn) {
      const panelEl = document.getElementById('parentDocsSiblings');
      const wrapperEl = document.getElementById('parentDocsNavWrapper');
      if (!panelEl || !wrapperEl) return;
      // 드롭다운의 좌측은 chevron 이 아니라 해당 breadcrumb 노드(세그먼트)
      // 시작점과 정렬한다.
      const anchorEl = btn.closest('.parent-docs-segment') || btn;
      const wrapperRect = wrapperEl.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      const anchorRect = anchorEl.getBoundingClientRect();

      panelEl.style.position = 'absolute';
      // 세로 위치는 chevron 바로 아래로 유지
      panelEl.style.top = `${Math.round(btnRect.bottom - wrapperRect.top + 4)}px`;

      // 화면 우측을 벗어나지 않도록 좌측 좌표를 viewport 기준으로 제한
      const desiredLeft = anchorRect.left - wrapperRect.left;
      const panelW = panelEl.offsetWidth || 192;
      const viewportW = document.documentElement.clientWidth;
      const maxLeftViewport = viewportW - panelW - 8; // viewport 우측 8px 여백
      const maxLeftRelative = Math.max(0, maxLeftViewport - wrapperRect.left);
      panelEl.style.left = `${Math.round(Math.min(desiredLeft, maxLeftRelative))}px`;
    }
    function closeParentDocsSiblings() {
      const panelEl = document.getElementById('parentDocsSiblings');
      const parentDocsEl = document.getElementById('parentDocsNav');
      if (parentDocsEl) {
        parentDocsEl.querySelectorAll('.parent-docs-chevron').forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-expanded', 'false');
        });
      }
      if (panelEl) {
        panelEl.classList.add('d-none');
        panelEl.innerHTML = '';
      }
      __parentDocsSiblingsActiveBtn = null;
      __parentDocsSiblingsReqSeq++; // 진행 중 응답 무효화
      document.removeEventListener('click', onParentDocsSiblingsOutsideClick, true);
      document.removeEventListener('keydown', onParentDocsSiblingsKeydown, true);
      window.removeEventListener('resize', onParentDocsSiblingsViewportChange);
    }
    function onParentDocsSiblingsOutsideClick(ev) {
      const panelEl = document.getElementById('parentDocsSiblings');
      if (panelEl && panelEl.contains(ev.target)) return;
      if (__parentDocsSiblingsActiveBtn && __parentDocsSiblingsActiveBtn.contains(ev.target)) return;
      closeParentDocsSiblings();
    }
    function onParentDocsSiblingsKeydown(ev) {
      if (ev.key === 'Escape') {
        // closeParentDocsSiblings() 호출 시 활성 버튼 참조가 사라지므로
        // 포커스를 되돌릴 트리거를 먼저 캡쳐해둔다.
        const triggerBtn = __parentDocsSiblingsActiveBtn;
        closeParentDocsSiblings();
        if (triggerBtn) triggerBtn.focus();
      }
    }
    function onParentDocsSiblingsViewportChange() {
      // 리사이즈 등으로 breadcrumb 가 리플로우되면 chevron 위치도 바뀌므로 재배치
      if (__parentDocsSiblingsActiveBtn) positionParentDocsSiblings(__parentDocsSiblingsActiveBtn);
    }

    async function toggleParentDocsSiblings(btn) {
      const panelEl = document.getElementById('parentDocsSiblings');
      if (!panelEl) return;
      const parentSlug = btn.dataset.parent || '';
      const currentName = btn.dataset.current || '';
      const wasActive = btn.classList.contains('active');

      // 일단 닫기 (다른 chevron 도 함께 비활성화)
      closeParentDocsSiblings();

      if (wasActive) return; // 같은 chevron 재클릭 → 닫기만

      const reqId = ++__parentDocsSiblingsReqSeq;
      __parentDocsSiblingsActiveBtn = btn;
      btn.classList.add('active');
      btn.setAttribute('aria-expanded', 'true');

      panelEl.classList.remove('d-none');
      panelEl.setAttribute('role', 'menu');
      panelEl.innerHTML = `<span class="parent-docs-siblings-status"><span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>불러오는 중...</span>`;
      positionParentDocsSiblings(btn);

      document.addEventListener('click', onParentDocsSiblingsOutsideClick, true);
      document.addEventListener('keydown', onParentDocsSiblingsKeydown, true);
      window.addEventListener('resize', onParentDocsSiblingsViewportChange);

      try {
        const res = await fetch(`/api/w/${encodeURIComponent(parentSlug)}/subdocs?immediate=1`);
        if (reqId !== __parentDocsSiblingsReqSeq) return;
        if (!res.ok) throw new Error('failed');
        const data = await res.json();
        if (reqId !== __parentDocsSiblingsReqSeq) return;
        const docs = (data.subdocs || []).filter(d => {
          const rel = d.slug.substring(parentSlug.length + 1);
          return rel !== currentName;
        });

        if (docs.length === 0) {
          panelEl.innerHTML = `<span class="parent-docs-siblings-status fst-italic">동일 단계 문서가 없습니다</span>`;
          positionParentDocsSiblings(btn);
          return;
        }

        const items = docs.map(d => {
          const rel = d.slug.substring(parentSlug.length + 1);
          return `<a href="/w/${encodeURIComponent(d.slug)}" role="menuitem" class="parent-docs-sibling-item wiki-spa-link" title="${window.escapeHtml(d.slug)}">${window.escapeHtml(rel)}</a>`;
        }).join('');
        panelEl.innerHTML = items;
        panelEl.querySelectorAll('.wiki-spa-link').forEach(link => {
          link.addEventListener('click', function (event) {
            event.preventDefault();
            const href = this.getAttribute('href');
            closeParentDocsSiblings();
            navigateTo(href);
          });
        });
        positionParentDocsSiblings(btn);
      } catch (err) {
        if (reqId !== __parentDocsSiblingsReqSeq) return;
        console.error(err);
        panelEl.innerHTML = `<span class="parent-docs-siblings-status">불러오기 실패</span>`;
        positionParentDocsSiblings(btn);
      }
    }

    // ── 이미지 문서 (미디어 기반) ──
    async function showImageDocument(slug, page) {
      currentPage = page;
      applyShareAiVisibility(page);
      document.title = `${page.slug} - ${window.appConfig.wikiName}`;

      // 제목/메타 — 이미지 문서는 별도 title 컬럼을 갖지 않으므로 항상 슬러그만 표시.
      document.getElementById('articleTitle').textContent = page.slug;
      renderSlugLabel(null);
      document.getElementById('redirectMessage').innerHTML = '';

      // 토론 배너 초기화: 이전 문서에서 열린 토론이 있었다면 배너가 남아 다른 슬러그를
      // 가리킬 수 있으므로, 이미지 문서 진입 시 항상 숨기고 링크를 비운다.
      const _imgBannerEl = document.getElementById('discussionBanner');
      const _imgBannerLinkEl = document.getElementById('discussionBannerLink');
      if (_imgBannerEl) _imgBannerEl.classList.add('d-none');
      if (_imgBannerLinkEl) _imgBannerLinkEl.removeAttribute('href');
      // 정책 문서 안내 배너도 잔존 방지를 위해 함께 초기화(이미지 문서는 정책 문서가 아님).
      renderPolicyDocBanner(page.slug);

      const media = page.media || {};
      const sizeStr = (media.size || 0) < 1024 ? `${media.size} B`
        : media.size < 1024 * 1024 ? `${(media.size / 1024).toFixed(1)} KB`
          : `${(media.size / (1024 * 1024)).toFixed(1)} MB`;
      const uploadDate = page.created_at
        ? new Date(page.created_at * 1000).toLocaleString('ko-KR')
        : '';
      const uploaderName = media.uploader_name ? window.escapeHtml(media.uploader_name) : '알 수 없음';

      document.getElementById('articleMeta').innerHTML = `
        <span class="meta-item">업로드: ${window.escapeHtml(uploadDate)}</span>
        <span class="meta-item">${window.escapeHtml(sizeStr)}</span>
        <span class="meta-item">업로더: ${uploaderName}</span>
        <span class="meta-item"><code>${window.escapeHtml(media.mime_type || '')}</code></span>
      `;

      // 액션 버튼: 편집/원본 열기
      // 편집 권한은 서버 RBAC가 부여한 wiki:edit 플래그를 그대로 따른다.
      // /api/me 가 permissions를 내려주므로 그 값을 사용하고, 비로그인은 currentUser가 null이다.
      const canEditImage = !!(window.currentUser && window.currentUser.permissions && window.currentUser.permissions['wiki:edit']);
      const editTitle = !window.currentUser
        ? '로그인 후 편집 가능'
        : (canEditImage ? '설명 편집' : '편집 권한이 없습니다');
      const filename = media.filename || page.slug.replace(/^이미지:/, '');
      document.getElementById('articleMainActions').innerHTML = `
        <button type="button" class="btn btn-outline-secondary ${canEditImage ? '' : 'disabled'}"
                ${canEditImage ? '' : 'disabled aria-disabled="true"'} onclick="editImageDocContent(); return false;"
                title="${editTitle}">
          <i class="bi bi-pencil"></i><span class="d-none d-sm-inline"> 편집</span>
        </button>
        <a href="${window.escapeHtml(media.url || '')}" target="_blank" rel="noopener" class="btn btn-outline-secondary">
          <i class="bi bi-box-arrow-up-right"></i><span class="d-none d-sm-inline"> 원본 열기</span>
        </a>
      `;
      document.getElementById('articleMoreActions').innerHTML = '';

      // 목차 / 부모 문서 영역 숨김 (이미지 문서는 목차/부모 문서 개념 없음)
      document.getElementById('wikiAccordion').classList.add('d-none');
      const tocFab = document.getElementById('tocFabBtn');
      if (tocFab) tocFab.classList.add('d-none');
      document.getElementById('parentDocsNav').classList.add('d-none');
      closeParentDocsSiblings();
      document.getElementById('parentDocsNavDivider').classList.add('d-none');
      // 역링크 섹션: 일반 문서와 달리 이미지 문서는 열람 즉시 자동 로드
      document.querySelector('#backlinksSection h5').innerHTML = '<i class="bi bi-link-45deg"></i> 이 이미지를 사용하는 문서';
      document.getElementById('backlinksSection').classList.add('d-none');
      document.getElementById('backlinksList').innerHTML = '';

      // Raw 보기용 원본 컨텐츠
      const rawEl = document.getElementById('articleRawContent');
      if (rawEl) rawEl.textContent = page.content || '';

      // 본문: 이미지 + 이스케이프된 content 텍스트
      const isVideo = (media.mime_type || '').startsWith('video/');
      const mediaHtml = isVideo
        ? `<video src="${window.escapeHtml(media.url || '')}" controls class="img-fluid"></video>`
        : `<img src="${window.escapeHtml(media.url || '')}" alt="${window.escapeHtml(filename)}" class="img-fluid">`;
      const contentHtml = page.content
        ? `<pre class="wiki-image-doc-content">${window.escapeHtml(page.content)}</pre>`
        : '<p class="text-muted">아직 설명이 작성되지 않았습니다.</p>';
      const tagsHtml = renderImageDocTagsHtml(media.tags);

      const contentEl = document.getElementById('articleContent');
      contentEl.innerHTML = `
        <div class="wiki-image-doc-view">
          <div class="wiki-image-doc-media">${mediaHtml}</div>
          <div class="wiki-image-doc-text" id="wikiImageDocText">${contentHtml}</div>
          <div class="wiki-image-doc-tags" id="wikiImageDocTags">${tagsHtml}</div>
        </div>
      `;

      hideAllPages();
      document.getElementById('articlePage').classList.remove('d-none');
      if (typeof window.__sidebarLayoutUpdate === 'function') window.__sidebarLayoutUpdate();

      // 이미지 문서는 일반 문서와 달리 역링크를 자동으로 로드한다
      // (일반 문서는 역링크 버튼 클릭 시 로드)
      loadImageBacklinks(filename);
    }

    // ── map: 가상 문서 (하위 트리 + TOC) ──
    // 서버가 합성한 트리 마크다운(<div class="wiki-map-tree">...) 을 일반 위키 렌더 파이프라인으로
    // 표시한다. 본문에 헤딩이 없어 자동 TOC 패널은 비어있고, 모든 편집 액션은 비활성화한다.
    async function showMapDocument(slug, page) {
      currentPage = page;
      applyShareAiVisibility(page);
      document.title = `${page.slug} - ${window.appConfig.wikiName}`;

      document.getElementById('articleTitle').textContent = page.slug;
      renderSlugLabel(null);
      document.getElementById('redirectMessage').innerHTML = '';

      const _bannerEl = document.getElementById('discussionBanner');
      const _bannerLinkEl = document.getElementById('discussionBannerLink');
      if (_bannerEl) _bannerEl.classList.add('d-none');
      if (_bannerLinkEl) _bannerLinkEl.removeAttribute('href');
      // 정책 문서 안내 배너도 잔존 방지를 위해 함께 초기화(map 가상 문서는 정책 문서가 아님).
      renderPolicyDocBanner(page.slug);
      // 일반 문서에서 노출된 MCP 편집 승인 대기 배너 잔존 방지 (SPA 전이 시).
      const _mcpBannerEl = document.getElementById('mcpSubmissionBanner');
      if (_mcpBannerEl) _mcpBannerEl.style.display = 'none';

      const baseSlug = page.slug.replace(/^map:/, '');
      const _mapIsAdmin = !!(window.currentUser && (window.currentUser.role === 'admin' || window.currentUser.role === 'super_admin'));
      // SSR 단계에서 ?perms=1 이 isAdmin 일 때만 활성화돼 _ssrShowPerms 로 내려온다.
      // 비관리자가 강제로 ?perms=1 을 붙여도 서버가 false 로 정규화하므로 신뢰 가능.
      const _mapPermsActive = !!(page && page._ssrShowPerms);
      // localStorage 자동 복원: 관리자이고, 현재 URL 에 perms 쿼리가 없는데 저장값이 ON 이면 ?perms=1 로 즉시 교체한다.
      // 비관리자에게는 의미가 없으므로 건너뛴다. 무한 루프 방지를 위해 URL 에 perms 가 있으면 복원 시도 자체를 안 함.
      if (_mapIsAdmin) {
        try {
          const _url0 = new URL(window.location.href);
          if (!_url0.searchParams.has('perms') && localStorage.getItem('mapShowPerms') === '1') {
            _url0.searchParams.set('perms', '1');
            window.location.replace(_url0.toString());
            return;
          }
        } catch (_) { /* localStorage 비활성 환경 등 — 무시 */ }
      }
      const _permsToggleHtml = _mapIsAdmin
        ? `<label class="meta-item" style="cursor:pointer; user-select:none;">
             <input type="checkbox" id="mapPermsToggle"${_mapPermsActive ? ' checked' : ''} style="vertical-align:middle; margin-right:4px;">
             <i class="bi bi-shield-lock"></i> 권한 표시
           </label>`
        : '';
      document.getElementById('articleMeta').innerHTML = `
        <span class="meta-item"><i class="bi bi-diagram-3"></i> 지도 뷰</span>
        <span class="meta-item">루트: ${window.escapeHtml(baseSlug || '(전체)')}</span>
        ${_permsToggleHtml}
      `;
      if (_mapIsAdmin) {
        const _toggleEl = document.getElementById('mapPermsToggle');
        if (_toggleEl) {
          _toggleEl.addEventListener('change', () => {
            const _next = _toggleEl.checked;
            try { localStorage.setItem('mapShowPerms', _next ? '1' : '0'); } catch (_) { /* ignore */ }
            const _url = new URL(window.location.href);
            if (_next) _url.searchParams.set('perms', '1');
            else _url.searchParams.delete('perms');
            window.location.assign(_url.toString());
          });
        }
      }

      // 액션 버튼: 편집/이력 등은 모두 비활성화. 루트 문서로 이동하는 바로가기만 노출한다.
      const rootHref = baseSlug ? `/w/${encodeURIComponent(baseSlug)}` : '/';
      document.getElementById('articleMainActions').innerHTML = baseSlug
        ? `<a href="${window.escapeHtml(rootHref)}" class="btn btn-outline-secondary" onclick="navigateTo(this.getAttribute('href')); return false;">
             <i class="bi bi-box-arrow-up-right"></i><span class="d-none d-sm-inline"> 루트 문서로 이동</span>
           </a>`
        : '';
      document.getElementById('articleMoreActions').innerHTML = '';

      // 목차/부모 문서/역링크 영역 모두 숨김 (가상 문서)
      document.getElementById('wikiAccordion').classList.add('d-none');
      const tocFab = document.getElementById('tocFabBtn');
      if (tocFab) tocFab.classList.add('d-none');
      document.getElementById('parentDocsNav').classList.add('d-none');
      closeParentDocsSiblings();
      document.getElementById('parentDocsNavDivider').classList.add('d-none');
      document.getElementById('backlinksSection').classList.add('d-none');
      document.getElementById('backlinksList').innerHTML = '';

      const rawEl = document.getElementById('articleRawContent');
      if (rawEl) rawEl.textContent = page.content || '';

      // 본문은 일반 위키 렌더러로 처리한다. wiki-map-tree div 안의 [[...]] 위키 링크가
      // render.ts 의 parseWikiLinks 에 의해 자동으로 anchor 로 치환된다.
      await window.renderWikiContent(page.content || '', slug, 'articleContent', {
        showCategory: false,
        canEdit: false,
        enableSectionEdit: false,
        collapsibleSections: false,
      });

      hideAllPages();
      document.getElementById('articlePage').classList.remove('d-none');
      if (typeof window.__sidebarLayoutUpdate === 'function') window.__sidebarLayoutUpdate();
    }

    // 이미지 문서 본문 하단 태그 뱃지 HTML 생성
    function renderImageDocTagsHtml(tags) {
      if (!Array.isArray(tags) || tags.length === 0) {
        return '<span class="wiki-image-doc-tags-empty text-muted">태그 없음</span>';
      }
      const items = tags.map(t =>
        `<span class="category-tag"><span>${window.escapeHtml(t)}</span></span>`
      ).join('');
      return `<span class="wiki-image-doc-tags-label text-muted"><i class="mdi mdi-tag-multiple-outline"></i> 태그</span>${items}`;
    }

    // 이미지 문서 설명 편집 (모달)
    async function editImageDocContent() {
      if (!window.currentUser) {
        Swal.fire('알림', '로그인 후 편집할 수 있습니다.', 'info');
        return;
      }
      if (!(window.currentUser.permissions && window.currentUser.permissions['wiki:edit'])) {
        Swal.fire('권한 없음', '이 작업을 수행할 권한이 없습니다.', 'error');
        return;
      }
      if (!currentPage || !currentPage.is_image_doc) return;
      const filename = (currentPage.media && currentPage.media.filename)
        || currentPage.slug.replace(/^이미지:/, '');
      const initialTags = (currentPage.media && Array.isArray(currentPage.media.tags))
        ? currentPage.media.tags.slice()
        : [];

      let tagWidget = null;
      const { value: formResult, isConfirmed } = await Swal.fire({
        title: '이미지 문서 편집',
        width: 600,
        showCancelButton: true,
        confirmButtonText: '저장',
        cancelButtonText: '취소',
        focusConfirm: false,
        html: `
          <div style="text-align:left;">
            <label class="form-label fw-bold" style="display:block; margin-bottom:4px;">설명</label>
            <textarea id="imageDocContentInput" class="form-control" rows="6" maxlength="20000" style="width:100%;" placeholder="이미지에 대한 설명을 입력하세요 (일반 텍스트, 위키 문법은 사용되지 않습니다)">${window.escapeHtml(currentPage.content || '')}</textarea>
            <label class="form-label fw-bold" style="display:block; margin:14px 0 4px 0;">태그</label>
            <div class="category-tag-container" id="imageDocTagContainer" style="max-width:100%;">
              <input type="text" id="imageDocTagInput" class="category-tag-input" placeholder="태그 입력 후 엔터나 쉼표">
            </div>
            <div class="form-text text-muted" style="margin-top:4px; font-size:0.82rem;">한글/영문/숫자/공백/_/./- 만 사용 가능 · 최대 20개</div>
          </div>
        `,
        didOpen: () => {
          tagWidget = window.mountMediaTagInput({
            container: document.getElementById('imageDocTagContainer'),
            input: document.getElementById('imageDocTagInput'),
            initial: initialTags,
          });
          document.getElementById('imageDocContentInput').focus();
        },
        willClose: () => { if (tagWidget) tagWidget.destroy(); },
        preConfirm: () => {
          const content = document.getElementById('imageDocContentInput').value || '';
          if (tagWidget) tagWidget.flush();
          return { content, tags: tagWidget ? tagWidget.getTags() : initialTags };
        },
      });
      if (!isConfirmed || !formResult) return;
      const newContent = formResult.content;
      const newTags = formResult.tags;

      try {
        const res = await fetch(`/api/media/doc/${encodeURIComponent(filename)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: newContent || '', tags: newTags }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '저장 실패');

        currentPage.content = newContent || '';
        if (currentPage.media) currentPage.media.tags = Array.isArray(newTags) ? newTags.slice() : [];
        const textEl = document.getElementById('wikiImageDocText');
        if (textEl) {
          textEl.innerHTML = currentPage.content
            ? `<pre class="wiki-image-doc-content">${window.escapeHtml(currentPage.content)}</pre>`
            : '<p class="text-muted">아직 설명이 작성되지 않았습니다.</p>';
        }
        const tagsEl = document.getElementById('wikiImageDocTags');
        if (tagsEl) tagsEl.innerHTML = renderImageDocTagsHtml(currentPage.media && currentPage.media.tags);
        const rawEl = document.getElementById('articleRawContent');
        if (rawEl) rawEl.textContent = currentPage.content;

        Swal.fire({ icon: 'success', title: '저장되었습니다.', toast: true, position: 'top-end', timer: 1500, showConfirmButton: false });
      } catch (err) {
        console.error(err);
        Swal.fire('오류', err.message || '저장에 실패했습니다.', 'error');
      }
    }

    // ── 카테고리 문서 (문서가 없는 경우) ──
    async function showCategoryArticle(slug, decodedSlug) {
      const categoryName = decodedSlug.replace(/^카테고리:/, '');
      // 카테고리 페이지 진입 시 캐시를 무효화해 SPA 세션 중 mutation 이후의 stale 목록을 막는다.
      // 페이지네이션 버튼이 호출하는 fetchCategoryList 는 TTL 안에서 캐시를 재사용해 빠름.
      if (typeof window._wikiCategoryInvalidate === 'function') {
        window._wikiCategoryInvalidate(categoryName);
      }
      const listHtml = await fetchCategoryList(categoryName);

      applyShareAiVisibility(null);
      document.title = `${decodedSlug} - ${window.appConfig.wikiName}`;
      document.getElementById('articleTitle').textContent = decodedSlug;
      renderSlugLabel(null);
      document.getElementById('articleMeta').innerHTML = '<span class="text-muted">아직 작성되지 않은 카테고리 문서입니다.</span>';

      const watchBtn = window.currentUser
        ? `<button class="btn btn-outline-secondary" id="catWatchBtn" data-category="${window.escapeHtml(categoryName)}" onclick="toggleCategoryWatch(this.dataset.category); return false;">
            <i class="bi bi-eye"></i> <span id="catWatchText">카테고리 주시</span>
          </button>`
        : '';
      const actions = `
        <button class="btn btn-outline-secondary" onclick="window.location.href='/edit?slug=${encodeURIComponent(slug).replace(/'/g, "%27")}'">
          <i class="bi bi-pencil-square"></i> 카테고리 설명 생성
        </button>
        ${watchBtn}
      `;
      document.getElementById('articleMainActions').innerHTML = actions;
      const _catIsAdmin = window.currentUser && (window.currentUser.role === 'admin' || window.currentUser.role === 'super_admin');
      const _catMoreActionsHtml = _catIsAdmin
        ? `<li><button class="dropdown-item" data-category="${window.escapeHtml(categoryName)}" onclick="window.openCategoryAclModal && window.openCategoryAclModal(this.dataset.category); return false;">
            <i class="bi bi-shield-lock"></i> 권한 관리
          </button></li>`
        : '';
      document.getElementById('articleMoreActions').innerHTML = _catMoreActionsHtml;
      if (window.currentUser) loadCategoryWatchStatus(categoryName);
      document.getElementById('articleContent').innerHTML = listHtml;
      document.getElementById('tocContainer').classList.add('d-none');
      document.getElementById('docStatsCounter')?.classList.add('d-none');
      document.getElementById('backlinksSection').classList.add('d-none');
      document.getElementById('parentDocsNav').classList.add('d-none');
      closeParentDocsSiblings();
      document.getElementById('parentDocsNavDivider').classList.add('d-none');

      hideAllPages();
      document.getElementById('articlePage').classList.remove('d-none');
      if (typeof window.__sidebarLayoutUpdate === 'function') window.__sidebarLayoutUpdate();
    }

    // ── 백링크 로드 ──
    // url 인자로 fetch 엔드포인트를 다르게 지정할 수 있다 (이미지 문서 역링크 등).
    async function loadBacklinks(slug, url) {
      const section = document.getElementById('backlinksSection');
      const list = document.getElementById('backlinksList');
      const fetchUrl = url || `/api/w/${encodeURIComponent(slug)}/backlinks`;

      try {
        const res = await fetch(fetchUrl);
        if (!res.ok) {
          section.classList.add('d-none');
          return false;
        }

        const data = await res.json();

        if (data.backlinks && data.backlinks.length > 0) {
          list.innerHTML = data.backlinks.map(bl => {
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
                </a>
              `;
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
                </a>
              `;
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
                </a>
              `;
            }
            return `
              <a href="/w/${encodeURIComponent(bl.slug)}" onclick="navigateTo(this.href); return false;" class="list-group-item list-group-item-action d-flex justify-content-between align-items-center">
                  <div>
                      <span class="fw-bold">${window.escapeHtml(bl.slug)}</span>
                      ${deletedBadge}
                  </div>
                  <small class="text-muted">${date}</small>
              </a>
            `;
          }).join('');
          section.classList.remove('d-none');
          return true;
        } else {
          list.innerHTML = '<div class="text-muted text-center py-3">이 문서를 참조하는 문서가 없습니다.</div>';
          section.classList.add('d-none');
          return false;
        }
      } catch (e) {
        section.classList.add('d-none');
        return false;
      }
    }

    // ── 이미지 문서 역링크 로드 (열람 즉시 자동 호출) ──
    async function loadImageBacklinks(filename) {
      if (!filename) return false;
      return await loadBacklinks(null, `/api/media/doc/${encodeURIComponent(filename)}/backlinks`);
    }

    // ── 카테고리 보기 (문서로 이동) ──
    function showCategory(category) {
      navigateTo(`/w/카테고리:${category}`);
    }

    // ── 카테고리 목록 렌더링 ──
    // 동일 로직이 src/client/render.ts 의 fetchCategoryList 에도 존재.
    // 이 인라인 사본은 /dist/render.js 로딩 실패 시 fallback 역할.
    // 핵심 구현(그룹핑/페이지네이션 위임 핸들러)은 render.ts 가 담당하므로
    // 여기서는 render.ts 의 window.fetchCategoryList 가 정의돼 있으면 그것을 호출하고,
    // 없을 때만 단순 목록을 보여준다.
    async function fetchCategoryList(category, page) {
      if (typeof window.__wikiCategoryListBound !== 'undefined' && typeof window.fetchCategoryList === 'function' && window.fetchCategoryList !== fetchCategoryList) {
        return window.fetchCategoryList(category, page);
      }
      try {
        const res = await fetch(`/api/w/category/${encodeURIComponent(category)}`);
        if (!res.ok) return '';

        const data = await res.json();
        const pages = Array.isArray(data.pages) ? data.pages : [];
        if (pages.length === 0) {
          return '<div class="alert alert-light border text-center my-4">이 카테고리에 속한 문서가 없습니다.</div>';
        }
        const items = pages.map(p => {
          const slug = String(p.slug || '');
          return `<a class="category-item" href="/w/${encodeURIComponent(slug)}" onclick="navigateTo(this.href);return false;" title="${window.escapeHtml(slug)}"><span class="category-item-name">${window.escapeHtml(slug)}</span></a>`;
        }).join('');
        return `<div class="category-list mt-4">
          <h4><i class="bi bi-folder2-open"></i> "${window.escapeHtml(category)}" 카테고리에 속한 문서</h4>
          <div class="category-grid">${items}</div>
        </div>`;
      } catch (e) {
        console.error(e);
        return '<div class="alert alert-danger">카테고리 목록을 불러오는 데 실패했습니다.</div>';
      }
    }

    // ── 문서 이동/이름 변경 ──
    async function promptMove(slug) {
      // 1) 역링크 조회 (있으면 경고 다이얼로그 표시)
      let backlinks = [];
      try {
        const r = await fetch(`/api/w/${encodeURIComponent(slug)}/backlinks`);
        if (r.ok) backlinks = (await r.json()).backlinks || [];
      } catch (_) { /* 조회 실패 시 경고 없이 진행 (기존 동작 유지) */ }

      // 역링크 자동 수정 여부 — 기본 true.
      // /backlinks API는 self-link(WHERE p.slug != ?)을 제외하므로, 역링크 목록이 비어 있어도
      // 이동되는 페이지 본문의 자기참조(예: [[oldSlug]])는 여전히 갱신되어야 한다.
      // 따라서 기본값을 true로 두고, 경고 다이얼로그에서 사용자가 체크박스로 해제할 수 있게 한다.
      let updateBacklinks = true;

      if (backlinks.length > 0) {
        // 반환된 모든 역링크(API는 최대 100개)를 스크롤 가능한 리스트로 표시
        const listHtml = backlinks.map(b =>
          `<li><a href="/w/${encodeURIComponent(b.slug)}" target="_blank" rel="noopener">${window.escapeHtml(b.slug)}</a></li>`
        ).join('');
        const ok = await Swal.fire({
          title: '연결된 문서 경고',
          html: `<p class="text-start">이 문서로 연결된 <b>${backlinks.length}개</b>의 문서가 있습니다.<br>아래 옵션을 해제하면 이동 후 해당 링크들은 깨지게 됩니다.</p>
                 <ul class="text-start" style="max-height:200px;overflow:auto">${listHtml}</ul>
                 <label class="d-flex align-items-center gap-2 mt-3 text-start" style="cursor:pointer">
                   <input type="checkbox" id="rewriteBacklinksChk" checked />
                   <span>역링크 <b>${backlinks.length}개</b> 문서 본문도 자동으로 수정</span>
                 </label>`,
          icon: 'warning',
          showCancelButton: true,
          confirmButtonText: '계속 진행',
          cancelButtonText: '취소',
          preConfirm: () => {
            const chk = document.getElementById('rewriteBacklinksChk');
            return { rewrite: chk ? chk.checked : false };
          }
        });
        if (!ok.isConfirmed) return;
        updateBacklinks = Boolean(ok.value && ok.value.rewrite);
      }

      const { value: newSlug } = await Swal.fire({
        title: '문서 이동/이름 변경',
        input: 'text',
        inputLabel: '새로운 문서 이름',
        inputValue: slug,
        showCancelButton: true,
        confirmButtonText: '이동',
        cancelButtonText: '취소',
        inputValidator: (value) => {
          // 서버와 동일하게 앞뒤 공백/슬래시를 제거한 값을 기준으로 검증해
          // 정규화 후 의도와 다른 결과(자기 자신으로 이동, 네임스페이스 변경 등)를 차단한다.
          const trimmed = value ? value.trim().replace(/^\/+/, '').replace(/\/+$/, '') : '';
          if (!trimmed) return '새 이름을 입력해주세요.';
          if (trimmed === slug) return '현재 이름과 동일합니다.';
          const currentNs = slug.includes(':') ? slug.split(':')[0] : '';
          const newNs = trimmed.includes(':') ? trimmed.split(':')[0] : '';
          if (slug.includes(':') && currentNs !== newNs) return '네임스페이스가 있는 문서는 다른 네임스페이스로 이동할 수 없습니다.';
        }
      });

      // 서버 src/utils/slug.ts 의 normalizeSlug 와 동일한 정책으로 정규화.
      // 앞뒤 공백 + 앞뒤 슬래시('/') 를 제거해 서버 저장 키와 이동 후 redirect URL 을 일치시킨다.
      const trimmedSlug = newSlug ? newSlug.trim().replace(/^\/+/, '').replace(/\/+$/, '') : '';
      if (trimmedSlug) {
        // 이동/역링크 일괄 갱신이 끝날 때까지 화면 상호작용을 차단하는 로딩 다이얼로그
        Swal.fire({
          title: '문서 주소 변경 중...',
          html: updateBacklinks
            ? '역링크가 있는 다른 문서들의 본문도 함께 수정하고 있습니다.<br>잠시만 기다려주세요.'
            : '잠시만 기다려주세요.',
          allowOutsideClick: false,
          allowEscapeKey: false,
          showConfirmButton: false,
          didOpen: () => {
            Swal.showLoading();
          }
        });

        try {
          const res = await fetch(`/api/w/${encodeURIComponent(slug)}/move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ new_slug: trimmedSlug, update_backlinks: updateBacklinks })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || '이동 실패');

          let summaryHtml = '문서가 이동되었습니다.';
          let summaryIcon = 'success';
          let summaryTitle = '성공';
          if (data.backlinks_error) {
            // 이동은 성공했지만 역링크 갱신이 실패한 경우 — 경고로 명확히 표시
            summaryIcon = 'warning';
            summaryTitle = '이동 완료 (역링크 갱신 실패)';
            summaryHtml = `<p class="text-start">문서는 새 주소로 이동되었으나, <b>역링크 일괄 갱신 중 오류가 발생해 역링크 본문이 수정되지 않았습니다.</b><br>
              <small class="text-muted">오류: ${window.escapeHtml(data.backlinks_error)}</small><br>
              관리자 로그를 확인하고, 필요하면 역링크 문서를 수동으로 수정해주세요.</p>`;
          } else if (data.backlinks && (data.backlinks.total > 0 || data.backlinks.updated > 0)) {
            // 실제로 처리 대상이 있던 경우에만 요약 표시 (자동 갱신이 no-op였으면 기본 토스트 유지)
            const b = data.backlinks;
            const skippedList = (b.skipped && b.skipped.length)
              ? `<details class="text-start mt-2"><summary>건너뛴 문서 ${b.skipped.length}개</summary><ul style="max-height:160px;overflow:auto">${b.skipped.map(s => `<li>${window.escapeHtml(s)}</li>`).join('')}</ul></details>`
              : '';
            const conflictList = (b.conflicts && b.conflicts.length)
              ? `<details class="text-start mt-2"><summary>충돌 문서 ${b.conflicts.length}개 (수동 수정 필요)</summary><ul style="max-height:160px;overflow:auto">${b.conflicts.map(s => `<li>${window.escapeHtml(s)}</li>`).join('')}</ul></details>`
              : '';
            summaryHtml = `<p class="text-start">문서가 이동되었습니다.<br>
              역링크 <b>${b.updated}개</b> 갱신 · 건너뜀 <b>${b.skipped.length}개</b> · 충돌 <b>${b.conflicts.length}개</b>
              ${b.total > (b.updated + b.skipped.length + b.conflicts.length) ? `<br><small class="text-muted">총 ${b.total}개 중 상한으로 일부 처리</small>` : ''}
              </p>${skippedList}${conflictList}`;
            if (b.conflicts && b.conflicts.length > 0) {
              summaryIcon = 'warning';
              summaryTitle = '이동 완료 (일부 충돌)';
            }
          }

          Swal.fire({ title: summaryTitle, html: summaryHtml, icon: summaryIcon }).then(() => {
            navigateTo(`/w/${encodeURIComponent(trimmedSlug)}`);
          });
        } catch (err) {
          Swal.fire('오류', err.message, 'error');
        }
      }
    }

    // ── 문서 삭제 ──
    async function confirmDelete(slug) {
      const isAdmin = window.currentUser && (window.currentUser.role === 'admin' || window.currentUser.role === 'super_admin');
      const isSuperAdmin = window.currentUser && window.currentUser.role === 'super_admin';

      const { value: formValues } = await Swal.fire({
        title: '문서 삭제',
        html: `
          <p>정말 "${window.escapeHtml(slug)}" 문서를 삭제하시겠습니까?</p>
          ${isSuperAdmin ? `
            <div class="form-check text-start d-inline-block">
              <input class="form-check-input" type="checkbox" id="hardDeleteCheck">
              <label class="form-check-label text-danger fw-bold" for="hardDeleteCheck">
                영구 삭제 (복구 불가)
              </label>
            </div>
          ` : ''}
        `,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        confirmButtonText: '삭제',
        cancelButtonText: '취소',
        preConfirm: () => {
          return {
            hard: isSuperAdmin ? document.getElementById('hardDeleteCheck').checked : false
          };
        }
      });

      if (formValues) {
        try {
          const query = formValues.hard ? '?hard=true' : '';
          const res = await fetch(`/api/w/${encodeURIComponent(slug)}${query}`, {
            method: 'DELETE'
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || '삭제 실패');

          Swal.fire('삭제됨', data.message, 'success').then(() => {
            window.location.href = '/';
          });
        } catch (err) {
          Swal.fire('오류', err.message, 'error');
        }
      }
    }

    // ── 문서 영구 삭제 (최고 관리자) ──
    async function confirmHardDelete(slug) {
      const isSuperAdmin = window.currentUser && window.currentUser.role === 'super_admin';
      if (!isSuperAdmin) {
        Swal.fire('권한 없음', '영구 삭제는 최고 관리자만 가능합니다.', 'error');
        return;
      }

      const { isConfirmed } = await Swal.fire({
        title: '문서 영구 삭제',
        html: `<p>정말 "${window.escapeHtml(slug)}" 문서를 <b>영구 삭제</b>하시겠습니까?</p><p class="text-danger small">이 작업은 복구할 수 없습니다.</p>`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        confirmButtonText: '영구 삭제',
        cancelButtonText: '취소'
      });

      if (isConfirmed) {
        try {
          const res = await fetch(`/api/w/${encodeURIComponent(slug)}?hard=true`, {
            method: 'DELETE'
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || '삭제 실패');

          Swal.fire('영구 삭제됨', data.message, 'success').then(() => {
            window.location.href = '/';
          });
        } catch (err) {
          Swal.fire('오류', err.message, 'error');
        }
      }
    }

    // ── 문서 복원 (관리자) ──
    async function restorePage(slug) {
      const isAdmin = window.currentUser && (window.currentUser.role === 'admin' || window.currentUser.role === 'super_admin');
      if (!isAdmin) {
        Swal.fire('권한 없음', '복구는 관리자만 가능합니다.', 'error');
        return;
      }

      const { isConfirmed } = await Swal.fire({
        title: '문서 복원',
        text: `"${window.escapeHtml(slug)}" 문서를 복원하시겠습니까?`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: '복원',
        cancelButtonText: '취소'
      });

      if (isConfirmed) {
        try {
          const res = await fetch(`/api/w/${encodeURIComponent(slug)}/restore`, {
            method: 'POST'
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || '복원 실패');

          Swal.fire('복원됨', data.message, 'success').then(() => {
            window.location.href = `/w/${encodeURIComponent(slug)}`;
          });
        } catch (err) {
          Swal.fire('오류', err.message, 'error');
        }
      }
    }

    // ── 공유하기 기능 ──
    async function shareNative() {
      const cleanUrl = window.location.origin + window.location.pathname;
      const wikiName = typeof window.appConfig !== 'undefined' && window.appConfig.wikiName ? window.appConfig.wikiName : 'CloudWiki';
      const pageTitle = currentPage && currentPage.slug ? currentPage.slug : document.title;
      try {
        await navigator.share({
          title: `${wikiName} - ${pageTitle}`,
          text: `${wikiName} - ${pageTitle}`,
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
        Swal.fire({ icon: 'success', title: '복사 완료', text: '문서 링크가 클립보드에 복사되었습니다.', toast: true, position: 'top-end', timer: 1500, showConfirmButton: false });
      } catch (err) {
        console.error('복사 실패:', err);
        Swal.fire('오류', '클립보드 복사에 실패했습니다.', 'error');
      }
    }

    async function shareCopyText() {
      const content = document.getElementById('articleContent');
      if (!content) return;
      try {
        const text = typeof window.extractPlainTextWithFootnotes === 'function'
          ? window.extractPlainTextWithFootnotes(content)
          : content.innerText;
        await navigator.clipboard.writeText(text);
        Swal.fire({ icon: 'success', title: '복사 완료', text: '문서 내용이 클립보드에 복사되었습니다.', toast: true, position: 'top-end', timer: 1500, showConfirmButton: false });
      } catch (err) {
        console.error('복사 실패:', err);
        Swal.fire('오류', '클립보드 복사에 실패했습니다.', 'error');
      }
    }

    async function shareCopyMarkdown() {
      if (!currentPage || !currentPage.content) {
        Swal.fire('오류', '문서 내용을 가져올 수 없습니다.', 'error');
        return;
      }
      try {
        const resolvedContent = await window.resolveTransclusionsForMarkdown(
          currentPage.content,
          currentPage.slug || currentSlug
        );
        const pageTitle = currentPage.slug ? currentPage.slug : '';
        const markdownWithTitle = pageTitle ? pageTitle + '\n\n' + resolvedContent : resolvedContent;
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

    // AI 질문 옵션(Claude/ChatGPT)은 해당 문서를 비회원이 열람할 수 있을 때만 노출한다.
    // 위키 전체가 closed 상태(로그인 필수)이거나 페이지가 관리자용 비공개(is_private)면
    // 외부 AI 가 URL 을 가져올 수 없으므로 숨긴다.
    function applyShareAiVisibility(page) {
      const wikiOpen = !window.appConfig || window.appConfig.wikiVisibility !== 'closed';
      const isPrivate = !!(page && page.is_private);
      const canGuestRead = wikiOpen && !isPrivate;
      ['shareAiDivider', 'shareItemAskClaude', 'shareItemAskChatGPT'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('d-none', !canGuestRead);
      });
    }

    function shareAskClaude() {
      const cleanUrl = window.location.origin + window.location.pathname;
      const prompt = '다음 위키 페이지를 읽고 내용에 대한 질문에 답해줘: ' + cleanUrl;
      window.open('https://claude.ai/new?q=' + encodeURIComponent(prompt), '_blank');
    }

    function shareAskChatGPT() {
      const cleanUrl = window.location.origin + window.location.pathname;
      const prompt = '다음 위키 페이지를 읽고 내용에 대한 질문에 답해줘: ' + cleanUrl;
      window.open('https://chatgpt.com/?q=' + encodeURIComponent(prompt), '_blank');
    }

    // ── 네비게이션 ──
    function navigateTo(url) {
      // SPA는 위키 문서(/w/slug)와 루트(/)만 처리; 나머지는 풀 내비게이션
      const u = new URL(url, window.location.origin);
      const path = u.pathname;
      if (!path.match(/^\/w\/[^/]+$/) && path !== '/' && path !== '') {
        window.location.href = url;
        return;
      }
      history.pushState(null, '', url);
      _lastPath = u.pathname;
      _lastSearch = u.search;
      // 해시가 있으면 렌더 완료 후 showArticle 내부에서 scrollToHash() 처리
      if (!u.hash) {
        window.scrollTo({ top: 0, behavior: 'instant' });
      }
      route();
    }

    // 현재 URL의 해시에 해당하는 요소로 스크롤 (없으면 no-op)
    // 타겟이 접힌 섹션/fold/목차 아코디언 내부에 있으면 먼저 펼친 뒤,
    // 애니메이션이 끝난 좌표 기준으로 다시 한번 보정한다.
    function scrollToHash() {
      const hash = window.location.hash;
      if (!hash || hash.length < 2) return;
      let id;
      try {
        id = decodeURIComponent(hash.slice(1));
      } catch (_) {
        id = hash.slice(1);
      }
      const el = id ? document.getElementById(id) : null;
      if (el) {
        if (typeof window._scrollToElementWithAncestors === 'function') {
          window._scrollToElementWithAncestors(el, { behavior: 'instant', block: 'start' });
        } else {
          el.scrollIntoView({ behavior: 'instant', block: 'start' });
        }
      }
    }

    // 검색 결과(/search)에서 ?highlight=<검색어> 로 진입한 경우, 본문에서 해당 단어의
    // 첫 매칭 위치를 찾아 <mark class="search-hit"> 로 감싸고 그 위치로 스크롤한다.
    // 일회성 동작이므로 처리 후 URL 에서 highlight 파라미터를 제거한다(새로고침/공유 시 깔끔).
    function highlightSearchMatch() {
      const params = new URLSearchParams(window.location.search);
      const rawTerm = params.get('highlight');

      // 파라미터가 있으면 항상 URL 에서 제거한다(매치 실패 시에도 일회성 유지).
      if (rawTerm !== null) {
        params.delete('highlight');
        const qs = params.toString();
        const cleanUrl = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
        history.replaceState(null, '', cleanUrl);
        _lastSearch = qs ? `?${qs}` : '';
      }

      const term = (rawTerm || '').trim();
      if (!term) return;

      const container = document.getElementById('articleContent');
      if (!container) return;

      const mark = _markFirstTextMatch(container, term);
      if (!mark) return;

      if (typeof window._scrollToElementWithAncestors === 'function') {
        window._scrollToElementWithAncestors(mark, { behavior: 'instant', block: 'center' });
      } else {
        mark.scrollIntoView({ behavior: 'instant', block: 'center' });
      }
    }

    // 컨테이너 내부 텍스트 노드를 순회하며 term(대소문자 무시)의 첫 매칭을 찾아
    // <mark class="search-hit"> 로 감싼 뒤 그 요소를 반환한다. 매치가 없으면 null.
    function _markFirstTextMatch(container, term) {
      const lowerTerm = term.toLowerCase();
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const value = node.nodeValue;
          if (!value || !value.trim()) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          // 목차/스크립트/스타일/섹션 편집 버튼 등 본문이 아닌 영역은 제외한다.
          if (parent.closest('.wiki-toc, .toc, script, style, .wiki-section-edit-btn, .wiki-anchor')) {
            return NodeFilter.FILTER_REJECT;
          }
          return value.toLowerCase().includes(lowerTerm)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP;
        }
      });

      const textNode = walker.nextNode();
      if (!textNode) return null;
      const idx = textNode.nodeValue.toLowerCase().indexOf(lowerTerm);
      if (idx < 0) return null;

      // 단일 텍스트 노드 범위라 surroundContents 가 안전하게 동작한다(요소 경계 미포함).
      const range = document.createRange();
      range.setStart(textNode, idx);
      range.setEnd(textNode, idx + term.length);
      const mark = document.createElement('mark');
      mark.className = 'search-hit';
      try {
        range.surroundContents(mark);
      } catch (_) {
        return null;
      }
      return mark;
    }



    function goNewPage() {
      if (!window.currentUser) {
        Swal.fire({
          icon: 'info',
          title: '로그인 필요',
          text: '문서를 만들려면 먼저 로그인해주세요.',
          confirmButtonText: '로그인',
        }).then(result => {
          if (result.isConfirmed) window.location.href = '/login';
        });
        return;
      }

      Swal.fire({
        title: '새 문서 만들기',
        input: 'text',
        inputLabel: '문서 이름 (URL 경로)',
        inputPlaceholder: '예: my-first-page',
        showCancelButton: true,
        confirmButtonText: '만들기',
        cancelButtonText: '취소',
        inputValidator: (value) => {
          if (!value) return '문서 이름을 입력해주세요.';
          if (!/^[a-zA-Z0-9가-힣\-_ :]+$/.test(value)) return '영문, 한글, 숫자, -, _, 공백, 콜론(:) 만 사용 가능합니다.';
        }
      }).then(result => {
        if (result.isConfirmed) {
          window.location.href = `/edit?slug=${encodeURIComponent(result.value)}`;
        }
      });
    }

    // ── 유틸리티 ──

    function formatDate(ts) {
      return new Date(ts * 1000).toLocaleString('ko-KR');
    }

    // ── 최근 변경 내역 로드 ──
    // loadRecentChanges, getRelativeTime → common.js로 이동

    // ── 문서 주시 ──
    // 현재 문서의 주시 상태(scope 포함)를 메모리에 캐싱해 드롭다운 라벨 표시 시 재요청을 줄인다.
    // 빠른 네비게이션 시 이전 문서의 상태를 새 문서에 적용하지 않도록 slug 를 함께 보관한다.
    let _currentWatchState = { slug: null, watching: false, scope: null };

    async function loadWatchStatus(slug) {
      // 새 문서 로드 직후엔 항상 미주시 상태로 즉시 리셋해 stale UI 를 차단한다.
      _currentWatchState = { slug, watching: false, scope: null };
      updateWatchUI(_currentWatchState);
      try {
        const res = await fetch(`/api/w/${encodeURIComponent(slug)}/watch`);
        if (!res.ok) return;
        const data = await res.json();
        // 응답이 도착하기 전에 다른 문서로 이동했다면 적용하지 않는다 (race 방지).
        if (_currentWatchState.slug !== slug) return;
        _currentWatchState = { slug, watching: !!data.watching, scope: data.scope || null };
        updateWatchUI(_currentWatchState);
      } catch (e) { /* 무시 */ }
    }

    function updateWatchUI(state) {
      const btn = document.getElementById('watchToggleBtn');
      const text = document.getElementById('watchToggleText');
      if (!btn || !text) return;
      const icon = btn.querySelector('i');
      if (state && state.watching) {
        const scopeLabel = state.scope === 'subtree' ? '주시 중 (하위 문서 포함)' : '주시 중';
        text.textContent = scopeLabel;
        if (icon) { icon.className = 'bi bi-eye-fill'; }
      } else {
        text.textContent = '주시하기';
        if (icon) { icon.className = 'bi bi-eye'; }
      }
    }

    // 주시 옵션 선택 모달
    async function openWatchMenu(slug) {
      // 캐시된 상태가 이 슬러그 기준이 아니면 무조건 재조회한다.
      // (빠른 네비게이션 직후 캐시는 이전 문서의 상태일 수 있음)
      if (_currentWatchState.slug !== slug) {
        await loadWatchStatus(slug);
      }
      const cur = (_currentWatchState.slug === slug)
        ? _currentWatchState
        : { slug, watching: false, scope: null };
      const watching = !!cur.watching;
      const scope = cur.scope || null;

      const html = `
        <div class="text-start">
          <div class="form-check mb-2">
            <input class="form-check-input" type="radio" name="watchScope" id="watchScopeThis" value="this"
              ${(!watching || scope === 'this') ? 'checked' : ''}>
            <label class="form-check-label" for="watchScopeThis">
              <i class="bi bi-file-earmark-text"></i> 이 문서만 주시
              <div class="small text-muted">이 문서가 편집될 때만 알림을 받습니다.</div>
            </label>
          </div>
          <div class="form-check mb-2">
            <input class="form-check-input" type="radio" name="watchScope" id="watchScopeSubtree" value="subtree"
              ${scope === 'subtree' ? 'checked' : ''}>
            <label class="form-check-label" for="watchScopeSubtree">
              <i class="bi bi-diagram-3"></i> 하위 문서까지 주시
              <div class="small text-muted">이 문서와 모든 하위 문서(<code>${window.escapeHtml(slug)}/...</code>)의 편집 알림을 받습니다.</div>
            </label>
          </div>
        </div>
      `;

      const result = await Swal.fire({
        title: '문서 주시 설정',
        html,
        showCancelButton: true,
        showDenyButton: watching,
        confirmButtonText: watching ? '변경 저장' : '주시 시작',
        denyButtonText: '주시 해제',
        cancelButtonText: '닫기',
        focusConfirm: false,
        preConfirm: () => {
          const checked = document.querySelector('input[name="watchScope"]:checked');
          return checked ? checked.value : 'this';
        },
      });

      if (result.isConfirmed) {
        await setWatch(slug, result.value || 'this');
      } else if (result.isDenied) {
        await unwatch(slug);
      }
    }

    async function setWatch(slug, scope) {
      try {
        const res = await fetch(`/api/w/${encodeURIComponent(slug)}/watch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope, action: 'set' }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || '주시 설정 실패');
        }
        const data = await res.json();
        // 응답 처리 도중 다른 문서로 이동했다면 UI 갱신을 생략한다.
        if (_currentWatchState.slug === slug) {
          _currentWatchState = { slug, watching: !!data.watching, scope: data.scope || null };
          updateWatchUI(_currentWatchState);
        }
        const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
        Toast.fire({
          icon: 'success',
          title: scope === 'subtree' ? '하위 문서까지 주시합니다.' : '문서를 주시합니다.',
        });
      } catch (err) {
        Swal.fire('오류', err.message, 'error');
      }
    }

    async function unwatch(slug) {
      // 캐시된 상태가 다른 문서의 것이면 새로 받아서 확정한다.
      // (stale scope 로 toggle 을 보내면 서버가 새 주시 row 를 INSERT 하므로 사고 방지)
      if (_currentWatchState.slug !== slug) {
        await loadWatchStatus(slug);
      }
      if (_currentWatchState.slug !== slug || !_currentWatchState.watching) {
        // 실제로 주시 중이 아니면 아무것도 하지 않는다.
        return;
      }
      const scope = _currentWatchState.scope || 'this';
      try {
        const res = await fetch(`/api/w/${encodeURIComponent(slug)}/watch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope, action: 'toggle' }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || '주시 해제 실패');
        }
        const data = await res.json();
        if (_currentWatchState.slug === slug) {
          _currentWatchState = { slug, watching: !!data.watching, scope: data.scope || null };
          updateWatchUI(_currentWatchState);
        }
        const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
        Toast.fire({ icon: 'success', title: '주시를 해제했습니다.' });
      } catch (err) {
        Swal.fire('오류', err.message, 'error');
      }
    }

    // ── 카테고리 주시 ──
    // 빠른 네비게이션 race 방지를 위해 응답 도착 시점에 #catWatchBtn 의
    // data-category 가 응답 대상과 같은지 확인한 뒤에만 UI 를 갱신한다.
    async function loadCategoryWatchStatus(category) {
      // 새 카테고리 진입 시 즉시 미주시로 리셋해 stale UI 차단
      updateCategoryWatchUIFor(category, false);
      try {
        const res = await fetch(`/api/w/category/${encodeURIComponent(category)}/watch`);
        if (!res.ok) return;
        const data = await res.json();
        updateCategoryWatchUIFor(category, !!data.watching);
      } catch (e) { /* 무시 */ }
    }

    // 현재 표시 중인 카테고리가 인자와 일치할 때만 UI 를 갱신한다.
    function updateCategoryWatchUIFor(category, watching) {
      const btn = document.getElementById('catWatchBtn');
      const text = document.getElementById('catWatchText');
      if (!btn || !text) return;
      if (btn.dataset.category !== category) return;
      const icon = btn.querySelector('i');
      if (watching) {
        text.textContent = '카테고리 주시 해제';
        if (icon) icon.className = 'bi bi-folder-fill';
      } else {
        text.textContent = '카테고리 주시';
        if (icon) icon.className = 'bi bi-folder';
      }
    }

    async function toggleCategoryWatch(category) {
      try {
        const res = await fetch(`/api/w/category/${encodeURIComponent(category)}/watch`, { method: 'POST' });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || '카테고리 주시 실패');
        }
        const data = await res.json();
        updateCategoryWatchUIFor(category, !!data.watching);
        const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
        Toast.fire({
          icon: 'success',
          title: data.watching ? '카테고리를 주시합니다.' : '카테고리 주시를 해제했습니다.',
        });
      } catch (err) {
        Swal.fire('오류', err.message, 'error');
      }
    }

    // ── 읽기 모드 ──
    function _applyReadingModeUi(active) {
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
      // 읽기 모드와 Raw 보기는 함께 사용 불가 — Raw 모드 활성 시 먼저 해제
      if (document.body.classList.contains('raw-mode')) {
        _exitRawMode();
      }
      const active = document.body.classList.toggle('reading-mode');
      _applyReadingModeUi(active);
      try {
        if (active) localStorage.setItem('readingMode', '1');
        else localStorage.removeItem('readingMode');
      } catch (e) { }
      // 프레젠테이션 문서는 모드 전환 시 본문 렌더 경로가 갈리므로 재렌더가 필요.
      // 읽기 모드 ON → 일반 문서처럼 합쳐서 표시 / OFF → 슬라이드 덱 복원.
      if (currentPage && currentPage.view_mode === 'presentation' && currentSlug) {
        if (typeof window.teardownPresentation === 'function') {
          try { window.teardownPresentation(); } catch (e) { /* noop */ }
        }
        showArticle(currentSlug);
      }
    }

    // ── 조회수 지연 로드 ──
    async function loadPageViewCount(btn) {
      if (!btn) return;
      const slug = btn.dataset.slug;
      if (!slug) return;
      if (btn.dataset.loaded === 'true') return;

      btn.disabled = true;
      const originalHtml = btn.innerHTML;

      // 로딩 스피너 표시 (Bootstrap 5.3 spinner-border-sm)
      btn.innerHTML = `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true" style="width: 0.75rem; height: 0.75rem; border-width: 1.5px; margin-right: 4px;"></span>로딩...`;

      try {
        const r = await fetch('/api/analytics/page-views/' + encodeURIComponent(slug));
        if (!r.ok) throw new Error('API response error');
        const data = await r.json();

        // SPA 네비게이션 등으로 다른 페이지로 이동했는지 검증
        if (currentPage && currentPage.slug !== slug) return;

        const totalViews = Number(data.total || 0);
        const total = totalViews.toLocaleString();
        btn.innerHTML = `<i class="bi bi-eye" aria-hidden="true"></i> ${total}`;
        
        if (totalViews > 0) {
          btn.dataset.loaded = 'true';
        } else {
          // 조회수가 0인 경우 (또는 백엔드 쿼리 에러 fallback 시) 버튼을 활성화된 상태로 두어 재조회가 가능하게 합니다.
          btn.disabled = false;
        }
      } catch (e) {
        console.error('Failed to load page views:', e);
        // 실패 시 복구하여 재시도 가능하도록 복원
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }
    }

    // ── Raw 보기 모드 ──
    function _applyRawModeUi(active) {
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

    // Raw 모드 표시 상태만 해제 — #articleRawContent 의 textContent 는 의도적으로 보존
    // (재진입 시 즉시 표시 가능; 원본 내용은 새 문서 로드 시 showArticle 에서 교체됨)
    function _exitRawMode() {
      if (document.body.classList.contains('raw-mode')) {
        document.body.classList.remove('raw-mode');
      }
      _applyRawModeUi(false);
    }

    function toggleRawMode() {
      // 읽기 모드와 Raw 보기는 함께 사용 불가 — 읽기 모드 활성 시 먼저 해제
      if (document.body.classList.contains('reading-mode')) {
        document.body.classList.remove('reading-mode');
        _applyReadingModeUi(false);
        try { localStorage.removeItem('readingMode'); } catch (e) { }
      }
      const active = document.body.classList.toggle('raw-mode');
      _applyRawModeUi(active);
      // Raw 모드 진입 시 페이지 상단으로 스크롤
      if (active) window.scrollTo({ top: 0, behavior: 'auto' });
    }

    // 초기 상태 복원 — 사이드바 숨김과 FAB 노출이 동시에 반영되도록 동기 적용
    try {
      if (localStorage.getItem('readingMode') === '1') {
        document.body.classList.add('reading-mode');
        _applyReadingModeUi(true);
      }
    } catch (e) { }

    function toggleFloatingToc() {
      const panel = document.getElementById('tocFloatingPanel');
      const tocSource = document.getElementById('tocNav');
      const floatingNav = document.getElementById('tocFloatingNav');
      const isVisible = panel.classList.contains('visible');

      if (!isVisible) {
        // 목차 내용이 없으면 표시하지 않음
        if (!tocSource || !tocSource.innerHTML.trim()) return;
        // 기존 tocNav 내용을 복제하여 표시
        floatingNav.innerHTML = tocSource.innerHTML;
        // 클릭 시 해당 위치로 이동 후 패널 닫기
        floatingNav.querySelectorAll('a').forEach(a => {
          a.addEventListener('click', () => {
            panel.classList.remove('visible');
          });
        });
        // 현재 스크롤 위치에 맞춰 활성 항목 표시
        _tocSpyLastId = null;
        _updateTocActive();
      }

      panel.classList.toggle('visible');
    }

    // ── 목차 스크롤 스파이 ──
    let _tocSpyAttached = false;
    let _tocSpyLastId = null;

    function _findCurrentHeadingId() {
      const articleContent = document.getElementById('articleContent');
      if (!articleContent) return null;
      const headings = articleContent.querySelectorAll('h1, h2, h3, h4');
      if (!headings.length) return null;

      const offset = 120;
      let currentId = null;
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

    function _updateTocActive() {
      const articlePage = document.getElementById('articlePage');
      if (!articlePage || articlePage.classList.contains('d-none')) return;
      const currentId = _findCurrentHeadingId();
      if (!currentId) return;
      if (currentId === _tocSpyLastId) return;
      _tocSpyLastId = currentId;

      ['tocNav', 'tocFloatingNav', 'wikiTocSidebarNav', 'wikiTocSidebarRightNav'].forEach(navId => {
        const nav = document.getElementById(navId);
        if (!nav) return;
        nav.querySelectorAll('a.toc-active').forEach(a => a.classList.remove('toc-active'));
        nav.querySelectorAll('a').forEach(a => {
          const href = a.getAttribute('href') || '';
          if (href.slice(1) === currentId) a.classList.add('toc-active');
        });
      });

      // 플로팅 패널이 열려 있으면 활성 항목이 보이도록 스크롤
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

    function _attachTocSpy() {
      if (_tocSpyAttached) return;
      _tocSpyAttached = true;
      let ticking = false;
      const handler = () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          _updateTocActive();
          ticking = false;
        });
      };
      window.addEventListener('scroll', handler, { passive: true });
      window.addEventListener('resize', handler, { passive: true });

      // 섹션 접기/펼치기(.wiki-section-body grid 전환), 자체 문법 fold(<details>),
      // 사이드바 목차 아코디언(#collapseTOC) 토글 시 레이아웃이 변하므로
      // 스크롤스파이를 재계산한다. 애니메이션 진행 중 중간 프레임도 보정.
      const refreshSpy = () => {
        _tocSpyLastId = null;
        _updateTocActive();
        [90, 200, 340, 450].forEach(d => setTimeout(() => {
          _tocSpyLastId = null;
          _updateTocActive();
        }, d));
      };

      // .wiki-section-body 는 grid-template-rows 에 CSS transition 을 걸어 접히므로
      // transitionend 가 접기/펼치기 완료 신호가 된다.
      document.addEventListener('transitionend', (e) => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        if (e.propertyName && e.propertyName !== 'grid-template-rows') return;
        if (t.classList && t.classList.contains('wiki-section-body')) refreshSpy();
      });

      // <details> 는 toggle 이벤트가 버블링되지 않으므로 capture 단계에서 수신.
      document.addEventListener('toggle', (e) => {
        const t = e.target;
        if (t && t.tagName === 'DETAILS') refreshSpy();
      }, true);

      // 본문과 별도의 목차 아코디언 — Bootstrap collapse 이벤트로 감지.
      const tocCollapse = document.getElementById('collapseTOC');
      if (tocCollapse) {
        tocCollapse.addEventListener('show.bs.collapse', refreshSpy);
        tocCollapse.addEventListener('hide.bs.collapse', refreshSpy);
        tocCollapse.addEventListener('shown.bs.collapse', refreshSpy);
        tocCollapse.addEventListener('hidden.bs.collapse', refreshSpy);
      }

      _updateTocActive();
    }

    // 목차(사이드바 / 플로팅 패널) 링크 클릭 시 접힌 조상을 먼저 펼친 뒤 스크롤.
    // TOC 링크는 기본적으로 `<a href="#id">` 이므로 브라우저 기본 동작이 접힌 섹션을
    // 무시한 채 현재(접힌) 좌표로 점프하는 문제를 막는다.
    function _interceptTocLinkClick(e) {
      const a = e.target.closest && e.target.closest('a[href^="#"]');
      if (!a) return;
      const hash = a.getAttribute('href');
      if (!hash || hash.length < 2) return;
      let id;
      try { id = decodeURIComponent(hash.slice(1)); } catch (_) { id = hash.slice(1); }
      const target = id ? document.getElementById(id) : null;
      if (!target) return;
      e.preventDefault();
      history.pushState(null, '', hash);
      if (typeof window._scrollToElementWithAncestors === 'function') {
        window._scrollToElementWithAncestors(target, { behavior: 'smooth', block: 'start' });
      } else {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }

    function _attachTocLinkInterceptors() {
      const tocNav = document.getElementById('tocNav');
      const floatingNav = document.getElementById('tocFloatingNav');
      const sidebarNav = document.getElementById('wikiTocSidebarNav');
      if (tocNav && !tocNav._tocLinkIntercepted) {
        tocNav.addEventListener('click', _interceptTocLinkClick);
        tocNav._tocLinkIntercepted = true;
      }
      if (floatingNav && !floatingNav._tocLinkIntercepted) {
        floatingNav.addEventListener('click', _interceptTocLinkClick);
        floatingNav._tocLinkIntercepted = true;
      }
      if (sidebarNav && !sidebarNav._tocLinkIntercepted) {
        sidebarNav.addEventListener('click', _interceptTocLinkClick);
        sidebarNav._tocLinkIntercepted = true;
      }
    }

    document.addEventListener('DOMContentLoaded', _attachTocSpy);
    document.addEventListener('DOMContentLoaded', _attachTocLinkInterceptors);

    // 문서 페이지가 아닐 때 TOC FAB 숨기기
    const _origHideAllPages = typeof hideAllPages === 'function' ? hideAllPages : null;
    document.addEventListener('DOMContentLoaded', () => {
      const observer = new MutationObserver(() => {
        const tocBtn = document.getElementById('tocFabBtn');
        const tocSource = document.getElementById('tocNav');
        const articlePage = document.getElementById('articlePage');
        if (tocBtn) {
          const hasToc = tocSource && tocSource.innerHTML.trim();
          const isArticle = articlePage && !articlePage.classList.contains('d-none');
          tocBtn.style.display = (hasToc && isArticle) ? '' : 'none';
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    });

// ── 편집 요청 검토(문서 페이지) ──
// 편집 버튼 드롭다운 "편집 요청 확인하기"/상단 배너 "검토하기" 에서 호출. 서버가 검토 권한자에게만
// 목록을 내려주므로(자연 게이팅) 별도 권한 체크 없이 호출한다. 기존 MCP 검토와 동일하게 showDiffModal 재사용.
async function reviewEditRequests(slug) {
  let list;
  try {
    const res = await fetch('/api/pending-edits?slug=' + encodeURIComponent(slug));
    if (!res.ok) throw new Error();
    const data = await res.json();
    list = (data && data.submissions) || [];
  } catch {
    Swal.fire('오류', '편집 요청을 불러오지 못했습니다.', 'error');
    return;
  }
  if (list.length === 0) {
    Swal.fire('편집 요청', '검토할 편집 요청이 없습니다.', 'info');
    return;
  }
  let chosenId = list[0].id;
  // 한 문서에 여러 작성자의 요청이 있을 수 있으므로 2건 이상이면 선택 단계를 둔다.
  if (list.length > 1) {
    const options = {};
    list.forEach(s => {
      const ts = s.updated_at ? new Date(s.updated_at).toLocaleString('ko-KR') : '';
      options[s.id] = `${s.author_name || '익명'} · ${s.action === 'create' ? '신규' : '수정'} · ${ts}${s.has_conflict ? ' · 충돌' : ''}`;
    });
    const pick = await Swal.fire({
      title: '편집 요청 선택',
      input: 'select',
      inputOptions: options,
      inputValue: String(list[0].id),
      showCancelButton: true,
      confirmButtonText: '검토',
      cancelButtonText: '취소',
    });
    if (!pick.isConfirmed) return;
    chosenId = Number(pick.value);
  }
  await openEditRequestDetail(chosenId);
}

// 문서 본문이 없는 화면(404 문서 없음 / 410 삭제됨)에도 검토 동선을 노출한다 — 편집 버튼 드롭다운이
// 닿지 않는 경로라, 이게 없으면 새 문서(create) 요청이나 page_missing/slug_soft_deleted 요청을 검토자가
// 발견·반려할 UI 경로가 사라져 요청이 영구히 stuck 된다. 서버가 검토 권한자에게만 count>0 을 반환하므로 자연 게이팅.
async function surfaceEditRequestsOn(boxId, slug) {
  const box = document.getElementById(boxId);
  if (!box || !window.currentUser) return;
  box.classList.add('d-none');
  box.innerHTML = '';
  try {
    const res = await fetch('/api/pending-edits/count?slug=' + encodeURIComponent(slug));
    const data = res.ok ? await res.json() : { count: 0 };
    if (!data || !data.count) return;
    box.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;padding:0.65rem 1rem;border:1px solid #38BDF8;background:rgba(56,189,248,0.10);border-radius:10px;font-size:0.95rem;">
        <span><i class="bi bi-hourglass-split"></i> 이 제목으로 제출된 편집 요청이 ${data.count}건 있습니다.</span>
        <button type="button" class="btn btn-sm" style="background:#38BDF8;color:#06283d;white-space:nowrap;"><i class="bi bi-list-check"></i> 편집 요청 확인하기</button>
      </div>
    `;
    const btn = box.querySelector('button');
    if (btn) btn.addEventListener('click', () => reviewEditRequests(slug));
    box.classList.remove('d-none');
  } catch { /* 무시 */ }
}

async function openEditRequestDetail(id) {
  let detail;
  try {
    const res = await fetch('/api/pending-edits/' + encodeURIComponent(id));
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      Swal.fire('오류', e.error || '편집 요청을 불러오지 못했습니다.', 'error');
      return;
    }
    detail = await res.json();
  } catch {
    Swal.fire('오류', '네트워크 오류', 'error');
    return;
  }

  const editorUrl = '/edit?slug=' + encodeURIComponent(detail.slug) + '&edit_request=' + encodeURIComponent(id);
  const conflictBanner = detail.has_conflict
    ? `<div class="alert alert-warning py-2 mb-2 text-start"><i class="bi bi-exclamation-triangle"></i> ${
        detail.conflict_reason === 'slug_taken' ? '동일 제목의 다른 문서가 그 사이 생성되었습니다. 직접 승인할 수 없습니다.'
        : detail.conflict_reason === 'slug_soft_deleted' ? '동일 제목의 소프트 삭제된 문서가 존재합니다. 먼저 복원/영구삭제 해야 합니다.'
        : detail.conflict_reason === 'page_missing' ? '문서가 삭제되었거나 존재하지 않습니다. 직접 승인할 수 없습니다.'
        : '제출 이후 문서가 수정되었습니다. 그대로 승인할 수 없으니 “에디터에서 편집”으로 병합하거나 반려하세요.'
      }</div>`
    : '';
  const ts = detail.submitted_at ? new Date(detail.submitted_at).toLocaleString('ko-KR') : '';
  const enabledExts = (window.appConfig && window.appConfig.enabledExtensions) || [];
  const isExtensionDataDiff = enabledExts.some(ext => detail.slug.startsWith(ext + ':'));
  // 동시 수정 충돌(또는 기타 충돌)이면 직접 승인 불가 — 에디터 병합 경로로 유도(2-리비전).
  const canDirectApprove = !detail.has_conflict;

  const extraTopHtml = `
    ${conflictBanner}
    <div class="text-start small text-muted mb-2">
      <div><b>${window.escapeHtml(detail.slug)}</b> · ${detail.action === 'create' ? '신규' : '수정'} · ${window.escapeHtml(detail.author_name || '')}님 · 제출 ${window.escapeHtml(ts)}</div>
      <div>+${detail.lines_added}줄 / -${detail.lines_removed}줄</div>
    </div>
    <div class="mb-2 text-start">
      <a href="${editorUrl}" class="btn btn-sm btn-outline-primary"><i class="bi bi-pencil-square"></i> 에디터에서 편집 (병합·추가 편집 후 승인)</a>
    </div>
    ${canDirectApprove ? `<div class="mt-1 mb-2 text-start">
      <label class="form-label small mb-1">편집 요약 (승인 시 끝에 “요청 승인 : [닉네임|id]” 가 자동 부착됩니다)</label>
      <input type="text" id="editRequestApproveSummary" class="form-control form-control-sm" maxlength="200" value="${window.escapeHtml(detail.summary || '')}">
    </div>` : ''}
  `;

  const result = await window.showDiffModal({
    title: '편집 요청 검토',
    oldText: detail.current_content || '',
    newText: detail.proposed_content || '',
    slug: detail.slug,
    forceRaw: isExtensionDataDiff,
    width: '1100px',
    extraTopHtml,
    swalOptions: {
      showCancelButton: true,
      showDenyButton: true,
      showConfirmButton: canDirectApprove,
      confirmButtonText: '<i class="bi bi-check-lg"></i> 승인',
      denyButtonText: '<i class="bi bi-x-lg"></i> 반려',
      cancelButtonText: '닫기',
      confirmButtonColor: '#10B981',
      denyButtonColor: '#EF4444',
      preConfirm: () => {
        const inp = document.getElementById('editRequestApproveSummary');
        return { summary: inp ? inp.value : '' };
      },
    },
  });

  if (result.isConfirmed) {
    await approveEditRequest(id, result.value && result.value.summary, editorUrl);
  } else if (result.isDenied) {
    await rejectEditRequest(id, detail.slug);
  }
}

async function approveEditRequest(id, summary, editorUrl) {
  try {
    const res = await fetch('/api/pending-edits/' + encodeURIComponent(id) + '/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 직접 승인 시 충돌 → 에디터 병합 경로로 fallback.
      if (data.error === 'conflict' && data.reason === 'concurrent_modification') {
        const go = await Swal.fire({
          icon: 'warning',
          title: '동시 수정 충돌',
          text: '제출 이후 문서가 수정되었습니다. 에디터에서 병합한 뒤 승인하시겠습니까?',
          showCancelButton: true,
          confirmButtonText: '에디터에서 편집',
          cancelButtonText: '취소',
        });
        if (go.isConfirmed) window.location.href = editorUrl;
        return;
      }
      Swal.fire('승인 실패', data.message || data.error || '승인에 실패했습니다.', 'error');
      return;
    }
    await Swal.fire({
      icon: 'success',
      title: '승인되었습니다.',
      text: data.two_revisions ? '요청분과 추가 편집이 각각 리비전으로 반영되었습니다.' : '요청자 명의 리비전으로 반영되었습니다.',
      toast: true, position: 'top-end', showConfirmButton: false, timer: 2400,
    });
    window.location.reload();
  } catch {
    Swal.fire('오류', '네트워크 오류', 'error');
  }
}

async function rejectEditRequest(id, slug) {
  const confirmRes = await Swal.fire({
    icon: 'warning',
    title: '편집 요청을 반려하시겠습니까?',
    input: 'text',
    inputLabel: '반려 사유 (선택, 요청자에게 전달됩니다)',
    inputAttributes: { maxlength: '100' },
    text: `"${slug}" 의 편집 요청을 폐기합니다. 되돌릴 수 없습니다.`,
    showCancelButton: true,
    confirmButtonText: '반려',
    cancelButtonText: '취소',
    confirmButtonColor: '#EF4444',
  });
  if (!confirmRes.isConfirmed) return;
  try {
    const res = await fetch('/api/pending-edits/' + encodeURIComponent(id) + '/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: confirmRes.value || '' }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      Swal.fire('반려 실패', e.error || '반려에 실패했습니다.', 'error');
      return;
    }
    await Swal.fire({ icon: 'success', title: '반려되었습니다.', toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
    window.location.reload();
  } catch {
    Swal.fire('오류', '네트워크 오류', 'error');
  }
}

// ── HTML 의 inline on* 속성에서 호출되는 함수들을 window 에 노출 ──
window.goNewPage = goNewPage;
window.shareNative = shareNative;
window.shareCopyLink = shareCopyLink;
window.shareCopyText = shareCopyText;
window.shareCopyMarkdown = shareCopyMarkdown;
window.sharePrint = sharePrint;
window.shareAskClaude = shareAskClaude;
window.shareAskChatGPT = shareAskChatGPT;
window.scrollToBacklinks = scrollToBacklinks;
window.showSubdocs = showSubdocs;
window.copySubdocsPopup = copySubdocsPopup;
window.showCategory = showCategory;
window.navigateTo = navigateTo;
window.promptMove = promptMove;
window.confirmDelete = confirmDelete;
window.confirmHardDelete = confirmHardDelete;
window.restorePage = restorePage;
window.openWatchMenu = openWatchMenu;
window.toggleCategoryWatch = toggleCategoryWatch;
window.editImageDocContent = editImageDocContent;
window.loadPageViewCount = loadPageViewCount;
window.toggleReadingMode = toggleReadingMode;
window.toggleRawMode = toggleRawMode;
window.toggleFloatingToc = toggleFloatingToc;
