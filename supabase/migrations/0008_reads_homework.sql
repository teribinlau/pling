-- 叮一下 · 已读回执 + 作业批改
-- 重复执行无害。

-- ---------------------------------------------------------------------------
-- 已读回执：某人看过某条提醒的某一次到期（打开详情、点开服务号消息都算）
-- 只有提醒的创建人和管理员能看到别人读没读；每个人能看到自己的
-- ---------------------------------------------------------------------------
create table if not exists public.reminder_reads (
  reminder_id    uuid not null references public.reminders(id) on delete cascade,
  occurrence_at  timestamptz not null,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  read_at        timestamptz not null default now(),
  primary key (reminder_id, occurrence_at, user_id)
);
create index if not exists reminder_reads_user_idx on public.reminder_reads (user_id);

-- 已读时间一律用服务器时间
create or replace function public.stamp_read_at() returns trigger
language plpgsql as $$
begin
  new.read_at = now();
  return new;
end $$;
drop trigger if exists reminder_reads_stamp on public.reminder_reads;
create trigger reminder_reads_stamp before insert on public.reminder_reads
  for each row execute function public.stamp_read_at();

alter table public.reminder_reads enable row level security;

drop policy if exists reminder_reads_select on public.reminder_reads;
create policy reminder_reads_select on public.reminder_reads for select to authenticated
  using (
    user_id = auth.uid()
    or public.is_admin()
    or exists (select 1 from public.reminders r where r.id = reminder_id and r.created_by = auth.uid())
  );

drop policy if exists reminder_reads_insert on public.reminder_reads;
create policy reminder_reads_insert on public.reminder_reads for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.is_active()
    and exists (select 1 from public.reminders r where r.id = reminder_id and public.can_see_reminder(r))
  );

-- 不能改、不能删（提醒删了跟着删）

-- ---------------------------------------------------------------------------
-- 作业批改：回传文件可以被提醒的创建人 / 管理员标成「通过」或「退回」（带一句批语）
-- 迟交 = 提交时间（服务器时间）晚于这一次的到期时间，前端算
-- ---------------------------------------------------------------------------
alter table public.submissions
  add column if not exists status       text not null default 'submitted',
  add column if not exists review_note  text not null default '',
  add column if not exists reviewed_by  uuid references public.profiles(id) on delete set null,
  add column if not exists reviewed_at  timestamptz;

do $$
begin
  alter table public.submissions add constraint submissions_status_check
    check (status in ('submitted','returned','accepted'));
exception when duplicate_object then null;
end $$;

-- 新交的文件：时间用服务器的，状态一律是「已交」（客户端传什么都不算）
create or replace function public.submissions_before_insert() returns trigger
language plpgsql as $$
begin
  new.created_at  = now();
  new.status      = 'submitted';
  new.review_note = '';
  new.reviewed_by = null;
  new.reviewed_at = null;
  return new;
end $$;
drop trigger if exists submissions_stamp on public.submissions;
create trigger submissions_stamp before insert on public.submissions
  for each row execute function public.submissions_before_insert();

-- 批改：只能改 status / review_note，谁改的、什么时候改的由服务器记
create or replace function public.submissions_before_update() returns trigger
language plpgsql as $$
begin
  if new.reminder_id      is distinct from old.reminder_id
     or new.occurrence_at is distinct from old.occurrence_at
     or new.uploaded_by   is distinct from old.uploaded_by
     or new.uploaded_by_name is distinct from old.uploaded_by_name
     or new.file_path     is distinct from old.file_path
     or new.file_name     is distinct from old.file_name
     or new.size          is distinct from old.size
     or new.mime          is distinct from old.mime
     or new.created_at    is distinct from old.created_at then
    raise exception 'only status and review_note can be changed' using errcode = '42501';
  end if;
  new.review_note = left(coalesce(new.review_note, ''), 500);
  if new.status is distinct from old.status or new.review_note is distinct from old.review_note then
    new.reviewed_by = auth.uid();
    new.reviewed_at = now();
  end if;
  return new;
end $$;
drop trigger if exists submissions_review on public.submissions;
create trigger submissions_review before update on public.submissions
  for each row execute function public.submissions_before_update();

drop policy if exists submissions_review on public.submissions;
create policy submissions_review on public.submissions for update to authenticated
  using (
    public.is_admin()
    or exists (select 1 from public.reminders r where r.id = reminder_id and r.created_by = auth.uid())
  )
  with check (
    public.is_admin()
    or exists (select 1 from public.reminders r where r.id = reminder_id and r.created_by = auth.uid())
  );

-- 交文件也要看得到这条提醒（以前只查了「是不是本人」）
drop policy if exists submissions_insert on public.submissions;
create policy submissions_insert on public.submissions for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and public.is_active()
    and exists (select 1 from public.reminders r where r.id = reminder_id and public.can_see_reminder(r))
  );

-- 退回重交：提醒的创建人可以撤掉某人这一次的「已完成」，让他重新交
drop policy if exists completions_delete on public.completions;
create policy completions_delete on public.completions for delete to authenticated
  using (
    completed_by = auth.uid()
    or public.is_admin()
    or exists (select 1 from public.reminders r where r.id = reminder_id and r.created_by = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 实时订阅
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'reminder_reads') then
    alter publication supabase_realtime add table public.reminder_reads;
  end if;
end $$;
