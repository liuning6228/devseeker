/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * C7 · Preview Bridge 协议（B-P1-2）
 *
 * 场景：用户本机 dev server 通过 `<script src="https://raw…/preview-bridge.sample.js">`
 *      或自行集成在页面里，实现 postMessage 桥接回 DualMind 父 webview。
 *
 * 安全：
 *  - 父 → 子 postMessage 只对 **允许的目标 origin** 发送（即 validatePreviewUrl 过的 origin）
 *  - 子 → 父 message 监听必须校验 `event.origin` 与 `event.data.source`，并要求 nonce 匹配
 *  - nonce 每次「启动 Inspect」会话重生成，避免重放
 *
 * 消息类型：
 *  父 → 子：
 *    - inspect:start  { nonce }     开启元素拾取
 *    - inspect:stop   { nonce }     关闭
 *    - ping           { nonce }     健康检查
 *  子 → 父：
 *    - inspect:picked { nonce, payload: DomPickedPayload }
 *    - inspect:cancelled { nonce }
 *    - pong           { nonce }
 *    - ready          {}            （无 nonce）页面加载完成宣告 bridge 在线
 */

export const BRIDGE_SOURCE = 'dualMind-preview-bridge';

export type BridgeType =
  | 'inspect:start'
  | 'inspect:stop'
  | 'inspect:picked'
  | 'inspect:cancelled'
  | 'ping'
  | 'pong'
  | 'ready';

export interface DomPickedPayload {
  /** CSS selector（桥接脚本尽量稳定生成，nth-child fallback） */
  selector: string;
  /** 标签名 */
  tag: string;
  /** outerHTML 截断后（最多 4KB） */
  outerHTML: string;
  /** 内部文本（最多 2KB） */
  text?: string;
  /** 可见矩形（页面坐标） */
  rect?: { x: number; y: number; w: number; h: number };
  /** 所在页面 URL */
  pageUrl: string;
}

export interface BridgeMessage {
  source: typeof BRIDGE_SOURCE;
  type: BridgeType;
  nonce?: string;
  payload?: DomPickedPayload;
}

// ─────────── 纯函数解析 ───────────

/** 严格解析外来的 postMessage，包含 origin 白名单与 schema 校验；失败返回 null。 */
export function parseIncomingBridgeMessage(
  evOrigin: string,
  evData: unknown,
  expectedOrigin: string,
): BridgeMessage | null {
  if (!evOrigin || evOrigin !== expectedOrigin) return null;
  if (!evData || typeof evData !== 'object') return null;
  const d = evData as Record<string, unknown>;
  if (d.source !== BRIDGE_SOURCE) return null;
  const type = d.type;
  if (typeof type !== 'string') return null;
  const allowed: BridgeType[] = [
    'inspect:start',
    'inspect:stop',
    'inspect:picked',
    'inspect:cancelled',
    'ping',
    'pong',
    'ready',
  ];
  if (!allowed.includes(type as BridgeType)) return null;
  const msg: BridgeMessage = { source: BRIDGE_SOURCE, type: type as BridgeType };
  if (typeof d.nonce === 'string') msg.nonce = d.nonce;
  if (type === 'inspect:picked') {
    const p = d.payload;
    if (!p || typeof p !== 'object') return null;
    const pr = p as Record<string, unknown>;
    if (
      typeof pr.selector !== 'string' ||
      typeof pr.tag !== 'string' ||
      typeof pr.outerHTML !== 'string' ||
      typeof pr.pageUrl !== 'string'
    ) {
      return null;
    }
    const payload: DomPickedPayload = {
      selector: String(pr.selector).slice(0, 512),
      tag: String(pr.tag).slice(0, 32),
      outerHTML: String(pr.outerHTML).slice(0, 4 * 1024),
      pageUrl: String(pr.pageUrl).slice(0, 2 * 1024),
    };
    if (typeof pr.text === 'string') payload.text = String(pr.text).slice(0, 2 * 1024);
    if (pr.rect && typeof pr.rect === 'object') {
      const r = pr.rect as Record<string, unknown>;
      if (
        typeof r.x === 'number' &&
        typeof r.y === 'number' &&
        typeof r.w === 'number' &&
        typeof r.h === 'number'
      ) {
        payload.rect = { x: r.x, y: r.y, w: r.w, h: r.h };
      }
    }
    msg.payload = payload;
  }
  return msg;
}

/** 把 DomPickedPayload 格式化为 Markdown，供主 chat 面板 prefill */
export function formatDomPickedForChat(p: DomPickedPayload): string {
  const rect = p.rect
    ? `rect=[x=${p.rect.x},y=${p.rect.y},w=${p.rect.w},h=${p.rect.h}]`
    : '';
  const head = `请基于以下 DOM 元素回答/修改（来自 ${p.pageUrl}）：`;
  const meta = [`- selector: \`${p.selector}\``, `- tag: \`${p.tag}\``, rect && `- ${rect}`]
    .filter(Boolean)
    .join('\n');
  const text = p.text ? `\n\n内部文本：\n\n\`\`\`\n${p.text}\n\`\`\`` : '';
  const html = `\n\nouterHTML：\n\n\`\`\`html\n${p.outerHTML}\n\`\`\``;
  return `${head}\n\n${meta}${text}${html}\n`;
}

/** 生成一个 hex nonce（16 字节） */
export function genBridgeNonce(): string {
  // 不在测试里调 crypto.getRandomValues 的原因：此函数仅在 extension host 调
  // 单测不直接依赖这里。
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
