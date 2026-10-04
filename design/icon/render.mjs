// 从 SVG 生成全部图标：node design/icon/render.mjs（需要 devDependencies 里的 sharp）
//   public/            PWA：icon.svg（直接用源文件）、icon-192 / 512、maskable、apple-touch-icon
//   design/icon/       pling-1024.png（给 `npx tauri icon` 当源图）
import sharp from 'sharp';
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const src = join(here, 'pling.svg');
const maskable = join(here, 'pling-maskable.svg');
const png = (file, size, out) => sharp(file, { density: Math.ceil((72 * size) / 512) * 2 }).resize(size, size).png().toFile(out);

await png(src, 1024, join(here, 'pling-1024.png'));
await png(src, 192, join(root, 'public/icon-192.png'));
await png(src, 512, join(root, 'public/icon-512.png'));
await png(maskable, 512, join(root, 'public/icon-maskable-512.png'));
await png(maskable, 180, join(root, 'public/apple-touch-icon.png'));
copyFileSync(src, join(root, 'public/icon.svg'));
console.log('icons written');
