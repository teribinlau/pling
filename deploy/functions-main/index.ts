// 叮一下 · 云函数总入口（edge-runtime 的 main 服务）
//
// 网关把 /functions/v1/<名字>/... 转到这里（去掉前缀后是 /<名字>/...），这里为 <名字> 起一个 user worker，
// 代码在 /home/deno/functions/<名字>/index.ts。
//
// 和 Supabase 官方的 main/index.ts 的区别：
// - 不在这里验 JWT（部署时 VERIFY_JWT=false，需要登录的函数自己验），所以不依赖 jsr: 上的 jose（国内服务器下载 jsr 不稳定）
// - 只允许名字是小写字母、数字、连字符的函数；_shared、main 这类目录不能当函数调用

const FUNCTIONS_DIR = '/home/deno/functions';
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const RESERVED = new Set(['main']);

function fail(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

declare const EdgeRuntime: {
  userWorkers: {
    create(opts: Record<string, unknown>): Promise<{ fetch(req: Request): Promise<Response> }>;
  };
  applySupabaseTag?(from: Request, to: Request): void;
};

console.log('pling functions main started');

Deno.serve(async (req: Request) => {
  const { pathname } = new URL(req.url);
  const name = pathname.split('/')[1] ?? '';

  if (!NAME.test(name) || RESERVED.has(name)) return fail(404, 'NOT_FOUND', 'Requested function was not found');

  const servicePath = `${FUNCTIONS_DIR}/${name}`;
  try {
    await Deno.stat(`${servicePath}/index.ts`);
  } catch {
    return fail(404, 'NOT_FOUND', 'Requested function was not found');
  }

  const envVars = Object.entries({ ...Deno.env.toObject(), SUPABASE_FUNCTION_SLUG: name });

  const callWorker = async (r: Request, retriesLeft = 3): Promise<Response> => {
    const retryReq = retriesLeft > 0 ? r.clone() : null;
    try {
      const worker = await EdgeRuntime.userWorkers.create({
        servicePath,
        memoryLimitMb: 150,
        // notify 每次最多跑 30 秒 + 收尾；wechat-mp 处理放在后台；都远小于这个上限
        workerTimeoutMs: 120_000,
        noModuleCache: false,
        envVars,
        context: { supervisor: { requestAbsentTimeoutMs: 60_000 } },
      });
      const userReq = new Request(r);
      EdgeRuntime.applySupabaseTag?.(r, userReq);
      return await worker.fetch(userReq);
    } catch (e) {
      const retired = (Deno.errors as Record<string, unknown>).WorkerAlreadyRetired as (new () => Error) | undefined;
      if (retired && e instanceof retired && retryReq) {
        EdgeRuntime.applySupabaseTag?.(r, retryReq);
        return await callWorker(retryReq, retriesLeft - 1);
      }
      console.error(`function ${name} failed:`, e);
      return fail(500, 'WORKER_ERROR', 'Function failed (please check logs)');
    }
  };

  return await callWorker(req);
});
