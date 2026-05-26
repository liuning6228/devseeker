/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Ecosystem Probe 单测（W13.2 · Phase 3 国产生态适配）
 *
 * 覆盖面：
 *   - detectEcosystems：文件存在/不存在/workspaceRoot 缺失
 *   - HARMONYOS_SIGNALS 四个优先级信号全覆盖
 *   - formatEcosystemBlock：块头/空输入/多生态拼接
 *   - buildEcosystemBlock：端到端组合
 *   - HARMONYOS_ECOSYSTEM_MODULE：关键内容断言（ArkTS / 装饰器 / 陷阱）
 *   - selectEcosystemModule：未实现生态返回 undefined
 */

import { describe, it, expect } from 'vitest';
import {
  detectEcosystems,
  formatEcosystemBlock,
  selectEcosystemModule,
  buildEcosystemBlock,
  HARMONYOS_SIGNALS,
  PACKAGE_JSON_SIGNALS,
  type FsLike,
} from '../../src/core/prompts/ecosystem-probe.js';
import { HARMONYOS_ECOSYSTEM_MODULE } from '../../src/core/prompts/modules/ecosystem-harmonyos.js';
import { VUE_ECOSYSTEM_MODULE } from '../../src/core/prompts/modules/ecosystem-vue.js';
import { ELEMENT_PLUS_ECOSYSTEM_MODULE } from '../../src/core/prompts/modules/ecosystem-element-plus.js';
import { TONGYI_ECOSYSTEM_MODULE } from '../../src/core/prompts/modules/ecosystem-tongyi.js';

/**
 * 构造一个假 fs：只认指定的绝对路径清单为存在，其余一律 ENOENT。
 * 可选传入 fileContents 映射模拟 readFile（用于 package.json 依赖探测）。
 */
function makeFs(
  existingPaths: readonly string[],
  fileContents?: Readonly<Record<string, string>>,
): FsLike {
  const set = new Set(existingPaths.map((p) => p.replace(/\\/g, '/')));
  const contents = new Map<string, string>();
  if (fileContents) {
    for (const [k, v] of Object.entries(fileContents)) {
      contents.set(k.replace(/\\/g, '/'), v);
    }
  }
  return {
    access: async (p: string) => {
      const normalized = p.replace(/\\/g, '/');
      if (set.has(normalized) || contents.has(normalized)) return;
      throw new Error(`ENOENT: ${p}`);
    },
    readFile: async (p: string) => {
      const normalized = p.replace(/\\/g, '/');
      const text = contents.get(normalized);
      if (text === undefined) throw new Error(`ENOENT: ${p}`);
      return text;
    },
  };
}

describe('W13.2 · ecosystem-probe · detectEcosystems', () => {
  it('无 workspaceRoot → 返回空数组（不触发 IO）', async () => {
    const out = await detectEcosystems({});
    expect(out).toEqual([]);
  });

  it('workspace 无任何鸿蒙文件 → 返回空数组', async () => {
    const fs = makeFs([]);
    const out = await detectEcosystems({ workspaceRoot: '/root', fsLike: fs });
    expect(out).toEqual([]);
  });

  it('命中 oh-package.json5 → kind=harmonyos', async () => {
    const fs = makeFs(['/root/oh-package.json5']);
    const out = await detectEcosystems({ workspaceRoot: '/root', fsLike: fs });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('harmonyos');
    expect(out[0].evidence).toBe('oh-package.json5');
  });

  it('命中 build-profile.json5（次优先级） → kind=harmonyos', async () => {
    const fs = makeFs(['/root/build-profile.json5']);
    const out = await detectEcosystems({ workspaceRoot: '/root', fsLike: fs });
    expect(out).toHaveLength(1);
    expect(out[0].evidence).toBe('build-profile.json5');
  });

  it('命中 entry/src/main/module.json5（深层路径）', async () => {
    const fs = makeFs(['/root/entry/src/main/module.json5']);
    const out = await detectEcosystems({ workspaceRoot: '/root', fsLike: fs });
    expect(out).toHaveLength(1);
    expect(out[0].evidence).toBe('entry/src/main/module.json5');
  });

  it('命中 AppScope/app.json5（兜底标识）', async () => {
    const fs = makeFs(['/root/AppScope/app.json5']);
    const out = await detectEcosystems({ workspaceRoot: '/root', fsLike: fs });
    expect(out).toHaveLength(1);
    expect(out[0].evidence).toBe('AppScope/app.json5');
  });

  it('多文件同时存在 → 只记一条 harmonyos（按 HARMONYOS_SIGNALS 优先级取首个）', async () => {
    const fs = makeFs([
      '/root/oh-package.json5',
      '/root/build-profile.json5',
      '/root/AppScope/app.json5',
    ]);
    const out = await detectEcosystems({ workspaceRoot: '/root', fsLike: fs });
    expect(out).toHaveLength(1);
    expect(out[0].evidence).toBe('oh-package.json5');
  });
});

