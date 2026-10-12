import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';

for (const mode of ['native', 'no-subtle', 'no-crypto'] as const) {
  test(`upload SHA-256 agrees with server hashing: ${mode}`, async ({ page }) => {
    if (mode !== 'native') {
      await page.addInitScript((selected) => {
        if (selected === 'no-crypto') {
          Object.defineProperty(window, 'crypto', { value: undefined });
        } else {
          Object.defineProperty(Crypto.prototype, 'subtle', { get: () => undefined });
        }
      }, mode);
    }
    await page.goto('/manage/');
    const sizes = [0, 3, 55, 56, 64, 8 * 1024 ** 2 + 1];
    const expected = sizes.map((size) => {
      const bytes = Buffer.alloc(size);
      for (let i = 0; i < size; i++) bytes[i] = (i * 17 + 97) % 256;
      return createHash('sha256').update(bytes).digest('hex');
    });
    const actual = await page.evaluate(async ({ sizes, mode }) => {
      if (mode === 'native' && !globalThis.crypto?.subtle) throw new Error('Native path unavailable');
      const moduleURL = '/manage/src/file-hash.ts';
      const { sha256Blob } = await import(/* @vite-ignore */ moduleURL);
      const hashes: string[] = [];
      for (const size of sizes) {
        const bytes = new Uint8Array(size);
        for (let i = 0; i < size; i++) bytes[i] = (i * 17 + 97) % 256;
        hashes.push(await sha256Blob(new Blob([bytes])));
      }
      return hashes;
    }, { sizes, mode });
    expect(actual).toEqual(expected);
  });
}
