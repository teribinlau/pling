-- 叮一下 · 服务端推送：微信服务号模板消息 + 企业微信 / 钉钉 / 飞书群机器人
-- 重复执行无害。
--
-- 云函数 notify 每分钟跑一次（pg_cron → pg_net → /functions/v1/notify），算出到点的提醒，
-- 发给绑定了服务号的人，以及指派到的小组配置的群机器人。发过的记在 notification_log（按 dedupe_key 去重）。

-- ---------------------------------------------------------------------------
-- 个人通知设置（没有这一行 = 全部用默认值）
-- 免打扰在这里存一份，桌面版的本机弹窗也读它，两边一致
-- ---------------------------------------------------------------------------
create table if not exists public.notify_prefs (
  user_id        uuid primary key references public.profiles(id) on delete cascade,
  wechat         boolean not null default true,    -- 服务号消息
  dnd_enabled    boolean not null default true,
  dnd_from       text not null default '21:30' check (dnd_from ~ '^[0-2][0-9]:[0-5][0-9]$'),
  dnd_to         text not null default '07:00' check (dnd_to ~ '^[0-2][0-9]:[0-5][0-9]$'),
  dnd_rest_days  boolean not null default true,    -- 周末和法定假日不推（调休上班的日子照推）
  updated_at     timestamptz not null default now()
);
drop trigger if exists notify_prefs_touch on public.notify_prefs;
create trigger notify_prefs_touch before update on public.notify_prefs
  for each row execute function public.touch_updated_at();

