-- 叮一下 · 多链接 + 回传文件（继承自 DZF 提醒 v0.1.2）
-- 重复执行无害。
--
-- 1. reminders.link 现在可以放多行：每行一个链接，可写「名称 链接」，前端自己拆
-- 2. reminders.require_upload = true 的提醒：员工必须上传文件（填好的表格 / 照片）才能点完成
-- 3. submissions：回传记录（谁、什么时候、传了哪个文件）；文件本体存 Storage 桶 submissions（私有，签名链接下载）

alter table public.reminders
  add column if not exists require_upload boolean not null default false;

create table if not exists public.submissions (
  id                uuid primary key default gen_random_uuid(),
  reminder_id       uuid not null references public.reminders(id) on delete cascade,
  occurrence_at     timestamptz not null,
  uploaded_by       uuid not null references public.profiles(id) on delete cascade,
  uploaded_by_name  text not null default '',   -- 工位模式下选的名字
  file_path         text not null,              -- Storage 里的对象路径：<reminder_id>/<occurrence>/<随机名>
  file_name         text not null,              -- 原始文件名（可以含中文）
  size              bigint not null default 0,
  mime              text not null default '',
  created_at        timestamptz not null default now()
);
create index if not exists submissions_reminder_idx on public.submissions (reminder_id, occurrence_at);

alter table public.submissions enable row level security;

-- 能看到提醒的人都能看回传记录
drop policy if exists submissions_select on public.submissions;
create policy submissions_select on public.submissions for select to authenticated
  using (exists (select 1 from public.reminders r where r.id = reminder_id and public.can_see_reminder(r)));

-- 本人只能以自己的名义上传
drop policy if exists submissions_insert on public.submissions;
create policy submissions_insert on public.submissions for insert to authenticated
  with check (uploaded_by = auth.uid() and public.is_active());

-- 上传人、提醒创建人、管理员可删
drop policy if exists submissions_delete on public.submissions;
create policy submissions_delete on public.submissions for delete to authenticated
  using (
    uploaded_by = auth.uid()
    or public.is_admin()
    or exists (select 1 from public.reminders r where r.id = reminder_id and r.created_by = auth.uid())
  );

-- 实时订阅（已加过就跳过）
do $$
begin
  alter publication supabase_realtime add table public.submissions;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Storage：私有桶 submissions，单文件最大 20 MB
-- 对象路径第一段是提醒 id → 权限跟着提醒的可见范围走
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('submissions', 'submissions', false, 20971520)
on conflict (id) do update set public = false, file_size_limit = 20971520;

drop policy if exists submissions_storage_select on storage.objects;
create policy submissions_storage_select on storage.objects for select to authenticated
  using (
    bucket_id = 'submissions'
    and exists (
      select 1 from public.reminders r
      where r.id::text = (storage.foldername(name))[1] and public.can_see_reminder(r)
    )
  );

drop policy if exists submissions_storage_insert on storage.objects;
create policy submissions_storage_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'submissions'
    and public.is_active()
    and exists (
      select 1 from public.reminders r
      where r.id::text = (storage.foldername(name))[1] and public.can_see_reminder(r)
    )
  );

drop policy if exists submissions_storage_delete on storage.objects;
create policy submissions_storage_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'submissions'
    and (
      owner_id = auth.uid()::text
      or public.is_admin()
      or exists (
        select 1 from public.reminders r
        where r.id::text = (storage.foldername(name))[1] and r.created_by = auth.uid()
      )
    )
  );
