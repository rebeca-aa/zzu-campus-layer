import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  publicDir: r('./public'),
  define: { __APP_VERSION__: JSON.stringify('0.2.85') },
  // 相对 base：产物里的资源引用是相对 HTML 的。
  // 这样 dist 既能放域名根路径（Cloudflare Pages / Netlify），也能放子路径（GitHub Pages 项目页）。
  // 注意：这条必须独占一行，曾被 PowerShell 覆盖把换行吃掉、注释把 base 吞掉，
  // 结果构建产物变成绝对路径 /assets/... → 子路径部署时 404 → 白屏。
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
