import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { dayDiff, monthLabel, shortDate, todayYmd } from '../lib/format';
import { holidayOn } from '../lib/holidays';
import { useStore } from '../lib/store';
import { IconCalendar, IconChevronL, IconChevronR, IconClock } from './Icons';

// 日期 / 时间选择：浏览器自带的 <input type="date|time"> 在 Mac（Safari / 桌面版的 WKWebView）上
// 没有日历和时钟小图标，时间框根本没有选择面板，日期面板也常常点了不出来 —— 所以自己画一套，各平台一样。

/* ---------------- 日期工具（都是机构时区的本地日期 YYYY-MM-DD，按 UTC 算天数，不受夏令时影响） ---------------- */

const toDate = (ymd: string) => new Date(ymd + 'T00:00:00Z');
const fromDate = (d: Date) => d.toISOString().slice(0, 10);
export const addDaysYmd = (ymd: string, n: number) => fromDate(new Date(toDate(ymd).getTime() + n * 86400000));
function addMonthsYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate(); // 目标月的最后一天（1 月 31 日 + 1 个月 = 2 月 28 日）
  return fromDate(new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))));
}
/** 这个月的 6 × 7 格，周一开头 */
function monthCells(month: string): string[] {
  const first = toDate(month + '-01');
  const offset = (first.getUTCDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => addDaysYmd(month + '-01', i - offset));
}
const clamp = (ymd: string, min?: string, max?: string) => (min && ymd < min ? min : max && ymd > max ? max : ymd);

/**
 * 在弹出层里按下鼠标时焦点不动（click 照样触发）：不然点到空白处、或者在 Safari 里点按钮（Safari 点按钮不给焦点），
 * 输入框 / 日期格会失焦，弹出层就被当成「点到外面」关掉了。
 */
const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();

/** 把手敲的时间变成 HH:MM：16:30 / 1630 / 16.30 / 16：30（中文冒号）/ 930 / 9 都行；看不懂的返回 null */
export function parseTime(raw: string): string | null {
  const s = raw.trim().replace(/[：.,hH]/g, ':').replace(/\s+/g, '').replace(/:$/, ''); // 16h / 16: → 16
  let h: number;
  let m: number;
  let mt: RegExpMatchArray | null;
  if ((mt = s.match(/^(\d{1,2}):(\d{1,2})$/))) {
    h = Number(mt[1]);
    m = Number(mt[2]);
  } else if ((mt = s.match(/^(\d{1,2})$/))) {
    h = Number(mt[1]);
    m = 0;
  } else if ((mt = s.match(/^(\d{1,2})(\d{2})$/))) {
    h = Number(mt[1]);
    m = Number(mt[2]);
  } else return null;
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function stepTime(hm: string, minutes: number): string {
  const [h, m] = hm.split(':').map(Number);
  const t = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/* ---------------- 弹出层：点外面 / Tab 出去就关；弹出来时左右放不下就往里挪，并滚到看得见 ---------------- */

function usePopover() {
  const [open, setOpen] = useState(false);
  const [offsetX, setOffsetX] = useState(0); // 相对输入框左边挪多少（负数 = 往左）
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('touchstart', onDown, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('touchstart', onDown, true);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) {
      setOffsetX(0);
      return;
    }
    const wrap = wrapRef.current;
    const pop = popRef.current;
    if (!wrap || !pop) return;
    // 在弹窗 / 设置面板（没有就是整个窗口）里放得下：右边超出就往左挪，但左边不能挪出去
    const box = (wrap.closest('.m-body, .pane, .main') ?? document.documentElement).getBoundingClientRect();
    const minLeft = Math.max(box.left, 0) + 8;
    const maxRight = Math.min(box.right, window.innerWidth) - 8;
    const left = wrap.getBoundingClientRect().left;
    let x = Math.min(0, maxRight - (left + pop.offsetWidth));
    x = Math.max(x, minLeft - left);
    setOffsetX(Math.round(x));
  }, [open]);
  useEffect(() => {
    if (open) popRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open, offsetX]);
  return { open, setOpen, offsetX, wrapRef, popRef };
}

/* ---------------- 日期 ---------------- */

interface DateFieldProps {
  id?: string;
  value: string; // YYYY-MM-DD，空 = 没选
  onChange: (ymd: string) => void;
  min?: string;
  max?: string;
  placeholder?: string;
  className?: string;
}

