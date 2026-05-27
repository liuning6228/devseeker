/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 写前安全扫描（Phase 5 Phase B Step 6）
 *
 * 10 种威胁正则 + 7 种不可见 Unicode。
 * 作为 `BuiltinMemoryProvider.handleToolCall` 的预处理步骤。
 * L0 快照构建时二次调用。
 *
 * DESIGN-1.md §4.3 · ROADMAP.md 方案三 Phase B Step 6
 */

/** 10 种威胁模式 */
const THREAT_PATTERNS: [RegExp, string][] = [
  [/ignore\s+(all\s+)?(previous|above|prior)\s+instructions/i, '指令忽略'],
  [/you\s+are\s+now\s+/i, '角色劫持'],
  [/do\s+not\s+tell\s+the\s+user/i, '信息隐藏'],
  [/system\s+prompt\s+override/i, '系统提示覆盖'],
  [/disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, '指令无视'],
  [/curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, '凭证泄露'],
  [/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)/i, '敏感文件读取'],
  [/authorized_keys/i, '密钥注入'],
  [/eval\s*\(.*\)/i, '动态执行'],
  [/process\.env/i, '环境变量泄露'],
];

/** 7 种不可见 Unicode 字符 */
const INVISIBLE_UNICODE = new Set([
  '\u200b', // ZERO WIDTH SPACE
  '\u200c', // ZERO WIDTH NON-JOINER
  '\u200d', // ZERO WIDTH JOINER
  '\u2060', // WORD JOINER
  '\ufeff', // ZERO WIDTH NO-BREAK SPACE (BOM)
  '\u202a', // LEFT-TO-RIGHT EMBEDDING
  '\u202b', // RIGHT-TO-LEFT EMBEDDING
  '\u202c', // POP DIRECTIONAL FORMATTING
  '\u202d', // LEFT-TO-RIGHT OVERRIDE
  '\u202e', // RIGHT-TO-LEFT OVERRIDE
]);

/**
 * 扫描记忆内容，返回拒绝原因或 null（安全）。
 * 扫描日志打到独立文件（调用方负责）。
 */
export function scanMemoryContent(content: string): string | null {
  if (!content || typeof content !== 'string') return null;

  // 检查不可见 Unicode
  for (const char of content) {
    if (INVISIBLE_UNICODE.has(char)) {
      const codePoint = char.codePointAt(0)!;
      return `Blocked: 不可见 Unicode U+${codePoint.toString(16)}`;
    }
  }

  // 检查威胁模式
  for (const [pattern, name] of THREAT_PATTERNS) {
    if (pattern.test(content)) {
      return `Blocked: ${name}`;
    }
  }

  return null;
}
