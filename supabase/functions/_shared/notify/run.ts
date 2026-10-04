// notify 的一次运行：拿锁 → 读快照 → 算 → 逐条「先记后发」→ 清理旧记录。
//
// 去重靠 notification_log.dedupe_key（唯一）：发之前先插一条记录（on conflict do nothing returning），
// 插不进去 = 别的运行已经发过（或正在发）；发失败把这条记录改成 failed + 错误信息，不自动重试。
// 所以中途崩溃时最多少发一条，不会重复发。
import { db, type Sql } from '../db.ts';
import { cfg } from '../env.ts';
import { sendWebhook } from '../webhooks.ts';
import {
  DEFAULT_TEMPLATE_FIELDS,
  ERR_NOT_SUBSCRIBED,
  mpPushConfigured,
  parseTemplateFields,
  templateData,
  type TemplateField,
  WechatMp,
  wxErrorText,
} from '../wechat-mp.ts';
import { type Job, planNotifications, type WebhookJob, type WechatJob } from './plan.ts';
import { loadSnapshot } from './snapshot.ts';
import { errText, runPool } from './util.ts';

/** pg_try_advisory_lock 的键：同一时间只有一次运行（和登录的 advisory lock 一样用 hashtextextended 取 64 位键） */
export const NOTIFY_LOCK_NAME = 'pling-notify';

/** 一次运行的限制（测试里会改） */
export const LIMITS = {
  /** 服务号同时发几条 */
  concurrency: 8,
  /** 同时给几个机器人发（同一个机器人的消息一条一条发）；和服务号分开排队，服务号消息多的时候群消息不会被挤到时间预算以外 */
  webhookConcurrency: 4,
  /**
   * 跑了这么久就不再开始新的发送，剩下的留给下一分钟。最坏情况下最后开始的一条还要 4 个请求（发送 → 令牌失效 → 换令牌 → 重发），
   * 每个最多 6 秒：30 + 24 = 54 秒，在 pg_net 的 55 秒超时和 edge-runtime 的 60 秒 worker 时限以内
   */
  timeBudgetMs: 30000,
  /** 每个机器人每次运行最多发这么多条，多的留给下一分钟：企业微信、钉钉的机器人每分钟最多 20 条（钉钉超了限流 10 分钟），飞书 100 条 */
  perWebhookPerRun: 15,
  /** 同一个机器人的两条消息之间隔这么久（飞书每秒最多 5 条） */
  webhookGapMs: 250,
};

/**
 * 预先读这么久以内的发送记录，算的时候就跳过已经发过的（真正的去重靠 dedupe_key 唯一）：
 * 只有 12 小时以内的阶段才会发，它的记录不会早于阶段时间，多留 1 小时余量
 */
const SENT_KEYS_INTERVAL = '13 hours';

export interface RunResult {
  sent: number;
  failed: number;
  /** 按规则这次不发（关了服务号消息、免打扰）+ 别的运行已经发过 */
  skipped: number;
  /** 超出时间预算、留给下一次运行的 */
  deferred: number;
  /** 拿不到服务号 access_token 时的错误：这次的服务号消息都没发（也没记），下一分钟再试 */
  error?: string;
}

export interface RunOptions {
  now?: Date;
  /** 只给测试用：不拿锁（测「两次运行同时算出同一条」时靠 dedupe_key 去重） */
  skipLock?: boolean;
}

