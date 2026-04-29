import { Hono, Context } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from '../types';
import { renderForAI, extractTOC, extractSection, findSectionsForQuery, expandTemplates } from '../utils/aiParser';
import { normalizeSlug, isR2OnlyNamespace, isMcpReadableSlug } from '../utils/slug';
import { getRevisionContent } from '../utils/r2';

const mcpRoutes = new Hono<Env>();

// 바이트 배열을 base64로 직접 인코딩한다. btoa(String.fromCharCode(...))나
// TextDecoder('latin1') 경유 방식은 0x80-0x9F 구간에서 WHATWG 규격이 Windows-1252로
// 매핑하여 일부 바이트가 0xFF를 넘는 코드 포인트로 디코드되고, btoa가
// InvalidCharacterError를 던질 수 있다. 압축된 이미지 바이트에는 해당 구간이 흔히
// 등장하므로, 출력 ASCII 코드를 Uint8Array에 미리 채운 뒤 TextDecoder 한 번으로
// 문자열로 변환한다. 핫 루프에서 result += ... 같은 문자열 결합을 피해 5MB 입력에서도
// CPU 사용을 일정하게 유지한다.
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_CODES = (() => {
    const codes = new Uint8Array(64);
    for (let i = 0; i < 64; i++) codes[i] = BASE64_ALPHABET.charCodeAt(i);
    return codes;
})();
const BASE64_PAD = 0x3d; // '='

