/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * IndexWatcher（DESIGN §M4.10 · W4.6 / B-P2-4）
 *
 * 在保留原有 `onDidSaveTextDocument` 的基础上，补齐对**外部修改**的监听，
 * 覆盖 `git pull` / 文件管理器拷贝 / 外部编辑器保存 等 VSCode 文档未感知
 * 的场景。
 *
 * 事件源优先级：VSCode `createFileSystemWatcher('**\*')` > chokidar。
 *   - VSCode API 已覆盖绝大多数本地变化且支持 Remote Dev（远端透明）
 *   - chokidar 仅作为可选 fallback（未启用；保留扩展点但不强制引入 native binary）
 *
 * 节流策略（§M4.10）：
 *   - 收到事件立即登记到 pending Map
 *   - 距最近一次同文件事件 2s 后真正调 `updateFile` / `removeFile`
 *   - 同文件短时间内反复写入只产出一次索引更新
 *
 * 单元化设计：
 *   - 构造时注入依赖（getIndex / isCodeFile / onError 回调），便于单测
 *   - dispose 清理所有 timer + 所有 vscode disposable
 */

export interface IndexWatcherDeps {
  /** 懒拿 index 实例；返回 undefined 表示索引未建立，watcher 跳过处理 */
  getIndex: () => Promise<{
    size: () => number;
    updateFile: (relPath: string) => Promise<unknown>;
    removeFile: (relPath: string) => unknown;
  } | undefined>;
  /** 判定相对路径是否是被索引的源码类型 */
  isCodeFile: (relPath: string) => boolean;
  /** 出错时回调（只做日志打点，不抛出） */
  onError?: (err: unknown, relPath: string, op: 'update' | 'remove') => void;
  /** 节流窗口（毫秒），默认 2000 */
  debounceMs?: number;
  /** DI 计时器，供单测用 fake timers 时替换 */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (id: ReturnType<typeof setTimeout>) => void;
}

type PendingOp = 'update' | 'remove';

interface PendingEntry {
  op: PendingOp;
  timer: ReturnType<typeof setTimeout>;
}

export class IndexFileWatcher {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly debounceMs: number;
  private readonly setTimeoutFn: NonNullable<IndexWatcherDeps['setTimeoutFn']>;
  private readonly clearTimeoutFn: NonNullable<IndexWatcherDeps['clearTimeoutFn']>;
  private disposed = false;

  constructor(private readonly deps: IndexWatcherDeps) {
    this.debounceMs = deps.debounceMs ?? 2000;
    this.setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = deps.clearTimeoutFn ?? ((id) => clearTimeout(id));
  }

  /**
   * 登记一次变更事件。同文件的后续事件会**取消**已排队的 timer，重新计时，
   * 保证只有最后一次事件落地为索引操作。
   *
   * - `create` / `change` → 最终 op = 'update'
   * - `delete` → 最终 op = 'remove'
   */
  schedule(relPath: string, op: PendingOp): void {
    if (this.disposed) return;
    if (!this.deps.isCodeFile(relPath)) return;

    // 取消同文件已排队的 timer
    const prev = this.pending.get(relPath);
    if (prev) this.clearTimeoutFn(prev.timer);

    const timer = this.setTimeoutFn(() => {
      this.pending.delete(relPath);
      void this.flush(relPath, op);
    }, this.debounceMs);
    this.pending.set(relPath, { op, timer });
  }

  /** 立即 flush 某文件（供外部强制 + 测试使用） */
  async flush(relPath: string, op: PendingOp): Promise<void> {
    try {
      const idx = await this.deps.getIndex();
      if (!idx) return;
      if (idx.size() === 0) return; // 尚未首次索引
      if (op === 'update') {
        await idx.updateFile(relPath);
      } else {
        idx.removeFile(relPath);
      }
    } catch (e) {
      this.deps.onError?.(e, relPath, op);
    }
  }

  /** 是否有待处理事件（供观测） */
  pendingCount(): number {
    return this.pending.size;
  }

  dispose(): void {
    this.disposed = true;
    for (const { timer } of this.pending.values()) this.clearTimeoutFn(timer);
    this.pending.clear();
  }
}