describe('W13.2 · ecosystem-probe · formatEcosystemBlock', () => {
  it('空输入 → 空字符串', () => {
    expect(formatEcosystemBlock([])).toBe('');
  });

  it('HarmonyOS 命中 → 含 <ecosystem kind="harmonyos"> 块头 + 模块正文', () => {
    const out = formatEcosystemBlock([{ kind: 'harmonyos', evidence: 'oh-package.json5' }]);
    expect(out).toContain('<ecosystem kind="harmonyos" evidence="oh-package.json5">');
    expect(out).toContain('</ecosystem>');
    expect(out).toContain('HarmonyOS / ArkTS ecosystem rules');
  });

  it('未实现生态 kind → 该条跳过（不产出块）', () => {
    const out = formatEcosystemBlock([
      // 故意伪造一个未知 kind 触发 default 分支；用 as any 绕过类型
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { kind: 'unknown-kind' as any, evidence: 'fake.json' },
      { kind: 'harmonyos', evidence: 'oh-package.json5' },
    ]);
    // unknown-kind 无 module，只出 harmonyos 块
    expect(out).not.toContain('kind="unknown-kind"');
    expect(out).toContain('kind="harmonyos"');
  });

  it('同输入两次调用字节级一致（稳定性）', () => {
    const a = formatEcosystemBlock([{ kind: 'harmonyos', evidence: 'oh-package.json5' }]);
    const b = formatEcosystemBlock([{ kind: 'harmonyos', evidence: 'oh-package.json5' }]);
    expect(a).toBe(b);
  });
});

describe('W13.2 · ecosystem-probe · selectEcosystemModule', () => {
  it('harmonyos → 返回 HARMONYOS_ECOSYSTEM_MODULE', () => {
    expect(selectEcosystemModule('harmonyos')).toBe(HARMONYOS_ECOSYSTEM_MODULE);
  });

  it('vue → 返回 VUE_ECOSYSTEM_MODULE', () => {
    expect(selectEcosystemModule('vue')).toBe(VUE_ECOSYSTEM_MODULE);
  });

  it('element-plus → 返回 ELEMENT_PLUS_ECOSYSTEM_MODULE', () => {
    expect(selectEcosystemModule('element-plus')).toBe(ELEMENT_PLUS_ECOSYSTEM_MODULE);
  });

  it('tongyi → 返回 TONGYI_ECOSYSTEM_MODULE', () => {
    expect(selectEcosystemModule('tongyi')).toBe(TONGYI_ECOSYSTEM_MODULE);
  });
});

describe('W13.2 · ecosystem-probe · buildEcosystemBlock (端到端)', () => {
  it('workspace 命中鸿蒙 → 直接产出可注入文本块', async () => {
    const fs = makeFs(['/root/oh-package.json5']);
    const out = await buildEcosystemBlock({ workspaceRoot: '/root', fsLike: fs });
    expect(out).toContain('<ecosystem kind="harmonyos"');
    expect(out).toContain('ArkTS');
  });

  it('workspace 未命中 → 返回空字符串（通用项目零注入）', async () => {
    const fs = makeFs([]);
    const out = await buildEcosystemBlock({ workspaceRoot: '/root', fsLike: fs });
    expect(out).toBe('');
  });

  it('无 workspaceRoot → 返回空字符串', async () => {
    const out = await buildEcosystemBlock({});
    expect(out).toBe('');
  });
});

