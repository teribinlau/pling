// 运行时配置（docs/架构.md §3）：同一份网页 / 桌面安装包可以连任何一家的服务器，连接信息不在构建时写死。
//   网页版：fetch('/config.json') → 没有就退回构建时的 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY → 都没有 = 演示模式
//          （离线打开 PWA 时用上次存下的那份，不会突然变成演示模式）
//   桌面版：第一次打开让用户填服务器地址（或粘贴邀请链接），取 <地址>/config.json 存本机；
//          以后每次启动刷新一次，离线用缓存；设置 → 关于 里可以换服务器
// main.tsx 先 await loadConfig()，再动态 import 其余代码（store 在模块初始化时就要建 repo）。
import { isTauri } from './tauri';

export interface PlingConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  /** 网页版地址，如 https://pling.example.cn（邀请链接、二维码用） */
  publicUrl: string;
  orgName: string;
  logins: { email: boolean; wechat: boolean; wechatMp: boolean; qq: boolean };
  notify: { wechatMp: boolean };
  /** 桌面版自动更新的 latest.json 地址；空 = 不检查更新 */
  updatesUrl: string;
}

/** server = 刚从服务器取到；cache = 离线用的缓存；env = 构建时的环境变量；demo = 演示模式 */
export type ConfigSource = 'server' | 'cache' | 'env' | 'demo';

export interface LoadedConfig extends PlingConfig {
  source: ConfigSource;
  demo: boolean;
  /** 桌面版：用户填的服务器地址（不带 /config.json）；网页版为空 */
  server: string;
  /** 桌面版第一次打开、还没选服务器（也没选演示）：显示「连接服务器」页 */
  needsServer: boolean;
}

const WEB_CACHE_KEY = 'pling-config-cache-v1';
const DESKTOP_KEY = 'pling-server-v1';
export const INVITE_KEY = 'pling-invite';

const DEMO_CONFIG: PlingConfig = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  publicUrl: '',
  orgName: '示例大学 · 计算机学院',
  // 演示模式不连服务器：登录页显示的是选身份；通知页的服务号部分照样能点（数据在内存里）
  logins: { email: false, wechat: false, wechatMp: false, qq: false },
  notify: { wechatMp: true },
  updatesUrl: '',
};

let loaded: LoadedConfig | null = null;

/** 已经加载好的配置；main.tsx 保证在别的模块用到之前加载完。没加载就当演示模式（单元测试里会这样） */
export function getConfig(): LoadedConfig {
  return loaded ?? { ...DEMO_CONFIG, source: 'demo', demo: true, server: '', needsServer: false };
}

/** 测试用：直接指定配置 */
export function setConfigForTest(c: LoadedConfig | null): void {
  loaded = c;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const bool = (v: unknown) => v === true;
const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** 校验并补全 config.json；缺 supabaseUrl / supabaseAnonKey 返回 null */
export function normalizeConfig(raw: unknown, fallbackPublicUrl = ''): PlingConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const supabaseUrl = trimSlash(str(o.supabaseUrl));
  const supabaseAnonKey = str(o.supabaseAnonKey);
  if (!/^https?:\/\//i.test(supabaseUrl) || !supabaseAnonKey) return null;
  const logins = (o.logins && typeof o.logins === 'object' ? o.logins : {}) as Record<string, unknown>;
  const notify = (o.notify && typeof o.notify === 'object' ? o.notify : {}) as Record<string, unknown>;
  return {
    supabaseUrl,
    supabaseAnonKey,
    publicUrl: trimSlash(str(o.publicUrl)) || trimSlash(fallbackPublicUrl),
    orgName: str(o.orgName),
    // 没写 email 的老配置：默认有邮箱登录（这是后备的登录方式）
    logins: { email: o.logins === undefined || logins.email === undefined ? true : bool(logins.email), wechat: bool(logins.wechat), wechatMp: bool(logins.wechatMp), qq: bool(logins.qq) },
    notify: { wechatMp: bool(notify.wechatMp) },
    updatesUrl: str(o.updatesUrl),
  };
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* 私密模式 */
  }
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { cache: 'no-store', signal: ctl.signal, headers: { Accept: 'application/json' } });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 桌面版：服务器地址
// ---------------------------------------------------------------------------

export interface DesktopServer {
  /** 用户填的地址整理后的样子：https://pling.example.cn */
  server: string;
  config: PlingConfig | null; // null = 选了「先看看演示」
  demo: boolean;
  savedAt: string;
}

export interface ParsedServerInput {
  /** 去掉 /config.json、查询串、#… 之后的地址，如 https://pling.example.cn */
  base: string;
  /** 粘贴的是邀请链接：里面的邀请码 */
  invite: string | null;
}

/** 用户输入的「pling.example.cn」「https://pling.example.cn/」「邀请链接」都整理成服务器地址；看不懂返回 null */
export function parseServerInput(input: string): ParsedServerInput | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!u.hostname || !(u.hostname.includes('.') || u.hostname === 'localhost')) return null;
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  // 只有本机开发能用 http，别的一律 https（微信 / QQ 登录也要求 https）
  const protocol = local ? u.protocol : 'https:';
  const invite = u.searchParams.get('invite');
  let path = u.pathname.replace(/\/config\.json$/i, '').replace(/\/index\.html$/i, '');
  path = trimSlash(path);
  return { base: `${protocol}//${u.host}${path}`, invite: invite ? invite.replace(/[^A-Za-z0-9]/g, '').toUpperCase() || null : null };
}

