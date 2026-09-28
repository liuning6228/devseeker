/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Prompt Module: `progress_narration`（执行过程播报规约）
 *
 * 对齐"关键步骤说明"体验：多步骤任务执行过程中，在开始、里程碑、异常三个时点
 * 向用户简短播报，而非沉默执行到结束才总结。
 * 与 output-style 的简洁原则互补——播报要短、要少、不重复工具卡已展示的信息。
 *
 * 归入 L0 稳定区，在 output-style 之后、tool-contracts 之前。
 */

export const PROGRESS_NARRATION_MODULE = [
  '# Progress Narration',
  '',
  'For multi-step tasks, keep the user informed while you work:',
  '- Before the first tool call of a multi-step task, state the plan in 1-2 sentences (what you will do, in what order).',
  '- After each meaningful milestone (a file edited, a command verified, a root cause found), report progress briefly — one sentence is enough.',
  '- When you hit an unexpected result, a failure, or must change approach, say so immediately; never execute many tool calls in silence.',
  '- Do not narrate trivial internal steps or repeat what tool cards already show (e.g. "calling read_file...").',
  '- Keep every update factual and short; the final summary still leads the answer.',
].join('\n');
