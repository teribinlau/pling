import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from './lib/store';
import { startScheduler } from './lib/scheduler';
import { useOccurrences } from './lib/useData';
import { useBackButton } from './lib/useBackButton';
import { getConfig } from './lib/config';
import { isTauri, listenAlertActions, listenTrayCommands, showMainWindow } from './lib/tauri';
import { Rail } from './components/Rail';
import { Sidebar } from './components/Sidebar';
import { AgendaView } from './components/AgendaView';
import { BoardView } from './components/BoardView';
import { DetailPanel } from './components/DetailPanel';
import { ReminderModal } from './components/ReminderModal';
import { StationPicker } from './components/StationPicker';
import { ImageViewer } from './components/ImageViewer';
import { DiscussionModal } from './components/DiscussionModal';
import { Toasts } from './components/Toasts';
import { LoginView, NameView } from './views/LoginView';
import { SettingsView } from './views/SettingsView';
import { DiscussionsView } from './views/DiscussionsView';
import { useDiscussions } from './lib/useDiscussions';
import { IconCalendar, IconChat, IconList, IconPlus, IconSliders, IconUser } from './components/Icons';

export default function App() {
  const init = useStore((s) => s.init);
  useEffect(() => {
    void init();
  }, [init]);
  return <Shell />;
}

function Shell() {
  const authReady = useStore((s) => s.authReady);
  const session = useStore((s) => s.session);
  const me = useStore((s) => s.me);
  const loaded = useStore((s) => s.loaded);
  const appSettings = useStore((s) => s.appSettings);
  const publicOrgName = useStore((s) => s.publicOrgName);

  // 窗口标题：机构名 · 叮一下
  const org = appSettings.org_name || publicOrgName || getConfig().orgName;
  useEffect(() => {
    document.title = org ? `${org} · 叮一下` : '叮一下';
  }, [org]);

  if (!authReady) return <div className="login" />;
  // 登录页 / 填姓名 / 等激活也要能弹提示（邀请码用没用上、登录出错……）
  if (!session || !loaded || !me)
    return (
      <>
        <LoginView />
        <Toasts />
      </>
    );
  // 微信 / QQ 新用户的名字是昵称、邮箱用户是邮箱前缀：进应用前先填真实姓名（共用设备账号不用）
  if (me.name_confirmed === false && !me.is_station)
    return (
      <>
        <NameView />
        <Toasts />
      </>
    );
  if (!me.active)
    return (
      <>
        <LoginView />
        <Toasts />
      </>
    );
  return <Main />;
}

