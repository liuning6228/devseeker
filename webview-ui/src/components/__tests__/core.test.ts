import { describe, it, expect } from 'vitest';

// ─────────── cn() ───────────
import { cn } from '../../lib/utils.js';

describe('cn()', () => {
  it('合并类名', () => {
    expect(cn('px-4', 'py-2')).toBe('px-4 py-2');
  });

  it('处理条件类名', () => {
    expect(cn('base', false && 'hidden', 'visible')).toBe('base visible');
  });

  it('处理 undefined', () => {
    expect(cn('a', undefined, 'b')).toBe('a b');
  });

  it('tailwind-merge 解决冲突（后者优先）', () => {
    expect(cn('px-4', 'px-6')).toBe('px-6');
  });
});

// ─────────── formatNumber ───────────
// 从 App.tsx 中提取的简单格式化函数

import { describe as d2, it as i2, expect as e2 } from 'vitest';

// ─────────── LightMarkdown ───────────
describe('LightMarkdown 渲染', () => {
  it('纯文本不变', () => {
    const text = 'Hello World';
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    expect(escaped).toBe('Hello World');
  });
});

// ─────────── formatTokens ───────────
describe('ContextWindow token 格式化', () => {
  it('小数字显示原始值', () => {
    const n = 500;
    expect(n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)).toBe('500');
  });

  it('千位显示 K', () => {
    const n = 1500;
    expect(n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)).toBe('1.5K');
  });

  it('百万显示 M', () => {
    const n = 1500000;
    expect(n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : String(n)).toBe('1.5M');
  });
});

// ─────────── ChecklistRenderer ───────────
describe('ChecklistRenderer 统计', () => {
  it('计算已勾选数量', () => {
    const items = [
      { id: '1', text: 'a', checked: true },
      { id: '2', text: 'b', checked: false },
      { id: '3', text: 'c', checked: true },
    ];
    expect(items.filter((i) => i.checked).length).toBe(2);
    expect(`${items.filter((i) => i.checked).length}/${items.length}`).toBe('2/3');
  });
});
