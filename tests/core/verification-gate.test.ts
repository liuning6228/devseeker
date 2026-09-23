/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * CVW 验证门单测（docs/verification-workflow-optimization-plan.md §4.3 / §4.6 / §4.7）
 *
 * 覆盖：
 * - decideGate 决策优先级：零开销放行 → 预算安全阀 → 分级拦截
 * - 两个独立预算：MAX_SOFT_PROMPTS（不肯跑测试）vs maxFixRounds（改不好）
 * - buildGatePrompt 分级文本与报告格式契约
 * - isVerificationCommand 客观放行信号（子序列匹配 + 兜底正则）
 * - decideTier 降级链（含交叉工具链）
 * - normalizeVerificationConfig 非法值回落
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_VERIFICATION_CONFIG,
  MAX_SOFT_PROMPTS,
  buildCompletionFallbackSummary,
  buildFixPrompt,
  buildGatePrompt,
  buildUnverifiedWarning,
  decideGate,
  decideTier,
  isGateMode,
  isVerificationCommand,
  isVerificationState,
  normalizeVerificationConfig,
  type GateInput,
  type TestPlan,
  type VerificationConfig,
} from '../../src/core/verification/index.js';

const PLAN: TestPlan = {
  framework: 'vitest',
  testCommand: 'npx vitest run',
  typecheckCommand: 'npx tsc --noEmit',
  buildCommand: 'npm run build',
  testDirGlobs: ['tests/**'],
  conventions: { testDir: 'tests/core', filePattern: '*.test.ts' },
};

function gateInput(over: Partial<GateInput> = {}): GateInput {
  return {
    config: { ...DEFAULT_VERIFICATION_CONFIG },
    state: 'Edited',
    editedFileCount: 1,
    turn: 3,
    maxTurns: 30,
    gatePromptCount: 0,
    fixRounds: 0,
    tier: 'L1-test',
    hardAttempted: false,
    ...over,
  };
}

describe('decideGate · 零开销放行路径', () => {
  it('gate=off 直接放行', () => {
    const d = decideGate(gateInput({ config: { ...DEFAULT_VERIFICATION_CONFIG, gate: 'off' } }));
    expect(d).toEqual({ action: 'allow', reason: 'gate-off' });
  });

  it('无编辑放行（editedFileCount=0）', () => {
    expect(decideGate(gateInput({ editedFileCount: 0 })).reason).toBe('no-edits');
  });

  it('状态 NotEdited 放行', () => {
    expect(decideGate(gateInput({ state: 'NotEdited' })).reason).toBe('no-edits');
  });

  it('已验证通过放行且无警示语', () => {
    const d = decideGate(gateInput({ state: 'Passed' }));
    expect(d.action).toBe('allow');
    expect(d.reason).toBe('already-verified');
    expect(d.warning).toBeUndefined();
  });

  it('Exceeded 放行但必须带警示语（绝不静默吞失败）', () => {
    const d = decideGate(gateInput({ state: 'Exceeded', fixRounds: 3 }));
    expect(d.action).toBe('allow');
    expect(d.warning).toContain('验证未通过');
  });
});

describe('decideGate · 预算安全阀', () => {
  it('最后一轮强制放行——门不能把任务拖成 max_turns 失败', () => {
    const d = decideGate(gateInput({ turn: 30, maxTurns: 30 }));
    expect(d.action).toBe('allow');
    expect(d.reason).toBe('turn-budget');
    expect(d.warning).toContain('未验证');
  });

  it('turn 超过 maxTurns 同样放行', () => {
    expect(decideGate(gateInput({ turn: 31, maxTurns: 30 })).reason).toBe('turn-budget');
  });

  it('修复轮次耗尽放行并标注轮数', () => {
    const d = decideGate(gateInput({ state: 'Failed', fixRounds: 3 }));
    expect(d.action).toBe('allow');
    expect(d.reason).toBe('fix-budget');
    expect(d.warning).toContain('3');
  });

  it('maxFixRounds=0 时任何 Failed 都不再修复', () => {
    const config: VerificationConfig = { ...DEFAULT_VERIFICATION_CONFIG, maxFixRounds: 0 };
    expect(decideGate(gateInput({ config, state: 'Failed' })).reason).toBe('fix-budget');
  });
});

