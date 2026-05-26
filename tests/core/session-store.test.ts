/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  SessionStore,
  extractTitleFromMessages,
  newSessionId,
  type MementoLike,
  type StoredSession,
} from '../../src/core/session/store.js';
import type { ProviderCost } from '../../src/core/cost/tracker.js';

class FakeMemento implements MementoLike {
  private store = new Map<string, unknown>();
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (this.store.has(key)) return this.store.get(key) as T;
    return defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
}

function fakeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  const now = Date.now();
  return {
    id: overrides.id ?? newSessionId(),
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    title: overrides.title ?? 'test',
    messages: overrides.messages ?? [{ role: 'user', content: 'hello' }],
    sessionCost: overrides.sessionCost ?? [],
  };
}

describe('SessionStore', () => {
  let memento: FakeMemento;
  let store: SessionStore;

  beforeEach(() => {
    memento = new FakeMemento();
    store = new SessionStore(memento, 3);
  });

  it('starts empty', () => {
    expect(store.listSessions()).toEqual([]);
    expect(store.latestSession()).toBeUndefined();
  });

  it('saves and retrieves sessions', async () => {
    const s = fakeSession({ id: 'a' });
    await store.saveSession(s);
    expect(store.listSessions()).toHaveLength(1);
    expect(store.getSession('a')?.title).toBe('test');
  });

  it('returns latest session by updatedAt', async () => {
    await store.saveSession(fakeSession({ id: 'old', updatedAt: 100 }));
    await store.saveSession(fakeSession({ id: 'new', updatedAt: 200 }));
    expect(store.latestSession()?.id).toBe('new');
  });

  it('deduplicates by id when saving the same session twice', async () => {
    await store.saveSession(fakeSession({ id: 'x', updatedAt: 100, title: 'first' }));
    await store.saveSession(fakeSession({ id: 'x', updatedAt: 200, title: 'second' }));
    const all = store.listSessions();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('second');
  });

  it('trims to maxSessions (keeps newest)', async () => {
    await store.saveSession(fakeSession({ id: '1', updatedAt: 100 }));
    await store.saveSession(fakeSession({ id: '2', updatedAt: 200 }));
    await store.saveSession(fakeSession({ id: '3', updatedAt: 300 }));
    await store.saveSession(fakeSession({ id: '4', updatedAt: 400 }));
    const all = store.listSessions().map((s) => s.id);
    expect(all).toEqual(['4', '3', '2']); // maxSessions=3
    expect(all).not.toContain('1');
  });

  it('deleteSession removes by id', async () => {
    await store.saveSession(fakeSession({ id: 'a', updatedAt: 1 }));
    await store.saveSession(fakeSession({ id: 'b', updatedAt: 2 }));
    await store.deleteSession('a');
    expect(store.listSessions().map((s) => s.id)).toEqual(['b']);
  });

  it('clearAll wipes everything', async () => {
    await store.saveSession(fakeSession());
    await store.saveSession(fakeSession());
    await store.clearAll();
    expect(store.listSessions()).toEqual([]);
  });

  it('persists and restores total cost', async () => {
    const costs: ProviderCost[] = [
      {
        providerId: 'deepseek-v4',
        currency: 'CNY',
        promptTokens: 1000,
        completionTokens: 500,
        cachedTokens: 0,
        cost: 0.006,
        calls: 1,
      },
    ];
    await store.saveTotalCost(costs);
    expect(store.loadTotalCost()).toEqual(costs);
  });

  it('snapshot bundles both sessions and totalCost', async () => {
    await store.saveSession(fakeSession({ id: 'x' }));
    await store.saveTotalCost([
      {
        providerId: 'openai-gpt',
        currency: 'USD',
        promptTokens: 1,
        completionTokens: 2,
        cachedTokens: 0,
        cost: 0.001,
        calls: 1,
      },
    ]);
    const snap = store.snapshot();
    expect(snap.sessions).toHaveLength(1);
    expect(snap.totalCost).toHaveLength(1);
  });

  it('tolerates corrupted storage (non-array)', () => {
    memento.update(KEY_SESSIONS_PUBLIC, 'garbage' as unknown);
    expect(store.listSessions()).toEqual([]);
    expect(store.latestSession()).toBeUndefined();
  });
});
// eslint-disable-next-line @typescript-eslint/naming-convention
const KEY_SESSIONS_PUBLIC = 'dualMind.sessions.v1';

describe('extractTitleFromMessages', () => {
  it('returns fallback when no user message', () => {
    expect(extractTitleFromMessages([{ role: 'assistant', content: 'hi' }])).toBe('新会话');
  });

  it('returns first user text truncated at 40 chars', () => {
    const long = 'a'.repeat(100);
    const t = extractTitleFromMessages([{ role: 'user', content: long }]);
    expect(t.endsWith('…')).toBe(true);
    expect(t.length).toBe(41);
  });

  it('collapses whitespace', () => {
    const t = extractTitleFromMessages([
      { role: 'user', content: 'hello\n\nworld   spaced' },
    ]);
    expect(t).toBe('hello world spaced');
  });

  it('reads text part from multi-part content', () => {
    const t = extractTitleFromMessages([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
          { type: 'text', text: 'what is this?' },
        ],
      },
    ]);
    expect(t).toBe('what is this?');
  });
});

