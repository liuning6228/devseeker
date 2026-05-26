# i18n 国际化规划

## 目标

DualMind 需要支持多语言界面。优先支持：中文（现有）、英文、日文。

## 方案选择

### 推荐：VS Code 原生 `l10n` API

VS Code 从 1.84 起内置了 `vscode.l10n` 模块：

```ts
import { l10n } from 'vscode';
const msg = l10n.t('Hello {0}', name);
```

优点：
- 零外部依赖
- 与 VS Code 生态一致
- 字符串提取工具 `@vscode/l10n-dev`
- 翻译文件为 JSON，社区友好

### 备选：react-intl / i18next（Webview 侧）

Webview UI（React）需要独立国际化方案。建议使用 `react-intl`（FormatJS）：

- Webview 消息通过 `IntlProvider` 包裹
- 翻译文件与扩展端共享 key 体系
- 后续通过 `vscode.l10n.uri` 传递 locale

## 实施步骤

1. **Phase 1 — 基础设施**：在 `src/infra/i18n.ts` 中封装 `l10n.t` 的 fallback
2. **Phase 2 — Webview 集成**：在 webview-ui 中引入 `react-intl`
3. **Phase 3 — 字符串提取**：将所有硬编码的中文 UI 文本抽取为 key
4. **Phase 4 — 翻译管理**：建立 `locales/` 目录 + CI 翻译校验

## 当前状态

- [x] 设计文档
- [ ] `src/infra/i18n.ts` 封装
- [ ] webview-ui `react-intl` 集成
- [ ] 硬编码字符串提取
- [ ] 英文翻译文件
- [ ] 日文翻译文件
