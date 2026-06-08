// Astro 정적 빌드 산출물(.astro-dist)에서 셸 HTML 만 public/ 으로 복사한다.
// public/ 을 통째로 Astro outDir 로 쓰지 않는 이유: public/ 에는 Vite 산출물(dist),
// css, components 등이 공존하므로 Astro 가 덮어쓰면 안 된다. 따라서 스테이징(.astro-dist)
// 에서 빌드한 뒤 필요한 파일만 골라 복사한다.
import { copyFile, mkdir, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAGING = resolve(root, '.astro-dist');
const PUBLIC = resolve(root, 'public');

// 복사 대상(증분 도입 시 이 배열만 확장). Astro build.format:'file' 산출물 기준.
const PAGES = ['error.html', 'login.html', 'search.html', 'explore.html', 'revisions.html', 'user-profile.html', 'setup-profile.html', 'admin-media.html', 'admin-bulk-manage.html', 'discussions.html', 'tickets.html', 'mypage.html', 'index.html', 'edit.html', 'blog.html', 'admin.html', 'blog-edit.html'];

for (const page of PAGES) {
    const src = resolve(STAGING, page);
    const dest = resolve(PUBLIC, page);
    try {
        await access(src);
    } catch {
        console.error(`[copy-astro-pages] 누락: ${src} (astro build 가 먼저 실행됐는지 확인)`);
        process.exit(1);
    }
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    console.log(`[copy-astro-pages] ${page} → public/${page}`);
}
