/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 梯度验证门（CVW §4.3）
 *
 * 本文件只放**纯决策与纯文本生成**：
 *   - decideGate：给定门状态快照，判定 allow / soft-prompt / hard-verify；
 *   - buildGatePrompt / buildFixPrompt / buildUnverifiedWarning：注入文本生成。
 *
 * 副作用（history.addUser 注入、runSubagent 派发、状态流转）全部留在 TaskLoop，
 * 便于本文件被单测直接覆盖（无 vscode / node:fs 依赖）。
 *
 * 决策优先级（自上而下短路）：
 *   1. 关门 / 无编辑 / 已验证 → 放行（零开销路径）
 *   2. 预算耗尽（修复轮次、门提示次数、任务轮次）→ 放行并标注未验证
 *   3. 梯度拦截：soft 优先（低成本），hard 兜底（确定性）
 */

import {
  MAX_SOFT_PROMPTS,
  type GateDecision,
  type TestPlan,
  type TestRunSummary,
  type VerificationConfig,
  type VerificationState,
  type VerificationTier,
} from './types.js';

/** 门决策所需的状态快照（由 TaskLoop 组装） */
export interface GateInput {
  config: VerificationConfig;
  state: VerificationState;
  /** 本任务已编辑的文件数 */
  editedFileCount: number;
  /** 当前轮次（1-based，与 TaskLoop turn 一致） */
  turn: number;
  maxTurns: number;
  /** 已注入的验证指令次数 */
  gatePromptCount: number;
  /** 已消耗的修复轮次 */
  fixRounds: number;
  /** 降级链级别（decideTier 产出） */
  tier: VerificationTier;
  /** hard 门是否已派发过 Verify 子代理 */
  hardAttempted: boolean;
}

/**
 * 判定验证门动作。纯函数，无副作用。
 */
export function decideGate(input: GateInput): GateDecision {
  const { config, state, tier } = input;

  // ── 1. 零开销放行路径 ──
  if (config.gate === 'off') {
    return { action: 'allow', reason: 'gate-off' };
  }
  if (input.editedFileCount === 0 || state === 'NotEdited') {
    return { action: 'allow', reason: 'no-edits' };
  }
  if (state === 'Passed') {
    return { action: 'allow', reason: 'already-verified' };
  }
  if (state === 'Exceeded') {
    return {
      action: 'allow',
      reason: 'budget-exceeded',
      warning: buildUnverifiedWarning('fix-budget', input.fixRounds),
    };
  }

  // ── 2. 预算与安全阀 ──
  // 最后一轮强制放行：门绝不能把任务拖成 max_turns 失败
  if (input.turn >= input.maxTurns) {
    return {
      action: 'allow',
      reason: 'turn-budget',
      warning: buildUnverifiedWarning('turn-budget'),
    };
  }
  if (input.fixRounds >= config.maxFixRounds) {
    return {
      action: 'allow',
      reason: 'fix-budget',
      warning: buildUnverifiedWarning('fix-budget', input.fixRounds),
    };
  }

  // ── 3. 分级拦截 ──
  // 3a. 验证确实跑过但失败 → 修复路径。预算由 maxFixRounds 控制（上方已检），
  // 不受 MAX_SOFT_PROMPTS 约束——两者是两个独立预算：前者管“改不好”，
  // 后者管“不肯跑测试”。否则 gatePromptCount 会先触顶，maxFixRounds 永远用不到。
  if (state === 'Failed') {
    return { action: 'soft-prompt', reason: `fix-round-${input.fixRounds}` };
  }

  // 3b. 未检测到验证执行 → 提醒路径，预算 MAX_SOFT_PROMPTS
  // hard 模式：首次仍用 soft（成本最低），未奏效再程序化派发子代理
  const canHard = config.gate === 'hard' && !input.hardAttempted;
  if (canHard && input.gatePromptCount >= 1) {
    return { action: 'hard-verify', reason: 'soft-ineffective' };
  }
  if (input.gatePromptCount < MAX_SOFT_PROMPTS) {
    return {
      action: 'soft-prompt',
      reason: tier === 'L4-manual' ? 'manual-checklist' : `soft-${tier}`,
    };
  }
  if (canHard) {
    return { action: 'hard-verify', reason: 'soft-exhausted' };
  }

  return {
    action: 'allow',
    reason: 'soft-exhausted',
    warning: buildUnverifiedWarning(
      tier === 'L4-manual' ? 'manual-only' : 'no-test-run',
    ),
  };
}

