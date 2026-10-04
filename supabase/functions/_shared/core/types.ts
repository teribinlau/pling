// 自动生成：源文件在 src/lib/，改那边再跑 npm run sync:core，不要直接改这里。
export type Role = 'admin' | 'member';
export type Lang = 'zh-CN' | 'en-US';
export type Priority = 'low' | 'medium' | 'high';
export type Visibility = 'private' | 'team' | 'company';
export type CompletionMode = 'any' | 'each';

/** 小组（界面上的叫法由机构设置的 team_label 决定：班级 / 部门 / 小组……） */
export interface Team {
  id: string;
  name: string;
  color: string;
  sort: number;
}

export interface Profile {
  id: string;
  email: string;
  name: string;
  team_id: string | null;
  role: Role;
  lang: Lang;
  is_station: boolean;
  active: boolean;
  phone: string; // 选填：工作群机器人 @ 人用
  avatar_url: string; // 微信 / QQ 头像
  name_confirmed: boolean; // false = 第一次进应用要先填真实姓名
}

export interface Reminder {
  id: string;
  title: string;
  notes: string;
  due_at: string; // ISO (UTC)
  tz: string;
  rrule: string | null;
  skip_holidays: boolean;
  remind_before_min: number;
  overdue_repeat_min: number;
  priority: Priority;
  visibility: Visibility;
  team_id: string | null;
  created_by: string;
  link: string; // 关联链接：可以多行，每行一个，可写「名称 链接」（见 links.ts）
  completion_mode: CompletionMode;
  require_upload: boolean; // 需要回传文件：必须上传文件才能点完成
  archived: boolean;
  source: string | null; // 外部来源（以后做导入用）；null = 手动创建
  source_key: string | null;
  created_at: string;
  updated_at: string;
}

/** 兼任班组：主班组之外，这个人还属于哪些班组 */
export interface TeamMembership {
  profile_id: string;
  team_id: string;
}

export interface Assignee {
  id: string;
  reminder_id: string;
  user_id: string | null;
  team_id: string | null;
}

export interface Completion {
  id: string;
  reminder_id: string;
  occurrence_at: string;
  completed_by: string;
  completed_by_name: string;
  completed_at: string;
  note: string;
}

/** 回传文件：员工上传的填好的表格 / 照片，文件本体在 Storage 桶 submissions */
export interface Submission {
  id: string;
  reminder_id: string;
  occurrence_at: string;
  uploaded_by: string;
  uploaded_by_name: string; // 工位模式下选的名字
  file_path: string;
  file_name: string;
  size: number;
  mime: string;
  created_at: string; // 服务器时间；晚于这一次的到期时间 = 迟交
  status: SubmissionStatus;
  review_note: string; // 退回 / 通过时写的一句批语
  reviewed_by: string | null;
  reviewed_at: string | null;
}

/** 作业批改状态：已交（待批）/ 退回重交 / 通过 */
export type SubmissionStatus = 'submitted' | 'returned' | 'accepted';

/** 已读回执：某人看过某条提醒的某一次到期 */
export interface ReminderRead {
  reminder_id: string;
  occurrence_at: string;
  user_id: string;
  read_at: string;
}

/** 机构设置（整个部署一行，管理员改） */
export interface AppSettings {
  org_name: string;
  team_label: string; // 「小组」这个词：班级 / 部门 / 班组……
  org_label: string; // 「全体」这个词：全校 / 全公司……
  timezone: string;
  push_overdue_max: number; // 逾期后服务号 / 群机器人最多再催几次
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  org_name: '',
  team_label: '小组',
  org_label: '全体',
  timezone: 'Asia/Shanghai',
  push_overdue_max: 2,
};

/** 个人通知设置（服务端推送和桌面弹窗共用）；数据库里没有这一行 = 用默认值 */
export interface NotifyPrefs {
  user_id: string;
  wechat: boolean; // 服务号消息
  dnd_enabled: boolean;
  dnd_from: string; // "21:30"
  dnd_to: string; // "07:00"
  dnd_rest_days: boolean; // 周末和法定假日不打扰（调休上班的日子照常）
}

export const DEFAULT_NOTIFY_PREFS: Omit<NotifyPrefs, 'user_id'> = {
  wechat: true,
  dnd_enabled: true,
  dnd_from: '21:30',
  dnd_to: '07:00',
  dnd_rest_days: true,
};

/** 服务号绑定：提醒会发到这个 openid */
export interface WechatBinding {
  user_id: string;
  openid: string;
  unionid: string;
  subscribed: boolean; // 取消关注了就收不到模板消息
  nickname: string;
  bound_at: string;
}

export type NotifyStage = 'pre' | 'due' | 'overdue';
export type WebhookKind = 'wecom' | 'dingtalk' | 'feishu';

/** 小组的工作群机器人（只有管理员看得到）；team_id 为空 = 「全体」的提醒发这里 */
export interface TeamWebhook {
  id: string;
  team_id: string | null;
  kind: WebhookKind;
  name: string;
  url: string;
  secret: string;
  stages: NotifyStage[];
  enabled: boolean;
  created_at: string;
  last_at: string | null;
  last_status: string;
}

/** 邀请码：新成员凭它自己激活并进小组 */
export interface TeamInvite {
  code: string;
  team_id: string | null;
  note: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  max_uses: number | null;
  uses: number;
  disabled: boolean;
}

export type LoginProvider = 'wechat_open' | 'wechat_mp' | 'qq';

