// 启动顺序：先拿到运行时配置（连哪台服务器 / 演示模式），再加载其余代码。
// store 在模块初始化时就要建 repo（SupabaseRepo 要用配置），所以 App / store 必须在 loadConfig() 之后才 import。
import './styles.css';
import './skins.css';
import { loadConfig } from './lib/config';

const SETTINGS_KEY = 'pling-settings-v1';

// 文件拖到没有接收区的地方松手：浏览器默认会直接打开这个文件（把整个应用换掉），拦下来
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

async function boot() {
  // 桌面版的置顶提醒小窗只显示主窗口发过来的一条提醒，不连服务器：不用等配置（等服务器回应会让小窗晚弹出来）
  const isAlert = window.location.hash.startsWith('#/alert');
  const config = isAlert ? null : await loadConfig();
  const [{ StrictMode, createElement }, { createRoot }, { applySkin }] = await Promise.all([import('react'), import('react-dom/client'), import('./lib/skins'), import('./i18n')]);

  // 皮肤在第一次渲染之前就挂上，免得先闪一下默认配色
  let skin: unknown;
  try {
    skin = (JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as { skin?: unknown }).skin;
  } catch {
    skin = undefined;
  }
  applySkin(skin);
  // 桌面版的置顶提醒小窗是另一个窗口：主窗口里换了皮肤，它通过 storage 事件跟着换
  window.addEventListener('storage', (e) => {
    if (e.key !== SETTINGS_KEY || !e.newValue) return;
    try {
      applySkin((JSON.parse(e.newValue) as { skin?: unknown }).skin);
    } catch {
      /* ignore */
    }
  });

  const root = createRoot(document.getElementById('root')!);
  if (isAlert) {
    const { AlertView } = await import('./views/AlertView');
    root.render(createElement(StrictMode, null, createElement(AlertView)));
    return;
  }
  if (config?.needsServer) {
    // 桌面版第一次打开：先选服务器（或者先看看演示），选好了整页重新加载
    const { ConnectView } = await import('./views/ConnectView');
    root.render(createElement(StrictMode, null, createElement(ConnectView)));
    return;
  }
  const [{ default: App }, { useStore }] = await Promise.all([import('./App'), import('./lib/store')]);
  useStore.subscribe((s, prev) => {
    if (s.settings.skin !== prev.settings.skin) applySkin(s.settings.skin);
  });
  root.render(createElement(StrictMode, null, createElement(App)));
}

void boot();