/** 未验证放行的原因分类 */
export type UnverifiedReason = 'fix-budget' | 'turn-budget' | 'no-test-run' | 'manual-only' | 'parse-error';

/**
 * 生成"未验证放行"警示语。绝不静默吞掉失败（§4.3 C.4）。
 */
export function buildUnverifiedWarning(reason: UnverifiedReason, fixRounds?: number): string {
  switch (reason) {
    case 'fix-budget':
      return `⚠️ 验证未通过（${fixRounds ?? '多'} 轮修复未收敛）：变更已保留，请人工复核测试结果后再合并。`;
    case 'turn-budget':
      return '⚠️ 变更未验证（任务轮次预算耗尽）：请手动运行受影响测试确认。';
    case 'no-test-run':
      return '⚠️ 变更未验证（未检测到测试命令执行）：请手动运行受影响测试确认。';
    case 'manual-only':
      return '⚠️ 本次变更无法自动验证（无可执行测试/构建），已按人工验证清单交付。';
    case 'parse-error':
      return '⚠️ 测试输出无法解析，验证结论不确定：请人工确认测试是否全绿。';
  }
}

/** 验证指令文本的组装上下文 */
export interface GatePromptContext {
  tier: VerificationTier;
  /** 展示用的变更文件清单（工作区相对路径） */
  editedFiles: string[];
  plan: TestPlan;
  /** 建议执行的命令（L1/L2 测试命令，L3 构建/类型检查命令） */
  command: string;
  /** 受影响测试文件（为空表示未映射到现有测试） */
  testFiles: string[];
  /** 第几次注入（1-based），用于加重语气 */
  attempt: number;
  /** 上一次的失败摘要（修复循环时存在） */
  lastSummary?: TestRunSummary | undefined;
  /** 影响分析补充说明 */
  note?: string | undefined;
}

/** 展示用文件清单上限 */
const MAX_LISTED_FILES = 8;

/**
 * 生成注入模型的验证指令（soft 门 / 修复循环共用）。
 *
 * 注入通道必须是 `history.addUser()`（历史尾部追加，前缀缓存全命中），
 * 不可改写 system 消息 —— 那会让其后所有缓存失效（§4.3 C.3）。
 */
export function buildGatePrompt(ctx: GatePromptContext): string {
  const lines: string[] = ['[Verification Gate] 本任务已修改代码，收尾前必须完成验证。'];

  lines.push(`变更文件（${ctx.editedFiles.length}）：${formatFileList(ctx.editedFiles)}`);
  if (ctx.attempt > 1) {
    lines.push(`这是第 ${ctx.attempt} 次提醒：上一轮未检测到测试命令执行，请勿仅口头声称已验证。`);
  }

  if (ctx.lastSummary && ctx.lastSummary.status === 'failed') {
    lines.push('');
    lines.push('上一次验证结果：❌ 未通过');
    lines.push(renderFailureLines(ctx.lastSummary));
    lines.push('请先修复上述失败，再重新运行同一命令确认全绿。');
  }

  lines.push('');
  lines.push(...tierInstructions(ctx));

  lines.push('');
  lines.push('完成后按此格式给出最终答复的验证段：');
  lines.push('Status: ✅ PASSED / ❌ FAILED / ⚠️ UNVERIFIED');
  lines.push('Commands run: <实际执行的命令>');
  lines.push('Counts: <passed>/<failed>（若适用）');
  lines.push('Next step: <若未通过，下一步动作>');

  return lines.join('\n');
}

