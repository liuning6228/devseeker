/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * AmbiguityDetector —— 智能澄清触发器（F1）
 *
 * 职责：
 * - 分析用户输入消息，检测模糊度
 * - 返回模糊信号列表 + 总体评分
 * - 纯函数，零外部依赖，仅操作字符串
 *
 * 设计要点：
 * - 不依赖 TaskContext 类型（fix P2: 解决此前适配问题）
 * - 四种信号按严重程度排序: vague_goal > missing_scope > missing_context > missing_constraint
 * - 阈值建议: score > 0.6 触发澄清
 * - 只会对**首次用户消息**生效
 */

export type AmbiguityType = 'missing_scope' | 'missing_constraint' | 'missing_context' | 'vague_goal';

export interface AmbiguitySignal {
  type: AmbiguityType;
  /** 严重程度 0-1 */
  severity: number;
  /** 拟向用户提出的澄清问题 */
  question: string;
}

export interface AmbiguityResult {
  /** 总体模糊度 0-1 */
  score: number;
  /** 触发的信号列表 */
  signals: AmbiguitySignal[];
}

/**
 * 检测用户输入消息的模糊度。
 * @param message 用户输入的原始文本
 * @param fileRefCount 用户消息中引用的文件路径数量（由调用方提供）
 * @returns AmbiguityResult
 */
export function detectAmbiguity(message: string, fileRefCount = 0): AmbiguityResult {
  const signals: AmbiguitySignal[] = [];

  const scopeSignal = detectMissingScope(message);
  if (scopeSignal) signals.push(scopeSignal);

  const constraintSignal = detectMissingConstraint(message);
  if (constraintSignal) signals.push(constraintSignal);

  const contextSignal = detectMissingContext(message, fileRefCount);
  if (contextSignal) signals.push(contextSignal);

  const vagueSignal = detectVagueGoal(message);
  if (vagueSignal) signals.push(vagueSignal);

  const score = signals.length > 0
    ? signals.reduce((sum, s) => sum + s.severity, 0) / signals.length
    : 0;

  return { score, signals };
}

/**
 * 检测是否缺少修改范围（文件/目录/模块）。
 * 用户没说"改哪个文件/目录"时触发。
 */
function detectMissingScope(message: string): AmbiguitySignal | null {
  // 忽略纯英文技术提问（如 "what is async/await"）
  const isQuestionOnly = /^(what|how|why|is|are|can|does|do)\b/i.test(message.trim());
  if (isQuestionOnly) return null;

  // 已指定范围则跳过
  const hasScope = /src\/|app\/|lib\/|packages\/|模块|文件|目录|component|page|route|service|hook/i.test(message);
  if (hasScope) return null;

  return {
    type: 'missing_scope',
    severity: 0.7,
    question: '你希望我修改哪些文件或模块？是整个项目还是特定目录？',
  };
}

/**
 * 检测是否缺少约束条件。
 * 用户没说"有什么限制"时触发。
 */
function detectMissingConstraint(message: string): AmbiguitySignal | null {
  const hasConstraint = /不要|避免|保持|兼容|限制|keep|preserve|don't|avoid|compatible/i.test(message);
  if (hasConstraint) return null;

  return {
    type: 'missing_constraint',
    severity: 0.5,
    question: '有什么需要特别注意的限制吗？比如向后兼容、性能要求、或不想改动的部分？',
  };
}

/**
 * 检测是否缺少上下文引用。
 * 用户没贴代码也没列文件路径时触发。
 */
function detectMissingContext(message: string, fileRefCount: number): AmbiguitySignal | null {
  // 纯问句（"什么是 X" / "How to X"）不触发
  const isPureQuestion = /^(what|how|why|is|are|can|does|where|which)\b/i.test(message.trim());

  // 已包含代码片段或文件引用则不触发
  const hasCodeSnippet = message.includes('```') || message.includes('`');
  if (hasCodeSnippet) return null;

  if (fileRefCount > 0) return null;

  // 纯问句不触发
  if (isPureQuestion) return null;

  return {
    type: 'missing_context',
    severity: 0.6,
    question: '能否提供相关的代码片段或文件路径，方便我准确定位？',
  };
}

/**
 * 检测模糊的目标描述。
 * 用"优化/改进/清理/整理"等笼统词汇时触发。
 */
function detectVagueGoal(message: string): AmbiguitySignal | null {
  const vaguePatterns = [
    /\b优化\b/, /\b改进\b/, /\b更好\b/, /\b清理\b/, /\b整理\b/,
    /\b提升\b/, /\b完善\b/, /\benhance\b/i, /\bimprove\b/i, /\bclean\b/i,
    /\brefactor\b/i, /\boptimize\b/i,
  ];

  const hasVague = vaguePatterns.some(p => p.test(message));
  if (!hasVague) return null;

  return {
    type: 'vague_goal',
    severity: 0.8,
    question: '"优化/改进"具体指什么？是性能、可读性、代码风格、架构还是其他方面？',
  };
}
