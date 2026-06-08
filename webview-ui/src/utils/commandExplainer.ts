/**
 * 命令解释器 — 基于正则模式匹配的本地命令解释（无 LLM 延迟）
 *
 * 用于审批面板中向用户解释 bash 命令的含义和风险。
 * 所有模式均为本地规则，不发起网络请求。
 */

export interface CommandExplanation {
  summary: string;
  riskFactors: string[];
  category: 'read' | 'write' | 'delete' | 'network' | 'process' | 'system' | 'unknown';
}

interface Pattern {
  regex: RegExp;
  category: CommandExplanation['category'];
  summary: string;
  risks: string[];
}

const PATTERNS: Pattern[] = [
  // 删除类
  { regex: /^rm\s+-rf\s/, category: 'delete', summary: '递归强制删除目录及所有内容', risks: ['🚫 不可逆操作', '⚠️ 可能删除重要文件'] },
  { regex: /^rm\s+/, category: 'delete', summary: '删除文件或目录', risks: ['⚠️ 删除操作不可逆'] },
  { regex: /^docker\s+rm\s/, category: 'delete', summary: '删除 Docker 容器', risks: ['⚠️ 删除容器数据'] },
  { regex: /^docker\s+system\s+prune/, category: 'delete', summary: '清理 Docker 未使用资源', risks: ['⚠️ 批量删除未使用的容器/镜像'] },

  // 写入类
  { regex: /^npm\s+install\s/, category: 'process', summary: '安装 npm 依赖包', risks: ['⚠️ 修改 node_modules', '⚠️ 可能执行 postinstall 脚本'] },
  { regex: /^git\s+push\s/, category: 'write', summary: '推送 Git 提交到远程仓库', risks: ['⚠️ 修改远程仓库'] },
  { regex: /^git\s+reset\s+--hard/, category: 'write', summary: '硬重置 Git 仓库到指定提交', risks: ['🚫 丢弃未提交的更改', '⚠️ 不可逆'] },
  { regex: /^git\s+checkout\s/, category: 'write', summary: '切换 Git 分支或恢复文件', risks: ['⚠️ 未提交更改可能丢失'] },
  { regex: /^chmod\s/, category: 'system', summary: '修改文件权限', risks: ['⚠️ 可能影响系统安全'] },

  // 网络类
  { regex: /^curl\s/, category: 'network', summary: '发送 HTTP 请求', risks: ['⚠️ 网络请求', '⚠️ 可能下载文件'] },
  { regex: /^wget\s/, category: 'network', summary: '从网络下载文件', risks: ['⚠️ 下载外部文件'] },
  { regex: /^npm\s+publish/, category: 'network', summary: '发布 npm 包到公共仓库', risks: ['⚠️ 公开发布到 npm'] },
  { regex: /^git\s+clone/, category: 'network', summary: '克隆远程 Git 仓库', risks: [] },

  // 进程类
  { regex: /^kill\s/, category: 'process', summary: '终止进程', risks: ['⚠️ 终止运行中的进程'] },
  { regex: /^npx\s/, category: 'process', summary: '执行 npm 包（临时下载并运行）', risks: ['⚠️ 临时下载外部代码并执行'] },

  // 读取类（低风险）
  { regex: /^ls\s/, category: 'read', summary: '列出目录内容', risks: [] },
  { regex: /^cat\s/, category: 'read', summary: '查看文件内容', risks: [] },
  { regex: /^echo\s/, category: 'read', summary: '输出文本到标准输出', risks: [] },
  { regex: /^pwd\s?$/, category: 'read', summary: '显示当前工作目录路径', risks: [] },
  { regex: /^which\s/, category: 'read', summary: '查找可执行文件的路径', risks: [] },
  { regex: /^head\s/, category: 'read', summary: '查看文件开头部分内容', risks: [] },
  { regex: /^tail\s/, category: 'read', summary: '查看文件末尾部分内容', risks: [] },
  { regex: /^grep\s/, category: 'read', summary: '在文件中搜索文本模式', risks: [] },
  { regex: /^find\s/, category: 'read', summary: '查找文件或目录', risks: [] },
  { regex: /^diff\s/, category: 'read', summary: '比较两个文件差异', risks: [] },
];

/**
 * 解释一条 bash 命令，返回人类可读的摘要和风险因子。
 * 匹配不到已知模式时返回通用分类结果。
 */
export function explainCommand(command: string): CommandExplanation {
  if (!command || typeof command !== 'string') {
    return { summary: '空命令', riskFactors: [], category: 'unknown' };
  }

  const trimmed = command.trim();

  for (const p of PATTERNS) {
    if (p.regex.test(trimmed)) {
      return { summary: p.summary, riskFactors: p.risks, category: p.category };
    }
  }

  // 未知命令的通用启发式分类
  if (trimmed.includes('>') || trimmed.includes('>>')) {
    return { summary: '输出重定向（可能写入文件）', riskFactors: ['⚠️ 可能修改文件'], category: 'write' };
  }
  if (trimmed.includes('|')) {
    return { summary: '管道命令组合', riskFactors: [], category: 'unknown' };
  }
  if (trimmed.includes('sudo ')) {
    return { summary: '以超级用户权限执行命令', riskFactors: ['🚫 可修改系统级文件'], category: 'system' };
  }
  if (trimmed.startsWith('#')) {
    return { summary: '注释（不会被执行）', riskFactors: [], category: 'read' };
  }

  return { summary: 'Shell 命令', riskFactors: [], category: 'unknown' };
}
