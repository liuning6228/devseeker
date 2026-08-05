/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Spec Manager —— Spec 工作流文件管理（P1）
 *
 * 职责：
 * - Spec 文件的 CRUD（创建 / 读取 / 更新 / 删除）
 * - Frontmatter 解析（feature / status / created）
 * - 状态流转（draft → approved → completed）
 * - Spec 列表查询
 *
 * 存储位置：`.devseeker/specs/<feature-name>/spec.md`
 *
 * spec.md 格式：
 * ```markdown
 * ---
 * feature: <feature-name>
 * status: draft | approved | completed
 * created: 2026-08-05
 * ---
 *
 * # <Feature 名称>
 *
 * ## 需求（Requirement）
 * ...
 *
 * ## 方案（Design）
 * ...
 *
 * ## 任务（Tasks）
 * - [ ] 1. 具体任务描述
 *   - _验收条件: ..._
 * ```
 *
 * 参考：docs/spec-workflow-and-knowledge-engine.md §五
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { WORKSPACE_DIR_NAME } from '../constants.js';
import { AgentError, ErrorCodes } from '../errors/index.js';

// ─────────── Types ───────────

/** Spec 状态 */
export type SpecStatus = 'draft' | 'approved' | 'completed';

/** Spec frontmatter 元数据 */
export interface SpecMeta {
  feature: string;
  status: SpecStatus;
  created: string;
}

/** 完整的 Spec 文档 */
export interface SpecDocument {
  meta: SpecMeta;
  /** 需求部分原文 */
  requirement: string;
  /** 方案部分原文 */
  design: string;
  /** 任务部分原文 */
  tasks: string;
  /** 原始完整内容 */
  raw: string;
}

/** Spec 列表项（轻量摘要） */
export interface SpecSummary {
  feature: string;
  status: SpecStatus;
  created: string;
  /** spec 目录的相对路径 */
  relativePath: string;
}

// ─────────── Constants ───────────

const SPECS_DIR = 'specs';
const SPEC_FILE = 'spec.md';

const VALID_STATUSES: ReadonlySet<SpecStatus> = new Set(['draft', 'approved', 'completed']);

// ─────────── SpecManager ───────────

export class SpecManager {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /** specs 根目录绝对路径 */
  private get specsRoot(): string {
    return path.join(this.workspaceRoot, WORKSPACE_DIR_NAME, SPECS_DIR);
  }

  /** 某个 feature 的 spec 目录 */
  private specDir(feature: string): string {
    return path.join(this.specsRoot, sanitizeFeatureName(feature));
  }

  /** 某个 feature 的 spec 文件路径 */
  private specPath(feature: string): string {
    return path.join(this.specDir(feature), SPEC_FILE);
  }

  // ─────────── CRUD ───────────

  /**
   * 创建新 Spec 文件。
   * 如果 feature 已存在，抛出 SPEC_ALREADY_EXISTS。
   */
  async create(input: {
    feature: string;
    requirement?: string;
    design?: string;
    tasks?: string;
  }): Promise<SpecDocument> {
    const feature = sanitizeFeatureName(input.feature);
    const specFile = this.specPath(feature);

    // 检查是否已存在
    try {
      await fs.access(specFile);
      throw new AgentError({
        code: ErrorCodes.SPEC_ALREADY_EXISTS,
        message: `Spec "${feature}" 已存在。请使用 update 修改，或用不同 feature 名称。`,
      });
    } catch (e) {
      if (e instanceof AgentError) throw e;
      // ENOENT → 不存在，可以继续
    }

    const now = new Date().toISOString().slice(0, 10);
    const content = buildSpecContent({
      feature,
      status: 'draft',
      created: now,
      requirement: input.requirement ?? '',
      design: input.design ?? '',
      tasks: input.tasks ?? '',
    });

    await fs.mkdir(this.specDir(feature), { recursive: true });
    await fs.writeFile(specFile, content, 'utf-8');

    return parseSpecDocument(content);
  }

  /**
   * 读取 Spec 文档。
   * 如果不存在，抛出 SPEC_NOT_FOUND。
   */
  async read(feature: string): Promise<SpecDocument> {
    const specFile = this.specPath(feature);
    let content: string;
    try {
      content = await fs.readFile(specFile, 'utf-8');
    } catch (e) {
      throw new AgentError({
        code: ErrorCodes.SPEC_NOT_FOUND,
        message: `Spec "${feature}" 不存在：${specFile}`,
      });
    }
    return parseSpecDocument(content);
  }

  /**
   * 更新 Spec 的部分内容。
   * 可更新 requirement / design / tasks 中的任意组合。
   * 可选更新 status。
   */
  async update(
    feature: string,
    patch: {
      requirement?: string;
      design?: string;
      tasks?: string;
      status?: SpecStatus;
    },
  ): Promise<SpecDocument> {
    const doc = await this.read(feature);

    // 状态校验
    if (patch.status !== undefined) {
      validateStatusTransition(doc.meta.status, patch.status);
      doc.meta.status = patch.status;
    }

    const content = buildSpecContent({
      feature: doc.meta.feature,
      status: doc.meta.status,
      created: doc.meta.created,
      requirement: patch.requirement ?? doc.requirement,
      design: patch.design ?? doc.design,
      tasks: patch.tasks ?? doc.tasks,
    });

    await fs.writeFile(this.specPath(feature), content, 'utf-8');
    return parseSpecDocument(content);
  }

