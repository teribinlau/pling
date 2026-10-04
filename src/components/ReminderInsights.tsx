// 提醒详情里给创建人 / 管理员看的两块：已读回执、作业统计（批改、导出）；以及交作业的人自己看到的「我的作业」。
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import { audienceOf, homeworkStats, homeworkTable, readStatusOf, toCsv, toTsv, type HomeworkRow, type HomeworkStatus, type PersonHomework } from '../lib/homework';
import { fullTime, hm, whenLabel } from '../lib/format';
import { localYmd } from '../lib/recurrence';
import { isPreviewableImage } from '../lib/images';
import { openExternal } from '../lib/tauri';
import type { Occurrence, Profile, Submission } from '../lib/types';
import { Avatar } from './Avatar';
import { FileGallery } from './FileGallery';
import { IconCheck, IconChevronD, IconCopy, IconDownload, IconEye, IconFile, IconImage, IconX } from './Icons';

function Bar({ value, total, parts }: { value: number; total: number; parts?: { n: number; cls: string }[] }) {
  const pct = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);
  return (
    <div className="pbar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={value}>
      {(parts ?? [{ n: value, cls: '' }]).map((p, i) => (
        <span key={i} className={p.cls} style={{ width: `${pct(p.n)}%` }} />
      ))}
    </div>
  );
}

/** 当前这个人能不能看 / 改统计：提醒的创建人或管理员 */
export function useCanReview(o: Occurrence | null): boolean {
  const me = useStore((s) => s.me);
  return !!o && !!me && !me.is_station && (me.id === o.reminder.created_by || me.role === 'admin');
}

export function useAudience(o: Occurrence | null): Profile[] {
  const assignees = useStore((s) => s.assignees);
  const profiles = useStore((s) => s.profiles);
  const teams = useStore((s) => s.teams);
  const memberships = useStore((s) => s.memberships);
  const r = o?.reminder;
  return useMemo(() => (r ? audienceOf(r, assignees, profiles, teams, memberships) : []), [r, assignees, profiles, teams, memberships]);
}

// ---------------------------------------------------------------------------
// 已读回执
// ---------------------------------------------------------------------------

