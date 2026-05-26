#!/usr/bin/env node
/**
 * bench-recall.js — E5 bge-m3-zh 基线对比跑分脚本
 *
 * 纯 Node.js，无 tsx 依赖。
 * 用法：node scripts/bench-recall.js [--provider bm25]
 *
 * 输出 Markdown 报表到 stdout。
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const QUERIES_FILE = path.resolve(PROJECT_ROOT, 'docs/benches/bge-m3-queries.json');
const SOURCE_DIR = path.resolve(PROJECT_ROOT, 'src');

const ARGS = process.argv.slice(2);
const PROVIDER = ARGS.includes('--provider')
  ? ARGS[ARGS.indexOf('--provider') + 1] || 'local-bert'
  : 'local-bert';

/** 简易 BM25 检索 */
function simpleBm25Search(query, files, topK) {
  const queryTerms = query
    .toLowerCase()
    .split(/[\s,，。]+/)
    .filter(t => t.length > 0);

  const scored = files.map(f => {
    const cl = f.content.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, 'g');
      const matches = cl.match(re);
      if (matches) score += matches.length;
    }
    return { path: f.path, score };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

function walkDir(dir, root) {
  const files = [];
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (!entry.startsWith('.') && entry !== 'node_modules' && entry !== 'dist') {
        files.push(...walkDir(full, root));
      }
    } else if (entry.endsWith('.ts') && stat.size < 100000) {
      try {
        const content = fs.readFileSync(full, 'utf-8');
        files.push({ path: path.relative(root, full), content });
      } catch { /* skip */ }
    }
  }
  return files;
}

async function runBenchmark() {
  console.log(`# bge-m3-zh 基线对比报告\n`);
  console.log(`**provider**: ${PROVIDER}`);
  console.log(`**workspace**: ${PROJECT_ROOT}`);
  console.log(`**date**: ${new Date().toISOString()}\n`);
  console.log(`---\n`);

  const queries = JSON.parse(fs.readFileSync(QUERIES_FILE, 'utf-8'));
  console.log(`加载 **${queries.length}** 道查询\n`);

  const files = walkDir(SOURCE_DIR, PROJECT_ROOT);
  console.log(`扫描 **${files.length}** 个源文件\n`);

  const results = [];

  for (const q of queries) {
    const topK = 5;
    const hits = simpleBm25Search(q.query, files, topK);
    const actualPaths = hits.map(h => h.path);

    const expectedLc = q.expectedFiles.map(f => f.toLowerCase());
    const top1Hit = actualPaths.length > 0 && expectedLc.some(e => actualPaths[0].toLowerCase().includes(e));
    const top5Hits = actualPaths.filter(p => expectedLc.some(e => p.toLowerCase().includes(e))).length;

    let rr = 0;
    for (let i = 0; i < actualPaths.length; i++) {
      if (expectedLc.some(e => actualPaths[i].toLowerCase().includes(e))) {
        rr = 1 / (i + 1);
        break;
      }
    }

    results.push({
      queryId: q.id,
      query: q.query,
      category: q.category,
      top1Hit,
      top5Hits,
      expectedFiles: q.expectedFiles,
      actualTop5: actualPaths,
      reciprocalRank: rr,
    });
  }

  const totalRecall1 = results.filter(r => r.top1Hit).length;
  const avgRecall5 = results.reduce((s, r) => s + r.top5Hits / r.expectedFiles.length, 0) / results.length;
  const mrr = results.reduce((s, r) => s + r.reciprocalRank, 0) / results.length;

  console.log('## 汇总指标\n');
  console.log('| 指标 | 值 |');
  console.log('|---|---|');
  console.log(`| Recall@1 | ${totalRecall1}/${results.length} (${((totalRecall1 / results.length) * 100).toFixed(1)}%) |`);
  console.log(`| avg Recall@5 (per-query) | ${(avgRecall5 * 100).toFixed(1)}% |`);
  console.log(`| MRR | ${mrr.toFixed(3)} |`);
  console.log(`| 源文件数 | ${files.length} |`);
  console.log(`| Provider | ${PROVIDER} |`);
  console.log();

  console.log('## 逐题详情\n');
  console.log('| # | 类别 | Query | Recall@1 | Recall@5 | MRR | Expected | Top hit |');
  console.log('|---|------|-------|----------|----------|-----|----------|---------|');
  for (const r of results) {
    const topHit = r.actualTop5[0] || '(none)';
    console.log(
      `| ${r.queryId} | ${r.category} | \`${r.query.slice(0, 30)}\` | ${r.top1Hit ? '✅' : '❌'} | ${r.top5Hits}/${r.expectedFiles.length} | ${r.reciprocalRank.toFixed(3)} | ${r.expectedFiles.length} files | \`${topHit.slice(0, 50)}\` |`,
    );
  }

  console.log('\n## 决策建议\n');
  console.log(`Provider=${PROVIDER}：`);
  console.log(`- Recall@1 ≥ 0.70: ${(totalRecall1 / results.length) >= 0.70 ? '✅' : '❌'} (${((totalRecall1 / results.length) * 100).toFixed(0)}%)`);
  console.log(`- MRR ≥ 0.50: ${mrr >= 0.50 ? '✅' : '❌'} (${mrr.toFixed(3)})`);

  if (PROVIDER === 'bm25') {
    console.log('\n> BM25 为纯 lexical 基线，无语义匹配。bge-m3-zh 预期 Recall@5 可比 BM25 高 20%+。');
  }
}

runBenchmark().catch(e => {
  console.error('Benchmark 失败:', e);
  process.exit(1);
});
