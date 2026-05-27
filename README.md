# DualMind

<div align="center">

![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)
![VSCode](https://img.shields.io/badge/VSCode-%3E%3D1.85-blueviolet)

> 技术 leader 型 AI 编码助手 · 双模型智能路由 · 自主 Agent · VSCode 扩展
> AI coding agent for tech leads · Dual-model routing · Autonomous agent · VSCode extension

[English](#english) · [中文](#中文)

</div>

---

## 中文

DualMind 是一款**自主 AI 编码 Agent**，不满足于"自动补全"——它能理解整个代码库、自主规划实施步骤、调用 34+ 工具读写文件执行命令，并像资深工程师一样在行动前先思考。

支持 DeepSeek / OpenAI / Anthropic / Qwen / Ollama 等多种模型，主推 **DeepSeek V4（编码）+ Qwen-VL-Max（视觉）** 双模型智能路由。

<div align="center">
  <img src="logo.png" alt="DualMind" width="120">
</div>

---

### 功能特色

#### 自主 Agent 循环

不只是一问一答的聊天机器人。每轮交互中自动执行 **思考→规划→执行→观察→再思考** 的闭环：

- **Think First**：每次工具调用前先内部分析，再行动
- **多步编排**：自主拆解复杂任务（"给我的所有 API 路由加鉴权"），中间步骤无需用户干预
- **34+ 内置工具**：读/写/搜索/执行/LSP/联网，所见即所得
- **Diff 预览**：每次写文件自动生成 unified diff，改动一目了然

#### 双模型智能路由

| 场景 | 路由模型 | 默认值 |
|------|---------|--------|
| 编码 / 推理 / 重构 | DeepSeek V4 | `deepseek-chat` |
| 截图 / 图像理解 | Qwen-VL-Max | `qwen-vl-max-latest` |

- 粘贴图片时自动路由视觉模型，无需手动切换
- 三级模型容灾：主力 → 备用 → 兜底，Key 用尽或 429 时自动降级
- 支持 OpenAI / Anthropic / Ollama / 自建兼容端点

#### 语义代码库索引

- **LanceDB + tree-sitter**：代码解析→分段→向量→语义检索
- **离线本地嵌入**：无需联网、无需额外 API Key
- **BM25 保底**：零模型冷启动，<1s 建好
- **实时增量**：文件修改后 2s 内自动更新索引

#### 四位一体模式

底部状态栏一键切换，适应不同场景：

| 模式 | 作用 |
|------|------|
| **Agent** | 全能模式，读写执行全开 |
| **Plan** | 只读规划，产出计划文档，审批后才动手 |
| **Debug** | 循证排障五步法：复现→取证→定位→修复→验证 |
| **Ask** | 只答不改，零代码变更风险 |

#### 子代理系统

将复杂任务拆解为隔离执行的子任务：

- **Research**：同时检索代码库 + 搜索网络，生成结构化报告
- **Browser**：纯网页浏览，不污染主会话
- **Guide**：DualMind 配置向导
- **Verify**：运行测试 / 类型检查 / 构建验证

#### 联网研究

- **双搜索**：Tavily（英文）+ 博查（中文），按语言自动路由
- **Jina Reader**：任意 URL → 干净 Markdown
- **SSRF 防护 & Prompt Injection 防御**：网页内容 `<web_content>` 包裹隔离

#### 安全与审批

| 级别 | 示例 | 默认策略 |
|------|------|---------|
| read_only | `read_file` / `lsp_*` | 自动执行 |
| workspace_write | `write_file` / `search_replace` | 自动执行 |
| destructive | 含 rm/rmdir 的 bash 命令 | **强制确认** |
| network | `search_web` / `fetch_content` | 自动执行（SSRF 防护） |
| external | MCP 工具 / `ask_user_question` | **强制确认** |

#### Checkpoints & 回滚

- **自动快照**：每次写操作前自动创建 checkpoint
- **三粒度回滚**：单步 → 当前轮次 → 整个会话
- **时间线面板**：`DualMind: Show Checkpoint Timeline` 命令打开可视化时间线，支持 Compare Diff

#### Rules 系统

用 Markdown 文件定义 Agent 行为准则：

- `always_on`：每次注入 System Prompt（项目规范、编码约定）
- `model_decision`：模型决策参考（架构决策记录）
- `glob`：按文件路径匹配注入
- **双源加载**：全局 `~/.dualmind/rules/` + 工作区 `.dualmind/rules/`

#### Skills 系统

将高频任务封装为可复用的命令化工作流：

```
/commit      — 标准化提交流程
/refactor    — 跨文件重构接口
/review      — 代码评审
```

#### 更多能力

- **Hooks 引擎**：pre_tool / post_tool / pre_commit / post_turn / post_error 五事件
- **成本追踪**：LLM / Embedding / 搜索 统一计费
- **会话持久化**：关窗重开完整恢复，支持 Markdown / JSON 导出
- **Inline Edit**：选中代码 `Ctrl+Shift+I`，零对话直接改写
- **Prompt Cache**：四层稳定区排序，token 命中率 ≥ 60%
- **工具自愈**：JSON 解析失败 / 替换不匹配时自动 hint 重试
- **Provider 重试链**：429/5xx 自动退避 + Retry-After 响应

---

### 安装

#### 环境要求

- **VSCode ≥ 1.85**
- 至少一个 LLM API Key（DeepSeek / OpenAI / Anthropic / Qwen / Ollama 任选其一）

#### 从源码编译打包

```bash
git clone https://github.com/liuning6228/dualmind.git
cd dualmind
npm install
npm run build
npm run download-model
npm run package
```

打包完成后会在项目根目录生成 `dualmind-0.1.0-linux-x64.vsix` 和 `dualmind-0.1.0-win32-x64.vsix`。

**安装 VSIX：**
```bash
# Linux
code --install-extension dualmind-0.1.0-linux-x64.vsix

# Windows
code --install-extension dualmind-0.1.0-win32-x64.vsix
```

或者直接在 VSCode Extensions 侧边栏 → `···` → **Install from VSIX...** → 选中对应平台的 `.vsix` 文件。

安装后重载窗口（`Ctrl+Shift+P` → `Developer: Reload Window`）。

---

### 快速上手

#### 1. 配置 API Key

`File → Preferences → Settings` → 搜 `dualMind`，填写：

| 设置 | 必填 | 说明 |
|------|------|------|
| `dualMind.models.llm.level1.apiKey` | **是** | 主力 LLM 的 API Key（默认 DeepSeek） |
| `dualMind.models.vllm.level1.apiKey` | 否 | 视觉模型 Key（截图需要，默认 Qwen-VL） |
| `dualMind.webResearch.tavily.apiKeys` | 否 | 联网搜索（Tavily，英文） |
| `dualMind.webResearch.bocha.apiKeys` | 否 | 联网搜索（博查，中文） |

只填第一项 LLM Key 即可开始编码。

#### 2. 打开面板

**方式一 · 底部状态栏**：点击 VSCode 底部状态栏右侧的 `$(rocket) DualMind` 按钮。

**方式二 · 命令面板**：`Ctrl+Shift+P` → **DualMind: Open Panel** → 在主编辑器列打开聊天面板。

#### 3. 开始使用

```
读一下 package.json，告诉我用了哪些依赖
给 src/ 下所有 API 路由加 JWT 鉴权
帮我看看为什么这个测试挂了
```

#### 4. 切换模式

底部状态栏点击模式名称（默认 **Agent**）下拉切换。

#### 5. 截图粘贴

`Ctrl+V` 直接粘贴截图 → 自动路由视觉模型分析。

---

### 命令面板

| 命令 | 作用 |
|------|------|
| `DualMind: Open Panel` | 打开聊天面板 |
| `DualMind: Show Logs` | 打开 runtime.log |
| `DualMind: Reindex Codebase` | 手动重建语义索引 |
| `DualMind: Revert to Checkpoint…` | 从快照列表回滚 |
| `DualMind: Show Checkpoint Timeline` | 查看快照时间线 |
| `DualMind: Export Session (md/json)` | 导出会话 |
| `DualMind: Show Cost Panel` | 查看今日用量 |
| `DualMind: Show Rules Panel` | 查看当前生效的 Rules |
| `DualMind: Show Hooks Panel` | 查看 Hooks 状态 |

### 快捷键

| 快捷键 | 用途 |
|--------|------|
| `Ctrl+Shift+I` | Inline Edit：选中代码直接改写 |
| `Ctrl+Shift+L` | 选中代码后询问 DualMind |
| `Ctrl+Enter` | 发送消息 / 接受 diff hunk |
| `Alt+↑/↓` | （diff 模式）前后切换 hunk |
| `Ctrl+Backspace` | 拒绝当前 diff hunk |

---


### 许可证

MIT License。详见 [LICENSE](LICENSE) 文件。

---

<p align="center">
  <a href="CONTRIBUTING.md">贡献指南</a> ·
  <a href="CODE_OF_CONDUCT.md">行为准则</a> ·
  <a href="SECURITY.md">安全报告</a> ·
  <a href="https://github.com/liuning6228/dualmind/issues">Issues</a>
</p>

---

## English

DualMind is an **autonomous AI coding agent** for VSCode. It understands your entire codebase, plans implementation steps, calls 34+ tools to read/write/execute/search, and thinks before acting -- like a senior engineer.

### Features

- **Autonomous Agent Loop**: Think → Plan → Act → Observe → Repeat
- **Dual-Model Routing**: DeepSeek for coding + Qwen-VL for vision, auto-routed
- **Semantic Code Index**: Offline embedding (local-bert) + BM25 fallback
- **4 Modes**: Agent / Plan / Debug / Ask, switch from status bar
- **Subagent System**: Delegate to Research/Browser/Guide/Verify subagents
- **Web Research**: Tavily (EN) + Bocha (CN) with Jina Reader
- **Checkpoints & Revert**: Auto snapshot before every write, 3-level rollback
- **Rules System**: Markdown-defined behavioral rules with glob matching
- **Skills System**: Reusable workflow commands (`/commit`, `/review`, etc.)
- **Prompt Cache**: 4-layer stable zone ordering, ≥60% cache hit rate

### Quick Start

1. Set `dualMind.models.llm.level1.apiKey` in VSCode settings
2. Click `$(rocket) DualMind` in the bottom status bar, or `Ctrl+Shift+P` → **DualMind: Open Panel**
3. Start coding — ask anything, DualMind will plan and execute

### Installation

**Requirements**: VSCode ≥ 1.85, a LLM API Key (DeepSeek / OpenAI / Anthropic / Qwen / Ollama)

#### Build from source

```bash
git clone https://github.com/liuning6228/dualmind.git
cd dualmind
npm install
npm run build
npm run download-model
npm run package
```

After packaging, you'll get `dualmind-0.1.0-linux-x64.vsix` and `dualmind-0.1.0-win32-x64.vsix` in the project root.

**Install the VSIX:**
```bash
# Linux
code --install-extension dualmind-0.1.0-linux-x64.vsix

# Windows
code --install-extension dualmind-0.1.0-win32-x64.vsix
```


### Keybindings

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+I` | Inline Edit |
| `Ctrl+Shift+L` | Ask about selection |
| `Ctrl+Enter` | Send message / Accept hunk |

### License

MIT — see [LICENSE](LICENSE).
