/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 轻量并发控制（Phase 5 Phase C Step 10）
 *
 * 使用 Promise.allSettled + 信号量（Semaphore）实现并发限制。
 * 不引入真正的多线程——VSCode Extension Host 是单线程 Event Loop。
 * 失败隔离：try-catch 每个子代理，一个失败不阻塞其他。
 *
 * DESIGN-1.md §4.4 · ROADMAP.md 方案一 Phase C Step 10
 */

/** 信号量：限制并发数 */
export class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current++;
        resolve();
      });
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) next();
  }
}

/** 一个可并发执行的任务 */
export interface RunnableTask<T> {
  readonly id: string;
  run(): Promise<T>;
}

/** 并发执行结果 */
export interface TaskResult<T> {
  readonly id: string;
  readonly status: 'fulfilled' | 'rejected';
  readonly value?: T;
  readonly reason?: unknown;
}

/**
 * 并发执行一组任务，不超过 maxConcurrency 的限制。
 * 失败隔离：一个任务 reject 不影响其他任务。
 */
export async function runConcurrent<T>(
  tasks: RunnableTask<T>[],
  maxConcurrency: number,
): Promise<TaskResult<T>[]> {
  const sem = new Semaphore(maxConcurrency);
  const results: TaskResult<T>[] = [];

  const wrapped = tasks.map((task) => async () => {
    await sem.acquire();
    try {
      const value = await task.run();
      results.push({ id: task.id, status: 'fulfilled', value });
    } catch (reason) {
      results.push({ id: task.id, status: 'rejected', reason });
    } finally {
      sem.release();
    }
  });

  await Promise.allSettled(wrapped.map((fn) => fn()));
  return results;
}
