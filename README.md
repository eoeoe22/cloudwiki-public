⚠️ 위키 자체 문법이 포함되어 있습니다.
[CloudWiki 소개 페이지](https://wiki.vialinks.xyz/wiki/Cloud%20wiki)
에서 열람하시는것을 추천합니다.

# CloudWiki

CloudWiki는 Cloudflare Workers 환경에서 동작하는 서버리스 위키 엔진입니다. Hono 프레임워크를 기반으로 하며, D1 (SQLite), R2 (객체 스토리지), KV 등 Cloudflare의 다양한 생태계를 적극 활용하여 가볍고 빠르며 저렴한 운영이 가능합니다.

## 주요 기능

* 서버리스 아키텍처: Cloudflare Workers 위에서 동작하여 높은 가용성과 낮은 지연 시간을 보장합니다.

* 사용자 인증 및 권한 관리: Google OAuth를 통한 로그인 기능과 일반 사용자, 토론 관리자, 관리자, 최고 관리자 등 세분화된 권한(Role-based Access Control)을 지원합니다.
* 리비전 및 변경 이력: 위키 문서의 모든 편집 이력(Revision)을 저장하여 이전 버전으로 되돌리거나(Revert), 두 리비전 간의 차이(Diff)를 비교할 수 있습니다.
* 토론 (Discussion) 기능: 문서마다 토론 스레드를 열어 의견을 교환할 수 있습니다.
* 강력한 확장 마크다운: 기본 마크다운 외에도 틀(Transclusion), 위키 내부 링크(`[[문서명]]`), 표 색상 지정, 펼치기/접기 등 위키 특화 확장 문법을 제공합니다.
* 미디어 업로드: Cloudflare R2 버킷을 이용해 이미지 등의 미디어 파일을 안정적으로 업로드하고 관리합니다.
* 문서 리다이렉트 및 별칭: 문서 제목 변경시 자동으로 리다이렉트가 생성되어 기존 링크의 연결 끊김을 방지합니다. 여러 검색어가 한가지 문서로 향하도록 하기 위한 리디렉션 전용 문서를 생성할수도 있습니다.
* 검색 기능: SQLite FTS5 확장 모듈을 활용한 문서 전문 검색(Full-Text Search)을 지원합니다.
* 레이트 리밋: 사용자별 API 요청 제한을 통해 성능 최적화와 남용 방지를 구현했습니다.
* 관리자 도구: 카테고리 관리, 특정 문서 잠금/비공개 처리, 유저 권한 제어 등 다양한 관리자 기능을 포함합니다.
* 라이트/다크모드를 모두 지원하며, 사용자 기기의 테마에 따라 자동으로 적용됩니다.

## 기술 스택

* Backend Framework: [Hono](https://hono.dev/)
* Platform: [Cloudflare Workers](https://workers.cloudflare.com/)
* Database: [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite 기반)
* Object Storage: [Cloudflare R2](https://developers.cloudflare.com/r2/) (미디어 업로드)
* Key-Value Storage: [Cloudflare KV](https://developers.cloudflare.com/kv/) (사이드바 설정 저장)
* Language: {mdi:language-typescript} TypeScript 
* Frontend UI: 
  * {mdi:language-html5} HTML5
  * {mdi:language-css3} CSS
  * {mdi:language-javascript} JavaScript
  * {mdi:bootstrap} Bootstrap 5
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

## 환경 변수 설정

이 프로젝트를 배포하거나 개발하기 위해서는 `wrangler.toml`에 정의된 바인딩과 환경 변수를 올바르게 설정해야 합니다.

### wrangler.toml 기본 설정
* `d1_databases`: `DB` 데이터베이스 아이디 설정 (database_id 교체 필요)
* `r2_buckets`: `MEDIA` R2 바인딩 설정
* `kv_namespaces`: `KV` KV 바인딩 설정 (id 교체 필요)
* `assets`: `public` 폴더 정적 파일 서빙 바인딩
* `vars`:
  * `GOOGLE_CLIENT_ID`: Google OAuth 클라이언트 ID
  * `GOOGLE_REDIRECT_URI`: OAuth 콜백 URL
  * `WIKI_NAME`: 위키 서비스 이름 (예: Cloud wiki)
  * `SUPER_ADMIN_EMAILS`: 최고 관리자 이메일 목록 (콤마로 구분)
  * `MEDIA_PUBLIC_URL`: R2 퍼블릭 도메인

### Secrets (비밀 변수)
보안상 `wrangler.toml`에 직접 하드코딩하지 않고, 시크릿 키로 주입해야 하는 값들입니다.
* `GOOGLE_CLIENT_SECRET`: Google OAuth 클라이언트 시크릿 키

Cloudflare Workers 대시보드에서 직접 주입하세요.


## 위키 문법 가이드

CloudWiki에서 문서 작성 시 사용할 수 있는 마크다운 및 위키 확장 문법은 [위키 문법 가이드](https://wiki.vialinks.xyz/wiki/%EC%9C%84%ED%82%A4%20%EB%AC%B8%EB%B2%95%20%EA%B0%80%EC%9D%B4%EB%93%9C) 문서를 참고해 주시기 바랍니다.




## 시작하는법

1. 레포지토리 복제
```bash
git clone https://github.com/eoeoe22/cloudwiki-public.git
```
git을 사용해 이 레포지토리를 복제하고, 깃허브에 프라이빗 레포지토리를 생성한 뒤 파일 전체를 업로드합니다.

2. GCP Oauth 설정
https://console.cloud.google.com 에 접속해 프로젝트를 생성하고, Google 인증 플랫폼 / 클라이언트에 접속해 Oauth 클라이언트를 생성합니다.
**승인된 JavaScript 원본** 에는 `https://사용할 도메인/auth/google/callback`
**승인된 리디렉션 URI** 에는 `https://사용할 도메인/auth/google/callback` 을 입력한 뒤, 저장 후 클라이언트 ID와 시크릿 키를 복사해둡니다.

3. Cloudflare 및 wrangler.toml 설정
https://dash.cloudflare.com 에 접속해 스토리지 및 데이터베이스를 클릭하고, R2 Object Storage, Workers KV, D1 SQL Database를 각각 하나씩 생성하고, 각 스토리지들의 UID와 이름을 wrangler.toml에 붙여넣습니다.
wrangler.toml에 적힌 주석을 참고해 나머지 설정값들도 적절히 설정합니다.

5. Cloudflare Workers 배포
Cloudflare 대시보드에서 ompute > Workers 및 Pages > 응용 프로그램 생성을 클릭한 뒤, **Continue with GitHub**를 클릭해 깃허브 계정을 연동한 후, 만들어둔 프라이빗 레포지토리를 선택해 Workers에 배포합니다.

6. Workers Secrets 주입
생성된 Workers의 설정에 들어가 변수 및 암호 탭에서 **+추가** 버튼을 클릭한 뒤, 유형은 **비밀**, 이름은 **GOOGLE_CLIENT_SECRET**, 값은 조금 전 복사해둔 구글 Oauth 클라이언트 시크릿 키로 설정한 뒤 저장합니다.

7. Workers 설정에서 도메인 및 경로 탭의 **+추가** 버튼, **사용자 설정 도메인** 버튼을 클릭한 뒤, Cloudflare 계정에 연결된 도메인을 입력후 저장합니다.

8. D1 데이터베이스 설정
앞서 생성했던 D1 데이터베이스의 설정으로 이동해 Explore Data 버튼을 클릭하고, **Query** 탭의 입력창에 **migrations/schema.sql** 파일의 내용을 붙여넣은 뒤, 실행 버튼의 **드롭다운 메뉴** 를 클릭하고 **Run all statement** 로 모든 설정 명령어를 실행합니다.

> 참고 : 연결된 깃허브 레포지토리의 main 브랜치에 수정사항이 발생할때마다 자동으로 업데이트된 내용이 배포됩니다.
> Wrangler.toml의 내용도 언제든 수정이 가능합니다.


# 운영 비용
방문자 수가 적다면 Cloudflare Workers 프리티어 환경에서 매우 안정적으로 운영이 가능합니다.

