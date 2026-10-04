// 运行时配置：config.json 校验、服务器地址整理、网页版的加载顺序；打开提醒 / 邀请链接的参数
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeConfig, parseServerInput, setConfigForTest } from '../../src/lib/config';
import { parseStartupLinks, stripStartupParams } from '../../src/lib/deeplink';

describe('config.json', () => {
  it('补全默认值、去掉末尾斜杠', () => {
    expect(normalizeConfig({ supabaseUrl: 'https://pling.example.cn/api/', supabaseAnonKey: 'k' }, 'https://pling.example.cn')).toEqual({
      supabaseUrl: 'https://pling.example.cn/api',
      supabaseAnonKey: 'k',
      publicUrl: 'https://pling.example.cn',
      orgName: '',
      logins: { email: true, wechat: false, wechatMp: false, qq: false },
      notify: { wechatMp: false },
      updatesUrl: '',
    });
  });
  it('按文档里的样子读全', () => {
    const c = normalizeConfig({
      supabaseUrl: 'https://pling.example.cn/api',
      supabaseAnonKey: 'eyJ',
      publicUrl: 'https://pling.example.cn',
      orgName: '某某中学',
      logins: { email: true, wechat: true, wechatMp: true, qq: false },
      notify: { wechatMp: true },
      updatesUrl: 'https://pling.example.cn/downloads/latest.json',
    });
    expect(c).toMatchObject({ orgName: '某某中学', logins: { email: true, wechat: true, wechatMp: true, qq: false }, notify: { wechatMp: true }, updatesUrl: 'https://pling.example.cn/downloads/latest.json' });
  });
  it('关掉邮箱登录要写 false', () => {
    expect(normalizeConfig({ supabaseUrl: 'https://a.cn/api', supabaseAnonKey: 'k', logins: { email: false, wechat: true } })?.logins.email).toBe(false);
  });
  it('缺地址 / key 就不是配置（比如单页应用把 /config.json 回成了 index.html）', () => {
    expect(normalizeConfig({})).toBeNull();
    expect(normalizeConfig({ supabaseUrl: 'pling.example.cn', supabaseAnonKey: 'k' })).toBeNull();
    expect(normalizeConfig('<!doctype html>')).toBeNull();
    expect(normalizeConfig(null)).toBeNull();
  });
});

describe('桌面版：服务器地址', () => {
  it('域名 / 完整地址 / 带 config.json / 邀请链接都行', () => {
    expect(parseServerInput('pling.example.cn')).toEqual({ base: 'https://pling.example.cn', invite: null });
    expect(parseServerInput(' https://pling.example.cn/ ')).toEqual({ base: 'https://pling.example.cn', invite: null });
    expect(parseServerInput('https://pling.example.cn/config.json')).toEqual({ base: 'https://pling.example.cn', invite: null });
    expect(parseServerInput('https://pling.example.cn/?invite=rj2301ab')).toEqual({ base: 'https://pling.example.cn', invite: 'RJ2301AB' });
    expect(parseServerInput('https://school.cn/pling/?invite=AB12CD')).toEqual({ base: 'https://school.cn/pling', invite: 'AB12CD' });
  });
  it('http 一律换成 https（本机开发除外）', () => {
    expect(parseServerInput('http://pling.example.cn')?.base).toBe('https://pling.example.cn');
    expect(parseServerInput('http://localhost:1420')?.base).toBe('http://localhost:1420');
  });
  it('看不懂的', () => {
    expect(parseServerInput('')).toBeNull();
    expect(parseServerInput('hello')).toBeNull();
    expect(parseServerInput('ftp://x.cn')).toBeNull();
  });
});

describe('网页版加载顺序', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
    setConfigForTest(null);
  });
  const stub = (fetchImpl: typeof fetch) => {
    const store = new Map<string, string>();
    vi.stubGlobal('location', { origin: 'https://pling.example.cn' });
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    vi.stubGlobal('fetch', fetchImpl);
    return store;
  };
  it('有 /config.json 就用它，并存一份', async () => {
    const store = stub(async () => new Response(JSON.stringify({ supabaseUrl: 'https://pling.example.cn/api', supabaseAnonKey: 'k', orgName: '某某中学' }), { status: 200 }));
    const { loadConfig } = await import('../../src/lib/config');
    const c = await loadConfig();
    expect(c).toMatchObject({ source: 'server', demo: false, orgName: '某某中学', publicUrl: 'https://pling.example.cn' });
    expect(store.get('pling-config-cache-v1')).toContain('某某中学');
  });
  it('没有 config.json（回的是 index.html）、也没有环境变量 → 演示模式', async () => {
    stub(async () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    const { loadConfig } = await import('../../src/lib/config');
    expect(await loadConfig()).toMatchObject({ source: 'demo', demo: true });
  });
  it('没有 config.json → 退回构建时的环境变量', async () => {
    stub(async () => new Response('not found', { status: 404 }));
    vi.stubEnv('VITE_SUPABASE_URL', 'https://dev.example.cn/api');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'devkey');
    const { loadConfig } = await import('../../src/lib/config');
    expect(await loadConfig()).toMatchObject({ source: 'env', supabaseUrl: 'https://dev.example.cn/api', logins: { email: true } });
  });
  it('断网：用上次存下的，不会突然变成演示模式', async () => {
    const store = stub(async () => {
      throw new TypeError('Failed to fetch');
    });
    store.set('pling-config-cache-v1', JSON.stringify({ supabaseUrl: 'https://pling.example.cn/api', supabaseAnonKey: 'k', orgName: '缓存的' }));
    const { loadConfig } = await import('../../src/lib/config');
    expect(await loadConfig()).toMatchObject({ source: 'cache', orgName: '缓存的' });
  });
});

describe('启动链接', () => {
  it('?r=&o= 打开某一次到期；+ 被当成空格也认', () => {
    expect(parseStartupLinks('?r=abc-123&o=2026-10-04T08:30:00.000Z')).toEqual({ reminder: { reminderId: 'abc-123', occurrenceAt: '2026-10-04T08:30:00.000Z' }, invite: null });
    expect(parseStartupLinks('?r=abc&o=2026-10-04T16:30:00 08:00').reminder?.occurrenceAt).toBe('2026-10-04T08:30:00.000Z');
    expect(parseStartupLinks('?r=abc').reminder).toEqual({ reminderId: 'abc', occurrenceAt: null });
    expect(parseStartupLinks('?r=abc&o=garbage').reminder?.occurrenceAt).toBeNull();
    expect(parseStartupLinks('?r=<script>').reminder).toBeNull();
  });
  it('?invite=', () => {
    expect(parseStartupLinks('?invite=rj2301ab').invite).toBe('RJ2301AB');
    expect(parseStartupLinks('?invite=RJ-2301-AB').invite).toBe('RJ2301AB');
    expect(parseStartupLinks('?invite=ab').invite).toBeNull();
  });
  it('用完从地址栏去掉，别的参数留着', () => {
    expect(stripStartupParams('?r=1&o=2')).toBe('');
    expect(stripStartupParams('?invite=X&utm=wx')).toBe('?utm=wx');
  });
});
