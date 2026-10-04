// 设置 → 机构（管理员）：机构名、「小组」「全体」的称呼、时区、逾期推送次数；设置 → 节假日
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../lib/store';
import type { Holiday, HolidayKind } from '../../lib/holidays';
import { rangeLabel, todayYmd } from '../../lib/format';
import { DateField, addDaysYmd } from '../../components/Pickers';
import { IconPlus, IconTrash } from '../../components/Icons';
import { Row } from './common';

export const LABEL_PRESETS = [
  { key: 'school', team: '班级', org: '全校' },
  { key: 'college', team: '班级', org: '全院' },
  { key: 'company', team: '部门', org: '全公司' },
  { key: 'team', team: '小组', org: '全体' },
] as const;

// 国内一律 Asia/Shanghai；港澳台、新疆（有的单位按乌鲁木齐时间作息）、新加坡备用。数据库里存了别的时区也照样显示、能保留
const TIMEZONES = ['Asia/Shanghai', 'Asia/Urumqi', 'Asia/Hong_Kong', 'Asia/Macau', 'Asia/Taipei', 'Asia/Singapore'];

const len = (s: string) => [...s.trim()].length;

export function OrgPane() {
  const { t } = useTranslation();
  const appSettings = useStore((s) => s.appSettings);
  const saveAppSettings = useStore((s) => s.saveAppSettings);
  const pushToast = useStore((s) => s.pushToast);
  const [orgName, setOrgName] = useState(appSettings.org_name);
  const [team, setTeam] = useState(appSettings.team_label);
  const [org, setOrg] = useState(appSettings.org_label);
  const [tz, setTz] = useState(appSettings.timezone);
  const [pushMax, setPushMax] = useState(appSettings.push_overdue_max);
  const [busy, setBusy] = useState(false);
  // 别人改了（实时同步）而我这边没动过：跟着换
  useEffect(() => {
    setOrgName(appSettings.org_name);
    setTeam(appSettings.team_label);
    setOrg(appSettings.org_label);
    setTz(appSettings.timezone);
    setPushMax(appSettings.push_overdue_max);
  }, [appSettings]);
  const preset = LABEL_PRESETS.find((p) => p.team === team.trim() && p.org === org.trim())?.key ?? 'custom';
  const [customOpen, setCustomOpen] = useState(false);
  const showCustom = preset === 'custom' || customOpen;
  const valid = len(team) >= 1 && len(team) <= 6 && len(org) >= 1 && len(org) <= 6;
  const dirty = orgName.trim() !== appSettings.org_name || team.trim() !== appSettings.team_label || org.trim() !== appSettings.org_label || tz !== appSettings.timezone || pushMax !== appSettings.push_overdue_max;
  const tzOptions = TIMEZONES.includes(tz) ? TIMEZONES : [tz, ...TIMEZONES];
  const save = async () => {
    if (!valid) {
      pushToast({ title: t('org.invalid'), body: '', kind: 'error' });
      return;
    }
    setBusy(true);
    const ok = await saveAppSettings({ org_name: orgName.trim(), team_label: team.trim(), org_label: org.trim(), timezone: tz, push_overdue_max: pushMax });
    setBusy(false);
    if (ok) pushToast({ title: t('org.saved'), body: '', kind: 'info' });
  };
  return (
    <div className="org-pane">
      <h2>{t('org.title')}</h2>
      <Row title={t('org.name')} hint={t('org.nameHint')}>
        <input className="input row-input wide" maxLength={40} placeholder={t('org.namePlaceholder')} value={orgName} onChange={(e) => setOrgName(e.target.value)} aria-label={t('org.name')} />
      </Row>
      <div className="set-row org-labels">
        <div className="txt">
          <b>{t('org.labels')}</b>
          <span>{t('org.labelsHint')}</span>
        </div>
        <div className="org-label-ctl">
          <div className="chips" role="radiogroup" aria-label={t('org.labels')}>
            {LABEL_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                role="radio"
                aria-checked={preset === p.key && !customOpen}
                className={`chip ${preset === p.key && !customOpen ? 'active' : ''}`}
                onClick={() => {
                  setTeam(p.team);
                  setOrg(p.org);
                  setCustomOpen(false);
                }}
              >
                {t(`org.preset.${p.key}`)}
                <small>
                  {p.team} / {p.org}
                </small>
              </button>
            ))}
            <button type="button" role="radio" aria-checked={showCustom} className={`chip ${showCustom ? 'active' : ''}`} onClick={() => setCustomOpen(true)}>
              {t('org.preset.custom')}
            </button>
          </div>
          {showCustom && (
            <div className="org-custom">
              <label>
                <span>{t('org.teamLabel')}</span>
                <input className="input" value={team} maxLength={6} onChange={(e) => setTeam(e.target.value)} aria-invalid={len(team) < 1 || len(team) > 6} aria-label={t('org.teamLabel')} />
              </label>
              <label>
                <span>{t('org.orgLabel')}</span>
                <input className="input" value={org} maxLength={6} onChange={(e) => setOrg(e.target.value)} aria-invalid={len(org) < 1 || len(org) > 6} aria-label={t('org.orgLabel')} />
              </label>
              <span className={`hint-text ${valid ? '' : 'bad'}`}>{t('org.max6')}</span>
            </div>
          )}
          <span className="hint-text org-preview">{t('org.preview', { team: team.trim() || '—', org: org.trim() || '—' })}</span>
        </div>
      </div>
      <Row title={t('org.timezone')} hint={t('org.timezoneHint')}>
        <select className="select" value={tz} onChange={(e) => setTz(e.target.value)} aria-label={t('org.timezone')}>
          {tzOptions.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      </Row>
      <Row title={t('org.pushMax')} hint={t('org.pushMaxHint')}>
        <select className="select" value={pushMax} onChange={(e) => setPushMax(Number(e.target.value))} aria-label={t('org.pushMax')}>
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n === 0 ? t('org.never') : t('org.times', { n })}
            </option>
          ))}
        </select>
      </Row>
      <div className="set-row" style={{ borderBottom: 0 }}>
        <button className="btn primary" onClick={() => void save()} disabled={busy || !dirty || !valid}>
          {busy ? t('actions.saving') : t('org.save')}
        </button>
      </div>
    </div>
  );
}

