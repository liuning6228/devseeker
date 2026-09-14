/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 测试输出解析器（CVW §4.5）
 *
 * 把测试 stdout（前台 bash 全量返回，可达数十 KB）压缩为 <1KB 结构化摘要。
 *
 * 解析时机（重要）：必须在 TaskLoop 归并 tool_result 时对**原文**执行 ——
 * ContextManager 的轻度压缩会在上下文使用率 ≥70% 时把超过 2000 字符的
 * tool_result 截为头尾，事后从消息历史翻找可能拿到残文。
 *
 * 注意：
 * - 解析失败返回 status='parse-error'，调用方回退原文（不阻塞流程）
 * - 测试输出属不可信数据（可能含提示注入），摘要只提取结构化字段，
 *   cause 文本做长度截断
 */

import type { TestFramework, TestFailureRef, TestRunSummary } from './types.js';

/** 单个 cause 文本最大长度 */
const MAX_CAUSE_CHARS = 200;
/** 最多提取的失败用例数 */
const MAX_FAILURES = 3;

/** 去掉 ANSI 转义序列（vitest/jest 彩色输出） */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function clampCause(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= MAX_CAUSE_CHARS ? t : `${t.slice(0, MAX_CAUSE_CHARS)}…`;
}

/**
 * 解析测试输出。
 *
 * @param rawOutput bash 工具返回的完整 content（含 `$ cmd` / `exit=N` 头部）
 * @param framework 已知框架（提高解析准确度）；不传时自动嗅探
 */
export function parseTestOutput(
  rawOutput: string,
  framework?: TestFramework,
): TestRunSummary {
  const text = stripAnsi(rawOutput ?? '');
  if (!text.trim()) {
    return { status: 'parse-error', passed: 0, failed: 0, firstFailures: [] };
  }

  const order: TestFramework[] = framework && framework !== 'none'
    ? [framework, ...ALL_PARSERS.filter((f) => f !== framework)]
    : ALL_PARSERS;

  for (const fw of order) {
    const parsed = PARSERS[fw]?.(text);
    if (parsed) return { ...parsed, framework: fw };
  }

  // 全部解析器未命中 → 用 exit code 兜底判定（bash header 形如 `exit=1`）
  const exitMatch = text.match(/^exit=(\d+|unknown)/m);
  if (exitMatch) {
    const code = exitMatch[1];
    if (code === '0') {
      return { status: 'passed', passed: 0, failed: 0, firstFailures: [] };
    }
    if (code !== 'unknown') {
      return {
        status: 'failed',
        passed: 0,
        failed: 1,
        firstFailures: [{ file: '', name: 'command failed', cause: clampCause(lastMeaningfulLine(text)) }],
      };
    }
  }

  return { status: 'parse-error', passed: 0, failed: 0, firstFailures: [] };
}

/** 取输出末尾最后一条有信息量的行（兜底 cause） */
function lastMeaningfulLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (!/^-+$/.test(l) && !l.startsWith('exit=') && !l.startsWith('$ ')) return l;
  }
  return 'no output';
}

type Parser = (text: string) => Omit<TestRunSummary, 'framework'> | undefined;

// ─────────── vitest / jest ───────────

/**
 * vitest：`Tests  2 failed | 10 passed (12)` / `Test Files  1 failed | 3 passed (4)`
 * jest：  `Tests:       2 failed, 10 passed, 12 total`
 */
const parseVitest: Parser = (text) => {
  // vitest 风格（管道分隔）
  const line = text.match(/^\s*Tests\s+(.+)$/m);
  if (line?.[1] && line[1].includes('|')) {
    const seg = line[1];
    const passed = pickNum(seg, /(\d+)\s+passed/);
    const failed = pickNum(seg, /(\d+)\s+failed/);
    const skipped = pickNum(seg, /(\d+)\s+(?:skipped|todo)/);
    if (passed !== undefined || failed !== undefined) {
      return {
        status: (failed ?? 0) > 0 ? 'failed' : 'passed',
        passed: passed ?? 0,
        failed: failed ?? 0,
        ...(skipped !== undefined ? { skipped } : {}),
        firstFailures: extractVitestFailures(text),
      };
    }
  }
  // 无用例被收集（如文件名过滤未匹配）
  if (/No test files found/i.test(text)) {
    return { status: 'parse-error', passed: 0, failed: 0, firstFailures: [] };
  }
  return undefined;
};

