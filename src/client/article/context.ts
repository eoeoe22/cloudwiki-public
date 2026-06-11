// 문서 조회 화면 공유 모듈(`src/client/article/*`)이 받는 컨텍스트 계약.
// 전역 위키(index.ts)와 워크스페이스(ws-doc.ts) 사이에서 *실제로 다른 부분만* 주입한다:
//   - 문서 링크 경로(`/w/<slug>` vs `/ws/<wslug>/w/<slug>`)
//   - 부속 API 경로(전역 `/api/w/...` vs 워크스페이스 `/api/ws/<wslug>/pages/...`)
//   - 네비게이션(전역은 SPA, 워크스페이스는 풀 내비게이션)
//   - 워크스페이스에 없는 기능 토글(AI 공유 등)
// DOM 마커 ID 는 두 셸이 동일하게 쓰므로 파라미터화하지 않는다.

export interface ArticleDoc {
  slug?: string;
  title?: string | null;
  content?: string;
  view_mode?: string | null;
  is_private?: boolean | number;
  [key: string]: unknown;
}

export interface ArticleContext {
  /** 문서 슬러그 → 조회 URL (`/w/<slug>` 또는 `/ws/<wslug>/w/<slug>`). */
  docHref(slug: string): string;
  /** 문서 슬러그 → 하위 문서 API URL. immediate=true 면 바로 아래 단계 자식만. */
  subdocsUrl(slug: string, immediate?: boolean): string;
  /** 문서 슬러그 → 역링크 API URL. */
  backlinksUrl(slug: string): string;
  /** 링크 이동. 전역은 SPA navigateTo, 워크스페이스는 풀 내비게이션. */
  navigate(href: string | null): void;
  /** 현재 문서 객체(공유/마크다운 복사 등에서 본문·슬러그 참조). */
  getDoc(): ArticleDoc | null;
  /** 현재 문서 슬러그(getDoc 가 비어 있을 때의 폴백). */
  getSlug(): string;
  /** 사이트 표시명(공유 텍스트). */
  wikiName(): string;
  /** 하위 문서 생성 버튼 노출 여부(권한·네임스페이스 판단). */
  canCreateSubdoc(slug: string): boolean;
  /** 하위 문서 생성 동선 진입. */
  onCreateSubdoc(slug: string | undefined): void;
  /** AI 질문 공유(Claude/ChatGPT) 옵션 노출 여부. 워크스페이스는 false. */
  includeAi: boolean;
}
