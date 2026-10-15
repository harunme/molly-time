import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mp4Fixture } from './mp4-fixture';

test('MP4 duration reads bounded headers without decoding or reading the video body', async ({ page }) => {
  await page.goto('/manage/');
  const cases = [mp4Fixture(), mp4Fixture(1, 'vide', 5000000000n)];
  const result = await page.evaluate(async (samples) => {
    // @ts-expect-error Vite browser module.
    const { videoDuration } = await import('/manage/src/video-metadata.ts');
    const results = [];
    for (const sample of samples) {
      const bytes = Uint8Array.from(atob(sample), (c) => c.charCodeAt(0));
      const mdat = new Uint8Array(8); new DataView(mdat.buffer).setUint32(0, 8 * 1024 * 1024 + 8);
      mdat.set([109, 100, 97, 116], 4);
      const blob = new Blob([bytes.slice(0, 16), mdat, new Uint8Array(8 * 1024 * 1024), bytes.slice(16)]);
      const slice = blob.slice.bind(blob);
      let largestRead = 0;
      blob.slice = (start, end, type) => { largestRead = Math.max(largestRead, (end ?? blob.size) - (start ?? 0)); return slice(start, end, type); };
      blob.arrayBuffer = () => { throw new Error('Must not read entire video'); };
      results.push({ runtime: await videoDuration(blob), largestRead });
    }
    return results;
  }, cases.map((data) => data.toString('base64')));
  expect(result).toEqual([{ runtime: 1250, largestRead: 20 }, { runtime: 5000000000, largestRead: 32 }]);
});

test('invalid or audio-only MP4 metadata is rejected before uploading', async ({ page }) => {
  await page.goto('/manage/');
  const badSize = mp4Fixture(); badSize.writeUInt32BE(0xffffffff, 0);
  const cases = [Buffer.from('not a video'), mp4Fixture(0, 'soun'), mp4Fixture(0, 'vide', 0n), badSize];
  const errors = await page.evaluate(async (samples) => {
    // @ts-expect-error Vite browser module.
    const { videoDuration } = await import('/manage/src/video-metadata.ts');
    return Promise.all(samples.map(async (sample: string) => {
      try { await videoDuration(new Blob([Uint8Array.from(atob(sample), (c) => c.charCodeAt(0))])); return ''; }
      catch (error) { return (error as Error).message; }
    }));
  }, cases.map((data) => data.toString('base64')));
  expect(errors.every(Boolean)).toBe(true);
  expect(errors[1]).toContain('没有视频轨道');
  expect(errors[2]).toContain('有效视频时长');
});

test('browser generates a bounded JPEG from a real local video without API calls', async ({ page }) => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'molly-metadata-'));
  try {
    const path = join(dir, 'video.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=640x360:d=1', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', path]);
    await page.goto('/manage/');
    const result = await page.evaluate(async (encoded) => {
      // @ts-expect-error Vite browser module.
      const { prepareVideo } = await import('/manage/src/video-metadata.ts');
      return prepareVideo(new File([Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))], 'video.mp4'));
    }, readFileSync(path).toString('base64'));
    expect(result.runtimeMs).toBe(1000);
    expect(result.cover).toMatch(/^data:image\/jpeg;base64,/);
    expect(result.cover.length).toBeLessThan(350000);
  } finally { rmSync(dir, { recursive: true }); }
});

test('unsupported video decoding keeps metadata and falls back to the default cover', async ({ page }) => {
  await page.goto('/manage/');
  const result = await page.evaluate(async (encoded) => {
    // @ts-expect-error Vite browser module.
    const { prepareVideo } = await import('/manage/src/video-metadata.ts');
    return prepareVideo(new File([Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))], 'metadata-only.mp4'));
  }, mp4Fixture().toString('base64'));
  expect(result.runtimeMs).toBe(1250);
  expect(result.cover).toBeUndefined();
});
