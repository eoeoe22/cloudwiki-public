/**
 * `graph:<slug>` 에고 그래프 시각화 모듈 (지연 로드).
 *
 * src/client/pages/index.ts 의 `showGraphDocument` 가 동적 import 로 불러와 실행한다.
 * 외부 force 라이브러리 없이 자체 경량 force-directed 레이아웃을 SVG 로 그린다(노드 상한 300이라
 * O(n²) 척력도 충분히 가볍다). `prefers-reduced-motion` 친화적으로 레이아웃은 한 번 동기
 * 시뮬레이션으로 수렴시킨 뒤 정적으로 그리며, 드래그·줌·팬만 상호작용으로 제공한다.
 *
 * - 노드 클릭 → 해당 문서로 이동(onNavigate)
 * - 노드 더블클릭 → 그 문서를 중심으로 그래프 재중심화(onRecenter)
 * - 호버 → 제목/slug/연결 수 툴팁
 * - 휠 → 커서 기준 줌, 배경 드래그 → 팬, 노드 드래그 → 위치 이동(고정)
 */

export interface GraphViewNode {
    slug: string;
    title: string | null;
    category: string | null;
    isPrivate: boolean;
    isCenter: boolean;
    characters: number;
}
export interface GraphViewEdge {
    source: string;
    target: string;
    type: string;
}
export interface GraphViewData {
    center: string;
    centerExists: boolean;
    depth: number;
    nodes: GraphViewNode[];
    edges: GraphViewEdge[];
    truncated: boolean;
    hasPrivate: boolean;
}
export interface RenderOptions {
    container: HTMLElement;
    data: GraphViewData;
    onNavigate: (slug: string) => void;
    onRecenter: (slug: string) => void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// 분류 색 팔레트 (WCAG 대비를 의식한 중간 채도). 분류 없음 → 중립 회색.
const CATEGORY_COLORS = [
    '#4f7cff', '#e8590c', '#2f9e44', '#9c36b5', '#1098ad',
    '#e8478b', '#f08c00', '#5c7cfa', '#37b24d', '#d6336c',
];
const NEUTRAL_COLOR = '#868e96';
const CENTER_COLOR = '#f03e3e';

interface SimNode extends GraphViewNode {
    x: number;
    y: number;
    vx: number;
    vy: number;
    degree: number;
    pinned: boolean;
    color: string;
    radius: number;
    el?: SVGGElement;
}

function injectStylesOnce(): void {
    if (document.getElementById('graph-view-styles')) return;
    const style = document.createElement('style');
    style.id = 'graph-view-styles';
    style.textContent = `
.graph-view-wrap { position: relative; width: 100%; height: 70vh; min-height: 420px;
    border: 1px solid var(--bs-border-color, #dee2e6); border-radius: 10px; overflow: hidden;
    background: var(--bs-tertiary-bg, #f8f9fa); }
.graph-view-wrap svg { width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; }
.graph-view-wrap svg.panning { cursor: grabbing; }
.graph-view-node { cursor: pointer; }
.graph-view-node circle { transition: stroke-width .1s ease; }
.graph-view-node:hover circle { stroke: #212529; stroke-width: 2.5px; }
.graph-view-node text { font-size: 11px; paint-order: stroke; stroke: var(--bs-body-bg, #fff);
    stroke-width: 3px; fill: var(--bs-body-color, #212529); pointer-events: none; user-select: none; }
.graph-view-edge { stroke: var(--bs-secondary-color, #adb5bd); stroke-opacity: .5; }
.graph-view-edge.mutual { stroke-opacity: .8; stroke-width: 2px; }
.graph-view-edge.template { stroke-dasharray: 4 3; }
.graph-view-tooltip { position: absolute; z-index: 5; max-width: 260px; pointer-events: none;
    background: rgba(33,37,41,.95); color: #fff; padding: 6px 9px; border-radius: 6px;
    font-size: 12px; line-height: 1.4; box-shadow: 0 2px 8px rgba(0,0,0,.25); display: none; }
.graph-view-legend { position: absolute; top: 8px; right: 8px; z-index: 4; max-width: 45%;
    background: rgba(var(--bs-body-bg-rgb, 255,255,255), .9); border: 1px solid var(--bs-border-color, #dee2e6);
    border-radius: 8px; padding: 6px 9px; font-size: 11px; line-height: 1.6; max-height: 50%; overflow: auto; }
.graph-view-legend .lg-item { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.graph-view-legend .lg-dot { width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto; }
.graph-view-controls { position: absolute; bottom: 8px; right: 8px; z-index: 4; display: flex; gap: 4px; }
.graph-view-controls button { width: 30px; height: 30px; padding: 0; }
`;
    document.head.appendChild(style);
}

/** 분류 문자열(다중이면 첫 번째) → 안정적인 색 인덱스. */
function categoryKey(category: string | null): string | null {
    if (!category) return null;
    const first = category.split(',')[0].trim();
    return first || null;
}
function colorForCategory(key: string | null): string {
    if (!key) return NEUTRAL_COLOR;
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return CATEGORY_COLORS[h % CATEGORY_COLORS.length];
}

export function renderEgoGraph(opts: RenderOptions): () => void {
    injectStylesOnce();
    const { container, data, onNavigate, onRecenter } = opts;
    container.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'graph-view-wrap';
    container.appendChild(wrap);

    if (!data.centerExists || data.nodes.length === 0) {
        wrap.style.height = 'auto';
        wrap.style.minHeight = '0';
        wrap.style.padding = '2rem';
        wrap.innerHTML = `<div class="text-center text-muted">
            <i class="bi bi-diagram-2" style="font-size:2rem"></i>
            <p class="mt-2 mb-0">표시할 연결이 없습니다.</p>
            <p class="small mb-0">이 문서를 가리키거나 이 문서가 가리키는 다른 문서가 없습니다.</p>
        </div>`;
        return () => { container.innerHTML = ''; };
    }

    // ── 노드/엣지 모델 구성 ──
    const nodeMap = new Map<string, SimNode>();
    for (const n of data.nodes) {
        nodeMap.set(n.slug, {
            ...n,
            x: 0, y: 0, vx: 0, vy: 0,
            degree: 0,
            pinned: n.isCenter,
            color: n.isCenter ? CENTER_COLOR : colorForCategory(categoryKey(n.category)),
            radius: 6,
        });
    }
    const nodes = Array.from(nodeMap.values());

    // 엣지: 양 끝이 모두 노드인 것만, 방향별 dedup. 상호 링크(mutual) 판정.
    const dirSet = new Set<string>();
    for (const e of data.edges) {
        if (nodeMap.has(e.source) && nodeMap.has(e.target)) dirSet.add(`${e.source}\u0000${e.target}`);
    }
    interface SimEdge { a: SimNode; b: SimNode; mutual: boolean; template: boolean; }
    const edges: SimEdge[] = [];
    const drawnUndirected = new Set<string>();
    for (const e of data.edges) {
        const a = nodeMap.get(e.source);
        const b = nodeMap.get(e.target);
        if (!a || !b || a === b) continue;
        const undirKey = a.slug < b.slug ? `${a.slug}\u0000${b.slug}` : `${b.slug}\u0000${a.slug}`;
        const mutual = dirSet.has(`${e.target}\u0000${e.source}`);
        if (drawnUndirected.has(undirKey)) {
            // 같은 쌍을 이미 그렸으면, 한쪽이 template 라도 mutual/template 플래그를 보강.
            const existing = edges.find(x => (x.a === a && x.b === b) || (x.a === b && x.b === a));
            if (existing) {
                if (e.type === 'template') existing.template = true;
                if (mutual) existing.mutual = true;
            }
            continue;
        }
        drawnUndirected.add(undirKey);
        edges.push({ a, b, mutual, template: e.type === 'template' });
        a.degree++; b.degree++;
    }

    // 차수에 따른 반지름 (4~16). 중심 노드는 가산.
    const maxDeg = Math.max(1, ...nodes.map(n => n.degree));
    for (const n of nodes) {
        n.radius = 4 + 12 * Math.sqrt(n.degree / maxDeg) + (n.isCenter ? 4 : 0);
    }

    // ── 초기 배치: 중심을 원점에, 나머지는 차수 역순으로 동심원에 분산 ──
    const center = nodes.find(n => n.isCenter) ?? nodes[0];
    center.x = 0; center.y = 0;
    const others = nodes.filter(n => n !== center);
    others.forEach((n, i) => {
        const ring = 1 + Math.floor(i / 12);
        const angle = (i % 12) * (Math.PI * 2 / 12) + ring * 0.6;
        n.x = Math.cos(angle) * ring * 120;
        n.y = Math.sin(angle) * ring * 120;
    });

    runForceSimulation(nodes, edges, center);

    // ── SVG 렌더 ──
    const svg = document.createElementNS(SVG_NS, 'svg');
    const vp = document.createElementNS(SVG_NS, 'g'); // 줌/팬 적용 그룹
    const edgeLayer = document.createElementNS(SVG_NS, 'g');
    const nodeLayer = document.createElementNS(SVG_NS, 'g');

    // 화살표 마커 (단방향 엣지용)
    const defs = document.createElementNS(SVG_NS, 'defs');
    defs.innerHTML = `<marker id="gv-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--bs-secondary-color, #adb5bd)"></path></marker>`;
    svg.appendChild(defs);
    vp.appendChild(edgeLayer);
    vp.appendChild(nodeLayer);
    svg.appendChild(vp);
    wrap.appendChild(svg);

    const edgeEls: { el: SVGLineElement; e: SimEdge }[] = [];
    for (const e of edges) {
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('class', `graph-view-edge${e.mutual ? ' mutual' : ''}${e.template ? ' template' : ''}`);
        if (!e.mutual) line.setAttribute('marker-end', 'url(#gv-arrow)');
        edgeLayer.appendChild(line);
        edgeEls.push({ el: line, e });
    }

    for (const n of nodes) {
        const g = document.createElementNS(SVG_NS, 'g');
        g.setAttribute('class', 'graph-view-node');
        const circle = document.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('r', String(n.radius));
        circle.setAttribute('fill', n.color);
        circle.setAttribute('stroke', n.isPrivate ? '#212529' : '#fff');
        circle.setAttribute('stroke-width', n.isPrivate ? '2' : '1.5');
        if (n.isPrivate) circle.setAttribute('stroke-dasharray', '3 2');
        g.appendChild(circle);
        // 라벨: 중심/차수 높은 노드만 항상 표시(과밀 방지).
        if (n.isCenter || n.degree >= 2 || nodes.length <= 30) {
            const text = document.createElementNS(SVG_NS, 'text');
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('dy', String(-n.radius - 4));
            text.textContent = truncateLabel(n.title || n.slug);
            g.appendChild(text);
        }
        n.el = g;
        nodeLayer.appendChild(g);
    }

    // 툴팁
    const tooltip = document.createElement('div');
    tooltip.className = 'graph-view-tooltip';
    wrap.appendChild(tooltip);

    // 범례 (분류 색)
    buildLegend(wrap, nodes);

    // 컨트롤 (줌/리셋)
    const controls = document.createElement('div');
    controls.className = 'graph-view-controls';
    controls.innerHTML = `
        <button type="button" class="btn btn-sm btn-light border" data-act="zoom-in" title="확대"><i class="bi bi-plus-lg"></i></button>
        <button type="button" class="btn btn-sm btn-light border" data-act="zoom-out" title="축소"><i class="bi bi-dash-lg"></i></button>
        <button type="button" class="btn btn-sm btn-light border" data-act="reset" title="맞춤"><i class="bi bi-arrows-fullscreen"></i></button>`;
    wrap.appendChild(controls);

    // ── 줌/팬 상태 ──
    let scale = 1, tx = 0, ty = 0;
    const applyTransform = () => { vp.setAttribute('transform', `translate(${tx} ${ty}) scale(${scale})`); };
    const positionEdges = () => {
        for (const { el, e } of edgeEls) {
            // 화살표가 도착 노드 원에 박히지 않도록 b 쪽을 반지름만큼 당긴다.
            const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
            const dist = Math.hypot(dx, dy) || 1;
            const ux = dx / dist, uy = dy / dist;
            el.setAttribute('x1', String(e.a.x + ux * e.a.radius));
            el.setAttribute('y1', String(e.a.y + uy * e.a.radius));
            el.setAttribute('x2', String(e.b.x - ux * e.b.radius));
            el.setAttribute('y2', String(e.b.y - uy * e.b.radius));
        }
    };
    const positionNodes = () => {
        for (const n of nodes) n.el!.setAttribute('transform', `translate(${n.x} ${n.y})`);
    };
    positionNodes();
    positionEdges();

    // 초기 맞춤(fit): 노드 bbox 를 컨테이너에 맞춰 scale/translate 계산.
    const fit = () => {
        const rect = wrap.getBoundingClientRect();
        const w = rect.width || 600, h = rect.height || 420;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of nodes) {
            minX = Math.min(minX, n.x - n.radius); minY = Math.min(minY, n.y - n.radius);
            maxX = Math.max(maxX, n.x + n.radius); maxY = Math.max(maxY, n.y + n.radius);
        }
        const pad = 40;
        const gw = (maxX - minX) || 1, gh = (maxY - minY) || 1;
        scale = Math.min((w - pad * 2) / gw, (h - pad * 2) / gh, 2);
        if (!isFinite(scale) || scale <= 0) scale = 1;
        tx = w / 2 - ((minX + maxX) / 2) * scale;
        ty = h / 2 - ((minY + maxY) / 2) * scale;
        applyTransform();
    };
    fit();

