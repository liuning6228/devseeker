/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * approval-policy 单测（W7b4a）
 *
 * 覆盖：
 * - 默认策略表（read_only/workspace_write/network=auto；destructive/external=confirm）
 * - 优先级：blacklisted > has_risk > risky > default
 * - policy 局部覆盖
 */

import { describe, it, expect } from 'vitest';
import {
  decideApproval,
  DEFAULT_POLICY,
} from '../../src/core/tools/approval-policy.js';

describe('decideApproval', () => {
  describe('default policy table', () => {
    it('read_only → auto', () => {
      expect(decideApproval({ level: 'read_only' }).decision).toBe('auto');
    });
    it('workspace_write → auto', () => {
      expect(decideApproval({ level: 'workspace_write' }).decision).toBe('auto');
    });
    it('network → auto', () => {
      expect(decideApproval({ level: 'network' }).decision).toBe('auto');
    });
    it('destructive → confirm', () => {
      expect(decideApproval({ level: 'destructive' }).decision).toBe('confirm');
    });
    it('external → confirm', () => {
      expect(decideApproval({ level: 'external' }).decision).toBe('confirm');
    });
  });

  describe('command safety overrides', () => {
    it('blacklisted command → deny', () => {
      const r = decideApproval({ level: 'read_only', command: 'rm -rf /' });
      expect(r.decision).toBe('deny');
      expect(r.commandSafety).toBe('blacklisted');
    });
    it('risky command + read_only level → confirm', () => {
      const r = decideApproval({
        level: 'read_only',
        command: 'git push --force',
      });
      expect(r.decision).toBe('confirm');
      expect(r.commandSafety).toBe('risky');
    });
    it('safe command respects level', () => {
      const r = decideApproval({
        level: 'destructive',
        command: 'ls -la',
      });
      expect(r.decision).toBe('confirm');
      expect(r.commandSafety).toBe('safe');
    });
  });

  describe('has_risk override', () => {
    it('has_risk=true + safe command + read_only → confirm', () => {
      const r = decideApproval({
        level: 'read_only',
        command: 'ls',
        hasRisk: true,
      });
      expect(r.decision).toBe('confirm');
    });
    it('has_risk=true + blacklisted still → deny (blacklist wins)', () => {
      const r = decideApproval({
        level: 'read_only',
        command: 'rm -rf /',
        hasRisk: true,
      });
      expect(r.decision).toBe('deny');
    });
    it('has_risk=true without command → confirm', () => {
      const r = decideApproval({ level: 'read_only', hasRisk: true });
      expect(r.decision).toBe('confirm');
    });
  });

  describe('policy override', () => {
    it('partial override', () => {
      const r = decideApproval({
        level: 'destructive',
        policy: { destructive: 'auto' },
      });
      expect(r.decision).toBe('auto');
    });
    it('DEFAULT_POLICY exposed', () => {
      expect(DEFAULT_POLICY.destructive).toBe('confirm');
      expect(DEFAULT_POLICY.read_only).toBe('auto');
    });
  });

  describe('command_safety overrides (settings auto-approve)', () => {
    it('command_safety=safe + safe command → auto (bash read auto)', () => {
      const r = decideApproval({
        level: 'destructive',
        command: 'ls -la',
        toolName: 'bash',
        overrides: [{ tool: 'bash', command_safety: 'safe', command_policy: 'auto' }],
      });
      expect(r.decision).toBe('auto');
      expect(r.commandSafety).toBe('safe');
    });
    it('command_safety=safe + risky command → override skipped, risky confirm', () => {
      const r = decideApproval({
        level: 'destructive',
        command: 'git push --force',
        toolName: 'bash',
        overrides: [{ tool: 'bash', command_safety: 'safe', command_policy: 'auto' }],
      });
      expect(r.decision).toBe('confirm');
      expect(r.commandSafety).toBe('risky');
    });
    it('command_safety=risky + risky command → auto (bash write auto)', () => {
      const r = decideApproval({
        level: 'destructive',
        command: 'npm publish',
        toolName: 'bash',
        overrides: [{ tool: 'bash', command_safety: 'risky', command_policy: 'auto' }],
      });
      expect(r.decision).toBe('auto');
    });
    it('command_safety=risky + safe command → override skipped, level table apply', () => {
      const r = decideApproval({
        level: 'destructive',
        command: 'cat package.json',
        toolName: 'bash',
        overrides: [{ tool: 'bash', command_safety: 'risky', command_policy: 'auto' }],
      });
      expect(r.decision).toBe('confirm');
    });
    it('blacklisted command wins over command_safety auto', () => {
      const r = decideApproval({
        level: 'destructive',
        command: 'rm -rf /',
        toolName: 'bash',
        overrides: [{ tool: 'bash', command_safety: 'safe', command_policy: 'auto' }],
      });
      expect(r.decision).toBe('deny');
    });
    it('has_risk=true + safe auto override → still confirm (hard rule)', () => {
      const r = decideApproval({
        level: 'destructive',
        command: 'ls',
        hasRisk: true,
        toolName: 'bash',
        overrides: [{ tool: 'bash', command_safety: 'safe', command_policy: 'auto' }],
      });
      expect(r.decision).toBe('confirm');
    });
    it('command_safety rule does not apply to other tools', () => {
      const r = decideApproval({
        level: 'read_only',
        command: 'ls',
        toolName: 'read_file',
        overrides: [{ tool: 'bash', command_safety: 'safe', command_policy: 'auto' }],
      });
      expect(r.decision).toBe('auto'); // 走默认表，不受 bash 规则影响
    });
  });
});
