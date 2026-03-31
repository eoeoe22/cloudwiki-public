* **{mdi:github}** https://github.com/eoeoe22/cloudwiki-public

# CloudWiki

CloudWiki는 Cloudflare Workers 환경에서 동작하는 서버리스 위키 엔진입니다. Hono 프레임워크를 기반으로 하며, D1 (SQLite), R2 (스토리지), KV 등 Cloudflare의 다양한 생태계를 적극 활용하여 가볍고 빠르며 저렴한 운영이 가능합니다.

> https://wiki.vialinks.xyz

[+ 주요 문서 목록]

​[[Cloudwiki/Pricing]]
​[[Cloudwiki/기능/토론]]
​[[Cloudwiki/기능/틀]]
​[[Cloudwiki/설정]]
​[[Cloudwiki/설정/MCP서버]]
​[[Cloudwiki/설정/사이드바 푸터 커스터마이징]]
​[[Cloudwiki/설정/스크립트 삽입]]
​[[Cloudwiki/설정/아이콘 커스터마이징]]
​[[Cloudwiki/위키 문법 가이드]]
[[Cloudwiki/설정/크롤링]]

[-]


## 주요 기능

* 서버리스 아키텍처: Cloudflare Workers 위에서 동작하여 높은 가용성과 낮은 지연 시간을 보장합니다. 
* 사용자 인증 및 권한 관리: Google OAuth를 통한 로그인 기능과 일반 사용자, 토론 관리자, 관리자, 최고 관리자 등 세분화된 권한 설정을 지원합니다. 특정 문서를 관리자만 편집 가능으로 제한할수도 있습니다.
* Cloudflare Turnstile 을 통해 문서 편집을 보호합니다.
* 리비전 및 변경 이력: 위키 문서의 모든 편집 이력을 저장하여 이전 버전으로 되돌리거나, 두 리비전 간의 차이(Diff)를 비교할 수 있습니다. D1 데이터베이스의 효율성을 위해 리비전은 R2 스토리지에 분리해 저장합니다.
* 토론 기능: 문서마다 토론 스레드를 열어 의견을 교환할 수 있습니다.
* 강력한 확장 마크다운: 기본 마크다운 외에도 틀(Transclusion), 위키 내부 링크(`[[문서명]]`), 표 색상 지정, 펼치기/접기 등 위키 특화 확장 문법을 제공합니다.
* 실시간 프리뷰 에디터: 작성한 문서 내용이 실제 열람과 동일한 형태로 실시간 렌더링됩니다.
* 미디어 업로드: Cloudflare R2 버킷을 이용해 이미지 파일을 안정적으로 업로드하고 관리합니다.
* 문서 카테고리 관리, 역링크 및 하위 문서 모아보기를 지원합니다.
* 검색 기능: SQLite FTS5 확장 모듈을 활용한 문서 전문 검색(Full-Text Search)을 지원합니다.
* 관리자 도구: 카테고리 관리, 특정 문서 잠금/비공개 처리, 유저 권한 제어 등 다양한 관리자 기능을 포함합니다.
* 라이트/다크모드를 모두 지원하며, 사용자 기기의 테마에 따라 자동으로 적용됩니다.
* 토론의 새 댓글, 쪽지 등을 개인 알림으로 확인할 수 있습니다. 관리자는 사이트 전체에서 쪽지 기능의 허용 여부를 관리할수 있습니다.
* 이름 변경시 중복방지가 작동하고, 관리자는 이름 변경 기간 제한/전면 제한을 설정할수 있습니다.
* AI 에이전트가 위키의 내용을 원할하게 읽을수 있는 MCP 기능을 제공합니다. 관리자 페이지에서 기능을 활성화할수 있습니다.
* 회원가입 정책을 자유 가입 / 신청후 승인제 두가지로 설정할수 있습니다.


## 기술 스택

* Backend Framework: [Hono](https://hono.dev/)
* Platform: [Cloudflare Workers](https://workers.cloudflare.com/)
* Database: [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite 기반)
* Object Storage: [Cloudflare R2](https://developers.cloudflare.com/r2/) (미디어 업로드)
* Key-Value Storage: [Cloudflare KV](https://developers.cloudflare.com/kv/) (사이드바 설정 저장 및 동시편집 충돌 감지)
* Language: {mdi:language-typescript} TypeScript 
* Frontend UI: 
  * {mdi:language-html5} HTML5
  * {mdi:language-css3} CSS
  * {mdi:language-javascript} JavaScript
  * {mdi:bootstrap} Bootstrap 5
  * {mdi:vector-square} Matarial Design Icons
  * DOMpurify
  * Toast UI Editor 
  * Sweetalert 2

## 디렉토리 구조

```
├── migrations/         # D1 데이터베이스 스키마 및 마이그레이션 SQL
├── public/             # 정적 파일 (HTML, CSS, JS, 이미지, 컴포넌트 템플릿 등)
├── src/                # 백엔드 소스 코드
│   ├── middleware/     # Hono 미들웨어 (세션, 레이트 리밋, SSR 등)
│   ├── routes/         # API 라우트 핸들러 (auth, wiki, search, admin, media, discussion 등)
│   ├── utils/          # 유틸리티 함수 (slug 정규화, JSON 래퍼, 권한 검사 등)
│   ├── index.ts        # 앱 진입점 (미들웨어 및 라우팅 등록, SSR 렌더러 등)
│   └── types.ts        # 타입스크립트 타입 정의 (Env, DB Model 등)
├── package.json        # 프로젝트 의존성 및 npm 스크립트
├── tsconfig.json       # 타입스크립트 설정
└── wrangler.toml       # Cloudflare Workers 설정 파일 (바인딩, 환경 변수 등)
```



## 위키 문법 가이드

CloudWiki에서 문서 작성 시 사용할 수 있는 마크다운 및 위키 확장 문법은 [위키 문법 가이드](https://w.vialinks.xyz/w/Cloudwiki%2F위키%20문법%20가이드) 문서를 참고해주세요.




## 시작하는법

[[Cloudwiki/설정]] 문서를 참고해주세요.


# 운영 비용
방문자 수가 적다면 Cloudflare Workers 프리티어 환경에서 매우 안정적으로 운영이 가능합니다.
방문자가 급증하더라도 별도의 서버 증설작업 조치 없이 Cloudflare Workers Paid 요금제 전환만으로 대응이 가능합니다.


# Cloudwiki 엔진으로 서비스중인 위키

[[Cloudwiki]]
