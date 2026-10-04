// 关联链接：reminders.link 里可以放多行，每行一个链接，可以带名称：
//   https://pan.example.edu.cn/s/xxx
//   报名表 https://forms.example.edu.cn/...
//   作业要求 | https://...
// 这里负责拆开 / 拼回去，数据库不用改。

export interface LinkItem {
  label: string; // 用户写的名称；没写就是空串
  url: string;
}

const URL_RE = /(https?:\/\/[^\s]+)/i;

export function parseLinks(text: string): LinkItem[] {
  const out: LinkItem[] = [];
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(URL_RE);
    if (m) {
      const url = m[1];
      const label = line
        .replace(url, '')
        .replace(/^[\s|:：—–-]+|[\s|:：—–-]+$/g, '')
        .trim();
      out.push({ label, url });
    } else if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(line)) {
      // 没写 https:// 的域名
      out.push({ label: '', url: 'https://' + line });
    } else {
      // 不像链接的行原样保留，避免用户内容丢失
      out.push({ label: line, url: '' });
    }
  }
  return out;
}

/** 链接的显示文字：有名称用名称，否则用「域名/路径开头」 */
export function linkTitle(l: LinkItem): string {
  if (l.label) return l.label;
  try {
    const u = new URL(l.url);
    const path = u.pathname === '/' ? '' : u.pathname;
    const s = u.host.replace(/^www\./, '') + path;
    return s.length > 40 ? s.slice(0, 38) + '…' : s;
  } catch {
    return l.url;
  }
}

export function hasLinks(text: string): boolean {
  return parseLinks(text).some((l) => l.url);
}
