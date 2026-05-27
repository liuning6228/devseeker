/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * StreamingFileWriter — 在 tool_args_delta 阶段实时提取 content 并写临时文件
 *
 * v2 架构：流式内容只写临时文件，不污染真实目标文件
 *
 * 工作原理：
 *   1. tool_start 时记录 tool name 和 id
 *   2. 每次 tool_args_delta 时，从部分 JSON 中增量提取 content 字段
 *   3. 写入 .devseeker/tmp/stream-{toolCallId}.partial 临时文件
 *   4. 工具正常完成时：write_file 工具自己写真实文件，StreamingFileWriter 清理临时文件
 *   5. SSE 断裂时：临时文件保留，真实文件不受影响；保存断点信息供 LLM 参考
 *
 * 安全：
 *   - 临时文件在 .devseeker/tmp/ 目录下，不会污染工作区源码
 *   - 真实文件只在 write_file/append_file 工具正式执行时才被写入
 *   - SSE 断裂后真实文件完好，LLM 可参考断点信息续写
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getLogger } from '../../infra/logger.js';

const log = getLogger('streaming-file-writer');

/** 临时文件目录名 */
const TMP_DIR_NAME = '.devseeker';
const TMP_SUBDIR = 'tmp';

/** 需要流式写入的工具名 */
const STREAM_WRITE_TOOLS = new Set(['write_file', 'append_file']);

/** cachedContents 单条目最大缓存字节数（超过此值停止缓存，仍写磁盘） */
const MAX_CACHED_CONTENT_BYTES = 2 * 1024 * 1024; // 2 MB

