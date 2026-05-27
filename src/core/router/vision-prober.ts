/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * VisionNeedProber —— 按图文组合分类视觉需求强度（W22）
 *
 * 纯启发式（零 LLM 调用、零延迟）：
 * - strong：需要 VLLM 精细识别（UI 设计/图表/照片/纯图无文）
 * - weak：LLM 粗略读取即可（代码/终端/日志截图）
 * - none：无图
 *
 * 路由层根据本模块的输出决定走 VLLM 轨还是 LLM 轨。
 * 不分析 priorMessages（只扫本轮用户输入 + 图片特征）。
 */

export type VisionNeed = 'strong' | 'weak' | 'none';

export interface VisionProbeResult {
  need: VisionNeed;
  signals: string[];
}

// ─────────── 信号正则 ───────────

/** 强视觉关键词：用户需要精细识别图文布局 */
const STRONG_VISION_RE =
  /(\bUI\b|布局|照片|这张图|图表|曲线|颜色|外观|界面布局|画面|图里|图片中的|diagram|chart|layout|photo\b|describe.*(ui|screen|image)|what.*(see|show)|这个.*(界面|图|表|照片))/i;

/** 弱视觉关键词：用户只是贴了图作为参考，核心是文本内容 */
const WEAK_VISION_RE =
  /(这个错误|这段代码|这个日志|贴了|复制了|看这个|读一下|提取|读出|翻译.*图|\bocr\b|这里写|写的是|attached|here('s| is)|this error|this code|extract.*(text|from.*image)|read.*(image|error|log)|what does.*(say|mean)|screenshot|screen.*(error|log|code)|this.*(screen|image|pic)|帮我看)/i;

/** 纯图无文字：true 时视为 strong（用户只发了图，没说啥） */
function hasUserText(text: string): boolean {
  return (text ?? '').trim().length > 0;
}

/** 图片长宽比超出此范围 → 可能是代码/终端截图（窄长形） */
const SCREENSHOT_ASPECT_RATIO_MIN = 0.5;
const SCREENSHOT_ASPECT_RATIO_MAX = 2.0;

/**
 * 从 image_url 的 data URL 或外部 URL 推断大致长宽比。
 * 仅做粗略估算（DataURL 含 base64 → 校验 base64 的头信息速度慢，不直接解码）。
 * 改用 url 特征启发：data:image 若无额外信息，跳过判断。
 * 外部 URL 无法推断，也跳过。
 */
function guessIsScreenshot(_url: string): boolean | undefined {
  // 当前不深度分析图片内容。URL 无法推断长宽比，返回 undefined。
  // 后续可通过 canvas/worker 做轻量分析（W22 后续优化）。
  return undefined;
}

// ─────────── 主函数 ───────────

/**
 * 分类本轮用户输入 + 图像的视觉需求强度。
 *
 * @param userInput 本轮用户文本（可能为空）
 * @param images    本轮用户上传的图片 data URL 或外部 URL 列表（可能为 undefined）
 * @returns VisionProbeResult
 */
export function classifyVisionNeed(
  userInput: string | undefined,
  images: readonly string[] | undefined,
): VisionProbeResult {
  const signals: string[] = [];
  const text = (userInput ?? '').trim();

  // 无图 → none
  if (!images || images.length === 0) {
    return { need: 'none', signals };
  }

  const hasText = hasUserText(text);

  // 纯图无文字 → strong（用户只发了图，没有说明，需要 VLLM 全面理解）
  if (!hasText) {
    signals.push('image-only');
    return { need: 'strong', signals };
  }

  // 检查强视觉信号
  if (STRONG_VISION_RE.test(text)) {
    signals.push('strong-vision-keyword');
  }

  // 检查弱视觉信号
  if (WEAK_VISION_RE.test(text)) {
    signals.push('weak-vision-keyword');
  }

  // 图片外观启发（当前不深度分析，留空位）
  const isScreenshot = guessIsScreenshot(images[0] ?? '');
  if (isScreenshot === true) {
    signals.push('screenshot-aspect');
  }

  // ─── 聚合规则 ───
  // 强信号优先
  if (signals.includes('strong-vision-keyword')) {
    return { need: 'strong', signals };
  }

  // 弱信号 → weak
  if (signals.includes('weak-vision-keyword') || signals.includes('screenshot-aspect')) {
    return { need: 'weak', signals };
  }

  // 无匹配信号但有图 → 默认 weak（保守：不浪费 VLLM 能力）
  signals.push('default-weak');
  return { need: 'weak', signals };
}
