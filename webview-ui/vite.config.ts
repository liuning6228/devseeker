import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

/**
 * Vite config for VSCode Webview UI.
 *
 * 关键约束：
 * - VSCode Webview 不支持 code splitting / dynamic import → 禁用 manualChunks
 * - 输出稳定文件名（main.js / main.css），便于 panel.ts 直接拼接 webview URI
 * - 产物直接输出到 ../out/webview/（与 extension bundle 并列，方便打包）
 * - 生产模式不生成 inline sourcemap（独立 .map 文件便于调试又不污染 CSP）
 */
export default defineConfig(({ mode }) => ({
  plugins: [tailwindcss(), react()],
  root: __dirname,
  base: './',
  resolve: {
    alias: {
      // W9.14: 复用 extension 侧 Markdown 解析器（纯 TS，无 DOM 依赖）
      '@core/markdown': resolve(__dirname, '../src/core/markdown'),
    },
  },
  server: { hmr: false, fs: { allow: [resolve(__dirname, '..')] } },
  build: {
    outDir: resolve(__dirname, '../out/webview'),
    emptyOutDir: true,
    sourcemap: mode === 'development',
    target: 'es2020',
    cssCodeSplit: false,
    reportCompressedSize: false,
    rollupOptions: {
      input: resolve(__dirname, 'src/main.tsx'),
      output: {
        entryFileNames: 'main.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: (asset) => {
          if (asset.name?.endsWith('.css')) return 'main.css';
          return 'assets/[name].[ext]';
        },
        inlineDynamicImports: true,
      },
    },
  },
  // VSCode webview runs in isolated context; no dev server needed for extension host
}));
