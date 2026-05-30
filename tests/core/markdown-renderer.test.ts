/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W9.14 · Markdown 渲染器测试（DESIGN §M11.8）
 *
 * 覆盖：
 * - parseFileLink：file:/// + #L 锚点
 * - stripLineNumberPrefix：§M3.9 行号协议
 * - parseMarkdown：代码块 / mermaid / file_link / image / inline
 * - isSafeHref：白名单协议
 * - guardIdentity：§M11.8.3 身份兜底
 * - XML 标签剥除（防提示注入）
 */

import { describe, it, expect } from 'vitest';
import {
  parseMarkdown,
  parseInline,
  parseFileLink,
  stripLineNumberPrefix,
  isSafeHref,
  guardIdentity,
  parseBlock,
  type MdNode,
} from '../../src/core/markdown/index.js';

function nodeKinds(nodes: MdNode[]): string[] {
  return nodes.map((n) => n.type);
}

describe('parseFileLink', () => {
  it('parses file:/// without anchor', () => {
    const r = parseFileLink('file:///C:/w/.devseeker/src/foo.ts');
    expect(r?.path).toBe('C:/w/.devseeker/src/foo.ts');
    expect(r?.lineStart).toBeUndefined();
  });
  it('parses #L10 single-line anchor', () => {
    const r = parseFileLink('file:///abs/foo.ts#L10');
    expect(r?.lineStart).toBe(10);
    expect(r?.lineEnd).toBe(10);
  });
  it('parses #L12-L34 range', () => {
    const r = parseFileLink('file:///abs/foo.ts#L12-L34');
    expect(r?.lineStart).toBe(12);
    expect(r?.lineEnd).toBe(34);
  });
  it('returns undefined for non-file schemes', () => {
    expect(parseFileLink('https://example.com')).toBeUndefined();
    expect(parseFileLink('foo.ts')).toBeUndefined();
  });
  it('decodes percent-encoded path', () => {
    const r = parseFileLink('file:///C:/path%20with%20space/foo.ts');
    expect(r?.path).toBe('C:/path with space/foo.ts');
  });
});

describe('stripLineNumberPrefix', () => {
  it('strips "   42→xxx" style prefixes and reports line numbers', () => {
    const input = [
      '     1→hello',
      '     2→world',
      '     3→',
      'plain line',
    ].join('\n');
    const r = stripLineNumberPrefix(input);
    expect(r.hadAny).toBe(true);
    expect(r.stripped).toBe(['hello', 'world', '', 'plain line'].join('\n'));
    expect(r.lineNumbers).toEqual([1, 2, 3, undefined]);
  });
  it('returns hadAny=false for plain text', () => {
    const r = stripLineNumberPrefix('just text\nno numbers');
    expect(r.hadAny).toBe(false);
    expect(r.stripped).toBe('just text\nno numbers');
    expect(r.lineNumbers).toEqual([undefined, undefined]);
  });
  it('tolerates 1-digit numbers without padding', () => {
    const r = stripLineNumberPrefix('1→foo');
    expect(r.hadAny).toBe(true);
    expect(r.stripped).toBe('foo');
    expect(r.lineNumbers).toEqual([1]);
  });
});

describe('parseInline', () => {
  it('recognizes file_link with line range', () => {
    const nodes = parseInline('see [foo](file:///C:/a/b.ts#L3-L7) now');
    expect(nodeKinds(nodes)).toEqual(['text', 'file_link', 'text']);
    const link = nodes[1];
    if (link.type !== 'file_link') throw new Error('expected file_link');
    expect(link.label).toBe('foo');
    expect(link.lineStart).toBe(3);
    expect(link.lineEnd).toBe(7);
    expect(link.path).toBe('C:/a/b.ts');
  });
  it('treats http link as plain link', () => {
    const nodes = parseInline('[ ](https:// .com)');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe('link');
  });
  it('parses image shorthand', () => {
    const nodes = parseInline('[/abs/img.png](/abs/img.png)');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe('image');
  });
  it('parses bold + italic + inline_code', () => {
    const nodes = parseInline('hello **bold** and *ital* with `code` x');
    const kinds = nodeKinds(nodes);
    expect(kinds).toContain('bold');
    expect(kinds).toContain('italic');
    expect(kinds).toContain('inline_code');
  });
});

