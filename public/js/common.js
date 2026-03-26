/**
 * CloudWiki Common JavaScript Module
 * 모든 페이지에서 공통으로 사용되는 함수와 변수를 모아놓은 파일입니다.
 */

// ── 전역 변수 ──
var appConfig = { wikiName: 'CloudWiki' };
var currentUser = null;

// ── Marked 설정 (1회 초기화) ──
function initMarkedConfig() {
    if (typeof marked === 'undefined') return;
    marked.use({
        renderer: {
            html(token) {
                const htmlStr = typeof token === 'string' ? token : (token.text || token.raw || '');
                return escapeHtml(htmlStr);
            }
        }
    });
    marked.setOptions({
        gfm: true,
        breaks: true,
        headerIds: true,
    });
}
initMarkedConfig();

// ── URL 스킴 검증 (XSS 방지) ──
function isSafeUrl(url) {
    if (!url) return false;
    try {
        const parsed = new URL(url, window.location.origin);
        return ['http:', 'https:'].includes(parsed.protocol);
    } catch { return false; }
}

// ── HTML 이스케이프 ──
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ── 검색 ──
function doSearch(e) {
    e.preventDefault();
    const q = document.getElementById('searchInput').value.trim();
    if (q) {
        window.location.href = `/search?q=${encodeURIComponent(q)}&mode=content`;
    }
}

// ── 랜덤 문서 ──
async function goRandomPage() {
    try {
        const res = await fetch('/api/wiki/random');
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (data.slug) {
            const url = `/wiki/${encodeURIComponent(data.slug)}`;
            if (typeof navigateTo === 'function') {
                navigateTo(url);
                const sidebar = document.getElementById('mobileSidebar');
                if (sidebar) {
                    const bsOffcanvas = bootstrap?.Offcanvas?.getInstance(sidebar);
                    if (bsOffcanvas) bsOffcanvas.hide();
                }
            } else {
                window.location.href = url;
            }
        }
    } catch (e) {
        if (typeof Swal !== 'undefined') {
            Swal.fire('오류', '랜덤 문서를 불러올 수 없습니다.', 'error');
        }
    }
}

// ── 설정 로드 + 브랜딩 적용 ──
async function loadConfig() {
    try {
        const res = await fetch('/api/config');
        if (res.ok) {
            appConfig = await res.json();

            // 위키 이름 적용
            document.querySelectorAll('.app-wiki-name').forEach(el => {
                if (el.tagName === 'TITLE') {
                    // 타이틀에는 기존 접두사를 유지
                    const prefix = el.textContent.split(' - ').slice(0, -1).join(' - ');
                    el.textContent = prefix ? prefix + ' - ' + appConfig.wikiName : appConfig.wikiName;
                } else {
                    el.textContent = appConfig.wikiName;
                }
            });

            // 파비콘 적용
            if (isSafeUrl(appConfig.wikiFaviconUrl)) {
                const favicon = document.getElementById('wiki-favicon');
                if (favicon) favicon.href = appConfig.wikiFaviconUrl;
            }

            // 로고 적용
            document.querySelectorAll('.wiki-logo-container').forEach(logoContainer => {
                if (isSafeUrl(appConfig.wikiLogoUrl)) {
                    const img = document.createElement('img');
                    img.src = appConfig.wikiLogoUrl;
                    img.alt = 'Logo';
                    img.className = 'brand-logo';
                    img.style.cssText = 'height: 32px; vertical-align: middle; margin-right: 8px;';
                    img.loading = 'lazy';
                    logoContainer.innerHTML = '';
                    logoContainer.appendChild(img);
                }
            });
        }
    } catch (e) {
        console.error('설정 로드 실패', e);
    }
}

// ── 인증 확인 + 네비바 UI 업데이트 ──
async function checkAuth() {
    try {
        const res = await fetch('/api/me');
        if (res.ok) {
            currentUser = await res.json();
            document.querySelectorAll('#navLogin').forEach(el => el.classList.add('d-none'));
            document.querySelectorAll('#navUser').forEach(el => el.classList.remove('d-none'));
            document.querySelectorAll('#userAvatar').forEach(el => el.src = isSafeUrl(currentUser.picture) ? currentUser.picture : '');
            document.querySelectorAll('#userName').forEach(el => el.textContent = currentUser.name);

            if (currentUser.role === 'admin' || currentUser.role === 'super_admin') {
                document.querySelectorAll('#navAdminConsole, #navAdminDivider').forEach(el => el.classList.remove('d-none'));
            }

            // 알림 버튼 표시 및 카운트 로드
            document.querySelectorAll('#notificationBtnWrapper').forEach(el => el.classList.remove('d-none'));
            loadNotificationCount();
            // 60초마다 알림 폴링 (탭 비활성 시 자동 중단)
            startNotifPolling();
        }
    } catch (e) {
        // 로그인 안 됨
    }
}

// ── 알림 시스템 ──
var _notifPanelOpen = false;
var _notifOffset = 0;
const _notifLimit = 10;
var _notifIntervalId = null;

