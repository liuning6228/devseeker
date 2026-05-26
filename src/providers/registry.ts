/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Provider Registry — 基于 LLM/VLLM 双轨 3 级降级链的动态 Provider 管理
 *
 * 重写自旧版硬编码 4 Provider 结构，核心变化：
 * - Provider 实例从 3 级配置动态创建（同一 ProviderType 可创建多个实例）
 * - LLM/VLLM 双轨独立管理
 * - ProviderId 格式：`{provider}:{track}:L{level}`（如 `deepseek:llm:L1`）
 * - 兼容旧版扁平配置（自动迁移）
 */

import * as vscode from 'vscode';
import type { IProvider } from './base.js';
import type { ProbeResult, ProviderId } from './types.js';
import { DeepSeekProvider } from './deepseek.js';
import { OpenAIProvider } from './openai.js';
import { QwenVLProvider } from './qwen-vl.js';
import { AnthropicProvider } from './anthropic.js';
import { AgentError, ErrorCodes } from '../core/errors/index.js';
import { getLogger } from '../infra/logger.js';
import { LatencyProbe } from './latency-probe.js';
import {
  type ProviderType,
  type ModelLevel,
  type ModelLevelConfig,
  type ModelTrackConfig,
  type ModelsConfig,
  type LegacyFlatConfig,
  PROVIDER_DEFAULTS,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_MODELS,
  getLevelProviderId,
  resolveBaseUrl,
  resolveModel,
  resolveReasoningModel,
  hasValidCredentials,
  resolveApiKeys,
  flattenLevels,
  migrateFromLegacyFlat,
} from './model-config.js';

const log = getLogger('provider.registry');

// ─────────── Provider 工厂 ───────────

/** 根据 ProviderType + 配置 创建 IProvider 实例 */
function buildProvider(
  providerType: ProviderType,
  levelConfig: ModelLevelConfig,
  providerId: ProviderId,
  track: 'llm' | 'vllm',
): IProvider {
  const apiKey = levelConfig.apiKey ?? '';
  const baseUrl = resolveBaseUrl(levelConfig);
  const model = resolveModel(levelConfig, track);
  const reasoningModel = resolveReasoningModel(levelConfig);

  switch (providerType) {
    case 'deepseek':
      return new DeepSeekProvider({
        apiKey: apiKey || 'placeholder',
        baseUrl: baseUrl !== PROVIDER_DEFAULTS.deepseek.baseUrl ? baseUrl : undefined,
        model: model !== PROVIDER_DEFAULTS.deepseek.model ? model : undefined,
        reasoningModel,
      });

    case 'openai':
      return new OpenAIProvider({
        apiKey: apiKey || 'placeholder',
        baseUrl: baseUrl !== PROVIDER_DEFAULTS.openai.baseUrl ? baseUrl : undefined,
        model: model !== PROVIDER_DEFAULTS.openai.model ? model : undefined,
      });

    case 'qwen':
      return new QwenVLProvider({
        apiKey: apiKey || 'placeholder',
        baseUrl: baseUrl !== PROVIDER_DEFAULTS.qwen.baseUrl ? baseUrl : undefined,
        model: model !== PROVIDER_DEFAULTS.qwen.model ? model : undefined,
      });

    case 'qwen-code':
      return new OpenAIProvider({
        apiKey: apiKey || 'placeholder',
        baseUrl: baseUrl !== PROVIDER_DEFAULTS['qwen-code'].baseUrl ? baseUrl : undefined,
        model: model !== PROVIDER_DEFAULTS['qwen-code'].model ? model : undefined,
      });

    case 'anthropic':
      return new AnthropicProvider({
        apiKey: apiKey || 'placeholder',
        baseUrl: baseUrl !== PROVIDER_DEFAULTS.anthropic.baseUrl ? baseUrl : undefined,
        model: model !== PROVIDER_DEFAULTS.anthropic.model ? model : undefined,
      });

    case 'openrouter':
      return new OpenAIProvider({
        apiKey: apiKey || 'placeholder',
        baseUrl: baseUrl !== PROVIDER_DEFAULTS.openrouter.baseUrl ? baseUrl : undefined,
        model: model !== PROVIDER_DEFAULTS.openrouter.model ? model : undefined,
      });

    case 'ollama':
      return new OpenAIProvider({
        apiKey: 'ollama-local',
        baseUrl,
        model,
      });

    case 'custom-openai':
      return new OpenAIProvider({
        apiKey: apiKey || 'placeholder',
        baseUrl,
        model,
      });

    default:
      throw new AgentError({
        code: ErrorCodes.PROVIDER_MODEL_NOT_FOUND,
        message: `Unknown provider type: ${providerType}`,
      });
  }
}

