import { test, expect, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/manage/#/library');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '资源库', exact: true })).toBeVisible();
}
async function pending(page: Page) {
  return page.evaluate(async () => {
    const uploads = await import(/* @vite-ignore */ '/manage/src/uploads.ts');
    return [...uploads.live.entries()].map(([id, state]: [string, { paused: boolean; error: string }]) => ({ id, ...state }));
  });
}

test('saved local files resume after reload without reselecting and are removed on completion', async ({ page }) => {
  await login(page);
  let failing = true;
  await page.route('**/api/manage/uploads/*/chunks?*', route => failing ? route.fulfill({ status: 503, json: { detail: '临时断网' } }) : route.continue());
  await page.evaluate(async () => {
    const { enqueue } = await import(/* @vite-ignore */ '/manage/src/uploads.ts');
    const { api } = await import(/* @vite-ignore */ '/manage/src/api.ts');
    const item = await api('/resources', 'POST', { type: 'Episode', parentId: 'season', name: `恢复检查 ${crypto.randomUUID()}` });
    await enqueue(new File(['1\n00:00:00,000 --> 00:00:01,000\nHello\n'], 'recovery.srt'), item.id, 'subtitle', 'en');
  });
  await expect.poll(async () => (await pending(page))[0]?.paused).toBe(true);
  const id = (await pending(page))[0].id;
  expect(await page.evaluate(async () => {
    const { storedUploads } = await import(/* @vite-ignore */ '/manage/src/upload-store.ts');
    return (await storedUploads()).map((row: { owner: string; file: File }) => ({ owner: row.owner, name: row.file.name, size: row.file.size }));
  })).toEqual([expect.objectContaining({ owner: 'family:parent', name: 'recovery.srt', size: 38 })]);
  failing = false;
  const complete = page.waitForResponse(response => response.url().endsWith(`/uploads/${id}/complete`) && response.ok());
  await page.reload();
  await complete;
  await expect.poll(() => pending(page)).toEqual([]);
  await expect.poll(() => page.evaluate(async () => (await (await import(/* @vite-ignore */ '/manage/src/upload-store.ts')).storedUploads()).length)).toBe(0);
});

test('online recovery resumes network failures while explicit pauses stay paused across a reload', async ({ page }) => {
  await login(page);
  let failing = true;
  await page.route('**/api/manage/uploads/*/chunks?*', route => failing ? route.abort('internetdisconnected') : route.continue());
  await page.evaluate(async () => {
    const { enqueue } = await import(/* @vite-ignore */ '/manage/src/uploads.ts');
    const { api } = await import(/* @vite-ignore */ '/manage/src/api.ts');
    const item = await api('/resources', 'POST', { type: 'Episode', parentId: 'season', name: `恢复检查 ${crypto.randomUUID()}` });
    await enqueue(new File(['1\n00:00:00,000 --> 00:00:01,000\nHello\n'], 'online.srt'), item.id, 'subtitle', 'en');
  });
  await expect.poll(async () => !!(await pending(page))[0]?.error).toBe(true);
  await page.evaluate(async () => {
    const uploads = await import(/* @vite-ignore */ '/manage/src/uploads.ts');
    uploads.pause([...uploads.live.keys()][0]);
  });
  await page.reload();
  await expect.poll(async () => (await pending(page))[0]?.paused).toBe(true);
  failing = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  expect((await pending(page))[0].paused).toBe(true);
  await page.evaluate(async () => {
    const uploads = await import(/* @vite-ignore */ '/manage/src/uploads.ts');
    const id = [...uploads.live.keys()][0];
    const row = await (await fetch(`/api/manage/uploads/${id}`)).json();
    await uploads.resume(row);
  });
  await expect.poll(() => pending(page)).toEqual([]);
});

test('reconnection automatically continues failed uploads and logout removes this account’s local copies', async ({ page }) => {
  await login(page);
  let failing = true;
  await page.route('**/api/manage/uploads/*/chunks?*', route => failing ? route.abort('internetdisconnected') : route.continue());
  const enqueue = () => page.evaluate(async () => {
    const uploads = await import(/* @vite-ignore */ '/manage/src/uploads.ts');
    const { api } = await import(/* @vite-ignore */ '/manage/src/api.ts');
    const item = await api('/resources', 'POST', { type: 'Episode', parentId: 'season', name: `恢复检查 ${crypto.randomUUID()}` });
    await uploads.enqueue(new File(['1\n00:00:00,000 --> 00:00:01,000\nHello\n'], 'reconnect.srt'), item.id, 'subtitle', 'en');
  });
  await enqueue();
  await expect.poll(async () => !!(await pending(page))[0]?.error).toBe(true);
  failing = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => pending(page)).toEqual([]);
  failing = true;
  await enqueue();
  await expect.poll(async () => !!(await pending(page))[0]?.error).toBe(true);
  await page.getByRole('button', { name: '账号菜单' }).click();
  await page.getByRole('menuitem', { name: /退出/ }).click();
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await (await import(/* @vite-ignore */ '/manage/src/upload-store.ts')).storedUploads()).length)).toBe(0);
});

test('unavailable local storage falls back to explicit file reselect and never claims an upload is running', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { get() { throw new Error('Storage unavailable'); } }); });
  await login(page);
  await page.route('**/api/manage/uploads/*/chunks?*', route => route.abort('internetdisconnected'));
  await page.evaluate(async () => {
    const { enqueue } = await import(/* @vite-ignore */ '/manage/src/uploads.ts');
    const { api } = await import(/* @vite-ignore */ '/manage/src/api.ts');
    const item = await api('/resources', 'POST', { type: 'Episode', parentId: 'season', name: `恢复检查 ${crypto.randomUUID()}` });
    await enqueue(new File(['1\n00:00:00,000 --> 00:00:01,000\nHello\n'], 'fallback.srt'), item.id, 'subtitle', 'en');
  });
  await expect.poll(async () => (await pending(page))[0]?.recovery).toContain('重新选择原文件');
  await page.reload();
  await expect(page.getByRole('button', { name: '上传任务', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '上传任务', exact: true }).click();
  await expect(page.locator('.upload-task').filter({ hasText: 'fallback.srt' }).getByText('等待重新选择原文件以续传，已上传进度会保留。')).toBeVisible();
});

test('a delayed unauthorized response cannot expire a newer login', async ({ page }) => {
  await login(page);
  await page.route('**/api/manage/stale-auth', route => route.fulfill({ status: 401, json: { detail: '旧会话已失效' } }));
  expect(await page.evaluate(async () => {
    const { api, setSession } = await import(/* @vite-ignore */ '/manage/src/api.ts');
    const session = await api('/auth/session');
    let expired = 0;
    const listener = () => expired++;
    window.addEventListener('mollytime:unauthorized', listener);
    const stale = api('/stale-auth').catch(() => {});
    setSession({ ...session, csrfToken: 'new-session-token' });
    await stale;
    window.removeEventListener('mollytime:unauthorized', listener);
    setSession(session);
    return expired;
  })).toBe(0);
  await expect(page.getByRole('heading', { name: '资源库', exact: true })).toBeVisible();
});