alter table public.notify_prefs enable row level security;
drop policy if exists notify_prefs_own on public.notify_prefs;
create policy notify_prefs_own on public.notify_prefs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists notify_prefs_admin_read on public.notify_prefs;
create policy notify_prefs_admin_read on public.notify_prefs for select to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 服务号绑定：成员在「设置 → 通知」里扫一个带参数的二维码（关注服务号），云函数 wechat-mp 收到事件后写这里
-- 在微信里用服务号授权登录的人，登录时自动绑定
-- ---------------------------------------------------------------------------
create table if not exists public.wechat_bindings (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  openid      text not null unique,          -- 服务号下的 openid
  unionid     text not null default '',
  subscribed  boolean not null default true, -- 取消关注了就是 false（模板消息只能发给关注的人）
  nickname    text not null default '',
  bound_at    timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
drop trigger if exists wechat_bindings_touch on public.wechat_bindings;
create trigger wechat_bindings_touch before update on public.wechat_bindings
  for each row execute function public.touch_updated_at();

alter table public.wechat_bindings enable row level security;
drop policy if exists wechat_bindings_select on public.wechat_bindings;
create policy wechat_bindings_select on public.wechat_bindings for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
-- 解绑：本人或管理员
drop policy if exists wechat_bindings_delete on public.wechat_bindings;
create policy wechat_bindings_delete on public.wechat_bindings for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- 绑定二维码的场景值（10 分钟有效），只有云函数用
create table if not exists public.wechat_bind_tickets (
  scene       text primary key,              -- bind_<随机串>
  user_id     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
alter table public.wechat_bind_tickets enable row level security;

-- ---------------------------------------------------------------------------
-- 小组的工作群机器人（只有管理员能看、能改：机器人地址等于发消息的权限）
-- team_id 为空 = 「全体」的提醒发到这个群
-- stages：发哪些阶段，pre = 提前提醒、due = 到点、overdue = 逾期
-- ---------------------------------------------------------------------------
create table if not exists public.team_webhooks (
  id           uuid primary key default gen_random_uuid(),
  team_id      uuid references public.teams(id) on delete cascade,
  kind         text not null check (kind in ('wecom','dingtalk','feishu')),
  name         text not null default '',
  url          text not null check (url ~ '^https://'),
  secret       text not null default '',     -- 钉钉 / 飞书「加签」的密钥，选填
  stages       text[] not null default '{due}',
  enabled      boolean not null default true,
  created_at   timestamptz not null default now(),
  last_at      timestamptz,
  last_status  text not null default ''      -- 'ok' 或错误信息
);
create index if not exists team_webhooks_team_idx on public.team_webhooks (team_id);
do $$
begin
  alter table public.team_webhooks add constraint team_webhooks_stages_check
    check (stages <@ array['pre','due','overdue']::text[] and cardinality(stages) > 0);
exception when duplicate_object then null;
end $$;

alter table public.team_webhooks enable row level security;
drop policy if exists team_webhooks_admin on public.team_webhooks;
create policy team_webhooks_admin on public.team_webhooks for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- 发送记录：dedupe_key 唯一 → 同一个人、同一次到期、同一个阶段只发一次
-- ---------------------------------------------------------------------------
create table if not exists public.notification_log (
  id             bigserial primary key,
  dedupe_key     text not null unique,
  channel        text not null check (channel in ('wechat','webhook')),
  user_id        uuid,
  webhook_id     uuid,
  reminder_id    uuid,
  occurrence_at  timestamptz,
  stage          text not null default '',
  status         text not null check (status in ('sent','failed','skipped')),
  error          text not null default '',
  created_at     timestamptz not null default now()
);
create index if not exists notification_log_created_idx on public.notification_log (created_at);
create index if not exists notification_log_reminder_idx on public.notification_log (reminder_id, occurrence_at);

alter table public.notification_log enable row level security;
drop policy if exists notification_log_admin_read on public.notification_log;
create policy notification_log_admin_read on public.notification_log for select to authenticated
  using (public.is_admin());

-- 云函数之间共享的小缓存（服务号的 access_token 等），只有 service role 能用
create table if not exists public.kv_cache (
  key         text primary key,
  value       text not null,
  expires_at  timestamptz not null
);
alter table public.kv_cache enable row level security;

-- ---------------------------------------------------------------------------
-- 每分钟触发 notify。地址和口令不进仓库：部署脚本写进 pling_private.settings
--   notify_url  = http://functions:9000/notify（docker 内网直连函数容器）
--   cron_secret = 和函数环境变量 PLING_CRON_SECRET 一样
-- ---------------------------------------------------------------------------
create schema if not exists pling_private;
revoke all on schema pling_private from public;
do $$
begin
  revoke all on schema pling_private from anon, authenticated;
exception when undefined_object then null;
end $$;

create table if not exists pling_private.settings (
  key    text primary key,
  value  text not null
);

do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net 不可用（本机测试库没有这个扩展时会这样），跳过：%', sqlerrm;
end $$;

create or replace function pling_private.call_notify() returns void
language plpgsql security definer set search_path = pling_private, public as $$
declare
  v_url    text;
  v_secret text;
begin
  select value into v_url    from pling_private.settings where key = 'notify_url';
  select value into v_secret from pling_private.settings where key = 'cron_secret';
  if v_url is null or v_secret is null then
    return;
  end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
end $$;
revoke all on function pling_private.call_notify() from public;

do $$
begin
  create extension if not exists pg_cron;
  if exists (select 1 from cron.job where jobname = 'pling-notify') then
    perform cron.unschedule('pling-notify');
  end if;
  perform cron.schedule('pling-notify', '* * * * *', 'select pling_private.call_notify()');
exception when others then
  raise notice 'pg_cron 不可用（本机测试库没有这个扩展时会这样），跳过：%', sqlerrm;
end $$;

-- 旧记录清理：发送记录留 30 天，登录请求留 1 天（notify 每次跑完顺手调）
create or replace function public.pling_cleanup() returns void
language sql security definer set search_path = public as $$
  delete from public.notification_log where created_at < now() - interval '30 days';
  delete from public.login_requests where created_at < now() - interval '1 day';
  delete from public.wechat_bind_tickets where expires_at < now() - interval '1 day';
  delete from public.kv_cache where expires_at < now() - interval '1 day';
$$;
revoke all on function public.pling_cleanup() from public, anon, authenticated;
grant execute on function public.pling_cleanup() to service_role;

-- ---------------------------------------------------------------------------
-- 实时订阅：绑定成功后设置页能马上变成「已绑定」
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'wechat_bindings') then
    alter publication supabase_realtime add table public.wechat_bindings;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'notify_prefs') then
    alter publication supabase_realtime add table public.notify_prefs;
  end if;
end $$;