export async function runNotify(opts: RunOptions = {}): Promise<RunResult | { skipped: 'busy' }> {
  const sql = db();
  if (opts.skipLock) return await runLocked(sql, opts);
  const conn = await sql.reserve();
  try {
    const [l] = await conn<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtextextended(${NOTIFY_LOCK_NAME}, 0)) as locked`;
    if (!l.locked) return { skipped: 'busy' };
    try {
      return await runLocked(sql, opts);
    } finally {
      await conn`select pg_advisory_unlock(hashtextextended(${NOTIFY_LOCK_NAME}, 0))`.catch((e) =>
        console.error('notify: unlock failed', e)
      );
    }
  } finally {
    conn.release();
  }
}

async function runLocked(sql: Sql, opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const result: RunResult = { sent: 0, failed: 0, skipped: 0, deferred: 0 };

  const [snapshot, logRows] = await Promise.all([
    loadSnapshot(sql, now),
    sql<
      { dedupe_key: string }[]
    >`select dedupe_key from public.notification_log where created_at > now() - ${SENT_KEYS_INTERVAL}::interval`,
  ]);
  const wechat = mpPushConfigured();
  const plan = planNotifications(snapshot, {
    now,
    publicUrl: cfg.publicUrl(),
    wechat,
    sentKeys: new Set(logRows.map((r) => r.dedupe_key)),
  });
  result.skipped += plan.skipped;

  const wechatJobs = plan.jobs.filter((j): j is WechatJob => j.channel === 'wechat');
  const webhookJobs = plan.jobs.filter((j): j is WebhookJob => j.channel === 'webhook');

  // 服务号：先确认拿得到令牌。拿不到（IP 白名单、密钥错、微信接口不通）就整批不发也不记，下一分钟再试
  const mp = new WechatMp(sql);
  let sendable = wechatJobs;
  if (wechatJobs.length) {
    try {
      await mp.token();
    } catch (e) {
      result.error = `wechat token: ${errText(e)}`;
      console.error(`notify: 拿不到服务号 access_token，这次的 ${wechatJobs.length} 条服务号消息先不发：${result.error}`);
      sendable = [];
    }
  }
  const fields = parseTemplateFields(cfg.wechatMp().templateFields || DEFAULT_TEMPLATE_FIELDS);
  const templateId = cfg.wechatMp().templateId;

  const overBudget = () => Date.now() - started > LIMITS.timeBudgetMs;
  const wechatTasks = sendable.map((job) => async () => {
    if (overBudget()) return void result.deferred++;
    await deliver(sql, job, result, () => sendWechat(sql, mp, job, templateId, fields));
  });
  const byHook = new Map<string, WebhookJob[]>();
  for (const job of webhookJobs) {
    const list = byHook.get(job.webhook.id) ?? [];
    list.push(job);
    byHook.set(job.webhook.id, list);
  }
  const webhookTasks: Array<() => Promise<void>> = [];
  for (const list of byHook.values()) {
    result.deferred += Math.max(0, list.length - LIMITS.perWebhookPerRun);
    webhookTasks.push(async () => {
      let first = true;
      for (const job of list.slice(0, LIMITS.perWebhookPerRun)) {
        if (!first && LIMITS.webhookGapMs > 0) await new Promise((r) => setTimeout(r, LIMITS.webhookGapMs));
        first = false;
        if (overBudget()) {
          result.deferred++;
          continue;
        }
        await deliver(sql, job, result, () => sendRobot(sql, job));
      }
    });
  }
  await Promise.all([runPool(wechatTasks, LIMITS.concurrency), runPool(webhookTasks, LIMITS.webhookConcurrency)]);

  try {
    await sql`select public.pling_cleanup()`;
  } catch (e) {
    console.error('notify: pling_cleanup failed', e);
  }
  return result;
}

/** 先记后发：插不进去 = 别人发过；发失败 → failed + 错误信息 */
async function deliver(sql: Sql, job: Job, result: RunResult, send: () => Promise<string | null>): Promise<void> {
  let id: string | null = null;
  try {
    const rows = await sql<{ id: string }[]>`
      insert into public.notification_log (dedupe_key, channel, user_id, webhook_id, reminder_id, occurrence_at, stage, status)
      values (${job.key}, ${job.channel}, ${job.channel === 'wechat' ? job.userId : null},
              ${job.channel === 'webhook' ? job.webhook.id : null}, ${job.reminderId}, ${job.at}, ${job.stage}, 'sent')
      on conflict (dedupe_key) do nothing
      returning id`;
    if (!rows.length) {
      result.skipped++;
      return;
    }
    id = rows[0].id;
  } catch (e) {
    // 记不下来就不发（不然下一分钟可能重复发）
    console.error(`notify: 记录 ${job.key} 失败`, e);
    result.failed++;
    return;
  }
  let error: string | null;
  try {
    error = await send();
  } catch (e) {
    error = errText(e);
  }
  if (error === null) {
    result.sent++;
    return;
  }
  result.failed++;
  try {
    await sql`update public.notification_log set status = 'failed', error = ${error} where id = ${id}`;
  } catch (e) {
    console.error(`notify: 更新 ${job.key} 的发送结果失败`, e);
  }
}

/** 发一条模板消息；成功返回 null，否则返回错误信息 */
async function sendWechat(sql: Sql, mp: WechatMp, job: WechatJob, templateId: string, fields: TemplateField[]): Promise<string | null> {
  const res = await mp.sendTemplate({ openid: job.openid, templateId, url: job.url, data: templateData(fields, job.values) });
  const code = Number(res.errcode ?? 0);
  if (code === 0) return null;
  if (code === ERR_NOT_SUBSCRIBED) {
    // 取消关注了（我们没收到 unsubscribe 事件）：标记一下，以后不再给他发
    await sql`update public.wechat_bindings set subscribed = false where user_id = ${job.userId} and openid = ${job.openid}`.catch((e) =>
      console.error('notify: 标记取消关注失败', e)
    );
  }
  return wxErrorText(code, res.errmsg);
}

/** 发一条群消息，顺手更新机器人的 last_at / last_status */
async function sendRobot(sql: Sql, job: WebhookJob): Promise<string | null> {
  const r = await sendWebhook(job.webhook, { text: job.text, mobiles: job.mobiles });
  await sql`update public.team_webhooks set last_at = now(), last_status = ${r.status} where id = ${job.webhook.id}`.catch((e) =>
    console.error('notify: 更新机器人状态失败', e)
  );
  return r.ok ? null : r.status;
}
