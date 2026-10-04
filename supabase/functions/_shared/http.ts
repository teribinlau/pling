// HTTP 小工具：CORS、JSON / HTML 回应、统一的错误处理。
import { cfg, env } from './env.ts';

/** 允许跨域调用云函数的来源：网页版、桌面版（Tauri）、本机开发；PLING_CORS_ORIGINS 可以再加（逗号分隔） */
function allowedOrigins(): string[] {
  const extra = env('PLING_CORS_ORIGINS').split(',').map((s) => s.trim()).filter(Boolean);
  return [
    cfg.publicUrl(),
    'tauri://localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
    'http://localhost:1420',
    'http://127.0.0.1:1420',
    ...extra,
  ].filter(Boolean);
}

export function corsHeaders(req: Request): Headers {
  const h = new Headers({
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  });
  const origin = req.headers.get('origin');
  if (origin && allowedOrigins().includes(origin)) h.set('Access-Control-Allow-Origin', origin);
  return h;
}

export function json(req: Request, body: unknown, status = 200): Response {
  const h = corsHeaders(req);
  h.set('Content-Type', 'application/json; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export function text(body: string, status = 200, contentType = 'text/plain; charset=utf-8'): Response {
  return new Response(body, { status, headers: { 'Content-Type': contentType } });
}

export function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': 'no-store' } });
}

/** 业务错误：code 是给客户端看的英文代码，前端按代码翻译成中文 */
export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

/** 包一层：OPTIONS 预检直接回；HttpError → { error: code }；其他异常 → 500 */
export function serve(handler: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
    try {
      return await handler(req);
    } catch (e) {
      if (e instanceof HttpError) return json(req, { error: e.code, message: e.message }, e.status);
      console.error(e);
      return json(req, { error: 'internal' }, 500);
    }
  };
}

/** 读 JSON 请求体；不是 JSON → 400 */
export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, 'bad_json');
  }
}