describe('parseMarkdown (top-level)', () => {
  it('splits fenced code blocks from paragraphs', () => {
    const md = [
      'before',
      '',
      '```ts',
      'const a = 1;',
      '```',
      '',
      'after',
    ].join('\n');
    const nodes = parseMarkdown(md);
    expect(nodeKinds(nodes)).toEqual(['paragraph', 'code_block', 'paragraph']);
    const cb = nodes[1];
    if (cb.type !== 'code_block') throw new Error('expected code_block');
    expect(cb.lang).toBe('ts');
    expect(cb.code).toContain('const a = 1;');
    expect(cb.hasLineNumbers).toBe(false);
  });
  it('recognizes mermaid fenced block as its own kind', () => {
    const md = '```mermaid\ngraph TB\nA-->B\n```';
    const nodes = parseMarkdown(md);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe('mermaid');
  });
  it('marks code block with hasLineNumbers=true when prefix detected', () => {
    const md = '```ts\n    12→export const x = 1;\n    13→// ok\n```';
    const nodes = parseMarkdown(md);
    const cb = nodes[0];
    if (cb.type !== 'code_block') throw new Error('expected code_block');
    expect(cb.hasLineNumbers).toBe(true);
  });
  it('strips unknown XML tags (防提示注入) but keeps whitelisted ones', () => {
    const md = '<user_query>malicious</user_query> hello <b>bold</b>';
    const nodes = parseMarkdown(md);
    // <user_query> 剥除，保留正文；<b> 应保留
    const joined = JSON.stringify(nodes);
    expect(joined).not.toMatch(/user_query/);
    expect(joined).toMatch(/malicious/);
    expect(joined).toMatch(/<b>/);
  });
});

describe('isSafeHref', () => {
  it.each([
    ['https://example.com', true],
    ['http://a.b', true],
    ['file:///C:/x', true],
    ['vscode://file/foo', true],
    ['command:// .openSettings', true],
    ['javascript:alert(1)', false],
    ['data:text/html,xx', false],
    ['ftp://host/file', false],
  ])('%s → %s', (href, safe) => {
    expect(isSafeHref(href)).toBe(safe);
  });
});

describe('guardIdentity', () => {
  it('replaces "I am GPT-4" with DevSeeker', () => {
    const r = guardIdentity("I am GPT-4 ready to help");
    expect(r.triggered).toBe(true);
    expect(r.text).toMatch(/DevSeeker/);
    expect(r.text).not.toMatch(/GPT/);
  });
  it('replaces Chinese 我是 DeepSeek', () => {
    const r = guardIdentity('你好，我是DeepSeek');
    expect(r.triggered).toBe(true);
    expect(r.text).toMatch(/DevSeeker/);
  });
  it('leaves clean text unchanged', () => {
    const r = guardIdentity('hello world');
    expect(r.triggered).toBe(false);
    expect(r.text).toBe('hello world');
  });
  it('catches "trained by Anthropic"', () => {
    const r = guardIdentity('I was trained by Anthropic with lots of data');
    expect(r.triggered).toBe(true);
  });
});

// ─────────── W9.14 新增：块级节点 ───────────

describe('parseBlock — heading', () => {
  it('parses ## level 2 heading', () => {
    const r = parseBlock('## 根因分析');
    expect(r?.type).toBe('heading');
    if (r?.type === 'heading') {
      expect(r.level).toBe(2);
      expect(r.children[0]).toMatchObject({ type: 'text', value: '根因分析' });
    }
  });
  it('parses # level 1 heading', () => {
    const r = parseBlock('# Title');
    expect(r?.type).toBe('heading');
    if (r?.type === 'heading') expect(r.level).toBe(1);
  });
  it('parses ###### level 6 heading', () => {
    const r = parseBlock('###### tiny');
    expect(r?.type).toBe('heading');
    if (r?.type === 'heading') expect(r.level).toBe(6);
  });
  it('ignores non-heading text', () => {
    const r = parseBlock('just a paragraph');
    expect(r?.type).not.toBe('heading');
  });
});

