// robots.txt 규칙을 여기서 직접 수정하세요.
// 사이트맵(Sitemap:) 항목은 index.ts에서 baseUrl을 기반으로 자동 삽입됩니다.
// wrangler.toml에서 ALLOW_CRAWL = "true" 를 "false'로 바꾸는 경우, 이 파일의 설정이 무시되며 모든 봇에 대해 크롤링 금지를 요청하고 사이트맵이 비활성화 됩니다.
// 악성 봇은 크롤링 금지 요청을 무시하니, 악성 봇은 Cloudflare 콘솔에서 제어하세요. ALLOW_CRAWL = "false" 설정은 검색엔진 노출 방지 용도입니다.
const robotsTxtBase = `User-agent: *
Allow: /

`;

export default robotsTxtBase;
