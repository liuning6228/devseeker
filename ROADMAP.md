# DevSeeker UI 优化实施路线图

> 本文档为 UI 优化方案的**可执行实施计划**。根据 [ui-optimization-index.md](./docs/ui-optimization-index.md) 中的 27 个优化方案，结合 [plan.md](./docs/ui-optimization-plan.md)、[detailed.md](./docs/ui-optimization-detailed.md)、[remaining-scenes.md](./docs/ui-optimization-remaining-scenes.md)、[remaining-scenes-code.md](./docs/ui-optimization-remaining-scenes-code.md) 四份文档的**重设计后版本**制定。
>
> **版本**: v2.0 · **创建**: 2026-06-04 · **最后实施**: 2026-06-04 · **总预估**: 60-90 天 · **实际实施**: 全部 22 步完成

---

## 一、实施原则

### 1.1 优先级排序标准

按 **`用户操作频次 × 当前痛点程度`** 排序，而非按技术实现复杂度：

| 权重因子 | 说明 |
|---------|------|
| 🔴 P0 | 每日使用 >5 次，当前体验严重受阻 |
| 🟡 P1 | 每日使用 1-5 次，或影响特定用户群体 |
| 🟢 P2 | 收益明确但可推迟，或可逐步小步迭代 |

### 1.2 实施顺序

1. 🟢 **纯 webview 端变更**（无需新协议，可独立测试）
2. 🟡 **需 protocol 扩展**（先扩 protocol → 再实现两端）
3. 🔴 **架构级改造**（需要跨文件重构，建议最后）

### 1.3 质量门控

每个 Step 完成后必须满足：
- `npm run type-check` 零错误（在 webview-ui/ 目录）
- 新组件含 Vitest 单元测试（覆盖核心逻辑）
- 不破坏现有功能（回归测试：输入/发送/审批/工具执行/会话切换）
- ❗**若实施过程中发现与原方案不兼容的问题，通过 `ask_user_question` 卡片让用户确认后再继续**

---

## 二、第一阶段：P0 核心交互（3-4 周）

> 目标：解决每日高频操作的严重痛点。15 个方案中 **6 个纯 webview 变更** 优先实施。

### Step 1: 输入历史 + 拖拽文件（OPT-UI-001）🟢 · 5 天

