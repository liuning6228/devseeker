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
});
