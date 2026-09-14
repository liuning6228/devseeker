/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 测试框架探测器（CVW §4.1）
 *
 * 把 VERIFY_PROMPT 第 1 步（模型自己 list_dir + read_file 探测项目类型）
 * 下沉为确定性代码。每个 TaskLoop 生命周期探测一次并缓存。
 *
 * 性能收益：每个含验证的任务节省 2-4 个 LLM 轮次。
 *
 * 注意：
 * - 探测全部基于文件存在性 + 内容正则，无 LLM 调用
 * - 任何 IO 失败都不抛异常，降级为 framework='none'（由降级链兜底）
 * - conventions 从现有测试文件采样，供 LLM 新建测试时遵循项目约定
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '../../infra/logger.js';
import type { TestFramework, TestPlan, TestConventions } from './types.js';

const log = getLogger('verification.detector');

/** conventions 采样时最多扫描的目录层数 */
const MAX_SAMPLE_DEPTH = 4;
/** conventions 采样时最多访问的目录数（防御超大仓库） */
const MAX_SAMPLE_DIRS = 200;
/** importStyle 提取的最大字符数 */
const MAX_IMPORT_STYLE_CHARS = 400;

/** 探测结果缓存键 = workspaceRoot */
const planCache = new Map<string, TestPlan>();

const NONE_PLAN: TestPlan = {
  framework: 'none',
  testCommand: '',
  testDirGlobs: [],
  conventions: { testDir: 'tests', filePattern: '*.test.ts' },
};

/** 交叉编译工具链信号（嵌入式场景 → 降级链 L3） */
const CROSS_TOOLCHAIN_PATTERNS = [
  /CMAKE_TOOLCHAIN_FILE/i,
  /CMAKE_SYSTEM_NAME\s+Generic/i,
  /arm-none-eabi/i,
  /riscv\d*-unknown-elf/i,
  /avr-gcc/i,
  /xtensa-esp32/i,
];

