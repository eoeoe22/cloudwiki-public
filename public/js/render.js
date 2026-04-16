// ── 타임스탬프 유틸리티 ──

/**
 * {dday:YYYY-MM-DD} → "n일 남음" / "D-Day" / "n일 지남"
 * {dday:MM-DD}     → 다음 MM-DD까지 "n일 남음" / "D-Day" (해가 지나면 365일부터 다시)
 */
function _computeDdayText(dateStr) {
    const parts = dateStr.split('-');
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (parts.length === 2) {
        const month = parseInt(parts[0], 10);
        const day = parseInt(parts[1], 10);
        if (isNaN(month) || isNaN(day)) return null;
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        // 달력상 존재할 수 없는 조합 거부 (02-30, 04-31 등). 02-29는 윤년에만 유효하므로 허용.
        const maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
        if (day > maxDay) return null;
        // 오늘 이후의 가장 가까운 유효한 MM-DD 찾기 (02-29는 다음 윤년으로 스킵)
        // 세기 경계(예: 2100은 비윤년)에서는 2096→2104처럼 최대 8년 간격이 발생하므로 i=8까지 포함.
        let year = today.getFullYear();
        let target = null;
        for (let i = 0; i <= 8; i++) {
            const candidate = new Date(year + i, month - 1, day);
            candidate.setHours(0, 0, 0, 0);
            const valid = candidate.getMonth() === month - 1 && candidate.getDate() === day;
            if (valid && candidate >= today) {
                target = candidate;
                break;
            }
        }
        if (target === null) return null;
        const diff = Math.round((target - today) / (1000 * 60 * 60 * 24));
        if (diff === 0) return 'D-Day';
        return `${diff}일 남음`;
    }

    if (parts.length !== 3) return null;
    const target = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    target.setHours(0, 0, 0, 0);
    if (isNaN(target.getTime())) return null;
    const diff = Math.round((target - today) / (1000 * 60 * 60 * 24));
    if (diff > 0) return `${diff}일 남음`;
    if (diff === 0) return 'D-Day';
    return `${Math.abs(diff)}일 지남`;
}

