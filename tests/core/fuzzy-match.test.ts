/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * fuzzy-match 单元测试
 *
 * 验证多级 fallback 匹配：精确 → 行 trim → Levenshtein 模糊
 */

import { describe, it, expect } from 'vitest';
import {
  exactMatch,
  lineTrimMatch,
  levenshteinDistance,
  similarity,
  fuzzySearch,
  multiLevelMatch,
  exactMatchCount,
} from '../../src/core/tools/fuzzy-match.js';

// ─────────── exactMatch ───────────

describe('exactMatch', () => {
  it('finds single occurrence', () => {
    const result = exactMatch('hello world', 'world');
    expect(result).toEqual([6]);
  });

  it('finds multiple occurrences', () => {
    const result = exactMatch('abcabcabc', 'abc');
    expect(result).toEqual([0, 3, 6]);
  });

  it('returns empty for no match', () => {
    const result = exactMatch('hello world', 'xyz');
    expect(result).toEqual([]);
  });

  it('handles empty needle', () => {
    // Empty needle has no meaningful match positions; exactMatch returns []
    const result = exactMatch('hello', '');
    expect(result).toEqual([]);
  });

  it('handles identical strings', () => {
    const result = exactMatch('hello', 'hello');
    expect(result).toEqual([0]);
  });
});

// ─────────── lineTrimMatch ───────────

describe('lineTrimMatch', () => {
  it('matches with different leading whitespace', () => {
    const haystack = '  const x = 1;\n  const y = 2;';
    const needle = 'const x = 1;\nconst y = 2;';
    const results = lineTrimMatch(haystack, needle);
    expect(results).toHaveLength(1);
    expect(results[0].matchedText).toBe(haystack);
  });

  it('matches with trailing whitespace', () => {
    const haystack = 'hello   \nworld   ';
    const needle = 'hello\nworld';
    const results = lineTrimMatch(haystack, needle);
    expect(results).toHaveLength(1);
  });

  it('returns empty for no match', () => {
    const haystack = 'foo\nbar';
    const needle = 'baz\nqux';
    const results = lineTrimMatch(haystack, needle);
    expect(results).toHaveLength(0);
  });

  it('handles multiple matches (same content repeated)', () => {
    const haystack = 'a\nb\na\nb';
    const needle = 'a\nb';
    const results = lineTrimMatch(haystack, needle);
    expect(results.length).toBeGreaterThanOrEqual(2);
  });
});

// ─────────── levenshteinDistance ───────────

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshteinDistance('hello', 'hello')).toBe(0);
  });

  it('returns length for empty string comparison', () => {
    expect(levenshteinDistance('', 'abc')).toBe(3);
    expect(levenshteinDistance('abc', '')).toBe(3);
  });

  it('computes single edit distance', () => {
    expect(levenshteinDistance('cat', 'bat')).toBe(1); // substitution
    expect(levenshteinDistance('cat', 'cats')).toBe(1); // insertion
    expect(levenshteinDistance('cats', 'cat')).toBe(1); // deletion
  });

  it('computes multi-edit distance', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
    expect(levenshteinDistance('saturday', 'sunday')).toBe(3);
  });
});

// ─────────── similarity ───────────

describe('similarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(similarity('hello', 'hello')).toBe(1);
  });

  it('returns 0 for empty strings', () => {
    expect(similarity('', 'hello')).toBe(0);
    expect(similarity('hello', '')).toBe(0);
  });

  it('returns high similarity for minor differences', () => {
    const sim = similarity('function hello() {', 'function hello() {}');
    expect(sim).toBeGreaterThan(0.9);
  });

  it('returns low similarity for very different strings', () => {
    const sim = similarity('abc', 'xyz');
    expect(sim).toBeLessThan(0.5);
  });
});

// ─────────── fuzzySearch ───────────

