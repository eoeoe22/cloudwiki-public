// @ts-nocheck — all.html(모든 문서 보기) 부트스트랩. common.ts 가 window.* 로 노출하는 공통 전역
// (loadConfig / checkAuth / loadTrending / loadRecentChanges / escapeHtml / uiSkeletonList /
//  uiEmptyState)과 CDN 글로벌(bootstrap / Swal)을 사용한다. any 형태 fetch 응답이라 타입 검사를 끈다.
//
// 데이터 전략: /api/w/all-index 로 전체 문서를 1회 받아 클라이언트가 네임스페이스 분리 →
// 최상위/하위 계층 구성 → 초성 그룹/정렬 → 페이지네이션을 수행한다(카테고리 페이지 선례와 동일).
// 카테고리/이미지 탭은 최초 진입 시 각자 /api/w/all-categories · /api/media/all 를 지연 로드한다.
import { wikiInitialGroupOf } from '../../shared/chosung';

const esc = (s) => window.escapeHtml(String(s ?? ''));
const enc = (s) => encodeURIComponent(String(s ?? ''));
const collator = new Intl.Collator(['ko', 'ja', 'en'], { sensitivity: 'base', numeric: true });
const DOC_PAGE_SIZE = 60;

// 편집 ACL 플래그 라벨 — index.ts 의 편집 잠금 배지와 동일 매핑. (aged 는 실제 임계 일수를 주입)
const ACL_FLAG_LABELS = {
    aged: '가입 N일 이상',
    page_editor: '본 문서 편집 이력',
    any_editor: '임의 문서 편집 이력',
    admin_only: '관리자 전용',
};
const ACL_FLAG_ORDER = ['aged', 'page_editor', 'any_editor', 'admin_only'];

// ── 상태 ──
let minAgeDays = 0;
let nsBuckets = {};      // nsKey('' = 일반) -> { tops: [...] }
let nsOrder = [];        // 표시 순서의 nsKey 배열
let currentNs = '';
let docSort = 'name_asc';
let aclDetail = false;
let docPage = 1;

let catData = null;
let catsLoaded = false;
let imgData = null;
let imgsLoaded = false;

// ── slug 파싱: 네임스페이스 / 최상위·하위 계층 / 초성 추출 기준 글자 ──
function parseSlug(slug) {
    const s = String(slug);
    const ci = s.indexOf(':');
    let namespace = null;
    let localPath = s;
    // 첫 ':' 앞이 공백·특수문자 없는 식별자일 때만 네임스페이스로 인정한다
    // (예: "틀:정보상자" → 틀 / "freq:Apple" → freq. "비율 3:2" 같은 일반 제목은 제외).
    // 주의: "버전:1.0"·"C:Drive" 처럼 공백 없는 접두를 가진 실제 일반 문서도 네임스페이스로
    // 분류된다 — 이는 앱 전반의 "첫 콜론 = 네임스페이스" 관례(utils/slug.ts isR2OnlyNamespace 등)와
    // 일치하는 동작이라 의도적으로 동일하게 둔다(표시/그룹핑 한정, 식별·링크는 항상 slug 전체).
    if (ci > 0) {
        const prefix = s.substring(0, ci);
        if (/^[\p{L}\p{N}_-]+$/u.test(prefix)) {
            namespace = prefix;
            localPath = s.substring(ci + 1);
        }
    }
    const segs = localPath.split('/');
    const rootSegment = segs[0];
    const rootSlug = namespace !== null ? `${namespace}:${rootSegment}` : rootSegment;
    return { namespace, localPath, rootSegment, rootSlug, isTopLevel: segs.length === 1 };
}

// 하위 문서의 루트 기준 상대 경로 (예: '틀:정보상자/색상' → '색상')
function relativeSubPath(slug) {
    const info = parseSlug(slug);
    const rel = info.localPath.substring(info.rootSegment.length + 1);
    return rel || info.localPath;
}

