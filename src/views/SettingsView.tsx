import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type SettingsTab } from '../lib/store';
import { isTauri } from '../lib/tauri';
import { clockLabel } from '../lib/format';
import { forgetDesktopServer, getConfig } from '../lib/config';
import { clearCache } from '../lib/cache';
import { BrandMark } from '../components/BrandMark';
import {
  IconBell,
  IconBot,
  IconBuilding,
  IconInfo,
  IconMonitor,
  IconRefresh,
  IconSliders,
  IconSun,
  IconTicket,
  IconUser,
  IconUsers,
} from '../components/Icons';
import { AccountPane, GeneralPane, NotificationsPane } from './settings/PersonalPanes';
import { MembersPane } from './settings/MembersPane';
import { InvitesPane } from './settings/InvitesPane';
import { BotsPane } from './settings/BotsPane';
import { HolidaysPane, OrgPane } from './settings/OrgPanes';

const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? '0.1.0';

export function SettingsView() {
  const { t } = useTranslation();
  const tab = useStore((s) => s.settingsTab);
  const setTab = useStore((s) => s.setSettingsTab);
  const me = useStore((s) => s.me);
  const isAdmin = me?.role === 'admin';
  const tabs: { key: SettingsTab; label: string; icon: ReactNode; admin?: boolean }[] = [
    { key: 'general', label: t('settings.general'), icon: <IconSliders size={16} /> },
    { key: 'account', label: t('settings.account'), icon: <IconUser size={16} /> },
    { key: 'notifications', label: t('settings.notifications'), icon: <IconBell size={16} /> },
    { key: 'members', label: t('settings.members'), icon: <IconUsers size={16} />, admin: true },
    { key: 'invites', label: t('settings.invites'), icon: <IconTicket size={16} />, admin: true },
    { key: 'bots', label: t('settings.bots'), icon: <IconBot size={16} />, admin: true },
    { key: 'org', label: t('settings.org'), icon: <IconBuilding size={16} />, admin: true },
    { key: 'holidays', label: t('settings.holidays'), icon: <IconSun size={16} /> },
    { key: 'about', label: t('settings.about'), icon: <IconInfo size={16} /> },
  ];
  const visible = tabs.filter((x) => !x.admin || isAdmin);
  const current = visible.some((x) => x.key === tab) ? tab : 'general';
  return (
    <section className="main">
      <div className="main-head">
        <div className="title">
          <span>{t('settings.title')}</span>
          <span className="dim">{visible.find((x) => x.key === current)?.label}</span>
        </div>
      </div>
      <div className="settings">
        <nav aria-label={t('settings.title')}>
          {visible.map((x) => (
            <button key={x.key} className={current === x.key ? 'active' : ''} onClick={() => setTab(x.key)} data-tab={x.key}>
              {x.icon}
              {x.label}
            </button>
          ))}
        </nav>
        <div className="pane">
          {current === 'general' && <GeneralPane />}
          {current === 'account' && <AccountPane />}
          {current === 'notifications' && <NotificationsPane />}
          {current === 'members' && isAdmin && <MembersPane />}
          {current === 'invites' && isAdmin && <InvitesPane />}
          {current === 'bots' && isAdmin && <BotsPane />}
          {current === 'org' && isAdmin && <OrgPane />}
          {current === 'holidays' && <HolidaysPane />}
          {current === 'about' && <AboutPane />}
        </div>
      </div>
    </section>
  );
}

function AboutPane() {
  const { t } = useTranslation();
  const [msg, setMsg] = useState<string | null>(null);
  const mode = useStore((s) => s.mode);
  const online = useStore((s) => s.online);
  const fromCache = useStore((s) => s.fromCache);
  const lastSync = useStore((s) => s.lastSync);
  const error = useStore((s) => s.error);
  const reload = useStore((s) => s.reload);
  const signOut = useStore((s) => s.signOut);
  const updateReady = useStore((s) => s.updateReady);
  const checkUpdate = useStore((s) => s.checkUpdate);
  const applyUpdate = useStore((s) => s.applyUpdate);
  const cfg = getConfig();
  const desktop = isTauri();
  const serverLabel = mode === 'demo' ? t('settings.demoServer') : (cfg.server || cfg.publicUrl || cfg.supabaseUrl).replace(/^https?:\/\//, '');
  const check = async () => {
    if (!cfg.updatesUrl) {
      setMsg(t('settings.noUpdatesUrl'));
      return;
    }
    setMsg('…');
    const v = await checkUpdate();
    setMsg(v ? t('settings.updated', { v }) : t('settings.upToDate'));
  };
  // 桌面版换服务器：退出登录、清掉这台服务器的缓存，回到「连接服务器」页
  const switchServer = async () => {
    if (!window.confirm(t('settings.confirmSwitchServer'))) return;
    try {
      await signOut();
    } catch {
      /* 离线也能换 */
    }
    await clearCache();
    forgetDesktopServer();
    window.location.reload();
  };
  return (
    <div>
      <h2>{t('settings.about')}</h2>
      <div className="about-brand">
        <BrandMark size={48} />
        <div className="txt">
          <b>
            {t('app.name')} · {t('app.latin')}
          </b>
          <span>
            {t('settings.version')} {APP_VERSION} · {desktop ? 'Desktop' : 'Web / PWA'}
          </span>
        </div>
        {desktop && (
          <button className="btn ghost" onClick={() => void check()}>
            <IconRefresh size={14} />
            {t('settings.checkUpdate')}
          </button>
        )}
      </div>
      {(msg || updateReady) && (
        <div className="set-row" style={{ borderBottom: 0, minHeight: 0 }}>
          <span className="hint-text">{msg ?? t('settings.updated', { v: updateReady })}</span>
          {updateReady && (
            <button className="btn primary sm" onClick={() => void applyUpdate()}>
              {t('settings.restart')}
            </button>
          )}
        </div>
      )}
      {desktop && cfg.updatesUrl && <span className="hint-text">{t('settings.autoUpdateHint')}</span>}

      <div className="stat-cards" style={{ marginTop: 16 }}>
        <div className="stat-card">
          <span className="k">{t('settings.server')}</span>
          <span className="v" data-testid="server">
            {serverLabel}
          </span>
          <span className="s">{t('settings.configFrom', { source: t(`settings.configSource.${cfg.source}`) })}</span>
        </div>
        <div className="stat-card">
          <span className="k">{t('settings.status')}</span>
          <span className={online && !fromCache ? 'status-ok' : 'status-warn'}>
            <span className="dot" style={{ width: 8, height: 8 }} />
            {online && !fromCache ? t('settings.connected') : t('settings.disconnected')}
          </span>
          <span className="s">
            {t('settings.lastSync')} {lastSync ? clockLabel(lastSync) : '—'}
            {error ? ` · ${error}` : ''}
          </span>
        </div>
        <div className="stat-card">
          <span className="k">{t('settings.cache')}</span>
          <span className="v">IndexedDB</span>
          <span className="s">{t('settings.cacheHint')}</span>
        </div>
      </div>
      <div className="about-acts">
        <button className="btn ghost" onClick={() => void reload()}>
          <IconRefresh size={14} />
          {t('settings.syncNow')}
        </button>
        {desktop && (
          <button className="btn outline" onClick={() => void switchServer()}>
            {t('settings.switchServer')}
          </button>
        )}
      </div>
      <div className="callout callout-row" style={{ marginTop: 14 }}>
        <IconMonitor size={16} style={{ flexShrink: 0, marginTop: 2 }} />
        <span>{t('station.modeHint')}</span>
      </div>
    </div>
  );
}