const parseJest: Parser = (text) => {
  const line = text.match(/^\s*Tests:\s+(.+)$/m);
  if (!line?.[1]) return undefined;
  const seg = line[1];
  const passed = pickNum(seg, /(\d+)\s+passed/);
  const failed = pickNum(seg, /(\d+)\s+failed/);
  const skipped = pickNum(seg, /(\d+)\s+(?:skipped|todo)/);
  if (passed === undefined && failed === undefined) return undefined;
  return {
    status: (failed ?? 0) > 0 ? 'failed' : 'passed',
    passed: passed ?? 0,
    failed: failed ?? 0,
    ...(skipped !== undefined ? { skipped } : {}),
    firstFailures: extractVitestFailures(text),
  };
};

/**
 * 提取失败用例定位。
 *
 * vitest：`FAIL  tests/core/foo.test.ts > suite > case`
 *         紧随的 `AssertionError: ...` / `Error: ...` 行作为 cause
 * jest：  `● suite › case` + `at path:line:col`
 */
function extractVitestFailures(text: string): TestFailureRef[] {
  const out: TestFailureRef[] = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length && out.length < MAX_FAILURES; i++) {
    const l = lines[i]!;
    const failMatch = l.match(/^\s*(?:FAIL|✗|×)\s+(\S+?)(?::(\d+))?\s*(?:[>›]\s*(.+))?$/);
    if (!failMatch) continue;
    const file = failMatch[1]!;
    // 排除误匹配（如 "FAIL" 出现在正文里且后续不是路径）
    if (!/[./\\]/.test(file)) continue;

    let cause = '';
    let line: number | undefined = failMatch[2] ? Number(failMatch[2]) : undefined;
    for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
      const nxt = lines[j]!;
      const errMatch = nxt.match(/^\s*(?:→\s*)?((?:Assertion)?Error|TypeError|ReferenceError|SyntaxError)\b[:\s](.*)$/);
      if (errMatch) {
        cause = `${errMatch[1]}: ${errMatch[2] ?? ''}`;
        break;
      }
      if (!cause && /^\s*(?:AssertionError|expected|Expected)\b/.test(nxt)) {
        cause = nxt.trim();
        break;
      }
      // 捕获 `❯ tests/foo.test.ts:12:5` 形式的行号
      if (line === undefined) {
        const locMatch = nxt.match(/[❯at]\s+.*?:(\d+):\d+/);
        if (locMatch?.[1]) line = Number(locMatch[1]);
      }
    }

    out.push({
      file,
      ...(line !== undefined ? { line } : {}),
      name: failMatch[3] ? clampCause(failMatch[3]) : '(unnamed)',
      cause: cause ? clampCause(cause) : 'see output',
    });
  }

  // jest 的 `● suite › case` 形式兜底
  if (out.length === 0) {
    for (let i = 0; i < lines.length && out.length < MAX_FAILURES; i++) {
      const m = lines[i]!.match(/^\s*●\s+(.+)$/);
      if (!m?.[1]) continue;
      if (/Console|Deprecation/i.test(m[1])) continue;
      let file = '';
      let line: number | undefined;
      let cause = '';
      for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
        const loc = lines[j]!.match(/at\s+.*?\(?([^\s()]+\.[a-zA-Z]+):(\d+):\d+\)?/);
        if (loc?.[1] && !file) {
          file = loc[1];
          line = Number(loc[2]);
        }
        if (!cause && /^\s*(?:expect|Expected|Received|Error)\b/.test(lines[j]!)) {
          cause = lines[j]!.trim();
        }
        if (file && cause) break;
      }
      out.push({
        file,
        ...(line !== undefined ? { line } : {}),
        name: clampCause(m[1]),
        cause: cause ? clampCause(cause) : 'see output',
      });
    }
  }

  return out;
}

