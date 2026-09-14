/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * CVW 测试输出解析器单测（docs/verification-workflow-optimization-plan.md §4.5）
 *
 * 覆盖：
 * - 八种框架的 stdout → TestRunSummary 压缩
 * - exit code 兜底判定
 * - parseVerifyReport：Verify 子代理自然语言报告（hard 门判定依据）
 * - renderTestSummary 注入文本
 * - 不可信数据防御：cause 长度截断
 */

import { describe, it, expect } from 'vitest';
import {
  parseTestOutput,
  parseVerifyReport,
  renderTestSummary,
  stripAnsi,
} from '../../src/core/verification/index.js';

const ESC = String.fromCharCode(27);

describe('stripAnsi', () => {
  it('去除颜色转义序列', () => {
    expect(stripAnsi(`${ESC}[32mpassed${ESC}[0m`)).toBe('passed');
  });
});

describe('parseTestOutput · vitest', () => {
  const failing = `
 FAIL  tests/core/foo.test.ts > suite > adds numbers
AssertionError: expected 1 to be 2
 ❯ tests/core/foo.test.ts:12:5

 Test Files  1 failed | 3 passed (4)
      Tests  2 failed | 10 passed (12)
`;

  it('解析失败摘要与首个失败定位', () => {
    const s = parseTestOutput(failing, 'vitest');
    expect(s.status).toBe('failed');
    expect(s.passed).toBe(10);
    expect(s.failed).toBe(2);
    expect(s.framework).toBe('vitest');
    expect(s.firstFailures[0]?.file).toBe('tests/core/foo.test.ts');
    expect(s.firstFailures[0]?.cause).toContain('expected 1 to be 2');
  });

  it('解析全绿摘要', () => {
    const s = parseTestOutput('      Tests  0 failed | 42 passed (42)\n', 'vitest');
    expect(s.status).toBe('passed');
    expect(s.passed).toBe(42);
    expect(s.failed).toBe(0);
  });

  it('带 skipped 计数', () => {
    const s = parseTestOutput('      Tests  1 skipped | 5 passed (6)\n', 'vitest');
    expect(s.skipped).toBe(1);
  });

  it('无框架提示时自动嗅探', () => {
    const s = parseTestOutput(failing);
    expect(s.framework).toBe('vitest');
    expect(s.status).toBe('failed');
  });

  it('未收集到测试文件视为解析失败（不能当通过）', () => {
    const s = parseTestOutput('No test files found, exiting with code 1\n', 'vitest');
    expect(s.status).toBe('parse-error');
  });
});

describe('parseTestOutput · jest', () => {
  it('解析逗号分隔摘要', () => {
    const out = `
● suite › renders
  expect(received).toBe(expected)
    at Object.<anonymous> (tests/a.test.ts:9:20)

Tests:       2 failed, 10 passed, 12 total
`;
    const s = parseTestOutput(out, 'jest');
    expect(s.status).toBe('failed');
    expect(s.passed).toBe(10);
    expect(s.failed).toBe(2);
    expect(s.firstFailures.length).toBeGreaterThan(0);
  });
});

describe('parseTestOutput · pytest', () => {
  it('解析汇总行与 FAILED 定位', () => {
    const out = `
FAILED tests/test_foo.py::test_bar - AssertionError: 1 != 2
=========== 2 failed, 10 passed, 1 skipped in 1.23s ===========
`;
    const s = parseTestOutput(out, 'pytest');
    expect(s.status).toBe('failed');
    expect(s.passed).toBe(10);
    expect(s.failed).toBe(2);
    expect(s.skipped).toBe(1);
    expect(s.firstFailures[0]?.file).toBe('tests/test_foo.py');
    expect(s.firstFailures[0]?.name).toBe('test_bar');
  });

  it('error 计入失败数', () => {
    const s = parseTestOutput('===== 1 error, 3 passed in 0.5s =====\n', 'pytest');
    expect(s.status).toBe('failed');
    expect(s.failed).toBe(1);
  });
});

describe('parseTestOutput · go', () => {
  it('解析 --- FAIL 与文件行号', () => {
    const out = `
--- FAIL: TestAdd (0.00s)
    add_test.go:12: got 3 want 4
FAIL
FAIL	example.com/pkg	0.102s
`;
    const s = parseTestOutput(out, 'go');
    expect(s.status).toBe('failed');
    expect(s.firstFailures[0]?.file).toBe('add_test.go');
    expect(s.firstFailures[0]?.line).toBe(12);
  });

  it('全绿包输出', () => {
    const s = parseTestOutput('ok  	example.com/pkg	0.102s\n', 'go');
    expect(s.status).toBe('passed');
  });
});

describe('parseTestOutput · cargo / ctest / mocha / make', () => {
  it('cargo 失败', () => {
    const s = parseTestOutput('test result: FAILED. 10 passed; 2 failed; 1 ignored; 0 measured\n', 'cargo');
    expect(s.status).toBe('failed');
    expect(s.passed).toBe(10);
    expect(s.failed).toBe(2);
    expect(s.skipped).toBe(1);
  });

  it('cargo 通过', () => {
    const s = parseTestOutput('test result: ok. 12 passed; 0 failed; 0 ignored\n', 'cargo');
    expect(s.status).toBe('passed');
  });

  it('ctest 按百分比行推导计数', () => {
    const s = parseTestOutput('80% tests passed, 1 tests failed out of 5\n', 'ctest');
    expect(s.status).toBe('failed');
    expect(s.passed).toBe(4);
    expect(s.failed).toBe(1);
  });

  it('mocha passing/failing', () => {
    const out = `
  10 passing (120ms)
  2 failing
  1 pending

  1) suite case one:
`;
    const s = parseTestOutput(out, 'mocha');
    expect(s.status).toBe('failed');
    expect(s.passed).toBe(10);
    expect(s.failed).toBe(2);
    expect(s.skipped).toBe(1);
  });

  it('make 错误行', () => {
    const s = parseTestOutput('make: *** [Makefile:12: test] Error 1\n', 'make');
    expect(s.status).toBe('failed');
  });
});

