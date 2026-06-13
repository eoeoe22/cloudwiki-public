import { extractTransclusionTargets } from './transclusion';

export interface PageLink {
    target_slug: string;
    link_type: string;
}

/**
 * 문서 content에서 링크를 파싱하여 { target_slug, link_type } 배열을 반환한다.
 *
 * 전역 문서(`wiki.ts` → `page_links`)의 역링크/검색 인덱스가 사용하는 단일 소스.
 *
 * 수집 범위:
 *   - `[[위키링크]]` / `[[위키링크|표시명]]` / `[[위키링크#섹션]]` → link_type='wikilink'
 *   - `{{틀}}` / `{{익스텐션:...}}` → link_type='template' or 'extension'
 *   - `images/...` 전역 이미지 R2 키 → link_type='image'
 *   - `{palette:이름}` 팔레트 토큰 → link_type='palette'
 */
export function extractPageLinks(content: string): PageLink[] {
    const links: PageLink[] = [];
    const seen = new Set<string>();

    // 코드블럭/코드스팬 내부 제외 (실제 링크가 아니라 예시/설명일 가능성)
    const cleaned = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '');

    // 1) [[위키링크]] / [[위키링크|표시명]] / [[위키링크#섹션]]
    // '|' 앞부분만 slug로 사용 (표시명 무시)
    // '#' 앞부분만 slug로 사용 (섹션 앵커 무시) — page_links는 문서간 참조 그래프이므로
    // 페이지 내부 섹션 정보를 인덱스에 저장하지 않음
    const wikiLinkRegex = /\[\[([^\]]+)\]\]/g;
    for (const m of cleaned.matchAll(wikiLinkRegex)) {
        const raw = m[1].trim();
        const slug = raw.split('|')[0].split('#')[0].trim();
        if (!slug) continue; // '[[#로컬앵커]]'처럼 대상 문서가 없는 링크는 제외
        const key = `wikilink:${slug}`;
        if (!seen.has(key)) {
            seen.add(key);
            links.push({ target_slug: slug, link_type: 'wikilink' });
        }
    }

    // 2) {{틀 트랜스클루전}} 또는 {{익스텐션:문서}}
    // 스택 기반 스캐너(src/shared/transclusion.ts)로 추출 — naive 정규식 /\{\{([^}]+?)\}\}/ 는
    // 파라미터 값에 든 `}` (예: 색 팔레트 틀의 {bg:#fff}{color:#000})를 만나면 첫 `}` 에서
    // 조기 종료해 멀티라인/중괄호 포함 트랜스클루전의 역링크를 누락한다. 공유 헬퍼가
    // render.ts 와 동일하게 슬러그를 정규화(첫 토큰만, 틀:/template:/템플릿: 접두사 부착,
    // # 섹션 앵커 제거)하고 익스텐션(freq:foo 등)을 분류한다.
    for (const t of extractTransclusionTargets(cleaned)) {
        const key = `${t.type}:${t.slug}`;
        if (!seen.has(key)) {
            seen.add(key);
            links.push({ target_slug: t.slug, link_type: t.type });
        }
    }

    // 3) 이미지 참조: images/로 시작하는 R2 키를 파싱
    // 마크다운 ![alt](/media/images/...) 또는 HTML <img src="...images/..."> 등
    // 업로더(media.ts FILENAME_FORBIDDEN)는 한글/영숫자뿐 아니라 일본어/한자/악센트
    // 라틴 등 임의 유니코드를 허용하므로, 화이트리스트 대신 URL/마크다운/HTML 경계를
    // 끊는 문자만 블랙리스트로 제외한다. 비탐욕(`+?`)으로 첫 `.확장자`에서 종료.
    const imageRegex = /images\/[^\s\[\]()<>"'\\?#|^]+?\.\w+/g;
    for (const m of cleaned.matchAll(imageRegex)) {
        const r2Key = m[0].trim();
        const key = `image:${r2Key}`;
        if (!seen.has(key)) {
            seen.add(key);
            links.push({ target_slug: r2Key, link_type: 'image' });
        }
    }

    // 4) {palette:이름} 토큰 — 본문이 참조하는 커스텀 팔레트를 page_links 에 인덱싱.
    // 문서 열람 시 loadPalettesForPage 가 이 인덱스를 참고해 실제로 사용된 팔레트만 SSR 한다.
    // 트랜스클루전된 틀의 본문이 참조하는 팔레트는 이 함수가 보지 못하지만 (틀 본문은 다른
    // 문서에 속하므로 그 문서의 page_links 에 자체 인덱싱돼 있음), loadPalettesForPage 가
    // page_links(link_type='template') 를 통해 합집합으로 끌어온다.
    const paletteRegex = /\{palette:\s*([A-Za-z0-9_-]+)\s*\}/g;
    for (const m of cleaned.matchAll(paletteRegex)) {
        const name = m[1];
        const key = `palette:${name}`;
        if (!seen.has(key)) {
            seen.add(key);
            links.push({ target_slug: name, link_type: 'palette' });
        }
    }

    return links;
}
