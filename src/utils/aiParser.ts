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
export async function renderForAI(content: string, db: D1Database, depth = 0, currentSlug?: string): Promise<string> {
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

        // 모든 매치를 먼저 순회하여 슬러그 목록을 모음
        const matches = Array.from(processed.matchAll(templateRegex));

        if (matches.length > 0) {
            // 1) 슬러그 목록 추출 (중복 제거)
            const slugMap = new Map<string, string>(); // normalizedSlug -> original match text
            const selfRefSlugs = new Set<string>(); // 자기 자신을 참조하는 슬러그
            for (const m of matches) {
                let targetSlug = m[1].trim();
                if (!targetSlug.startsWith('틀:') && !targetSlug.startsWith('template:') && !targetSlug.startsWith('템플릿:')) {
                    targetSlug = '틀:' + targetSlug;
                }
                const normalized = normalizeSlug(targetSlug);
                // 자기 자신을 참조하는 틀은 건너뛰기
                if (currentSlug && normalized === normalizeSlug(currentSlug)) {
                    selfRefSlugs.add(normalized);
                    continue;
                }
                if (!slugMap.has(normalized)) {
                    slugMap.set(normalized, targetSlug);
                }
            }

            // 2) IN 절을 사용하여 한 번의 쿼리로 모든 틀 내용을 배치 조회
            const slugList = Array.from(slugMap.keys());
            const templateContents = new Map<string, string>();

            // D1은 단일 prepare에 IN절 바인딩이 제한적이므로 batch 사용
            const batchStatements = slugList.map(slug =>
                db.prepare('SELECT slug, content FROM pages WHERE slug = ? AND deleted_at IS NULL AND is_private = 0').bind(slug)
            );

            try {
                const batchResults = await db.batch<{ slug: string; content: string }>(batchStatements);
                for (const result of batchResults) {
                    if (result.results && result.results.length > 0) {
                        const row = result.results[0];
                        templateContents.set(row.slug, row.content);
                    }
                }
            } catch {
                // 배치 실패 시 빈 결과로 처리
            }

            // 3) 조회된 틀 내용을 재귀적으로 파싱
            const parsedTemplates = new Map<string, string>();
            const parsePromises: Promise<void>[] = [];

            for (const [normalized] of slugMap) {
                const content = templateContents.get(normalized);
                if (content) {
                    parsePromises.push(
                        renderForAI(content, db, depth + 1, normalized).then(parsed => {
                            parsedTemplates.set(normalized, parsed);
                        })
                    );
                }
            }
            await Promise.all(parsePromises);

            // 4) 수집된 치환 값들을 원본에서 교체
            for (const m of matches) {
                const original = m[0];
                let targetSlug = m[1].trim();
                if (!targetSlug.startsWith('틀:') && !targetSlug.startsWith('template:') && !targetSlug.startsWith('템플릿:')) {
                    targetSlug = '틀:' + targetSlug;
                }
                const normalized = normalizeSlug(targetSlug);
                // 자기 참조 틀은 빈 문자열로 치환
                const replacement = selfRefSlugs.has(normalized) ? '' : (parsedTemplates.get(normalized) || '');
                processed = processed.replace(new RegExp(original.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g'), replacement);
            }
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