describe('parseTestOutput · exit code 兜底', () => {
  it('exit=0 且无法识别格式 → 通过', () => {
    const s = parseTestOutput('$ npx tsc --noEmit\nexit=0\n');
    expect(s.status).toBe('passed');
  });

  it('exit≠0 → 失败，并用末行有效信息作为 cause', () => {
    const s = parseTestOutput('$ npx tsc --noEmit\nsrc/a.ts(3,5): error TS2322: bad type\nexit=2\n');
    expect(s.status).toBe('failed');
    expect(s.firstFailures[0]?.cause).toContain('TS2322');
  });

  it('exit=unknown（后台执行）→ 解析失败', () => {
    const s = parseTestOutput('$ npx vitest run\nexit=unknown\n');
    expect(s.status).toBe('parse-error');
  });

  it('空输出 → 解析失败', () => {
    expect(parseTestOutput('   ').status).toBe('parse-error');
  });

  it('cause 做长度截断（测试输出属不可信数据）', () => {
    const long = 'x'.repeat(5000);
    const s = parseTestOutput(`$ make test\n${long}\nexit=1\n`);
    expect(s.firstFailures[0]?.cause.length).toBeLessThanOrEqual(201);
  });
});

describe('parseVerifyReport · hard 门判定（回归：FAILED 被误判为通过）', () => {
  it('PASSED 报告', () => {
    const r = parseVerifyReport(`
Status: ✅ PASSED
Commands run: npx vitest run tests/core/a.test.ts
Counts: 12 passed / 0 failed
`);
    expect(r?.status).toBe('passed');
    expect(r?.passed).toBe(12);
    expect(r?.failed).toBe(0);
  });

  it('FAILED 报告绝不能被当作通过', () => {
    const r = parseVerifyReport(`
Status: ❌ FAILED
Commands run: npx vitest run
Counts: 10 passed / 2 failed
First failure: tests/core/a.test.ts#L42 — expected 1 to be 2
Next step: 修复 add() 的边界处理
`);
    expect(r?.status).toBe('failed');
    expect(r?.failed).toBe(2);
    expect(r?.firstFailures[0]?.file).toBe('tests/core/a.test.ts');
    expect(r?.firstFailures[0]?.line).toBe(42);
  });

  it('UNVERIFIED / 部分验证按解析失败处理（既不放行也不冤枉变更）', () => {
    expect(parseVerifyReport('Status: ⚠️ UNVERIFIED\n')?.status).toBe('parse-error');
    expect(parseVerifyReport('Status: PARTIAL\n')?.status).toBe('parse-error');
  });

  it('容忍 Markdown 列表标记与全角冒号', () => {
    expect(parseVerifyReport('- Status：❌ FAILED\n')?.status).toBe('failed');
    expect(parseVerifyReport('* Status: PASSED\n')?.status).toBe('passed');
  });

  it('大小写不敏感', () => {
    expect(parseVerifyReport('status: passed\n')?.status).toBe('passed');
  });

  it('三数形式 total/passed/failed', () => {
    const r = parseVerifyReport('Status: FAILED\nCounts: 12 / 11 / 1\n');
    expect(r?.passed).toBe(11);
    expect(r?.failed).toBe(1);
  });

  it('报失败但未给数字时至少计 1（避免渲染成 0 failed 自相矛盾）', () => {
    const r = parseVerifyReport('Status: ❌ FAILED\n');
    expect(r?.failed).toBe(1);
  });

  it('无 Status 行 → undefined（交由调用方回退框架解析器）', () => {
    expect(parseVerifyReport('Tests  0 failed | 10 passed (10)\n')).toBeUndefined();
    expect(parseVerifyReport('   ')).toBeUndefined();
  });

  it('Status 行语义无法识别 → undefined', () => {
    expect(parseVerifyReport('Status: 说不清\n')).toBeUndefined();
  });
});

describe('renderTestSummary', () => {
  it('渲染失败摘要含命令与定位', () => {
    const t = renderTestSummary(
      {
        status: 'failed', passed: 3, failed: 1, skipped: 2,
        firstFailures: [{ file: 'tests/a.test.ts', line: 7, name: 'case', cause: 'boom' }],
      },
      'npx vitest run tests/a.test.ts',
    );
    expect(t).toContain('❌ FAILED');
    expect(t).toContain('npx vitest run tests/a.test.ts');
    expect(t).toContain('3 passed / 1 failed / 2 skipped');
    expect(t).toContain('tests/a.test.ts#L7');
  });

  it('渲染通过摘要', () => {
    const t = renderTestSummary({ status: 'passed', passed: 9, failed: 0, firstFailures: [] });
    expect(t).toContain('✅ PASSED');
  });

  it('解析失败时提示自行判读原始输出', () => {
    const t = renderTestSummary({ status: 'parse-error', passed: 0, failed: 0, firstFailures: [] });
    expect(t).toContain('无法解析');
  });

  it('摘要保持紧凑（<1KB）', () => {
    const t = renderTestSummary({
      status: 'failed', passed: 0, failed: 3,
      firstFailures: Array.from({ length: 3 }, (_, i) => ({
        file: `tests/f${i}.test.ts`, line: i, name: `case ${i}`, cause: 'y'.repeat(200),
      })),
    }, 'npx vitest run');
    expect(t.length).toBeLessThan(1024);
  });
});
