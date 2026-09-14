/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * approval-policy-loader 单测（自动审批设置持久化）
 *
 * 覆盖：
 * - 多行列表项解析（- tool + 缩进续行键合并为一个 override）
 * - command_safety 字段透传
 * - writeApprovalPolicy 写回 + 再读 round-trip（临时目录）
 * - 手写 overrides 保留、UI 生成 bash 规则整体替换
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadApprovalPolicy,
  loadPolicyYaml,
  writeApprovalPolicy,
} from '../../src/core/tools/approval-policy-loader.js';

let wsRoot: string;

/** loader 读取 <workspaceRoot>/.devseeker/approval-policy.yaml */
async function writePolicyYaml(ws: string, lines: string[]): Promise<void> {
  const dir = path.join(ws, '.devseeker');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'approval-policy.yaml'), lines.join('\n'), 'utf8');
}

beforeAll(async () => {
  wsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-loader-'));
});

afterAll(async () => {
  await fs.rm(wsRoot, { recursive: true, force: true });
});

describe('loadPolicyYaml multi-key list items', () => {
  it('merges indented continuation keys into one override item', async () => {
    await writePolicyYaml(wsRoot, [
      'version: 1',
      'defaults:',
      '  read_only: auto',
      'overrides:',
      '  - tool: bash',
      '    command_safety: risky',
      '    command_policy: auto',
      '  - tool: npm publish',
      '    command_match: "npm publish"',
      '    command_policy: deny',
      '',
    ]);
    const cfg = await loadPolicyYaml(wsRoot);
    expect(cfg.overrides).toHaveLength(2);
    expect(cfg.overrides?.[0]).toMatchObject({
      tool: 'bash',
      command_safety: 'risky',
      command_policy: 'auto',
    });
    expect(cfg.overrides?.[1]).toMatchObject({
      tool: 'npm publish',
      command_match: 'npm publish',
      command_policy: 'deny',
    });
  });
});

describe('loadApprovalPolicy command_safety passthrough', () => {
  it('exposes command_safety on loaded overrides', async () => {
    const { overrides } = await loadApprovalPolicy(wsRoot);
    expect(overrides.some((o) => o.tool === 'bash' && o.command_safety === 'risky')).toBe(true);
  });
});

describe('writeApprovalPolicy round-trip', () => {
  it('writes defaults + bash rules, keeps handwritten overrides', async () => {
    // 手写规则：无 command_safety
    await writePolicyYaml(wsRoot, [
      'version: 1',
      'defaults:',
      '  read_only: auto',
      '  destructive: confirm',
      'overrides:',
      '  - tool: write_file',
      '    policy: confirm',
      '',
    ]);
    await writeApprovalPolicy(wsRoot, {
      defaults: { read_only: 'confirm', network: 'auto' },
      bashRead: true,
      bashWrite: true,
    });
    const cfg = await loadPolicyYaml(wsRoot);
    // defaults 合并：更新字段生效，destructive 保留
    expect(cfg.defaults).toMatchObject({
      read_only: 'confirm',
      destructive: 'confirm',
      network: 'auto',
    });
    // 手写规则保留 + 两条 UI bash 规则
    expect(cfg.overrides).toHaveLength(3);
    expect(cfg.overrides?.map((o) => o.tool)).toEqual(['write_file', 'bash', 'bash']);
    expect(cfg.overrides?.filter((o) => o.tool === 'bash')).toMatchObject([
      { tool: 'bash', command_safety: 'safe', command_policy: 'auto' },
      { tool: 'bash', command_safety: 'risky', command_policy: 'auto' },
    ]);
  });

  it('closing a UI bash rule removes only that rule', async () => {
    await writeApprovalPolicy(wsRoot, { bashRead: false, bashWrite: false });
    const cfg = await loadPolicyYaml(wsRoot);
    expect(cfg.overrides).toHaveLength(1); // 仅剩手写 write_file 规则
    expect(cfg.overrides).toMatchObject([{ tool: 'write_file', policy: 'confirm' }]);
  });

  it('creates file when missing and persists all patches', async () => {
    const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-loader-empty-'));
    try {
      await writeApprovalPolicy(emptyRoot, { defaults: { workspace_write: 'confirm' }, bashWrite: true });
      const cfg = await loadPolicyYaml(emptyRoot);
      expect(cfg.defaults).toMatchObject({ workspace_write: 'confirm' });
      expect(cfg.overrides).toMatchObject([{ tool: 'bash', command_safety: 'risky', command_policy: 'auto' }]);
      // 写出的文件可被再次读写（round-trip 稳定）
      const again = await loadPolicyYaml(emptyRoot);
      expect(again.overrides).toEqual(cfg.overrides);
    } finally {
      await fs.rm(emptyRoot, { recursive: true, force: true });
    }
  });

  it('single-field patches keep the other bash rule (read/write toggles are independent)', async () => {
    // UI 单次点击只携带变更字段：先开读、再开写，两条规则必须共存（非互斥）
    const seqRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-loader-seq-'));
    try {
      await writeApprovalPolicy(seqRoot, { bashRead: true });
      await writeApprovalPolicy(seqRoot, { bashWrite: true });
      let cfg = await loadPolicyYaml(seqRoot);
      expect(cfg.overrides).toHaveLength(2);
      expect(cfg.overrides).toContainEqual({ tool: 'bash', command_safety: 'safe', command_policy: 'auto' });
      expect(cfg.overrides).toContainEqual({ tool: 'bash', command_safety: 'risky', command_policy: 'auto' });

      // 单独关闭写（未指定读）→ 读规则保留，不受连带删除
      await writeApprovalPolicy(seqRoot, { bashWrite: false });
      cfg = await loadPolicyYaml(seqRoot);
      expect(cfg.overrides).toHaveLength(1);
      expect(cfg.overrides).toContainEqual({ tool: 'bash', command_safety: 'safe', command_policy: 'auto' });
    } finally {
      await fs.rm(seqRoot, { recursive: true, force: true });
    }
  });

  it('rejects write without workspace root', async () => {
    await expect(writeApprovalPolicy(undefined, { bashRead: true })).rejects.toThrow('未打开工作区');
  });
});