/** 从部分 JSON 中提取 content 字段的已接收部分 */
export function extractPartialContent(
  partialJson: string,
): { filePath: string; content: string } | null {
  const t0 = performance.now();

  // 1. 提取 file_path
  const fpMatch = partialJson.match(/"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!fpMatch) return null;
  const filePath = fpMatch[1]
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');

  // 2. 提取 content — 从 "content":" 开始找，到字符串末尾
  const contentStart = partialJson.indexOf('"content"');
  if (contentStart === -1) return { filePath, content: '' };

  const colonAfterContent = partialJson.indexOf(':', contentStart + 9);
  if (colonAfterContent === -1) return { filePath, content: '' };

  const openQuote = partialJson.indexOf('"', colonAfterContent + 1);
  if (openQuote === -1) return { filePath, content: '' };

  let rawContent = partialJson.slice(openQuote + 1);

  // 快速路径：只在末尾 30 个字符内检查闭合引号
  let endQuoteIdx = -1;
  const scanStart = Math.max(0, rawContent.length - 30);
  for (let i = rawContent.length - 1; i >= scanStart; i--) {
    if (rawContent[i] === '"') {
      let backslashes = 0;
      let j = i - 1;
      while (j >= 0 && rawContent[j] === '\\') {
        backslashes++;
        j--;
      }
      if (backslashes % 2 === 0) {
        endQuoteIdx = i;
        break;
      }
    }
  }

  if (endQuoteIdx >= 0) {
    rawContent = rawContent.slice(0, endQuoteIdx);
  } else {
    // 末尾可能是不完整的转义序列
    let trailingBackslashes = 0;
    for (let i = rawContent.length - 1; i >= 0; i--) {
      if (rawContent[i] === '\\') {
        trailingBackslashes++;
      } else {
        break;
      }
    }
    if (trailingBackslashes % 2 === 1) {
      rawContent = rawContent.slice(0, -1);
    }
  }

  const content = rawContent
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');

  const dt = performance.now() - t0;
  if (dt > 20) {
    log.warn({ dt, partialJsonLen: partialJson.length }, 'extractPartialContent slow');
  }
  return { filePath, content };
}

export class StreamingFileWriter {
  private readonly workspaceRoot: string;
  private readonly tmpDir: string;
  /** toolCallId → 上次已写入磁盘的 content 长度 */
  private readonly writtenLengths = new Map<string, number>();
  /** toolCallId → 已解析的 filePath（目标文件相对路径） */
  private readonly filePaths = new Map<string, string>();
  /** toolCallId → 工具名 */
  private readonly toolNames = new Map<string, string>();
  /** toolCallId → 临时文件绝对路径 */
  private readonly tmpPaths = new Map<string, string>();
  /** toolCallId → 是否已创建临时文件 */
  private readonly tmpCreated = new Map<string, boolean>();
  /** toolCallId → 上次写入时间戳（节流用） */
  private readonly lastWriteTimes = new Map<string, number>();
  /** toolCallId → 缓存的最新完整 content（SSE 断裂时刷新用） */
  private readonly cachedContents = new Map<string, string>();
  /** 最小写入间隔（ms） */
  private static readonly WRITE_THROTTLE_MS = 300;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.tmpDir = path.join(workspaceRoot, TMP_DIR_NAME, TMP_SUBDIR);
  }

  /** 是否需要流式写入 */
  isStreamWriteTool(toolName: string): boolean {
    return STREAM_WRITE_TOOLS.has(toolName);
  }

  /** 确保临时目录存在 */
  private async ensureTmpDir(): Promise<void> {
    await fs.mkdir(this.tmpDir, { recursive: true });
  }

  /** 生成临时文件路径 */
  private getTmpPath(toolCallId: string): string {
    return path.join(this.tmpDir, `stream-${toolCallId}.partial`);
  }

  /** tool_start 时调用 */
  async onToolStart(toolCallId: string, toolName: string): Promise<void> {
    this.toolNames.set(toolCallId, toolName);
    this.writtenLengths.set(toolCallId, 0);
    this.filePaths.set(toolCallId, '');
    this.tmpPaths.set(toolCallId, this.getTmpPath(toolCallId));
    this.tmpCreated.set(toolCallId, false);
    await this.ensureTmpDir();
  }

  /** tool_args_delta 时调用 — 增量写临时文件（带节流） */
  async onToolArgsDelta(toolCallId: string, partialArgs: string): Promise<void> {
    const toolName = this.toolNames.get(toolCallId);
    if (!toolName) return;

    const extracted = extractPartialContent(partialArgs);
    if (!extracted) return;

    const { filePath, content } = extracted;
    if (!filePath) return;

    // 安全校验：路径必须在 workspaceRoot 内
    const absPath = path.resolve(this.workspaceRoot, filePath);
    if (!absPath.startsWith(this.workspaceRoot)) {
      log.warn({ filePath, absPath }, 'StreamingFileWriter: path outside workspace, skip');
      return;
    }

    this.filePaths.set(toolCallId, filePath);

    // 内存保护：大文件停止缓存
    const currentCached = this.cachedContents.get(toolCallId);
    const contentBytes = Buffer.byteLength(content, 'utf-8');
    if (contentBytes <= MAX_CACHED_CONTENT_BYTES) {
      this.cachedContents.set(toolCallId, content);
    } else if (currentCached === undefined) {
      this.cachedContents.set(toolCallId, '');
      log.info({ toolCallId, filePath, contentBytes }, 'StreamingFileWriter: content too large, skipping cache');
    }

    const prevLen = this.writtenLengths.get(toolCallId) ?? 0;
    if (content.length <= prevLen) return;

    // 节流
    const now = Date.now();
    const lastWrite = this.lastWriteTimes.get(toolCallId) ?? 0;
    if (now - lastWrite < StreamingFileWriter.WRITE_THROTTLE_MS) {
      return;
    }

    const newContent = content.slice(prevLen);
    const tmpPath = this.tmpPaths.get(toolCallId)!;

    try {
      // 首次写入：创建临时文件并写入全部内容
      if (!this.tmpCreated.get(toolCallId)) {
        await this.ensureTmpDir();
        await fs.writeFile(tmpPath, content, { encoding: 'utf-8' });
        this.writtenLengths.set(toolCallId, content.length);
        this.tmpCreated.set(toolCallId, true);
        this.lastWriteTimes.set(toolCallId, now);
        log.debug(
          { toolCallId, filePath, tmpPath, writtenChars: content.length },
          'StreamingFileWriter: initial write to tmp file',
        );
        return;
      }

      // 追加新内容到临时文件
      await fs.appendFile(tmpPath, newContent, { encoding: 'utf-8' });
      this.writtenLengths.set(toolCallId, content.length);
      this.lastWriteTimes.set(toolCallId, now);
      log.debug(
        { toolCallId, filePath, tmpPath, writtenChars: content.length, newChars: newContent.length },
        'StreamingFileWriter: wrote delta to tmp file',
      );
    } catch (e) {
      log.warn({ toolCallId, filePath, tmpPath, err: String(e) }, 'StreamingFileWriter: tmp write failed');
    }
  }

  /** 工具正常执行完成时调用 — 删除临时文件（真实文件由工具本身写入） */
  async onToolExecComplete(toolCallId: string): Promise<void> {
    const tmpPath = this.tmpPaths.get(toolCallId);
    if (tmpPath) {
      try {
        await fs.unlink(tmpPath);
        log.debug({ toolCallId, tmpPath }, 'StreamingFileWriter: tmp file cleaned up after tool exec');
      } catch {
        // 临时文件可能不存在，忽略
      }
    }
    this.cleanup(toolCallId);
  }

  /** SSE 断裂时调用 — 保存断点信息，真实文件不受影响 */
  async onStreamBroken(): Promise<void> {
    log.info(
      {
        activeWriters: this.writtenLengths.size,
        paths: Array.from(this.filePaths.values()).filter(Boolean),
      },
      'StreamingFileWriter: stream broken, saving breakpoint info',
    );

    for (const [toolCallId, content] of this.cachedContents) {
      const prevLen = this.writtenLengths.get(toolCallId) ?? 0;
      const filePath = this.filePaths.get(toolCallId);
      if (!filePath) continue;

      // 刷新缓存到临时文件
      const tmpPath = this.tmpPaths.get(toolCallId);
      if (tmpPath && content.length > prevLen) {
        const newContent = content.slice(prevLen);
        try {
          if (this.tmpCreated.get(toolCallId)) {
            await fs.appendFile(tmpPath, newContent, { encoding: 'utf-8' });
          } else {
            await this.ensureTmpDir();
            await fs.writeFile(tmpPath, content, { encoding: 'utf-8' });
          }
          this.writtenLengths.set(toolCallId, content.length);
          log.info({ toolCallId, filePath, tmpPath, flushedChars: newContent.length }, 'StreamingFileWriter: flushed to tmp on stream broken');
        } catch (e) {
          log.warn({ toolCallId, filePath, tmpPath, err: String(e) }, 'StreamingFileWriter: flush to tmp failed on stream broken');
        }
      }

      // 保存断点信息
      try {
        await this.saveBreakpointInfo(filePath, content, tmpPath);
      } catch (e) {
        log.warn({ filePath, err: String(e) }, 'StreamingFileWriter: failed to save breakpoint info');
      }
    }
    // 注意：不清理状态，让临时文件和断点信息保留
    // 真实文件完全不受影响
  }

  /**
   * 获取指定 toolCallId 的临时文件路径（供外部读取用）
   */
  getTmpFilePath(toolCallId: string): string | undefined {
    return this.tmpPaths.get(toolCallId);
  }

  /**
   * 获取指定 toolCallId 的目标文件路径
   */
  getTargetFilePath(toolCallId: string): string | undefined {
    return this.filePaths.get(toolCallId);
  }

  /**
   * 保存断点信息到 .devseeker/tmp/breakpoint-{sanitized-filename}.json
   */
  private async saveBreakpointInfo(filePath: string, writtenContent: string, tmpPath?: string): Promise<void> {
    await this.ensureTmpDir();

    const safeName = filePath.replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '__');
    const bpPath = path.join(this.tmpDir, `breakpoint-${safeName}.json`);

    const writtenLines = writtenContent.split('\n').length;
    const writtenBytes = Buffer.byteLength(writtenContent, 'utf-8');

    const info = {
      filePath,
      writtenLines,
      writtenBytes,
      tmpFile: tmpPath || undefined,
      timestamp: new Date().toISOString(),
      hint: `SSE 断裂：${filePath} 的部分内容已保存到临时文件（${writtenLines} 行，${writtenBytes} 字节）。` +
        `真实文件未被修改。请用 read_file 检查真实文件内容，然后决定是否需要续写。` +
        (tmpPath ? `临时文件路径：${tmpPath}` : ''),
    };

    await fs.writeFile(bpPath, JSON.stringify(info, null, 2), { encoding: 'utf-8' });
    log.info({ bpPath, writtenLines, writtenBytes }, 'StreamingFileWriter: breakpoint info saved');
  }

  /** 清理单个 toolCall 的状态 */
  private cleanup(toolCallId: string): void {
    this.writtenLengths.delete(toolCallId);
    this.filePaths.delete(toolCallId);
    this.toolNames.delete(toolCallId);
    this.tmpPaths.delete(toolCallId);
    this.tmpCreated.delete(toolCallId);
    this.lastWriteTimes.delete(toolCallId);
    this.cachedContents.delete(toolCallId);
  }

  /** 清理所有状态 + 临时文件 */
  async cleanupAll(): Promise<void> {
    // 尝试删除所有临时文件
    for (const [toolCallId, tmpPath] of this.tmpPaths) {
      try {
        await fs.unlink(tmpPath);
      } catch {
        // ignore
      }
      this.cleanup(toolCallId);
    }
  }
}
