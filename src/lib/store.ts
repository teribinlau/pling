import { create } from 'zustand';
import type { InviteInput, Repo, Session, Snapshot, WebhookInput } from './repo';
import { SupabaseRepo, hasSupabaseConfig, MAX_UPLOAD_MB, type FileBucket } from './repo';
import { DemoRepo } from './demo';
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_NOTIFY_PREFS,
  DEFAULT_SETTINGS,
  setTimeZone,
  type AppSettings,
  type Assignee,
  type Attachment,
  type Completion,
  type DiscussionComment,
  type DiscussionFile,
  type DiscussionInput,
  type LoginProvider,
  type NotifyPrefs,
  type Occurrence,
  type Profile,
  type Reminder,
  type ReminderInput,
  type Settings,
  type Snooze,
  type Submission,
  type SubmissionStatus,
  type Team,
  type TeamMembership,
} from './types';
import { setHolidays, type Holiday } from './holidays';
import { normalizeSkin } from './skins';
import { shrinkImage } from './images';
import { readCache, readQueue, writeCache, writeQueue, type QueuedOp } from './cache';
import { downloadUpdate, installUpdate, isTauri, openExternal, setAutostart, showMainWindow } from './tauri';
import { buildOccurrences, canSee, occurrenceKey } from './occurrences';
import { ts } from './discussions';
import { audienceOf, hasValidHomework, isCompletionOf, personHomework, isSubmissionOf, uploadRequiredFor } from './homework';
import { getConfig, clearPendingInvite, readPendingInvite, savePendingInvite } from './config';
import { parseStartupLinks, stripStartupParams, type ReminderLink } from './deeplink';
import { finishWebLogin, LoginFailure, parseLoginHash, pollDesktopLogin, startWebLogin, stripLoginHash } from './login';
import { FnError, type WechatBindResponse } from './functions';
import i18n, { setOrgLabels } from '../i18n';

export type View = 'calendar' | 'board' | 'discussions' | 'settings';
export type DiscussionTab = 'open' | 'closed';
/** 新建 / 编辑讨论的弹窗 */
export type DiscussionModal = { mode: 'new' } | { mode: 'edit'; id: string };
export type Filter = 'all' | 'mine' | 'created' | `team:${string}`;
export type SettingsTab = 'general' | 'account' | 'notifications' | 'members' | 'invites' | 'bots' | 'org' | 'holidays' | 'about';

export interface Toast {
  id: string;
  title: string;
  body: string;
  kind: 'info' | 'error' | 'reminder';
  occurrenceKey?: string;
}

/** 微信 / QQ 登录（或加绑）进行到哪一步 */
export interface LoginFlow {
  phase: 'idle' | 'redirecting' | 'waiting' | 'finishing';
  provider: LoginProvider | null;
  link: boolean;
  /** 桌面版：授权页地址（「重新打开浏览器」用） */
  url?: string;
}

const SETTINGS_KEY = 'pling-settings-v1';
const OPEN_LINK_KEY = 'pling-open';

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const s = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
      return { ...s, skin: normalizeSkin(s.skin) };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS };
}

function makeRepo(): Repo {
  return hasSupabaseConfig() ? new SupabaseRepo() : new DemoRepo();
}

/** 看大图：一组图片 + 当前第几张（全局一层，安卓返回键先关它） */
export interface ViewerState {
  images: { bucket: FileBucket; path: string; name: string }[];
  index: number;
}

interface State extends Snapshot {
  repo: Repo;
  mode: 'supabase' | 'demo';
  session: Session | null;
  authReady: boolean;
  me: Profile | null;
  loaded: boolean;
  fromCache: boolean;
  online: boolean;
  lastSync: Date | null;
  error: string | null;
  settings: Settings;
  mutedUntil: Date | null;
  updateReady: string | null; // 新版本已经下载好，等用户点重启
  /** 登录页上显示的机构名（没登录之前从 config.json / app_settings 拿） */
  publicOrgName: string;
  loginFlow: LoginFlow;
  /** 登录失败的代码（登录页翻译成中文显示） */
  loginError: string | null;

  // UI
  view: View;
  filter: Filter;
  selectedKey: string | null;
  showNew: boolean;
  editReminderId: string | null;
  settingsTab: SettingsTab;
  toasts: Toast[];
  pendingComplete: Occurrence | null; // 共用设备：等待选择完成人
  pendingFiles: File[]; // 需要回传的提醒：选好的文件先放这里，等选完是谁再一起传
  uploading: boolean;
  /** 多个文件上传时的进度（按钮上显示「上传中 2/5」） */
  uploadProgress: { done: number; total: number } | null;
  viewer: ViewerState | null;
  calendarAnchor: Date; // 日历当前显示的起始日
  mobileDetailOpen: boolean;
  /** 讨论：当前打开的是哪个；列表看「进行中」还是「已结束」；新建 / 编辑弹窗 */
  discussionId: string | null;
  discussionTab: DiscussionTab;
  discussionModal: DiscussionModal | null;
  /** 从日历点开的讨论：关掉（× / 返回键）时回到日历，而不是停在讨论列表 */
  discussionReturn: View | null;

  // actions
  init(): Promise<void>;
  reload(): Promise<void>;
  signOut(): Promise<void>;
  setView(v: View): void;
  setFilter(f: Filter): void;
  select(key: string | null): void;
  /** 打开链接里的那一次到期（服务号 / 群机器人消息里的 ?r=&o=） */
  openReminderLink(link: ReminderLink): boolean;
  openNew(): void;
  openEdit(id: string): void;
  closeModal(): void;
  openViewer(v: ViewerState): void;
  closeViewer(): void;
  setSettingsTab(t: SettingsTab): void;
  setCalendarAnchor(d: Date): void;
  updateSettings(patch: Partial<Settings>): void;
  pushToast(t: Omit<Toast, 'id'>): void;
  dismissToast(id: string): void;
  muteFor(minutes: number): void;
  /** 后台查新版本并下好（桌面版才有；网页版、服务器没给更新地址时跳过） */
  checkUpdate(): Promise<string | null>;
  /** 安装下好的新版本并重启 */
  applyUpdate(): Promise<void>;

  // 登录、入门
  startOAuth(provider: LoginProvider, link?: boolean): Promise<void>;
  cancelOAuth(): void;
  reopenOAuth(): void;
  clearLoginError(): void;
  redeemInvite(code: string): Promise<boolean>;
  confirmName(name: string): Promise<boolean>;

