/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * ContextAssembler 单测（B-P1-9）
 *
 * 覆盖：
 *  - IAttachment 5 种类型各自渲染正确
 *  - 类型间顺序稳定（file → image → selection → commits → code_change）
 *  - ContextAssembler add/remove/list/clear + render 幂等
 *  - tokenCost 与 estimateTokens 一致
 *  - L3 层通过 `attached` 字段正确注入 5 种 block
 */
import { describe, it, expect } from 'vitest';
import {
  ContextAssembler,
  renderAttachments,
  attachmentsTokenCost,
  type IAttachment,
  type FileAttachment,
  type ImageAttachment,
  type SelectionAttachment,
  type GitCommitsAttachment,
  type CodeChangeAttachment,
} from '../../src/core/prompts/context-assembler.js';
import { estimateTokens } from '../../src/core/prompts/token-budget.js';
import { buildL3Attachments } from '../../src/core/prompts/layers/attachments.js';

const mkFile = (id: string, ref: string, content: string): FileAttachment => ({
  id, type: 'file', ref, content,
});
const mkImage = (id: string, ref: string, extra: Partial<ImageAttachment> = {}): ImageAttachment => ({
  id, type: 'image', ref, ...extra,
});
const mkSel = (
  id: string,
  filePath: string,
  startLine: number,
  endLine: number,
  text: string,
): SelectionAttachment => ({
  id, type: 'selection', ref: `${filePath}:${startLine}-${endLine}`,
  filePath, startLine, endLine, content: text,
});
const mkCommits = (id: string, range: string, content: string): GitCommitsAttachment => ({
  id, type: 'git_commits', ref: range, range, content,
});
const mkChange = (id: string, ref: string, content: string): CodeChangeAttachment => ({
  id, type: 'code_change', ref, content,
});

describe('renderAttachments · 按 type 分桶', () => {
  it('空输入 → 空串', () => {
    expect(renderAttachments([])).toBe('');
  });

  it('单 file 附件 → `<attached_files>` 包裹', () => {
    const out = renderAttachments([mkFile('f1', 'a.ts', 'console.log(1);')]);
    expect(out).toMatch(/^<attached_files>/);
    expect(out).toMatch(/<\/attached_files>$/);
    expect(out).toMatch(/<file path="a\.ts">[\s\S]*console\.log\(1\)/);
  });

  it('单 image 附件 → `<attached_images>` 自闭合元数据', () => {
    const out = renderAttachments([
      mkImage('i1', 'img://abc', { mime: 'image/png', bytes: 1024, width: 800, height: 600 }),
    ]);
    expect(out).toMatch(/<attached_images>/);
    expect(out).toMatch(/<image ref="img:\/\/abc" mime="image\/png" bytes="1024" size="800x600" \/>/);
  });

  it('单 selection 附件 → `<selected_codes>` + `<selection>`', () => {
    const out = renderAttachments([mkSel('s1', 'a.ts', 3, 5, 'foo()')]);
    expect(out).toMatch(/<selected_codes>/);
    expect(out).toMatch(/<selection path="a\.ts:3-5">[\s\S]*foo\(\)/);
  });

  it('selection start===end → 单行定位', () => {
    const out = renderAttachments([mkSel('s1', 'a.ts', 10, 10, 'x')]);
    expect(out).toMatch(/<selection path="a\.ts:10">/);
  });

  it('单 git_commits → `<git_commits>` + `<commits range=...>`', () => {
    const out = renderAttachments([mkCommits('g1', 'HEAD~3..HEAD', 'abc foo\ndef bar')]);
    expect(out).toMatch(/<git_commits>/);
    expect(out).toMatch(/<commits range="HEAD~3\.\.HEAD">/);
  });

  it('单 code_change → `<code_change>` + `<diff ref=...>`', () => {
    const out = renderAttachments([mkChange('c1', 'staged', 'diff --git a b')]);
    expect(out).toMatch(/<code_change>/);
    expect(out).toMatch(/<diff ref="staged">/);
  });

  it('混合 5 种 → 类型顺序固定 file → image → selection → commits → code_change', () => {
    const items: IAttachment[] = [
      mkChange('c1', 'staged', 'diff'),
      mkCommits('g1', 'HEAD', 'hash msg'),
      mkSel('s1', 'a.ts', 1, 2, 'text'),
      mkImage('i1', 'img://x'),
      mkFile('f1', 'a.ts', 'body'),
    ];
    const out = renderAttachments(items);
    const pos = (tag: string) => out.indexOf(tag);
    expect(pos('<attached_files>')).toBeGreaterThanOrEqual(0);
    expect(pos('<attached_files>')).toBeLessThan(pos('<attached_images>'));
    expect(pos('<attached_images>')).toBeLessThan(pos('<selected_codes>'));
    expect(pos('<selected_codes>')).toBeLessThan(pos('<git_commits>'));
    expect(pos('<git_commits>')).toBeLessThan(pos('<code_change>'));
  });

  it('同输入多次调用 → 字节级一致（幂等）', () => {
    const items: IAttachment[] = [
      mkFile('f1', 'a.ts', 'x'),
      mkFile('f2', 'b.ts', 'y'),
    ];
    expect(renderAttachments(items)).toBe(renderAttachments(items));
  });

  it('attachmentsTokenCost = estimateTokens(render)', () => {
    const items: IAttachment[] = [mkFile('f1', 'a.ts', 'x'.repeat(100))];
    expect(attachmentsTokenCost(items)).toBe(estimateTokens(renderAttachments(items)));
  });
});

