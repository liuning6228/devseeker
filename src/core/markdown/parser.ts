/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Markdown 渲染器（W9.14 · DESIGN §M11.8）
 *
 * 目标：把一段 assistant 文本解析为结构化 AST，webview 层据此渲染：
 *
 *  - `[symbol](file:///C:/path/to/file.ts)` → 可点击文件链接
 *  - `[symbol](file:///C:/path/to/file.ts#L120-L140)` → 点击定位行
 *  - `[/abs/path/img.png](/abs/path/img.png)` → 内联图片
 *  - ```lang\n...\n``` fenced 代码块（Mermaid 单独一种 kind）
 *  - inline code `foo`
 *  - 粗体 **...** / 斜体 *...*
 *  - 行号前缀协议 "<6位右对齐数字>→<内容>"
 *  - `<user_query>...</user_query>` 类白名单外 XML 标签剥除（防注入）
 *
 * 设计原则：
 * 1. 纯函数 / 零外部依赖（测试无需 DOM）
 * 2. 解析失败时**优雅降级**为纯文本节点
 * 3. 识别 identity 关键词但不在此剥除（留给 identity-guard）
 */

// ─────────── 类型 ───────────

export type MdNode =
  | { type: 'text'; value: string }
  | { type: 'code_block'; lang: string; code: string; hasLineNumbers: boolean }
  | { type: 'mermaid'; code: string }
  | { type: 'inline_code'; code: string }
  | { type: 'bold'; children: MdNode[] }
  | { type: 'italic'; children: MdNode[] }
  | {
      type: 'file_link';
      label: string;
      href: string;
      path: string;
      lineStart?: number;
      lineEnd?: number;
    }
  | { type: 'image'; alt: string; src: string }
  | { type: 'link'; label: string; href: string }
  | { type: 'paragraph'; children: MdNode[] }
  // ── W9.14 新增 ──
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: MdNode[] }
  | { type: 'list'; ordered: boolean; items: MdNode[][] }
  | { type: 'table'; headers: MdNode[][][]; rows: MdNode[][][] }
  | { type: 'blockquote'; children: MdNode[] }
  | { type: 'thematic_break' };

export interface ParseOptions {
  /** 剥除白名单外的 <xxx> 标签（防提示注入）。默认 true */
  stripUnknownTags?: boolean;
}

const ALLOWED_INLINE_TAGS = new Set<string>([
  'b', 'i', 'em', 'strong', 'u', 'code', 'br', 'span',
]);

// 白名单外的"成对 / 单独"标签都剥；但保留其文本内容
const TAG_REGEX = /<\/?([a-zA-Z][a-zA-Z0-9_-]*)(\s+[^>]*)?\/?>/g;

// ─────────── 行号前缀 ───────────

/**
 * 行号前缀协议（来自 inline_line_numbers 规则 §M3.9）：
 *   "<6位右对齐数字>→<原内容>"
 * 返回剥除后的内容 + 识别到的行号数组（与输入逐行对应；无前缀的行为 undefined）
 */
export function stripLineNumberPrefix(text: string): {
  stripped: string;
  lineNumbers: Array<number | undefined>;
  hadAny: boolean;
} {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  const nums: Array<number | undefined> = [];
  let hadAny = false;
  // 正则：行首可含空格，6 位数字右对齐（实际含 1–6 位 + padded spaces），然后一个 "→"
  const re = /^(\s*)(\d{1,6})→(.*)$/;
  for (const line of lines) {
    const m = line.match(re);
    if (m) {
      nums.push(parseInt(m[2], 10));
      out.push(m[3]);
      hadAny = true;
    } else {
      nums.push(undefined);
      out.push(line);
    }
  }
  return { stripped: out.join('\n'), lineNumbers: nums, hadAny };
}

// ─────────── file:/// 链接解析 ───────────

export interface FileLinkInfo {
  /** 原始 href */
  href: string;
  /** OS 绝对路径（去 file:/// 前缀；Windows 下保留盘符） */
  path: string;
  /** 起始行（1-based） */
  lineStart?: number;
  /** 结束行（1-based；单行锚点等于 start） */
  lineEnd?: number;
}

