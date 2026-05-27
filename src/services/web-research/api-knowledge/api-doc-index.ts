/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * ApiDocIndex —— 中文前端框架 API 文档预索引（§8.16.2）
 *
 * 职责：
 * - 加载 Element Plus / Ant Design Vue / Vue 3 官方中文 API 文档的预打包索引
 * - Agent 检测到 `el-` / `a-` 前缀时自动加载对应框架知识
 * - 注入到 system prompt L2 层
 *
 * 数据文件：media/api-knowledge/*.jsonl（每行一条 JSON）
 * 数据文件不随仓库提交，需通过爬取或手动维护生成。
 */

export interface ApiDocEntry {
  /** 符号名，如 "ElButton"、"ElTableColumn" */
  symbol: string;
  /** 框架前缀，如 "el-", "a-", "v-" */
  prefix: string;
  /** 所属框架，如 "element-plus", "ant-design-vue", "vue3" */
  framework: string;
  /** 官方文档中文 URL（来源） */
  sourceUrl: string;
  /** API 说明（中文，~200 字以内） */
  description: string;
  /** 属性列表（可选） */
  props?: Array<{ name: string; type: string; description: string }>;
  /** 事件列表（可选） */
  events?: Array<{ name: string; payload: string; description: string }>;
  /** 标签关键词，用于检索 */
  tags: string[];
}

interface ApiDocEntryRaw {
  symbol: string;
  prefix: string;
  framework: string;
  sourceUrl: string;
  description: string;
  props?: Array<{ name: string; type: string; description: string }>;
  events?: Array<{ name: string; payload: string; description: string }>;
  tags: string[];
}

/**
 * 中文 API 文档索引。
 * 全局单例，懒加载（首次查询时才加载数据文件）。
 */
export class ApiDocIndex {
  private entries: ApiDocEntry[] = [];
  private symbolIndex = new Map<string, ApiDocEntry[]>();
  private prefixIndex = new Map<string, string[]>(); // prefix → symbol list
  private loaded = false;
  private extUri: string | undefined;

  /**
   * 设置扩展资源路径（由 extension.ts 在激活时通过 context.extensionUri 传入）。
   */
  setExtensionUri(uri: string): void {
    this.extUri = uri;
  }

  /**
   * 从 media/api-knowledge/*.jsonl 加载索引。
   * 全局单例，懒加载（首次查询时才加载）。
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    const files = ['element-plus.jsonl', 'ant-design-vue.jsonl', 'vue3.jsonl'];
    const allEntries: ApiDocEntryRaw[] = [];

    for (const file of files) {
      try {
        const content = await this.readDataFile(file);
        if (!content) continue;
        for (const line of content.split('\n').filter(Boolean)) {
          try {
            const parsed = JSON.parse(line) as ApiDocEntryRaw;
            allEntries.push(parsed);
          } catch {
            // 跳过单行 JSON 解析失败
          }
        }
      } catch {
        // 文件不存在 → 跳过
      }
    }

    this.entries = allEntries;

    // 构建符号索引
    this.symbolIndex.clear();
    for (const entry of this.entries) {
      const existing = this.symbolIndex.get(entry.symbol) ?? [];
      existing.push(entry);
      this.symbolIndex.set(entry.symbol, existing);
    }

    // 构建前缀索引
    this.prefixIndex.clear();
    for (const entry of this.entries) {
      const existing = this.prefixIndex.get(entry.prefix) ?? [];
      if (!existing.includes(entry.symbol)) {
        existing.push(entry.symbol);
        this.prefixIndex.set(entry.prefix, existing);
      }
    }
  }

  /** 是否已加载 */
  isLoaded(): boolean {
    return this.loaded;
  }

  /** 根据符号名查询 API 文档 */
  findBySymbol(symbol: string): ApiDocEntry[] {
    return this.symbolIndex.get(symbol) ?? [];
  }

  /** 根据标签查询 */
  findByTag(tag: string): ApiDocEntry[] {
    return this.entries.filter(e => e.tags.includes(tag));
  }

  /**
   * 检测 content 中出现的框架前缀，返回已检测到的前缀列表。
   */
  detectPrefixes(content: string): string[] {
    const detected: string[] = [];
    for (const prefix of this.prefixIndex.keys()) {
      // 匹配 el-button、a-table 等标签
      const regex = new RegExp(`(?:<|\\b)${escapeRegex(prefix)}(?:\\w|-)`, 'g');
      if (regex.test(content)) {
        detected.push(prefix);
      }
    }
    return detected;
  }

  /**
   * 获取匹配的前缀对应的 API 条目摘要。
   * 格式：<api_knowledge framework="element-plus" count="12">...</api_knowledge>
   */
  getKnowledgeSummary(prefixes: string[]): string {
    const matched: ApiDocEntry[] = [];
    for (const p of prefixes) {
      const symbols = this.prefixIndex.get(p) ?? [];
      for (const sym of symbols) {
        const entries = this.findBySymbol(sym);
        for (const e of entries) {
          if (!matched.find(m => m.symbol === e.symbol && m.framework === e.framework)) {
            matched.push(e);
          }
        }
      }
    }

    if (matched.length === 0) return '';

    // 按 framework 分组
    const groups = new Map<string, ApiDocEntry[]>();
    for (const e of matched) {
      const g = groups.get(e.framework) ?? [];
      g.push(e);
      groups.set(e.framework, g);
    }

    const blocks: string[] = [];
    for (const [framework, entries] of groups) {
      const lines = entries.slice(0, 15).map(e =>
        `${e.symbol}: ${e.description.slice(0, 80)}`,
      );
      if (entries.length > 15) lines.push(`…及 ${entries.length - 15} 个 API`);
      blocks.push(`<api_knowledge framework="${framework}" count="${entries.length}">\n${lines.join('\n')}\n</api_knowledge>`);
    }

    return blocks.join('\n');
  }

  /** 读取数据文件内容（从 extension media 目录或打包路径） */
  private async readDataFile(fileName: string): Promise<string | undefined> {
    const { join } = await import('node:path');
    const { promises: fs } = await import('node:fs');

    // 尝试多个可能路径
    const candidates = [
      this.extUri ? join(this.extUri, 'media', 'api-knowledge', fileName) : undefined,
      join(process.cwd(), 'media', 'api-knowledge', fileName),
      join(process.cwd(), '..', 'media', 'api-knowledge', fileName),
    ].filter(Boolean) as string[];

    for (const p of candidates) {
      try {
        return await fs.readFile(p, 'utf-8');
      } catch {
        continue;
      }
    }
    return undefined;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 全局单例 */
export const apiDocIndex = new ApiDocIndex();
