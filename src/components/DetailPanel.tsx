import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import { useOccurrences, useSelected } from '../lib/useData';
import { resolveAssignees, teamName } from '../lib/occurrences';
import { hasValidHomework, isSubmissionOf, personHomework, uploadRequiredFor } from '../lib/homework';
import { beforeLabel, dateLabel, hm, relativeLabel, repeatLabel, whenLabel } from '../lib/format';
import { localYmd } from '../lib/recurrence';
import { linkTitle, parseLinks } from '../lib/links';
import { isMacDesktop, openExternal } from '../lib/tauri';
import type { Submission } from '../lib/types';
import { Avatar } from './Avatar';
import { IconCheck, IconDownload, IconEdit, IconExternal, IconPaperclip, IconTrash, IconUpload, IconX } from './Icons';
import { FileGallery } from './FileGallery';
import { FileTray } from './FileTray';
import { HomeworkPanel, MyHomework, ReadReceipts, useAudience, useCanReview } from './ReminderInsights';

export function DetailPanel() {
  const { t } = useTranslation();
  const now = new Date();
  const from = useMemo(() => new Date(now.getTime() - 62 * 86400000), [now.getDate()]); // eslint-disable-line react-hooks/exhaustive-deps
  const to = useMemo(() => new Date(now.getTime() + 60 * 86400000), [now.getDate()]); // eslint-disable-line react-hooks/exhaustive-deps
  const occs = useOccurrences(from, to, false, true);
  const o = useSelected(occs);
  const teams = useStore((s) => s.teams);
  const profiles = useStore((s) => s.profiles);
  const assignees = useStore((s) => s.assignees);
  const memberships = useStore((s) => s.memberships);
  const completions = useStore((s) => s.completions);
  const me = useStore((s) => s.me);
  const requestComplete = useStore((s) => s.requestComplete);
  const uncomplete = useStore((s) => s.uncomplete);
  const snooze = useStore((s) => s.snooze);
  const openEdit = useStore((s) => s.openEdit);
  const deleteReminder = useStore((s) => s.deleteReminder);
  const uploadSubmission = useStore((s) => s.uploadSubmission);
  const deleteSubmission = useStore((s) => s.deleteSubmission);
  const uploading = useStore((s) => s.uploading);
  const uploadProgress = useStore((s) => s.uploadProgress);
  const complete = useStore((s) => s.complete);
  const attachments = useStore((s) => s.attachments);
  const attachFiles = useStore((s) => s.attachFiles);
  const deleteAttachment = useStore((s) => s.deleteAttachment);
  const repo = useStore((s) => s.repo);
  const pushToast = useStore((s) => s.pushToast);
  const select = useStore((s) => s.select);
  const markRead = useStore((s) => s.markRead);
  const mobileOpen = useStore((s) => s.mobileDetailOpen);
  const canReview = useCanReview(o);
  const audience = useAudience(o);

  const completeInput = useRef<HTMLInputElement>(null);
  const moreInput = useRef<HTMLInputElement>(null);
  const attInput = useRef<HTMLInputElement>(null);
  // 要交的文件先放进托盘，确认后再上传 —— 可以分几次加（先拍一张、再从相册挑几张、再加个 PDF）
  const [stash, setStash] = useState<File[]>([]);
  const [stashMode, setStashMode] = useState<'complete' | 'more' | null>(null);
  const oKey = o?.key;
  useEffect(() => {
    setStash([]);
    setStashMode(null);
  }, [oKey]);
  const [zipping, setZipping] = useState(false);
  const [canZip, setCanZip] = useState(true);
  useEffect(() => {
    void isMacDesktop().then((mac) => setCanZip(!mac));
  }, []);

  // 已读回执：详情打开、窗口在前台且有焦点才算看过（托盘里挂着、切到别的窗口都不算）
  useEffect(() => {
    if (!o) return;
    const target = o;
    const mark = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) markRead(target);
    };
    mark();
    window.addEventListener('focus', mark);
    document.addEventListener('visibilitychange', mark);
    return () => {
      window.removeEventListener('focus', mark);
      document.removeEventListener('visibilitychange', mark);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oKey, markRead]);

  if (!o) {
    return (
      <aside className={`detail ${mobileOpen ? 'open' : ''}`}>
        <div className="hint">{t('detail.selectHint')}</div>
      </aside>
    );
  }
  const r = o.reminder;
  const team = teams.find((x) => x.id === r.team_id);
  const color = team?.color ?? 'var(--ink)';
  const { people, teams: assignedTeams } = resolveAssignees(r, assignees, profiles, teams, memberships);
  const creator = profiles.find((p) => p.id === r.created_by);
  const canEdit = me && (me.id === r.created_by || me.role === 'admin');
  const rel = relativeLabel(o.at);
  const links = parseLinks(r.link).filter((l) => l.url);
  const history = completions
    .filter((c) => c.reminder_id === r.id)
    .sort((a, b) => new Date(b.occurrence_at).getTime() - new Date(a.occurrence_at).getTime())
    .slice(0, 6);
  // 重复提醒：补上最近几次「未完成」的记录
  const missed = r.rrule ? occs.filter((x) => x.reminder.id === r.id && x.at < now && !x.completion && x.key !== o.key).slice(-3) : [];
  const rows = [
    ...history.map((c) => ({ key: c.id, at: new Date(c.occurrence_at), ok: true, who: c.completed_by_name || profiles.find((p) => p.id === c.completed_by)?.name || '', time: hm(new Date(c.completed_at)) })),
    ...missed.map((x) => ({ key: x.key, at: x.at, ok: false, who: '', time: '' })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 6);
  const assigneeLabel = assignedTeams.length ? assignedTeams.map((tm) => t('detail.wholeTeam', { name: teamName(tm) })).join(' · ') : t('detail.people', { n: people.length });

  // ---- 回传文件 / 作业 ----
  const isStation = !!me?.is_station;
  const homework = r.require_upload;
  // 我要不要交：受众里的人（学生）、共用设备要交；布置作业的老师（创建人 / 管理员，不在受众里）不用交
  const mustUpload = !!me && uploadRequiredFor(r, me, audience);
  // 我自己（普通成员）这一次的作业：被退回的不算交过，要重交
  const myHw = me && !isStation ? personHomework(o.submissions.filter((s) => isSubmissionOf(s, me)), o.at) : null;
  const mine = me ? hasValidHomework(o, me) : false;
  const subName = (s: Submission) => s.uploaded_by_name || profiles.find((p) => p.id === s.uploaded_by)?.name || '';
  const canDeleteSub = (s: Submission) => !!me && (s.uploaded_by === me.id || me.role === 'admin' || r.created_by === me.id);
  // 普通提醒附带的文件：大家都能看；需要回传的：共用设备看整个小组谁交了（按名字对），创建人 / 管理员看统计
  const showAllFiles = !homework ? o.submissions.length > 0 : isStation && !canReview;
  // 未交名单跟老师那边的统计用同一个受众（不含布置作业的人自己）
  const stationMissing = homework && isStation && r.completion_mode === 'each' ? audience.filter((p) => !hasValidHomework(o, p)) : null;

  // 第一次选文件必须在按钮的点击里直接弹（iPhone Safari 不允许别处弹文件选择），选完进托盘
  const takeFiles = (input: HTMLInputElement | null, mode: 'complete' | 'more') => {
    const files = Array.from(input?.files ?? []);
    if (input) input.value = '';
    if (!files.length) return;
    const seen = new Set(stash.map((f) => `${f.name}|${f.size}`));
    setStash([...stash, ...files.filter((f) => !seen.has(`${f.name}|${f.size}`))]);
    setStashMode(mode);
  };
  const clearStash = () => {
    setStash([]);
    setStashMode(null);
  };
  const submitStash = async () => {
    if (!stash.length) return;
    // 共用设备：先选是谁，文件交给选人弹窗一起传（已完成的话只是多传一份）
    if (isStation) {
      requestComplete(o, stash);
      clearStash();
      return;
    }
    const ok = stashMode === 'complete' ? await complete(o, undefined, stash) : await uploadSubmission(o, stash);
    if (ok) clearStash(); // 没传成功就留在托盘里，可以直接再点一次
  };
  const onAttFiles = async () => {
    const files = Array.from(attInput.current?.files ?? []);
    if (attInput.current) attInput.current.value = '';
    if (!files.length) return;
    if (!navigator.onLine) {
      pushToast({ title: t('errors.needOnline'), body: '', kind: 'error' });
      return;
    }
    const failed = await attachFiles(r.id, files);
    if (failed.length) pushToast({ title: t('errors.attachFailed', { count: failed.length }), body: failed.join('、'), kind: 'error' });
  };
  const atts = attachments.filter((a) => a.reminder_id === r.id);
  const progressLabel = uploadProgress ? t('files.uploadingN', uploadProgress) : t('actions.uploading');
  const downloadAll = async () => {
    setZipping(true);
    try {
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      const used = new Set<string>();
      for (const s of o.submissions) {
        const res = await fetch(await repo.submissionUrl(s));
        if (!res.ok) throw new Error(`${res.status} ${s.file_name}`);
        const who = subName(s).replace(/[\\/:*?"<>|]/g, '_');
        let name = who ? `${who}_${s.file_name}` : s.file_name;
        let i = 2;
        while (used.has(name)) name = `${i++}_${name}`;
        used.add(name);
        zip.file(name, await res.blob());
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${r.title.slice(0, 40).replace(/[\\/:*?"<>|]/g, '_')}_${localYmd(o.at)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      pushToast({ title: t('errors.downloadFailed'), body: (e as Error).message, kind: 'error' });
    } finally {
      setZipping(false);
    }
  };
  // 还能补交：已经完成了、交过（没被退回）、或者是普通提醒；交作业的人被通过了就不用再交
  const canUploadMore = !stashMode && (!!o.completion || mine || !homework) && myHw?.status !== 'accepted' && !(homework && isStation);
  const showMyFilesBlock = homework && !!myHw && !canReview && myHw.status !== 'missing';

  return (
    <aside className={`detail ${mobileOpen ? 'open' : ''}`} aria-label={t('detail.title')}>
      <div className="head">
        <span className="kicker">{t('detail.title')}</span>
        {canEdit && (
          <>
            <button className="icon-btn" aria-label={t('actions.edit')} onClick={() => openEdit(r.id)}>
              <IconEdit size={16} />
            </button>
            <button
              className="icon-btn"
              aria-label={t('actions.delete')}
              onClick={() => {
                if (window.confirm(t('actions.confirmDelete'))) void deleteReminder(r.id);
              }}
            >
              <IconTrash size={16} />
            </button>
          </>
        )}
        <button className="icon-btn" aria-label={t('actions.close')} onClick={() => select(null)}>
          <IconX size={16} />
        </button>
      </div>

      <div className="field" style={{ gap: 8 }}>
        <span className="label" style={{ color }}>
          {[teamName(team), r.priority === 'high' ? t('priority.highLabel') : '', t(`visibility.${r.visibility}`), r.require_upload ? t('submit.badge') : ''].filter(Boolean).join(' · ')}
        </span>
        <h2>{r.title}</h2>
      </div>

      <div className="time-block">
        <span className="big">{hm(o.at)}</span>
        <div className="lines">
          {o.completion ? (
            <span className="ok">
              {t('actions.completed')} · {o.completion.completed_by_name || profiles.find((p) => p.id === o.completion!.completed_by)?.name}
            </span>
          ) : (
            <span className={rel.hot ? 'hot' : ''}>
              {whenLabel(o.at, false)} · {rel.text}
            </span>
          )}
          <span>
            {repeatLabel(r)} · {beforeLabel(r.remind_before_min)}
          </span>
          {r.overdue_repeat_min > 0 && <span>{t('form.overdueRepeat', { n: r.overdue_repeat_min })}</span>}
        </div>
      </div>

      <div className="field" style={{ gap: 8 }}>
        <span className="kicker">{t('detail.assignees')}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="avatars" style={{ paddingLeft: 6 }}>
            {people.slice(0, 6).map((p) => (
              <Avatar key={p.id} p={p} />
            ))}
          </span>
          <span className="hint-text">
            {assigneeLabel} · {t(`completionMode.${r.completion_mode}`)}
          </span>
        </div>
      </div>

      {canReview && r.visibility !== 'private' && <ReadReceipts o={o} audience={audience} />}

      {r.notes && (
        <div className="field" style={{ gap: 6 }}>
          <span className="kicker">{t('detail.notes')}</span>
          <p style={{ whiteSpace: 'pre-line' }}>{r.notes}</p>
        </div>
      )}

      {links.length > 0 && (
        <div className="field" style={{ gap: 6 }}>
          <span className="kicker">{t('detail.links')}</span>
          <div className="links">
            {links.map((l, i) => (
              <a
                key={i}
                className="link-row"
                href={l.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => {
                  e.preventDefault();
                  void openExternal(l.url);
                }}
              >
                <IconExternal size={13} />
                <span className="link-title">{linkTitle(l)}</span>
                {l.label && <span className="link-host">{linkTitle({ label: '', url: l.url })}</span>}
              </a>
            ))}
          </div>
        </div>
      )}

      {atts.length > 0 && (
        <div className="field" style={{ gap: 6 }}>
          <div className="sec-line">
            <span className="kicker grow">
              {t('detail.attachments')} · {atts.length}
            </span>
            {canEdit && (
              <button className="mini-btn" onClick={() => attInput.current?.click()} disabled={uploading}>
                <IconPaperclip size={12} />
                {uploading && !stashMode ? progressLabel : t('files.add')}
              </button>
            )}
          </div>
          <FileGallery
            bucket="attachments"
            items={atts}
            canDelete={() => !!canEdit}
            onDelete={(it) => {
              const a = atts.find((x) => x.id === it.id);
              if (a) void deleteAttachment(a);
            }}
          />
          <input ref={attInput} type="file" multiple hidden onChange={() => void onAttFiles()} />
        </div>
      )}

      {/* macOS 桌面壳（WKWebView）不处理 <a download>：导出名单和全部下载一样藏起来，「复制表格」照样能用 */}
      {homework && canReview && <HomeworkPanel o={o} audience={audience} canExport={canZip} zipping={zipping} onZip={canZip ? () => void downloadAll() : undefined} />}

      {showMyFilesBlock && <MyHomework o={o} hw={myHw!} onDelete={(s) => void deleteSubmission(s)} />}

      {(showAllFiles || (showMyFilesBlock && canUploadMore) || (!homework && canUploadMore && !!o.completion)) && (
        <div className="field" style={{ gap: 6 }}>
          <div className="sec-line">
            <span className="kicker grow">
              {showAllFiles ? t('detail.submissions') : ''}
              {showAllFiles && o.submissions.length > 0 ? ` · ${o.submissions.length}` : ''}
            </span>
            {showAllFiles && o.submissions.length > 0 && canZip && (
              <button className="mini-btn" onClick={() => void downloadAll()} disabled={zipping}>
                <IconDownload size={12} />
                {zipping ? t('detail.zipping') : t('detail.downloadAll')}
              </button>
            )}
            {canUploadMore && (
              <button className="mini-btn" onClick={() => moreInput.current?.click()} disabled={uploading}>
                <IconUpload size={12} />
                {t('detail.uploadMore')}
              </button>
            )}
          </div>
          {showAllFiles &&
            (o.submissions.length ? (
              <FileGallery
                bucket="submissions"
                items={o.submissions.map((x) => ({ ...x, meta: `${subName(x)} · ${hm(new Date(x.created_at))}` }))}
                canDelete={(it) => {
                  const x = o.submissions.find((y) => y.id === it.id);
                  return !!x && canDeleteSub(x);
                }}
                onDelete={(it) => {
                  const x = o.submissions.find((y) => y.id === it.id);
                  if (x) void deleteSubmission(x);
                }}
              />
            ) : (
              <span className="hint-text">{t('detail.noSubmissions')}</span>
            ))}
          {stationMissing && audience.length > 0 && (
            <span className={`hint-text ${stationMissing.length ? 'bad' : ''}`}>
              {stationMissing.length ? `${t('homework.missing')}：${stationMissing.map((p) => p.name).join('、')}` : t('detail.allSubmitted')}
            </span>
          )}
        </div>
      )}
      <input ref={moreInput} type="file" multiple hidden onChange={() => takeFiles(moreInput.current, 'more')} />

      <div className="field" style={{ gap: 6 }}>
        <span className="kicker">{t('detail.history')}</span>
        {rows.length ? (
          <div className="history">
            {rows.map((row) => (
              <div key={row.key} className="row">
                <span className="dot" style={{ width: 8, height: 8, background: row.ok ? 'var(--green)' : 'var(--red)' }} />
                <span className="d">{localYmd(row.at) === localYmd(now) ? t('time.today') : dateLabel(localYmd(row.at))}</span>
                <span className={`who ${row.ok ? '' : 'bad'}`}>{row.ok ? `${row.time} · ${row.who}` : t('detail.notDone')}</span>
              </div>
            ))}
          </div>
        ) : (
          <span className="hint-text">{t('detail.noHistory')}</span>
        )}
      </div>

      <div className="actions">
        {stashMode ? (
          <div className="stash">
            <span className="kicker">
              {stashMode === 'complete' ? t('files.toSubmit') : t('files.toAdd')} · {stash.length}
            </span>
            <FileTray
              files={stash}
              onChange={(f) => {
                setStash(f);
                if (!f.length) setStashMode(null);
              }}
              disabled={uploading}
            />
            <button className="btn primary lg block" onClick={() => void submitStash()} disabled={uploading || !stash.length}>
              <IconUpload size={16} />
              {uploading ? progressLabel : stashMode === 'complete' ? t('files.submitComplete', { count: stash.length }) : t('files.submitMore', { count: stash.length })}
            </button>
            <button className="btn ghost block" onClick={clearStash} disabled={uploading}>
              {t('actions.cancel')}
            </button>
          </div>
        ) : o.completion && !(homework && isStation) ? (
          <button className="btn outline lg block" onClick={() => void uncomplete(o)}>
            {t('actions.undo')}
          </button>
        ) : (
          <>
            {homework && mustUpload && (isStation || !mine) ? (
              <>
                <button className="btn primary lg block" onClick={() => completeInput.current?.click()} disabled={uploading}>
                  <IconUpload size={16} />
                  {uploading ? progressLabel : myHw?.status === 'returned' ? t('homework.resubmit') : t('files.pickToSubmit')}
                </button>
                <span className="hint-text" style={{ textAlign: 'center' }}>
                  {t('submit.needUploadHint')}
                </span>
              </>
            ) : (
              <>
                <button className="btn primary lg block" onClick={() => requestComplete(o)}>
                  <IconCheck size={16} />
                  {t('actions.complete')}
                </button>
                {(!homework || mustUpload) && (
                  <button className="link-btn" onClick={() => completeInput.current?.click()} disabled={uploading}>
                    <IconPaperclip size={13} />
                    {t('files.completeWithFiles')}
                  </button>
                )}
              </>
            )}
            {!o.completion && (
              <div className="row2">
                <button className="btn outline" onClick={() => void snooze(o, 10)}>
                  {t('actions.snooze10')}
                </button>
                <button className="btn ghost" onClick={() => void snooze(o, 24 * 60)}>
                  {t('actions.skipToday')}
                </button>
              </div>
            )}
          </>
        )}
        <input ref={completeInput} type="file" multiple hidden onChange={() => takeFiles(completeInput.current, 'complete')} />
        <span className="foot">
          {t('detail.createdBy', { name: creator?.name ?? '' })} · {dateLabel(localYmd(new Date(r.created_at)))}
        </span>
      </div>
    </aside>
  );
}
