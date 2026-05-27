/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * EnvironmentProbe（DESIGN §M3.7 · W3.7 / B-P3-1）
 *
 * 采集运行时环境信息，生成 `<environment>...</environment>` 块，注入到
 * System Prompt 的 L3 层（`buildL3Attachments`）。用于让模型感知：
 *   - 当前 OS / shell / Node.js 版本
 *   - 工作区根目录
 *   - 当前时间 + 时区
 *
 * 设计原则：
 * 1. **可测试**：所有"外部状态"通过 override 注入，纯函数易于 stub。
 * 2. **稳定**：同输入字节级恒等输出；时间戳是唯一合法变化源。
 * 3. **不侵入 L0/L1/L2**：只出现在 L3，不影响前缀缓存命中。
 * 4. **轻量**：纯 Node 内置 API，无新增依赖。
 *
 * 与 git 上下文（B-P1-11）的分工：本探针仅采集"静态"环境，git 状态
 * 由独立的 `git-context` 模块负责，因 git 调用有 IO 开销需单独处理。
 */

import * as os from 'node:os';

export interface EnvironmentSnapshot {
  /** os.platform() · 'win32' / 'darwin' / 'linux' */
  platform: string;
  /** os.release() · e.g. '10.0.26100' */
  osRelease: string;
  /** os.arch() · 'x64' / 'arm64' */
  arch: string;
  /** 默认 shell 路径；未知时返回 'unknown' */
  shell: string;
  /** Node.js 版本 · e.g. 'v24.14.0' */
  nodeVersion: string;
  /** 工作区根目录（若无则省略该字段） */
  workspaceRoot?: string;
  /** 当前时间 ISO8601（含时区偏移） */
  now: string;
  /** IANA 时区名 · e.g. 'Asia/Shanghai' */
  timezone: string;
}

export interface CollectOptions {
  /** 工作区根目录。调用方传入，避免依赖 vscode API */
  workspaceRoot?: string;
  /** DI 时间源，默认 Date.now() */
  now?: () => Date;
  /** DI process 对象，默认 globalThis.process */
  processLike?: { platform: string; arch: string; version: string; env: NodeJS.ProcessEnv };
  /** DI os 模块，默认 node:os */
  osLike?: { release: () => string };
}

/** 采集当前环境快照（纯函数；同输入恒等输出，除 `now` 字段）。 */
export function collectEnvironment(opts: CollectOptions = {}): EnvironmentSnapshot {
  const proc = opts.processLike ?? (globalThis.process as NodeJS.Process);
  const osMod = opts.osLike ?? os;
  const nowDate = (opts.now ?? (() => new Date()))();

  // shell 探测顺序：SHELL（Unix/ bash/zsh）→ ComSpec（Windows cmd/PowerShell）→ unknown
  const shell =
    proc.env['SHELL']?.trim() ||
    proc.env['ComSpec']?.trim() ||
    proc.env['COMSPEC']?.trim() ||
    'unknown';

  let timezone = 'UTC';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    // noop
  }

  const snapshot: EnvironmentSnapshot = {
    platform: proc.platform,
    osRelease: osMod.release(),
    arch: proc.arch,
    shell,
    nodeVersion: proc.version,
    now: nowDate.toISOString(),
    timezone,
  };
  if (opts.workspaceRoot) {
    snapshot.workspaceRoot = opts.workspaceRoot;
  }
  return snapshot;
}

/**
 * 把快照格式化为 `<environment>...</environment>` 文本块。
 *
 * 字段顺序固定，利于：
 *   1. 同输入字节级恒等输出（测试断言）
 *   2. 模型读取时可预测结构
 *
 * 输出示例：
 * ```
 * <environment>
 * platform: win32 10.0.26100 x64
 * shell: C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
 * node: v24.14.0
 * workspace: c:\Users\x\workspace
 * tz: Asia/Shanghai
 * now: 2026-05-02T14:23:45.000Z
 * </environment>
 * ```
 */
export function formatEnvironment(snapshot: EnvironmentSnapshot): string {
  const lines = [
    '<environment>',
    `platform: ${snapshot.platform} ${snapshot.osRelease} ${snapshot.arch}`,
    `shell: ${snapshot.shell}`,
    `node: ${snapshot.nodeVersion}`,
  ];
  if (snapshot.workspaceRoot) {
    lines.push(`workspace: ${snapshot.workspaceRoot}`);
  }
  lines.push(`tz: ${snapshot.timezone}`);
  lines.push(`now: ${snapshot.now}`);
  lines.push('</environment>');
  return lines.join('\n');
}

/** 便捷组合：采集 + 格式化，一步到位。 */
export function buildEnvironmentBlock(opts: CollectOptions = {}): string {
  return formatEnvironment(collectEnvironment(opts));
}
