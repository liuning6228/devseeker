# 将 DualMind 更名为 BiCoder

## 背景
当前项目名 DualMind 与多个已有品牌/项目重名（GitHub 同名 AI 公司、VSCode 扩展 `twinny`、USPTO 已注册商标）。经调研，**BiCoder** 在所有主流平台（GitHub / GitCode / VSCode Marketplace / 商标）均无冲突，可直接注册。

## 改动范围分类

### 类别 A: 用户可见名称 (displayName)
- `package.json` → `displayName`: "DualMind" → "BiCoder"
- `package.json` → `name`: "dualmind" → "bicoder"
- `package.json` → `publisher`: "dualmind" → "bicoder"
- `package.json` → `description`: 更新描述
- `package.json` → `qna` / `repository` / `bugs` / `homepage` URL 更新
- `README.md` / `CHANGELOG.md` / `CONTRIBUTING.md` / `SECURITY.md` / 其他 markdown 文档
- `scripts/vsce-package.mjs` 中的文件名
- `esbuild.mjs` 中的入口/产出路径

### 类别 B: VSCode 命令标识符 (command ID / configuration key / menu group)
**注意：类别 B 是运行时标识符，必须区分大小写精确替换，不能多做少做。**

当前命令前缀: `dualMind.xxx` → `biCoder.xxx`
当前配置前缀: `dualMind.xxx` → `biCoder.xxx`
当前菜单组: `dualMind@N` → `biCoder@N`
当前 UI scheme: `dualmind-diff` → `bicoder-diff`

涉及文件:
- `package.json` 的 contributes.commands / menus / configuration / keybindings
- `src/extension.ts` 中的 registerCommand / 配置读取
- `src/ui/streaming-diff-view.ts` 中的 URI scheme
- `src/webview/panel.ts` 中的路径匹配
- `src/core/web/duckduckgo.ts` 中的 User-Agent
- `src/core/tools/fetch_content.ts` 中的 User-Agent
- `src/core/mcp/client.ts` 中的 client name
- `tests/core/agent-loader.test.ts` 中的 type 字段
- 其他有 `dualMind` / `DualMind` 词法标识符的文件

### 类别 C: 源码文件注释头 (Copyright)
约 200+ 个 .ts 文件首行有:
```
* Copyright (c) 2026 DualMind Contributors
```
→ 全部改为 `BiCoder Contributors`
用 `sed` 批量替换，不要逐个文件。

### 类别 D: 用户提示语 / 错误消息中的 "DualMind"
- `src/core/index/bm25-codebase-index.ts` "请先运行 DualMind: Reindex Codebase"
- `src/core/index/codebase-index.ts` 同上
- `src/core/markdown/parser.ts` 返回值 `'DualMind'`
- `src/webview/panel.ts` 中的 `[DualMind]` 前缀
- `src/extension.ts` 中的 `[DualMind]` 前缀
- `src/core/subagent/definitions.ts` 中的子代理 prompt 文本
- `src/core/tools/search_knowledge.ts` 中的命令名
- 等等

### 类别 E: 目录/文件路径中的 `dualmind`
- `.dualmind/` 目录名 — **不改**（这是工作区配置目录，与项目名无关）
- `src/core/storage/sqlite-db.ts` 中的 `dualmind.sqlite` / `dualmind-index.sqlite` 数据库文件名
- `src/core/cost/usage-store.ts` 中的 `~/.dualmind/usage.jsonl`
- 安装描述中的 `dualmind-0.1.0.vsix` → `bicoder-0.1.0.vsix`

## 执行策略

### 分批执行
1. **批 1 (元数据)**: `package.json` 基础字段 + 命令/配置/菜单标识符
2. **批 2 (doc)**: `README.md` 全文替换 + `CHANGELOG.md` / `CONTRIBUTING.md` 等
3. **批 3 (scripts/build)**: 构建脚本中的文件名
4. **批 4 (ALL .ts 注释头)**: `sed` 批量替换 Copyright 行
5. **批 5 (代码中 DualMind 标识符)**: 逐个文件替换 VSCode 命令 / scheme / User-Agent / client name
6. **批 6 (用户可见提示文本)**: 替换提示字符串
7. **批 7 (测试文件)**: 替换测试中的引用
8. **批 8 (vsix/文件名)**: 重命名生成的 .vsix 文件名

### 验证
- `grep -r "DualMind\|dualmind" --include="*.ts" --include="*.json" --include="*.md" | grep -v node_modules | grep -v ".git/" | grep -v ".dualmind/"` 验证无遗漏
- `npm run build` 验证编译通过
