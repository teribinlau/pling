// 设置 → 群机器人（管理员）：每个小组可以配企业微信 / 钉钉 / 飞书机器人，「全体」也能配
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../lib/store';
import { agoLabel } from '../../lib/format';
import type { NotifyStage, TeamWebhook, WebhookKind } from '../../lib/types';
import type { WebhookInput } from '../../lib/repo';
import { IconBot, IconEdit, IconPlus, IconTrash } from '../../components/Icons';
import { Switch } from './common';

const KINDS: WebhookKind[] = ['wecom', 'dingtalk', 'feishu'];
const STAGES: NotifyStage[] = ['pre', 'due', 'overdue'];

function BotForm({ initial, onDone }: { initial: WebhookInput; onDone: () => void }) {
  const { t } = useTranslation();
  const teams = useStore((s) => s.teams);
  const upsertWebhook = useStore((s) => s.upsertWebhook);
  const [w, setW] = useState<WebhookInput>(initial);
  const [busy, setBusy] = useState(false);
  const urlOk = /^https:\/\/\S+$/.test(w.url.trim());
  const ok = urlOk && w.stages.length > 0 && !!w.name.trim();
  const toggleStage = (s: NotifyStage) => setW({ ...w, stages: w.stages.includes(s) ? w.stages.filter((x) => x !== s) : STAGES.filter((x) => x === s || w.stages.includes(x)) });
  const save = async () => {
    if (!ok) return;
    setBusy(true);
    const done = await upsertWebhook({ ...w, name: w.name.trim(), url: w.url.trim(), secret: w.secret.trim() });
    setBusy(false);
    if (done) onDone();
  };
  return (
    <div className="bot-form">
      <span className="lbl">{t('bots.kind.wecom')} / {t('bots.kind.dingtalk')} / {t('bots.kind.feishu')}</span>
      <div className="seg bot-kind" role="radiogroup">
        {KINDS.map((k) => (
          <button key={k} type="button" role="radio" aria-checked={w.kind === k} className={w.kind === k ? 'active' : ''} onClick={() => setW({ ...w, kind: k })}>
            {t(`bots.kind.${k}`)}
          </button>
        ))}
      </div>
      <label className="lbl" htmlFor="bot-team">
        {t('form.team')}
      </label>
      <select id="bot-team" className="select" value={w.team_id ?? ''} onChange={(e) => setW({ ...w, team_id: e.target.value || null })}>
        {teams.map((tm) => (
          <option key={tm.id} value={tm.id}>
            {tm.name}
          </option>
        ))}
        <option value="">{t('bots.orgGroup')}</option>
      </select>
      <label className="lbl" htmlFor="bot-name">
        {t('bots.name')}
      </label>
      <input id="bot-name" className="input" maxLength={30} placeholder={t('bots.namePlaceholder')} value={w.name} onChange={(e) => setW({ ...w, name: e.target.value })} />
      <label className="lbl" htmlFor="bot-url">
        {t('bots.url')}
      </label>
      <input id="bot-url" className="input mono" spellCheck={false} placeholder={t('bots.urlPlaceholder')} value={w.url} onChange={(e) => setW({ ...w, url: e.target.value })} aria-invalid={!!w.url && !urlOk} />
      {!!w.url && !urlOk && <span className="hint-text bad">{t('bots.badUrl')}</span>}
      {w.kind !== 'wecom' && (
        <>
          <label className="lbl" htmlFor="bot-secret">
            {t('bots.secret')}
          </label>
          <input id="bot-secret" className="input mono" spellCheck={false} value={w.secret} onChange={(e) => setW({ ...w, secret: e.target.value })} />
          <span className="hint-text">{t('bots.secretHint')}</span>
        </>
      )}
      <span className="lbl">{t('bots.stages')}</span>
      <div className="chips">
        {STAGES.map((s) => (
          <button key={s} type="button" className={`chip ${w.stages.includes(s) ? 'active' : ''}`} onClick={() => toggleStage(s)} aria-pressed={w.stages.includes(s)}>
            {t(`bots.stage.${s}`)}
          </button>
        ))}
      </div>
      {!w.stages.length && <span className="hint-text bad">{t('bots.needStage')}</span>}
      <div className="bot-form-row">
        <span className="txt">{t('bots.enabled')}</span>
        <Switch on={w.enabled} onChange={(v) => setW({ ...w, enabled: v })} label={t('bots.enabled')} />
      </div>
      <div className="inv-form-acts">
        <button className="btn ghost" onClick={onDone} disabled={busy}>
          {t('actions.cancel')}
        </button>
        <button className="btn primary" onClick={() => void save()} disabled={busy || !ok}>
          {t('actions.save')}
        </button>
      </div>
    </div>
  );
}

