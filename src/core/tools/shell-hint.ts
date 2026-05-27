/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * ShellHint（W13.1-B · Phase 3 软降级命令模板平台化）
 *
 * 背景：A/B 索引基准测试（perf-ab-index-benchmark.md）Phase B 发现，
 *      `search_codebase` 软降级后 Agent 在无索引态下频繁混用 cmd `findstr`、
 *      PowerShell `Select-String`、`cd && findstr` 等多种命令形式，
 *      Q2 耗 4 次工具调用试错、Q3 耗 5 次变体扫描。根因是原 `softIndexNotReady`
 *      只提示 "rg / findstr" 裸词，没有按平台给出**可直接复制**的完整命令。
 *
 * 本模块职责：
 *   1. 根据 `process.platform` + `SHELL / ComSpec` 环境变量探测 shell 类型
 *   2. 提供平台对应的 **关键字搜索** + **文件枚举** 命令模板
 *   3. 保持纯函数，所有外部状态通过 DI 注入，易于单测
 *
 * 设计原则：
 *   - 字节级恒等：同输入同输出
 *   - 模板优先于自由发挥：给 Agent 可复制的整条命令，而非散词
 *   - 失败可兜底：unknown shell 走 POSIX 风格
 */

export type ShellKind = 'powershell' | 'cmd' | 'bash' | 'zsh' | 'unknown';

export interface ShellDetectInput {
  /** os.platform() · 'win32' / 'darwin' / 'linux' / ... */
  platform: string;
  /** 原始 shell 路径（来自 EnvironmentProbe.shell） */
  shell: string;
}

/**
 * 根据平台 + shell 路径识别 shell 种类。
 *
 * 优先级：
 *   1. shell 字符串含 pwsh/powershell → powershell
 *   2. shell 字符串含 cmd.exe         → cmd
 *   3. shell 字符串含 zsh             → zsh
 *   4. shell 字符串含 bash            → bash
 *   5. win32 fallback → cmd（经验：Windows 开 bash 子进程概率低）
 *   6. darwin / linux fallback → bash
 *   7. 其余 → unknown
 */
export function detectShellKind(input: ShellDetectInput): ShellKind {
  const shellLower = input.shell.toLowerCase();
  if (shellLower.includes('pwsh') || shellLower.includes('powershell')) return 'powershell';
  if (shellLower.includes('cmd.exe') || shellLower.endsWith('cmd')) return 'cmd';
  if (shellLower.includes('zsh')) return 'zsh';
  if (shellLower.includes('bash')) return 'bash';
  if (input.platform === 'win32') return 'cmd';
  if (input.platform === 'darwin' || input.platform === 'linux') return 'bash';
  return 'unknown';
}

export interface CommandHints {
  /** 按关键字全文搜索（Agent 最常用） */
  keywordSearch: string;
  /** 递归枚举某类文件 */
  fileEnumerate: string;
  /** 单行命令说明（给 LLM 读的人类语言） */
  caption: string;
}

/**
 * 按 shell 种类返回命令模板。
 *
 * 占位符约定：
 *   - `<KEYWORD>` 关键字
 *   - `<EXT>`     文件扩展名（如 ts / js / py）
 *   - `<DIR>`     搜索起始目录（默认 `.`）
 */
export function buildCommandHints(kind: ShellKind): CommandHints {
  switch (kind) {
    case 'powershell':
      return {
        keywordSearch:
          "Get-ChildItem -Recurse -Include '*.<EXT>' | Select-String -Pattern '<KEYWORD>' -SimpleMatch",
        fileEnumerate: "Get-ChildItem -Recurse -Filter '*.<EXT>' | Select-Object -ExpandProperty FullName",
        caption: 'PowerShell（Windows 默认）',
      };
    case 'cmd':
      return {
        keywordSearch: 'findstr /s /n /i "<KEYWORD>" *.<EXT>',
        fileEnumerate: 'dir /s /b *.<EXT>',
        caption: 'cmd.exe（Windows 经典命令行）',
      };
    case 'zsh':
      return {
        keywordSearch: "grep -rn --include='*.<EXT>' '<KEYWORD>' <DIR>",
        fileEnumerate: "find <DIR> -type f -name '*.<EXT>'",
        caption: 'zsh（macOS 默认 / Linux 可选）',
      };
    case 'bash':
      return {
        keywordSearch: "grep -rn --include='*.<EXT>' '<KEYWORD>' <DIR>",
        fileEnumerate: "find <DIR> -type f -name '*.<EXT>'",
        caption: 'bash（Linux 默认）',
      };
    default:
      return {
        keywordSearch: "grep -rn '<KEYWORD>' <DIR>",
        fileEnumerate: "find <DIR> -type f",
        caption: 'POSIX 兜底模板（未识别 shell）',
      };
  }
}

/**
 * 把 `<KEYWORD> / <EXT> / <DIR>` 占位符渲染成具体示例。
 * 只用于展示给 Agent 的 fallback 提示中，**不在运行时执行**。
 */
export function fillHint(tpl: string, ex: { keyword?: string; ext?: string; dir?: string }): string {
  return tpl
    .replaceAll('<KEYWORD>', ex.keyword ?? 'MyKeyword')
    .replaceAll('<EXT>', ex.ext ?? 'ts')
    .replaceAll('<DIR>', ex.dir ?? '.');
}

/**
 * 渲染完整的软降级 fallback 提示行（供 `softIndexNotReady` 组装）。
 *
 * 输出形态（举例 · Windows PowerShell）：
 * ```
 * → 推荐切换到以下工具继续完成检索（不要重复调 search_codebase）：
 *   • list_dir · read_file             — 已知文件路径的精确定位
 *   • lsp (operation=workspace_symbol) — 按类/函数/方法名查找符号
 *   • lsp (operation=document_symbol)  — 单文件内部结构
 *   • bash 关键字全文检索（当前 shell: PowerShell · Windows 默认）
 *     模板：Get-ChildItem -Recurse -Include '*.ts' | Select-String -Pattern 'MyKeyword' -SimpleMatch
 *     替换 <KEYWORD>=查询词、<EXT>=文件扩展名后整条可复制执行
 * ```
 */
export interface RenderFallbackOpts {
  kind: ShellKind;
  /** 从用户 query 里提炼的示例关键字（可选，默认占位符） */
  exampleKeyword?: string;
}

export function renderFallbackBlock(opts: RenderFallbackOpts): string[] {
  const hints = buildCommandHints(opts.kind);
  const lines: string[] = [
    '→ 推荐切换到以下工具继续完成检索（不要重复调 search_codebase）：',
    '  • list_dir · read_file             — 已知文件路径的精确定位',
    '  • lsp (operation=workspace_symbol) — 按类/函数/方法名查找符号',
    '  • lsp (operation=document_symbol)  — 单文件内部结构',
    `  • bash 关键字全文检索（当前 shell: ${hints.caption}）`,
    `    模板：${hints.keywordSearch}`,
    `    替换 <KEYWORD>=查询词、<EXT>=文件扩展名（默认 ts）后整条可复制执行`,
    `    枚举文件：${hints.fileEnumerate}`,
  ];
  return lines;
}
