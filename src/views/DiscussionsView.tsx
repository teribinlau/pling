import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import { useDiscussions } from '../lib/useDiscussions';
import { teamName } from '../lib/occurrences';
import { agoLabel, dueLabel } from '../lib/format';
import { ts, type UnreadInfo } from '../lib/discussions';
import type { Discussion } from '../lib/types';
import { Avatar } from '../components/Avatar';
import { DiscussionThread } from '../components/DiscussionThread';
import { IconCalendar, IconChat, IconPaperclip, IconPlus } from '../components/Icons';

/** 讨论页：左边列表（进行中 / 已结束），右边打开的讨论；手机上讨论盖满整个屏幕 */
export function DiscussionsView() {
  const { t } = useTranslation();
  const ready = useStore((s) => s.discussionsReady);
  const discussionId = useStore((s) => s.discussionId);
  const openDiscussion = useStore((s) => s.openDiscussion);
  const { open, closed, unread, readAt } = useDiscussions();
  const current = [...open, ...closed].find((d) => d.id === discussionId) ?? null;

  // 打开着的讨论被删了 / 范围改了看不到了 → 关掉（刚发起、还没同步下来的不算）
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (current) seen.current.add(current.id);
    else if (discussionId && seen.current.has(discussionId)) openDiscussion(null);
  }, [current, discussionId, openDiscussion]);

  return (
    <section className={`dview ${current ? 'has-thread' : ''}`}>
      <DiscussionList open={open} closed={closed} unread={unread} currentId={current?.id ?? null} ready={ready} />
      {current ? (
        <DiscussionThread key={current.id} d={current} readAt={readAt.get(current.id)} />
      ) : (
        <div className="dthread-empty">
          <IconChat size={28} />
          <span>{t('discuss.selectHint')}</span>
        </div>
      )}
    </section>
  );
}

function DiscussionList({
  open,
  closed,
  unread,
  currentId,
  ready,
}: {
  open: Discussion[];
  closed: Discussion[];
  unread: Map<string, UnreadInfo>;
  currentId: string | null;
  ready: boolean;
}) {
  const { t } = useTranslation();
  const tab = useStore((s) => s.discussionTab);
  const setTab = useStore((s) => s.setDiscussionTab);
  const openNew = useStore((s) => s.openNewDiscussion);
  const items = tab === 'open' ? open : closed;
  const dot = (list: Discussion[]) => list.some((d) => unread.get(d.id)?.unread);
  return (
    <aside className="dlist">
      <div className="dlist-head">
        <h1>{t('discuss.title')}</h1>
        <button className="btn primary sm dlist-new" onClick={openNew} disabled={!ready} title={t('discuss.new')}>
          <IconPlus size={14} />
          {t('discuss.newShort')}
        </button>
      </div>
      <div className="seg dlist-tabs" role="tablist">
        {(['open', 'closed'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {k === 'open' ? t('discuss.tabOpen') : t('discuss.tabClosed')}
            <span className="cnt">{(k === 'open' ? open : closed).length}</span>
            {dot(k === 'open' ? open : closed) && <span className="udot" aria-hidden />}
          </button>
        ))}
      </div>
      <div className="dlist-scroll">
        {!ready && <div className="callout">{t('discuss.notReady')}</div>}
        {ready && !items.length && <div className="empty-day">{tab === 'open' ? t('discuss.empty') : t('discuss.emptyClosed')}</div>}
        {items.map((d) => (
          <DiscussionItem key={d.id} d={d} u={unread.get(d.id)} active={d.id === currentId} />
        ))}
      </div>
    </aside>
  );
}

function DiscussionItem({ d, u, active }: { d: Discussion; u: UnreadInfo | undefined; active: boolean }) {
  const { t } = useTranslation();
  const profiles = useStore((s) => s.profiles);
  const teams = useStore((s) => s.teams);
  const members = useStore((s) => s.discussionMembers);
  const comments = useStore((s) => s.comments);
  const files = useStore((s) => s.discussionFiles);
  const openDiscussion = useStore((s) => s.openDiscussion);

  const creator = profiles.find((p) => p.id === d.created_by);
  const creatorName = d.created_by_name || creator?.name || '';
  const avatar = d.created_by_name ? (profiles.find((p) => p.name === d.created_by_name) ?? { id: `name:${d.created_by_name}`, name: d.created_by_name }) : (creator ?? { id: d.created_by, name: '?' });

  // 预览：已结束的看结论；否则看最后一条留言；没有留言就看正文
  const last = comments.filter((c) => c.discussion_id === d.id).sort((a, b) => ts(b.created_at) - ts(a.created_at))[0];
  const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.trim() ?? '';
  let preview = '';
  if (d.closed_at && d.conclusion) preview = t('discuss.conclusionPreview', { text: firstLine(d.conclusion) });
  else if (last) {
    const who = last.author_name || profiles.find((p) => p.id === last.author_id)?.name || '';
    preview = t('discuss.preview', { name: who, text: firstLine(last.body) || t('discuss.filesOnly') });
  } else preview = firstLine(d.body);

  const scopeRows = members.filter((m) => m.discussion_id === d.id);
  const scope =
    d.visibility === 'company'
      ? t('discuss.everyone')
      : [
          ...teams.filter((tm) => scopeRows.some((m) => m.team_id === tm.id)).map((tm) => teamName(tm)),
          ...profiles.filter((p) => scopeRows.some((m) => m.user_id === p.id)).map((p) => p.name),
        ].join('、');
  const hasFiles = files.some((f) => f.discussion_id === d.id);
  const when = new Date(ts(d.closed_at ?? d.last_activity_at));
  // 截止日期：只给进行中的看（结束了就不用再提）
  const due = d.due_date && !d.closed_at ? dueLabel(d.due_date, false, false) : null;

  return (
    <button className={`ditem ${active ? 'active' : ''} ${u?.unread ? 'unread' : ''}`} onClick={() => openDiscussion(d.id)} aria-current={active ? 'true' : undefined}>
      <Avatar p={avatar} />
      <span className="ditem-main">
        <span className="ditem-top">
          <span className="ditem-title">{d.title}</span>
          <span className="ditem-time">{agoLabel(when)}</span>
        </span>
        {preview && <span className="ditem-sub">{preview}</span>}
        <span className="ditem-meta">
          <span className="ditem-scope">
            {creatorName} · {scope}
          </span>
          {due && (
            <span className={`ditem-due ${due.over ? 'over' : due.hot ? 'hot' : ''}`}>
              <IconCalendar size={11} />
              {due.text}
            </span>
          )}
          <span className="ditem-cnt">
            <IconChat size={11} />
            {d.comment_count}
          </span>
          {hasFiles && <IconPaperclip size={11} />}
          {u?.unread &&
            (u.isNew ? (
              <span className="dnew">{t('discuss.newBadge')}</span>
            ) : u.count > 0 ? (
              <span className="pill-count" title={t('discuss.unreadN', { count: u.count })}>
                {u.count}
              </span>
            ) : (
              <span className="udot" aria-label={t('discuss.newBadge')} />
            ))}
        </span>
      </span>
    </button>
  );
}
