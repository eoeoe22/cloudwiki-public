import { Hono, Context } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from '../types';
import { renderForAI, extractTOC, extractSection, findSectionForSnippet } from '../utils/aiParser';
import { normalizeSlug, isR2OnlyNamespace, isMcpReadableSlug } from '../utils/slug';
import { getRevisionContent } from '../utils/r2';

const mcpRoutes = new Hono<Env>();

// ... (omitting lines between imports and handleJsonRpc for brevity in this thought, but replace tool needs exact match)

// CORS 미들웨어 적용
mcpRoutes.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Hono-CSRF'],
    maxAge: 86400,
}));

// 인증 및 모드 체크 미들웨어
mcpRoutes.use('*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return await next();

    // 브라우저 GET 요청(Accept: text/html)은 라우트 핸들러에서 직접 처리
    if (c.req.method === 'GET' && (c.req.header('Accept') || '').includes('text/html')) {
        return await next();
    }

    const mcpMode = c.env.MCP_MODE || 'disabled';

    if (mcpMode === 'disabled') {
        return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'MCP is disabled by administrator.' }, id: null }, 403);
    }

    await next();
});

// GET /api/mcp - 기본 정보 (브라우저 접속 시 안내 페이지)
mcpRoutes.get('/', async (c) => {
    const accept = c.req.header('Accept') || '';

    // 브라우저 접속 감지
    if (accept.includes('text/html')) {
        const mcpMode = c.env.MCP_MODE || 'disabled';

        // MCP 비활성화 시 404
        if (mcpMode === 'disabled') {
            return new Response('Not Found', { status: 404 });
        }

        // 안내 배너 HTML (captcha 페이지 body 최상단에 삽입)
        const bannerHtml = `<div style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#fff;border-bottom:2px solid #e0e0e0;padding:0.7rem 1.2rem;display:flex;align-items:center;justify-content:space-between;gap:1rem;font-family:'Segoe UI',system-ui,sans-serif;font-size:0.92rem;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
  <span><strong>로봇입니까?</strong> &nbsp;사람은 MCP 서버에 접속할 수 없습니다.</span>
</div>
<div style="height:52px;"></div>`;

        // captcha 페이지 fetch 후 HTMLRewriter로 배너 삽입
        try {
            const captchaRes = await fetch('https://vialinks.xyz/captcha');
            if (captchaRes.ok) {
                return new HTMLRewriter()
                    .on('head', {
                        element(el) {
                            // 상대경로 리소스(CSS/JS/이미지)가 원본 도메인 기준으로 로드되도록
                            el.append('<base href="https://vialinks.xyz/">', { html: true });
                        }
                    })
                    .on('body', {
                        element(el) {
                            el.prepend(bannerHtml, { html: true });
                        }
                    })
                    .transform(captchaRes);
            }
        } catch {
            // fetch 실패 시 fallback으로 진행
        }

        // fallback: captcha 페이지를 가져올 수 없는 경우 iframe으로 표시
        const fallbackHtml = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>로봇입니까?</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #f5f5f5; font-family: 'Segoe UI', system-ui, sans-serif; color: #1a1a1a; padding: 2rem; }
  .card { background: #fff; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.10); padding: 2.5rem 2rem 2rem; max-width: 520px; width: 100%; text-align: center; }
  .robot-icon { font-size: 3.5rem; margin-bottom: 1rem; }
  h1 { font-size: 1.8rem; font-weight: 700; margin-bottom: 0.4rem; }
  .subtitle { font-size: 1rem; color: #555; margin-bottom: 1.8rem; }
  .iframe-wrapper { width: 100%; border-radius: 8px; overflow: hidden; border: 1.5px solid #e0e0e0; margin-bottom: 1.8rem; background: #fafafa; }
  iframe { width: 100%; height: 320px; border: none; display: block; }
  .info-box { background: #f0f7ff; border: 1px solid #c2daf7; border-radius: 8px; padding: 0.9rem 1.2rem; font-size: 0.92rem; color: #2563eb; }
  .info-box a { color: #1d4ed8; font-weight: 600; text-decoration: underline; }
</style>
</head>
<body>
<div class="card">
  <div class="robot-icon"></div>
  <h1>로봇입니까?</h1>
  <p class="subtitle">사람은 접속할 수 없습니다.</p>
  <div class="iframe-wrapper">
    <iframe src="https://vialinks.xyz/captcha" title="CAPTCHA" sandbox="allow-scripts allow-same-origin"></iframe>
  </div>
</div>
</body>
</html>`;

        return new Response(fallbackHtml, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=UTF-8' },
        });
    }

    return c.json({
        mcp: true,
        version: '1.0.0',
        transport: 'http',
        endpoint: `${new URL(c.req.url).origin}/api/mcp`
    });
});

// 공통 JSON-RPC 처리 함수
async function handleJsonRpc(c: Context<Env>, body: any) {
    const { jsonrpc, method, params, id } = body;
    if (jsonrpc !== '2.0') return { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: id || null };

    const db = c.env.DB;

    // 1. 핸드셰이크: initialize
    if (method === 'initialize') {
        return {
            jsonrpc: '2.0',
            id,
            result: {
                protocolVersion: '2024-11-05',
                capabilities: {
                    tools: {},
                    logging: {}
                },
                serverInfo: {
                    name: 'cloudwiki-mcp',
                    version: '1.0.0'
                }
            }
        };
    }

    // 2. 핸드셰이크: initialized 알림 (응답 필요 없음)
    if (method === 'notifications/initialized') {
        return null; 
    }

    // 3. 도구 목록 반환
    if (method === 'tools/list') {
        return {
            jsonrpc: '2.0', id,
            result: {
                tools: [
                    {
                        name: 'information',
                        description: `이 도구는 ${c.env.WIKI_NAME} 의 문서를 탐색할 수 있는 MCP 도구입니다.`,
                        inputSchema: { type: 'object', properties: {}, required: [] }
                    },
                    {
                        name: 'search_title',
                        description: '위키 문서의 제목을 검색합니다.',
                        inputSchema: { type: 'object', properties: { query: { type: 'string', description: '검색어' } }, required: ['query'] }
                    },
                    {
                        name: 'search_fts',
                        description: '위키 문서의 본문을 전문 검색(FTS) 합니다. 검색 결과에는 문서 제목, 하이라이트된 부분, 그리고 해당 부분이 속한 목차가 포함됩니다.',
                        inputSchema: { type: 'object', properties: { query: { type: 'string', description: '검색어' } }, required: ['query'] }
                    },
                    {
                        name: 'get_toc',
                        description: '위키 문서의 목차(section)만 불러옵니다. 긴 문서를 전부 읽기보다 get_toc 도구로 목차를 추출한 뒤 read_section 도구를 이용해 부분적으로 읽는 것을 권장합니다.',
                        inputSchema: { type: 'object', properties: { title: { type: 'string', description: '문서 제목' } }, required: ['title'] }
                    },
                    {
                        name: 'read_document',
                        description: '위키 문서의 전체 본문을 읽어옵니다.',
                        inputSchema: { type: 'object', properties: { title: { type: 'string', description: '문서 제목' } }, required: ['title'] }
                    },
                    {
                        name: 'read_section',
                        description: '위키 문서에서 특정 목차의 내용만 읽어옵니다.',
                        inputSchema: { type: 'object', properties: { title: { type: 'string', description: '문서 제목' }, section_name: { type: 'string', description: '목차 명' } }, required: ['title', 'section_name'] }
                    },
                    {
                        name: 'get_tree',
                        description: '해당 문서의 하위 문서 목록을 tree구조로 보여줍니다.',
                        inputSchema: { type: 'object', properties: { title: { type: 'string', description: '문서 제목' } }, required: ['title'] }
                    },
                    {
                        name: 'search_category',
                        description: '카테고리를 제목으로 검색합니다.',
                        inputSchema: { type: 'object', properties: { query: { type: 'string', description: '검색할 카테고리 이름 (부분 문자열)' } }, required: ['query'] }
                    },
                    {
                        name: 'get_category_info',
                        description: '해당 카테고리에 속한 문서 목록과 카테고리 설명을 반환합니다.',
                        inputSchema: { type: 'object', properties: { category: { type: 'string', description: '조회할 카테고리 이름' } }, required: ['category'] }
                    },
                    {
                        name: 'get_document_categoty',
                        description: '해당 문서가 속한 카테고리 목록을 반환합니다.',
                        inputSchema: { type: 'object', properties: { title: { type: 'string', description: '조회할 문서 제목' } }, required: ['title'] }
                    }
                ]
            }
        };
    }

    if (method === 'tools/call') {
        const toolName = params?.name;
        const args = params?.arguments || {};
        try {
            if (toolName === 'information') {
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `이 도구는 ${c.env.WIKI_NAME} 의 문서를 탐색할 수 있는 MCP 도구입니다.` }] } };
            }
            if (toolName === 'search_title') {
                const results = await db.prepare('SELECT title FROM pages WHERE title LIKE ? AND deleted_at IS NULL AND is_private = 0 LIMIT 15')
                    .bind(`%${args.query}%`).all();
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(results.results, null, 2) }] } };
            }
            if (toolName === 'search_fts') {
                const query = `SELECT p.slug, p.title, p.content, p.last_revision_id, snippet(pages_fts, -1, '<b>', '</b>', '...', 20) as snippet FROM pages_fts f JOIN pages p ON f.rowid = p.id WHERE pages_fts MATCH ? AND p.deleted_at IS NULL AND p.is_private = 0 LIMIT 10`;
                const results = await db.prepare(query).bind(`"${args.query}"*`).all<{ slug: string; title: string; content: string; last_revision_id: number | null; snippet: string }>();
                
                const origin = new URL(c.req.url).origin;
                const output = await Promise.all(results.results.map(async (row) => {
                    let actualContent = row.content;
                    if (isR2OnlyNamespace(row.slug) && (!actualContent || actualContent === '')) {
                        if (row.last_revision_id) {
                            const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(row.last_revision_id).first<{ content: string, r2_key: string | null }>();
                            if (lastRev) {
                                actualContent = await getRevisionContent(c.env.MEDIA, lastRev, origin);
                            }
                        }
                    }
                    return {
                        title: row.title,
                        section: findSectionForSnippet(actualContent, row.snippet),
                    };
                }));
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] } };
            }
            if (toolName === 'get_toc' || toolName === 'read_document' || toolName === 'read_section') {
                const slug = normalizeSlug(args.title || '');
                if (!isMcpReadableSlug(slug)) {
                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'raw 데이터는 읽을 수 없습니다.' }], isError: true } };
                }
                const page = await db.prepare('SELECT slug, content, last_revision_id FROM pages WHERE slug = ? AND deleted_at IS NULL AND is_private = 0').bind(slug).first<{slug: string, content: string, last_revision_id: number | null}>();
                if (!page) return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: 문서를 찾을 수 없거나 비공개/삭제 상태입니다.' }], isError: true } };
                
                let actualContent = page.content;
                const origin = new URL(c.req.url).origin;
                if (isR2OnlyNamespace(page.slug) && (!actualContent || actualContent === '')) {
                    if (page.last_revision_id) {
                        const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(page.last_revision_id).first<{ content: string, r2_key: string | null }>();
                        if (lastRev) {
                            actualContent = await getRevisionContent(c.env.MEDIA, lastRev, origin);
                        }
                    }
                }

                if (toolName === 'get_toc') return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: extractTOC(actualContent) || '목차가 존재하지 않습니다.' }] } };
                if (toolName === 'read_document') return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: await renderForAI(actualContent, db, 0, slug) || '문서 내용이 존재하지 않습니다.' }] } };
                if (toolName === 'read_section') return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: await renderForAI(extractSection(actualContent, args.section_name || ''), db, 0, slug) || '해당 목차를 찾을 수 없습니다.' }] } };
            }
            if (toolName === 'get_tree') {
                const requestedSlug = normalizeSlug(args.title || '');
                const topSlug = requestedSlug.includes('/') ? requestedSlug.split('/')[0] : requestedSlug;

                const subdocs = await db.prepare('SELECT slug FROM pages WHERE deleted_at IS NULL AND is_private = 0 AND slug LIKE ? ORDER BY slug ASC LIMIT 200').bind(topSlug + '/%').all<{slug: string}>();

                if (subdocs.results.length === 0) {
                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '하위 문서가 없습니다.' }] } };
                }

                const tree: any = {};
                for (const doc of subdocs.results) {
                    const relative = doc.slug.substring(topSlug.length + 1);
                    const parts = relative.split('/');
                    let node = tree;
                    for (const part of parts) {
                        if (!node[part]) node[part] = { _children: {}, _doc: null };
                        node = node[part]._children;
                    }
                    let target = tree;
                    for (let i = 0; i < parts.length; i++) {
                        if (i === parts.length - 1) {
                            target[parts[i]]._doc = doc;
                        } else {
                            target = target[parts[i]]._children;
                        }
                    }
                }

                function renderTree(nodes: any, parentPrefix: string): string {
                    const entries = Object.keys(nodes).sort();
                    let text = '';
                    entries.forEach((key, idx) => {
                        const node = nodes[key];
                        const isLast = idx === entries.length - 1;
                        const hasChildren = Object.keys(node._children).length > 0;
                        const connector = isLast ? '└── ' : '├── ';
                        const childPrefix = parentPrefix + (isLast ? '    ' : '│   ');

                        text += `${parentPrefix}${connector}${key}\n`;

                        if (hasChildren) {
                            text += renderTree(node._children, childPrefix);
                        }
                    });
                    return text;
                }

                const treeText = `${topSlug}\n` + renderTree(tree, '');
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: treeText }] } };
            }
            if (toolName === 'search_category') {
                const results = await db.prepare('SELECT DISTINCT category FROM page_categories WHERE category LIKE ? ORDER BY category ASC LIMIT 15')
                    .bind(`%${args.query}%`).all<{category: string}>();
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(results.results.map(r => r.category), null, 2) }] } };
            }
            if (toolName === 'get_category_info') {
                const docs = await db.prepare('SELECT p.title FROM page_categories pc JOIN pages p ON pc.page_id = p.id WHERE pc.category = ? AND p.deleted_at IS NULL AND p.is_private = 0 ORDER BY p.title ASC LIMIT 50')
                    .bind(args.category).all<{title: string}>();

                const catSlug = normalizeSlug(`카테고리:${args.category}`);
                const catPage = await db.prepare('SELECT slug, content, last_revision_id FROM pages WHERE slug = ? AND deleted_at IS NULL AND is_private = 0').bind(catSlug).first<{slug: string, content: string, last_revision_id: number | null}>();

                let renderedCatContent = '카테고리 문서가 존재하지 않습니다.';
                if (catPage) {
                    let actualContent = catPage.content;
                    const origin = new URL(c.req.url).origin;
                    if (isR2OnlyNamespace(catPage.slug) && (!actualContent || actualContent === '')) {
                        if (catPage.last_revision_id) {
                            const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(catPage.last_revision_id).first<{ content: string, r2_key: string | null }>();
                            if (lastRev) {
                                actualContent = await getRevisionContent(c.env.MEDIA, lastRev, origin);
                            }
                        }
                    }
                    renderedCatContent = await renderForAI(actualContent, db, 0, catSlug) || '문서 내용이 존재하지 않습니다.';
                }

                const output = {
                    documents: docs.results.map(r => r.title),
                    categoryContent: renderedCatContent
                };
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] } };
            }
            if (toolName === 'get_document_categoty') {
                const slug = normalizeSlug(args.title || '');
                const cats = await db.prepare('SELECT pc.category FROM page_categories pc JOIN pages p ON pc.page_id = p.id WHERE p.slug = ? AND p.deleted_at IS NULL AND p.is_private = 0 ORDER BY pc.category ASC')
                    .bind(slug).all<{category: string}>();
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(cats.results.map(r => r.category), null, 2) }] } };
            }
            return { jsonrpc: '2.0', error: { code: -32601, message: `Tool not found: ${toolName}` }, id };
        } catch (e: any) {
            return { jsonrpc: '2.0', error: { code: -32000, message: e.message }, id };
        }
    }
    return { jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id };
}

// POST /api/mcp - HTTP 방식 JSON-RPC 엔드포인트
mcpRoutes.post('/', async (c) => {
    const body = await c.req.json();
    const response = await handleJsonRpc(c, body);
    return c.json(response);
});

export default mcpRoutes;