function startNotifPolling() {
    stopNotifPolling();
    _notifIntervalId = setInterval(loadNotificationCount, 60000);
}
function stopNotifPolling() {
    if (_notifIntervalId) { clearInterval(_notifIntervalId); _notifIntervalId = null; }
}
document.addEventListener('visibilitychange', () => {
    if (!currentUser) return;
    if (document.hidden) {
        stopNotifPolling();
    } else {
        loadNotificationCount();
        startNotifPolling();
    }
});

async function loadNotificationCount() {
    try {
        const res = await fetch('/api/notifications/count');
        if (!res.ok) return;
        const data = await res.json();
        const badge = document.getElementById('notificationBadge');
        if (badge) {
            if (data.count > 0) {
                badge.innerHTML = '';
                badge.classList.remove('d-none');
            } else {
                badge.classList.add('d-none');
            }
        }
    } catch (e) { }
}

function toggleNotificationPanel() {
    const panel = document.getElementById('notificationPanel');
    if (!panel) return;
    _notifPanelOpen = !_notifPanelOpen;
    if (_notifPanelOpen) {
        panel.classList.remove('d-none');
        loadNotifications(false);
        // 외부 클릭 시 닫기
        setTimeout(() => {
            document.addEventListener('click', _closeNotifOnOutsideClick);
        }, 0);
    } else {
        panel.classList.add('d-none');
        document.removeEventListener('click', _closeNotifOnOutsideClick);
    }
}

function _closeNotifOnOutsideClick(e) {
    const wrapper = document.getElementById('notificationBtnWrapper');
    if (wrapper && !wrapper.contains(e.target)) {
        _notifPanelOpen = false;
        document.getElementById('notificationPanel')?.classList.add('d-none');
        document.removeEventListener('click', _closeNotifOnOutsideClick);
    }
}

async function handleNotificationClick(event, id, type, refId, link) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }

    // 삭제 API 호출 (백그라운드 처리)
    fetch(`/api/notifications/${id}`, { method: 'DELETE' }).then(() => {
        // 알림 카운트 업데이트
        loadNotificationCount();
    }).catch(console.error);

    // 즉시 이동 또는 팝업 표시
    const isMessage = type === 'message';
    if (isMessage && refId) {
        viewMessage(refId);
    } else if (link && link !== 'null' && isSafeUrl(link)) {
        if (typeof navigateTo === 'function') {
            navigateTo(link);
            toggleNotificationPanel(); // 알림 패널 닫기 (SPA 이동 시)
        } else {
            window.location.href = link;
        }
    }
}

async function loadNotifications(append = false) {
    const body = document.getElementById('notificationPanelBody');
    if (!body) return;

    if (!append) {
        _notifOffset = 0;
        body.innerHTML = '<div class="text-center text-muted py-4"><div class="spinner-border spinner-border-sm"></div></div>';
    } else {
        const loadMoreBtn = document.getElementById('notifLoadMoreBtn');
        if (loadMoreBtn) {
            loadMoreBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 로딩 중...';
            loadMoreBtn.disabled = true;
        }
    }

    try {
        const res = await fetch(`/api/notifications?limit=${_notifLimit}&offset=${_notifOffset}`);
        if (!res.ok) throw new Error();
        const data = await res.json();
        const notifs = data.notifications || [];
        const has_more = data.has_more || false;

        if (notifs.length === 0 && !append) {
            body.innerHTML = '<div class="notification-empty"><i class="mdi mdi-inbox-outline fs-1 d-block mb-2"></i>알림이 없습니다.</div>';
            return;
        }

        const notifsHtml = notifs.map(n => {
            const iconMap = {
                'discussion_comment': 'mdi mdi-comment-text-outline',
                'banned': 'mdi mdi-block-helper',
                'message': 'mdi mdi-email-outline',
                'ticket_created': 'mdi mdi-ticket-outline',
                'ticket_comment': 'mdi mdi-ticket-confirmation-outline'
            };
            const icon = iconMap[n.type] || 'mdi mdi-bell';
            const timeAgo = _formatTimeAgo(n.created_at);

            return `<div class="notification-item" data-notif-id="${escapeHtml(String(n.id))}" data-notif-type="${escapeHtml(n.type)}" data-notif-ref="${escapeHtml(String(n.ref_id || ''))}" data-notif-link="${escapeHtml(n.link || '')}">
                <i class="notif-icon ${icon} type-${escapeHtml(n.type)}"></i>
                <div class="notif-content">
                    <div class="notif-text">${escapeHtml(n.content)}</div>
                    <div class="notif-time">${timeAgo}</div>
                </div>
                <button class="notif-delete" data-delete-id="${escapeHtml(String(n.id))}" title="삭제">
                    <i class="mdi mdi-close"></i>
                </button>
            </div>`;
        }).join('');

        if (append) {
            const loadMoreWrapper = document.getElementById('notifLoadMoreWrapper');
            if (loadMoreWrapper) loadMoreWrapper.remove();
            body.insertAdjacentHTML('beforeend', notifsHtml);
        } else {
            body.innerHTML = notifsHtml;
        }

        if (has_more) {
            _notifOffset += _notifLimit;
            body.insertAdjacentHTML('beforeend', `
                <div id="notifLoadMoreWrapper" class="text-center p-2 border-top">
                    <button id="notifLoadMoreBtn" class="btn btn-sm btn-link text-decoration-none w-100" data-load-more="true">
                        더보기 <i class="mdi mdi-chevron-down"></i>
                    </button>
                </div>
            `);
        }

        // 이벤트 델리게이션 (한 번만 등록)
        if (!body._notifDelegated) {
            body._notifDelegated = true;
            body.addEventListener('click', (e) => {
                // 삭제 버튼
                const deleteBtn = e.target.closest('[data-delete-id]');
                if (deleteBtn) {
                    e.stopPropagation();
                    deleteNotification(parseInt(deleteBtn.dataset.deleteId, 10));
                    return;
                }
                // 더보기 버튼
                const loadMoreBtn = e.target.closest('[data-load-more]');
                if (loadMoreBtn) {
                    loadNotifications(true);
                    return;
                }
                // 알림 아이템 클릭
                const item = e.target.closest('[data-notif-id]');
                if (item) {
                    const id = parseInt(item.dataset.notifId, 10);
                    const type = item.dataset.notifType;
                    const refId = item.dataset.notifRef ? parseInt(item.dataset.notifRef, 10) : null;
                    const link = item.dataset.notifLink || null;
                    handleNotificationClick(e, id, type, refId, link);
                }
            });
        }
    } catch (e) {
        if (!append) {
            body.innerHTML = '<div class="notification-empty text-danger">알림 로드 실패</div>';
        } else {
            const loadMoreBtn = document.getElementById('notifLoadMoreBtn');
            if (loadMoreBtn) {
                loadMoreBtn.innerHTML = '로드 실패. 다시 시도';
                loadMoreBtn.disabled = false;
            }
        }
    }
}

