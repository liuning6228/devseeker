# Changelog

All notable changes to DevSeeker will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
