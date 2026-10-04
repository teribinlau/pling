import { createClient, type EmailOtpType, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AppSettings,
  Assignee,
  Attachment,
  Completion,
  Discussion,
  DiscussionComment,
  DiscussionFile,
  DiscussionInput,
  DiscussionMember,
  DiscussionRead,
  LoginIdentity,
  NotifyPrefs,
  Profile,
  Reminder,
  ReminderInput,
  ReminderRead,
  Snooze,
  Submission,
  SubmissionStatus,
  Team,
  TeamInvite,
  TeamMembership,
  TeamWebhook,
  WechatBinding,
} from './types';
import { DEFAULT_APP_SETTINGS, TZ } from './types';
import type { Holiday } from './holidays';
import { getConfig } from './config';
import {
  fnErrorFrom,
  type AuthFinishResponse,
  type AuthStartRequest,
  type AuthStartResponse,
  type NotifyTestResponse,
  type PlingFunction,
  type WechatBindResponse,
} from './functions';

export interface Session {
  userId: string;
  email: string;
}

export interface Snapshot {
  teams: Team[];
  profiles: Profile[];
  reminders: Reminder[];
  assignees: Assignee[];
  completions: Completion[];
  snoozes: Snooze[];
  submissions: Submission[];
  memberships: TeamMembership[]; // 兼任小组
  attachments: Attachment[]; // 创建人挂的附件
  // 讨论：留言只加载最近 DISCUSSION_WINDOW_DAYS 天的，更早的在打开讨论时按需加载
  discussions: Discussion[];
  discussionMembers: DiscussionMember[];
  comments: DiscussionComment[];
  discussionFiles: DiscussionFile[]; // 正文附件全部 + 窗口内留言的附件
  discussionReads: DiscussionRead[]; // 我的已读位置
  /** false = 数据库里还没有讨论的表 */
  discussionsReady: boolean;
  /** 机构设置（机构名、「小组」「全体」的叫法、时区、逾期推送次数） */
  appSettings: AppSettings;
  /** 节假日：off 放假 / work 调休上班 */
  holidays: Holiday[];
  /** 已读回执（近 60 天）：自己的 + 我创建的提醒的（管理员是全部） */
  reads: ReminderRead[];
  /** 我的通知设置；null = 还没存过，用默认值 */
  notifyPrefs: NotifyPrefs | null;
  /** 我的服务号绑定 */
  wechatBinding: WechatBinding | null;
  /** 微信 / QQ 身份：自己的；管理员是全部（成员列表显示登录方式） */
  identities: LoginIdentity[];
  /** 邀请码（只有管理员拿得到） */
  invites: TeamInvite[];
  /** 群机器人（只有管理员拿得到） */
  webhooks: TeamWebhook[];
}

/** 三个私有桶：成员交的文件 / 创建人挂的附件 / 讨论里的文件 */
export type FileBucket = 'submissions' | 'attachments' | 'discussions';

/** 留言只自动加载最近这么多天的 */
export const DISCUSSION_WINDOW_DAYS = 120;
/** 完成记录 / 回传文件 / 已读只加载最近这么多天的 */
export const RECENT_DAYS = 60;

/** 发一条留言要登记的内容（文件本体单独传） */
export type CommentDraft = Pick<DiscussionComment, 'discussion_id' | 'author_id' | 'author_name' | 'body'>;

/** 上传回传文件时的元数据（文件本体单独传；状态 / 批语由服务器定） */
export type SubmissionMeta = Pick<Submission, 'reminder_id' | 'occurrence_at' | 'uploaded_by' | 'uploaded_by_name'>;

/** 新建邀请码（码由客户端随机生成） */
export interface InviteInput {
  team_id: string | null;
  note: string;
  expires_at: string | null;
  max_uses: number | null;
}

/** 新建 / 改群机器人 */
export type WebhookInput = Pick<TeamWebhook, 'team_id' | 'kind' | 'name' | 'url' | 'secret' | 'stages' | 'enabled'> & { id?: string };

/** redeem_invite() 的结果 */
export interface RedeemResult {
  ok: boolean;
  reason?: 'not_signed_in' | 'not_found' | 'disabled' | 'expired' | 'used_up' | 'no_profile' | 'station' | string;
  team_id?: string | null;
  was_active?: boolean;
}

export const MAX_UPLOAD_MB = 20;

/** 微信 / QQ 登录的账号，邮箱是内部用的假地址（@login.pling.invalid），不显示 */
export function displayEmail(email: string | null | undefined): string {
  return email && !/@login\.pling\.invalid$/i.test(email) ? email : '';
}