/**
 * 覆盖 Provider 实例的 id 为新的 3 级格式。
 * 因为子类构造时 id 是固定的，我们通过 Object.defineProperty 覆盖。
 */
function buildProviderWithId(
  providerType: ProviderType,
  levelConfig: ModelLevelConfig,
  track: 'llm' | 'vllm',
  level: ModelLevel,
): IProvider | null {
  const providerId = getLevelProviderId(providerType, level, track);

  // 即使没 apiKey 也注册 Provider（用 placeholder key），
  // 保证 UI 面板和 getDefaultProvider 能正确识别 L1。
  // 实际请求时若 key 无效会报错引导用户配置。
  const hasCredentials = hasValidCredentials(levelConfig);
  if (!hasCredentials) {
    log.debug(
      { provider: providerType, track, level },
      'Registering provider without valid credentials (placeholder)',
    );
  }

  try {
    const provider = buildProvider(providerType, levelConfig, providerId, track);
    // 覆盖 id 为 3 级格式（通过 BaseProvider setter）
    provider.id = providerId;
    // 覆盖 contextWindow（用户在 Settings 中配置了非零值时覆盖 Provider 默认值）
    const customCtx = levelConfig.contextWindow;
    if (customCtx && customCtx > 0) {
      Object.defineProperty(provider, 'contextWindow', { value: customCtx, writable: false, configurable: true });
    }
    log.info({ providerId, model: resolveModel(levelConfig, track), hasCredentials, contextWindow: provider.contextWindow }, 'Provider registered');
    return provider;
  } catch (e) {
    log.error(
      { err: String(e), providerType, track, level },
      'Failed to build provider',
    );
    return null;
  }
}

