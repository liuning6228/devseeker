/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * PDF 文本提取（W8.10 / DESIGN §M12.5）
 *
 * 极简实现：不引入 pdf-parse / pdfjs-dist（避免 .vsix 膨胀）。
 * 策略：
 * 1. 检测 %PDF- magic bytes
 * 2. 解压 FlateDecode 流（zlib.inflateSync）
 * 3. 从 PDF 内容流中抽取 `( text ) Tj` 和 `[ ... ] TJ` 指令中的文字
 *
 * 局限：
 * - 不支持字形 CID/ToUnicode 映射（会得到原始字节序列，非 Unicode）→ 对纯 ASCII/Latin-1 OK，对中文可能乱码
 * - 不支持加密 / 图片 / 表单 PDF
 * - 输出为"尽力而为"的文字，用于给 Agent 一个可读的摘要，不要求像素级精度
 *
 * 若提取结果过短（< 50 字符），调用方应降级为"非文本类型"提示。
 */

import { inflateSync } from 'node:zlib';

export interface PdfExtractResult {
  /** 提取的纯文本（去掉多余空白） */
  text: string;
  /** 是否认为提取成功（text.length >= 50） */
  ok: boolean;
  /** 字节大小（输入 PDF） */
  byteSize: number;
}

const PDF_MAGIC = '%PDF-';

export function isPdfContent(bytes: Uint8Array | Buffer): boolean {
  if (bytes.length < 5) return false;
  for (let i = 0; i < 5; i++) {
    if (bytes[i] !== PDF_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * 极简 PDF 文本提取。
 * 接受 Buffer/Uint8Array，返回尽力而为的文字。
 */
export function extractPdfText(buf: Uint8Array | Buffer): PdfExtractResult {
  const byteSize = buf.byteLength;
  if (!isPdfContent(buf)) {
    return { text: '', ok: false, byteSize };
  }

  const text = latin1(buf);
  const pieces: string[] = [];

  // 找到所有 "stream ... endstream" 块
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(text)) !== null) {
    const streamStart = m.index;
    // 向前找该对象的 header（/Filter /FlateDecode 标志）
    const headerStart = Math.max(0, streamStart - 500);
    const header = text.slice(headerStart, streamStart);
    const flateEncoded = /\/FlateDecode/.test(header);

    let body = m[1] ?? '';
    if (flateEncoded) {
      try {
        // 把字符转回字节再解压
        const bytes = new Uint8Array(body.length);
        for (let i = 0; i < body.length; i++) bytes[i] = body.charCodeAt(i) & 0xff;
        const decoded = inflateSync(bytes);
        body = latin1(decoded);
      } catch {
        // 解压失败 → 跳过
        continue;
      }
    }

    pieces.push(...extractTextFromContentStream(body));
  }

  // 也尝试从未加 Filter 的部分直接抓 (...)Tj 与 [..]TJ
  pieces.push(...extractTextFromContentStream(text));

  // 去重连续相同片段 + 合并空白
  const combined = pieces.join(' ').replace(/\s+/g, ' ').trim();
  return {
    text: combined,
    ok: combined.length >= 50,
    byteSize,
  };
}

/**
 * 从 PDF 内容流中抽取文字。
 * PDF 操作符：
 *  - (text) Tj
 *  - [ (a) b (c) ... ] TJ
 *  - 支持转义：\( \) \\ \n \r \t
 */
function extractTextFromContentStream(stream: string): string[] {
  const out: string[] = [];
  // ( ... ) Tj / TJ：平衡括号比较复杂，用简单扫描带转义处理
  let i = 0;
  while (i < stream.length) {
    const ch = stream[i];
    if (ch === '(') {
      // 扫描到匹配的 ')'（考虑转义和嵌套）
      let depth = 1;
      let j = i + 1;
      let buf = '';
      while (j < stream.length && depth > 0) {
        const c = stream[j]!;
        if (c === '\\' && j + 1 < stream.length) {
          const esc = stream[j + 1]!;
          if (esc === 'n') buf += '\n';
          else if (esc === 'r') buf += '\r';
          else if (esc === 't') buf += '\t';
          else if (esc === '(' || esc === ')' || esc === '\\') buf += esc;
          else buf += esc;
          j += 2;
          continue;
        }
        if (c === '(') {
          depth++;
          buf += c;
        } else if (c === ')') {
          depth--;
          if (depth === 0) break;
          buf += c;
        } else {
          buf += c;
        }
        j++;
      }
      // buf 中内容是否被 Tj/TJ 使用？向后找 20 字符内是否有 "Tj" / "TJ"
      const ahead = stream.slice(j + 1, j + 40);
      if (/^\s*(?:-?\d+\s+)*(?:\]\s*)?T[jJ]/.test(ahead) || /T[jJ]/.test(ahead)) {
        if (buf.trim()) out.push(buf);
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}

function latin1(bytes: Uint8Array | Buffer): string {
  // 尽量不改字节值 → 用 latin1 视角
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(bytes)) {
    return bytes.toString('latin1');
  }
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}
