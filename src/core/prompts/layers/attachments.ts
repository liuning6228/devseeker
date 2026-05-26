/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * L3 Session Attachments Layer（DESIGN §M3.6 · W3.6）
 *
 * 本层承载**会话级**动态内容：attachments / selected_codes / git diff 摘要 /
 * environment probe / 当前轮特定时间戳等。每轮可能都不同，**不参与前缀缓存**。
 *
 * 接入状态：
 *   - `<environment>`（B-P3-1）✅ 通过 `environment` 字段注入
 *   - `<selected_codes>`（B-P1-10）✅ 通过 `selectedCodes` 字段注入
 *   - `<git_context>`（B-P1-11）✅ 通过 `gitContext` 字段注入
 *   - 5 种用户显式附件（M10.4）✅ 通过 `attached`（IAttachment[]）由 ContextAssembler 渲染
 */

import type { IAttachment } from '../context-assembler.js';
import { renderAttachments } from '../context-assembler.js';

export interface L3AttachmentsInput {
  /**
   * B-P3-1 · EnvironmentProbe `<environment>...</environment>` 预格式块。
   * 由调用方用 `buildEnvironmentBlock()` 生成后传入。
   */
  environment?: string;
  /**
   * W13.2 · Ecosystem Probe `<ecosystem kind="...">` 预格式块（可能含多块）。
   * 由调用方用 `buildEcosystemBlock({ workspaceRoot })` 生成；未命中任何生态时为空字符串。
   * 位置紧随 environment——两者都是工作区静态信号，语义相近。
   */
  ecosystem?: string;
  /**
   * W13.3 · VLM OCR Policy `<vlm_policy kind="ocr">` 预格式块。
   * 由调用方用 `buildVlmOcrBlock(hasVision)` 生成；无图场景为空字符串。
   * 位置紧随 ecosystem——均为"条件启用的领域策略"，注入性质相近。
   */
  vlmOcrPolicy?: string;
  /**
   * B-P1-13 · M10.1 框架自动注入 4 块（current_open_file / open_tabs /
   * workspace_tree / git_status / git_diff_staged）。由调用方用
   * `buildFrameworkContext()` 预生成后传入。注入顺序紧随 environment 之后。
   */
  frameworkContext?: string;
  /**
   * DEPRECATED 占位（W3.6 预留）：文件摘要列表。改用 `attached`（IAttachment[]）。
   * 仍然保留以维持向后兼容与 token-budget 裁剪现状。
   */
  attachments?: readonly { filePath: string; summary: string }[];
  /**
   * B-P1-10 · selected_codes。按出现顺序保留，不参与缓存。
   */
  selectedCodes?: readonly { filePath: string; startLine: number; endLine: number; text: string }[];
  /**
   * B-P1-11 · git 上下文（已格式化的 `<git_context>` 完整块）。
   */
  gitContext?: string;
  /**
   * B-P1-9 · M10.4 5 种用户显式附件（file / image / selection / git_commits / code_change）。
   * 由 ContextAssembler.listAttachments() 产出，或调用方手动构造。
   */
  attached?: readonly IAttachment[];
}

/**
 * 构建 L3 层。按稳定顺序拼接，让下游模型可预测结构。
 *
 * 稳定排序为：environment → ecosystem → vlmOcrPolicy → frameworkContext → selectedCodes → attached(5 种 block) → gitContext。
 * 同结构输入重复调用输出字节级一致（仅 environment 内部 now 字段可变）。
 */
export function buildL3Attachments(input: L3AttachmentsInput = {}): string {
  const parts: string[] = [];

  if (input.environment && input.environment.length > 0) {
    parts.push(input.environment);
  }

  // W13.2 · Ecosystem Probe 注入（紧随 environment，两者都是工作区静态信号）
  if (input.ecosystem && input.ecosystem.length > 0) {
    parts.push(input.ecosystem);
  }

  // W13.3 · VLM OCR Policy 注入（紧随 ecosystem，条件启用的领域策略）
  if (input.vlmOcrPolicy && input.vlmOcrPolicy.length > 0) {
    parts.push(input.vlmOcrPolicy);
  }

  // B-P1-13 · M10.1 框架自动注入 4 块（紧随 environment）
  if (input.frameworkContext && input.frameworkContext.length > 0) {
    parts.push(input.frameworkContext);
  }

  // B-P1-10 · selected_codes 注入（按出现顺序保留）
  if (input.selectedCodes && input.selectedCodes.length > 0) {
    const lines: string[] = ['<selected_codes>'];
    for (const sc of input.selectedCodes) {
      const loc =
        sc.startLine === sc.endLine
          ? `${sc.filePath}:${sc.startLine}`
          : `${sc.filePath}:${sc.startLine}-${sc.endLine}`;
      lines.push(`<selection path="${loc}">`);
      lines.push(sc.text);
      lines.push('</selection>');
    }
    lines.push('</selected_codes>');
    parts.push(lines.join('\n'));
  }

  // B-P1-9 · M10.4 5 种用户显式附件（ContextAssembler 产物）
  if (input.attached && input.attached.length > 0) {
    const rendered = renderAttachments(input.attached);
    if (rendered.length > 0) parts.push(rendered);
  }

  // B-P1-11 · git 上下文（已格式化的完整块）
  if (input.gitContext && input.gitContext.length > 0) {
    parts.push(input.gitContext);
  }

  // attachments 留为后续（当前由 messages 正文承载）。

  return parts.join('\n\n');
}
