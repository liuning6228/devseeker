/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Ecosystem · HarmonyOS / ArkTS（W13.2 · Phase 3 国产生态适配）
 *
 * L1 条件注入模块——仅当 ecosystem-probe 检测到 `oh-package.json5` / `build-profile.json5` /
 * `module.json5` 等鸿蒙工程标识时才拼接到 System Prompt，避免对通用项目增加 token 成本。
 *
 * 内容结构（遵循 W13.1 设计深度决策：SOP + 陷阱清单）：
 *   1. 语言与文件约定（ArkTS / .ets / .ts 分界）
 *   2. 装饰器与 UI 组件 SOP（@Entry/@Component/@State/@Link/@Prop/@Watch）
 *   3. Ability 与元服务（UIAbility 生命周期 / 元服务入口）
 *   4. 常见陷阱清单（TS 特性裁剪 / 装饰器顺序 / 资源引用）
 *   5. 工程约定（oh-package.json5 / build-profile.json5）
 *
 * 字节级常量：同输入恒等输出，便于 L0/L1 缓存对齐 & 单测断言。
 * 所有规则条目保持一行一条（便于 prompt 解析与调整）。
 */
export const HARMONYOS_ECOSYSTEM_MODULE = [
  '## HarmonyOS / ArkTS ecosystem rules (auto-loaded by workspace detection)',
  '',
  '### Language & files',
  '- ArkTS 是 TypeScript 的严格子集：.ets 文件承载 UI 组件，.ts 文件承载纯逻辑；禁用 any、禁止结构类型逃逸、禁止运行时对象扩展。',
  '- 组件入口文件以 `@Entry @Component struct Foo { build() { ... } }` 形式书写；build() 方法必须纯声明、禁副作用（不要在 build 里调 setState、fetch、console.log 等）。',
  '- 一切资源引用走 `$r(\'app.string.xxx\')` / `$r(\'app.media.xxx\')`，不要写硬编码字符串；图片放 `resources/base/media/`，多语言放 `resources/base/element/string.json` + 对应语言目录。',
  '',
  '### UI 装饰器 SOP',
  '- 状态装饰器层级：`@State` 组件内本地 > `@Prop` 父→子单向 > `@Link` 父子双向 > `@Provide/@Consume` 跨层级 > `@StorageLink/@AppStorage` 持久化。',
  '- `@Watch(\'stateKey\')` 必须紧跟在对应 `@State`/`@Link` 装饰器**之后**，否则编译期报错；一个 watcher 对应一个 state。',
  '- `@Builder` 函数用于拆分 UI 片段，不能带状态；如需带状态请改用 `@Component struct`。',
  '- `@Styles` 装饰样式函数，`@Extend(ComponentName)` 扩展特定组件链式样式；两者互斥不可混用。',
  '',
  '### Ability 与元服务',
  '- UIAbility 生命周期顺序：`onCreate` → `onWindowStageCreate` → `onForeground` → `onBackground` → `onWindowStageDestroy` → `onDestroy`；资源申请放 onCreate，释放放 onDestroy。',
  '- 元服务（MetaService / Atomic Service）入口放 `entry/src/main/ets/entryability/EntryAbility.ets`，`module.json5` 的 `installationFree=true` 标记为免安装；包体上限 10 MB。',
  '- 路由用 `router.pushUrl({ url: \'pages/Foo\' })`，页面路径写 `module.json5` 的 pages 数组；跨 Ability 跳转用 `Want` + `startAbility`。',
  '',
  '### Pitfalls（常见陷阱）',
  '- ArkTS 不支持 TS 的：结构化类型断言、any/unknown、动态 import、原生 Function.prototype.bind；遇到这些需改写为显式类型/静态 import。',
  '- 装饰器写错顺序（如 `@Component` 写在 `@Entry` 之前）会编译失败——固定顺序：`@Entry` → `@Component` → `struct`。',
  '- `build()` 里不能写 if/for 的 JS 表达式，要用 ArkTS 内置 `if () { }` / `ForEach(arr, (item) => { ... }, (item) => item.id)`；ForEach 第三个参数 keyGenerator 必填以保证 diff 性能。',
  '- 资源访问走 `$r()`/`$rawfile()`，**不要**用 `import` 引相对路径下的图片/字符串。',
  '',
  '### 工程约定',
  '- 依赖配置写 `oh-package.json5`（JSON5 语法：支持注释、尾逗号、单引号），不是 npm 的 package.json；依赖源 OpenHarmony 官方或华为 ohpm。',
  '- 构建配置写 `build-profile.json5`，模块元信息写 `module.json5`，应用元信息写 `app.json5`；三者缺一编译失败。',
  '- 调试时终端命令：`hvigorw assembleHap --mode module -p product=default` 编译，`hdc shell aa start -a EntryAbility -b <bundleName>` 拉起；别用 Gradle/Android Studio 的术语回复用户。',
].join('\n');
