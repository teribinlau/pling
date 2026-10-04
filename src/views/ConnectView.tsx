// 桌面版第一次打开：连接服务器。输入 pling.example.cn / 完整地址 / 邀请链接都行，
// 取 <地址>/config.json 存本机，然后整页重新加载（store 要用新配置重新建）。也可以「先看看演示」。
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchServerConfig, parseServerInput, saveDesktopServer, savePendingInvite, type ConnectError } from '../lib/config';
import { BrandMark } from '../components/BrandMark';

export function ConnectView({ initial = '' }: { initial?: string }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ConnectError | null>(null);
  const parsed = parseServerInput(value);

  const connect = async () => {
    setErr(null);
    if (!parsed) {
      setErr('bad_address');
      return;
    }
    setBusy(true);
    const r = await fetchServerConfig(parsed.base);
    setBusy(false);
    if (!r.ok) {
      setErr(r.error);
      return;
    }
    saveDesktopServer(parsed.base, r.config);
    if (parsed.invite) savePendingInvite(parsed.invite);
    window.location.reload();
  };

  const demo = () => {
    saveDesktopServer('', null);
    window.location.reload();
  };

  return (
    <div className="login">
      <form
        className="box connect-box"
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        <div className="brand">
          <BrandMark size={44} />
          <div className="brand-txt">
            <h1>{t('app.name')}</h1>
            <span className="brand-sub">{t('app.latin')}</span>
          </div>
        </div>
        <h2 className="login-h2">{t('connect.title')}</h2>
        <p>{t('connect.hint')}</p>
        <label className="lbl" htmlFor="server">
          {t('connect.label')}
        </label>
        <input
          id="server"
          className="input big"
          autoFocus
          autoComplete="url"
          spellCheck={false}
          inputMode="url"
          placeholder={t('connect.placeholder')}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setErr(null);
          }}
          aria-invalid={!!err}
        />
        {parsed?.invite && !err && <p className="ok">{t('connect.inviteFound', { code: parsed.invite })}</p>}
        {err && (
          <p className="login-err" role="alert">
            {t(`connect.errors.${err}`)}
          </p>
        )}
        <button className="btn primary lg block" type="submit" disabled={busy || !value.trim()}>
          {busy ? t('connect.connecting') : t('connect.connect')}
        </button>
        <button className="btn ghost block" type="button" onClick={demo} disabled={busy}>
          {t('connect.demo')}
        </button>
      </form>
    </div>
  );
}