describe('newSessionId', () => {
  it('returns unique ids with prefix s-', () => {
    const a = newSessionId();
    const b = newSessionId();
    expect(a.startsWith('s-')).toBe(true);
    expect(a).not.toBe(b);
  });
});

// ═══════════════════════ W7b3 extensions ═══════════════════════

import type { Message } from '../../src/providers/types.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text };
}
function assistantMsg(text: string): Message {
  return { role: 'assistant', content: text };
}

describe('SessionStore · W7b3 appendMessage / markReverted / export / gc', () => {
  let store: SessionStore;
  let memento: FakeMemento;

  beforeEach(() => {
    memento = new FakeMemento();
    store = new SessionStore(memento);
  });

  it('appendMessage adds to existing session and bumps updatedAt', async () => {
    const s = fakeSession({ id: 's1', messages: [userMsg('hello')] });
    await store.saveSession(s);
    const beforeUpdated = store.getSession('s1')!.updatedAt;
    await new Promise((r) => setTimeout(r, 2));
    await store.appendMessage('s1', assistantMsg('hi there'));
    const after = store.getSession('s1')!;
    expect(after.messages).toHaveLength(2);
    expect(after.messages[1]!.content).toBe('hi there');
    expect(after.updatedAt).toBeGreaterThan(beforeUpdated);
  });

  it('appendMessage silently no-ops when session is missing', async () => {
    await store.appendMessage('ghost', userMsg('x'));
    expect(store.listSessions()).toEqual([]);
  });

  it('markReverted flags the target message with _reverted', async () => {
    const s = fakeSession({ id: 's1', messages: [userMsg('a'), assistantMsg('b')] });
    await store.saveSession(s);
    await store.markReverted('s1', 1);
    const after = store.getSession('s1')!;
    const flagged = after.messages[1] as Message & { _reverted?: boolean };
    expect(flagged._reverted).toBe(true);
    const first = after.messages[0] as Message & { _reverted?: boolean };
    expect(first._reverted).toBeUndefined();
  });

  it('markReverted ignores out-of-range index', async () => {
    const s = fakeSession({ id: 's1', messages: [userMsg('a')] });
    await store.saveSession(s);
    await store.markReverted('s1', 10);
    await store.markReverted('s1', -1);
    const after = store.getSession('s1')!;
    const m0 = after.messages[0] as Message & { _reverted?: boolean };
    expect(m0._reverted).toBeUndefined();
  });

  it('exportSession returns JSON for json format', () => {
    const s = fakeSession({ id: 's-json', title: 'Hello', messages: [userMsg('hi')] });
    void store.saveSession(s);
    const json = store.exportSession('s-json', 'json');
    expect(json).toBeDefined();
    const parsed = JSON.parse(json!);
    expect(parsed.id).toBe('s-json');
    expect(parsed.title).toBe('Hello');
  });

  it('exportSession returns Markdown for md format', async () => {
    const s = fakeSession({
      id: 's-md',
      title: 'My Session',
      messages: [userMsg('question one'), assistantMsg('answer one')],
    });
    await store.saveSession(s);
    const md = store.exportSession('s-md', 'md');
    expect(md).toBeDefined();
    expect(md!).toContain('# Session: My Session');
    expect(md!).toContain('Turn 1 · User');
    expect(md!).toContain('## Assistant');
    expect(md!).toContain('question one');
    expect(md!).toContain('answer one');
  });

  it('exportSession returns undefined for missing id', () => {
    expect(store.exportSession('nope', 'md')).toBeUndefined();
  });

  it('exportSession renders _reverted marker when flagged', async () => {
    const s = fakeSession({ id: 's-rv', messages: [userMsg('q'), assistantMsg('a')] });
    await store.saveSession(s);
    await store.markReverted('s-rv', 1);
    const md = store.exportSession('s-rv', 'md');
    expect(md!).toContain('_(reverted)_');
  });

  it('gc keeps the N newest sessions by updatedAt', async () => {
    await store.saveSession(fakeSession({ id: 's-old', updatedAt: 100 }));
    await store.saveSession(fakeSession({ id: 's-mid', updatedAt: 200 }));
    await store.saveSession(fakeSession({ id: 's-new', updatedAt: 300 }));
    const removed = await store.gc(2);
    expect(removed).toBe(1);
    const ids = store.listSessions().map((s) => s.id).sort();
    expect(ids).toEqual(['s-mid', 's-new']);
  });

  it('gc returns 0 when count <= keep', async () => {
    await store.saveSession(fakeSession({ id: 's1' }));
    expect(await store.gc(5)).toBe(0);
    expect(await store.gc(0)).toBe(0);
  });
});