/** 账号绑定的微信 / QQ 身份 */
export interface LoginIdentity {
  provider: LoginProvider;
  subject: string;
  unionid: string;
  user_id: string;
  nickname: string;
  avatar_url: string;
  created_at: string;
  last_login_at: string;
}

/** 创建人挂在提醒上的附件（照片、PDF、表格……）；和员工完成时交的 Submission 分开 */
export interface Attachment {
  id: string;
  reminder_id: string;
  uploaded_by: string;
  file_path: string; // Storage 桶 attachments 里的对象路径：<reminder_id>/<随机名>.<ext>
  file_name: string; // 原始文件名（可以含中文）
  size: number;
  mime: string;
  created_at: string;
}

/** 讨论：company = 全公司；members = 只有 discussion_members 里的人和班组（兼任也算），外加发起人和管理员 */
export type DiscussionVisibility = 'members' | 'company';

export interface Discussion {
  id: string;
  title: string;
  body: string;
  created_by: string;
  created_by_name: string; // 工位账号发起时选的名字
  visibility: DiscussionVisibility;
  closed_at: string | null; // 不为空 = 已结束（只读），只有发起人能结束 / 重新打开
  conclusion: string; // 结束时写的一句结论
  comment_count: number; // 服务器维护；比本地加载到的多 = 有更早的留言没加载
  last_activity_at: string; // 最近一次动静（新留言 / 改内容 / 结束 / 重开）的服务器时间
  last_activity_by: string | null;
  /** 截止日期（机构时区的本地日期 YYYY-MM-DD），可以不设；设了就出现在日历的那一天（不弹提醒） */
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface DiscussionMember {
  id: string;
  discussion_id: string;
  user_id: string | null;
  team_id: string | null;
}

export interface DiscussionComment {
  id: string;
  discussion_id: string;
  author_id: string;
  author_name: string; // 工位账号留言时选的名字
  body: string;
  created_at: string;
}

/** 讨论里的文件：comment_id 为空 = 正文附件，否则是那条留言的附件；文件本体在 Storage 桶 discussions */
export interface DiscussionFile {
  id: string;
  discussion_id: string;
  comment_id: string | null;
  uploaded_by: string;
  file_path: string;
  file_name: string;
  size: number;
  mime: string;
  created_at: string;
}

/** 我在某个讨论里读到了哪一刻（存的是讨论的 last_activity_at，服务器时间） */
export interface DiscussionRead {
  discussion_id: string;
  user_id: string;
  last_read_at: string;
}

export interface DiscussionInput {
  title: string;
  body: string;
  visibility: DiscussionVisibility;
  member_user_ids: string[];
  member_team_ids: string[];
  created_by_name: string;
  due_date: string | null;
}

export interface Snooze {
  id: string;
  reminder_id: string;
  user_id: string;
  occurrence_at: string;
  until: string;
}

/** 一次具体的到期（重复提醒展开后的一项） */
export interface Occurrence {
  key: string; // reminderId|occurrenceISO
  reminder: Reminder;
  at: Date; // 到期时间
  completion: Completion | null; // any 模式：第一条完成记录；each 模式：当前用户的完成记录
  completions: Completion[];
  submissions: Submission[]; // 这一次到期的回传文件
  snoozedUntil: Date | null;
  isOverdue: boolean;
  /** 重复提醒里超过 48 小时仍未完成的旧日期：不再当作逾期催办，只在历史里记为「未完成」 */
  stale: boolean;
}

export interface ReminderInput {
  title: string;
  notes: string;
  due_at: string;
  rrule: string | null;
  skip_holidays: boolean;
  remind_before_min: number;
  overdue_repeat_min: number;
  priority: Priority;
  visibility: Visibility;
  team_id: string | null;
  link: string;
  completion_mode: CompletionMode;
  require_upload: boolean;
  assignee_user_ids: string[];
  assignee_team_ids: string[];
}

/** 皮肤（每台设备各自选，存在本机设置里），定义在 src/skins.css + src/lib/skins.ts */
export type Skin = 'default' | 'opencode' | 'notion' | 'popcart';

export interface Settings {
  lang: Lang;
  skin: Skin;
  autostart: boolean;
  closeToTray: boolean;
  systemNotifications: boolean;
  sound: boolean;
  alertWindow: boolean; // 高优先级额外弹置顶小窗
  defaultRemindBefore: number;
  dndEnabled: boolean;
  dndFrom: string; // "18:30"
  dndTo: string; // "07:00"
  dndWeekend: boolean; // 周末和法定假日不打扰（调休上班的日子照常）
  overdueRepeatMin: number;
}

export const DEFAULT_SETTINGS: Settings = {
  lang: 'zh-CN',
  skin: 'default',
  autostart: true,
  closeToTray: true,
  systemNotifications: true,
  sound: true,
  alertWindow: true,
  defaultRemindBefore: 15,
  dndEnabled: true,
  dndFrom: '21:30',
  dndTo: '07:00',
  dndWeekend: true,
  overdueRepeatMin: 30,
};

/** 机构时区：展开重复提醒、显示时间、判断免打扰都按它。默认上海；加载机构设置后用 setTimeZone() 换 */
export let TZ = 'Asia/Shanghai';

export function setTimeZone(tz: string | null | undefined): void {
  if (!tz) return;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    TZ = tz;
  } catch {
    /* 不认识的时区名：保持原来的 */
  }
}