function bytesToBase64(bytes: Uint8Array): string {
    const len = bytes.length;
    const fullTriples = (len / 3) | 0;
    const remainder = len - fullTriples * 3;
    const outLen = fullTriples * 4 + (remainder ? 4 : 0);
    const out = new Uint8Array(outLen);

    let inIdx = 0;
    let outIdx = 0;
    for (let i = 0; i < fullTriples; i++) {
        const b0 = bytes[inIdx++];
        const b1 = bytes[inIdx++];
        const b2 = bytes[inIdx++];
        out[outIdx++] = BASE64_CODES[b0 >> 2];
        out[outIdx++] = BASE64_CODES[((b0 & 0x03) << 4) | (b1 >> 4)];
        out[outIdx++] = BASE64_CODES[((b1 & 0x0f) << 2) | (b2 >> 6)];
        out[outIdx++] = BASE64_CODES[b2 & 0x3f];
    }
    if (remainder === 1) {
        const b0 = bytes[inIdx];
        out[outIdx++] = BASE64_CODES[b0 >> 2];
        out[outIdx++] = BASE64_CODES[(b0 & 0x03) << 4];
        out[outIdx++] = BASE64_PAD;
        out[outIdx++] = BASE64_PAD;
    } else if (remainder === 2) {
        const b0 = bytes[inIdx];
        const b1 = bytes[inIdx + 1];
        out[outIdx++] = BASE64_CODES[b0 >> 2];
        out[outIdx++] = BASE64_CODES[((b0 & 0x03) << 4) | (b1 >> 4)];
        out[outIdx++] = BASE64_CODES[(b1 & 0x0f) << 2];
        out[outIdx++] = BASE64_PAD;
    }

    // 출력 바이트는 모두 base64 알파벳/'=' 으로 ASCII 범위(0x2B, 0x2F, 0x30-0x39,
    // 0x3D, 0x41-0x5A, 0x61-0x7A) 안에만 들어가므로 UTF-8 디코더로 안전하게
    // 한 번에 문자열화할 수 있다.
    return new TextDecoder().decode(out);
}

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
                        description: `이 도구는 ${c.env.WIKI_NAME} 의 문서를 탐색할 수 있는 MCP 도구입니다. 이 위키의 문법은 마크다운 기반으로, 기본적으로는 문법 가이드 문서를 읽지 않아도 내용 파악이 가능합니다. 문서를 읽을 때 raw 설정을 사용하지 않으면 마크다운 기반으로 정리된 내용이 반환됩니다. raw 설정을 사용하려면 위키 문법 문서를 먼저 읽을 것을 권장합니다.${c.env.WIKI_SYNTAX ? ` 문법 가이드 문서: ${c.env.WIKI_SYNTAX}` : ''}`,
                        inputSchema: { type: 'object', properties: {}, required: [] }
                    },
                    {
                        name: 'search_title',
                        description: '위키 문서의 슬러그(=제목)를 검색합니다.',
                        inputSchema: { type: 'object', properties: { query: { type: 'string', description: '검색어' } }, required: ['query'] }
                    },
                    {
                        name: 'search_fts',
                        description: '위키 문서의 본문을 전문 검색(FTS) 합니다. 검색 결과에는 문서 슬러그와, 검색어가 등장하는 모든 목차의 목록이 포함됩니다. 한 문서에서 여러 섹션에 걸쳐 등장하면 모든 섹션이 반환됩니다.',
                        inputSchema: { type: 'object', properties: { query: { type: 'string', description: '검색어' } }, required: ['query'] }
                    },
                    {
                        name: 'get_toc',
                        description: '위키 문서의 목차(section)만 불러옵니다. 목차는 계층적 번호(예: "1.", "1.1", "1.1.1")가 붙은 형식으로 반환됩니다. 긴 문서를 전부 읽기보다 get_toc 도구로 목차를 추출한 뒤 read_section 도구에 번호를 지정해 부분적으로 읽는 것을 권장합니다.',
                        inputSchema: { type: 'object', properties: { title: { type: 'string', description: '문서 슬러그(=제목)' } }, required: ['title'] }
                    },
                    {
                        name: 'read_document',
                        description: '위키 문서의 전체 본문을 읽어옵니다. raw=true로 설정 시 위키 꾸미기 문법 변환을 건너뛰고 원본 그대로 반환합니다.',
                        inputSchema: { type: 'object', properties: { title: { type: 'string', description: '문서 슬러그(=제목)' }, raw: { type: 'boolean' } }, required: ['title'] }
                    },
                    {
                        name: 'read_section',
                        description: '위키 문서에서 특정 목차의 내용만 읽어옵니다. 목차는 get_toc 가 반환하는 계층적 번호(예: "1", "1.1", "1.1.1")로 지정합니다. raw=true로 설정 시 위키 꾸미기 문법 변환을 건너뛰고 반환합니다. 단, get_toc 의 번호 체계와 맞추기 위해 틀 트랜스클루전({{...}})은 항상 확장된 상태로 반환됩니다.',
                        inputSchema: { type: 'object', properties: { title: { type: 'string', description: '문서 슬러그(=제목)' }, section_number: { type: 'string', description: 'get_toc가 반환한 목차 번호 (예: "1", "1.1", "1.1.1")' }, raw: { type: 'boolean' } }, required: ['title', 'section_number'] }
                    },
                    {
                        name: 'get_tree',
                        description: '입력한 문서를 루트로 한 하위 문서 트리를 반환합니다. 예를 들어 "A/B/C" 를 입력하면 "A/B/C" 부터 시작하는 하위 트리만 반환됩니다.',
                        inputSchema: { type: 'object', properties: { title: { type: 'string', description: '트리의 루트가 될 문서 슬러그(=제목)' } }, required: ['title'] }
                    },
                    {
                        name: 'read_batch',
                        description: '여러 문서를 한 번에 최대 10개까지 읽어옵니다. 두 가지 모드를 지원합니다. (1) titles: 직접 지정한 문서 슬러그 배열을 한 번에 읽기. (2) parent_title: 지정한 문서의 하위 문서들을 일괄 읽기. parent_title 모드에서 하위 문서가 10개를 초과하면 상위 10개만 읽고, 응답에 읽은/읽지 않은 문서를 표시한 트리와 페이지네이션 정보가 포함됩니다. page 파라미터(1부터 시작)로 다음 페이지를 요청할 수 있습니다. raw=true 설정 시 위키 꾸미기 문법 변환을 건너뜁니다.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                titles: { type: 'array', items: { type: 'string' }, description: '직접 지정할 문서 슬러그 목록 (최대 10개). parent_title 과 함께 지정한 경우 titles 가 우선합니다.' },
                                parent_title: { type: 'string', description: '하위 문서를 일괄 읽을 부모 문서 슬러그' },
                                page: { type: 'number', description: 'parent_title 모드의 페이지 번호 (1부터 시작, 기본 1)' },
                                raw: { type: 'boolean' }
                            },
                            required: []
                        }
                    },
                    {
                        name: 'search_category',
                        description: '카테고리를 이름으로 검색합니다.',
                        inputSchema: { type: 'object', properties: { query: { type: 'string', description: '검색할 카테고리 이름 (부분 문자열)' } }, required: ['query'] }
                    },
                    {
                        name: 'get_category_info',
                        description: '해당 카테고리에 속한 문서 목록과 카테고리 설명을 반환합니다. raw=true로 설정 시 카테고리 설명의 위키 꾸미기 문법 변환을 건너뛰고 원본 그대로 반환합니다.',
                        inputSchema: { type: 'object', properties: { category: { type: 'string', description: '조회할 카테고리 이름' }, raw: { type: 'boolean' } }, required: ['category'] }
                    },
                    {
                        name: 'get_document_categoty',
                        description: '해당 문서가 속한 카테고리 목록을 반환합니다.',
                        inputSchema: { type: 'object', properties: { title: { type: 'string', description: '조회할 문서 슬러그(=제목)' } }, required: ['title'] }
                    },
                    {
                        name: 'get_backlinks',
                        description: '이 문서를 참조하는 역링크(위키링크 [[...]], 틀 트랜스클루전 {{...}}) 문서 목록을 반환합니다.',
                        inputSchema: { type: 'object', properties: { title: { type: 'string', description: '역링크를 조회할 문서 슬러그(=제목)' } }, required: ['title'] }
                    },
                    {
                        name: 'get_recent_changes',
                        description: '위키 전체에서 최근 수정된 문서 목록을 반환합니다.',
                        inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '최대 반환 개수 (기본 10, 최대 50)' } }, required: [] }
                    },
                    {
                        name: 'list_discussions',
                        description: '특정 문서에 달린 토론 스레드 목록을 반환합니다. 각 스레드의 id, 제목, 상태(open/closed), 댓글 수, 작성일이 포함됩니다.',
                        inputSchema: { type: 'object', properties: { title: { type: 'string', description: '문서 슬러그(=제목)' } }, required: ['title'] }
                    },
                    {
                        name: 'read_discussion',
                        description: '특정 토론 스레드의 제목, 상태, 모든 댓글을 읽어옵니다. discussion_id 는 list_discussions 가 반환한 id를 사용합니다.',
                        inputSchema: { type: 'object', properties: { discussion_id: { type: 'number', description: 'list_discussions가 반환한 토론 id' } }, required: ['discussion_id'] }
                    },
                    {
                        name: 'view_image',
                        description: '위키에 업로드된 이미지를 파일명으로 조회하여 이미지 데이터로 반환합니다. 문서 본문에 ![파일명](https://도메인/media/images/파일명) 형식으로 삽입된 그 파일명(확장자 포함)을 사용합니다.',
                        inputSchema: { type: 'object', properties: { filename: { type: 'string', description: '이미지 파일명 (확장자 포함, 예: "example.png")' } }, required: ['filename'] }
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
                const syntaxNote = c.env.WIKI_SYNTAX ? `\n\n문법 가이드 문서: ${c.env.WIKI_SYNTAX}` : '';
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `이 도구는 ${c.env.WIKI_NAME} 의 문서를 탐색할 수 있는 MCP 도구입니다.\n\n이 위키의 문법은 마크다운 기반으로, 기본적으로는 문법 가이드 문서를 읽지 않아도 내용 파악이 가능합니다. 문서를 읽을 때 raw 파라미터를 따로 활성화하지 않으면 마크다운 기반으로 정리된 내용이 반환됩니다. raw 파라미터를 사용하려면 위키 문법 문서를 먼저 읽을 것을 권장합니다.${syntaxNote}` }] } };
            }
            if (toolName === 'search_title') {
                const results = await db.prepare('SELECT slug, rows, characters FROM pages WHERE slug LIKE ? AND deleted_at IS NULL AND is_private = 0 LIMIT 15')
                    .bind(`%${args.query}%`).all();
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(results.results, null, 2) }] } };
            }
            if (toolName === 'search_fts') {
                const rawQuery = String(args.query || '').trim();
                if (!rawQuery) {
                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '[]' }] } };
                }

                // Trigram 토크나이저는 3 codepoint 미만 쿼리를 매치할 수 없다.
                // 웹 /search 와 동일하게 짧은 쿼리는 LIKE fallback 으로 본문/제목 부분 일치를 잡는다.
                // 또한 따옴표(")는 FTS5 phrase syntax 를 깨뜨리므로 이중 따옴표로 escape 한다.
                // String.length 는 UTF-16 code unit 기준이라 이모지 등 비-BMP 문자에서 codepoint
                // 수와 어긋나므로, trigram의 codepoint 단위 기준에 맞춰 [...]로 codepoint 수를 센다.
                let rows: { slug: string; content: string; last_revision_id: number | null; rows: number | null; characters: number | null }[] = [];
                if ([...rawQuery].length < 3) {
                    // LIKE 메타문자(%, _, \)를 escape 해 사용자가 입력한 문자열 그대로 부분 일치만 수행한다.
                    const likeEscaped = rawQuery.replace(/[\\%_]/g, '\\$&');
                    const likePattern = `%${likeEscaped}%`;
                    const fbSql = `SELECT p.slug, p.content, p.last_revision_id, p.rows, p.characters FROM pages p WHERE (p.slug LIKE ? ESCAPE '\\' OR p.content LIKE ? ESCAPE '\\') AND p.deleted_at IS NULL AND p.is_private = 0 ORDER BY (CASE WHEN p.slug LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END), p.updated_at DESC LIMIT 10`;
                    const fbRes = await db.prepare(fbSql).bind(likePattern, likePattern, likePattern).all<{ slug: string; content: string; last_revision_id: number | null; rows: number | null; characters: number | null }>();
                    rows = fbRes.results;
                } else {
                    const safeMatchQuery = '"' + rawQuery.replace(/"/g, '""') + '"';
                    const ftsSql = `SELECT p.slug, p.content, p.last_revision_id, p.rows, p.characters FROM pages_fts JOIN pages p ON pages_fts.rowid = p.id WHERE pages_fts MATCH ? AND p.deleted_at IS NULL AND p.is_private = 0 LIMIT 10`;
                    const ftsRes = await db.prepare(ftsSql).bind(safeMatchQuery).all<{ slug: string; content: string; last_revision_id: number | null; rows: number | null; characters: number | null }>();
                    rows = ftsRes.results;
                }

                const origin = new URL(c.req.url).origin;
                const enabledExtMcp1 = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
                const output = await Promise.all(rows.map(async (row) => {
                    let actualContent = row.content;
                    if (isR2OnlyNamespace(row.slug, enabledExtMcp1) && (!actualContent || actualContent === '')) {
                        if (row.last_revision_id) {
                            const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(row.last_revision_id).first<{ content: string, r2_key: string | null }>();
                            if (lastRev) {
                                actualContent = await getRevisionContent(c.env.MEDIA, lastRev, origin);
                            }
                        }
                    }
                    // 키워드가 한 문서에서 여러 섹션에 걸쳐 등장할 수 있으므로,
                    // 단일 FTS snippet 위치가 아니라 본문 전체를 훑어 모든 섹션을 모은다.
                    return {
                        title: row.slug,
                        rows: row.rows,
                        characters: row.characters,
                        sections: findSectionsForQuery(actualContent, rawQuery),
                    };
                }));
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] } };
            }
            if (toolName === 'get_toc' || toolName === 'read_document' || toolName === 'read_section') {
                const slug = normalizeSlug(args.title || '');
                if (!isMcpReadableSlug(slug)) {
                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'raw 데이터는 읽을 수 없습니다.' }], isError: true } };
                }
                const page = await db.prepare('SELECT slug, content, last_revision_id FROM pages WHERE slug = ? AND deleted_at IS NULL AND is_private = 0').bind(slug).first<{ slug: string, content: string, last_revision_id: number | null }>();
                if (!page) return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: 문서를 찾을 수 없거나 비공개/삭제 상태입니다.' }], isError: true } };

                let actualContent = page.content;
                const origin = new URL(c.req.url).origin;
                const enabledExtMcp2 = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
                if (isR2OnlyNamespace(page.slug, enabledExtMcp2) && (!actualContent || actualContent === '')) {
                    if (page.last_revision_id) {
                        const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(page.last_revision_id).first<{ content: string, r2_key: string | null }>();
                        if (lastRev) {
                            actualContent = await getRevisionContent(c.env.MEDIA, lastRev, origin);
                        }
                    }
                }

                if (toolName === 'get_toc') {
                    const expanded = await expandTemplates(actualContent, db, 0, slug);
                    // 헤딩 텍스트에 섞인 {mdi:icon} 같은 {...} 위키 문법 마커는 목차에서 가독성을
                    // 떨어뜨리므로 MCP 응답 단계에서만 제거한다. extractTOC 자체는 다른 호출자에도
                    // 사용되므로 aiParser.ts 는 건드리지 않는다.
                    const tocText = (extractTOC(expanded) || '')
                        .split('\n')
                        .map(line => line.replace(/\{[^}]*\}/g, '').replace(/[ \t]+/g, ' ').trimEnd())
                        .join('\n');
                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: tocText || '목차가 존재하지 않습니다.' }] } };
                }
                if (toolName === 'read_document') {
                    const text = args.raw === true ? actualContent : await renderForAI(actualContent, db, 0, slug);
                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: text || '문서 내용이 존재하지 않습니다.' }] } };
                }
                if (toolName === 'read_section') {
                    // get_toc 가 확장된 컨텐츠 기준으로 번호를 매기므로, read_section 도
                    // 동일하게 확장 후 번호를 찾아야 일관된 결과가 나온다. 틀이 원문의
                    // 실제 섹션 앞쪽에 헤딩을 주입하는 경우, 같은 번호가 원문·확장본에서
                    // 서로 다른 헤딩을 가리키므로 "원문에서 먼저 찾기" 같은 폴백은 위험하다.
                    // raw 플래그는 추출 이후 위키 문법 stripping 여부에만 영향을 준다.
                    const expanded = await expandTemplates(actualContent, db, 0, slug);
                    const sectionContent = extractSection(expanded, args.section_number || '');
                    const text = args.raw === true ? sectionContent : await renderForAI(sectionContent, db, 0, slug);
                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: text || '해당 목차를 찾을 수 없습니다.' }] } };
                }
            }
            if (toolName === 'get_tree') {
                const rootSlug = normalizeSlug(args.title || '');
                if (!rootSlug) {
                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: title이 필요합니다.' }], isError: true } };
                }
                // D1 의 LIKE 패턴 50바이트 한도를 피하기 위해 prefix 범위 비교를 사용한다.
                // '/' (0x2F) 의 다음 코드포인트가 '0' (0x30) 이므로 'rootSlug/' 로 시작하는 모든
                // 슬러그는 ['rootSlug/', 'rootSlug0') 범위에 정확히 들어간다.
                const prefixLower = rootSlug + '/';
                const prefixUpper = rootSlug + '0';

                const [subdocs, rootPage] = await Promise.all([
                    db.prepare('SELECT slug, rows, characters FROM pages WHERE deleted_at IS NULL AND is_private = 0 AND slug > ? AND slug < ? ORDER BY slug ASC LIMIT 200').bind(prefixLower, prefixUpper).all<{ slug: string; rows: number | null; characters: number | null }>(),
                    db.prepare('SELECT slug, rows, characters FROM pages WHERE slug = ? AND deleted_at IS NULL AND is_private = 0').bind(rootSlug).first<{ slug: string; rows: number | null; characters: number | null }>()
                ]);

                const formatStats = (r: number | null, ch: number | null) => ` (${r ?? 0}줄, ${ch ?? 0}자)`;

                if (subdocs.results.length === 0) {
                    const rootMarker = rootPage ? formatStats(rootPage.rows, rootPage.characters) : ' (문서 없음)';
                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `${rootSlug}${rootMarker}\n하위 문서가 없습니다.` }] } };
                }

                const tree: any = {};
                for (const doc of subdocs.results) {
                    const relative = doc.slug.substring(rootSlug.length + 1);
                    const parts = relative.split('/');
                    let node = tree;
                    for (let i = 0; i < parts.length; i++) {
                        const part = parts[i];
                        if (!node[part]) node[part] = { _children: {}, _exists: false, _rows: null, _characters: null };
                        if (i === parts.length - 1) {
                            node[part]._exists = true;
                            node[part]._rows = doc.rows;
                            node[part]._characters = doc.characters;
                        }
                        node = node[part]._children;
                    }
                }

                // 트리 경로상 필요하지만 실제 문서가 없는 노드도 검출해 표시한다.
                const missingDocs: string[] = [];
                if (!rootPage) missingDocs.push(rootSlug);

                function renderTree(nodes: any, parentPrefix: string, slugPrefix: string): string {
                    const entries = Object.keys(nodes).sort();
                    let text = '';
                    entries.forEach((key, idx) => {
                        const node = nodes[key];
                        const isLast = idx === entries.length - 1;
                        const hasChildren = Object.keys(node._children).length > 0;
                        const connector = isLast ? '└── ' : '├── ';
                        const childPrefix = parentPrefix + (isLast ? '    ' : '│   ');
                        const fullSlug = `${slugPrefix}/${key}`;
                        const marker = node._exists ? formatStats(node._rows, node._characters) : ' (문서 없음)';
                        if (!node._exists) missingDocs.push(fullSlug);

                        text += `${parentPrefix}${connector}${key}${marker}\n`;

                        if (hasChildren) {
                            text += renderTree(node._children, childPrefix, fullSlug);
                        }
                    });
                    return text;
                }

                const rootMarker = rootPage ? formatStats(rootPage.rows, rootPage.characters) : ' (문서 없음)';
                const treeText = `${rootSlug}${rootMarker}\n` + renderTree(tree, '', rootSlug);
                const missingSection = missingDocs.length > 0
                    ? `\n문서가 없는 항목 (${missingDocs.length}):\n${missingDocs.map(s => `- ${s}`).join('\n')}\n`
                    : '';
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: treeText + missingSection }] } };
            }
            if (toolName === 'read_batch') {
                const BATCH_LIMIT = 10;
                const TREE_DISPLAY_CAP = 500;
                const raw = args.raw === true;
                const origin = new URL(c.req.url).origin;
                const enabledExt = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);

                let mode: 'titles' | 'parent';
                let targetSlugs: string[] = [];
                let allCandidateSlugs: string[] = [];
                let parentSlug = '';
                let pageNum = 1;
                let totalCount = 0;
                const statsMap = new Map<string, { rows: number | null; characters: number | null }>();
                const formatBatchStats = (r: number | null | undefined, ch: number | null | undefined) => ` (${r ?? 0}줄, ${ch ?? 0}자)`;

                if (Array.isArray(args.titles) && args.titles.length > 0) {
                    mode = 'titles';
                    const normalized = (args.titles as any[])
                        .map(t => normalizeSlug(String(t || '')))
                        .filter((s: string) => s.length > 0);
                    if (normalized.length === 0) {
                        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: titles 배열이 비어있습니다.' }], isError: true } };
                    }
                    if (normalized.length > BATCH_LIMIT) {
                        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: 한 번에 최대 ${BATCH_LIMIT}개까지만 읽을 수 있습니다.` }], isError: true } };
                    }
                    // 중복 제거하되 입력 순서 유지
                    const seen = new Set<string>();
                    targetSlugs = normalized.filter((s: string) => {
                        if (seen.has(s)) return false;
                        seen.add(s);
                        return true;
                    });
                    allCandidateSlugs = targetSlugs;
                    totalCount = targetSlugs.length;
                } else if (args.parent_title) {
                    mode = 'parent';
                    parentSlug = normalizeSlug(String(args.parent_title || ''));
                    if (!parentSlug) {
                        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: parent_title이 비어있습니다.' }], isError: true } };
                    }
                    pageNum = Math.max(1, Math.floor(Number(args.page) || 1));
                    const offset = (pageNum - 1) * BATCH_LIMIT;
                    // D1 의 LIKE 패턴은 50바이트 한도가 있어 긴 슬러그에서 쿼리가 실패할 수 있다.
                    // 대신 prefix 범위 비교(slug > 'parent/' AND slug < 'parent0')로 하위 문서를 찾는다.
                    // '/' (0x2F) 의 바로 다음 코드포인트가 '0' (0x30) 이므로 'parent/' 로 시작하는 모든
                    // 슬러그는 ['parent/', 'parent0') 범위에 정확히 들어간다. UTF-8 의 codepoint 순서가
                    // 바이트 사전순과 일치해 비-ASCII 슬러그에서도 안전하다.
                    const prefixLower = parentSlug + '/';
                    const prefixUpper = parentSlug + '0';

                    // total 은 트리 표시용 캡(500)과 무관하게 COUNT(*) 로 정확히 구해야 한다.
                    // 그렇지 않으면 500을 초과한 시점부터 has_next_page 가 거짓이 되어
                    // 클라이언트가 페이지네이션으로 나머지 문서에 접근할 수 없다.
                    const totalRow = await db.prepare('SELECT COUNT(*) AS cnt FROM pages WHERE deleted_at IS NULL AND is_private = 0 AND slug > ? AND slug < ?').bind(prefixLower, prefixUpper).first<{ cnt: number }>();
                    totalCount = totalRow?.cnt ?? 0;
                    if (totalCount === 0) {
                        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `'${parentSlug}' 의 하위 문서가 없습니다.` }] } };
                    }

                    // 실제 읽을 페이지는 SQL LIMIT/OFFSET 으로 직접 잘라서 가져온다.
                    // 트리 표시용 후보(allCandidateSlugs)와 별개로 처리해야 어떤 페이지 번호든 안정적으로 도달 가능하다.
                    const pageRows = await db.prepare('SELECT slug FROM pages WHERE deleted_at IS NULL AND is_private = 0 AND slug > ? AND slug < ? ORDER BY slug ASC LIMIT ? OFFSET ?').bind(prefixLower, prefixUpper, BATCH_LIMIT, offset).all<{ slug: string }>();
                    targetSlugs = pageRows.results.map(r => r.slug);
                    if (targetSlugs.length === 0) {
                        const totalPages = Math.ceil(totalCount / BATCH_LIMIT);
                        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: page ${pageNum} 에 해당하는 문서가 없습니다. (총 ${totalCount}개, ${totalPages}페이지)` }], isError: true } };
                    }

                    // 트리 표시는 응답 크기 보호를 위해 500개로 제한한다.
                    // 500을 초과해도 페이지네이션은 total/COUNT(*) 기준으로 동작하므로 도달 가능성을 잃지 않는다.
                    const treeRows = await db.prepare('SELECT slug, rows, characters FROM pages WHERE deleted_at IS NULL AND is_private = 0 AND slug > ? AND slug < ? ORDER BY slug ASC LIMIT ?').bind(prefixLower, prefixUpper, TREE_DISPLAY_CAP).all<{ slug: string; rows: number | null; characters: number | null }>();
                    allCandidateSlugs = treeRows.results.map(r => r.slug);
                    for (const r of treeRows.results) {
                        statsMap.set(r.slug, { rows: r.rows, characters: r.characters });
                    }
                    // 현재 페이지 슬러그가 트리 캡(500) 이후에 위치한 경우에도 [읽음] 표시가 보이도록 합쳐둔다.
                    if (offset + targetSlugs.length > allCandidateSlugs.length) {
                        const merged = new Set(allCandidateSlugs);
                        for (const s of targetSlugs) merged.add(s);
                        allCandidateSlugs = Array.from(merged).sort();
                    }
                } else {
                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: titles 또는 parent_title 중 하나를 지정해야 합니다.' }], isError: true } };
                }

                // 각 문서를 병렬로 읽는다. 핫패스에서 D1 쿼리 latency가 누적되지 않도록 Promise.all 사용.
                const documents = await Promise.all(targetSlugs.map(async (slug) => {
                    if (!isMcpReadableSlug(slug)) {
                        return { title: slug, error: 'raw 데이터는 읽을 수 없습니다.' };
                    }
                    const pageRow = await db.prepare('SELECT slug, content, last_revision_id, rows, characters FROM pages WHERE slug = ? AND deleted_at IS NULL AND is_private = 0').bind(slug).first<{ slug: string, content: string, last_revision_id: number | null, rows: number | null, characters: number | null }>();
                    if (!pageRow) {
                        return { title: slug, error: '문서를 찾을 수 없거나 비공개/삭제 상태입니다.' };
                    }
                    statsMap.set(pageRow.slug, { rows: pageRow.rows, characters: pageRow.characters });
                    let actualContent = pageRow.content;
                    if (isR2OnlyNamespace(pageRow.slug, enabledExt) && (!actualContent || actualContent === '')) {
                        if (pageRow.last_revision_id) {
                            const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(pageRow.last_revision_id).first<{ content: string, r2_key: string | null }>();
                            if (lastRev) {
                                actualContent = await getRevisionContent(c.env.MEDIA, lastRev, origin);
                            }
                        }
                    }
                    const text = raw ? actualContent : await renderForAI(actualContent, db, 0, slug);
                    return { title: slug, rows: pageRow.rows, characters: pageRow.characters, content: text || '문서 내용이 존재하지 않습니다.' };
                }));

                // 읽은 문서/읽지 않은 문서를 트리 또는 목록 형태로 표시
                const readSet = new Set(targetSlugs);
                let treeText = '';
                if (mode === 'parent') {
                    const tree: any = {};
                    for (const slug of allCandidateSlugs) {
                        const relative = slug.substring(parentSlug.length + 1);
                        const parts = relative.split('/');
                        let node = tree;
                        for (let i = 0; i < parts.length; i++) {
                            const part = parts[i];
                            if (!node[part]) node[part] = { _children: {}, _slug: '' };
                            if (i === parts.length - 1) node[part]._slug = slug;
                            node = node[part]._children;
                        }
                    }
                    function renderBatchTree(nodes: any, parentPrefix: string): string {
                        const entries = Object.keys(nodes).sort();
                        let text = '';
                        entries.forEach((key, idx) => {
                            const node = nodes[key];
                            const isLast = idx === entries.length - 1;
                            const hasChildren = Object.keys(node._children).length > 0;
                            const connector = isLast ? '└── ' : '├── ';
                            const childPrefix = parentPrefix + (isLast ? '    ' : '│   ');
                            let marker = '';
                            if (node._slug) {
                                const stats = statsMap.get(node._slug);
                                const statsText = stats ? formatBatchStats(stats.rows, stats.characters) : '';
                                marker = (readSet.has(node._slug) ? ' [읽음]' : ' [읽지 않음]') + statsText;
                            }
                            text += `${parentPrefix}${connector}${key}${marker}\n`;
                            if (hasChildren) text += renderBatchTree(node._children, childPrefix);
                        });
                        return text;
                    }
                    treeText = `${parentSlug}\n` + renderBatchTree(tree, '');
                } else {
                    treeText = allCandidateSlugs
                        .map(s => {
                            const stats = statsMap.get(s);
                            const statsText = stats ? formatBatchStats(stats.rows, stats.characters) : '';
                            return `- ${s} ${readSet.has(s) ? '[읽음]' : '[읽지 않음]'}${statsText}`;
                        })
                        .join('\n');
                }

                const output: any = {
                    mode,
                    documents,
                    tree: treeText,
                };
                if (mode === 'parent') {
                    const totalPages = Math.ceil(totalCount / BATCH_LIMIT);
                    output.parent = parentSlug;
                    output.page = pageNum;
                    output.page_size = BATCH_LIMIT;
                    output.total = totalCount;
                    output.total_pages = totalPages;
                    output.has_next_page = pageNum < totalPages;
                    if (output.has_next_page) {
                        output.next_page = pageNum + 1;
                    }
                    if (totalCount > TREE_DISPLAY_CAP) {
                        output.tree_truncated = true;
                        output.tree_display_cap = TREE_DISPLAY_CAP;
                        output.notice = `하위 문서가 총 ${totalCount}개로 응답 트리 표시 한도(${TREE_DISPLAY_CAP}개)를 초과합니다. 트리에는 일부만 표시되지만, page 파라미터로 모든 문서를 페이지네이션으로 조회할 수 있습니다.`;
                    }
                }
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] } };
            }
            if (toolName === 'search_category') {
                const results = await db.prepare('SELECT DISTINCT category FROM page_categories WHERE category LIKE ? ORDER BY category ASC LIMIT 15')
                    .bind(`%${args.query}%`).all<{ category: string }>();
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(results.results.map(r => r.category), null, 2) }] } };
            }
            if (toolName === 'get_category_info') {
                const docs = await db.prepare('SELECT p.slug, p.rows, p.characters FROM page_categories pc JOIN pages p ON pc.page_id = p.id WHERE pc.category = ? AND p.deleted_at IS NULL AND p.is_private = 0 ORDER BY p.slug ASC LIMIT 50')
                    .bind(args.category).all<{ slug: string; rows: number | null; characters: number | null }>();

                const catSlug = normalizeSlug(`카테고리:${args.category}`);
                const catPage = await db.prepare('SELECT slug, content, last_revision_id FROM pages WHERE slug = ? AND deleted_at IS NULL AND is_private = 0').bind(catSlug).first<{ slug: string, content: string, last_revision_id: number | null }>();

                let renderedCatContent = '카테고리 문서가 존재하지 않습니다.';
                if (catPage) {
                    let actualContent = catPage.content;
                    const origin = new URL(c.req.url).origin;
                    const enabledExtMcp3 = (c.env.ENABLED_EXTENSIONS || '').split(',').map((s: string) => s.trim()).filter(Boolean);
                    if (isR2OnlyNamespace(catPage.slug, enabledExtMcp3) && (!actualContent || actualContent === '')) {
                        if (catPage.last_revision_id) {
                            const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(catPage.last_revision_id).first<{ content: string, r2_key: string | null }>();
                            if (lastRev) {
                                actualContent = await getRevisionContent(c.env.MEDIA, lastRev, origin);
                            }
                        }
                    }
                    const categoryText = args.raw === true
                        ? actualContent
                        : await renderForAI(actualContent, db, 0, catSlug);
                    renderedCatContent = categoryText || '문서 내용이 존재하지 않습니다.';
                }

                const output = {
                    documents: docs.results.map(r => ({ slug: r.slug, rows: r.rows, characters: r.characters })),
                    categoryContent: renderedCatContent
                };
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] } };
            }
            if (toolName === 'get_document_categoty') {
                const slug = normalizeSlug(args.title || '');
                const cats = await db.prepare('SELECT pc.category FROM page_categories pc JOIN pages p ON pc.page_id = p.id WHERE p.slug = ? AND p.deleted_at IS NULL AND p.is_private = 0 ORDER BY pc.category ASC')
                    .bind(slug).all<{ category: string }>();
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(cats.results.map(r => r.category), null, 2) }] } };
            }
            if (toolName === 'get_backlinks') {
                const slug = normalizeSlug(args.title || '');
                const targetSlugs: string[] = [slug];
                // 틀 접두사인 경우 접두사 없는 이름도 함께 매칭 (웹 API와 동일)
                const templatePrefixes = ['틀:', 'template:', '템플릿:'];
                for (const prefix of templatePrefixes) {
                    if (slug.startsWith(prefix)) {
                        targetSlugs.push(slug.substring(prefix.length));
                        break;
                    }
                }
                const placeholders = targetSlugs.map(() => '?').join(', ');
                const query = `
                    SELECT DISTINCT p.slug, p.rows, p.characters, p.updated_at
                    FROM page_links pl
                    JOIN pages p ON pl.source_page_id = p.id
                    WHERE p.slug != ?
                      AND pl.target_slug IN (${placeholders})
                      AND p.is_private = 0
                      AND p.deleted_at IS NULL
                    ORDER BY p.updated_at DESC LIMIT 100
                `;
                const backlinks = await db.prepare(query).bind(slug, ...targetSlugs).all<{ slug: string; rows: number | null; characters: number | null }>();
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(backlinks.results.map(r => ({ slug: r.slug, rows: r.rows, characters: r.characters })), null, 2) }] } };
            }
            if (toolName === 'get_recent_changes') {
                const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
                const { results } = await db.prepare(`
                    SELECT p.slug, p.updated_at, p.rows, p.characters, u.name as author_name
                    FROM pages p
                    LEFT JOIN users u ON p.author_id = u.id
                    WHERE p.deleted_at IS NULL AND p.is_private = 0
                    ORDER BY p.updated_at DESC LIMIT ?
                `).bind(limit).all();
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] } };
            }
            if (toolName === 'list_discussions') {
                const slug = normalizeSlug(args.title || '');
                const page = await db.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL AND is_private = 0').bind(slug).first<{ id: number }>();
                if (!page) return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: 문서를 찾을 수 없거나 비공개/삭제 상태입니다.' }], isError: true } };
                const { results } = await db.prepare(`
                    SELECT d.id, d.title, d.status, d.created_at, d.updated_at,
                           u.name as author_name,
                           (SELECT COUNT(*) FROM discussion_comments dc WHERE dc.discussion_id = d.id AND dc.deleted_at IS NULL) as comment_count
                    FROM discussions d
                    LEFT JOIN users u ON d.author_id = u.id
                    WHERE d.page_id = ? AND d.deleted_at IS NULL
                    ORDER BY d.updated_at DESC LIMIT 50
                `).bind(page.id).all();
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] } };
            }
            if (toolName === 'read_discussion') {
                const dId = Number(args.discussion_id);
                if (!Number.isFinite(dId)) {
                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: discussion_id가 유효하지 않습니다.' }], isError: true } };
                }
                const discussion = await db.prepare(`
                    SELECT d.id, d.title, d.status, d.created_at, d.updated_at,
                           u.name as author_name,
                           p.slug as page_title
                    FROM discussions d
                    LEFT JOIN users u ON d.author_id = u.id
                    JOIN pages p ON d.page_id = p.id
                    WHERE d.id = ? AND d.deleted_at IS NULL AND p.deleted_at IS NULL AND p.is_private = 0
                `).bind(dId).first();
                if (!discussion) return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: 토론을 찾을 수 없거나 비공개/삭제 상태입니다.' }], isError: true } };
                const { results: comments } = await db.prepare(`
                    SELECT dc.id, dc.content, dc.parent_id, dc.created_at, dc.deleted_at,
                           u.name as author_name
                    FROM discussion_comments dc
                    LEFT JOIN users u ON dc.author_id = u.id
                    WHERE dc.discussion_id = ?
                    ORDER BY dc.created_at ASC
                `).bind(dId).all<{ id: number; content: string; parent_id: number | null; created_at: number; deleted_at: number | null; author_name: string | null }>();
                const cleanedComments = comments.map(dc => ({
                    id: dc.id,
                    author_name: dc.deleted_at ? null : dc.author_name,
                    content: dc.deleted_at ? '(삭제된 댓글)' : dc.content,
                    parent_id: dc.parent_id,
                    created_at: dc.created_at
                }));
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ discussion, comments: cleanedComments }, null, 2) }] } };
            }
            if (toolName === 'view_image') {
                const filename = String(args.filename || '').trim();
                if (!filename) {
                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: filename이 필요합니다.' }], isError: true } };
                }

                let row = await db.prepare(
                    `SELECT r2_key, filename, mime_type, size FROM media WHERE filename = ? AND mime_type LIKE 'image/%' LIMIT 1`
                ).bind(filename).first<{ r2_key: string; filename: string; mime_type: string; size: number }>();

                if (!row) {
                    const escapedFilename = filename.replace(/[\\%_]/g, '\\$&');
                    const matches = await db.prepare(
                        `SELECT r2_key, filename, mime_type, size FROM media WHERE filename LIKE ? ESCAPE '\\' AND mime_type LIKE 'image/%' ORDER BY filename ASC LIMIT 10`
                    ).bind(`%${escapedFilename}%`).all<{ r2_key: string; filename: string; mime_type: string; size: number }>();

                    if (matches.results.length === 0) {
                        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: '${filename}' 와 일치하는 이미지를 찾을 수 없습니다.` }], isError: true } };
                    }
                    if (matches.results.length > 1) {
                        const list = matches.results.map(r => r.filename).join(', ');
                        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: 여러 이미지가 일치합니다. 정확한 파일명을 지정해 주세요: ${list}` }], isError: true } };
                    }
                    row = matches.results[0];
                }

                const MAX_IMAGE_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
                if (row.size > MAX_IMAGE_RESPONSE_SIZE) {
                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: 이미지 파일이 너무 큽니다 (${(row.size / 1024 / 1024).toFixed(1)}MB). 5MB 이하 이미지만 조회할 수 있습니다.` }], isError: true } };
                }

                const obj = await c.env.MEDIA.get(row.r2_key);
                if (!obj) {
                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: 이미지 파일이 스토리지에 존재하지 않습니다.' }], isError: true } };
                }

                const buffer = await obj.arrayBuffer();
                const base64 = bytesToBase64(new Uint8Array(buffer));
                const mimeType = obj.httpMetadata?.contentType || row.mime_type || 'image/png';

                return {
                    jsonrpc: '2.0', id,
                    result: {
                        content: [
                            { type: 'image', data: base64, mimeType }
                        ]
                    }
                };
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
