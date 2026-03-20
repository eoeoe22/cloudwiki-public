import { Hono, Context } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from '../types';
import { renderForAI, extractTOC, extractSection, findSectionForSnippet } from '../utils/aiParser';
import { normalizeSlug } from '../utils/slug';

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

    const db = c.env.DB;
    let settings;
    try {
        settings = await db.prepare('SELECT mcp_mode FROM settings WHERE id = 1').first<{ mcp_mode: string }>();
        if (!settings) {
            return c.json({ error: 'Critical: Settings row (id=1) not found in DB.' }, 500);
        }
    } catch (e: any) {
        // 테이블이나 컬럼이 없을 때 발생하는 에러를 명확히 알림
        return c.json({ 
            error: `Database error: ${e.message}. Please ensure you ran 'wrangler d1 migrations apply'.`,
            details: 'mcp_mode column might be missing.'
        }, 500);
    }
    
    if (settings.mcp_mode === 'disabled') {
        return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'MCP is disabled by administrator.' }, id: null }, 403);
    }

    await next();
});

// GET /api/mcp - 기본 정보
mcpRoutes.get('/', (c) => {
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
                    }
                ]
            }
        };
    }

    if (method === 'tools/call') {
        const toolName = params?.name;
        const args = params?.arguments || {};
        try {
            if (toolName === 'search_title') {
                const results = await db.prepare('SELECT title FROM pages WHERE title LIKE ? AND deleted_at IS NULL AND is_private = 0 LIMIT 15')
                    .bind(`%${args.query}%`).all();
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(results.results, null, 2) }] } };
            }
            if (toolName === 'search_fts') {
                const query = `SELECT p.title, p.content, snippet(pages_fts, -1, '<b>', '</b>', '...', 20) as snippet FROM pages_fts f JOIN pages p ON f.rowid = p.id WHERE pages_fts MATCH ? AND p.deleted_at IS NULL AND p.is_private = 0 LIMIT 10`;
                const results = await db.prepare(query).bind(`"${args.query}"*`).all<{ title: string; content: string; snippet: string }>();
                const output = results.results.map(({ title, content, snippet }) => ({
                    title,
                    section: findSectionForSnippet(content, snippet),
                }));
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] } };
            }
            if (toolName === 'get_toc' || toolName === 'read_document' || toolName === 'read_section') {
                const slug = normalizeSlug(args.title || '');
                const page = await db.prepare('SELECT content FROM pages WHERE slug = ? AND deleted_at IS NULL AND is_private = 0').bind(slug).first<{content: string}>();
                if (!page) return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: 문서를 찾을 수 없거나 비공개/삭제 상태입니다.' }], isError: true } };
                if (toolName === 'get_toc') return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: extractTOC(page.content) || '목차가 존재하지 않습니다.' }] } };
                if (toolName === 'read_document') return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: await renderForAI(page.content, db, 0) || '문서 내용이 존재하지 않습니다.' }] } };
                if (toolName === 'read_section') return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: await renderForAI(extractSection(page.content, args.section_name || ''), db, 0) || '해당 목차를 찾을 수 없습니다.' }] } };
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
