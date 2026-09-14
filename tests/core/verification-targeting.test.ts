/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * CVW 变更影响分析器单测（docs/verification-workflow-optimization-plan.md §4.2）
 *
 * 覆盖：
 * - isTestPath 各生态测试文件识别
 * - 约定映射（同目录 / __tests__ / 镜像 tests/ / 扁平 testDir）
 * - 图索引反向依赖（fake GraphIndex 注入）与异常吞掉
 * - 回落全量的三种情形：无映射 / 超上限 / 框架不支持文件参数
 * - buildTestCommand 各框架命令组装
 */

import { describe, it, expect } from 'vitest';
import {
  buildTestCommand,
  computeAffectedTests,
  isTestPath,
  type GraphIndexLike,
  type TestPlan,
} from '../../src/core/verification/index.js';

const WS = '/ws';

function plan(over: Partial<TestPlan> = {}): TestPlan {
  return {
    framework: 'vitest',
    testCommand: 'npx vitest run',
    testDirGlobs: ['tests/**'],
    conventions: { testDir: 'tests/core', filePattern: '*.test.ts' },
    ...over,
  };
}

/** 只有白名单里的相对路径“存在” */
function existsOf(rels: string[]): (abs: string) => Promise<boolean> {
  const set = new Set(rels.map((r) => `${WS}/${r}`));
  return async (abs: string) => set.has(abs.replace(/\\/g, '/'));
}

function fakeGraph(
  symbols: Record<string, string[]>,
  callers: Record<string, string[]>,
): GraphIndexLike {
  return {
    findSymbolsByPathPrefix: (prefix) =>
      (symbols[prefix] ?? []).map((name) => ({ name, filePath: prefix })),
    findCallers: (name) => (callers[name] ?? []).map((filePath) => ({ name: 'caller', filePath })),
  };
}

describe('isTestPath', () => {
  it('识别 JS/TS 测试文件', () => {
    expect(isTestPath('src/a.test.ts')).toBe(true);
    expect(isTestPath('src/a.spec.tsx')).toBe(true);
    expect(isTestPath('src/a.test.mjs')).toBe(true);
    expect(isTestPath('src/a.ts')).toBe(false);
  });

  it('识别测试目录', () => {
    expect(isTestPath('tests/core/foo.ts')).toBe(true);
    expect(isTestPath('test/foo.ts')).toBe(true);
    expect(isTestPath('src/__tests__/foo.ts')).toBe(true);
    expect(isTestPath('src/latest/foo.ts')).toBe(false);
  });

  it('识别 python/go/rust/c 风格', () => {
    expect(isTestPath('pkg/test_foo.py')).toBe(true);
    expect(isTestPath('pkg/foo_test.go')).toBe(true);
    expect(isTestPath('src/foo_test.rs')).toBe(true);
    expect(isTestPath('src/foo_test.cpp')).toBe(true);
  });

  it('兼容 Windows 分隔符', () => {
    expect(isTestPath('tests\\core\\foo.ts')).toBe(true);
  });
});