// ── /api/w/all-index 응답 → 네임스페이스별 최상위 트리 구성 ──
function buildBuckets(pages) {
    const buckets = {}; // nsKey -> Map<rootSlug, top>
    for (const p of pages) {
        const info = parseSlug(p.slug);
        const ns = info.namespace ?? '';
        if (!buckets[ns]) buckets[ns] = new Map();
        const m = buckets[ns];
        if (!m.has(info.rootSlug)) {
            m.set(info.rootSlug, { rootSlug: info.rootSlug, rootSegment: info.rootSegment, page: null, children: [] });
        }
        const top = m.get(info.rootSlug);
        if (info.isTopLevel) top.page = p;
        else top.children.push(p);
    }

    const out = {};
    for (const ns of Object.keys(buckets)) {
        const tops = [...buckets[ns].values()];
        for (const t of tops) {
            t.children.sort((a, b) => collator.compare(a.slug, b.slug));
            t._subs = t.children.length;
            t._chars = t.page && t.page.characters ? t.page.characters : 0;
            let upd = t.page && t.page.updated_at ? t.page.updated_at : 0;
            let crd = t.page && t.page.created_at ? t.page.created_at : 0;
            for (const ch of t.children) {
                if (ch.updated_at && ch.updated_at > upd) upd = ch.updated_at;
                if (ch.created_at && (crd === 0 || ch.created_at < crd)) crd = ch.created_at;
            }
            t._updated = upd;
            t._created = crd;
        }
        out[ns] = { tops };
    }

    const order = Object.keys(out).sort((a, b) => (a === '' ? -1 : b === '' ? 1 : collator.compare(a, b)));
    return { buckets: out, order };
}

// ── 배지: 카테고리(쉼표 구분) + 편집 ACL ──
function aclLabel(flag) {
    if (flag === 'aged') return minAgeDays > 0 ? `가입 ${minAgeDays}일 이상` : ACL_FLAG_LABELS.aged;
    return ACL_FLAG_LABELS[flag] || flag;
}

function categoryBadges(catStr) {
    if (!catStr) return '';
    return String(catStr).split(',').map(s => s.trim()).filter(Boolean)
        .map(cat => `<span class="badge bg-secondary bg-opacity-10 text-secondary border">${esc(cat)}</span>`)
        .join('');
}

function aclBadges(flags, detail) {
    const valid = ACL_FLAG_ORDER.filter(f => Array.isArray(flags) && flags.includes(f));
    if (!valid.length) return '';
    if (detail) {
        return valid.map(f => `<span class="badge bg-danger bg-opacity-10 text-danger border"><i class="bi bi-lock-fill"></i> ${esc(aclLabel(f))}</span>`).join('');
    }
    const content = '<ul class="mb-0 ps-3">' + valid.map(f => `<li>${esc(aclLabel(f))}</li>`).join('') + '</ul>';
    return `<span class="badge bg-danger edit-lock-badge" tabindex="0" data-bs-toggle="popover" data-bs-trigger="hover focus" data-bs-placement="top" data-bs-html="true" data-bs-content="${esc(content)}" style="cursor:help;"><i class="bi bi-lock-fill"></i> 편집 잠금</span>`;
}

function pageBadges(page) {
    if (!page) return '';
    return categoryBadges(page.category) + aclBadges(page.acl, aclDetail);
}

// ── Bootstrap popover (편집 잠금 배지) 관리 ──
function disposePopovers(container) {
    if (typeof bootstrap === 'undefined' || !container) return;
    container.querySelectorAll('.edit-lock-badge[data-bs-toggle="popover"]').forEach(el => {
        if (el._lockPopover) {
            try { el._lockPopover.dispose(); } catch { /* ignore */ }
            el._lockPopover = null;
        }
    });
}

function initPopovers(container) {
    if (typeof bootstrap === 'undefined' || !container) return;
    container.querySelectorAll('.edit-lock-badge[data-bs-toggle="popover"]').forEach(el => {
        if (!el._lockPopover) {
            el._lockPopover = new bootstrap.Popover(el, { trigger: 'hover focus', container: 'body', animation: false, html: true });
        }
    });
}

// ── 그룹 렌더링 헬퍼 (초성 섹션 + 그리드) ──
function renderGroups(items, renderItem, gridClass) {
    let html = '<div class="all-groups">';
    let cur = null;
    let open = false;
    for (const it of items) {
        if (cur !== it._label) {
            if (open) html += '</div></section>';
            cur = it._label;
            html += `<section class="all-group"><h5 class="all-group-label">${esc(cur)}</h5><div class="${gridClass}">`;
            open = true;
        }
        html += renderItem(it);
    }
    if (open) html += '</div></section>';
    html += '</div>';
    return html;
}

