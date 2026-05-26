/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * L1 Tools & Mode Layer（DESIGN §M3.6 · W3.6 Cache Priority Ordering · V2 M3.14.9）
 *
 * 本层承载「工具 schemas + 当前 Mode + workspace 技能清单」——
 * 只有当用户**切换 Mode**、**新增/删除技能文件**时才变。
 *
 * V2 增强（M3.14.9）：新增 Skills Activation Protocol 段，引导模型
 * 在匹配技能时遵循三段式激活流程，避免跳过 skill 或虚构 skill 名。
 *
 * 缓存边界：当 mode + skills 不变时，L1 字节级稳定；
 * 变更时 L1 之后的所有层（L2/L3/messages）从本轮起不能再命中旧缓存，
 * 但 L0 的前缀仍然命中 → 仅丢弃 mode-section 之后的部分。
 *
 * 注意事项：
 * - skills 列表必须按 `name` 字典序排序（稳定前缀）
 * - renderModePromptSection 为纯函数，mode 不变时输出恒等
 * - 未来注入 MCP 动态工具时，需按 `mcpServerId` 排序，避免顺序抖动
 */

import { renderModePromptSection, type Mode } from '../../modes/index.js';
import type { Skill } from '../../skills/types.js';

export interface L1ToolsModeInput {
  mode: Mode;
  /** workspace + builtin 合并后的 skills 列表；调用方保证按 name 升序 */
  skills: readonly Skill[];
}

/**
 * 构建 L1 层：mode 段 + skills 清单 + skills 激活协议。
 *
 * skills 为空时不输出 skills 段（但 mode 段永远存在）。
 *
 * V2 增加 Skills Activation Protocol（M3.14.9）：模型在调用 skill 前
 * 进行匹配评估，选最相关的 skill 并严格遵循其指令。
 */
export function buildL1ToolsMode({ mode, skills }: L1ToolsModeInput): string {
  const parts: string[] = [renderModePromptSection(mode)];

  if (skills.length > 0) {
    // §M3.6 稳定前缀要求：副本 + 显式排序，防调用方遗漏
    const sortedSkills = skills.slice().sort((a, b) => a.name.localeCompare(b.name));
    parts.push(
      [
        '# Available Skills',
        'When the user has a task that matches one of the skills below, you MUST invoke `skill()` to load the full instructions before doing anything else.',
        'Do NOT try to solve the task directly — load the skill first, then follow its instructions.',
        '',
        'Invoke these workflow skills with `skill(skill="<name>", args="<free text>")` when their description matches the task:',
        ...sortedSkills.map((s) => {
          const argsHint = s.argumentsHint ? ` (args: ${s.argumentsHint})` : '';
          const desc = s.description ? ` — ${s.description}` : '';
          return `- \`${s.name}\`${argsHint}${desc}`;
        }),
        '',
        '## Skill Activation Protocol',
        '',
        '### Step 1: Evaluate',
        '- Review the user request against ALL available skill descriptions.',
        '- Determine if at least one skill clearly and unambiguously applies.',
        '',
        '### Step 2: Branch',
        '',
        '**If a skill matches:**',
        '- Select EXACTLY ONE most specific skill.',
        '- Call `skill(name, args)` to load the full instructions.',
        '- Follow the loaded instructions precisely.',
        '- Do NOT skip steps, create parallel workarounds, or modify the skill\'s flow.',
        '',
        '**If NO skill matches:**',
        '- Proceed with standard problem-solving.',
        '- Do NOT fabricate, guess, or hallucinate skill names.',
        '- Do NOT load any SKILL.md files.',
        '',
        '### Step 3: Report',
        '- Report completion using the skill\'s defined output format.',
        '- If the skill does not define an output format, summarize concisely.',
        '',
        '## ALREADY LOADED protocol',
        'If a tool result contains `<command-name>X</command-name>` for skill X, the skill has ALREADY been loaded in this session.',
        'DO NOT re-invoke `skill(skill="X", ...)` — follow the previously loaded instructions directly.',
        'A 60s debounce window is enforced: repeat calls within 60s will only return a short reminder (not the full SKILL.md body).',
        '',
        'After a skill is loaded, you MUST immediately execute the skill instructions using one or more tools.',
        'Do NOT respond with only text — call tools to fulfill the skill.',
      ].join('\n'),
    );
  }

  return parts.join('\n\n');
}
