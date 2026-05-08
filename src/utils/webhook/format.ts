// Discord webhook 페이로드 작성에 쓰이는 공통 포맷 헬퍼.
// - escapeMd: 사용자 입력이 임베드 description / field value 안에서 markdown 폭주를 일으키지 않도록
//   `*`, `_`, `~`, `|`, `` ` ``, `\`, `>` 를 백슬래시로 이스케이프한다.
// - truncate: 시각적으로 깔끔하게 자르고 말줄임표(`…`) 를 붙인다.
// - absoluteUrl: WIKI_LOGO_URL 등 상대 경로를 WIKI_PUBLIC_BASE_URL 와 결합해 절대 URL 로 보정한다.
//   Discord 는 avatar_url / 임베드 url 에 절대 URL 을 요구한다.

import type { Env } from '../../types';

export function escapeMd(input: string | null | undefined): string {
    if (!input) return '';
    // 백슬래시를 먼저 이스케이프해야 다른 치환에 영향이 없다.
    return input
        .replace(/\\/g, '\\\\')
        .replace(/([*_~`|>])/g, '\\$1');
}

export function truncate(input: string | null | undefined, max: number): string {
    if (!input) return '';
    const trimmed = input.trim();
    if (trimmed.length <= max) return trimmed;
    // 한 글자 단위로 자른 뒤 끝에 ellipsis 추가. max 가 너무 작아 음수가 되는 경우 방어.
    const cutoff = Math.max(0, max - 1);
    return trimmed.slice(0, cutoff) + '…';
}

export function absoluteUrl(env: Env['Bindings'], pathOrUrl: string | null | undefined): string | undefined {
    if (!pathOrUrl) return undefined;
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    const base = (env.WIKI_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    if (!base) return undefined;
    const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
    return `${base}${path}`;
}

// 위키 본문에서 이미지/위키 문법을 대충 떼고 일반 텍스트 미리보기를 만든다.
// 정확한 렌더링이 아니라 임베드 description 의 짧은 미리보기 용이다.
export function stripWiki(input: string | null | undefined): string {
    if (!input) return '';
    return input
        // 코드블록/인라인코드 제거
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`([^`]+)`/g, '$1')
        // 이미지 / 미디어 토큰 제거
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\{(?:icon|media|image|video|색|색상|palette|틀|template)[^{}]*\}/g, '')
        // 위키링크 [[target|label]] → label
        .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, '$2')
        .replace(/\[\[([^\]]+)\]\]/g, '$1')
        // 마크다운 링크 [label](url) → label
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        // 마크다운 강조 기호 제거
        .replace(/[*_~]+/g, '')
        // HTML 태그 제거 (간단한 형태만)
        .replace(/<[^>]+>/g, '')
        // 다중 공백/개행 정리
        .replace(/\r/g, '')
        .replace(/\n{2,}/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .trim();
}

export function nowIso(): string {
    return new Date().toISOString();
}
