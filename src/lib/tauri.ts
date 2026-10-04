// 桌面壳相关的调用都集中在这里，网页版下全部安全降级。
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export interface AlertPayload {
  key: string;
  reminderId: string;
  occurrenceAt: string;
  title: string;
  body: string;
  priority: 'low' | 'medium' | 'high';
  teamName: string;
  teamColor: string;
  timeLabel: string;
}

export async function showAlertWindow(payload: AlertPayload): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('show_alert', { payload });
}

/** 把主窗口从托盘里叫出来（置顶小窗点「查看」、或者需要上传文件时用） */
export async function showMainWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const w = await WebviewWindow.getByLabel('main');
    if (!w) return;
    await w.show();
    await w.unminimize();
    await w.setFocus();
  } catch {
    /* ignore */
  }
}

/** 在系统浏览器里打开链接（桌面壳用 opener 插件；网页版就是新标签页） */
export async function openExternal(url: string): Promise<void> {
  if (!url) return;
  if (isTauri()) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
      return;
    } catch {
      /* 插件不可用时退回 window.open */
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** 当前是不是 macOS 桌面壳（WKWebView 不会自己处理下载，打包下载按钮要藏起来） */
export async function isMacDesktop(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { platform } = await import('@tauri-apps/plugin-os');
    return platform() === 'macos';
  } catch {
    return false;
  }
}

export async function closeAlertWindow(): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('close_alert');
}

export async function sendSystemNotification(title: string, body: string): Promise<void> {
  if (isTauri()) {
    const n = await import('@tauri-apps/plugin-notification');
    let granted = await n.isPermissionGranted();
    if (!granted) granted = (await n.requestPermission()) === 'granted';
    if (granted) n.sendNotification({ title, body });
    return;
  }
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission === 'granted') new Notification(title, { body, icon: '/icon-192.png' });
}

export async function setAutostart(enabled: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    const a = await import('@tauri-apps/plugin-autostart');
    if (enabled) await a.enable();
    else await a.disable();
  } catch {
    /* 插件不可用时忽略 */
  }
}

// 自动更新分两步：先在后台把新版本下好（不打断正在干活的人），
// 等用户点「重启更新」时才真正安装 —— Windows 上安装会关掉应用。
// 更新地址是运行时的（服务器 config.json 里的 updatesUrl），插件的 JS check() 换不了地址，
// 所以走 src-tauri/src/lib.rs 里自己的两个命令（updater_builder().endpoints(...)）。
let pendingVersion: string | null = null;

/** 查有没有新版本并下载好；返回新版本号，没有新版本返回 null。可以反复调用。endpoint 空 = 不检查 */
export async function downloadUpdate(endpoint: string): Promise<string | null> {
  if (!isTauri() || !endpoint) return null;
  if (pendingVersion) return pendingVersion;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const info = await invoke<{ version: string } | null>('update_download', { endpoint });
    if (!info) return null;
    pendingVersion = info.version;
    return info.version;
  } catch (e) {
    /* 离线、清单里没有这个平台、签名对不上…… */
    console.warn('update check failed', e);
    return null;
  }
}

/** 安装已经下好的新版本并重启（Windows 上安装程序会先把应用关掉） */
export async function installUpdate(): Promise<void> {
  if (!pendingVersion) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('update_install');
}

export async function relaunchApp(): Promise<void> {
  if (!isTauri()) return;
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}

/** 监听置顶小窗发回的动作（完成 / 稍后 / 打开） */
export async function listenAlertActions(
  cb: (action: { type: 'complete' | 'snooze' | 'open'; key: string; reminderId: string; occurrenceAt: string; minutes?: number }) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  const un = await listen<{ type: 'complete' | 'snooze' | 'open'; key: string; reminderId: string; occurrenceAt: string; minutes?: number }>(
    'alert-action',
    (e) => cb(e.payload),
  );
  return un;
}

export async function emitAlertAction(action: {
  type: 'complete' | 'snooze' | 'open';
  key: string;
  reminderId: string;
  occurrenceAt: string;
  minutes?: number;
}): Promise<void> {
  if (!isTauri()) return;
  const { emit } = await import('@tauri-apps/api/event');
  await emit('alert-action', action);
}

export async function listenAlertPayload(cb: (p: AlertPayload) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<AlertPayload>('alert-payload', (e) => cb(e.payload));
}

export async function listenTrayCommands(cb: (cmd: 'mute-1h' | 'open') => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<'mute-1h' | 'open'>('tray-command', (e) => cb(e.payload));
}

export async function setTrayBadge(overdue: number): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_tray_badge', { overdue });
  } catch {
    /* ignore */
  }
}

/** 一段短促的提示音（WebAudio，不依赖音频文件） */
export function playChime(loud: boolean): void {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const gain = ctx.createGain();
    gain.gain.value = loud ? 0.35 : 0.18;
    gain.connect(ctx.destination);
    const notes = loud ? [880, 1174, 880, 1174] : [880, 1174];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.connect(gain);
      o.start(ctx.currentTime + i * 0.18);
      o.stop(ctx.currentTime + i * 0.18 + 0.16);
    });
    window.setTimeout(() => ctx.close(), 1500);
  } catch {
    /* 无音频设备 */
  }
}
