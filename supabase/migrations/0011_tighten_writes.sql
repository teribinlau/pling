-- 叮一下 · 收紧几处写权限（继承自 DZF 的规则只检查了「是不是本人」）
-- 重复执行无害。
--
-- 完成记录、稍后提醒、讨论已读：以前只要求「记的是自己」，没检查这条提醒 / 讨论自己看不看得到。
-- 虽然要知道对方的 id 才能写，但还是补上：看得到才能写。

drop policy if exists completions_insert on public.completions;
create policy completions_insert on public.completions for insert to authenticated
  with check (
    completed_by = auth.uid()
    and public.is_active()
    and exists (select 1 from public.reminders r where r.id = reminder_id and public.can_see_reminder(r))
  );

drop policy if exists snoozes_own on public.snoozes;
create policy snoozes_own on public.snoozes for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.reminders r where r.id = reminder_id and public.can_see_reminder(r))
  );

drop policy if exists discussion_reads_own on public.discussion_reads;
create policy discussion_reads_own on public.discussion_reads for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.discussions d where d.id = discussion_id and public.can_see_discussion(d))
  );
