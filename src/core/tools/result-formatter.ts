/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 行号前缀格式化（DESIGN §M9.2.1 / §M3.9）
 *
 * 格式：`<6字符右对齐行号>→<行内容>\n`
 * 行号 1-based，空格右对齐到 6 字符宽度，分隔符 U+2192。
 *
 * 此前缀仅作元数据辅助模型定位；模型生成写入内容时必须剥除。
 */

const ARROW = '\u2192'; // →
const WIDTH = 6;

export function formatWithLineNumbers(text: string, startLine = 1): string {
  const lines = text.split(/\r?\n/);
  // 若源字符串以 \n 结尾会多一个空字符串，不要输出它
  const hasTrailingNewline = text.endsWith('\n');
  const lastIdx = hasTrailingNewline ? lines.length - 1 : lines.length;
  let out = '';
  for (let i = 0; i < lastIdx; i++) {
    const num = String(startLine + i);
    const pad = num.length >= WIDTH ? num : ' '.repeat(WIDTH - num.length) + num;
    out += `${pad}${ARROW}${lines[i]}\n`;
  }
  return out;
}

/**
 * 校验字符串是否被行号前缀污染（DESIGN §M9.2.1）。
 * 返回污染的首行（1-based）或 null。
 *
 * 供 create_file / search_replace 在接收参数前防御性校验。
 */
export function detectLineNumberPrefix(text: string): number | null {
  const re = /^\s{0,6}\d+\u2192/;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i + 1;
  }
  return null;
}
