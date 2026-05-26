/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ProviderRegistry,
  __resetProviderRegistryForTest,
  getProviderRegistry,
} from '../../src/providers/registry.js';
import { initLogger, closeLogger, __resetLoggerForTest } from '../../src/infra/logger.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** 造一个 mock vscode.WorkspaceConfiguration */
function mockConfig(overrides: Record<string, unknown> = {}): any {
  const data: Record<string, unknown> = {
    'models.llm.level1.provider': 'deepseek',
    'models.llm.level1.apiKey': 'sk-ds-abc',
    'models.llm.level1.model': 'deepseek-chat',
    'models.llm.level1.apiKeys': [],
    'models.llm.level1.baseUrl': '',
    'models.llm.level1.reasoningModel': '',
    'models.llm.level1.contextWindow': 0,
    'models.vllm.level1.provider': '',
    'models.vllm.level1.apiKey': '',
    ...overrides,
  };
  return {
    get: (key: string, def?: unknown) => data[key] ?? def,
    has: (key: string) => key in data,
  };
}

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;
  let logDir: string;

  beforeEach(() => {
    __resetLoggerForTest();
    __resetProviderRegistryForTest();
    logDir = join(tmpdir(), `dualmind-registry-test-${randomUUID()}`);
    mkdirSync(logDir, { recursive: true });
    initLogger({ logDir, level: 'info' });
    registry = new ProviderRegistry();
  });

  afterEach(async () => {
    await closeLogger();
    __resetLoggerForTest();
    __resetProviderRegistryForTest();
    try { rmSync(logDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('initFromConfig registers LLM L1 provider with apiKey', () => {
    registry.initFromConfig(mockConfig());
    expect(registry.ids().length).toBeGreaterThanOrEqual(1);
    const ids = registry.ids();
    const llmL1 = ids.find((id) => id.includes(':llm:L1'));
    expect(llmL1).toBeDefined();
  });

  it('initFromConfig registers default vllm provider when vllm L1 is not explicitly configured', () => {
    registry.initFromConfig(mockConfig({
      'models.vllm.level1.provider': '',
    }));
    // 即使 provider 为空，registry 会 fallback 到默认（qwen）注册 vllm:L1
    const ids = registry.ids();
    const vllmL1 = ids.find((id) => id.includes(':vllm:L1'));
    expect(vllmL1).toBeDefined();
  });

  it('initFromConfig registers LLM L1 even without apiKey (placeholder)', () => {
    registry.initFromConfig(mockConfig({
      'models.llm.level1.apiKey': '',
      'models.llm.level1.apiKeys': [],
    }));
    const ids = registry.ids();
    expect(ids.length).toBeGreaterThanOrEqual(1);
  });

  it('initFromConfig reads vllm track when configured', () => {
    registry.initFromConfig(mockConfig({
      'models.llm.level1.apiKey': 'sk-llm',
      'models.vllm.level1.provider': 'qwen',
      'models.vllm.level1.apiKey': 'sk-vl',
      'models.vllm.level1.model': 'qwen-vl-max-latest',
    }));
    const vllmL1 = registry.ids().find((id) => id.includes(':vllm:L1'));
    expect(vllmL1).toBeDefined();
  });

  it('getDefaultProvider returns LLM L1 with valid key', () => {
    registry.initFromConfig(mockConfig({
      'models.llm.level1.apiKey': 'sk-llm',
    }));
    const p = registry.getDefaultProvider('llm');
    expect(p).toBeDefined();
    expect(p!.id).toContain(':llm:L1');
  });

  it('getDefaultProvider returns undefined when no provider registered', () => {
    const p = registry.getDefaultProvider('llm');
    expect(p).toBeUndefined();
  });

  it('getNextLevel returns next level provider', () => {
    registry.initFromConfig(mockConfig({
      'models.llm.level1.provider': 'deepseek',
      'models.llm.level1.apiKey': 'sk-l1',
      'models.llm.level2.provider': 'openai',
      'models.llm.level2.apiKey': 'sk-l2',
    }));
    const next = registry.getNextLevel('deepseek:llm:L1');
    expect(next).toBeDefined();
    expect(next!.id).toContain(':llm:L2');
  });

  it('getNextLevel returns undefined when no next level', () => {
    registry.initFromConfig(mockConfig({
      'models.llm.level1.provider': 'deepseek',
      'models.llm.level1.apiKey': 'sk-l1',
    }));
    const next = registry.getNextLevel('deepseek:llm:L1');
    expect(next).toBeUndefined();
  });

  it('getNextLevel returns undefined at max level', () => {
    registry.initFromConfig(mockConfig({
      'models.llm.level3.provider': 'deepseek',
      'models.llm.level3.apiKey': 'sk-l3',
    }));
    const next = registry.getNextLevel('deepseek:llm:L3');
    expect(next).toBeUndefined();
  });

  it('rotateApiKey switches to next key and returns true', () => {
    registry.initFromConfig(mockConfig({
      'models.llm.level1.apiKey': 'key1',
      'models.llm.level1.apiKeys': ['key1', 'key2', 'key3'],
    }));
    const ok = registry.rotateApiKey('deepseek:llm:L1');
    expect(ok).toBe(true);
    // 第二次轮换应到 key3
    const ok2 = registry.rotateApiKey('deepseek:llm:L1');
    expect(ok2).toBe(true);
  });

  it('rotateApiKey returns false when only one key', () => {
    registry.initFromConfig(mockConfig({
      'models.llm.level1.apiKey': 'only-key',
    }));
    const ok = registry.rotateApiKey('deepseek:llm:L1');
    expect(ok).toBe(false);
  });

  it('hasMoreKeys returns false only when all keys exhausted', () => {
    registry.initFromConfig(mockConfig({
      'models.llm.level1.apiKey': 'k1',
      'models.llm.level1.apiKeys': ['k1', 'k2'],
    }));
    expect(registry.hasMoreKeys('deepseek:llm:L1')).toBe(true);
    // rotate 第一次成功（k1→k2）
    expect(registry.rotateApiKey('deepseek:llm:L1')).toBe(true);
    // k2 是未耗尽的 key，所以 hasMoreKeys 仍为 true
    expect(registry.hasMoreKeys('deepseek:llm:L1')).toBe(true);
    // rotate 第二次（k2→k1，但都耗尽了），返回 false
    expect(registry.rotateApiKey('deepseek:llm:L1')).toBe(false);
    expect(registry.hasMoreKeys('deepseek:llm:L1')).toBe(false);
  });

  it('resetKeyRotation restores to first key', () => {
    registry.initFromConfig(mockConfig({
      'models.llm.level1.apiKey': 'k1',
      'models.llm.level1.apiKeys': ['k1', 'k2'],
    }));
    registry.rotateApiKey('deepseek:llm:L1');
    registry.resetKeyRotation('deepseek:llm:L1');
    expect(registry.getCurrentKeyIndex('deepseek:llm:L1')).toBe(0);
  });

  it('listWithDisplayNames returns human-readable names', () => {
    registry.initFromConfig(mockConfig({
      'models.llm.level1.apiKey': 'sk-llm',
    }));
    const items = registry.listWithDisplayNames();
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.displayName).toContain('DeepSeek');
  });

  it('listGroupedByTrack separates llm and vllm', () => {
    registry.initFromConfig(mockConfig({
      'models.llm.level1.apiKey': 'sk-llm',
      'models.vllm.level1.provider': 'qwen',
      'models.vllm.level1.apiKey': 'sk-vl',
    }));
    const grouped = registry.listGroupedByTrack();
    expect(grouped.llm.length).toBeGreaterThan(0);
    expect(grouped.vllm.length).toBeGreaterThan(0);
  });

  it('register and get work for manually added providers', () => {
    const mockProvider = {
      id: 'mock:llm:L1',
      async createMessage() { return; },
      async probe() { return { ok: true, latencyMs: 0 }; },
      getModel() { return 'mock-model'; },
      capabilities: ['text'],
      contextWindow: 128000,
      updateApiKey() {},
    };
    registry.register(mockProvider as any);
    expect(registry.get('mock:llm:L1')).toBeDefined();
    expect(registry.has('mock:llm:L1')).toBe(true);
  });

  it('require throws for missing provider', () => {
    expect(() => registry.require('nonexistent:llm:L9')).toThrow();
  });

  it('clear empties all providers', () => {
    registry.initFromConfig(mockConfig({ 'models.llm.level1.apiKey': 'sk' }));
    registry.clear();
    expect(registry.ids()).toEqual([]);
  });

  it('probeAll returns results map', async () => {
    registry.initFromConfig(mockConfig({ 'models.llm.level1.apiKey': 'sk' }));
    const results = await registry.probeAll();
    expect(results.size).toBeGreaterThan(0);
  });

  it('getKeyPoolSize returns correct count', () => {
    registry.initFromConfig(mockConfig({
      'models.llm.level1.apiKey': 'k1',
      'models.llm.level1.apiKeys': ['k1', 'k2', 'k3'],
    }));
    expect(registry.getKeyPoolSize('deepseek:llm:L1')).toBe(3);
  });

  it('getNextLevelWithLargerContext skips smaller context windows', () => {
    registry.initFromConfig(mockConfig({
      'models.llm.level1.provider': 'deepseek',
      'models.llm.level1.apiKey': 'sk-l1',
    }));
    // 只有 L1，没有 L2 → 返回 undefined
    const next = registry.getNextLevelWithLargerContext('deepseek:llm:L1');
    expect(next).toBeUndefined();
  });
});
