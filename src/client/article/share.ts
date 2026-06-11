// @ts-nocheck — 문서 공유 메뉴 공유 모듈(전역 위키·워크스페이스 공용).
// 현재 문서/슬러그/사이트명은 ArticleContext 로 주입받는다. 공유 링크는 항상
// `origin + pathname`(쿼리·해시 제외)으로 만들어 현재 문서 URL 을 가리킨다.
// AI 질문(Claude/ChatGPT) 옵션은 ctx.includeAi 가 true 일 때만 의미를 가진다 —
// 워크스페이스 문서는 비공개가 기본이라 외부 AI 가 URL 을 가져올 수 없어 제외한다.

import type { ArticleContext } from './context';

declare const Swal: any;

export function createShareActions(ctx: ArticleContext) {
  const cleanUrl = () => window.location.origin + window.location.pathname;
  const toast = (title: string) =>
    Swal.fire({ icon: 'success', title, toast: true, position: 'top-end', timer: 1500, showConfirmButton: false });

  async function shareNative() {
    const url = cleanUrl();
    const wikiName = ctx.wikiName();
    const doc = ctx.getDoc();
    const pageTitle = doc && doc.slug ? doc.slug : document.title;
    try {
      await navigator.share({ title: `${wikiName} - ${pageTitle}`, text: `${wikiName} - ${pageTitle}`, url });
    } catch (err) {
      if (err && err.name !== 'AbortError') console.error('공유 실패:', err);
    }
  }

  async function shareCopyLink() {
    try {
      await navigator.clipboard.writeText(cleanUrl());
      toast('문서 링크가 클립보드에 복사되었습니다.');
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
      toast('문서 내용이 클립보드에 복사되었습니다.');
    } catch (err) {
      console.error('복사 실패:', err);
      Swal.fire('오류', '클립보드 복사에 실패했습니다.', 'error');
    }
  }

  async function shareCopyMarkdown() {
    const doc = ctx.getDoc();
    if (!doc || !doc.content) {
      Swal.fire('오류', '문서 내용을 가져올 수 없습니다.', 'error');
      return;
    }
    try {
      const resolvedContent = await window.resolveTransclusionsForMarkdown(doc.content, doc.slug || ctx.getSlug());
      const pageTitle = doc.slug ? doc.slug : '';
      const markdownWithTitle = pageTitle ? pageTitle + '\n\n' + resolvedContent : resolvedContent;
      await navigator.clipboard.writeText(markdownWithTitle);
      toast('마크다운 원문이 클립보드에 복사되었습니다.');
    } catch (err) {
      console.error('복사 실패:', err);
      Swal.fire('오류', '클립보드 복사에 실패했습니다.', 'error');
    }
  }

  function sharePrint() {
    window.print();
  }

  function shareAskClaude() {
    const prompt = '다음 위키 페이지를 읽고 내용에 대한 질문에 답해줘: ' + cleanUrl();
    window.open('https://claude.ai/new?q=' + encodeURIComponent(prompt), '_blank');
  }

  function shareAskChatGPT() {
    const prompt = '다음 위키 페이지를 읽고 내용에 대한 질문에 답해줘: ' + cleanUrl();
    window.open('https://chatgpt.com/?q=' + encodeURIComponent(prompt), '_blank');
  }

  /**
   * AI 질문 옵션(Claude/ChatGPT)은 비회원이 열람 가능한 문서에서만 노출한다.
   * 위키 전체가 closed(로그인 필수)이거나 관리자용 비공개(is_private)면 외부 AI 가
   * URL 을 가져올 수 없으므로 숨긴다. ctx.includeAi 가 false 면 항상 숨긴다.
   */
  function applyAiVisibility(doc: any) {
    const wikiOpen = !window.appConfig || window.appConfig.wikiVisibility !== 'closed';
    const isPrivate = !!(doc && doc.is_private);
    const canGuestRead = ctx.includeAi && wikiOpen && !isPrivate;
    ['shareAiDivider', 'shareItemAskClaude', 'shareItemAskChatGPT'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle('d-none', !canGuestRead);
    });
  }

  return {
    shareNative,
    shareCopyLink,
    shareCopyText,
    shareCopyMarkdown,
    sharePrint,
    shareAskClaude,
    shareAskChatGPT,
    applyAiVisibility,
  };
}