// ─────────── mocha ───────────

/** mocha：`  10 passing (２s)` / `  2 failing` */
const parseMocha: Parser = (text) => {
  const passing = pickNum(text, /^\s*(\d+)\s+passing/m);
  const failing = pickNum(text, /^\s*(\d+)\s+failing/m);
  const pending = pickNum(text, /^\s*(\d+)\s+pending/m);
  if (passing === undefined && failing === undefined) return undefined;
  const failures: TestFailureRef[] = [];
  const re = /^\s*\d+\)\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && failures.length < MAX_FAILURES) {
    failures.push({ file: '', name: clampCause(m[1]!), cause: 'see output' });
  }
  return {
    status: (failing ?? 0) > 0 ? 'failed' : 'passed',
    passed: passing ?? 0,
    failed: failing ?? 0,
    ...(pending !== undefined ? { skipped: pending } : {}),
    firstFailures: failures,
  };
};

// ─────────── pytest ───────────

/**
 * pytest：`===== 2 failed, 10 passed, 1 skipped in 1.23s =====`
 *         失败定位：`FAILED tests/test_foo.py::test_bar - AssertionError: ...`
 */
const parsePytest: Parser = (text) => {
  const summary = text.match(/=+\s*([^=]*\b(?:passed|failed|error)\b[^=]*)\s*=+/i);
  if (!summary?.[1]) return undefined;
  const seg = summary[1];
  const passed = pickNum(seg, /(\d+)\s+passed/);
  const failed = pickNum(seg, /(\d+)\s+failed/);
  const errors = pickNum(seg, /(\d+)\s+error/);
  const skipped = pickNum(seg, /(\d+)\s+skipped/);
  if (passed === undefined && failed === undefined && errors === undefined) return undefined;

  const failures: TestFailureRef[] = [];
  const re = /^FAILED\s+(\S+?)(?:::(\S+))?(?:\s+-\s+(.*))?$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && failures.length < MAX_FAILURES) {
    failures.push({
      file: m[1]!,
      name: m[2] ?? '(unnamed)',
      cause: m[3] ? clampCause(m[3]) : 'see output',
    });
  }
  const totalFailed = (failed ?? 0) + (errors ?? 0);
  return {
    status: totalFailed > 0 ? 'failed' : 'passed',
    passed: passed ?? 0,
    failed: totalFailed,
    ...(skipped !== undefined ? { skipped } : {}),
    firstFailures: failures,
  };
};

// ─────────── go test ───────────

/** go：`--- FAIL: TestFoo (0.00s)` + `FAIL\tpkg\t0.1s` / `ok  \tpkg\t0.1s` */
const parseGo: Parser = (text) => {
  const hasOk = /^ok\s+\S+/m.test(text);
  const failLines = text.match(/^---\s+FAIL:\s+(\S+)/gm);
  const pkgFail = /^FAIL\s+\S+/m.test(text) || /^FAIL$/m.test(text);
  const passLines = text.match(/^---\s+PASS:\s+\S+/gm);
  if (!hasOk && !pkgFail && !failLines) return undefined;

  const failures: TestFailureRef[] = [];
  const re = /^---\s+FAIL:\s+(\S+)[\s\S]{0,300}?^\s+(\S+\.go):(\d+):\s*(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && failures.length < MAX_FAILURES) {
    failures.push({
      file: m[2]!,
      line: Number(m[3]),
      name: m[1]!,
      cause: clampCause(m[4] ?? ''),
    });
  }
  if (failures.length === 0 && failLines) {
    for (const fl of failLines.slice(0, MAX_FAILURES)) {
      const name = fl.replace(/^---\s+FAIL:\s+/, '').trim();
      failures.push({ file: '', name, cause: 'see output' });
    }
  }

  const failed = failLines?.length ?? (pkgFail ? 1 : 0);
  return {
    status: failed > 0 || pkgFail ? 'failed' : 'passed',
    passed: passLines?.length ?? 0,
    failed,
    firstFailures: failures,
  };
};