describe('decideGate · 两个独立预算（回归：预算耦合缺陷）', () => {
  it('Failed 走修复路径，不消耗 MAX_SOFT_PROMPTS 预算', () => {
    // gatePromptCount 已触顶，但修复轮次尚有余额 → 仍须继续修复
    const d = decideGate(gateInput({
      state: 'Failed',
      gatePromptCount: MAX_SOFT_PROMPTS,
      fixRounds: 1,
    }));
    expect(d.action).toBe('soft-prompt');
    expect(d.reason).toBe('fix-round-1');
  });

  it('soft 提醒耗尽且从未跑过测试 → 放行 + no-test-run 警示', () => {
    const d = decideGate(gateInput({ state: 'Verifying', gatePromptCount: MAX_SOFT_PROMPTS }));
    expect(d.action).toBe('allow');
    expect(d.reason).toBe('soft-exhausted');
    expect(d.warning).toContain('未检测到测试命令执行');
  });

  it('soft 提醒耗尽且为 L4 → 警示语改为人工清单口径', () => {
    const d = decideGate(gateInput({
      state: 'Verifying',
      tier: 'L4-manual',
      gatePromptCount: MAX_SOFT_PROMPTS,
    }));
    expect(d.warning).toContain('人工验证清单');
  });
});

describe('decideGate · 分级拦截', () => {
  it('soft 模式首次拦截注入提示，reason 带 tier', () => {
    const d = decideGate(gateInput());
    expect(d.action).toBe('soft-prompt');
    expect(d.reason).toBe('soft-L1-test');
  });

  it('L4 首次拦截给人工清单原因', () => {
    expect(decideGate(gateInput({ tier: 'L4-manual' })).reason).toBe('manual-checklist');
  });

  it('hard 模式首轮仍走 soft（成本最低）', () => {
    const config: VerificationConfig = { ...DEFAULT_VERIFICATION_CONFIG, gate: 'hard' };
    expect(decideGate(gateInput({ config })).action).toBe('soft-prompt');
  });

  it('hard 模式 soft 一次未奏效 → 程序化派发子代理', () => {
    const config: VerificationConfig = { ...DEFAULT_VERIFICATION_CONFIG, gate: 'hard' };
    const d = decideGate(gateInput({ config, state: 'Verifying', gatePromptCount: 1 }));
    expect(d.action).toBe('hard-verify');
    expect(d.reason).toBe('soft-ineffective');
  });

  it('hard 已派发过则不再重复派发，退回 soft/放行', () => {
    const config: VerificationConfig = { ...DEFAULT_VERIFICATION_CONFIG, gate: 'hard' };
    const d = decideGate(gateInput({
      config,
      state: 'Verifying',
      gatePromptCount: MAX_SOFT_PROMPTS,
      hardAttempted: true,
    }));
    expect(d.action).toBe('allow');
    expect(d.reason).toBe('soft-exhausted');
  });
});

