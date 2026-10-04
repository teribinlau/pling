import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import { DEMO_USERS } from '../lib/demo';
import { getConfig, readPendingInvite } from '../lib/config';
import { displayEmail } from '../lib/repo';
import { isMobileBrowser, isWechatBrowser, loginChoices, loginErrorText } from '../lib/login';
import { isTauri } from '../lib/tauri';
import type { LoginProvider } from '../lib/types';
import { BrandMark } from '../components/BrandMark';
import { IconChevronD, IconLogout, IconMail, IconTicket, IconWechat } from '../components/Icons';

/** 登录页顶上：机构名 + 叮一下 */
function Brand({ title }: { title?: string }) {
  const { t } = useTranslation();
  const publicOrgName = useStore((s) => s.publicOrgName);
  const orgName = useStore((s) => s.appSettings.org_name) || publicOrgName || getConfig().orgName;
  return (
    <div className="brand">
      <BrandMark size={44} />
      <div className="brand-txt">
        <h1>{orgName || t('app.name')}</h1>
        <span className="brand-sub">{orgName ? `${t('app.name')} · ${t('app.latin')}` : t('app.latin')}</span>
      </div>
      {title && <span className="sr-only">{title}</span>}
    </div>
  );
}

function ProviderIcon({ provider }: { provider: LoginProvider }) {
  if (provider === 'qq') {
    return (
      <span className="qq-ic" aria-hidden="true">
        QQ
      </span>
    );
  }
  return <IconWechat size={18} />;
}

export function LoginView() {
  const session = useStore((s) => s.session);
  const me = useStore((s) => s.me);
  const loaded = useStore((s) => s.loaded);
  const mode = useStore((s) => s.mode);
  if (session && loaded && me && !me.active) return <PendingView />;
  if (session && !loaded) return <div className="login" />;
  if (mode === 'demo') return <DemoLogin />;
  return <RealLogin />;
}

function DemoLogin() {
  const { t } = useTranslation();
  const repo = useStore((s) => s.repo);
  return (
    <div className="login">
      <div className="box">
        <Brand />
        <h2 className="login-h2">{t('login.demoTitle')}</h2>
        <p>{t('login.demoHint')}</p>
        <button className="btn primary lg block" onClick={() => void repo.signInDemo?.(DEMO_USERS.admin)}>
          {t('login.asAdmin')}
        </button>
        <button className="btn outline lg block" onClick={() => void repo.signInDemo?.(DEMO_USERS.member)}>
          {t('login.asMember')}
        </button>
        <button className="btn ghost lg block" onClick={() => void repo.signInDemo?.(DEMO_USERS.station)}>
          {t('login.asStation')}
        </button>
        <button className="link-btn center" onClick={() => void repo.signInDemo?.(DEMO_USERS.newcomer)}>
          {t('login.asNewcomer')}
        </button>
      </div>
    </div>
  );
}

