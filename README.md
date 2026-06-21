# Cloudwiki

Cloudflare 프리티어만으로 셀프호스팅할 수 있는 서버리스 위키 엔진입니다. 커뮤니티 위키부터 프라이빗 팀의 내부 지식 베이스까지, 작게 시작해 트래픽이 늘어도 서버 증설 없이 운영할 수 있습니다. 마크다운에 확장 문법을 더해 위키 기능을 구현하규, 문서를 컴포넌트 조립식 페이지처럼 구성하고, MCP 연동으로 AI의 외장 지식 저장소로도 활용합니다.

- 🌐 데모: <https://wiki.vialinks.xyz>

## 핵심 특징

- **프리티어 셀프호스팅** — Cloudflare Workers · D1 · R2 · KV 위에서 동작합니다. 방문자가 적으면 무료 한도로 충분하고, 늘어나도 Workers Paid 요금제 전환만으로 대응합니다.
- **컴포넌트 조립식 문서** — 마크다운과 호환되는 확장 문법으로 카드 · 그리드 · 탭 · 콜아웃 · 버튼 등을 조립해 문서 한 장을 페이지처럼 구성합니다.
- **MCP 외장 지식 저장소** — 모델 컨텍스트 프로토콜(MCP) 서버를 내장해, AI 에이전트가 위키를 검색 · 열람 · 편집하는 외장 지식 베이스로 활용할 수 있습니다.
- **커뮤니티 · 프라이빗 팀** — 문서 · 카테고리 단위 ACL, 회원가입 정책, 위키 공개 설정으로 공개 커뮤니티 위키와 비공개 팀 위키를 모두 운영할 수 있습니다.

## 기술 스택

| 영역 | 사용 기술 |
| --- | --- |
| 런타임 | Cloudflare Workers (서버리스) |
| 프레임워크 | [Hono](https://hono.dev/) |
| 데이터베이스 | [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite 기반) |
| 오브젝트 스토리지 | [Cloudflare R2](https://developers.cloudflare.com/r2/) (미디어 업로드) |
| Key-Value | [Cloudflare KV](https://developers.cloudflare.com/kv/) (사이드바 설정 · 동시편집 충돌 감지) |
| 보안 · API | [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) (캡차), Web Push API (`@block65/webcrypto-web-push`) |
| 언어 | TypeScript |
| 프런트엔드 | Bootstrap 5 & Bootstrap Icons, Material Design Icons, Astro, Marked.js, DOMPurify, CodeMirror 6, PrismJS, jsdiff, SweetAlert2, Chart.js |

## 위키 문법

마크다운을 기반으로 확장한 문법을 사용하며, 기존 마크다운 문서를 그대로 가져와 쓸 수 있습니다. 문서 작성에 사용할 수 있는 전체 문법은 [위키 문법 가이드](https://wiki.vialinks.xyz/w/Cloudwiki%2F%EC%9C%84%ED%82%A4%20%EB%AC%B8%EB%B2%95%20%EA%B0%80%EC%9D%B4%EB%93%9C) 문서를 참고하세요.

## 시작하기

설치 및 초기 구성은 [Cloudwiki/설정](https://wiki.vialinks.xyz/w/Cloudwiki%2F%EC%84%A4%EC%A0%95) 문서에서 안내합니다. 대략적인 흐름은 다음과 같습니다.

1. 공개 저장소 [`eoeoe22/cloudwiki-public`](https://github.com/eoeoe22/cloudwiki-public)를 클론해 본인 GitHub 프라이빗 저장소에 올립니다.
2. Cloudflare에서 D1 · R2 · KV를 생성하고 `wrangler example.toml`에 값을 채운 뒤, 파일명을 `wrangler.toml`로 변경합니다.
3. OAuth(Google / Discord) 제공자를 최소 하나 설정합니다.
4. Cloudflare Workers에 GitHub 저장소를 연결해 배포하고, 도메인을 연결합니다.
5. D1에 `migrations/schema.sql`을 실행해 스키마를 적용합니다.

## 운영 비용

방문자 수가 적다면 Cloudflare Workers 프리티어 환경에서 매우 안정적으로 운영할 수 있습니다. 방문자가 급증하더라도 별도의 서버 증설 작업 없이 Cloudflare Workers Paid 요금제 전환만으로 대응할 수 있습니다.

## 라이선스

MIT 라이선스로 자유롭게 사용할 수 있습니다. 사용하실 때 `eoe@vialinks.xyz`로 한마디 보내주시면 감사하겠습니다.
