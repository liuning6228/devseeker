/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 变更影响分析器（CVW §4.2）
 *
 * 输入 editedFiles + TestPlan，输出**最小受影响测试集**与可直接执行的测试命令。
 *
 * 两级映射：
 *   1. 约定映射（零成本）：按项目约定推导候选测试路径，存在即命中；
 *   2. 图索引反向依赖（DevSeeker 独有）：约定映射不到时，取变更文件定义的符号，
 *      用 GraphIndex.findCallers 反查调用方，落在测试文件里的纳入测试集。
 *
 * 注意：
 * - GraphIndex 以**工作区相对 POSIX 路径**存储 file_path，本模块内部统一用该表示；
 * - 图索引未建/打开失败时（panel 的 getGraphIndex 返回 undefined）自动降级为仅约定映射；
 * - 任何异常都不上抛：影响分析失败只意味着回落全量命令，不能阻断任务。
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, dirname, basename, extname, posix } from 'node:path';
import { getLogger } from '../../infra/logger.js';
import type { TestFramework, TestPlan } from './types.js';

const log = getLogger('verification.targeting');

/** 最多纳入命令行的测试文件数（超出则回落全量，避免命令过长） */
const MAX_TEST_FILES = 10;
/** 图索引反查时每个变更文件最多取用的符号数 */
const MAX_SYMBOLS_PER_FILE = 12;
/** 图索引反查的变更文件上限（大批量变更时约定映射已够用） */
const MAX_GRAPH_FILES = 8;

/**
 * GraphIndex 的最小结构化契约（只声明本模块需要的方法）。
 * 便于单测注入 fake，且避免 verification 模块依赖 sql.js。
 */
export interface GraphIndexLike {
  findCallers(symbolName: string, filePath?: string): Array<{ name: string; filePath: string }>;
  findSymbolsByPathPrefix(prefix: string, limit?: number): Array<{ name: string; filePath: string; kind?: string }>;
}

/** 影响分析结果 */
export interface TargetingResult {
  /** 受影响测试文件（工作区相对 POSIX 路径），可能为空 */
  testFiles: string[];
  /** 建议执行的测试命令；空串表示无可执行测试命令（交由降级链处理） */
  command: string;
  /** 测试集来源（日志 / 单测断言用） */
  source: 'convention' | 'graph' | 'convention+graph' | 'full-suite' | 'none';
  /** true 表示 command 为全量命令（未能收敛到最小集） */
  fullSuite: boolean;
  /** 附加说明（如"变更文件过多，回落全量"） */
  note?: string;
}

/** 判断一个相对路径是否为测试文件 */
export function isTestPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/');
  const base = posix.basename(p);
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) ||
    /^test_.*\.py$/.test(base) ||
    /_test\.(py|go|c|cc|cpp|cxx|rs)$/.test(base) ||
    /(^|\/)(tests?|__tests__)\//.test(p)
  );
}

