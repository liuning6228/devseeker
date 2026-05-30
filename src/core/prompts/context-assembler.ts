/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * ContextAssembler（DESIGN §M10.4 · B-P1-9）
 *
 * 统一建模   暴露给模型的 5 种用户侧附件：
 *   - `<attached_files>`   → type: 'file'
 *   - `<attached_images>`  → type: 'image'（文本侧仅记元数据，真图像走多模态 content）
 *   - `<selected_codes>`   → type: 'selection'
 *   - `<git_commits>`      → type: 'git_commits'
 *   - `<code_change>`      → type: 'code_change'（用户勾选的已 staged 变更）
 *
 * 设计原则：
 *  - 纯数据 + 纯函数：本模块不触碰 VSCode API / 文件系统；所有 content 由调用方预加载。
 *  - 稳定排序：同类型内按插入顺序；类型间按 DESIGN §M10.4 表格顺序（file → image → selection → commits → code_change）。
 *  - 渲染幂等：同输入 → 字节级一致输出，便于前缀缓存。
 *  - tokenCost 近似：用 §B-P2-8 的 `estimateTokens`（len/4）近似。
 *
 * 与 L3 attachments layer 的衔接：
 *  - `buildL3Attachments` 新增 `attached?: IAttachment[]` 字段；
 *    调用方可直接传入 IAttachment 列表，L3 内部调用 `renderAttachments()` 拼接。
 *  - 现有 `selectedCodes` / `gitContext` 字段保持向后兼容（W3.6 遗留 API）。
 */

import { estimateTokens } from './token-budget.js';

/** 5 种附件类型（DESIGN §M10.4 表）。 */
export type AttachmentType = 'file' | 'image' | 'selection' | 'git_commits' | 'code_change';

