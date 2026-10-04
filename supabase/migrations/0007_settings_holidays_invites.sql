-- 叮一下 · 机构设置、节假日（含调休）、邀请码、个人资料补充、权限收紧
-- 重复执行无害。

-- ---------------------------------------------------------------------------
-- 机构设置：整个部署只有一行（id = 1），管理员在「设置 → 机构」里改
-- team_label / org_label：界面上「小组」「全体」这两个词换成机构自己的叫法（班级 / 全校、部门 / 全公司……）
-- timezone：展开重复提醒、判断免打扰都按它；国内一律 Asia/Shanghai
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  id                int primary key default 1 check (id = 1),
  org_name          text not null default '',
  team_label        text not null default '小组' check (char_length(team_label) between 1 and 6),
  org_label         text not null default '全体' check (char_length(org_label) between 1 and 6),
  timezone          text not null default 'Asia/Shanghai',
  push_overdue_max  int  not null default 2 check (push_overdue_max between 0 and 20),
  updated_at        timestamptz not null default now()
);
insert into public.app_settings (id) values (1) on conflict (id) do nothing;

drop trigger if exists app_settings_touch on public.app_settings;
create trigger app_settings_touch before update on public.app_settings
  for each row execute function public.touch_updated_at();

alter table public.app_settings enable row level security;
-- 登录页要显示机构名，所以没登录也能读（这一行里没有机密）
drop policy if exists app_settings_select on public.app_settings;
create policy app_settings_select on public.app_settings for select to anon, authenticated using (true);
drop policy if exists app_settings_update on public.app_settings;
create policy app_settings_update on public.app_settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- 节假日：off = 放假（工作日也不上班）；work = 调休上班（周末也要上班）
-- 「跳过节假日」的提醒：off 的日子跳过；「每个工作日」的提醒在 work 的日子照样提醒
-- 每年 11 月前后国务院公布下一年的安排，管理员在「设置 → 节假日」里加
-- ---------------------------------------------------------------------------
create table if not exists public.holidays (
  day   date primary key,
  kind  text not null check (kind in ('off','work')),
  name  text not null default ''
);
alter table public.holidays enable row level security;
drop policy if exists holidays_select on public.holidays;
create policy holidays_select on public.holidays for select to authenticated using (true);
drop policy if exists holidays_admin_write on public.holidays;
create policy holidays_admin_write on public.holidays for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- 2026 年（国务院办公厅 2025-11-04 公布）
insert into public.holidays (day, kind, name)
select d::date, 'off', n
from (values
  ('2026-01-01','2026-01-03','元旦'),
  ('2026-02-15','2026-02-23','春节'),
  ('2026-04-04','2026-04-06','清明节'),
  ('2026-05-01','2026-05-05','劳动节'),
  ('2026-06-19','2026-06-21','端午节'),
  ('2026-09-25','2026-09-27','中秋节'),
  ('2026-10-01','2026-10-07','国庆节')
) as r(a, b, n), generate_series(a::date, b::date, interval '1 day') as d
on conflict (day) do nothing;

insert into public.holidays (day, kind, name) values
  ('2026-01-04','work','元旦调休'),
  ('2026-02-14','work','春节调休'),
  ('2026-02-28','work','春节调休'),
  ('2026-05-09','work','劳动节调休'),
  ('2026-09-20','work','国庆节调休'),
  ('2026-10-10','work','国庆节调休')
on conflict (day) do nothing;

-- ---------------------------------------------------------------------------
-- 个人资料补充
-- phone：选填，工作群机器人 @ 人用；avatar_url：微信 / QQ 头像
-- name_confirmed：第一次登录要填真实姓名（微信昵称、邮箱前缀都不算）
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists phone          text not null default '',
  add column if not exists avatar_url     text not null default '',
  add column if not exists name_confirmed boolean not null default false;

-- 新用户：微信 / QQ 登录的账号由云函数建，邮箱是内部用的假地址（@login.pling.invalid），不显示
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  first_user boolean;
  provider   text := coalesce(nullif(new.raw_user_meta_data->>'login_provider', ''), 'email');
  real_email text := case when provider = 'email' then coalesce(new.email, '') else '' end;
