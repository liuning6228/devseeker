# 重构：`.dualmind` → `.devseeker`

## 背景

项目已更名为 DevSeeker，但所有工作区配置目录（rules / skills / agents / checkpoints / knowledge / memory / hooks / data / logs / sessions / perf / audit / tmp）仍然位于 `.dualmind/` 下。本次重构将全部改为 `.devseeker/`。

## 方法

**不搞逐个替换**，采用统一常量方案：

1. 新增 `src/core/constants.ts`，导出 `WORKSPACE_DIR_NAME = '.devseeker'`
2. 所有运行时路径拼接改为引用该常量
3. 工具描述字符串、错误消息、注释同步更新

## 第 1 批：常量定义 + 核心基础设施（8 files）

| 操作 | 文件 | 替换内容 |
|---|---|---|
| 新建 | `src/core/constants.ts` | 导出 `WORKSPACE_DIR_NAME = '.devseeker'` |
| 替换 | `src/core/agents/loader.ts:67` | `'.dualmind'` → `WORKSPACE_DIR_NAME`，并 import |
| 替换 | `src/core/checkpoints/store.ts:48` | `const ROOT_DIR = '.dualmind/checkpoints'` → 改用 `WORKSPACE_DIR_NAME` + `CHECKPOINTS_SUBDIR` |
| 替换 | `src/core/cost/usage-store.ts:42` | `'.dualmind'` → `WORKSPACE_DIR_NAME` |
| 替换 | `src/core/hooks/config.ts:35` | `'.dualmind'` → `WORKSPACE_DIR_NAME` |
| 替换 | `src/core/storage/sqlite-db.ts:593,598` | 两处 `'.dualmind'` → `WORKSPACE_DIR_NAME` |
| 替换 | `src/core/memory/store.ts:42` | `const DEFAULT_DIR = '.dualmind'` → `'.devseeker'` 或引用常量 |

## 第 2 批：tools 目录（8 files）

| 操作 | 文件 | 替换内容 |
|---|---|---|
| 替换 | `src/core/tools/approval-audit.ts:62` | `'.dualmind'` → `WORKSPACE_DIR_NAME` |
| 替换 | `src/core/tools/approval-policy-loader.ts:117` | `'.dualmind'` → `WORKSPACE_DIR_NAME` |
| 替换 | `src/core/tools/sandbox.ts:90` | `'.dualmind'` → `WORKSPACE_DIR_NAME` |
| 替换 | `src/core/tools/streaming-file-writer.ts:32` | `const TMP_DIR_NAME = '.dualmind'` → `'.devseeker'` |
| 替换 | `src/core/tools/grep_code.ts:154` | `--exclude-dir=.dualmind` → `.devseeker` |
| 替换 | `src/core/tools/settings-validator.ts:28` | `dirPrefix: '.dualmind'` → `.devseeker` |
| 替换 | `src/core/tools/create_agent.ts:127` | `'.dualmind'` → `WORKSPACE_DIR_NAME` |
| 替换 | `src/core/tools/create_skill.ts:109` | `'.dualmind'` → `WORKSPACE_DIR_NAME` |

## 第 3 批：index / knowledge / rules / skills / subagent（7 files）

| 操作 | 文件 | 替换内容 |
|---|---|---|
| 替换 | `src/core/index/bm25-codebase-index.ts:319` | `'.dualmind'` → `WORKSPACE_DIR_NAME` |
| 替换 | `src/core/index/codebase-index.ts:420` | `'.dualmind'` → `WORKSPACE_DIR_NAME` |
| 替换 | `src/core/index/scanner.ts:45` | `'.dualmind'` → `'.devseeker'`（Set 常量，直接改字符串） |
| 替换 | `src/core/knowledge/store-path.ts:23,28` | 两处 `'.dualmind'` → `WORKSPACE_DIR_NAME` |
| 替换 | `src/core/rules/loader.ts:66,73` | 两处 `'.dualmind'` → `WORKSPACE_DIR_NAME` |
| 替换 | `src/core/skills/loader.ts:51` | `'.dualmind'` → `WORKSPACE_DIR_NAME` |
| 替换 | `src/core/subagent/definitions.ts:53` | prompt 中的 `.dualmind` → `.devseeker` |

## 第 4 批：extension / ui / 剩余工具 + 注释清理

| 操作 | 文件 | 替换内容 |
|---|---|---|
| 替换 | `src/extension.ts:63,255,331` | 三处 `'.dualmind'` → `WORKSPACE_DIR_NAME` |
| 替换 | `src/ui/streaming-diff-view.ts:44` | `const TMP_DIR_NAME = '.dualmind'` → 直接 `.devseeker` |
| 替换 | `src/core/tools/agent.ts:158` | 描述中 `.dualmind` → `.devseeker` |
| 替换 | `src/core/tools/search_knowledge.ts:155,177` | 错误消息中 `.dualmind` → `.devseeker` |
| 替换 | `src/core/knowledge/knowledge-index.ts:91` | 错误消息中 `.dualmind` → `.devseeker` |
| 替换 | 所有注释中 `.dualmind` 引用 | 字符串替换 `.dualmind` → `.devseeker` |

## 验证

1. `grep -rn "\.dualmind" src/` → 结果为 0（或仅剩有意保留的旧名引用）
2. `tsc --noEmit` → 编译通过
