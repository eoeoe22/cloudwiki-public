// ── Diff HTML 생성 공통 함수 ──
function buildDiffHtml(diffData, contextLines) {
    let html = '';
    diffData.forEach((part, i) => {
        if (part.added || part.removed) {
            const cls = part.added ? 'diff-added' : 'diff-removed';
            html += `<span class="${cls}">${escapeHtml(part.value)}</span>`;
        } else {
            let lines = part.value.split('\n');
            let hasTrailingNewline = false;
            if (lines[lines.length - 1] === '') {
                lines.pop();
                hasTrailingNewline = true;
            }

            let showTop = (i !== 0);
            let showBottom = (i !== diffData.length - 1);

            if (!showTop && !showBottom) {
                html += `<span>${escapeHtml(part.value)}</span>`;
            } else if (lines.length <= contextLines * 2 + 1) {
                html += `<span>${escapeHtml(part.value)}</span>`;
            } else {
                if (showTop) {
                    html += `<span>${escapeHtml(lines.slice(0, contextLines).join('\n') + '\n')}</span>`;
                }
                html += `<span style="color: grey; font-style: italic; background: #e9ecef; border-radius: 4px; padding: 0 4px;">... (생략됨) ...</span>\n`;
                if (showBottom) {
                    html += `<span>${escapeHtml(lines.slice(-contextLines).join('\n') + (hasTrailingNewline ? '\n' : ''))}</span>`;
                }
            }
        }
    });
    return html;
}

// ── 에디터의 자동 줄바꿈 설정을 diff 미리보기 컨테이너에 반영 ──
function applyDiffPreviewWrapMode(container) {
    if (!container) return;
    const wrap = localStorage.getItem('editor_word_wrap') !== 'false';
    container.classList.toggle('wrap-mode', wrap);
}

// ── 변경 사항 (내 수정본) 렌더링 ──
function renderLocalDiff() {
    const container = document.getElementById('diffPreviewContainer');
    if (!container) return;

    applyDiffPreviewWrapMode(container);

    const currentContent = editor ? editor.getMarkdown() : '';
    if (originalContent === currentContent) {
        container.innerHTML = '<span class="text-muted">변경 사항이 없습니다.</span>';
        return;
    }

    const diffData = Diff.diffLines(originalContent, currentContent);
    container.innerHTML = buildDiffHtml(diffData, 3);
}

// ── 충돌 해결 UI ──
function showConflictModal(data) {
    pageVersion = data.current_version;
    const serverContent = data.content || '';
    const localContent = editor.getMarkdown();

    // ── 최신본: raw div에 텍스트 세팅 ──
    document.getElementById('conflict-server-raw').textContent = serverContent;
    // 뷰 상태 초기화 (raw로 리셋)
    document.getElementById('conflict-server-raw').style.display = 'block';
    document.getElementById('conflict-server-preview').style.display = 'none';
    document.getElementById('serverViewToggle').innerHTML = '<i class="mdi mdi-eye"></i> 프리뷰 보기';
    serverViewMode = 'raw';
    // viewer가 이미 있으면 내용만 갱신
    if (serverViewer) {
        serverViewer.setMarkdown(serverContent);
    }

    // ── 내 수정본: conflict-ui가 block된 후 에디터 초기화 ──
    document.getElementById('conflict-ui').style.display = 'block';
    document.getElementById('main-editor-container').style.display = 'none';
    window.scrollTo(0, 0);

    if (isExtensionData) {
        // 익스텐션 데이터: textarea 사용
        const conflictEl = document.querySelector('#conflict-local-editor');
        if (!conflictEditor) {
            conflictEl.innerHTML = '<textarea id="conflictRawTextarea" class="wiki-ext-raw-textarea" spellcheck="false" style="min-height:400px;"></textarea>';
            const conflictTextarea = document.getElementById('conflictRawTextarea');
            conflictTextarea.value = localContent;
            conflictEditor = {
                getMarkdown: () => conflictTextarea.value,
                setMarkdown: (md) => { conflictTextarea.value = md; },
            };
        } else {
            conflictEditor.setMarkdown(localContent);
        }
    } else {
        // CM6 환경: 충돌 해결용 에디터도 textarea + shim 사용
        const conflictEl = document.querySelector('#conflict-local-editor');
        if (!conflictEditor) {
            conflictEl.innerHTML = '<textarea id="conflictTextarea" class="wiki-ext-raw-textarea" spellcheck="false" style="min-height:400px; width:100%; height:500px; font-family:monospace; font-size:0.9rem; resize:none; border:1px solid var(--wiki-border); border-radius:4px; padding:8px; background:var(--wiki-bg); color:var(--wiki-text);"></textarea>';
            const conflictTextarea = document.getElementById('conflictTextarea');
            conflictTextarea.value = localContent;
            conflictEditor = {
                getMarkdown: () => conflictTextarea.value,
                setMarkdown: (md) => { conflictTextarea.value = md; },
            };
        } else {
            conflictEditor.setMarkdown(localContent);
        }
    }

    // ── Diff 렌더링 (요약/전체 보기를 위해 데이터 보관 후 렌더링 호출) ──
    cachedDiffData = Diff.diffLines(serverContent, localContent);

    // 토글 버튼 상태 초기화
    diffViewMode = 'summary';
    document.getElementById('diffViewToggle').innerHTML = '<i class="mdi mdi-filter-variant"></i> 전체 보기';

    renderDiffView();
}

