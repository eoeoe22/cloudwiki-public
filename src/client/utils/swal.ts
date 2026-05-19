/**
 * sweetalert2 (CDN 글로벌 window.Swal) 의 타입과 Window 증강.
 *
 * 여러 모듈(login.ts / src/client/edit/* / 향후 다른 페이지)이 동일 글로벌을
 * 사용하면서 각자 다른 shape 으로 declare 하면 TypeScript interface merge 에서
 * 충돌하므로 단일 소스로 둔다.
 *
 * 본 프로젝트에서는 sweetalert2 를 npm 으로 가져오지 않고 CDN 스크립트 태그로
 * 로드한다. CDN 스크립트가 window.Swal 에 객체를 노출하므로 모듈은 그대로 호출만 한다.
 */

export type SwalIcon = 'success' | 'error' | 'warning' | 'info' | 'question';

export interface SwalOptions {
    title?: string;
    text?: string;
    html?: string;
    icon?: SwalIcon;
    width?: string | number;
    timer?: number;
    showConfirmButton?: boolean;
    showCancelButton?: boolean;
    showDenyButton?: boolean;
    showCloseButton?: boolean;
    confirmButtonText?: string;
    cancelButtonText?: string;
    denyButtonText?: string;
    confirmButtonColor?: string;
    cancelButtonColor?: string;
    denyButtonColor?: string;
    customClass?: { popup?: string };
    toast?: boolean;
    position?: string;
    focusConfirm?: boolean;
    didOpen?: (popup: HTMLElement) => void;
    willClose?: (popup: HTMLElement) => void;
    preConfirm?: () => unknown | Promise<unknown> | false;
}

export interface SwalResult<T = unknown> {
    isConfirmed: boolean;
    isDenied: boolean;
    isDismissed: boolean;
    value?: T;
}

export interface SwalGlobal {
    fire<T = unknown>(options: SwalOptions): Promise<SwalResult<T>>;
    fire<T = unknown>(title: string, text?: string, icon?: SwalIcon): Promise<SwalResult<T>>;
    close(): void;
    showValidationMessage(message: string): void;
    getConfirmButton(): HTMLButtonElement | null;
}

declare global {
    interface Window {
        /** sweetalert2 CDN 글로벌. CDN 미로드 페이지에선 undefined 일 수 있다. */
        Swal?: SwalGlobal;
    }
}

export {};