function _formatTimeAgo(unixTimestamp) {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - unixTimestamp;
    if (diff < 60) return '방금 전';
    if (diff < 3600) return Math.floor(diff / 60) + '분 전';
    if (diff < 86400) return Math.floor(diff / 3600) + '시간 전';
    if (diff < 604800) return Math.floor(diff / 86400) + '일 전';
    return new Date(unixTimestamp * 1000).toLocaleDateString('ko-KR');
}

// ── 사용자 역할 아이콘 렌더링 ──
function renderUserRoleIcon(role) {
    const roleMap = {
        super_admin: { icon: 'bi-shield-fill-check', color: '#f97316', label: '최고 관리자' },
        admin:       { icon: 'bi-shield-fill-check', color: '#3b82f6', label: '관리자' },
        discussion_manager: { icon: 'bi-shield-fill-check', color: '#22c55e', label: '토론 관리자' },
        banned:      { icon: 'bi-ban',               color: '#ef4444', label: '차단' },
        deleted:     { icon: 'bi-x-circle-fill',     color: '#9ca3af', label: '탈퇴' },
    };
    const cfg = roleMap[role];
    const icon  = cfg ? cfg.icon  : 'bi-person-fill';
    const color = cfg ? cfg.color : '#9ca3af';
    const label = cfg ? cfg.label : '일반 유저';
    return `<i class="bi ${escapeHtml(icon)} user-role-icon ms-1" tabindex="0" data-bs-toggle="popover" data-bs-content="${escapeHtml(label)}" data-bs-trigger="hover focus" data-bs-placement="top" style="color:${color};font-size:0.8em;cursor:pointer;" aria-label="${escapeHtml(label)}"></i>`;
}

// ── 역할 아이콘 팝오버 초기화 (동적 렌더링 후 호출) ──
function initRoleIconPopovers(container) {
    if (!container || typeof bootstrap === 'undefined') return;
    container.querySelectorAll('.user-role-icon[data-bs-toggle="popover"]').forEach(el => {
        if (!el._rolePopover) {
            el._rolePopover = new bootstrap.Popover(el, {
                trigger: 'hover focus',
                container: 'body',
                animation: false,
            });
        }
    });
}