/** Storage 对象名：时间 + 随机串 + 原扩展名（原始文件名可能有中文 / 空格，存在表里） */
function objectName(fileName: string): string {
  const ext = (fileName.match(/\.([a-z0-9]{1,8})$/i)?.[1] ?? 'bin').toLowerCase();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
}

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉 I O 0 1，念 / 抄的时候不会弄混

export function randomInviteCode(len = 8): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join('');
}

export interface Repo {
  mode: 'supabase' | 'demo';
  getSession(): Promise<Session | null>;
  onAuthChange(cb: (s: Session | null) => void): () => void;
  signInWithEmail(email: string): Promise<void>;
  /** 输入邮件里的 6 位验证码登录（桌面端用，不需要跳转浏览器） */
  verifyEmailCode(email: string, code: string): Promise<void>;
  /** 演示模式：直接以某个示例用户身份进入 */
  signInDemo?(userId: string): Promise<void>;
  signOut(): Promise<void>;
  loadAll(userId: string): Promise<Snapshot>;
  /**
   * 实时订阅：别人改了数据就调 onChange（去抖后重新 loadAll）。
   * onRead 给了的话，新增的已读回执直接交给它合并（不为每一条「谁看了一眼」把 20 多张表重新拉一遍）；没给就也走 onChange。
   */
  subscribe(onChange: () => void, onRead?: (row: ReminderRead) => void): () => void;

  // ---- 微信 / QQ 登录（docs §6.1–6.3） ----
  authStart(req: AuthStartRequest): Promise<AuthStartResponse>;
  authFinish(id: string, secret: string): Promise<AuthFinishResponse>;
  /** 用 auth-finish 拿到的一次性令牌换成会话 */
  verifyTokenHash(tokenHash: string, type: string): Promise<void>;
  redeemInvite(code: string): Promise<RedeemResult>;

  createReminder(input: ReminderInput, userId: string): Promise<string>;
  updateReminder(id: string, input: ReminderInput): Promise<void>;
  deleteReminder(id: string): Promise<void>;
  addCompletion(c: Omit<Completion, 'id' | 'completed_at'>): Promise<void>;
  removeCompletion(id: string): Promise<void>;
  setSnooze(s: Omit<Snooze, 'id'>): Promise<void>;
  clearSnooze(reminderId: string, userId: string, occurrenceAt: string): Promise<void>;
  /** 上传一个回传文件并登记；返回登记行 */
  addSubmission(meta: SubmissionMeta, file: File): Promise<Submission>;
  /** 删记录 + 删文件 */
  removeSubmission(s: Submission): Promise<void>;
  /** 批改：一个人这一次交的几个文件一起标成通过 / 退回（带一句批语） */
  reviewSubmissions(ids: string[], status: SubmissionStatus, note: string): Promise<void>;
  /** 拿一个短期有效的下载地址（浏览器直接打开就会下载） */
  submissionUrl(s: Submission): Promise<string>;
  /** 已读回执：看过某条提醒的这一次到期（重复写无害） */
  markRead(reminderId: string, occurrenceAt: string, userId: string): Promise<void>;
  /** 给提醒挂一个附件（只有创建人 / 管理员有权限，数据库里也拦着） */
  addAttachment(reminderId: string, userId: string, file: File): Promise<Attachment>;
  removeAttachment(a: Attachment): Promise<void>;
  /** 短期有效的地址：downloadName 给了就是「下载」，不给就是在浏览器里直接看（图片预览用） */
  fileUrl(bucket: FileBucket, path: string, downloadName?: string): Promise<string>;
  /** 一次拿一批图片的预览地址（缩略图用），返回 path → url */
  fileUrls(bucket: FileBucket, paths: string[]): Promise<Record<string, string>>;
  updateProfile(id: string, patch: Partial<Profile>): Promise<void>;
  /** 设置某人的兼任小组（整组替换，不含主小组） */
  setMemberships(profileId: string, teamIds: string[]): Promise<void>;
  upsertTeam(team: Partial<Team> & { name: string; color: string }): Promise<void>;
  deleteTeam(id: string): Promise<void>;

  // ---- 机构设置、节假日（管理员） ----
  updateAppSettings(patch: Partial<AppSettings>): Promise<void>;
  /** 加一段节假日（起止日期都含），已有的日子会被覆盖 */
  addHolidays(rows: Holiday[]): Promise<void>;
  removeHolidays(days: string[]): Promise<void>;

  // ---- 通知 ----
  saveNotifyPrefs(p: NotifyPrefs): Promise<void>;
  /** 服务号绑定二维码（10 分钟有效） */
  wechatBind(): Promise<WechatBindResponse>;
  unbindWechat(userId: string): Promise<void>;
  /** { webhookId } 给群机器人发测试消息；{ wechat: true } 给自己发一条服务号测试消息 */
  notifyTest(body: { webhookId: string } | { wechat: true }): Promise<NotifyTestResponse>;