/** {time:UNIX} → 날짜+시간 문자열 */
function _formatUnixTime(unixSec) {
    const d = new Date(unixSec * 1000);
    if (isNaN(d.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** {timer:UNIX} → "n년 n달 n일 n시간 n분 n초 남음/지남" (0인 단위 제거) */
function _computeTimerText(unixSec) {
    const now = Math.floor(Date.now() / 1000);
    const diff = unixSec - now;
    const s = Math.abs(diff);
    const years   = Math.floor(s / (365 * 24 * 3600));
    const months  = Math.floor((s % (365 * 24 * 3600)) / (30 * 24 * 3600));
    const days    = Math.floor((s % (30 * 24 * 3600)) / (24 * 3600));
    const hours   = Math.floor((s % (24 * 3600)) / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const seconds = s % 60;
    const parts = [];
    if (years   > 0) parts.push(`${years}년`);
    if (months  > 0) parts.push(`${months}달`);
    if (days    > 0) parts.push(`${days}일`);
    if (hours   > 0) parts.push(`${hours}시간`);
    if (minutes > 0) parts.push(`${minutes}분`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}초`);
    return parts.join(' ') + (diff >= 0 ? ' 남음' : ' 지남');
}

// containerId → intervalId (타이머 중복 방지)
const _timerIntervalMap = {};

function _initTimers(containerEl, containerId) {
    if (_timerIntervalMap[containerId]) {
        clearInterval(_timerIntervalMap[containerId]);
        delete _timerIntervalMap[containerId];
    }
    const timerEls = containerEl.querySelectorAll('.wiki-timer[data-unix]');
    if (timerEls.length === 0) return;
    function tick() {
        timerEls.forEach(el => {
            const unix = parseInt(el.getAttribute('data-unix'), 10);
            if (!isNaN(unix)) el.textContent = _computeTimerText(unix);
        });
    }
    tick();
    _timerIntervalMap[containerId] = setInterval(tick, 1000);
}

/** {age:YYYY-MM-DD} → 만 나이 (국제 표준) */
function _computeAge(dateStr) {
    const parts = dateStr.split('-');
    if (parts.length !== 3) return null;
    const birth = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    if (isNaN(birth.getTime())) return null;
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
    if (age < 0) return null;
    return `${age}세`;
}

/** HTML 문자열 내의 타임스탬프 문법을 span 태그로 치환 (코드블록 제외) */
function _processTimestampsInHtml(html) {
    // <pre>…</pre> 및 인라인 <code>…</code> 내부는 건드리지 않음
    const prot = [];
    html = html.replace(/<pre[\s\S]*?<\/pre>/gi, (m) => {
        prot.push(m);
        return `\x00TSPROT${prot.length - 1}\x00`;
    });
    html = html.replace(/<code[^>]*>[\s\S]*?<\/code>/gi, (m) => {
        prot.push(m);
        return `\x00TSPROT${prot.length - 1}\x00`;
    });

    // {dday:YYYY-MM-DD} 또는 {dday:MM-DD}
    html = html.replace(/\{dday:(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})\}/g, (match, dateStr) => {
        const text = _computeDdayText(dateStr);
        if (text === null) return match;
        const cls = text === 'D-Day' ? 'wiki-dday wiki-dday-today'
            : text.endsWith('남음') ? 'wiki-dday wiki-dday-future'
            : 'wiki-dday wiki-dday-past';
        return `<span class="${cls}" title="${dateStr}">${text}</span>`;
    });
    // {time:UNIX}
    html = html.replace(/\{time:(\d+)\}/g, (match, unixStr) => {
        const text = _formatUnixTime(parseInt(unixStr, 10));
        if (text === null) return match;
        return `<span class="wiki-timestamp" title="Unix: ${unixStr}">${text}</span>`;
    });
    // {timer:UNIX}
    html = html.replace(/\{timer:(\d+)\}/g, (match, unixStr) => {
        const unix = parseInt(unixStr, 10);
        const text = _computeTimerText(unix);
        return `<span class="wiki-timer" data-unix="${unix}" title="Unix: ${unixStr}">${text}</span>`;
    });
    // {age:YYYY-MM-DD}
    html = html.replace(/\{age:(\d{4}-\d{2}-\d{2})\}/g, (match, dateStr) => {
        const text = _computeAge(dateStr);
        if (text === null) return match;
        return `<span class="wiki-age" title="${dateStr}">${text}</span>`;
    });

    // 보호했던 코드블록 복원
    html = html.replace(/\x00TSPROT(\d+)\x00/g, (_, i) => prot[parseInt(i, 10)]);
    return html;
}

// ── 위키 링크 보호 유틸리티 ──

/** [[링크|텍스트]] 구문을 플레이스홀더로 치환하여 마크다운 파서로부터 보호 */
function protectWikiLinks(text) {
    const prot = [];
    const protected_text = text.replace(/\[\[[^\]]+\]\]/g, (m) => {
        prot.push(m);
        return `\x00WLPROT${prot.length - 1}\x00`;
    });
    return { text: protected_text, prot };
}

/** protectWikiLinks 로 치환한 플레이스홀더를 원래 위키 링크로 복원 */
function restoreWikiLinks(html, prot) {
    return html.replace(/\x00WLPROT(\d+)\x00/g, (_, i) => prot[parseInt(i, 10)]);
}

// ── 문서 렌더링 통합 (index.html, edit.html 공통) ──
async function renderWikiContent(content, slug, containerId, options = {}) {
    const containerEl = document.getElementById(containerId);
    if (!containerEl) return;

    try {
        const resolvedContent = await resolveTransclusions(content || '', slug);

        const codeBlocksForFold = [];
        let foldInput = resolvedContent.replace(/^(`{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$|`[^`\n]+`/gm, (m) => {
            const idx = codeBlocksForFold.length;
            codeBlocksForFold.push(m);
            return `WIKICODEFPH${idx}XEND`;
        });

        foldInput = foldInput.replace(/^[\u200B\uFEFF]+(\[[-+])/gm, '$1');

        const foldRegex = /^\[\+\s*(.*?)\s*\][ \t]*\n((?:(?!^\[-\][ \t]*$)[\s\S])*?)\n\[-\][ \t]*$/gm;
        const foldBlocks = [];
        let preprocessed = foldInput.replace(foldRegex, (match, titleLine, foldContent) => {
            foldContent = foldContent.replace(/^\n+|\n+$/g, '');
            let summaryText = titleLine;
            let bgOpt = '';
            let colorOpt = '';

            let replaced = true;
            while (replaced) {
                replaced = false;
                let bgMatch = summaryText.match(/\{bg:\s*([^}]+)\}/);
                if (bgMatch) { bgOpt = escapeHtml(bgMatch[1].trim()); summaryText = summaryText.replace(bgMatch[0], ''); replaced = true; }
                let colorMatch = summaryText.match(/\{color:\s*([^}]+)\}/);
                if (colorMatch) { colorOpt = escapeHtml(colorMatch[1].trim()); summaryText = summaryText.replace(colorMatch[0], ''); replaced = true; }
            }

            summaryText = escapeHtml(summaryText.trim());

            let bgAttr = bgOpt ? ` data-bg="${bgOpt}"` : '';
            let colorAttr = colorOpt ? ` data-color="${colorOpt}"` : '';

            const idx = foldBlocks.length;

            const restoredContent = foldContent.replace(/WIKICODEFPH(\d+)XEND/g, (_, i) => codeBlocksForFold[parseInt(i, 10)]);
            // [[링크|텍스트]] 안의 | 가 마크다운 테이블 구분자와 충돌하지 않도록 보호
            const { text: restoredContentProt, prot: foldWikiLinkProt } = protectWikiLinks(restoredContent);
            let rawContentHtml = (typeof marked !== 'undefined') ? marked.parse(restoredContentProt) : restoredContentProt;
            rawContentHtml = restoreWikiLinks(rawContentHtml, foldWikiLinkProt);
            rawContentHtml = rawContentHtml.replace(/<img([^>]*)>\s*\{size:([a-zA-Z0-9_-]+)\}/g, (_, attrs, size) => `<img${attrs} data-size="${size.trim()}">`);
            let contentHtml = (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(rawContentHtml, { ADD_TAGS: ['i', 'span', 'details', 'summary'], ADD_ATTR: ['class', 'style', 'data-bg', 'data-color', 'data-size', 'data-unix', 'colspan', 'rowspan', 'title'] }) : escapeHtml(rawContentHtml);

            foldBlocks.push({ summaryText, bgAttr, colorAttr, contentHtml });
            return `\n\nWIKIFOLDPH${idx}XEND\n\n`;
        });

        preprocessed = preprocessed.replace(/WIKICODEFPH(\d+)XEND/g, (_, idx) => codeBlocksForFold[parseInt(idx, 10)]);

        // [[링크|텍스트]] 안의 | 가 마크다운 테이블 구분자와 충돌하지 않도록 보호
        const { text: preprocessedProt, prot: mainWikiLinkProt } = protectWikiLinks(preprocessed);
        let rawHtml = (typeof marked !== 'undefined') ? marked.parse(preprocessedProt) : preprocessedProt;
        rawHtml = restoreWikiLinks(rawHtml, mainWikiLinkProt);
        rawHtml = rawHtml.replace(/<img([^>]*)>\s*\{size:([a-zA-Z0-9_-]+)\}/g, (_, attrs, size) => `<img${attrs} data-size="${size.trim()}">`);

        rawHtml = rawHtml.replace(/(?:<p>)?WIKIFOLDPH(\d+)XEND(?:<\/p>)?/g, (m, idx) => {
            const block = foldBlocks[parseInt(idx, 10)];
            if (!block) return '';
            return `<details class="wiki-fold border rounded mb-3"${block.bgAttr}${block.colorAttr}>` +
                `<summary class="fw-bold p-2 wiki-fold-summary">${block.summaryText}</summary>` +
                `<div class="wiki-fold-content p-3 border-top">${block.contentHtml}</div>` +
                `</details>`;
        });
        // 익스텐션 플레이스홀더를 div 태그로 변환 (DOMPurify 전에)
        rawHtml = rawHtml.replace(/(?:<p>)?WIKIEXTPH_([a-zA-Z0-9]+)_(\d+)_XEND(?:<\/p>)?/g, (m, extName, idx) => {
            return `<div class="wiki-ext wiki-ext-${escapeHtml(extName)}" data-ext-name="${escapeHtml(extName)}" data-ext-idx="${escapeHtml(idx)}"></div>`;
        });

        let html = (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(rawHtml, { ADD_TAGS: ['i', 'span', 'details', 'summary', 'div', 'canvas'], ADD_ATTR: ['class', 'style', 'data-bg', 'data-color', 'data-size', 'data-unix', 'data-ext-name', 'data-ext-idx', 'colspan', 'rowspan', 'title'] }) : escapeHtml(rawHtml);

        if (options.showCategory && slug) {
            const decodedSlug = decodeURIComponent(slug);
            if (decodedSlug.startsWith('카테고리:')) {
                const categoryName = decodedSlug.replace(/^카테고리:/, '');
                const listHtml = await fetchCategoryList(categoryName);
                if (listHtml) {
                    html += (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(listHtml, { ADD_TAGS: ['i', 'span'], ADD_ATTR: ['class', 'title'] }) : escapeHtml(listHtml);
                }
            }
        }

        // 타임스탬프 문법 처리
        html = _processTimestampsInHtml(html);

        containerEl.innerHTML = html;

        // 테이블 색상 적용
        containerEl.querySelectorAll('td, th').forEach(cell => {
            let walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null, false);
            let firstTextNode = walker.nextNode();
            if (firstTextNode) {
                let val = firstTextNode.nodeValue;
                let replaced = true;

                while (replaced) {
                    replaced = false;
                    let bgMatch = val.match(/^([\s]*)\{bg:\s*([^}]+)\}/);
                    if (bgMatch) {
                        const colorValue = bgMatch[2].trim();
                        if (_isSafeCssColor(colorValue)) cell.style.backgroundColor = colorValue;
                        val = val.replace(bgMatch[0], '');
                        replaced = true;
                    }
                    let colorMatch = val.match(/^([\s]*)\{color:\s*([^}]+)\}/);
                    if (colorMatch) {
                        const colorValue = colorMatch[2].trim();
                        if (_isSafeCssColor(colorValue)) cell.style.color = colorValue;
                        val = val.replace(colorMatch[0], '');
                        replaced = true;
                    }
                }
                firstTextNode.nodeValue = val;
            }
        });

        // 테이블 셀 병합 처리 (colspan/rowspan)
        containerEl.querySelectorAll('table').forEach(table => {
            const rows = Array.from(table.querySelectorAll(':scope > thead > tr, :scope > tbody > tr, :scope > tr'));
            if (rows.length === 0) return;

            // {^} 병합이 thead/tbody 경계를 넘는 경우 rowspan이 작동하지 않으므로,
            // thead 행을 tbody로 이동하고 th를 td로 변환
            const thead = table.querySelector(':scope > thead');
            const tbody = table.querySelector(':scope > tbody');
            if (thead && tbody) {
                const hasVerticalMerge = Array.from(tbody.querySelectorAll('td, th')).some(cell => cell.textContent.trim().match(/^\{\^\}$/));
                if (hasVerticalMerge) {
                    const theadRows = Array.from(thead.querySelectorAll('tr'));
                    theadRows.forEach(tr => {
                        Array.from(tr.querySelectorAll('th')).forEach(th => {
                            const td = document.createElement('td');
                            td.innerHTML = th.innerHTML;
                            Array.from(th.attributes).forEach(attr => td.setAttribute(attr.name, attr.value));
                            td.style.fontWeight = 'bold';
                            td.style.textAlign = th.style.textAlign || 'center';
                            th.replaceWith(td);
                        });
                        tbody.insertBefore(tr, tbody.firstChild);
                    });
                    thead.remove();
                }
            }

            // 행 목록을 재구성 (thead가 이동되었을 수 있으므로)
            const updatedRows = Array.from(table.querySelectorAll(':scope > thead > tr, :scope > tbody > tr, :scope > tr'));
            if (updatedRows.length === 0) return;

            const grid = updatedRows.map(row => Array.from(row.cells));
            const markers = grid.map(row => row.map(cell => {
                const text = cell.textContent.trim();
                const m = text.match(/^\{(><|[<>^])\}$/);
                return m ? m[1] : null;
            }));

            const toRemove = grid.map(row => row.map(() => false));

            // {<} 처리 (왼쪽 병합)
            for (let r = 0; r < grid.length; r++) {
                for (let c = 1; c < grid[r].length; c++) {
                    if (markers[r][c] === '<') {
                        let target = c - 1;
                        while (target >= 0 && markers[r][target] === '<') target--;
                        if (target >= 0 && !toRemove[r][target]) {
                            const currentSpan = parseInt(grid[r][target].getAttribute('colspan') || '1');
                            grid[r][target].setAttribute('colspan', currentSpan + 1);
                            toRemove[r][c] = true;
                        }
                    }
                }
            }

            // {>} 처리 (오른쪽 병합)
            for (let r = 0; r < grid.length; r++) {
                for (let c = grid[r].length - 2; c >= 0; c--) {
                    if (markers[r][c] === '>') {
                        let target = c + 1;
                        while (target < grid[r].length && markers[r][target] === '>') target++;
                        if (target < grid[r].length && !toRemove[r][target]) {
                            const currentSpan = parseInt(grid[r][target].getAttribute('colspan') || '1');
                            grid[r][target].setAttribute('colspan', currentSpan + 1);
                            toRemove[r][c] = true;
                        }
                    }
                }
            }

            // {^} 처리 (위쪽 병합)
            for (let r = 1; r < grid.length; r++) {
                for (let c = 0; c < grid[r].length; c++) {
                    if (markers[r][c] === '^') {
                        if (toRemove[r][c]) continue;
                        let target = r - 1;
                        while (target >= 0 && markers[target][c] === '^') target--;
                        if (target >= 0 && c < grid[target].length) {
                            const currentSpan = parseInt(grid[target][c].getAttribute('rowspan') || '1');
                            grid[target][c].setAttribute('rowspan', currentSpan + 1);
                            toRemove[r][c] = true;
                        }
                    }
                }
            }

            // {><} 처리 (양쪽 분할 병합)
            const hasDoubleMerge = markers.some(row => row.some(m => m === '><'));
            if (hasDoubleMerge) {
                // 모든 셀의 colspan을 2배로 확대하여 반분할 가능하게 함
                for (let r = 0; r < grid.length; r++) {
                    for (let c = 0; c < grid[r].length; c++) {
                        const currentSpan = parseInt(grid[r][c].getAttribute('colspan') || '1');
                        grid[r][c].setAttribute('colspan', currentSpan * 2);
                    }
                }

                // {><} 마커 셀의 공간을 양쪽 이웃에 균등 분배
                for (let r = 0; r < grid.length; r++) {
                    for (let c = 0; c < grid[r].length; c++) {
                        if (markers[r][c] !== '><') continue;

                        let left = c - 1;
                        while (left >= 0 && (toRemove[r][left] || markers[r][left] === '><')) left--;
                        let right = c + 1;
                        while (right < grid[r].length && (toRemove[r][right] || markers[r][right] === '><')) right++;

                        const hasLeft = left >= 0;
                        const hasRight = right < grid[r].length;

                        if (hasLeft && hasRight) {
                            const leftSpan = parseInt(grid[r][left].getAttribute('colspan') || '1');
                            grid[r][left].setAttribute('colspan', leftSpan + 1);
                            const rightSpan = parseInt(grid[r][right].getAttribute('colspan') || '1');
                            grid[r][right].setAttribute('colspan', rightSpan + 1);
                        } else if (hasLeft) {
                            const leftSpan = parseInt(grid[r][left].getAttribute('colspan') || '1');
                            grid[r][left].setAttribute('colspan', leftSpan + 2);
                        } else if (hasRight) {
                            const rightSpan = parseInt(grid[r][right].getAttribute('colspan') || '1');
                            grid[r][right].setAttribute('colspan', rightSpan + 2);
                        }
                        toRemove[r][c] = true;
                    }
                }
            }

            // 병합 마커 셀 제거 및 병합된 셀 가운데 정렬
            for (let r = 0; r < grid.length; r++) {
                for (let c = grid[r].length - 1; c >= 0; c--) {
                    if (toRemove[r][c]) {
                        grid[r][c].remove();
                    } else {
                        const cell = grid[r][c];
                        if (cell.getAttribute('colspan') > 1 || cell.getAttribute('rowspan') > 1) {
                            if (!cell.style.textAlign) cell.style.textAlign = 'center';
                            if (!cell.style.verticalAlign) cell.style.verticalAlign = 'middle';
                        }
                    }
                }
            }
        });

        // Fold 색상 적용
        containerEl.querySelectorAll('.wiki-fold').forEach(fold => {
            const bg = fold.getAttribute('data-bg');
            const color = fold.getAttribute('data-color');
            if (bg && _isSafeCssColor(bg)) fold.style.backgroundColor = bg;
            if (color && _isSafeCssColor(color)) {
                const summary = fold.querySelector('summary');
                if (summary) summary.style.color = color;
            }
        });

        processWikiLinks(containerEl);
        processFootnotes(containerEl);

        // 카테고리 링크 SPA 내비게이션 (인라인 onclick 대체)
        if (typeof navigateTo === 'function') {
            containerEl.querySelectorAll('.wiki-spa-link').forEach(a => {
                a.addEventListener('click', (e) => {
                    e.preventDefault();
                    navigateTo(a.href);
                });
            });
        }

        // YouTube / Niconico Embed Processing
        containerEl.querySelectorAll('a').forEach(a => {
            const href = a.getAttribute('href');
            if (!href) return;

            // Must be the only text inside a block level element, specifically a paragraph
            const parent = a.parentElement;
            if (!parent || parent.tagName !== 'P') return;
            if (parent.textContent.trim() !== a.textContent.trim()) return;

            // Must not be a custom markdown link. If text exactly matches href or its domain, we allow it.
            // Also ignore if it is inside a blockquote, a code block, or a footnote
            if (a.closest('code, pre') || a.closest('.wiki-fn-ref')) return;

            // Checking if the link display text looks like a URL instead of custom text
            const textContent = a.textContent.trim();
            let textLooksLikeGoogleMaps = false;
            try {
                const tcUrl = new URL(textContent);
                const h = tcUrl.hostname;
                textLooksLikeGoogleMaps = (h === 'www.google.com' || h === 'google.com' || h === 'maps.google.com' || h === 'goo.gl' || h === 'maps.app.goo.gl');
            } catch (e) { /* textContent가 URL 형식이 아닌 경우 무시 */ }
            if (!textContent.includes('youtube.com') && !textContent.includes('youtu.be') && !textContent.includes('nicovideo.jp') && !textContent.includes('spotify.com') && !textLooksLikeGoogleMaps) return;

            // Spotify Embed Processing
            if (href.includes('open.spotify.com')) {
                try {
                    const url = new URL(href, window.location.origin);
                    const pathParts = url.pathname.split('/').filter(Boolean); // e.g. ["track", "ID"]

                    if (pathParts.length >= 2) {
                        const type = pathParts[0];
                        const id = pathParts[1];
                        const allowedTypes = ['track', 'album', 'playlist', 'artist', 'show', 'episode'];

                        if (allowedTypes.includes(type)) {
                            const container = document.createElement('div');
                            container.className = 'spotify-embed-container my-3';

                            const iframe = document.createElement('iframe');
                            const embedUrl = `https://open.spotify.com/embed/${type}/${id}${url.search}`;

                            iframe.setAttribute('src', embedUrl);
                            iframe.setAttribute('width', '100%');
                            // 트랙/에피소드는 짧게(152px), 나머지는 길게(352px) 설정
                            iframe.setAttribute('height', (type === 'track' || type === 'episode') ? '152' : '352');
                            iframe.setAttribute('frameborder', '0');
                            iframe.setAttribute('allow', 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture');
                            iframe.setAttribute('loading', 'lazy');
                            iframe.style.borderRadius = '12px';

                            container.appendChild(iframe);
                            parent.replaceWith(container);
                            return;
                        }
                    }
                } catch (e) {
                    console.error('Spotify embed error:', e);
                }
            }

            // Google Maps Embed Processing
            try {
                const mapUrl = new URL(href);
                const mh = mapUrl.hostname;
                const isGoogleMapsHost = (
                    ((mh === 'www.google.com' || mh === 'google.com' || mh === 'maps.google.com') && mapUrl.pathname.startsWith('/maps')) ||
                    (mh === 'goo.gl' && mapUrl.pathname.startsWith('/maps')) ||
                    mh === 'maps.app.goo.gl'
                );
                if (isGoogleMapsHost) {
                    let embedUrl;
                    if (mapUrl.pathname.startsWith('/maps/embed')) {
                        embedUrl = href;
                    } else {
                        mapUrl.searchParams.set('output', 'embed');
                        embedUrl = mapUrl.toString();
                    }

                    const container = document.createElement('div');
                    container.className = 'maps-embed-container my-3';
                    container.style.width = '100%';

                    const iframe = document.createElement('iframe');
                    iframe.setAttribute('src', embedUrl);
                    iframe.setAttribute('width', '100%');
                    iframe.setAttribute('height', '400');
                    iframe.setAttribute('frameborder', '0');
                    iframe.setAttribute('style', 'border:0; border-radius:8px;');
                    iframe.setAttribute('allowfullscreen', '');
                    iframe.setAttribute('loading', 'lazy');
                    iframe.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');

                    container.appendChild(iframe);
                    parent.replaceWith(container);
                    return;
                }
            } catch (e) {
                console.error('Google Maps embed error:', e);
            }

            // YouTube Embed Processing (Improved)
            if (href.includes('youtube.com') || href.includes('youtu.be')) {
                try {
                    const url = new URL(href, window.location.origin);
                    let videoId = '';
                    let listId = url.searchParams.get('list');
                    let start = url.searchParams.get('t');

                    if (url.hostname.includes('youtu.be')) {
                        videoId = url.pathname.slice(1);
                    } else if (url.pathname === '/watch') {
                        videoId = url.searchParams.get('v');
                    } else if (url.pathname.startsWith('/shorts/')) {
                        videoId = url.pathname.split('/')[2];
                    } else if (url.pathname.startsWith('/live/')) {
                        videoId = url.pathname.split('/')[2];
                    } else if (url.pathname === '/playlist' && listId) {
                        // Playlist only URL
                        const iframeWrapper = document.createElement('div');
                        iframeWrapper.className = 'ratio ratio-16x9 my-3';
                        iframeWrapper.style.maxWidth = '100%';
                        const ytIframe = document.createElement('iframe');
                        ytIframe.setAttribute('src', `https://www.youtube.com/embed/videoseries?list=${encodeURIComponent(listId)}`);
                        ytIframe.setAttribute('title', 'YouTube playlist player');
                        ytIframe.setAttribute('frameborder', '0');
                        ytIframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture');
                        ytIframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
                        ytIframe.setAttribute('allowfullscreen', '');
                        iframeWrapper.appendChild(ytIframe);
                        parent.replaceWith(iframeWrapper);
                        return;
                    }

                    if (videoId) {
                        const queryParams = [];
                        if (start) {
                            // handle format like 1m30s or 90
                            let seconds = 0;
                            const timeMatch = start.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
                            if (timeMatch && (timeMatch[1] || timeMatch[2] || timeMatch[3])) {
                                seconds = (parseInt(timeMatch[1] || 0) * 3600) + (parseInt(timeMatch[2] || 0) * 60) + parseInt(timeMatch[3] || 0);
                            } else {
                                seconds = parseInt(start, 10);
                            }
                            if (!isNaN(seconds)) queryParams.push(`start=${seconds}`);
                        }
                        if (listId) {
                            queryParams.push(`list=${encodeURIComponent(listId)}`);
                        }
                        const query = queryParams.length > 0 ? '?' + queryParams.join('&') : '';

                        const iframeWrapper = document.createElement('div');
                        iframeWrapper.className = 'ratio ratio-16x9 my-3';
                        iframeWrapper.style.maxWidth = '100%';
                        const ytIframe = document.createElement('iframe');
                        ytIframe.setAttribute('src', `https://www.youtube.com/embed/${encodeURIComponent(videoId)}${query}`);
                        ytIframe.setAttribute('title', 'YouTube video player');
                        ytIframe.setAttribute('frameborder', '0');
                        ytIframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture');
                        ytIframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
                        ytIframe.setAttribute('allowfullscreen', '');
                        iframeWrapper.appendChild(ytIframe);
                        parent.replaceWith(iframeWrapper);
                        return;
                    }
                } catch (e) {
                    console.error('YouTube embed error:', e);
                }
            }

            const nicoMatch = href.match(/^https?:\/\/(?:www\.)?nicovideo\.jp\/watch\/([a-zA-Z0-9_-]+)(.*)$/);
            if (nicoMatch) {
                const videoId = nicoMatch[1];
                const params = nicoMatch[2] || '';
                // convert ?from= or &from= to from=
                const timeMatch = params.match(/[?&]from=(\d+)/);
                let query = '';
                if (timeMatch) {
                    query = `?from=${parseInt(timeMatch[1], 10)}`;
                }
                const iframeWrapper = document.createElement('div');
                iframeWrapper.className = 'ratio ratio-16x9 my-3';
                iframeWrapper.style.maxWidth = '100%';
                const nicoIframe = document.createElement('iframe');
                nicoIframe.setAttribute('src', `https://embed.nicovideo.jp/watch/${encodeURIComponent(videoId)}${query}`);
                nicoIframe.setAttribute('frameborder', '0');
                nicoIframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
                nicoIframe.setAttribute('allowfullscreen', '');
                iframeWrapper.appendChild(nicoIframe);
                parent.replaceWith(iframeWrapper);
                return;
            }
        });

        const popoverTriggerList = [].slice.call(containerEl.querySelectorAll('[data-bs-toggle="popover"]'));
        if (typeof bootstrap !== 'undefined') {
            popoverTriggerList.map(function (popoverTriggerEl) {
                return new bootstrap.Popover(popoverTriggerEl, { html: false });
            });
        }

        containerEl.querySelectorAll('a').forEach(a => {
            const href = a.getAttribute('href');
            if (href && (href.startsWith('http://') || href.startsWith('https://')) && a.hostname && a.hostname !== window.location.hostname) {
                a.onclick = (e) => {
                    e.preventDefault();
                    if (typeof Swal !== 'undefined') {
                        Swal.fire({
                            title: '외부 링크 이동',
                            html: `외부 링크 <b>${escapeHtml(href)}</b> 로 이동합니다.<br>계속하시겠습니까?`,
                            icon: 'warning',
                            showCancelButton: true,
                            confirmButtonText: '예',
                            cancelButtonText: '아니오'
                        }).then((result) => {
                            if (result.isConfirmed) window.open(href, '_blank');
                        });
                    } else {
                        if (confirm(`외부 링크 ${href} 로 이동하시겠습니까?`)) {
                            window.open(href, '_blank');
                        }
                    }
                };
            }
        });

        containerEl.querySelectorAll('table').forEach(t => {
            t.classList.add('table', 'table-bordered');
            const wrapper = document.createElement('div');
            wrapper.className = 'table-responsive';
            t.parentNode.insertBefore(wrapper, t);
            wrapper.appendChild(t);
        });

        containerEl.querySelectorAll('img').forEach(img => {
            if (img.getAttribute('data-size') !== 'icon') {
                img.classList.add('img-fluid');
            }
            if (!img.hasAttribute('loading')) {
                img.setAttribute('loading', 'lazy');
            }
        });

        // 코드블럭 복사 버튼 추가 및 언어 하이라이팅 감지
        let requirePrism = false;
        containerEl.querySelectorAll('pre').forEach(pre => {
            const codeEl = pre.querySelector('code');
            if (codeEl) {
                const hasLanguage = Array.from(codeEl.classList).some(cls => cls.startsWith('language-') && cls !== 'language-');
                if (hasLanguage) {
                    requirePrism = true;
                }
            }

            if (pre.parentNode.classList.contains('wiki-code-wrapper')) return;

            const wrapper = document.createElement('div');
            wrapper.className = 'wiki-code-wrapper';
            pre.parentNode.insertBefore(wrapper, pre);
            wrapper.appendChild(pre);

            const copyBtn = document.createElement('button');
            copyBtn.className = 'btn-copy-code';
            copyBtn.title = '코드 복사';
            copyBtn.innerHTML = '<i class="bi bi-copy"></i>';

            copyBtn.onclick = async () => {
                try {
                    const textToCopy = pre.innerText || pre.textContent;
                    await navigator.clipboard.writeText(textToCopy);
                    copyBtn.innerHTML = '<i class="bi bi-check-lg"></i>';
                    setTimeout(() => { copyBtn.innerHTML = '<i class="bi bi-copy"></i>'; }, 2000);
                } catch (err) {
                    const textarea = document.createElement('textarea');
                    textarea.value = pre.innerText || pre.textContent;
                    document.body.appendChild(textarea);
                    textarea.select();
                    try {
                        document.execCommand('copy');
                        copyBtn.innerHTML = '<i class="bi bi-check-lg"></i>';
                        setTimeout(() => { copyBtn.innerHTML = '<i class="bi bi-copy"></i>'; }, 2000);
                    } catch (e) { /* ignore */ }
                    document.body.removeChild(textarea);
                }
            };

            wrapper.appendChild(copyBtn);
        });

        // ── 코드블럭 문법 하이라이팅 (Prism.js Autoloader 연동) ──
        // 코드블럭이 아무 문법이 아니라면 라이브러리를 불러오지 않음
        if (requirePrism) {
            if (typeof window.Prism === 'undefined') {
                if (!document.getElementById('prism-core-script')) {
                    const prismCss = document.createElement('link');
                    prismCss.rel = 'stylesheet';
                    prismCss.href = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css';
                    document.head.appendChild(prismCss);

                    const prismCore = document.createElement('script');
                    prismCore.id = 'prism-core-script';
                    prismCore.src = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-core.min.js';
                    prismCore.onload = () => {
                        const prismAutoloader = document.createElement('script');
                        prismAutoloader.id = 'prism-autoloader-script';
                        prismAutoloader.src = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/plugins/autoloader/prism-autoloader.min.js';
                        prismAutoloader.onload = () => {
                            Prism.plugins.autoloader.languages_path = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/';
                            document.querySelectorAll('pre code[class*="language-"]').forEach(el => Prism.highlightElement(el));
                        };
                        document.body.appendChild(prismAutoloader);
                    };
                    document.body.appendChild(prismCore);
                } else {
                    // 스크립트가 로딩 중인 경우
                    const checkPrism = setInterval(() => {
                        if (typeof window.Prism !== 'undefined' && window.Prism.plugins && window.Prism.plugins.autoloader) {
                            clearInterval(checkPrism);
                            containerEl.querySelectorAll('pre code[class*="language-"]').forEach(el => Prism.highlightElement(el));
                        }
                    }, 100);
                }
            } else if (typeof window.Prism !== 'undefined' && window.Prism.highlightElement) {
                containerEl.querySelectorAll('pre code[class*="language-"]').forEach(el => Prism.highlightElement(el));
            }
        }

        // 헤딩 번호 삽입 (항상 실행)
        numberHeadings(containerEl);

        if (options.tocContainerId && options.tocNavId) {
            generateTOC(containerEl, options.tocContainerId, options.tocNavId);
        }

        if (options.collapsibleSections) {
            makeCollapsibleSections(containerEl);
        }

        // 헤딩 복사 버튼 추가 (makeCollapsibleSections 이후에 실행하여 토글 아이콘 위치 인식)
        // 편집 권한이 있을 때는 섹션 편집 버튼도 함께 표시
        // rawContent: 원본(raw) 마크다운 - 섹션 편집 URL 의 section 인덱스를 원본 기준으로 생성하기 위함
        // (transclusion 으로 주입된 헤딩은 원본에 없으므로 raw 매칭 실패 시 편집 버튼 생략)
        _addHeadingCopyButtons(containerEl, resolvedContent, {
            enableSectionEdit: !!options.enableSectionEdit,
            canEdit: !!options.canEdit,
            slug: options.enableSectionEdit ? (options.sectionEditSlug || slug) : null,
            rawContent: content
        });

        // {timer:} 요소 실시간 업데이트
        _initTimers(containerEl, containerId);

        // 익스텐션 렌더링 (Chart.js 등)
        _processExtensions(containerEl);

    } catch (err) {
        console.error('renderWikiContent error:', err);
    }
}