describe('W13.2 · HARMONYOS_ECOSYSTEM_MODULE 内容断言', () => {
  it('包含核心 section 标题', () => {
    expect(HARMONYOS_ECOSYSTEM_MODULE).toContain('HarmonyOS / ArkTS ecosystem rules');
    expect(HARMONYOS_ECOSYSTEM_MODULE).toContain('### Language & files');
    expect(HARMONYOS_ECOSYSTEM_MODULE).toContain('### UI 装饰器 SOP');
    expect(HARMONYOS_ECOSYSTEM_MODULE).toContain('### Ability 与元服务');
    expect(HARMONYOS_ECOSYSTEM_MODULE).toContain('### Pitfalls');
    expect(HARMONYOS_ECOSYSTEM_MODULE).toContain('### 工程约定');
  });

  it('覆盖关键装饰器清单（@Entry/@Component/@State/@Link/@Prop/@Watch/@Builder/@Styles）', () => {
    for (const decorator of [
      '@Entry',
      '@Component',
      '@State',
      '@Link',
      '@Prop',
      '@Watch',
      '@Builder',
      '@Styles',
    ]) {
      expect(HARMONYOS_ECOSYSTEM_MODULE).toContain(decorator);
    }
  });

  it('覆盖关键工程文件（oh-package.json5 / build-profile.json5 / module.json5 / app.json5）', () => {
    expect(HARMONYOS_ECOSYSTEM_MODULE).toContain('oh-package.json5');
    expect(HARMONYOS_ECOSYSTEM_MODULE).toContain('build-profile.json5');
    expect(HARMONYOS_ECOSYSTEM_MODULE).toContain('module.json5');
    expect(HARMONYOS_ECOSYSTEM_MODULE).toContain('app.json5');
  });

  it('覆盖关键命令与工具（hvigorw / hdc / ohpm）', () => {
    expect(HARMONYOS_ECOSYSTEM_MODULE).toContain('hvigorw');
    expect(HARMONYOS_ECOSYSTEM_MODULE).toContain('hdc');
    expect(HARMONYOS_ECOSYSTEM_MODULE).toContain('ohpm');
  });

  it('覆盖关键陷阱规则（ForEach keyGenerator / build() 副作用禁令）', () => {
    expect(HARMONYOS_ECOSYSTEM_MODULE).toContain('ForEach');
    expect(HARMONYOS_ECOSYSTEM_MODULE).toContain('keyGenerator');
    expect(HARMONYOS_ECOSYSTEM_MODULE).toContain('build()');
  });

  it('HARMONYOS_SIGNALS 与 module 正文内容互相一致', () => {
    // 四个信号文件名都应在 module 正文中被提及（作为权威工程约定）
    for (const signal of HARMONYOS_SIGNALS) {
      const basename = signal.split('/').pop() ?? signal;
      expect(HARMONYOS_ECOSYSTEM_MODULE).toContain(basename);
    }
  });
});

// ============================================================================
// W13.2 续作：Vue / Element Plus package.json 依赖探测
// ============================================================================

