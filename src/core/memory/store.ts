/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * MemoryStore —— 分类记忆存储层（W4 批次 2）
 *
 * 存储格式：每条记忆一行 JSON（JSONL），便于追加写、避免整表重写风险
 * 默认路径：
 * - workspace scope: `<workspaceRoot>/.dualmind/memories.jsonl`
 * - global scope:    `<os.homedir()>/.dualmind/memories.jsonl`
 *
 * 工具层不直接操作文件，全部经由 MemoryStore 方法。
 *
 * 并发：单进程内通过内存 Map 缓存，写入整表覆盖一次（原子）。
 */

import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ALL_CATEGORIES, isValidCategory, isWritableCategory } from './categories.js';
import type { MemoryCategory } from './categories.js';
import type { MemoryRecord, MemoryScope } from './types.js';
import { AgentError, ErrorCodes } from '../errors/index.js';
import type { Embedder } from '../index/embedder.js';

export interface MemoryStoreOptions {
  /** workspace scope 的根目录（可选；不提供则不支持 workspace 作用域） */
  workspaceRoot?: string;
  /** global scope 的根目录（默认 os.homedir()） */
  globalRoot?: string;
  /** 自定义文件名（默认 memories.jsonl） */
  fileName?: string;
  /** v1.8.0：可选 embedder，用于写入时自动计算 _embedding */
  embedder?: Embedder;
}

const DEFAULT_FILE = 'memories.jsonl';
const DEFAULT_DIR = '.dualmind';

export class MemoryStore {
  private readonly workspacePath: string | undefined;
  private readonly globalPath: string;
  private readonly embedder: Embedder | undefined;
  /** 缓存：id → record */
  private records = new Map<string, MemoryRecord>();
  private loaded = false;

  constructor(opts: MemoryStoreOptions) {
    const file = opts.fileName ?? DEFAULT_FILE;
    this.workspacePath = opts.workspaceRoot
      ? path.join(opts.workspaceRoot, DEFAULT_DIR, file)
      : undefined;
    const globalDir = opts.globalRoot ?? process.env.HOME ?? process.env.USERPROFILE ?? '.';
    this.globalPath = path.join(globalDir, DEFAULT_DIR, file);
    this.embedder = opts.embedder;
  }

  /** 懒加载：按需读取两个 JSONL 文件到内存 */
  async load(): Promise<void> {
    if (this.loaded) return;
    const all: MemoryRecord[] = [];
    if (this.workspacePath) {
      all.push(...(await readJsonl(this.workspacePath)));
    }
    all.push(...(await readJsonl(this.globalPath)));
    // 规范化 + 去重（以 id 为键，后者覆盖前者：workspace 在前，被 global 同 id 覆盖）
    for (const r of all) {
      if (this.isValidRecord(r)) {
        this.records.set(r.id, r);
      }
    }
    this.loaded = true;
  }

