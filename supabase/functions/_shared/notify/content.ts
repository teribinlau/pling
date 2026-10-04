// 推送的文字内容：服务号模板消息的各个值、群机器人的消息正文。时间都按机构时区（core 的 TZ，先 setTimeZone）。
import { localHm, localYmd } from '../core/recurrence.ts';
import type { NotifyStage } from '../core/types.ts';
import { clipChars } from './util.ts';

export const STAGE_LABEL: Record<NotifyStage, string> = { pre: '即将到期', due: '已到期', overdue: '已逾期' };

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 模板消息 time 字段的格式：2026年10月04日 08:30 */
export function templateTime(at: Date): string {
  const [y, m, d] = localYmd(at).split('-');
  return `${y}年${m}月${d}日 ${localHm(at)}`;
}

/** 群消息里的时间：10月9日 周五 17:00（不是今年的前面加年份） */
export function chatTime(at: Date, now: Date): string {
  const [y, m, d] = localYmd(at).split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const year = localYmd(now).slice(0, 4) === String(y) ? '' : `${y}年`;
  return `${year}${m}月${d}日 ${WEEKDAY[weekday]} ${localHm(at)}`;
}

/** 打开就是这一次到期的详情：{PUBLIC}/?r=<提醒 id>&o=<到期 ISO> */
export function reminderUrl(publicUrl: string, reminderId: string, at: Date): string {
  return publicUrl ? `${publicUrl}/?r=${reminderId}&o=${at.toISOString()}` : '';
}

/** 备注的第一行（空行跳过） */
export function firstLine(s: string): string {
  return s.split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? '';
}

/** 名单：最多列 max 个，多了后面写「等」 */
export function joinNames(names: string[], max = 40): string {
  return names.length > max ? `${names.slice(0, max).join('、')} 等` : names.join('、');
}

export interface ChatMessageInput {
  title: string;
  at: Date;
  now: Date;
  stage: NotifyStage;
  /** each 模式：还没完成的人（有指派时） */
  pending?: string[] | null;
  /** any 模式：直接指派到的人 */
  owners?: string[] | null;
  url: string;
}

/**
 * 群机器人的正文：
 *   【叮一下】交物理实验报告
 *   时间：10月9日 周五 17:00（已到期）
 *   还没完成：李四、王五、张三（共 3 人）
 *   查看：https://pling.example.cn/?r=…&o=…
 */
export function chatText(i: ChatMessageInput): string {
  const lines = [`【叮一下】${clipChars(i.title, 100, true)}`, `时间：${chatTime(i.at, i.now)}（${STAGE_LABEL[i.stage]}）`];
  if (i.pending?.length) lines.push(`还没完成：${joinNames(i.pending)}（共 ${i.pending.length} 人）`);
  else if (i.owners?.length) lines.push(`负责：${joinNames(i.owners)}`);
  if (i.url) lines.push(`查看：${i.url}`);
  return lines.join('\n');
}

export const WEBHOOK_TEST_TEXT = '【叮一下】测试消息：机器人配置成功';

/** 手机号整理成机器人 @ 用的格式：去掉空格 / 横线 / 括号和 +86 前缀；不像手机号的不要 */
export function normalizeMobile(phone: string): string | null {
  let s = phone.replace(/[\s\-()（）]/g, '');
  if (/^(\+86|0086)\d{11}$/.test(s)) s = s.slice(s.length - 11);
  return /^\+?\d{6,15}$/.test(s) ? s : null;
}