/**
 * 解析 `file:///xxx` 以及 `file:///xxx#L12-L34` / `#L12` 格式。
 * 非 file:/// 返回 undefined。
 */
export function parseFileLink(href: string): FileLinkInfo | undefined {
  if (!/^file:\/\//i.test(href)) return undefined;
  // 拆出 #fragment
  const hashIdx = href.indexOf('#');
  const basePart = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  const frag = hashIdx >= 0 ? href.slice(hashIdx + 1) : '';
  // file:/// → ''；Windows 下常见 file:///C:/...
  let p = basePart.replace(/^file:\/\/\/?/i, '');
  try {
    p = decodeURI(p);
  } catch {
    /* 保留原样 */
  }
  // Windows 盘符：file:///C:/... → "C:/..."，保持 "/" 分隔符给上层解释
  const info: FileLinkInfo = { href, path: p };
  if (frag) {
    const m = frag.match(/^L(\d+)(?:-L(\d+))?$/i);
    if (m) {
      info.lineStart = parseInt(m[1], 10);
      info.lineEnd = m[2] ? parseInt(m[2], 10) : info.lineStart;
    }
  }
  return info;
}

// ─────────── 主解析 ───────────

/** 顶层解析：按 ``` 代码块切分，再对正文做 inline 解析 */
export function parseMarkdown(input: string, opts: ParseOptions = {}): MdNode[] {
  const stripUnknownTags = opts.stripUnknownTags ?? true;
  const text = stripUnknownTags ? stripWhitelistedTags(input) : input;

  const nodes: MdNode[] = [];
  const fence = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    // 前置文本按段落走 inline
    if (m.index > last) {
      pushParagraphs(nodes, text.slice(last, m.index));
    }
    const lang = (m[1] || '').trim().toLowerCase();
    const code = m[2];
    if (lang === 'mermaid') {
      nodes.push({ type: 'mermaid', code });
    } else {
      const hadLineNumbers = detectLineNumberPrefix(code);
      nodes.push({
        type: 'code_block',
        lang,
        code,
        hasLineNumbers: hadLineNumbers,
      });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    pushParagraphs(nodes, text.slice(last));
  }
  return nodes;
}

function detectLineNumberPrefix(code: string): boolean {
  const first3 = code.split(/\r?\n/).slice(0, 3);
  return first3.some((l) => /^\s*\d{1,6}→/.test(l));
}

// ─────────── 块级节点检测 ───────────

const HEADING_RE = /^(#{1,6})\s+(.+)$/m;
const HR_RE = /^---\s*$/;
const BLOCKQUOTE_RE = /^>\s?(.*)$/m;

/**
 * 检测并解析一个非空文本块（按 `\n\n` 切分后的一块）。
 * 返回 MdNode 或 undefined（fallback 为 paragraph）。
 */
export function parseBlock(block: string): MdNode | undefined {
  if (!block.trim()) return undefined;

  // 1) 分隔线 ---
  if (HR_RE.test(block.trim())) {
    return { type: 'thematic_break' };
  }

  // 2) 标题 ## ...
  const hMatch = block.match(HEADING_RE);
  if (hMatch) {
    const level = hMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
    // heading 的 children 只 inline 解析标题文本本身（非整块）
    const children = parseInline(hMatch[2].trim());
    if (children.length === 0) return undefined;
    return { type: 'heading', level, children };
  }

  // 3) 引用块 > ...
  if (block.startsWith('>')) {
    const lines = block.split(/\r?\n/);
    // 只取连续的 > 行
    const quoteLines: string[] = [];
    for (const line of lines) {
      const qm = line.match(BLOCKQUOTE_RE);
      if (qm) {
        quoteLines.push(qm[1]);
      } else if (line.trim() === '') {
        // 空行也允许（多段落 blockquote）
        quoteLines.push('');
      } else {
        break;
      }
    }
    if (quoteLines.length > 0) {
      const text = quoteLines.join('\n').trim();
      const children = parseInline(text);
      if (children.length > 0) {
        return { type: 'blockquote', children };
      }
    }
  }

  // 4) 列表 - / * / 1. ...
  const listLines = block.split(/\r?\n/);
  const firstLine = listLines[0].trim();
  const ulMatch = firstLine.match(/^[-*]\s+(.+)$/);
  const olMatch = firstLine.match(/^\d+\.\s+(.+)$/);
  if (ulMatch || olMatch) {
    const ordered = !!olMatch;
    const items: MdNode[][] = [];
    let currentItem: string[] = [];
    for (const line of listLines) {
      const trimmed = line.trim();
      const itemMatch = ordered
        ? trimmed.match(/^\d+\.\s+(.+)$/)
        : trimmed.match(/^[-*]\s+(.+)$/);
      if (itemMatch) {
        if (currentItem.length > 0) {
          const parsed: MdNode[] = parseInline(currentItem.join(' '));
          items.push(parsed);
          currentItem = [];
        }
        currentItem.push(itemMatch[1]);
      } else if (trimmed) {
        // 续行（列表项的多行内容）
        currentItem.push(trimmed);
      }
    }
    if (currentItem.length > 0) {
      const parsed: MdNode[] = parseInline(currentItem.join(' '));
      items.push(parsed);
    }
    if (items.length > 0) {
      return { type: 'list', ordered, items };
    }
  }

  // 5) 表格 | ... |
  const tableLines = listLines.filter((l) => l.trim());
  if (tableLines.length >= 2 && tableLines.every((l) => l.trim().startsWith('|'))) {
    const rows: MdNode[][][] = [];
    for (const line of tableLines) {
      // 按 | 切分，去头尾空字符串
      const parts = line.split('|');
      const cells: MdNode[][] = [];
      for (let i = 1; i < parts.length - 1; i++) {
        cells.push(parseInline(parts[i].trim()));
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length >= 2) {
      // 第 2 行是 `|---|---|` 分隔行，跳过
      const isSepLine = (row: MdNode[][]) =>
        row.length > 0 &&
        row.every(
          (cell) =>
            cell.length === 1 &&
            cell[0].type === 'text' &&
            /^[-:|+]+\s*$/.test(cell[0].value),
        );
      const filteredRows: MdNode[][][] = rows.filter((r, i) => i !== 1 || !isSepLine(r));
      const headers: MdNode[][][] = filteredRows.length > 0 ? [filteredRows[0]] : [];
      const body: MdNode[][][] = filteredRows.slice(1);
      return { type: 'table', headers, rows: body };
    }
  }

  return undefined; // fallback: 由调用方按 paragraph 处理
}

function pushParagraphs(out: MdNode[], chunk: string): void {
  if (!chunk) return;
  const paragraphs = chunk.split(/\n\s*\n/);
  for (const para of paragraphs) {
    if (!para.trim()) continue;
    const block = parseBlock(para);
    if (block) {
      out.push(block);
    } else {
      // fallback: 普通段落
      const children = parseInline(para);
      if (children.length === 0) continue;
      out.push({ type: 'paragraph', children });
    }
  }
}

// 预编译正则：按优先级依次匹配
// 0) 图片：[alt](/abs/path/img.(png|jpg|jpeg|webp))
// 1) 链接：[label](url)
// 2) 行内代码：`code`
// 3) 粗体：**text**
// 4) 斜体：*text*（不吃空格 *）
const INLINE_IMG = /!?\[([^\]]*?)\]\(([^)]+?\.(?:png|jpe?g|webp|gif))\)/i;
const INLINE_LINK = /\[([^\]]+?)\]\(([^)\s]+?)\)/;
const INLINE_CODE = /`([^`\n]+?)`/;
const INLINE_BOLD = /\*\*([^*\n]+?)\*\*/;
const INLINE_ITALIC = /(?<!\*)\*([^*\s][^*\n]*?)\*(?!\*)/;

interface InlineMatch {
  kind: 'img' | 'link' | 'code' | 'bold' | 'italic';
  index: number;
  length: number;
  groups: string[];
}

function firstMatch(s: string): InlineMatch | undefined {
  const tries: Array<{ kind: InlineMatch['kind']; re: RegExp }> = [
    { kind: 'img', re: INLINE_IMG },
    { kind: 'link', re: INLINE_LINK },
    { kind: 'code', re: INLINE_CODE },
    { kind: 'bold', re: INLINE_BOLD },
    { kind: 'italic', re: INLINE_ITALIC },
  ];
  let best: InlineMatch | undefined;
  for (const { kind, re } of tries) {
    const m = re.exec(s);
    if (m && (!best || m.index < best.index)) {
      best = {
        kind,
        index: m.index,
        length: m[0].length,
        groups: m.slice(1),
      };
    }
  }
  return best;
}

/** 解析一段内联文本 → MdNode[] */
export function parseInline(input: string): MdNode[] {
  const nodes: MdNode[] = [];
  let cur = input;
  while (cur.length > 0) {
    const m = firstMatch(cur);
    if (!m) {
      nodes.push({ type: 'text', value: cur });
      break;
    }
    if (m.index > 0) {
      nodes.push({ type: 'text', value: cur.slice(0, m.index) });
    }
    switch (m.kind) {
      case 'img':
        nodes.push({ type: 'image', alt: m.groups[0] ?? '', src: m.groups[1] ?? '' });
        break;
      case 'link': {
        const label = m.groups[0] ?? '';
        const href = m.groups[1] ?? '';
        const fi = parseFileLink(href);
        if (fi) {
          nodes.push({
            type: 'file_link',
            label,
            href: fi.href,
            path: fi.path,
            ...(fi.lineStart !== undefined ? { lineStart: fi.lineStart } : {}),
            ...(fi.lineEnd !== undefined ? { lineEnd: fi.lineEnd } : {}),
          });
        } else {
          nodes.push({ type: 'link', label, href });
        }
        break;
      }
      case 'code':
        nodes.push({ type: 'inline_code', code: m.groups[0] ?? '' });
        break;
      case 'bold':
        nodes.push({ type: 'bold', children: parseInline(m.groups[0] ?? '') });
        break;
      case 'italic':
        nodes.push({ type: 'italic', children: parseInline(m.groups[0] ?? '') });
        break;
    }
    cur = cur.slice(m.index + m.length);
  }
  return nodes;
}

/** 剥除白名单外的 <xxx> 标签（保留文本内容） */
function stripWhitelistedTags(s: string): string {
  return s.replace(TAG_REGEX, (whole, name: string) => {
    const tag = (name ?? '').toLowerCase();
    if (ALLOWED_INLINE_TAGS.has(tag)) return whole;
    return '';
  });
}

// ─────────── 链接安全白名单（§M11.8.2） ───────────

const SAFE_SCHEMES = [
  /^https?:\/\//i,
  /^file:\/\//i,
  /^vscode:\/\//i,
  /^command:\/\/qoder\./i,
];

export function isSafeHref(href: string): boolean {
  return SAFE_SCHEMES.some((re) => re.test(href));
}

// ─────────── Identity Guard（§M11.8.3） ───────────

/**
 * 兜底替换 assistant 文本中"我是 GPT/Claude/DeepSeek"等身份声明（M3.11）。
 * 保守规则：只替换最常见变体；触发时返回 triggered=true 供埋点使用。
 */
export function guardIdentity(text: string): { text: string; triggered: boolean } {
  // 常见英文 / 中文变体
  const patterns: RegExp[] = [
    /\b(I am|I'm)\s+(Chat\s*GPT|GPT(?:-?\d+)?|Claude(?:\s*\d+(?:\.\d+)*)?|DeepSeek(?:-V\d+)?|Gemini|Qwen|Llama|Mistral)\b/gi,
    /我\s*是\s*(ChatGPT|GPT(?:-?\d+)?|Claude|DeepSeek|Gemini|通义千问|Qwen|Llama|文心一言|混元)/g,
    /\bI\s+was\s+(?:created|made|trained|developed)\s+by\s+(?:OpenAI|Anthropic|DeepSeek|Google|Meta|Alibaba)\b/gi,
    /由\s*(OpenAI|Anthropic|DeepSeek|Google|Meta|阿里云|阿里巴巴|腾讯)\s*(开发|训练|打造)/g,
  ];
  let triggered = false;
  let out = text;
  for (const re of patterns) {
    out = out.replace(re, () => {
      triggered = true;
      return 'DevSeeker';
    });
  }
  return { text: out, triggered };
}
