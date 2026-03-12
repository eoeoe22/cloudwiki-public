import type { D1Database } from '@cloudflare/workers-types';
import { normalizeSlug } from './slug';

const MAX_TEMPLATE_DEPTH = 3;

/**
 * 텍스트에서 AI 처리에 방해되는 위키 전용 문법을 제거/변환합니다.
 * - [[문서간 링크]]는 변환하지 않고 그대로 유지합니다.
 * - 코드블럭(```) 및 인라인 코드(`) 내부는 문법 처리 없이 그대로 반환합니다.
 * @param content 원본 위키 마크다운
 * @param db 데이터베이스 인스턴스 (틀 트랜스클루전에 사용)
 * @param depth 현재 트랜스클루전 깊이 (무한 루프 방지)
 */
export async function renderForAI(content: string, db: D1Database, depth = 0): Promise<string> {
    if (!content) return '';

    let processed = content;
    const placeholders = new Map<string, string>();
    let placeholderIndex = 0;

    // 코드블럭/인라인 코드 보호: 내부 내용이 위키 문법 처리되지 않도록 플레이스홀더로 치환
    // 1) 펜스 코드블럭 (``` ... ```) 먼저 처리 (멀티라인 포함)
    processed = processed.replace(/```[\s\S]*?```/g, (match) => {
        const key = `\x00FENCED_CODE_${placeholderIndex++}\x00`;
        placeholders.set(key, match);
        return key;
    });

    // 2) 인라인 코드 (`...`)
    processed = processed.replace(/`[^`\n]+`/g, (match) => {
        const key = `\x00INLINE_CODE_${placeholderIndex++}\x00`;
        placeholders.set(key, match);
        return key;
    });

    // 3. {중괄호} 문법 완전 제거
    // {#fff}, {mdi mdi-icon} 등 표 색상, 아이콘 문법을 제거. 내용물까지 모두 제거함.
    processed = processed.replace(/\{[^{}]*\}/g, '');

    // [[문서간 링크]]는 그대로 유지 (변환하지 않음)

    // 4. {{틀 트랜스클루전}} 처리
    if (depth < MAX_TEMPLATE_DEPTH) {
        // 정규식: {{틀이름}} 또는 {{틀:틀이름}} 또는 {{문서이름}}
        const templateRegex = /\{\{([^}]+?)\}\}/g;
        const replacements: { original: string; replacement: string }[] = [];

        // 모든 매치를 먼저 순회하여 비동기 Fetch 작업을 모음
        const matches = Array.from(processed.matchAll(templateRegex));

        for (const m of matches) {
            const original = m[0];
            let templateName = m[1].trim();

            // '틀:' 접두사가 없으면 붙여서 검색하는게 기본 위키 동작
            let targetSlug = templateName;

            if (!targetSlug.startsWith('틀:') && !targetSlug.startsWith('template:') && !targetSlug.startsWith('템플릿:')) {
                targetSlug = '틀:' + targetSlug;
            }

            try {
                const page = await db.prepare('SELECT content FROM pages WHERE slug = ? AND deleted_at IS NULL AND is_private = 0')
                    .bind(normalizeSlug(targetSlug))
                    .first<{ content: string }>();

                if (page && page.content) {
                    // 찾은 틀 내용도 재귀적으로 파싱
                    const parsedTemplate = await renderForAI(page.content, db, depth + 1);
                    replacements.push({ original, replacement: parsedTemplate });
                } else {
                    replacements.push({ original, replacement: '' });
                }
            } catch (e) {
                replacements.push({ original, replacement: '' });
            }
        }

        // 수집된 치환 값들을 원본에서 교체
        for (const { original, replacement } of replacements) {
            processed = processed.replace(new RegExp(original.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g'), replacement);
        }
    } else {
        // 최대 깊이를 초과하면 틀 문법 자체를 텍스트에서 삭제
        processed = processed.replace(/\{\{([^}]+?)\}\}/g, '');
    }

    // 플레이스홀더 복원 (코드블럭/인라인 코드 내용 원상복구)
    for (const [key, value] of placeholders) {
        processed = processed.split(key).join(value);
    }

    return processed;
}

/**
 * 문서에서 헤딩(#) 기반으로 목차만 추출합니다.
 */
export function extractTOC(content: string): string {
    const lines = content.split('\n');
    const toc: string[] = [];

    let inCodeBlock = false;

    for (const line of lines) {
        if (line.trim().startsWith('```')) {
            inCodeBlock = !inCodeBlock;
            continue;
        }

        if (inCodeBlock) continue;

        const match = line.match(/^(#{1,6})\s+(.*)$/);
        if (match) {
            toc.push(`${match[1]} ${match[2].trim()}`);
        }
    }

    return toc.join('\n');
}

/**
 * 문서에서 특정 목차의 내용만 추출합니다.
 * @param content 원본 마크다운
 * @param sectionName 찾을 목차명
 */
export function extractSection(content: string, sectionName: string): string {
    const lines = content.split('\n');
    let inSection = false;
    let sectionLevel = 0;
    const result: string[] = [];
    let inCodeBlock = false;

    const targetSection = sectionName.trim().toLowerCase();

    for (const line of lines) {
        if (line.trim().startsWith('```')) {
            inCodeBlock = !inCodeBlock;
        }

        if (!inCodeBlock) {
            const match = line.match(/^(#{1,6})\s+(.*)$/);
            if (match) {
                const level = match[1].length;
                const title = match[2].trim().toLowerCase();

                if (inSection) {
                    if (level <= sectionLevel) {
                        break;
                    }
                } else if (title === targetSection) {
                    inSection = true;
                    sectionLevel = level;
                    result.push(line);
                    continue;
                }
            }
        }

        if (inSection) {
            result.push(line);
        }
    }

    return result.join('\n');
}

/**
 * 콘텐츠에서 주어진 위치 이전의 마지막 헤딩을 찾습니다.
 */
function findLastHeading(textBefore: string): string {
    const lines = textBefore.split('\n');
    let inCodeBlock = false;
    let lastHeading = '';

    for (const line of lines) {
        if (line.trim().startsWith('```')) {
            inCodeBlock = !inCodeBlock;
            continue;
        }
        if (inCodeBlock) continue;

        const match = line.match(/^(#{1,6})\s+(.+)$/);
        if (match) {
            lastHeading = match[2].trim();
        }
    }
    return lastHeading;
}

/**
 * FTS snippet이 속한 목차(헤딩)를 문서 원본에서 찾습니다.
 * @param content 문서 전체 원본 마크다운
 * @param snippet FTS snippet() 결과 (<b>...</b> 태그 포함 가능)
 */
export function findSectionForSnippet(content: string, snippet: string): string {
    // HTML 태그 및 말줄임표 제거
    const plainSnippet = snippet.replace(/<\/?b>/g, '').replace(/\.\.\./g, ' ').trim();

    // 의미있는 단어 추출 (3글자 초과)
    const words = plainSnippet.split(/\s+/).filter(w => w.length > 3);
    if (words.length === 0) return '';

    // 연속된 단어로 검색 시도 (최대 4개)
    const searchWords = words.slice(0, Math.min(4, words.length));
    const escapedWords = searchWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const searchRegex = new RegExp(escapedWords.join('\\s+'), 'i');

    let matchIndex = searchRegex.exec(content)?.index;

    // 실패하면 첫 단어만으로 재시도
    if (matchIndex === undefined) {
        const fallbackRegex = new RegExp(escapedWords[0], 'i');
        matchIndex = fallbackRegex.exec(content)?.index;
    }

    if (matchIndex === undefined) return '';

    return findLastHeading(content.substring(0, matchIndex));
}