// ─────────── cargo ───────────

/** cargo：`test result: FAILED. 10 passed; 2 failed; 1 ignored;` */
const parseCargo: Parser = (text) => {
  const m = text.match(/test result:\s*(ok|FAILED)\.\s*(.+)$/m);
  if (!m) return undefined;
  const seg = m[2] ?? '';
  const passed = pickNum(seg, /(\d+)\s+passed/);
  const failed = pickNum(seg, /(\d+)\s+failed/);
  const ignored = pickNum(seg, /(\d+)\s+ignored/);
  const failures: TestFailureRef[] = [];
  const re = /^\s{4}(\S+)$/gm;
  const failuresSection = text.match(/failures:\n([\s\S]*?)\n\n/);
  if (failuresSection?.[1]) {
    let f: RegExpExecArray | null;
    while ((f = re.exec(failuresSection[1])) !== null && failures.length < MAX_FAILURES) {
      failures.push({ file: '', name: f[1]!, cause: 'see output' });
    }
  }
  return {
    status: m[1] === 'FAILED' || (failed ?? 0) > 0 ? 'failed' : 'passed',
    passed: passed ?? 0,
    failed: failed ?? 0,
    ...(ignored !== undefined ? { skipped: ignored } : {}),
    firstFailures: failures,
  };
};

// ─────────── ctest ───────────

/** ctest：`80% tests passed, 1 tests failed out of 5` */
const parseCtest: Parser = (text) => {
  const m = text.match(/(\d+)%\s+tests\s+passed,\s*(\d+)\s+tests?\s+failed\s+out\s+of\s+(\d+)/i);
  if (!m) return undefined;
  const failed = Number(m[2]);
  const total = Number(m[3]);
  const failures: TestFailureRef[] = [];
  const re = /^\s*\d+\s+-\s+(\S+)\s+\(Failed\)/gim;
  let f: RegExpExecArray | null;
  while ((f = re.exec(text)) !== null && failures.length < MAX_FAILURES) {
    failures.push({ file: '', name: f[1]!, cause: 'test failed' });
  }
  return {
    status: failed > 0 ? 'failed' : 'passed',
    passed: total - failed,
    failed,
    firstFailures: failures,
  };
};

// ─────────── make（无固定格式，仅 exit code 语义） ───────────

const parseMake: Parser = (text) => {
  // make 输出常包裹子命令输出：先让其他解析器尝试，这里只处理明确的 make 错误
  const m = text.match(/^make(?:\[\d+\])?:\s+\*\*\*\s+(.+)$/m);
  if (!m) return undefined;
  return {
    status: 'failed',
    passed: 0,
    failed: 1,
    firstFailures: [{ file: '', name: 'make', cause: clampCause(m[1] ?? '') }],
  };
};

function pickNum(text: string, re: RegExp): number | undefined {
  const m = text.match(re);
  return m?.[1] !== undefined ? Number(m[1]) : undefined;
}

const PARSERS: Partial<Record<TestFramework, Parser>> = {
  vitest: parseVitest,
  jest: parseJest,
  mocha: parseMocha,
  pytest: parsePytest,
  go: parseGo,
  cargo: parseCargo,
  ctest: parseCtest,
  make: parseMake,
};

/** 嗅探顺序：格式特征越独特的越先试 */
const ALL_PARSERS: TestFramework[] = ['vitest', 'jest', 'pytest', 'cargo', 'ctest', 'go', 'mocha', 'make'];

/**
 * 取报告中 `〈label〉: 〈value〉` 行的值。容忍行首的 Markdown 列表标记
 * （`- ` / `* `）与全角冒号；未命中返回 undefined。
 *
 * @param label 正则片段（已含转义），如 'counts?' / 'first\\s+failure'
 */