// ── 헤딩 복사 버튼 ──

/**
 * 마크다운 텍스트에서 h1~h4 헤딩을 찾아 섹션별 라인 범위를 반환.
 * 펜스 코드블록 내부의 '#' 라인은 헤딩으로 처리하지 않음.
 * 반환값: [{ level, lineIdx, endLine, headingText }, ...]
 *   - lineIdx: 헤딩 라인 (0-based)
 *   - endLine: 섹션 종료 라인(exclusive, 끝 빈 줄 제거 반영)
 *   - headingText: "## " 등 마크다운 접두사를 제거한 헤딩 텍스트
 */
function _extractMarkdownSectionRanges(markdownText) {
    const text = markdownText || '';
    const lines = text.split('\n');

    // transclusion 센티넬 마커 위치(문자 오프셋)를 수집하여 라인별 깊이를 계산.
    // 센티넬은 common.js 의 _resolveTransclusionsCore 가 템플릿 전개 결과 주위에
    // 삽입한다. 이를 통해 헤딩이 원본에서 온 것인지 transclusion 주입된 것인지를
    // 텍스트가 아닌 구조적 소스 표식으로 판별한다.
    const OPEN = '<!--WIKI_TCL_B-->';
    const CLOSE = '<!--WIKI_TCL_E-->';
    const markers = [];
    let pos = 0;
    while (true) {
        const oIdx = text.indexOf(OPEN, pos);
        const cIdx = text.indexOf(CLOSE, pos);
        if (oIdx < 0 && cIdx < 0) break;
        if (oIdx >= 0 && (cIdx < 0 || oIdx < cIdx)) {
            markers.push({ offset: oIdx, type: +1 });
            pos = oIdx + OPEN.length;
        } else {
            markers.push({ offset: cIdx, type: -1 });
            pos = cIdx + CLOSE.length;
        }
    }

    // 각 라인 시작의 문자 오프셋 사전 계산
    const lineOffsets = new Array(lines.length);
    {
        let off = 0;
        for (let i = 0; i < lines.length; i++) {
            lineOffsets[i] = off;
            off += lines[i].length + 1; // '\n'
        }
    }

    // 주어진 문자 오프셋에서 transclusion 깊이 반환
    function depthAt(charOffset) {
        let d = 0;
        for (const mk of markers) {
            if (mk.offset >= charOffset) break;
            d += mk.type;
        }
        return d > 0 ? d : 0;
    }

    const headings = []; // { level, lineIdx, headingText, transcluded }
    let inFencedCode = false;
    let fenceChar = '';
    let fenceLen = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (!inFencedCode) {
            const fenceMatch = line.match(/^(`{3,}|~{3,})/);
            if (fenceMatch) {
                inFencedCode = true;
                fenceChar = fenceMatch[1][0];
                fenceLen = fenceMatch[1].length;
                continue;
            }
            const hMatch = line.match(/^(#{1,4})\s+(.*)$/);
            if (hMatch) {
                headings.push({
                    level: hMatch[1].length,
                    lineIdx: i,
                    headingText: hMatch[2].trim(),
                    transcluded: depthAt(lineOffsets[i]) > 0
                });
            } else if (i > 0) {
                // setext 헤딩(=== / ---) 감지.
                // marked 는 setext 를 <h1>/<h2> 로 렌더링하므로 DOM headingEls 에는
                // 포함되지만, ATX 만 파싱하면 ranges 와 DOM 개수가 어긋나 section 인덱스가
                // 엉뚱한 섹션을 가리킬 수 있다.
                const underlineMatch = line.match(/^(=+|-+)\s*$/);
                if (underlineMatch) {
                    const prev = lines[i - 1];
                    const prevTrim = prev.trim();
                    // 이전 라인이 문단 텍스트여야 setext 로 인정.
                    // 빈 줄/ATX 헤딩/블록쿼트/리스트 항목 등은 제외.
                    const isParagraph = prevTrim !== ''
                        && !prevTrim.startsWith('#')
                        && !prevTrim.startsWith('>')
                        && !/^[-*_]{3,}\s*$/.test(prevTrim)
                        && !/^[-*+]\s+/.test(prevTrim)
                        && !/^\d+[.)]\s+/.test(prevTrim)
                        && !/^(`{3,}|~{3,})/.test(prevTrim);
                    if (isParagraph) {
                        const level = underlineMatch[1][0] === '=' ? 1 : 2;
                        headings.push({
                            level: level,
                            lineIdx: i - 1,
                            headingText: prevTrim,
                            transcluded: depthAt(lineOffsets[i - 1]) > 0
                        });
                    }
                }
            }
        } else {
            const trimmed = line.trim();
            if (trimmed[0] === fenceChar && trimmed.replace(new RegExp('^' + fenceChar + '+'), '').trim() === '' && trimmed.length >= fenceLen) {
                inFencedCode = false;
            }
        }
    }

    return headings.map((h, idx) => {
        let endLine = lines.length;
        for (let j = idx + 1; j < headings.length; j++) {
            if (headings[j].level <= h.level) {
                endLine = headings[j].lineIdx;
                break;
            }
        }
        // 섹션 끝의 빈 줄 제거
        while (endLine > h.lineIdx && lines[endLine - 1].trim() === '') endLine--;
        return {
            level: h.level,
            lineIdx: h.lineIdx,
            endLine,
            headingText: h.headingText,
            transcluded: h.transcluded
        };
    });
}

