import { del, get, set } from 'idb-keyval';
import type { Snapshot } from './repo';
import { DEFAULT_APP_SETTINGS } from './types';
import { getConfig } from './config';

// 离线缓存按服务器分开存：桌面版换了服务器，不会显示上一家的数据
function scope(): string {
  const c = getConfig();
  if (c.demo) return 'demo';
  try {
    const u = new URL(c.supabaseUrl);
    return `${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return 'default';
  }
}
const key = () => `pling-snapshot-v1:${scope()}`;
const qkey = () => `pling-queue-v1:${scope()}`;

export async function readCache(): Promise<{ snapshot: Snapshot; savedAt: string } | null> {
  try {
    const v = await get<{ snapshot: Snapshot; savedAt: string }>(key());
    if (!v) return null;
    // 旧版本缓存里没有的字段补上
    const s = v.snapshot;
    s.submissions ??= [];
    s.snoozes ??= [];
    s.memberships ??= [];
    s.attachments ??= [];
    s.discussions ??= [];
    s.discussionMembers ??= [];
    s.comments ??= [];
    s.discussionFiles ??= [];
    s.discussionReads ??= [];
    s.discussionsReady ??= true;
    s.appSettings = { ...DEFAULT_APP_SETTINGS, ...(s.appSettings ?? {}) };
    s.holidays ??= [];
    s.reads ??= [];
    s.notifyPrefs ??= null;
    s.wechatBinding ??= null;
    s.identities ??= [];
    s.invites ??= [];
    s.webhooks ??= [];
    s.discussions = s.discussions.map((d) => ({ ...d, due_date: d.due_date ?? null }));
    return v;
  } catch {
    return null;
  }
}

export async function writeCache(snapshot: Snapshot): Promise<void> {
  try {
    await set(key(), { snapshot, savedAt: new Date().toISOString() });
  } catch {
    /* 私密模式等情况下忽略 */
  }
}

/** 换服务器 / 退出时清掉这台服务器的缓存和离线队列 */
export async function clearCache(): Promise<void> {
  try {
    await del(key());
    await del(qkey());
  } catch {
    /* ignore */
  }
}

/** 断网时排队的写操作，恢复后按顺序重放 */
export interface QueuedOp {
  id: string;
  kind: 'completion' | 'snooze';
  payload: unknown;
  queuedAt: string;
}

export async function readQueue(): Promise<QueuedOp[]> {
  try {
    return (await get<QueuedOp[]>(qkey())) ?? [];
  } catch {
    return [];
  }
}

export async function writeQueue(ops: QueuedOp[]): Promise<void> {
  try {
    await set(qkey(), ops);
  } catch {
    /* ignore */
  }
}