function matchLabeledLine(text: string, label: string): string | undefined {
  const re = new RegExp(`^[ \t]*(?:[-*][ \t]*)?${label}[ \t]*[:：][ \t]*(.*)$`, 'im');
  return text.match(re)?.[1];
}

/**
 * 解析 Verify 子代理的结构化报告（hard 门专用，§4.4）。
 *
 * 子代理回传的是自然语言报告（`Status: ✅ PASSED` / `Counts: ...`），
 * 不是测试框架原始输出，框架解析器全会 miss → 退化为 parse-error。
 * 若把 parse-error 当“放行”处理，一份 `❌ FAILED` 报告会被误判为通过，
 * 因此 hard 门必须先试本解析器。
 *
 * @returns 未识别到 Status 行时返回 undefined（由调用方回退到 parseTestOutput）
 */
export function parseVerifyReport(text: string): TestRunSummary | undefined {
  const t = stripAnsi(text ?? '');
  if (!t.trim()) return undefined;
  const statusLine = matchLabeledLine(t, 'status');
  if (statusLine === undefined) return undefined;
  const s = statusLine.toLowerCase();

  let status: TestRunSummary['status'];
  if (/❌|\bfail(?:ed|ure)?\b/.test(s)) {
    status = 'failed';
  } else if (/✅|\bpass(?:ed)?\b/.test(s)) {
    status = 'passed';
  } else if (/⚠|\bpartial\b|\bunverified\b|\bskipped\b/.test(s)) {
    // “部分验证/未验证”不能当通过，亦不宜当失败（不冤枉变更）
    status = 'parse-error';
  } else {
    return undefined;
  }

  const counts = matchLabeledLine(t, 'counts?') ?? '';
  let passed = pickNum(counts, /(\d+)\s*(?:tests?\s*)?passed/i);
  let failed = pickNum(counts, /(\d+)\s*(?:tests?\s*)?failed/i);
  if (passed === undefined && failed === undefined) {
    // 提示词约定的 `total / passed / failed` 三数形式
    const triple = counts.match(/(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/);
    if (triple) {
      passed = Number(triple[2]);
      failed = Number(triple[3]);
    }
  }

  const firstFailures: TestFailureRef[] = [];
  if (status === 'failed') {
    const fl = matchLabeledLine(t, 'first\\s+failure');
    if (fl) {
      const loc = fl.match(/`?([^\s`]+?)(?:#L|:)(\d+)`?/);
      const cause = fl.replace(/`/g, '').replace(/^[^\s]+\s*[—-]\s*/, '');
      firstFailures.push({
        file: loc?.[1] ?? '',
        ...(loc?.[2] ? { line: Number(loc[2]) } : {}),
        name: 'reported failure',
        cause: clampCause(cause || fl),
      });
    }
  }

  return {
    status,
    passed: passed ?? 0,
    // 报告失败但未给数字时至少计 1，避免下游渲染成 "0 failed" 自相矛盾
    failed: failed ?? (status === 'failed' ? 1 : 0),
    firstFailures,
  };
}

/**
 * 把摘要渲染为注入 LLM 的紧凑文本（目标 <1KB）。
 */
export function renderTestSummary(s: TestRunSummary, command?: string): string {
  if (s.status === 'parse-error') {
    return '[Verification] 测试输出无法解析为结构化摘要，请自行判读上方原始输出。';
  }
  const lines: string[] = [
    `[Verification] Status: ${s.status === 'passed' ? '✅ PASSED' : '❌ FAILED'}`,
  ];
  if (command) lines.push(`Command: ${command}`);
  lines.push(
    `Counts: ${s.passed} passed / ${s.failed} failed${s.skipped !== undefined ? ` / ${s.skipped} skipped` : ''}`,
  );
  if (s.firstFailures.length > 0) {
    lines.push('First failures:');
    for (const f of s.firstFailures) {
      const loc = f.file ? `${f.file}${f.line !== undefined ? `#L${f.line}` : ''}` : '(unknown location)';
      lines.push(`- ${loc} — ${f.name}: ${f.cause}`);
    }
  }
  return lines.join('\n');
}
