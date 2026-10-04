-- 叮一下 · 讨论（继承自 DZF 提醒 v0.5.0）
-- 重复执行无害。
--
-- 谁都可以发起一个讨论：主题 + 内容 + 附件（照片、PDF、表格……）。
-- 范围和提醒一样选：全公司，或者指定的班组 / 人（兼任班组也算）。能看到的人都能在下面留言，留言也能带附件。
-- 只有发起人能「结束」讨论：结束后变只读（可以写一句结论），发起人随时可以重新打开。
-- 新留言不弹通知：客户端按 discussion_reads（每人每个讨论读到哪儿）算未读数，显示在「讨论」入口上。
-- 文件放私有桶 discussions，对象路径第一段是讨论 id，Storage 权限靠它判断。

-- ---------------------------------------------------------------------------
-- 讨论
-- visibility: company（全公司）/ members（只有 discussion_members 里的人和班组）
-- ---------------------------------------------------------------------------
create table if not exists public.discussions (
  id                uuid primary key default gen_random_uuid(),
  title             text not null check (length(btrim(title)) > 0),
  body              text not null default '',
  created_by        uuid not null references public.profiles(id) on delete cascade,
  created_by_name   text not null default '',            -- 工位账号发起时选的名字
  visibility        text not null default 'members' check (visibility in ('members','company')),
  closed_at         timestamptz,                          -- 不为空 = 已结束（只读）
  conclusion        text not null default '',             -- 结束时写的一句结论；重新打开后保留，下次结束时带出来
  comment_count     int not null default 0,               -- 留言条数（触发器维护）
  last_activity_at  timestamptz not null default now(),   -- 最近一次动静：新留言 / 改内容 / 结束 / 重新打开（算未读用）
  last_activity_by  uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists discussions_activity_idx on public.discussions (last_activity_at desc);

-- 范围：给人或给班组（二选一）
create table if not exists public.discussion_members (
  id             uuid primary key default gen_random_uuid(),
  discussion_id  uuid not null references public.discussions(id) on delete cascade,
  user_id        uuid references public.profiles(id) on delete cascade,
  team_id        uuid references public.teams(id) on delete cascade,
  check ((user_id is null) <> (team_id is null))
);
create index if not exists discussion_members_discussion_idx on public.discussion_members (discussion_id);
create index if not exists discussion_members_user_idx on public.discussion_members (user_id);
create index if not exists discussion_members_team_idx on public.discussion_members (team_id);

-- 留言
create table if not exists public.discussion_comments (
  id             uuid primary key default gen_random_uuid(),
  discussion_id  uuid not null references public.discussions(id) on delete cascade,
  author_id      uuid not null references public.profiles(id) on delete cascade,
  author_name    text not null default '',   -- 工位账号留言时选的名字
  body           text not null default '',
  created_at     timestamptz not null default now()
);
create index if not exists discussion_comments_discussion_idx on public.discussion_comments (discussion_id, created_at);
create index if not exists discussion_comments_created_idx on public.discussion_comments (created_at);

-- 文件：comment_id 为空 = 讨论正文的附件；否则是那条留言的附件
create table if not exists public.discussion_files (
  id             uuid primary key default gen_random_uuid(),
  discussion_id  uuid not null references public.discussions(id) on delete cascade,
  comment_id     uuid references public.discussion_comments(id) on delete cascade,
  uploaded_by    uuid not null references public.profiles(id) on delete cascade,
  file_path      text not null,              -- <discussion_id>/<随机名>.<ext>
  file_name      text not null,              -- 原始文件名（可以含中文）
  size           bigint not null default 0,
  mime           text not null default '',
  created_at     timestamptz not null default now()
);
create index if not exists discussion_files_discussion_idx on public.discussion_files (discussion_id, created_at);
create index if not exists discussion_files_comment_idx on public.discussion_files (comment_id);

-- 已读位置：每人每个讨论读到了哪一刻（存的是服务器时间 last_activity_at，不受各人电脑时钟影响）
create table if not exists public.discussion_reads (
  discussion_id  uuid not null references public.discussions(id) on delete cascade,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  last_read_at   timestamptz not null default now(),
  primary key (discussion_id, user_id)
);

-- ---------------------------------------------------------------------------
-- 谁能看到：发起人、全公司、范围里的人、范围里班组的人（主班组或兼任）、管理员
-- ---------------------------------------------------------------------------
create or replace function public.can_see_discussion(d public.discussions) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_active() and (
    d.created_by = auth.uid()
    or d.visibility = 'company'
    or exists (
      select 1 from public.discussion_members m
      where m.discussion_id = d.id
        and (m.user_id = auth.uid() or m.team_id in (select public.my_team_ids()))
    )
    or public.is_admin()
  );
$$;

-- ---------------------------------------------------------------------------
-- 触发器
-- ---------------------------------------------------------------------------

-- 讨论：计数、「最近动静」、结束时间只能由服务器算；已结束的讨论不能改内容（先重新打开）
create or replace function public.discussions_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.comment_count := 0;
    new.closed_at := null;
    new.created_at := now();
    new.last_activity_at := now();
    new.last_activity_by := new.created_by;
  elsif pg_trigger_depth() = 1 then
    -- 客户端直接改的（留言计数触发器改的时候 depth = 2，不走这里）
    if old.closed_at is not null and new.closed_at is not null and (
         new.title is distinct from old.title
      or new.body is distinct from old.body
      or new.visibility is distinct from old.visibility
      or new.conclusion is distinct from old.conclusion
    ) then
      raise exception 'discussion is closed';
    end if;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.comment_count := old.comment_count;
    new.last_activity_at := old.last_activity_at;
    new.last_activity_by := old.last_activity_by;
    if new.closed_at is not null and old.closed_at is null then
      new.closed_at := now();           -- 结束时间用服务器时间
    elsif new.closed_at is not null then
      new.closed_at := old.closed_at;   -- 已经结束的，结束时间不变
    end if;
    if new.title is distinct from old.title
      or new.body is distinct from old.body
      or new.visibility is distinct from old.visibility
      or new.closed_at is distinct from old.closed_at
      or new.conclusion is distinct from old.conclusion then
      new.last_activity_at := now();
      new.last_activity_by := auth.uid();
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists discussions_guard on public.discussions;
create trigger discussions_guard before insert or update on public.discussions
  for each row execute function public.discussions_guard();

-- 留言 / 文件的时间一律用服务器时间（未读数靠它比较，不能信客户端的钟）
create or replace function public.stamp_created_at() returns trigger
language plpgsql as $$
begin
  new.created_at := now();
  return new;
end $$;
drop trigger if exists discussion_comments_stamp on public.discussion_comments;
create trigger discussion_comments_stamp before insert on public.discussion_comments
  for each row execute function public.stamp_created_at();
drop trigger if exists discussion_files_stamp on public.discussion_files;
create trigger discussion_files_stamp before insert on public.discussion_files
  for each row execute function public.stamp_created_at();

-- 新留言：计数 +1，记下最近动静；删留言：计数 -1
create or replace function public.discussion_comments_count() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update public.discussions
       set comment_count = comment_count + 1,
           last_activity_at = new.created_at,
           last_activity_by = new.author_id
     where id = new.discussion_id;
    return new;
  end if;
  update public.discussions
     set comment_count = greatest(comment_count - 1, 0)
   where id = old.discussion_id;
  return old;
end $$;
drop trigger if exists discussion_comments_count on public.discussion_comments;
create trigger discussion_comments_count after insert or delete on public.discussion_comments
  for each row execute function public.discussion_comments_count();

-- 已读位置只往前走（手机和电脑先后标记已读时，不会被旧的覆盖回去）
create or replace function public.discussion_reads_forward() returns trigger
language plpgsql as $$
begin
  new.last_read_at := greatest(new.last_read_at, old.last_read_at);
  return new;
end $$;
drop trigger if exists discussion_reads_forward on public.discussion_reads;
create trigger discussion_reads_forward before update on public.discussion_reads
  for each row execute function public.discussion_reads_forward();

-- ---------------------------------------------------------------------------
-- 行级权限（RLS）
-- ---------------------------------------------------------------------------
alter table public.discussions         enable row level security;
alter table public.discussion_members  enable row level security;
alter table public.discussion_comments enable row level security;
alter table public.discussion_files    enable row level security;
alter table public.discussion_reads    enable row level security;

-- 讨论：按范围读；登录用户可发起（created_by 必须是自己）；
-- 只有发起人能改（编辑 / 结束 / 重新打开）；发起人和管理员能删
drop policy if exists discussions_select on public.discussions;
create policy discussions_select on public.discussions for select to authenticated
  using (public.can_see_discussion(discussions));
drop policy if exists discussions_insert on public.discussions;
create policy discussions_insert on public.discussions for insert to authenticated
  with check (created_by = auth.uid() and public.is_active());
drop policy if exists discussions_update on public.discussions;
create policy discussions_update on public.discussions for update to authenticated
  using (created_by = auth.uid() and public.is_active())
  with check (created_by = auth.uid());
drop policy if exists discussions_delete on public.discussions;
create policy discussions_delete on public.discussions for delete to authenticated
  using (created_by = auth.uid() or public.is_admin());

-- 范围：跟着讨论的可见性读；只有发起人能改
drop policy if exists discussion_members_select on public.discussion_members;
create policy discussion_members_select on public.discussion_members for select to authenticated
  using (exists (select 1 from public.discussions d where d.id = discussion_id and public.can_see_discussion(d)));
drop policy if exists discussion_members_write on public.discussion_members;
create policy discussion_members_write on public.discussion_members for all to authenticated
  using (exists (select 1 from public.discussions d where d.id = discussion_id and d.created_by = auth.uid()))
  with check (exists (select 1 from public.discussions d where d.id = discussion_id and d.created_by = auth.uid() and d.closed_at is null));

-- 留言：能看到讨论就能看、能留（结束后不能再留）；自己的留言在结束前能删，管理员随时能删
drop policy if exists discussion_comments_select on public.discussion_comments;
create policy discussion_comments_select on public.discussion_comments for select to authenticated
  using (exists (select 1 from public.discussions d where d.id = discussion_id and public.can_see_discussion(d)));
drop policy if exists discussion_comments_insert on public.discussion_comments;
create policy discussion_comments_insert on public.discussion_comments for insert to authenticated
  with check (
    author_id = auth.uid()
    and public.is_active()
    and exists (
      select 1 from public.discussions d
      where d.id = discussion_id and d.closed_at is null and public.can_see_discussion(d)
    )
  );
drop policy if exists discussion_comments_delete on public.discussion_comments;
create policy discussion_comments_delete on public.discussion_comments for delete to authenticated
  using (
    public.is_admin()
    or (
      author_id = auth.uid()
      and exists (select 1 from public.discussions d where d.id = discussion_id and d.closed_at is null)
    )
  );

-- 文件：能看到讨论就能看；正文附件只有发起人能加，留言附件只有留言人自己能加（都要在结束前）；
-- 上传人在结束前能删，管理员随时能删
drop policy if exists discussion_files_select on public.discussion_files;
create policy discussion_files_select on public.discussion_files for select to authenticated
  using (exists (select 1 from public.discussions d where d.id = discussion_id and public.can_see_discussion(d)));
drop policy if exists discussion_files_insert on public.discussion_files;
create policy discussion_files_insert on public.discussion_files for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and public.is_active()
    and exists (
      select 1 from public.discussions d
      where d.id = discussion_files.discussion_id
        and d.closed_at is null
        and public.can_see_discussion(d)
        and (
          (discussion_files.comment_id is null and d.created_by = auth.uid())
          or exists (
            select 1 from public.discussion_comments c
            where c.id = discussion_files.comment_id
              and c.discussion_id = d.id
              and c.author_id = auth.uid()
          )
        )
    )
  );
