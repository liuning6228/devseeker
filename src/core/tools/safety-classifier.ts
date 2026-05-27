/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Command Safety Classifier（DESIGN §M9.6.1 + §M9.5）
 *
 * 将命令字符串归为三级：
 * - `blacklisted` —— 硬拒绝（rm -rf、mkfs、sudo、curl|bash 等）
 * - `risky`       —— 需批准（git reset / git push --force / docker push / chmod / npm publish）
 * - `safe`        —— 默认 auto（ls / cat / git status / npm test / ...）
 *
 * 用途：
 * - `bash` 工具执行前调 `classifyCommand(cmd)` → blacklisted 立即拒绝
 * - `TerminalPool.classify(cmd)` 委托此函数
 * - approval-policy 根据结果 + ToolSafetyLevel 决定是否弹窗（UI 批准 W7.11 落地）
 *
 * 设计要点：
 * - 正则匹配不区分大小写；命令前后有空白或分号 / && / | 边界时才匹配
 * - 黑名单优先（比 risky 严格）
 * - 规则集中在此文件；bash.ts 的 DANGEROUS_PATTERNS 保留用于向后兼容，
 *   但实际行为以本文件为准（通过委托函数对外暴露）
 */

export type CommandSafety = 'safe' | 'risky' | 'blacklisted';

interface Rule {
  pattern: RegExp;
  reason: string;
}

/** 硬拒绝：即使用户批准也不允许执行 */
export const BLACKLIST_RULES: readonly Rule[] = [
  // 递归删除
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f?|-[a-zA-Z]*f[a-zA-Z]*r)/i, reason: 'rm -r/-rf' },
  { pattern: /\brimraf\b/i, reason: 'rimraf' },
  { pattern: /\brmdir\s+\/s/i, reason: 'rmdir /s' },
  { pattern: /\bremove-item\b[^|;&]*\s-(recurse|force)/i, reason: 'Remove-Item -Recurse/-Force' },
  { pattern: /\bdel\s+\/s\b/i, reason: 'del /s' },
  // 磁盘破坏
  { pattern: /\b(mkfs|format)\b/i, reason: 'mkfs/format' },
  { pattern: /\bdd\s+if=/i, reason: 'dd' },
  // 系统控制
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: 'shutdown/reboot' },
  // 提权
  { pattern: /\bsudo\b/i, reason: 'sudo' },
  // 下载后管道执行
  {
    pattern:
      /\b(curl|wget|iwr|invoke-webrequest)\b[^|;&]*\|[^|;&]*\b(bash|sh|pwsh|powershell|cmd)\b/i,
    reason: 'curl|bash 远程脚本',
  },
  // 写磁盘根（粗粒度）
  { pattern: /\b(>|>>)\s*\/(\*|\s)/, reason: '写磁盘根' },
];

/** 需批准：高风险但存在合法场景（批准后可执行） */
export const RISKY_RULES: readonly Rule[] = [
  // Git 写远端 / 历史重写
  { pattern: /\bgit\s+push\b[^|;&]*--force\b/i, reason: 'git push --force' },
  { pattern: /\bgit\s+push\b[^|;&]*\s-f(\s|$)/i, reason: 'git push -f' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: 'git reset --hard' },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/i, reason: 'git clean -f' },
  { pattern: /\bgit\s+filter-branch\b/i, reason: 'git filter-branch' },
  // 发布
  { pattern: /\bnpm\s+publish\b/i, reason: 'npm publish' },
  { pattern: /\bpnpm\s+publish\b/i, reason: 'pnpm publish' },
  { pattern: /\byarn\s+publish\b/i, reason: 'yarn publish' },
  { pattern: /\bdocker\s+push\b/i, reason: 'docker push' },
  // 权限 / 系统写
  { pattern: /\bchmod\s+-R\b/i, reason: 'chmod -R' },
  { pattern: /\bchown\s+-R\b/i, reason: 'chown -R' },
  // 远端数据库
  { pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, reason: 'DROP TABLE/DATABASE' },
  { pattern: /\bTRUNCATE\s+TABLE\b/i, reason: 'TRUNCATE TABLE' },
];

/**
 * 归类命令。优先级：blacklisted > risky > safe
 */
export function classifyCommand(cmd: string): CommandSafety {
  if (!cmd || typeof cmd !== 'string') return 'safe';
  for (const r of BLACKLIST_RULES) {
    if (r.pattern.test(cmd)) return 'blacklisted';
  }
  for (const r of RISKY_RULES) {
    if (r.pattern.test(cmd)) return 'risky';
  }
  return 'safe';
}

/** 返回命中的黑名单 reason（调试/错误消息用）；未命中返回 undefined */
export function findBlacklistReason(cmd: string): string | undefined {
  for (const r of BLACKLIST_RULES) {
    if (r.pattern.test(cmd)) return r.reason;
  }
  return undefined;
}

/** 返回命中的 risky reason；未命中返回 undefined */
export function findRiskyReason(cmd: string): string | undefined {
  for (const r of RISKY_RULES) {
    if (r.pattern.test(cmd)) return r.reason;
  }
  return undefined;
}
