/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * T4 金测 · 跨 10 文件重构接口签名（B-P3-3）
 *
 * 来源：DESIGN 附录 A 金测 T4 —— "给 IProvider.createMessage 第 2 个参数加可选字段，
 * 更新所有调用点；`npm run type-check` 0 errors + grep 新签名一致"。
 *
 * 本测试以程序化方式验证链路的核心能力（不依赖真实 LSP / VSCode）：
 *   1) 构造 tmp 工作区，10 个 `.ts` 文件，每个文件都有 `provider.createMessage(messages)` 调用
 *   2) FakeBridge.findReferences 按 fixture 返回 10 处跨文件 reference
 *   3) FindReferencesTool.execute → 解析 structured.locations，获得 10 个不同 filePath
 *   4) 对每个文件用 SearchReplaceTool 把旧签名改为新签名（replace_all 批量）
 *   5) 读回所有文件 → 断言：
 *       - 不再包含旧签名
 *       - 每个文件都至少有 1 处新签名
 *       - 所有 10 个文件被修改
 *
 * 这是 "LSP findReferences 穷举 → 批量 search_replace" 端到端闭环的程序化金测，
 * 对应金测 T4 "✅ 新签名一致" 判定。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FindReferencesTool,
  SearchReplaceTool,
} from '../../src/core/tools/index.js';
import type {
  LspBridge,
  LspLocation,
  LspPosition,
  LspSymbol,
  CallHierarchyEntry,
} from '../../src/core/lsp/bridge.js';
import { ErrorCodes } from '../../src/core/errors/index.js';

// ─────────────── Fixture helpers ───────────────

const FILE_COUNT = 10;
const OLD_SIG = 'provider.createMessage(messages)';
const NEW_SIG = 'provider.createMessage(messages, { trace: true })';

function makeFileContent(index: number): string {
  return [
    `// auto-generated fixture #${index}`,
    `import type { IProvider } from './provider.js';`,
    ``,
    `export async function caller${index}(provider: IProvider) {`,
    `  const messages = [{ role: 'user', content: 'hi ${index}' }];`,
    `  const result = await ${OLD_SIG};`,
    `  return result;`,
    `}`,
    ``,
  ].join('\n');
}

class FakeBridge implements LspBridge {
  constructor(private readonly refs: LspLocation[]) {}

  async goToDefinition(): Promise<LspLocation[]> { return []; }
  async findReferences(
    _filePath: string,
    _pos: LspPosition,
    _incl?: boolean,
  ): Promise<LspLocation[]> {
    return this.refs;
  }
  async documentSymbols(): Promise<LspSymbol[]> { return []; }
  async workspaceSymbols(): Promise<LspSymbol[]> { return []; }
  async goToImplementation(): Promise<LspLocation[]> { return []; }
  async callHierarchy(): Promise<CallHierarchyEntry[]> { return []; }
}

function makeCtx(workspaceRoot: string) {
  return {
    toolCallId: 't4',
    workspaceRoot,
    signal: new AbortController().signal,
    taskId: 'task-t4',
  };
}

// ─────────────── Test ───────────────