/** 分级验证指令（§4.6 降级链） */
function tierInstructions(ctx: GatePromptContext): string[] {
  const out: string[] = [];
  switch (ctx.tier) {
    case 'L1-test':
      out.push('验证方式（L1 测试级）：运行受影响测试');
      out.push(`命令：\`${ctx.command}\``);
      if (ctx.testFiles.length > 0) {
        out.push(`受影响测试：${formatFileList(ctx.testFiles)}`);
      }
      break;
    case 'L2-new-test':
      out.push('验证方式（L2 补测级）：未映射到现有测试，请先判断风险等级');
      out.push('- 核心逻辑/算法/协议/状态机变更 → 新建一个 focused 冒烟测试后执行；');
      out.push('- 纯展示/配置/注释/文案变更 → 执行类型检查或 lint 即可，无需新建测试。');
      out.push(`新建测试请遵循项目约定：目录 \`${ctx.plan.conventions.testDir}\`，命名 \`${ctx.plan.conventions.filePattern}\`。`);
      if (ctx.plan.conventions.importStyle) {
        out.push(`现有测试的 import 风格参考：\n${ctx.plan.conventions.importStyle}`);
      }
      out.push(`测试命令：\`${ctx.command || ctx.plan.testCommand}\``);
      break;
    case 'L3-build':
      out.push('验证方式（L3 编译级）：本项目无可在主机运行的测试（交叉工具链或无测试框架），只验证编译/类型检查，**不要尝试运行目标程序**。');
      out.push(`命令：\`${ctx.command || ctx.plan.buildCommand || ctx.plan.typecheckCommand || ''}\``);
      break;
    case 'L4-manual':
      out.push('验证方式（L4 人工清单）：本项目未探测到可执行的测试或构建命令。');
      out.push('请在最终答复中给出**人工验证清单**：每项包含「操作步骤 → 预期现象」，并明确声明"未执行运行时验证"。');
      break;
    case 'L0-diagnostic':
      out.push('验证方式（L0 诊断级）：确认编辑后诊断无错误（编辑后诊断已自动注入上文）。');
      break;
  }
  if (ctx.note) out.push(`补充：${ctx.note}`);
  if (ctx.plan.crossToolchain) {
    out.push('注意：检测到交叉编译工具链，构建产物无法在开发机执行。');
  }
  return out;
}

/**
 * 生成修复指令（hard 门 Verify 子代理报告失败后注入）。
 */
export function buildFixPrompt(summary: TestRunSummary, command: string): string {
  const lines = [
    '[Verification Gate] 程序化验证失败，请修复后重新验证。',
    `执行的命令：\`${command}\``,
    renderFailureLines(summary),
    '修复原则：只改导致失败的实现或测试预期本身错误之处，不得删除/跳过测试让其变绿。',
  ];
  return lines.join('\n');
}

function renderFailureLines(summary: TestRunSummary): string {
  const parts = [`失败数：${summary.failed}，通过数：${summary.passed}`];
  for (const f of summary.firstFailures) {
    const loc = f.file ? `${f.file}${f.line !== undefined ? `#L${f.line}` : ''}` : '(未知位置)';
    parts.push(`- ${loc} — ${f.name}: ${f.cause}`);
  }
  return parts.join('\n');
}

function formatFileList(files: string[]): string {
  if (files.length === 0) return '（无）';
  const shown = files.slice(0, MAX_LISTED_FILES).join(', ');
  return files.length > MAX_LISTED_FILES ? `${shown} 等 ${files.length} 个` : shown;
}

/**
 * 纯输出/查看类命令：参数里出现测试命令文本不代表真的跑过验证。
 * 缺了这层过滤，`echo "npx vitest run"` 会命中兜底正则被当成已验证——
 * 恰好是本机制要防的"口头验证"绕过。
 */
const NON_EXECUTING_HEADS = new Set([
  'echo', 'printf', 'cat', 'head', 'tail', 'less', 'more',
  'grep', 'rg', 'sed', 'awk', 'ls', 'find', 'which', 'type', 'man',
]);

/** 只影响执行环境、不改变"实际被执行命令"的前缀包装 */
const TRANSPARENT_HEADS = new Set([
  'sudo', 'time', 'env', 'nohup', 'command', 'exec', 'cd',
  'bash', 'sh', 'zsh', 'dash',
]);

/** 测试 runner 可执行名（出现在命令位即可判定） */
const RUNNER_TOKENS = new Set(['vitest', 'jest', 'mocha', 'pytest', 'ctest', 'mypy']);

/** 命令位窗口：runner 只可能出现在前几个实参 token（`npx vitest run` / `poetry run pytest`） */
const CMD_POSITION_WINDOW = 3;

