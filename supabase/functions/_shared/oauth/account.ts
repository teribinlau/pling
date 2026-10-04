// 用第三方身份找账号 / 建账号 / 加绑，都在一个数据库事务里：
// 1. (provider, openid) 已经绑过 → 那个账号（加绑模式下属于别人 → already_linked）
// 2. 同一个 unionid 的另一个身份（微信：网站应用 ↔ 服务号，或者换过 appid；QQ：同一开发者账号下换过应用）→ 那个账号
// 3. 加绑模式 → 发起加绑的账号；否则用 GoTrue 管理接口新建用户（会触发 handle_new_user() 建 profile）
// 4. 服务号登录 / 加绑顺手写 wechat_bindings
//
// 并发：同一个身份（以及同一个 unionid）先拿事务级的 advisory lock，同时进来的第二次登录会等第一次提交后
// 直接读到身份，不会建出两个用户；(provider, subject) 主键再兜一层底（冲突了就重读，删掉多建的用户）。
import type postgres from 'npm:postgres@3.4.7';
import { db } from '../db.ts';
import { createUser, deleteUser } from '../gotrue.ts';
import { errorMessage } from './remote.ts';
import { type ExternalIdentity, isWechat, LoginError, type Provider } from './types.ts';

type Tx = postgres.TransactionSql;

/** 新用户在 GoTrue 里的邮箱：随机、不发邮件、不显示（GoTrue 要求有个邮箱；真正的映射靠 login_identities） */
export const LOGIN_EMAIL_DOMAIN = 'login.pling.invalid';

export function newLoginEmail(): string {
  return `u.${crypto.randomUUID()}@${LOGIN_EMAIL_DOMAIN}`;
}

/** unionid 只在同一家里比较：微信的两种登录互认，QQ 和微信不互认 */
function unionScope(p: Provider): { key: string; providers: Provider[] } {
  return isWechat(p) ? { key: 'wechat', providers: ['wechat_open', 'wechat_mp'] } : { key: 'qq', providers: ['qq'] };
}

export interface ResolvedAccount {
  userId: string;
  /** 这次新建的用户 */
  created: boolean;
}

export async function resolveAccount(ident: ExternalIdentity, linkUserId: string | null): Promise<ResolvedAccount> {
  let createdUserId: string | null = null;
  let keepCreated = false;
  try {
    const result = await db().begin(async (tx): Promise<ResolvedAccount> => {
      await lockIdentity(tx, ident);

      const [own] = await tx<{ user_id: string; avatar_url: string }[]>`
        select user_id, avatar_url from public.login_identities
         where provider = ${ident.provider} and subject = ${ident.subject}`;
      if (own) {
        if (linkUserId && own.user_id !== linkUserId) throw new LoginError('already_linked');
        await tx`
          update public.login_identities
             set unionid = case when ${ident.unionid}::text <> '' then ${ident.unionid}::text else unionid end,
                 nickname = case when ${ident.nickname}::text <> '' then ${ident.nickname}::text else nickname end,
                 avatar_url = case when ${ident.avatarUrl}::text <> '' then ${ident.avatarUrl}::text else avatar_url end,
                 last_login_at = now()
           where provider = ${ident.provider} and subject = ${ident.subject}`;
        await refreshAvatar(tx, own.user_id, own.avatar_url, ident.avatarUrl);
        await bindWechatMp(tx, own.user_id, ident);
        return { userId: own.user_id, created: false };
      }

      let userId: string | null = null;
      if (ident.unionid) {
        const scope = unionScope(ident.provider);
        const [sibling] = await tx<{ user_id: string }[]>`
          select user_id from public.login_identities
           where unionid = ${ident.unionid} and provider in ${tx(scope.providers)}
           order by created_at
           limit 1`;
        userId = sibling?.user_id ?? null;
      }
      if (linkUserId) {
        // 同一个人（unionid）已经是别的账号的登录方式了，不能再绑到这里
        if (userId && userId !== linkUserId) throw new LoginError('already_linked');
        userId = linkUserId;
      }
      if (!userId) {
        userId = createdUserId = await createUser({
          email: newLoginEmail(),
          name: ident.nickname,
          avatarUrl: ident.avatarUrl,
          provider: ident.provider,
        });
      }

      const inserted = await tx<{ user_id: string }[]>`
        insert into public.login_identities (provider, subject, unionid, user_id, nickname, avatar_url)
        values (${ident.provider}, ${ident.subject}, ${ident.unionid}, ${userId}, ${ident.nickname}, ${ident.avatarUrl})
        on conflict (provider, subject) do nothing
        returning user_id`;
      if (!inserted.length) {
        // 有锁的情况下不会走到这里；万一走到了：以先写进去的为准（刚建的用户在事务结束后删掉）
        const [winner] = await tx<{ user_id: string }[]>`
          select user_id from public.login_identities where provider = ${ident.provider} and subject = ${ident.subject}`;
        if (!winner) throw new Error('login_identities: conflict but no row');
        if (linkUserId && winner.user_id !== linkUserId) throw new LoginError('already_linked');
        userId = winner.user_id;
      } else if (!createdUserId) {
        // 老账号多了一个登录方式：资料里没有头像就用这个
        await refreshAvatar(tx, userId, '', ident.avatarUrl);
      }

      await bindWechatMp(tx, userId, ident);
      return { userId, created: userId === createdUserId };
    });
    keepCreated = result.created;
    return result;
  } finally {
    // 刚建的 GoTrue 用户没用上（事务失败，或者撞上了并发的第一次登录）：删掉，免得成员列表里多一个空账号
    if (createdUserId && !keepCreated) await deleteUserQuietly(createdUserId);
  }
}