describe('buildGatePrompt', () => {
  const base = {
    editedFiles: ['src/core/a.ts'],
    plan: PLAN,
    command: 'npx vitest run tests/core/a.test.ts',
    testFiles: ['tests/core/a.test.ts'],
    attempt: 1,
  };

  it('含验证门标记与报告格式契约（供 parseVerifyReport 解析）', () => {
    const p = buildGatePrompt({ ...base, tier: 'L1-test' });
    expect(p).toContain('[Verification Gate]');
    expect(p).toContain('Status:');
    expect(p).toContain('Commands run:');
    expect(p).toContain('Counts:');
  });

  it('要求验证后输出"综合最终答复"（结论 + 验证结果合并，禁止只回一句测试通过）', () => {
    const p = buildGatePrompt({ ...base, tier: 'L1-test' });
    expect(p).toContain('综合最终答复');
    expect(p).toContain('合并重写');
    expect(p).toContain('不要只回一句"测试通过"');
  });

  it('L1 给出命令与受影响测试', () => {
    const p = buildGatePrompt({ ...base, tier: 'L1-test' });
    expect(p).toContain('L1 测试级');
    expect(p).toContain('npx vitest run tests/core/a.test.ts');
    expect(p).toContain('tests/core/a.test.ts');
  });

  it('L2 携带项目测试约定（目录/命名）', () => {
    const p = buildGatePrompt({ ...base, tier: 'L2-new-test', testFiles: [] });
    expect(p).toContain('L2 补测级');
    expect(p).toContain('tests/core');
    expect(p).toContain('*.test.ts');
  });

  it('L3 明确禁止运行目标程序（嵌入式关键约束）', () => {
    const p = buildGatePrompt({ ...base, tier: 'L3-build' });
    expect(p).toContain('L3 编译级');
    expect(p).toContain('不要尝试运行目标程序');
  });

  it('L4 要求给出人工验证清单', () => {
    const p = buildGatePrompt({ ...base, tier: 'L4-manual' });
    expect(p).toContain('人工验证清单');
  });

  it('attempt>1 加重语气', () => {
    const p = buildGatePrompt({ ...base, tier: 'L1-test', attempt: 2 });
    expect(p).toContain('第 2 次提醒');
  });

  it('携带上次失败摘要时给出修复指引', () => {
    const p = buildGatePrompt({
      ...base,
      tier: 'L1-test',
      lastSummary: {
        status: 'failed',
        passed: 3,
        failed: 1,
        firstFailures: [{ file: 'tests/core/a.test.ts', line: 12, name: 'case', cause: 'boom' }],
      },
    });
    expect(p).toContain('❌ 未通过');
    expect(p).toContain('tests/core/a.test.ts#L12');
  });

  it('交叉工具链追加执行不可行提示', () => {
    const p = buildGatePrompt({
      ...base,
      tier: 'L3-build',
      plan: { ...PLAN, crossToolchain: true },
    });
    expect(p).toContain('交叉编译工具链');
  });

  it('文件清单超上限时折叠为 “等 N 个”', () => {
    const files = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`);
    const p = buildGatePrompt({ ...base, tier: 'L1-test', editedFiles: files });
    expect(p).toContain('等 12 个');
  });
});

describe('buildFixPrompt / buildUnverifiedWarning', () => {
  it('修复指令禁止删测试作弊', () => {
    const p = buildFixPrompt(
      { status: 'failed', passed: 0, failed: 2, firstFailures: [] },
      'npx vitest run',
    );
    expect(p).toContain('不得删除/跳过测试');
    expect(p).toContain('npx vitest run');
  });

  it('五种未验证原因各有独立文案', () => {
    const reasons = ['fix-budget', 'turn-budget', 'no-test-run', 'manual-only', 'parse-error'] as const;
    const texts = reasons.map((r) => buildUnverifiedWarning(r));
    expect(new Set(texts).size).toBe(reasons.length);
    for (const t of texts) expect(t.startsWith('⚠️')).toBe(true);
  });
});

describe('isVerificationCommand', () => {
  it('命中计划命令（允许追加参数）', () => {
    expect(isVerificationCommand('npx vitest run tests/core/a.test.ts', PLAN)).toBe(true);
  });

  it('命中并容忍中间 flag（子序列匹配）', () => {
    expect(isVerificationCommand('npx vitest --reporter=dot run tests/a.test.ts', PLAN)).toBe(true);
  });

  it('命中类型检查命令', () => {
    expect(isVerificationCommand('npx tsc --noEmit -p tsconfig.json', PLAN)).toBe(true);
  });

  it('命中额外命令（影响分析组装出的命令）', () => {
    const plan: TestPlan = { ...PLAN, testCommand: '', typecheckCommand: undefined, buildCommand: undefined };
    expect(isVerificationCommand('pnpm run verify:all', plan, ['pnpm run verify:all'])).toBe(true);
  });

  it('通用兜底：模型自选等价命令也算验证', () => {
    const plan: TestPlan = { ...PLAN, framework: 'none', testCommand: '', typecheckCommand: undefined, buildCommand: undefined };
    expect(isVerificationCommand('python -m pytest tests/', plan)).toBe(true);
    expect(isVerificationCommand('go test ./...', plan)).toBe(true);
    expect(isVerificationCommand('npm run typecheck', plan)).toBe(true);
  });

  it('无关命令不放行（防口头验证）', () => {
    expect(isVerificationCommand('git status', PLAN)).toBe(false);
    expect(isVerificationCommand('ls -la', PLAN)).toBe(false);
    expect(isVerificationCommand('echo "tests passed"', PLAN)).toBe(false);
  });

  describe('回归：口头验证绕过（关键字仅出现在参数里）', () => {
    // 这批命令都含真实测试命令文本且 exit=0，若被当作验证信号
    // 则未验证的改动会被直接判为 Passed —— 门等于彻底失效。
    it.each([
      'echo "npx vitest run"',
      'printf "npm test\\n"',
      'cat scripts/run-tests.sh',
      'grep -rn "npx vitest run" docs/',
      'bash -lc \'echo "npx vitest run tests/a.test.ts"\'',
      'git commit -m "chore: npm test 全绿"',
      'git log --oneline | grep pytest',
      'sed -i "s/npm test/npm run test/" README.md',
    ])('%s 不算验证', (cmd) => {
      expect(isVerificationCommand(cmd, PLAN)).toBe(false);
    });
  });

  describe('真实执行仍需放行（修正后不得降低召回）', () => {
    it.each([
      'npx vitest run tests/a.test.ts 2>&1 | tail -20',
      'cd webview-ui && npx vitest run',
      'CI=1 npx vitest run',
      "bash -lc 'npx vitest run'",
      'echo "start" && npx vitest run',
      'npm test',
      'pnpm run type-check',
      'poetry run pytest tests/',
      'python3 -m pytest -q',
      'go test ./...',
      'cargo test --all',
      'ctest --output-on-failure',
      'make test',
    ])('%s 算验证', (cmd) => {
      expect(isVerificationCommand(cmd, PLAN)).toBe(true);
    });

    it('tsc 不带 --noEmit 是产物编译，不算类型检查', () => {
      const plan: TestPlan = { ...PLAN, testCommand: '', typecheckCommand: undefined, buildCommand: undefined };
      expect(isVerificationCommand('npx tsc -p tsconfig.json', plan)).toBe(false);
      expect(isVerificationCommand('npx tsc --noEmit', plan)).toBe(true);
    });
  });

  it('空命令不放行', () => {
    expect(isVerificationCommand('   ', PLAN)).toBe(false);
  });
});

describe('decideTier · 降级链', () => {
  it('有映射测试 → L1', () => {
    expect(decideTier(PLAN, true, true)).toBe('L1-test');
  });

  it('无映射测试但允许补测 → L2', () => {
    expect(decideTier(PLAN, false, true)).toBe('L2-new-test');
  });

  it('无映射测试且禁止补测 → L3（有构建命令）', () => {
    expect(decideTier(PLAN, false, false)).toBe('L3-build');
  });

  it('交叉工具链无视测试映射，直接 L3 编译级', () => {
    expect(decideTier({ ...PLAN, crossToolchain: true }, true, true)).toBe('L3-build');
  });

  it('交叉工具链且无构建命令 → L4', () => {
    const plan: TestPlan = { ...PLAN, crossToolchain: true, buildCommand: undefined };
    expect(decideTier(plan, true, true)).toBe('L4-manual');
  });

  it('无框架但有构建命令 → L3', () => {
    expect(decideTier({ ...PLAN, framework: 'none' }, false, true)).toBe('L3-build');
  });

  it('探测失败（plan=undefined）→ L4', () => {
    expect(decideTier(undefined, false, true)).toBe('L4-manual');
  });

  it('无框架且无任何命令 → L4', () => {
    const plan: TestPlan = {
      framework: 'none', testCommand: '', testDirGlobs: [],
      conventions: { testDir: 'tests', filePattern: '*.test.ts' },
    };
    expect(decideTier(plan, false, true)).toBe('L4-manual');
  });
});

describe('buildCompletionFallbackSummary · 兜底总结并入验证结果', () => {
  const PASSED = { status: 'passed' as const, passed: 12, failed: 0, firstFailures: [] };
  const FAILED = { status: 'failed' as const, passed: 9, failed: 3, firstFailures: [] };

  it('未跑过验证：保持原有纯完成口径（不含验证段）', () => {
    const s = buildCompletionFallbackSummary(4, undefined);
    expect(s).toBe('✅ 任务执行完成，共调用 4 个工具。');
    expect(s).not.toContain('验证结果');
  });

  it('parse-error（输出无法解析）不臆造验证结论', () => {
    const s = buildCompletionFallbackSummary(4, { status: 'parse-error', passed: 0, failed: 0, firstFailures: [] });
    expect(s).not.toContain('验证结果');
    expect(s.startsWith('✅')).toBe(true);
  });

  it('验证通过：✅ 完成 + ✅ PASSED 与计数', () => {
    const s = buildCompletionFallbackSummary(4, PASSED);
    expect(s).toContain('✅ 任务执行完成');
    expect(s).toContain('验证结果：✅ PASSED（12 passed / 0 failed）');
  });

  it('验证失败：不得出现 ✅ 与 ❌ 并存的自相矛盾（前缀降级为 ⚠️）', () => {
    const s = buildCompletionFallbackSummary(4, FAILED);
    expect(s.startsWith('⚠️')).toBe(true);
    expect(s).toContain('验证未通过');
    expect(s).toContain('验证结果：❌ FAILED（9 passed / 3 failed）');
    expect(s).not.toContain('✅');
  });
});

describe('normalizeVerificationConfig / 类型守卫', () => {
  it('undefined 回落默认', () => {
    expect(normalizeVerificationConfig(undefined)).toEqual(DEFAULT_VERIFICATION_CONFIG);
  });

  it('非法 gate 回落 soft', () => {
    expect(normalizeVerificationConfig({ gate: 'HARD' }).gate).toBe('soft');
  });

  it('合法值透传', () => {
    expect(normalizeVerificationConfig({
      gate: 'hard', maxFixRounds: 5, fullSuite: true, allowNewTests: false,
    })).toEqual({ gate: 'hard', maxFixRounds: 5, fullSuite: true, allowNewTests: false });
  });

  it('maxFixRounds 越界钳制到 [0,10]', () => {
    expect(normalizeVerificationConfig({ maxFixRounds: 999 }).maxFixRounds).toBe(10);
    expect(normalizeVerificationConfig({ maxFixRounds: -5 }).maxFixRounds).toBe(0);
  });

  it('maxFixRounds 非整数忽略', () => {
    expect(normalizeVerificationConfig({ maxFixRounds: 2.5 }).maxFixRounds)
      .toBe(DEFAULT_VERIFICATION_CONFIG.maxFixRounds);
  });

  it('布尔项类型不符则忽略', () => {
    expect(normalizeVerificationConfig({ fullSuite: 'yes' }).fullSuite).toBe(false);
  });

  it('状态与档位守卫', () => {
    expect(isVerificationState('Exceeded')).toBe(true);
    expect(isVerificationState('Done')).toBe(false);
    expect(isGateMode('hard')).toBe(true);
    expect(isGateMode(1)).toBe(false);
  });
});
