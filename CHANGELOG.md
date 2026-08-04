# Changelog

All notable changes to DevSeeker will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.4] - 2026-08-05

### Fixed

- 用户在审批卡片挂起期间点 Stop 导致任务永久挂死：`ToolRunner` 的 `approvalGate` 裸 `await` 未与 `ctx.signal` 竞速，`approvalPending` 也未监听 abort。`ToolRunner` 改为 `Promise.race` + `ctx.signal`，Panel 的 `approvalPending` 登记时挂 `abort` 监听，`abort` 分支同时调 `cancelAllPendingApprovals` + `cancelAllPendingAsk` 兜底清理一切挂起的用户交互
- Plan 模式弹窗"批准并切回 Agent"后模型仍输出确认文本、不直接执行：`create_plan` 的 `onPlanWritten` 钩子返回 `void` 把用户决策丢弃，`tool_result` 硬编码为"下一步建议：用户批准后切回 Agent 执行"。改为返回 `PlanWrittenOutcome`，根据用户是否批准生成不同 `tool_result`（批准→"用户已批准，请立即执行，不要再询问"；未批准→"用户选择继续打磨"）
- 模式切换后模型在同一轮里看到互相矛盾的信号（工具清单已按新模式放开，system prompt 还写着旧模式约束）：`TaskLoop` 新增 `replaceSystemPrompt` / `appendSystemNote`，Panel 新增 `syncModeToActiveLoop`，在 `promptApprovePlan` 批准路径、`handleSwitchToAgentAfterPlan`、`approveSwitchMode`、`handleSetModeFromUser` 四个切模式入口同步重建 prompt 并追加模式切换说明
- Plan 模式 prompt 要求 Interview Phase 分阶段需求收集，但 `ask_user_question`（`safetyLevel='external'`）不在 Plan 白名单，模型根本调不到提问工具：`PLAN_EXTRA_ALLOW_TOOLS` 加入 `ask_user_question`
- Plan 批准切回 Agent 后 plan 路径要等下一轮才注入：批准时立即通过 `syncModeToActiveLoop` 的 note 把 plan 路径 + 立即执行指令写入 system prompt 末尾，模型当轮即可开始执行第一步

## [0.2.3] - 2026-08-02

### Fixed

- 推理过程中点击停止/暂停按键无响应：`runUntilTerminal` 的 STREAM_BROKEN 退避等待从不可取消的 `setTimeout` 改为可取消的 `sleepWithAbort`，用户点 Stop 后立即中断退避
- `runUntilTerminal` 循环每轮入口缺少 `signal.aborted` 检查：工具执行完成后进入下一轮前不检查用户是否已停止
- `runOneTurn` 入口缺少 `signal.aborted` 检查：预处理阶段（特别是 `compactWithSummary` LLM 回环调用，最长 10s）忽略用户停止信号
- `buildEditContextForTurn` 调用前缺少 `signal.aborted` 检查：CodebaseIndex 查询期间无法响应停止
- `compactWithSummary` 流消费循环缺少 `signal.aborted` 检查：Provider yield 的 abort 事件被忽略，不立即退出
- 中断任务需点击两次才生效：用户主动中止被误判为可重试错误后触发 fallback 自动重启任务。`TaskLoop` 的 abort 返回路径原本不带 `errorCode`，Panel 侧 `classifyErrorCode('')` 兜底判为 `timeout`（`next_level`），进而轮换 API Key 或降级到下一 Level 并创建新 `TaskLoop` 重跑同一任务
- 新增 `aborted` FailoverReason 及 `no_fallback` 策略，`classifyErrorCode` 优先识别 `TASK.LOOP.ABORTED`（精确匹配 `LOOP.ABORTED` 以避免误伤 socket 的 `ECONNABORTED`）
- `TaskLoop` 三处 abort 返回路径补齐 `errorCode: TASK_LOOP_ABORTED`；新增 `isAbortedByUser()` 供 Panel 在 `send()` 返回后判定用户中止（`abortController` 在 finally 中被置 null，故用独立标志位留存）
- Panel 的 try / catch 两处 fallback 入口新增用户中止守卫，中止后不再重启任务
- 任务启动窗口期（`send_user_input` 到 `this.taskLoop = loop` 之间的多次 await）收到的 abort 不再被静默丢弃：新增 `pendingAbort` 预约标志，`TaskLoop` 就绪后立即兑现；`abortController` 提前至构造时创建，`abort()` 去掉 `running` 守卫，`send()` 入口检查预约中止

## [0.2.2] - 2026-07-28

### Changed

- DeepSeek 模型默认升级到 V4 系列：`deepseek-v4-flash`（主力）/ `deepseek-v4-pro`（推理）
- 旧名 `deepseek-chat` / `deepseek-reasoner` / `deepseek-coder` 自动映射到 V4（已于 2026-07-24 停服）
- 更新 DeepSeek 定价参数（input 1 / output 2 / cached 0.02 CNY per M tokens，按 V4-Flash）
- provider enum 补齐 `openrouter` / `qwen-code`，与 `PROVIDER_TYPES` 8 项对齐

### Fixed

- 新安装用户填 API Key 后无回复：registry `buildProvider` 现从 `resolveApiKeys` 取首个 Key，避免实例带 `placeholder` 发 401 请求
- 幻影 L2/L3 Provider 注册：`readLevelConfig` 在 provider 为空且 level>1 时返回 undefined
- Webview ModelConfigPanel 与 VS Code Settings 页显示不同步：`pushModelConfig` 统一用 `PROVIDER_DEFAULTS` 兜底
- Provider 切换时 baseUrl 写空字符串污染 settings.json：空 baseUrl 改走 undefined + 兜底
- 无凭证 Provider 照样发注定失败的请求：`startTask` 前加 `hasUsableCredentials` 守卫，直接给出配置引导
- apiKey 掩码字符 `••••••••` 兜底过滤，防止意外写入 settings.json

## [0.2.1]

### Added

- 自主 AI 编码 Agent，支持 34+ 内置工具
- 双模型智能路由（LLM + VLLM），三级降级链
- 多 Provider 支持：DeepSeek / OpenAI / Anthropic / Qwen / Ollama
- 语义代码库索引（本地 BERT 嵌入 + BM25 保底）
- 四位一体模式：Agent / Plan / Debug / Ask
- 子代理系统：Research / Browser / Guide / Verify
- 联网研究：Tavily + 博查 + DuckDuckGo + Jina Reader
- Checkpoints & 回滚：自动快照、三粒度回滚、时间线面板
- Rules 系统：双源加载、glob 匹配、模式决策规则
- Skills 系统：/commit / /review / /refactor 可复用工作流
- Hooks 引擎：pre/post 生命周期事件
- Inline Edit：Ctrl+Shift+I 零对话改写
- Prompt Cache：四层稳定区排序，≥60% 缓存命中率
- 工具自愈 + 容错重试链
- MCP（Model Context Protocol）客户端支持
- SQLite 持久化（session / cost / usage）
- 成本追踪面板 + 性能探针

### Fixed

- 初始版本无修复记录
