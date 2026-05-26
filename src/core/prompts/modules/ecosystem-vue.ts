/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Ecosystem · Vue 3（W13.2 续作 · Phase 3 国产生态适配）
 *
 * L1 条件注入模块——由 ecosystem-probe 扫描 package.json dependencies/devDependencies 命中
 * "vue" 且版本 >= 3.0 时自动挂载。
 *
 * 内容结构（遵循 W13.1 设计深度决策：SOP + 陷阱清单）：
 *   1. 语言与文件约定（.vue SFC / TS 支持 / <script setup>）
 *   2. Composition API SOP（ref / reactive / computed / watch / watchEffect）
 *   3. 组件通信（defineProps / defineEmits / defineExpose / provide-inject）
 *   4. Vue Router 4 约定（createRouter / useRoute / useRouter / 路由守卫）
 *   5. Pinia 约定（defineStore / setup-style / options-style）
 *   6. Pitfalls（响应式陷阱 / 模板 ref / async 组件 / Teleport）
 *   7. 工程约定（vite / vue-tsc / eslint-plugin-vue）
 *
 * 字节级常量：同输入恒等输出，便于缓存对齐 & 单测断言。
 */
export const VUE_ECOSYSTEM_MODULE = [
  '## Vue 3 ecosystem rules (auto-loaded by package.json detection)',
  '',
  '### Language & files',
  '- Vue 3 项目默认走 Composition API + `<script setup lang="ts">`：SFC 内容顺序为 `<script setup>` → `<template>` → `<style scoped>`。',
  '- 禁用 Options API 新写法（data()/methods/computed 对象）；历史代码维护时保留原风格。',
  '- 文件命名：组件 PascalCase（如 `UserCard.vue`），composable 文件 camelCase 带 `use` 前缀（如 `useAuth.ts`），Pinia store 文件带 `.store.ts` 后缀。',
  '',
  '### Composition API SOP',
  '- 响应式优先级：`ref()` 适合基本类型/单值对象（`.value` 访问）> `reactive()` 适合纯对象（不可重新赋值整体）> `shallowRef/shallowReactive` 大型数据避深度响应。',
  '- `computed` 用于派生数据只读；可写 computed 用 `{ get, set }` 形式；`watch` 用于副作用（fetch/DOM/log），`watchEffect` 用于自动追踪依赖的副作用。',
  '- `<script setup>` 中顶层 await 合法（自动 `defineAsyncComponent` 包裹），但会影响挂载时机，需配 `<Suspense>` 使用。',
  '- `onMounted` / `onUnmounted` / `onBeforeRouteLeave` 等钩子必须同步调用于 setup 顶层，不能放入 `if` / 异步回调中。',
  '',
  '### 组件通信',
  '- Props 定义走 `const props = defineProps<{ count: number; label?: string }>()`（TS 类型推导）；不要用 runtime 对象形式 `defineProps({...})`，类型推导较弱。',
  '- Emits 定义走 `const emit = defineEmits<{ (e: \'update\', val: number): void }>()`；父组件用 `v-on:update` 或 `@update` 监听。',
  '- 双向绑定：子组件 `defineEmits<{(e: \'update:modelValue\', v: T): void}>()` + props `modelValue`，父组件用 `v-model`。',
  '- 透传属性走 `defineProps` 后剩余属性自动透传到根元素；多根元素需 `useAttrs()` 手动分发。',
  '',
  '### Vue Router 4',
  '- 路由定义：`createRouter({ history: createWebHistory(), routes })`；路由文件集中在 `src/router/index.ts`。',
  '- setup 内访问走 `const route = useRoute(); const router = useRouter();`——不要 `this.$route` / `this.$router`。',
  '- 路由守卫 `beforeEach` 写在路由模块 export 之前；组件内守卫走 `onBeforeRouteLeave` / `onBeforeRouteUpdate`。',
  '- 动态路由 `path: \'/user/:id\'` + `route.params.id`（string | string[]）；TS 下常需 `as string` 断言。',
  '',
  '### Pinia',
  '- 优先用 setup-style：`defineStore(\'user\', () => { const name = ref(\'\'); const login = () => { ... }; return { name, login } })`——更简洁、TS 友好。',
  '- options-style 用于明确区分 state/getters/actions 的老项目；两者不可混用于同一 store。',
  '- store 只在 setup 或 composable 内调用 `useUserStore()`；不要在路由守卫/工具函数顶层调用（pinia 实例未注入）。',
  '- 持久化走 `pinia-plugin-persistedstate`，在 `createPinia().use(piniaPluginPersistedstate)` 处挂载。',
  '',
  '### Pitfalls（常见陷阱）',
  '- `ref()` 在模板中自动解包无需 `.value`；但在脚本内必须写 `.value`，否则操作的是 Ref 对象本身。',
  '- `reactive()` 解构丢失响应性：`const { count } = reactive({count:0})` → count 变普通值；改用 `toRefs()` 或直接访问 `state.count`。',
  '- 模板 ref：`const el = ref<HTMLDivElement | null>(null)` + `<div ref="el">`，访问必须在 `onMounted` 之后，且 `el.value` 可能为 null。',
  '- Teleport 目标 `<Teleport to="body">` 需在 mount 时 body 已存在；SSR 场景用 `<ClientOnly>` 包裹。',
  '- 异步组件 `defineAsyncComponent(() => import(\'./Heavy.vue\'))` 必须搭配 `<Suspense>` 处理 pending 态。',
  '',
  '### 工程约定',
  '- 构建走 Vite（`vite` + `@vitejs/plugin-vue`）；TS 类型检查走 `vue-tsc --noEmit`（不是 `tsc`，vue-tsc 能解析 SFC）。',
  '- ESLint：`eslint-plugin-vue` + `@vue/eslint-config-typescript`；prettier 与 vue 插件共存需 `eslint-config-prettier` 关冲突规则。',
  '- package.json scripts 典型：`"dev": "vite"` / `"build": "vue-tsc -b && vite build"` / `"preview": "vite preview"`。',
].join('\n');