    // ── 상호작용 ──
    const screenToGraph = (clientX: number, clientY: number) => {
        const rect = wrap.getBoundingClientRect();
        return { x: (clientX - rect.left - tx) / scale, y: (clientY - rect.top - ty) / scale };
    };

    let dragNode: SimNode | null = null;
    let panning = false;
    let downX = 0, downY = 0, moved = false;
    let lastClientX = 0, lastClientY = 0;
    // 단일 클릭(이동)을 더블클릭(재중심화)과 구분하기 위해, 클릭 이동을 짧게 지연했다가
    // 그 사이 dblclick 이 오면 취소한다. (지연하지 않으면 첫 pointerup 이 곧장 이동해
    // dblclick 의 onRecenter 가 도달하지 못한다.)
    const DBLCLICK_MS = 250;
    let clickTimer: number | null = null;
    const cancelPendingClick = () => {
        if (clickTimer !== null) { clearTimeout(clickTimer); clickTimer = null; }
    };

    const findNodeFromEvent = (target: EventTarget | null): SimNode | null => {
        let el = target as Element | null;
        while (el && el !== svg) {
            if (el instanceof SVGGElement && el.classList.contains('graph-view-node')) {
                return nodes.find(n => n.el === el) ?? null;
            }
            el = el.parentElement;
        }
        return null;
    };

