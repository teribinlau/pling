// 设置：通用（这台设备）、账户（姓名 / 手机号 / 登录方式）、通知（免打扰 + 服务号 + 手机号）
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { effectiveNotifyPrefs, useStore } from '../../lib/store';
import { isTauri } from '../../lib/tauri';
import { SKINS, preloadSkinFonts } from '../../lib/skins';
import { getConfig } from '../../lib/config';
import { displayEmail } from '../../lib/repo';
import { isMobileBrowser, isWechatBrowser } from '../../lib/login';
import type { LoginProvider } from '../../lib/types';
import { TimeField } from '../../components/Pickers';
import { IconLogout, IconMail, IconRefresh, IconWechat } from '../../components/Icons';
import { Row, Switch } from './common';

export function GeneralPane() {
  const { t } = useTranslation();
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const signOut = useStore((s) => s.signOut);
  // 预览卡片要用各皮肤自己的字体
  useEffect(() => preloadSkinFonts(), []);
  return (
    <div>
      <h2>{t('settings.general')}</h2>
      <div className="set-row skin-row">
        <div className="txt">
          <b>{t('settings.skin')}</b>
          <span>{t('settings.skinHint')}</span>
        </div>
        <div className="skin-grid" role="radiogroup" aria-label={t('settings.skin')}>
          {SKINS.map((sk) => {
            const on = settings.skin === sk.id;
            const [ground, card, ink, accent] = sk.swatch;
            return (
              <button key={sk.id} role="radio" aria-checked={on} className={`skin-opt ${on ? 'on' : ''}`} onClick={() => update({ skin: sk.id })}>
                <span className="skin-prev" style={{ background: ground, borderRadius: `calc(8px * ${sk.rs})` }}>
                  <span className="skin-card" style={{ background: card, color: ink, fontFamily: sk.previewFont, borderRadius: `calc(8px * ${sk.rs})` }}>
                    Aa
                  </span>
                  <span className="skin-dots">
                    <i style={{ background: ink }} />
                    <i style={{ background: accent }} />
                  </span>
                </span>
                <span className="skin-name">{sk.name}</span>
                <span className="skin-src">{sk.source}</span>
              </button>
            );
          })}
        </div>
      </div>
      <Row title={t('settings.defaultBefore')} hint={t('settings.defaultBeforeHint')}>
        <div className="chips">
          {[0, 5, 15, 30, 60].map((m) => (
            <button key={m} className={`chip ${settings.defaultRemindBefore === m ? 'active' : ''}`} onClick={() => update({ defaultRemindBefore: m })}>
              {m === 0 ? t('time.onTime') : m === 60 ? t('time.beforeH', { n: 1 }) : t('time.before', { n: m })}
            </button>
          ))}
        </div>
      </Row>
      <Row title={t('settings.overdueRepeat')} hint={t('settings.overdueRepeatHint')}>
        <select className="select" value={settings.overdueRepeatMin} onChange={(e) => update({ overdueRepeatMin: Number(e.target.value) })} aria-label={t('settings.overdueRepeat')}>
          {[0, 10, 15, 30, 60].map((m) => (
            <option key={m} value={m}>
              {m === 0 ? '—' : t('settings.every', { n: m })}
            </option>
          ))}
        </select>
      </Row>
      {isTauri() && (
        <>
          <Row title={t('settings.autostart')} hint={t('settings.autostartHint')}>
            <Switch on={settings.autostart} onChange={(v) => update({ autostart: v })} label={t('settings.autostart')} />
          </Row>
          <Row title={t('settings.closeToTray')} hint={t('settings.closeToTrayHint')}>
            <Switch on={settings.closeToTray} onChange={(v) => update({ closeToTray: v })} label={t('settings.closeToTray')} />
          </Row>
        </>
      )}
      <div className="set-row" style={{ borderBottom: 0 }}>
        <button className="btn ghost" onClick={() => void signOut()}>
          <IconLogout size={14} />
          {t('actions.signOut')}
        </button>
      </div>
    </div>
  );
}

const PHONE_RE = /^1\d{10}$/;

