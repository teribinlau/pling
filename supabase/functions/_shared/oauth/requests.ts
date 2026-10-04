// login_requests 表的读写（只有云函数用；客户端没有任何权限）。
//
// 状态：pending →（回调）done / error →（auth-finish 取走令牌）used
// - 回调要在发起后 10 分钟内到；auth-finish 在发起后 10 分钟内、或者回调开始处理 / 处理完的 2 分钟内都能取（回调卡在第 9 分 59 秒也不吃亏）
// - finished_at 不为空而状态还是 pending = 有一个回调正在处理（微信内置浏览器偶尔会把回调地址打开两次，
//   code 只能用一次，所以只让先到的那个处理，后到的等结果）；处理完再更新成完成时间
import { db } from '../db.ts';
import type { Client, LoginErrorCode, Provider } from './types.ts';

export type RequestStatus = 'pending' | 'done' | 'error' | 'used';

export interface LoginRequestRow {
  id: string;
  secret_hash: string;
  provider: Provider;
  client: Client;
  return_to: string;
  link_user_id: string | null;
  status: RequestStatus;
  token_hash: string | null;
  token_type: string | null;
  user_id: string | null;
  error: string;
  finished_at: Date | null;
  /** 发起超过 10 分钟：回调不再处理 */
  expired: boolean;
  /** auth-finish 也不能再取了 */
  finish_expired: boolean;
  /** 有回调抢到了这个请求，但 2 分钟了还没处理完（函数中途挂了） */
  stale_claim: boolean;
}

export async function createRequest(r: {
  secretHash: string;
  provider: Provider;
  client: Client;
  returnTo: string;
  linkUserId: string | null;
}): Promise<string> {
  const rows = await db()<{ id: string }[]>`
    insert into public.login_requests (secret_hash, provider, client, return_to, link_user_id)
    values (${r.secretHash}, ${r.provider}, ${r.client}, ${r.returnTo}, ${r.linkUserId})
    returning id`;
  return rows[0].id;
}

export async function loadRequest(id: string): Promise<LoginRequestRow | null> {
  const rows = await db()<LoginRequestRow[]>`
    select id, secret_hash, provider, client, return_to, link_user_id, status, token_hash, token_type, user_id, error, finished_at,
           created_at < now() - interval '10 minutes' as expired,
           (created_at < now() - interval '10 minutes'
             and not (finished_at is not null and finished_at > now() - interval '2 minutes')) as finish_expired,
           (status = 'pending' and finished_at is not null and finished_at < now() - interval '2 minutes') as stale_claim
      from public.login_requests
     where id = ${id}`;
  return rows[0] ?? null;
}

/** 回调开始处理：只有一个能抢到（返回 false = 别的回调已经在处理，或者已经不是 pending / 已过期） */
export async function claimRequest(id: string): Promise<boolean> {
  const rows = await db()`
    update public.login_requests set finished_at = now()
     where id = ${id} and status = 'pending' and finished_at is null and created_at >= now() - interval '10 minutes'
    returning id`;
  return rows.length > 0;
}

/**
 * 记失败；返回 false = 这个请求已经不是 pending（别的回调先处理完了）。
 * unclaimedOnly：没抢这个请求就判失败的情况（取消、过期），别的回调正在处理时不动它。
 */
export async function markError(id: string, code: LoginErrorCode, unclaimedOnly = false): Promise<boolean> {
  const rows = await db()`
    update public.login_requests set status = 'error', error = ${code}, finished_at = now()
     where id = ${id} and status = 'pending' and (${!unclaimedOnly}::boolean or finished_at is null)
    returning id`;
  return rows.length > 0;
}

/** 记成功：登录带令牌，加绑不带（token 为 null） */
export async function markDone(id: string, userId: string, token: { tokenHash: string; type: string } | null): Promise<boolean> {
  const rows = await db()`
    update public.login_requests
       set status = 'done', user_id = ${userId}, token_hash = ${token?.tokenHash ?? null}, token_type = ${token?.type ?? null},
           error = '', finished_at = now()
     where id = ${id} and status = 'pending'
    returning id`;
  return rows.length > 0;
}

/** auth-finish 取结果：done → used，令牌只给一次（并发的两次调用只有一个拿得到），库里的令牌顺手清掉 */
export async function takeResult(
  id: string,
): Promise<{ token_hash: string | null; token_type: string | null; link_user_id: string | null } | null> {
  const rows = await db()<{ token_hash: string | null; token_type: string | null; link_user_id: string | null }[]>`
    with old as (
      select id, token_hash, token_type from public.login_requests where id = ${id} and status = 'done' for update
    )
    update public.login_requests r set status = 'used', token_hash = null
      from old
     where r.id = old.id
    returning old.token_hash, old.token_type, r.link_user_id`;
  return rows[0] ?? null;
}
