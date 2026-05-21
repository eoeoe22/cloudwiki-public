
CloudWiki는 Cloudflare Workers 환경에서 동작하는 서버리스 위키 엔진입니다. Hono 프레임워크를 기반으로 하며, D1 (SQLite), R2 (스토리지), KV 등 Cloudflare의 다양한 생태계를 적극 활용하여 가볍고 빠르며 저렴한 운영이 가능합니다.

> https://wiki.vialinks.xyz

## 기술 스택

* Backend Framework: [Hono](https://hono.dev/)
* Platform: [Cloudflare Workers](https://workers.cloudflare.com/)
* Database: [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite 기반)
* Object Storage: [Cloudflare R2](https://developers.cloudflare.com/r2/) (미디어 업로드)
* Key-Value Storage: [Cloudflare KV](https://developers.cloudflare.com/kv/) (사이드바 설정 저장 및 동시편집 충돌 감지)
* Security & APIs: [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) (캡챠), Web Push API (`@block65/webcrypto-web-push`)
* Language: {mdi:language-typescript} TypeScript 
* Frontend UI (CDN을 통해 불러옴):
  * {mdi:language-html5} HTML5
  * {mdi:language-css3} CSS
  * {mdi:language-javascript} JavaScript
  * {mdi:bootstrap} Bootstrap 5 & Bootstrap Icons
  * {mdi:vector-square} Material Design Icons
  * Marked.js (마크다운 파싱)
  * DOMPurify (XSS 방어)
  * CodeMirror 6 (편집기)
  * PrismJS (코드 하이라이팅)
  * jsdiff (문서 리비전 비교)
  * SweetAlert2 (알림 모달)
  * Chart.js [* freq 확장 기능 전용]




## 위키 문법

마크다운을 기반으로 확장한 문법을 사용합니다.
CloudWiki에서 문서 작성 시 사용할 수 있는 마크다운 및 위키 확장 문법은 [위키 문법 가이드](https://wiki.vialinks.xyz/w/Cloudwiki%2F위키%20문법%20가이드) 문서를 참고해주세요.




## 시작하는법

[Cloudwiki/설정](https://wiki.vialinks.xyz/w/Cloudwiki%2F%EC%84%A4%EC%A0%95) 문서를 참고해주세요.

# 운영 비용
방문자 수가 적다면 Cloudflare Workers 프리티어 환경에서 매우 안정적으로 운영이 가능합니다.
방문자가 급증하더라도 별도의 서버 증설작업 조치 없이 Cloudflare Workers Paid 요금제 전환만으로 대응이 가능합니다.