describe('fuzzySearch', () => {
  const haystack = [
    'import React from "react";',
    'import ReactDOM from "react-dom";',
    '',
    'function App() {',
    '  const [count, setCount] = useState(0);',
    '  return (',
    '    <div className="App">',
    '      <h1>Hello World</h1>',
    '      <button onClick={() => setCount(c => c + 1)}>',
    '        Count: {count}',
    '      </button>',
    '    </div>',
    '  );',
    '}',
    '',
    'export default App;',
  ].join('\n');

  it('finds exact match in file', () => {
    const needle = 'function App() {';
    const result = fuzzySearch(haystack, needle);
    expect(result).not.toBeNull();
    expect(result!.similarity).toBe(1);
  });

  it('finds fuzzy match with minor whitespace difference', () => {
    const needle = 'function App(){';  // missing space
    const result = fuzzySearch(haystack, needle, { threshold: 0.8 });
    expect(result).not.toBeNull();
    expect(result!.similarity).toBeGreaterThan(0.8);
  });

  it('finds fuzzy match with indentation difference', () => {
    const needle = 'const [count, setCount] = useState(0);';  // no indent
    const result = fuzzySearch(haystack, needle, { threshold: 0.9 });
    expect(result).not.toBeNull();
  });

  it('returns null for no match below threshold', () => {
    const needle = 'completely unrelated content that has nothing to do with anything';
    const result = fuzzySearch(haystack, needle, { threshold: 0.5 });
    expect(result).toBeNull();
  });

  it('respects startLine/endLine range', () => {
    const needle = 'function App() {';
    const result = fuzzySearch(haystack, needle, {
      startLine: 10,
      endLine: 16,
      threshold: 0.9,
    });
    // App() is at line 3, outside the range
    expect(result).toBeNull();
  });
});

// ─────────── multiLevelMatch ───────────

describe('multiLevelMatch', () => {
  const content = [
    'class MyComponent {',
    '  constructor() {',
    '    this.name = "test";',
    '  }',
    '',
    '  render() {',
    '    return <div>Hello</div>;',
    '  }',
    '}',
  ].join('\n');

  it('returns exact match when string is found', () => {
    const result = multiLevelMatch(content, '  render() {');
    expect(result.matched).toBe(true);
    expect(result.matchLevel).toBe('exact');
    expect(result.similarity).toBe(1);
  });

  it('returns line-trim match when only whitespace differs', () => {
    // Both lines in the needle have different indentation than the haystack:
    // Haystack has "  constructor() {\n    this.name = "test";\n  }"
    // Needle uses tab indentation instead of spaces
    const needle = 'constructor() {\n\tthis.name = "test";\n}';
    const result = multiLevelMatch(content, needle);
    expect(result.matched).toBe(true);
    expect(result.matchLevel).toBe('line-trim');
  });

  it('returns fuzzy match for minor content differences', () => {
    const result = multiLevelMatch(content, '  render() {\n    return <div>World</div>;', { threshold: 0.7 });
    expect(result.matched).toBe(true);
    expect(result.matchLevel).toBe('fuzzy');
    expect(result.similarity).toBeGreaterThan(0.7);
  });

  it('returns no match for completely different content', () => {
    const result = multiLevelMatch(content, 'totally different and unrelated code block here');
    expect(result.matched).toBe(false);
  });

  it('respects allowFuzzy=false', () => {
    const needle = 'constructor() {\n\tthis.name = "test";\n}';
    const result = multiLevelMatch(content, needle, { allowFuzzy: false });
    // line-trim should still work (it's not fuzzy)
    expect(result.matched).toBe(true);
    expect(result.matchLevel).toBe('line-trim');
  });

  it('uses custom threshold', () => {
    // Very strict threshold
    const strict = multiLevelMatch(content, '  render() {\n    return <span>World</span>;', {
      threshold: 0.99,
    });
    // Loose threshold
    const loose = multiLevelMatch(content, '  render() {\n    return <span>World</span>;', {
      threshold: 0.7,
    });
    expect(strict.matched).toBe(false);
    expect(loose.matched).toBe(true);
  });
});

// ─────────── exactMatchCount ───────────

describe('exactMatchCount', () => {
  it('counts occurrences correctly', () => {
    expect(exactMatchCount('abcabcabc', 'abc')).toBe(3);
    expect(exactMatchCount('hello world', 'world')).toBe(1);
    expect(exactMatchCount('hello', 'xyz')).toBe(0);
  });
});
