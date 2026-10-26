import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  publicDir: r('./public'),
  define: { __APP_VERSION__: JSON.stringify('0.2.45') },
  // 相对 base：产物里的资源引用是相对 HTML 的，
  // 这样 dist 既可以放域名根（Cloudflare Pages / Netlify），也可以放子路径（GitHub Pages 项目页）。
  base: './',
  build: {
    outDir: r('./dist'),
    emptyOutDir: true,
    target: 'chrome114',
    sourcemap: false,
    rollupOptions: {
      input: {
        background: r('./src/background/index.ts'),
        sidepanel: r('./sidepanel/index.html'),
        pwa: r('./pwa/index.html'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
