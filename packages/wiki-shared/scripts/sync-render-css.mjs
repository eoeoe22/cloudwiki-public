// wiki-shared 의 본문 렌더 스타일(render.css)을 소비 앱의 public/render.css 로 생성한다.
//
// render.css 는 렌더 엔진 render.ts 와 한 쌍이므로 원본을 wiki-shared 에 두고
// (sync-wiki-shared CI 가 wiki-shared 를 cloudwiki ↔ cloudspace 간 동기화),
// 빌드 타임에 각 앱의 public/ 으로 복사한다. 따라서 cloudwiki·cloudspace 가
// 항상 동일한 render.css 를 공유하며, public/render.css 는 생성물이라 .gitignore 된다.
//
// 경로는 이 스크립트 위치(<repo>/packages/wiki-shared/scripts/)를 기준으로 계산하므로
// 두 repo 어디서 실행해도 해당 repo 의 public/ 에 기록된다.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../src/render/render.css');
const DEST = resolve(here, '../../../public/render.css');

const BANNER =
    '/* AUTO-GENERATED — 직접 수정하지 마세요.\n' +
    '   원본: packages/wiki-shared/src/render/render.css\n' +
    '   재생성: node packages/wiki-shared/scripts/sync-render-css.mjs (npm run build 에 포함) */\n';

const css = await readFile(SRC, 'utf8');
await mkdir(dirname(DEST), { recursive: true });
await writeFile(DEST, BANNER + css);
console.log('[sync-render-css] packages/wiki-shared/src/render/render.css → public/render.css');
