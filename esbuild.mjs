// esbuild 打包配置
// - VSCode 扩展入口打 CommonJS bundle 到 out/extension.js
// - 外部化 `vscode` 和所有原生依赖，避免 esbuild 试图打包它们
import { build, context } from 'esbuild';

const isWatch = process.argv.includes('--watch');
const isProd = process.env.NODE_ENV === 'production';

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: !isProd,
  minify: isProd,
  logLevel: 'info',
  // vscode 必须 external（由宿主提供）
  // pino-pretty 只在开发模式使用，生产模式不捆绑
  // @huggingface/transformers：含动态 import + WASM + ONNX .node 二进制，无法 bundle
  // onnxruntime-node/web：含原生 .node 二进制和 WASM
  external: ['vscode', 'pino-pretty', '@huggingface/transformers', 'onnxruntime-web', 'onnxruntime-node', 'sharp', '@img/*'],
};

const extensionConfig = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
};

const workerConfig = {
  ...common,
  entryPoints: ['src/core/index/embedding-worker.ts'],
  outfile: 'out/embedding-worker.js',
};

async function run() {
  if (isWatch) {
    const ctx = await context(extensionConfig);
    await ctx.watch();
    console.log('[esbuild] watching src/...');
  } else {
    await Promise.all([
      build(extensionConfig),
      build(workerConfig),
    ]);
    console.log('[esbuild] build complete');
  }
}

run().catch((err) => {
  console.error('[esbuild] build failed:', err);
  process.exit(1);
});
