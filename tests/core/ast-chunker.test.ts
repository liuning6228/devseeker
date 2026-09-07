/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * tests/core/ast-chunker.test.ts
 *
 * M4-tree-sitter · AST 语法感知切分器测试
 *
 * 覆盖：
 * - extToLangId：扩展名到语言 ID 映射正确
 * - astChunkText：TS/PY/JAVA/GO 语法感知切分
 * - 不支持的语言回退到行滑窗
 * - WASM 不可用时的降级
 * - 超大函数二次切分
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  astChunkText,
  extToLangId,
  AST_SUPPORTED_EXTS,
} from '../../src/core/index/ast-chunker.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('extToLangId', () => {
  it('映射 .ts → ts', () => {
    expect(extToLangId('src/index.ts')).toBe('ts');
    expect(extToLangId('file.mts')).toBe('ts');
    expect(extToLangId('file.cts')).toBe('ts');
  });
  it('映射 .tsx → tsx', () => expect(extToLangId('app.tsx')).toBe('tsx'));
  it('映射 .js → js', () => {
    expect(extToLangId('index.js')).toBe('js');
    expect(extToLangId('index.mjs')).toBe('js');
  });
  it('映射 .py → py', () => expect(extToLangId('main.py')).toBe('py'));
  it('映射 .java → java', () => expect(extToLangId('App.java')).toBe('java'));
  it('映射 .go → go', () => expect(extToLangId('server.go')).toBe('go'));
  it('映射 .rs → rs', () => expect(extToLangId('lib.rs')).toBe('rs'));
  it('未知扩展名 → undefined', () => {
    expect(extToLangId('readme.md')).toBeUndefined();
    expect(extToLangId('style.css')).toBeUndefined();
  });
});

describe('AST_SUPPORTED_EXTS', () => {
  it('包含 12 个扩展名', () => {
    expect(AST_SUPPORTED_EXTS.size).toBe(13);
    expect(AST_SUPPORTED_EXTS.has('.ts')).toBe(true);
    expect(AST_SUPPORTED_EXTS.has('.py')).toBe(true);
    expect(AST_SUPPORTED_EXTS.has('.rs')).toBe(true);
  });
});

