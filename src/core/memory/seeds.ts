/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 种子记忆（DESIGN §M6.4 / B-P3-4 · W5.11）
 *
 * 目标：首次启动或空仓库时，向 MemoryStore 注入 10 条工程侧域知识作为 `<memory_overview>`
 *  的初始内容，让模型在第一轮对话就拿到项目的关键规范/陷阱/技术栈上下文。
 *
 * 约束：
 *  - 所有条目使用 **可写类别**（WRITABLE_CATEGORIES）；系统沉淀类别不适用于种子。
 *  - 不覆盖已有记忆；`ensureSeedMemories()` 只在目标 scope 下记忆总数为 0 时写入。
 *  - 默认 scope='workspace'（随项目走）；调用方可传 globalRoot 切全局种子。
 */

import type { WritableCategory } from './categories.js';
import type { MemoryRecord, MemoryScope } from './types.js';
import type { MemoryStore } from './store.js';

/** 种子模板（不带 id/createdAt/updatedAt，由 store.create 赋值）。 */
export interface MemorySeed {
  readonly title: string;
  readonly content: string;
  readonly category: WritableCategory;
  readonly keywords: readonly string[];
  /** 默认 'workspace'。 */
  readonly scope?: MemoryScope;
}

/**
 * 10 条内置种子记忆（devseeker 工程侧通用域知识）。
 *
 * 分类分布（覆盖 4 大类）：
 *  - project_*        × 4  技术栈 / 构建 / SCM / 运行环境
 *  - development_*    × 4  代码 / 测试 / 注释 / 实践
 *  - expert_experience × 1 Prompt 前缀缓存
 *  - common_pitfalls_experience × 1  行号前缀泄漏陷阱
 */
export const BUILTIN_MEMORY_SEEDS: readonly MemorySeed[] = [
  {
    title: 'Tech Stack · TypeScript + VSCode Extension',
    content:
      '本工程基于 TypeScript（严格模式）+ VSCode Extension API（Host）+ vitest 单测 + pnpm 包管理。Node 20+ 运行时，ESM 产物。',
    category: 'project_tech_stack',
    keywords: ['typescript', 'vscode', 'extension', 'vitest', 'pnpm'],
  },
  {
    title: 'Build · esbuild bundle 入口与输出',
    content:
      '构建使用 esbuild（见 `build.mjs`），bundle 入口为 `src/extension.ts`，输出 `dist/extension.js`（CommonJS target，外部依赖 `vscode`）。单测直接跑源码（vitest 自带 ts 编译）。',
    category: 'project_build_configuration',
    keywords: ['esbuild', 'bundle', 'extension.ts', 'dist'],
  },
  {
    title: 'SCM · commit message workstream 前缀',
    content:
      'git commit message 必须带工作流前缀 `feat(B-P*-N): ...` 或 `feat(W*.*): ...`（对齐 ROADMAP 条目）。修复用 `fix()`，文档用 `docs()`。body 中文可接受。',
    category: 'project_scm_configuration',
    keywords: ['commit', 'git', 'workstream', 'roadmap'],
  },
  {
    title: 'Environment · Windows PowerShell 不支持 `&&`',
    content:
      '本项目常见开发环境为 Windows PowerShell；`&&` 不是合法语句分隔符，多命令拼接必须用 `;`。Unix/macOS bash 不受此限制。跨平台脚本优先写到 package.json scripts，避免 shell 差异。',
    category: 'project_environment_configuration',
    keywords: ['windows', 'powershell', 'shell', 'cross-platform'],
  },
  {
    title: 'Code Spec · TypeScript 严格模式 + 显式返回类型',
    content:
      '所有公共函数/方法必须有显式返回类型；禁止 `any`（用 `unknown` 或具体联合类型代替）；`strictNullChecks` + `noUncheckedIndexedAccess` 均启用。Error 对象用自定义 `AgentError` + 冻结的 `ErrorCodes` 常量。',
    category: 'development_code_specification',
    keywords: ['typescript', 'strict', 'any', 'AgentError', 'ErrorCodes'],
  },
  {
    title: 'Test Spec · vitest describe/it 命名 + 正负路径覆盖',
    content:
      '新写测试文件放 `tests/core/`；命名 `<module>.test.ts`；顶层 `describe("<module> · 子域")`；每个 it 必须覆盖一个正路径 + 关键负路径（错误码/边界）。Fake 实现优先，不依赖真实 VSCode / LSP / 子进程。',
    category: 'development_test_specification',
    keywords: ['vitest', 'describe', 'it', 'fake', 'coverage'],
  },
  {
    title: 'Comment Spec · 公共 API 中文 JSDoc + 文件 header',
    content:
      '所有公共类/函数需 JSDoc（中文可），首行一句概述 + 参数 + 抛出。文件头 block 说明模块来源（DESIGN §X.Y / ROADMAP W条目）。私有辅助函数可省注释。避免无意义的 `// 设置变量` 类注释。',
    category: 'development_comment_specification',
    keywords: ['jsdoc', 'comment', 'header', 'chinese'],
  },
  {
    title: 'Practice Spec · 小步修改 + 不做无关重构',
    content:
      'Bug 修复只动相关代码，不趁机做风格/命名等无关重构（另开 commit）。新增功能优先沿用现有抽象（接口/类/dep injection），避免引入重复抽象层。代码改动前先 read_file 完整上下文再编辑。',
    category: 'development_practice_specification',
    keywords: ['refactor', 'minimal', 'scope', 'context'],
  },
  {
    title: 'Expert · L0 Prompt 必须字节级稳定以命中前缀缓存',
    content:
      'L0 Prompt（identity + tools contracts + general behavior + memory policy）是前缀缓存命中的基石：任何修改都必须用 `prompt-builder-version.test.ts` + `prompt-cache-boundary.test.ts` 验证哈希恒等。Token-budget 裁剪只动 L2/L3，绝不触碰 L0/L1。',
    category: 'expert_experience',
    keywords: ['prompt', 'cache', 'L0', 'L1', 'hash', 'stable'],
  },
  {
    title: 'Pitfall · read_file 行号前缀不能泄漏到 search_replace',
    content:
      'read_file 返回的内容每行带 "   N→" 前缀（M3.9 协议），这是元数据**不是文件真实内容**。调用 search_replace 时 old_string / new_string 必须去除行号前缀，否则会命中 `TOOL_ARGS_INVALID`（detectLineNumberPrefix 拦截）。T19 金测专项校验此项。',
    category: 'common_pitfalls_experience',
    keywords: ['line-number', 'prefix', 'search_replace', 'T19', 'read_file'],
  },
] as const;