describe('W13.2-B · ecosystem-probe · Vue/Element Plus detection', () => {
  it('PACKAGE_JSON_SIGNALS 注册正确的映射', () => {
    expect(PACKAGE_JSON_SIGNALS.get('vue')).toBe('vue');
    expect(PACKAGE_JSON_SIGNALS.get('element-plus')).toBe('element-plus');
  });

  it('package.json 含 dependencies.vue → 命中 vue', async () => {
    const root = '/w';
    const pkg = JSON.stringify({ dependencies: { vue: '^3.4.0' } });
    const hits = await detectEcosystems({
      workspaceRoot: root,
      fsLike: makeFs([], { '/w/package.json': pkg }),
    });
    expect(hits.length).toBe(1);
    expect(hits[0]).toEqual({ kind: 'vue', evidence: 'package.json:vue' });
  });

  it('package.json 含 devDependencies.element-plus → 命中 element-plus', async () => {
    const root = '/w';
    const pkg = JSON.stringify({ devDependencies: { 'element-plus': '^2.5.0' } });
    const hits = await detectEcosystems({
      workspaceRoot: root,
      fsLike: makeFs([], { '/w/package.json': pkg }),
    });
    expect(hits.length).toBe(1);
    expect(hits[0].kind).toBe('element-plus');
  });

  it('Vue + Element Plus 同 package.json 命中两条', async () => {
    const root = '/w';
    const pkg = JSON.stringify({
      dependencies: { vue: '^3.4.0', 'element-plus': '^2.5.0' },
    });
    const hits = await detectEcosystems({
      workspaceRoot: root,
      fsLike: makeFs([], { '/w/package.json': pkg }),
    });
    expect(hits.map((h) => h.kind)).toEqual(['vue', 'element-plus']);
  });

  it('peerDependencies 也被采集', async () => {
    const root = '/w';
    const pkg = JSON.stringify({ peerDependencies: { vue: '^3.0.0' } });
    const hits = await detectEcosystems({
      workspaceRoot: root,
      fsLike: makeFs([], { '/w/package.json': pkg }),
    });
    expect(hits.length).toBe(1);
    expect(hits[0].kind).toBe('vue');
  });

  it('HarmonyOS + Vue 同时存在 → 返回两条（鸿蒙在前）', async () => {
    const root = '/w';
    const pkg = JSON.stringify({ dependencies: { vue: '^3.4.0' } });
    const hits = await detectEcosystems({
      workspaceRoot: root,
      fsLike: makeFs(['/w/oh-package.json5'], { '/w/package.json': pkg }),
    });
    expect(hits.map((h) => h.kind)).toEqual(['harmonyos', 'vue']);
  });

  it('package.json 破损 JSON → 降级为空依赖，不抛错', async () => {
    const root = '/w';
    const hits = await detectEcosystems({
      workspaceRoot: root,
      fsLike: makeFs([], { '/w/package.json': '{ not valid json' }),
    });
    expect(hits).toEqual([]);
  });

  it('package.json 无 vue/element-plus 相关依赖 → 无命中', async () => {
    const root = '/w';
    const pkg = JSON.stringify({ dependencies: { react: '^18.0.0' } });
    const hits = await detectEcosystems({
      workspaceRoot: root,
      fsLike: makeFs([], { '/w/package.json': pkg }),
    });
    expect(hits).toEqual([]);
  });

  it('fsLike 缺 readFile → 只做存在性探测（Vue/EP 无法命中）', async () => {
    const root = '/w';
    const fs: FsLike = {
      access: async (p: string) => {
        if (p.replace(/\\/g, '/') === '/w/oh-package.json5') return;
        throw new Error('ENOENT');
      },
    };
    const hits = await detectEcosystems({ workspaceRoot: root, fsLike: fs });
    expect(hits).toEqual([{ kind: 'harmonyos', evidence: 'oh-package.json5' }]);
  });
});

// ============================================================================
// W13.2 续作：buildEcosystemBlock 端到端（多命中拼接）
// ============================================================================

describe('W13.2-B · ecosystem-probe · buildEcosystemBlock Vue+EP 多命中', () => {
  it('Vue + Element Plus 同时命中 → 两个 ecosystem 块按检出顺序拼接', async () => {
    const root = '/w';
    const pkg = JSON.stringify({
      dependencies: { vue: '^3.4.0', 'element-plus': '^2.5.0' },
    });
    const out = await buildEcosystemBlock({
      workspaceRoot: root,
      fsLike: makeFs([], { '/w/package.json': pkg }),
    });
    const vueIdx = out.indexOf('kind="vue"');
    const epIdx = out.indexOf('kind="element-plus"');
    expect(vueIdx).toBeGreaterThan(-1);
    expect(epIdx).toBeGreaterThan(-1);
    expect(vueIdx).toBeLessThan(epIdx);
    expect(out).toContain('Composition API');
    expect(out).toContain('Element Plus ecosystem rules');
  });
});

// ============================================================================
// W13.2 续作：模块正文字节级内容断言（冒烟）
// ============================================================================

