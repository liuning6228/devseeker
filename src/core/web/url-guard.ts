/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * URL 安全校验 —— SSRF / scheme / blocklist 防护（W6b3）
 *
 * 来源：DESIGN §M12.6
 *
 * 规则：
 * - 仅允许 http/https scheme（DESIGN §M12.7 allowSchemes）
 * - 拒绝私有/回环/链路本地/unique-local IP：
 *     127.0.0.0/8  / 10.0.0.0/8  / 172.16.0.0/12  / 192.168.0.0/16
 *     169.254.0.0/16（link-local） / 0.0.0.0/8
 *     ::1 / fc00::/7 / fe80::/10
 * - 拒绝 host === 'localhost'（及 *.localhost）
 * - 可选 blocklist（glob-lite：'*.internal.example.com'）
 */

export interface UrlGuardOptions {
  allowSchemes?: string[];
  blocklist?: string[];
}

export interface UrlGuardResult {
  ok: boolean;
  reason?: string;
  url?: URL;
}

const DEFAULT_SCHEMES = ['http:', 'https:'];

/** 解析 host 为 (type, octets)：IPv4 / IPv6 / hostname */
function classifyHost(host: string): 'ipv4' | 'ipv6' | 'hostname' {
  if (host.startsWith('[') && host.endsWith(']')) return 'ipv6';
  if (host.includes(':') && !/[a-zA-Z]/.test(host)) return 'ipv6';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'ipv4';
  return 'hostname';
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // 格式异常直接视为不可信
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isPrivateIpv6(hostRaw: string): boolean {
  const host = hostRaw.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '::1' || host === '::') return true;
  if (host.startsWith('fe80:') || /^fe[89ab]/.test(host)) return true; // link-local
  if (host.startsWith('fc') || host.startsWith('fd')) return true; // unique-local
  // IPv4-mapped (dotted): ::ffff:a.b.c.d
  const textV4 = host.match(/::ffff:([\d.]+)$/i);
  if (textV4) return isPrivateIpv4(textV4[1]!);
  // IPv4-mapped (hextet，Node 20 规范化): ::ffff:hhhh:hhhh
  const hexV4 = host.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hexV4) {
    const a = parseInt(hexV4[1]!, 16);
    const b = parseInt(hexV4[2]!, 16);
    const ipv4 = `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
    return isPrivateIpv4(ipv4);
  }
  return false;
}

function matchesBlocklistEntry(host: string, entry: string): boolean {
  if (entry.startsWith('*.')) {
    const suffix = entry.slice(1); // ".internal.example.com"
    return host === entry.slice(2) || host.endsWith(suffix);
  }
  return host === entry;
}

/**
 * 校验 URL 是否允许请求。
 *
 * @param rawUrl 待校验 URL 字符串
 * @param opts   白名单 scheme / blocklist 配置
 */
export function validateUrl(rawUrl: string, opts: UrlGuardOptions = {}): UrlGuardResult {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { ok: false, reason: 'URL 不能为空' };
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'URL 格式非法' };
  }

  const schemes = opts.allowSchemes ?? DEFAULT_SCHEMES;
  const normalizedSchemes = schemes.map((s) => (s.endsWith(':') ? s : `${s}:`));
  if (!normalizedSchemes.includes(url.protocol)) {
    return { ok: false, reason: `scheme 不允许: ${url.protocol}`, url };
  }

  const host = url.hostname.toLowerCase();
  if (!host) {
    return { ok: false, reason: 'host 为空', url };
  }

  // 本地主机名
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, reason: 'localhost 不允许', url };
  }

  const type = classifyHost(host);
  if (type === 'ipv4' && isPrivateIpv4(host)) {
    return { ok: false, reason: `私有/回环 IPv4 不允许: ${host}`, url };
  }
  if (type === 'ipv6' && isPrivateIpv6(host)) {
    return { ok: false, reason: `私有/回环 IPv6 不允许: ${host}`, url };
  }

  // blocklist
  const blocklist = opts.blocklist ?? [];
  for (const entry of blocklist) {
    if (matchesBlocklistEntry(host, entry)) {
      return { ok: false, reason: `域名被 blocklist 阻断: ${entry}`, url };
    }
  }

  return { ok: true, url };
}

/** 仅用于测试的导出（非公开 API） */
export const __internal__ = { classifyHost, isPrivateIpv4, isPrivateIpv6, matchesBlocklistEntry };
