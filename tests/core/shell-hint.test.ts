/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W13.1-B · shell-hint 平台化命令模板单测
 *
 * 断言：
 *   1. detectShellKind 覆盖 5 类 shell × Windows/macOS/Linux 平台兜底
 *   2. buildCommandHints 各 shell 都返回非空 keyword/enumerate/caption
 *   3. fillHint 正确替换占位符
 *   4. renderFallbackBlock 输出符合 softIndexNotReady 的契约（至少含 list_dir / lsp / 当前 shell caption）
 */
import { describe, expect, it } from 'vitest';
import {
  detectShellKind,
  buildCommandHints,
  fillHint,
  renderFallbackBlock,
  type ShellKind,
} from '../../src/core/tools/shell-hint.js';

describe('W13.1-B · detectShellKind', () => {
  const cases: Array<{
    name: string;
    platform: string;
    shell: string;
    expected: ShellKind;
  }> = [
    {
      name: 'Windows PowerShell 默认',
      platform: 'win32',
      shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      expected: 'powershell',
    },
    {
      name: 'Windows pwsh 7+',
      platform: 'win32',
      shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      expected: 'powershell',
    },
    {
      name: 'Windows cmd',
      platform: 'win32',
      shell: 'C:\\Windows\\System32\\cmd.exe',
      expected: 'cmd',
    },
    {
      name: 'Windows ComSpec unknown → win32 fallback = cmd',
      platform: 'win32',
      shell: 'unknown',
      expected: 'cmd',
    },
    {
      name: 'macOS zsh 默认',
      platform: 'darwin',
      shell: '/bin/zsh',
      expected: 'zsh',
    },
    {
      name: 'Linux bash',
      platform: 'linux',
      shell: '/bin/bash',
      expected: 'bash',
    },
    {
      name: 'Linux shell 缺失 → linux fallback = bash',
      platform: 'linux',
      shell: 'unknown',
      expected: 'bash',
    },
    {
      name: '罕见平台 freebsd + shell 空 → unknown',
      platform: 'freebsd',
      shell: '',
      expected: 'unknown',
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(detectShellKind({ platform: c.platform, shell: c.shell })).toBe(c.expected);
    });
  }
});

describe('W13.1-B · buildCommandHints', () => {
  const kinds: ShellKind[] = ['powershell', 'cmd', 'bash', 'zsh', 'unknown'];
  for (const k of kinds) {
    it(`${k} 模板非空且含占位符`, () => {
      const hints = buildCommandHints(k);
      expect(hints.keywordSearch.length).toBeGreaterThan(10);
      expect(hints.fileEnumerate.length).toBeGreaterThan(5);
      expect(hints.caption.length).toBeGreaterThan(0);
      // 关键字搜索模板必含 <KEYWORD> 占位符，除了 unknown POSIX 兜底也必含
      expect(hints.keywordSearch).toContain('<KEYWORD>');
    });
  }

  it('PowerShell 模板使用 Select-String', () => {
    expect(buildCommandHints('powershell').keywordSearch).toContain('Select-String');
  });

  it('cmd 模板使用 findstr', () => {
    expect(buildCommandHints('cmd').keywordSearch).toContain('findstr');
  });

  it('bash 模板使用 grep -rn', () => {
    expect(buildCommandHints('bash').keywordSearch).toContain('grep -rn');
  });

  it('zsh 模板与 bash 一致（POSIX 习惯）', () => {
    expect(buildCommandHints('zsh').keywordSearch).toBe(
      buildCommandHints('bash').keywordSearch,
    );
  });
});

describe('W13.1-B · fillHint', () => {
  it('替换单个占位符', () => {
    expect(fillHint('find <DIR>', { dir: 'src' })).toBe('find src');
  });

  it('替换多个占位符（同时出现）', () => {
    const tpl = "grep -rn --include='*.<EXT>' '<KEYWORD>' <DIR>";
    expect(fillHint(tpl, { keyword: 'foo', ext: 'ts', dir: './src' })).toBe(
      "grep -rn --include='*.ts' 'foo' ./src",
    );
  });

  it('未提供值时使用默认占位', () => {
    const tpl = "grep '<KEYWORD>' <DIR>";
    expect(fillHint(tpl, {})).toBe("grep 'MyKeyword' .");
  });

  it('替换同名占位符所有实例（replaceAll）', () => {
    const tpl = '<EXT>/*.<EXT>';
    expect(fillHint(tpl, { ext: 'ts' })).toBe('ts/*.ts');
  });
});

describe('W13.1-B · renderFallbackBlock', () => {
  it('PowerShell 输出含 Select-String 模板', () => {
    const block = renderFallbackBlock({ kind: 'powershell' });
    const joined = block.join('\n');
    expect(joined).toContain('list_dir');
    expect(joined).toContain('lsp');
    expect(joined).toContain('workspace_symbol');
    expect(joined).toContain('Select-String');
    expect(joined).toContain('PowerShell');
  });

  it('cmd 输出含 findstr 模板', () => {
    const joined = renderFallbackBlock({ kind: 'cmd' }).join('\n');
    expect(joined).toContain('findstr');
    expect(joined).toContain('cmd.exe');
  });

  it('bash 输出含 grep 模板', () => {
    const joined = renderFallbackBlock({ kind: 'bash' }).join('\n');
    expect(joined).toContain('grep -rn');
    expect(joined).toContain('bash');
  });

  it('unknown 走 POSIX 兜底', () => {
    const joined = renderFallbackBlock({ kind: 'unknown' }).join('\n');
    expect(joined).toContain('grep -rn');
    expect(joined).toContain('POSIX 兜底');
  });

  it('输出首行恒为推荐工具引导', () => {
    expect(renderFallbackBlock({ kind: 'bash' })[0]).toContain('推荐切换到以下工具继续完成检索');
  });
});