/** 给这个账号生成登录令牌要用它在 GoTrue 里的邮箱（老账号可能是真邮箱，新账号是 u.<uuid>@login.pling.invalid） */
export async function loginEmail(userId: string): Promise<string> {
  const rows = await db()<{ email: string | null }[]>`select email from auth.users where id = ${userId}`;
  const email = rows[0]?.email ?? '';
  if (!email) throw new Error(`auth.users ${userId}: no email`);
  return email;
}

async function lockIdentity(tx: Tx, ident: ExternalIdentity): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`pling-login:${ident.provider}:${ident.subject}`}, 0))`;
  if (ident.unionid) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`pling-login-unionid:${
      unionScope(ident.provider).key
    }:${ident.unionid}`}, 0))`;
  }
}

/** 头像跟着微信 / QQ 更新（换了头像旧地址会失效），但只在资料里的头像是空的、或者就是这个身份上次的头像时才动 */
async function refreshAvatar(tx: Tx, userId: string, previous: string, next: string): Promise<void> {
  if (!next) return;
  await tx`
    update public.profiles set avatar_url = ${next}
     where id = ${userId} and avatar_url <> ${next} and (avatar_url = '' or avatar_url = ${previous})`;
}

/**
 * 服务号登录：这个 openid 以后收模板消息。
 * subscribed 先写 true（不在登录里调服务号的 access_token 接口）；没关注的话推送那边发模板消息会收到 43004，再改成 false。
 * 这个 openid 绑在别的账号上 → 挪过来。写不进去不影响登录（成员还可以在设置里扫码绑定）。
 */
async function bindWechatMp(tx: Tx, userId: string, ident: ExternalIdentity): Promise<void> {
  if (ident.provider !== 'wechat_mp') return;
  try {
    await tx.savepoint(async (sp) => {
      await sp`delete from public.wechat_bindings where openid = ${ident.subject} and user_id <> ${userId}`;
      await sp`
        insert into public.wechat_bindings as b (user_id, openid, unionid, nickname, subscribed)
        values (${userId}, ${ident.subject}, ${ident.unionid}, ${ident.nickname}, true)
        on conflict (user_id) do update
          set openid = excluded.openid,
              unionid = case when excluded.unionid <> '' then excluded.unionid else b.unionid end,
              nickname = case when excluded.nickname <> '' then excluded.nickname else b.nickname end,
              subscribed = true,
              bound_at = case when b.openid = excluded.openid then b.bound_at else now() end`;
    });
  } catch (e) {
    console.warn(`[auth] wechat_bindings 没写进去（user ${userId}）：${errorMessage(e)}`);
  }
}

async function deleteUserQuietly(userId: string): Promise<void> {
  try {
    await deleteUser(userId);
  } catch (e) {
    console.error(`[auth] 删除多建的用户 ${userId} 失败：${errorMessage(e)}`);
  }
}