/** 手机号（选填）：群机器人发提醒时按手机号 @ 人。账户页和通知页都有这一行（改的是同一个字段） */
function PhoneRow() {
  const { t } = useTranslation();
  const me = useStore((s) => s.me);
  const updateMyProfile = useStore((s) => s.updateMyProfile);
  const [phone, setPhone] = useState(me?.phone ?? '');
  useEffect(() => {
    setPhone(me?.phone ?? '');
  }, [me?.id, me?.phone]);
  if (!me) return null;
  const phoneOk = !phone.trim() || PHONE_RE.test(phone.trim());
  const savePhone = () => {
    const p = phone.trim();
    if (!phoneOk) return;
    if (p !== (me.phone ?? '')) void updateMyProfile({ phone: p });
  };
  return (
    <Row title={t('phone.title')} hint={phoneOk ? t('phone.hint') : <span className="bad">{t('phone.invalid')}</span>}>
      <input
        className="input row-input"
        inputMode="tel"
        autoComplete="tel"
        placeholder={t('phone.placeholder')}
        value={phone}
        maxLength={11}
        onChange={(e) => setPhone(e.target.value.replace(/[^\d]/g, ''))}
        onBlur={savePhone}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        aria-label={t('phone.title')}
        aria-invalid={!phoneOk}
      />
    </Row>
  );
}

