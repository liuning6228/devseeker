# Contributing to DualMind

感谢您对 DualMind 的关注！我们欢迎各种形式的贡献——提交 bug 报告、特性建议、文档改进和代码贡献。

## 行为准则

本项目采用 [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md)。参与即表示同意遵守。

## 提交 Issue

- **Bug 报告**：请提供 VSCode 版本、操作系统、复现步骤、错误日志（`DualMind: Show Logs` 的输出）
- **特性请求**：清晰描述使用场景和期望行为，最好有 mockup 或参考实现

## 开发环境

```bash
git clone https://github.com/dualmind/dualmind
cd dualmind
npm install
npm run watch      # 编译 + 监听
```

按 `F5` 启动 Extension Development Host 即可调试。

## 代码规范

- TypeScript strict 模式
- 路径别名 `@/` → `src/`（tsconfig.json 中已配置）
- 使用 `import type { ... }` 导入类型
- 异步函数优先 `async/await`，避免 `.then()`
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)：
  - `feat:` — 新功能
  - `fix:` — 修复
  - `refactor:` — 重构
  - `chore:` — 构建/工具/依赖变更
  - `docs:` — 文档
  - `test:` — 测试

## 提交 PR 流程

1. Fork 仓库并创建特性分支：`git checkout -b feat/your-feature`
2. 确保通过已有测试：`npm test`
3. 新功能请附带测试用例
4. PR 标题遵循 Conventional Commits 格式
5. 等待 CI 通过和 Code Review

## 项目结构

```
src/               # 扩展端（Node.js + VSCode API）
  core/            # 核心逻辑层
    tools/         # 34+ 内置工具实现
    agents/        # Agent 循环与路由
    index/         # 代码库索引（语义 + BM25）
    memory/        # 记忆系统
    skills/        # Skills 系统
    hooks/         # Hooks 引擎
    checkpoints/   # Shadow Git 快照
    subagent/      # 子代理系统
    prompts/       # System Prompt 模块
  providers/       # LLM / VLLM Provider 适配层
  ui/              # VSCode UI 扩展
  webview/         # Webview 面板
  infra/           # 基础设施（日志、性能探针）
  shared/          # 常量和协议定义
webview-ui/        # React 前端（聊天面板 UI）
scripts/           # 构建脚本
tests/             # 单元测试（Vitest）
```