// ── 페이지네이션 (Bootstrap .pagination 재사용) ──
function paginationHtml(cur, total) {
    if (total <= 1) return '';
    const pages = new Set([1, total]);
    for (let i = Math.max(2, cur - 2); i <= Math.min(total - 1, cur + 2); i++) pages.add(i);
    const sorted = [...pages].sort((a, b) => a - b);
    let html = '<nav class="all-pagination" aria-label="페이지"><ul class="pagination justify-content-center flex-wrap">';
    html += `<li class="page-item ${cur === 1 ? 'disabled' : ''}"><a class="page-link" href="#" data-pg="${cur - 1}">이전</a></li>`;
    let prev = 0;
    for (const p of sorted) {
        if (prev && p - prev > 1) html += '<li class="page-item disabled"><span class="page-link">…</span></li>';
        html += `<li class="page-item ${p === cur ? 'active' : ''}"><a class="page-link" href="#" data-pg="${p}">${p}</a></li>`;
        prev = p;
    }
    html += `<li class="page-item ${cur === total ? 'disabled' : ''}"><a class="page-link" href="#" data-pg="${cur + 1}">다음</a></li>`;
    html += '</ul></nav>';
    return html;
}

function bindPagination(container, total, cb) {
    container.querySelectorAll('.all-pagination a.page-link[data-pg]').forEach(a => {
        a.addEventListener('click', (e) => {
            e.preventDefault();
            const p = parseInt(a.getAttribute('data-pg'), 10);
            if (p >= 1 && p <= total) {
                cb(p);
                const pane = container.closest('.tab-pane');
                if (pane) pane.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    });
}

// ── 문서 탭 ──
async function loadDocs() {
    const el = document.getElementById('docContent');
    el.innerHTML = window.uiSkeletonList(8);
    try {
        const res = await fetch('/api/w/all-index');
        if (!res.ok) throw new Error('all-index load failed');
        const data = await res.json();
        minAgeDays = Number(data.min_age_days) || 0;
        const pages = Array.isArray(data.pages) ? data.pages : [];
        const built = buildBuckets(pages);
        nsBuckets = built.buckets;
        nsOrder = built.order;
        currentNs = nsOrder.length ? nsOrder[0] : '';
        if (!nsOrder.length) {
            document.getElementById('nsSubTabs').innerHTML = '';
            el.innerHTML = window.uiEmptyState({ icon: 'bi bi-inbox', title: '문서가 없습니다', text: '첫 문서를 작성해 보세요.' });
            return;
        }
        renderNsTabs();
        renderDocs(1);
    } catch (e) {
        console.error(e);
        el.innerHTML = window.uiEmptyState({ icon: 'bi bi-exclamation-triangle', title: '문서를 불러오지 못했습니다' });
    }
}

function renderNsTabs() {
    const tabsEl = document.getElementById('nsSubTabs');
    tabsEl.innerHTML = nsOrder.map(ns => {
        const label = ns === '' ? '일반' : ns + ':';
        const count = nsBuckets[ns].tops.length;
        const active = ns === currentNs ? ' active' : '';
        return `<li class="nav-item" role="presentation"><button type="button" class="nav-link${active}" data-ns="${esc(ns)}">${esc(label)} <span class="badge bg-light text-muted border ms-1">${count}</span></button></li>`;
    }).join('');
    tabsEl.querySelectorAll('button[data-ns]').forEach(btn => {
        btn.addEventListener('click', () => {
            currentNs = btn.getAttribute('data-ns');
            tabsEl.querySelectorAll('.nav-link').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderDocs(1);
        });
    });
}

function orderedTops(tops, sort) {
    if (sort === 'name_asc' || sort === 'name_desc') {
        const arr = tops.map(t => {
            const g = wikiInitialGroupOf(t.rootSegment);
            t._order = g.order;
            t._label = g.label;
            return t;
        });
        arr.sort((a, b) => {
            if (a._order !== b._order) return a._order < b._order ? -1 : 1;
            return collator.compare(a.rootSlug, b.rootSlug);
        });
        if (sort === 'name_desc') arr.reverse();
        return { items: arr, grouped: true };
    }
    const arr = tops.slice();
    const dir = sort.endsWith('_desc') ? -1 : 1;
    const key = sort.startsWith('updated') ? '_updated'
        : sort.startsWith('created') ? '_created'
            : sort.startsWith('chars') ? '_chars'
                : '_subs';
    arr.sort((a, b) => {
        const av = a[key] || 0;
        const bv = b[key] || 0;
        if (av !== bv) return (av < bv ? -1 : 1) * dir;
        return collator.compare(a.rootSlug, b.rootSlug);
    });
    return { items: arr, grouped: false };
}

function topCardHtml(t) {
    const hasKids = t.children.length > 0;
    const collapseId = `allsub-${t._cid}`;
    const titleHtml = t.page
        ? `<a class="all-card-title" href="/w/${enc(t.rootSlug)}" title="${esc(t.rootSlug)}">${esc(t.page.title || t.rootSlug)}</a>`
        : `<span class="all-card-title is-missing" title="${esc(t.rootSlug)} (문서 없음)">${esc(t.rootSlug)}</span>`;
    const toggle = hasKids
        ? `<button class="all-toggle" type="button" data-bs-toggle="collapse" data-bs-target="#${collapseId}" aria-expanded="false" aria-controls="${collapseId}" aria-label="하위 문서 ${t.children.length}개 펼치기"><i class="bi bi-chevron-right"></i></button>`
        : '<span class="all-toggle" style="visibility:hidden;" aria-hidden="true"><i class="bi bi-chevron-right"></i></span>';
    const subCount = hasKids ? `<span class="badge bg-light text-muted border" title="하위 문서 수">${t.children.length}</span>` : '';

    let html = `<div class="surface-card all-card"><div class="all-card-header">${toggle}${titleHtml}<span class="all-badges">${subCount}${pageBadges(t.page)}</span></div>`;
    if (hasKids) {
        const kids = t.children.map(ch =>
            `<a class="all-subdoc" href="/w/${enc(ch.slug)}" title="${esc(ch.slug)}"><i class="bi bi-arrow-return-right text-muted" aria-hidden="true"></i><span class="all-subdoc-name">${esc(relativeSubPath(ch.slug))}</span><span class="all-badges">${pageBadges(ch)}</span></a>`
        ).join('');
        html += `<div class="collapse all-subdocs" id="${collapseId}">${kids}</div>`;
    }
    html += '</div>';
    return html;
}

function renderDocs(page) {
    docPage = page || 1;
    const el = document.getElementById('docContent');
    const bucket = nsBuckets[currentNs];
    disposePopovers(el);
    if (!bucket || bucket.tops.length === 0) {
        el.innerHTML = window.uiEmptyState({ icon: 'bi bi-inbox', title: '문서가 없습니다' });
        return;
    }
    const { items, grouped } = orderedTops(bucket.tops, docSort);
    const totalPages = Math.max(1, Math.ceil(items.length / DOC_PAGE_SIZE));
    const cur = Math.min(Math.max(1, docPage), totalPages);
    docPage = cur;
    const start = (cur - 1) * DOC_PAGE_SIZE;
    const slice = items.slice(start, start + DOC_PAGE_SIZE);
    slice.forEach((t, i) => { t._cid = i; });

    const body = grouped
        ? renderGroups(slice, topCardHtml, 'all-grid')
        : `<div class="all-grid">${slice.map(topCardHtml).join('')}</div>`;
    const summary = `<div class="all-summary text-muted small">총 ${items.length}개 최상위 문서 · ${start + 1}–${start + slice.length} 표시</div>`;

    el.innerHTML = summary + body + paginationHtml(cur, totalPages);
    initPopovers(el);
    bindPagination(el, totalPages, renderDocs);
}

// ── 카테고리 탭 ──
async function loadCats() {
    const el = document.getElementById('catContent');
    el.innerHTML = window.uiSkeletonList(8);
    try {
        const res = await fetch('/api/w/all-categories');
        if (!res.ok) throw new Error('all-categories load failed');
        const data = await res.json();
        catData = Array.isArray(data.categories) ? data.categories : [];
        renderCats();
    } catch (e) {
        console.error(e);
        el.innerHTML = window.uiEmptyState({ icon: 'bi bi-exclamation-triangle', title: '카테고리를 불러오지 못했습니다' });
    }
}

function catItemHtml(c) {
    const lock = aclBadges(c.acl, false);
    return `<a class="surface-card all-card" href="/w/category/${enc(c.name)}" title="${esc(c.name)}"><div class="all-card-header"><span class="all-card-title">${esc(c.name)}</span><span class="all-badges"><span class="badge bg-light text-muted border" title="문서 수">${Number(c.count) || 0}</span>${lock}</span></div></a>`;
}

function renderCats() {
    const el = document.getElementById('catContent');
    disposePopovers(el);
    if (!catData || !catData.length) {
        el.innerHTML = window.uiEmptyState({ icon: 'bi bi-inbox', title: '카테고리가 없습니다' });
        return;
    }
    const sort = document.getElementById('catSortSelect').value;
    let items = catData.slice();
    let grouped = false;
    if (sort === 'name_asc' || sort === 'name_desc') {
        items.forEach(c => { const g = wikiInitialGroupOf(c.name); c._order = g.order; c._label = g.label; });
        items.sort((a, b) => (a._order !== b._order ? (a._order < b._order ? -1 : 1) : collator.compare(a.name, b.name)));
        if (sort === 'name_desc') items.reverse();
        grouped = true;
    } else {
        const dir = sort === 'count_desc' ? -1 : 1;
        items.sort((a, b) => (a.count !== b.count ? (a.count < b.count ? -1 : 1) * dir : collator.compare(a.name, b.name)));
    }
    const summary = `<div class="all-summary text-muted small">총 ${items.length}개 카테고리</div>`;
    const body = grouped
        ? renderGroups(items, catItemHtml, 'all-grid')
        : `<div class="all-grid">${items.map(catItemHtml).join('')}</div>`;
    el.innerHTML = summary + body;
    initPopovers(el);
}

// ── 이미지 탭 ──
function formatSize(bytes) {
    const b = Number(bytes) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(1) + ' MB';
}

async function loadImages() {
    const el = document.getElementById('imgContent');
    el.innerHTML = window.uiSkeletonList(8);
    try {
        const res = await fetch('/api/media/all');
        if (!res.ok) throw new Error('all-images load failed');
        const data = await res.json();
        imgData = Array.isArray(data.items) ? data.items : [];
        renderImages();
    } catch (e) {
        console.error(e);
        el.innerHTML = window.uiEmptyState({ icon: 'bi bi-exclamation-triangle', title: '이미지를 불러오지 못했습니다' });
    }
}

function imgItemHtml(m) {
    return `<a class="surface-card all-img-card" href="${esc(m.url)}" target="_blank" rel="noopener" title="${esc(m.filename)}"><img class="all-img-thumb" src="${esc(m.url)}" alt="${esc(m.filename)}" loading="lazy"><div class="all-img-meta"><div class="all-img-name">${esc(m.filename)}</div><div class="all-img-size">${esc(formatSize(m.size))}</div></div></a>`;
}

function renderImages() {
    const el = document.getElementById('imgContent');
    if (!imgData || !imgData.length) {
        el.innerHTML = window.uiEmptyState({ icon: 'bi bi-inbox', title: '이미지가 없습니다' });
        return;
    }
    const sort = document.getElementById('imgSortSelect').value;
    let items = imgData.slice();
    let grouped = false;
    if (sort === 'name_asc' || sort === 'name_desc') {
        items.forEach(m => { const g = wikiInitialGroupOf(m.filename); m._order = g.order; m._label = g.label; });
        items.sort((a, b) => (a._order !== b._order ? (a._order < b._order ? -1 : 1) : collator.compare(a.filename, b.filename)));
        if (sort === 'name_desc') items.reverse();
        grouped = true;
    } else if (sort === 'created_desc' || sort === 'created_asc') {
        const dir = sort === 'created_desc' ? -1 : 1;
        items.sort((a, b) => ((a.created_at || 0) - (b.created_at || 0)) * dir);
    } else {
        const dir = sort === 'size_desc' ? -1 : 1;
        items.sort((a, b) => ((a.size || 0) - (b.size || 0)) * dir);
    }
    const summary = `<div class="all-summary text-muted small">총 ${items.length}개 이미지</div>`;
    const body = grouped
        ? renderGroups(items, imgItemHtml, 'all-img-grid')
        : `<div class="all-img-grid">${items.map(imgItemHtml).join('')}</div>`;
    el.innerHTML = summary + body;
}

// ── 초기화 ──
document.addEventListener('DOMContentLoaded', async () => {
    await window.loadConfig();
    await window.checkAuth();
    window.loadTrending();
    window.loadRecentChanges();

    loadDocs();

    document.getElementById('tab-cats').addEventListener('shown.bs.tab', () => {
        if (!catsLoaded) { catsLoaded = true; loadCats(); }
    });
    document.getElementById('tab-imgs').addEventListener('shown.bs.tab', () => {
        if (!imgsLoaded) { imgsLoaded = true; loadImages(); }
    });

    document.getElementById('docSortSelect').addEventListener('change', (e) => {
        docSort = e.target.value;
        renderDocs(1);
    });
    document.getElementById('aclDetailToggle').addEventListener('change', (e) => {
        aclDetail = e.target.checked;
        renderDocs(docPage);
    });
    document.getElementById('catSortSelect').addEventListener('change', renderCats);
    document.getElementById('imgSortSelect').addEventListener('change', renderImages);
});
