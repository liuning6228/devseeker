/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * CVW（Change Verification Workflow）核心类型
 *
 * 来源：docs/verification-workflow-optimization-plan.md §3.2 / §4.1 / §4.5
 *
 * 设计哲学：确定性下沉、判断上浮 ——
 * 状态机流转、框架探测、测试集计算、输出解析属"确定性"，全部由代码维护；
 * 修什么/怎么修/是否补测属"判断性"，留给 LLM。
 *
 * 注意：
 * - 验证状态由 TaskLoop 在程序侧内存维护，LLM 不可篡改（与 Qoder"靠自觉"的本质区别）
 * - 本文件只放类型与纯判定函数，不引入 vscode / node:fs 依赖，便于单测
 */

/**
 * 任务级验证状态机（§3.2）
 *
 * ```
 * NotEdited ──编辑成功──▶ Edited ──收尾拦截──▶ Verifying ──┬─▶ Passed ──再次编辑──▶ Edited
 *                                                        └─▶ Failed ──修复──▶ Verifying
 *                                                                  └─超预算─▶ Exceeded
 * ```
 */
export type VerificationState =
  /** 本任务未发生编辑 —— 正常结束，零额外开销 */
  | 'NotEdited'
  /** 已编辑但未验证 —— 收尾时会被验证门拦截 */
  | 'Edited'
  /** 验证进行中（soft: 已注入指令等待模型执行；hard: 子代理执行中） */
  | 'Verifying'
  /** 验证通过 —— 放行收尾 */
  | 'Passed'
  /** 验证失败 —— 进入修复循环 */
  | 'Failed'
  /** 修复预算超限 —— 放行但强制标注"验证未通过" */
  | 'Exceeded';

/** 验证门档位 */
export type VerificationGateMode = 'off' | 'soft' | 'hard';

/** 支持的测试框架 */
export type TestFramework =
  | 'vitest'
  | 'jest'
  | 'mocha'
  | 'pytest'
  | 'go'
  | 'cargo'
  | 'ctest'
  | 'make'
  | 'none';

/**
 * 新建测试时遵循的项目约定（从现有测试文件采样）
 */
export interface TestConventions {
  /** 测试目录，如 "tests/core" */
  testDir: string;
  /** 文件名模式，如 "*.test.ts" */
  filePattern: string;
  /** 从最近的现有测试文件头部提取的 import 风格样例 */
  importStyle?: string;
}

/**
 * 探测器产出的结构化测试执行计划（§4.1）
 *
 * 每个 TaskLoop 生命周期探测一次并缓存 —— 替代 VERIFY_PROMPT 第 1 步
 * 「模型自己 list_dir + read_file 探测」，节省 2-4 个 LLM 轮次。
 */
export interface TestPlan {
  framework: TestFramework;
  /** 测试命令，如 "npx vitest run"；framework='none' 时为空串 */
  testCommand: string;
  /** 类型检查命令，如 "npx tsc --noEmit" */
  typecheckCommand?: string;
  /** 构建命令，如 "npm run build" */
  buildCommand?: string;
  /** 交叉工具链标记（嵌入式场景）→ 触发降级链 L3 编译级 */
  crossToolchain?: boolean;
  /** 测试文件 glob，如 ["tests/**", "src/**\/*.test.ts"] */
  testDirGlobs: string[];
  conventions: TestConventions;
}

/** 单个失败用例的定位信息 */
export interface TestFailureRef {
  file: string;
  line?: number;
  name: string;
  cause: string;
}

/**
 * 测试输出解析结果（§4.5）
 *
 * 把无界的测试 stdout 压缩为 <1KB 结构化摘要。
 */
export interface TestRunSummary {
  status: 'passed' | 'failed' | 'parse-error';
  passed: number;
  failed: number;
  skipped?: number;
  /** 前 3 个失败用例 */
  firstFailures: TestFailureRef[];
  /** 解析所依据的框架（便于调试） */
  framework?: TestFramework;
}

