// @ts-nocheck — 문서 구조 보기(하위 문서 트리) 모달 공유 모듈.
// 전역 위키(index.ts)·워크스페이스(ws-doc.ts) 공용. 하위 문서 API 경로·문서 링크 경로·
// 네비게이션만 ArticleContext 로 주입받는다. 트리 빌드/정렬/렌더 로직은 과거 index.ts 의
// showSubdocs 와 동일. 인라인 onclick 대신 Swal didOpen 에서 핸들러를 붙여 전역(SPA)·
// 워크스페이스(풀 내비게이션) 양쪽에서 동작하게 한다.

import type { ArticleContext } from './context';

declare const Swal: any;

export function createStructureModal(ctx: ArticleContext) {
  async function show(slug: string) {
    // 하위 문서인 경우 최상위 문서를 기준으로 탐색
    const topSlug = slug.includes('/') ? slug.split('/')[0] : slug;

    let subdocs: any[] = [];
    try {
      const res = await fetch(ctx.subdocsUrl(topSlug, false));
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      subdocs = data.subdocs || [];
    } catch (err) {
      console.error(err);
      Swal.fire('오류', '하위 문서를 불러오는 데 실패했습니다.', 'error');
      return;
    }

    if (subdocs.length === 0) {
      Swal.fire('문서 구조', '하위 문서가 없습니다.', 'info');
      return;
    }

    // 트리 구조 빌드 (slug 에서 최상위 문서 prefix 제거)
    const tree: any = {};
    for (const doc of subdocs) {
      const relative = doc.slug.substring(topSlug.length + 1);
      const parts = relative.split('/');
      let node = tree;
      for (const part of parts) {
        if (!node[part]) node[part] = { _children: {}, _doc: null };
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

    function annotateDescendants(children: any): number {
      let total = 0;
      for (const key of Object.keys(children)) {
        const sub = annotateDescendants(children[key]._children);
        children[key]._descendants = sub;
        total += 1 + sub;
      }
      return total;
    }
    annotateDescendants(tree);

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

    const topTitle = decodeURIComponent(topSlug);

    let treeHtml = `<div style="font-family:monospace;white-space:pre;line-height:1.6;"><a href="${ctx.docHref(topSlug)}" class="article-structure-link text-decoration-none fw-bold">${window.escapeHtml(topTitle)}</a></div>`;
    treeHtml += renderTree(tree, '');

    const plainText = topTitle + '\n' + renderPlain(tree, '');
    const markdown = `[[${topSlug}]]\n` + renderMarkdown(tree, '');

    const copyData = { plain: plainText, md: markdown };

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

    const buttonsHtml = `
      <div class="d-flex gap-2 mb-3 justify-content-end">
        <button type="button" class="btn btn-sm btn-outline-secondary" data-copy="plain"><i class="bi bi-copy"></i> 텍스트 복사</button>
        <button type="button" class="btn btn-sm btn-outline-secondary" data-copy="md"><i class="bi bi-markdown"></i> 마크다운 복사</button>
      </div>`;

    Swal.fire({
      title: '문서 구조',
      html: `${buttonsHtml}<div class="text-start">${treeHtml}</div>`,
      width: 600,
      confirmButtonText: '닫기',
      customClass: { htmlContainer: 'text-start' },
      didOpen: (popup: HTMLElement) => {
        popup.querySelectorAll('button[data-copy]').forEach((b) => {
          b.addEventListener('click', () => copyFrom(b as HTMLElement, (b as HTMLElement).dataset.copy as 'plain' | 'md'));
        });
        popup.querySelectorAll('a.article-structure-link').forEach((a) => {
          a.addEventListener('click', (e) => {
            e.preventDefault();
            Swal.close();
            ctx.navigate((a as HTMLAnchorElement).getAttribute('href'));
          });
        });
      },
    });
  }

  return { show };
}