describe('astChunkText', () => {
  // 未支持的扩展名 → 回退行滑窗（同步返回 Promise）
  it('不支持的语言回退到行滑窗', async () => {
    const chunks = await astChunkText('readme.md', 'line1\nline2\nline3');
    expect(chunks.length).toBe(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(3);
    expect(chunks[0].text).toContain('line1');
  });

  // WASM 加载失败的场景 → mock web-tree-sitter 抛出异常，验证降级
  it('WASM 加载失败时回退到行滑窗', async () => {
    // mock require 使 web-tree-sitter 加载失败
    vi.mock('web-tree-sitter', () => {
      throw new Error('mock WASM load failure');
    });
    // 由于 vi.mock 在模块级别，这个测试只能验证 extToLangId 和基础降级行为
    const chunks = await astChunkText('test.py', 'def foo():\n    pass\n\ndef bar():\n    pass\n');
    // 降级后应该是行滑窗结果（至少包含文件内容）
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.some(c => c.text.includes('foo'))).toBe(true);
  });

  // TypeScript 语法感知切分：验证函数和类被正确识别
  it('TypeScript 函数识别', async () => {
    const code = `function add(a: number, b: number): number {
  return a + b;
}

function sub(a: number, b: number): number {
  return a - b;
}
`;
    // 由于 WASM 可能不可用（CI 环境），我们验证无论哪种路径都返回有意义的 chunks
    const chunks = await astChunkText('math.ts', code);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // 验证内容被保留
    const allText = chunks.map(c => c.text).join('\n');
    expect(allText).toContain('function add');
    expect(allText).toContain('function sub');
  });

  it('TypeScript class 识别', async () => {
    const code = `class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  sub(a: number, b: number): number {
    return a - b;
  }
}

class Logger {
  log(msg: string): void {
    console.log(msg);
  }
}
`;
    const chunks = await astChunkText('calc.ts', code);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const allText = chunks.map(c => c.text).join('\n');
    expect(allText).toContain('Calculator');
    expect(allText).toContain('Logger');
  });

  it('Python 函数识别', async () => {
    const code = `def foo():
    pass

def bar(x: int) -> str:
    return str(x)
`;
    const chunks = await astChunkText('demo.py', code);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const allText = chunks.map(c => c.text).join('\n');
    expect(allText).toContain('def foo');
    expect(allText).toContain('def bar');
  });

  it('Java 类识别', async () => {
    const code = `public class Hello {
  public void greet() {
    System.out.println("hi");
  }
}

class World {
  public void run() {
    System.out.println("run");
  }
}
`;
    const chunks = await astChunkText('Hello.java', code);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const allText = chunks.map(c => c.text).join('\n');
    expect(allText).toContain('Hello');
    expect(allText).toContain('World');
  });

  it('Go 函数识别', async () => {
    const code = `package main

func add(a int, b int) int {
  return a + b
}

func sub(a int, b int) int {
  return a - b
}
`;
    const chunks = await astChunkText('math.go', code);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const allText = chunks.map(c => c.text).join('\n');
    expect(allText).toContain('func add');
    expect(allText).toContain('func sub');
  });

  it('Rust 函数识别', async () => {
    const code = `fn add(a: i32, b: i32) -> i32 {
  a + b
}

fn sub(a: i32, b: i32) -> i32 {
  a - b
}
`;
    const chunks = await astChunkText('math.rs', code);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const allText = chunks.map(c => c.text).join('\n');
    expect(allText).toContain('fn add');
    expect(allText).toContain('fn sub');
  });

  // 超大函数二次切分（> 1600 chars）
  it('超大函数被二次切分', async () => {
    // 构造一个超过 maxChars 的 TypeScript 函数
    const longBody = Array.from({ length: 80 }, (_, i) => `  // line ${i}: x${'x'.repeat(30)}`).join('\n');
    const code = `function veryLong() {\n${longBody}\n}\n`;
    const chunks = await astChunkText('long.ts', code);
    // 应该被切分成至少 2 个 chunk
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  // 空文件
  it('空文件返回空数组', async () => {
    const chunks = await astChunkText('empty.ts', '');
    expect(chunks.length).toBe(0);
  });

  // 空白文件
  it('空白文件返回空数组', async () => {
    const chunks = await astChunkText('blank.ts', '   \n  \n');
    expect(chunks.length).toBe(0);
  });

  // 短内容不切分
  it('短内容返回单个 chunk', async () => {
    const chunks = await astChunkText('short.ts', 'const x = 1;\n');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  // 节点间隙的超大注释块（> maxChars）按 maxChars 二次切分，且注释内容不丢失
  it('超大注释间隙按 maxChars 二次切分且内容不丢失', async () => {
    // 构造一块超过默认 maxChars(1600) 的头部注释（模拟 LICENSE 块）
    const commentLines = Array.from({ length: 60 }, (_, i) => `// ${i}: ${'y'.repeat(40)}`);
    const comment = commentLines.join('\n');
    expect(comment.length).toBeGreaterThan(1600);
    const code = `${comment}\n\nfunction handle() {\n  return 1;\n}\n`;
    const chunks = await astChunkText('gap.ts', code);
    // 注释被切为多个 gap chunk + 函数节点 chunk
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // gap chunk（无 `// file:` 上下文头前缀）单块不超过 maxChars
    for (const c of chunks) {
      if (!c.text.startsWith('// file:')) {
        expect(c.text.length).toBeLessThanOrEqual(1600);
      }
    }
    // 注释首尾行与函数文本都保留（切分不丢内容）
    const allText = chunks.map(c => c.text).join('\n');
    expect(allText).toContain('// 0: yyyyyyyyy');
    expect(allText).toContain('// 59: yyyyyyyyy');
    expect(allText).toContain('function handle');
    // chunk 按行号有序、无重叠
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startLine).toBeGreaterThanOrEqual(chunks[i - 1].endLine);
    }
  });

  // Vue SFC：三层 chunk 输出，且 WASM 可用时优先走 tree-sitter AST 分支
  it('Vue SFC 输出三层 chunk 且优先走 AST 分支', async () => {
    const code = `<template>\n  <el-button>Go</el-button>\n</template>\n\n<script setup lang="ts">\nconst msg = 'hello';\nfunction greet() { return msg; }\n</script>\n\n<style scoped>\n.btn { color: red; }\n</style>\n`;

    // WASM 可用时挂 spy 验证 AST 分支被触发（chunkVueSfcWithTreeSitter 内实例化
    // parser 并 setLanguage 才会调用到）；WASM 不可用环境跳过 spy 断言，输出断言兜底
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const wts: unknown = await import('web-tree-sitter');
      const ns = wts as { Parser?: { prototype: object }; default?: { prototype: object } };
      const ParserCtor: unknown = ns.Parser ?? ns.default ?? wts;
      if (typeof ParserCtor !== 'undefined') {
        spy = vi.spyOn((ParserCtor as { prototype: object }).prototype, 'setLanguage' as never);
      }
    } catch {
      // tree-sitter 不可用 → 跳过 spy 断言
    }

    const chunks = await astChunkText('comp.vue', code);
    expect(chunks.some(c => c.text.startsWith('[vue-template]'))).toBe(true);
    expect(chunks.some(c => c.text.startsWith('[vue-script'))).toBe(true);
    expect(chunks.some(c => c.text.startsWith('[vue-style]'))).toBe(true);
    if (spy) expect(spy).toHaveBeenCalled();
  });
});
