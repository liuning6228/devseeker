/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W15.4b · Inline Edit 历史记录
 *
 * 持久化最近的 Inline Edit 操作，供下次触发时展示建议。
 * 存储在 VS Code globalState（memento），跨会话保留。
 */

/** 单条历史记录 */
export interface InlineEditRecord {
  /** 相对文件路径 */
  filePath: string;
  /** 选区起始行（1-based） */
  startLine: number;
  /** 选区结束行（1-based） */
  endLine: number;
  /** 选区代码快照（前 500 字符） */
  snippetPreview: string;
  /** 用户输入的修改指令（前 200 字符） */
  userPrompt?: string;
  /** 时间戳 */
  timestamp: number;
}

/** memento 中存储的 key */
const STORAGE_KEY = 'devSeeker.inlineEditHistory.v1';
/** 最大保留条数 */
const MAX_RECORDS = 50;

/**
 * InlineEditHistory —— VS Code globalState 持久化
 *
 * 用法：
 *   const hist = new InlineEditHistory(memento);
 *   hist.record({ filePath: 'src/foo.ts', startLine: 10, endLine: 15, snippetPreview: '...', userPrompt: 'add error handling' });
 *   const recent = hist.getRecent('src/foo.ts');  // 按文件筛选
 *   const allRecent = hist.getRecent();             // 全局最近
 */
export class InlineEditHistory {
  constructor(private readonly memento: { get: <T>(key: string, defaultValue?: T) => T | undefined; update: (key: string, value: unknown) => Thenable<void> }) {}

  /** 追加一条记录（自动去重同 filePath+startLine+endLine 的旧条目） */
  async record(entry: Omit<InlineEditRecord, 'timestamp'>): Promise<void> {
    const records = this.load();
    // 去重：同文件同位置只保留最新
    const dedupKey = `${entry.filePath}:${entry.startLine}:${entry.endLine}`;
    const filtered = records.filter((r) => `${r.filePath}:${r.startLine}:${r.endLine}` !== dedupKey);
    filtered.push({ ...entry, timestamp: Date.now() });
    // 按时间倒序排列，保留最新 MAX_RECORDS 条
    filtered.sort((a, b) => b.timestamp - a.timestamp);
    const toSave = filtered.slice(0, MAX_RECORDS);
    await this.memento.update(STORAGE_KEY, toSave);
  }

  /** 获取最近记录，可选按文件路径筛选 */
  getRecent(filePath?: string, limit?: number): InlineEditRecord[] {
    let records = this.load();
    if (filePath) {
      records = records.filter((r) => r.filePath === filePath);
    }
    if (limit && limit > 0) {
      records = records.slice(0, limit);
    }
    return records;
  }

  /** 清空所有历史 */
  async clear(): Promise<void> {
    await this.memento.update(STORAGE_KEY, []);
  }

  // ── 内部 ──

  private load(): InlineEditRecord[] {
    return this.memento.get<InlineEditRecord[]>(STORAGE_KEY) ?? [];
  }
}
