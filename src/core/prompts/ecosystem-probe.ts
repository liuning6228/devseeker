/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Ecosystem Probe（W13.2 · Phase 3 国产生态适配探测器）
 *
 * 扫描工作区根目录，识别是否命中特定技术栈；命中后由 `buildEcosystemBlock()`
 * 将对应 `ecosystem-*` module 常量拼接为可注入的 prompt 文本块。
 *
 * 设计原则：
 * 1. **可测试**：所有 fs IO 通过 `fsLike` DI，纯函数易于 stub。
 * 2. **轻量**：只做"存在性判定"，不解析文件内容，单次调用 ≤ 3 次 stat。
 * 3. **条件注入**：只在 L3 层注入检测到的 module；通用项目零开销。
 * 4. **字节级稳定**：未命中返回空字符串；命中则拼接稳定常量。
 * 5. **可扩展**：当前只实现 HarmonyOS；Vue / Element Plus / 通义灵码留 API 位但未实现。
 *
 * 与 environment-probe 的分工：
 *   - environment-probe 采集 OS/shell/node 等"运行时"静态环境（每轮注入 L3）。
 *   - 本探测采集"工作区技术栈"类静态信号；首轮注入即可缓存复用。
 */

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { HARMONYOS_ECOSYSTEM_MODULE } from './modules/ecosystem-harmonyos.js';
import { VUE_ECOSYSTEM_MODULE } from './modules/ecosystem-vue.js';
import { ELEMENT_PLUS_ECOSYSTEM_MODULE } from './modules/ecosystem-element-plus.js';
import { TONGYI_ECOSYSTEM_MODULE } from './modules/ecosystem-tongyi.js';
import { apiDocIndex } from '../../services/web-research/api-knowledge/api-doc-index.js';

/** 支持的生态标识（W13.2-C：harmonyos/vue/element-plus/tongyi 全部落地） */
export type EcosystemKind = 'harmonyos' | 'vue' | 'element-plus' | 'tongyi';

export interface EcosystemDetection {
  /** 命中的生态标识 */
  kind: EcosystemKind;
  /** 证据文件的相对路径（便于调试与展示） */
  evidence: string;
}

export interface FsLike {
  /** 存在性判定（stat 语义） */
  access: (p: string) => Promise<void>;
  /**
   * 读取 UTF-8 文本；用于解析 package.json 依赖。未实现读文件的 stub 可省略，
   * 调用方需注意：省略时无法探测 Vue / Element Plus（仅 HarmonyOS 存在性探测仍可用）。
   */
  readFile?: (p: string) => Promise<string>;
}

export interface EcosystemProbeOptions {
  /** 工作区根目录；未传则直接返回空数组 */
  workspaceRoot?: string;
  /** DI fs 模块，默认 node:fs/promises */
  fsLike?: FsLike;
}

/**
 * HarmonyOS/ArkTS 探测文件清单（按优先级）。
 * 任一命中即认定为鸿蒙项目——module.json5 最强标识，其余辅助验证。
 */
export const HARMONYOS_SIGNALS: readonly string[] = [
  'oh-package.json5',
  'build-profile.json5',
  'entry/src/main/module.json5',
  'AppScope/app.json5',
];

/**
 * package.json 依赖探测表：键为依赖包名，值为对应的 EcosystemKind。
 * 扫描 dependencies + devDependencies + peerDependencies 合集。
 *
 * 通义灵码（tongyi）生态探测策略：只要依赖里含「通义/DashScope/Qwen SDK」之一即视为命中，
 * 同一工作区多包命中也只输出一条证据（最先命中的包名）。
 */
export const PACKAGE_JSON_SIGNALS: ReadonlyMap<string, EcosystemKind> = new Map([
  ['vue', 'vue'],
  ['element-plus', 'element-plus'],
  ['dashscope', 'tongyi'],
  ['@dashscope/dashscope-sdk-nodejs', 'tongyi'],
  ['qwen-agent', 'tongyi'],
  ['@alicloud/dashscope20230601', 'tongyi'],
]);