async function deleteNotification(id) {
    const numId = parseInt(id, 10);
    if (isNaN(numId)) return;
    try {
        const res = await fetch(`/api/notifications/${numId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error();
        loadNotifications();
        loadNotificationCount();
    } catch (e) {
        if (typeof Swal !== 'undefined') {
            Swal.fire('오류', '알림 삭제에 실패했습니다.', 'error');
        }
    }
}

async function viewMessage(messageId) {
    try {
        const res = await fetch(`/api/messages/${messageId}`);
        if (!res.ok) throw new Error();
        const msg = await res.json();

        const date = new Date(msg.created_at * 1000).toLocaleString('ko-KR');
        const senderName = msg.sender_name || '알 수 없음';
        const senderPic = isSafeUrl(msg.sender_picture)
            ? `<img src="${escapeHtml(msg.sender_picture)}" class="rounded-circle me-2" width="28" height="28" loading="lazy">`
            : '<i class="mdi mdi-account-circle fs-4 me-2 text-muted"></i>';

        // DM 설정 확인 (답장 가능 여부)
        let canReply = false;
        if (currentUser) {
            const dmRes = await fetch('/api/settings/dm');
            const dmData = dmRes.ok ? await dmRes.json() : { allow_direct_message: 0 };
            const canBypassDm = ['admin', 'super_admin', 'discussion_manager'].includes(currentUser.role);

            if (dmData.allow_direct_message === 1 || canBypassDm) {
                canReply = true;
            } else if (msg.receiver_id === currentUser.id) {
                // DM 비활성화 상태에서 관리자/토론관리자가 보낸 쪽지에 답장 가능
                const senderRole = msg.sender_role || '';
                canReply = ['admin', 'super_admin', 'discussion_manager'].includes(senderRole);
            }
        }

        const showReplyBtn = canReply && currentUser && msg.sender_id !== currentUser.id;
        const replyBtnHtml = showReplyBtn
            ? `<button class="btn btn-sm btn-outline-primary mt-2" id="swal-reply-btn"><i class="mdi mdi-reply"></i> 답장</button>`
            : '';

        if (typeof Swal !== 'undefined') {
            Swal.fire({
                title: '<i class="mdi mdi-email-outline text-primary"></i> 쪽지',
                html: `
                    <div class="text-start">
                        <div class="d-flex align-items-center mb-3 pb-2 border-bottom">
                            ${senderPic}
                            <div>
                                <strong>${escapeHtml(senderName)}</strong>
                                <div class="text-muted small">${date}</div>
                            </div>
                        </div>
                        <div style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(msg.content)}</div>
                        ${replyBtnHtml}
                    </div>
                `,
                showConfirmButton: true,
                confirmButtonText: '닫기',
                width: 480,
                didOpen: () => {
                    const replyBtn = document.getElementById('swal-reply-btn');
                    if (replyBtn) {
                        replyBtn.addEventListener('click', () => {
                            replyToMessage(msg.id, msg.sender_id, senderName);
                        });
                    }
                }
            });
        }

        // 알림 패널 닫기
        _notifPanelOpen = false;
        document.getElementById('notificationPanel')?.classList.add('d-none');
        document.removeEventListener('click', _closeNotifOnOutsideClick);

    } catch (e) {
        if (typeof Swal !== 'undefined') {
            Swal.fire('오류', '쪽지를 불러올 수 없습니다.', 'error');
        }
    }
}

async function replyToMessage(originalMsgId, receiverId, receiverName) {
    if (typeof Swal === 'undefined') return;

    // 기존 Swal 닫기
    Swal.close();

    const { value: content, isConfirmed } = await Swal.fire({
        title: `<i class="mdi mdi-reply text-primary"></i> ${escapeHtml(receiverName)}님에게 답장`,
        input: 'textarea',
        inputPlaceholder: '답장 내용을 입력하세요...',
        inputAttributes: { maxlength: 2000 },
        showCancelButton: true,
        confirmButtonText: '보내기',
        cancelButtonText: '취소',
        width: 480,
        inputValidator: (val) => {
            if (!val || !val.trim()) return '내용을 입력해주세요.';
        }
    });

    if (isConfirmed && content) {
        try {
            const res = await fetch('/api/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ receiver_id: receiverId, content: content.trim(), reply_to: originalMsgId })
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || '발송 실패');
            }

            Swal.fire({ icon: 'success', title: '쪽지 발송 완료', showConfirmButton: false, timer: 1200 });
        } catch (e) {
            Swal.fire('오류', '쪽지 발송에 실패했습니다.', 'error');
        }
    }
}

async function sendMessage(receiverId, receiverName) {
    if (typeof Swal === 'undefined') return;

    const { value: content, isConfirmed } = await Swal.fire({
        title: `<i class="mdi mdi-email-plus-outline text-primary"></i> ${escapeHtml(receiverName)}님에게 쪽지`,
        input: 'textarea',
        inputPlaceholder: '쪽지 내용을 입력하세요...',
        inputAttributes: { maxlength: 2000 },
        showCancelButton: true,
        confirmButtonText: '보내기',
        cancelButtonText: '취소',
        width: 480,
        inputValidator: (val) => {
            if (!val || !val.trim()) return '내용을 입력해주세요.';
        }
    });

    if (isConfirmed && content) {
        try {
            const res = await fetch('/api/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ receiver_id: receiverId, content: content.trim() })
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || '발송 실패');
            }

            Swal.fire({ icon: 'success', title: '쪽지 발송 완료', showConfirmButton: false, timer: 1200 });
        } catch (e) {
            Swal.fire('오류', '쪽지 발송에 실패했습니다.', 'error');
        }
    }
}

// ── 틀(Transclusion) 처리 ──
async function resolveTransclusions(content, pageSlug) {
    const MAX_DEPTH = 3;
    const cache = new Map();

    async function resolve(text, depth) {
        if (depth > MAX_DEPTH) return text;

        const codeBlocks = [];
        let protectedText = text;
        const tokens = marked.lexer(protectedText);

        marked.walkTokens(tokens, token => {
            if (token.type === 'code' || token.type === 'codespan') {
                const raw = token.raw;
                if (protectedText.includes(raw)) {
                    const idx = codeBlocks.length;
                    codeBlocks.push(raw);
                    protectedText = protectedText.replace(raw, `\x00CODEBLOCK_${idx}\x00`);
                }
            }
        });

        const regex = /\{\{\s*([^\}]+?)\s*\}\}/g;
        const matches = [...protectedText.matchAll(regex)];

        if (matches.length === 0) return text;

        const slugsToFetch = new Set();
        matches.forEach(m => {
            const name = m[1].trim();
            let slug = name;
            if (!slug.startsWith('template:') && !slug.startsWith('틀:') && !slug.startsWith('템플릿:')) {
                slug = '틀:' + slug;
            }
            slugsToFetch.add(slug);
        });

        const fetchPromises = [];
        for (const slug of slugsToFetch) {
            if (!cache.has(slug)) {
                // 자기 자신을 참조하는 틀은 가져오지 않고 경고 표시
                if (pageSlug && slug === pageSlug) {
                    cache.set(slug, `⚠️ [자기 자신을 참조하는 틀은 사용할 수 없습니다: ${slug}]`);
                    continue;
                }
                fetchPromises.push(
                    fetch(`/api/wiki/${encodeURIComponent(slug)}`)
                        .then(res => res.ok ? res.json() : null)
                        .then(data => {
                            if (data) {
                                // 틀 내용에서 자기 자신을 참조하는 부분을 경고 메시지로 치환
                                const selfSlug = slug;
                                const tplContent = data.content.replace(/\{\{\s*([^\}]+?)\s*\}\}/g, (match, name) => {
                                    let refSlug = name.trim();
                                    if (!refSlug.startsWith('template:') && !refSlug.startsWith('틀:') && !refSlug.startsWith('템플릿:')) {
                                        refSlug = '틀:' + refSlug;
                                    }
                                    if (refSlug === selfSlug) {
                                        return `⚠️ [자기 자신을 참조하는 틀은 사용할 수 없습니다: ${selfSlug}]`;
                                    }
                                    return match;
                                });
                                cache.set(slug, tplContent);
                            } else {
                                cache.set(slug, `⚠️ [틀을 찾을 수 없음: ${slug}]`);
                            }
                        })
                        .catch(() => {
                            cache.set(slug, `⚠️ [틀 로딩 실패: ${slug}]`);
                        })
                );
            }
        }
        await Promise.all(fetchPromises);

        let newText = protectedText.replace(regex, (match, name) => {
            let slug = name.trim();
            if (!slug.startsWith('template:') && !slug.startsWith('틀:') && !slug.startsWith('템플릿:')) {
                slug = '틀:' + slug;
            }
            return cache.get(slug) || match;
        });

        newText = newText.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx, 10)]);

        if (newText !== text) {
            return await resolve(newText, depth + 1);
        }
        return newText;
    }

    return await resolve(content, 0);
}

// ── 카테고리 목록 렌더링 ──
async function fetchCategoryList(category) {
    try {
        const res = await fetch(`/api/wiki/category/${encodeURIComponent(category)}`);
        if (!res.ok) return '';

        const data = await res.json();
        if (data.pages.length === 0) {
            return '<div class="alert alert-light border text-center my-4">이 카테고리에 속한 문서가 없습니다.</div>';
        }

        const listHtml = data.pages.map(page => {
            const date = new Date(page.updated_at * 1000).toLocaleString('ko-KR');
            const lockIcon = page.is_locked ? ' <i class="bi bi-lock-fill text-danger" title="관리자 전용"></i>' : '';
            return `
        <a href="/wiki/${encodeURIComponent(page.slug)}" class="list-group-item list-group-item-action d-flex justify-content-between align-items-center wiki-spa-link">
            <div>
                <span class="fw-bold">${escapeHtml(page.title)}</span>
                ${lockIcon}
            </div>
            <small class="text-muted">${date}</small>
        </a>
      `;
        }).join('');

        return `
        <div class="category-list mt-4">
            <h4><i class="bi bi-folder2-open"></i> "${escapeHtml(category)}" 카테고리에 속한 문서</h4>
            <div class="list-group mt-3">${listHtml}</div>
        </div>
    `;
    } catch (e) {
        console.error(e);
        return '<div class="alert alert-danger">카테고리 목록을 불러오는 데 실패했습니다.</div>';
    }
}

// ── TOC 생성 ──
// 헤딩에 계층적 번호 프리픽스 삽입 (예: 1., 1.1., 1.1.1.)
function numberHeadings(contentEl) {
    if (!contentEl) return;
    const headings = contentEl.querySelectorAll('h1, h2, h3, h4');
    if (headings.length < 1) return;

    const minLevel = Math.min(...Array.from(headings).map(h => parseInt(h.tagName[1], 10)));
    const counters = [0, 0, 0, 0, 0, 0];

    headings.forEach((h, i) => {
        const level = parseInt(h.tagName[1], 10);
        h.id = h.id || `heading-${i}`;

        const relLevel = level - minLevel;
        counters[relLevel]++;
        for (let k = relLevel + 1; k < counters.length; k++) counters[k] = 0;

        const numParts = [];
        for (let k = 0; k <= relLevel; k++) numParts.push(counters[k] || 1);
        const numStr = numParts.join('.');

        const existingPrefix = h.querySelector('.wiki-heading-num');
        if (!existingPrefix) {
            const numSpan = document.createElement('span');
            numSpan.className = 'wiki-heading-num';
            numSpan.textContent = numStr + '. ';
            h.insertBefore(numSpan, h.firstChild);
        }
    });
}

function generateTOC(contentEl, tocContainerId, tocNavId) {
    if (!contentEl) return;
    const headings = contentEl.querySelectorAll('h1, h2, h3, h4');
    const tocContainer = document.getElementById(tocContainerId);
    if (!tocContainer) return;

    if (headings.length < 1) {
        tocContainer.classList.add('d-none');
        return;
    }

    const tocNav = document.getElementById(tocNavId);
    if (!tocNav) return;

    let html = '<ol>';
    let prevLevel = 0;

    headings.forEach((h, i) => {
        const level = parseInt(h.tagName[1], 10);
        const id = h.id || `heading-${i}`;
        // .wiki-heading-num을 제외한 순수 텍스트만 사용 (번호는 <ol>이 자동 생성)
        const numSpan = h.querySelector('.wiki-heading-num');
        let text = '';
        h.childNodes.forEach(n => {
            if (n !== numSpan) text += n.textContent;
        });

        if (level > prevLevel) {
            for (let j = prevLevel; j < level; j++) html += '<ol>';
        } else if (level < prevLevel) {
            for (let j = level; j < prevLevel; j++) html += '</ol>';
        }

        html += `<li><a href="#${id}">${escapeHtml(text.trim())}</a></li>`;
        prevLevel = level;
    });

    for (let j = 0; j < prevLevel; j++) html += '</ol>';

    tocNav.innerHTML = html;
    tocContainer.classList.remove('d-none');
}

// ── 본문 섹션 접기/펼치기 ──
function makeCollapsibleSections(containerEl) {
    const headings = containerEl.querySelectorAll('h1, h2, h3, h4');
    if (headings.length < 1) return;
    const minLevel = Math.min(...Array.from(headings).map(h => parseInt(h.tagName[1], 10)));
    _wrapLevelSections(containerEl, minLevel);
}

function _wrapLevelSections(containerEl, level) {
    if (level > 4) return;
    const tagName = 'H' + level;
    const children = Array.from(containerEl.childNodes);

    let i = 0;
    while (i < children.length) {
        const child = children[i];
        if (child.nodeName === tagName) {
            // 토글 아이콘 삽입
            const toggleIcon = document.createElement('span');
            toggleIcon.className = 'wiki-section-toggle-icon';
            toggleIcon.innerHTML = '<i class="bi bi-chevron-down"></i>';
            child.appendChild(toggleIcon);
            child.classList.add('wiki-section-heading');

            // 섹션 래퍼 생성
            const section = document.createElement('div');
            section.className = 'wiki-section wiki-section-level-' + level;
            child.parentNode.insertBefore(section, child);
            section.appendChild(child);

            // 섹션 본문 래퍼 생성
            const body = document.createElement('div');
            body.className = 'wiki-section-body';
            section.appendChild(body);

            // 이 헤딩 이하에 속하는 형제 노드들을 body로 이동
            let j = i + 1;
            while (j < children.length) {
                const sibling = children[j];
                const m = sibling.nodeName.match(/^H(\d)$/);
                if (m && parseInt(m[1], 10) <= level) break;
                body.appendChild(sibling);
                j++;
            }

            // 헤딩 클릭 시 섹션 토글
            child.addEventListener('click', function (e) {
                if (e.target.closest('a')) return;
                const collapsed = section.classList.toggle('wiki-section-collapsed');
                const icon = toggleIcon.querySelector('i');
                if (icon) {
                    icon.className = collapsed ? 'bi bi-chevron-right' : 'bi bi-chevron-down';
                }
            });

            i = j;
        } else {
            i++;
        }
    }

    // 하위 레벨 섹션 재귀 처리
    containerEl.querySelectorAll('.wiki-section-level-' + level + ' > .wiki-section-body').forEach(function (body) {
        _wrapLevelSections(body, level + 1);
    });
}

// ── 확장 문법(위키링크, 아이콘 등) 처리 ──
function processWikiLinks(contentEl) {
    if (!contentEl) return;
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];

    while (walker.nextNode()) {
        const parentTag = walker.currentNode.parentNode.tagName;
        if (parentTag === 'CODE' || parentTag === 'PRE') continue;

        const val = walker.currentNode.nodeValue;
        if (val.includes('[[') || val.includes('{bi:') || val.includes('{mdi:') || val.includes('{icon:')) {
            textNodes.push(walker.currentNode);
        }
    }

    textNodes.forEach(node => {
        const frag = document.createDocumentFragment();
        const parts = node.nodeValue.split(/(\[\[[^\]]+\]\]|(?<!\{)\{bi:[\w-]+\}(?!\})|(?<!\{)\{mdi:[\w-]+\}(?!\})|(?<!\{)\{icon:[\w-]+\}(?!\}))/g).filter(Boolean);

        parts.forEach(part => {
            if (part.startsWith('[[') && part.endsWith(']]')) {
                const linkText = part.slice(2, -2).trim();
                const a = document.createElement('a');
                a.href = `/wiki/${encodeURIComponent(linkText)}`;
                a.textContent = linkText;
                a.onclick = (e) => {
                    e.preventDefault();
                    if (typeof navigateTo === 'function') {
                        navigateTo(a.href);
                    } else {
                        window.location.href = a.href;
                    }
                };
                frag.appendChild(a);
            } else if (part.startsWith('{bi:') && part.endsWith('}')) {
                const iconName = part.slice(4, -1);
                const i = document.createElement('i');
                i.className = `bi bi-${iconName}`;
                frag.appendChild(i);
            } else if (part.startsWith('{mdi:') && part.endsWith('}')) {
                const iconName = part.slice(5, -1);
                const span = document.createElement('span');
                span.className = `mdi mdi-${iconName}`;
                frag.appendChild(span);
            } else if (part.startsWith('{icon:') && part.endsWith('}')) {
                const iconCode = part.slice(6, -1);
                if (iconCode.startsWith('bi-')) {
                    const el = document.createElement('i');
                    el.className = `bi ${iconCode}`;
                    frag.appendChild(el);
                } else if (iconCode.startsWith('mdi-')) {
                    const el = document.createElement('span');
                    el.className = `mdi ${iconCode}`;
                    frag.appendChild(el);
                } else {
                    const errSpan = document.createElement('span');
                    errSpan.className = 'text-danger';
                    errSpan.title = '알 수 없는 아이콘 접두사: bi- 또는 mdi-로 시작해야 합니다';
                    errSpan.textContent = part;
                    frag.appendChild(errSpan);
                }
            } else if (part) {
                frag.appendChild(document.createTextNode(part));
            }
        });

        node.parentNode.replaceChild(frag, node);
    });
}

// ── 각주 처리 ──
var _fnUniqueCounter = 0;
function processFootnotes(contentEl) {
    if (!contentEl) return;
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];

    while (walker.nextNode()) {
        const parentTag = walker.currentNode.parentNode.tagName;
        if (parentTag === 'CODE' || parentTag === 'PRE') continue;

        const val = walker.currentNode.nodeValue;
        if (/\[\*\s/.test(val)) {
            textNodes.push(walker.currentNode);
        }
    }

    if (textNodes.length === 0) return;

    let footnoteIndex = 0;
    const footnotes = [];

    textNodes.forEach(node => {
        const frag = document.createDocumentFragment();
        const parts = node.nodeValue.split(/(\[\*\s[^\]]+\])/g);

        parts.forEach(part => {
            const fnMatch = part.match(/^\[\*\s(.+)\]$/);
            if (fnMatch) {
                footnoteIndex++;
                const fnContent = fnMatch[1];
                const uniqueId = ++_fnUniqueCounter;
                const fnId = `fn-${footnoteIndex}-${uniqueId}`;
                const refId = `fn-ref-${footnoteIndex}-${uniqueId}`;

                footnotes.push({ id: fnId, refId: refId, num: footnoteIndex, content: fnContent });

                const sup = document.createElement('sup');
                sup.className = 'wiki-fn-ref';
                const a = document.createElement('a');
                a.href = `#${fnId}`;
                a.id = refId;
                a.textContent = `[${footnoteIndex}]`;

                if (typeof bootstrap !== 'undefined') {
                    a.setAttribute('data-bs-toggle', 'popover');
                    a.setAttribute('data-bs-trigger', 'hover focus');
                    a.setAttribute('data-bs-placement', 'top');
                    a.setAttribute('data-bs-content', escapeHtml(fnContent || ''));
                }

                a.onclick = (e) => {
                    e.preventDefault();
                    if (window.innerWidth >= 992) {
                        document.getElementById(fnId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                };
                sup.appendChild(a);
                frag.appendChild(sup);
            } else if (part) {
                frag.appendChild(document.createTextNode(part));
            }
        });

        node.parentNode.replaceChild(frag, node);
    });

    if (footnotes.length > 0) {
        const fnSection = document.createElement('div');
        fnSection.className = 'wiki-footnotes';
        fnSection.innerHTML = `<hr><h4><i class="bi bi-card-text"></i> 각주</h4>`;

        const ol = document.createElement('ol');
        footnotes.forEach(fn => {
            const li = document.createElement('li');
            li.id = fn.id;

            const backLink = document.createElement('a');
            backLink.href = `#${fn.refId}`;
            backLink.className = 'wiki-fn-back';
            backLink.innerHTML = '<i class="bi bi-arrow-return-left"></i>';
            backLink.title = '본문으로 돌아가기';
            backLink.onclick = (e) => {
                e.preventDefault();
                document.getElementById(fn.refId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            };

            const span = document.createElement('span');
            span.textContent = ' ' + fn.content;

            li.appendChild(backLink);
            li.appendChild(span);
            ol.appendChild(li);
        });

        fnSection.appendChild(ol);
        contentEl.appendChild(fnSection);
    }
}

