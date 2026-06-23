// @ts-nocheck — 문서 구조 보기(하위 문서 트리) 모달 공유 모듈.
// 전역 위키(index.ts)·워크스페이스(ws-doc.ts) 공용. 하위 문서 API 경로·문서 링크 경로·
// 네비게이션만 ArticleContext 로 주입받는다. 트리 빌드/정렬/렌더 로직은 과거 index.ts 의
// showSubdocs 와 동일. 인라인 onclick 대신 Swal didOpen 에서 핸들러를 붙여 전역(SPA)·
// 워크스페이스(풀 내비게이션) 양쪽에서 동작하게 한다.
//
// "전체 구조 보기" 체크박스:
//   - 체크(활성화) 시 최상위 문서 기준으로 전체 트리를 표시(기존 동작).
//   - 해제(비활성화) 시 현재 문서를 시작점으로 하는 하위 트리만 표시.
// 각 뷰는 해당 기준 문서(base)의 하위 목록을 직접 받아온다(전역 목록을 클라이언트에서
// 필터링하지 않는다). `/subdocs` 응답은 `LIMIT 200` 으로 잘리므로, 하위 문서가 많은
// 최상위 문서에서 현재 문서 뷰를 전역 목록 필터링으로 만들면 200행 밖의 가지가 누락될 수
// 있기 때문이다. 한 번 받은 base 의 결과는 캐시해 토글 반복 시 재요청하지 않는다.
// 현재 문서가 최상위 문서이면 두 뷰가 동일하므로 체크박스를 노출하지 않는다.

import type { ArticleContext } from './context';

declare const Swal: any;

