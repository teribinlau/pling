// 皮肤：颜色 / 圆角 / 字体都是 CSS 变量（src/skins.css），这里只负责
//   1. 把 data-skin 挂到 <html> 上
//   2. 按需加载这套皮肤要的字体（从 npm 的 @fontsource 打包进来，只要拉丁子集；中文回落 Noto Sans SC）
//   3. 手机浏览器地址栏 / 状态栏的颜色跟着换
import type { Skin } from './types';

export interface SkinMeta {
  id: Skin;
  /** 设置页上显示的名字 */
  name: string;
  /** 来源（设置页小字） */
  source: string;
  /** 预览色块：页面底色 / 卡片 / 主色 / 强调色 */
  swatch: [string, string, string, string];
  /** 预览「Aa」用的字体 */
  previewFont: string;
  /** 圆角倍数，和 skins.css 里的 --rs 一致，预览卡片用 */
  rs: number;
}

export const SKINS: SkinMeta[] = [
  { id: 'default', name: '默认', source: '叮一下', swatch: ['#eeece7', '#f6f5f1', '#121212', '#e5322d'], previewFont: "'Archivo', sans-serif", rs: 1 },
  { id: 'opencode', name: 'opencode.ai', source: 'getdesign', swatch: ['#f8f7f7', '#fdfcfc', '#201d1d', '#007aff'], previewFont: "'JetBrains Mono', monospace", rs: 0.3 },
  { id: 'notion', name: 'Notion', source: 'getdesign', swatch: ['#f6f5f4', '#ffffff', '#191918', '#0075de'], previewFont: "'Inter', sans-serif", rs: 0.7 },
  { id: 'popcart', name: 'Popcart', source: 'Claude Design', swatch: ['#f7f8fa', '#ffffff', '#15181c', '#e4000f'], previewFont: "'Fredoka', sans-serif", rs: 1.4 },
];

// 默认皮肤的 Archivo 也打包进来（以前从 Google Fonts 拉，国内经常打不开）；中文一律用系统字体
void Promise.all([
  import('@fontsource/archivo/latin-500.css'),
  import('@fontsource/archivo/latin-700.css'),
  import('@fontsource/archivo/latin-800.css'),
  import('@fontsource/archivo/latin-900.css'),
]).catch(() => undefined);

const FONT_LOADERS: Partial<Record<Skin, () => Promise<unknown>>> = {
  opencode: () =>
    Promise.all([
      import('@fontsource/jetbrains-mono/latin-400.css'),
      import('@fontsource/jetbrains-mono/latin-500.css'),
      import('@fontsource/jetbrains-mono/latin-700.css'),
      import('@fontsource/jetbrains-mono/latin-800.css'),
    ]),
  notion: () =>
    Promise.all([
      import('@fontsource/inter/latin-400.css'),
      import('@fontsource/inter/latin-500.css'),
      import('@fontsource/inter/latin-700.css'),
      import('@fontsource/inter/latin-800.css'),
      import('@fontsource/inter/latin-900.css'),
    ]),
  popcart: () =>
    Promise.all([
      import('@fontsource/figtree/latin-400.css'),
      import('@fontsource/figtree/latin-500.css'),
      import('@fontsource/figtree/latin-700.css'),
      import('@fontsource/figtree/latin-800.css'),
      import('@fontsource/fredoka/latin-500.css'),
      import('@fontsource/fredoka/latin-600.css'),
      import('@fontsource/fredoka/latin-700.css'),
    ]),
};

/** 设置里存的值可能是旧版本 / 手改的，不认识就当默认皮肤 */
export function normalizeSkin(v: unknown): Skin {
  return SKINS.some((s) => s.id === v) ? (v as Skin) : 'default';
}

/** 字体都是本地文件（打包进应用），预览卡片要显示真字体，所以设置页打开时把全部皮肤的字体先加载了 */
export function preloadSkinFonts(): void {
  for (const load of Object.values(FONT_LOADERS)) void load?.().catch(() => undefined);
}

export function applySkin(value: unknown): void {
  const skin = normalizeSkin(value);
  const root = document.documentElement;
  if (skin === 'default') root.removeAttribute('data-skin');
  else root.setAttribute('data-skin', skin);
  void FONT_LOADERS[skin]?.().catch(() => undefined);
  // 手机上地址栏 / 状态栏的颜色
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (bg && meta) meta.setAttribute('content', bg);
}
