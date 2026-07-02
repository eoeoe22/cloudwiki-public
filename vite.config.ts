import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Vite 빌드 파이프라인.
 * - 입력: src/client/<entry>.ts
 * - 출력: public/dist/<entry>.js (예측 가능한 파일명, 해시 없음)
 *
 * Cloudflare Workers Assets가 public/ 디렉토리를 정적 자산으로 서빙하기 때문에,
 * 빌드 산출물은 /dist/<entry>.js 경로로 자동 노출된다.
 *
 * 새 클라이언트 모듈을 추가하려면:
 *   1) src/client/<entry>.ts 작성
 *   2) 아래 input 객체에 항목 추가
 *   3) 해당 HTML에서 <script type="module" src="/dist/<entry>.js"></script>
 *
 * 빌드 산출물(public/dist/)은 .gitignore 처리되어 있으며,
 * wrangler.toml의 [build] 섹션이 deploy 전에 자동으로 vite build를 실행한다.
 */
export default defineConfig({
    // Vite는 번들러로만 사용한다. publicDir 기능(public/을 outDir로 복사)은
    // outDir 자체가 public/dist이라 충돌하므로 비활성화한다.
    publicDir: false,
    build: {
        outDir: 'public/dist',
        emptyOutDir: true,
        target: 'es2022',
        minify: true,
        sourcemap: false,
        rollupOptions: {
            input: {
                '404': resolve(__dirname, 'src/client/404.ts'),
                'login': resolve(__dirname, 'src/client/pages/login.ts'),
                'qr-login-approve': resolve(__dirname, 'src/client/pages/qr-login-approve.ts'),
                'edit-summary': resolve(__dirname, 'src/client/edit/summary.ts'),
                'edit-utils': resolve(__dirname, 'src/client/edit/utils.ts'),
                'edit-image': resolve(__dirname, 'src/client/edit/image.ts'),
                'edit-conflict': resolve(__dirname, 'src/client/edit/conflict.ts'),
                'edit-autocomplete': resolve(__dirname, 'src/client/edit/autocomplete.ts'),
                'edit-modals': resolve(__dirname, 'src/client/edit/modals.ts'),
                'edit-table-toolbar': resolve(__dirname, 'src/client/edit/table-toolbar.ts'),
                'edit-main': resolve(__dirname, 'src/client/edit/main.ts'),
                'edit-bulk-category': resolve(__dirname, 'src/client/edit/bulk-category.ts'),
                'permissions-modal': resolve(__dirname, 'src/client/permissions/permissions-modal.ts'),
                'category-acl-modal': resolve(__dirname, 'src/client/permissions/category-acl-modal.ts'),
                'discussion-edit': resolve(__dirname, 'src/client/discussion-edit/editor.ts'),
                'render': resolve(__dirname, 'src/client/render.ts'),
                'common': resolve(__dirname, 'src/client/common-wiki.ts'),
                'common-core': resolve(__dirname, 'packages/wiki-shared/src/ui/common-core.ts'),
                'diff': resolve(__dirname, 'src/client/diff.ts'),
                'push': resolve(__dirname, 'src/client/push.ts'),
                'sw': resolve(__dirname, 'src/client/sw.ts'),
                'setup-profile': resolve(__dirname, 'src/client/pages/setup-profile.ts'),
                'setup-profile-form': resolve(__dirname, 'src/client/pages/setup-profile-form.ts'),
                'search': resolve(__dirname, 'src/client/pages/search.ts'),
                'explore': resolve(__dirname, 'src/client/pages/explore.ts'),
                'all': resolve(__dirname, 'src/client/pages/all.ts'),
                'user-profile': resolve(__dirname, 'src/client/pages/user-profile.ts'),
                'blog': resolve(__dirname, 'src/client/pages/blog.ts'),
                'revisions': resolve(__dirname, 'src/client/pages/revisions.ts'),
                'admin-media': resolve(__dirname, 'src/client/pages/admin-media.ts'),
                'admin-bulk-manage': resolve(__dirname, 'src/client/pages/admin-bulk-manage.ts'),
                'components-json-builder': resolve(__dirname, 'src/client/pages/components-json-builder.ts'),
                'index': resolve(__dirname, 'src/client/pages/index.ts'),
                'memo': resolve(__dirname, 'src/client/pages/memo.ts'),
                'admin': resolve(__dirname, 'src/client/pages/admin.ts'),
                'mypage': resolve(__dirname, 'src/client/pages/mypage.ts'),
                'tickets': resolve(__dirname, 'src/client/pages/tickets.ts'),
                'discussions': resolve(__dirname, 'src/client/pages/discussions.ts'),
                'edit-page': resolve(__dirname, 'src/client/edit/page.ts'),
                'icon-picker': resolve(__dirname, 'src/client/iconPicker.ts'),
                'admin-palettes': resolve(__dirname, 'src/client/admin/palettes.ts'),
            },
            // CodeMirror 6 / Lezer 패키지는 npm 으로 설치하지 않고 HTML 의
            // <script type="importmap"> 으로 esm.sh CDN 을 통해 직접 해석한다.
            // 번들에 포함시키지 않고 import 구문을 그대로 유지하기 위해 external 처리.
            external: [/^@codemirror\//, /^@lezer\//],
            output: {
                entryFileNames: '[name].js',
                chunkFileNames: 'chunks/[name]-[hash].js',
                assetFileNames: '[name][extname]',
                format: 'es',
            },
        },
    },
});