describe('W13.2-B · VUE_ECOSYSTEM_MODULE 内容断言', () => {
  it('包含 6 大 section 标题', () => {
    expect(VUE_ECOSYSTEM_MODULE).toContain('### Language & files');
    expect(VUE_ECOSYSTEM_MODULE).toContain('### Composition API SOP');
    expect(VUE_ECOSYSTEM_MODULE).toContain('### 组件通信');
    expect(VUE_ECOSYSTEM_MODULE).toContain('### Vue Router 4');
    expect(VUE_ECOSYSTEM_MODULE).toContain('### Pinia');
    expect(VUE_ECOSYSTEM_MODULE).toContain('### Pitfalls');
    expect(VUE_ECOSYSTEM_MODULE).toContain('### 工程约定');
  });

  it('核心 API 与陷阱被提及', () => {
    expect(VUE_ECOSYSTEM_MODULE).toContain('<script setup');
    expect(VUE_ECOSYSTEM_MODULE).toContain('defineProps');
    expect(VUE_ECOSYSTEM_MODULE).toContain('defineEmits');
    expect(VUE_ECOSYSTEM_MODULE).toContain('useRoute');
    expect(VUE_ECOSYSTEM_MODULE).toContain('defineStore');
    expect(VUE_ECOSYSTEM_MODULE).toContain('toRefs');
    expect(VUE_ECOSYSTEM_MODULE).toContain('vue-tsc');
  });
});

describe('W13.2-B · ELEMENT_PLUS_ECOSYSTEM_MODULE 内容断言', () => {
  it('包含核心 section 标题', () => {
    expect(ELEMENT_PLUS_ECOSYSTEM_MODULE).toContain('### 集成方式');
    expect(ELEMENT_PLUS_ECOSYSTEM_MODULE).toContain('### 表单与校验 SOP');
    expect(ELEMENT_PLUS_ECOSYSTEM_MODULE).toContain('### 反馈类 API');
    expect(ELEMENT_PLUS_ECOSYSTEM_MODULE).toContain('### 容器与数据展示');
    expect(ELEMENT_PLUS_ECOSYSTEM_MODULE).toContain('### 主题与国际化');
    expect(ELEMENT_PLUS_ECOSYSTEM_MODULE).toContain('### Pitfalls');
  });

  it('核心 API 与陷阱被提及', () => {
    expect(ELEMENT_PLUS_ECOSYSTEM_MODULE).toContain('ElMessage');
    expect(ELEMENT_PLUS_ECOSYSTEM_MODULE).toContain('ElMessageBox');
    expect(ELEMENT_PLUS_ECOSYSTEM_MODULE).toContain('ElForm');
    expect(ELEMENT_PLUS_ECOSYSTEM_MODULE).toContain('ElTable');
    expect(ELEMENT_PLUS_ECOSYSTEM_MODULE).toContain('unplugin-vue-components');
    expect(ELEMENT_PLUS_ECOSYSTEM_MODULE).toContain('resetFields');
    expect(ELEMENT_PLUS_ECOSYSTEM_MODULE).toContain('el-config-provider');
  });
});

// ============================================================================
// W13.2-C · 通义灵码生态探测与模块内容
// ============================================================================

