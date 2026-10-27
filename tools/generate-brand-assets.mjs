#!/usr/bin/env node
// Generate launcher artwork and favicons from the single flat M vector.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'apps/site/package.json'));
const sharp = require('sharp');
const mark = await readFile(resolve(root, 'assets/brand/mollytime-mark.svg'), 'utf8');
const path = mark.match(/<path\b[^>]*\/>/)?.[0];
if (!path) throw new Error('The brand mark must contain one SVG path.');
const attribute = name => {
  const value = path.match(new RegExp(`${name}="([^"]+)"`))?.[1];
  if (!value) throw new Error(`Missing mark attribute: ${name}`);
  return value;
};
const background = '#FFD000';
const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" fill="none"><title>MollyTime</title><rect width="128" height="128" rx="28" fill="${background}"/>${path}</svg>\n`;
const banner = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" fill="none"><title>MollyTime</title><rect width="1280" height="720" fill="${background}"/><g transform="translate(320 40) scale(5)">${path}</g></svg>\n`;
const write = async (destination, contents) => {
  const target = resolve(root, destination);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
};
const raster = (source, size) => sharp(Buffer.from(source)).resize(size, size).png().toBuffer();

await write('assets/brand/mollytime-icon.svg', icon);
await write('assets/brand/mollytime-banner.svg', banner);
await write('apps/tv/client/src/main/res/drawable-nodpi/mollytime_icon.png', await raster(icon, 1024));
await write('apps/tv/client/src/main/res/drawable-nodpi/mollytime_banner.png', await sharp(Buffer.from(banner)).png().toBuffer());
await write('apps/site/src/assets/favicons/favicon.svg', icon);
await write('apps/site/src/assets/favicons/mask-icon.svg', mark);
await write('apps/site/src/assets/favicons/apple-touch-icon.png', await raster(icon, 180));
await write('apps/web/public/favicon.svg', icon);
await write('apps/tv/web/public/favicon.svg', icon);
for (const app of ['web', 'tv/web', 'site']) {
  await write(`apps/${app}/public/brand/mollytime-mark.svg`, mark);
  await write(`apps/${app}/public/brand/mollytime-icon.svg`, icon);
  await write(`apps/${app}/public/brand/mollytime-banner.svg`, banner);
}

// ICO supports PNG-compressed frames; keep small browser sizes crisp.
const sizes = [16, 32, 48, 64];
const frames = await Promise.all(sizes.map(size => raster(icon, size)));
const directory = Buffer.alloc(6 + 16 * frames.length);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(frames.length, 4);
let offset = directory.length;
frames.forEach((frame, index) => {
  const entry = 6 + index * 16;
  directory[entry] = sizes[index]; directory[entry + 1] = sizes[index];
  directory.writeUInt16LE(1, entry + 4); directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(frame.length, entry + 8); directory.writeUInt32LE(offset, entry + 12);
  offset += frame.length;
});
await write('apps/site/src/assets/favicons/favicon.ico', Buffer.concat([directory, ...frames]));
await write('apps/tv/client/src/main/res/values/colors.xml', `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="launcher_background">${background}</color>
</resources>
`);

// Keep the foreground inside Android's adaptive-icon safe circle.
await write('apps/tv/client/src/main/res/drawable/app_mark.xml', `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp"
    android:viewportWidth="128" android:viewportHeight="128">
    <group android:pivotX="64" android:pivotY="64" android:scaleX="0.55" android:scaleY="0.55">
        <path android:pathData="${attribute('d')}"
            android:fillColor="#00000000" android:strokeColor="${attribute('stroke')}"
            android:strokeWidth="${attribute('stroke-width')}" android:strokeLineCap="round" android:strokeLineJoin="round" />
    </group>
</vector>
`);
const nativeMark = `android:pathData="${attribute('d')}" android:fillColor="#00000000" android:strokeColor="${attribute('stroke')}" android:strokeWidth="${attribute('stroke-width')}" android:strokeLineCap="round" android:strokeLineJoin="round"`;
await write('apps/tv/client/src/main/res/drawable/app_logo.xml', `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp" android:viewportWidth="128" android:viewportHeight="128">
    <path android:fillColor="${background}" android:pathData="M28 0H100A28 28 0 0 1 128 28V100A28 28 0 0 1 100 128H28A28 28 0 0 1 0 100V28A28 28 0 0 1 28 0Z" />
    <path ${nativeMark} />
</vector>
`);
await write('apps/tv/client/src/main/res/drawable/app_banner.xml', `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="320dp" android:height="180dp" android:viewportWidth="1280" android:viewportHeight="720">
    <path android:fillColor="${background}" android:pathData="M0 0H1280V720H0Z" />
    <group android:translateX="320" android:translateY="40" android:scaleX="5" android:scaleY="5">
        <path ${nativeMark} />
    </group>
</vector>
`);
process.stdout.write('Generated MollyTime M launcher artwork and web favicons.\n');
