import { test, expect, type Locator } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const apiOrigin = process.env.MOLLYTIME_TEST_API_ORIGIN || 'http://127.0.0.1:8098';
const python = '../server/.venv/bin/python';

async function channel(image: Locator) {
  const bytes = await image.screenshot();
  const pixel = JSON.parse(execFileSync(python, ['-c',
    'import io,json,sys; from PIL import Image; i=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGB"); print(json.dumps(i.getpixel((i.width//2,i.height//2))))'],
  { input: bytes }).toString()) as number[];
  return pixel.indexOf(Math.max(...pixel));
}

test('legacy animated covers retain a first-frame fallback and loop on hover/focus in both apps', async ({ page }, testInfo) => {
  const data = execFileSync(python, ['-c', 'import io,sys; from PIL import Image; f=[Image.new("RGB",(160,90),c) for c in ["red","lime","blue"]]; b=io.BytesIO(); f[0].save(b,format="WEBP",save_all=True,append_images=f[1:],duration=[600,600,600],loop=0,lossless=True); sys.stdout.buffer.write(b.getvalue())']);
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible();
  const session = await (await page.request.get('/api/manage/auth/session')).json();
  const headers = { 'X-CSRF-Token': session.csrfToken };
  const upload = await (await page.request.post('/api/manage/uploads', { headers, data: {
    itemId: 'series', filename: 'animation.webp', kind: 'image', size: data.length, fingerprint: 'animated-cover',
  } })).json();
  expect((await page.request.put(`/api/manage/uploads/${upload.id}/chunks?offset=0`, {
    headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': createHash('sha256').update(data).digest('hex') }, data,
  })).ok()).toBe(true);
  expect((await page.request.post(`/api/manage/uploads/${upload.id}/complete`, { headers })).ok()).toBe(true);
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '资源库', exact: true }).click();
  const parentCard = page.getByRole('button', { name: '打开 英语启蒙', exact: true });
  const parentImage = parentCard.locator('img');
  await expect(parentImage).toBeVisible();
  await expect.poll(() => channel(parentImage)).toBe(0);
  await parentCard.hover();
  await expect(parentImage).toHaveAttribute('data-preview', 'true');
  await expect.poll(() => channel(parentImage)).toBe(1);
  await expect.poll(() => channel(parentImage)).toBe(2);
  await expect.poll(() => channel(parentImage)).toBe(1);
  await expect.poll(() => channel(parentImage)).toBe(2);
  await parentImage.screenshot({ path: testInfo.outputPath('parent-preview-loop.png') });
  await page.mouse.move(0, 0);
  await expect.poll(() => channel(parentImage)).toBe(0);
  await parentCard.hover();
  await expect.poll(() => channel(parentImage)).toBe(1);
  await expect.poll(() => channel(parentImage)).toBe(2);
  await page.mouse.move(0, 0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await parentCard.hover();
  await expect(parentImage).not.toHaveAttribute('data-preview', 'true');
  expect(await channel(parentImage)).toBe(0);

  const auth = await (await page.request.post(`${apiOrigin}/api/auth/login`, {
    headers: { 'X-Molly-Client': 'tv-shell/2' }, data: { username: 'parent@example.test', password: 'parent-e2e' },
  })).json();
  const tv = await page.context().newPage();
  await tv.addInitScript(binding => localStorage.setItem('mollytime.tv.binding.v1', JSON.stringify(binding)), {
    accessToken: auth.accessToken, refreshToken: auth.refreshToken, deviceId: auth.deviceId,
  });
  await tv.goto(`${apiOrigin}/tv/`);
  const tvCard = tv.locator('[data-focus="series-series"]');
  const tvImage = tvCard.locator('.cover img');
  await expect(tvImage).toBeVisible();
  await tv.getByRole('button', { name: '打开设置', exact: true }).focus();
  await expect.poll(() => channel(tvImage)).toBe(0);
  await tvCard.hover();
  await expect(tvImage).toHaveAttribute('data-preview', 'true');
  await expect.poll(() => channel(tvImage)).toBe(1);
  await expect.poll(() => channel(tvImage)).toBe(2);
  await expect.poll(() => channel(tvImage)).toBe(1);
  await expect.poll(() => channel(tvImage)).toBe(2);
  await tvImage.screenshot({ path: testInfo.outputPath('tv-preview-loop.png') });
  await tv.mouse.move(0, 0);
  await expect.poll(() => channel(tvImage)).toBe(0);
  // Spatial navigation adds .focused without relying on browser DOM focus.
  await tvCard.focus();
  await expect(tvCard).toHaveClass(/focused/);
  await expect(tvImage).toHaveAttribute('data-preview', 'true');
  await expect.poll(() => channel(tvImage)).toBe(2);
  await tv.getByRole('button', { name: '打开设置', exact: true }).focus();
  await expect.poll(() => channel(tvImage)).toBe(0);
});

