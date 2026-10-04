import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import type { CompletionMode, Priority, ReminderInput, Visibility } from '../lib/types';
import { localToUtc, presetToRule, ruleToPreset, type RepeatPreset } from '../lib/recurrence';
import { todayYmd, ymdOffset, zoned } from '../lib/format';
import { teamIdsOf, teamName } from '../lib/occurrences';
import { isPreviewableImage } from '../lib/images';
import { useFileUrls } from '../lib/useFileUrls';
import { Avatar } from './Avatar';
import { FileTray } from './FileTray';
import { DateField, TimeField } from './Pickers';
import { IconCheck, IconLink, IconUpload, IconX } from './Icons';

interface Template {
  key: string;
  time: string;
  before: number;
  priority: Priority;
  repeat: RepeatPreset;
  /** 交作业 / 收材料：每个人都要交文件 */
  upload?: boolean;
  /** 不重复的模板：默认放到几天以后（交作业一般给一周） */
  inDays?: number;
}

/** 常用模板：学校、小团队通用（指派默认还是自己的小组，可以改） */
const TEMPLATES: Template[] = [
  { key: 'homework', time: '22:00', before: 1440, priority: 'high', repeat: 'none', upload: true, inDays: 7 },
  { key: 'collect', time: '17:00', before: 1440, priority: 'medium', repeat: 'none', upload: true, inDays: 3 },
  { key: 'meeting', time: '14:00', before: 30, priority: 'medium', repeat: 'none', inDays: 1 },
  { key: 'duty', time: '17:30', before: 15, priority: 'medium', repeat: 'weekdays' },
  { key: 'signup', time: '17:00', before: 1440, priority: 'high', repeat: 'none', inDays: 5 },
  { key: 'weekly', time: '16:00', before: 60, priority: 'low', repeat: 'weekly' },
];

const BEFORE_OPTIONS = [0, 5, 15, 30, 60, 1440];

