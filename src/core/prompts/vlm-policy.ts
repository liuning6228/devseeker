/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * VLM Policy 组装器 · W13.3 Phase 3 中文视觉识别强化
 *
 * 轻量模块：仅根据是否含图返回预格式化的 `<vlm_policy>` 块，无 I/O、无探测。
 * 与 ecosystem-probe（需 fs）形成对比——VLM 触发条件来自调用方（panel/loop）
 * 显式知晓的 `images.length > 0`，不需要自行侦察。
 *
 * 注入点：由调用方填入 `L3AttachmentsInput.vlmOcrPolicy`；
 * 顺序紧随 ecosystem（两者性质都是"条件启用的领域策略"）。
 */
import { VLM_OCR_POLICY_MODULE } from './modules/vlm-ocr-policy.js';

/** 块外层标签，便于模型识别区段边界与下游字节级断言。 */
const VLM_POLICY_TAG_OPEN = '<vlm_policy kind="ocr">';
const VLM_POLICY_TAG_CLOSE = '</vlm_policy>';

/**
 * 根据调用方是否含图决定是否产出 VLM OCR policy 块。
 *
 * @param hasVision 当前轮（或 session 首轮）是否包含图像 ContentPart
 * @returns 含图 → `<vlm_policy kind="ocr">MODULE</vlm_policy>`；无图 → `''`
 */
export function buildVlmOcrBlock(hasVision: boolean): string {
  if (!hasVision) return '';
  return `${VLM_POLICY_TAG_OPEN}\n${VLM_OCR_POLICY_MODULE}\n${VLM_POLICY_TAG_CLOSE}`;
}

export { VLM_OCR_POLICY_MODULE };