export function AccountPane() {
  const { t } = useTranslation();
  const me = useStore((s) => s.me);
  const session = useStore((s) => s.session);
  const identities = useStore((s) => s.identities);
  const mode = useStore((s) => s.mode);
  const updateMyProfile = useStore((s) => s.updateMyProfile);
  const startOAuth = useStore((s) => s.startOAuth);
  const loginFlow = useStore((s) => s.loginFlow);
  const cancelOAuth = useStore((s) => s.cancelOAuth);
  const signOut = useStore((s) => s.signOut);
  const [name, setName] = useState(me?.name ?? '');
  useEffect(() => {
    setName(me?.name ?? '');
  }, [me?.id, me?.name]);
  if (!me) return null;
  const cfg = getConfig();
  const email = displayEmail(me.email || session?.email);
  const mine = identities.filter((i) => i.user_id === me.id);
  const wechat = mine.find((i) => i.provider === 'wechat_open' || i.provider === 'wechat_mp');
  const qq = mine.find((i) => i.provider === 'qq');
  // 绑微信：微信里打开用服务号授权；电脑上用扫码；手机普通浏览器没法扫自己 → 提示
  const inWechat = isWechatBrowser();
  const wechatProvider: LoginProvider | null = !isTauri() && inWechat && cfg.logins.wechatMp ? 'wechat_mp' : (isTauri() || !isMobileBrowser()) && cfg.logins.wechat ? 'wechat_open' : null;
  const wechatEnabled = cfg.logins.wechat || cfg.logins.wechatMp;
  const linking = loginFlow.link && loginFlow.phase !== 'idle';
  const saveName = () => {
    const n = name.trim();
    if (n && n !== me.name) void updateMyProfile({ name: n.slice(0, 40) });
    else setName(me.name);
  };
  return (
    <div>
      <h2>{t('account.title')}</h2>
      <Row title={t('settings.changeMyName')} hint={t('settings.changeMyNameHint')}>
        <input className="input row-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onBlur={saveName} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} aria-label={t('settings.changeMyName')} />
      </Row>
      {!me.is_station && <PhoneRow />}
      <div className="set-row acct-methods">
        <div className="txt">
          <b>{t('account.loginMethods')}</b>
          <span>{t('account.loginMethodsHint')}</span>
        </div>
        <div className="acct-list">
          <div className="acct-item">
            <span className="acct-ic">
              <IconMail size={15} />
            </span>
            <span className="acct-name">{t('account.emailLogin')}</span>
            <span className="acct-val">{email || t('account.notBound')}</span>
          </div>
          {wechatEnabled && (
            <div className="acct-item">
              <span className="acct-ic wx">
                <IconWechat size={15} />
              </span>
              <span className="acct-name">{t('account.wechat')}</span>
              {wechat ? (
                <span className="acct-val ok">{t('account.boundAs', { name: wechat.nickname || t('account.bound') })}</span>
              ) : mode === 'demo' ? (
                <span className="acct-val">{t('account.demoNote')}</span>
              ) : wechatProvider ? (
                <button className="btn outline sm" onClick={() => void startOAuth(wechatProvider, true)} disabled={linking}>
                  {t('account.bind')}
                </button>
              ) : (
                <span className="acct-val">{t('account.linkOnComputer')}</span>
              )}
            </div>
          )}
          {cfg.logins.qq && (
            <div className="acct-item">
              <span className="acct-ic qq">QQ</span>
              <span className="acct-name">{t('account.qq')}</span>
              {qq ? (
                <span className="acct-val ok">{t('account.boundAs', { name: qq.nickname || t('account.bound') })}</span>
              ) : mode === 'demo' ? (
                <span className="acct-val">{t('account.demoNote')}</span>
              ) : (
                <button className="btn outline sm" onClick={() => void startOAuth('qq', true)} disabled={linking}>
                  {t('account.bind')}
                </button>
              )}
            </div>
          )}
          {mode === 'demo' && !wechatEnabled && (
            <>
              <div className="acct-item">
                <span className="acct-ic wx">
                  <IconWechat size={15} />
                </span>
                <span className="acct-name">{t('account.wechat')}</span>
                <span className={`acct-val ${wechat ? 'ok' : ''}`}>{wechat ? t('account.boundAs', { name: wechat.nickname }) : t('account.notBound')}</span>
              </div>
              <div className="acct-item">
                <span className="acct-ic qq">QQ</span>
                <span className="acct-name">{t('account.qq')}</span>
                <span className={`acct-val ${qq ? 'ok' : ''}`}>{qq ? t('account.boundAs', { name: qq.nickname }) : t('account.notBound')}</span>
              </div>
            </>
          )}
          {linking && loginFlow.phase === 'waiting' && (
            <div className="acct-wait">
              <span className="hint-text">{t('login.waitingLink', { provider: t(`login.providerName.${loginFlow.provider ?? 'wechat_open'}`) })}</span>
              <button className="btn ghost sm" onClick={cancelOAuth}>
                {t('login.cancel')}
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="set-row" style={{ borderBottom: 0 }}>
        <button className="btn ghost" onClick={() => void signOut()}>
          <IconLogout size={14} />
          {t('actions.signOut')}
        </button>
      </div>
    </div>
  );
}

function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 服务号：绑定状态、扫码绑定（二维码 + 倒计时，绑好了自动变）、解绑、开关、测试消息 */
function WechatMpSection() {
  const { t } = useTranslation();
  const me = useStore((s) => s.me);
  const binding = useStore((s) => s.wechatBinding);
  const prefs = useStore((s) => s.notifyPrefs);
  const saveNotifyPrefs = useStore((s) => s.saveNotifyPrefs);
  const startWechatBind = useStore((s) => s.startWechatBind);
  const pollWechatBinding = useStore((s) => s.pollWechatBinding);
  const unbindWechat = useStore((s) => s.unbindWechat);
  const testWechat = useStore((s) => s.testWechat);
  const pushToast = useStore((s) => s.pushToast);
  const [qr, setQr] = useState<{ url: string; expiresAt: number; boundBefore: string | null } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const p = effectiveNotifyPrefs(prefs, me?.id ?? '');

  // 二维码显示时：每秒走倒计时；每 5 秒问一次服务器（实时订阅之外的兜底）
  useEffect(() => {
    if (!qr) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(() => void pollWechatBinding(), 5000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [qr, pollWechatBinding]);
  // 绑好了（实时订阅 / 轮询都会更新 store 里的 wechatBinding）→ 收起二维码
  useEffect(() => {
    if (qr && binding?.subscribed && binding.bound_at !== qr.boundBefore) {
      setQr(null);
      pushToast({ title: t('wechat.boundToast'), body: '', kind: 'info' });
    }
  }, [binding, qr, pushToast, t]);

  const bind = async () => {
    setBusy(true);
    const r = await startWechatBind();
    setBusy(false);
    if (r) {
      setNow(Date.now());
      setQr({ url: r.qrUrl, expiresAt: new Date(r.expiresAt).getTime(), boundBefore: binding?.subscribed ? binding.bound_at : null });
    }
  };
  const left = qr ? qr.expiresAt - now : 0;
  const state = !binding ? 'unbound' : binding.subscribed ? 'bound' : 'unsubscribed';
  return (
    <div className="wx-section">
      <Row title={t('wechat.title')} hint={t('wechat.hint')} className="wx-head">
        <span className={`wx-state ${state}`} data-state={state}>
          {state === 'unbound' ? t('wechat.unbound') : state === 'bound' ? (binding!.nickname ? t('wechat.bound', { name: binding!.nickname }) : t('wechat.boundNoName')) : t('wechat.unsubscribed')}
        </span>
      </Row>
      {qr ? (
        <div className="wx-qr">
          {left > 0 ? <img src={qr.url} alt={t('wechat.scan')} width={180} height={180} /> : <div className="wx-qr-expired">{t('wechat.expired')}</div>}
          <div className="wx-qr-txt">
            <b>{t('wechat.scan')}</b>
            <span className="hint-text">{left > 0 ? `${t('wechat.waiting')} · ${t('wechat.expiresIn', { time: fmtCountdown(left) })}` : t('wechat.expired')}</span>
            <div className="wx-qr-acts">
              <button className="btn outline sm" onClick={() => void bind()} disabled={busy}>
                <IconRefresh size={13} />
                {t('wechat.refresh')}
              </button>
              <button className="btn ghost sm" onClick={() => setQr(null)}>
                {t('actions.cancel')}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="wx-acts">
          {state !== 'bound' && (
            <button className="btn primary sm" onClick={() => void bind()} disabled={busy}>
              <IconWechat size={14} />
              {state === 'unbound' ? t('wechat.bind') : t('wechat.rebind')}
            </button>
          )}
          {binding && (
            <button
              className="btn ghost sm"
              onClick={() => {
                if (window.confirm(t('wechat.confirmUnbind'))) void unbindWechat();
              }}
            >
              {t('wechat.unbind')}
            </button>
          )}
        </div>
      )}
      {binding && (
        <>
          <Row title={t('wechat.receive')} hint={t('wechat.receiveHint')}>
            <Switch on={p.wechat} onChange={(v) => void saveNotifyPrefs({ wechat: v })} label={t('wechat.receive')} />
          </Row>
          <div className="set-row" style={{ minHeight: 0 }}>
            <button
              className="btn outline sm"
              disabled={testing || !binding.subscribed}
              onClick={async () => {
                setTesting(true);
                await testWechat();
                setTesting(false);
              }}
            >
              {t('wechat.test')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function NotificationsPane() {
  const { t } = useTranslation();
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const me = useStore((s) => s.me);
  const prefs = useStore((s) => s.notifyPrefs);
  const saveNotifyPrefs = useStore((s) => s.saveNotifyPrefs);
  const p = effectiveNotifyPrefs(prefs, me?.id ?? '');
  const showWechat = getConfig().notify.wechatMp && !me?.is_station;
  return (
    <div>
      <h2>{t('settings.notifications')}</h2>
      <Row title={t('settings.dnd')} hint={t('settings.dndHint')}>
        <div className="dnd-row">
          <TimeField className="time-input" value={p.dnd_from} onChange={(v) => void saveNotifyPrefs({ dnd_from: v })} ariaLabel={`${t('settings.dnd')} · ${t('settings.from')}`} />
          <span className="hint-text">{t('settings.to')}</span>
          <TimeField className="time-input" value={p.dnd_to} onChange={(v) => void saveNotifyPrefs({ dnd_to: v })} ariaLabel={`${t('settings.dnd')} · ${t('settings.to')}`} />
          <Switch on={p.dnd_enabled} onChange={(v) => void saveNotifyPrefs({ dnd_enabled: v })} label={t('settings.dnd')} />
        </div>
      </Row>
      <Row title={t('settings.dndRestDays')} hint={t('settings.dndRestDaysHint')}>
        <Switch on={p.dnd_rest_days} onChange={(v) => void saveNotifyPrefs({ dnd_rest_days: v })} label={t('settings.dndRestDays')} />
      </Row>
      <p className="hint-text set-note">{t('settings.dndShared')}</p>
      {showWechat && <WechatMpSection />}
      {!me?.is_station && <PhoneRow />}
      <h2 style={{ marginTop: 18 }}>{t('settings.thisDevice')}</h2>
      <Row title={t('settings.systemNotifications')} hint={t('settings.systemNotificationsHint')}>
        <Switch on={settings.systemNotifications} onChange={(v) => update({ systemNotifications: v })} label={t('settings.systemNotifications')} />
      </Row>
      <Row title={t('settings.sound')} hint={t('settings.soundHint')}>
        <Switch on={settings.sound} onChange={(v) => update({ sound: v })} label={t('settings.sound')} />
      </Row>
      {isTauri() && (
        <Row title={t('settings.alertWindow')} hint={t('settings.alertWindowHint')}>
          <Switch on={settings.alertWindow} onChange={(v) => update({ alertWindow: v })} label={t('settings.alertWindow')} />
        </Row>
      )}
    </div>
  );
}