// ─────────── ProviderRegistry ───────────

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, IProvider>();
  /** 当前加载的 ModelsConfig 快照（用于判断是否需要重新加载） */
  private loadedConfigHash = '';

  // ─────────── P1-1: API Key 轮换状态 ───────────

  /** 每个 ProviderId 对应的所有可用 API Key 列表 */
  private readonly apiKeyPool = new Map<ProviderId, string[]>();
  /** 每个 ProviderId 当前使用的 Key 索引 */
  private readonly apiKeyIndex = new Map<ProviderId, number>();

  /** 记录某个 ProviderId 在当前 Key 上是否已被 429/overloaded 拒绝 */
  private readonly keyExhausted = new Map<ProviderId, Set<number>>();

  /** §8.16.3 · 网络延迟探测器（延迟初始化） */
  private readonly latencyProbe = new LatencyProbe();

  /**
   * 从 VSCode 配置初始化 Provider。
   * 优先读新版 dualMind.models.* 配置；
   * 若不存在则回退读旧版扁平配置并自动迁移。
   */
  initFromConfig(config: vscode.WorkspaceConfiguration): void {
    this.providers.clear();
    this.apiKeyPool.clear();
    this.apiKeyIndex.clear();
    this.keyExhausted.clear();
    this.loadedConfigHash = '';

    const modelsConfig = this.readModelsConfig(config);

    // 注册 LLM 轨
    for (const { level, config: levelConfig } of flattenLevels(modelsConfig.llm)) {
      const provider = buildProviderWithId(levelConfig.provider, levelConfig, 'llm', level);
      if (provider) {
        this.providers.set(provider.id, provider);
        // P1-1: 注册 Key 池
        const keys = resolveApiKeys(levelConfig);
        if (keys.length > 0) {
          this.apiKeyPool.set(provider.id, keys);
          this.apiKeyIndex.set(provider.id, 0);
        }
      }
    }

    // 注册 VLLM 轨
    for (const { level, config: levelConfig } of flattenLevels(modelsConfig.vllm)) {
      const provider = buildProviderWithId(levelConfig.provider, levelConfig, 'vllm', level);
      if (provider) {
        this.providers.set(provider.id, provider);
        // P1-1: 注册 Key 池
        const keys = resolveApiKeys(levelConfig);
        if (keys.length > 0) {
          this.apiKeyPool.set(provider.id, keys);
          this.apiKeyIndex.set(provider.id, 0);
        }
      }
    }

    const count = this.providers.size;
    log.info({ providerCount: count }, `ProviderRegistry initialized with ${count} providers`);
  }

  /**
   * 从 VSCode 配置读取 ModelsConfig。
   * 优先新版结构；但需要验证用户是否真正配置了新格式（而非仅命中默认值）。
   * 判断条件：新版 L1 的 provider 有值 **且** 有有效凭证（apiKey/apiKeys 非空）。
   * 若新格式有 provider 但无凭证，且旧格式有凭证 → 走旧版迁移。
   */
  readModelsConfigPublic(config: vscode.WorkspaceConfiguration): ModelsConfig {
    return this.readModelsConfig(config);
  }

  private readModelsConfig(config: vscode.WorkspaceConfiguration): ModelsConfig {
    // 尝试读新版配置 — 检查所有轨所有级是否有凭证
    // 旧逻辑只检查 LLM L1，导致用户通过 ModelConfigPanel 配 L2/L3 时仍走 legacy
    const hasNewConfigWithCredentials = this.checkNewConfigCredentials(config);

    if (hasNewConfigWithCredentials) {
      log.info('Using new model config format (models.llm/vllm.level*)');
      return {
        llm: this.readTrackConfig(config, 'llm'),
        vllm: this.readTrackConfig(config, 'vllm'),
      };
    }

    // 检查是否有新格式的 provider 配置（即使没有凭证）
    const hasAnyNewProvider = this.checkAnyNewProvider(config);

    // 新格式有 provider 但无凭证 → 检查旧格式是否有凭证
    const hasLegacyCredentials = !!(config.get<string>('deepseek.apiKey')?.trim()
      || config.get<string>('openai.apiKey')?.trim()
      || config.get<string>('qwenVl.apiKey')?.trim()
      || config.get<string>('anthropic.apiKey')?.trim());

    if (hasAnyNewProvider && !hasNewConfigWithCredentials && !hasLegacyCredentials) {
      // 新旧都没有凭证 → 仍走新格式（让 UI 引导用户配新格式）
      log.warn('New config has provider but no API key; no legacy config either. Returning new config with placeholder credentials.');
      return {
        llm: this.readTrackConfig(config, 'llm'),
        vllm: this.readTrackConfig(config, 'vllm'),
      };
    }

    // 回退旧版配置 + 自动迁移
    log.info('Falling back to legacy flat config (dualMind.deepseek.* / openai.* / qwenVl.* / anthropic.*), will auto-migrate to new 3-level format');
    const legacy: LegacyFlatConfig = {
      deepseek: {
        apiKey: config.get<string>('deepseek.apiKey'),
        baseUrl: config.get<string>('deepseek.baseUrl'),
        model: config.get<string>('deepseek.model'),
      },
      openai: {
        apiKey: config.get<string>('openai.apiKey'),
        baseUrl: config.get<string>('openai.baseUrl'),
        model: config.get<string>('openai.model'),
      },
      qwenVl: {
        apiKey: config.get<string>('qwenVl.apiKey'),
        baseUrl: config.get<string>('qwenVl.baseUrl'),
        model: config.get<string>('qwenVl.model'),
      },
      anthropic: {
        apiKey: config.get<string>('anthropic.apiKey'),
        baseUrl: config.get<string>('anthropic.baseUrl'),
        model: config.get<string>('anthropic.model'),
      },
      defaultProvider: config.get<string>('defaultProvider'),
    };
    return migrateFromLegacyFlat(legacy);
  }

  /** 检查新格式配置中是否有任何轨任何级的凭证 */
  private checkNewConfigCredentials(config: vscode.WorkspaceConfiguration): boolean {
    for (const track of ['llm', 'vllm'] as const) {
      for (let level = 1; level <= 3; level++) {
        const prefix = `models.${track}.level${level}`;
        const provider = config.get<string>(`${prefix}.provider`)?.trim();
        const apiKey = config.get<string>(`${prefix}.apiKey`)?.trim();
        const apiKeys = config.get<string[]>(`${prefix}.apiKeys`);
        if (provider && (apiKey || (apiKeys && apiKeys.length > 0))) {
          return true;
        }
      }
    }
    return false;
  }

  /** 检查新格式配置中是否有任何 provider 配置（无论有无凭证） */
  private checkAnyNewProvider(config: vscode.WorkspaceConfiguration): boolean {
    for (const track of ['llm', 'vllm'] as const) {
      for (let level = 1; level <= 3; level++) {
        const provider = config.get<string>(`models.${track}.level${level}.provider`)?.trim();
        if (provider) return true;
      }
    }
    return false;
  }

  /** 从 VSCode 配置读取单轨（LLM 或 VLLM）的 3 级配置 */
  private readTrackConfig(config: vscode.WorkspaceConfiguration, track: 'llm' | 'vllm'): ModelTrackConfig {
    const level1 = this.readLevelConfig(config, track, 1);
    const level2 = this.readLevelConfig(config, track, 2);
    const level3 = this.readLevelConfig(config, track, 3);

    return {
      level1,
      ...(level2 ? { level2 } : {}),
      ...(level3 ? { level3 } : {}),
    };
  }

  /** 从 VSCode 配置读取单级配置；provider 为空则返回 undefined */
  private readLevelConfig(
    config: vscode.WorkspaceConfiguration,
    track: 'llm' | 'vllm',
    level: ModelLevel,
  ): ModelLevelConfig {
    const prefix = `models.${track}.level${level}`;
    const provider = config.get<string>(`${prefix}.provider`)?.trim() as ProviderType | undefined;

    if (!provider) {
      // Level 1 必填，返回占位（引导用户配置）
      const defaultProvider = track === 'llm' ? 'deepseek' : 'qwen';
      const defaults = PROVIDER_DEFAULTS[defaultProvider];
      return {
        provider: defaultProvider,
        model: track === 'vllm' && defaults.vllmModel ? defaults.vllmModel : defaults.model,
      };
    }

    return {
      provider,
      model: config.get<string>(`${prefix}.model`)?.trim() || PROVIDER_DEFAULTS[provider].model,
      apiKey: config.get<string>(`${prefix}.apiKey`)?.trim() || undefined,
      apiKeys: config.get<string[]>(`${prefix}.apiKeys`)?.filter((k) => k?.trim()) || undefined,
      baseUrl: config.get<string>(`${prefix}.baseUrl`)?.trim() || undefined,
      reasoningModel: config.get<string>(`${prefix}.reasoningModel`)?.trim() || undefined,
      contextWindow: config.get<number>(`${prefix}.contextWindow`) || undefined,
    };
  }

  /** 运行时注册（测试用 / MCP Provider 用） */
  register(provider: IProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: ProviderId): IProvider | undefined {
    return this.providers.get(id);
  }

  /** 必须存在，否则抛 AgentError */
  require(id: ProviderId): IProvider {
    const p = this.providers.get(id);
    if (!p) {
      throw new AgentError({
        code: ErrorCodes.PROVIDER_MODEL_NOT_FOUND,
        message: `Provider "${id}" not registered. Check your model configuration.`,
        userMessage: `模型 "${id}" 未注册，请在设置中配置对应级别的 Provider。`,
      });
    }
    return p;
  }

  list(): IProvider[] {
    return Array.from(this.providers.values());
  }

  ids(): ProviderId[] {
    return Array.from(this.providers.keys());
  }

  /** UI 下拉展示用：返回已注册 Provider 的 id + displayName */
  listWithDisplayNames(): Array<{ id: ProviderId; displayName: string }> {
    const out: Array<{ id: ProviderId; displayName: string }> = [];
    for (const [id, provider] of this.providers) {
      // 从 id 解析 provider type 和 level
      const parts = id.split(':');
      const providerType = parts[0] as ProviderType;
      const track = parts[1] || 'llm';
      const levelStr = parts[2] || 'L1';
      const levelNum = parseInt(levelStr.replace('L', ''), 10);
      const levelLabel = levelNum === 1 ? '主力' : levelNum === 2 ? '备选' : '兜底';
      const trackLabel = track === 'vllm' ? 'VLLM' : 'LLM';
      const providerLabel = PROVIDER_DISPLAY_NAMES[providerType] ?? providerType;

      out.push({
        id,
        displayName: `${providerLabel} (${trackLabel} ${levelLabel})`,
      });
    }
    return out;
  }

  /**
   * P1-2: 按双轨分组返回 Provider 列表（新版 UI 使用）。
   * 包含 level 和 keyPoolSize 信息，便于 UI 展示降级链结构。
   */
  listGroupedByTrack(): {
    llm: Array<{ id: ProviderId; displayName: string; level: number; keyPoolSize: number }>;
    vllm: Array<{ id: ProviderId; displayName: string; level: number; keyPoolSize: number }>;
  } {
    const llm: Array<{ id: ProviderId; displayName: string; level: number; keyPoolSize: number }> = [];
    const vllm: Array<{ id: ProviderId; displayName: string; level: number; keyPoolSize: number }> = [];

    for (const [id] of this.providers) {
      const parts = id.split(':');
      const providerType = parts[0] as ProviderType;
      const track = (parts[1] || 'llm') as 'llm' | 'vllm';
      const levelStr = parts[2] || 'L1';
      const levelNum = parseInt(levelStr.replace('L', ''), 10);
      const levelLabel = levelNum === 1 ? '主力' : levelNum === 2 ? '备选' : '兜底';
      const providerLabel = PROVIDER_DISPLAY_NAMES[providerType] ?? providerType;

      const entry = {
        id,
        displayName: `${providerLabel} (${levelLabel})`,
        level: levelNum,
        keyPoolSize: this.getKeyPoolSize(id),
      };

      if (track === 'vllm') {
        vllm.push(entry);
      } else {
        llm.push(entry);
      }
    }

    // 按 level 排序
    const sort = (a: { level: number }, b: { level: number }) => a.level - b.level;
    llm.sort(sort);
    vllm.sort(sort);

    return { llm, vllm };
  }

  has(id: ProviderId): boolean {
    return this.providers.has(id);
  }

  /**
   * 获取指定轨的默认 Provider。
   * 优先返回有凭证的 L1；若 L1 无凭证则返回该轨任意有凭证的 Level；
   * 若都没有凭证则返回 L1（占位，请求时会报错引导配置）。
   *
   * §8.16.3 · 在返回前对后台做网络延迟探测（非阻塞），
   * 若延迟 >200ms 且存在同一 Provider 的 CN 端点配置，标记日志。
   * 实际降级由调用方在 createMessage 时通过 ProbedLatencyTier 决定。
   */
  getDefaultProvider(track: 'llm' | 'vllm' = 'llm'): IProvider | undefined {
    // 1. 查找该轨有凭证的 L1
    for (const [id, provider] of this.providers) {
      if (id.includes(`:${track}:L1`) && this.hasValidKey(provider.id)) {
        // §8.16.3 · 网络感知：后台探测延迟，仅在 poor 时记录告警
        this.probeLatencyDeferred(provider).catch(() => {});
        return provider;
      }
    }
    // 2. L1 没凭证 → 找该轨任意有凭证的 Level
    for (const [id, provider] of this.providers) {
      if (id.includes(`:${track}:`) && this.hasValidKey(provider.id)) {
        this.probeLatencyDeferred(provider).catch(() => {});
        return provider;
      }
    }
    // 3. 都没凭证 → 返回 L1（占位）
    for (const [id, provider] of this.providers) {
      if (id.includes(`:${track}:L1`)) {
        return provider;
      }
    }
    // 4. 完全没有 → 任意第一个
    const first = this.providers.values().next();
    return first.done ? undefined : first.value;
  }

  /**
   * §8.16.3 · 后台网络延迟探测（fire-and-forget）。
   * 对 Provider 的 base URL 做 HEAD 延迟探测，仅在 poor 时记录告警。
   */
  private async probeLatencyDeferred(provider: IProvider): Promise<void> {
    const url = this.resolveProbeUrl(provider);
    if (!url) return;
    try {
      const result = await this.latencyProbe.probe(url);

      // poor：延迟 >200ms，记录告警日志
      // moderate（50-200ms）：记录 info，不告警
      // good：跳过
      if (result.tier === 'poor') {
        log.warn(
          { providerId: provider.id, latencyMs: result.latencyMs },
          '[LatencyProbe] Network latency is poor, consider switching to CN endpoint',
        );
      } else if (result.tier === 'moderate') {
        log.info(
          { providerId: provider.id, latencyMs: result.latencyMs },
          '[LatencyProbe] Network latency is moderate, key rotation may help',
        );
      }
    } catch {
      // 静默失败，不阻塞主流程
    }
  }

  /** 检查 Provider 是否有有效的 API Key（非 placeholder） */
  private hasValidKey(providerId: ProviderId): boolean {
    const pool = this.apiKeyPool.get(providerId);
    return !!pool && pool.length > 0;
  }

  /**
   * 获取指定轨的下一个 Level Provider（降级用）。
   * 跳过不满足能力约束或无有效凭证的级别。
   * 若下一级均无凭证，返回 undefined（调用方应继续使用当前 Provider 重试）。
   * @param currentProviderId 当前失败的 Provider id
   * @param requiredCapabilities 需要的能力（如 ['tool-use']），默认不限制
   * @returns 下一个 Level 的 Provider，或 undefined（已到底）
   */
  getNextLevel(currentProviderId: ProviderId, requiredCapabilities?: string[]): IProvider | undefined {
    const parts = currentProviderId.split(':');
    if (parts.length < 3) return undefined;

    const track = parts[1] as 'llm' | 'vllm';
    const currentLevel = parseInt(parts[2].replace('L', ''), 10) as ModelLevel;

    if (currentLevel >= 3) return undefined; // 已到底

    // 从下一级开始找有凭证 + 满足能力的 Provider
    for (let l = currentLevel + 1; l <= 3; l++) {
      for (const [id, provider] of this.providers) {
        if (
          id.includes(`:${track}:L${l}`) &&
          this.hasValidKey(id) &&
          this.meetsCapabilities(provider, requiredCapabilities)
        ) {
          return provider;
        }
      }
    }

    return undefined;
  }

  /**
   * 获取指定轨的下一个 Level Provider，且上下文窗口不小于当前 Provider。
   *
   * C7: context_overflow 时不应降级到更小上下文窗口的模型。
   * 如果下一级模型的上下文窗口更小，降级过去也会 overflow。
   *
   * @param currentProviderId 当前失败的 Provider id
   * @param requiredCapabilities 需要的能力（如 ['tool-use']）
   * @returns 上下文窗口 >= 当前 Provider 的下一级 Provider，或 undefined
   */
  getNextLevelWithLargerContext(
    currentProviderId: ProviderId,
    requiredCapabilities?: string[],
  ): IProvider | undefined {
    const currentProvider = this.providers.get(currentProviderId);
    if (!currentProvider) return undefined;

    const minContextWindow = currentProvider.contextWindow;

    const parts = currentProviderId.split(':');
    if (parts.length < 3) return undefined;
    const track = parts[1] as 'llm' | 'vllm';
    const currentLevel = parseInt(parts[2].replace('L', ''), 10) as ModelLevel;

    for (let l = currentLevel + 1; l <= 3; l++) {
      for (const [id, provider] of this.providers) {
        if (
          id.includes(`:${track}:L${l}`) &&
          this.hasValidKey(id) &&
          provider.contextWindow >= minContextWindow &&
          this.meetsCapabilities(provider, requiredCapabilities)
        ) {
          return provider;
        }
      }
    }

    return undefined;
  }

  /** 检查 Provider 是否满足所需能力 */
  private meetsCapabilities(provider: IProvider, required?: string[]): boolean {
    if (!required || required.length === 0) return true;
    return required.every((cap) => provider.capabilities.includes(cap as any));
  }

  /**
   * 批量并行 probe。单个 Provider 失败不影响其他。
   */
  async probeAll(): Promise<Map<ProviderId, ProbeResult>> {
    const entries = Array.from(this.providers.entries());
    const results = await Promise.all(
      entries.map(async ([id, p]): Promise<[ProviderId, ProbeResult]> => {
        try {
          const r = await p.probe();
          return [id, r];
        } catch (e) {
          return [
            id,
            {
              ok: false,
              latencyMs: 0,
              error: {
                code: ErrorCodes.INTERNAL_UNKNOWN,
                message: e instanceof Error ? e.message : String(e),
                retryable: false,
                providerId: id,
              },
            },
          ];
        }
      }),
    );
    return new Map(results);
  }

  clear(): void {
    this.providers.clear();
    this.apiKeyPool.clear();
    this.apiKeyIndex.clear();
    this.keyExhausted.clear();
  }

  // ─────────── P1-1: API Key 轮换 ───────────

  /**
   * 尝试轮换指定 Provider 的 API Key。
   * 当收到 429/overloaded 时调用，优先在同级内换 Key 重试。
   *
   * @returns true 表示成功轮换到新 Key，false 表示所有 Key 已耗尽
   */
  rotateApiKey(providerId: ProviderId): boolean {
    const pool = this.apiKeyPool.get(providerId);
    if (!pool || pool.length <= 1) return false; // 只有 0 或 1 个 Key，无法轮换

    const currentIndex = this.apiKeyIndex.get(providerId) ?? 0;
    // 标记当前 Key 已耗尽
    let exhausted = this.keyExhausted.get(providerId);
    if (!exhausted) {
      exhausted = new Set();
      this.keyExhausted.set(providerId, exhausted);
    }
    exhausted.add(currentIndex);

    // 查找下一个未耗尽的 Key
    for (let i = 1; i <= pool.length; i++) {
      const nextIndex = (currentIndex + i) % pool.length;
      if (!exhausted.has(nextIndex)) {
        this.apiKeyIndex.set(providerId, nextIndex);
        const provider = this.providers.get(providerId);
        if (provider) {
          provider.updateApiKey(pool[nextIndex]);
          log.info(
            { providerId, keyIndex: nextIndex, totalKeys: pool.length },
            'API Key rotated (same level)',
          );
        }
        return true;
      }
    }

    // 所有 Key 都已耗尽
    log.warn({ providerId, totalKeys: pool.length }, 'All API Keys exhausted for this level');
    return false;
  }

  /**
   * 检查指定 Provider 是否还有未尝试的 Key 可轮换。
   */
  hasMoreKeys(providerId: ProviderId): boolean {
    const pool = this.apiKeyPool.get(providerId);
    if (!pool || pool.length <= 1) return false;

    const exhausted = this.keyExhausted.get(providerId);
    if (!exhausted) return true; // 还没开始轮换，有 Key 可用

    return exhausted.size < pool.length;
  }

  /**
   * 重置指定 Provider 的 Key 轮换状态（成功请求后调用）。
   * 下次 429 时重新从第一个 Key 开始轮换。
   */
  resetKeyRotation(providerId: ProviderId): void {
    this.keyExhausted.delete(providerId);
    this.apiKeyIndex.set(providerId, 0);

    // 恢复到第一个 Key
    const pool = this.apiKeyPool.get(providerId);
    const provider = this.providers.get(providerId);
    if (pool && pool.length > 0 && provider) {
      provider.updateApiKey(pool[0]);
    }
  }

  /**
   * 获取指定 Provider 当前使用的 Key 索引（调试/监控用）。
   */
  getCurrentKeyIndex(providerId: ProviderId): number {
    return this.apiKeyIndex.get(providerId) ?? 0;
  }

  /**
   * 获取指定 Provider 的 Key 池大小（调试/监控用）。
   */
  getKeyPoolSize(providerId: ProviderId): number {
    return this.apiKeyPool.get(providerId)?.length ?? 0;
  }

  /**
   * §8.16.3 · 从 Provider 推断探测用的 base URL。
   * 各 Provider 实现类中 baseUrl 为 protected/private，无法通过接口访问。
   * 此处从 provider.id 推导端点 URL（不构造真实请求，仅用于 HEAD 延迟探测）。
   */
  private resolveProbeUrl(provider: IProvider): string | undefined {
    const providerType = provider.id.split(':')[0];
    switch (providerType) {
      case 'deepseek':
        return 'https://api.deepseek.com/v1';
      case 'openai':
        return 'https://api.openai.com/v1';
      case 'qwen':
      case 'qwen-code':
        return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
      case 'anthropic':
        return 'https://api.anthropic.com/v1';
      default:
        return undefined;
    }
  }
}

/** 进程级单例 */
let globalRegistry: ProviderRegistry | null = null;

export function getProviderRegistry(): ProviderRegistry {
  if (!globalRegistry) globalRegistry = new ProviderRegistry();
  return globalRegistry;
}

/** 测试用：重置单例 */
export function __resetProviderRegistryForTest(): void {
  globalRegistry = null;
}