function Main() {
  const { t } = useTranslation();
  const mode = useStore((s) => s.mode);
  const fromCache = useStore((s) => s.fromCache);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const showNew = useStore((s) => s.showNew);
  const openNew = useStore((s) => s.openNew);
  const select = useStore((s) => s.select);
  const settingsTab = useStore((s) => s.settingsTab);
  const setSettingsTab = useStore((s) => s.setSettingsTab);
  const updateReady = useStore((s) => s.updateReady);
  const checkUpdate = useStore((s) => s.checkUpdate);
  const applyUpdate = useStore((s) => s.applyUpdate);
  const discussionModal = useStore((s) => s.discussionModal);
  const openNewDiscussion = useStore((s) => s.openNewDiscussion);
  const discussionsReady = useStore((s) => s.discussionsReady);
  const { unreadTotal } = useDiscussions();

  // 安卓返回键：关掉当前这一层，而不是退出应用
  useBackButton();

  const now = new Date();
  const from = useMemo(() => new Date(now.getTime() - 30 * 86400000), [now.getDate()]); // eslint-disable-line react-hooks/exhaustive-deps
  const to = useMemo(() => new Date(now.getTime() + 1 * 86400000), [now.getDate()]); // eslint-disable-line react-hooks/exhaustive-deps
  const occs = useOccurrences(from, to, false);
  const overdue = occs.filter((o) => o.isOverdue && !o.snoozedUntil).length;

  // 自动更新（桌面版）：启动 20 秒后查一次，之后每 6 小时查一次，新版本在后台下好，
  // 装不装由用户点顶部那条提示决定（Windows 上安装会关掉应用，不能说装就装）。地址是服务器给的 updatesUrl。
  useEffect(() => {
    if (!isTauri() || !getConfig().updatesUrl) return;
    const tick = () => void checkUpdate();
    const first = window.setTimeout(tick, 20000);
    const timer = window.setInterval(tick, 6 * 3600 * 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [checkUpdate]);

  useEffect(() => {
    const stop = startScheduler();
    let unAlert: (() => void) | undefined;
    let unTray: (() => void) | undefined;
    void listenAlertActions((a) => {
      const st = useStore.getState();
      const o = occs.find((x) => x.key === a.key);
      if (!o) return;
      if (a.type === 'complete') st.requestComplete(o);
      else if (a.type === 'snooze') void st.snooze(o, a.minutes ?? 10);
      else {
        st.select(o.key);
        void showMainWindow();
      }
    }).then((u) => (unAlert = u));
    void listenTrayCommands((cmd) => {
      if (cmd === 'mute-1h') useStore.getState().muteFor(60);
    }).then((u) => (unTray = u));
    return () => {
      stop();
      unAlert?.();
      unTray?.();
    };
  }, [occs]);

  const isDiscuss = view === 'discussions';
  const noDetail = view === 'settings' || isDiscuss;
  const onAccount = view === 'settings' && settingsTab === 'account';
  return (
    <div className={`app ${isDiscuss ? 'discuss' : noDetail ? 'no-detail' : ''}`}>
      {updateReady ? (
        <div className="banner update">
          {t('app.updateReady', { v: updateReady })}
          <button className="banner-btn" onClick={() => void applyUpdate()}>
            {t('app.updateRestart')}
          </button>
        </div>
      ) : (
        <div className={`banner ${fromCache ? 'warn' : ''}`}>{mode === 'demo' ? t('app.demoBanner') : fromCache ? t('app.offline') : ''}</div>
      )}
      <Rail overdue={overdue} unreadDiscussions={unreadTotal} />
      {!isDiscuss && <Sidebar />}
      {view === 'calendar' && <AgendaView />}
      {view === 'board' && <BoardView />}
      {isDiscuss && <DiscussionsView />}
      {view === 'settings' && <SettingsView />}
      {!noDetail && <DetailPanel />}
      {!noDetail && (
        <button className="fab" aria-label={t('actions.new')} onClick={openNew}>
          <IconPlus size={22} />
        </button>
      )}
      {isDiscuss && discussionsReady && (
        <button className="fab" aria-label={t('discuss.new')} onClick={openNewDiscussion}>
          <IconPlus size={22} />
        </button>
      )}
      <nav className="tabbar" aria-label="mobile">
        <button className={view === 'calendar' ? 'active' : ''} onClick={() => { select(null); setView('calendar'); }}>
          <IconCalendar size={20} />
          <span className="tab-lbl">{t('nav.today')}</span>
        </button>
        <button className={view === 'board' ? 'active' : ''} onClick={() => { select(null); setView('board'); }}>
          <IconList size={20} />
          <span className="tab-lbl">{t('nav.board')}</span>
        </button>
        <button className={isDiscuss ? 'active' : ''} onClick={() => { select(null); setView('discussions'); }}>
          <span className="tab-ic">
            <IconChat size={20} />
            {unreadTotal > 0 && <span className="badge">{unreadTotal}</span>}
          </span>
          <span className="tab-lbl">{t('nav.discussions')}</span>
        </button>
        <button
          className={view === 'settings' && !onAccount ? 'active' : ''}
          onClick={() => {
            if (settingsTab === 'account') setSettingsTab('general');
            select(null);
            setView('settings');
          }}
        >
          <IconSliders size={20} />
          <span className="tab-lbl">{t('nav.settings')}</span>
        </button>
        <button
          className={onAccount ? 'active' : ''}
          onClick={() => {
            setSettingsTab('account');
            select(null);
            setView('settings');
          }}
        >
          <IconUser size={20} />
          <span className="tab-lbl">{t('nav.mine')}</span>
        </button>
      </nav>
      {showNew && <ReminderModal />}
      {discussionModal && <DiscussionModal />}
      <StationPicker />
      <ImageViewer />
      <Toasts />
    </div>
  );
}