/** 日期框：显示「9月25日 周五 · 今天」，点一下弹出月历 */
export function DateField({ id, value, onChange, min, max, placeholder, className }: DateFieldProps) {
  const { t } = useTranslation();
  const { open, setOpen, offsetX, wrapRef, popRef } = usePopover();
  const btnRef = useRef<HTMLButtonElement>(null);
  const today = todayYmd();
  const diff = value ? dayDiff(value, today) : 0;
  const rel = !value ? '' : diff === 0 ? t('time.today') : diff === 1 ? t('time.tomorrow') : diff === -1 ? t('time.yesterday') : '';
  const text = value ? shortDate(value) + (rel ? ` · ${rel}` : '') : placeholder ?? t('picker.chooseDate');

  const close = (focusBack: boolean) => {
    setOpen(false);
    if (focusBack) btnRef.current?.focus();
  };
  const pick = (ymd: string) => {
    onChange(ymd);
    close(true);
  };

  return (
    <div
      ref={wrapRef}
      className={`pfield ${open ? 'open' : ''} ${className ?? ''}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          // 只关日历，不关整个弹窗
          e.stopPropagation();
          e.preventDefault();
          close(true);
        }
      }}
      onBlur={(e) => {
        if (open && !wrapRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={btnRef}
        id={id}
        type="button"
        className={`input pfield-btn ${value ? '' : 'empty'}`}
        data-value={value}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="pfield-text">{text}</span>
        <IconCalendar size={16} />
      </button>
      {open && (
        <div ref={popRef} className="picker-pop cal-pop" style={{ left: offsetX }} role="dialog" aria-label={t('picker.chooseDate')} onMouseDown={keepFocus}>
          <MonthCalendar value={value} min={min} max={max} onPick={pick} />
          <div className="cal-foot">
            {[0, 1].map((n) => {
              const ymd = addDaysYmd(today, n);
              const off = (!!min && ymd < min) || (!!max && ymd > max);
              return (
                <button key={n} type="button" className={`chip ${value === ymd ? 'active' : ''}`} disabled={off} onClick={() => pick(ymd)}>
                  {n === 0 ? t('time.today') : t('time.tomorrow')}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** 月历：方向键按天 / 按周移动，PageUp / PageDown 换月，Home / End 到周一 / 周日，回车选中 */
function MonthCalendar({ value, min, max, onPick }: { value: string; min?: string; max?: string; onPick: (ymd: string) => void }) {
  const { t } = useTranslation();
  useStore((s) => s.holidays); // 节假日变了（管理员加了 / 实时同步）重新画
  const today = todayYmd();
  const [cursor, setCursor] = useState(() => clamp(value || today, min, max));
  const [month, setMonth] = useState(cursor.slice(0, 7));
  const gridRef = useRef<HTMLDivElement>(null);
  const cells = useMemo(() => monthCells(month), [month]);
  const [y, m] = month.split('-').map(Number);

  // 光标移动后把焦点放到那一格（刚弹出来时也是：键盘直接就能用）
  useLayoutEffect(() => {
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-ymd="${cursor}"]`)?.focus({ preventScroll: true });
  }, [cursor, month]);

  const moveTo = (ymd: string) => {
    const next = clamp(ymd, min, max);
    setCursor(next);
    setMonth(next.slice(0, 7));
  };
  const showMonth = (delta: number) => {
    const next = addMonthsYmd(month + '-01', delta).slice(0, 7);
    setMonth(next);
    // 光标跟着换到那个月的同一天（没有这一天就是月底），超出范围的夹回来
    setCursor(clamp(addMonthsYmd(cursor, delta), min, max));
  };
  const onKey = (e: ReactKeyboardEvent) => {
    const wd = (toDate(cursor).getUTCDay() + 6) % 7;
    const moves: Record<string, () => void> = {
      ArrowLeft: () => moveTo(addDaysYmd(cursor, -1)),
      ArrowRight: () => moveTo(addDaysYmd(cursor, 1)),
      ArrowUp: () => moveTo(addDaysYmd(cursor, -7)),
      ArrowDown: () => moveTo(addDaysYmd(cursor, 7)),
      PageUp: () => moveTo(addMonthsYmd(cursor, -1)),
      PageDown: () => moveTo(addMonthsYmd(cursor, 1)),
      Home: () => moveTo(addDaysYmd(cursor, -wd)),
      End: () => moveTo(addDaysYmd(cursor, 6 - wd)),
    };
    const fn = moves[e.key];
    if (!fn) return;
    e.preventDefault();
    fn();
  };

  return (
    <div className="cal">
      <div className="cal-head">
        <button type="button" className="icon-btn sm" aria-label={t('picker.prevMonth')} onClick={() => showMonth(-1)}>
          <IconChevronL size={14} />
        </button>
        <b aria-live="polite">{monthLabel(y, m)}</b>
        <button type="button" className="icon-btn sm" aria-label={t('picker.nextMonth')} onClick={() => showMonth(1)}>
          <IconChevronR size={14} />
        </button>
      </div>
      <div className="cal-grid" role="group" aria-label={monthLabel(y, m)} ref={gridRef} onKeyDown={onKey}>
        {[1, 2, 3, 4, 5, 6, 0].map((d) => (
          <span key={d} className="cal-wd" aria-hidden="true">
            {t(`weekdays.${d}`)}
          </span>
        ))}
        {cells.map((ymd) => {
          const wd = toDate(ymd).getUTCDay();
          const h = holidayOn(ymd);
          const holiday = h?.kind === 'off';
          const makeup = h?.kind === 'work';
          const off = (!!min && ymd < min) || (!!max && ymd > max);
          const cls = [
            'cal-day',
            ymd.slice(0, 7) !== month ? 'other' : '',
            (wd === 0 || wd === 6) && !makeup ? 'weekend' : '',
            holiday ? 'holiday' : '',
            makeup ? 'makeup' : '',
            ymd === today ? 'today' : '',
            ymd === value ? 'selected' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const tip = h ? `${h.name} · ${holiday ? t('picker.holiday') : t('picker.makeup')}` : undefined;
          return (
            <button
              key={ymd}
              type="button"
              data-ymd={ymd}
              className={cls}
              disabled={off}
              tabIndex={ymd === cursor ? 0 : -1}
              aria-pressed={ymd === value}
              aria-current={ymd === today ? 'date' : undefined}
              aria-label={shortDate(ymd) + (tip ? ` · ${tip}` : '')}
              title={tip}
              onClick={() => onPick(ymd)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (!off) onPick(ymd);
                }
              }}
            >
              {Number(ymd.slice(8, 10))}
              {(holiday || makeup) && (
                <i className={`hday ${holiday ? 'off' : 'work'}`} aria-hidden="true">
                  {holiday ? t('holidays.badgeOff') : t('holidays.badgeWork')}
                </i>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- 时间 ---------------- */

interface TimeFieldProps {
  id?: string;
  value: string; // HH:MM
  onChange: (hm: string) => void;
  className?: string;
  ariaLabel?: string;
}

// 面板里给的整点和半点：早 6 点到晚 9 点半（别的分钟直接在框里敲）
const SLOTS = Array.from({ length: 32 }, (_, i) => stepTime('06:00', i * 30));

/** 时间框：可以直接敲（16:30 / 1630），点一下弹出整点、半点的格子；↑ / ↓ 每次 15 分钟 */
export function TimeField({ id, value, onChange, className, ariaLabel }: TimeFieldProps) {
  const { t } = useTranslation();
  const { open, setOpen, offsetX, wrapRef, popRef } = usePopover();
  const listId = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const v = parseTime(draft);
    if (v && v !== value) onChange(v);
    setDraft(v ?? value);
  };
  const set = (v: string) => {
    setDraft(v);
    if (v !== value) onChange(v);
  };

  return (
    <div
      ref={wrapRef}
      className={`pfield tfield ${open ? 'open' : ''} ${className ?? ''}`}
      onBlur={(e) => {
        if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) {
          commit();
          setOpen(false);
        }
      }}
    >
      <input
        id={id}
        className="input pfield-input"
        value={draft}
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        maxLength={5}
        placeholder="--:--"
        aria-label={ariaLabel}
        role="combobox"
        aria-autocomplete="none"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
            setOpen(false);
          } else if (e.key === 'Escape' && open) {
            e.stopPropagation();
            e.preventDefault();
            setDraft(value);
            setOpen(false);
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            set(stepTime(parseTime(draft) ?? value, e.key === 'ArrowUp' ? 15 : -15));
          }
        }}
      />
      <IconClock size={16} className="pfield-ic" />
      {open && (
        <div ref={popRef} className="picker-pop time-pop" style={{ left: offsetX }} onMouseDown={keepFocus}>
          <div id={listId} className="time-list" role="listbox" aria-label={t('picker.chooseTime')}>
            {[
              { key: 'am', label: t('picker.am'), slots: SLOTS.filter((s) => s < '12:00') },
              { key: 'pm', label: t('picker.pm'), slots: SLOTS.filter((s) => s >= '12:00') },
            ].map((g) => (
              <div key={g.key} className="time-group" role="group" aria-label={g.label}>
                <span className="time-lbl" aria-hidden="true">
                  {g.label}
                </span>
                <div className="time-grid">
                  {g.slots.map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={s === value}
                      className={`time-slot ${s === value ? 'active' : ''}`}
                      onClick={() => {
                        set(s);
                        setOpen(false);
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <span className="hint-text">{t('picker.typeHint')}</span>
        </div>
      )}
    </div>
  );
}
