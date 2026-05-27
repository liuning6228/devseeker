/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

import { describe, it, expect } from 'vitest';
import {
  collectEnvironment,
  formatEnvironment,
  buildEnvironmentBlock,
} from '../../src/core/prompts/environment-probe.js';

describe('environment-probe', () => {
  const fakeProcess = {
    platform: 'win32',
    arch: 'x64',
    version: 'v24.14.0',
    env: {
      ComSpec: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    } as NodeJS.ProcessEnv,
  };
  const fakeOs = { release: () => '10.0.26100' };
  const fakeNow = () => new Date('2026-05-02T14:23:45.000Z');

  it('collectEnvironment 返回完整快照（workspaceRoot 显式传入）', () => {
    const snap = collectEnvironment({
      workspaceRoot: 'c:\\ws',
      now: fakeNow,
      processLike: fakeProcess,
      osLike: fakeOs,
    });
    expect(snap.platform).toBe('win32');
    expect(snap.osRelease).toBe('10.0.26100');
    expect(snap.arch).toBe('x64');
    expect(snap.nodeVersion).toBe('v24.14.0');
    expect(snap.shell).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(snap.workspaceRoot).toBe('c:\\ws');
    expect(snap.now).toBe('2026-05-02T14:23:45.000Z');
    expect(snap.timezone).toBeTruthy();
  });

  it('collectEnvironment 不传 workspaceRoot 时，字段被省略', () => {
    const snap = collectEnvironment({
      now: fakeNow,
      processLike: fakeProcess,
      osLike: fakeOs,
    });
    expect('workspaceRoot' in snap).toBe(false);
  });

  it('shell 优先 SHELL → ComSpec → unknown', () => {
    const unixProc = { ...fakeProcess, env: { SHELL: '/bin/zsh' } as NodeJS.ProcessEnv };
    expect(
      collectEnvironment({ now: fakeNow, processLike: unixProc, osLike: fakeOs }).shell,
    ).toBe('/bin/zsh');

    const unknownProc = { ...fakeProcess, env: {} as NodeJS.ProcessEnv };
    expect(
      collectEnvironment({ now: fakeNow, processLike: unknownProc, osLike: fakeOs }).shell,
    ).toBe('unknown');
  });

  it('formatEnvironment 输出稳定结构（含 workspace）', () => {
    const snap = collectEnvironment({
      workspaceRoot: 'c:\\ws',
      now: fakeNow,
      processLike: fakeProcess,
      osLike: fakeOs,
    });
    const text = formatEnvironment(snap);
    expect(text.startsWith('<environment>\n')).toBe(true);
    expect(text.endsWith('\n</environment>')).toBe(true);
    expect(text).toContain('platform: win32 10.0.26100 x64');
    expect(text).toContain('shell: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(text).toContain('node: v24.14.0');
    expect(text).toContain('workspace: c:\\ws');
    expect(text).toContain('now: 2026-05-02T14:23:45.000Z');
  });

  it('formatEnvironment 不含 workspace 时自动省略该行', () => {
    const snap = collectEnvironment({
      now: fakeNow,
      processLike: fakeProcess,
      osLike: fakeOs,
    });
    const text = formatEnvironment(snap);
    expect(text).not.toContain('workspace:');
  });

  it('buildEnvironmentBlock 同输入输出字节级相同（now 相同）', () => {
    const a = buildEnvironmentBlock({
      workspaceRoot: 'c:\\ws',
      now: fakeNow,
      processLike: fakeProcess,
      osLike: fakeOs,
    });
    const b = buildEnvironmentBlock({
      workspaceRoot: 'c:\\ws',
      now: fakeNow,
      processLike: fakeProcess,
      osLike: fakeOs,
    });
    expect(a).toBe(b);
  });

  it('buildEnvironmentBlock 默认参数不抛异常（走真实运行时）', () => {
    const text = buildEnvironmentBlock();
    expect(text.startsWith('<environment>')).toBe(true);
    expect(text).toContain('\nnode: ');
  });
});
