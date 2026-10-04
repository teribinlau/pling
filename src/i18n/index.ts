import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from './zh-CN.json';

// 只有中文界面。zh-CN.json 里「小组」「全体」这两个词写成 {{team}} / {{org}}：
// 机构设置里改了称呼（班级 / 全校、部门 / 全公司……）就换掉默认变量，再发一个 labelsChanged 让界面重渲染。
export const DEFAULT_TEAM_LABEL = '小组';
export const DEFAULT_ORG_LABEL = '全体';

void i18n.use(initReactI18next).init({
  resources: { 'zh-CN': { translation: zhCN } },
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false, defaultVariables: { team: DEFAULT_TEAM_LABEL, org: DEFAULT_ORG_LABEL } },
  react: { bindI18n: 'languageChanged labelsChanged' },
});

if (typeof document !== 'undefined') document.documentElement.lang = 'zh-CN';

/** 换掉界面上的「小组」「全体」（机构设置加载 / 实时同步之后调用）；没变就什么都不做 */
export function setOrgLabels(team: string | null | undefined, org: string | null | undefined): void {
  const t = (team ?? '').trim() || DEFAULT_TEAM_LABEL;
  const o = (org ?? '').trim() || DEFAULT_ORG_LABEL;
  const iv = (i18n.options.interpolation ??= {});
  const cur = (iv.defaultVariables ?? {}) as Record<string, unknown>;
  if (cur.team === t && cur.org === o) return;
  iv.defaultVariables = { ...cur, team: t, org: o };
  i18n.emit('labelsChanged');
}

/** 现在的称呼（导出名单的表头之类不经过 t() 的地方用） */
export function orgLabels(): { team: string; org: string } {
  const cur = (i18n.options.interpolation?.defaultVariables ?? {}) as Record<string, string>;
  return { team: cur.team || DEFAULT_TEAM_LABEL, org: cur.org || DEFAULT_ORG_LABEL };
}

export default i18n;
