// robots.txt 규칙을 여기서 직접 수정하세요.
// 사이트맵(Sitemap:) 항목은 index.ts에서 baseUrl을 기반으로 자동 삽입됩니다.
const robotsTxtBase = `User-agent: Googlebot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: GPTBot
Allow: /

User-agent: Grok
Allow: /

User-agent: *
Disallow: /
`;

export default robotsTxtBase;
