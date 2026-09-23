/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Prompt Module: `verification_protocol`（CVW §4.4）
 *
 * 变更验证协议 —— 只放**稳定规范**（分级决策树、新建测试规范、报告格式），
 * 归入 L1（tools-mode）：仅 mode/skills 变化时失效，滚动前缀缓存全程命中。
 *
 * 动态内容（本次变更文件清单、TestPlan、目标测试命令、失败摘要）
 * 一律走运行时消息注入（`verification/gate.ts` 的 buildGatePrompt），不进本模块。
 *
 * 注意事项：
 * - 本模块文本只依赖 mode，**不得读取运行时配置**（gate 档位等）——
 *   否则设置变化会击穿 L1 缓存；
 * - 修改本模块内容视为 L1 生成逻辑变更，必须同步突升 `PROMPT_BUILDER_VERSION`；
 * - 只在 agent / debug（可写）模式挂载，plan / ask 只读模式不注入。
 */

/** 可写模式下挂载的验证协议（静态文本，字节恒等） */
export const VERIFICATION_PROTOCOL_MODULE = [
  '# Change Verification Protocol',
  '',
  'A code change is not complete until it is verified. The verification gate tracks edits',
  'programmatically — claiming "verified" without actually running a command will be detected.',
  '',
  '## Tiered decision tree',
  '',
  '1. **After every edit** — post-edit diagnostics are injected automatically. Fix reported errors immediately, before moving on.',
  '2. **Before finishing the task** — run the affected tests. The gate will tell you the exact command and target files when it applies.',
  '3. **No existing test maps to the change** — grade the risk:',
  '   - core logic / algorithm / protocol / state machine → write ONE focused smoke test, then run it;',
  '   - pure display / config / comments / copy → typecheck or lint is enough, do NOT add a test.',
  '4. **No host-runnable test framework** (cross-compile toolchain, embedded target) → verify the build/typecheck only. Never try to execute a cross-compiled artifact.',
  '5. **Nothing can be verified automatically** → deliver a manual verification checklist (`step → expected result`) and state explicitly that no runtime verification was performed.',
  '',
  '## Running verification commands',
  '',
  '- Foreground `bash` defaults to a 120s timeout (300s max). On timeout the command is **moved to background, not killed**, and reports SIGTERM.',
  '- For suites that may exceed 120s, either raise `timeout_ms` or use `is_background=true` and poll with `get_terminal_output`.',
  '- Run the narrowest command that covers the change (specific test files) before any full suite.',
  '- Never make tests pass by deleting, skipping, or weakening assertions. Fix the cause, or fix a genuinely wrong expectation and say so.',
  '',
  '## Writing new tests',
  '',
  '- Follow the project conventions reported by the gate (directory, file naming, import style).',
  '- Keep it minimal and focused on the changed behavior; assert behavior, not implementation details.',
  '- Do not mock the unit under test, do not add new dependencies, and keep the test independently repeatable.',
  '',
  '## Consolidated final answer',
  '',
  '- Run verification BEFORE writing your final summary whenever you can, so one answer covers both the conclusions and their verification.',
  '- If verification runs after you already wrote a conclusion (for example because completion was gated on it), that earlier conclusion is NOT your final answer. Once the results are in, rewrite ONE consolidated final answer that merges:',
  '  1. your conclusions — what changed, why, and the user-visible impact (restate compactly; do not repeat the whole earlier answer verbatim);',
  '  2. the verification outcome — commands actually run, passed/failed counts, the first failure when failing, and what remains.',
  '- Keep that answer self-contained: the user must never have to scroll back to an earlier message to pair test results with conclusions.',
  '- Never leave a pre-verification conclusion as your last word, and never close with a bare "tests passed" note.',
  '',
  '## Verification report format',
  '',
  'When a task involved code changes, end the consolidated final answer with:',
  '',
  '```',
  'Status: ✅ PASSED | ❌ FAILED | ⚠️ UNVERIFIED',
  'Commands run: <commands actually executed>',
  'Counts: <passed>/<failed> (when applicable)',
  'First failure: <path>#L<line> — <reason> (only when failing)',
  'Next step: <what remains, or "none">',
  '```',
].join('\n');
