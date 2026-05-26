#!/usr/bin/env node
/**
 * vsce-package.mjs —— 安全打包 VSIX
 *
 * 两个打包前调整：
 * 1. 移走 onnxruntime-web 的浏览器专用 WASM 变体（jsep/asyncify/jspi，~61MB）
 * 2. Patch transformers.node.mjs：将 `import * as ONNX_NODE from "onnxruntime-node"`
 *    保留（使用原生 onnxruntime-node 后端，支持 Node.js 环境）
 * 3. Patch @huggingface/transformers 的 package.json，确保 Node 入口仍指向 node 版本
 *    （node 版本有 node:fs/node:path，能正确读取本地模型文件）
 *
 * 打包后恢复所有修改。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, existsSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(__filename)); // scripts/ → project root
const STAGING = join(ROOT, 'tmp', 'vsce-staging');

const HF_PKG_PATH = join(ROOT, 'node_modules', '@huggingface', 'transformers', 'package.json');
const HF_NODE_MJS = join(ROOT, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs');
const HF_NODE_CJS = join(ROOT, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.cjs');

function getVersion() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return pkg.version;
}

// ─── WASM 文件 stash/unstash ───

const FILES_TO_STASH = [
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs',
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm',
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs',
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jspi.wasm',
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jspi.mjs',
];

function stashFiles() {
  if (existsSync(STAGING)) rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });
  for (const rel of FILES_TO_STASH) {
    const src = join(ROOT, rel);
    if (existsSync(src)) {
      renameSync(src, join(STAGING, rel.replace(/\//g, '__')));
      console.log(`  [stash] ${rel}`);
    }
  }
}

function restoreFiles() {
  for (const rel of FILES_TO_STASH) {
    const staged = join(STAGING, rel.replace(/\//g, '__'));
    const dest = join(ROOT, rel);
    if (existsSync(staged)) {
      renameSync(staged, dest);
      console.log(`  [restore] ${rel}`);
    }
  }
  if (existsSync(STAGING)) rmSync(STAGING, { recursive: true, force: true });
}

// ─── Patch transformers.node.mjs: 替换 onnxruntime-node import ───

let originalNodeMjs = '';
let originalNodeCjs = '';

function patchTransformersNodeEntry() {
  // Patch ESM entry (transformers.node.mjs)
  if (existsSync(HF_NODE_MJS)) {
    originalNodeMjs = readFileSync(HF_NODE_MJS, 'utf8');
    let patched = originalNodeMjs;
    // 保留 onnxruntime-node 原生 import（Node.js 环境下正常工作）
    // 仅移除 sharp（图片处理原生模块，@huggingface/transformers 可选依赖）
    patched = patched.replace(
      'import sharp from "sharp";',
      '// [patched] sharp removed: native image processing module not available cross-platform\nvar sharp = {};'
    );
    if (patched !== originalNodeMjs) {
      writeFileSync(HF_NODE_MJS, patched);
      console.log('  [patch] transformers.node.mjs: sharp → empty object');
    }
  }

  // Patch CJS entry (transformers.node.cjs)
  if (existsSync(HF_NODE_CJS)) {
    originalNodeCjs = readFileSync(HF_NODE_CJS, 'utf8');
    let patched = originalNodeCjs;
    patched = patched.replace(/require\(["']sharp["']\)/g, '({})');
    if (patched !== originalNodeCjs) {
      writeFileSync(HF_NODE_CJS, patched);
      console.log('  [patch] transformers.node.cjs: sharp → empty object');
    }
  }
}

function restoreTransformersNodeEntry() {
  if (originalNodeMjs && existsSync(HF_NODE_MJS)) {
    writeFileSync(HF_NODE_MJS, originalNodeMjs);
    console.log('  [restore] transformers.node.mjs');
  }
  if (originalNodeCjs && existsSync(HF_NODE_CJS)) {
    writeFileSync(HF_NODE_CJS, originalNodeCjs);
    console.log('  [restore] transformers.node.cjs');
  }
}

// ─── main ───

console.log('[vsce-package] Pre-pack adjustments...');

console.log('[vsce-package] Staging unnecessary WASM files...');
stashFiles();

console.log('[vsce-package] Patching @huggingface/transformers node entry...');
patchTransformersNodeEntry();

const vsixName = `dualmind-${getVersion()}.vsix`;
const vsixPath = join(ROOT, vsixName);
if (existsSync(vsixPath)) rmSync(vsixPath);

try {
  console.log('[vsce-package] Running vsce package...');
  spawnSync('npx', ['vsce', 'package'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
  });

  if (existsSync(vsixPath)) {
    const sizeMB = (statSync(vsixPath).size / (1024 * 1024)).toFixed(1);
    console.log(`[vsce-package] Generated: ${vsixName} (${sizeMB} MB)`);
  }
} finally {
  console.log('[vsce-package] Restoring pre-pack adjustments...');
  restoreTransformersNodeEntry();
  restoreFiles();
}

if (!existsSync(vsixPath)) {
  console.error('[vsce-package] FAILED — VSIX not generated');
  process.exit(1);
}

console.log('[vsce-package] Done!');