describe('T4 金测 · 跨 10 文件重构接口签名（B-P3-3）', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    // 用 tmp dir 构造 10 个文件的 fixture 工作区
    workspaceRoot = await fs.mkdtemp(join(tmpdir(), 'dualmind-t4-'));
    for (let i = 0; i < FILE_COUNT; i++) {
      const filePath = join(workspaceRoot, `caller${i}.ts`);
      await fs.writeFile(filePath, makeFileContent(i), 'utf-8');
    }
    // 放一个定义文件（作为 findReferences 的"入口"）
    await fs.writeFile(
      join(workspaceRoot, 'provider.ts'),
      [
        `export interface IProvider {`,
        `  createMessage(messages: unknown[]): Promise<unknown>;`,
        `}`,
        ``,
      ].join('\n'),
      'utf-8',
    );
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('findReferences 返回 10 处引用，覆盖 10 个不同文件', async () => {
    // 构造 10 处 fake reference（每个 fixture 文件一处）
    const refs: LspLocation[] = Array.from({ length: FILE_COUNT }, (_, i) => ({
      filePath: `caller${i}.ts`,
      range: {
        start: { line: 6, character: 28 },
        end: { line: 6, character: 28 + 'createMessage'.length },
      },
      preview: `  const result = await ${OLD_SIG};`,
    }));

    const bridge = new FakeBridge(refs);
    const tool = new FindReferencesTool({ getBridge: () => bridge });

    const res = await tool.execute(
      { file_path: 'provider.ts', line: 2, character: 3, include_declaration: false },
      makeCtx(workspaceRoot),
    );

    expect(res.ok).toBe(true);
    expect(res.display).toBeTruthy();
    const structured = res.display as {
      count: number;
      locations: Array<{ filePath: string }>;
    };
    expect(structured.count).toBe(FILE_COUNT);
    const uniqueFiles = new Set(structured.locations.map((l) => l.filePath));
    expect(uniqueFiles.size).toBe(FILE_COUNT);
  });

  it('端到端：基于 findReferences 结果用 search_replace 批量改签名，所有文件一致', async () => {
    // 步骤 1：findReferences 拿到 10 处引用
    const refs: LspLocation[] = Array.from({ length: FILE_COUNT }, (_, i) => ({
      filePath: `caller${i}.ts`,
      range: {
        start: { line: 6, character: 28 },
        end: { line: 6, character: 28 + 'createMessage'.length },
      },
    }));
    const bridge = new FakeBridge(refs);
    const findTool = new FindReferencesTool({ getBridge: () => bridge });

    const findRes = await findTool.execute(
      { file_path: 'provider.ts', line: 2, character: 3 },
      makeCtx(workspaceRoot),
    );
    expect(findRes.ok).toBe(true);
    const locations = (findRes.display as { locations: Array<{ filePath: string }> }).locations;

    // 步骤 2：按 filePath 分组去重（同一文件可能多处引用）
    const uniqueFiles = Array.from(new Set(locations.map((l) => l.filePath)));
    expect(uniqueFiles).toHaveLength(FILE_COUNT);

    // 步骤 3：逐个文件 search_replace（replace_all=true，等价于 LLM 一次性收敛）
    const replaceTool = new SearchReplaceTool();
    for (const relPath of uniqueFiles) {
      const res = await replaceTool.execute(
        {
          file_path: relPath,
          old_string: OLD_SIG,
          new_string: NEW_SIG,
          replace_all: true,
        },
        makeCtx(workspaceRoot),
      );
      expect(res.ok, `search_replace failed for ${relPath}: ${res.content}`).toBe(true);
    }

    // 步骤 4：grep 断言所有 fixture 文件都已更新（0 处旧签名，≥1 处新签名）
    for (let i = 0; i < FILE_COUNT; i++) {
      const content = await fs.readFile(join(workspaceRoot, `caller${i}.ts`), 'utf-8');
      expect(content, `file ${i} still has old signature`).not.toContain(OLD_SIG);
      expect(content, `file ${i} missing new signature`).toContain(NEW_SIG);
    }
  });

  it('search_replace 对不含旧签名的 provider.ts 不报错（选择不调用）', async () => {
    // 验证 search_replace 工具对不含目标字符串的文件返回 TOOL_PATCH_NO_MATCH
    // —— 这条确认 LLM 只需在 findReferences 列出的文件上做 replace，不会误改无关文件。
    const replaceTool = new SearchReplaceTool();
    const res = await replaceTool.execute(
      {
        file_path: 'provider.ts',
        old_string: OLD_SIG,
        new_string: NEW_SIG,
      },
      makeCtx(workspaceRoot),
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe(ErrorCodes.TOOL_PATCH_NO_MATCH);
  });

  it('bridge 未就绪 → find_references 返回 LSP_SERVER_NOT_RUNNING', async () => {
    const tool = new FindReferencesTool({ getBridge: () => undefined });
    const res = await tool.execute(
      { file_path: 'provider.ts', line: 2, character: 3 },
      makeCtx(workspaceRoot),
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe(ErrorCodes.LSP_SERVER_NOT_RUNNING);
  });

  it('回归：FakeBridge 返回 0 条 → find_references count=0（不误报）', async () => {
    const bridge = new FakeBridge([]);
    const tool = new FindReferencesTool({ getBridge: () => bridge });
    const res = await tool.execute(
      { file_path: 'provider.ts', line: 2, character: 3 },
      makeCtx(workspaceRoot),
    );
    expect(res.ok).toBe(true);
    expect((res.display as { count: number }).count).toBe(0);
  });
});
