/**
 * Cloudwiki 익스텐션 저작용 앰비언트 타입 선언.
 *
 * 익스텐션 파일(`public/ext/<name>/<name>.js`)은 Vite 번들 밖의 raw JS 로 서빙되므로
 * 빌드/타입체크 대상이 아니다. 이 `.d.ts` 는 저작자의 IDE 자동완성·타입 점검 용도로만
 * 제공된다(런타임에는 영향 없음). 파일 상단에 다음을 추가하면 타입이 적용된다:
 *
 *   /// <reference path="../cloudwiki-ext.d.ts" />
 *
 * 등록은 `window.defineExtension(manifest, renderer)` 로 한다. 본문에서 `{{<name>:인자}}`
 * 형태로 호출되며, 콜론 앞이 네임스페이스(=`name`=디렉터리명)이다.
 */

/** 본문 `{{name:인자}}` 호출이 렌더러로 전달하는 데이터(레거시 호환 — shape 동결). */
interface ExtensionData {
    /** 네임스페이스(예: "freq", "stock"). */
    extName: string;
    /** 전체 슬러그(예: "freq:title", "stock:AAPL"). */
    slug: string;
    /** 확장 문서 본문(requiresDocument=false 인 확장은 빈 문자열). */
    content: string;
    /** 문서 표시 제목 또는 슬러그. */
    title: string;
    /** 위치 인자 맵. `{{stock:AAPL|chart}}` → `{ "1": "chart" }`. */
    args: Record<string, string>;
    /** 인자가 가리키는 다른 확장 문서의 미리 페치된 데이터 맵. */
    secondary: Record<string, {
        slug: string;
        content?: string;
        title?: string;
        disabled?: boolean;
        error?: string;
    }>;
}

/** SDK 가 렌더러에 주입하는 공용 컨텍스트(전역 상태). `window._extSdk` 로도 접근 가능. */
interface ExtensionContext {
    theme: {
        /** 현재 적용 테마가 다크인지(위키 밝기축 `data-theme` 기준 + OS 폴백). */
        isDark(): boolean;
        /** 'light' | 'dark'. */
        mode(): 'light' | 'dark';
    };
    /** 외부 스크립트를 1회만 로드(중복 가드). `opts.global` 전역이 이미 있으면 즉시 resolve. */
    loadScript(src: string, opts?: { id?: string; global?: string }): Promise<void>;
    /** DOMPurify 래퍼(canvas/svg 허용 안전 프로파일). 익스텐션이 innerHTML 삽입 시 사용. */
    sanitizeHtml(html: string): string;
}

/**
 * 렌더러. 함수형(레거시 호환) 또는 라이프사이클 객체형.
 * - `render` 가 cleanup 함수를 반환하면 SDK 가 그것을 정리 훅으로 사용한다(`destroy` 보다 우선).
 * - `render` 에서 throw 하면 SDK 가 `.alert` 박스로 격리 표시한다(페이지 전체 렌더는 보존).
 */
type ExtensionRenderer =
    | ((el: HTMLElement, data: ExtensionData) => void)
    | {
        /**
         * 본문 토큰을 DOM 으로 렌더. 반환 destroy 함수 또는 throw/reject 처리는 위 참고.
         *
         * 비동기 작업(외부 스크립트 로드 등) 시 staleness 주의: SDK 는 매 렌더마다 `el._extGen`
         * 세대 토큰을 증가시키고, 재렌더·정리(teardown) 시 무효화한다. 비동기 콜백에서 DOM 을
         * 변경하기 전 시작 시점에 캡처한 `el._extGen` 과 현재 값을 비교해, 교체/정리된 렌더면
         * 중단하라(예: `if (el._extGen !== myGen || !el.isConnected) return;`).
         */
        render(el: HTMLElement, data: ExtensionData, ctx: ExtensionContext): void | (() => void) | Promise<void>;
        /** 요소가 DOM 에서 제거/재렌더되기 직전 호출 — Chart.destroy()/리스너 해제 등. */
        destroy?(el: HTMLElement): void;
        /** 테마 변경 시 부분 갱신. 없으면 destroy→render 폴백. */
        onThemeChange?(el: HTMLElement, ctx: ExtensionContext): void;
    };

/** 익스텐션 메타. 현재 `name` 만 필수이며 나머지는 향후 확장(매니페스트) 여지. */
interface ExtensionManifest {
    /** 네임스페이스 = 디렉터리명 = `{{name:...}}` 의 name. */
    name: string;
    version?: string;
    displayName?: string;
    description?: string;
}

/**
 * 에디터 페이지(/edit·/blog-edit) 전용 훅. `public/ext/<name>/<name>-editor.js` 에서
 * `window._extensionEditors[name] = {...}` 로 등록한다(SDK 의 defineExtension 과 별개 경로).
 */
interface ExtensionEditorHook {
    /** 대용량 데이터(REW 등)에서 키스트로크별 문자/줄 카운터 비활성. */
    disableTextCounter?: boolean;
    /** 도구막대 컨테이너에 익스텐션 전용 UI 부착. */
    mount(
        toolbarEl: HTMLElement,
        api: { getValue(): string; setValue(s: string): void; slug: string; extName: string },
    ): void;
}

interface Window {
    defineExtension(manifest: ExtensionManifest, renderer: ExtensionRenderer): void;
    _extSdk: ExtensionContext;
    _extensionRenderers: Record<string, (el: HTMLElement, data: ExtensionData) => void>;
    _extensionDefs: Record<string, ExtensionRenderer>;
    _extensionEditors: Record<string, ExtensionEditorHook>;
}

/**
 * SDK 가 렌더 대상 요소에 부여하는 내부 프로퍼티. 비동기 익스텐션이 staleness 판정에
 * `el._extGen` 을 읽을 수 있도록 타입을 노출한다(위 render 주석의 예시 참고).
 */
interface HTMLElement {
    /** 렌더 세대 토큰. SDK 가 매 렌더마다 증가시키고 재렌더·정리 시 무효화한다. */
    _extGen?: number;
}

declare function defineExtension(manifest: ExtensionManifest, renderer: ExtensionRenderer): void;