// ── CSS 색상 값 검증 ──
function _isSafeCssColor(value) {
    if (!value || typeof value !== 'string') return false;
    // 위험 키워드 차단
    const lower = value.toLowerCase().replace(/\s/g, '');
    if (lower.includes('url(') || lower.includes('expression(') || lower.includes('var(') || lower.includes('env(')) return false;
    // CSS.supports가 있으면 브라우저 네이티브 검증
    if (typeof CSS !== 'undefined' && CSS.supports) {
        return CSS.supports('color', value);
    }
    // 폴백: 안전한 패턴만 허용
    return /^(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(rgb|hsl)a?\([0-9,.\s/%]+\))$/.test(value);
}

// ── 문서 렌더링 통합 (index.html, edit.html 공통) ──
async function renderWikiContent(content, slug, containerId, options = {}) {
    const containerEl = document.getElementById(containerId);
    if (!containerEl) return;

    try {
        const resolvedContent = await resolveTransclusions(content || '', slug);

        const codeBlocksForFold = [];
        let foldInput = resolvedContent.replace(/(`{3,})[\s\S]*?\1|`[^`\n]+`/g, (m) => {
            const idx = codeBlocksForFold.length;
            codeBlocksForFold.push(m);
            return `WIKICODEFPH${idx}XEND`;
        });

        const foldRegex = /^\[\+\s*(.*?)\s*\](?:(?:\r?\n)+)([\s\S]*?)(?:\r?\n)+\[-\]$/gm;
        const foldBlocks = [];
        let preprocessed = foldInput.replace(foldRegex, (match, titleLine, foldContent) => {
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
            let contentHtml = (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(rawContentHtml, { ADD_TAGS: ['i', 'span', 'details', 'summary'], ADD_ATTR: ['class', 'style', 'data-bg', 'data-color', 'colspan', 'rowspan'] }) : escapeHtml(rawContentHtml);

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

        let html = (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(rawHtml, { ADD_TAGS: ['i', 'span', 'details', 'summary'], ADD_ATTR: ['class', 'style', 'data-bg', 'data-color', 'colspan', 'rowspan'] }) : escapeHtml(rawHtml);

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
                const m = text.match(/^\{([<>^])\}$/);
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
            if (a.closest('blockquote') || a.closest('code, pre') || a.closest('.wiki-fn-ref')) return;

            // Checking if the link display text looks like a URL instead of custom text
            const textContent = a.textContent.trim();
            if (!textContent.includes('youtube.com') && !textContent.includes('youtu.be') && !textContent.includes('nicovideo.jp')) return;

            const ytMatch = href.match(/^https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)(.*)$|^https?:\/\/youtu\.be\/([a-zA-Z0-9_-]+)(.*)$/);
            if (ytMatch) {
                const videoId = ytMatch[1] || ytMatch[3];
                let params = ytMatch[2] || ytMatch[4] || '';
                // convert ?t= or &t= to start=
                const timeMatch = params.match(/[?&]t=(\d+)s?/);
                let query = '';
                if (timeMatch) {
                    query = `?start=${parseInt(timeMatch[1], 10)}`;
                }
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
            t.classList.add('table', 'table-bordered', 'table-hover');
            const wrapper = document.createElement('div');
            wrapper.className = 'table-responsive';
            t.parentNode.insertBefore(wrapper, t);
            wrapper.appendChild(t);
        });

        containerEl.querySelectorAll('img').forEach(img => {
            img.classList.add('img-fluid');
            if (!img.hasAttribute('loading')) {
                img.setAttribute('loading', 'lazy');
            }
        });

        // 코드블럭 복사 버튼 추가
        containerEl.querySelectorAll('pre').forEach(pre => {
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

// ── PC 사이드바: 본문 스크롤 연동 및 푸터 겹침 방지 ──
(function () {
    function setupSidebarLayout() {
        const sidebar = document.getElementById('wikiSidebar');
        const footer = document.querySelector('.wiki-footer');
        if (!sidebar || !footer) return;

        const BASE_TOP = 80; // sticky top (5rem ≈ 80px)
        const FOOTER_GAP = 16;

        function update() {
            const layout = sidebar.closest('.wiki-layout');
            if (!layout) return;
            const container = layout.querySelector('.wiki-container');
            if (!container) return;

            if (window.innerWidth < 992) {
                container.style.paddingBottom = '';
                return;
            }

            // 자연 높이 측정을 위해 초기화
            container.style.paddingBottom = '';

            const sidebarH = sidebar.scrollHeight;
            const containerH = container.scrollHeight;

            // 사이드바가 본문보다 긴 경우: 본문 아래에 여백을 추가하여
            // flex 컨테이너가 사이드바 전체를 포함할 수 있도록 함
            if (sidebarH > containerH) {
                const extraPadding = sidebarH - containerH + FOOTER_GAP;
                container.style.paddingBottom = extraPadding + 'px';
            }
        }

        window.addEventListener('resize', update, { passive: true });
        update();
        // SPA 네비게이션 후 외부에서 호출 가능하도록 노출
        window.__sidebarLayoutUpdate = update;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupSidebarLayout);
    } else {
        setupSidebarLayout();
    }
})();

// ── 모바일 사이드바 열림/닫힘 시 헤더 숨기기/표시 ──
(function () {
    function setupSidebarHeaderToggle() {
        const sidebar = document.getElementById('mobileSidebar');
        if (!sidebar) return;
        const navbar = document.querySelector('.navbar');
        if (!navbar) return;

        sidebar.addEventListener('show.bs.offcanvas', function () {
            navbar.classList.add('header-hidden-mobile');
        });
        sidebar.addEventListener('hide.bs.offcanvas', function () {
            navbar.classList.remove('header-hidden-mobile');
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupSidebarHeaderToggle);
    } else {
        setupSidebarHeaderToggle();
    }
})();
