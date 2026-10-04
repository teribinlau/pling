-- 叮一下 · Pling · 数据库结构（基础表）
-- 由部署脚本按文件名顺序执行（deploy/scripts/migrate.sh），每个文件重复执行无害。
-- 所有时间都存 timestamptz（UTC）；显示和展开重复规则按机构设置里的时区（默认 Asia/Shanghai，见 0007）。
-- 这一套表从 DZF 提醒 v0.6.2 继承而来（班组、提醒、指派、完成、稍后提醒）。

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 班组
-- ---------------------------------------------------------------------------
create table if not exists public.teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  color       text not null default '#0E7C6B',
  sort        int  not null default 0,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 用户资料（auth.users 的镜像 + 业务字段）
-- role: admin / member；is_station = 工位账号（多人共用的电脑）
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  name        text not null,
  team_id     uuid references public.teams(id) on delete set null,
  role        text not null default 'member' check (role in ('admin','member')),
  lang        text not null default 'zh-CN' check (lang in ('zh-CN','en-US')),
  is_station  boolean not null default false,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 提醒
-- rrule: null = 一次性；否则形如 FREQ=DAILY | FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR | FREQ=MONTHLY
-- visibility: private（仅自己）/ team（本班组）/ company（全公司）
-- completion_mode: any（任一人完成即完成）/ each（每人各自完成）
-- ---------------------------------------------------------------------------
create table if not exists public.reminders (
  id                 uuid primary key default gen_random_uuid(),
  title              text not null,
  notes              text not null default '',
  due_at             timestamptz not null,
  tz                 text not null default 'Asia/Shanghai',
  rrule              text,
  skip_holidays      boolean not null default true,
  remind_before_min  int not null default 15,
  overdue_repeat_min int not null default 30,
  priority           text not null default 'medium' check (priority in ('low','medium','high')),
  visibility         text not null default 'team' check (visibility in ('private','team','company')),
  team_id            uuid references public.teams(id) on delete set null,
  created_by         uuid not null references public.profiles(id) on delete cascade,
  link               text not null default '',
  completion_mode    text not null default 'any' check (completion_mode in ('any','each')),
  archived           boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists reminders_due_at_idx on public.reminders (due_at);
create index if not exists reminders_team_idx   on public.reminders (team_id);

-- 外部来源（以后做导入用）：source 是来源名，source_key 是该来源里的唯一键；手动建的都是 null
alter table public.reminders
  add column if not exists source     text,
  add column if not exists source_key text;
create unique index if not exists reminders_source_key_idx
  on public.reminders (source, source_key)
  where source_key is not null;

-- ---------------------------------------------------------------------------
-- 指派：给人或给班组（二选一）
-- ---------------------------------------------------------------------------
create table if not exists public.reminder_assignees (
  id           uuid primary key default gen_random_uuid(),
  reminder_id  uuid not null references public.reminders(id) on delete cascade,
  user_id      uuid references public.profiles(id) on delete cascade,
  team_id      uuid references public.teams(id) on delete cascade,
  check ((user_id is null) <> (team_id is null)),
  unique (reminder_id, user_id, team_id)
);
create index if not exists assignees_reminder_idx on public.reminder_assignees (reminder_id);

-- ---------------------------------------------------------------------------
-- 完成记录：重复提醒的每一次到期（occurrence_at）单独记
-- completed_by_name：工位模式下点完成的人选的名字
-- ---------------------------------------------------------------------------
create table if not exists public.completions (
  id                 uuid primary key default gen_random_uuid(),
  reminder_id        uuid not null references public.reminders(id) on delete cascade,
  occurrence_at      timestamptz not null,
  completed_by       uuid not null references public.profiles(id) on delete cascade,
  completed_by_name  text not null default '',
  completed_at       timestamptz not null default now(),
  note               text not null default '',
  unique (reminder_id, occurrence_at, completed_by)
);
create index if not exists completions_reminder_idx on public.completions (reminder_id, occurrence_at);

-- ---------------------------------------------------------------------------
-- 稍后提醒：只影响自己这台设备
-- ---------------------------------------------------------------------------
create table if not exists public.snoozes (
  id             uuid primary key default gen_random_uuid(),
  reminder_id    uuid not null references public.reminders(id) on delete cascade,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  occurrence_at  timestamptz not null,
  until          timestamptz not null,
  unique (reminder_id, user_id, occurrence_at)
);

-- ---------------------------------------------------------------------------
-- 辅助函数（security definer，避免 RLS 递归）
-- ---------------------------------------------------------------------------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' and active from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select active from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.my_team_id() returns uuid
language sql stable security definer set search_path = public as $$
  select team_id from public.profiles where id = auth.uid();
$$;

create or replace function public.can_see_reminder(r public.reminders) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_active() and (
    r.created_by = auth.uid()
    or r.visibility = 'company'
    or (r.visibility = 'team' and r.team_id is not null and r.team_id = public.my_team_id())
    or exists (
      select 1 from public.reminder_assignees a
      where a.reminder_id = r.id
        and (a.user_id = auth.uid() or a.team_id = public.my_team_id())
    )
    or public.is_admin()
  );
$$;

-- updated_at 自动更新
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;
drop trigger if exists reminders_touch on public.reminders;
create trigger reminders_touch before update on public.reminders
  for each row execute function public.touch_updated_at();

-- 新用户首次登录 → 自动建 profile。
-- 第一个用户自动成为管理员并激活；之后的用户默认「待激活」，由管理员在「账户与班组」里激活并分班组，
-- 这样不需要 service key 也能控制谁能进系统（任何邮箱都能收登录链接，但激活前什么也看不到）。
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  first_user boolean;
begin
  select not exists (select 1 from public.profiles) into first_user;
  insert into public.profiles (id, email, name, role, active)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'name', split_part(coalesce(new.email,''), '@', 1)),
    case when first_user then 'admin' else 'member' end,
    first_user
  )
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 至少保留一名管理员
create or replace function public.keep_one_admin() returns trigger
language plpgsql as $$
begin
  if old.role = 'admin' and (new.role <> 'admin' or new.active = false) then
    if (select count(*) from public.profiles where role = 'admin' and active and id <> old.id) = 0 then
      raise exception 'at least one active admin is required';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists profiles_keep_admin on public.profiles;