  /**
   * 删除 Spec。
   * 如果不存在，静默成功（幂等）。
   */
  async remove(feature: string): Promise<void> {
    const dir = this.specDir(feature);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // 幂等：不存在也成功
    }
  }

  /**
   * 列出所有 Spec 摘要。
   */
  async list(): Promise<SpecSummary[]> {
    let entries: string[];
    try {
      const dirEntries = await fs.readdir(this.specsRoot, { withFileTypes: true });
      entries = dirEntries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      // specs 目录不存在 → 空列表
      return [];
    }

    const summaries: SpecSummary[] = [];
    for (const entry of entries) {
      try {
        const doc = await this.read(entry);
        summaries.push({
          feature: doc.meta.feature,
          status: doc.meta.status,
          created: doc.meta.created,
          relativePath: path.join(WORKSPACE_DIR_NAME, SPECS_DIR, entry, SPEC_FILE),
        });
      } catch {
        // 解析失败的 spec 跳过
      }
    }

    // 按 created 倒序
    summaries.sort((a, b) => b.created.localeCompare(a.created));
    return summaries;
  }

  /**
   * 检查某个 feature 的 spec 是否存在。
   */
  async exists(feature: string): Promise<boolean> {
    try {
      await fs.access(this.specPath(feature));
      return true;
    } catch {
      return false;
    }
  }
}

// ─────────── Pure Functions ───────────

/**
 * 解析 spec.md 内容为 SpecDocument。
 */
export function parseSpecDocument(raw: string): SpecDocument {
  const meta = parseFrontmatter(raw);
  const body = stripFrontmatter(raw);

  return {
    meta,
    requirement: extractSection(body, '需求'),
    design: extractSection(body, '方案'),
    tasks: extractSection(body, '任务'),
    raw,
  };
}

/**
 * 解析 YAML frontmatter。
 * 轻量实现，不引入 js-yaml 依赖。
 */
export function parseFrontmatter(content: string): SpecMeta {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    return { feature: 'unknown', status: 'draft', created: new Date().toISOString().slice(0, 10) };
  }

  const front = match[1];
  const feature = extractYamlField(front, 'feature') ?? 'unknown';
  const statusRaw = extractYamlField(front, 'status') ?? 'draft';
  const status = VALID_STATUSES.has(statusRaw as SpecStatus) ? (statusRaw as SpecStatus) : 'draft';
  const created = extractYamlField(front, 'created') ?? new Date().toISOString().slice(0, 10);

  return { feature, status, created };
}

/**
 * 剥离 frontmatter，返回 body 部分。
 */
export function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

/**
 * 从 body 中提取指定标题的 section 内容。
 * 匹配 `## <titleKeyword>` 到下一个 `## ` 之间的内容。
 */
export function extractSection(body: string, titleKeyword: string): string {
  // 支持中英文标题：## 需求（Requirement） 或 ## Requirement
  const patterns = [
    new RegExp(`^## .*${escapeRegex(titleKeyword)}.*$`, 'm'),
  ];

  let startIdx = -1;
  for (const p of patterns) {
    const m = body.match(p);
    if (m && m.index !== undefined) {
      startIdx = m.index + m[0].length;
      break;
    }
  }

  if (startIdx === -1) return '';

  // 找到下一个 ## 开头
  const rest = body.slice(startIdx);
  const nextSection = rest.search(/^## /m);
  const sectionContent = nextSection === -1 ? rest : rest.slice(0, nextSection);

  return sectionContent.trim();
}

/**
 * 构建 spec.md 文件内容。
 */
export function buildSpecContent(input: {
  feature: string;
  status: SpecStatus;
  created: string;
  requirement: string;
  design: string;
  tasks: string;
}): string {
  const parts: string[] = [];

  // Frontmatter
  parts.push('---');
  parts.push(`feature: ${input.feature}`);
  parts.push(`status: ${input.status}`);
  parts.push(`created: ${input.created}`);
  parts.push('---');
  parts.push('');

  // Title
  parts.push(`# ${input.feature}`);
  parts.push('');

  // Requirement
  parts.push('## 需求（Requirement）');
  parts.push('');
  parts.push(input.requirement || '_待补充_');
  parts.push('');

  // Design
  parts.push('## 方案（Design）');
  parts.push('');
  parts.push(input.design || '_待补充_');
  parts.push('');

  // Tasks
  parts.push('## 任务（Tasks）');
  parts.push('');
  parts.push(input.tasks || '_待补充_');
  parts.push('');

  return parts.join('\n');
}

/**
 * 校验状态流转合法性。
 * draft → approved → completed（不可逆）
 */
export function validateStatusTransition(from: SpecStatus, to: SpecStatus): void {
  const valid: Record<SpecStatus, SpecStatus[]> = {
    draft: ['approved'],
    approved: ['completed'],
    completed: [],
  };

  if (from === to) return; // 幂等
  if (!valid[from].includes(to)) {
    throw new AgentError({
      code: ErrorCodes.SPEC_INVALID_STATUS_TRANSITION,
      message: `非法状态流转：${from} → ${to}。允许：${valid[from].join(', ') || '无'}`,
    });
  }
}

// ─────────── Helpers ───────────

function extractYamlField(front: string, key: string): string | undefined {
  const match = front.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 规范化 feature 名称：
 * - 转小写
 * - 空格/特殊字符替换为连字符
 * - 去除首尾连字符
 */
export function sanitizeFeatureName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}
