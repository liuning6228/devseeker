#!/usr/bin/env node
// 离线 BERT 模型下载脚本（v1.2.0）
// ----------------------------------------------------------------
// 从 HuggingFace CDN 拉 Xenova/multilingual-e5-small 到 models/ 目录。
// 模型不入 Git（.gitignore 已排除 models/），每次 npm run package 前自动拉。
// 幂等：已存在且大小合理则跳过。
//
// 引用文件布局（@huggingface/transformers v4 要求）：
//   models/Xenova/multilingual-e5-small/
//     ├── onnx/model_quantized.onnx   (~60 MB, q8)
//     ├── tokenizer.json
//     ├── tokenizer_config.json
//     ├── config.json
//     └── special_tokens_map.json
// ----------------------------------------------------------------

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MODEL_DIR = join(ROOT, 'models', 'Xenova', 'multilingual-e5-small');

const BASE = 'https://huggingface.co/Xenova/multilingual-e5-small/resolve/main';
// 镜像列表（按顺序尝试，任一成功即跳过后面）：
//   1. HuggingFace 官方
//   2. hf-mirror.com（国内镜像）
// 也可通过环境变量 HF_MIRROR 覆盖主源（如内网 / 私有代理）
const MIRRORS = process.env.HF_MIRROR
  ? [process.env.HF_MIRROR.replace(/\/$/, '') + '/Xenova/multilingual-e5-small/resolve/main']
  : [
      'https://huggingface.co/Xenova/multilingual-e5-small/resolve/main',
      'https://hf-mirror.com/Xenova/multilingual-e5-small/resolve/main',
    ];
/** @type {Array<{ relPath: string, minBytes: number }>} */
const FILES = [
  { relPath: 'onnx/model_quantized.onnx', minBytes: 50_000_000 }, // ~60MB q8
  { relPath: 'tokenizer.json', minBytes: 1_000_000 },
  { relPath: 'tokenizer_config.json', minBytes: 100 },
  { relPath: 'config.json', minBytes: 100 },
  { relPath: 'special_tokens_map.json', minBytes: 50 },
];

async function exists(p) {
  try {
    const s = await stat(p);
    return s;
  } catch {
    return null;
  }
}

async function downloadOne({ relPath, minBytes }) {
  const out = join(MODEL_DIR, relPath);
  const existing = await exists(out);
  if (existing && existing.size >= minBytes) {
    console.log(`[skip] ${relPath}  (${(existing.size / 1e6).toFixed(1)} MB)`);
    return;
  }
  await mkdir(dirname(out), { recursive: true });

  let lastErr;
  for (const base of MIRRORS) {
    const url = `${base}/${relPath}`;
    console.log(`[pull] ${url}`);
    const started = Date.now();
    try {
      const resp = await fetch(url, { redirect: 'follow' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      if (!resp.body) throw new Error('empty body');
      const ws = createWriteStream(out);
      await pipeline(Readable.fromWeb(resp.body), ws);
      const s = await stat(out);
      if (s.size < minBytes) {
        throw new Error(`file too small: got ${s.size} bytes (expect ≥ ${minBytes})`);
      }
      const durSec = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`[done] ${relPath}  ${(s.size / 1e6).toFixed(1)} MB in ${durSec}s`);
      return;
    } catch (e) {
      lastErr = e;
      console.warn(`[warn] mirror failed: ${e.message}; 尝试下一个...`);
    }
  }
  throw new Error(`all mirrors failed for ${relPath}: ${lastErr?.message}`);
}

async function main() {
  console.log(`[model] target: ${MODEL_DIR}`);
  await mkdir(MODEL_DIR, { recursive: true });
  for (const f of FILES) {
    await downloadOne(f);
  }
  console.log('\n[model] all files ready. VSIX packaging will include models/.');
}

main().catch((err) => {
  console.error('[model] FAILED:', err.message);
  process.exit(1);
});