  // ---- 邀请码、群机器人（管理员） ----
  createInvite(input: InviteInput, userId: string): Promise<TeamInvite>;
  setInviteDisabled(code: string, disabled: boolean): Promise<void>;
  upsertWebhook(w: WebhookInput): Promise<void>;
  deleteWebhook(id: string): Promise<void>;

  // 讨论
  createDiscussion(input: DiscussionInput, userId: string): Promise<string>;
  /** 改主题 / 内容 / 范围（只有发起人；已结束的要先重新打开） */
  updateDiscussion(id: string, input: DiscussionInput): Promise<void>;
  /** 结束（可带一句结论）/ 重新打开；只有发起人 */
  setDiscussionClosed(id: string, closed: boolean, conclusion?: string): Promise<void>;
  /** 删掉整个讨论：先清掉存储里的文件，再删行（留言、文件记录跟着删） */
  deleteDiscussion(id: string): Promise<void>;
  /** 正文附件（只有发起人） */
  addDiscussionFile(discussionId: string, userId: string, file: File): Promise<DiscussionFile>;
  removeDiscussionFile(f: DiscussionFile): Promise<void>;
  /** 发留言：文件先全部传上去，都成功了才登记留言 —— 不会留下缺附件的半条留言 */
  addComment(c: CommentDraft, files: File[], onProgress?: (done: number) => void): Promise<{ comment: DiscussionComment; files: DiscussionFile[] }>;
  /** 删留言（它的文件一起删） */
  removeComment(c: DiscussionComment, files: DiscussionFile[]): Promise<void>;
  /** 标记读到了 at（讨论的 last_activity_at，服务器时间） */
  markDiscussionRead(discussionId: string, userId: string, at: string): Promise<void>;
  /** 一个讨论的全部留言和文件（打开很早以前的讨论时用） */
  loadThread(discussionId: string): Promise<{ comments: DiscussionComment[]; files: DiscussionFile[] }>;
}

// ---------------------------------------------------------------------------
// Supabase 实现
// ---------------------------------------------------------------------------
export function hasSupabaseConfig(): boolean {
  return !getConfig().demo;
}

/** 测试用：换掉 fetch / 本地存储 */
export interface SupabaseRepoOptions {
  url?: string;
  anonKey?: string;
  fetch?: typeof fetch;
  storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
}

export class SupabaseRepo implements Repo {
  mode = 'supabase' as const;
  client: SupabaseClient;