/** 验证门决策 */
export type GateAction =
  /** 放行收尾 */
  | 'allow'
  /** soft：注入验证指令，退回模型执行 */
  | 'soft-prompt'
  /** hard：程序化派发 Verify 子代理 */
  | 'hard-verify';

export interface GateDecision {
  action: GateAction;
  /** 决策原因（日志 / 单测断言用） */
  reason: string;
  /**
   * 放行时的警示语（附加到最终输出）。
   * 仅在"未验证放行"（预算超限 / 轮次耗尽）时存在。
   */
  warning?: string;
}

/** 验证配置（对应 devSeeker.verification.* 设置项，§4.7） */
export interface VerificationConfig {
  gate: VerificationGateMode;
  /** 修复循环预算 */
  maxFixRounds: number;
  /** 受影响集全绿后是否补跑全量 */
  fullSuite: boolean;
  /** 是否允许新建测试（L2 补测级开关） */
  allowNewTests: boolean;
}

export const DEFAULT_VERIFICATION_CONFIG: VerificationConfig = {
  gate: 'soft',
  maxFixRounds: 3,
  fullSuite: false,
  allowNewTests: true,
};

/** soft 门重复提示上限 —— 超过即放行并标注未验证（§4.3 C.2） */
export const MAX_SOFT_PROMPTS = 2;

/**
 * 降级链级别（§4.6）
 *
 * L0 诊断级 → L1 测试级 → L2 补测级 → L3 编译级 → L4 人工清单
 */
export type VerificationTier = 'L0-diagnostic' | 'L1-test' | 'L2-new-test' | 'L3-build' | 'L4-manual';

/**
 * 依据 TestPlan 与受影响测试集判定降级级别（§4.6）。
 *
 * @param plan 测试计划；undefined 视为探测失败 → L4
 * @param hasTargetTests 是否存在映射到的现有测试
 * @param allowNewTests 是否允许新建测试
 */
export function decideTier(
  plan: TestPlan | undefined,
  hasTargetTests: boolean,
  allowNewTests: boolean,
): VerificationTier {
  if (!plan || plan.framework === 'none') {
    // 无测试框架：能编译则编译级，否则人工清单
    return plan?.buildCommand ? 'L3-build' : 'L4-manual';
  }
  // 交叉工具链（嵌入式）：不尝试运行测试，只验证编译
  if (plan.crossToolchain) {
    return plan.buildCommand ? 'L3-build' : 'L4-manual';
  }
  if (hasTargetTests) return 'L1-test';
  if (allowNewTests) return 'L2-new-test';
  // 不允许新建测试且无映射测试 → 退回编译/类型检查
  return plan.buildCommand || plan.typecheckCommand ? 'L3-build' : 'L4-manual';
}

/** 类型守卫：是否为合法验证状态 */
export function isVerificationState(v: unknown): v is VerificationState {
  return (
    v === 'NotEdited' ||
    v === 'Edited' ||
    v === 'Verifying' ||
    v === 'Passed' ||
    v === 'Failed' ||
    v === 'Exceeded'
  );
}

/** 类型守卫：是否为合法门档位 */
export function isGateMode(v: unknown): v is VerificationGateMode {
  return v === 'off' || v === 'soft' || v === 'hard';
}

/**
 * 归一化外部（VS Code 设置）传入的验证配置，非法值回落默认。
 */
export function normalizeVerificationConfig(
  raw: Partial<Record<keyof VerificationConfig, unknown>> | undefined,
): VerificationConfig {
  const base = { ...DEFAULT_VERIFICATION_CONFIG };
  if (!raw) return base;
  if (isGateMode(raw.gate)) base.gate = raw.gate;
  if (typeof raw.maxFixRounds === 'number' && Number.isInteger(raw.maxFixRounds)) {
    base.maxFixRounds = Math.min(10, Math.max(0, raw.maxFixRounds));
  }
  if (typeof raw.fullSuite === 'boolean') base.fullSuite = raw.fullSuite;
  if (typeof raw.allowNewTests === 'boolean') base.allowNewTests = raw.allowNewTests;
  return base;
}
