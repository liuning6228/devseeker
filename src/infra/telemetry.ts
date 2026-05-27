/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Telemetry —— 可选的匿名使用统计上报
 *
 * 设计原则：
 * - **Opt-in**：默认完全关闭，用户通过 `devSeeker.telemetry.enabled` 显式开启
 * - **仅匿名**：不收集个人身份信息、文件内容、API Key
 * - **仅事件**：不收集连续追踪数据（如光标位置、频率）
 * - **可审计**：发送的内容可在 log 中查看（debug 级别）
 *
 * 集成方式：
 * - 使用 VS Code 官方 telemetryReporter（https://github.com/microsoft/vscode-extension-telemetry）
 * - 在 activate() 时初始化，用户修改配置时刷新开关
 *
 * 收集的字段（示例，商业化时根据合规要求调整）：
 * - 扩展版本、VSCode 版本、平台（OS）
 * - 功能激活计数：面板打开次数、工具调用次数、模式切换次数
 * - 不收集：API Key、文件路径、代码内容、模型输出
 */

import { getLogger } from './logger.js';

const log = getLogger('telemetry');

export interface TelemetryEvent {
  /** 事件名，如 'panel.open' / 'tool.call' / 'mode.switch' */
  name: string;
  /** 可选的数字属性（如耗时 ms） */
  measurements?: Record<string, number>;
  /** 可选的字符串属性（如模式名、版本） */
  properties?: Record<string, string | undefined>;
}

export interface TelemetryReporter {
  /** 发送事件（仅在启用时实际发出） */
  sendTelemetryEvent(event: TelemetryEvent): void;
  /** 发送异常（仅在启用时发出） */
  sendTelemetryException(error: Error, properties?: Record<string, string | undefined>): void;
  /** 释放资源 */
  dispose(): Promise<void>;
}

/** 空实现：遥测关闭时使用，零开销 */
class NoopReporter implements TelemetryReporter {
  sendTelemetryEvent(_event: TelemetryEvent): void {
    // noop
  }
  sendTelemetryException(_error: Error, _properties?: Record<string, string | undefined>): void {
    // noop
  }
  async dispose(): Promise<void> {
    // noop
  }
}

/** 文件系统日志实现：dev 模式下将事件写入日志文件（不发送网络） */
class DevLogReporter implements TelemetryReporter {
  private prefix: string;

  constructor(appVersion: string) {
    this.prefix = `[telemetry-dev] v${appVersion}`;
  }

  sendTelemetryEvent(event: TelemetryEvent): void {
    log.debug({ event }, `${this.prefix} event: ${event.name}`);
  }

  sendTelemetryException(error: Error, properties?: Record<string, string | undefined>): void {
    log.debug({ err: error.message, properties }, `${this.prefix} exception`);
  }

  async dispose(): Promise<void> {
    // noop
  }
}

let activeReporter: TelemetryReporter = new NoopReporter();

/**
 * 初始化遥测。应在扩展 activate() 中调用。
 * @param enabled 用户设置中 telemetry.enabled 的值
 * @param appVersion 当前扩展版本
 */
export function initTelemetry(enabled: boolean, appVersion: string): TelemetryReporter {
  if (!enabled) {
    activeReporter = new NoopReporter();
  } else if (process.env.NODE_ENV === 'development' || process.env.DUALMIND_DEV) {
    activeReporter = new DevLogReporter(appVersion);
  } else {
    // 生产启用时：应在此集成 vscode-extension-telemetry 或自定义 HTTP 上报
    // 当前用 DevLogReporter 占位
    activeReporter = new DevLogReporter(appVersion);
    log.info('[telemetry] Telemetry enabled (production reporter not yet configured, using dev log)');
  }
  log.info({ enabled, reporter: activeReporter.constructor.name }, 'Telemetry initialized');
  return activeReporter;
}

/** 获取当前上报器（供全局使用） */
export function getTelemetryReporter(): TelemetryReporter {
  return activeReporter;
}

/** 关闭遥测 */
export async function disposeTelemetry(): Promise<void> {
  await activeReporter.dispose();
  activeReporter = new NoopReporter();
}

/**
 * 测试用：重置为 noop
 */
export function __resetTelemetryForTest(): void {
  activeReporter = new NoopReporter();
}

/**
 * 创建带公共属性的 TelemetryEvent 快捷方法。
 * @param name 事件名
 * @param props 额外属性
 */
export function telemetryEvent(
  name: string,
  props?: Record<string, string | undefined>,
  measurements?: Record<string, number>,
): TelemetryEvent {
  return { name, properties: props, measurements };
}

// ─────────── VS Code 配置 key ───────────
/** 用户设置中遥测开关的配置路径 */
export const TELEMETRY_CONFIG_KEY = 'devSeeker.telemetry.enabled';
