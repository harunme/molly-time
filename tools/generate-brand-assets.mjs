#!/usr/bin/env node
// Publish the approved filled m + flower and outlined Nunito ExtraBold wordmark.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'apps/site/package.json'));
const sharp = require('sharp');
await import('../assets/brand/mollytime-flower/build-kit.mjs');
const kit = 'assets/brand/mollytime-flower';
const read = file => readFile(resolve(root, kit, file), 'utf8');
const write = async (file, data) => {
  const target = resolve(root, file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
};
const copy = async (from, to) => write(to, await readFile(resolve(root, kit, from)));
const { jasmine, ivory, ink } = JSON.parse(await read('palette.json'));
const mark = await read('digital/mollytime-symbol-primary.svg');
const icon = await read('icons/app-icon.svg');
const horizontal = await read('digital/mollytime-horizontal-primary.svg');
const wordmark = await read('digital/mollytime-wordmark-ink.svg');
const wordmarkOnDark = await read('digital/mollytime-wordmark-ivory.svg');
const inner = source => source.replace(/^[\s\S]*?<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title\b[^>]*>[\s\S]*?<\/title>/g, '');
const paths = source => [...source.matchAll(/<path\b[^>]*\bd="([^"]+)"[^>]*\/>/g)].map(match => match[1]);
const markPaths = paths(mark);
const wordPaths = paths(wordmark);
if (markPaths.length !== 2 || wordPaths.length !== 9) throw new Error('Expected two symbol paths and nine outlined wordmark letters.');
const onDark = horizontal.replaceAll(ink, ivory);
const logoWidth = Number(horizontal.match(/viewBox="0 0 ([\d.]+)/)?.[1]);
if (!Number.isFinite(logoWidth) || logoWidth <= 0) throw new Error('Invalid horizontal logo viewBox.');
const bannerScale = 896 / logoWidth;
const bannerY = (720 - 256 * bannerScale) / 2;
const banner = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><title>MollyTime</title><rect width="1280" height="720" fill="${ivory}"/><g transform="translate(192 ${bannerY}) scale(${bannerScale})">${inner(horizontal)}</g></svg>\n`;
const assets = {
  'mollytime-mark.svg': mark,
  'mollytime-icon.svg': icon,
  'mollytime-icon-transparent.svg': await read('icons/app-icon-transparent.svg'),
  'mollytime-animated.svg': await read('motion/mollytime-animated.svg'),
  'mollytime-banner.svg': banner,
  'mollytime-horizontal.svg': horizontal,
  'mollytime-horizontal-on-dark.svg': onDark,
  'mollytime-stacked.svg': await read('digital/mollytime-stacked-primary.svg'),
  'mollytime-wordmark.svg': wordmark,
  'mollytime-wordmark-on-dark.svg': wordmarkOnDark,
};
for (const file of await readdir(resolve(root, kit, 'digital'))) {
  if (file.endsWith('.svg')) assets[file] = await read(`digital/${file}`);
}
for (const [name, svg] of Object.entries(assets)) {
  await write(`assets/brand/${name}`, svg);
  for (const app of ['site', 'web', 'tv/web']) await write(`apps/${app}/public/brand/${name}`, svg);
}
for (const app of ['web', 'tv/web']) {
  await copy('web/favicon.svg', `apps/${app}/public/favicon.svg`);
  await copy('web/favicon.ico', `apps/${app}/public/favicon.ico`);
}
await copy('web/favicon.svg', 'apps/site/src/assets/favicons/favicon.svg');
await copy('web/favicon.ico', 'apps/site/src/assets/favicons/favicon.ico');
await copy('web/apple-touch-icon.png', 'apps/site/src/assets/favicons/apple-touch-icon.png');
await copy('digital/mollytime-symbol-black.svg', 'apps/site/src/assets/favicons/mask-icon.svg');
for (const [from, to] of Object.entries({
  'web/icon-192.png': 'icon-192.png',
  'web/icon-512.png': 'icon-512.png',
  'web/icon-maskable-512.png': 'maskable-512.png',
  'web/apple-touch-icon.png': 'apple-touch-icon.png',
})) await copy(from, `apps/web/public/icons/${to}`);
const manifestPath = 'apps/web/public/manifest.webmanifest';
const manifest = JSON.parse(await readFile(resolve(root, manifestPath), 'utf8'));
manifest.background_color = ivory;
manifest.theme_color = ivory;
await write(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
await write('apps/tv/client/src/main/res/drawable-nodpi/mollytime_icon.png',
  await sharp(Buffer.from(await read('icons/app-icon-transparent.svg'))).resize(1024, 1024).png().toBuffer());
await write('apps/tv/client/src/main/res/drawable-nodpi/mollytime_banner.png', await sharp(Buffer.from(banner)).resize(1280, 720).png().toBuffer());
await write('apps/tv/client/src/main/res/values/colors.xml', `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="launcher_background">#00000000</color>
</resources>
`);
const nativePaths = (data, color) => data.map(d => `<path android:pathData="${d}" android:fillColor="${color}" />`).join('\n        ');
const nativeSymbol = nativePaths(markPaths, jasmine);
const vector = (width, height, viewportWidth, viewportHeight, contents) => `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="${width}dp" android:height="${height}dp" android:viewportWidth="${viewportWidth}" android:viewportHeight="${viewportHeight}">
    ${contents}
</vector>
`;
await write('apps/tv/client/src/main/res/drawable/app_mark.xml', vector(108, 108, 256, 256,
  `<group android:pivotX="128" android:pivotY="128" android:rotation="-25" android:scaleX="0.70" android:scaleY="0.70">${nativeSymbol}</group>`));
await write('apps/tv/client/src/main/res/drawable/app_logo.xml', vector(108, 108, 256, 256,
  `<group android:pivotX="128" android:pivotY="128" android:rotation="-25" android:translateX="-8" android:translateY="2" android:scaleX="1.02" android:scaleY="1.02">${nativeSymbol}</group>`));
// Use the same transparent drawable on every API level. An adaptive icon
// introduces a launcher background/mask even when the logo itself has alpha.
const launcher = `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:width="48dp" android:height="48dp" android:gravity="center"
        android:drawable="@drawable/app_logo" />
</layer-list>
`;
for (const directory of ['mipmap-anydpi', 'mipmap-anydpi-v26']) {
  await write(`apps/tv/client/src/main/res/${directory}/ic_launcher.xml`, launcher);
}
await write('apps/tv/client/src/main/res/drawable/app_banner.xml', vector(320, 180, 1280, 720,
  `<path android:fillColor="${ivory}" android:pathData="M0 0H1280V720H0Z" />
    <group android:translateX="192" android:translateY="${bannerY}" android:scaleX="${bannerScale}" android:scaleY="${bannerScale}">
      ${nativeSymbol}
      <group android:translateX="288" android:translateY="52" android:scaleX="1.5" android:scaleY="1.5">${nativePaths(wordPaths, ink)}</group>
    </group>`));
process.stdout.write('Published MollyTime jasmine logo, wordmarks, web icons and Android artwork.\n');