function toggleDiffView() {
    diffViewMode = (diffViewMode === 'summary') ? 'all' : 'summary';
    const btn = document.getElementById('diffViewToggle');
    if (diffViewMode === 'all') {
        btn.innerHTML = '<i class="mdi mdi-filter"></i> 요약 보기';
    } else {
        btn.innerHTML = '<i class="mdi mdi-filter-variant"></i> 전체 보기';
    }
    renderDiffView();
}

function renderDiffView() {
    if (!cachedDiffData) return;
    let diffHtml;

    if (diffViewMode === 'all') {
        diffHtml = '';
        cachedDiffData.forEach(part => {
            const cls = part.added ? 'diff-added' : part.removed ? 'diff-removed' : '';
            diffHtml += `<span class="${cls}">${escapeHtml(part.value)}</span>`;
        });
    } else {
        diffHtml = buildDiffHtml(cachedDiffData, 2);
    }
    document.getElementById('conflict-diff-view').innerHTML = diffHtml;
}

function toggleServerView() {
    const raw = document.getElementById('conflict-server-raw');
    const preview = document.getElementById('conflict-server-preview');
    const btn = document.getElementById('serverViewToggle');

    if (serverViewMode === 'raw') {
        // renderWikiContent를 사용하여 프리뷰 렌더링
        preview.innerHTML = '';
        preview.style.display = 'block';
        const previewContent = document.createElement('div');
        previewContent.className = 'wiki-content';
        previewContent.style.padding = '12px';
        previewContent.style.maxHeight = '500px';
        previewContent.style.overflowY = 'auto';
        preview.appendChild(previewContent);
        previewContent.id = 'conflict-server-preview-content';
        renderWikiContent(raw.textContent, slug, 'conflict-server-preview-content');
        serverViewer = {
            setMarkdown: (md) => renderWikiContent(md, slug, 'conflict-server-preview-content')
        };
        raw.style.display = 'none';
        btn.innerHTML = '<i class="mdi mdi-code-tags"></i> Raw 보기';
        serverViewMode = 'preview';
    } else {
        raw.style.display = 'block';
        preview.style.display = 'none';
        btn.innerHTML = '<i class="mdi mdi-eye"></i> 프리뷰 보기';
        serverViewMode = 'raw';
    }
}

function resolveConflict() {
    // textarea 대신 conflictEditor에서 값 읽기
    const finalContent = conflictEditor ? conflictEditor.getMarkdown() : '';

    // 메인 에디터 업데이트
    editor.setMarkdown(finalContent);
    scrollToBottom();

    // 충돌 해결 UI 숨기기
    document.getElementById('conflict-ui').style.display = 'none';
    document.getElementById('main-editor-container').style.display = 'block';

    // 저장 다시 시도
    savePage();
}

function cancelConflict() {
    Swal.fire({
        title: '충돌 해결 취소',
        text: '편집 내용을 버리고 최신 버전으로 새로고침 하시겠습니까?',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: '새로고침 (내용 버림)',
        cancelButtonText: '계속 해결하기'
    }).then((result) => {
        if (result.isConfirmed) {
            window.location.reload();
        }
    });
}


// ── 동시편집 감지 ──
const heartbeat = {
    interval: null,
    editorCheckInterval: null,
};

function startEditingHeartbeat() {
    if (!slug) return;
    if (appConfig.enableConcurrentEditDetection === false) return;

    // 즉시 첫 하트비트 전송
    sendHeartbeat();

    // 50초마다 하트비트 전송
    heartbeat.interval = setInterval(sendHeartbeat, 50000);

    // 50초마다 편집자 목록 확인
    heartbeat.editorCheckInterval = setInterval(checkConcurrentEditors, 50000);

    // 페이지 이탈 시 인터벌 정리
    window.addEventListener('beforeunload', stopEditingHeartbeat);
}

function stopEditingHeartbeat() {
    if (heartbeat.interval) {
        clearInterval(heartbeat.interval);
        heartbeat.interval = null;
    }
    if (heartbeat.editorCheckInterval) {
        clearInterval(heartbeat.editorCheckInterval);
        heartbeat.editorCheckInterval = null;
    }
}

async function sendHeartbeat() {
    if (!slug) return;
    try {
        await fetch(`/api/w/${encodeURIComponent(slug)}/editing`, {
            method: 'POST',
        });
    } catch (e) {
        // 하트비트 실패는 무시
    }
}

async function checkConcurrentEditors() {
    if (!slug) return;
    try {
        const res = await fetch(`/api/w/${encodeURIComponent(slug)}/editors`);
        if (!res.ok) return;
        const data = await res.json();

        const banner = document.getElementById('concurrent-edit-banner');
        const textEl = document.getElementById('concurrent-edit-text');
        if (!banner || !textEl) return;

        if (data.editors && data.editors.length > 0) {
            const editorNames = data.editors.map(e => {
                const avatar = e.picture
                    ? `<img src="${escapeHtml(e.picture)}" class="editor-avatar" alt="" loading="lazy">`
                    : '';
                return `${avatar}<strong>${escapeHtml(e.name)}</strong>`;
            }).join(', ');

            textEl.innerHTML = `이 문서를 ${editorNames}님이 동시에 편집 중입니다. 편집 충돌이 발생할 수 있습니다.`;
            banner.style.display = 'flex';
        } else {
            banner.style.display = 'none';
        }
    } catch (e) {
        // 조회 실패는 무시
    }
}