/** 桌面版取 config.json：走 Rust（网页的来源是 tauri://localhost，服务器不一定给 CORS 头）；网页里（测试）用 fetch */
async function fetchConfigText(url: string): Promise<string> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('fetch_server_config', { url });
  }
  const res = await fetchWithTimeout(url, 10000);
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.text();
}

export type ConnectError = 'bad_address' | 'unreachable' | 'not_pling';

/** 连接服务器：取 <base>/config.json 并校验。成功返回整理好的配置 */
export async function fetchServerConfig(base: string): Promise<{ ok: true; config: PlingConfig } | { ok: false; error: ConnectError; detail: string }> {
  let text: string;
  try {
    text = await fetchConfigText(`${base}/config.json`);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/bad_url/.test(msg)) return { ok: false, error: 'bad_address', detail: msg };
    if (/http_404|http_403/.test(msg)) return { ok: false, error: 'not_pling', detail: msg };
    return { ok: false, error: 'unreachable', detail: msg };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not_pling', detail: 'not json' };
  }
  const config = normalizeConfig(raw, base);
  return config ? { ok: true, config } : { ok: false, error: 'not_pling', detail: 'missing supabaseUrl / supabaseAnonKey' };
}

export function readDesktopServer(): DesktopServer | null {
  return readJson<DesktopServer>(DESKTOP_KEY);
}

export function saveDesktopServer(server: string, config: PlingConfig | null): void {
  writeJson(DESKTOP_KEY, { server, config, demo: !config, savedAt: new Date().toISOString() } satisfies DesktopServer);
}

/** 换服务器：忘掉现在这台（调用的地方负责退出登录、清缓存、重新加载页面） */
export function forgetDesktopServer(): void {
  try {
    localStorage.removeItem(DESKTOP_KEY);
  } catch {
    /* ignore */
  }
}

/** 邀请码先存本机，登录 / 激活之后再用 */
export function savePendingInvite(code: string): void {
  const c = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!c) return;
  try {
    localStorage.setItem(INVITE_KEY, c);
  } catch {
    /* ignore */
  }
}

export function readPendingInvite(): string | null {
  try {
    return localStorage.getItem(INVITE_KEY);
  } catch {
    return null;
  }
}

export function clearPendingInvite(): void {
  try {
    localStorage.removeItem(INVITE_KEY);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 加载
// ---------------------------------------------------------------------------

function fromEnv(): PlingConfig | null {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return normalizeConfig({ supabaseUrl: url, supabaseAnonKey: key, publicUrl: typeof location !== 'undefined' ? location.origin : '' });
}

function done(c: PlingConfig | null, source: ConfigSource, server = '', needsServer = false): LoadedConfig {
  loaded = c ? { ...c, source, demo: false, server, needsServer } : { ...DEMO_CONFIG, source: 'demo', demo: true, server, needsServer };
  return loaded;
}

async function loadWeb(): Promise<LoadedConfig> {
  const origin = location.origin;
  try {
    const res = await fetchWithTimeout('/config.json', 5000);
    // 没有这个文件时，单页应用的服务器会回 index.html（200, text/html），所以要真的解析一下
    if (res.ok) {
      const text = await res.text();
      let cfg: PlingConfig | null = null;
      try {
        cfg = normalizeConfig(JSON.parse(text), origin);
      } catch {
        cfg = null;
      }
      if (cfg) {
        writeJson(WEB_CACHE_KEY, cfg);
        return done(cfg, 'server');
      }
    }
    // 服务器明确没有 config.json：用构建时的变量；再没有就看看以前存过没有
    const env = fromEnv();
    if (env) return done(env, 'env');
    const cached = normalizeConfig(readJson(WEB_CACHE_KEY), origin);
    return cached ? done(cached, 'cache') : done(null, 'demo');
  } catch {
    // 断网 / 超时：用上次存下的，别一下子变成演示模式
    const cached = normalizeConfig(readJson(WEB_CACHE_KEY), origin);
    if (cached) return done(cached, 'cache');
    const env = fromEnv();
    return env ? done(env, 'env') : done(null, 'demo');
  }
}

async function loadDesktop(): Promise<LoadedConfig> {
  const saved = readDesktopServer();
  if (!saved) {
    // 构建时写了服务器（自己打包的定制版）就直接用，不用再问
    const env = fromEnv();
    return env ? done(env, 'env') : done(null, 'demo', '', true);
  }
  if (saved.demo || !saved.config) return done(null, 'demo', saved.server);
  // 每次启动刷新一次（管理员可能改了登录方式 / 更新地址）；连不上就用存着的
  const fresh = await Promise.race([
    fetchServerConfig(saved.server),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
  ]);
  if (fresh && fresh.ok) {
    saveDesktopServer(saved.server, fresh.config);
    return done(fresh.config, 'server', saved.server);
  }
  const cached = normalizeConfig(saved.config, saved.server);
  return cached ? done(cached, 'cache', saved.server) : done(null, 'demo', saved.server, true);
}

export async function loadConfig(): Promise<LoadedConfig> {
  if (loaded) return loaded;
  return isTauri() ? loadDesktop() : loadWeb();
}
