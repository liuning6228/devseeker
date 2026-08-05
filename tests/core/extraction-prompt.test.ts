/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 记忆自动提炼单测（P0）
 *
 * 覆盖：extraction-prompt 纯函数 + BuiltinMemoryProvider 提炼集成
 */

import { describe, it, expect } from 'vitest';
import {
  shouldExtractFromTurn,
  parseExtractionResult,
  summarizeSessionMessages,
  buildSyncTurnExtractionPrompt,
  buildSessionEndExtractionPrompt,
  SYNC_TURN_MAX_MEMORIES,
  SESSION_END_MAX_MEMORIES,
} from '../../src/core/memory/extraction-prompt.js';

// ── shouldExtractFromTurn ──

describe('shouldExtractFromTurn', () => {
  it('短文本 + 短回复 → false', () => {
    expect(shouldExtractFromTurn('ok', '好的')).toBe(false);
  });

  it('纯寒暄 → false', () => {
    expect(shouldExtractFromTurn('谢谢', '不客气，有问题随时问我')).toBe(false);
    expect(shouldExtractFromTurn('你好', '你好！有什么可以帮你的？')).toBe(false);
  });

  it('包含错误信号词 → true', () => {
    expect(shouldExtractFromTurn(
      '运行报错了',
      '这个错误是因为 xxx 导致的，需要修改 yyy',
    )).toBe(true);
  });

  it('包含决策信号词 → true', () => {
    expect(shouldExtractFromTurn(
      '为什么选择这个方案？',
      '我们决定用方案 A 因为性能更好',
    )).toBe(true);
  });

  it('包含代码的长回复 → true', () => {
    expect(shouldExtractFromTurn(
      '帮我写个函数',
      '好的，这是一个实现：\n```typescript\nfunction foo() {\n  return 42;\n}\n```\n这个函数接受无参数，返回一个固定值 42。你可以在需要的地方调用它。'.repeat(10),
    )).toBe(true);
  });

  it('长回复（>800字）→ true', () => {
    const longText = 'a'.repeat(900);
    expect(shouldExtractFromTurn('请解释一下', longText)).toBe(true);
  });
});

// ── parseExtractionResult ──

describe('parseExtractionResult', () => {
  it('空字符串 → []', () => {
    expect(parseExtractionResult('')).toEqual([]);
    expect(parseExtractionResult('   ')).toEqual([]);
  });

  it('合法 JSON 数组 → 正常解析', () => {
    const raw = JSON.stringify([
      {
        title: '测试标题',
        content: '测试内容，包含了重要的踩坑经验',
        category: 'common_pitfalls_experience',
        keywords: ['test', '坑'],
      },
    ]);
    const result = parseExtractionResult(raw);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('测试标题');
    expect(result[0].category).toBe('common_pitfalls_experience');
  });

  it('markdown 代码块包裹 → 正常解析', () => {
    const raw = '```json\n[{"title":"标题","content":"内容","category":"tool_experience","keywords":["k1"]}]\n```';
    const result = parseExtractionResult(raw);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('标题');
  });

  it('混合文本中的 JSON → 提取数组部分', () => {
    const raw = '根据分析，我提取了以下记忆：\n[{"title":"标题","content":"内容","category":"expert_experience","keywords":[]}]';
    const result = parseExtractionResult(raw);
    expect(result).toHaveLength(1);
  });

  it('非法 JSON → []', () => {
    expect(parseExtractionResult('这不是 JSON')).toEqual([]);
    expect(parseExtractionResult('{broken')).toEqual([]);
  });

  it('非数组 JSON → []', () => {
    expect(parseExtractionResult('{"key": "value"}')).toEqual([]);
  });

  it('数组中无效条目被跳过', () => {
    const raw = JSON.stringify([
      { title: '有效', content: '内容', category: 'tool_experience', keywords: [] },
      null,
      { title: '', content: '空标题', category: 'tool_experience', keywords: [] },
      { title: '缺内容', content: '', category: 'tool_experience', keywords: [] },
    ]);
    const result = parseExtractionResult(raw);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('有效');
  });

  it('keywords 非数组时默认为空', () => {
    const raw = JSON.stringify([
      { title: '标题', content: '内容', category: 'tool_experience', keywords: 'not-array' },
    ]);
    const result = parseExtractionResult(raw);
    expect(result).toHaveLength(1);
    expect(result[0].keywords).toEqual([]);
  });
});

// ── summarizeSessionMessages ──

describe('summarizeSessionMessages', () => {
  it('空消息列表 → 空结果', () => {
    const result = summarizeSessionMessages([]);
    expect(result.taskGoal).toBe('');
    expect(result.keyActions).toEqual([]);
    expect(result.finalOutcome).toBe('');
  });

  it('提取首条 user 消息作为任务目标', () => {
    const messages = [
      { role: 'user', content: '请帮我修复这个 bug' },
      { role: 'assistant', content: '好的，我来看看' },
    ];
    const result = summarizeSessionMessages(messages);
    expect(result.taskGoal).toBe('请帮我修复这个 bug');
  });

  it('提取 assistant 的 tool_calls 作为关键操作', () => {
    const messages = [
      { role: 'user', content: '修复 bug' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'read_file', arguments: '{"path":"src/foo.ts"}' } },
          { function: { name: 'search_replace', arguments: '{"file_path":"src/foo.ts"}' } },
        ],
      },
    ];
    const result = summarizeSessionMessages(messages);
    expect(result.keyActions).toHaveLength(2);
    expect(result.keyActions[0]).toContain('read_file');
  });

  it('最后一条 assistant 文本作为最终结果', () => {
    const messages = [
      { role: 'user', content: '任务' },
      { role: 'assistant', content: '中间回复' },
      { role: 'user', content: '继续' },
      { role: 'assistant', content: '最终完成结果' },
    ];
    const result = summarizeSessionMessages(messages);
    expect(result.finalOutcome).toBe('最终完成结果');
  });
});

// ── buildSyncTurnExtractionPrompt ──

describe('buildSyncTurnExtractionPrompt', () => {
  it('包含用户和助手内容', () => {
    const prompt = buildSyncTurnExtractionPrompt('用户问题', '助手回复');
    expect(prompt).toContain('用户问题');
    expect(prompt).toContain('助手回复');
  });

  it('包含提取规则', () => {
    const prompt = buildSyncTurnExtractionPrompt('q', 'a');
    expect(prompt).toContain('提取规则');
    expect(prompt).toContain('JSON 数组');
  });

  it('包含 SYNC_TURN_MAX_MEMORIES 限制', () => {
    const prompt = buildSyncTurnExtractionPrompt('q', 'a');
    expect(prompt).toContain(String(SYNC_TURN_MAX_MEMORIES));
  });
});

// ── buildSessionEndExtractionPrompt ──

describe('buildSessionEndExtractionPrompt', () => {
  it('包含任务目标、操作和结果', () => {
    const prompt = buildSessionEndExtractionPrompt(
      '修复 bug',
      ['- read_file(src/foo.ts)', '- search_replace(...)'],
      '已修复',
    );
    expect(prompt).toContain('修复 bug');
    expect(prompt).toContain('read_file');
    expect(prompt).toContain('已修复');
  });

  it('包含 SESSION_END_MAX_MEMORIES 限制', () => {
    const prompt = buildSessionEndExtractionPrompt('goal', [], 'outcome');
    expect(prompt).toContain(String(SESSION_END_MAX_MEMORIES));
  });
});
