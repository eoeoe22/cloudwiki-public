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
        extensions: [
            {
                name: 'highlight',
                level: 'inline',
                start(src) { return src.indexOf('=='); },
                tokenizer(src) {
                    const match = src.match(/^==([^=]+)==/);
                    if (match) {
                        const token = {
                            type: 'highlight',
                            raw: match[0],
                            text: match[1],
                            tokens: []
                        };
                        this.lexer.inline(token.text, token.tokens);
                        return token;
                    }
                },
                childTokens: ['tokens'],
                renderer(token) {
                    return '<mark>' + this.parser.parseInline(token.tokens) + '</mark>';
                }
            },
            {
                name: 'underline',
                level: 'inline',
                start(src) { return src.indexOf('__'); },
                tokenizer(src) {
                    const match = src.match(/^__([^_]+(?:_[^_]+)*)__/);
                    if (match) {
                        const token = {
                            type: 'underline',
                            raw: match[0],
                            text: match[1],
                            tokens: []
                        };
                        this.lexer.inline(token.text, token.tokens);
                        return token;
                    }
                },
                childTokens: ['tokens'],
                renderer(token) {
                    return '<u>' + this.parser.parseInline(token.tokens) + '</u>';
                }
            },
            {
                name: 'customImage',
                level: 'inline',
                start(src) { return src.indexOf('!['); },
                tokenizer(src) {
                    const match = src.match(/^!\[([^\]]*)\]\(([^)]+)\)(?:\{size:\s*(icon|small|medium|full)\})/);
                    if (match) {
                        return {
                            type: 'customImage',
                            raw: match[0],
                            text: match[1],
                            href: match[2],
                            size: match[3]
                        };
                    }
                },
                renderer(token) {
                    let style = '';
                    if (token.size === 'icon') {
                        style = 'height: 1.2em; width: auto; display: inline-block; vertical-align: middle; margin: 0 2px;';
                    } else if (token.size === 'small') {
                        style = 'max-width: 25%; height: auto;';
                    } else if (token.size === 'medium') {
                        style = 'max-width: 50%; height: auto;';
                    } else if (token.size === 'full') {
                        style = 'max-width: 100%; height: auto;';
                    }
                    return `<img src="${escapeHtml(token.href)}" alt="${escapeHtml(token.text)}" style="${style}" data-size="${token.size}">`;
                }
            },
            {
                name: 'spoiler',
                level: 'inline',
                start(src) { return src.indexOf('||'); },
                tokenizer(src) {
                    const match = src.match(/^\|\|([^|]+(?:\|[^|]+)*?)\|\|/);
                    if (match) {
                        const token = {
                            type: 'spoiler',
                            raw: match[0],
                            text: match[1],
                            tokens: []
                        };
                        this.lexer.inline(token.text, token.tokens);
                        return token;
                    }
                },
                childTokens: ['tokens'],
                renderer(token) {
                    return '<span class="spoiler">' + this.parser.parseInline(token.tokens) + '</span>';
                }
            }
        ],
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
        const res = await fetch('/api/w/random');
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (data.slug) {
            const url = `/w/${encodeURIComponent(data.slug)}`;
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
    // 레이아웃 컴포넌트(헤더/사이드바)가 비어있으면 클라이언트에서 로드 시도 (SSR 누락 대비)
    await ensureLayoutComponents();

    // 전역 인증 상태 동기화 (레이아웃 주입 여부와 상관없이 항상 수행)
    await checkAuth();
}

/**
 * SSR이 누락된 경우를 대비한 클라이언트 사이드 레이아웃 주입
 */
