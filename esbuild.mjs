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
  // pino-pretty 只在开发模式使用，生产模式不捆绑避免巨大的依赖树
  // sql.js 是 WASM SQLite（零原生依赖，替代 better-sqlite3）
  // @huggingface/transformers v4：含动态 import + WASM 文件 + ONNX 模型资源，esbuild bundle 后资源路径解析失败
  // onnxruntime-web：含 WASM 文件，需运行时加载
  external: ['vscode', 'pino-pretty', 'sql.js', 'better-sqlite3', '@huggingface/transformers', 'onnxruntime-web', 'onnxruntime-node'],
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