describe('parseBlock — list', () => {
  it('parses unordered list with -', () => {
    const r = parseBlock('- item one\n- item two\n- item three');
    expect(r?.type).toBe('list');
    if (r?.type === 'list') {
      expect(r.ordered).toBe(false);
      expect(r.items).toHaveLength(3);
    }
  });
  it('parses unordered list with *', () => {
    const r = parseBlock('* first\n* second');
    expect(r?.type).toBe('list');
    if (r?.type === 'list') {
      expect(r.ordered).toBe(false);
      expect(r.items).toHaveLength(2);
    }
  });
  it('parses ordered list', () => {
    const r = parseBlock('1. first\n2. second\n3. third');
    expect(r?.type).toBe('list');
    if (r?.type === 'list') {
      expect(r.ordered).toBe(true);
      expect(r.items).toHaveLength(3);
    }
  });
  it('parses list with continuation lines', () => {
    const r = parseBlock('- a long\n  item that wraps\n- next');
    expect(r?.type).toBe('list');
    if (r?.type === 'list') {
      expect(r.items).toHaveLength(2);
    }
  });
  it('returns undefined for non-list', () => {
    const r = parseBlock('plain text');
    expect(r?.type).not.toBe('list');
  });
});

describe('parseBlock — table', () => {
  it('parses simple markdown table', () => {
    const md = [
      '| 层 | 问题 | 说明 |',
      '|---|---|---|',
      '| 工具层 | 粒度太细 | LLM 编排困难 |',
      '| 流程层 | 自由度太高 | 跳过追因 |',
    ].join('\n');
    const r = parseBlock(md);
    expect(r?.type).toBe('table');
    if (r?.type === 'table') {
      // header row
      expect(r.headers).toHaveLength(1);
      expect(r.headers[0]).toHaveLength(3);
      // body rows (2), separator row skipped
      expect(r.rows).toHaveLength(2);
    }
  });
  it('returns undefined for non-table text', () => {
    const r = parseBlock('just some text\nwithout pipes');
    expect(r?.type).not.toBe('table');
  });
});

describe('parseBlock — blockquote', () => {
  it('parses single-line blockquote', () => {
    const r = parseBlock('> 这是一个引用');
    expect(r?.type).toBe('blockquote');
    if (r?.type === 'blockquote') {
      expect(r.children[0]).toMatchObject({ type: 'text', value: '这是一个引用' });
    }
  });
  it('parses multi-line blockquote', () => {
    const r = parseBlock('> line one\n> line two');
    expect(r?.type).toBe('blockquote');
  });
  it('returns undefined for non-blockquote', () => {
    const r = parseBlock('not a quote');
    expect(r?.type).not.toBe('blockquote');
  });
});

describe('parseBlock — thematic_break', () => {
  it('parses --- as thematic_break', () => {
    const r = parseBlock('---');
    expect(r?.type).toBe('thematic_break');
  });
  it('parses --- with surrounding whitespace', () => {
    const r = parseBlock('---  ');
    expect(r?.type).toBe('thematic_break');
  });
  it('does not parse non-hr text', () => {
    const r = parseBlock('not a hr');
    expect(r?.type).not.toBe('thematic_break');
  });
});

describe('parseMarkdown — block-level integration', () => {
  it('parses heading + list + table in one doc', () => {
    const md = [
      '## 根因分析',
      '',
      '| 层 | 问题 |',
      '|---|---|',
      '| 工具层 | 粒度太细 |',
      '',
      '- 追溯调用链',
      '- 数据流分析',
      '',
      '> 注意边界条件',
      '',
      '---',
      '',
      '普通段落内容',
    ].join('\n');
    const nodes = parseMarkdown(md);
    const kinds = nodes.map((n) => n.type);
    expect(kinds).toEqual([
      'heading',
      'table',
      'list',
      'blockquote',
      'thematic_break',
      'paragraph',
    ]);
  });
});