    const onPointerDown = (ev: PointerEvent) => {
        downX = ev.clientX; downY = ev.clientY; moved = false;
        lastClientX = ev.clientX; lastClientY = ev.clientY;
        const node = findNodeFromEvent(ev.target);
        if (node) {
            dragNode = node;
        } else {
            panning = true;
            svg.classList.add('panning');
        }
        svg.setPointerCapture(ev.pointerId);
    };
    const onPointerMove = (ev: PointerEvent) => {
        if (!dragNode && !panning) {
            // 호버 툴팁
            const node = findNodeFromEvent(ev.target);
            if (node) showTooltip(node, ev); else tooltip.style.display = 'none';
            return;
        }
        const dx = ev.clientX - lastClientX, dy = ev.clientY - lastClientY;
        lastClientX = ev.clientX; lastClientY = ev.clientY;
        if (Math.abs(ev.clientX - downX) + Math.abs(ev.clientY - downY) > 4) moved = true;
        if (dragNode) {
            const p = screenToGraph(ev.clientX, ev.clientY);
            dragNode.x = p.x; dragNode.y = p.y; dragNode.pinned = true;
            dragNode.el!.setAttribute('transform', `translate(${dragNode.x} ${dragNode.y})`);
            positionEdges();
        } else if (panning) {
            tx += dx; ty += dy; applyTransform();
        }
    };
    const onPointerUp = (ev: PointerEvent) => {
        try { svg.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
        const node = dragNode;
        dragNode = null; panning = false; svg.classList.remove('panning');
        // 드래그가 아니면 클릭 = 이동. 단, 더블클릭(재중심화) 가능성을 위해 잠깐 지연한다.
        if (node && !moved) {
            cancelPendingClick();
            const targetSlug = node.slug;
            clickTimer = window.setTimeout(() => { clickTimer = null; onNavigate(targetSlug); }, DBLCLICK_MS);
        }
    };
    const onDblClick = (ev: MouseEvent) => {
        const node = findNodeFromEvent(ev.target);
        if (node && !node.isCenter) {
            // 보류된 단일 클릭 이동을 취소하고 재중심화. (center 노드는 재중심화가 무의미하므로
            // 보류된 이동을 그대로 둬 해당 문서로 이동하게 한다.)
            cancelPendingClick();
            onRecenter(node.slug);
        }
    };
    const onWheel = (ev: WheelEvent) => {
        ev.preventDefault();
        const rect = wrap.getBoundingClientRect();
        const cx = ev.clientX - rect.left, cy = ev.clientY - rect.top;
        const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
        const newScale = Math.max(0.15, Math.min(5, scale * factor));
        // 커서 위치를 기준으로 확대/축소.
        tx = cx - (cx - tx) * (newScale / scale);
        ty = cy - (cy - ty) * (newScale / scale);
        scale = newScale;
        applyTransform();
    };

    svg.addEventListener('pointerdown', onPointerDown);
    svg.addEventListener('pointermove', onPointerMove);
    svg.addEventListener('pointerup', onPointerUp);
    svg.addEventListener('pointercancel', onPointerUp);
    svg.addEventListener('dblclick', onDblClick);
    svg.addEventListener('wheel', onWheel, { passive: false });
    svg.addEventListener('pointerleave', () => { tooltip.style.display = 'none'; });

    controls.addEventListener('click', (ev) => {
        const btn = (ev.target as Element).closest('button');
        if (!btn) return;
        const act = btn.getAttribute('data-act');
        if (act === 'reset') { fit(); return; }
        const rect = wrap.getBoundingClientRect();
        const cx = rect.width / 2, cy = rect.height / 2;
        const factor = act === 'zoom-in' ? 1.25 : 0.8;
        const newScale = Math.max(0.15, Math.min(5, scale * factor));
        tx = cx - (cx - tx) * (newScale / scale);
        ty = cy - (cy - ty) * (newScale / scale);
        scale = newScale;
        applyTransform();
    });

    function showTooltip(node: SimNode, ev: PointerEvent) {
        const rect = wrap.getBoundingClientRect();
        const cat = categoryKey(node.category);
        tooltip.innerHTML = `<strong>${escapeHtml(node.title || node.slug)}</strong>`
            + (node.title ? `<br><span style="opacity:.7">${escapeHtml(node.slug)}</span>` : '')
            + `<br>연결 ${node.degree}개${cat ? ` · ${escapeHtml(cat)}` : ''}${node.isPrivate ? ' · 비공개' : ''}`;
        tooltip.style.display = 'block';
        let left = ev.clientX - rect.left + 12;
        let top = ev.clientY - rect.top + 12;
        if (left + tooltip.offsetWidth > rect.width) left = rect.width - tooltip.offsetWidth - 6;
        if (top + tooltip.offsetHeight > rect.height) top = ev.clientY - rect.top - tooltip.offsetHeight - 12;
        tooltip.style.left = Math.max(4, left) + 'px';
        tooltip.style.top = Math.max(4, top) + 'px';
    }

    // 컨테이너 크기 변동 시 재맞춤.
    const ro = new ResizeObserver(() => fit());
    ro.observe(wrap);

    return () => {
        cancelPendingClick();
        ro.disconnect();
        container.innerHTML = '';
    };
}

/** 경량 force-directed 레이아웃을 동기적으로 수렴시킨다(애니메이션 없음). */
function runForceSimulation(nodes: SimNode[], edges: { a: SimNode; b: SimNode }[], center: SimNode): void {
    const n = nodes.length;
    const ITER = n <= 60 ? 320 : n <= 150 ? 240 : 180;
    const REPULSION = 9000;
    const SPRING = 0.02;
    const SPRING_LEN = 90;
    const GRAVITY = 0.012;
    const MAX_DISP_START = 120;

    for (let it = 0; it < ITER; it++) {
        const t = MAX_DISP_START * (1 - it / ITER); // 냉각
        // 척력 (O(n²), n≤300)
        for (let i = 0; i < n; i++) {
            const a = nodes[i];
            for (let j = i + 1; j < n; j++) {
                const b = nodes[j];
                let dx = a.x - b.x, dy = a.y - b.y;
                let d2 = dx * dx + dy * dy;
                if (d2 < 0.01) { dx = (Math.random() - 0.5); dy = (Math.random() - 0.5); d2 = 0.01; }
                const force = REPULSION / d2;
                const dist = Math.sqrt(d2);
                const fx = (dx / dist) * force, fy = (dy / dist) * force;
                a.vx += fx; a.vy += fy;
                b.vx -= fx; b.vy -= fy;
            }
        }
        // 인력 (엣지 스프링)
        for (const e of edges) {
            const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
            const dist = Math.hypot(dx, dy) || 1;
            const force = SPRING * (dist - SPRING_LEN);
            const fx = (dx / dist) * force, fy = (dy / dist) * force;
            e.a.vx += fx; e.a.vy += fy;
            e.b.vx -= fx; e.b.vy -= fy;
        }
        // 중력(원점으로) + 적분 + 냉각 제한
        for (const node of nodes) {
            node.vx -= node.x * GRAVITY;
            node.vy -= node.y * GRAVITY;
            if (node.pinned) { node.vx = 0; node.vy = 0; continue; }
            const sp = Math.hypot(node.vx, node.vy);
            if (sp > t) { node.vx = (node.vx / sp) * t; node.vy = (node.vy / sp) * t; }
            node.x += node.vx; node.y += node.vy;
            node.vx *= 0.85; node.vy *= 0.85;
        }
        center.x = 0; center.y = 0;
    }
}

function buildLegend(wrap: HTMLElement, nodes: SimNode[]): void {
    const seen = new Map<string, string>();
    for (const n of nodes) {
        const key = categoryKey(n.category);
        if (key && !seen.has(key) && !n.isCenter) seen.set(key, n.color);
    }
    const items: string[] = [`<div class="lg-item"><span class="lg-dot" style="background:${CENTER_COLOR}"></span>중심 문서</div>`];
    for (const [key, color] of seen) {
        items.push(`<div class="lg-item"><span class="lg-dot" style="background:${color}"></span>${escapeHtml(key)}</div>`);
    }
    if (seen.size === 0) {
        items.push(`<div class="lg-item"><span class="lg-dot" style="background:${NEUTRAL_COLOR}"></span>분류 없음</div>`);
    }
    // 범례가 너무 길면 상위 일부만.
    const legend = document.createElement('div');
    legend.className = 'graph-view-legend';
    legend.innerHTML = items.slice(0, 12).join('') + (items.length > 12 ? `<div class="lg-item text-muted">…외 ${items.length - 12}</div>` : '');
    wrap.appendChild(legend);
}

function truncateLabel(s: string): string {
    return s.length > 22 ? s.slice(0, 21) + '…' : s;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}