describe('ContextAssembler · add/remove/list/clear/render', () => {
  it('add 按插入顺序保留；list 返回副本', () => {
    const a = new ContextAssembler();
    a.addAttachment(mkFile('f1', 'a.ts', 'A'));
    a.addAttachment(mkFile('f2', 'b.ts', 'B'));
    const list1 = a.listAttachments();
    expect(list1.map((x) => x.id)).toEqual(['f1', 'f2']);
    // 返回副本：外部不能通过修改影响内部
    (list1 as IAttachment[]).push(mkFile('f3', 'c.ts', 'C'));
    expect(a.listAttachments()).toHaveLength(2);
  });

  it('add 相同 id 覆盖旧条目（不重复）', () => {
    const a = new ContextAssembler();
    a.addAttachment(mkFile('f1', 'a.ts', 'A'));
    a.addAttachment(mkFile('f1', 'a.ts', 'A2'));
    expect(a.listAttachments()).toHaveLength(1);
    expect((a.listAttachments()[0] as FileAttachment).content).toBe('A2');
  });

  it('remove 命中返回 true，未命中返回 false', () => {
    const a = new ContextAssembler();
    a.addAttachment(mkFile('f1', 'a.ts', 'A'));
    expect(a.removeAttachment('f1')).toBe(true);
    expect(a.removeAttachment('f1')).toBe(false);
    expect(a.listAttachments()).toHaveLength(0);
  });

  it('clear 清空所有附件', () => {
    const a = new ContextAssembler();
    a.addAttachment(mkFile('f1', 'a.ts', 'A'));
    a.addAttachment(mkSel('s1', 'a.ts', 1, 1, 'x'));
    a.clear();
    expect(a.listAttachments()).toHaveLength(0);
    expect(a.render()).toBe('');
  });

  it('render 与 tokenCost 与 listAttachments 保持一致', () => {
    const a = new ContextAssembler();
    a.addAttachment(mkFile('f1', 'a.ts', 'X'));
    a.addAttachment(mkImage('i1', 'img://y'));
    expect(a.render()).toBe(renderAttachments(a.listAttachments()));
    expect(a.tokenCost()).toBe(attachmentsTokenCost(a.listAttachments()));
  });
});

describe('L3 · buildL3Attachments 接入 `attached` 字段', () => {
  it('传入 attached 且其他字段为空 → 输出仅 5-block 聚合', () => {
    const out = buildL3Attachments({
      attached: [mkFile('f1', 'a.ts', 'A'), mkSel('s1', 'b.ts', 1, 3, 'B')],
    });
    expect(out).toMatch(/<attached_files>/);
    expect(out).toMatch(/<selected_codes>/);
    // 两 block 用空行分隔
    expect(out).toMatch(/<\/attached_files>\n\n<selected_codes>/);
  });

  it('attached 与 selectedCodes(legacy) 同时存在 → 两者各自出现', () => {
    const out = buildL3Attachments({
      selectedCodes: [{ filePath: 'legacy.ts', startLine: 1, endLine: 1, text: 'L' }],
      attached: [mkFile('f1', 'a.ts', 'A')],
    });
    // legacy 的 selected_codes 在前（按稳定顺序 environment → selectedCodes → attached → gitContext）
    const selPos = out.indexOf('<selected_codes>');
    const filesPos = out.indexOf('<attached_files>');
    expect(selPos).toBeGreaterThanOrEqual(0);
    expect(filesPos).toBeGreaterThanOrEqual(0);
    expect(selPos).toBeLessThan(filesPos);
  });

  it('attached + environment + gitContext 完整组合', () => {
    const out = buildL3Attachments({
      environment: '<environment>ENV</environment>',
      attached: [mkFile('f1', 'a.ts', 'A')],
      gitContext: '<git_context>GIT</git_context>',
    });
    const envPos = out.indexOf('<environment>');
    const filesPos = out.indexOf('<attached_files>');
    const gitPos = out.indexOf('<git_context>');
    expect(envPos).toBeGreaterThanOrEqual(0);
    expect(envPos).toBeLessThan(filesPos);
    expect(filesPos).toBeLessThan(gitPos);
  });

  it('attached 为空数组 → 不注入 block', () => {
    const out = buildL3Attachments({ attached: [] });
    expect(out).toBe('');
  });
});
