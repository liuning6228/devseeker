/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Reasoning Probe —— 复杂度探测器（W15.5 Auto-Thinking-Router）
 *
 * 目标：纯启发式（零 LLM 调用、零延迟）判断 userInput 是否应该走 reasoning 模型。
 *
 * 信号维度（按我方经验排序）：
 *   1. 关键词命中（中英双语：证明/推导/算法/设计/优化 / prove/derive/algorithm/optimize …）
 *   2. 长文本（>1500 chars 视为复杂上下文）
 *   3. 代码围栏数（≥3 个 ``` 视为多文件/多片段分析）
 *   4. 数学/LaTeX 标记（$$ / \begin / \int / \sum / \forall …）
 *   5. 多步指令关键字（逐步 / 一步步 / step by step / think step by step）
 *   6. 错误日志/堆栈特征（Error/TypeError/FAIL/Traceback/at file:line:col）
 *
 * 聚合规则：命中信号数 ≥2 → needsReasoning=true。
 *   - math / stepwise / error-log 为高质量信号，单独即可触发。
 * 单一长文本信号默认不触发（避免粘贴大段代码就乱切 reasoner），需与其它信号叠加。
 *
 * 不在本模块做的事：
 *   - 不看图片（VLM 走独立 vision 路由）
 *   - 不看 priorMessages（只探本轮 userInput）
 *   - 不做 LLM 二次判定（留给 W15.2 推理缓存阶段）
 */

export interface ReasoningProbeResult {
  /** 是否应切 reasoning 模型 */
  needed: boolean;
  /** 累计命中信号数（用于 UI/日志排查） */
  score: number;
  /** 命中的具体信号名称（有序） */
  signals: string[];
}

/**
 * 中英双语 reasoning 关键词（命中任意一个计 1 分）。
 * 精选高信噪比词，避免 "写代码/ code / function" 这类高频词误伤。
 */
const REASONING_KEYWORDS_RE =
  /(证明|推导|推理|算法(设计|优化|复杂度)?|复杂度|最优解|最优化|数学归纳|形式化|正确性证明|并发安全|线程安全|时间复杂度|空间复杂度|NP[- ]?hard|状态机分析|不变式|invariant|分析为什么|为何(会|是)|排查|深度分析|深入分析|架构设计|权衡|取舍|trade[- ]?off|重构方案|根因|root cause|死锁|race condition|数据一致性|事务隔离|CAP|BASE|分布式共识|Paxos|Raft|报错|崩溃|异常|不工作|不生效|失效|卡死|无响应|白屏|黑屏|闪退|堆栈|调用栈|出错了|怎么回事|为什么不|无法启动|加载失败)|\b(prove|derive|derivation|algorithm|optimize|optimal|complexity|formal(ly)?|reasoning|proof|theorem|induction|invariant|concurren(cy|t)|deadlock|race[- ]?condition|refactor(ing)?\s+strateg|architect(ure|ural)\s+(design|trade|decision)|bug|crash(?:ed)?|error|exception|broken|not working|won'?t work|stack[- ]?trace|traceback|undefined is|null pointer|segfault|panic|TypeError|ReferenceError|SyntaxError|fails?)\b/i;

/** 数学/LaTeX 信号 */
const MATH_RE = /(\$\$|\\begin\{|\\int|\\sum|\\forall|\\exists|\\mathbb|\\lim|\\frac\{)/;

/** 多步指令（"逐步 / step by step / think step by step"） */
const STEPWISE_RE =
  /(逐步|一步步|一步一步|step[- ]?by[- ]?step|think\s+step|chain[- ]?of[- ]?thought|分步(骤|推导|思考)?)/i;

/** 代码围栏计数（``` 三引号块） */
function countCodeFences(text: string): number {
  const m = text.match(/```/g);
  return m ? Math.floor(m.length / 2) : 0;
}

/** 错误日志/堆栈信号（高信噪比，单独即可触发） */
const ERROR_LOG_RE =
  /(Error|TypeError|ReferenceError|SyntaxError|RangeError|FAIL|FAILED|panic:|Traceback|at\s+\w+\s+\(.*:\d+:\d+\)|^\s+at\s+.*:\d+)/m;

/**
 * 探测 userInput 是否需要 reasoning 模型。
 *
 * @param userInput 本轮用户文本（已合并 selectedCodes / gitContext 拼接前的原始输入即可）
 * @returns ReasoningProbeResult
 */
export function detectReasoningNeed(userInput: string): ReasoningProbeResult {
  const signals: string[] = [];
  const text = (userInput ?? '').trim();
  if (text.length === 0) {
    return { needed: false, score: 0, signals };
  }

  // 1. 关键词
  if (REASONING_KEYWORDS_RE.test(text)) signals.push('keyword');
  // 2. 数学
  if (MATH_RE.test(text)) signals.push('math');
  // 3. 多步指令
  if (STEPWISE_RE.test(text)) signals.push('stepwise');
  // 4. 代码围栏 ≥3
  const fences = countCodeFences(text);
  if (fences >= 3) signals.push('multi-code-blocks');
  // 5. 长文本（辅助信号，需叠加其它才生效）
  if (text.length >= 1500) signals.push('long-input');
  // 6. 错误日志/堆栈特征（高质量信号，单独即可触发）
  if (ERROR_LOG_RE.test(text)) signals.push('error-log');

  // 规则：
  //   - 命中 math / stepwise / error-log 单独即可触发（信号质量高）
  //   - 其它组合需 ≥2 信号聚合
  const hasHighQuality =
    signals.includes('math') || signals.includes('stepwise') || signals.includes('error-log');
  const needed = hasHighQuality || signals.length >= 2;

  return {
    needed,
    score: signals.length,
    signals,
  };
}

// ── T6 · Debug 模式自动决策 ──

/**
 * BUG 信号检测：判断用户输入是否描述了 BUG，应切换到 debug 模式。
 *
 * 与 detectReasoningNeed 的区别：
 * - detectReasoningNeed 判断是否需要 reasoning 模型（关注复杂度）
 * - detectDebugNeed 判断是否需要 debug 模式（关注是否是 BUG 场景）
 *
 * 触发条件（任一命中即 needed=true）：
 * 1. 粘贴了错误日志/堆栈（Error/TypeError/Traceback/at file:line:col）
 * 2. 显式 BUG 描述意图（“报错了”/“不工作”/“崩溃”/“fix bug”/“crash”）
 * 3. 包含错误码/退出码（exit code 1 / error code E001 / HTTP 500）
 */
export interface DebugProbeResult {
  needed: boolean;
  /** 0-1，用于区分 auto_debug vs suggest_debug */
  confidence: number;
  signals: string[];
}

const BUG_EXPLICIT_RE =
  /(报错|出错了|不工作了?|不生效|失效|崩溃|卡死|无响应|白屏|黑屏|闪退|怎么回事|为什么不行|无法启动|加载失败|出了(个|一)个?bug|调试|排错)|\b(fix (the )?bug|it'?s broken|doesn'?t work|won'?t work|crash|crashed|failing test|test failed|exit code \d|error code)\b/i;

const ERROR_LOG_STRONG_RE =
  /(TypeError|ReferenceError|SyntaxError|RangeError|Error:|FAIL\s|FAILED|panic:|Traceback|^\s+at\s+.*:\d+:\d+)/m;

const ERROR_CODE_RE =
  /(error\s+code\s+\w+|exit\s+code\s+\d+|HTTP\s+[45]\d{2}|status\s+[45]\d{2})/i;

export function detectDebugNeed(userInput: string): DebugProbeResult {
  const signals: string[] = [];
  const text = (userInput ?? '').trim();
  if (text.length === 0) return { needed: false, confidence: 0, signals };

  if (ERROR_LOG_STRONG_RE.test(text)) signals.push('error-log');
  if (BUG_EXPLICIT_RE.test(text)) signals.push('bug-keyword');
  if (ERROR_CODE_RE.test(text)) signals.push('error-code');

  const needed = signals.length > 0;
  // 多信号叠加 = 高置信度
  const confidence = signals.length >= 2 ? 0.9 : signals.length === 1 ? 0.6 : 0;

  return { needed, confidence, signals };
}
