/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Image Clamp（DESIGN §M2.5 · W2.5 / B-P2-6）
 *
 * 「两阶段图像降维」工具：
 *   阶段 1 · 字节判定：解析 DataURL，算出实际字节数。≤ maxBytes 直接透传。
 *   阶段 2 · 像素降维：> maxBytes 时通过可选的 `sharp` 依赖降维到 maxEdge，
 *                     重编码为 jpeg(quality 85)；若 sharp 不可用则抛出
 *                     `ImageOversizedError`，由上游转化为任务错误事件。
 *
 * 设计原因：
 *   - Qwen-VL 限制单张图 ≤ 10MB，超限请求会返回 400 并消耗 token 预算
 *   - 旧实现直接 passthrough，大图会打挂 Provider
 *   - 降维实现理想上需要 sharp（native binary），但不强制依赖，改为**可选**
 *     dynamic import；未安装时明确提示用户执行安装命令
 *
 * 约定：
 *   - 默认 maxBytes = 6 MB（留 40% 余量应对 base64 膨胀与 HTTP 开销）
 *   - 默认 maxEdge = 1536（长边；短边按比例缩放，保持 ratio）
 */

export interface ClampImageOptions {
  /** 允许的字节上限（二进制字节，不含 base64 膨胀），默认 6 * 1024 * 1024 */
  maxBytes?: number;
  /** 允许的最大边长（像素），默认 1536 */
  maxEdge?: number;
  /** 降维后 jpeg 质量，默认 85 */
  quality?: number;
}

export class ImageOversizedError extends Error {
  constructor(
    public readonly mime: string,
    public readonly bytes: number,
    public readonly maxBytes: number,
  ) {
    super(
      `Image oversized: mime=${mime} bytes=${bytes} > maxBytes=${maxBytes}. ` +
        `Install optional dependency "sharp" to enable automatic downscaling: ` +
        `npm i sharp (or pnpm add sharp). See DESIGN §M2.5.`,
    );
    this.name = 'ImageOversizedError';
  }
}

export interface ParsedDataUrl {
  mime: string;
  base64: string;
  bytes: number;
}

/** 解析 `data:image/xxx;base64,YYY`。非 data: 协议（http/https）返回 undefined。 */
export function parseDataUrl(url: string): ParsedDataUrl | undefined {
  if (!url.startsWith('data:')) return undefined;
  const comma = url.indexOf(',');
  if (comma < 0) return undefined;
  const header = url.slice(5, comma); // 去掉 "data:"
  const payload = url.slice(comma + 1);
  const parts = header.split(';');
  const mime = parts[0] || 'application/octet-stream';
  const isBase64 = parts.includes('base64');
  if (!isBase64) {
    // 非 base64 data URL（罕见），用字节长度估算
    return { mime, base64: '', bytes: payload.length };
  }
  // base64 解码后字节数 ≈ len * 3/4，再扣 padding
  const padCount = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((payload.length * 3) / 4) - padCount;
  return { mime, base64: payload, bytes };
}

/**
 * 检查并（必要时）降维图片 DataURL。
 *
 * - 非 data: URL 直接返回（externally hosted，不动）
 * - ≤ maxBytes 直接返回
 * - > maxBytes：尝试 dynamic import("sharp") 降维；失败抛 `ImageOversizedError`
 */
export async function clampImage(
  url: string,
  opts: ClampImageOptions = {},
): Promise<string> {
  const maxBytes = opts.maxBytes ?? 6 * 1024 * 1024;
  const maxEdge = opts.maxEdge ?? 1536;
  const quality = opts.quality ?? 85;

  const parsed = parseDataUrl(url);
  if (!parsed) return url; // 外部 URL：不动
  if (parsed.bytes <= maxBytes) return url;

  // 需降维：尝试动态加载 sharp
  let sharp: unknown;
  try {
    sharp = (await import('sharp' as string)).default;
  } catch {
    throw new ImageOversizedError(parsed.mime, parsed.bytes, maxBytes);
  }

  const sharpFn = sharp as (
    input: Buffer,
  ) => {
    resize: (opts: { width: number; height: number; fit: string; withoutEnlargement: boolean }) => {
      jpeg: (opts: { quality: number }) => { toBuffer: () => Promise<Buffer> };
    };
  };

  const inputBuffer = Buffer.from(parsed.base64, 'base64');
  const outBuffer = await sharpFn(inputBuffer)
    .resize({
      width: maxEdge,
      height: maxEdge,
      fit: 'inside', // 保持长宽比，长边 = maxEdge
      withoutEnlargement: true, // 小图不放大
    })
    .jpeg({ quality })
    .toBuffer();

  return `data:image/jpeg;base64,${outBuffer.toString('base64')}`;
}

/**
 * 批量处理：对 images 数组逐张 clampImage。
 * 遇 `ImageOversizedError` 继续尝试其余图片，最后聚合所有失败返回。
 */
export async function clampImages(
  urls: readonly string[],
  opts: ClampImageOptions = {},
): Promise<{ ok: string[]; failed: ImageOversizedError[] }> {
  const ok: string[] = [];
  const failed: ImageOversizedError[] = [];
  for (const u of urls) {
    try {
      ok.push(await clampImage(u, opts));
    } catch (e) {
      if (e instanceof ImageOversizedError) {
        failed.push(e);
      } else {
        // sharp 原生模块处理无效图片格式时抛出 Error，也视为降级失败
        failed.push(new ImageOversizedError('unknown', 0, opts.maxBytes ?? 0));
      }
    }
  }
  return { ok, failed };
}
