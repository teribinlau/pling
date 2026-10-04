import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import { participantsOf, readPoint, ts } from '../lib/discussions';
import { filesFromTransfer, isFileDrag, mergeFiles } from '../lib/files';
import { teamName } from '../lib/occurrences';
import { dueLabel, whenLabel } from '../lib/format';
import type { Discussion, DiscussionComment, DiscussionFile, Profile } from '../lib/types';
import { Avatar } from './Avatar';
import { FileGallery } from './FileGallery';
import { FileTray } from './FileTray';
import { Linkify } from './Linkify';
import { SignAs } from './SignAs';
import { IconArrowL, IconCalendar, IconCamera, IconCheck, IconEdit, IconFlag, IconLock, IconPaperclip, IconRefresh, IconSend, IconTrash, IconUsers, IconX } from './Icons';

/** 没发出去的留言草稿：切到别的讨论再回来还在（只在内存里，关掉应用就没了） */
const drafts = new Map<string, string>();
const TOUCH = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

const byTime = <T extends { created_at: string }>(a: T, b: T) => ts(a.created_at) - ts(b.created_at);
function mergeById<T extends { id: string }>(a: T[], b: T[]): T[] {
  const m = new Map<string, T>();
  for (const x of a) m.set(x.id, x);
  for (const x of b) m.set(x.id, x);
  return [...m.values()];
}

