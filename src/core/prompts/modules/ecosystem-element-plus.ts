/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Ecosystem · Element Plus（W13.2 续作 · Phase 3 国产生态适配）
 *
 * L1 条件注入模块——由 ecosystem-probe 扫描 package.json dependencies/devDependencies 命中
 * "element-plus" 时自动挂载。通常与 vue 模块并列命中（两块拼接）。
 *
 * 内容结构（遵循 W13.1 设计深度决策：SOP + 陷阱清单）：
 *   1. 集成方式（全量 vs 按需 + unplugin-vue-components / unplugin-auto-import）
 *   2. 表单与校验 SOP（ElForm / ElFormItem / FormInstance / validate）
 *   3. 反馈类 API（ElMessage / ElMessageBox / ElNotification / ElLoading）
 *   4. 容器与数据展示（ElTable / ElPagination / ElDialog / ElDrawer）
 *   5. 主题与国际化（useLocale / 主题 token 覆盖 / dark 模式）
 *   6. Pitfalls（按需导入样式 / ElTable 列插槽 / v-model 差异）
 *
 * 字节级常量：同输入恒等输出，便于缓存对齐 & 单测断言。
 */
export const ELEMENT_PLUS_ECOSYSTEM_MODULE = [
  '## Element Plus ecosystem rules (auto-loaded by package.json detection)',
  '',
  '### 集成方式',
  '- 生产项目优先按需导入：`unplugin-vue-components` + `unplugin-auto-import` + `ElementPlusResolver`；vite 配置里同时挂两个插件的 resolvers 数组。',
  '- 按需导入**必须**同时导入样式：全局 `import \'element-plus/dist/index.css\'` 或 scoped 模式由 resolvers 自动注入；漏样式会导致组件黑白无边框。',
  '- 中文本地化：`import zhCn from \'element-plus/es/locale/lang/zh-cn\'` + `<el-config-provider :locale="zhCn">` 包裹根组件。',
  '- 图标走独立包 `@element-plus/icons-vue`，`<el-icon><Edit /></el-icon>` 形式；不要用 Font Awesome/iconfont 混用。',
  '',
  '### 表单与校验 SOP',
  '- 表单结构固定：`<el-form ref="formRef" :model="form" :rules="rules">` + `<el-form-item prop="name">` + 输入组件；`prop` 必须匹配 `rules` 的 key 才能触发校验。',
  '- 校验触发：`await formRef.value?.validate()` 返回 Promise<boolean>；失败时 catch 拿到 invalid fields 对象。',
  '- 重置走 `formRef.value?.resetFields()`——只重置 `initialValue`（首次渲染的值），不是清空。要清空需手动 `form.xxx = \'\'` 配合。',
  '- 单字段校验 `formRef.value?.validateField(\'name\')`；清除校验态 `clearValidate(\'name\')`。',
  '- 自定义校验器 `validator: (rule, value, callback) => callback()`——**必须**调 callback(无参成功 / new Error(\'msg\') 失败)，否则 validate 永挂起。',
  '',
  '### 反馈类 API',
  '- 命令式消息：`ElMessage.success(\'保存成功\')` / `ElMessage({ type: \'warning\', message: \'xxx\', duration: 0 })`；duration=0 表示不自动关闭。',
  '- 确认框：`await ElMessageBox.confirm(\'确认删除？\', \'提示\', { type: \'warning\' })` 返回 Promise，用户点取消会 reject（必须 try/catch 否则报 uncaught）。',
  '- 通知：`ElNotification({ title, message, type, duration })` 适合异步操作完成的弹窗；消息通知用 ElMessage 更轻。',
  '- 全屏 loading：`const loading = ElLoading.service({ fullscreen: true }); loading.close();`——必须手动 close，不要依赖 GC。',
  '',
  '### 容器与数据展示',
  '- ElTable：`<el-table :data="rows">` + `<el-table-column prop="name" label="姓名">`；复杂单元格用 `#default="{ row, $index }"` 作用域插槽。',
  '- ElPagination：`:page-size` `:total` `:current-page` 双向绑定，`@current-change` 回调。默认 `layout="prev, pager, next"`，生产常配 `layout="total, sizes, prev, pager, next, jumper"`。',
  '- ElDialog：`<el-dialog v-model="visible" title="编辑">`；`@close` 钩子清理表单。嵌套 Dialog 需加 `append-to-body`。',
  '- ElDrawer 用法等同 Dialog，`direction` 控制抽屉方向。',
  '',
  '### 主题与国际化',
  '- CSS 变量覆盖：`:root { --el-color-primary: #409eff; }`；SCSS 方式见官方 `element-plus/theme-chalk/src/common/var.scss`。',
  '- 暗黑模式：根节点加 `class="dark"` + 引入 `import \'element-plus/theme-chalk/dark/css-vars.css\'`。',
  '- 多语言切换：`<el-config-provider :locale="locale">` + `const locale = computed(() => lang.value === \'zh\' ? zhCn : en)`。',
  '',
  '### Pitfalls（常见陷阱）',
  '- 按需导入忘记样式：组件能渲染但无样式 → resolvers 里务必包含 `ElementPlusResolver({ importStyle: \'sass\' })` 或显式 `import \'element-plus/dist/index.css\'`。',
  '- ElTable 列插槽模板：Element Plus 3+ 使用 `#default="{ row }"` 而不是 `slot-scope`；历史代码迁移要改写。',
  '- `v-model` 在 ElInput 是 string 双向绑定；ElInputNumber 是 number | undefined（当输入被清空时是 undefined 不是 0，要小心 null 判定）。',
  '- ElForm 的 `rules` 用响应式对象（reactive）避免 computed 失效；嵌套字段 prop 写点路径：`prop="user.email"`。',
  '- ElMessageBox.confirm 的 reject 必须 catch：`await ElMessageBox.confirm(...).catch(() => {})` 否则控制台报 uncaught promise。',
].join('\n');
