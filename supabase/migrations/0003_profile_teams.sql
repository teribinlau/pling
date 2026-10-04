-- 叮一下 · 一个人可以兼任多个班组（继承自 DZF 提醒 v0.2.0）
-- 重复执行无害。
--
-- profiles.team_id 还是「主班组」：决定卡片颜色、新建提醒的默认归属、成员列表里的分组。
-- profile_teams 是「兼任班组」：这些班组的提醒他也能看到、也会被指派到。

create table if not exists public.profile_teams (
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  team_id     uuid not null references public.teams(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (profile_id, team_id)
);
create index if not exists profile_teams_team_idx on public.profile_teams (team_id);

alter table public.profile_teams enable row level security;

-- 人人可读（界面要算「这条提醒跟谁有关」）；只有管理员能改
drop policy if exists profile_teams_select on public.profile_teams;
create policy profile_teams_select on public.profile_teams for select to authenticated using (true);
drop policy if exists profile_teams_admin_write on public.profile_teams;
create policy profile_teams_admin_write on public.profile_teams for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- 我所属的全部班组 = 主班组 + 兼任
create or replace function public.my_team_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select team_id from public.profiles where id = auth.uid() and team_id is not null
  union
  select team_id from public.profile_teams where profile_id = auth.uid();
$$;

-- 可见范围和指派都改成「我所属的任一班组」
create or replace function public.can_see_reminder(r public.reminders) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_active() and (
    r.created_by = auth.uid()
    or r.visibility = 'company'
    or (r.visibility = 'team' and r.team_id is not null and r.team_id in (select public.my_team_ids()))
    or exists (
      select 1 from public.reminder_assignees a
      where a.reminder_id = r.id
        and (a.user_id = auth.uid() or a.team_id in (select public.my_team_ids()))
    )
    or public.is_admin()
  );
$$;

-- 实时订阅（已加过就跳过）
do $$
begin
  alter publication supabase_realtime add table public.profile_teams;
exception when duplicate_object then null;
end $$;