  constructor(opts: SupabaseRepoOptions = {}) {
    const cfg = getConfig();
    const url = opts.url ?? cfg.supabaseUrl;
    const key = opts.anonKey ?? cfg.supabaseAnonKey;
    // 登录状态按服务器分开存：桌面版换了服务器，不会拿着上一家的会话去连下一家
    let storageKey = 'pling-auth';
    try {
      const u = new URL(url);
      storageKey = `pling-auth-${u.host}${u.pathname.replace(/\/+$/, '')}`.replace(/[^A-Za-z0-9._-]/g, '_');
    } catch {
      /* 地址不对 createClient 会报错 */
    }
    this.client = createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey, ...(opts.storage ? { storage: opts.storage } : {}) },
      ...(opts.fetch ? { global: { fetch: opts.fetch } } : {}),
    });
  }

  async getSession(): Promise<Session | null> {
    const { data } = await this.client.auth.getSession();
    const u = data.session?.user;
    return u ? { userId: u.id, email: u.email ?? '' } : null;
  }

  onAuthChange(cb: (s: Session | null) => void): () => void {
    const { data } = this.client.auth.onAuthStateChange((_event, session) => {
      const u = session?.user;
      cb(u ? { userId: u.id, email: u.email ?? '' } : null);
    });
    return () => data.subscription.unsubscribe();
  }

  async signInWithEmail(email: string): Promise<void> {
    // 邮件里的链接打开网页版（桌面版的地址 tauri://localhost 在浏览器里打不开）；桌面版填验证码
    const site = getConfig().publicUrl || window.location.origin;
    const { error } = await this.client.auth.signInWithOtp({ email, options: { emailRedirectTo: site } });
    if (error) throw error;
  }

  async verifyEmailCode(email: string, code: string): Promise<void> {
    const { error } = await this.client.auth.verifyOtp({ email, token: code.trim(), type: 'email' });
    if (error) throw error;
  }

  async signOut(): Promise<void> {
    await this.client.auth.signOut();
  }

  // ---- 云函数 ----
  private async invokeFn<T>(name: PlingFunction, body: unknown): Promise<T> {
    const { data, error } = await this.client.functions.invoke(name, { body: body as Record<string, unknown> });
    if (error) throw await fnErrorFrom(error);
    return data as T;
  }

  authStart(req: AuthStartRequest): Promise<AuthStartResponse> {
    return this.invokeFn<AuthStartResponse>('auth-start', req);
  }

  authFinish(id: string, secret: string): Promise<AuthFinishResponse> {
    return this.invokeFn<AuthFinishResponse>('auth-finish', { id, secret });
  }

  async verifyTokenHash(tokenHash: string, type: string): Promise<void> {
    const { error } = await this.client.auth.verifyOtp({ token_hash: tokenHash, type: (type || 'magiclink') as EmailOtpType });
    if (error) throw error;
  }

  async redeemInvite(code: string): Promise<RedeemResult> {
    const { data, error } = await this.client.rpc('redeem_invite', { p_code: code });
    if (error) throw error;
    return (data ?? { ok: false, reason: 'unknown' }) as RedeemResult;
  }

  async loadAll(userId: string): Promise<Snapshot> {
    const since = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString();
    const dSince = new Date(Date.now() - DISCUSSION_WINDOW_DAYS * 86400000).toISOString();
    const c = this.client;
    const [teams, profiles, reminders, assignees, completions, snoozes, submissions, memberships, attachments, discussions, dMembers, comments, dFiles, dReads, settings, holidays, reads, prefs, binding, identities, invites, webhooks] =
      await Promise.all([
        c.from('teams').select('*').order('sort'),
        c.from('profiles').select('*').order('name'),
        c.from('reminders').select('*').eq('archived', false),
        c.from('reminder_assignees').select('*'),
        c.from('completions').select('*').gte('occurrence_at', since),
        c.from('snoozes').select('*'),
        c.from('submissions').select('*').gte('occurrence_at', since).order('created_at'),
        c.from('profile_teams').select('profile_id, team_id'),
        c.from('reminder_attachments').select('*').order('created_at'),
        c.from('discussions').select('*').order('last_activity_at', { ascending: false }),
        c.from('discussion_members').select('*'),
        c.from('discussion_comments').select('*').gte('created_at', dSince).order('created_at'),
        c.from('discussion_files').select('*').or(`comment_id.is.null,created_at.gte."${dSince}"`).order('created_at'),
        c.from('discussion_reads').select('*').eq('user_id', userId),
        c.from('app_settings').select('org_name, team_label, org_label, timezone, push_overdue_max').eq('id', 1).maybeSingle(),
        c.from('holidays').select('day, kind, name').order('day'),
        c.from('reminder_reads').select('*').gte('occurrence_at', since),
        c.from('notify_prefs').select('user_id, wechat, dnd_enabled, dnd_from, dnd_to, dnd_rest_days').eq('user_id', userId).maybeSingle(),
        c.from('wechat_bindings').select('user_id, openid, unionid, subscribed, nickname, bound_at').eq('user_id', userId).maybeSingle(),
        c.from('login_identities').select('provider, subject, unionid, user_id, nickname, avatar_url, created_at, last_login_at'),
        c.from('team_invites').select('*').order('created_at', { ascending: false }),
        c.from('team_webhooks').select('*').order('created_at'),
      ]);
    const err = [teams, profiles, reminders, assignees, completions, snoozes, submissions, memberships].find((r) => r.error)?.error;
    if (err) throw err;
    const list = <T>(r: { data: unknown; error: unknown }): T[] => (r.error ? [] : ((r.data ?? []) as T[]));
    return {
      teams: (teams.data ?? []) as Team[],
      profiles: ((profiles.data ?? []) as Profile[]).map((p) => ({ ...p, phone: p.phone ?? '', avatar_url: p.avatar_url ?? '', name_confirmed: p.name_confirmed ?? true })),
      reminders: (reminders.data ?? []) as Reminder[],
      assignees: (assignees.data ?? []) as Assignee[],
      completions: (completions.data ?? []) as Completion[],
      snoozes: (snoozes.data ?? []) as Snooze[],
      submissions: ((submissions.data ?? []) as Submission[]).map((s) => ({ ...s, status: s.status ?? 'submitted', review_note: s.review_note ?? '', reviewed_by: s.reviewed_by ?? null, reviewed_at: s.reviewed_at ?? null })),
      memberships: (memberships.data ?? []) as TeamMembership[],
      // 后加的表：查询出错（权限、表不存在）不能把整个应用拖垮，当作没有
      attachments: list<Attachment>(attachments),
      discussionsReady: !discussions.error,
      discussions: list<Discussion>(discussions).map((d) => ({ ...d, due_date: d.due_date ?? null })),
      discussionMembers: list<DiscussionMember>(dMembers),
      comments: list<DiscussionComment>(comments),
      discussionFiles: list<DiscussionFile>(dFiles),
      discussionReads: list<DiscussionRead>(dReads),
      appSettings: { ...DEFAULT_APP_SETTINGS, ...((settings.error ? null : settings.data) ?? {}) } as AppSettings,
      holidays: list<Holiday>(holidays).map((h) => ({ ...h, day: String(h.day).slice(0, 10) })),
      reads: list<ReminderRead>(reads),
      notifyPrefs: prefs.error ? null : ((prefs.data as NotifyPrefs | null) ?? null),
      wechatBinding: binding.error ? null : ((binding.data as WechatBinding | null) ?? null),
      identities: list<LoginIdentity>(identities),
      invites: list<TeamInvite>(invites),
      webhooks: list<TeamWebhook>(webhooks).map((w) => ({ ...w, stages: (w.stages ?? ['due']) as TeamWebhook['stages'] })),
    };
  }

  subscribe(onChange: () => void, onRead?: (row: ReminderRead) => void): () => void {
    let timer: number | undefined;
    const debounced = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(onChange, 250);
    };
    const on = (ch: ReturnType<SupabaseClient['channel']>, tables: string[]) => {
      for (const table of tables) {
        if (table === 'reminder_reads' && onRead) {
          // 已读回执只会新增（主键冲突的重复写被忽略）：新的一行直接合并；删除（提醒 / 人被删）少见，照样整体刷新
          ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table }, (p) => onRead(p.new as ReminderRead));
          ch.on('postgres_changes', { event: 'DELETE', schema: 'public', table }, debounced);
        } else {
          ch.on('postgres_changes', { event: '*', schema: 'public', table }, debounced);
        }
      }
      return ch.subscribe();
    };
    const channel = on(this.client.channel('pling-changes'), [
      'reminders',
      'reminder_assignees',
      'completions',
      'submissions',
      'reminder_attachments',
      'profiles',
      'teams',
      'profile_teams',
    ]);
    // 讨论、后加的表各自一个频道：一个频道里只要有一张表订阅不上，整个频道都会失败 —— 分开放，提醒的实时同步不受影响
    const discuss = on(this.client.channel('pling-discussions'), ['discussions', 'discussion_members', 'discussion_comments', 'discussion_files', 'discussion_reads']);
    const extra = on(this.client.channel('pling-extra'), ['app_settings', 'holidays', 'reminder_reads', 'notify_prefs', 'wechat_bindings']);
    return () => {
      window.clearTimeout(timer);
      this.client.removeChannel(channel);
      this.client.removeChannel(discuss);
      this.client.removeChannel(extra);
    };
  }

  private reminderRow(input: ReminderInput) {
    return {
      title: input.title,
      notes: input.notes,
      due_at: input.due_at,
      rrule: input.rrule,
      skip_holidays: input.skip_holidays,
      remind_before_min: input.remind_before_min,
      overdue_repeat_min: input.overdue_repeat_min,
      priority: input.priority,
      visibility: input.visibility,
      team_id: input.team_id,
      link: input.link,
      completion_mode: input.completion_mode,
      require_upload: input.require_upload,
    };
  }

  private async writeAssignees(reminderId: string, input: ReminderInput) {
    await this.client.from('reminder_assignees').delete().eq('reminder_id', reminderId);
    const rows = [
      ...input.assignee_user_ids.map((user_id) => ({ reminder_id: reminderId, user_id, team_id: null })),
      ...input.assignee_team_ids.map((team_id) => ({ reminder_id: reminderId, user_id: null, team_id })),
    ];
    if (rows.length) {
      const { error } = await this.client.from('reminder_assignees').insert(rows);
      if (error) throw error;
    }
  }

  async createReminder(input: ReminderInput, userId: string): Promise<string> {
    const { data, error } = await this.client
      .from('reminders')
      .insert({ ...this.reminderRow(input), created_by: userId, tz: TZ })
      .select('id')
      .single();
    if (error) throw error;
    await this.writeAssignees(data.id as string, input);
    return data.id as string;
  }

  async updateReminder(id: string, input: ReminderInput): Promise<void> {
    const { error } = await this.client.from('reminders').update(this.reminderRow(input)).eq('id', id);
    if (error) throw error;
    await this.writeAssignees(id, input);
  }

  async deleteReminder(id: string): Promise<void> {
    const { error } = await this.client.from('reminders').update({ archived: true }).eq('id', id);
    if (error) throw error;
  }

  async addCompletion(c: Omit<Completion, 'id' | 'completed_at'>): Promise<void> {
    const { error } = await this.client.from('completions').upsert(c, { onConflict: 'reminder_id,occurrence_at,completed_by' });
    if (error) throw error;
  }

  async removeCompletion(id: string): Promise<void> {
    const { error } = await this.client.from('completions').delete().eq('id', id);
    if (error) throw error;
  }

  async setSnooze(s: Omit<Snooze, 'id'>): Promise<void> {
    const { error } = await this.client.from('snoozes').upsert(s, { onConflict: 'reminder_id,user_id,occurrence_at' });
    if (error) throw error;
  }

  async clearSnooze(reminderId: string, userId: string, occurrenceAt: string): Promise<void> {
    await this.client.from('snoozes').delete().eq('reminder_id', reminderId).eq('user_id', userId).eq('occurrence_at', occurrenceAt);
  }

  async addSubmission(meta: SubmissionMeta, file: File): Promise<Submission> {
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) throw new Error(`too large: ${file.name}`);
    // 对象路径只用 ASCII（原始文件名存在表里），第一段是提醒 id，Storage 权限靠它判断
    const occ = meta.occurrence_at.replace(/[^0-9]/g, '').slice(0, 12);
    const path = `${meta.reminder_id}/${occ}/${objectName(file.name)}`;
    const up = await this.client.storage.from('submissions').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
    if (up.error) throw up.error;
    const row = { ...meta, file_path: path, file_name: file.name, size: file.size, mime: file.type || '' };
    const { data, error } = await this.client.from('submissions').insert(row).select('*').single();
    if (error) {
      await this.client.storage.from('submissions').remove([path]);
      throw error;
    }
    return data as Submission;
  }

  async removeSubmission(s: Submission): Promise<void> {
    const { error } = await this.client.from('submissions').delete().eq('id', s.id);
    if (error) throw error;
    await this.client.storage.from('submissions').remove([s.file_path]);
  }

  async reviewSubmissions(ids: string[], status: SubmissionStatus, note: string): Promise<void> {
    if (!ids.length) return;
    const { data, error } = await this.client.from('submissions').update({ status, review_note: note }).in('id', ids).select('id');
    if (error) throw error;
    if (!data?.length) throw new Error('not allowed');
  }

  async submissionUrl(s: Submission): Promise<string> {
    return this.fileUrl('submissions', s.file_path, s.file_name);
  }

  async markRead(reminderId: string, occurrenceAt: string, userId: string): Promise<void> {
    const { error } = await this.client
      .from('reminder_reads')
      .upsert({ reminder_id: reminderId, occurrence_at: occurrenceAt, user_id: userId }, { onConflict: 'reminder_id,occurrence_at,user_id', ignoreDuplicates: true });
    if (error) throw error;
  }

  async addAttachment(reminderId: string, userId: string, file: File): Promise<Attachment> {
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) throw new Error(`too large: ${file.name}`);
    const path = `${reminderId}/${objectName(file.name)}`;
    const up = await this.client.storage.from('attachments').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
    if (up.error) throw up.error;
    const row = { reminder_id: reminderId, uploaded_by: userId, file_path: path, file_name: file.name, size: file.size, mime: file.type || '' };
    const { data, error } = await this.client.from('reminder_attachments').insert(row).select('*').single();
    if (error) {
      await this.client.storage.from('attachments').remove([path]);
      throw error;
    }
    return data as Attachment;
  }

  async removeAttachment(a: Attachment): Promise<void> {
    const { error } = await this.client.from('reminder_attachments').delete().eq('id', a.id);
    if (error) throw error;
    await this.client.storage.from('attachments').remove([a.file_path]);
  }

  async fileUrl(bucket: FileBucket, path: string, downloadName?: string): Promise<string> {
    const { data, error } = await this.client.storage.from(bucket).createSignedUrl(path, 600, downloadName ? { download: downloadName } : undefined);
    if (error) throw error;
    return data.signedUrl;
  }

  async fileUrls(bucket: FileBucket, paths: string[]): Promise<Record<string, string>> {
    if (!paths.length) return {};
    const { data, error } = await this.client.storage.from(bucket).createSignedUrls(paths, 3600);
    if (error) throw error;
    const out: Record<string, string> = {};
    for (const d of data ?? []) if (d.path && d.signedUrl) out[d.path] = d.signedUrl;
    return out;
  }

  async updateProfile(id: string, patch: Partial<Profile>): Promise<void> {
    const { error } = await this.client.from('profiles').update(patch).eq('id', id);
    if (error) throw error;
  }

  async setMemberships(profileId: string, teamIds: string[]): Promise<void> {
    const del = await this.client.from('profile_teams').delete().eq('profile_id', profileId);
    if (del.error) throw del.error;
    if (teamIds.length) {
      const { error } = await this.client.from('profile_teams').insert(teamIds.map((team_id) => ({ profile_id: profileId, team_id })));
      if (error) throw error;
    }
  }

  async upsertTeam(team: Partial<Team> & { name: string; color: string }): Promise<void> {
    const { error } = await this.client.from('teams').upsert(team);
    if (error) throw error;
  }

  async deleteTeam(id: string): Promise<void> {
    const { error } = await this.client.from('teams').delete().eq('id', id);
    if (error) throw error;
  }

  // ---- 机构设置、节假日 ----
  async updateAppSettings(patch: Partial<AppSettings>): Promise<void> {
    const { data, error } = await this.client.from('app_settings').update(patch).eq('id', 1).select('id');
    if (error) throw error;
    if (!data?.length) throw new Error('not allowed');
  }

  async addHolidays(rows: Holiday[]): Promise<void> {
    if (!rows.length) return;
    const { error } = await this.client.from('holidays').upsert(rows, { onConflict: 'day' });
    if (error) throw error;
  }

  async removeHolidays(days: string[]): Promise<void> {
    if (!days.length) return;
    const { error } = await this.client.from('holidays').delete().in('day', days);
    if (error) throw error;
  }

  // ---- 通知 ----
  async saveNotifyPrefs(p: NotifyPrefs): Promise<void> {
    const { error } = await this.client.from('notify_prefs').upsert(p, { onConflict: 'user_id' });
    if (error) throw error;
  }

  wechatBind(): Promise<WechatBindResponse> {
    return this.invokeFn<WechatBindResponse>('wechat-bind', {});
  }

  async unbindWechat(userId: string): Promise<void> {
    const { error } = await this.client.from('wechat_bindings').delete().eq('user_id', userId);
    if (error) throw error;
  }

  notifyTest(body: { webhookId: string } | { wechat: true }): Promise<NotifyTestResponse> {
    return this.invokeFn<NotifyTestResponse>('notify-test', body);
  }

  // ---- 邀请码、群机器人 ----
  async createInvite(input: InviteInput, userId: string): Promise<TeamInvite> {
    for (let attempt = 0; ; attempt++) {
      const row = { ...input, code: randomInviteCode(), created_by: userId };
      const { data, error } = await this.client.from('team_invites').insert(row).select('*').single();
      if (!error) return data as TeamInvite;
      // 码撞了（主键冲突）就换一个再来
      if (error.code !== '23505' || attempt >= 4) throw error;
    }
  }

  async setInviteDisabled(code: string, disabled: boolean): Promise<void> {
    const { error } = await this.client.from('team_invites').update({ disabled }).eq('code', code);
    if (error) throw error;
  }

  async upsertWebhook(w: WebhookInput): Promise<void> {
    const row = { team_id: w.team_id, kind: w.kind, name: w.name, url: w.url, secret: w.secret, stages: w.stages, enabled: w.enabled };
    const { error } = w.id ? await this.client.from('team_webhooks').update(row).eq('id', w.id) : await this.client.from('team_webhooks').insert(row);
    if (error) throw error;
  }

  async deleteWebhook(id: string): Promise<void> {
    const { error } = await this.client.from('team_webhooks').delete().eq('id', id);
    if (error) throw error;
  }

  // -------------------------------------------------------------------------
  // 讨论
  // -------------------------------------------------------------------------
  private async writeDiscussionMembers(discussionId: string, input: DiscussionInput) {
    const del = await this.client.from('discussion_members').delete().eq('discussion_id', discussionId);
    if (del.error) throw del.error;
    if (input.visibility === 'company') return;
    const rows = [
      ...input.member_user_ids.map((user_id) => ({ discussion_id: discussionId, user_id, team_id: null })),
      ...input.member_team_ids.map((team_id) => ({ discussion_id: discussionId, user_id: null, team_id })),
    ];
    if (rows.length) {
      const { error } = await this.client.from('discussion_members').insert(rows);
      if (error) throw error;
    }
  }

  async createDiscussion(input: DiscussionInput, userId: string): Promise<string> {
    const row = { title: input.title, body: input.body, visibility: input.visibility, created_by: userId, created_by_name: input.created_by_name, due_date: input.due_date };
    const { data, error } = await this.client.from('discussions').insert(row).select('id').single();
    if (error) throw error;
    await this.writeDiscussionMembers(data.id as string, input);
    return data.id as string;
  }

  async updateDiscussion(id: string, input: DiscussionInput): Promise<void> {
    const { error } = await this.client.from('discussions').update({ title: input.title, body: input.body, visibility: input.visibility, due_date: input.due_date }).eq('id', id);
    if (error) throw error;
    await this.writeDiscussionMembers(id, input);
  }

  async setDiscussionClosed(id: string, closed: boolean, conclusion?: string): Promise<void> {
    // 结束时间由数据库换成服务器时间；只有发起人改得动（RLS），别人改会是 0 行 → 当作失败
    const patch = closed ? { closed_at: new Date().toISOString(), conclusion: conclusion ?? '' } : { closed_at: null };
    const { data, error } = await this.client.from('discussions').update(patch).eq('id', id).select('id');
    if (error) throw error;
    if (!data?.length) throw new Error('only the creator can close / reopen this discussion');
  }

  async deleteDiscussion(id: string): Promise<void> {
    // 存储里的对象要趁讨论还在时删（删除权限要查「是不是这个讨论的发起人」）
    const { data, error } = await this.client.from('discussion_files').select('file_path').eq('discussion_id', id);
    if (error) throw error;
    const paths = (data ?? []).map((r) => r.file_path as string);
    for (let i = 0; i < paths.length; i += 100) await this.client.storage.from('discussions').remove(paths.slice(i, i + 100));
    const del = await this.client.from('discussions').delete().eq('id', id).select('id');
    if (del.error) throw del.error;
    if (!del.data?.length) throw new Error('not allowed');
  }

  private async uploadDiscussionObject(discussionId: string, file: File): Promise<string> {
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) throw new Error(`too large: ${file.name}`);
    const path = `${discussionId}/${objectName(file.name)}`;
    const up = await this.client.storage.from('discussions').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
    if (up.error) throw up.error;
    return path;
  }

  async addDiscussionFile(discussionId: string, userId: string, file: File): Promise<DiscussionFile> {
    const path = await this.uploadDiscussionObject(discussionId, file);
    const row = { discussion_id: discussionId, comment_id: null, uploaded_by: userId, file_path: path, file_name: file.name, size: file.size, mime: file.type || '' };
    const { data, error } = await this.client.from('discussion_files').insert(row).select('*').single();
    if (error) {
      await this.client.storage.from('discussions').remove([path]);
      throw error;
    }
    return data as DiscussionFile;
  }

  async removeDiscussionFile(f: DiscussionFile): Promise<void> {
    const { data, error } = await this.client.from('discussion_files').delete().eq('id', f.id).select('id');
    if (error) throw error;
    if (!data?.length) throw new Error('not allowed');
    await this.client.storage.from('discussions').remove([f.file_path]);
  }

  async addComment(c: CommentDraft, files: File[], onProgress?: (done: number) => void): Promise<{ comment: DiscussionComment; files: DiscussionFile[] }> {
    const uploaded: { path: string; file: File }[] = [];
    try {
      for (const f of files) {
        uploaded.push({ path: await this.uploadDiscussionObject(c.discussion_id, f), file: f });
        onProgress?.(uploaded.length);
      }
      const { data, error } = await this.client.from('discussion_comments').insert(c).select('*').single();
      if (error) throw error;
      const comment = data as DiscussionComment;
      if (!uploaded.length) return { comment, files: [] };
      const rows = uploaded.map((u) => ({
        discussion_id: c.discussion_id,
        comment_id: comment.id,
        uploaded_by: c.author_id,
        file_path: u.path,
        file_name: u.file.name,
        size: u.file.size,
        mime: u.file.type || '',
      }));
      const ins = await this.client.from('discussion_files').insert(rows).select('*');
      if (ins.error) {
        await this.client.from('discussion_comments').delete().eq('id', comment.id);
        throw ins.error;
      }
      return { comment, files: (ins.data ?? []) as DiscussionFile[] };
    } catch (e) {
      if (uploaded.length) await this.client.storage.from('discussions').remove(uploaded.map((u) => u.path));
      throw e;
    }
  }

  async removeComment(c: DiscussionComment, files: DiscussionFile[]): Promise<void> {
    const { data, error } = await this.client.from('discussion_comments').delete().eq('id', c.id).select('id');
    if (error) throw error;
    if (!data?.length) throw new Error('not allowed');
    if (files.length) await this.client.storage.from('discussions').remove(files.map((f) => f.file_path));
  }

  async markDiscussionRead(discussionId: string, userId: string, at: string): Promise<void> {
    const { error } = await this.client.from('discussion_reads').upsert({ discussion_id: discussionId, user_id: userId, last_read_at: at }, { onConflict: 'discussion_id,user_id' });
    if (error) throw error;
  }

  async loadThread(discussionId: string): Promise<{ comments: DiscussionComment[]; files: DiscussionFile[] }> {
    const [c, f] = await Promise.all([
      this.client.from('discussion_comments').select('*').eq('discussion_id', discussionId).order('created_at'),
      this.client.from('discussion_files').select('*').eq('discussion_id', discussionId).order('created_at'),
    ]);
    if (c.error) throw c.error;
    if (f.error) throw f.error;
    return { comments: (c.data ?? []) as DiscussionComment[], files: (f.data ?? []) as DiscussionFile[] };
  }
}