/** 一个讨论：正文 + 附件、（已结束时）结论、留言、底部的输入框 */
export function DiscussionThread({ d, readAt }: { d: Discussion; readAt: string | undefined }) {
  const { t } = useTranslation();
  const me = useStore((s) => s.me)!;
  const repo = useStore((s) => s.repo);
  const profiles = useStore((s) => s.profiles);
  const teams = useStore((s) => s.teams);
  const members = useStore((s) => s.discussionMembers);
  const memberships = useStore((s) => s.memberships);
  const comments = useStore((s) => s.comments);
  const dFiles = useStore((s) => s.discussionFiles);
  const uploadProgress = useStore((s) => s.uploadProgress);
  const openDiscussion = useStore((s) => s.openDiscussion);
  const openEdit = useStore((s) => s.openEditDiscussion);
  const closeDiscussion = useStore((s) => s.closeDiscussion);
  const reopenDiscussion = useStore((s) => s.reopenDiscussion);
  const deleteDiscussion = useStore((s) => s.deleteDiscussion);
  const deleteDiscussionFile = useStore((s) => s.deleteDiscussionFile);
  const postComment = useStore((s) => s.postComment);
  const deleteComment = useStore((s) => s.deleteComment);
  const markRead = useStore((s) => s.markDiscussionRead);
  const pushToast = useStore((s) => s.pushToast);
  const setView = useStore((s) => s.setView);
  const setAnchor = useStore((s) => s.setCalendarAnchor);

  const isCreator = d.created_by === me.id;
  const isAdmin = me.role === 'admin';
  const closed = !!d.closed_at;

  // ---- 留言：store 里是最近几个月的；更早的点「查看更早的」时整串拉下来 ----
  const [full, setFull] = useState<{ comments: DiscussionComment[]; files: DiscussionFile[] } | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const mineComments = useMemo(() => comments.filter((c) => c.discussion_id === d.id), [comments, d.id]);
  const list = useMemo(() => mergeById(full?.comments ?? [], mineComments).sort(byTime), [full, mineComments]);
  const allFiles = useMemo(() => mergeById(full?.files ?? [], dFiles.filter((f) => f.discussion_id === d.id)).sort(byTime), [full, dFiles, d.id]);
  const bodyFiles = allFiles.filter((f) => !f.comment_id);
  const missing = full ? 0 : Math.max(0, d.comment_count - mineComments.length);
  const loadEarlier = async () => {
    setLoadingEarlier(true);
    try {
      setFull(await repo.loadThread(d.id));
    } catch (e) {
      pushToast({ title: t('errors.downloadFailed'), body: (e as Error).message, kind: 'error' });
    } finally {
      setLoadingEarlier(false);
    }
  };
  // 整串已经拉下来之后，有人删了 / 加了留言：再拉一次，别留着已经删掉的
  useEffect(() => {
    if (!full) return;
    let alive = true;
    repo
      .loadThread(d.id)
      .then((r) => alive && setFull(r))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.comment_count]);

  // ---- 「新留言」分隔线：记住打开时读到的位置（之后标了已读也不挪） ----
  const [dividerAt] = useState(() => readPoint(d, me.id, readAt));
  const firstNewId = dividerAt !== undefined ? list.find((c) => c.author_id !== me.id && ts(c.created_at) > dividerAt)?.id : undefined;

  // ---- 标记已读：窗口在前台、看得见的时候才算 ----
  useEffect(() => {
    const mark = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) markRead(d.id, d.last_activity_at);
    };
    mark();
    window.addEventListener('focus', mark);
    document.addEventListener('visibilitychange', mark);
    return () => {
      window.removeEventListener('focus', mark);
      document.removeEventListener('visibilitychange', mark);
    };
  }, [d.id, d.last_activity_at, markRead]);

  // ---- 滚动：打开时从没看过 / 已结束 → 从头看；有新留言 → 滚到第一条新的；否则 → 到最底 ----
  const scrollRef = useRef<HTMLDivElement>(null);
  const firstNewRef = useRef<HTMLDivElement>(null);
  const stick = useRef(false); // 在底部附近：有新留言进来就跟着滚到底
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (dividerAt === undefined || closed) el.scrollTop = 0;
    else if (firstNewRef.current) el.scrollTop = Math.max(0, firstNewRef.current.offsetTop - 60);
    else {
      el.scrollTop = el.scrollHeight;
      stick.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [list.length]);
  const toBottom = () => {
    stick.current = true;
    window.requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  };

  // ---- 谁发的 ----
  const creator = profiles.find((p) => p.id === d.created_by);
  const creatorName = d.created_by_name || creator?.name || '';
  const personByName = (name: string) => profiles.find((p) => p.name === name);
  const authorOf = (c: DiscussionComment): { p: Pick<Profile, 'id' | 'name'>; via: string } => {
    const acct = profiles.find((p) => p.id === c.author_id);
    // 工位账号：显示选的名字，后面小字标一下是哪台工位
    if (c.author_name) return { p: personByName(c.author_name) ?? { id: `name:${c.author_name}`, name: c.author_name }, via: acct?.name ?? '' };
    return { p: acct ?? { id: c.author_id, name: '?' }, via: '' };
  };
  const isCreatorComment = (c: DiscussionComment) => c.author_id === d.created_by && (!d.created_by_name || c.author_name === d.created_by_name);

  // ---- 截止日期：点一下跳到日历的那一天 ----
  const due = d.due_date ? dueLabel(d.due_date, closed) : null;
  const showInCalendar = () => {
    if (!d.due_date) return;
    const [y, m, dd] = d.due_date.split('-').map(Number);
    setAnchor(new Date(Date.UTC(y, m - 1, dd, 12)));
    setView('calendar');
  };

  // ---- 范围 ----
  const scopeRows = members.filter((m) => m.discussion_id === d.id);
  const scopeTeams = teams.filter((tm) => scopeRows.some((m) => m.team_id === tm.id));
  const scopePeople = profiles.filter((p) => scopeRows.some((m) => m.user_id === p.id));
  const participants = participantsOf(d, members, profiles, memberships);

  // ---- 结束 ----
  const [closing, setClosing] = useState(false);
  const [conclusion, setConclusion] = useState(d.conclusion);
  const [busy, setBusy] = useState(false);
  const doClose = async () => {
    setBusy(true);
    const ok = await closeDiscussion(d.id, conclusion);
    setBusy(false);
    if (ok) {
      setClosing(false);
      scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };
  const doReopen = async () => {
    setBusy(true);
    await reopenDiscussion(d.id);
    setBusy(false);
  };

  // ---- 输入框 ----
  const [text, setText] = useState(() => drafts.get(d.id) ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const [signAs, setSignAs] = useState('');
  const [sending, setSending] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }, [text, closing]);
  const needSign = me.is_station && !signAs;
  const canSend = (!!text.trim() || files.length > 0) && !needSign && !sending;
  const addFiles = (input: HTMLInputElement | null) => {
    const picked = Array.from(input?.files ?? []);
    if (input) input.value = '';
    setFiles(mergeFiles(files, picked));
  };
  const [dragOver, setDragOver] = useState(false);
  const send = async () => {
    if (!canSend) return;
    setSending(true);
    const ok = await postComment(d.id, text, files, me.is_station ? signAs : '');
    setSending(false);
    if (ok) {
      setText('');
      setFiles([]);
      setSignAs(''); // 共用工位：每条都重新选是谁，免得下一个人用了上一个人的名字
      drafts.delete(d.id);
      toBottom();
      // 电脑上接着打字；手机上不自动弹键盘
      if (!TOUCH) window.setTimeout(() => taRef.current?.focus(), 0);
    }
  };

  const del = () => {
    if (window.confirm(t('discuss.confirmDelete'))) void deleteDiscussion(d.id);
  };
  const canDeleteComment = (c: DiscussionComment) => isAdmin || (c.author_id === me.id && !closed);

  return (
    <section className="dthread" aria-label={d.title}>
      <div className="dt-head">
        <button className="icon-btn dt-back" aria-label={t('mobile.back')} onClick={() => openDiscussion(null)}>
          <IconArrowL size={18} />
        </button>
        <span className={`dstatus ${closed ? 'closed' : 'open'}`}>{closed ? t('discuss.tabClosed') : t('discuss.tabOpen')}</span>
        <span className="grow" />
        {isCreator && !closed && !closing && (
          <button
            className="btn outline sm"
            onClick={() => {
              setConclusion(d.conclusion); // 重新打开过的：带出上次的结论
              setClosing(true);
            }}
          >
            <IconFlag size={13} />
            {t('discuss.close')}
          </button>
        )}
        {isCreator && !closed && (
          <button className="icon-btn" aria-label={t('actions.edit')} title={t('actions.edit')} onClick={() => openEdit(d.id)}>
            <IconEdit size={16} />
          </button>
        )}
        {(isCreator || isAdmin) && (
          <button className="icon-btn" aria-label={t('discuss.delete')} title={t('discuss.delete')} onClick={del}>
            <IconTrash size={16} />
          </button>
        )}
        <button className="icon-btn dt-x" aria-label={t('actions.close')} onClick={() => openDiscussion(null)}>
          <IconX size={16} />
        </button>
      </div>

      <div className="dt-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="dt-inner">
          <article className="dpost">
            <h2 className="dpost-title">{d.title}</h2>
            <div className="dpost-meta">
              <Avatar p={d.created_by_name ? (personByName(d.created_by_name) ?? { id: `name:${d.created_by_name}`, name: d.created_by_name }) : (creator ?? { id: d.created_by, name: '?' })} size="sm" />
              <span>
                {t('discuss.startedBy', { name: creatorName })}
                {d.created_by_name && creator ? <span className="dc-via"> · {creator.name}</span> : null} · {whenLabel(new Date(ts(d.created_at)))}
              </span>
              {due && (
                <button type="button" className={`ddue ${closed ? 'closed' : due.over ? 'over' : due.hot ? 'hot' : ''}`} onClick={showInCalendar} title={t('discuss.showInCalendar')}>
                  <IconCalendar size={12} />
                  {due.text}
                </button>
              )}
            </div>
            <div className="dpost-scope" title={participants.map((p) => p.name).join('、')}>
              <IconUsers size={13} />
              {d.visibility === 'company' ? (
                <span className="tchip on">{t('discuss.everyone')}</span>
              ) : (
                <>
                  {scopeTeams.map((tm) => (
                    <span key={tm.id} className="tchip on">
                      <span className="dot" style={{ background: tm.color, width: 7, height: 7 }} />
                      {teamName(tm)}
                    </span>
                  ))}
                  {scopePeople.map((p) => (
                    <span key={p.id} className="tchip">
                      {p.name}
                    </span>
                  ))}
                </>
              )}
              <span className="dpost-count">{t('discuss.participants', { count: participants.length })}</span>
            </div>
            {closed && (
              <div className="dclosed">
                <div className="dclosed-head">
                  <IconCheck size={14} />
                  <span>{t('discuss.closedBy', { name: creatorName, when: whenLabel(new Date(ts(d.closed_at))) })}</span>
                </div>
                {d.conclusion && (
                  <div className="dclosed-text">
                    <b>{t('discuss.conclusionLabel')}</b>
                    <p>
                      <Linkify text={d.conclusion} />
                    </p>
                  </div>
                )}
                {isCreator && (
                  <button className="btn outline sm" onClick={() => void doReopen()} disabled={busy}>
                    <IconRefresh size={13} />
                    {t('discuss.reopen')}
                  </button>
                )}
              </div>
            )}
            {d.body && (
              <p className="dpost-body">
                <Linkify text={d.body} />
              </p>
            )}
            {bodyFiles.length > 0 && (
              <FileGallery
                bucket="discussions"
                items={bodyFiles}
                canDelete={() => isCreator && !closed}
                onDelete={(it) => {
                  const f = bodyFiles.find((x) => x.id === it.id);
                  if (f) void deleteDiscussionFile(f);
                }}
              />
            )}
          </article>

          <div className="dcomments">
            <div className="dcomments-head">
              {t('discuss.comments')} · {Math.max(d.comment_count, list.length)}
            </div>
            {missing > 0 && (
              <button className="link-btn dearlier" onClick={() => void loadEarlier()} disabled={loadingEarlier}>
                {loadingEarlier ? '…' : t('discuss.earlier', { count: missing })}
              </button>
            )}
            {list.length === 0 && missing === 0 && !closed && <div className="dempty">{t('discuss.noComments')}</div>}
            {list.map((c) => {
              const a = authorOf(c);
              const cf = allFiles.filter((f) => f.comment_id === c.id);
              return (
                <Fragment key={c.id}>
                  {c.id === firstNewId && (
                    <div className="dnew-divider" ref={firstNewRef}>
                      <span>{t('discuss.newDivider')}</span>
                    </div>
                  )}
                  <div className={`dcomment ${c.author_id === me.id && !c.author_name ? 'mine' : ''}`}>
                    <Avatar p={a.p} />
                    <div className="dc-main">
                      <div className="dc-head">
                        <b className="dc-name">{a.p.name}</b>
                        {a.via && <span className="dc-via">{a.via}</span>}
                        {isCreatorComment(c) && <span className="dc-tag">{t('discuss.creatorTag')}</span>}
                        <span className="dc-time">{whenLabel(new Date(ts(c.created_at)))}</span>
                        {canDeleteComment(c) && (
                          <button
                            className="icon-btn sm dc-del"
                            aria-label={t('actions.delete')}
                            title={t('actions.delete')}
                            onClick={() => {
                              if (window.confirm(t('discuss.confirmDeleteComment'))) void deleteComment(c, cf);
                            }}
                          >
                            <IconTrash size={13} />
                          </button>
                        )}
                      </div>
                      {c.body && (
                        <p className="dc-body">
                          <Linkify text={c.body} />
                        </p>
                      )}
                      {cf.length > 0 && <FileGallery bucket="discussions" items={cf} />}
                    </div>
                  </div>
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>

      <div className="dt-foot">
        <div className="dt-inner">
          {closed ? (
            <div className="dt-readonly">
              <IconLock size={14} />
              <span>{t('discuss.readOnly')}</span>
            </div>
          ) : closing ? (
            <div className="dclose">
              <div className="dclose-head">
                <IconFlag size={14} />
                <b>{t('discuss.closeTitle')}</b>
              </div>
              <span className="hint-text">{t('discuss.closeHint')}</span>
              <label className="dclose-lbl" htmlFor="d-conclusion">
                {t('discuss.conclusion')}
              </label>
              <textarea
                id="d-conclusion"
                className="input"
                rows={2}
                autoFocus
                value={conclusion}
                placeholder={t('discuss.conclusionPlaceholder')}
                onChange={(e) => setConclusion(e.target.value)}
                disabled={busy}
              />
              <div className="dclose-acts">
                <button className="btn ghost" onClick={() => setClosing(false)} disabled={busy}>
                  {t('actions.cancel')}
                </button>
                <button className="btn primary" onClick={() => void doClose()} disabled={busy}>
                  <IconCheck size={14} />
                  {t('discuss.confirmClose')}
                </button>
              </div>
            </div>
          ) : (
            <div
              className={`dcomposer ${dragOver ? 'drag' : ''}`}
              onDragOver={(e) => {
                if (sending || !isFileDrag(e)) return;
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
              }}
              onDrop={(e) => {
                setDragOver(false);
                if (sending || !isFileDrag(e)) return;
                e.preventDefault();
                const got = filesFromTransfer(e.dataTransfer);
                if (got.length) setFiles(mergeFiles(files, got));
              }}
            >
              {files.length > 0 && <FileTray files={files} onChange={setFiles} disabled={sending} />}
              <textarea
                ref={taRef}
                className="dc-input"
                rows={1}
                value={text}
                placeholder={t('discuss.composer')}
                aria-label={t('discuss.composer')}
                onChange={(e) => {
                  setText(e.target.value);
                  drafts.set(d.id, e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void send();
                  }
                }}
                onPaste={(e) => {
                  // 截图直接 Ctrl+V 贴进来就是附件
                  const got = filesFromTransfer(e.clipboardData);
                  if (!got.length) return;
                  e.preventDefault();
                  setFiles(mergeFiles(files, got));
                }}
                disabled={sending}
              />
              <div className="dc-bar">
                {!files.length && (
                  <button className="icon-btn" aria-label={t('discuss.attach')} title={t('discuss.attach')} onClick={() => pickRef.current?.click()} disabled={sending}>
                    <IconPaperclip size={18} />
                  </button>
                )}
                {!files.length && TOUCH && (
                  <button className="icon-btn" aria-label={t('files.camera')} title={t('files.camera')} onClick={() => camRef.current?.click()} disabled={sending}>
                    <IconCamera size={18} />
                  </button>
                )}
                {me.is_station && <SignAs value={signAs} onChange={setSignAs} disabled={sending} />}
                <span className="grow" />
                {!TOUCH && <span className="dc-hint">{t('discuss.sendHint', { key: MAC ? '⌘' : 'Ctrl' })}</span>}
                <button className="btn primary sm" onClick={() => void send()} disabled={!canSend}>
                  <IconSend size={14} />
                  {sending ? (uploadProgress ? t('files.uploadingN', uploadProgress) : t('discuss.sending')) : t('discuss.send')}
                </button>
              </div>
              <input ref={pickRef} type="file" multiple hidden onChange={() => addFiles(pickRef.current)} />
              <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={() => addFiles(camRef.current)} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