describe('parseYamlCompat list definition robustness', () => {
  it('recognizes list even when comments/blank lines separate key from first item', async () => {
    await writePolicyYaml(wsRoot, [
      'version: 1',
      'defaults:',
      '  read_only: auto',
      'overrides:',
      '  # 手写规则（注释分隔，不应导致列表识别失败）',
      '',
      '  - tool: bash',
      '    command_safety: risky',
      '    command_policy: deny',
      '',
    ]);
    const cfg = await loadPolicyYaml(wsRoot);
    expect(Array.isArray(cfg.overrides)).toBe(true);
    expect(cfg.overrides).toHaveLength(1);
    expect(cfg.overrides?.[0]).toMatchObject({
      tool: 'bash',
      command_safety: 'risky',
      command_policy: 'deny',
    });
  });
});

describe('writeApprovalPolicy handwritten bash rules protection', () => {
  it('keeps handwritten command_safety deny rule when UI bashWrite toggled', async () => {
    // 手写：bash risky 命令级 deny（用户自定义硬规则）
    await writePolicyYaml(wsRoot, [
      'version: 1',
      'overrides:',
      '  - tool: bash',
      '    command_safety: risky',
      '    command_policy: deny',
      '',
    ]);
    // UI 开启 bashWrite → 只应替换/追加 UI 特征规则（auto），手写 deny 规则必须保留
    await writeApprovalPolicy(wsRoot, { bashRead: true, bashWrite: true });
    const cfg = await loadPolicyYaml(wsRoot);
    const bashRules = (cfg.overrides ?? []).filter((o) => o.tool === 'bash');
    expect(bashRules).toHaveLength(3);
    expect(bashRules).toContainEqual({ tool: 'bash', command_safety: 'risky', command_policy: 'deny' });
    expect(bashRules).toContainEqual({ tool: 'bash', command_safety: 'safe', command_policy: 'auto' });
    expect(bashRules).toContainEqual({ tool: 'bash', command_safety: 'risky', command_policy: 'auto' });
    // 再次写盘（UI 关闭 bashWrite）→ deny 规则仍保留，UI 的 risky auto 规则被移除
    await writeApprovalPolicy(wsRoot, { bashWrite: false });
    const cfg2 = await loadPolicyYaml(wsRoot);
    const riskyRules = (cfg2.overrides ?? []).filter(
      (o) => o.tool === 'bash' && o.command_safety === 'risky',
    );
    expect(riskyRules).toEqual([{ tool: 'bash', command_safety: 'risky', command_policy: 'deny' }]);
  });
});