import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import type { DiscussionInput, DiscussionVisibility } from '../lib/types';
import { teamName } from '../lib/occurrences';
import { countParticipants } from '../lib/discussions';
import { isPreviewableImage } from '../lib/images';
import { useFileUrls } from '../lib/useFileUrls';
import { filesFromTransfer, mergeFiles } from '../lib/files';
import { dueLabel, todayYmd, weekdayOf, ymdOffset } from '../lib/format';
import { Avatar } from './Avatar';
import { FileTray } from './FileTray';
import { SignAs } from './SignAs';
import { DateField } from './Pickers';
import { IconCheck, IconX } from './Icons';

/** 发起 / 编辑讨论：主题、内容、附件、谁能看到（全公司，或者指定的班组和人） */
export function DiscussionModal() {
  const { t } = useTranslation();
  const modal = useStore((s) => s.discussionModal);
  const close = useStore((s) => s.closeDiscussionModal);
  const me = useStore((s) => s.me);
  const teams = useStore((s) => s.teams);
  const profiles = useStore((s) => s.profiles);
  const memberships = useStore((s) => s.memberships);
  const discussions = useStore((s) => s.discussions);
  const members = useStore((s) => s.discussionMembers);
  const dFiles = useStore((s) => s.discussionFiles);
  const createDiscussion = useStore((s) => s.createDiscussion);
  const updateDiscussion = useStore((s) => s.updateDiscussion);
  const uploadProgress = useStore((s) => s.uploadProgress);
  const openViewer = useStore((s) => s.openViewer);
  const editing = modal?.mode === 'edit' ? discussions.find((d) => d.id === modal.id) : undefined;

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<DiscussionVisibility>('members');
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [userIds, setUserIds] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [signAs, setSignAs] = useState('');
  const [due, setDue] = useState(''); // 截止日期 YYYY-MM-DD；空 = 不设
  const [saving, setSaving] = useState(false);

  // 正文附件（编辑时）：点 × 只是标记，保存时才删
  const existing = editing ? dFiles.filter((f) => f.discussion_id === editing.id && !f.comment_id) : [];
  const existingImages = existing.filter((f) => isPreviewableImage(f.mime));
  const thumbUrls = useFileUrls(
    'discussions',
    existingImages.map((f) => f.file_path),
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !saving && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, saving]);

  const editId = editing?.id;
  useEffect(() => {
    if (editing) {
      setTitle(editing.title);
      setBody(editing.body);
      setVisibility(editing.visibility);
      setDue(editing.due_date ?? '');
      const rows = members.filter((m) => m.discussion_id === editing.id);
      setTeamIds(rows.map((m) => m.team_id).filter((x): x is string => !!x));
      setUserIds(rows.map((m) => m.user_id).filter((x): x is string => !!x));
    } else if (me) {
      // 新建：默认给自己的主班组；没有班组、或者班组里只有自己（比如「管理」只有一个人）就默认全公司
      const others = me.team_id ? countParticipants('members', [], [me.team_id], me.id, profiles, memberships) - 1 : 0;
      if (me.team_id && others > 0) {
        setVisibility('members');
        setTeamIds([me.team_id]);
      } else setVisibility('company');
    }
    // 只在打开弹窗（或换了要编辑的讨论）时初始化，之后别人同步过来的改动不覆盖正在填的内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId, me?.id]);

  const suggestRef = useRef<HTMLDivElement>(null);
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return profiles
      .filter((p) => p.active && !p.is_station && p.id !== me?.id && !userIds.includes(p.id) && (p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)))
      .slice(0, 6);
  }, [query, profiles, userIds, me?.id]);

  // 候选名单排在弹窗靠下的位置：出来时滚到能看见
  useEffect(() => {
    suggestRef.current?.scrollIntoView({ block: 'nearest' });
  }, [candidates.length]);

  if (!modal || !me) return null;
  const creatorId = editing?.created_by ?? me.id;
  const participants = countParticipants(visibility, userIds, teamIds, creatorId, profiles, memberships);
  const noScope = visibility === 'members' && !teamIds.length && !userIds.length;
  const needSign = !editing && me.is_station && !signAs;
  const canSave = !!title.trim() && !noScope && !needSign && !saving;

  // 截止日期的快捷选项：明天 / 这周五（还在后天以后才给）/ 下周五；日期框里也能直接选
  const today = todayYmd();
  const wd = weekdayOf(today);
  const toFriday = wd === 0 ? -2 : 5 - wd; // 这周（周一开头）的周五离今天几天，过了就是负的
  const quick: { key: string; label: string; ymd: string }[] = [
    { key: 'none', label: t('discuss.pickNone'), ymd: '' },
    { key: 'tomorrow', label: t('discuss.pickTomorrow'), ymd: ymdOffset(new Date(), 1) },
    ...(toFriday >= 2 ? [{ key: 'friday', label: t('discuss.pickFriday'), ymd: ymdOffset(new Date(), toFriday) }] : []),
    { key: 'nextFriday', label: t('discuss.pickNextFriday'), ymd: ymdOffset(new Date(), toFriday + 7) },
  ];
  // 日期框默认不让选过去的日子；编辑一个已经过了截止日期的讨论时，原来的日期照样能留着
  const minDue = editing?.due_date && editing.due_date < today ? editing.due_date : today;

  const toggleTeam = (id: string) => setTeamIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const addPerson = (id: string) => {
    setUserIds((ids) => [...ids, id]);
    setQuery('');
  };

  const submit = async () => {
    if (!canSave) return;
    const input: DiscussionInput = {
      title: title.trim(),
      body: body.trim(),
      visibility,
      member_user_ids: visibility === 'members' ? userIds : [],
      member_team_ids: visibility === 'members' ? teamIds : [],
      created_by_name: editing ? editing.created_by_name : me.is_station ? signAs : '',
      due_date: due || null,
    };
    setSaving(true);
    try {
      if (editing) await updateDiscussion(editing.id, input, files, existing.filter((f) => removedIds.includes(f.id)));
      else await createDiscussion(input, files);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !saving && close()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={editing ? t('discuss.editTitle') : t('discuss.newTitle')}>
        <div className="m-head">
          <div className="grow">
            <h1>{editing ? t('discuss.editTitle') : t('discuss.newTitle')}</h1>
            <div className="sub">{t('discuss.subtitle')}</div>
          </div>
          <button className="close-round" aria-label={t('actions.close')} onClick={close} disabled={saving}>
            <IconX size={16} />
          </button>
        </div>
        <div className="m-body">
          <div className="field">
            <label htmlFor="d-title">{t('discuss.fTitle')}</label>
            <input id="d-title" className="input big" autoFocus value={title} maxLength={200} placeholder={t('discuss.titlePlaceholder')} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="d-body">{t('discuss.fBody')}</label>
            <textarea
              id="d-body"
              className="input"
              rows={5}
              value={body}
              placeholder={t('discuss.bodyPlaceholder')}
              onChange={(e) => setBody(e.target.value)}
              onPaste={(e) => {
                // 截图直接 Ctrl+V 贴进来就是附件
                const got = filesFromTransfer(e.clipboardData);
                if (!got.length) return;
                e.preventDefault();
                setFiles((cur) => mergeFiles(cur, got));
              }}
            />
          </div>
          <div className="field">
            <label>{t('form.attachments')}</label>
            <FileTray
              files={files}
              onChange={setFiles}
              existing={existing.map((f) => ({ id: f.id, name: f.file_name, size: f.size, mime: f.mime, thumb: thumbUrls[f.file_path], removed: removedIds.includes(f.id) }))}
              onToggleExisting={(id) => setRemovedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))}
              onOpenExisting={(id) => {
                const i = existingImages.findIndex((f) => f.id === id);
                if (i >= 0) openViewer({ images: existingImages.map((f) => ({ bucket: 'discussions', path: f.file_path, name: f.file_name })), index: i });
              }}
              disabled={saving}
            />
            <span className="hint-text">{t('form.attachmentsHint')}</span>
          </div>
          <div className="field">
            <label htmlFor="d-due">{t('discuss.fDue')}</label>
            <div className="chips due-pick">
              {quick.map((q) => (
                <button key={q.key} type="button" className={`chip lg ${due === q.ymd ? 'active' : ''}`} aria-pressed={due === q.ymd} onClick={() => setDue(q.ymd)}>
                  {q.label}
                </button>
              ))}
              <DateField id="d-due" className="due-input" value={due} min={minDue} onChange={setDue} />
            </div>
            <span className="hint-text">{due ? t('discuss.dueHintSet', { when: dueLabel(due, false).text }) : t('discuss.dueHint')}</span>
          </div>
          <div className="field">
            <span className="lbl">{t('discuss.scope')}</span>
            <div className="grid-2 scope-cards">
              {(['company', 'members'] as DiscussionVisibility[]).map((v) => (
                <button key={v} type="button" className={`opt-card ${visibility === v ? 'active' : ''}`} onClick={() => setVisibility(v)} aria-pressed={visibility === v}>
                  <b>{v === 'company' ? t('discuss.scopeCompany') : t('discuss.scopeMembers')}</b>
                  <span>{v === 'company' ? t('discuss.scopeCompanyHint') : t('discuss.scopeMembersHint')}</span>
                </button>
              ))}
            </div>
            {visibility === 'members' && (
              <div className="scope-pick">
                <span className="scope-sub">{t('discuss.pickTeams')}</span>
                <div className="chips">
                  {teams.map((tm) => (
                    <button key={tm.id} type="button" className={`chip ${teamIds.includes(tm.id) ? 'active' : ''}`} onClick={() => toggleTeam(tm.id)} aria-pressed={teamIds.includes(tm.id)}>
                      <span className="dot" style={{ background: tm.color, width: 8, height: 8 }} />
                      {teamName(tm)}
                    </button>
                  ))}
                </div>
                <label className="scope-sub" htmlFor="d-people">
                  {t('discuss.pickPeople')}
                </label>
                <div className="assign-box">
                  {userIds.map((id) => {
                    const p = profiles.find((x) => x.id === id);
                    if (!p) return null;
                    return (
                      <span key={id} className="tag" style={{ paddingLeft: 4 }}>
                        <Avatar p={p} size="sm" />
                        {p.name}
                        <button type="button" className="x" aria-label={t('files.remove', { name: p.name })} onClick={() => setUserIds(userIds.filter((x) => x !== id))}>
                          <IconX size={11} />
                        </button>
                      </span>
                    );
                  })}
                  <input
                    id="d-people"
                    value={query}
                    placeholder={t('discuss.peoplePlaceholder')}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && candidates[0]) {
                        e.preventDefault();
                        addPerson(candidates[0].id);
                      }
                    }}
                  />
                </div>
                {candidates.length > 0 && (
                  <div className="suggest inline" ref={suggestRef}>
                    {candidates.map((p) => (
                      <button key={p.id} type="button" onClick={() => addPerson(p.id)}>
                        <Avatar p={p} size="sm" />
                        {p.name}
                        <span className="hint-text">{teamName(teams.find((x) => x.id === p.team_id))}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <span className={`hint-text ${noScope ? 'bad' : ''}`}>{noScope ? t('discuss.needScope') : t('discuss.adminNote')}</span>
          </div>
          {!editing && me.is_station && (
            <div className="field">
              <span className="lbl">{t('discuss.signAs')}</span>
              <SignAs value={signAs} onChange={setSignAs} disabled={saving} />
              <span className={`hint-text ${needSign ? 'bad' : ''}`}>{t('station.whoDoneHint')}</span>
            </div>
          )}
        </div>
        <div className="m-foot">
          <div className="grow">{!noScope ? t('discuss.participants', { count: participants }) : ''}</div>
          <button className="btn outline lg" type="button" onClick={close} disabled={saving}>
            {t('actions.cancel')}
          </button>
          <button className="btn primary lg" type="button" disabled={!canSave} onClick={() => void submit()}>
            <IconCheck size={16} />
            {saving && uploadProgress ? t('files.uploadingN', uploadProgress) : editing ? t('actions.save') : t('discuss.publish')}
          </button>
        </div>
      </div>
    </div>
  );
}
