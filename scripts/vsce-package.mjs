#!/usr/bin/env node
/**
 * vsce-package.mjs —— 多平台打包（最终版）
 * 
 * 使用 --no-dependencies 绕过 npm list 检查
 * 手动注入依赖（包含所有间接依赖）
 */

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, statSync, readFileSync, writeFileSync, mkdirSync, cpSync, renameSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(__filename));
const STAGING = join(ROOT, 'tmp', 'vsce-staging');

const TARGETS = [
  { name: 'linux-x64', arg: 'linux-x64' },
  { name: 'win32-x64', arg: 'win32-x64' },
  { name: 'darwin-x64', arg: 'darwin-x64' },
  { name: 'darwin-arm64', arg: 'darwin-arm64' },
];

const ALL_ONNX = ['darwin/arm64','darwin/x64','linux/arm64','linux/x64','win32/arm64','win32/x64'];

function stashFiles(target) {
  if (existsSync(STAGING)) rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });
  
  // 移走浏览器 WASM
  const wasmFiles = [
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs',
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm',
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs',
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jspi.wasm',
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jspi.mjs',
  ];
  
  for (const rel of wasmFiles) {
    const src = join(ROOT, rel);
    if (existsSync(src)) {
      renameSync(src, join(STAGING, rel.replace(/\//g, '__')));
    }
  }
  
  // 移走非目标平台二进制
  const keepMap = {
    'linux-x64': ['linux/x64'], 'win32-x64': ['win32/x64'],
    'darwin-x64': ['darwin/x64'], 'darwin-arm64': ['darwin/arm64'],
  };
  const keep = keepMap[target] || ALL_ONNX;
  const onnxBase = join(ROOT, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
  
  for (const platform of ALL_ONNX) {
    if (!keep.includes(platform)) {
      const src = join(onnxBase, platform);
      if (existsSync(src)) {
        renameSync(src, join(STAGING, `onnx-${platform.replace(/\//g, '__')}`));
      }
    }
  }
}

function restoreFiles() {
  if (!existsSync(STAGING)) return;
  
  for (const entry of readdirSync(STAGING)) {
    const staged = join(STAGING, entry);
    if (entry.startsWith('onnx-')) {
      const platform = entry.replace('onnx-', '').replace(/__/g, '/');
      const dest = join(onnxBase, platform);
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(staged, dest);
    } else {
      const rel = entry.replace(/__/g, '/');
      const dest = join(ROOT, rel);
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(staged, dest);
    }
  }
  
  rmSync(STAGING, { recursive: true, force: true });
}

function patchSharp() {
  const files = [
    join(ROOT, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs'),
    join(ROOT, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.cjs'),
  ];
  
  for (const file of files) {
    if (!existsSync(file)) continue;
    let content = readFileSync(file, 'utf8');
    let patched = content
      .replace('import sharp from "sharp";', 'var sharp = {};')
      .replace(/require\(["']sharp["']\)/g, '({})');
    if (patched !== content) writeFileSync(file, patched);
  }
}

function getAllDependencies(pkgName, visited = new Set()) {
  if (visited.has(pkgName)) return [];
  visited.add(pkgName);
  
  const pkgPath = join(ROOT, 'node_modules', pkgName, 'package.json');
  if (!existsSync(pkgPath)) return [];
  
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const deps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {}),
  ];
  
  let allDeps = [...deps];
  for (const dep of deps) {
    if (dep !== 'sharp') { // 排除 sharp
      allDeps = allDeps.concat(getAllDependencies(dep, visited));
    }
  }
  
  return [...new Set(allDeps)];
}

function main() {
  const args = process.argv.slice(2);
  let targets = TARGETS;
  
  if (args.length > 0) {
    const requested = args[0].split(',').map(a => a.trim());
    targets = TARGETS.filter(t => requested.includes(t.name));
  }
  
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  const generated = [];
  
  patchSharp();
  
  // 保留 transformers 的嵌套 node_modules（包含 onnxruntime-node）
  // const hfNested = join(ROOT, 'node_modules', '@huggingface', 'transformers', 'node_modules');
  // if (existsSync(hfNested)) rmSync(hfNested, { recursive: true, force: true });
  
  for (const target of targets) {
    const vsixName = `devseeker-${version}-${target.name}.vsix`;
    const vsixPath = join(ROOT, vsixName);
    if (existsSync(vsixPath)) rmSync(vsixPath);
    
    console.log(`\n━━━ ${target.name} ━━━`);
    
    // 创建临时工作目录
    const workDir = join(ROOT, 'tmp', `vsix-${target.name}`);
    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });
    
    // 复制项目文件
    const items = ['out', 'models', 'media', '.github', 'package.json', '.vscodeignore',
                   'CHANGELOG.md', 'README.md', 'LICENSE.txt', 'logo.png', 'logo.svg'];
    for (const item of items) {
      const src = join(ROOT, item);
      const dest = join(workDir, item);
      if (existsSync(src)) cpSync(src, dest, { recursive: true, dereference: true });
    }
    
    // webview-ui 只保留 dist
    mkdirSync(join(workDir, 'webview-ui'), { recursive: true });
    const wvuDist = join(ROOT, 'webview-ui', 'dist');
    if (existsSync(wvuDist)) cpSync(wvuDist, join(workDir, 'webview-ui', 'dist'), { recursive: true });
    
    // 收集所有依赖并复制
    console.log('[1/3] Collecting dependencies...');
    const allDeps = new Set();
    for (const dep of Object.keys(pkg.dependencies || {})) {
      allDeps.add(dep);
      getAllDependencies(dep).forEach(d => allDeps.add(d));
    }
    
    console.log('[2/3] Copying dependencies...');
    mkdirSync(join(workDir, 'node_modules'), { recursive: true });
    for (const dep of allDeps) {
      if (dep === 'sharp') continue;
      const src = join(ROOT, 'node_modules', dep);
      const dest = join(workDir, 'node_modules', dep);
      if (existsSync(src)) cpSync(src, dest, { recursive: true, dereference: true });
    }
    
    // 复制 transformers 的嵌套 node_modules（包含 onnxruntime-node）
    const hfNestedSrc = join(ROOT, 'node_modules', '@huggingface', 'transformers', 'node_modules');
    const hfNestedDest = join(workDir, 'node_modules', '@huggingface', 'transformers', 'node_modules');
    if (existsSync(hfNestedSrc)) {
      cpSync(hfNestedSrc, hfNestedDest, { recursive: true, dereference: true });
    }
    
    // 裁剪非目标平台
    console.log('[3/3] Trimming and packaging...');
    const keepMap = {'linux-x64':['linux/x64'],'win32-x64':['win32/x64'],'darwin-x64':['darwin/x64'],'darwin-arm64':['darwin/arm64']};
    const keep = keepMap[target.arg] || ALL_ONNX;
    
    // 裁剪顶层 onnxruntime-node
    const onnxBase = join(workDir, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
    for (const platform of ALL_ONNX) {
      if (!keep.includes(platform)) {
        const p = join(onnxBase, platform);
        if (existsSync(p)) rmSync(p, { recursive: true, force: true });
      }
    }
    
    // 裁剪 transformers 嵌套的 onnxruntime-node
    const hfOnnxBase = join(workDir, 'node_modules', '@huggingface', 'transformers', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
    if (existsSync(hfOnnxBase)) {
      for (const platform of ALL_ONNX) {
        if (!keep.includes(platform)) {
          const p = join(hfOnnxBase, platform);
          if (existsSync(p)) rmSync(p, { recursive: true, force: true });
        }
      }
    }
    
    // vsce package
    const result = spawnSync(
      'node', [join(ROOT, 'node_modules', '@vscode', 'vsce', 'vsce'), 'package', '--target', target.arg, '-o', vsixPath, '--no-dependencies'],
      { cwd: workDir, stdio: 'inherit' }
    );
    
    if (result.status === 0 && existsSync(vsixPath)) {
      // 注入 node_modules 和 models 到 extension/ 目录下
      // 先创建临时 extension 目录结构
      const extDir = join(workDir, 'extension');
      mkdirSync(extDir, { recursive: true });
      renameSync(join(workDir, 'node_modules'), join(extDir, 'node_modules'));
      renameSync(join(workDir, 'models'), join(extDir, 'models'));
      
      spawnSync('zip', ['-rq', vsixPath, 'extension/node_modules/', 'extension/models/'], { cwd: workDir, stdio: 'inherit' });
      
      const sizeMB = (statSync(vsixPath).size / (1024 * 1024)).toFixed(1);
      console.log(`✓ ${vsixName} (${sizeMB} MB)`);
      generated.push(vsixName);
    } else {
      console.error(`✗ Failed`);
    }
    
    rmSync(workDir, { recursive: true, force: true });
  }
  
  if (generated.length > 0) {
    console.log(`\nDone! ${generated.join(', ')}`);
  }
}

main();