drop policy if exists discussion_files_delete on public.discussion_files;
create policy discussion_files_delete on public.discussion_files for delete to authenticated
  using (
    public.is_admin()
    or (
      uploaded_by = auth.uid()
      and exists (select 1 from public.discussions d where d.id = discussion_id and d.closed_at is null)
    )
  );

-- 已读位置：只看 / 改自己的
drop policy if exists discussion_reads_own on public.discussion_reads;
create policy discussion_reads_own on public.discussion_reads for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 实时订阅（已加过就跳过）
-- ---------------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table public.discussions;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.discussion_members;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.discussion_comments;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.discussion_files;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.discussion_reads;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Storage：私有桶 discussions，单文件最大 20 MB（照片上传前在客户端已经压到长边 2560px）
-- 对象路径第一段是讨论 id → 权限跟着讨论的范围走
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('discussions', 'discussions', false, 20971520)
on conflict (id) do update set public = false, file_size_limit = 20971520;

drop policy if exists discussions_storage_select on storage.objects;
create policy discussions_storage_select on storage.objects for select to authenticated
  using (
    bucket_id = 'discussions'
    and exists (
      select 1 from public.discussions d
      where d.id::text = (storage.foldername(name))[1] and public.can_see_discussion(d)
    )
  );

-- 只能往没结束、自己看得到的讨论里传
drop policy if exists discussions_storage_insert on storage.objects;
create policy discussions_storage_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'discussions'
    and public.is_active()
    and exists (
      select 1 from public.discussions d
      where d.id::text = (storage.foldername(name))[1] and d.closed_at is null and public.can_see_discussion(d)
    )
  );

-- 上传人、管理员能删；发起人删整个讨论时要能把别人留言里的文件一起清掉
drop policy if exists discussions_storage_delete on storage.objects;
create policy discussions_storage_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'discussions'
    and (
      owner_id = auth.uid()::text
      or public.is_admin()
      or exists (
        select 1 from public.discussions d
        where d.id::text = (storage.foldername(name))[1] and d.created_by = auth.uid()
      )
    )
  );