  /** files = 新建时挂的附件（照片会先压到长边 2560px） */
  createReminder(input: ReminderInput, files?: File[]): Promise<void>;
  /** files = 新加的附件；removeAttachments = 编辑时点掉的旧附件（保存时才真的删） */
  updateReminder(id: string, input: ReminderInput, files?: File[], removeAttachments?: Attachment[]): Promise<void>;
  /** 逐个上传附件，返回没传上去的文件名（内部用） */
  attachFiles(reminderId: string, files: File[]): Promise<string[]>;
  deleteAttachment(a: Attachment): Promise<void>;
  deleteReminder(id: string): Promise<void>;
  /** 点「完成」：共用设备先选人；需要回传的提醒没交文件就先打开详情 */
  requestComplete(o: Occurrence, files?: File[]): void;
  /** 返回 true = 已完成（或断网已排队）；文件没传上去 / 还没交文件就是 false */
  complete(o: Occurrence, actorName?: string, files?: File[]): Promise<boolean>;
  uncomplete(o: Occurrence): Promise<void>;
  /** 只上传文件，不标记完成（已完成后再补一份也走这里） */
  uploadSubmission(o: Occurrence, files: File[], actorName?: string): Promise<boolean>;
  deleteSubmission(s: Submission): Promise<void>;
  snooze(o: Occurrence, minutes: number): Promise<void>;
  cancelPendingComplete(): void;
  /** 已读回执：看过这一次到期（共用设备账号不记；本机去重，重复写无害） */
  markRead(o: Occurrence): void;
  /** 批改：通过 / 退回某人这一次的作业；退回会同时撤掉他这一次的完成记录，让他重交 */
  reviewHomework(o: Occurrence, person: Profile, status: Exclude<SubmissionStatus, 'submitted'>, note: string): Promise<boolean>;

  // 讨论
  /** from = 从哪一页点进来的（日历）：关掉讨论时回到那一页 */
  openDiscussion(id: string | null, from?: View): void;
  setDiscussionTab(tab: DiscussionTab): void;
  openNewDiscussion(): void;
  openEditDiscussion(id: string): void;
  closeDiscussionModal(): void;
  /** files = 正文附件（照片先压到长边 2560px）；成功后直接打开这个讨论 */
  createDiscussion(input: DiscussionInput, files?: File[]): Promise<boolean>;
  updateDiscussion(id: string, input: DiscussionInput, files?: File[], removeFiles?: DiscussionFile[]): Promise<boolean>;
  /** 逐个上传正文附件，返回没传上去的文件名（内部用） */
  attachDiscussionFiles(discussionId: string, files: File[]): Promise<string[]>;
  deleteDiscussionFile(f: DiscussionFile): Promise<void>;
  /** 结束（只有发起人）：变只读，可带一句结论 */
  closeDiscussion(id: string, conclusion: string): Promise<boolean>;
  reopenDiscussion(id: string): Promise<void>;
  deleteDiscussion(id: string): Promise<void>;
  /** 发留言（可带附件）；返回 true = 发出去了，false = 没发出去（输入框里的内容保留） */
  postComment(discussionId: string, body: string, files: File[], authorName: string): Promise<boolean>;
  deleteComment(c: DiscussionComment, files: DiscussionFile[]): Promise<void>;
  /** 标记读到了 at（讨论的 last_activity_at） */
  markDiscussionRead(id: string, at: string): void;

  // 自己的资料、通知
  updateMyProfile(patch: Pick<Partial<Profile>, 'name' | 'phone'>): Promise<boolean>;
  saveNotifyPrefs(patch: Partial<Omit<NotifyPrefs, 'user_id'>>): Promise<void>;
  startWechatBind(): Promise<WechatBindResponse | null>;
  /** 绑定二维码显示期间轮询（实时订阅之外的兜底）；返回 true = 已经绑好 */
  pollWechatBinding(): Promise<boolean>;
  unbindWechat(): Promise<void>;
  testWechat(): Promise<void>;

  // 管理员
  adminUpdateProfile(id: string, patch: Partial<Profile>): Promise<void>;
  /** 设置某人的兼任小组（不含主小组） */
  adminSetMemberships(id: string, teamIds: string[]): Promise<void>;
  adminUpsertTeam(team: Partial<Team> & { name: string; color: string }): Promise<void>;
  adminDeleteTeam(id: string): Promise<void>;
  saveAppSettings(patch: Partial<AppSettings>): Promise<boolean>;
  addHolidayRange(rows: Holiday[]): Promise<boolean>;
  removeHolidays(days: string[]): Promise<void>;
  createInvite(input: InviteInput): Promise<string | null>;
  setInviteDisabled(code: string, disabled: boolean): Promise<void>;
  upsertWebhook(w: WebhookInput): Promise<boolean>;
  deleteWebhook(id: string): Promise<void>;
  testWebhook(id: string): Promise<void>;
}

let unsubscribeRealtime: (() => void) | null = null;
let pollAbort: AbortController | null = null;
/** 登录后的收尾（用邀请码、打开链接）每个账号只做一次：启动时 onAuthChange 和 getSession 可能同时进来 */
let afterLoginFor: string | null = null;
/** 正在兑换的邀请码：同一个码不同时兑两次（不然次数会算两遍） */
const redeeming = new Set<string>();
/** 这次会话里已经记过的已读（reminderId|ISO），不重复写 */
const readMarked = new Set<string>();

function errText(e: unknown): string {
  if (e instanceof FnError) {
    // 云函数没给中文说明时 message 就是英文代码（unauthorized / inactive / admin_only…）：按代码翻译
    if (!e.message || e.message === e.code || /^[\x20-\x7e]*$/.test(e.message)) return i18n.t(`fnErrors.${e.code}`, { defaultValue: e.message || e.code });
    return e.message;
  }
  return (e as Error)?.message ?? String(e);
}

function loginCode(e: unknown): string {
  if (e instanceof LoginFailure) return e.code;
  if (e instanceof FnError) return e.code === 'not_found' ? 'expired' : e.code;
  return 'network';
}

/** 机构设置 / 节假日 / 称呼：展开提醒、显示时间之前先换好 */
function applyOrg(snap: Pick<Snapshot, 'appSettings' | 'holidays'>): void {
  setTimeZone(snap.appSettings.timezone);
  setHolidays(snap.holidays);
  setOrgLabels(snap.appSettings.team_label, snap.appSettings.org_label);
}