begin
  select not exists (select 1 from public.profiles) into first_user;
  insert into public.profiles (id, email, name, role, active, avatar_url, name_confirmed)
  values (
    new.id,
    real_email,
    left(coalesce(
      nullif(trim(new.raw_user_meta_data->>'name'), ''),
      nullif(split_part(real_email, '@', 1), ''),
      '新成员'
    ), 40),
    case when first_user then 'admin' else 'member' end,
    first_user,
    coalesce(new.raw_user_meta_data->>'avatar_url', ''),
    false
  )
  on conflict (id) do nothing;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 权限收紧
-- 1. 本人改自己的资料时，active（是否激活）和 email 也不能改 —— 不然待激活的人能把自己激活
-- 2. 待激活的人看不到成员名单和小组（学校里有学生的名字），只看得到自己
-- ---------------------------------------------------------------------------
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and role = (select p.role from public.profiles p where p.id = auth.uid())
    and team_id is not distinct from (select p.team_id from public.profiles p where p.id = auth.uid())
    and is_station = (select p.is_station from public.profiles p where p.id = auth.uid())
    and active = (select p.active from public.profiles p where p.id = auth.uid())
    and email = (select p.email from public.profiles p where p.id = auth.uid())
  );

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_active());

drop policy if exists teams_select on public.teams;
create policy teams_select on public.teams for select to authenticated using (public.is_active());

drop policy if exists profile_teams_select on public.profile_teams;
create policy profile_teams_select on public.profile_teams for select to authenticated
  using (profile_id = auth.uid() or public.is_active());

-- ---------------------------------------------------------------------------
-- 邀请码：管理员给某个小组生成，发链接 / 二维码；新成员登录后输入（或带着链接进来）就直接激活并进这个小组
-- 已经激活的人用另一个小组的码 = 兼任那个小组
-- ---------------------------------------------------------------------------
create table if not exists public.team_invites (
  code        text primary key check (code ~ '^[A-Z0-9]{6,12}$'),
  team_id     uuid references public.teams(id) on delete cascade,  -- null = 只激活，不分小组
  note        text not null default '',
  created_by  uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz,                 -- null = 不过期
  max_uses    int check (max_uses is null or max_uses > 0),  -- null = 不限次数
  uses        int not null default 0,
  disabled    boolean not null default false
);
create index if not exists team_invites_team_idx on public.team_invites (team_id);

alter table public.team_invites enable row level security;
drop policy if exists team_invites_admin on public.team_invites;
create policy team_invites_admin on public.team_invites for all to authenticated
  using (public.is_admin()) with check (public.is_admin() and created_by = auth.uid());

create or replace function public.redeem_invite(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  inv public.team_invites;
  me  public.profiles;
  c   text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_signed_in');
  end if;
  select * into inv from public.team_invites where code = c for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if inv.disabled then
    return jsonb_build_object('ok', false, 'reason', 'disabled');
  end if;
  if inv.expires_at is not null and inv.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if inv.max_uses is not null and inv.uses >= inv.max_uses then
    return jsonb_build_object('ok', false, 'reason', 'used_up');
  end if;
  select * into me from public.profiles where id = auth.uid() for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;
  if me.is_station then
    return jsonb_build_object('ok', false, 'reason', 'station');
  end if;

  update public.profiles
     set active = true,
         team_id = coalesce(team_id, inv.team_id)
   where id = me.id;
  if inv.team_id is not null and me.team_id is not null and me.team_id <> inv.team_id then
    insert into public.profile_teams (profile_id, team_id) values (me.id, inv.team_id)
    on conflict do nothing;
  end if;
  update public.team_invites set uses = uses + 1 where code = inv.code;
  return jsonb_build_object('ok', true, 'team_id', inv.team_id, 'was_active', me.active);
end $$;
revoke all on function public.redeem_invite(text) from public, anon;
grant execute on function public.redeem_invite(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 实时订阅
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'app_settings') then
    alter publication supabase_realtime add table public.app_settings;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'holidays') then
    alter publication supabase_realtime add table public.holidays;
  end if;
end $$;
