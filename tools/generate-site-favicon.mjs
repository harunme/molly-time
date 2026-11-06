#!/usr/bin/env node
// Keep SVG and legacy ICO browser-tab icons on the approved transparent artwork.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const sharp = createRequire(new URL('../apps/site/package.json', import.meta.url))('sharp');
const artwork = await readFile(new URL('../assets/brand/mollytime-icon-transparent.svg', import.meta.url));
const target = new URL('../apps/site/src/assets/favicons/', import.meta.url);
const sizes = [16, 32, 48, 64];
const frames = await Promise.all(sizes.map(size => sharp(artwork).resize(size, size).png().toBuffer()));
const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
frames.forEach((frame, index) => {
  const entry = 6 + index * 16;
  directory[entry] = directory[entry + 1] = sizes[index];
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(frame.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += frame.length;
});
await writeFile(new URL('favicon.svg', target), artwork);
await writeFile(new URL('favicon.ico', target), Buffer.concat([directory, ...frames]));
