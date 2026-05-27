/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * TaskEvent re-export（单一真源在 src/shared/protocol.ts）
 *
 * 保持此模块仅做 re-export，避免 extension 与 webview-ui 类型漂移。
 */

export type { TaskEvent } from '../../shared/protocol.js';
