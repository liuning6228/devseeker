#!/usr/bin/env node
/**
 * vsce-package.mjs —— 多平台安全打包 VSIX
 *
 * 为每个目标平台：
 * 1. 移走 onnxruntime-web 的浏览器专用 WASM 变体（jsep/asyncify/jspi）
 * 2. 移走 onnxruntime-node 的非目标平台原生二进制
 * 3. Patch @huggingface/transformers node entry：移除 sharp 引用
 * 4. 调用 vsce package 打包
 * 5. 恢复所有修改
 *
 * 用法：
 *   node scripts/vsce-package.mjs                          # 打包所有目标
 *   node scripts/vsce-package.mjs linux-x64                # 只打 linux-x64
 *   node scripts/vsce-package.mjs linux-x64,win32-x64      # 逗号分隔
 */

import { spawnSync } from 'node:child_process';
import {
  mkdirSync, renameSync, existsSync, rmSync, statSync,
  readFileSync, writeFileSync, readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(__filename));
const STAGING = join(ROOT, 'tmp', 'vsce-staging');

const HF_NODE_MJS = join(ROOT, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs');
const HF_NODE_CJS = join(ROOT, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.cjs');

function getVersion() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return pkg.version;
}

// ─────────── 平台映射 ───────────

const ALL_ONNX_PLATFORMS = [
  'darwin/arm64', 'darwin/x64',
  'linux/arm64',  'linux/x64',
  'win32/arm64',  'win32/x64',
];

/** vsce target → onnxruntime-node/bin/napi-v6/ 下的子目录列表（保留的） */
function keepDirsForTarget(target) {
  const map = {
    'linux-x64':     ['linux/x64'],
    'linux-arm64':   ['linux/arm64'],
    'win32-x64':     ['win32/x64'],
    'win32-arm64':   ['win32/arm64'],
    'darwin-x64':    ['darwin/x64'],
    'darwin-arm64':  ['darwin/arm64'],
  };
  return map[target] || ALL_ONNX_PLATFORMS; // fallback: keep all
}

/** 要移除的目录列表 */
function removeDirsForTarget(target) {
  const keep = keepDirsForTarget(target);
  return ALL_ONNX_PLATFORMS.filter(d => !keep.includes(d));
}

// ─────────── Stash / Restore ───────────

/** 收集所有需要 stash 的文件（移出 node_modules，打包后再恢复） */
function collectFilesToStash(target) {
  const files = [];

  // 1. onnxruntime-web 的浏览器 WASM 变体（通用，所有平台都不需要）
  files.push(
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs',
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm',
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs',
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jspi.wasm',
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jspi.mjs',
  );

  // 2. 根 onnxruntime-node 的非目标平台二进制
  collectOnnxDirFiles(
    files,
    join(ROOT, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6'),
    target,
    'node_modules/onnxruntime-node',
  );

  // 3. @huggingface/transformers 的整个嵌套 node_modules
  //     包含 onnxruntime-node（所有平台二进制 ~200 MB）、onnxruntime-common、
  //     global-agent 等 extraneous 包。npm list --production 会报这些包为
  //     extraneous 导致 vsce 打包失败。transformers 运行时靠 hoisted 依赖即可，
  //     完全不需要自身嵌套的 node_modules。
  const hfNested = join(ROOT, 'node_modules', '@huggingface', 'transformers', 'node_modules');
  if (existsSync(hfNested)) {
    collectAllFiles(hfNested, files, 'node_modules/@huggingface/transformers/node_modules');
  }

  return files;
}

function collectOnnxDirFiles(files, baseDir, target, prefix) {
  const dirsToRemove = removeDirsForTarget(target);
  for (const dir of dirsToRemove) {
    const platformDir = join(baseDir, dir);
    if (existsSync(platformDir)) {
      collectAllFiles(platformDir, files, `${prefix}/bin/napi-v6/${dir}`);
    }
  }
}

function collectAllFiles(dir, files, prefix) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = `${prefix}/${entry}`;
    if (statSync(full).isDirectory()) {
      collectAllFiles(full, files, rel);
    } else {
      files.push(rel);
    }
  }
}

