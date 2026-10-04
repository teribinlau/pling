#!/usr/bin/env node
// 把前端的提醒展开逻辑复制给云函数用（supabase/functions/_shared/core/）。
//   node scripts/sync-core.mjs           复制
//   node scripts/sync-core.mjs --check   只检查两边是否一致（CI 用），不一致退出码 1
// 改写：相对导入补 .ts 后缀（Deno 要求）；date-fns-tz 换成 npm: 依赖。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['types.ts', 'holidays.ts', 'recurrence.ts', 'occurrences.ts'];
const OUT = join(root, 'supabase/functions/_shared/core');
const HEADER = '// 自动生成：源文件在 src/lib/，改那边再跑 npm run sync:core，不要直接改这里。\n';

function transform(src) {
  return (
    HEADER +
    src
      .replace(/from '(\.\/[A-Za-z0-9_-]+)'/g, "from '$1.ts'")
      .replace(/from 'date-fns-tz'/g, "from 'npm:date-fns-tz@3.2.0'")
  );
}

const check = process.argv.includes('--check');
let stale = [];
mkdirSync(OUT, { recursive: true });
for (const f of FILES) {
  const out = transform(readFileSync(join(root, 'src/lib', f), 'utf8'));
  const target = join(OUT, f);
  const cur = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (cur === out) continue;
  if (check) stale.push(f);
  else writeFileSync(target, out);
}
if (check && stale.length) {
  console.error(`supabase/functions/_shared/core/ 和 src/lib/ 不一致：${stale.join(', ')}。请运行 npm run sync:core`);
  process.exit(1);
}
if (!check) console.log(`已同步 ${FILES.length} 个文件到 supabase/functions/_shared/core/`);
