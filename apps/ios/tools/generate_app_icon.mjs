#!/usr/bin/env node
// iOS home-screen variant of the existing MollyTime vector mark.
// Render an opaque square: iOS applies its own corner mask and surface treatment.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(resolve(root, 'apps/site/package.json'));
const sharp = require('sharp');
const source = await readFile(resolve(root, 'assets/brand/mollytime-symbol-ink.svg'), 'utf8');
const paths = source.match(/<path\b[^>]*\/>/g)?.join('');
if (!paths) throw new Error('The canonical mark must contain vector paths.');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><title>MollyTime iOS app icon</title><rect width="256" height="256" fill="#211F1B"/><g fill="#F8DE7E" transform="translate(128 128) rotate(-15) scale(0.92) translate(-133 -130)">${paths}</g></svg>\n`;
const brand = resolve(root, 'apps/ios/Brand');
await mkdir(brand, { recursive: true });
await writeFile(resolve(brand, 'app-icon.svg'), svg);
await sharp(Buffer.from(svg)).resize(1024, 1024).flatten({ background: '#211F1B' }).removeAlpha()
  .png().toFile(resolve(root, 'apps/ios/MollyTime/Assets.xcassets/AppIcon.appiconset/icon.png'));
console.log('Generated opaque 1024 × 1024 iOS app icon.');