/** 连续、同类型、同名字的日子合成一段 */
interface HolidayRun {
  from: string;
  to: string;
  kind: HolidayKind;
  name: string;
  days: string[];
}

export function holidayRuns(rows: Holiday[]): HolidayRun[] {
  const sorted = [...rows].sort((a, b) => a.day.localeCompare(b.day));
  const runs: HolidayRun[] = [];
  for (const h of sorted) {
    const last = runs[runs.length - 1];
    if (last && last.kind === h.kind && last.name === h.name && addDaysYmd(last.to, 1) === h.day) {
      last.to = h.day;
      last.days.push(h.day);
    } else runs.push({ from: h.day, to: h.day, kind: h.kind, name: h.name, days: [h.day] });
  }
  return runs;
}

export function HolidaysPane() {
  const { t } = useTranslation();
  const holidays = useStore((s) => s.holidays);
  const me = useStore((s) => s.me);
  const addHolidayRange = useStore((s) => s.addHolidayRange);
  const removeHolidays = useStore((s) => s.removeHolidays);
  const pushToast = useStore((s) => s.pushToast);
  const isAdmin = me?.role === 'admin';
  const thisYear = Number(todayYmd().slice(0, 4));
  const years = useMemo(() => {
    const ys = new Set([thisYear, thisYear + 1, ...holidays.map((h) => Number(h.day.slice(0, 4)))]);
    return [...ys].sort();
  }, [holidays, thisYear]);
  const [year, setYear] = useState(thisYear);
  const runs = holidayRuns(holidays.filter((h) => h.day.startsWith(`${year}-`)));
  const [form, setForm] = useState<{ name: string; from: string; to: string; kind: HolidayKind } | null>(null);
  const [busy, setBusy] = useState(false);
  const nDays = form && form.from && form.to ? Math.round((new Date(form.to + 'T00:00:00Z').getTime() - new Date(form.from + 'T00:00:00Z').getTime()) / 86400000) + 1 : 0;
  const formError = !form ? '' : !form.name.trim() ? t('holidays.needName') : nDays < 1 ? t('holidays.badRange') : nDays > 31 ? t('holidays.tooLong') : '';
  const add = async () => {
    if (!form || formError) return;
    const rows: Holiday[] = [];
    for (let d = form.from; d <= form.to; d = addDaysYmd(d, 1)) rows.push({ day: d, kind: form.kind, name: form.name.trim() });
    setBusy(true);
    const ok = await addHolidayRange(rows);
    setBusy(false);
    if (ok) {
      pushToast({ title: t('holidays.added', { name: form.name.trim() }), body: rangeLabel(form.from, form.to), kind: 'info' });
      setYear(Number(form.from.slice(0, 4)));
      setForm(null);
    }
  };
  return (
    <div className="hol-pane">
      <div className="sec-line h2-line">
        <h2 className="grow">{t('holidays.title')}</h2>
        {isAdmin && !form && (
          <button
            className="btn primary sm"
            onClick={() => {
              const d = year === thisYear ? todayYmd() : `${year}-01-01`;
              setForm({ name: '', from: d, to: d, kind: 'off' });
            }}
          >
            <IconPlus size={14} />
            {t('holidays.add')}
          </button>
        )}
      </div>
      <p className="hint-text pane-hint">{t('holidays.hint')}</p>
      {form && (
        <div className="hol-form">
          <label className="lbl" htmlFor="hol-name">
            {t('holidays.name')}
          </label>
          <input id="hol-name" className="input" autoFocus maxLength={20} placeholder={t('holidays.namePlaceholder')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <div className="hol-dates">
            <div className="field">
              <label className="lbl" htmlFor="hol-from">
                {t('holidays.from')}
              </label>
              <DateField id="hol-from" value={form.from} onChange={(v) => setForm({ ...form, from: v, to: form.to < v ? v : form.to })} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="hol-to">
                {t('holidays.to')}
              </label>
              <DateField id="hol-to" value={form.to} min={form.from} onChange={(v) => setForm({ ...form, to: v })} />
            </div>
          </div>
          <span className="lbl">{t('holidays.kind')}</span>
          <div className="seg hol-kind" role="radiogroup">
            {(['off', 'work'] as HolidayKind[]).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={form.kind === k} className={form.kind === k ? 'active' : ''} onClick={() => setForm({ ...form, kind: k })}>
                <i className={`hday ${k}`}>{k === 'off' ? t('holidays.badgeOff') : t('holidays.badgeWork')}</i>
                {t(`holidays.${k}`)}
              </button>
            ))}
          </div>
          <span className={`hint-text ${formError ? 'bad' : ''}`}>{formError || `${rangeLabel(form.from, form.to)} · ${t('holidays.days', { n: nDays })}`}</span>
          <div className="inv-form-acts">
            <button className="btn ghost" onClick={() => setForm(null)} disabled={busy}>
              {t('actions.cancel')}
            </button>
            <button className="btn primary" onClick={() => void add()} disabled={busy || !!formError}>
              {t('holidays.add')}
            </button>
          </div>
        </div>
      )}
      <div className="seg hol-years" role="tablist">
        {years.map((y) => (
          <button key={y} role="tab" aria-selected={y === year} className={y === year ? 'active' : ''} onClick={() => setYear(y)}>
            {y}
          </button>
        ))}
      </div>
      {runs.length ? (
        <div className="hol-list">
          {runs.map((r) => (
            <div key={`${r.from}-${r.kind}`} className={`hol-row ${r.kind}`} data-holiday={r.name}>
              <i className={`hday ${r.kind}`}>{r.kind === 'off' ? t('holidays.badgeOff') : t('holidays.badgeWork')}</i>
              <b className="hol-name">{r.name}</b>
              <span className="hol-range">{rangeLabel(r.from, r.to)}</span>
              <span className="hol-days">{r.kind === 'off' ? t('holidays.days', { n: r.days.length }) : t('holidays.work')}</span>
              {isAdmin && (
                <button
                  className="icon-btn sm"
                  aria-label={`${t('actions.delete')} ${r.name}`}
                  onClick={() => {
                    if (window.confirm(t('holidays.confirmDelete', { name: r.name, range: rangeLabel(r.from, r.to) }))) void removeHolidays(r.days);
                  }}
                >
                  <IconTrash size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-day">{t('holidays.empty', { year })}</div>
      )}
    </div>
  );
}