function BotCard({ w, onEdit }: { w: TeamWebhook; onEdit: () => void }) {
  const { t } = useTranslation();
  const upsertWebhook = useStore((s) => s.upsertWebhook);
  const deleteWebhook = useStore((s) => s.deleteWebhook);
  const testWebhook = useStore((s) => s.testWebhook);
  const [testing, setTesting] = useState(false);
  const okStatus = w.last_status === 'ok';
  let host = '';
  try {
    host = new URL(w.url).host;
  } catch {
    host = w.url;
  }
  return (
    <div className={`bot-card ${w.enabled ? '' : 'off'}`} data-bot={w.name}>
      <div className="bot-top">
        <span className={`bot-kind-tag ${w.kind}`}>{t(`bots.kind.${w.kind}`)}</span>
        <b className="bot-name">{w.name || host}</b>
        <span className="grow" />
        <Switch on={w.enabled} onChange={(v) => void upsertWebhook({ ...w, enabled: v })} label={t('bots.enabled')} />
      </div>
      <div className="bot-meta">
        <span className="mono">{host}</span>
        <span>· {w.stages.map((s) => t(`bots.stage.${s}`)).join(' / ')}</span>
        {w.secret && <span>· {t('bots.secret').replace(/（.*）/, '')}</span>}
      </div>
      <div className={`bot-status ${w.last_at ? (okStatus ? 'ok' : 'bad') : ''}`}>
        {w.last_at ? `${t('bots.last', { when: agoLabel(new Date(w.last_at)) })} · ${okStatus ? t('bots.lastOk') : w.last_status}` : t('bots.never')}
      </div>
      <div className="bot-acts">
        <button
          className="btn outline sm"
          disabled={testing}
          onClick={async () => {
            setTesting(true);
            await testWebhook(w.id);
            setTesting(false);
          }}
        >
          {t('bots.test')}
        </button>
        <span className="grow" />
        <button className="icon-btn" aria-label={t('bots.edit')} onClick={onEdit}>
          <IconEdit size={15} />
        </button>
        <button
          className="icon-btn"
          aria-label={t('actions.delete')}
          onClick={() => {
            if (window.confirm(t('bots.confirmDelete', { name: w.name || host }))) void deleteWebhook(w.id);
          }}
        >
          <IconTrash size={15} />
        </button>
      </div>
    </div>
  );
}

export function BotsPane() {
  const { t } = useTranslation();
  const teams = useStore((s) => s.teams);
  const webhooks = useStore((s) => s.webhooks);
  const [editing, setEditing] = useState<WebhookInput | null>(null);
  const groups = [...teams.map((tm) => ({ key: tm.id, team: tm, items: webhooks.filter((w) => w.team_id === tm.id) })), { key: 'org', team: null, items: webhooks.filter((w) => !w.team_id) }];
  const blank = (team_id: string | null): WebhookInput => ({ team_id, kind: 'wecom', name: '', url: '', secret: '', stages: ['due'], enabled: true });
  return (
    <div className="bots-pane">
      <div className="sec-line h2-line">
        <h2 className="grow">{t('bots.title')}</h2>
        {!editing && (
          <button className="btn primary sm" onClick={() => setEditing(blank(teams[0]?.id ?? null))}>
            <IconPlus size={14} />
            {t('bots.add')}
          </button>
        )}
      </div>
      <p className="hint-text pane-hint">{t('bots.hint')}</p>
      {editing && <BotForm key={editing.id ?? 'new'} initial={editing} onDone={() => setEditing(null)} />}
      {groups.map((g) => (
        <div key={g.key} className="inv-group">
          <h3 className="inv-group-h">
            {g.team ? <span className="dot" style={{ background: g.team.color, width: 9, height: 9 }} /> : <IconBot size={14} />}
            {g.team ? g.team.name : t('bots.orgGroup')}
            <span className="cnt">{g.items.length}</span>
            <span className="grow" />
            {!editing && (
              <button className="btn ghost sm" onClick={() => setEditing(blank(g.team?.id ?? null))} aria-label={`${t('bots.add')} · ${g.team ? g.team.name : t('bots.orgGroup')}`}>
                <IconPlus size={13} />
              </button>
            )}
          </h3>
          {g.items.length ? (
            <div className="inv-cards">
              {g.items.map((w) => (
                <BotCard key={w.id} w={w} onEdit={() => setEditing({ id: w.id, team_id: w.team_id, kind: w.kind, name: w.name, url: w.url, secret: w.secret, stages: w.stages, enabled: w.enabled })} />
              ))}
            </div>
          ) : (
            <span className="hint-text">{t('bots.empty')}</span>
          )}
        </div>
      ))}
    </div>
  );
}