/**
 * 마크다운 텍스트에서 h1~h4 헤딩 목록과 각 헤딩의 섹션 마크다운을 추출.
 * 펜스 코드블록 내부의 '#' 라인은 헤딩으로 처리하지 않음.
 * 반환값: 헤딩 순서에 대응하는 섹션 마크다운 문자열 배열.
 */
function _extractMarkdownSections(markdownText) {
    const lines = markdownText.split('\n');
    const ranges = _extractMarkdownSectionRanges(markdownText);
    return ranges.map(r => lines.slice(r.lineIdx, r.endLine).join('\n'));
}

/** 컨테이너 내 h1~h4 요소에 섹션 마크다운 복사 버튼(+ 선택적으로 섹션 편집 버튼)을 추가 */
function _addHeadingCopyButtons(containerEl, resolvedContent, options = {}) {
    const ranges = _extractMarkdownSectionRanges(resolvedContent);
    const lines = resolvedContent.split('\n');
    const headingEls = Array.from(containerEl.querySelectorAll('h1, h2, h3, h4'));

    const enableSectionEdit = !!options.enableSectionEdit;
    const canEdit = !!options.canEdit;
    const editSlug = options.slug || '';
    // 섹션 편집 링크는 원본(raw) 마크다운의 섹션 인덱스를 써야 한다.
    // transclusion 으로 주입된 헤딩은 원본에 존재하지 않으므로 편집 버튼을 생략하며,
    // 이 판정은 headingText 매칭이 아니라 _extractMarkdownSectionRanges 가 센티넬
    // 마커로부터 계산한 range.transcluded (소스 구조 메타데이터) 로 수행한다.
    const rawContent = typeof options.rawContent === 'string' ? options.rawContent : null;
    const rawRanges = rawContent !== null ? _extractMarkdownSectionRanges(rawContent) : null;
    let rawCursor = 0; // non-transcluded DOM 헤딩에 대응하는 raw range 포인터

    // 섹션 콘텐츠에서 센티넬 주석 라인 제거(복사 텍스트를 깔끔하게 유지)
    const SENTINEL_RE = /<!--WIKI_TCL_[BE]-->/g;
    const stripSentinels = (s) => s.replace(SENTINEL_RE, '');

    headingEls.forEach((h, idx) => {
        const range = ranges[idx];
        if (!range) return;
        const sectionContent = stripSentinels(lines.slice(range.lineIdx, range.endLine).join('\n'));

        const copyBtn = document.createElement('button');
        copyBtn.className = 'wiki-heading-copy-btn';
        copyBtn.title = '섹션 마크다운 복사';
        copyBtn.type = 'button';
        copyBtn.innerHTML = '<i class="bi bi-copy"></i>';

        copyBtn.onclick = async (e) => {
            e.stopPropagation(); // 섹션 접기/펼치기 이벤트 전파 방지
            try {
                await navigator.clipboard.writeText(sectionContent);
                copyBtn.innerHTML = '<i class="bi bi-check-lg"></i>';
                setTimeout(() => { copyBtn.innerHTML = '<i class="bi bi-copy"></i>'; }, 2000);
            } catch (err) {
                const ta = document.createElement('textarea');
                ta.value = sectionContent;
                document.body.appendChild(ta);
                ta.select();
                try {
                    document.execCommand('copy');
                    copyBtn.innerHTML = '<i class="bi bi-check-lg"></i>';
                    setTimeout(() => { copyBtn.innerHTML = '<i class="bi bi-copy"></i>'; }, 2000);
                } catch (e2) { /* ignore */ }
                document.body.removeChild(ta);
            }
        };

        // 토글 아이콘이 있으면 그 앞에, 없으면 헤딩 끝에 삽입
        const toggleIcon = h.querySelector('.wiki-section-toggle-icon');
        if (toggleIcon) {
            h.insertBefore(copyBtn, toggleIcon);
        } else {
            h.appendChild(copyBtn);
        }

        // 편집 권한이 있을 때만 섹션 편집 버튼을 복사 버튼 옆에 추가
        if (enableSectionEdit && canEdit && editSlug && rawRanges) {
            // transclusion 주입 헤딩은 원본에 존재하지 않으므로 편집 버튼 미생성.
            // 판정은 텍스트 매칭이 아니라 센티넬 기반 소스 메타데이터(range.transcluded)로.
            if (range.transcluded) return;

            // 이 DOM 헤딩은 원본 마크다운의 rawCursor 번째 헤딩에 해당한다(순서 불변).
            const rawIdx = rawCursor;
            rawCursor++;
            const rawRange = rawRanges[rawIdx];
            if (!rawRange) return; // 예기치 않은 불일치 — 방어적 차단

            // 텍스트 일치 확인(방어적): 원본을 앞서 변경한 뒤 캐시된 이전 render 와
            // 엇갈리는 극한 경우를 잡기 위한 안전망. 불일치 시 편집 버튼 생략.
            const normalize = (s) => (s || '').trim();
            if (normalize(rawRange.headingText) !== normalize(range.headingText)) return;

            const editLink = document.createElement('a');
            editLink.className = 'wiki-heading-edit-btn';
            editLink.title = '이 섹션만 편집';
            editLink.setAttribute('aria-label', '섹션 편집');
            const params = new URLSearchParams({
                slug: editSlug,
                section: String(rawIdx),
                h: rawRange.headingText
            });
            editLink.href = '/edit?' + params.toString();
            editLink.innerHTML = '<i class="bi bi-pencil"></i>';
            editLink.addEventListener('click', (e) => {
                // 섹션 접기/펼치기 헤딩 클릭 이벤트와 충돌 방지
                e.stopPropagation();
            });

            // 복사 버튼 바로 다음 형제로 삽입 → [copy][edit][toggle-icon]
            if (copyBtn.nextSibling) {
                h.insertBefore(editLink, copyBtn.nextSibling);
            } else {
                h.appendChild(editLink);
            }
        }
    });
}

// ── 익스텐션 렌더링 시스템 ──

/** 익스텐션 모듈별 렌더러 맵 (각 익스텐션 파일이 로드 시 자동 등록) */
if (!window._extensionRenderers) window._extensionRenderers = {};

/** 컨테이너 내 모든 익스텐션 요소를 찾아 렌더러 실행 */
function _processExtensions(containerEl) {
    const extElements = containerEl.querySelectorAll('.wiki-ext[data-ext-name]');
    if (extElements.length === 0) return;

    extElements.forEach(el => {
        const extName = el.getAttribute('data-ext-name');
        const extIdx = parseInt(el.getAttribute('data-ext-idx'), 10);
        const extData = (typeof _wikiExtensionData !== 'undefined') ? _wikiExtensionData[extIdx] : null;

        if (!extData) {
            el.innerHTML = '<div class="alert alert-warning">⚠️ 익스텐션 데이터를 찾을 수 없습니다.</div>';
            return;
        }

        const renderer = window._extensionRenderers[extName];
        if (renderer) {
            renderer(el, extData);
        } else {
            el.innerHTML = `<div class="alert alert-warning">⚠️ 알 수 없는 익스텐션: ${escapeHtml(extName)}</div>`;
        }
    });
}