test('static posters and complete motion previews upload independently in both apps', async ({ page }) => {
  const animation = execFileSync(python, ['-c', 'import io,sys; from PIL import Image; f=[Image.new("RGB",(160,90),c) for c in ["red","lime"]]; b=io.BytesIO(); f[0].save(b,format="WEBP",save_all=True,append_images=f[1:],duration=[700,700],loop=0,lossless=True); sys.stdout.buffer.write(b.getvalue())']);
  const poster = execFileSync(python, ['-c', 'import io,sys; from PIL import Image; b=io.BytesIO(); Image.new("RGB",(160,90),"blue").save(b,"PNG"); sys.stdout.buffer.write(b.getvalue())']);
  await page.goto('/manage/#/library');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '资源库', exact: true })).toBeVisible();
  const card = page.getByRole('button', { name: '打开 英语启蒙', exact: true });
  const tile = page.locator('.resource-tile').filter({ has: card });
  const choose = async (action: string, name: string, mimeType: string, buffer: Buffer) => {
    await tile.getByRole('button', { name: '更多操作 英语启蒙', exact: true }).click();
    const picker = page.waitForEvent('filechooser');
    await page.getByRole('menuitem', { name: action, exact: true }).click();
    const complete = page.waitForResponse(response => response.url().endsWith('/complete') && response.request().method() === 'POST');
    await (await picker).setFiles({ name, mimeType, buffer });
    return complete;
  };
  expect((await choose('上传封面', 'poster.png', 'image/png', poster)).ok()).toBe(true);
  expect((await choose('上传动态预览', 'motion.webp', 'image/webp', animation)).ok()).toBe(true);
  await expect.poll(async () => (await (await page.request.get('/api/manage/resources/series')).json()).hasOwnPreview).toBe(true);
  const image = card.locator('img');
  await page.mouse.move(0, 0);
  await expect.poll(() => channel(image)).toBe(2);
  await card.hover();
  await expect(image).toHaveAttribute('data-preview', 'true');
  await expect.poll(() => channel(image)).toBe(0); // The first animation frame is retained.
  await expect.poll(() => channel(image)).toBe(1);
  await expect.poll(() => channel(image)).toBe(0); // It loops, independently of the blue poster.
  await page.mouse.move(0, 0);
  await expect.poll(() => channel(image)).toBe(2);

  const auth = await (await page.request.post(`${apiOrigin}/api/auth/login`, {
    headers: { 'X-Molly-Client': 'tv-shell/2' }, data: { username: 'parent@example.test', password: 'parent-e2e' },
  })).json();
  const tv = await page.context().newPage();
  await tv.addInitScript(binding => localStorage.setItem('mollytime.tv.binding.v1', JSON.stringify(binding)), {
    accessToken: auth.accessToken, refreshToken: auth.refreshToken, deviceId: auth.deviceId,
  });
  await tv.goto(`${apiOrigin}/tv/`);
  const tvCard = tv.locator('[data-focus="series-series"]'), tvImage = tvCard.locator('.cover img');
  await expect(tvImage).toBeVisible();
  await tv.getByRole('button', { name: '打开设置', exact: true }).focus();
  await expect.poll(() => channel(tvImage)).toBe(2);
  await tvCard.focus();
  await expect(tvImage).toHaveAttribute('data-preview', 'true');
  await expect.poll(() => channel(tvImage)).toBe(0);
  await expect.poll(() => channel(tvImage)).toBe(1);
  await expect.poll(() => channel(tvImage)).toBe(0);
  await tv.getByRole('button', { name: '打开设置', exact: true }).focus();
  await expect.poll(() => channel(tvImage)).toBe(2);

  expect((await choose('上传动态预览', 'still.png', 'image/png', poster)).status()).toBe(422);
  await expect(tile.getByRole('alert')).toContainText('动态预览需要多帧');
  await page.mouse.move(0, 0);
  await expect.poll(() => channel(image)).toBe(2);
  await tile.getByRole('button', { name: '更多操作 英语启蒙', exact: true }).click();
  await page.getByRole('menuitem', { name: '移除动态预览', exact: true }).click();
  await expect.poll(async () => (await (await page.request.get('/api/manage/resources/series')).json()).hasOwnPreview).toBe(false);
  await card.hover();
  await expect(image).not.toHaveAttribute('data-preview', 'true');
  expect(await channel(image)).toBe(2);
});