async function ensureLayoutComponents() {
    const header = document.getElementById('app-header-placeholder');
    const sidebar = document.getElementById('app-sidebar-placeholder');
    const footer = document.getElementById('app-footer-placeholder');

    const headerEmpty = header && header.innerHTML.trim() === '';
    const sidebarEmpty = sidebar && sidebar.innerHTML.trim() === '';
    const footerEmpty = footer && footer.innerHTML.trim() === '';

    if (headerEmpty || sidebarEmpty || footerEmpty) {
        try {
            const [h, s, f] = await Promise.all([
                headerEmpty ? fetch('/components/header.html').then(r => r.ok ? r.text() : null) : Promise.resolve(null),
                sidebarEmpty ? fetch('/components/sidebar.html').then(r => r.ok ? r.text() : null) : Promise.resolve(null),
                footerEmpty ? fetch('/components/footer.html').then(r => r.ok ? r.text() : null) : Promise.resolve(null)
            ]);

            if (h && header) header.innerHTML = h;
            if (s && sidebar) sidebar.innerHTML = s;
            if (f && footer) footer.innerHTML = f;

            // 컴포넌트 로드 후 브랜딩 및 인증 재적용
            if (h || s || f) {
                // 무한 루프 방지를 위해 ensureLayoutComponents 제외하고 재호출
                document.querySelectorAll('.app-wiki-name').forEach(el => {
                    if (el.tagName !== 'TITLE') el.textContent = appConfig.wikiName;
                });
                await checkAuth();
                if (window.__sidebarLayoutUpdate) window.__sidebarLayoutUpdate();
            }
        } catch (e) {
            console.error('Layout component load failed:', e);
        }
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
                    fetch(`/api/w/${encodeURIComponent(slug)}`)
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
        const res = await fetch(`/api/w/category/${encodeURIComponent(category)}`);
        if (!res.ok) return '';

        const data = await res.json();
        if (data.pages.length === 0) {
            return '<div class="alert alert-light border text-center my-4">이 카테고리에 속한 문서가 없습니다.</div>';
        }

        // 트리 구조 빌드
        const tree = {};
        for (const page of data.pages) {
            const parts = page.slug.split('/');
            let node = tree;
            for (const part of parts) {
                if (!node[part]) node[part] = { _children: {}, _doc: null };
                node = node[part]._children;
            }
            let target = tree;
            for (let i = 0; i < parts.length; i++) {
                if (i === parts.length - 1) {
                    target[parts[i]]._doc = page;
                } else {
                    target = target[parts[i]]._children;
                }
            }
        }

        function renderTree(nodes, parentPrefix) {
            const entries = Object.keys(nodes).sort();
            let html = '';
            entries.forEach((key, idx) => {
                const node = nodes[key];
                const isLast = idx === entries.length - 1;
                const hasChildren = Object.keys(node._children).length > 0;
                const connector = isLast ? '└── ' : '├── ';
                const childPrefix = parentPrefix + (isLast ? '    ' : '│   ');

                if (node._doc) {
                    html += `<div class="wiki-tree-line">${parentPrefix}${connector}<a href="/w/${encodeURIComponent(node._doc.slug)}" class="text-decoration-none wiki-spa-link">${escapeHtml(key)}</a></div>`;
                } else {
                    html += `<div class="wiki-tree-line">${parentPrefix}${connector}${escapeHtml(key)}</div>`;
                }

                if (hasChildren) {
                    html += renderTree(node._children, childPrefix);
                }
            });
            return html;
        }

        const treeHtml = renderTree(tree, '');

        return `
        <div class="category-list mt-4">
            <h4><i class="bi bi-folder2-open"></i> "${escapeHtml(category)}" 카테고리에 속한 문서</h4>
            <div class="mt-3">${treeHtml}</div>
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
    const headings = containerEl.querySelectorAll('h1, h2, h3, h4, h5, h6');
    if (headings.length < 1) return;
    const minLevel = Math.min(...Array.from(headings).map(h => parseInt(h.tagName[1], 10)));
    _wrapLevelSections(containerEl, minLevel);
}

function _wrapLevelSections(containerEl, level) {
    if (level > 6) return;
    const tagName = 'H' + level;
    const children = Array.from(containerEl.childNodes);
    const inners = [];

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

            // 애니메이션을 위한 내부 래퍼
            const bodyInner = document.createElement('div');
            bodyInner.className = 'wiki-section-body-inner';
            body.appendChild(bodyInner);
            inners.push(bodyInner);

            // 이 헤딩 이하에 속하는 형제 노드들을 inner로 이동
            let j = i + 1;
            while (j < children.length) {
                const sibling = children[j];
                // 일반 H태그 체크
                const m = sibling.nodeName.match(/^H(\d)$/);
                if (m && parseInt(m[1], 10) <= level) break;
                // 이미 래핑된 상위 레벨의 섹션인지 체크
                let isHigherOrEqualSection = false;
                if (sibling.nodeType === 1 && sibling.classList.contains('wiki-section')) {
                    for (let l = 1; l <= level; l++) {
                        if (sibling.classList.contains('wiki-section-level-' + l)) {
                            isHigherOrEqualSection = true;
                            break;
                        }
                    }
                }
                if (isHigherOrEqualSection) break;
                bodyInner.appendChild(sibling);
                j++;
            }

            // 헤딩 클릭 시 섹션 토글 (아이콘은 CSS로 제어)
            child.addEventListener('click', function (e) {
                if (e.target.closest('a')) return;
                section.classList.toggle('wiki-section-collapsed');
            });

            i = j;
        } else {
            i++;
        }
    }

    // 하위 레벨 섹션 재귀 처리
    // 현재 레벨에서 생성된 내부 래퍼들을 대상으로 하위 레벨 적용
    inners.forEach(function (inner) {
        _wrapLevelSections(inner, level + 1);
    });

    // 만약 상위 레벨 헤딩 없이 하위 레벨 헤딩만 존재하는 경우를 위해
    // 현재 containerEl에 대해서도 하위 레벨 처리를 수행
    _wrapLevelSections(containerEl, level + 1);
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
                a.href = `/w/${encodeURIComponent(linkText)}`;
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

// ── PC 사이드바: 본문 스크롤 연동 및 푸터 겹침 방지 ──
(function () {
    function setupSidebarLayout() {
        const sidebar = document.getElementById('wikiSidebar');
        const footer = document.querySelector('.wiki-footer');
        if (!sidebar || !footer) return;

        const FOOTER_GAP = 16;

        function getNavbarHeight() {
            const navbar = document.querySelector('.navbar');
            return navbar ? navbar.offsetHeight : 0;
        }

        function updateSidebarTop() {
            if (window.innerWidth < 992) {
                sidebar.style.top = '';
                return;
            }
            const navH = getNavbarHeight();
            const top = Math.max(0, navH - window.scrollY);
            sidebar.style.top = top + 'px';
        }

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

            updateSidebarTop();
        }

        window.addEventListener('scroll', updateSidebarTop, { passive: true });
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

// ── 스포일러 클릭 이벤트 위임 ──
document.addEventListener('click', function (e) {
    const spoiler = e.target.closest('.spoiler');
    if (spoiler) spoiler.classList.toggle('revealed');
});

// ── 상대 시간 변환 ──
function getRelativeTime(unixTs) {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - unixTs;
    if (diff < 60) return '방금 전';
    if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}일 전`;
    return new Date(unixTs * 1000).toLocaleDateString('ko-KR');
}

// ── 최근 변경 로드 (recent-changes-container 클래스를 가진 모든 요소에 채움) ──
async function loadRecentChanges() {
    try {
        const res = await fetch('/api/w/recent-changes');
        if (!res.ok) return;
        const data = await res.json();

        const html = data.changes.map(item => {
            const timeAgo = getRelativeTime(item.updated_at);
            return `
              <a href="/w/${encodeURIComponent(item.slug)}" class="recent-change-item"
                 onclick="if(typeof navigateTo==='function'){navigateTo(this.href);return false;}">
                <div class="rc-title">${escapeHtml(item.title)}</div>
                <div class="rc-meta">
                  <span class="rc-time">${timeAgo}</span>
                  <span class="rc-author">${escapeHtml(item.author_name || '알 수 없음')}</span>
                </div>
              </a>
            `;
        }).join('');

        const emptyMsg = '<div class="text-muted small p-2">변경 내역이 없습니다.</div>';
        const content = data.changes.length > 0 ? html : emptyMsg;

        document.querySelectorAll('.recent-changes-container').forEach(el => {
            el.innerHTML = content;
        });
    } catch (e) {
        // 무시
    }
}
