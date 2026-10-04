// 设置 → 成员（管理员）：小组卡片、成员表（登录方式、手机号、主小组 / 兼任、角色、激活、共用设备）
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../lib/store';
import { teamIdsOf, teamName } from '../../lib/occurrences';
import { displayEmail } from '../../lib/repo';
import type { LoginIdentity, Profile, Team } from '../../lib/types';
import { Avatar } from '../../components/Avatar';
import { IconBot, IconLock, IconPlus, IconTicket, IconTrash } from '../../components/Icons';

const TEAM_COLORS = ['#3B7A2A', '#1E5A8A', '#A8560A', '#6B4FBB', '#0E7C6B', '#C8261F', '#5F5C55'];

export function MembersPane() {
  const { t } = useTranslation();
  const me = useStore((s) => s.me);
  const teams = useStore((s) => s.teams);
  const profiles = useStore((s) => s.profiles);
  const memberships = useStore((s) => s.memberships);
  const identities = useStore((s) => s.identities);
  const invites = useStore((s) => s.invites);
  const webhooks = useStore((s) => s.webhooks);
  const adminUpdateProfile = useStore((s) => s.adminUpdateProfile);
  const adminSetMemberships = useStore((s) => s.adminSetMemberships);
  const adminUpsertTeam = useStore((s) => s.adminUpsertTeam);
  const adminDeleteTeam = useStore((s) => s.adminDeleteTeam);
  const setTab = useStore((s) => s.setSettingsTab);
  const [editTeam, setEditTeam] = useState<Partial<Team> | null>(null);

  const saveTeam = async () => {
    if (!editTeam || !editTeam.name?.trim()) return;
    await adminUpsertTeam({ ...editTeam, name: editTeam.name.trim(), color: editTeam.color ?? TEAM_COLORS[0] });
    setEditTeam(null);
  };
  // 待激活的排前面（要处理），然后按小组、姓名
  const sorted = [...profiles].sort((a, b) => Number(a.active) - Number(b.active) || (teams.find((x) => x.id === a.team_id)?.sort ?? 99) - (teams.find((x) => x.id === b.team_id)?.sort ?? 99) || a.name.localeCompare(b.name, 'zh-CN'));
  const pendingCount = profiles.filter((p) => !p.active).length;

  return (
    <>
      <div className="callout callout-row">
        <IconLock size={16} style={{ flexShrink: 0, marginTop: 2 }} />
        <span>{t('settings.inviteHint')}</span>
      </div>

      <div>
        <div className="sec-line h2-line">
          <h2 className="grow">
            {t('settings.teams')} · {teams.length}
          </h2>
          <button className="btn ghost sm" onClick={() => setEditTeam({ name: '', color: TEAM_COLORS[teams.length % TEAM_COLORS.length] })}>
            <IconPlus size={14} />
            {t('actions.newTeam')}
          </button>
        </div>
        {editTeam && (
          <div className="team-card team-edit">
            <input
              className="input"
              autoFocus
              placeholder={t('settings.teamName')}
              value={editTeam.name ?? ''}
              maxLength={20}
              onChange={(e) => setEditTeam({ ...editTeam, name: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && void saveTeam()}
              aria-label={t('settings.teamName')}
            />
            <input type="color" value={editTeam.color ?? TEAM_COLORS[0]} onChange={(e) => setEditTeam({ ...editTeam, color: e.target.value })} aria-label={t('settings.color')} className="color-input" />
            <button className="btn primary sm" onClick={() => void saveTeam()} disabled={!editTeam.name?.trim()}>
              {t('actions.save')}
            </button>
            <button className="btn ghost sm" onClick={() => setEditTeam(null)}>
              {t('actions.cancel')}
            </button>
          </div>
        )}
        <div className="team-cards">
          {teams.map((tm) => {
            // 兼任的人也算这个小组的成员，只是排在主小组的人后面
            const members = profiles.filter((p) => p.active && !p.is_station && teamIdsOf(p, memberships).includes(tm.id)).sort((a, b) => Number(b.team_id === tm.id) - Number(a.team_id === tm.id));
            const invCount = invites.filter((i) => i.team_id === tm.id && !i.disabled).length;
            const botCount = webhooks.filter((w) => w.team_id === tm.id).length;
            return (
              <div key={tm.id} className="team-card">
                <div className="name">
                  <span className="dot" style={{ background: tm.color, width: 10, height: 10 }} />
                  <span className="team-card-name">{tm.name}</span>
                  <span className="cnt">{t('settings.membersCount', { n: members.length })}</span>
                </div>
                <span className="avatars">
                  {members.slice(0, 6).map((p) => (
                    <Avatar key={p.id} p={p} size="sm" />
                  ))}
                </span>
                <div className="team-card-acts">
                  <button className="mini-btn" onClick={() => setTab('invites')} title={t('settings.invites')} aria-label={`${t('settings.invites')} ${invCount}`}>
                    <IconTicket size={12} />
                    {invCount}
                  </button>
                  <button className="mini-btn" onClick={() => setTab('bots')} title={t('settings.bots')} aria-label={`${t('settings.bots')} ${botCount}`}>
                    <IconBot size={12} />
                    {botCount}
                  </button>
                  <span className="grow" />
                  <button className="btn ghost sm" onClick={() => setEditTeam(tm)}>
                    {t('actions.edit')}
                  </button>
                  <button
                    className="btn ghost sm"
                    aria-label={t('settings.deleteTeam')}
                    onClick={() => {
                      if (window.confirm(t('settings.confirmDeleteTeam'))) void adminDeleteTeam(tm.id);
                    }}
                  >
                    <IconTrash size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <h2 style={{ marginBottom: 10 }}>
          {t('settings.members2')} · {profiles.length}
          {pendingCount > 0 && <span className="pill-count h2-pill">{t('settings.pending')} {pendingCount}</span>}
        </h2>
        <div className="table members-table">
          <div className="th">{t('settings.name')}</div>
          <div className="th">{t('settings.login')}</div>
          <div className="th">{t('form.team')}</div>
          <div className="th">{t('settings.role')}</div>
          <div className="th">{t('settings.status')}</div>
          <div className="th">{t('settings.station')}</div>
          {sorted.map((p) => (
            // 桌面上 display: contents，六个格子直接进表格；窄的时候这层变成一张卡片
            <div className="mrow" key={p.id} data-member={p.name}>
              <MemberRow
                p={p}
                me={me}
                teams={teams}
                identities={identities.filter((i) => i.user_id === p.id)}
                extras={memberships.filter((m) => m.profile_id === p.id && m.team_id !== p.team_id).map((m) => m.team_id)}
                onChange={(patch) => void adminUpdateProfile(p.id, patch)}
                onExtras={(ids) => void adminSetMemberships(p.id, ids)}
              />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/** 小组格：上面是主小组，下面是兼任小组的小标签（点 + 展开挑选） */
function TeamCell({ p, teams, extras, onChange, onExtras }: { p: Profile; teams: Team[]; extras: string[]; onChange: (patch: Partial<Profile>) => void; onExtras: (ids: string[]) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const others = teams.filter((tm) => tm.id !== p.team_id);
  const toggle = (id: string) => onExtras(extras.includes(id) ? extras.filter((x) => x !== id) : [...extras, id]);
  return (
    <div className="td team-td">
      <div className="line">
        <select className="select" value={p.team_id ?? ''} onChange={(e) => onChange({ team_id: e.target.value || null })} aria-label={t('settings.primaryTeam')}>
          <option value="">{t('form.noTeam')}</option>
          {teams.map((tm) => (
            <option key={tm.id} value={tm.id}>
              {teamName(tm)}
            </option>
          ))}
        </select>
        {others.length > 0 && (
          <button className={`add-extra ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} title={t('settings.extraTeamsHint')} aria-label={t('settings.addExtraTeam')} aria-expanded={open}>
            +
          </button>
        )}
      </div>
      {extras.length > 0 && (
        <div className="extras">
          {extras.map((id) => {
            const tm = teams.find((x) => x.id === id);
            if (!tm) return null;
            return (
              <button key={id} className="tchip on" onClick={() => toggle(id)} aria-label={t('settings.removeExtraTeam', { name: teamName(tm) })}>
                <span className="dot" style={{ background: tm.color, width: 7, height: 7 }} />
                {teamName(tm)}
                <span aria-hidden="true">×</span>
              </button>
            );
          })}
        </div>
      )}
      {open && (
        <div className="extra-pick">
          <span className="hint-text">{t('settings.extraTeams')}</span>
          <div className="extras">
            {others.map((tm) => (
              <button key={tm.id} className={`tchip ${extras.includes(tm.id) ? 'on' : ''}`} onClick={() => toggle(tm.id)}>
                <span className="dot" style={{ background: tm.color, width: 7, height: 7 }} />
                {teamName(tm)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** 登录方式：微信 / QQ / 邮箱（微信、QQ 用户没有邮箱，别显示空的） + 手机号 */
function LoginCell({ p, identities }: { p: Profile; identities: LoginIdentity[] }) {
  const { t } = useTranslation();
  const email = displayEmail(p.email);
  const hasWechat = identities.some((i) => i.provider === 'wechat_open' || i.provider === 'wechat_mp');
  const hasQq = identities.some((i) => i.provider === 'qq');
  const nick = identities.find((i) => i.nickname && i.nickname !== p.name)?.nickname;
  return (
    <div className="td login-td">
      <span className="login-tags">
        {hasWechat && <span className="ltag wx">{t('account.wechat')}</span>}
        {hasQq && <span className="ltag qq">{t('account.qq')}</span>}
        {email && <span className="ltag mail">{t('account.emailLogin')}</span>}
        {!hasWechat && !hasQq && !email && <span className="hint-text">—</span>}
      </span>
      <span className="login-sub">
        {[email, nick ? `「${nick}」` : '', p.phone].filter(Boolean).join(' · ')}
      </span>
    </div>
  );
}

function MemberRow({ p, me, teams, identities, extras, onChange, onExtras }: { p: Profile; me: Profile | null; teams: Team[]; identities: LoginIdentity[]; extras: string[]; onChange: (patch: Partial<Profile>) => void; onExtras: (ids: string[]) => void }) {
  const { t } = useTranslation();
  const isMe = me?.id === p.id;
  return (
    <>
      <div className="td">
        <Avatar p={p} size="sm" />
        <b className="member-name">{p.name}</b>
        {isMe && <span className="hint-text">· {t('settings.you')}</span>}
      </div>
      <LoginCell p={p} identities={identities} />
      <TeamCell p={p} teams={teams} extras={extras} onChange={onChange} onExtras={onExtras} />
      <div className="td">
        <div className="role-seg">
          <button className={p.role === 'member' ? 'active' : ''} disabled={isMe} onClick={() => onChange({ role: 'member' })}>
            {t('settings.member')}
          </button>
          <button className={p.role === 'admin' ? 'active' : ''} disabled={isMe} onClick={() => onChange({ role: 'admin' })}>
            {t('settings.admin')}
          </button>
        </div>
      </div>
      <div className="td">
        {p.active ? (
          <button className="status-ok" onClick={() => !isMe && onChange({ active: false })} title={t('settings.deactivate')} style={{ cursor: isMe ? 'default' : 'pointer' }}>
            <span className="dot" style={{ width: 7, height: 7 }} />
            {t('settings.active')}
          </button>
        ) : (
          <button className="btn primary sm" onClick={() => onChange({ active: true })}>
            {t('settings.activate')}
          </button>
        )}
      </div>
      <div className="td station-td">
        <span className="only-phone hint-text">{t('settings.station')}</span>
        <button className={`switch ${p.is_station ? 'on' : ''}`} role="switch" aria-checked={p.is_station} aria-label={t('station.mode')} title={t('station.modeHint')} onClick={() => onChange({ is_station: !p.is_station })}>
          <i />
        </button>
      </div>
    </>
  );
}
