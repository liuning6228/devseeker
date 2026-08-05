/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 记忆自动提炼 —— prompt 模板与类型定义（P0）
 *
 * 两条提炼路径：
 * - syncTurn：每轮对话结束后，从 user/assistant 文本中提取即时记忆
 * - onSessionEnd：会话关闭时，从完整 messages 中批量提取任务总结
 *
 * 设计约束：
 * - 提炼调用使用 Agent 配置的 LLM，但使用轻量参数（低 max_tokens）
 * - 提炼失败静默降级（记日志，不阻断对话）
 * - syncTurn 最多提炼 3 条记忆
 * - onSessionEnd 最多提炼 5 条记忆
 */

import type { MemoryCategory } from './categories.js';

/** 提炼出的单条记忆 */
export interface ExtractedMemory {
  title: string;
  content: string;
  category: MemoryCategory;
  keywords: string[];
}

/** 提炼器接口 —— 解耦 LLM 调用细节 */
export interface MemoryExtractorFn {
  (prompt: string, maxTokens: number): Promise<string>;
}

/** syncTurn 提炼上限 */
export const SYNC_TURN_MAX_MEMORIES = 3;
/** onSessionEnd 提炼上限 */
export const SESSION_END_MAX_MEMORIES = 5;

/**
 * syncTurn prompt：从单轮对话中提取即时记忆。
 * 聚焦踩坑记录、决策依据、项目知识。
 */
export function buildSyncTurnExtractionPrompt(
  userContent: string,
  assistantContent: string,
): string {
  return `你是一个记忆提取助手。请从以下对话中提取有价值的记忆条目。

## 提取规则
- 只提取真正有价值的信息：踩坑记录、技术决策、项目知识、工具使用经验
- 忽略寒暄、重复信息、已在记忆中存在的内容
- 每条记忆必须具体、可操作，不要泛泛而谈
- 最多提取 ${SYNC_TURN_MAX_MEMORIES} 条

## 类别选择
从以下类别中选择最匹配的：
- common_pitfalls_experience: 踩坑记录（遇到了什么问题，怎么解决的）
- important_decision_experience: 技术决策（为什么选择某个方案）
- project_tech_stack: 项目技术栈信息
- project_build_configuration: 构建配置信息
- tool_experience: 工具使用经验
- learned_skill_experience: 学到的技能/方法

## 输出格式
严格输出 JSON 数组，每个元素包含：
\`\`\`json
[
  {
    "title": "简短标题（5-20字）",
    "content": "具体内容（20-200字，必须包含关键细节）",
    "category": "类别名",
    "keywords": ["关键词1", "关键词2", "关键词3"]
  }
]
\`\`\`

如果没有值得提取的内容，输出空数组：[]

## 对话内容

**用户**：
${truncate(userContent, 2000)}

**助手**：
${truncate(assistantContent, 3000)}

请输出 JSON 数组：`;
}

/**
 * onSessionEnd prompt：从完整会话中提取任务总结和经验。
 * 聚焦任务流程、参考文件、踩坑经验。
 */
export function buildSessionEndExtractionPrompt(
  taskGoal: string,
  keyActions: string[],
  finalOutcome: string,
): string {
  const actionsText = keyActions.slice(0, 30).join('\n');
  return `你是一个记忆提取助手。请从以下任务执行记录中提取有价值的记忆。

## 提取规则
- 提取任务总结（task_summary_experience）：任务目标、关键步骤、最终结果
- 提取踩坑经验（common_pitfalls_experience）：遇到的问题和解决方案
- 提取参考文件（history_task_reference_files）：任务中涉及的关键文件
- 最多提取 ${SESSION_END_MAX_MEMORIES} 条

## 输出格式
严格输出 JSON 数组：
\`\`\`json
[
  {
    "title": "简短标题",
    "content": "具体内容",
    "category": "task_summary_experience | common_pitfalls_experience | history_task_reference_files",
    "keywords": ["关键词1", "关键词2"]
  }
]
\`\`\`

如果没有值得提取的内容，输出空数组：[]

## 任务信息

**任务目标**：
${truncate(taskGoal, 500)}

**关键操作序列**：
${actionsText}

**最终结果**：
${truncate(finalOutcome, 1000)}

请输出 JSON 数组：`;
}