  /** 列出（按 scope/category 过滤，可选） */
  async list(filter?: { scope?: MemoryScope; category?: MemoryCategory }): Promise<MemoryRecord[]> {
    await this.load();
    const out: MemoryRecord[] = [];
    for (const r of this.records.values()) {
      if (filter?.scope && r.scope !== filter.scope) continue;
      if (filter?.category && r.category !== filter.category) continue;
      out.push(r);
    }
    // 按 updatedAt 倒序
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  async getById(id: string): Promise<MemoryRecord | undefined> {
    await this.load();
    return this.records.get(id);
  }

  /** 创建新记忆 */
  async create(input: {
    title: string;
    content: string;
    category: string;
    keywords: string[];
    scope?: MemoryScope;
  }): Promise<MemoryRecord> {
    await this.load();
    this.assertWritableCategory(input.category);
    this.assertField('title', input.title);
    this.assertField('content', input.content);
    const now = Date.now();
    const rec: MemoryRecord = {
      id: generateId(),
      title: input.title.trim(),
      content: input.content,
      category: input.category as MemoryCategory,
      keywords: normalizeKeywords(input.keywords),
      scope: input.scope ?? 'workspace',
      createdAt: now,
      updatedAt: now,
    };
    if (rec.scope === 'workspace' && !this.workspacePath) {
      throw new AgentError({
        code: ErrorCodes.MEMORY_CATEGORY_NOT_WRITABLE,
        message: '未打开工作区，无法写入 workspace 作用域的记忆',
      });
    }
    // v1.8.0：自动计算 embedding（非阻塞，失败静默跳过）
    await this.computeEmbedding(rec).catch(() => {});
    // v1.8.0：keywords 不足时自动从 content 提取关键术语
    if (rec.keywords.length <= 3) {
      const extracted = extractKeywords(rec.content);
      const merged = [...rec.keywords];
      for (const kw of extracted) {
        if (!merged.some((k) => k.toLowerCase() === kw.toLowerCase())) {
          merged.push(kw);
        }
      }
      rec.keywords = merged;
    }
    this.records.set(rec.id, rec);
    await this.persist(rec.scope);
    return rec;
  }

  /** 更新已有记忆（按 id） */
  async update(
    id: string,
    patch: { title?: string; content?: string; category?: string; keywords?: string[] },
  ): Promise<MemoryRecord> {
    await this.load();
    const existing = this.records.get(id);
    if (!existing) {
      throw new AgentError({
        code: ErrorCodes.MEMORY_ID_NOT_FOUND,
        message: `记忆 id 不存在：${id}`,
      });
    }
    const next: MemoryRecord = { ...existing };
    if (patch.category !== undefined) {
      this.assertWritableCategory(patch.category);
      next.category = patch.category as MemoryCategory;
    }
    if (patch.title !== undefined) {
      this.assertField('title', patch.title);
      next.title = patch.title.trim();
    }
    if (patch.content !== undefined) {
      this.assertField('content', patch.content);
      next.content = patch.content;
    }
    if (patch.keywords !== undefined) {
      next.keywords = normalizeKeywords(patch.keywords);
    }
    next.updatedAt = Date.now();
    // v1.8.0：content 或 title 变时重新计算 embedding
    if (patch.content !== undefined || patch.title !== undefined) {
      await this.computeEmbedding(next).catch(() => {});
    }
    this.records.set(id, next);
    await this.persist(next.scope);
    return next;
  }

  /** 删除记忆 */
  async remove(id: string): Promise<void> {
    await this.load();
    const existing = this.records.get(id);
    if (!existing) {
      throw new AgentError({
        code: ErrorCodes.MEMORY_ID_NOT_FOUND,
        message: `记忆 id 不存在：${id}`,
      });
    }
    this.records.delete(id);
    await this.persist(existing.scope);
  }

  /** 清空（测试用） */
  async clear(): Promise<void> {
    this.records.clear();
    this.loaded = true;
    await this.persist('workspace').catch(() => {});
    await this.persist('global').catch(() => {});
  }

  // ─────────── internals ───────────

  private assertWritableCategory(c: string): void {
    if (!isValidCategory(c)) {
      throw new AgentError({
        code: ErrorCodes.MEMORY_CATEGORY_INVALID,
        message: `非法类别 "${c}"。合法类别：${ALL_CATEGORIES.join(', ')}`,
      });
    }
    if (!isWritableCategory(c)) {
      throw new AgentError({
        code: ErrorCodes.MEMORY_CATEGORY_NOT_WRITABLE,
        message: `类别 "${c}" 属于系统沉淀，工具层不允许写入`,
      });
    }
  }

  private assertField(name: 'title' | 'content', v: string): void {
    if (typeof v !== 'string' || !v.trim()) {
      throw new AgentError({
        code: ErrorCodes.TOOL_ARGS_INVALID,
        message: `${name} 不能为空`,
      });
    }
  }

  /** v1.8.0：计算记忆的 embedding 向量 */
  private async computeEmbedding(rec: MemoryRecord): Promise<void> {
    await computeEmbeddingForRecord(rec, this.embedder);
  }

  private isValidRecord(r: unknown): r is MemoryRecord {
    if (!r || typeof r !== 'object') return false;
    const rr = r as Partial<MemoryRecord>;
    return (
      typeof rr.id === 'string' &&
      typeof rr.title === 'string' &&
      typeof rr.content === 'string' &&
      typeof rr.category === 'string' &&
      Array.isArray(rr.keywords) &&
      (rr.scope === 'workspace' || rr.scope === 'global') &&
      typeof rr.createdAt === 'number' &&
      typeof rr.updatedAt === 'number' &&
      isValidCategory(rr.category)
    );
  }

  /** 重写某 scope 对应的 JSONL 文件（Phase 5 Phase C Step 8 · 原子写） */
  private async persist(scope: MemoryScope): Promise<void> {
    const file = scope === 'workspace' ? this.workspacePath : this.globalPath;
    if (!file) return;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const lines: string[] = [];
      for (const r of this.records.values()) {
        if (r.scope !== scope) continue;
        lines.push(JSON.stringify(r));
      }
      const body = lines.join('\n') + (lines.length > 0 ? '\n' : '');

      // 原子写：tempfile → writeSync → fsync → rename（同文件系统原子操作）
      const tmpFile = path.join(path.dirname(file), `.tmp_${path.basename(file)}_${process.pid}`);
      const fd = fsSync.openSync(tmpFile, 'w');
      try {
        fsSync.writeFileSync(fd, body, 'utf-8');
        fsSync.fsyncSync(fd);
      } finally {
        fsSync.closeSync(fd);
      }
      fsSync.renameSync(tmpFile, file);
    } catch (e) {
      throw new AgentError({
        code: ErrorCodes.MEMORY_STORE_CORRUPTED,
        message: `记忆持久化失败：${(e as Error).message}`,
        cause: e,
      });
    }
  }
}

