#!/usr/bin/env node
// PDF 翻译中文字体下载脚本
// ----------------------------------------------------------------
// 从 jsdelivr / unpkg CDN 拉 Noto Sans SC Regular 到 fonts/ 目录，
// 供 PDF 版面保留翻译（translate_pdf）嵌入中文译文使用。
// 字体不入 Git（.gitignore 已排除 fonts/），每次 npm run package 前自动拉。
// 幂等：已存在且大小合理则跳过。
//
// 引用文件布局（VSIX 内随包携带）：
//   fonts/
//     ├── NotoSansSC-Regular.ttf   (~10 MB, 静态 TTF)
//     └── LICENSE-OFL.txt          (SIL Open Font License 1.1)
//
// 许可：Noto Sans SC 由 Google 提供，SIL OFL 1.1，允许随应用分发。
// ----------------------------------------------------------------

import { mkdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FONT_DIR = join(ROOT, 'fonts');

// 源包与版本（@expo-google-fonts/noto-sans-sc 内含完整静态 TTF；CDN 可直接取单文件）
const PKG = '@expo-google-fonts/noto-sans-sc@0.4.3';
// 镜像列表（按顺序尝试，任一成功即跳过后面）
const MIRRORS = [
  `https://cdn.jsdelivr.net/npm/${PKG}`,
  `https://fastly.jsdelivr.net/npm/${PKG}`,
  `https://unpkg.com/${PKG}`,
];

/** @type {Array<{ relPath: string, outName: string, minBytes: number }>} */
const FILES = [
  { relPath: '400Regular/NotoSansSC_400Regular.ttf', outName: 'NotoSansSC-Regular.ttf', minBytes: 8_000_000 },
  { relPath: 'LICENSE_FONT', outName: 'LICENSE-OFL.txt', minBytes: 1_000 },
];

async function exists(p) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

async function downloadOne({ relPath, outName, minBytes }) {
  const out = join(FONT_DIR, outName);
  const existing = await exists(out);
  if (existing && existing.size >= minBytes) {
    console.log(`[skip] ${outName}  (${(existing.size / 1e6).toFixed(1)} MB)`);
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
      await pipeline(Readable.fromWeb(resp.body), createWriteStream(out));
      const s = await stat(out);
      if (s.size < minBytes) {
        throw new Error(`file too small: got ${s.size} bytes (expect >= ${minBytes})`);
      }
      const durSec = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`[done] ${outName}  ${(s.size / 1e6).toFixed(1)} MB in ${durSec}s`);
      return;
    } catch (e) {
      lastErr = e;
      console.warn(`[warn] mirror failed: ${e.message}; 尝试下一个...`);
    }
  }
  throw new Error(`all mirrors failed for ${relPath}: ${lastErr?.message}`);
}

async function main() {
  console.log(`[font] target: ${FONT_DIR}`);
  await mkdir(FONT_DIR, { recursive: true });
  for (const f of FILES) {
    await downloadOne(f);
  }
  console.log('\n[font] all files ready. VSIX packaging will include fonts/.');
}

main().catch((err) => {
  console.error('[font] FAILED:', err.message);
  process.exit(1);
});