create trigger profiles_keep_admin before update on public.profiles
  for each row execute function public.keep_one_admin();

-- ---------------------------------------------------------------------------
-- 行级权限（RLS）
-- ---------------------------------------------------------------------------
alter table public.teams              enable row level security;
alter table public.profiles           enable row level security;
alter table public.reminders          enable row level security;
alter table public.reminder_assignees enable row level security;
alter table public.completions        enable row level security;
alter table public.snoozes            enable row level security;

-- teams：人人可读，管理员可改
drop policy if exists teams_select on public.teams;
create policy teams_select on public.teams for select to authenticated using (true);
drop policy if exists teams_admin_write on public.teams;
create policy teams_admin_write on public.teams for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- profiles：人人可读（要显示同事名字）；本人可改语言 / 名字；管理员可改角色 / 班组 / 工位
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (true);
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and role = (select p.role from public.profiles p where p.id = auth.uid())
    and team_id is not distinct from (select p.team_id from public.profiles p where p.id = auth.uid())
    and is_station = (select p.is_station from public.profiles p where p.id = auth.uid())
  );
drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- reminders：按可见范围读；登录用户可建（created_by 必须是自己）；创建人或管理员可改删
drop policy if exists reminders_select on public.reminders;
create policy reminders_select on public.reminders for select to authenticated
  using (public.can_see_reminder(reminders));
drop policy if exists reminders_insert on public.reminders;
create policy reminders_insert on public.reminders for insert to authenticated
  with check (created_by = auth.uid() and public.is_active());
drop policy if exists reminders_update on public.reminders;
create policy reminders_update on public.reminders for update to authenticated
  using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());
drop policy if exists reminders_delete on public.reminders;
create policy reminders_delete on public.reminders for delete to authenticated
  using (created_by = auth.uid() or public.is_admin());

-- assignees：跟随提醒的可见性；创建人 / 管理员可写
drop policy if exists assignees_select on public.reminder_assignees;
create policy assignees_select on public.reminder_assignees for select to authenticated
  using (exists (select 1 from public.reminders r where r.id = reminder_id and public.can_see_reminder(r)));
drop policy if exists assignees_write on public.reminder_assignees;
create policy assignees_write on public.reminder_assignees for all to authenticated
  using (exists (select 1 from public.reminders r where r.id = reminder_id and (r.created_by = auth.uid() or public.is_admin())))
  with check (exists (select 1 from public.reminders r where r.id = reminder_id and (r.created_by = auth.uid() or public.is_admin())));

-- completions：能看到提醒的人都能看完成记录；本人可写自己的记录；管理员可删
drop policy if exists completions_select on public.completions;
create policy completions_select on public.completions for select to authenticated
  using (exists (select 1 from public.reminders r where r.id = reminder_id and public.can_see_reminder(r)));
drop policy if exists completions_insert on public.completions;
create policy completions_insert on public.completions for insert to authenticated
  with check (completed_by = auth.uid() and public.is_active());
drop policy if exists completions_delete on public.completions;
create policy completions_delete on public.completions for delete to authenticated
  using (completed_by = auth.uid() or public.is_admin());

-- snoozes：只看 / 改自己的
drop policy if exists snoozes_own on public.snoozes;
create policy snoozes_own on public.snoozes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 实时订阅
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
alter publication supabase_realtime add table public.reminders;
alter publication supabase_realtime add table public.reminder_assignees;
alter publication supabase_realtime add table public.completions;
alter publication supabase_realtime add table public.profiles;
alter publication supabase_realtime add table public.teams;
