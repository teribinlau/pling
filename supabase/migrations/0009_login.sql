-- 叮一下 · 微信 / QQ 登录
-- 重复执行无害。
--
-- 登录流程（云函数 auth-start → 微信 / QQ 授权页 → auth-callback → auth-finish）：
--   1. 客户端调 auth-start，拿到一次性的 id + secret 和授权页地址
--   2. 用户在微信 / QQ 授权后跳回 auth-callback：云函数用 code 换 openid / unionid，找到或新建账号，
--      生成一个一次性的登录令牌（GoTrue magiclink 的 token_hash），记在 login_requests 里
--   3. 客户端拿 id + secret 调 auth-finish 取走令牌，supabase.auth.verifyOtp({ token_hash }) 换成会话
-- 这两张表只有云函数（service role）能读写，客户端没有任何权限。

-- 账号绑定的第三方身份：provider + 该应用下的 openid 唯一确定一个人；
-- 同一个微信开放平台下的网站应用和服务号，unionid 相同 → 认作同一个账号
create table if not exists public.login_identities (
  provider       text not null check (provider in ('wechat_open','wechat_mp','qq')),
  subject        text not null,                 -- openid
  unionid        text not null default '',
  user_id        uuid not null references auth.users(id) on delete cascade,
  nickname       text not null default '',
  avatar_url     text not null default '',
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz not null default now(),
  primary key (provider, subject)
);
create index if not exists login_identities_unionid_idx on public.login_identities (unionid) where unionid <> '';
create index if not exists login_identities_user_idx on public.login_identities (user_id);

alter table public.login_identities enable row level security;
-- 本人能看到自己绑了哪些；管理员在成员列表里能看到每个人用什么登录
drop policy if exists login_identities_select on public.login_identities;
create policy login_identities_select on public.login_identities for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- 登录请求：一次性，10 分钟内有效
create table if not exists public.login_requests (
  id            uuid primary key default gen_random_uuid(),
  secret_hash   text not null,                  -- sha256(secret) 的十六进制
  provider      text not null check (provider in ('wechat_open','wechat_mp','qq')),
  client        text not null default 'web' check (client in ('web','desktop')),
  return_to     text not null default '',       -- 网页版登录完回到哪个地址（只允许本站的路径）
  link_user_id  uuid references auth.users(id) on delete cascade,  -- 不为空 = 给已登录的账号加绑这个身份
  status        text not null default 'pending' check (status in ('pending','done','error','used')),
  token_hash    text,
  token_type    text,
  user_id       uuid,
  error         text not null default '',
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index if not exists login_requests_created_idx on public.login_requests (created_at);
alter table public.login_requests enable row level security;
-- 没有任何 policy：客户端读写不了，只有 service role 能用
