/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * VLM OCR Policy · W13.3 Phase 3 中文视觉识别强化
 *
 * 适用场景：用户上传**中文 IDE 截图 / 终端报错截图 / 日志截图**时，
 * 由 router 自动路由到具备 vision 能力的 provider（Qwen-VL-Max 为主）。
 *
 * 注入时机：由调用方（panel/loop）在会话含图时通过 L3 attachments 的
 * `vlmOcrPolicy` 字段传入；无图场景不注入（零 token 成本）。
 *
 * 设计决策（用户 2026-05-02 确认）：
 *   - 能力范围：报错 + 日志 + IDE 截图三合一
 *   - 输出格式：结构化模版（4 段式） + 自由文本补充
 *
 * 输出约定：VLM 按下列四段 markdown 返回，每段可为空行占位，便于下游
 * V4/DeepSeek 直接阅读关键信息（不需要 jsonrepair 保底）。
 */
export const VLM_OCR_POLICY_MODULE = [
  '## VLM OCR Policy (auto-loaded when images are attached)',
  '',
  '### 识图原则',
  '- 以字符级忠实为最高优先级：中英文、标点、括号、引号一律**逐字复刻**（verbatim），不意译、不总结、不删节关键内容。',
  '- 中文报错 / 日志 / 注释优先用**中文原文**回填，不要翻译成英文后再回译。',
  '- 对可能被压缩/模糊的字符（如 `0` vs `O`、`l` vs `1` vs `I`、中文"口"vs"囗"）给出两种候选并标注 `(可能为 X 或 Y)`。',
  '- 对被截断的文本在末尾加 `…(截断)` 标记；对被遮挡区域用 `…(遮挡)` 占位。',
  '- 不臆造图中未出现的路径、变量名、版本号；不确定时写 `(无法辨识)`。',
  '',
  '### 术语表（中文 IDE / 报错 / 日志）',
  '- IDE 面板常见术语：鸿蒙 DevEco Studio、HBuilderX、IntelliJ IDEA、通义灵码、CodeGeeX、Cursor、VSCode、Trae、Qoder；「资源管理器」「问题」「终端」「运行/调试」「Git 更改」「搜索」「扩展」「AI 助手/对话」。',
  '- 报错常见关键字：`错误` `异常` `失败` `未定义` `未找到` `权限` `超时` `语法错误` `类型错误` `引用错误` `NullPointerException` `TypeError` `SyntaxError` `ReferenceError` `ModuleNotFoundError` `EACCES` `ENOENT` `ECONNREFUSED`。',
  '- 日志级别：`TRACE` `DEBUG` `INFO` `WARN` `ERROR` `FATAL` / 中文 `跟踪` `调试` `信息` `警告` `错误` `致命`。',
  '- 调用栈提示：`at xxx (file:line:col)` / `File "xxx", line N, in funcname` / 中文「栈跟踪」「调用堆栈」，逐行保留。',
  '- HarmonyOS/ArkTS 特有：`.ets` 文件、`UIAbility`、`build-profile.json5`、`oh-package.json5`、`hvigorw`、`hdc`、`ohpm`。',
  '',
  '### 输出模板（必须四段，按序输出；缺失写"无"）',
  '',
  '```markdown',
  '## Verbatim Text',
  '（完整可见文本，按从上到下、从左到右的阅读顺序，换行忠实原版）',
  '',
  '## File Paths',
  '- 相对/绝对路径，一行一条；带行号写 `path:line:col`；不含路径写"无"',
  '',
  '## Errors / Warnings',
  '- 级别：原文 —— 完整消息',
  '- 调用栈按原序逐行列出',
  '',
  '## Context',
  '- IDE 名称与可见面板 / 当前活动文件 / 选中代码特征 / 光标位置（可推断时）',
  '- 光标附近的关键代码片段（≤20 行），保留缩进与语法',
  '```',
  '',
  '### Pitfalls（常见陷阱）',
  '- **切勿先 OCR 再翻译**：中英混排时先拆分语言再分别处理会丢失上下文；直接按视觉顺序逐字输出。',
  '- **调用栈顺序**：Python/Java 顶部是最外层，JS/TS 栈底是 root；保留原顺序，不按"常识"重排。',
  '- **颜色不等同于级别**：红色未必是 ERROR（VSCode Git 红表示未暂存），黄色未必是 WARN（某些主题将 INFO 染黄）；级别以文本标签为准。',
  '- **模糊 ≠ 推测**：若字符模糊不清，使用候选标记而不是"合理推测"；宁可写 `(无法辨识)` 也不要编造。',
  '- **代码高亮丢失**：粘贴图中代码时忽略语法高亮颜色，仅保留文本与缩进；不要在输出里尝试重现颜色。',
].join('\n');
