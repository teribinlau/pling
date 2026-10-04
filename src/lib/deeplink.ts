// 打开就定位到某条提醒的链接：服务号消息、群机器人消息里的链接是 `<publicUrl>/?r=<提醒 id>&o=<这一次到期的 ISO 时间>`；
// 邀请链接是 `<publicUrl>/?invite=<邀请码>`。启动时读一次，然后从地址栏里清掉（刷新页面不会再触发一次）。

export interface ReminderLink {
  reminderId: string;
  /** 规范成 Date#toISOString() 的样子，和 occurrenceKey 一致；没给 o = null（打开最近的一次） */
  occurrenceAt: string | null;
}

export interface StartupLinks {
  reminder: ReminderLink | null;
  invite: string | null;
}

export function parseStartupLinks(search: string): StartupLinks {
  const q = new URLSearchParams(search ?? '');
  const r = (q.get('r') ?? '').trim();
  const o = (q.get('o') ?? '').trim();
  let occurrenceAt: string | null = null;
  if (o) {
    const d = new Date(o.replace(' ', '+')); // + 在查询串里没编码会变成空格
    occurrenceAt = Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const inviteRaw = (q.get('invite') ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return {
    reminder: r && /^[A-Za-z0-9-]{1,64}$/.test(r) ? { reminderId: r, occurrenceAt } : null,
    invite: inviteRaw.length >= 6 && inviteRaw.length <= 12 ? inviteRaw : null,
  };
}

/** 去掉 r / o / invite，别的参数和 hash 留着 */
export function stripStartupParams(search: string): string {
  const q = new URLSearchParams(search ?? '');
  q.delete('r');
  q.delete('o');
  q.delete('invite');
  const s = q.toString();
  return s ? `?${s}` : '';
}