export function ReadReceipts({ o, audience }: { o: Occurrence; audience: Profile[] }) {
  const { t } = useTranslation();
  const reads = useStore((s) => s.reads);
  const [open, setOpen] = useState(false);
  const st = useMemo(() => readStatusOf(o, reads, audience), [o, reads, audience]);
  if (!audience.length) return null;
  const n = st.read.length;
  const total = st.people.length;
  return (
    <div className="field reads" style={{ gap: 8 }}>
      <div className="sec-line">
        <span className="kicker grow">
          <IconEye size={12} /> {t('reads.title')}
        </span>
        <button className="mini-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? t('reads.hide') : t('reads.show')}
          <IconChevronD size={12} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
        </button>
      </div>
      <div className="reads-sum">
        <b className="reads-count">{t('reads.count', { read: n, total })}</b>
        <span className="hint-text">{n === total ? t('reads.allRead') : n === 0 ? t('reads.noneRead') : ''}</span>
      </div>
      <Bar value={n} total={total} />
      {open && (
        <div className="reads-lists">
          {st.read.length > 0 && (
            <div className="reads-group">
              <span className="scope-sub">
                {t('reads.readers')} · {st.read.length}
              </span>
              <div className="people-chips">
                {st.read.map(({ person, at }) => (
                  <span key={person.id} className="pchip" title={whenLabel(new Date(at))}>
                    <Avatar p={person} size="sm" />
                    <span className="pchip-name">{person.name}</span>
                    <span className="pchip-meta">{whenLabel(new Date(at))}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          {st.unread.length > 0 && (
            <div className="reads-group">
              <span className="scope-sub bad">
                {t('reads.unread')} · {st.unread.length}
              </span>
              <div className="people-chips">
                {st.unread.map((p) => (
                  <span key={p.id} className="pchip dim">
                    <Avatar p={p} size="sm" />
                    <span className="pchip-name">{p.name}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 作业统计
// ---------------------------------------------------------------------------

const STATUS_KEY: Record<HomeworkStatus, string> = {
  missing: 'homework.statusMissing',
  submitted: 'homework.statusSubmitted',
  returned: 'homework.statusReturned',
  accepted: 'homework.statusAccepted',
};

export function StatusPill({ hw }: { hw: Pick<PersonHomework, 'status' | 'late' | 'resubmitted'> }) {
  const { t } = useTranslation();
  return (
    <span className="hw-pills">
      <span className={`hw-pill ${hw.status}`}>{t(STATUS_KEY[hw.status])}</span>
      {hw.late && hw.status !== 'missing' && <span className="hw-pill late">{t('homework.lateTag')}</span>}
    </span>
  );
}

/** 一个人这一批交的文件：图片点开看大图，其他文件点了下载；创建人 / 管理员可以删 */
function FileChips({ subs }: { subs: Submission[] }) {
  const { t } = useTranslation();
  const repo = useStore((s) => s.repo);
  const openViewer = useStore((s) => s.openViewer);
  const pushToast = useStore((s) => s.pushToast);
  const images = subs.filter((s) => isPreviewableImage(s.mime));
  const open = async (s: Submission) => {
    if (isPreviewableImage(s.mime)) {
      openViewer({ images: images.map((x) => ({ bucket: 'submissions', path: x.file_path, name: x.file_name })), index: images.findIndex((x) => x.id === s.id) });
      return;
    }
    try {
      await openExternal(await repo.fileUrl('submissions', s.file_path, s.file_name));
    } catch (e) {
      pushToast({ title: t('errors.downloadFailed'), body: (e as Error).message, kind: 'error' });
    }
  };
  return (
    <span className="hw-files">
      {subs.map((s) => (
        <button key={s.id} className="hw-file" onClick={() => void open(s)} title={`${s.file_name} · ${hm(new Date(s.created_at))}`}>
          {isPreviewableImage(s.mime) ? <IconImage size={12} /> : <IconFile size={12} />}
          <span>{s.file_name}</span>
        </button>
      ))}
    </span>
  );
}

function HomeworkPersonRow({ row, o }: { row: HomeworkRow; o: Occurrence }) {
  const { t } = useTranslation();
  const reviewHomework = useStore((s) => s.reviewHomework);
  const profiles = useStore((s) => s.profiles);
  const [returning, setReturning] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const reviewer = row.reviewedBy ? profiles.find((p) => p.id === row.reviewedBy)?.name : '';
  const act = async (status: 'accepted' | 'returned') => {
    setBusy(true);
    const ok = await reviewHomework(o, row.person, status, status === 'returned' ? note : '');
    setBusy(false);
    if (ok) {
      setReturning(false);
      setNote('');
    }
  };
  return (
    <div className={`hw-row ${row.status}`} data-person={row.person.name}>
      <Avatar p={row.person} size="sm" />
      <div className="hw-main">
        <div className="hw-top">
          <b className="hw-name">{row.person.name}</b>
          <StatusPill hw={row} />
        </div>
        {row.status !== 'missing' && (
          <div className="hw-meta">
            {row.firstAt && <span>{t('homework.submittedAt', { time: whenLabel(new Date(row.firstAt)) })}</span>}
            {row.resubmitted && row.lastAt && <span>· {t('homework.resubmit')} {whenLabel(new Date(row.lastAt))}</span>}
            <span>· {t('homework.files', { n: row.current.length })}</span>
          </div>
        )}
        {row.current.length > 0 && <FileChips subs={row.current} />}
        {row.note && (
          <div className="hw-note">
            {t('homework.note', { note: row.note })}
            {reviewer ? <span className="hint-text"> · {t('homework.reviewedBy', { name: reviewer })}</span> : null}
          </div>
        )}
        {returning && (
          <div className="hw-return">
            <textarea
              className="input"
              rows={2}
              autoFocus
              value={note}
              maxLength={500}
              placeholder={t('homework.returnPlaceholder')}
              aria-label={t('homework.returnTitle', { name: row.person.name })}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy}
            />
            <div className="hw-return-acts">
              <button className="btn ghost sm" onClick={() => setReturning(false)} disabled={busy}>
                {t('actions.cancel')}
              </button>
              <button className="btn danger sm" onClick={() => void act('returned')} disabled={busy || !note.trim()}>
                {t('homework.confirmReturn')}
              </button>
            </div>
          </div>
        )}
      </div>
      {row.status !== 'missing' && !returning && (
        <div className="hw-acts">
          {row.status !== 'accepted' && (
            <button className="mini-btn ok" onClick={() => void act('accepted')} disabled={busy} aria-label={`${t('homework.accept')} ${row.person.name}`}>
              <IconCheck size={11} />
              {t('homework.accept')}
            </button>
          )}
          {row.status !== 'returned' && (
            <button className="mini-btn bad" onClick={() => setReturning(true)} disabled={busy} aria-label={`${t('homework.return')} ${row.person.name}`}>
              <IconX size={11} />
              {t('homework.return')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 老浏览器 / 没给剪贴板权限：用隐藏的输入框 + execCommand
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function safeName(s: string): string {
  return s.slice(0, 40).replace(/[\\/:*?"<>|]/g, '_');
}

export function HomeworkPanel({ o, audience, canExport, zipping, onZip }: { o: Occurrence; audience: Profile[]; canExport: boolean; zipping: boolean; onZip?: () => void }) {
  const { t } = useTranslation();
  const teams = useStore((s) => s.teams);
  const pushToast = useStore((s) => s.pushToast);
  const stats = useMemo(() => homeworkStats(o, audience), [o, audience]);
  const [showAll, setShowAll] = useState(false);
  if (!audience.length) {
    return (
      <div className="field">
        <span className="kicker">{t('homework.title')}</span>
        <span className="hint-text">{t('homework.noAudience')}</span>
      </div>
    );
  }
  const table = () =>
    homeworkTable(
      stats,
      teams,
      {
        name: t('homework.csvName'),
        team: t('form.team'),
        status: t('homework.csvStatus'),
        time: t('homework.csvTime'),
        late: t('homework.csvLate'),
        note: t('homework.csvNote'),
        files: t('homework.csvFiles'),
        yes: t('homework.yes'),
        no: t('homework.no'),
        statusText: { missing: t(STATUS_KEY.missing), submitted: t(STATUS_KEY.submitted), returned: t(STATUS_KEY.returned), accepted: t(STATUS_KEY.accepted) },
      },
      fullTime,
    );
  const exportCsv = () => {
    const blob = new Blob([toCsv(table())], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName(o.reminder.title)}_${localYmd(o.at)}_名单.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    pushToast({ title: t('homework.exported'), body: a.download, kind: 'info' });
  };
  const copy = async () => {
    const ok = await copyText(toTsv(table()));
    pushToast(ok ? { title: t('homework.copied'), body: '', kind: 'info' } : { title: t('errors.copyFailed'), body: '', kind: 'error' });
  };
  // 名单很长时先显示要处理的（待批、退回、未交），通过的折起来
  const rows = showAll || stats.rows.length <= 12 ? stats.rows : stats.rows.filter((r) => r.status !== 'accepted');
  const hidden = stats.rows.length - rows.length;
  const hasFiles = o.submissions.length > 0;
  return (
    <div className="field homework" style={{ gap: 10 }}>
      <div className="sec-line">
        <span className="kicker grow">{t('homework.title')}</span>
        {canExport && (
          <button className="mini-btn" onClick={exportCsv}>
            <IconDownload size={12} />
            {t('homework.export')}
          </button>
        )}
        <button className="mini-btn" onClick={() => void copy()}>
          <IconCopy size={12} />
          {t('homework.copy')}
        </button>
      </div>
      <div className="hw-stats">
        <div className="hw-stat">
          <b>{stats.expected}</b>
          <span>{t('homework.expected')}</span>
        </div>
        <div className="hw-stat good">
          <b>{stats.submitted}</b>
          <span>
            {t('homework.submitted')}
            <small>
              {t('homework.onTime')} {stats.onTime} · {t('homework.late')} {stats.late}
            </small>
          </span>
        </div>
        <div className={`hw-stat ${stats.missing ? 'bad' : ''}`}>
          <b>{stats.missing}</b>
          <span>{t('homework.missing')}</span>
        </div>
        <div className={`hw-stat ${stats.returned ? 'warn' : ''}`}>
          <b>{stats.returned}</b>
          <span>{t('homework.returned')}</span>
        </div>
        <div className="hw-stat">
          <b>{stats.accepted}</b>
          <span>{t('homework.accepted')}</span>
        </div>
      </div>
      <div className="hw-progress">
        <Bar
          value={stats.submitted}
          total={stats.expected}
          parts={[
            { n: stats.accepted, cls: 'accepted' },
            { n: stats.waiting, cls: 'submitted' },
            { n: stats.returned, cls: 'returned' },
          ]}
        />
        <span className="hint-text">
          {t('homework.progress', { done: stats.submitted, total: stats.expected })}
          {stats.waiting ? ` · ${t('homework.waiting')} ${stats.waiting}` : ''}
        </span>
      </div>
      <div className="hw-list">
        {rows.map((row) => (
          <HomeworkPersonRow key={row.person.id} row={row} o={o} />
        ))}
      </div>
      {hidden > 0 && (
        <button className="link-btn" onClick={() => setShowAll(true)}>
          {t('homework.accepted')} · {hidden}
          <IconChevronD size={12} />
        </button>
      )}
      {hasFiles && onZip && (
        <button className="link-btn" onClick={onZip} disabled={zipping}>
          <IconDownload size={13} />
          {zipping ? t('detail.zipping') : t('detail.downloadAll')}
        </button>
      )}
    </div>
  );
}

/** 交作业的人自己：状态、批语、自己交的文件（没通过之前可以删） */
export function MyHomework({ o, hw, onDelete }: { o: Occurrence; hw: PersonHomework; onDelete: (s: Submission) => void }) {
  const { t } = useTranslation();
  const profiles = useStore((s) => s.profiles);
  const reviewer = hw.reviewedBy ? profiles.find((p) => p.id === hw.reviewedBy)?.name : '';
  const msg = hw.status === 'accepted' ? t('homework.myAccepted') : hw.status === 'returned' ? t('homework.myReturned') : hw.status === 'submitted' ? t('homework.mySubmitted') : '';
  return (
    <div className={`field my-hw ${hw.status}`} style={{ gap: 8 }}>
      <div className="sec-line">
        <span className="kicker grow">{t('homework.mine')}</span>
        <StatusPill hw={hw} />
      </div>
      {msg && (
        <span className={`hint-text ${hw.status === 'returned' ? 'bad' : ''}`}>
          {msg}
          {hw.late && hw.status !== 'missing' ? t('homework.myLate') : ''}
        </span>
      )}
      {hw.note && (
        <div className="hw-note big">
          {t('homework.note', { note: hw.note })}
          {reviewer ? <span className="hint-text"> · {t('homework.reviewedBy', { name: reviewer })}</span> : null}
        </div>
      )}
      {hw.current.length > 0 && (
        <FileGallery
          bucket="submissions"
          items={hw.current.map((x) => ({ ...x, meta: hm(new Date(x.created_at)) }))}
          canDelete={() => hw.status !== 'accepted'}
          onDelete={(it) => {
            const s = o.submissions.find((x) => x.id === it.id);
            if (s) onDelete(s);
          }}
        />
      )}
    </div>
  );
}
