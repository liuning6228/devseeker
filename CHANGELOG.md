# Changelog

All notable changes to DevSeeker will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