/** 判定给定相对路径在工作区内是否存在（stat 方式）。 */
async function exists(fs: FsLike, absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取并解析 package.json，返回依赖集合（合并 dependencies/devDependencies/peerDependencies）。
 * 解析失败返回空集合——生态探测不应因 JSON 破损而阻塞主流程。
 */
async function readPackageDeps(fs: FsLike, root: string): Promise<Set<string>> {
  if (!fs.readFile) return new Set();
  const pkgPath = join(root, 'package.json');
  try {
    const text = await fs.readFile(pkgPath);
    const pkg = JSON.parse(text) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const deps = new Set<string>();
    for (const section of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
      if (section && typeof section === 'object') {
        for (const k of Object.keys(section)) deps.add(k);
      }
    }
    return deps;
  } catch {
    return new Set();
  }
}

/**
 * 探测工作区命中的所有生态标识。未命中返回空数组。
 *
 * 当前实现：
 *   - ✅ HarmonyOS / ArkTS（文件存在性探测）
 *   - ✅ Vue 3（package.json 依赖 "vue"）
 *   - ✅ Element Plus（package.json 依赖 "element-plus"）
 *   - ✅ 通义 / Qwen SDK（package.json 依赖 dashscope / @dashscope/* / qwen-agent 任一）
 *
 * 探测顺序：HarmonyOS → package.json 依赖链（Vue → Element Plus → 通义）；
 * 同类型命中只记一条；多生态同存会返回多条（如 Vue + Element Plus + 通义）。
 */
export async function detectEcosystems(
  opts: EcosystemProbeOptions = {},
): Promise<readonly EcosystemDetection[]> {
  if (!opts.workspaceRoot) return [];
  const fs = opts.fsLike ?? {
    access: (p: string) => fsp.access(p),
    readFile: (p: string) => fsp.readFile(p, 'utf-8'),
  };
  const root = opts.workspaceRoot;
  const hits: EcosystemDetection[] = [];

  // 1. HarmonyOS：文件存在性探测
  for (const rel of HARMONYOS_SIGNALS) {
    if (await exists(fs, join(root, rel))) {
      hits.push({ kind: 'harmonyos', evidence: rel });
      break; // 同类型命中一条即可
    }
  }

  // 2. package.json 依赖链：按 PACKAGE_JSON_SIGNALS 顺序匹配
  const deps = await readPackageDeps(fs, root);
  if (deps.size > 0) {
    const seen = new Set<EcosystemKind>();
    for (const [pkgName, kind] of PACKAGE_JSON_SIGNALS) {
      if (deps.has(pkgName) && !seen.has(kind)) {
        hits.push({ kind, evidence: `package.json:${pkgName}` });
        seen.add(kind);
      }
    }
  }

  return hits;
}

/**
 * 将探测结果映射为可注入的 prompt 文本块。
 *
 * 输出示例：
 * ```
 * <ecosystem kind="harmonyos" evidence="oh-package.json5">
 * ## HarmonyOS / ArkTS ecosystem rules ...
 * </ecosystem>
 * ```
 *
 * 多 ecosystem 命中时按稳定顺序拼接，块间单空行分隔。
 */
export function formatEcosystemBlock(detections: readonly EcosystemDetection[]): string {
  if (detections.length === 0) return '';
  const blocks: string[] = [];
  for (const d of detections) {
    const body = selectEcosystemModule(d.kind);
    if (!body) continue;
    blocks.push(
      `<ecosystem kind="${d.kind}" evidence="${d.evidence}">\n${body}\n</ecosystem>`,
    );
  }
  return blocks.join('\n\n');
}

/** 按 kind 选择对应的 module 常量；未来新增生态在此扩展 switch 分支。 */
export function selectEcosystemModule(kind: EcosystemKind): string | undefined {
  switch (kind) {
    case 'harmonyos':
      return HARMONYOS_ECOSYSTEM_MODULE;
    case 'vue':
      return VUE_ECOSYSTEM_MODULE;
    case 'element-plus':
      return ELEMENT_PLUS_ECOSYSTEM_MODULE;
    case 'tongyi':
      return TONGYI_ECOSYSTEM_MODULE;
    default:
      return undefined;
  }
}

/** 便捷组合：探测 + 格式化，一步到位。未命中返回空字符串。 */
export async function buildEcosystemBlock(opts: EcosystemProbeOptions = {}): Promise<string> {
  const detections = await detectEcosystems(opts);
  let ecosystemBlock = formatEcosystemBlock(detections);

  // §8.16.2 · 中文 API 文档注入：当检测到 Element Plus 或 Vue 项目时，
  // 从 ApiDocIndex 加载预索引的中文 API 知识并追加到块末尾。
  const needsApiKnowledge = detections.some(d =>
    d.kind === 'element-plus' || d.kind === 'vue',
  );
  if (needsApiKnowledge) {
    try {
      await apiDocIndex.load();
    } catch {
      // 加载失败（数据文件不存在）→ 静默跳过
    }
    if (apiDocIndex.isLoaded()) {
      const prefixMap: Partial<Record<EcosystemKind, string[]>> = {
        'element-plus': ['el-'],
        'vue': ['v-'],
      };
      for (const d of detections) {
        const prefixes = prefixMap[d.kind];
        if (prefixes) {
          const summary = apiDocIndex.getKnowledgeSummary(prefixes);
          if (summary) {
            ecosystemBlock += `\n\n${summary}`;
          }
        }
      }
    }
  }

  return ecosystemBlock;
}
