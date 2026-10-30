import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

test('covers reuse the browser cache and replacement artwork gets a new URL', async ({ page }) => {
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible();
  const session = await (await page.request.get('/api/manage/auth/session')).json();
  const headers = { 'X-CSRF-Token': session.csrfToken };

  const upload = async (color: string) => {
    const data = execFileSync('../server/.venv/bin/python', ['-c',
      'import io,sys; from PIL import Image; b=io.BytesIO(); Image.new("RGB",(64,36),sys.argv[1]).save(b,"PNG"); sys.stdout.buffer.write(b.getvalue())', color]);
    const fingerprint = createHash('sha256').update(data).digest('hex');
    const created = await page.request.post('/api/manage/uploads', { headers, data: {
      itemId: 'series', filename: `${color}.png`, kind: 'image', size: data.length, fingerprint,
    } });
    expect(created.ok()).toBe(true);
    const row = await created.json();
    expect((await page.request.put(`/api/manage/uploads/${row.id}/chunks?offset=0`, {
      headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': fingerprint }, data,
    })).ok()).toBe(true);
    expect((await page.request.post(`/api/manage/uploads/${row.id}/complete`, { headers })).ok()).toBe(true);
    const resource = await (await page.request.get('/api/manage/resources/series')).json();
    return resource.imageUrl as string;
  };

  const read = (path: string) => page.evaluate(async path => {
    const url = new URL(path, location.origin).href;
    performance.clearResourceTimings();
    const response = await fetch(url);
    const blob = await response.blob();
    const timing = performance.getEntriesByName(url).at(-1) as PerformanceResourceTiming;
    return { status: response.status, size: blob.size, transferred: timing.transferSize,
      etag: response.headers.get('etag'), cache: response.headers.get('cache-control') };
  }, path);

  const original = await upload('blue');
  const first = await read(original);
  expect(first.status).toBe(200);
  expect(first.cache).toBe('private, max-age=86400');
  expect(first.transferred).toBeGreaterThan(0);
  const cached = await read(original);
  expect(cached.size).toBe(first.size);
  expect(cached.etag).toBe(first.etag);
  expect(cached.transferred).toBe(0);

  // A new document still uses the same browser cache.
  await page.goto('/manage/#/overview');
  expect((await read(original)).transferred).toBe(0);
  const replacement = await upload('red');
  expect(replacement).not.toBe(original);
  const updated = await read(replacement);
  expect(updated.etag).not.toBe(first.etag);
  expect(updated.transferred).toBeGreaterThan(0);
});