// ─────────── helpers ───────────

async function readJsonl(file: string): Promise<MemoryRecord[]> {
  let content: string;
  try {
    content = await fs.readFile(file, 'utf-8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw new AgentError({
      code: ErrorCodes.MEMORY_STORE_CORRUPTED,
      message: `读取记忆文件失败 ${file}：${(e as Error).message}`,
      cause: e,
    });
  }
  const out: MemoryRecord[] = [];
  for (const line of content.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as MemoryRecord);
    } catch {
      // 损坏行：跳过（warn 级别，不抛）
    }
  }
  return out;
}

/** v1.8.0：计算记忆内容的 embedding（非阻塞，失败静默） */
async function computeEmbeddingForRecord(
  rec: MemoryRecord,
  embedder?: Embedder,
): Promise<void> {
  if (!embedder || !rec.content) return;
  try {
    const result = await embedder.embed([`${rec.title}: ${rec.content}`], { kind: 'passage' });
    if (result.vectors.length > 0) {
      rec._embedding = result.vectors[0];
    }
  } catch {
    // embedding 失败静默跳过（旧记录/无 embedder 时正常退化）
  }
}

/**
 * v1.8.0：从文本中提取 Top-5 关键词（轻量词频，零依赖）。
 * - 中文按单字 unigram 拆
 * - 英文按 [a-zA-Z0-9_]+ tokenize
 * - 过滤中英停用词，按 TF 降序取 Top-5
 */
export function extractKeywords(text: string, maxCount = 5): string[] {
  if (!text) return [];
  const freq = new Map<string, number>();

  // 英文 tokenize
  const enTokens = text.match(/[a-zA-Z0-9_]+/g) ?? [];
  for (const t of enTokens) {
    const lc = t.toLowerCase();
    if (lc.length < 3 || ENGLISH_STOPWORDS.has(lc)) continue;
    freq.set(lc, (freq.get(lc) ?? 0) + 1);
  }

  // 中文 unigram（长度 ≥ 2 的连续中文字符的 2-gram）
  const zhChars = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) ?? [];
  for (const chunk of zhChars) {
    if (chunk.length < 2) continue;
    for (let i = 0; i < chunk.length - 1; i++) {
      const bigram = chunk.slice(i, i + 2);
      if (CHINESE_STOPWORDS.has(bigram)) continue;
      freq.set(bigram, (freq.get(bigram) ?? 0) + 1);
    }
  }

  // 取 Top-5
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxCount)
    .map(([k]) => k);
}

/** 英文停用词（常用 100+） */
const ENGLISH_STOPWORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'from','as','is','it','its','this','that','are','was','were','be','been',
  'being','have','has','had','do','does','did','will','would','could','should',
  'may','might','shall','can','not','no','nor','if','so','up','down','out',
  'off','over','under','again','further','then','once','here','there','when',
  'where','why','how','all','each','every','both','few','more','most','other',
  'some','such','only','own','same','too','very','just','about','above',
  'after','before','between','through','during','without','within','along',
  'around','because','until','while','get','got','make','made','use','used',
  'set','put','take','go','come','see','know','like','well','way','new','now',
  'one','two','also','much','many','still','even','back','here','into','than',
]);

/** 中文停用词（高频虚词） */
const CHINESE_STOPWORDS = new Set([
  '的','了','在','是','我','有','和','就','不','人','都','一','个','上','也',
  '很','到','说','要','去','你','会','着','没有','看','好','自己','这','他',
  '她','它','们','那','些','什么','怎么','因为','所以','如果','虽然','但是',
  '可以','这个','那个','这些','那些','已经','正在','之后','之前','关于',
  '对于','通过','使用','进行','包括','其中','以及','或者','不是','就是',
  '还是','只是','但是','然而','因此','而且','并且','或者','虽然','尽管',
  '无论','不过','否则','假如','除非','因为','由于','所以','于是',
]);

function normalizeKeywords(kws: string[] | undefined): string[] {
  if (!Array.isArray(kws)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of kws) {
    if (typeof k !== 'string') continue;
    const t = k.trim();
    if (!t) continue;
    const lc = t.toLowerCase();
    if (seen.has(lc)) continue;
    seen.add(lc);
    out.push(t);
  }
  return out;
}

function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `mem_${ts}_${rand}`;
}
