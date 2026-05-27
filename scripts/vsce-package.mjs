#!/usr/bin/env node
/**
 * vsce-package.mjs —— 安全打包 VSIX
 *
 * 打包前调整：
 * 1. 移走 onnxruntime-web 的浏览器专用 WASM 变体（jsep/asyncify/jspi）
 * 2. 移走 @huggingface/transformers 嵌套 onnxruntime-node 的非目标平台二进制
 * 3. Patch transformers.node.mjs：移除 sharp 引用
 *
 * 打包后恢复所有修改。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, existsSync, rmSync, statSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(__filename));
const STAGING = join(ROOT, 'tmp', 'vsce-staging');

const HF_PKG_PATH = join(ROOT, 'node_modules', '@huggingface', 'transformers', 'package.json');
const HF_NODE_MJS = join(ROOT, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs');
const HF_NODE_CJS = join(ROOT, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.cjs');

function getVersion() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return pkg.version;
}

// ─── 确定目标平台的 onnxruntime 子目录 ───

/** 把 vsce target 名映射到 onnxruntime-node/bin/napi-v6/ 下的目录名 */
function onnxruntimedirForTarget(target) {
  // vsce targets: linux-x64, win32-x64, darwin-x64, darwin-arm64, linux-arm64, etc.
  const map = {
    'linux-x64':   ['linux/x64'],
    'linux-arm64': ['linux/arm64'],
    'win32-x64':   ['win32/x64'],
    'win32-arm64': ['win32/arm64'],
    'darwin-x64':  ['darwin/x64'],
    'darwin-arm64': ['darwin/arm64'],
  };
  return map[target] || null;
}

/** 返回某平台上 onnxruntime-node 可以移除的平台目录列表 */
function platformDirsToRemove(target) {
  const keep = onnxruntimedirForTarget(target);
  if (!keep) return []; // fallback: keep all

  const allPlatforms = [
    'darwin/arm64', 'darwin/x64',
    'linux/arm64',  'linux/x64',
    'win32/arm64',  'win32/x64',
  ];
  return allPlatforms.filter(d => !keep.includes(d));
}

// ─── 文件 stash/unstash ───

function collectFilesToStash(target) {
  const files = [];

  // 1. onnxruntime-web 的浏览器变体（通用）
  files.push(
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs',
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm',
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs',
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jspi.wasm',
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jspi.mjs',
  );

  // 2. @huggingface/transformers 嵌套的 onnxruntime-node 非目标平台二进制
  const nestedOnnxBase = join(ROOT, 'node_modules', '@huggingface', 'transformers', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
  const dirsToRemove = platformDirsToRemove(target);
  for (const dir of dirsToRemove) {
    const platformDir = join(nestedOnnxBase, dir);
    if (existsSync(platformDir)) {
      for (const f of readdirSync(platformDir)) {
        files.push(`node_modules/@huggingface/transformers/node_modules/onnxruntime-node/bin/napi-v6/${dir}/${f}`);
      }
    }
  }

  return files;
}

function stashFiles(target) {
  if (existsSync(STAGING)) rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });

  const files = collectFilesToStash(target);
  for (const rel of files) {
    const src = join(ROOT, rel);
    if (existsSync(src)) {
      renameSync(src, join(STAGING, rel.replace(/\//g, '__')));
      console.log(`  [stash] ${rel}`);
    }
  }
}

function restoreFiles() {
  if (!existsSync(STAGING)) return;

  // 恢复所有已 stash 的文件（遍历 staging 目录）
  for (const entry of readdirSync(STAGING)) {
    const origRel = entry.replace(/__/g, '/');
    const dest = join(ROOT, origRel);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(join(STAGING, entry), dest);
    console.log(`  [restore] ${origRel}`);
  }
  rmSync(STAGING, { recursive: true, force: true });
}

// ─── Patch transformers.node.mjs: 移除 sharp ───

let originalNodeMjs = '';
let originalNodeCjs = '';

function patchTransformersNodeEntry() {
  if (existsSync(HF_NODE_MJS)) {
    originalNodeMjs = readFileSync(HF_NODE_MJS, 'utf8');
    let patched = originalNodeMjs;
    patched = patched.replace(
      'import sharp from "sharp";',
      '// [patched] sharp removed\nvar sharp = {};'
    );
    if (patched !== originalNodeMjs) {
      writeFileSync(HF_NODE_MJS, patched);
      console.log('  [patch] transformers.node.mjs: sharp → empty object');
    }
  }

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

const TARGETS = [
  { name: 'linux-x64',   arg: 'linux-x64'   },
  { name: 'win32-x64',   arg: 'win32-x64'   },
];

const version = getVersion();
const generated = [];

try {
  for (const target of TARGETS) {
    const vsixName = `devseeker-${version}-${target.name}.vsix`;
    const vsixPath = join(ROOT, vsixName);
    if (existsSync(vsixPath)) rmSync(vsixPath);

    console.log(`\n[vsce-package] Packaging for ${target.name}...`);

    // 对每个目标平台单独 stash（不同平台的二进制不同）
    console.log('[vsce-package] Staging platform-specific binaries...');
    stashFiles(target.arg);

    // Patch 只需做一次，对两个目标一样
    if (generated.length === 0) {
      console.log('[vsce-package] Patching @huggingface/transformers node entry...');
      patchTransformersNodeEntry();
    }

    const result = spawnSync('npx', ['vsce', 'package', '--target', target.arg, '-o', vsixPath], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: true,
    });

    if (result.status !== 0) {
      console.error(`[vsce-package] FAILED for ${target.name}`);
      process.exit(1);
    }

    if (existsSync(vsixPath)) {
      const sizeMB = (statSync(vsixPath).size / (1024 * 1024)).toFixed(1);
      console.log(`[vsce-package] Generated: ${vsixName} (${sizeMB} MB)`);
      generated.push(vsixName);
    } else {
      console.error(`[vsce-package] ${target.name}: expected ${vsixPath} not found`);
      process.exit(1);
    }

    // 打包完后 restore，再打包下一个目标
    console.log('[vsce-package] Restoring binaries...');
    restoreFiles();
  }
} catch (err) {
  console.error('[vsce-package] Unexpected error:', err);
  process.exit(1);
} finally {
  // 确保所有都恢复
  restoreTransformersNodeEntry();
  restoreFiles();
}

if (generated.length === 0) {
  console.error('[vsce-package] FAILED — no VSIX generated');
  process.exit(1);
}

console.log(`\n[vsce-package] Done! Generated: ${generated.join(', ')}`);
