/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 测试用 PDF 构造 helper —— 生成 pdfjs-dist 可解析的合法最小 PDF（含 xref 表）。
 *
 * 注意：文件名不含 .test 后缀，避免被 vitest 收集为用例文件。
 * 正文限制：
 * - ASCII 且不含 ( ) \ 等需要转义的字符
 * - 采用 10pt 小字号：pdfjs 提取时会裁剪超出页面可见区域（MediaBox）的文本，
 *   24pt 下约 50 字符即被截断，小字号可让长文本完整落在页内
 */

/**
 * 构造合法的最小多页 PDF。
 *
 * 对象布局：
 * - 1: Catalog / 2: Pages
 * - 每页两个对象：Page（3+2i）、Contents（4+2i）
 * - 末尾：Font（3+2n）
 *
 * @param texts 每页一段正文；空字符串 = 空白页（无文本层，用于图片 PDF 场景）
 */
export function buildValidPdf(texts: string[]): Buffer {
  const n = Math.max(1, texts.length);
  const chunks: string[] = [];
  let offset = 0;
  const offsets: number[] = [];

  const push = (s: string): void => {
    chunks.push(s);
    offset += Buffer.byteLength(s, 'latin1');
  };
  const addObj = (num: number, body: string): void => {
    offsets[num - 1] = offset;
    push(`${num} 0 obj\n${body}\nendobj\n`);
  };

  push('%PDF-1.4\n');

  const pageObjNums: number[] = [];
  for (let i = 0; i < n; i++) pageObjNums.push(3 + i * 2);
  const kids = pageObjNums.map((num) => `${num} 0 R`).join(' ');
  const fontObjNum = 3 + 2 * n;

  addObj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  addObj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);

  for (let i = 0; i < n; i++) {
    const pageNum = 3 + i * 2;
    const contentNum = pageNum + 1;
    const text = texts[i] ?? '';
    const contentStream = text ? `BT /F1 10 Tf 72 720 Td (${text}) Tj ET` : '';
    addObj(
      pageNum,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNum} 0 R /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> >>`,
    );
    addObj(contentNum, `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`);
  }

  addObj(fontObjNum, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const size = fontObjNum + 1;
  const xrefStart = offset;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let num = 1; num < size; num++) {
    xref += `${String(offsets[num - 1]).padStart(10, '0')} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  return Buffer.from(chunks.join(''), 'latin1');
}