function stashFiles(target) {
  if (existsSync(STAGING)) rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });

  const files = collectFilesToStash(target);
  for (const rel of files) {
    const src = join(ROOT, rel);
    if (existsSync(src)) {
      // 用 __ 替换 / 避免子目录冲突
      renameSync(src, join(STAGING, rel.replace(/\//g, '__')));
      console.log(`  [stash] ${rel}`);
    }
  }
}

function restoreFiles() {
  if (!existsSync(STAGING)) return;
  for (const entry of readdirSync(STAGING)) {
    const origRel = entry.replace(/__/g, '/');
    const dest = join(ROOT, origRel);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(join(STAGING, entry), dest);
    console.log(`  [restore] ${origRel}`);
  }
  rmSync(STAGING, { recursive: true, force: true });
}

// ─────────── Patch @huggingface/transformers ───────────

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

// ─────────── VSIX 验证 ───────────

/**
 * 验证 VSIX 是否包含必需的模型和关键依赖
 */
function verifyVsix(vsixPath, target) {
  const errors = [];
  let totalSize = 0;
  let onnxModelCount = 0;
  let hasNodeModules = false;

  try {
    const { stdout } = spawnSync('unzip', ['-l', vsixPath], { encoding: 'utf8', cwd: ROOT });
    const lines = stdout.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.endsWith('.onnx')) onnxModelCount++;
      if (trimmed.includes('node_modules/')) hasNodeModules = true;
      // 解析大小
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 3 && /^\d+$/.test(parts[0])) {
        totalSize += parseInt(parts[0], 10);
      }
    }
  } catch {
    errors.push('无法读取 VSIX');
  }

  if (onnxModelCount === 0) errors.push('缺少 ONNX 模型文件（.onnx）');
  if (!hasNodeModules) errors.push('缺少 node_modules');
  const sizeMB = (totalSize / (1024 * 1024)).toFixed(1);

  console.log(`  └─ 大小: ${sizeMB} MB, ONNX 模型: ${onnxModelCount} 个, node_modules: ${hasNodeModules ? '✓' : '✗'}`);
  if (errors.length > 0) {
    console.error(`  └─ ⚠ 验证失败: ${errors.join('; ')}`);
    return false;
  }
  return true;
}

// ─────────── Main ───────────

const DEFAULT_TARGETS = [
  { name: 'linux-x64',   arg: 'linux-x64'   },
  { name: 'win32-x64',   arg: 'win32-x64'   },
  { name: 'darwin-x64',  arg: 'darwin-x64'  },
  { name: 'darwin-arm64',arg: 'darwin-arm64'},
];

function parseTargets(argv) {
  if (argv.length === 0) return DEFAULT_TARGETS;
  return argv.flatMap(a => a.split(',')).map(t => ({ name: t, arg: t }));
}

function main() {
  const userTargets = process.argv.slice(2);
  const TARGETS = parseTargets(userTargets);
  const version = getVersion();
  const generated = [];
  let allPassed = true;

  console.log(`[vsce-package] Targets: ${TARGETS.map(t => t.name).join(', ')}`);

  try {
    for (const target of TARGETS) {
      const vsixName = `devseeker-${version}-${target.name}.vsix`;
      const vsixPath = join(ROOT, vsixName);
      if (existsSync(vsixPath)) rmSync(vsixPath);

      console.log(`\n━━━ Packaging for ${target.name} ━━━`);

      // 1. Stash 非目标平台二进制
      console.log('[vsce-package] Stashing cross-platform binaries...');
      stashFiles(target.arg);

      // 2. Patch transformers（只需做一次）
      if (generated.length === 0) {
        console.log('[vsce-package] Patching @huggingface/transformers node entry...');
        patchTransformersNodeEntry();
      }

      // 3. vsce package
      const result = spawnSync(
        'npx', ['vsce', 'package', '--target', target.arg, '-o', vsixPath],
        { cwd: ROOT, stdio: 'inherit', shell: true },
      );

      if (result.status !== 0) {
        console.error(`[vsce-package] FAILED for ${target.name}`);
        allPassed = false;
        // 继续恢复文件
        restoreFiles();
        continue;
      }

      if (existsSync(vsixPath)) {
        const sizeMB = (statSync(vsixPath).size / (1024 * 1024)).toFixed(1);
        console.log(`[vsce-package] Generated: ${vsixName} (${sizeMB} MB)`);
        generated.push(vsixName);

        // 4. 验证
        const ok = verifyVsix(vsixPath, target.arg);
        if (!ok) allPassed = false;
      } else {
        console.error(`[vsce-package] ${target.name}: VSIX not found at ${vsixPath}`);
        allPassed = false;
      }

      // 5. 恢复
      console.log('[vsce-package] Restoring binaries...');
      restoreFiles();
    }
  } catch (err) {
    console.error('[vsce-package] Unexpected error:', err);
    process.exit(1);
  } finally {
    restoreTransformersNodeEntry();
    restoreFiles();
  }

  if (generated.length === 0) {
    console.error('\n[vsce-package] FAILED — no VSIX generated');
    process.exit(1);
  }

  console.log(`\n[vsce-package] Done! Generated: ${generated.join(', ')}`);
  if (!allPassed) {
    console.warn('[vsce-package] Some packages have warnings above — check manually.');
  }
}

main();
