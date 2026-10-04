// 设置 → 邀请码（管理员）：每个小组可以生成邀请码（有效期、次数、备注），链接 + 二维码 + 复制 + 停用；也有不分组的
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../lib/store';
import { getConfig } from '../../lib/config';
import { shortDate } from '../../lib/format';
import { localYmd } from '../../lib/recurrence';
import type { TeamInvite } from '../../lib/types';
import { IconCopy, IconDownload, IconPlus, IconQr, IconTicket } from '../../components/Icons';
import { copyToClipboard, useQrDataUrl } from './common';

type Validity = 'd7' | 'd30' | 'forever';

export function inviteLink(code: string): string {
  const base = getConfig().publicUrl || (typeof location !== 'undefined' ? location.origin : '');
  return `${base.replace(/\/+$/, '')}/?invite=${code}`;
}

export function inviteState(inv: TeamInvite, now = Date.now()): 'active' | 'disabled' | 'expired' | 'usedUp' {
  if (inv.disabled) return 'disabled';
  if (inv.expires_at && new Date(inv.expires_at).getTime() < now) return 'expired';
  if (inv.max_uses !== null && inv.uses >= inv.max_uses) return 'usedUp';
  return 'active';
}

function InviteCard({ inv, open, onToggleQr }: { inv: TeamInvite; open: boolean; onToggleQr: () => void }) {
  const { t } = useTranslation();
  const teams = useStore((s) => s.teams);
  const setInviteDisabled = useStore((s) => s.setInviteDisabled);
  const pushToast = useStore((s) => s.pushToast);
  const link = inviteLink(inv.code);
  const qr = useQrDataUrl(open ? link : '', 260);
  const team = teams.find((x) => x.id === inv.team_id);
  const state = inviteState(inv);
  const copy = async () => {
    const ok = await copyToClipboard(link);
    pushToast(ok ? { title: t('invites.copied'), body: link, kind: 'info' } : { title: t('errors.copyFailed'), body: link, kind: 'error' });
  };
  return (
    <div className={`inv-card ${state}`} data-code={inv.code}>
      <div className="inv-top">
        <span className="inv-team">
          {team ? <span className="dot" style={{ background: team.color, width: 9, height: 9 }} /> : null}
          {team ? team.name : t('invites.noTeam')}
        </span>
        <span className={`inv-state ${state}`}>{t(`invites.state.${state}`)}</span>
      </div>
      <div className="inv-code" aria-label={t('login.inviteCode')}>
        {inv.code}
      </div>
      {inv.note && <div className="inv-note">{inv.note}</div>}
      <div className="inv-meta">
        <span>{inv.max_uses !== null ? t('invites.usedOf', { n: inv.uses, max: inv.max_uses }) : t('invites.used', { n: inv.uses })}</span>
        <span>· {inv.expires_at ? t('invites.expiresOn', { date: shortDate(localYmd(new Date(inv.expires_at)), false) }) : t('invites.neverExpires')}</span>
      </div>
      <div className="inv-link" title={link}>
        {link}
      </div>
      <div className="inv-acts">
        <button className="btn outline sm" onClick={() => void copy()} disabled={state !== 'active'}>
          <IconCopy size={13} />
          {t('invites.copy')}
        </button>
        <button className={`btn ghost sm ${open ? 'on' : ''}`} onClick={onToggleQr} disabled={state !== 'active'} aria-expanded={open}>
          <IconQr size={13} />
          {t('invites.qr')}
        </button>
        <span className="grow" />
        <button className="btn ghost sm" onClick={() => void setInviteDisabled(inv.code, !inv.disabled)}>
          {inv.disabled ? t('invites.enable') : t('invites.disable')}
        </button>
      </div>
      {open && state === 'active' && (
        <div className="inv-qr">
          {qr ? <img src={qr} alt={`${t('invites.qr')} ${inv.code}`} width={200} height={200} /> : <div className="inv-qr-ph" />}
          <div className="inv-qr-txt">
            <span className="hint-text">{t('invites.qrHint')}</span>
            {qr && (
              <a className="btn ghost sm" href={qr} download={`邀请码_${team?.name ?? ''}_${inv.code}.png`}>
                <IconDownload size={13} />
                {t('invites.downloadQr')}
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function InvitesPane() {
  const { t } = useTranslation();
  const teams = useStore((s) => s.teams);
  const invites = useStore((s) => s.invites);
  const createInvite = useStore((s) => s.createInvite);
  const pushToast = useStore((s) => s.pushToast);
  const [form, setForm] = useState<{ team: string; validity: Validity; uses: 'unlimited' | 'custom'; usesN: string; note: string } | null>(null);
  const [qrFor, setQrFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const usesN = Number(form?.usesN);
  const usesOk = !form || form.uses === 'unlimited' || (Number.isInteger(usesN) && usesN > 0 && usesN <= 10000);

  // 按小组分组：每个小组一块（没有邀请码的小组也显示，方便直接生成）；最后是「不分组」
  const groups = useMemo(() => {
    const byTeam = (id: string | null) => invites.filter((i) => i.team_id === id).sort((a, b) => Number(inviteState(a) !== 'active') - Number(inviteState(b) !== 'active') || b.created_at.localeCompare(a.created_at));
    return [...teams.map((tm) => ({ key: tm.id, team: tm, items: byTeam(tm.id) })), { key: 'none', team: null, items: byTeam(null) }];
  }, [teams, invites]);

  const submit = async () => {
    if (!form || !usesOk) return;
    setBusy(true);
    const days = form.validity === 'd7' ? 7 : form.validity === 'd30' ? 30 : 0;
    const code = await createInvite({
      team_id: form.team || null,
      note: form.note.trim(),
      expires_at: days ? new Date(Date.now() + days * 86400000).toISOString() : null,
      max_uses: form.uses === 'custom' ? usesN : null,
    });
    setBusy(false);
    if (code) {
      setForm(null);
      setQrFor(code);
      pushToast({ title: t('invites.created', { code }), body: inviteLink(code), kind: 'info' });
    }
  };

  return (
    <div className="invites-pane">
      <div className="sec-line h2-line">
        <h2 className="grow">{t('invites.title')}</h2>
        {!form && (
          <button className="btn primary sm" onClick={() => setForm({ team: teams[0]?.id ?? '', validity: 'd7', uses: 'unlimited', usesN: '50', note: '' })}>
            <IconPlus size={14} />
            {t('invites.new')}
          </button>
        )}
      </div>
      <p className="hint-text pane-hint">{t('invites.hint')}</p>
      {!getConfig().publicUrl && !getConfig().demo && <p className="hint-text bad">{t('invites.noPublicUrl')}</p>}

      {form && (
        <div className="inv-form">
          <label className="lbl" htmlFor="inv-team">
            {t('invites.team')}
          </label>
          <select id="inv-team" className="select" value={form.team} onChange={(e) => setForm({ ...form, team: e.target.value })}>
            {teams.map((tm) => (
              <option key={tm.id} value={tm.id}>
                {tm.name}
              </option>
            ))}
            <option value="">{t('invites.noTeam')}</option>
          </select>
          <span className="lbl">{t('invites.validity')}</span>
          <div className="chips">
            {(['d7', 'd30', 'forever'] as Validity[]).map((v) => (
              <button key={v} type="button" className={`chip ${form.validity === v ? 'active' : ''}`} onClick={() => setForm({ ...form, validity: v })} aria-pressed={form.validity === v}>
                {t(`invites.${v}`)}
              </button>
            ))}
          </div>
          <span className="lbl">{t('invites.uses')}</span>
          <div className="chips inv-uses">
            <button type="button" className={`chip ${form.uses === 'unlimited' ? 'active' : ''}`} onClick={() => setForm({ ...form, uses: 'unlimited' })} aria-pressed={form.uses === 'unlimited'}>
              {t('invites.unlimited')}
            </button>
            <button type="button" className={`chip ${form.uses === 'custom' ? 'active' : ''}`} onClick={() => setForm({ ...form, uses: 'custom' })} aria-pressed={form.uses === 'custom'}>
              {t('invites.custom')}
            </button>
            {form.uses === 'custom' && (
              <span className="inv-usesn">
                <input className="input" inputMode="numeric" value={form.usesN} onChange={(e) => setForm({ ...form, usesN: e.target.value.replace(/[^\d]/g, '') })} aria-label={t('invites.uses')} aria-invalid={!usesOk} />
                {t('invites.usesN')}
              </span>
            )}
          </div>
          {!usesOk && <span className="hint-text bad">{t('invites.badUses')}</span>}
          <label className="lbl" htmlFor="inv-note">
            {t('invites.note')}
          </label>
          <input id="inv-note" className="input" maxLength={60} placeholder={t('invites.notePlaceholder')} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          <div className="inv-form-acts">
            <button className="btn ghost" onClick={() => setForm(null)} disabled={busy}>
              {t('actions.cancel')}
            </button>
            <button className="btn primary" onClick={() => void submit()} disabled={busy || !usesOk}>
              <IconTicket size={14} />
              {t('invites.create')}
            </button>
          </div>
        </div>
      )}

      {groups.map((g) => (
        <div key={g.key} className="inv-group">
          <h3 className="inv-group-h">
            {g.team ? <span className="dot" style={{ background: g.team.color, width: 9, height: 9 }} /> : null}
            {g.team ? g.team.name : t('invites.noTeam')}
            <span className="cnt">{g.items.length}</span>
          </h3>
          {g.items.length ? (
            <div className="inv-cards">
              {g.items.map((inv) => (
                <InviteCard key={inv.code} inv={inv} open={qrFor === inv.code} onToggleQr={() => setQrFor(qrFor === inv.code ? null : inv.code)} />
              ))}
            </div>
          ) : (
            <span className="hint-text">{t('invites.empty')}</span>
          )}
        </div>
      ))}
    </div>
  );
}