async function readFileSafe(path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 探测工作区的测试执行计划。
 *
 * @param workspaceRoot 工作区根目录
 * @param opts.noCache true 时跳过缓存（单测用）
 */
export async function detectTestPlan(
  workspaceRoot: string | undefined,
  opts?: { noCache?: boolean },
): Promise<TestPlan> {
  if (!workspaceRoot) return NONE_PLAN;
  if (!opts?.noCache) {
    const cached = planCache.get(workspaceRoot);
    if (cached) return cached;
  }

  let plan: TestPlan;
  try {
    plan = await detectUncached(workspaceRoot);
  } catch (e) {
    log.warn({ err: String(e) }, 'detectTestPlan failed; degrading to none');
    plan = NONE_PLAN;
  }

  if (!opts?.noCache) planCache.set(workspaceRoot, plan);
  return plan;
}

/** 清除探测缓存（工作区切换 / 单测隔离） */
export function clearTestPlanCache(): void {
  planCache.clear();
}

async function detectUncached(root: string): Promise<TestPlan> {
  // ── 1. npm 生态（package.json） ──
  const pkgRaw = await readFileSafe(join(root, 'package.json'));
  if (pkgRaw) {
    const plan = await detectNpm(root, pkgRaw);
    if (plan) return plan;
  }

  // ── 2. Python（pytest） ──
  const pyPlan = await detectPython(root);
  if (pyPlan) return pyPlan;

  // ── 3. Go ──
  if (await exists(join(root, 'go.mod'))) {
    return {
      framework: 'go',
      testCommand: 'go test ./...',
      buildCommand: 'go build ./...',
      typecheckCommand: 'go vet ./...',
      testDirGlobs: ['**/*_test.go'],
      conventions: await sampleConventions(root, ['_test.go'], 'pkg', '*_test.go'),
    };
  }

  // ── 4. Rust ──
  if (await exists(join(root, 'Cargo.toml'))) {
    return {
      framework: 'cargo',
      testCommand: 'cargo test',
      buildCommand: 'cargo build',
      typecheckCommand: 'cargo check',
      testDirGlobs: ['tests/**/*.rs', 'src/**/*.rs'],
      conventions: await sampleConventions(root, ['.rs'], 'tests', '*.rs'),
    };
  }

  // ── 5. C/C++（CMake） ──
  const cmakeRaw = await readFileSafe(join(root, 'CMakeLists.txt'));
  if (cmakeRaw) {
    const crossToolchain = CROSS_TOOLCHAIN_PATTERNS.some((re) => re.test(cmakeRaw));
    const hasTesting = /enable_testing\s*\(/i.test(cmakeRaw);
    return {
      framework: hasTesting && !crossToolchain ? 'ctest' : 'none',
      testCommand: hasTesting && !crossToolchain ? 'ctest --output-on-failure' : '',
      buildCommand: 'cmake --build build',
      ...(crossToolchain ? { crossToolchain: true } : {}),
      testDirGlobs: ['test/**', 'tests/**'],
      conventions: await sampleConventions(root, ['_test.c', '_test.cpp', '.test.cpp'], 'tests', '*_test.cpp'),
    };
  }

  // ── 6. Makefile ──
  const makeRaw = await readFileSafe(join(root, 'Makefile'));
  if (makeRaw && /^test\s*:/m.test(makeRaw)) {
    const crossToolchain = CROSS_TOOLCHAIN_PATTERNS.some((re) => re.test(makeRaw));
    return {
      framework: 'make',
      testCommand: 'make test',
      ...(/^build\s*:/m.test(makeRaw) ? { buildCommand: 'make build' } : { buildCommand: 'make' }),
      ...(crossToolchain ? { crossToolchain: true } : {}),
      testDirGlobs: ['test/**', 'tests/**'],
      conventions: await sampleConventions(root, ['_test.c', '_test.cpp'], 'tests', '*_test.c'),
    };
  }

  // ── 7. CI 兜底信号 ──
  const ciCommand = await detectFromCi(root);
  if (ciCommand) {
    return {
      framework: 'none',
      testCommand: ciCommand,
      testDirGlobs: ['tests/**'],
      conventions: await sampleConventions(root, ['.test.ts', '.spec.ts'], 'tests', '*.test.ts'),
    };
  }

  return NONE_PLAN;
}

// ─────────── npm 生态 ───────────

interface PackageJsonShape {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}

async function detectNpm(root: string, raw: string): Promise<TestPlan | undefined> {
  let pkg: PackageJsonShape;
  try {
    pkg = JSON.parse(raw) as PackageJsonShape;
  } catch {
    return undefined;
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const scripts = pkg.scripts ?? {};

  let framework: TestFramework | undefined;
  if (deps['vitest']) framework = 'vitest';
  else if (deps['jest']) framework = 'jest';
  else if (deps['mocha']) framework = 'mocha';

  // 无测试框架依赖但有 test script → 仍以 script 为准（框架标 none 触发降级判定）
  if (!framework && !scripts['test']) return undefined;

  const testCommand = pickNpmTestCommand(framework, scripts);
  const typecheckCommand = pickScript(scripts, ['type-check', 'typecheck', 'tsc'])
    ?? (deps['typescript'] ? 'npx tsc --noEmit' : undefined);
  const buildCommand = pickScript(scripts, ['build', 'compile']);

  const suffixes = framework === 'jest'
    ? ['.test.ts', '.test.js', '.spec.ts', '.spec.js']
    : ['.test.ts', '.test.js', '.test.tsx', '.spec.ts'];

  return {
    framework: framework ?? 'none',
    testCommand,
    ...(typecheckCommand ? { typecheckCommand } : {}),
    ...(buildCommand ? { buildCommand } : {}),
    testDirGlobs: ['tests/**', 'test/**', 'src/**/*.test.*', 'src/**/*.spec.*', '**/__tests__/**'],
    conventions: await sampleConventions(root, suffixes, 'tests', '*.test.ts'),
  };
}

/**
 * 选定 npm 测试命令。
 *
 * 优先用框架直调（`npx vitest run <file>` 支持追加文件参数，便于最小测试集）；
 * 无框架依赖时回落项目 test script（遵循"不发明命令"原则）。
 */
function pickNpmTestCommand(
  framework: TestFramework | undefined,
  scripts: Record<string, string>,
): string {
  switch (framework) {
    case 'vitest':
      return 'npx vitest run';
    case 'jest':
      return 'npx jest';
    case 'mocha':
      return 'npx mocha';
    default:
      return scripts['test'] ? 'npm test' : '';
  }
}

function pickScript(scripts: Record<string, string>, names: string[]): string | undefined {
  for (const n of names) {
    if (typeof scripts[n] === 'string' && scripts[n].trim()) return `npm run ${n}`;
  }
  return undefined;
}

// ─────────── Python ───────────

async function detectPython(root: string): Promise<TestPlan | undefined> {
  const pyproject = await readFileSafe(join(root, 'pyproject.toml'));
  const pytestIni = await exists(join(root, 'pytest.ini'));
  const setupCfg = await readFileSafe(join(root, 'setup.cfg'));
  const requirements = await readFileSafe(join(root, 'requirements.txt'));

  const hasPytest =
    pytestIni ||
    (pyproject !== undefined && /pytest/i.test(pyproject)) ||
    (setupCfg !== undefined && /\[tool:pytest\]/i.test(setupCfg)) ||
    (requirements !== undefined && /^\s*pytest\b/im.test(requirements));

  if (!hasPytest) return undefined;

  const hasMypy = (pyproject !== undefined && /mypy/i.test(pyproject))
    || (requirements !== undefined && /^\s*mypy\b/im.test(requirements));

  return {
    framework: 'pytest',
    testCommand: 'python -m pytest',
    ...(hasMypy ? { typecheckCommand: 'python -m mypy .' } : {}),
    testDirGlobs: ['tests/**/*.py', 'test/**/*.py', '**/test_*.py'],
    conventions: await sampleConventions(root, ['_test.py'], 'tests', 'test_*.py', ['test_']),
  };
}

// ─────────── CI 兜底 ───────────

async function detectFromCi(root: string): Promise<string | undefined> {
  const dir = join(root, '.github', 'workflows');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return undefined;
  }
  for (const name of entries) {
    if (!/\.ya?ml$/i.test(name)) continue;
    const raw = await readFileSafe(join(dir, name));
    if (!raw) continue;
    // 提取形如 `run: npm test` / `run: pytest` 的测试命令
    const m = raw.match(/run:\s*([^\n]*\b(?:test|pytest|vitest|jest)\b[^\n]*)/i);
    if (m?.[1]) {
      const cmd = m[1].trim();
      // 过滤多行 block 标记与明显非命令内容
      if (cmd && !cmd.startsWith('|') && !cmd.startsWith('>') && cmd.length < 200) return cmd;
    }
  }
  return undefined;
}

// ─────────── conventions 采样 ───────────

/**
 * 从现有测试文件采样项目约定。
 *
 * 采样失败（新项目 / 无测试）时返回传入的默认值 —— 不阻塞探测。
 *
 * @param suffixes 测试文件后缀白名单，如 ['.test.ts']
 * @param prefixes 测试文件前缀白名单，如 ['test_']（pytest 风格）
 */
async function sampleConventions(
  root: string,
  suffixes: string[],
  defaultDir: string,
  defaultPattern: string,
  prefixes: string[] = [],
): Promise<TestConventions> {
  const found = await findFirstTestFile(root, suffixes, prefixes);
  if (!found) return { testDir: defaultDir, filePattern: defaultPattern };

  const { relDir, fileName, absPath } = found;
  const importStyle = await extractImportStyle(absPath);
  return {
    testDir: relDir || defaultDir,
    filePattern: toPattern(fileName, suffixes, prefixes) ?? defaultPattern,
    ...(importStyle ? { importStyle } : {}),
  };
}

function toPattern(fileName: string, suffixes: string[], prefixes: string[]): string | undefined {
  for (const s of suffixes) {
    if (fileName.endsWith(s)) return `*${s}`;
  }
  for (const p of prefixes) {
    if (fileName.startsWith(p)) {
      const ext = fileName.slice(fileName.lastIndexOf('.'));
      return `${p}*${ext}`;
    }
  }
  return undefined;
}

interface FoundTestFile {
  /** 相对 root 的目录（POSIX 分隔符） */
  relDir: string;
  fileName: string;
  absPath: string;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'out', 'dist', 'build', '.venv', 'venv',
  '__pycache__', 'target', '.next', 'coverage', '.devseeker',
]);

/**
 * BFS 查找第一个测试文件。优先 tests/ 与 test/ 目录（更代表项目约定）。
 */
async function findFirstTestFile(
  root: string,
  suffixes: string[],
  prefixes: string[],
): Promise<FoundTestFile | undefined> {
  const isTestFile = (name: string): boolean =>
    suffixes.some((s) => name.endsWith(s)) || prefixes.some((p) => name.startsWith(p));

  // 队列元素：[绝对路径, 相对路径（POSIX）, 深度]
  const queue: Array<[string, string, number]> = [];
  // 优先探测常规测试目录
  for (const preferred of ['tests', 'test', '__tests__']) {
    if (await exists(join(root, preferred))) queue.push([join(root, preferred), preferred, 1]);
  }
  queue.push([root, '', 0]);

  let visited = 0;
  while (queue.length > 0 && visited < MAX_SAMPLE_DIRS) {
    const [absDir, relDir, depth] = queue.shift()!;
    visited++;
    let entries: Array<{ name: string; isDir: boolean }>;
    try {
      const dirents = await fs.readdir(absDir, { withFileTypes: true });
      entries = dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
    } catch {
      continue;
    }
    // 先看文件（同层命中即返回，保证"最浅最先"）
    for (const e of entries) {
      if (!e.isDir && isTestFile(e.name)) {
        return { relDir, fileName: e.name, absPath: join(absDir, e.name) };
      }
    }
    if (depth >= MAX_SAMPLE_DEPTH) continue;
    for (const e of entries) {
      if (e.isDir && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
        queue.push([join(absDir, e.name), relDir ? `${relDir}/${e.name}` : e.name, depth + 1]);
      }
    }
  }
  return undefined;
}

/** 提取测试文件头部的 import 段，供 LLM 新建测试时对齐风格 */
async function extractImportStyle(absPath: string): Promise<string | undefined> {
  const raw = await readFileSafe(absPath);
  if (!raw) return undefined;
  const lines: string[] = [];
  let chars = 0;
  const allLines = raw.split('\n');
  // 只扫头部 40 行：import 段必在文件开头，避免整文件遍历
  const limit = Math.min(allLines.length, 40);
  for (let i = 0; i < limit; i++) {
    const t = allLines[i]!.trim();
    if (
      t.startsWith('import ') ||
      t.startsWith('from ') ||
      (t.startsWith('const ') && t.includes('require(')) ||
      t.startsWith('#include') ||
      t.startsWith('use ')
    ) {
      lines.push(t);
      chars += t.length;
      if (chars >= MAX_IMPORT_STYLE_CHARS || lines.length >= 8) break;
    }
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}