export function createStructureModal(ctx: ArticleContext) {
  async function show(slug: string) {
    // 하위 문서인 경우 최상위 문서를 기준으로 탐색
    const topSlug = slug.includes('/') ? slug.split('/')[0] : slug;
    const isSubdoc = slug !== topSlug;

    // base 슬러그 → 하위 문서 목록 캐시(중복 요청 방지).
    // 슬러그가 `constructor`·`toString` 등 Object.prototype 키와 충돌할 수 있으므로 Map 을 쓴다.
    const cache = new Map<string, any[]>();
    async function loadSubdocs(baseSlug: string): Promise<any[]> {
      const cached = cache.get(baseSlug);
      if (cached) return cached;
      const res = await fetch(ctx.subdocsUrl(baseSlug, false));
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      const list = data.subdocs || [];
      cache.set(baseSlug, list);
      return list;
    }

    function annotateDescendants(children: any): number {
      let total = 0;
      for (const key of Object.keys(children)) {
        const sub = annotateDescendants(children[key]._children);
        children[key]._descendants = sub;
        total += 1 + sub;
      }
      return total;
    }

    function sortEntries(nodes: any): string[] {
      return Object.keys(nodes).sort((a, b) => {
        const ca = nodes[a]._descendants;
        const cb = nodes[b]._descendants;
        if (ca !== cb) return ca - cb;
        return a.localeCompare(b);
      });
    }

    function renderTree(nodes: any, parentPrefix: string): string {
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
            `<a href="${ctx.docHref(node._doc.slug)}" class="article-structure-link text-decoration-none">${window.escapeHtml(key)}</a></div>`;
        } else {
          html += `<div style="font-family:monospace;white-space:pre;line-height:1.6;">${parentPrefix}${connector}${window.escapeHtml(key)}</div>`;
        }

        if (hasChildren) {
          html += renderTree(node._children, childPrefix);
        }
      });
      return html;
    }

    function renderPlain(nodes: any, parentPrefix: string): string {
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

    function renderMarkdown(nodes: any, parentPrefix: string): string {
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

    // baseSlug 를 루트로 하는 뷰(트리 HTML·복사용 텍스트/마크다운)를 구성한다.
    // list 는 baseSlug 의 하위 문서 목록(슬러그가 `baseSlug/` 로 시작).
    function computeView(baseSlug: string, list: any[]) {
      // 슬러그 세그먼트가 `constructor` 등 prototype 키와 충돌하지 않도록 null-prototype 객체를 쓴다.
      const tree: any = Object.create(null);
      const prefix = baseSlug + '/';
      for (const doc of list) {
        if (!doc.slug.startsWith(prefix)) continue;
        const relative = doc.slug.substring(prefix.length);
        const parts = relative.split('/');
        let node = tree;
        for (const part of parts) {
          if (!node[part]) node[part] = { _children: Object.create(null), _doc: null };
          node = node[part]._children;
        }
        let target = tree;
        for (let i = 0; i < parts.length; i++) {
          if (i === parts.length - 1) {
            target[parts[i]]._doc = doc;
          } else {
            target = target[parts[i]]._children;
          }
        }
      }
      annotateDescendants(tree);

      const title = decodeURIComponent(baseSlug);
      let treeHtml = `<div style="font-family:monospace;white-space:pre;line-height:1.6;"><a href="${ctx.docHref(baseSlug)}" class="article-structure-link text-decoration-none fw-bold">${window.escapeHtml(title)}</a></div>`;
      treeHtml += renderTree(tree, '');

      const plainText = title + '\n' + renderPlain(tree, '');
      const markdown = `[[${baseSlug}]]\n` + renderMarkdown(tree, '');

      return { treeHtml, plainText, markdown };
    }

    // 초기 뷰: 현재 문서가 하위 문서이면 현재 문서 기준(체크 해제 상태), 아니면 최상위 문서 기준.
    const initialBase = isSubdoc ? slug : topSlug;
    let initialList: any[];
    try {
      initialList = await loadSubdocs(initialBase);
    } catch (err) {
      console.error(err);
      Swal.fire('오류', '하위 문서를 불러오는 데 실패했습니다.', 'error');
      return;
    }

    // 현재 문서가 최상위 문서인데 하위 문서가 없으면 안내만 표시(기존 동작).
    // 현재 문서가 하위 문서이면 비어 있어도 모달을 열어 "전체 구조 보기"로 전환할 수 있게 한다.
    if (!isSubdoc && initialList.length === 0) {
      Swal.fire('문서 구조', '하위 문서가 없습니다.', 'info');
      return;
    }

    const copyData = { plain: '', md: '' };

    function applyView(view: { treeHtml: string; plainText: string; markdown: string }, container: HTMLElement | null) {
      copyData.plain = view.plainText;
      copyData.md = view.markdown;
      if (container) {
        container.innerHTML = view.treeHtml;
        attachLinks(container);
      }
    }

    async function copyFrom(btn: HTMLElement, format: 'plain' | 'md') {
      const text = format === 'md' ? copyData.md : copyData.plain;
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

    function attachLinks(container: HTMLElement) {
      container.querySelectorAll('a.article-structure-link').forEach((a) => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          Swal.close();
          ctx.navigate((a as HTMLAnchorElement).getAttribute('href'));
        });
      });
    }

    const initialView = computeView(initialBase, initialList);
    copyData.plain = initialView.plainText;
    copyData.md = initialView.markdown;

    // 현재 문서가 하위 문서일 때만 전체/현재 전환 체크박스를 노출한다.
    const checkboxHtml = isSubdoc ? `
      <div class="form-check text-start mb-2">
        <input class="form-check-input" type="checkbox" id="structure-full-toggle">
        <label class="form-check-label" for="structure-full-toggle">전체 구조 보기</label>
      </div>` : '';

    const buttonsHtml = `
      <div class="d-flex gap-2 mb-3 justify-content-end">
        <button type="button" class="btn btn-sm btn-outline-secondary" data-copy="plain"><i class="bi bi-copy"></i> 텍스트 복사</button>
        <button type="button" class="btn btn-sm btn-outline-secondary" data-copy="md"><i class="bi bi-markdown"></i> 마크다운 복사</button>
      </div>`;

    Swal.fire({
      title: '문서 구조',
      html: `${checkboxHtml}${buttonsHtml}<div class="text-start" id="article-structure-tree">${initialView.treeHtml}</div>`,
      width: 600,
      confirmButtonText: '닫기',
      customClass: { htmlContainer: 'text-start' },
      didOpen: (popup: HTMLElement) => {
        const treeContainer = popup.querySelector('#article-structure-tree') as HTMLElement | null;
        popup.querySelectorAll('button[data-copy]').forEach((b) => {
          b.addEventListener('click', () => copyFrom(b as HTMLElement, (b as HTMLElement).dataset.copy as 'plain' | 'md'));
        });
        if (treeContainer) attachLinks(treeContainer);

        const toggle = popup.querySelector('#structure-full-toggle') as HTMLInputElement | null;
        if (toggle) {
          toggle.addEventListener('change', async () => {
            const targetBase = toggle.checked ? topSlug : slug;
            toggle.disabled = true;
            if (!cache.has(targetBase) && treeContainer) {
              treeContainer.innerHTML = '<div class="text-muted">불러오는 중...</div>';
            }
            try {
              const list = await loadSubdocs(targetBase);
              applyView(computeView(targetBase, list), treeContainer);
            } catch (err) {
              console.error(err);
              if (treeContainer) {
                treeContainer.innerHTML = '<div class="text-danger">하위 문서를 불러오는 데 실패했습니다.</div>';
              }
            } finally {
              toggle.disabled = false;
            }
          });
        }
      },
    });
  }

  return { show };
}
