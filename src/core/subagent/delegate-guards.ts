/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 子代理只读守卫（自动拒绝，不弹审批）
 *
 * 设计目标：子代理自动执行、**不需要用户审批**；但绝不能修改工作区。
 * 因此对子代理的 bash 采取"自动拒绝"而非"转审批"：
 * - 命中「写工作区」规则的命令 → 立即返回拒绝说明（并引导子代理改用只读方式）
 * - 其余命令（读取 / 测试 / 构建 / 类型检查）→ 自动执行
 *
 * 局限性（有意接受）：bash 是图灵完备的，正则守卫只能拦常见写路径，
 * 不是沙箱。真正的强隔离需要 OS 级沙箱；本模块作为纵深防御的第一层。
 */

interface WriteRule {
  pattern: RegExp;
  reason: string;
}

/**
 * 「会修改工作区」的命令规则。
 * 检测前会先剔除引号内内容（避免 `grep "cp"` 这类误报）。
 */
const WORKSPACE_WRITE_RULES: readonly WriteRule[] = [
  // 输出重定向写文件（排除 2>&1 / >& / >/dev/null 等）
  {
    pattern: /(^|[^0-9&])>>?\s*(?!&)(?!\/dev\/(null|stdout|stderr)\b)\S/,
    reason: '输出重定向写文件（> / >>）',
  },
  // 就地编辑 / 截断
  { pattern: /\bsed\s+(-[a-zA-Z]*i|--in-place)/i, reason: 'sed -i 就地编辑' },
  { pattern: /\bperl\s+-[a-zA-Z]*i\b/i, reason: 'perl -i 就地编辑' },
  { pattern: /\btruncate\b/i, reason: 'truncate 截断文件' },
  { pattern: /\bdd\s+of=/i, reason: 'dd of= 写盘' },
  { pattern: /\btee\b/i, reason: 'tee 写入文件' },
  // 文件系统改写
  { pattern: /\b(rm|rmdir|unlink)\b/i, reason: 'rm / rmdir / unlink 删除' },
  { pattern: /\bmv\b/i, reason: 'mv 移动 / 改名' },
  { pattern: /\bcp\b/i, reason: 'cp 复制写入' },
  { pattern: /\btouch\b/i, reason: 'touch 创建 / 改时间戳' },
  { pattern: /\bmkdir\b/i, reason: 'mkdir 建目录' },
  { pattern: /\bln\b/i, reason: 'ln 建链接' },
  { pattern: /\b(chmod|chown)\b/i, reason: 'chmod / chown' },
  { pattern: /\b(patch|git\s+apply)\b/i, reason: 'patch 打补丁' },
  // git 写操作（status / log / diff / show / blame / fetch / config 等读取类不在内）
  {
    pattern:
      /\bgit\s+(add|commit|checkout|switch|reset|clean|stash|restore|revert|merge|rebase|cherry-pick|rm|mv|push|pull|tag|init|clone|worktree)\b/i,
    reason: 'git 写操作',
  },
  // 包管理器安装 / 更新（会改 node_modules / 锁文件）
  {
    pattern: /\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|ci|up|update|link)\b/i,
    reason: '包管理器安装 / 更新',
  },
  { pattern: /\bpip3?\s+(install|uninstall)\b/i, reason: 'pip install / uninstall' },
  { pattern: /\b(cargo|go)\s+(add|install|get)\b/i, reason: 'cargo / go 依赖安装' },
];

/** 剔除引号内内容，消除 `grep "cp"` / `echo "a > b"` 这类误报 */
function scrubQuoted(command: string): string {
  return command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

/**
 * 判断命令是否会修改工作区。
 * @returns 命中原因；未命中返回 undefined（自动放行）
 */
export function findWorkspaceMutationReason(command: string): string | undefined {
  if (typeof command !== 'string' || command.trim().length === 0) return undefined;
  const scrubbed = scrubQuoted(command);
  for (const rule of WORKSPACE_WRITE_RULES) {
    if (rule.pattern.test(scrubbed)) return rule.reason;
  }
  return undefined;
}

/**
 * 子代理路径白名单判定（read_file 用）。
 * prefix 以 `/` 结尾视为目录前缀；否则视为精确文件（如 AGENTS.md）。
 */
export function isDelegatePathAllowed(relPath: string, prefixes: readonly string[]): boolean {
  const norm = relPath.split('\\').join('/');
  return prefixes.some((p) => {
    const prefix = p.split('\\').join('/');
    if (prefix.endsWith('/')) return norm.startsWith(prefix);
    return norm === prefix;
  });
}

/**
 * 子代理域名白名单判定（网络工具用）。支持子域后缀匹配（如 `vitest.dev` 匹配 `docs.vitest.dev`）。
 */
export function isDelegateHostAllowed(url: string, whitelist: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return whitelist.some((h) => {
    const allowed = h.toLowerCase().replace(/^\./, '');
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}