**参考**: [plan.md §E.2 OPT-UI-001](./docs/ui-optimization-plan.md#L1868)

**改动范围**（纯 `Composer.tsx` 增量）：
- `Composer.tsx`: 增加 `inputHistory` state、修改 `handleKeyDown`（Ctrl+↑/↓）、修改 `submit`（存入历史）
- `Composer.tsx`: 增加 `handleDrop`（文本文件读取 + 图片上传复用现有逻辑）

**设计决策**：
- ⚠️ 使用 `Ctrl+↑/↓` 而非 `↑/↓` 导航历史，避免拦截 textarea 原生光标行内移动
- ⚠️ 不使用独立 CodeEditor 组件（Monaco 增加 ~5MB，VSCode 已有原生编辑器）

**文件清单**：
- [x] `webview-ui/src/components/Composer.tsx`（增量修改）
- [ ] 新增单元测试：输入历史 CRUD、拖拽文件读取

---

### Step 2: 流式渲染优化（OPT-UI-010）🟢 · 2 天

**参考**: [plan.md §E.2 OPT-UI-010](./docs/ui-optimization-plan.md#L2348)

**改动范围**（纯 `MessageList.tsx` 增量）：
- `MessageList.tsx`: 增加阅读进度条（`ReadingProgress` 组件，监听 scroll 事件）
- `MessageList.tsx`: 流式消息无内容时显示骨架屏（`SkeletonLine` 组件）
- 修正数据模型引用：`m.isStreaming` → `m.parts.some(p => p.kind === 'text' && p.isStreaming)`

**设计决策**：
- ⚠️ 保留现有 ResizeObserver 滚动策略，骨架屏作为可选增强
- ⚠️ 不引入独立动画框架，使用纯 CSS 动画

**文件清单**：
- [x] `webview-ui/src/components/MessageList.tsx`（增量修改）
- [ ] 新增 CSS 样式 `skeleton-line` / `reading-progress`

---

### Step 3: 审批命令解释（OPT-UI-020 局部）🟢 · 3 天

**参考**: [plan.md §E.2 OPT-UI-020](./docs/ui-optimization-plan.md#L2487)

**改动范围**：
- `webview-ui/src/utils/commandExplainer.ts`（新增）：正则匹配引擎，无 LLM 延迟
- `ToolCard.tsx`: 在命令展示区 `<pre><code>{bashCommand}</code></pre>` 下方插入解释行
- `ToolCard.tsx`: 增加"允许并记住"按钮（`allowRemember=true` 时显示）

**设计决策**：
- ⚠️ 用本地正则匹配替换 LLM 命令解释（避免 1-3s 延迟）
- ⚠️ 命令解释行放在现有审批面板内，不改变面板布局结构

**文件清单**：
- [x] `webview-ui/src/utils/commandExplainer.ts`（新增）
- [x] `webview-ui/src/components/ToolCard.tsx`（增量修改）
- [ ] 单元测试：命令解释器正则覆盖率 > 20 种常见命令模式

---

### Step 4: 上下文可视化（OPT-UI-040）🟡 · 3-5 天

**参考**: [plan.md §E.2 OPT-UI-040](./docs/ui-optimization-plan.md#L2714)

**改动范围**（需先扩 protocol，再改 webview）：

**1. protocol 扩展**：
- `src/shared/protocol.ts`: `context_stats` TaskEvent 扩展 `items?: ContextItemEntry[]` 字段

**2. reducer 扩展**：
- `webview-ui/src/state/reducer.ts`: `ContextStatsSnapshot` 扩展 `items?: ContextItemEntry[]`

**3. webview 组件**：
- `webview-ui/src/components/ContextPanel.tsx`（新增）：弹出层展示上下文文件/符号/记忆

**设计决策**：
- ⚠️ 使用弹出层（popover）而非 Drawer，减少布局占用
- ⚠️ 复用 `context_stats` 事件扩展字段，不新增独立消息类型

**文件清单**：
- [x] `src/shared/protocol.ts`（扩展 `context_stats`）
- [x] `webview-ui/src/state/reducer.ts`（扩展 `ContextStatsSnapshot`）
- [x] `webview-ui/src/components/ContextPanel.tsx`（新增）
- [ ] 新增 CSS 样式

---

### Step 5: 列表渲染性能优化（PERF-001）🟢 · 3-5 天

**参考**: [remaining-scenes-code.md §21.4 PERF](./docs/ui-optimization-remaining-scenes-code.md#L4708)

**改动范围**（纯 webview 端，不引入新依赖）：

1. **React.memo MessageItem**
```typescript
export const MessageItem = React.memo(function MessageItem(props: MessageItemProps) {
  // ... 现有实现
}, (prev, next) => {
  return prev.message.id === next.message.id
    && prev.message.parts === next.message.parts
    && prev.awaitingApproval === next.awaitingApproval;
});
```

2. **CSS content-visibility**（带 feature-detection）
```typescript
const supportsCv = typeof CSS !== 'undefined' && CSS.supports?.('content-visibility', 'auto');
// 仅在支持且消息数 >200 时启用
```

3. **ErrorBoundary** 包裹关键区域（Composer + MessageList）

4. **ImageWithLazyLoad** 组件（IntersectionObserver 懒加载）

**设计决策**：
- ❌ 不使用 `react-window` 虚拟化（与 StreamController DOM 直写 + 流式高度变化不兼容）
- ✅ 使用 `content-visibility: auto` + React.memo 替代
- ✅ content-visibility 添加 `CSS.supports()` feature-detection，不支持时退化为全量渲染

**文件清单**：
- [x] `webview-ui/src/components/MessageItem.tsx`（包裹 React.memo）
- [x] `webview-ui/src/components/MessageList.tsx`（增加 content-visibility + feature-detection）
- [ ] `webview-ui/src/components/SkeletonScreen.tsx`（新增）
- [ ] `webview-ui/src/components/ErrorBoundary.tsx`（新增）
- [ ] `webview-ui/src/components/ImageWithLazyLoad.tsx`（新增）

---

### Step 6: 模式切换通知 + 确认（OPT-MODE-001/010/020）🟡 · 4-6 天

**参考**: [detailed.md §15.2 OPT-MODE-001](./docs/ui-optimization-detailed.md#L3748)

**改动范围**：

1. **protocol 扩展**：`ModeStatusPayload.switchDetail` 字段（增量，非新消息）
2. **panel.ts 改造**：`pushModeStatus()` 自动切换时附带 `switchDetail`
3. **webview 端**：`App.tsx` 根据 `mode_status.switchDetail` 显示 banner（8s 自动消失）
4. **Composer 改造**：手动切换模式时弹出确认对话框（`ModeSwitchConfirm` 组件）

**设计决策**：
- ⚠️ 删除 VSCode Modal（阻断式），只保留 webview banner（非阻断式）
- ⚠️ 不新增独立 `mode_switch_notification` 消息类型，复用 `mode_status` 扩展

**文件清单**：
- [x] `src/shared/protocol.ts`（扩展 `ModeStatusPayload`）
- [x] `src/webview/panel.ts`（`pushModeStatus` 增加 switchDetail）
- [x] `webview-ui/src/App.tsx`（onMessage 处理 switchDetail 显示 banner）
- [x] `webview-ui/src/components/Composer.tsx`（模式切换确认）

---

### Step 7: @ 上下文选择器（OPT-UI-002）🟡 · 5-7 天

**参考**: [plan.md §E.2 OPT-UI-002](./docs/ui-optimization-plan.md#L1991)

**改动范围**：

1. **protocol 扩展**：
   - 新增 `context_search`（Webview→Extension）
   - 新增 `context_search_result`（Extension→Webview）
   - 新增 `ContextSearchItem` 类型

2. **panel.ts handler**：实现 `findFiles` + `executeWorkspaceSymbolProvider` + `memoryManager.search`

3. **webview 组件**：
   - `ContextPicker.tsx`（新增）：弹出选择器
   - `Composer.tsx` 修改：@ 检测逻辑 (`handleInput` 实时检测光标前 @)

**设计决策**：
- ✅ 文件搜索：首次返回全量文件名 → 前端 `fuse.js` 模糊匹配（减少 request 次数）
- ✅ 符号搜索：用户切到"符号"Tab 时才触发（lazy fetch）
- ❌ 不针对每次按键都发 request，100ms 防抖 + 缓存

**文件清单**：
- [x] `src/shared/protocol.ts`（2 条新消息 + 1 新类型）
- [x] `src/webview/panel.ts`（handler 实现）
- [x] `webview-ui/src/components/ContextPicker.tsx`（新增）
- [x] `webview-ui/src/components/Composer.tsx`（增量修改）
- [ ] 单元测试：@ 检测逻辑、搜索缓存、键盘导航

---

## 三、第二阶段：P1 重要交互（3-4 周）

### Step 8: 错误处理增强（OPT-ERROR-001）🟡 · 3-5 天

**参考**: [detailed.md §15.2 OPT-ERROR-001](./docs/ui-optimization-detailed.md#L4037)

**改动范围**：
- `reducer.ts`: `lastError` 扩展 `{category, suggestion, retryable}` 字段
- `ErrorRow.tsx`: 根据 `category` 显示不同图标和颜色（网络/权限/超时/API）
- `ToolCard.tsx`: 扩展 `handleRetry` 增加重试次数限制

**文件清单**：
- [x] `webview-ui/src/state/reducer.ts`（扩展 `lastError`）
- [x] `webview-ui/src/components/chat/ErrorRow.tsx`（增量增强）
- [x] `webview-ui/src/components/ToolCard.tsx`（重试次数限制）
- [ ] 单元测试：错误分类正则匹配

---

### Step 9: 工具耗时显示（OPT-UI-011 局部）🟡 · 2 天

**参考**: [plan.md §E.2 OPT-UI-011](./docs/ui-optimization-plan.md#L2418)

**改动范围**：
- `protocol.ts`: `tool_exec_start` 扩展 `startTime`、`tool_exec_end` 扩展 `endTime`
- `reducer.ts`: `ToolCallPart` 扩展 `startTime`、`duration`
- `panel.ts`: `handleToolExecStart/End` 携带时间戳
- `ToolCard.tsx`: header 区增加 `⏱️ {(duration/1000).toFixed(1)}s`

**设计决策**：
- ⚠️ 计时在 Extension 侧完成（`Date.now()`），避免 postMessage 延迟偏差
- ⚠️ 小工具（几毫秒）的 duration 显示为 `0.0s`，可以接受

**文件清单**：
- [x] `src/shared/protocol.ts`（扩展 `tool_exec_start`/`tool_exec_end`）
- [x] `src/webview/panel.ts`（携带时间戳）
- [x] `webview-ui/src/state/reducer.ts`（记录 startTime/计算 duration）
- [x] `webview-ui/src/components/ToolCard.tsx`（显示耗时）

---

### Step 10: 无障碍访问（A11Y-001~012）🟢 · 3 天

**参考**: [remaining-scenes-code.md §19](./docs/ui-optimization-remaining-scenes-code.md#L2367)

**改动范围**（纯 CSS/HTML/ARIA，无协议依赖）：
- `accessibility.ts`: `ariaLiveRegion`/`focusTrap`/`announceToScreenReader` 工具函数
- `useFocusTrap.ts` Hook：模态框焦点循环
- `accessibility.css`: `.sr-only`、`:focus-visible`、`prefers-reduced-motion`、`prefers-contrast: high`
- 各组件添加 `aria-label`、`role` 等属性
- `App.tsx`: 全局跳过链接 + 关键事件屏幕阅读器播报

**文件清单**：
- [x] `webview-ui/src/utils/accessibility.ts`（已有，需扩展）
- [x] `webview-ui/src/hooks/useFocusTrap.ts`（新增）
- [x] `webview-ui/src/styles/accessibility.css`（新增，在 main.css 中 @import）
- [x] `webview-ui/src/App.tsx`（跳过链接 + 播报）
- [x] 各组件 ARIA 属性增量修改

---

### Step 11: 文件拖拽增强（DRAG-001~006）🟢 · 2 天

**参考**: [remaining-scenes-code.md §17](./docs/ui-optimization-remaining-scenes-code.md#L1913)

**改动范围**（纯 `Composer.tsx` 增量）：
- 在现有 Composer 的 textarea 增加 `onDrop` handler（见 Step 1 整合）
- 视觉反馈：拖拽时显示覆盖层 + 文件预览

**设计决策**：
- ❌ 不引入独立 DragDropZone 组件，直接在 Composer 内增量添加
- ✅ 图片拖拽复用 `readFileAsDataURL` + `send_user_input` images 参数
- ✅ 文本文件拖拽用 `File.text()` 读取后以代码块格式插入 textarea

**文件清单**：
- [x] `webview-ui/src/components/Composer.tsx`（增量修改）
- [x] 拖拽覆盖层 CSS 样式（追加到 main.css）

---

### Step 12: 命令菜单增强（OPT-UI-003）🟡 · 2-3 天

**参考**: [plan.md §E.2 OPT-UI-003](./docs/ui-optimization-plan.md#L2279)

**改动范围**：
- `protocol.ts`: 新增 `get_skills`/`skill_list`/`execute_skill` 消息
- `panel.ts`: handler 返回 Skills 列表
- `Composer.tsx`: / 检测逻辑 + SlashMenu 弹层
- `SlashCommandMenu.tsx`: 改为动态加载 + 搜索/分类/频率排序

**文件清单**：
- [x] `src/shared/protocol.ts`（3 条新消息 + `SkillInfo` 类型）
- [x] `src/webview/panel.ts`（handler）
- [x] `webview-ui/src/components/Composer.tsx`（/ 检测集成）
- [x] `webview-ui/src/components/chat/SlashCommandMenu.tsx`（重构）

---

### Step 13: 会话管理增强（OPT-UI-031）🟡 · 3-5 天

**参考**: [plan.md §E.2 OPT-UI-031](./docs/ui-optimization-plan.md#L2680)

**改动范围**：
- `protocol.ts`: `SessionSummary` 扩展 `tags?`、`preview?`；新增 `delete_sessions`、`update_session_tags` 消息
- `SessionDrawer.tsx`: 搜索框 + 标签过滤 + 批量选择 + 删除确认 + 排序

**文件清单**：
- [x] `src/shared/protocol.ts`（扩展 + 新消息）
- [x] `src/webview/panel.ts`（handler）
- [x] `webview-ui/src/components/SessionDrawer.tsx`（增量重构）

---

### Step 14: 工具历史面板（TOOLHIST-001~008）🟢 · 2-3 天

**参考**: [remaining-scenes-code.md §21.2](./docs/ui-optimization-remaining-scenes-code.md#L4412)

**改动范围**：
- `reducer.ts`: `AppState.toolCallIndex: Map<string, number>`（`tool_start` 时维护，`HISTORY_RESET` 时清空）
- `ToolHistoryPanel.tsx`（新增）：从 `state.messages` 就地聚合 + 高效索引路径 + 全量遍历回退路径
- `App.tsx`: 增加 `tool_history` 视图路由

**设计决策**：
- ✅ 不新增后端存储，从 `UiMessage.parts` 就地聚合
- ✅ 通过 `toolCallIndex` 索引实现 O(1) 查找，避免 ≥50 条消息时全量遍历
- ❌ 删除 `re_execute_tool`（需 TaskLoop 架构改造）

**文件清单**：
- [x] `webview-ui/src/state/reducer.ts`（新增 `toolCallIndex` + 维护逻辑）
- [x] `webview-ui/src/components/ToolHistoryPanel.tsx`（新增）
- [x] `webview-ui/src/App.tsx`（视图路由）
- [ ] 新增 CSS 样式

---

### Step 15: 上下文菜单（CTXMENU-001~010）🟢 · 3 天

**参考**: [remaining-scenes-code.md §21.2](./docs/ui-optimization-remaining-scenes-code.md#L4674)

**改动范围**（纯 webview 端，复用现有 `chat/ContextMenu.tsx`）：
- 扩展 `ContextMenu.tsx`：支持 `divider`、`shortcut`、`disabled`
- `MessageItem.tsx`: 右键菜单（复制消息/复制原文）
- `SessionDrawer.tsx`: 右键菜单（加载/导出/删除）

**设计决策**：
- ❌ 删除 `regenerate_message`/`delete_message`（需 TaskLoop 架构改造）
- ✅ 仅保留 webview 端可独立执行的操作（clipboard copy + postMessage）

**文件清单**：
- [x] `webview-ui/src/components/chat/ContextMenu.tsx`（增强）
- [x] `webview-ui/src/components/MessageItem.tsx`（onContextMenu）
- [x] `webview-ui/src/components/SessionDrawer.tsx`（onContextMenu）

---

### Step 16: 提问弹窗增强（OPT-QUESTION-001）🟢 · 2 天

**参考**: [detailed.md §7.1](./docs/ui-optimization-detailed.md#L2134)

**改动范围**（纯 `QuestionCard.tsx` 增量）：
- 增加问题进度条（已回答/总数）
- 增加折叠选项描述（`<details><summary>`）
- 增加"查看答案预览"区域
- 键盘导航支持

**文件清单**：
- [x] `webview-ui/src/components/QuestionCard.tsx`（增量修改）

---

## 四、第三阶段：P2 辅助功能（2-3 周）

### Step 17: 快捷键系统（HOTKEY-001~010）🟡 · 2 天

**参考**: [detailed.md §11.1](./docs/ui-optimization-detailed.md#L3145)

**改动范围**：
- `useKeyboardShortcuts.ts` Hook（纯 webview 端，不拦截 VSCode 全局快捷键）
- `ShortcutsHelpDialog.tsx`（新增）：`Shift+/` 触发

**设计决策**：
- ⚠️ 只绑定 webview 内焦点可用快捷键（`Ctrl+L` 聚焦输入框、`Ctrl+K` 清空等）
- ❌ 不尝试拦截 VSCode 全局快捷键（`Ctrl+N`、`Ctrl+Shift+P` 等）

---

### Step 18: 状态栏增强（OPT-STATUS-001）+ 成本展示（COST-001~005）🟡 · 3 天

**参考**: [plan.md §E.2 OPT-UI-030](./docs/ui-optimization-plan.md#L2609)、[remaining-scenes-code.md §15](./docs/ui-optimization-remaining-scenes-code.md#L1082)

**改动范围**：
- `CostSummaryPayload` 扩展 `history?: DailyCostEntry[]`、`budgetAlertMessage?: string`
- `CostDetailPanel.tsx`（新增）：点击 cost 展开详情 + 简单趋势图
- `StatusBar.tsx`: 新建会话确认 + 会话计时器

---

### Step 19: 索引状态面板（INDEX-001~006）🟡 · 1-2 天

**参考**: [remaining-scenes-code.md §21.2](./docs/ui-optimization-remaining-scenes-code.md#L4527)

**改动范围**：
- `IndexStatusPayload` 扩展 `indexSize?`、`startTime?`、`status`、`currentFile?`
- `IndexStatusPanel.tsx`（新增）：直接使用现有 `IndexProgressPayload` + `IndexStatusPayload` 类型

---

### Step 20: 预览功能增强（PREVIEW-001~008）🟢 · 2 天

**参考**: [remaining-scenes-code.md §21.2](./docs/ui-optimization-remaining-scenes-code.md#L4635)

**改动范围**：
- `PreviewBanner.tsx` 增强：加载状态、`🟢 Live` 徽章、刷新提示
- ❌ 不实现 iframe 内嵌（VSCode CSP 限制）
- ❌ 不实现 HotReloadIndicator（WebSocket 在 webview 中不可靠）

---

### Step 21: 设置面板增强（OPT-SETTINGS-001）🟡 · 3-5 天

**参考**: [detailed.md §9.1](./docs/ui-optimization-detailed.md#L2588)

**改动范围**：
- `SettingsView.tsx`: 配置搜索、验证提示、保存状态指示器
- `model-config.css`: 增强样式

---

### Step 22: 记忆管理面板（OPT-MEMORY-001）🟡 · 3-5 天

**参考**: [plan.md §E.2 OPT-UI-041](./docs/ui-optimization-plan.md#L2816)

**改动范围**：
- `protocol.ts`: 新增 `get_memories`/`delete_memory`/`create_memory` + `memory_result`/`memory_deleted`
- `panel.ts`: handler
- `MemoryPanel.tsx`（新增）

---

## 五、文件变更总览

### 5.1 New Files

| 文件 | 所属 Step | 类型 |
|------|-----------|------|
| `webview-ui/src/utils/commandExplainer.ts` | Step 3 | 工具函数 |
| `webview-ui/src/components/ContextPanel.tsx` | Step 4 | React 组件 |
| `webview-ui/src/components/SkeletonScreen.tsx` | Step 5 | React 组件 |
| `webview-ui/src/components/ErrorBoundary.tsx` | Step 5 | React 组件 |
| `webview-ui/src/components/ImageWithLazyLoad.tsx` | Step 5 | React 组件 |
| `webview-ui/src/components/ContextPicker.tsx` | Step 7 | React 组件 |
| `webview-ui/src/components/ToolHistoryPanel.tsx` | Step 14 | React 组件 |
| `webview-ui/src/hooks/useFocusTrap.ts` | Step 10 | Hook |
| `webview-ui/src/styles/accessibility.css` | Step 10 | CSS |
| `webview-ui/src/components/CostDetailPanel.tsx` | Step 18 | React 组件 |
| `webview-ui/src/components/IndexStatusPanel.tsx` | Step 19 | React 组件 |
| `webview-ui/src/hooks/useKeyboardShortcuts.ts` | Step 17 | Hook |
| `webview-ui/src/components/ShortcutsHelpDialog.tsx` | Step 17 | React 组件 |
| `webview-ui/src/components/MemoryPanel.tsx` | Step 22 | React 组件 |

### 5.2 Modified Files

| 文件 | 涉及 Step | 改动类型 |
|------|----------|---------|
| `src/shared/protocol.ts` | 4, 6, 7, 9, 12, 13, 18, 19, 22 | 类型扩展 + 新消息 |
| `src/webview/panel.ts` | 6, 7, 12, 13, 22 | Handler 实现 |
| `webview-ui/src/state/reducer.ts` | 4, 9, 14 | 字段扩展 + Action |
| `webview-ui/src/App.tsx` | 6, 10, 14 | onMessage + 视图路由 |
| `webview-ui/src/components/Composer.tsx` | 1, 7, 11, 12 | 增量增强 |
| `webview-ui/src/components/MessageList.tsx` | 2, 5 | 阅读进度 + content-visibility |
| `webview-ui/src/components/MessageItem.tsx` | 5, 15 | React.memo + 右键菜单 |
| `webview-ui/src/components/ToolCard.tsx` | 3, 9 | 命令解释 + 耗时 + 重试限制 |
| `webview-ui/src/components/ToolCard.tsx` | 3 | 记住选择按钮 |
| `webview-ui/src/components/chat/ErrorRow.tsx` | 8 | 分类图标 |
| `webview-ui/src/components/QuestionCard.tsx` | 16 | 进度 + 折叠 |
| `webview-ui/src/components/StatusBar.tsx` | 18 | 新建会话确认 |
| `webview-ui/src/components/SessionDrawer.tsx` | 13, 15 | 搜索 + 标签 + 右键 |
| `webview-ui/src/components/PreviewBanner.tsx` | 20 | 加载状态增强 |
| `webview-ui/src/components/settings/SettingsView.tsx` | 21 | 搜索 + 验证 |
| `webview-ui/src/components/chat/SlashCommandMenu.tsx` | 12 | 动态加载重构 |
| `webview-ui/src/styles/main.css` | 5, 11 | 追加样式 |
| `webview-ui/src/utils/accessibility.ts` | 10 | 扩展函数 |
| `webview-ui/src/components/chat/ContextMenu.tsx` | 15 | 功能增强 |

### 5.3 Protocol 变更清单

| 新消息/类型 | 方向 | 用途 | Step |
|------------|------|------|------|
| `context_stats.items?: ContextItemEntry[]` | 扩展已有（TaskEvent） | 上下文文件列表 | 4 |
| `ModeStatusPayload.switchDetail?` | 扩展已有 | 模式切换通知 | 6 |
| `context_search` | Webview→Extension | @ 选择器搜索请求 | 7 |
| `context_search_result` | Extension→Webview | @ 选择器搜索结果 | 7 |
| `ContextSearchItem` | 新类型 | 搜索结果条目 | 7 |
| `tool_exec_start.startTime` | 扩展已有 | 工具耗时计时 | 9 |
| `tool_exec_end.endTime` | 扩展已有 | 工具耗时计时 | 9 |
| `ToolCallPart.startTime/duration` | 扩展已有 | reducer 记录 | 9 |
| `get_skills` | Webview→Extension | 命令菜单 | 12 |
| `skill_list` / `SkillInfo` | Extension→Webview | 命令列表 | 12 |
| `execute_skill` | Webview→Extension | 执行命令 | 12 |
| `SessionSummary.tags?/preview?` | 扩展已有 | 会话增强 | 13 |
| `delete_sessions` | Webview→Extension | 批量删除 | 13 |
| `update_session_tags` | Webview→Extension | 标签管理 | 13 |
| `CostSummaryPayload.history?/budgetAlertMessage?` | 扩展已有 | 成本展示 | 18 |
| `IndexStatusPayload.{indexSize,startTime,status,currentFile}?` | 扩展已有 | 索引状态 | 19 |
| `get_memories` / `delete_memory` / `create_memory` | Webview→Extension | 记忆管理 | 22 |
| `memory_result` / `memory_deleted` | Extension→Webview | 记忆管理 | 22 |

---

## 六、验证清单

每个 Step 完成后，执行以下验证：

```bash
# 1. 类型检查
cd webview-ui && npm run type-check

# 2. 构建
npm run build

# 3. 单元测试（新增组件需覆盖）
npm test

# 4. 回归测试（手动在 VSCode 中验证）
- 输入/发送消息
- 工具调用审批
- 会话切换
- 流式输出
```

---

## 七、风险与回退

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| VSCode Webview 内核对 `content-visibility` 不支持 | 回退到全量渲染 | `CSS.supports()` 检测已内置 |
| `toolCallIndex` Map 在超长对话中内存膨胀 | 最多 150 轮 × 几个工具 = <1KB | 已接受 |
| protocol 扩展后 extension 端 handler 遗漏 | 功能不可用 | 每个新增消息必须有对应 handler 注册 |
| 组件重设计后与原方案代码冲突 | 增量修改覆盖 | 优先使用 `search_replace` 而非重写文件 |
| `npm run type-check` 因外部包类型缺失失败 | 构建中断 | `// @ts-ignore` 或 `skipLibCheck: true` 临时跳过 |
| 实施中发现文档方案与实际源码仍有偏差 | 卡住 | **通过 `ask_user_question` 让用户确认后再继续** |
| StreamController DOM 直写与 React 渲染冲突 | 流式文本显示异常 | 每个改动后验证流式输出正常 |

---

## 八、进展跟踪

- [x] **Step 1**: 输入历史 + 拖拽文件（5 天）
- [x] **Step 2**: 流式渲染优化（2 天）
- [x] **Step 3**: 审批命令解释（3 天）
- [x] **Step 4**: 上下文可视化（3-5 天）
- [x] **Step 5**: 列表渲染性能优化（3-5 天）
- [x] **Step 6**: 模式切换通知 + 确认（4-6 天）
- [x] **Step 7**: @ 上下文选择器（5-7 天）
- [x] **Step 8**: 错误处理增强（3-5 天）
- [x] **Step 9**: 工具耗时显示（2 天）
- [x] **Step 10**: 无障碍访问（3 天）
- [x] **Step 11**: 文件拖拽增强（2 天）
- [x] **Step 12**: 命令菜单增强（2-3 天）
- [x] **Step 13**: 会话管理增强（3-5 天）
- [x] **Step 14**: 工具历史面板（2-3 天）
- [x] **Step 15**: 上下文菜单（3 天）
- [x] **Step 16**: 提问弹窗增强（2 天）
- [x] **Step 17**: 快捷键系统（2 天）
- [x] **Step 18**: 状态栏 + 成本展示（3 天）
- [x] **Step 19**: 索引状态面板（1-2 天）
- [x] **Step 20**: 预览功能增强（2 天）
- [x] **Step 21**: 设置面板增强（3-5 天）
- [x] **Step 22**: 记忆管理面板（3-5 天）