export function ReminderModal() {
  const { t } = useTranslation();
  const me = useStore((s) => s.me);
  const teams = useStore((s) => s.teams);
  const profiles = useStore((s) => s.profiles);
  const assignees = useStore((s) => s.assignees);
  const memberships = useStore((s) => s.memberships);
  const reminders = useStore((s) => s.reminders);
  const editId = useStore((s) => s.editReminderId);
  const closeModal = useStore((s) => s.closeModal);
  const createReminder = useStore((s) => s.createReminder);
  const updateReminder = useStore((s) => s.updateReminder);
  const settings = useStore((s) => s.settings);
  const attachments = useStore((s) => s.attachments);
  const uploadProgress = useStore((s) => s.uploadProgress);
  const openViewer = useStore((s) => s.openViewer);
  const editing = editId ? reminders.find((r) => r.id === editId) : undefined;
  // 附件：新选的文件先放本地，保存时才上传；旧附件点 × 只是标记，保存时才删
  const [files, setFiles] = useState<File[]>([]);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const existing = editing ? attachments.filter((a) => a.reminder_id === editing.id) : [];
  const existingImages = existing.filter((a) => isPreviewableImage(a.mime));
  const thumbUrls = useFileUrls(
    'attachments',
    existingImages.map((a) => a.file_path),
  );

  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [date, setDate] = useState(todayYmd());
  const [time, setTime] = useState('09:00');
  const [repeat, setRepeat] = useState<RepeatPreset>('none');
  const [customDays, setCustomDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [skipHolidays, setSkipHolidays] = useState(true);
  const [before, setBefore] = useState(settings.defaultRemindBefore);
  const [userIds, setUserIds] = useState<string[]>([]);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [visibility, setVisibility] = useState<Visibility>('team');
  const [priority, setPriority] = useState<Priority>('medium');
  const [link, setLink] = useState('');
  const [mode, setMode] = useState<CompletionMode>('any');
  const [requireUpload, setRequireUpload] = useState(false);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeModal();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeModal]);

  // 只在打开弹窗（或者换了要编辑的提醒）时填一次表单。以前跟着 editing / me / assignees 走：
  // 实时同步一刷新这几个对象就换新，正在填的时间、指派会被冲回默认值（新建）或者存着的旧值（编辑）
  const initKey = editId ?? 'new';
  useEffect(() => {
    if (editId) {
      if (!editing) return;
      const z = zoned(new Date(editing.due_at));
      setTitle(editing.title);
      setNotes(editing.notes);
      setDate(`${z.getFullYear()}-${String(z.getMonth() + 1).padStart(2, '0')}-${String(z.getDate()).padStart(2, '0')}`);
      setTime(`${String(z.getHours()).padStart(2, '0')}:${String(z.getMinutes()).padStart(2, '0')}`);
      const rp = ruleToPreset(editing.rrule, z);
      setRepeat(rp.preset);
      if (rp.days.length) setCustomDays(rp.days);
      setSkipHolidays(editing.skip_holidays);
      setBefore(editing.remind_before_min);
      setUserIds(assignees.filter((a) => a.reminder_id === editing.id && a.user_id).map((a) => a.user_id!));
      setTeamIds(assignees.filter((a) => a.reminder_id === editing.id && a.team_id).map((a) => a.team_id!));
      setVisibility(editing.visibility);
      setPriority(editing.priority);
      setLink(editing.link);
      setMode(editing.completion_mode);
      setRequireUpload(editing.require_upload);
    } else if (me) {
      // 新建：默认指派给自己的班组
      if (me.team_id) setTeamIds([me.team_id]);
      else setUserIds([me.id]);
      // 默认时间：下一个整点
      const z = zoned(new Date());
      const h = Math.min(23, z.getHours() + 1);
      setTime(`${String(h).padStart(2, '0')}:00`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initKey, !!editing, me?.id]);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return { people: [], teams: [] };
    return {
      people: profiles.filter((p) => p.active && !p.is_station && !userIds.includes(p.id) && (p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q))).slice(0, 6),
      teams: teams.filter((tm) => !teamIds.includes(tm.id) && tm.name.toLowerCase().includes(q)),
    };
  }, [query, profiles, teams, userIds, teamIds]);

  const notifyCount = useMemo(() => {
    const ids = new Set(userIds);
    profiles.forEach((p) => {
      if (p.active && !p.is_station && teamIdsOf(p, memberships).some((id) => teamIds.includes(id))) ids.add(p.id);
    });
    return ids.size;
  }, [userIds, teamIds, profiles, memberships]);

  const applyTemplate = (tpl: Template) => {
    setTitle(t(`templates.${tpl.key}`));
    setTime(tpl.time);
    setBefore(tpl.before);
    setPriority(tpl.priority);
    setRepeat(tpl.repeat);
    if (tpl.inDays !== undefined) setDate(ymdOffset(new Date(), tpl.inDays));
    setRequireUpload(!!tpl.upload);
    setMode(tpl.upload ? 'each' : 'any');
    setVisibility('team');
  };

  const submit = async () => {
    if (!title.trim() || !me) return;
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    const dueLocal = new Date(y, m - 1, d, hh, mm);
    const primaryTeam = teamIds[0] ?? me.team_id ?? null;
    const input: ReminderInput = {
      title: title.trim(),
      notes: notes.trim(),
      due_at: localToUtc(y, m, d, hh, mm).toISOString(),
      rrule: presetToRule(repeat, dueLocal, customDays),
      skip_holidays: skipHolidays,
      remind_before_min: before,
      overdue_repeat_min: settings.overdueRepeatMin,
      priority,
      visibility,
      team_id: visibility === 'private' ? me.team_id : primaryTeam,
      link: link
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .join('\n'),
      completion_mode: mode,
      require_upload: requireUpload,
      assignee_user_ids: visibility === 'private' ? [me.id] : userIds,
      assignee_team_ids: visibility === 'private' ? [] : teamIds,
    };
    setSaving(true);
    try {
      if (editing) await updateReminder(editing.id, input, files, existing.filter((a) => removedIds.includes(a.id)));
      else await createReminder(input, files);
    } finally {
      setSaving(false);
    }
  };

  const weekdayOrder = [1, 2, 3, 4, 5, 6, 0];

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && closeModal()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="m-head">
          <div className="grow">
            <h1>{editing ? t('form.editTitle') : t('form.newTitle')}</h1>
            <div className="sub">{t('form.subtitle')}</div>
          </div>
          <button className="close-round" aria-label={t('actions.close')} onClick={closeModal}>
            <IconX size={16} />
          </button>
        </div>
        <div className="m-body">
          {!editing && (
            <div className="field">
              <span className="lbl">{t('form.templates')}</span>
              <div className="templates">
                {TEMPLATES.map((tpl) => (
                  <button key={tpl.key} type="button" onClick={() => applyTemplate(tpl)} title={t(`templates.${tpl.key}`)}>
                    {t(`templates.${tpl.key}`).split(' — ')[0]}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="field">
            <label htmlFor="f-title">{t('form.title')}</label>
            <input id="f-title" className="input big" autoFocus value={title} placeholder={t('form.titlePlaceholder')} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="f-notes">{t('form.notes')}</label>
            <textarea id="f-notes" className="input" rows={2} value={notes} placeholder={t('form.notesPlaceholder')} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="f-date">{t('form.date')}</label>
              <DateField id="f-date" value={date} min={ymdOffset(new Date(), -365)} onChange={setDate} />
            </div>
            <div className="field">
              <label htmlFor="f-time">{t('form.time')}</label>
              <TimeField id="f-time" value={time} onChange={setTime} />
            </div>
          </div>
          <div className="field">
            <span className="lbl">{t('form.repeat')}</span>
            <div className="chips">
              {(['none', 'daily', 'weekdays', 'weekly', 'monthly', 'custom'] as RepeatPreset[]).map((p) => (
                <button key={p} type="button" className={`chip lg ${repeat === p ? 'active' : ''}`} onClick={() => setRepeat(p)}>
                  {t(`repeat.${p}`)}
                </button>
              ))}
            </div>
            {repeat === 'custom' && (
              <div className="weekday-picker" aria-label={t('form.customDays')}>
                {weekdayOrder.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={customDays.includes(d) ? 'active' : ''}
                    onClick={() => setCustomDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]))}
                  >
                    {t(`weekdays.${d}`)}
                  </button>
                ))}
              </div>
            )}
            {repeat !== 'none' && (
              <label className="hint-text" style={{ display: 'flex', alignItems: 'center', gap: 8, letterSpacing: 0, fontWeight: 500 }}>
                <input type="checkbox" checked={skipHolidays} onChange={(e) => setSkipHolidays(e.target.checked)} />
                {t('repeat.skipHolidays')}
              </label>
            )}
          </div>
          <div className="field">
            <span className="lbl">{t('form.remindBefore')}</span>
            <div className="chips" style={{ alignItems: 'center' }}>
              {BEFORE_OPTIONS.map((min) => (
                <button key={min} type="button" className={`chip lg ${before === min ? 'active' : ''}`} onClick={() => setBefore(min)}>
                  {min === 0 ? t('time.onTime') : min >= 60 ? t('time.beforeH', { n: min / 60 }) : t('time.before', { n: min })}
                </button>
              ))}
              <span className="hint-text">{t('form.overdueRepeat', { n: settings.overdueRepeatMin })}</span>
            </div>
          </div>
          <div className="field">
            <label htmlFor="f-assign">{t('form.assign')}</label>
            <div className="assign-box">
              {teamIds.map((id) => {
                const tm = teams.find((x) => x.id === id);
                if (!tm) return null;
                return (
                  <span key={id} className="tag team" style={{ background: tm.color }}>
                    {teamName(tm)}
                    <button type="button" className="x" aria-label={t('actions.delete')} onClick={() => setTeamIds(teamIds.filter((x) => x !== id))}>
                      <IconX size={11} />
                    </button>
                  </span>
                );
              })}
              {userIds.map((id) => {
                const p = profiles.find((x) => x.id === id);
                if (!p) return null;
                return (
                  <span key={id} className="tag" style={{ paddingLeft: 4 }}>
                    <Avatar p={p} size="sm" />
                    {p.name}
                    <button type="button" className="x" aria-label={t('actions.delete')} onClick={() => setUserIds(userIds.filter((x) => x !== id))}>
                      <IconX size={11} />
                    </button>
                  </span>
                );
              })}
              <input id="f-assign" value={query} placeholder={t('form.assignPlaceholder')} onChange={(e) => setQuery(e.target.value)} disabled={visibility === 'private'} />
              {(candidates.people.length > 0 || candidates.teams.length > 0) && (
                <div className="suggest">
                  {candidates.teams.map((tm) => (
                    <button key={tm.id} type="button" onClick={() => { setTeamIds([...teamIds, tm.id]); setQuery(''); }}>
                      <span className="dot" style={{ background: tm.color, width: 10, height: 10 }} />
                      {teamName(tm)}
                    </button>
                  ))}
                  {candidates.people.map((p) => (
                    <button key={p.id} type="button" onClick={() => { setUserIds([...userIds, p.id]); setQuery(''); }}>
                      <Avatar p={p} size="sm" />
                      {p.name}
                      <span className="hint-text">{teamName(teams.find((x) => x.id === p.team_id))}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="field">
            <span className="lbl">{t('form.visibility')}</span>
            <div className="grid-3">
              {(['private', 'team', 'company'] as Visibility[]).map((v) => (
                <button key={v} type="button" className={`opt-card ${visibility === v ? 'active' : ''}`} onClick={() => setVisibility(v)}>
                  <b>{t(`visibility.${v}`)}</b>
                  <span>{t(`visibility.${v}Hint`)}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="grid-2">
            <div className="field">
              <span className="lbl">{t('form.priority')}</span>
              <div className="chips">
                {(['low', 'medium', 'high'] as Priority[]).map((p) => (
                  <button key={p} type="button" className={`chip lg ${priority === p ? 'active' : ''}`} onClick={() => setPriority(p)} style={p === 'high' && priority !== p ? { color: 'var(--red-ink)' } : undefined}>
                    {p === 'high' && <span className="dot" style={{ background: 'var(--red)', width: 7, height: 7 }} />}
                    {t(`priority.${p}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <span className="lbl">{t('form.completionMode')}</span>
              <div className="chips">
                {(['any', 'each'] as CompletionMode[]).map((m) => (
                  <button key={m} type="button" className={`chip lg ${mode === m ? 'active' : ''}`} onClick={() => setMode(m)}>
                    {t(`completionMode.${m}`)}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="field">
            <label htmlFor="f-link">{t('form.link')}</label>
            <div className="assign-box" style={{ minHeight: 44, padding: '8px 14px', alignItems: 'flex-start' }}>
              <IconLink size={14} style={{ color: 'var(--muted)', marginTop: 4, flexShrink: 0 }} />
              <textarea
                id="f-link"
                rows={Math.min(5, Math.max(1, link.split('\n').length))}
                value={link}
                placeholder={t('form.linkPlaceholder')}
                onChange={(e) => setLink(e.target.value)}
                style={{ flex: 1, border: 0, background: 'transparent', font: 'inherit', resize: 'none', outline: 'none', padding: 0, minWidth: 0 }}
              />
            </div>
            <span className="hint-text">{t('form.linkHint')}</span>
          </div>
          <div className="field">
            <label>{t('form.attachments')}</label>
            <FileTray
              files={files}
              onChange={setFiles}
              existing={existing.map((a) => ({ id: a.id, name: a.file_name, size: a.size, mime: a.mime, thumb: thumbUrls[a.file_path], removed: removedIds.includes(a.id) }))}
              onToggleExisting={(id) => setRemovedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))}
              onOpenExisting={(id) => {
                const i = existingImages.findIndex((a) => a.id === id);
                if (i >= 0) openViewer({ images: existingImages.map((a) => ({ bucket: 'attachments', path: a.file_path, name: a.file_name })), index: i });
              }}
              disabled={saving}
            />
            <span className="hint-text">{t('form.attachmentsHint')}</span>
          </div>
          <div className="field">
            <button type="button" className={`opt-card upload-opt ${requireUpload ? 'active' : ''}`} onClick={() => setRequireUpload(!requireUpload)} aria-pressed={requireUpload}>
              <span className="upload-opt-ic">
                <IconUpload size={16} />
              </span>
              <span className="grow" style={{ textAlign: 'left' }}>
                <b>{t('form.requireUpload')}</b>
                <span>{t('form.requireUploadHint')}</span>
              </span>
              <span className={`toggle ${requireUpload ? 'on' : ''}`} aria-hidden />
            </button>
          </div>
        </div>
        <div className="m-foot">
          <div className="grow">{visibility !== 'private' && notifyCount > 0 ? t('form.willNotify', { count: notifyCount }) : ''}</div>
          <button className="btn outline lg" type="button" onClick={closeModal}>
            {t('actions.cancel')}
          </button>
          <button className="btn primary lg" type="button" disabled={!title.trim() || saving} onClick={() => void submit()}>
            <IconCheck size={16} />
            {saving && uploadProgress ? t('files.uploadingN', uploadProgress) : editing ? t('actions.save') : t('actions.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
