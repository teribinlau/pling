// 界面测试的公用工具
import { expect, type Page } from '@playwright/test';

export const SHOTS = process.env.PLING_SHOTS ?? '/tmp/claude-0/-home-claude/c91023f1-e699-5f15-8cb8-0a74a36fa2da/scratchpad/ui';

export type Who = 'admin' | 'member' | 'station' | 'newcomer';
const BUTTON: Record<Who, RegExp> = {
  admin: /王老师/,
  member: /李同学/,
  station: /实验室电脑/,
  newcomer: /新同学/,
};

/** 打开演示模式并以某个身份进入。query 可以带 ?invite= / ?r=&o= 这类启动参数 */
export async function enterDemo(page: Page, who: Who, opts: { query?: string; skin?: string } = {}): Promise<void> {
  if (opts.skin) {
    await page.addInitScript((skin) => {
      try {
        localStorage.setItem('pling-settings-v1', JSON.stringify({ skin }));
      } catch {
        /* ignore */
      }
    }, opts.skin);
  }
  await page.goto('/' + (opts.query ?? ''));
  await page.getByRole('button', { name: BUTTON[who] }).click();
  if (who === 'newcomer') await expect(page.getByText('先填一下你的真实姓名')).toBeVisible();
  else await expect(page.locator('.app')).toBeVisible();
}

/** 桌面宽度下换个人：左下角头像 → 账户 → 退出登录 → 登录页选另一个演示身份（演示数据在内存里，不刷新页面就还在） */
export async function switchUser(page: Page, who: Who): Promise<void> {
  await page.locator('.rail-me').click();
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.getByRole('button', { name: BUTTON[who] }).click();
  if (who === 'newcomer') await expect(page.getByText('先填一下你的真实姓名')).toBeVisible();
  else await expect(page.locator('.app')).toBeVisible();
}

/** 收集页面错误（console.error 里的 404 是 Vite 开发服务器找不到 /config.json，正常） */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

/** 让测试里的截图稳定：去掉动画、鼠标挪开、toast 藏起来（别 remove React 管的节点，会崩） */
export async function calm(page: Page, hideToasts = false): Promise<void> {
  await page.addStyleTag({ content: `*{animation:none!important;transition:none!important;caret-color:transparent!important}${hideToasts ? '.toasts{display:none!important}' : ''}` });
  await page.mouse.move(2, 2);
}

export async function openSettings(page: Page, tab: string): Promise<void> {
  const nav = page.locator('.settings nav');
  if (!(await nav.isVisible().catch(() => false))) {
    const isPhone = (page.viewportSize()?.width ?? 1440) <= 900;
    if (isPhone) await page.locator('.tabbar button', { hasText: '设置' }).click();
    else await page.locator('.rail .nav-btn[aria-label="设置"]').click();
  }
  await page.locator(`.settings nav button[data-tab="${tab}"]`).click();
}

/** 看板里点开一条提醒 */
export async function openReminder(page: Page, title: string | RegExp): Promise<void> {
  const isPhone = (page.viewportSize()?.width ?? 1440) <= 900;
  if (isPhone) await page.locator('.tabbar button', { hasText: '看板' }).click();
  else await page.locator('.rail .nav-btn[aria-label="看板"]').click();
  await page.locator('.card', { hasText: title }).first().click();
  await expect(page.locator('.detail h2')).toContainText(title);
}

/**
 * 布局扫描（DZF 记录里的扫描脚本思路）：
 *   1. 页面 / 主要容器不横向滚动
 *   2. 元素右边超出它的滚动容器（被裁掉）
 *   3. 文字被挤成竖条：宽 < 40、高 > 60 的文字元素（头像列 .side、二维码这类天生窄高的除外）
 */
export async function scanLayout(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const vw = document.documentElement.clientWidth;
    const desc = (el: Element) => {
      const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 3).join('.');
      const txt = (el.textContent ?? '').trim().slice(0, 24);
      return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}「${txt}」`;
    };
    if (document.documentElement.scrollWidth > vw + 1) problems.push(`页面横向滚动 ${document.documentElement.scrollWidth} > ${vw}`);
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const st = getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.01;
    };
    // 滚动容器自己横向溢出
    for (const sel of ['.main', '.scroll', '.detail', '.settings .pane', '.m-body', '.dlist-scroll', '.dt-scroll', '.sidebar', '.login .box']) {
      document.querySelectorAll(sel).forEach((el) => {
        if (!visible(el)) return;
        const st = getComputedStyle(el);
        if (st.overflowX === 'visible' || st.overflowX === 'hidden' || st.overflowX === 'clip') {
          if (el.scrollWidth > el.clientWidth + 2 && st.overflowX !== 'visible') problems.push(`${sel} 内容被裁 ${el.scrollWidth} > ${el.clientWidth}`);
        } else if (el.scrollWidth > el.clientWidth + 2) problems.push(`${sel} 横向滚动 ${el.scrollWidth} > ${el.clientWidth}`);
      });
    }
    // 竖条文字
    const skip = '.side, .avatar, .avatars, .hday, .dot, svg, img, .switch, .toggle, .cal-wd, .wd, .mini-month, .time-col, .pbar, .tab-ic, .badge, .udot, .check-sq, .brand-mark, .qq-ic, .acct-ic';
    document.querySelectorAll('body *').forEach((el) => {
      if (!(el instanceof HTMLElement) || el.closest(skip)) return;
      if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim().length >= 2)) return;
      if (!visible(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width < 40 && r.height > 60) problems.push(`竖排文字 ${Math.round(r.width)}×${Math.round(r.height)} ${desc(el)}`);
      if (r.right > vw + 1 && !el.closest('.toasts')) {
        // 祖先里有横向滚动的容器就不算（比如手机上的设置页签、看板的筛选条）
        let p: HTMLElement | null = el.parentElement;
        let scroller = false;
        while (p) {
          const ox = getComputedStyle(p).overflowX;
          if (ox === 'auto' || ox === 'scroll') {
            scroller = true;
            break;
          }
          p = p.parentElement;
        }
        if (!scroller) problems.push(`超出屏幕右边 ${Math.round(r.right)} > ${vw} ${desc(el)}`);
      }
    });
    return [...new Set(problems)].slice(0, 20);
  });
}