function RealLogin() {
  const { t } = useTranslation();
  const repo = useStore((s) => s.repo);
  const loginFlow = useStore((s) => s.loginFlow);
  const loginError = useStore((s) => s.loginError);
  const startOAuth = useStore((s) => s.startOAuth);
  const cancelOAuth = useStore((s) => s.cancelOAuth);
  const reopenOAuth = useStore((s) => s.reopenOAuth);
  const clearLoginError = useStore((s) => s.clearLoginError);
  const cfg = getConfig();
  const desktop = isTauri();
  const { choices, openInWechatHint } = loginChoices(cfg.logins, { desktop, wechat: isWechatBrowser(), mobile: isMobileBrowser() });
  // 只有邮箱一种方式时直接展开；有微信 / QQ 时邮箱是后备，折起来
  const [emailOpen, setEmailOpen] = useState(choices.length === 0);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const invite = readPendingInvite();

  const send = async () => {
    setErr(null);
    setBusy(true);
    try {
      await repo.signInWithEmail(email.trim());
      setSent(email.trim());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loginFlow.phase === 'waiting') {
    const name = t(`login.providerName.${loginFlow.provider ?? 'wechat_open'}`);
    return (
      <div className="login">
        <div className="box">
          <Brand />
          <h2 className="login-h2">{t('login.waiting')}</h2>
          <p>{t('login.waitingHint', { provider: name })}</p>
          <div className="login-wait" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <button className="btn outline lg block" onClick={reopenOAuth}>
            {t('login.reopen')}
          </button>
          <button className="btn ghost block" onClick={cancelOAuth}>
            {t('login.cancel')}
          </button>
        </div>
      </div>
    );
  }

  const busyFlow = loginFlow.phase === 'redirecting' || loginFlow.phase === 'finishing';
  return (
    <div className="login">
      <div className="box">
        <Brand />
        {loginFlow.phase === 'finishing' ? (
          <p className="login-status">{t('login.finishing')}</p>
        ) : (
          <>
            {loginError && (
              <div className="login-err" role="alert">
                <b>{t('login.errorTitle')}</b>
                <span>{loginErrorText(loginError)}</span>
                <button className="link-btn" onClick={clearLoginError}>
                  {t('actions.close')}
                </button>
              </div>
            )}
            {invite && <p className="ok">{t('invite.saved', { code: invite })}</p>}
            {choices.map((c) => (
              <button
                key={c.key}
                className={`btn lg block login-btn ${c.provider === 'qq' ? 'qq' : 'wechat'}`}
                onClick={() => void startOAuth(c.provider)}
                disabled={busyFlow}
              >
                <ProviderIcon provider={c.provider} />
                {loginFlow.phase === 'redirecting' && loginFlow.provider === c.provider ? t('login.redirecting') : t(`login.${c.key}`)}
              </button>
            ))}
            {openInWechatHint && <p className="login-hint">{t('login.openInWechat')}</p>}
            {cfg.logins.email &&
              (choices.length > 0 && !emailOpen ? (
                <button className="link-btn center" onClick={() => setEmailOpen(true)}>
                  <IconMail size={13} />
                  {t('login.emailToggle')}
                  <IconChevronD size={13} />
                </button>
              ) : sent ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    setErr(null);
                    setBusy(true);
                    repo
                      .verifyEmailCode(sent, code)
                      .catch((er: Error) => setErr(er.message))
                      .finally(() => setBusy(false));
                  }}
                  className="login-form"
                >
                  <p className="ok">{t('login.sent', { email: sent })}</p>
                  <p>{t('login.codeHint')}</p>
                  <input className="input big" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} aria-label={t('login.code')} />
                  {err && <p className="login-err-text">{err}</p>}
                  <button className="btn primary lg block" type="submit" disabled={busy || code.trim().length < 6}>
                    {t('login.verify')}
                  </button>
                  <button className="btn ghost" type="button" onClick={() => { setSent(null); setCode(''); }}>
                    {t('login.changeEmail')}
                  </button>
                </form>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                  }}
                  className="login-form"
                >
                  {choices.length > 0 && <div className="login-or">{t('login.or')}</div>}
                  <p>{t('login.hint')}</p>
                  <input className="input big" type="email" required autoFocus={choices.length === 0} placeholder={t('login.emailPlaceholder')} value={email} onChange={(e) => setEmail(e.target.value)} aria-label={t('login.email')} />
                  {err && <p className="login-err-text">{err}</p>}
                  <button className={`btn ${choices.length ? 'outline' : 'primary'} lg block`} type="submit" disabled={busy || !email.includes('@')}>
                    {t('login.send')}
                  </button>
                </form>
              ))}
            {!cfg.logins.email && !choices.length && !openInWechatHint && <p className="login-err-text">{t('login.noLogins')}</p>}
          </>
        )}
      </div>
    </div>
  );
}

/** 登录了但还没激活：可以输入邀请码马上激活，否则等管理员 */
function PendingView() {
  const { t } = useTranslation();
  const me = useStore((s) => s.me);
  const session = useStore((s) => s.session);
  const signOut = useStore((s) => s.signOut);
  const redeemInvite = useStore((s) => s.redeemInvite);
  const [code, setCode] = useState(() => readPendingInvite() ?? '');
  const [busy, setBusy] = useState(false);
  const who = me?.name || displayEmail(session?.email) || '';
  return (
    <div className="login">
      <div className="box">
        <Brand />
        <h2 className="login-h2">{t('login.pendingTitle')}</h2>
        <p>{t('login.pendingHint', { who })}</p>
        <form
          className="login-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            await redeemInvite(code);
            setBusy(false);
          }}
        >
          <label className="lbl" htmlFor="invite-code">
            {t('login.inviteCode')}
          </label>
          <div className="invite-row">
            <IconTicket size={16} />
            <input
              id="invite-code"
              className="input big"
              value={code}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              placeholder={t('login.invitePlaceholder')}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          </div>
          <button className="btn primary lg block" type="submit" disabled={busy || code.replace(/[^A-Za-z0-9]/g, '').length < 6}>
            {t('login.redeem')}
          </button>
        </form>
        <button className="btn outline" onClick={() => void signOut()}>
          <IconLogout size={14} />
          {t('actions.signOut')}
        </button>
      </div>
    </div>
  );
}

/** 第一次进来：先填真实姓名（预填微信 / QQ 昵称或邮箱前缀） */
export function NameView() {
  const { t } = useTranslation();
  const me = useStore((s) => s.me);
  const signOut = useStore((s) => s.signOut);
  const confirmName = useStore((s) => s.confirmName);
  const [name, setName] = useState(me?.name ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (me && !name) setName(me.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id]);
  const n = name.trim();
  const tooLong = n.length > 20;
  return (
    <div className="login">
      <form
        className="box"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!n || tooLong) return;
          setBusy(true);
          await confirmName(n);
          setBusy(false);
        }}
      >
        <Brand />
        <h2 className="login-h2">{t('login.nameTitle')}</h2>
        <p>{t('login.nameHint')}</p>
        <input
          className="input big"
          autoFocus
          value={name}
          maxLength={40}
          placeholder={t('login.namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
          aria-label={t('settings.name')}
          onFocus={(e) => e.currentTarget.select()}
        />
        {tooLong && <p className="login-err-text">{t('login.nameTooLong')}</p>}
        <button className="btn primary lg block" type="submit" disabled={busy || !n || tooLong}>
          {t('login.nameSave')}
        </button>
        <button className="btn ghost" type="button" onClick={() => void signOut()}>
          <IconLogout size={14} />
          {t('actions.signOut')}
        </button>
      </form>
    </div>
  );
}