/**
 * 判断 bash 命令是否命中验证命令（客观放行信号，§4.3 C.3）。
 *
 * 三层判定，先拆子命令再逐段匹配：
 * 1. 拆分 shell 分隔符（`&&` / `||` / `;` / `|` / 换行），并丢弃纯输出类子命令；
 * 2. 计划命令匹配：首 token 必须为子命令的可执行名，其余按保序子序列（容忍追加参数/flag）；
 * 3. 通用兜底：runner 必须出现在**命令位**（前 3 个实参 token），避开
 *    `git commit -m "npm test"` 这类仅提及关键字的命令。
 *
 * @param command 模型实际执行的 bash 命令
 * @param plan 当前测试计划
 * @param extra 额外视为验证命令的字符串（如影响分析组装出的命令）
 */
export function isVerificationCommand(
  command: string,
  plan: TestPlan,
  extra: string[] = [],
): boolean {
  const cmd = command.trim().toLowerCase();
  if (!cmd) return false;

  const heads = [plan.testCommand, plan.typecheckCommand, plan.buildCommand, ...extra]
    .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    .map((c) => significantTokens(c, 3))
    .filter((h) => h.length > 0);

  for (const segment of cmd.split(/&&|\|\||[;|\n]/)) {
    const tokens = executableTokens(segment);
    if (tokens.length === 0) continue;
    if (NON_EXECUTING_HEADS.has(basename(tokens[0]!))) continue;

    for (const head of heads) {
      // 首 token 锚定：避免 `git commit -m "npm test"` 被子序列误命中
      if (head[0] === tokens[0] && isSubsequence(head, tokens)) return true;
    }
    if (looksLikeVerificationRun(tokens, segment)) return true;
  }
  return false;
}

/** 通用兜底：命令位上是否为常见测试/类型检查/构建执行形态 */
function looksLikeVerificationRun(tokens: string[], segment: string): boolean {
  const head = tokens.slice(0, CMD_POSITION_WINDOW).map(basename);
  if (head.some((t) => RUNNER_TOKENS.has(t))) return true;
  // tsc 必须带 --noEmit，否则是产物编译而非类型检查
  if (head.includes('tsc') && /--no-?emit/.test(segment)) return true;

  const joined = head.join(' ');
  return /\b(?:go|cargo)\s+test\b/.test(joined)
    || /\bcargo\s+check\b/.test(joined)
    || /\bmake\s+(?:test|check)\b/.test(joined)
    || /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|type-check|typecheck|build)\b/.test(joined);
}

/**
 * 提取子命令中"实参" token：剥引号、丢 flag 与环境变量赋值、跳过透明包装前缀。
 *
 * 例：`CI=1 sudo bash -lc 'npx vitest run'` → `['npx', 'vitest', 'run']`
 */
function executableTokens(segment: string): string[] {
  const out: string[] = [];
  for (const raw of segment.split(/\s+/)) {
    const t = raw.replace(/^['"`(]+/, '').replace(/['"`)]+$/, '');
    if (!t) continue;
    if (t.startsWith('-')) continue;
    if (/^[a-z_][a-z0-9_]*=/.test(t)) continue;
    // out 为空期间持续剥离 sudo/bash 等包装，使命令位对齐真实可执行文件
    if (out.length === 0 && TRANSPARENT_HEADS.has(basename(t))) continue;
    out.push(t);
  }
  return out;
}

function basename(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1);
}

/**
 * 提取命令中的判别性 token（丢弃 flag 参数）。
 *
 * 保留 npm/npx 等 runner —— 判定用子序列匹配，runner 是有效判别信息；
 * 若模型换了等价 runner（`npx vitest` vs `npm test`），由通用兜底正则覆盖。
 *
 * @param limit >0 时只取前 limit 个 token（0 表示不限）
 */
function significantTokens(command: string, limit: number): string[] {
  const tokens = command
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t && !t.startsWith('-'));
  return limit > 0 ? tokens.slice(0, limit) : tokens;
}

/** needle 是否为 haystack 的子序列（保序、可跳过） */
function isSubsequence(needle: string[], haystack: string[]): boolean {
  let i = 0;
  for (const h of haystack) {
    if (h === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}