function readOpenLink(): ReminderLink | null {
  try {
    const raw = sessionStorage.getItem(OPEN_LINK_KEY);
    return raw ? (JSON.parse(raw) as ReminderLink) : null;
  } catch {
    return null;
  }
}

function writeOpenLink(link: ReminderLink | null): void {
  try {
    if (link) sessionStorage.setItem(OPEN_LINK_KEY, JSON.stringify(link));
    else sessionStorage.removeItem(OPEN_LINK_KEY);
  } catch {
    /* ignore */
  }
}

const EMPTY_SNAPSHOT: Snapshot = {
  teams: [],
  profiles: [],
  reminders: [],
  assignees: [],
  completions: [],
  snoozes: [],
  submissions: [],
  memberships: [],
  attachments: [],
  discussions: [],
  discussionMembers: [],
  comments: [],
  discussionFiles: [],
  discussionReads: [],
  discussionsReady: true,
  appSettings: { ...DEFAULT_APP_SETTINGS },
  holidays: [],
  reads: [],
  notifyPrefs: null,
  wechatBinding: null,
  identities: [],
  invites: [],
  webhooks: [],
};

export const useStore = create<State>((set, get) => ({
  repo: makeRepo(),
  mode: hasSupabaseConfig() ? 'supabase' : 'demo',
  session: null,
  authReady: false,
  me: null,
  loaded: false,
  fromCache: false,
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  lastSync: null,
  error: null,
  settings: loadSettings(),
  mutedUntil: null,
  updateReady: null,
  publicOrgName: getConfig().orgName,
  loginFlow: { phase: 'idle', provider: null, link: false },
  loginError: null,
  ...EMPTY_SNAPSHOT,
  holidays: [],

  view: 'calendar',
  filter: 'all',
  selectedKey: null,
  showNew: false,
  editReminderId: null,
  settingsTab: 'general',
  toasts: [],
  pendingComplete: null,
  pendingFiles: [],
  uploading: false,
  uploadProgress: null,
  viewer: null,
  calendarAnchor: new Date(),
  mobileDetailOpen: false,
  discussionId: null,
  discussionTab: 'open',
  discussionModal: null,
  discussionReturn: null,

  async init() {
    const { repo, settings } = get();
    window.addEventListener('online', () => {
      set({ online: true });
      void get().reload();
    });
    window.addEventListener('offline', () => set({ online: false }));

    // 地址栏里的 ?invite= / ?r=&o=：先记下来，登录、加载完再用；然后从地址栏里清掉
    const links = parseStartupLinks(window.location.search);
    if (links.invite) savePendingInvite(links.invite);
    if (links.reminder) writeOpenLink(links.reminder);
    const hashLogin = parseLoginHash(window.location.hash);
    if (links.invite || links.reminder || hashLogin) {
      window.history.replaceState(window.history.state, '', window.location.pathname + stripStartupParams(window.location.search) + stripLoginHash(window.location.hash));
    }

    const applySession = async (s: Session | null) => {
      const prev = get().session;
      set({ session: s, authReady: true });
      if (s) {
        if (prev?.userId === s.userId && get().loaded) return; // token 刷新之类，不用重新加载
        if (prev && prev.userId !== s.userId) set({ ...EMPTY_SNAPSHOT, me: null, loaded: false });
        await get().reload();
        if (get().session?.userId !== s.userId) return;
        unsubscribeRealtime?.();
        unsubscribeRealtime = repo.subscribe(
          () => void get().reload(),
          (row) => {
            // 别人刚看了：只把这一行并进来（同一个人同一次到期已经有了就不动）
            const t = ts(row.occurrence_at);
            const have = get().reads.some((x) => x.reminder_id === row.reminder_id && x.user_id === row.user_id && Math.abs(ts(x.occurrence_at) - t) < 60000);
            if (!have) set({ reads: [...get().reads, row] });
          },
        );
        if (afterLoginFor !== s.userId && get().loaded) {
          afterLoginFor = s.userId;
          afterLogin();
        }
      } else {
        unsubscribeRealtime?.();
        unsubscribeRealtime = null;
        afterLoginFor = null;
        readMarked.clear();
        // 换个人登录要从头开始：别停在上一个人的设置页 / 筛选 / 打开的弹窗上
        set({
          ...EMPTY_SNAPSHOT,
          me: null,
          loaded: false,
          view: 'calendar',
          filter: 'all',
          settingsTab: 'general',
          selectedKey: null,
          showNew: false,
          editReminderId: null,
          pendingComplete: null,
          pendingFiles: [],
          viewer: null,
          discussionId: null,
          discussionModal: null,
          discussionReturn: null,
          mobileDetailOpen: false,
        });
      }
    };

    // 登录 / 加载完之后：用掉存着的邀请码，打开链接里的提醒
    const afterLogin = () => {
      const code = readPendingInvite();
      const me = get().me;
      if (code && me && !me.is_station) void get().redeemInvite(code);
      else if (code && me?.is_station) clearPendingInvite();
      const link = readOpenLink();
      if (link && get().me?.active) {
        writeOpenLink(null);
        if (!get().openReminderLink(link)) get().pushToast({ title: i18n.t('detail.notFound'), body: '', kind: 'error' });
      }
    };

    repo.onAuthChange((s) => void applySession(s));

    // 网页版从微信 / QQ 授权页回来：#pling-login=<id> → auth-finish → verifyOtp（会话变了 onAuthChange 会接着走）
    if (hashLogin && repo.mode === 'supabase') {
      set({ loginFlow: { phase: 'finishing', provider: null, link: false } });
      try {
        const r = await finishWebLogin(repo, sessionStorage, hashLogin);
        if (r.link) {
          set({ view: 'settings', settingsTab: 'account' });
          get().pushToast({ title: i18n.t('account.linked', { provider: i18n.t(`login.providerName.${r.provider ?? 'wechat_open'}`) }), body: '', kind: 'info' });
          void get().reload();
        }
      } catch (e) {
        set({ loginError: loginCode(e) });
      } finally {
        set({ loginFlow: { phase: 'idle', provider: null, link: false } });
      }
    }

    // 登录页的机构名：config.json 没写就问数据库（app_settings 这一行没登录也能读）
    if (!get().publicOrgName && repo.mode === 'supabase') {
      void (repo as SupabaseRepo).client
        .from('app_settings')
        .select('org_name')
        .eq('id', 1)
        .maybeSingle()
        .then(({ data }) => data?.org_name && !get().publicOrgName && set({ publicOrgName: data.org_name as string }), () => undefined);
    }

    const s = await repo.getSession();
    await applySession(s);
    if (settings.autostart) void setAutostart(true);
  },

  async reload() {
    const { repo, session } = get();
    if (!session) return;
    try {
      const snap = await repo.loadAll(session.userId);
      // 离线队列重放
      const queue = await readQueue();
      if (queue.length && get().online) {
        const remaining: QueuedOp[] = [];
        for (const op of queue) {
          try {
            if (op.kind === 'completion') await repo.addCompletion(op.payload as Omit<Completion, 'id' | 'completed_at'>);
            else await repo.setSnooze(op.payload as Omit<Snooze, 'id'>);
          } catch {
            remaining.push(op);
          }
        }
        await writeQueue(remaining);
      }
      if (get().session?.userId !== session.userId) return; // 加载期间换了账号 / 退出了
      const me = snap.profiles.find((p) => p.id === session.userId) ?? null;
      applyOrg(snap);
      // 打开着的讨论被删了 / 看不到了：关掉
      const did = get().discussionId;
      const gone = !!did && !snap.discussions.some((d) => d.id === did);
      set({ ...snap, me, loaded: true, fromCache: false, lastSync: new Date(), error: null, online: true, ...(gone ? { discussionId: null, discussionReturn: null } : {}) });
      void writeCache(snap);
    } catch (e) {
      const cached = await readCache();
      if (cached && !get().loaded) {
        const me = cached.snapshot.profiles.find((p) => p.id === session.userId) ?? null;
        applyOrg(cached.snapshot);
        set({ ...cached.snapshot, me, loaded: true, fromCache: true, lastSync: new Date(cached.savedAt) });
      }
      set({ error: errText(e), online: navigator.onLine });
    }
  },

  async signOut() {
    get().cancelOAuth();
    await get().repo.signOut();
  },

  setView(view) {
    set({ view, mobileDetailOpen: false, discussionReturn: null });
  },
  setFilter(filter) {
    set({ filter });
  },
  select(selectedKey) {
    // 从通知 / 提醒小窗点「查看」时可能正停在设置或讨论页：那里没有提醒详情，先切回日历
    const v = get().view;
    set({ selectedKey, mobileDetailOpen: !!selectedKey, ...(selectedKey && (v === 'settings' || v === 'discussions') ? { view: 'calendar' as View } : {}) });
  },
  openReminderLink(link) {
    const { reminders, completions, snoozes, submissions, session, me, assignees, memberships } = get();
    const r = reminders.find((x) => x.id === link.reminderId && !x.archived);
    if (!r || !session || !me || !canSee(r, assignees, me, memberships)) return false;
    // 找到链接说的那一次到期（展开一下，对上同一分钟）；没给时间 / 对不上就打开离现在最近的一次
    const target = link.occurrenceAt ? new Date(link.occurrenceAt) : new Date();
    const occs = buildOccurrences({
      reminders: [r],
      completions,
      snoozes,
      submissions,
      userId: session.userId,
      from: new Date(target.getTime() - 40 * 86400000),
      to: new Date(target.getTime() + 40 * 86400000),
    });
    if (!occs.length) return false;
    const best = occs.reduce((a, b) => (Math.abs(b.at.getTime() - target.getTime()) < Math.abs(a.at.getTime() - target.getTime()) ? b : a));
    set({ view: 'calendar', calendarAnchor: best.at, selectedKey: occurrenceKey(r.id, best.at), mobileDetailOpen: true, discussionId: null, showNew: false });
    return true;
  },
  openNew() {
    set({ showNew: true, editReminderId: null });
  },
  openEdit(id) {
    set({ showNew: true, editReminderId: id });
  },
  openViewer(viewer) {
    set({ viewer });
  },
  closeViewer() {
    set({ viewer: null });
  },
  closeModal() {
    set({ showNew: false, editReminderId: null });
  },
  setSettingsTab(settingsTab) {
    set({ settingsTab });
  },
  setCalendarAnchor(calendarAnchor) {
    set({ calendarAnchor });
  },
  updateSettings(patch) {
    const settings = { ...get().settings, ...patch };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
    set({ settings });
    if (patch.autostart !== undefined) void setAutostart(patch.autostart);
  },
  pushToast(t) {
    const id = Math.random().toString(36).slice(2);
    set({ toasts: [...get().toasts, { ...t, id }] });
    if (t.kind !== 'reminder') window.setTimeout(() => get().dismissToast(id), 6000);
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  muteFor(minutes) {
    set({ mutedUntil: new Date(Date.now() + minutes * 60000) });
  },

  async checkUpdate() {
    const v = await downloadUpdate(getConfig().updatesUrl);
    if (v) set({ updateReady: v });
    return v;
  },

  async applyUpdate() {
    await installUpdate();
  },

  // -------------------------------------------------------------------------
  // 登录、入门
  // -------------------------------------------------------------------------
  async startOAuth(provider, link = false) {
    const { repo } = get();
    if (repo.mode !== 'supabase') return;
    get().cancelOAuth();
    set({ loginError: null });
    try {
      if (isTauri()) {
        // 桌面版：系统浏览器里登录，这边每 2 秒问一次，最多 10 分钟
        const res = await repo.authStart({ provider, client: 'desktop', ...(link ? { link: true } : {}) });
        const ctl = new AbortController();
        pollAbort = ctl;
        set({ loginFlow: { phase: 'waiting', provider, link, url: res.url } });
        await openExternal(res.url);
        try {
          await pollDesktopLogin(repo, res.id, res.secret, { signal: ctl.signal, link });
          if (link) {
            get().pushToast({ title: i18n.t('account.linked', { provider: i18n.t(`login.providerName.${provider}`) }), body: '', kind: 'info' });
            void get().reload();
          }
          void showMainWindow();
        } finally {
          if (pollAbort === ctl) pollAbort = null;
        }
        set({ loginFlow: { phase: 'idle', provider: null, link: false } });
        return;
      }
      // 网页版：跳到授权页，回来时 init() 接着走
      set({ loginFlow: { phase: 'redirecting', provider, link } });
      const url = await startWebLogin(repo, sessionStorage, provider, { link });
      window.location.assign(url);
    } catch (e) {
      const code = loginCode(e);
      set({ loginFlow: { phase: 'idle', provider: null, link: false } });
      if (code === 'cancelled') return;
      if (link) get().pushToast({ title: i18n.t('account.linkFailed', { provider: i18n.t(`login.providerName.${provider}`) }), body: i18n.t(`login.errors.${code}`, { defaultValue: code, code }), kind: 'error' });
      else set({ loginError: code });
    }
  },
  cancelOAuth() {
    pollAbort?.abort();
    pollAbort = null;
    if (get().loginFlow.phase !== 'idle') set({ loginFlow: { phase: 'idle', provider: null, link: false } });
  },
  reopenOAuth() {
    const url = get().loginFlow.url;
    if (url) void openExternal(url);
  },
  clearLoginError() {
    set({ loginError: null });
  },

  async redeemInvite(code) {
    const c = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (!c || redeeming.has(c)) return false;
    redeeming.add(c);
    try {
      const res = await get().repo.redeemInvite(c);
      clearPendingInvite();
      if (!res.ok) {
        const reason = res.reason ?? 'unknown';
        get().pushToast({ title: i18n.t('invite.failedTitle'), body: i18n.t(`invite.reasons.${reason}`, { defaultValue: i18n.t('invite.reasons.unknown', { code: reason }) }), kind: 'error' });
        return false;
      }
      await get().reload();
      const team = res.team_id ? get().teams.find((t) => t.id === res.team_id) : undefined;
      const me = get().me;
      const title = !team ? i18n.t('invite.activated') : res.was_active && me?.team_id !== team.id ? i18n.t('invite.alsoJoined', { name: team.name }) : i18n.t('invite.joined', { name: team.name });
      get().pushToast({ title, body: '', kind: 'info' });
      return true;
    } catch (e) {
      get().pushToast({ title: i18n.t('invite.failedTitle'), body: errText(e), kind: 'error' });
      return false;
    } finally {
      redeeming.delete(c);
    }
  },

  async confirmName(name) {
    const { me, repo } = get();
    const n = name.trim();
    if (!me || !n) return false;
    try {
      await repo.updateProfile(me.id, { name: n.slice(0, 40), name_confirmed: true });
      set({ me: { ...me, name: n.slice(0, 40), name_confirmed: true } });
      await get().reload();
      // 填完姓名再看要不要用邀请码 / 打开链接（新用户第一次登录时这两步被姓名页挡着）
      const code = readPendingInvite();
      if (code && !get().me?.is_station) void get().redeemInvite(code);
      return true;
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
      return false;
    }
  },

  // -------------------------------------------------------------------------
  // 提醒
  // -------------------------------------------------------------------------
  async createReminder(input, files = []) {
    const { repo, session } = get();
    if (!session) return;
    if (files.length && (!get().online || !navigator.onLine)) {
      get().pushToast({ title: i18n.t('errors.needOnline'), body: '', kind: 'error' });
      return;
    }
    try {
      const id = await repo.createReminder(input, session.userId);
      const failed = await get().attachFiles(id, files);
      set({ showNew: false, editReminderId: null });
      await get().reload();
      if (failed.length) get().pushToast({ title: i18n.t('errors.attachFailed', { count: failed.length }), body: failed.join('、'), kind: 'error' });
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
    }
  },

  async updateReminder(id, input, files = [], removeAttachments = []) {
    if ((files.length || removeAttachments.length) && (!get().online || !navigator.onLine)) {
      get().pushToast({ title: i18n.t('errors.needOnline'), body: '', kind: 'error' });
      return;
    }
    try {
      const { repo } = get();
      await repo.updateReminder(id, input);
      for (const a of removeAttachments) await repo.removeAttachment(a);
      if (removeAttachments.length) {
        const gone = new Set(removeAttachments.map((a) => a.id));
        set({ attachments: get().attachments.filter((a) => !gone.has(a.id)) });
      }
      const failed = await get().attachFiles(id, files);
      set({ showNew: false, editReminderId: null });
      await get().reload();
      if (failed.length) get().pushToast({ title: i18n.t('errors.attachFailed', { count: failed.length }), body: failed.join('、'), kind: 'error' });
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
    }
  },

  async attachFiles(reminderId, files) {
    const { repo, session } = get();
    if (!files.length || !session) return [];
    const failed: string[] = [];
    set({ uploading: true, uploadProgress: { done: 0, total: files.length } });
    try {
      for (const [i, f] of files.entries()) {
        try {
          const ready = await shrinkImage(f);
          if (ready.size > MAX_UPLOAD_MB * 1024 * 1024) throw new Error(i18n.t('errors.tooLarge', { n: MAX_UPLOAD_MB }));
          const row = await repo.addAttachment(reminderId, session.userId, ready);
          set({ attachments: [...get().attachments, row] });
        } catch (e) {
          console.warn('attachment failed', f.name, e);
          failed.push(f.name);
        }
        set({ uploadProgress: { done: i + 1, total: files.length } });
      }
    } finally {
      set({ uploading: false, uploadProgress: null });
    }
    return failed;
  },

  async deleteAttachment(a) {
    try {
      await get().repo.removeAttachment(a);
      set({ attachments: get().attachments.filter((x) => x.id !== a.id) });
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
    }
  },

  async deleteReminder(id) {
    try {
      await get().repo.deleteReminder(id);
      set({ selectedKey: null, showNew: false, editReminderId: null });
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
    }
  },

  requestComplete(o, files) {
    const { me, session, assignees, profiles, teams, memberships } = get();
    if (!me || !session) return;
    // 需要回传文件：没带文件、也没交过（被退回的不算）→ 打开详情让他上传。布置作业的老师（不在受众里）不用交。
    // 共用设备没选人之前只能按「有没有任何人交过」粗判，选人后再严格判
    const mustUpload = uploadRequiredFor(o.reminder, me, audienceOf(o.reminder, assignees, profiles, teams, memberships));
    if (mustUpload && !files?.length && !hasValidHomework(o, me) && !(me.is_station && o.submissions.length)) {
      set({ selectedKey: o.key, mobileDetailOpen: true, view: get().view === 'settings' || get().view === 'discussions' ? 'calendar' : get().view });
      get().pushToast({ title: i18n.t('submit.needUploadToast'), body: o.reminder.title, kind: 'info' });
      void showMainWindow();
      return;
    }
    if (me.is_station) set({ pendingComplete: o, pendingFiles: files ?? [] });
    else void get().complete(o, undefined, files);
  },

  cancelPendingComplete() {
    set({ pendingComplete: null, pendingFiles: [] });
  },

  async uploadSubmission(o, files, actorName) {
    const { repo, session, online } = get();
    if (!session) return false;
    if (!online || !navigator.onLine) {
      get().pushToast({ title: i18n.t('errors.needOnline'), body: '', kind: 'error' });
      return false;
    }
    set({ uploading: true, uploadProgress: { done: 0, total: files.length } });
    try {
      // 照片先压到长边 2560px，压完再看有没有超 20 MB
      const ready: File[] = [];
      for (const f of files) ready.push(await shrinkImage(f));
      const big = ready.find((f) => f.size > MAX_UPLOAD_MB * 1024 * 1024);
      if (big) {
        get().pushToast({ title: i18n.t('errors.tooLarge', { n: MAX_UPLOAD_MB }), body: big.name, kind: 'error' });
        return false;
      }
      for (const [i, f] of ready.entries()) {
        const row = await repo.addSubmission(
          { reminder_id: o.reminder.id, occurrence_at: o.at.toISOString(), uploaded_by: session.userId, uploaded_by_name: actorName ?? '' },
          f,
        );
        set({ submissions: [...get().submissions, row], uploadProgress: { done: i + 1, total: ready.length } });
      }
      return true;
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.uploadFailed'), body: errText(e), kind: 'error' });
      return false;
    } finally {
      set({ uploading: false, uploadProgress: null });
    }
  },

  async deleteSubmission(sub) {
    try {
      await get().repo.removeSubmission(sub);
      set({ submissions: get().submissions.filter((x) => x.id !== sub.id) });
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
    }
  },

  async complete(o, actorName, files) {
    const { repo, session, online, me } = get();
    if (!session || !me) return false;
    set({ pendingComplete: null, pendingFiles: [] });
    // 带了文件就先传（任何提醒都可以附文件完成）；没传成功就不算完成
    if (files?.length) {
      const ok = await get().uploadSubmission(o, files, actorName);
      if (!ok) return false;
    } else if (o.reminder.require_upload) {
      // 需要回传：交作业的人（共用设备按所选的名字）得先有「算数」的文件；布置作业的老师不用交
      const st = get();
      const who = actorName ? { id: '', name: actorName } : me;
      const must = !!actorName || uploadRequiredFor(o.reminder, me, audienceOf(o.reminder, st.assignees, st.profiles, st.teams, st.memberships));
      const latest = st.submissions.filter((s) => s.reminder_id === o.reminder.id && Math.abs(ts(s.occurrence_at) - o.at.getTime()) < 60000);
      if (must && !hasValidHomework({ submissions: latest, at: o.at }, who)) {
        get().pushToast({ title: i18n.t('submit.needUploadToast'), body: o.reminder.title, kind: 'info' });
        set({ selectedKey: o.key, mobileDetailOpen: true });
        return false;
      }
    }
    const row: Omit<Completion, 'id' | 'completed_at'> = {
      reminder_id: o.reminder.id,
      occurrence_at: o.at.toISOString(),
      completed_by: session.userId,
      completed_by_name: actorName ?? '',
      note: '',
    };
    // 乐观更新
    set({
      completions: [...get().completions, { ...row, id: 'local-' + Math.random().toString(36).slice(2), completed_at: new Date().toISOString() }],
      toasts: get().toasts.filter((t) => t.occurrenceKey !== o.key),
    });
    try {
      await repo.addCompletion(row);
      await get().reload();
      return true;
    } catch (e) {
      if (!online || !navigator.onLine) {
        const q = await readQueue();
        q.push({ id: Math.random().toString(36).slice(2), kind: 'completion', payload: row, queuedAt: new Date().toISOString() });
        await writeQueue(q);
        get().pushToast({ title: i18n.t('offline.queued'), body: '', kind: 'info' });
        return true;
      } else {
        get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
        await get().reload();
        return false;
      }
    }
  },

  async uncomplete(o) {
    const c = o.completion;
    if (!c) return;
    try {
      await get().repo.removeCompletion(c.id);
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
    }
  },

  async snooze(o, minutes) {
    const { repo, session } = get();
    if (!session) return;
    const row: Omit<Snooze, 'id'> = {
      reminder_id: o.reminder.id,
      user_id: session.userId,
      occurrence_at: o.at.toISOString(),
      until: new Date(Date.now() + minutes * 60000).toISOString(),
    };
    set({ toasts: get().toasts.filter((t) => t.occurrenceKey !== o.key) });
    try {
      await repo.setSnooze(row);
      await get().reload();
    } catch {
      const q = await readQueue();
      q.push({ id: Math.random().toString(36).slice(2), kind: 'snooze', payload: row, queuedAt: new Date().toISOString() });
      await writeQueue(q);
      set({ snoozes: [...get().snoozes, { ...row, id: 'local-' + Math.random().toString(36).slice(2) }] });
    }
  },

  markRead(o) {
    const { me, session, repo, reads } = get();
    if (!me || !session || me.is_station || !me.active) return;
    const iso = o.at.toISOString();
    const k = `${o.reminder.id}|${iso}`;
    if (readMarked.has(k)) return;
    readMarked.add(k);
    if (reads.some((r) => r.reminder_id === o.reminder.id && r.user_id === me.id && Math.abs(ts(r.occurrence_at) - o.at.getTime()) < 60000)) return;
    // 先放进本地（自己马上就算已读），服务器的时间随后同步过来
    set({ reads: [...get().reads, { reminder_id: o.reminder.id, occurrence_at: iso, user_id: me.id, read_at: new Date().toISOString() }] });
    void repo.markRead(o.reminder.id, iso, me.id).catch((e) => {
      readMarked.delete(k);
      console.warn('mark read failed', e);
    });
  },

  async reviewHomework(o, person, status, note) {
    const { repo } = get();
    const mine = o.submissions.filter((s) => isSubmissionOf(s, person));
    const hw = personHomework(mine, o.at);
    const ids = hw.current.map((s) => s.id);
    if (!ids.length) return false;
    try {
      await repo.reviewSubmissions(ids, status, note.trim());
      if (status === 'returned') {
        // 退回重交：撤掉他这一次的「已完成」，他那边会重新变成待交
        for (const c of o.completions.filter((x) => isCompletionOf(x, person))) await repo.removeCompletion(c.id);
      }
      await get().reload();
      return true;
    } catch (e) {
      get().pushToast({ title: i18n.t('homework.reviewFailed'), body: errText(e), kind: 'error' });
      await get().reload();
      return false;
    }
  },

  // -------------------------------------------------------------------------
  // 讨论
  // -------------------------------------------------------------------------
  openDiscussion(id, from) {
    if (id) {
      set({ discussionId: id, view: 'discussions', discussionReturn: from && from !== 'discussions' ? from : null, mobileDetailOpen: false });
      return;
    }
    const back = get().view === 'discussions' ? get().discussionReturn : null;
    set({ discussionId: null, discussionReturn: null, ...(back ? { view: back } : {}) });
  },
  setDiscussionTab(discussionTab) {
    set({ discussionTab });
  },
  openNewDiscussion() {
    set({ discussionModal: { mode: 'new' } });
  },
  openEditDiscussion(id) {
    set({ discussionModal: { mode: 'edit', id } });
  },
  closeDiscussionModal() {
    set({ discussionModal: null });
  },

  async createDiscussion(input, files = []) {
    const { repo, session } = get();
    if (!session) return false;
    if (!get().online || !navigator.onLine) {
      get().pushToast({ title: i18n.t('discuss.needOnline'), body: '', kind: 'error' });
      return false;
    }
    try {
      const id = await repo.createDiscussion(input, session.userId);
      const failed = await get().attachDiscussionFiles(id, files);
      await get().reload();
      set({ discussionModal: null, discussionId: id, discussionTab: 'open', view: 'discussions' });
      if (failed.length) get().pushToast({ title: i18n.t('errors.attachFailed', { count: failed.length }), body: failed.join('、'), kind: 'error' });
      return true;
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
      return false;
    }
  },

  async updateDiscussion(id, input, files = [], removeFiles = []) {
    if (!get().online || !navigator.onLine) {
      get().pushToast({ title: i18n.t('discuss.needOnline'), body: '', kind: 'error' });
      return false;
    }
    try {
      const { repo } = get();
      await repo.updateDiscussion(id, input);
      for (const f of removeFiles) await repo.removeDiscussionFile(f);
      if (removeFiles.length) {
        const gone = new Set(removeFiles.map((f) => f.id));
        set({ discussionFiles: get().discussionFiles.filter((f) => !gone.has(f.id)) });
      }
      const failed = await get().attachDiscussionFiles(id, files);
      set({ discussionModal: null });
      await get().reload();
      if (failed.length) get().pushToast({ title: i18n.t('errors.attachFailed', { count: failed.length }), body: failed.join('、'), kind: 'error' });
      return true;
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
      return false;
    }
  },

  async attachDiscussionFiles(discussionId, files) {
    const { repo, session } = get();
    if (!files.length || !session) return [];
    const failed: string[] = [];
    set({ uploading: true, uploadProgress: { done: 0, total: files.length } });
    try {
      for (const [i, f] of files.entries()) {
        try {
          const ready = await shrinkImage(f);
          if (ready.size > MAX_UPLOAD_MB * 1024 * 1024) throw new Error(i18n.t('errors.tooLarge', { n: MAX_UPLOAD_MB }));
          const row = await repo.addDiscussionFile(discussionId, session.userId, ready);
          set({ discussionFiles: [...get().discussionFiles, row] });
        } catch (e) {
          console.warn('discussion file failed', f.name, e);
          failed.push(f.name);
        }
        set({ uploadProgress: { done: i + 1, total: files.length } });
      }
    } finally {
      set({ uploading: false, uploadProgress: null });
    }
    return failed;
  },

  async deleteDiscussionFile(f) {
    try {
      await get().repo.removeDiscussionFile(f);
      set({ discussionFiles: get().discussionFiles.filter((x) => x.id !== f.id) });
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
    }
  },

  async closeDiscussion(id, conclusion) {
    try {
      await get().repo.setDiscussionClosed(id, true, conclusion.trim());
      await get().reload();
      return true;
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
      return false;
    }
  },

  async reopenDiscussion(id) {
    try {
      await get().repo.setDiscussionClosed(id, false);
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
    }
  },

  async deleteDiscussion(id) {
    try {
      await get().repo.deleteDiscussion(id);
      set({ discussionModal: null });
      // 删的是正开着的这个：和点 × 一样关掉（从日历点进来的回到日历）
      if (get().discussionId === id) get().openDiscussion(null);
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
    }
  },

  async postComment(discussionId, body, files, authorName) {
    const { repo, session } = get();
    if (!session) return false;
    if (!get().online || !navigator.onLine) {
      get().pushToast({ title: i18n.t('discuss.needOnline'), body: '', kind: 'error' });
      return false;
    }
    set({ uploading: true, uploadProgress: files.length ? { done: 0, total: files.length } : null });
    try {
      // 照片先压到长边 2560px，压完再看有没有超 20 MB
      const ready: File[] = [];
      for (const f of files) ready.push(await shrinkImage(f));
      const big = ready.find((f) => f.size > MAX_UPLOAD_MB * 1024 * 1024);
      if (big) {
        get().pushToast({ title: i18n.t('errors.tooLarge', { n: MAX_UPLOAD_MB }), body: big.name, kind: 'error' });
        return false;
      }
      const res = await repo.addComment(
        { discussion_id: discussionId, author_id: session.userId, author_name: authorName, body: body.trim() },
        ready,
        (done) => set({ uploadProgress: { done, total: ready.length } }),
      );
      // 先放进本地，马上就能看到自己这条（服务器的数据随后同步过来）
      set({
        comments: [...get().comments, res.comment],
        discussionFiles: [...get().discussionFiles, ...res.files],
        discussions: get().discussions.map((d) =>
          d.id === discussionId ? { ...d, comment_count: d.comment_count + 1, last_activity_at: res.comment.created_at, last_activity_by: session.userId } : d,
        ),
      });
      get().markDiscussionRead(discussionId, res.comment.created_at);
      void get().reload();
      return true;
    } catch (e) {
      get().pushToast({ title: i18n.t('discuss.sendFailed'), body: errText(e), kind: 'error' });
      return false;
    } finally {
      set({ uploading: false, uploadProgress: null });
    }
  },

  async deleteComment(c, files) {
    try {
      await get().repo.removeComment(c, files);
      set({ comments: get().comments.filter((x) => x.id !== c.id), discussionFiles: get().discussionFiles.filter((x) => x.comment_id !== c.id) });
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
    }
  },

  markDiscussionRead(id, at) {
    const { session, repo } = get();
    if (!session || !at) return;
    const cur = get().discussionReads.find((r) => r.discussion_id === id && r.user_id === session.userId);
    if (cur && ts(cur.last_read_at) >= ts(at)) return;
    set({
      discussionReads: [
        ...get().discussionReads.filter((r) => !(r.discussion_id === id && r.user_id === session.userId)),
        { discussion_id: id, user_id: session.userId, last_read_at: at },
      ],
    });
    // 已读位置丢了也不要紧（下次打开再标），不打扰用户
    void repo.markDiscussionRead(id, session.userId, at).catch((e) => console.warn('mark read failed', e));
  },

  // -------------------------------------------------------------------------
  // 自己的资料、通知
  // -------------------------------------------------------------------------
  async updateMyProfile(patch) {
    const { me, repo } = get();
    if (!me) return false;
    try {
      await repo.updateProfile(me.id, patch);
      set({ me: { ...me, ...patch } });
      await get().reload();
      return true;
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
      return false;
    }
  },

  async saveNotifyPrefs(patch) {
    const { me, repo, notifyPrefs } = get();
    if (!me) return;
    const next: NotifyPrefs = { ...DEFAULT_NOTIFY_PREFS, ...(notifyPrefs ?? {}), ...patch, user_id: me.id };
    set({ notifyPrefs: next });
    try {
      await repo.saveNotifyPrefs(next);
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
      await get().reload();
    }
  },

  async startWechatBind() {
    try {
      return await get().repo.wechatBind();
    } catch (e) {
      get().pushToast({ title: i18n.t('wechat.bindFailed'), body: errText(e), kind: 'error' });
      return null;
    }
  },

  async pollWechatBinding() {
    const before = get().wechatBinding;
    await get().reload();
    const after = get().wechatBinding;
    return !!after && after.subscribed && (!before || before.bound_at !== after.bound_at || !before.subscribed);
  },

  async unbindWechat() {
    const { me, repo } = get();
    if (!me) return;
    try {
      await repo.unbindWechat(me.id);
      set({ wechatBinding: null });
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
    }
  },

  async testWechat() {
    try {
      const r = await get().repo.notifyTest({ wechat: true });
      if (r.ok) get().pushToast({ title: i18n.t('wechat.testOk'), body: '', kind: 'info' });
      else get().pushToast({ title: i18n.t('wechat.testFailed', { error: r.error ?? '' }), body: '', kind: 'error' });
    } catch (e) {
      get().pushToast({ title: i18n.t('wechat.testFailed', { error: errText(e) }), body: '', kind: 'error' });
    }
  },

  // -------------------------------------------------------------------------
  // 管理员
  // -------------------------------------------------------------------------
  async adminUpdateProfile(id, patch) {
    try {
      await get().repo.updateProfile(id, patch);
      // 主小组改成了原来的兼任小组 → 从兼任里去掉，免得重复
      if (patch.team_id) {
        const extras = get().memberships.filter((m) => m.profile_id === id).map((m) => m.team_id);
        if (extras.includes(patch.team_id)) {
          await get().repo.setMemberships(id, extras.filter((t) => t !== patch.team_id));
        }
      }
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
    }
  },
  async adminSetMemberships(id, teamIds) {
    try {
      await get().repo.setMemberships(id, teamIds);
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
    }
  },
  async adminUpsertTeam(team) {
    try {
      await get().repo.upsertTeam(team);
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
    }
  },
  async adminDeleteTeam(id) {
    try {
      await get().repo.deleteTeam(id);
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
    }
  },

  async saveAppSettings(patch) {
    try {
      await get().repo.updateAppSettings(patch);
      const appSettings = { ...get().appSettings, ...patch };
      applyOrg({ appSettings, holidays: get().holidays });
      set({ appSettings });
      await get().reload();
      return true;
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
      return false;
    }
  },
  async addHolidayRange(rows) {
    try {
      await get().repo.addHolidays(rows);
      await get().reload();
      return true;
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
      return false;
    }
  },
  async removeHolidays(days) {
    try {
      await get().repo.removeHolidays(days);
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
    }
  },

  async createInvite(input) {
    const { me, repo } = get();
    if (!me) return null;
    try {
      const inv = await repo.createInvite(input, me.id);
      set({ invites: [inv, ...get().invites.filter((x) => x.code !== inv.code)] });
      void get().reload();
      return inv.code;
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
      return null;
    }
  },
  async setInviteDisabled(code, disabled) {
    try {
      await get().repo.setInviteDisabled(code, disabled);
      set({ invites: get().invites.map((x) => (x.code === code ? { ...x, disabled } : x)) });
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
    }
  },
  async upsertWebhook(w) {
    try {
      await get().repo.upsertWebhook(w);
      await get().reload();
      return true;
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
      return false;
    }
  },
  async deleteWebhook(id) {
    try {
      await get().repo.deleteWebhook(id);
      await get().reload();
    } catch (e) {
      get().pushToast({ title: i18n.t('errors.saveFailed'), body: errText(e), kind: 'error' });
    }
  },
  async testWebhook(id) {
    try {
      const r = await get().repo.notifyTest({ webhookId: id });
      if (r.ok) get().pushToast({ title: i18n.t('bots.testOk'), body: '', kind: 'info' });
      else get().pushToast({ title: i18n.t('bots.testFailed', { error: r.error ?? '' }), body: '', kind: 'error' });
    } catch (e) {
      get().pushToast({ title: i18n.t('bots.testFailed', { error: errText(e) }), body: '', kind: 'error' });
    }
    await get().reload();
  },
}));

/** 我现在的通知设置（数据库里没有这一行 = 默认值） */
export function effectiveNotifyPrefs(p: NotifyPrefs | null, userId: string): NotifyPrefs {
  return { ...DEFAULT_NOTIFY_PREFS, ...(p ?? {}), user_id: userId };
}

export type { Assignee, Reminder, TeamMembership };
