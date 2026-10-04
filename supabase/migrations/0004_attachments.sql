-- 叮一下 · 提醒可以挂附件（继承自 DZF 提醒 v0.4.0）
-- 重复执行无害。
--
-- 和「回传文件」（submissions，员工完成时交的）分开：
--   reminder_attachments = 创建人放上去的参考材料，所有能看到提醒的人都能看 / 下载，
--   只有提醒的创建人和管理员能加、能删（和「编辑提醒」的权限一致）。
-- 文件本体放私有桶 attachments，对象路径第一段是提醒 id，Storage 权限靠它判断。

create table if not exists public.reminder_attachments (
  id           uuid primary key default gen_random_uuid(),
  reminder_id  uuid not null references public.reminders(id) on delete cascade,
  uploaded_by  uuid not null references public.profiles(id) on delete cascade,
  file_path    text not null,              -- <reminder_id>/<随机名>.<ext>
  file_name    text not null,              -- 原始文件名（可以含中文）
  size         bigint not null default 0,
  mime         text not null default '',
  created_at   timestamptz not null default now()
);
create index if not exists reminder_attachments_reminder_idx on public.reminder_attachments (reminder_id, created_at);

alter table public.reminder_attachments enable row level security;

-- 能看到提醒的人都能看附件
drop policy if exists reminder_attachments_select on public.reminder_attachments;
create policy reminder_attachments_select on public.reminder_attachments for select to authenticated
  using (exists (select 1 from public.reminders r where r.id = reminder_id and public.can_see_reminder(r)));

-- 只有提醒的创建人 / 管理员能加，而且只能以自己的名义
drop policy if exists reminder_attachments_insert on public.reminder_attachments;
create policy reminder_attachments_insert on public.reminder_attachments for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and public.is_active()
    and exists (
      select 1 from public.reminders r
      where r.id = reminder_id and (r.created_by = auth.uid() or public.is_admin())
    )
  );

-- 提醒的创建人 / 管理员能删
drop policy if exists reminder_attachments_delete on public.reminder_attachments;
create policy reminder_attachments_delete on public.reminder_attachments for delete to authenticated
  using (
    public.is_admin()
    or exists (select 1 from public.reminders r where r.id = reminder_id and r.created_by = auth.uid())
  );

-- 实时订阅（已加过就跳过）
do $$
begin
  alter publication supabase_realtime add table public.reminder_attachments;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Storage：私有桶 attachments，单文件最大 20 MB（照片上传前在客户端已经压到长边 2560px）
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 20971520)
on conflict (id) do update set public = false, file_size_limit = 20971520;

drop policy if exists attachments_storage_select on storage.objects;
create policy attachments_storage_select on storage.objects for select to authenticated
  using (
    bucket_id = 'attachments'
    and exists (
      select 1 from public.reminders r
      where r.id::text = (storage.foldername(name))[1] and public.can_see_reminder(r)
    )
  );

drop policy if exists attachments_storage_insert on storage.objects;
create policy attachments_storage_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and public.is_active()
    and exists (
      select 1 from public.reminders r
      where r.id::text = (storage.foldername(name))[1] and (r.created_by = auth.uid() or public.is_admin())
    )
  );

drop policy if exists attachments_storage_delete on storage.objects;
create policy attachments_storage_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'attachments'
    and (
      public.is_admin()
      or exists (
        select 1 from public.reminders r
        where r.id::text = (storage.foldername(name))[1] and r.created_by = auth.uid()
      )
    )
  );