/**
 * 快速预判：对话是否值得调用 LLM 提炼。
 * 避免对短文本、纯寒暄等低价值对话浪费 LLM 调用。
 */
export function shouldExtractFromTurn(
  userContent: string,
  assistantContent: string,
): boolean {
  const combined = `${userContent} ${assistantContent}`;

  // 纯寒暄关键词 → 跳过（优先于信号词检查，避免“有问题随时问我”误触发）
  const smallTalkPatterns = [
    /^(好的|ok|thanks|谢谢|明白了|了解|收到|嗯|是的|对)\s*[.!?。！？]*$/i,
    /^(hi|hello|hey|你好|在吗)\s*[.!?。！？]*$/i,
  ];
  const userTrimmed = userContent.trim().toLowerCase();
  if (smallTalkPatterns.some((p) => p.test(userTrimmed))) {
    return false;
  }

  // 包含错误/决策/配置等信号词 → 值得提取
  const signalPatterns = [
    /error|错误|失败|bug|问题|异常|exception/i,
    /决定|选择|方案|为什么|because|decided/i,
    /配置|config|设置|环境|environment/i,
    /注意|记住|remember|important|关键/i,
    /不要|避免|avoid|不要忘|don't forget/i,
  ];
  const hasSignal = signalPatterns.some((p) => p.test(combined));
  if (hasSignal) {
    return true;
  }

  // 文本过短（双方都很短且无信号词）→ 跳过
  if (userContent.length < 20 && assistantContent.length < 50) {
    return false;
  }

  // assistant 回复较长且包含代码 → 可能有技术细节
  if (assistantContent.length > 300 && /```|function|class|const|let|var/.test(assistantContent)) {
    return true;
  }

  // 默认：assistant 回复超过 800 字 → 值得看看
  return assistantContent.length > 800;
}

/**
 * 解析 LLM 输出的 JSON 数组。
 * 容错处理：处理 markdown 代码块包裹、多余文本等情况。
 */
export function parseExtractionResult(raw: string): ExtractedMemory[] {
  if (!raw || !raw.trim()) return [];

  let jsonStr = raw.trim();

  // 尝试提取 markdown 代码块中的 JSON
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  // 尝试提取第一个 [ ... ] 区间
  const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    jsonStr = arrayMatch[0];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const results: ExtractedMemory[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const { title, content, category, keywords } = item as Record<string, unknown>;
    if (
      typeof title === 'string' && title.trim() &&
      typeof content === 'string' && content.trim() &&
      typeof category === 'string' && category.trim()
    ) {
      results.push({
        title: title.trim(),
        content: content.trim(),
        category: category.trim() as MemoryCategory,
        keywords: Array.isArray(keywords)
          ? keywords.filter((k): k is string => typeof k === 'string').slice(0, 6)
          : [],
      });
    }
  }

  return results;
}

/**
 * 从 messages 中提取关键操作摘要。
 * 用于 onSessionEnd 的输入。
 */
export function summarizeSessionMessages(
  messages: Array<{ role: string; content?: string; tool_calls?: unknown[]; name?: string }>,
): { taskGoal: string; keyActions: string[]; finalOutcome: string } {
  let taskGoal = '';
  const keyActions: string[] = [];
  let finalOutcome = '';

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    // 第一条 user message 作为任务目标
    if (!taskGoal && msg.role === 'user' && msg.content) {
      taskGoal = msg.content.slice(0, 500);
    }

    // 收集工具调用作为关键操作
    if (msg.role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls as Array<{ function?: { name?: string; arguments?: string } }>) {
        const fnName = tc.function?.name;
        if (fnName) {
          const argsPreview = tc.function?.arguments
            ? truncate(tc.function.arguments, 100)
            : '';
          keyActions.push(`- ${fnName}(${argsPreview})`);
        }
      }
    }

    // 最后一条 assistant 文本作为最终结果
    if (msg.role === 'assistant' && msg.content) {
      finalOutcome = msg.content.slice(0, 1000);
    }
  }

  return { taskGoal, keyActions, finalOutcome };
}

function truncate(text: string, maxLen: number): string {
  if (!text || text.length <= maxLen) return text ?? '';
  return text.slice(0, maxLen) + '...[truncated]';
}
