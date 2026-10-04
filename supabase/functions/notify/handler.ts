// notify：每分钟由 pg_cron → pg_net 调一次（内网，带 x-cron-secret），算出到点的提醒，发服务号模板消息和群机器人消息。
// 详见 docs/架构.md §6.6；算法在 _shared/notify/plan.ts，发送和去重在 _shared/notify/run.ts。
import { cfg } from '../_shared/env.ts';
import { HttpError, json, serve } from '../_shared/http.ts';
import { runNotify } from '../_shared/notify/run.ts';
import { safeEqual } from '../_shared/notify/util.ts';

export default serve(async (req: Request): Promise<Response> => {
  const secret = cfg.cronSecret();
  if (!secret || !safeEqual(req.headers.get('x-cron-secret') ?? '', secret)) throw new HttpError(401, 'unauthorized');
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  return json(req, await runNotify());
});
