/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

import { describe, it, expect } from 'vitest';
import {
  parseDataUrl,
  clampImage,
  clampImages,
  ImageOversizedError,
} from '../../src/core/image/image-clamp.js';

// 构造一个 1 KB 的 base64 DataURL（小图，不会触发降维）
function makeSmallDataUrl(): string {
  const buf = Buffer.alloc(1024, 0xff);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

// 构造一个"伪装"大于 maxBytes 的 DataURL（实际 bytes 由 parseDataUrl 解析出）
function makeOversizedDataUrl(bytes: number): string {
  const buf = Buffer.alloc(bytes, 0xaa);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

describe('image-clamp · parseDataUrl', () => {
  it('解析 data:image/png;base64 头部', () => {
    const url = makeSmallDataUrl();
    const p = parseDataUrl(url);
    expect(p).toBeDefined();
    expect(p!.mime).toBe('image/png');
    expect(p!.bytes).toBe(1024);
    expect(p!.base64.length).toBeGreaterThan(0);
  });

  it('非 data: 协议返回 undefined', () => {
    expect(parseDataUrl('https://example.com/a.png')).toBeUndefined();
    expect(parseDataUrl('file:///x.png')).toBeUndefined();
  });

  it('没有逗号的畸形 DataURL 返回 undefined', () => {
    expect(parseDataUrl('data:image/png;base64')).toBeUndefined();
  });

  it('bytes 计算包含 base64 padding 校正', () => {
    // "Zm9vYg==" 对应 "foob" 4 字节
    const url = 'data:text/plain;base64,Zm9vYg==';
    const p = parseDataUrl(url);
    expect(p!.bytes).toBe(4);
  });
});

describe('image-clamp · clampImage', () => {
  it('非 data: URL 原样返回', async () => {
    const url = 'https://example.com/x.png';
    expect(await clampImage(url)).toBe(url);
  });

  it('≤ maxBytes 的小图原样返回', async () => {
    const url = makeSmallDataUrl();
    expect(await clampImage(url, { maxBytes: 100 * 1024 })).toBe(url);
  });

  it('> maxBytes 且非 PNG 字节时抛出错误（sharp 校验或 ImageOversizedError 回退）', async () => {
    // 构造 2KB 随机字节标记为 image/png → sharp 环境会报"unsupported"，无 sharp 抛 ImageOversizedError
    const url = makeOversizedDataUrl(2048);
    // 接受两种行为之一
    await expect(clampImage(url, { maxBytes: 1024 })).rejects.toThrow();
  });

  it('ImageOversizedError 结构（sharp 不可用时）', () => {
    // 直接测类型结构，不依赖 sharp
    const err = new ImageOversizedError('image/png', 2048, 1024);
    expect(err.mime).toBe('image/png');
    expect(err.bytes).toBe(2048);
    expect(err.maxBytes).toBe(1024);
    expect(err.message).toContain('sharp');
  });
});

describe('image-clamp · clampImages 批量', () => {
  it('全部 ok 时 failed 为空', async () => {
    const urls = [makeSmallDataUrl(), makeSmallDataUrl()];
    const { ok, failed } = await clampImages(urls, { maxBytes: 100 * 1024 });
    expect(ok.length).toBe(2);
    expect(failed.length).toBe(0);
  });

  it('混合大小图时不短路（小图通过、大图失败或降维）', async () => {
    const urls = [
      makeSmallDataUrl(),
      makeOversizedDataUrl(2048),
      makeSmallDataUrl(),
      makeOversizedDataUrl(3072),
    ];
    const { ok, failed } = await clampImages(urls, { maxBytes: 1024 });
    // 小图应该通过
    expect(ok.length).toBeGreaterThanOrEqual(2);
    // 所有结果合并应等于输入数
    expect(ok.length + failed.length).toBe(urls.length);
  });
});