/** 绝对路径 → 工作区相对 POSIX 路径；不在工作区内时返回 undefined */
function toRelPosix(workspaceRoot: string, absOrRel: string): string | undefined {
  const abs = isAbsolute(absOrRel) ? absOrRel : join(workspaceRoot, absOrRel);
  const rel = relative(workspaceRoot, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.replace(/\\/g, '/');
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    const st = await fs.stat(abs);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * 计算最小受影响测试集。
 *
 * @param opts.editedFiles 编辑过的文件（绝对路径，来自 TaskLoop.editedFiles）
 * @param opts.graphIndex 可选图索引；缺省则仅用约定映射
 * @param opts.exists 存在性判定注入点（单测用）
 */
export async function computeAffectedTests(opts: {
  workspaceRoot: string | undefined;
  editedFiles: Iterable<string>;
  plan: TestPlan;
  graphIndex?: GraphIndexLike | undefined;
  exists?: (absPath: string) => Promise<boolean>;
}): Promise<TargetingResult> {
  const { workspaceRoot, plan } = opts;
  const exists = opts.exists ?? fileExists;
  const fullCommand = plan.testCommand;

  if (!workspaceRoot || plan.framework === 'none') {
    return {
      testFiles: [],
      command: fullCommand,
      source: fullCommand ? 'full-suite' : 'none',
      fullSuite: Boolean(fullCommand),
    };
  }

  const edited: string[] = [];
  for (const f of opts.editedFiles) {
    const rel = toRelPosix(workspaceRoot, f);
    if (rel) edited.push(rel);
  }
  if (edited.length === 0) {
    return { testFiles: [], command: fullCommand, source: 'none', fullSuite: false };
  }

  const targets = new Set<string>();
  const unmapped: string[] = [];
  let usedConvention = false;

  // ── 1. 约定映射 ──
  for (const rel of edited) {
    // 变更的就是测试文件本身 → 直接纳入
    if (isTestPath(rel)) {
      targets.add(rel);
      usedConvention = true;
      continue;
    }
    const hit = await mapByConvention(workspaceRoot, rel, plan, exists);
    if (hit.length > 0) {
      for (const h of hit) targets.add(h);
      usedConvention = true;
    } else {
      unmapped.push(rel);
    }
  }

  // ── 2. 图索引反向依赖（仅对约定映射未命中的文件） ──
  let usedGraph = false;
  if (opts.graphIndex && unmapped.length > 0) {
    const viaGraph = findTestsViaGraph(opts.graphIndex, unmapped.slice(0, MAX_GRAPH_FILES));
    if (viaGraph.length > 0) {
      for (const t of viaGraph) targets.add(t);
      usedGraph = true;
    }
  }

  const testFiles = [...targets].sort();
  if (testFiles.length === 0) {
    return {
      testFiles: [],
      command: fullCommand,
      source: 'none',
      fullSuite: Boolean(fullCommand),
      note: unmapped.length > 0 ? `未映射到现有测试：${unmapped.slice(0, 5).join(', ')}` : undefined,
    };
  }

  if (testFiles.length > MAX_TEST_FILES) {
    return {
      testFiles,
      command: fullCommand,
      source: 'full-suite',
      fullSuite: true,
      note: `受影响测试 ${testFiles.length} 个，超过 ${MAX_TEST_FILES}，回落全量命令`,
    };
  }

  const command = buildTestCommand(plan, testFiles);
  const source: TargetingResult['source'] = usedConvention && usedGraph
    ? 'convention+graph'
    : usedGraph ? 'graph' : 'convention';

  return {
    testFiles,
    command: command || fullCommand,
    source: command ? source : 'full-suite',
    fullSuite: !command,
    ...(unmapped.length > 0 && !usedGraph
      ? { note: `以下变更未映射到测试：${unmapped.slice(0, 5).join(', ')}` }
      : {}),
  };
}

// ─────────── 约定映射 ───────────

/**
 * 由源文件推导候选测试路径并做存在性校验。
 *
 * 覆盖形态：
 * - 同目录：`foo.test.ts` / `foo.spec.ts` / `__tests__/foo.test.ts`
 * - 镜像目录：`tests/<源路径去掉首层>/foo.test.ts`（DevSeeker 自身即此约定）
 * - 扁平目录：`<conventions.testDir>/foo.test.ts`
 * - pytest：`test_foo.py`；go：`foo_test.go`；rust：`tests/foo.rs`
 */
async function mapByConvention(
  workspaceRoot: string,
  relFile: string,
  plan: TestPlan,
  exists: (abs: string) => Promise<boolean>,
): Promise<string[]> {
  const ext = extname(relFile);
  const stem = basename(relFile, ext);
  const dir = dirname(relFile).replace(/\\/g, '/');
  const dirNoRoot = stripFirstSegment(dir);
  const testDir = plan.conventions.testDir.replace(/\\/g, '/');

  const candidates = new Set<string>();
  const push = (p: string): void => {
    const norm = posix.normalize(p).replace(/^\.\//, '');
    if (norm && !norm.startsWith('..')) candidates.add(norm);
  };

  switch (plan.framework) {
    case 'go':
      push(joinPosix(dir, `${stem}_test.go`));
      break;
    case 'pytest':
      push(joinPosix(dir, `test_${stem}.py`));
      push(joinPosix(dirNoRoot ? `tests/${dirNoRoot}` : 'tests', `test_${stem}.py`));
      push(`tests/test_${stem}.py`);
      push(`test/test_${stem}.py`);
      push(joinPosix(testDir, `test_${stem}.py`));
      break;
    case 'cargo':
      push(`tests/${stem}.rs`);
      push(joinPosix(dir, `${stem}_test.rs`));
      break;
    case 'ctest':
    case 'make':
      for (const e of ['.c', '.cpp', '.cc']) {
        push(`tests/${stem}_test${e}`);
        push(`test/${stem}_test${e}`);
        push(joinPosix(dir, `${stem}_test${e}`));
      }
      break;
    default: {
      // JS/TS 生态
      const exts = jsTestExts(ext);
      for (const e of exts) {
        for (const kind of ['test', 'spec']) {
          push(joinPosix(dir, `${stem}.${kind}${e}`));
          push(joinPosix(dir, '__tests__', `${stem}.${kind}${e}`));
          push(joinPosix(dirNoRoot ? `tests/${dirNoRoot}` : 'tests', `${stem}.${kind}${e}`));
          push(joinPosix(dirNoRoot ? `test/${dirNoRoot}` : 'test', `${stem}.${kind}${e}`));
          push(joinPosix(testDir, `${stem}.${kind}${e}`));
          push(`tests/${stem}.${kind}${e}`);
        }
      }
      break;
    }
  }

  const hits: string[] = [];
  for (const c of candidates) {
    if (await exists(join(workspaceRoot, c))) hits.push(c);
  }
  return hits;
}

/** 源文件扩展名 → 可能的测试文件扩展名（含 ts↔js 互查） */
function jsTestExts(srcExt: string): string[] {
  switch (srcExt) {
    case '.ts':
      return ['.ts'];
    case '.tsx':
      return ['.tsx', '.ts'];
    case '.jsx':
      return ['.jsx', '.js'];
    case '.mts':
    case '.cts':
      return [srcExt, '.ts'];
    case '.js':
    case '.mjs':
    case '.cjs':
      return ['.js', '.ts'];
    default:
      return ['.ts', '.js'];
  }
}

function joinPosix(...parts: string[]): string {
  return parts.filter((p) => p && p !== '.').join('/');
}

/** `src/core/foo` → `core/foo`（去掉源根层，用于镜像到 tests/） */
function stripFirstSegment(dir: string): string {
  if (!dir || dir === '.') return '';
  const idx = dir.indexOf('/');
  return idx === -1 ? '' : dir.slice(idx + 1);
}

// ─────────── 图索引反向依赖 ───────────

/**
 * 用调用关系图反查测试文件。
 *
 * 对每个变更文件：取其定义的符号 → findCallers → 调用方落在测试文件中的纳入。
 * 图索引查询为同步 SQLite 调用，异常一律吞掉（图索引为可选增强）。
 */
function findTestsViaGraph(graph: GraphIndexLike, relFiles: string[]): string[] {
  const out = new Set<string>();
  for (const rel of relFiles) {
    try {
      const symbols = graph.findSymbolsByPathPrefix(rel, 200)
        // findSymbolsByPathPrefix 支持前缀/文件名/目录段三种语义，这里只要精确同文件
        .filter((s) => s.filePath.replace(/\\/g, '/') === rel);
      const names = dedupe(symbols.map((s) => s.name)).slice(0, MAX_SYMBOLS_PER_FILE);
      for (const name of names) {
        for (const caller of graph.findCallers(name)) {
          const cp = caller.filePath.replace(/\\/g, '/');
          if (cp !== rel && isTestPath(cp)) out.add(cp);
        }
      }
    } catch (e) {
      log.warn({ rel, err: String(e) }, 'graph targeting failed; skipping file');
    }
  }
  return [...out];
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

// ─────────── 命令组装 ───────────

/** 支持在命令行追加文件参数的框架 */
const FILE_ARG_FRAMEWORKS: ReadonlySet<TestFramework> = new Set<TestFramework>([
  'vitest', 'jest', 'mocha', 'pytest', 'go',
]);

/**
 * 把最小测试集组装成命令。
 *
 * 返回空串表示该框架不支持按文件过滤（cargo/ctest/make/npm-script），调用方回落全量。
 */
export function buildTestCommand(plan: TestPlan, testFiles: string[]): string {
  if (testFiles.length === 0 || !plan.testCommand) return '';
  if (!FILE_ARG_FRAMEWORKS.has(plan.framework)) return '';
  // 项目 test script（`npm test`）追加参数需要 `--` 且行为不可预期 → 不组装
  if (/^npm\s+(test|run)\b/.test(plan.testCommand)) return '';

  if (plan.framework === 'go') {
    // go 按包粒度执行：目录去重后拼 ./dir/...
    const pkgs = dedupe(testFiles.map((f) => posix.dirname(f)))
      .map((d) => (d === '.' ? './...' : `./${d}/...`));
    return `${plan.testCommand.replace(/\s+\.\/\.\.\.\s*$/, '')} ${pkgs.join(' ')}`.trim();
  }

  return `${plan.testCommand} ${testFiles.map(quoteIfNeeded).join(' ')}`;
}

/** 含空格/shell 元字符的路径加引号（测试路径正常不含，但防御拼接注入） */
function quoteIfNeeded(p: string): string {
  return /^[\w./@+-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;
}