describe('computeAffectedTests · 约定映射', () => {
  it('镜像目录命中（DevSeeker 自身约定 src/core/x → tests/core/x.test.ts）', async () => {
    const r = await computeAffectedTests({
      workspaceRoot: WS,
      editedFiles: [`${WS}/src/core/loop.ts`],
      plan: plan(),
      exists: existsOf(['tests/core/loop.test.ts']),
    });
    expect(r.testFiles).toEqual(['tests/core/loop.test.ts']);
    expect(r.source).toBe('convention');
    expect(r.fullSuite).toBe(false);
    expect(r.command).toBe('npx vitest run tests/core/loop.test.ts');
  });

  it('同目录与 __tests__ 命中', async () => {
    const r = await computeAffectedTests({
      workspaceRoot: WS,
      editedFiles: [`${WS}/src/a.ts`, `${WS}/src/b.ts`],
      plan: plan(),
      exists: existsOf(['src/a.test.ts', 'src/__tests__/b.test.ts']),
    });
    expect(r.testFiles).toEqual(['src/__tests__/b.test.ts', 'src/a.test.ts']);
  });

  it('变更的就是测试文件本身 → 直接纳入', async () => {
    const r = await computeAffectedTests({
      workspaceRoot: WS,
      editedFiles: [`${WS}/tests/core/gate.test.ts`],
      plan: plan(),
      exists: existsOf([]),
    });
    expect(r.testFiles).toEqual(['tests/core/gate.test.ts']);
    expect(r.source).toBe('convention');
  });

  it('相对路径输入同样可用', async () => {
    const r = await computeAffectedTests({
      workspaceRoot: WS,
      editedFiles: ['src/core/loop.ts'],
      plan: plan(),
      exists: existsOf(['tests/core/loop.test.ts']),
    });
    expect(r.testFiles).toEqual(['tests/core/loop.test.ts']);
  });

  it('工作区外的文件被忽略', async () => {
    const r = await computeAffectedTests({
      workspaceRoot: WS,
      editedFiles: ['/etc/hosts'],
      plan: plan(),
      exists: existsOf([]),
    });
    expect(r.testFiles).toEqual([]);
    expect(r.source).toBe('none');
  });

  it('pytest 约定映射', async () => {
    const r = await computeAffectedTests({
      workspaceRoot: WS,
      editedFiles: [`${WS}/pkg/mod/util.py`],
      plan: plan({
        framework: 'pytest',
        testCommand: 'python -m pytest',
        conventions: { testDir: 'tests', filePattern: 'test_*.py' },
      }),
      exists: existsOf(['tests/mod/test_util.py']),
    });
    expect(r.testFiles).toEqual(['tests/mod/test_util.py']);
    expect(r.command).toBe('python -m pytest tests/mod/test_util.py');
  });

  it('go 约定映射并按包粒度组装命令', async () => {
    const r = await computeAffectedTests({
      workspaceRoot: WS,
      editedFiles: [`${WS}/pkg/svc/add.go`],
      plan: plan({
        framework: 'go',
        testCommand: 'go test ./...',
        conventions: { testDir: 'pkg', filePattern: '*_test.go' },
      }),
      exists: existsOf(['pkg/svc/add_test.go']),
    });
    expect(r.testFiles).toEqual(['pkg/svc/add_test.go']);
    expect(r.command).toBe('go test ./pkg/svc/...');
  });
});

describe('computeAffectedTests · 图索引反向依赖', () => {
  it('约定映射不到时用调用方反查（source=graph）', async () => {
    const r = await computeAffectedTests({
      workspaceRoot: WS,
      editedFiles: [`${WS}/src/util/hash.ts`],
      plan: plan(),
      exists: existsOf([]),
      graphIndex: fakeGraph(
        { 'src/util/hash.ts': ['hashOf'] },
        { hashOf: ['tests/core/consumer.test.ts', 'src/app.ts'] },
      ),
    });
    expect(r.testFiles).toEqual(['tests/core/consumer.test.ts']);
    expect(r.source).toBe('graph');
    expect(r.fullSuite).toBe(false);
  });

  it('约定 + 图索引混合命中', async () => {
    const r = await computeAffectedTests({
      workspaceRoot: WS,
      editedFiles: [`${WS}/src/core/loop.ts`, `${WS}/src/util/hash.ts`],
      plan: plan(),
      exists: existsOf(['tests/core/loop.test.ts']),
      graphIndex: fakeGraph(
        { 'src/util/hash.ts': ['hashOf'] },
        { hashOf: ['tests/core/hash.test.ts'] },
      ),
    });
    expect(r.testFiles).toEqual(['tests/core/hash.test.ts', 'tests/core/loop.test.ts']);
    expect(r.source).toBe('convention+graph');
  });

  it('图索引只认精确同文件的符号（前缀语义会带回同目录其它文件）', async () => {
    const graph: GraphIndexLike = {
      findSymbolsByPathPrefix: () => [{ name: 'other', filePath: 'src/util/other.ts' }],
      findCallers: () => [{ name: 'c', filePath: 'tests/core/other.test.ts' }],
    };
    const r = await computeAffectedTests({
      workspaceRoot: WS,
      editedFiles: [`${WS}/src/util/hash.ts`],
      plan: plan(),
      exists: existsOf([]),
      graphIndex: graph,
    });
    expect(r.testFiles).toEqual([]);
  });

  it('图索引抛错不影响流程（可选增强）', async () => {
    const graph: GraphIndexLike = {
      findSymbolsByPathPrefix: () => { throw new Error('db closed'); },
      findCallers: () => { throw new Error('db closed'); },
    };
    const r = await computeAffectedTests({
      workspaceRoot: WS,
      editedFiles: [`${WS}/src/util/hash.ts`],
      plan: plan(),
      exists: existsOf([]),
      graphIndex: graph,
    });
    expect(r.source).toBe('none');
    expect(r.fullSuite).toBe(true);
    expect(r.command).toBe('npx vitest run');
  });
});

