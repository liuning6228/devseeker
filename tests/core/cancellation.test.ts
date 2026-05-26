/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * CancellationToken 单测 — W7b2 / DESIGN §M15.4
 */

import { describe, it, expect } from 'vitest';
import {
  CancellationToken,
  CancellationError,
  isCancellationError,
} from '../../src/core/cancellation/index.js';

describe('CancellationToken', () => {
  it('starts not cancelled; cancel() flips isCancelled to true', () => {
    const t = new CancellationToken();
    expect(t.isCancelled).toBe(false);
    t.cancel();
    expect(t.isCancelled).toBe(true);
  });

  it('cancel() is idempotent — multiple calls do not re-fire callbacks', () => {
    const t = new CancellationToken();
    let count = 0;
    t.onCancel(() => {
      count += 1;
    });
    t.cancel();
    t.cancel();
    t.cancel();
    expect(count).toBe(1);
    expect(t.isCancelled).toBe(true);
  });

  it('throwIfCancelled() throws CancellationError after cancel', () => {
    const t = new CancellationToken();
    expect(() => t.throwIfCancelled()).not.toThrow();
    t.cancel();
    expect(() => t.throwIfCancelled()).toThrow(CancellationError);
  });

  it('onCancel registered before cancel → invoked exactly once', async () => {
    const t = new CancellationToken();
    let fired = 0;
    t.onCancel(() => {
      fired += 1;
    });
    t.cancel();
    expect(fired).toBe(1);
  });

  it('onCancel registered AFTER cancel → invoked asynchronously once', async () => {
    const t = new CancellationToken();
    t.cancel();
    let fired = 0;
    t.onCancel(() => {
      fired += 1;
    });
    // onCancel 在已取消时通过 queueMicrotask 延迟执行
    expect(fired).toBe(0);
    await Promise.resolve();
    expect(fired).toBe(1);
  });

  it('dispose() before cancel cancels the subscription', () => {
    const t = new CancellationToken();
    let fired = 0;
    const sub = t.onCancel(() => {
      fired += 1;
    });
    sub.dispose();
    t.cancel();
    expect(fired).toBe(0);
  });

  it('callback throwing does not affect other listeners', () => {
    const t = new CancellationToken();
    let tail = 0;
    t.onCancel(() => {
      throw new Error('boom');
    });
    t.onCancel(() => {
      tail += 1;
    });
    expect(() => t.cancel()).not.toThrow();
    expect(tail).toBe(1);
  });

  it('toAbortSignal() returns a signal that aborts on cancel', () => {
    const t = new CancellationToken();
    const signal = t.toAbortSignal();
    expect(signal.aborted).toBe(false);
    t.cancel();
    expect(signal.aborted).toBe(true);
  });

  it('constructor with pre-aborted controller is immediately cancelled', () => {
    const ctl = new AbortController();
    ctl.abort();
    const t = new CancellationToken(ctl);
    expect(t.isCancelled).toBe(true);
    expect(() => t.throwIfCancelled()).toThrow(CancellationError);
  });

  it('from(signal) propagates external abort', () => {
    const ctl = new AbortController();
    const t = CancellationToken.from(ctl.signal);
    expect(t.isCancelled).toBe(false);
    let fired = 0;
    t.onCancel(() => {
      fired += 1;
    });
    ctl.abort();
    expect(t.isCancelled).toBe(true);
    expect(fired).toBe(1);
  });

  it('from(already-aborted signal) → token starts cancelled', () => {
    const ctl = new AbortController();
    ctl.abort();
    const t = CancellationToken.from(ctl.signal);
    expect(t.isCancelled).toBe(true);
  });

  it('CancellationToken.None never cancels', () => {
    const n = CancellationToken.None;
    expect(n.isCancelled).toBe(false);
    let fired = 0;
    const sub = n.onCancel(() => {
      fired += 1;
    });
    sub.dispose();
    expect(() => n.throwIfCancelled()).not.toThrow();
    expect(fired).toBe(0);
  });
});

describe('CancellationError', () => {
  it('has code "CANCELLED" and name "CancellationError"', () => {
    const e = new CancellationError();
    expect(e.code).toBe('CANCELLED');
    expect(e.name).toBe('CancellationError');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(CancellationError);
  });

  it('isCancellationError() recognizes plain object with code=CANCELLED', () => {
    expect(isCancellationError(new CancellationError())).toBe(true);
    expect(isCancellationError({ code: 'CANCELLED' })).toBe(true);
    expect(isCancellationError(new Error('other'))).toBe(false);
    expect(isCancellationError(null)).toBe(false);
    expect(isCancellationError(undefined)).toBe(false);
  });
});
