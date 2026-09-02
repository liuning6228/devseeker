/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MODEL_CONTEXT_WINDOWS,
  resolveContextWindowForModel,
} from '../../src/providers/model-config.js';
import {
  ProviderRegistry,
  __resetProviderRegistryForTest,
} from '../../src/providers/registry.js';
import { initLogger, closeLogger, __resetLoggerForTest } from '../../src/infra/logger.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** 造一个 mock vscode.WorkspaceConfiguration（与 provider-registry.test.ts 同构） */
function mockConfig(overrides: Record<string, unknown> = {}): any {
  const data: Record<string, unknown> = { ...overrides };
  return {
    get: (key: string, def?: unknown) => data[key] ?? def,
    has: (key: string) => key in data,
    inspect: <T>(key: string) => {
      if (!(key in data)) {
        return { globalValue: undefined, defaultValue: undefined, workspaceValue: undefined, workspaceFolderValue: undefined };
      }
      return { globalValue: data[key] as T, defaultValue: undefined, workspaceValue: undefined, workspaceFolderValue: undefined };
    },
  };
}

describe('resolveContextWindowForModel', () => {
  it('精确匹配 Qwen 大上下文模型', () => {
    expect(resolveContextWindowForModel('qwen3.8-max')).toBe(1_000_000);
    expect(resolveContextWindowForModel('qwen3.7-plus')).toBe(1_000_000);
    expect(resolveContextWindowForModel('qwen-max')).toBe(1_000_000);
  });

  it('精确匹配 Qwen 视觉模型（32K）', () => {
    expect(resolveContextWindowForModel('qwen-vl-max')).toBe(32_000);
    expect(resolveContextWindowForModel('qwen-vl-max-latest')).toBe(32_000);
  });

  it('前缀通配匹配日期快照模型', () => {
    expect(resolveContextWindowForModel('deepseek-v4-pro-0813')).toBe(1_000_000);
    expect(resolveContextWindowForModel('deepseek-v4-flash-0901')).toBe(1_000_000);
    expect(resolveContextWindowForModel('deepseek-v4-pro')).toBe(1_000_000);
  });

  it('未命中返回 undefined（保留 Provider 类默认值）', () => {
    expect(resolveContextWindowForModel('qwen3-8b')).toBeUndefined();
    expect(resolveContextWindowForModel('glm-5.2')).toBeUndefined();
    expect(resolveContextWindowForModel('unknown-model')).toBeUndefined();
    expect(resolveContextWindowForModel('')).toBeUndefined();
    expect(resolveContextWindowForModel(undefined)).toBeUndefined();
  });

  it('映射表键合法：数字为正且通配键以 * 结尾', () => {
    for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
      if (key.endsWith('*')) {
        expect(key.length).toBeGreaterThan(1);
      }
    }
  });
});

describe('ProviderRegistry contextWindow 推断', () => {
  let logDir: string;

  beforeEach(() => {
    __resetLoggerForTest();
    __resetProviderRegistryForTest();
    logDir = join(tmpdir(), `dualmind-ctx-test-${randomUUID()}`);
    mkdirSync(logDir, { recursive: true });
    initLogger({ logDir, level: 'info' });
  });

  afterEach(async () => {
    await closeLogger();
    __resetLoggerForTest();
    __resetProviderRegistryForTest();
    try { rmSync(logDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('qwen provider 选 qwen3.8-max：未显式配置 → 按映射表推断为 1M', () => {
    const registry = new ProviderRegistry();
    registry.initFromConfig(mockConfig({
      'models.llm.level1.provider': 'qwen',
      'models.llm.level1.model': 'qwen3.8-max',
      'models.llm.level1.apiKey': 'sk-test',
    }));
    const provider = registry.get('qwen:llm:L1');
    expect(provider).toBeDefined();
    expect(provider!.contextWindow).toBe(1_000_000);
  });

  it('qwen provider 选 deepseek-v4-pro-0813（token-plan 托管）：前缀通配推断为 1M', () => {
    const registry = new ProviderRegistry();
    registry.initFromConfig(mockConfig({
      'models.llm.level1.provider': 'qwen',
      'models.llm.level1.model': 'deepseek-v4-pro-0813',
      'models.llm.level1.apiKey': 'sk-test',
    }));
    const provider = registry.get('qwen:llm:L1');
    expect(provider).toBeDefined();
    expect(provider!.contextWindow).toBe(1_000_000);
  });

  it('qwen provider 选 qwen-vl-max：映射表保持 32K（视觉模型）', () => {
    const registry = new ProviderRegistry();
    registry.initFromConfig(mockConfig({
      'models.vllm.level1.provider': 'qwen',
      'models.vllm.level1.model': 'qwen-vl-max',
      'models.vllm.level1.apiKey': 'sk-test',
    }));
    const provider = registry.get('qwen:vllm:L1');
    expect(provider).toBeDefined();
    expect(provider!.contextWindow).toBe(32_000);
  });

  it('用户显式配置 contextWindow 优先于映射表', () => {
    const registry = new ProviderRegistry();
    registry.initFromConfig(mockConfig({
      'models.llm.level1.provider': 'qwen',
      'models.llm.level1.model': 'qwen3.8-max',
      'models.llm.level1.apiKey': 'sk-test',
      'models.llm.level1.contextWindow': 65536,
    }));
    const provider = registry.get('qwen:llm:L1');
    expect(provider).toBeDefined();
    expect(provider!.contextWindow).toBe(65_536);
  });

  it('deepseek provider 未被映射表改变类默认 1M', () => {
    const registry = new ProviderRegistry();
    registry.initFromConfig(mockConfig({
      'models.llm.level1.provider': 'deepseek',
      'models.llm.level1.model': 'deepseek-v4-flash',
      'models.llm.level1.apiKey': 'sk-test',
    }));
    const provider = registry.get('deepseek:llm:L1');
    expect(provider).toBeDefined();
    expect(provider!.contextWindow).toBe(1_000_000);
  });
});