describe('W13.2-C · 通义灵码生态探测（dashscope / qwen-agent）', () => {
  it('PACKAGE_JSON_SIGNALS 注册了 dashscope / @dashscope/* / qwen-agent', () => {
    expect(PACKAGE_JSON_SIGNALS.get('dashscope')).toBe('tongyi');
    expect(PACKAGE_JSON_SIGNALS.get('@dashscope/dashscope-sdk-nodejs')).toBe('tongyi');
    expect(PACKAGE_JSON_SIGNALS.get('qwen-agent')).toBe('tongyi');
    expect(PACKAGE_JSON_SIGNALS.get('@alicloud/dashscope20230601')).toBe('tongyi');
  });

  it('package.json dependencies.dashscope → 命中 tongyi', async () => {
    const root = '/ws';
    const pkg = JSON.stringify({ dependencies: { dashscope: '^1.0.0' } });
    const fsLike = makeFs([], { '/ws/package.json': pkg });
    const hits = await detectEcosystems({ workspaceRoot: root, fsLike });
    expect(hits).toEqual([{ kind: 'tongyi', evidence: 'package.json:dashscope' }]);
  });

  it('package.json devDependencies.qwen-agent → 命中 tongyi', async () => {
    const root = '/ws';
    const pkg = JSON.stringify({ devDependencies: { 'qwen-agent': '^2.0.0' } });
    const fsLike = makeFs([], { '/ws/package.json': pkg });
    const hits = await detectEcosystems({ workspaceRoot: root, fsLike });
    expect(hits).toEqual([{ kind: 'tongyi', evidence: 'package.json:qwen-agent' }]);
  });

  it('多个通义包同时存在 → 只记一条 tongyi 条目（最先命中的包名作为 evidence）', async () => {
    const root = '/ws';
    const pkg = JSON.stringify({
      dependencies: { dashscope: '^1.0.0', 'qwen-agent': '^2.0.0' },
    });
    const fsLike = makeFs([], { '/ws/package.json': pkg });
    const hits = await detectEcosystems({ workspaceRoot: root, fsLike });
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe('tongyi');
    // 顺序按 PACKAGE_JSON_SIGNALS 的插入顺序：dashscope 先于 qwen-agent
    expect(hits[0].evidence).toBe('package.json:dashscope');
  });

  it('Vue + Element Plus + tongyi 多生态共存按顺序返回', async () => {
    const root = '/ws';
    const pkg = JSON.stringify({
      dependencies: {
        vue: '^3.4.0',
        'element-plus': '^2.5.0',
        dashscope: '^1.0.0',
      },
    });
    const fsLike = makeFs([], { '/ws/package.json': pkg });
    const hits = await detectEcosystems({ workspaceRoot: root, fsLike });
    expect(hits.map((h) => h.kind)).toEqual(['vue', 'element-plus', 'tongyi']);
  });

  it('buildEcosystemBlock 端到端：tongyi 产出 <ecosystem kind="tongyi"> 块 + 模块正文', async () => {
    const root = '/ws';
    const pkg = JSON.stringify({ dependencies: { dashscope: '^1.0.0' } });
    const fsLike = makeFs([], { '/ws/package.json': pkg });
    const out = await buildEcosystemBlock({ workspaceRoot: root, fsLike });
    expect(out).toContain('<ecosystem kind="tongyi" evidence="package.json:dashscope">');
    expect(out).toContain('## 通义 / Qwen 生态集成规范');
    expect(out).toContain('</ecosystem>');
  });
});

describe('W13.2-C · TONGYI_ECOSYSTEM_MODULE 内容断言', () => {
  it('包含核心 section 标题', () => {
    expect(TONGYI_ECOSYSTEM_MODULE).toContain('### 选型：OpenAI 兼容模式 vs 原生 SDK');
    expect(TONGYI_ECOSYSTEM_MODULE).toContain('### 鉴权');
    expect(TONGYI_ECOSYSTEM_MODULE).toContain('### 模型表');
    expect(TONGYI_ECOSYSTEM_MODULE).toContain('### 参数差异与兼容陷阱');
    expect(TONGYI_ECOSYSTEM_MODULE).toContain('### 视觉消息格式');
    expect(TONGYI_ECOSYSTEM_MODULE).toContain('### Function Calling');
    expect(TONGYI_ECOSYSTEM_MODULE).toContain('### 流式响应');
    expect(TONGYI_ECOSYSTEM_MODULE).toContain('### Pitfalls');
  });

  it('核心 baseURL / 模型名 / 鉴权 env 出现', () => {
    expect(TONGYI_ECOSYSTEM_MODULE).toContain('dashscope.aliyuncs.com/compatible-mode/v1');
    expect(TONGYI_ECOSYSTEM_MODULE).toContain('DASHSCOPE_API_KEY');
    expect(TONGYI_ECOSYSTEM_MODULE).toContain('qwen-plus');
    expect(TONGYI_ECOSYSTEM_MODULE).toContain('qwen-max');
    expect(TONGYI_ECOSYSTEM_MODULE).toContain('qwen-vl-max');
    expect(TONGYI_ECOSYSTEM_MODULE).toContain('text-embedding-v3');
  });

  it('Pitfalls 包含关键陷阱关键字', () => {
    expect(TONGYI_ECOSYSTEM_MODULE).toContain('混淆 baseURL');
    expect(TONGYI_ECOSYSTEM_MODULE).toContain('硬编码模型版本号');
    expect(TONGYI_ECOSYSTEM_MODULE).toContain('include_usage');
  });
});