/** 基础 IAttachment（与 DESIGN §M10.4 接口一致，字段按 type 收窄）。 */
export interface BaseAttachment {
  /** 会话内唯一 id；用于去重 / 移除。 */
  readonly id: string;
  /** 附件类型。 */
  readonly type: AttachmentType;
  /** 主引用：文件路径 / 图片 ref / commit 范围等。 */
  readonly ref: string;
  /** 可选预加载正文（文件内容 / diff / commits 文本）。 */
  readonly content?: string;
  /** 结构化元数据（由各 type 自行约定）。 */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface FileAttachment extends BaseAttachment {
  readonly type: 'file';
  /** 必须是内容文本（若过大由调用方自行截断）。 */
  readonly content: string;
}

export interface ImageAttachment extends BaseAttachment {
  readonly type: 'image';
  /** 图像附件在文本 L3 中只呈现元数据行（真图像走多模态 content array）。 */
  readonly mime?: string;
  readonly bytes?: number;
  readonly width?: number;
  readonly height?: number;
}

export interface SelectionAttachment extends BaseAttachment {
  readonly type: 'selection';
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  /** 必填：选区文本（可能已按 max chars 截断）。 */
  readonly content: string;
}

export interface GitCommitsAttachment extends BaseAttachment {
  readonly type: 'git_commits';
  /** e.g. "HEAD~3..HEAD" 或单 commit sha。 */
  readonly range: string;
  /** 必填：`git log --oneline` 风格的摘要文本。 */
  readonly content: string;
}

export interface CodeChangeAttachment extends BaseAttachment {
  readonly type: 'code_change';
  /** 必填：`git diff --cached` 文本（可截断）。 */
  readonly content: string;
}

export type IAttachment =
  | FileAttachment
  | ImageAttachment
  | SelectionAttachment
  | GitCommitsAttachment
  | CodeChangeAttachment;

/** ContextAssembler 接口（DESIGN §M10.4）。 */
export interface IContextAssembler {
  addAttachment(a: IAttachment): void;
  removeAttachment(id: string): boolean;
  listAttachments(): readonly IAttachment[];
  clear(): void;
  render(): string;
  tokenCost(): number;
}

/** 单条 file block 渲染。 */
function renderFile(a: FileAttachment): string {
  const meta = a.metadata && Object.keys(a.metadata).length > 0
    ? ` ${Object.entries(a.metadata).map(([k, v]) => `${k}="${String(v)}"`).join(' ')}`
    : '';
  return [
    `<file path="${a.ref}"${meta}>`,
    a.content,
    '</file>',
  ].join('\n');
}

/** 单条 selection block 渲染（与现有 L3 `<selected_codes>` 风格对齐）。 */
function renderSelection(a: SelectionAttachment): string {
  const loc =
    a.startLine === a.endLine
      ? `${a.filePath}:${a.startLine}`
      : `${a.filePath}:${a.startLine}-${a.endLine}`;
  return [
    `<selection path="${loc}">`,
    a.content,
    '</selection>',
  ].join('\n');
}

/** 单条 image 元数据行（真图像数据走多模态 content array）。 */
function renderImage(a: ImageAttachment): string {
  const parts: string[] = [`ref="${a.ref}"`];
  if (a.mime) parts.push(`mime="${a.mime}"`);
  if (typeof a.bytes === 'number') parts.push(`bytes="${a.bytes}"`);
  if (typeof a.width === 'number' && typeof a.height === 'number') {
    parts.push(`size="${a.width}x${a.height}"`);
  }
  return `<image ${parts.join(' ')} />`;
}

function renderCommits(a: GitCommitsAttachment): string {
  return [
    `<commits range="${a.range}">`,
    a.content,
    '</commits>',
  ].join('\n');
}

function renderCodeChange(a: CodeChangeAttachment): string {
  return [
    `<diff ref="${a.ref}">`,
    a.content,
    '</diff>',
  ].join('\n');
}

/**
 * 按 type 分桶渲染为 DESIGN §M10.4 的 5 个顶层 block。
 *
 * - 空输入或某 type 无条目 → 对应顶层 block 不出现
 * - 同类型内按插入顺序保留
 * - 类型间顺序：file → image → selection → commits → code_change
 */
export function renderAttachments(items: readonly IAttachment[]): string {
  if (items.length === 0) return '';

  const files: FileAttachment[] = [];
  const images: ImageAttachment[] = [];
  const selections: SelectionAttachment[] = [];
  const commits: GitCommitsAttachment[] = [];
  const changes: CodeChangeAttachment[] = [];

  for (const it of items) {
    switch (it.type) {
      case 'file': files.push(it); break;
      case 'image': images.push(it); break;
      case 'selection': selections.push(it); break;
      case 'git_commits': commits.push(it); break;
      case 'code_change': changes.push(it); break;
    }
  }

  const blocks: string[] = [];

  if (files.length > 0) {
    blocks.push(['<attached_files>', ...files.map(renderFile), '</attached_files>'].join('\n'));
  }
  if (images.length > 0) {
    blocks.push(['<attached_images>', ...images.map(renderImage), '</attached_images>'].join('\n'));
  }
  if (selections.length > 0) {
    blocks.push(['<selected_codes>', ...selections.map(renderSelection), '</selected_codes>'].join('\n'));
  }
  if (commits.length > 0) {
    blocks.push(['<git_commits>', ...commits.map(renderCommits), '</git_commits>'].join('\n'));
  }
  if (changes.length > 0) {
    blocks.push(['<code_change>', ...changes.map(renderCodeChange), '</code_change>'].join('\n'));
  }

  return blocks.join('\n\n');
}

/** 近似 token 成本（DESIGN §M10.3 预算裁剪用）。 */
export function attachmentsTokenCost(items: readonly IAttachment[]): number {
  return estimateTokens(renderAttachments(items));
}

/**
 * 默认实现：保持插入顺序 + 按 id 去重（后入覆盖旧条目）。
 */
export class ContextAssembler implements IContextAssembler {
  private readonly items: IAttachment[] = [];

  addAttachment(a: IAttachment): void {
    const idx = this.items.findIndex((x) => x.id === a.id);
    if (idx >= 0) this.items[idx] = a;
    else this.items.push(a);
  }

  removeAttachment(id: string): boolean {
    const idx = this.items.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    this.items.splice(idx, 1);
    return true;
  }

  listAttachments(): readonly IAttachment[] {
    return [...this.items];
  }

  clear(): void {
    this.items.length = 0;
  }

  render(): string {
    return renderAttachments(this.items);
  }

  tokenCost(): number {
    return attachmentsTokenCost(this.items);
  }
}
