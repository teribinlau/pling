import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import { Avatar } from './Avatar';
import { IconCalendar, IconChat, IconList, IconSliders, IconUsers } from './Icons';
import { BrandMark } from './BrandMark';
import { clockLabel } from '../lib/format';

export function Rail({ overdue, unreadDiscussions }: { overdue: number; unreadDiscussions: number }) {
  const { t } = useTranslation();
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const setSettingsTab = useStore((s) => s.setSettingsTab);
  const settingsTab = useStore((s) => s.settingsTab);
  const me = useStore((s) => s.me);
  const online = useStore((s) => s.online);
  const fromCache = useStore((s) => s.fromCache);
  const lastSync = useStore((s) => s.lastSync);

  return (
    <nav className="rail" aria-label="main">
      <div className="logo" title={t('app.name')}>
        <BrandMark size={36} />
      </div>
      <button className={`nav-btn ${view === 'board' ? 'active' : ''}`} aria-label={t('nav.board')} title={t('nav.board')} onClick={() => setView('board')}>
        <IconList size={18} />
        {overdue > 0 && <span className="badge">{overdue}</span>}
      </button>
      <button className={`nav-btn ${view === 'calendar' ? 'active' : ''}`} aria-label={t('nav.calendar')} title={t('nav.calendar')} onClick={() => setView('calendar')}>
        <IconCalendar size={18} />
      </button>
      <button className={`nav-btn ${view === 'discussions' ? 'active' : ''}`} aria-label={t('nav.discussions')} title={t('nav.discussions')} onClick={() => setView('discussions')}>
        <IconChat size={18} />
        {unreadDiscussions > 0 && <span className="badge">{unreadDiscussions}</span>}
      </button>
      {me?.role === 'admin' && (
        <button
          className={`nav-btn ${view === 'settings' && settingsTab === 'members' ? 'active' : ''}`}
          aria-label={t('nav.teams')}
          title={t('nav.teams')}
          onClick={() => {
            setSettingsTab('members');
            setView('settings');
          }}
        >
          <IconUsers size={18} />
        </button>
      )}
      <button
        className={`nav-btn ${view === 'settings' && settingsTab !== 'members' ? 'active' : ''}`}
        aria-label={t('nav.settings')}
        title={t('nav.settings')}
        onClick={() => {
          if (settingsTab === 'members') setSettingsTab('general');
          setView('settings');
        }}
      >
        <IconSliders size={18} />
      </button>
      <div className="spacer" />
      <div
        className={`sync ${online && !fromCache ? '' : 'off'}`}
        title={online && !fromCache ? (lastSync ? t('app.syncedAt', { time: clockLabel(lastSync) }) : t('app.synced')) : t('app.offline')}
        aria-label={online && !fromCache ? t('app.synced') : t('app.offline')}
      >
        <span className="dot" style={{ width: 10, height: 10 }} />
      </div>
      {me && (
        <button
          className="rail-me"
          title={me.name}
          aria-label={`${t('settings.account')} · ${me.name}`}
          onClick={() => {
            setSettingsTab('account');
            setView('settings');
          }}
        >
          <Avatar p={me} size="lg" />
        </button>
      )}
    </nav>
  );
}
