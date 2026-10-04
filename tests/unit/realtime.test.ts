// 实时订阅：新的已读回执直接交给 onRead 合并，不触发整体重新加载；其他表（含已读回执被删）照样去抖后 onChange。
// 用真的 SupabaseRepo，把 client.channel 换成记录回调的假频道（不连 websocket）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupabaseRepo } from '../../src/lib/repo';
import type { ReminderRead } from '../../src/lib/types';

type Handler = (payload: { new: unknown; old: unknown }) => void;
interface FakeChannel {
  name: string;
  handlers: { event: string; table: string; cb: Handler }[];
  on(type: string, filter: { event: string; table: string }, cb: Handler): FakeChannel;
  subscribe(): FakeChannel;
}

function memoryKV() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

describe('SupabaseRepo.subscribe', () => {
  let channels: FakeChannel[];
  let repo: SupabaseRepo;

  beforeEach(() => {
    vi.useFakeTimers();
    // 去抖用的是 window.setTimeout（浏览器里跑）：node 里把 window 指到全局
    (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
    channels = [];
    repo = new SupabaseRepo({ url: 'https://pling.example.cn/api', anonKey: 'anon', fetch: (async () => new Response('{}')) as typeof fetch, storage: memoryKV() });
    const client = repo.client as unknown as { channel: (name: string) => FakeChannel; removeChannel: (c: FakeChannel) => void };
    client.channel = (name: string) => {
      const ch: FakeChannel = {
        name,
        handlers: [],
        on(_type, filter, cb) {
          ch.handlers.push({ event: filter.event, table: filter.table, cb });
          return ch;
        },
        subscribe() {
          return ch;
        },
      };
      channels.push(ch);
      return ch;
    };
    client.removeChannel = () => undefined;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const fire = (table: string, event: string, row: unknown) => {
    for (const ch of channels) for (const h of ch.handlers) if (h.table === table && (h.event === event || h.event === '*')) h.cb({ new: row, old: row });
  };

  it('新的已读回执 → onRead（不重新加载）；删除 → 去抖后 onChange', () => {
    const onChange = vi.fn();
    const onRead = vi.fn();
    const stop = repo.subscribe(onChange, onRead);
    expect(channels.map((c) => c.name)).toEqual(['pling-changes', 'pling-discussions', 'pling-extra']);
    const row: ReminderRead = { reminder_id: 'r1', occurrence_at: '2026-10-09T06:00:00+00:00', user_id: 'u1', read_at: '2026-10-09T05:00:00+00:00' };
    fire('reminder_reads', 'INSERT', row);
    expect(onRead).toHaveBeenCalledWith(row);
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();
    fire('reminder_reads', 'DELETE', row);
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it('其他表的改动连着来几次，只重新加载一次', () => {
    const onChange = vi.fn();
    repo.subscribe(onChange, vi.fn());
    fire('completions', 'INSERT', {});
    fire('submissions', 'UPDATE', {});
    fire('holidays', 'DELETE', {});
    vi.advanceTimersByTime(100);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('没给 onRead：已读回执也走 onChange', () => {
    const onChange = vi.fn();
    repo.subscribe(onChange);
    fire('reminder_reads', 'INSERT', {});
    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
