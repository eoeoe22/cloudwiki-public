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
            let rawContentHtml = (typeof marked !== 'undefined') ? marked.parse(restoredContent) : restoredContent;
            let contentHtml = (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(rawContentHtml, { ADD_TAGS: ['i', 'span', 'details', 'summary'], ADD_ATTR: ['class', 'style', 'data-bg', 'data-color', 'data-size', 'colspan', 'rowspan'] }) : escapeHtml(rawContentHtml);

            foldBlocks.push({ summaryText, bgAttr, colorAttr, contentHtml });
            return `\n\nWIKIFOLDPH${idx}XEND\n\n`;
        });

        preprocessed = preprocessed.replace(/WIKICODEFPH(\d+)XEND/g, (_, idx) => codeBlocksForFold[parseInt(idx, 10)]);

        let rawHtml = (typeof marked !== 'undefined') ? marked.parse(preprocessed) : preprocessed;

        rawHtml = rawHtml.replace(/(?:<p>)?WIKIFOLDPH(\d+)XEND(?:<\/p>)?/g, (m, idx) => {
            const block = foldBlocks[parseInt(idx, 10)];
            if (!block) return '';
            return `<details class="wiki-fold border rounded mb-3"${block.bgAttr}${block.colorAttr}>` +
                `<summary class="fw-bold p-2 wiki-fold-summary">${block.summaryText}</summary>` +
                `<div class="wiki-fold-content p-3 border-top">${block.contentHtml}</div>` +
                `</details>`;
        });

        let html = (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(rawHtml, { ADD_TAGS: ['i', 'span', 'details', 'summary'], ADD_ATTR: ['class', 'style', 'data-bg', 'data-color', 'data-size', 'colspan', 'rowspan'] }) : escapeHtml(rawHtml);

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
            if (!textContent.includes('youtube.com') && !textContent.includes('youtu.be') && !textContent.includes('nicovideo.jp') && !textContent.includes('spotify.com')) return;

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

    } catch (err) {
        console.error('renderWikiContent error:', err);
    }
}