export interface EnsureSeedOptions {
  /** 目标 scope；默认 'workspace'。 */
  scope?: MemoryScope;
  /** 调用方可覆盖种子集（测试用）。默认 BUILTIN_MEMORY_SEEDS。 */
  seeds?: readonly MemorySeed[];
}

export interface EnsureSeedResult {
  /** 是否执行了种子写入（false 表示已存在记忆，跳过）。 */
  seeded: boolean;
  /** 实际创建的记忆数（seeded=false 时为 0）。 */
  created: number;
  /** 跳过原因（若 seeded=false）。 */
  skipReason?: 'already_has_memories';
  /** 创建的记录列表（顺序与 seeds 输入一致）。 */
  records?: readonly MemoryRecord[];
}

/**
 * 在 MemoryStore 下，若目标 scope 无任何记忆，则写入 `seeds`（默认 10 条）。
 *
 * - 已有 ≥1 条记忆（同 scope） → 跳过，不覆盖用户已有数据
 * - 若某条 seed 写入失败（如类别校验不过），抛出错误由调用方决定策略
 */
export async function ensureSeedMemories(
  store: MemoryStore,
  opts: EnsureSeedOptions = {},
): Promise<EnsureSeedResult> {
  const scope = opts.scope ?? 'workspace';
  const seeds = opts.seeds ?? BUILTIN_MEMORY_SEEDS;

  const existing = await store.list({ scope });
  if (existing.length > 0) {
    return { seeded: false, created: 0, skipReason: 'already_has_memories' };
  }

  const created: MemoryRecord[] = [];
  for (const s of seeds) {
    const rec = await store.create({
      title: s.title,
      content: s.content,
      category: s.category,
      keywords: [...s.keywords],
      scope: s.scope ?? scope,
    });
    created.push(rec);
  }
  return { seeded: true, created: created.length, records: created };
}