describe('computeAffectedTests · 回落全量', () => {
  it('未映射到任何测试 → 全量命令 + note', async () => {
    const r = await computeAffectedTests({
      workspaceRoot: WS,
      editedFiles: [`${WS}/src/util/hash.ts`],
      plan: plan(),
      exists: existsOf([]),
    });
    expect(r.testFiles).toEqual([]);
    expect(r.command).toBe('npx vitest run');
    expect(r.fullSuite).toBe(true);
    expect(r.note).toContain('src/util/hash.ts');
  });

  it('受影响测试超过 10 个 → 回落全量但保留清单', async () => {
    const edited = Array.from({ length: 11 }, (_, i) => `${WS}/tests/core/f${i}.test.ts`);
    const r = await computeAffectedTests({
      workspaceRoot: WS, editedFiles: edited, plan: plan(), exists: existsOf([]),
    });
    expect(r.testFiles.length).toBe(11);
    expect(r.fullSuite).toBe(true);
    expect(r.source).toBe('full-suite');
    expect(r.note).toContain('回落全量');
  });

  it('框架不支持文件参数（cargo）→ 全量', async () => {
    const r = await computeAffectedTests({
      workspaceRoot: WS,
      editedFiles: [`${WS}/tests/hash.rs`],
      plan: plan({ framework: 'cargo', testCommand: 'cargo test' }),
      exists: existsOf([]),
    });
    expect(r.testFiles).toEqual(['tests/hash.rs']);
    expect(r.command).toBe('cargo test');
    expect(r.fullSuite).toBe(true);
    expect(r.source).toBe('full-suite');
  });

  it('framework=none → 直接全量/无命令', async () => {
    const r = await computeAffectedTests({
      workspaceRoot: WS,
      editedFiles: [`${WS}/src/a.ts`],
      plan: plan({ framework: 'none', testCommand: '' }),
      exists: existsOf([]),
    });
    expect(r.source).toBe('none');
    expect(r.command).toBe('');
    expect(r.fullSuite).toBe(false);
  });

  it('无工作区根 → 不做映射', async () => {
    const r = await computeAffectedTests({
      workspaceRoot: undefined,
      editedFiles: ['/x/a.ts'],
      plan: plan(),
    });
    expect(r.source).toBe('full-suite');
    expect(r.command).toBe('npx vitest run');
  });

  it('空编辑集 → 无命中', async () => {
    const r = await computeAffectedTests({
      workspaceRoot: WS, editedFiles: [], plan: plan(), exists: existsOf([]),
    });
    expect(r.source).toBe('none');
    expect(r.fullSuite).toBe(false);
  });
});

describe('buildTestCommand', () => {
  it('vitest 追加文件参数', () => {
    expect(buildTestCommand(plan(), ['tests/a.test.ts', 'tests/b.test.ts']))
      .toBe('npx vitest run tests/a.test.ts tests/b.test.ts');
  });

  it('空测试集 / 空命令返回空串', () => {
    expect(buildTestCommand(plan(), [])).toBe('');
    expect(buildTestCommand(plan({ testCommand: '' }), ['tests/a.test.ts'])).toBe('');
  });

  it('npm script 不追加参数（行为不可预期）', () => {
    expect(buildTestCommand(plan({ testCommand: 'npm test' }), ['tests/a.test.ts'])).toBe('');
    expect(buildTestCommand(plan({ testCommand: 'npm run test:unit' }), ['tests/a.test.ts'])).toBe('');
  });

  it('cargo/ctest/make 不支持文件过滤', () => {
    expect(buildTestCommand(plan({ framework: 'cargo', testCommand: 'cargo test' }), ['tests/a.rs'])).toBe('');
    expect(buildTestCommand(plan({ framework: 'ctest', testCommand: 'ctest' }), ['tests/a.cpp'])).toBe('');
    expect(buildTestCommand(plan({ framework: 'make', testCommand: 'make test' }), ['tests/a.c'])).toBe('');
  });

  it('go 目录去重并去掉尾部 ./...', () => {
    const cmd = buildTestCommand(
      plan({ framework: 'go', testCommand: 'go test ./...' }),
      ['pkg/a/x_test.go', 'pkg/a/y_test.go', 'pkg/b/z_test.go'],
    );
    expect(cmd).toBe('go test ./pkg/a/... ./pkg/b/...');
  });

  it('含 shell 元字符的路径加引号（防拼接注入）', () => {
    const cmd = buildTestCommand(plan(), ['tests/a b;rm -rf.test.ts']);
    expect(cmd).toContain("'tests/a b;rm -rf.test.ts'");
  });
});
