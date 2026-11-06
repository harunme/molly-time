import { test, expect, type Page } from '@playwright/test';

// Content checks wait for the real entrance to finish; lifecycle cases live in startup.spec.ts.
async function visit(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('#startup-intro')).toBeHidden({ timeout: 6000 });
}

async function capture(page: Page, path: string) {
  await page.evaluate(async () => {
    document.querySelectorAll<HTMLImageElement>('img').forEach((image) => { image.loading = 'eager'; });
    await Promise.all(Array.from(document.images).map((image) => image.decode()));
    for (const image of document.images) {
      image.scrollIntoView();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    window.scrollTo(0, 0);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect.poll(() => page.evaluate(() => Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0))).toBe(true);
  await page.screenshot({ path, fullPage: true });
}

test('homepage has minimal header, download entries, metadata and no browser errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await visit(page, '/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('你挑的好故事，孩子的小世界。');
  await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', 'https://mollytime.app');
  await expect(page.getByRole('link', { name: '使用网页版家长后台' })).toHaveCount(0);
  await expect(page.locator('#download-android-button')).toHaveCSS('background-color', 'rgb(248, 222, 126)');
  await expect(page.locator('#download-android-button')).toHaveCSS('color', 'rgb(63, 58, 50)');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(250, 250, 244)');
  await expect(page.locator('header a')).toHaveCount(1);
  await expect(page.locator('header button')).toHaveCount(1);
  await expect(page.locator('header nav')).toHaveCount(0);
  await page.locator('#features').scrollIntoViewIfNeeded();
  await expect(page.locator('#features .section-heading')).toHaveCSS('opacity', '1');
  await page.getByRole('button', { name: '切换深浅色主题' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.locator('#download-android-button')).toHaveCSS('color', 'rgb(63, 58, 50)');
  await expect(page.getByRole('button', { name: '下载电视端' })).toHaveCSS('color', 'rgb(246, 244, 233)');
  await capture(page, 'test-results/dark.png');
  await page.getByRole('button', { name: '切换深浅色主题' }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  expect(errors).toEqual([]);
  const share = await page.request.get('/site/share.png');
  expect(share.status()).toBe(200);
  expect(share.headers()['content-type']).toContain('image/png');
  await visit(page, '/');
  await capture(page, 'test-results/desktop.png');
});

test('minimal header and download remain usable at narrow phone widths', async ({ page }) => {
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await visit(page, '/');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const cta = await page.locator('#download-android-button').boundingBox();
    expect(cta && cta.y + cta.height).toBeLessThan(844);
    for (const entry of [page.locator('#download-button')]) {
      const bounds = await entry.boundingBox();
      expect(bounds && bounds.y + bounds.height).toBeLessThan(844);
    }
    await expect(page.locator('header a')).toHaveCount(1);
    await expect(page.locator('header button')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '打开导航菜单' })).toHaveCount(0);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await visit(page, '/');
  await page.getByRole('button', { name: '切换深浅色主题' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator('#startup-intro')).toBeHidden({ timeout: 6000 });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('button', { name: '切换深浅色主题' }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await capture(page, 'test-results/mobile.png');
});

test('story garden floats independently of copy and pauses offscreen', async ({ page }) => {
  await page.setViewportSize({width:1440,height:700});
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await visit(page, '/');
  const art = page.locator('.story-garden');
  await art.locator('img').evaluate((element: HTMLImageElement) => element.decode());
  // Entry may finish near the float's resting crest; measure from a known phase.
  await art.evaluate(element => element.getAnimations().forEach(animation => { animation.currentTime = 0; }));
  const initial = await art.boundingBox();
  if (!initial) throw new Error('Story garden is not visible');
  const copy = await page.locator('.hero-copy').boundingBox();
  const button = await page.locator('#download-android-button').boundingBox();
  await expect.poll(async () => Math.abs((await art.boundingBox())!.y - initial.y), { timeout: 10000 }).toBeGreaterThan(3);
  expect(await page.locator('.hero-copy').boundingBox()).toEqual(copy);
  expect(await page.locator('#download-android-button').boundingBox()).toEqual(button);
  await page.locator('footer').scrollIntoViewIfNeeded();
  await expect.poll(() => art.evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(0);
  await expect(art).toHaveCSS('animation-play-state', 'paused');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(art).toHaveCSS('animation-name', 'none');
  await expect(art).toHaveCSS('transform', 'none');
});

test('keyboard entry and supporting pages have a usable route back', async ({ page }) => {
  await visit(page, '/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '跳到正文' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
  for (const [path, title] of [['/privacy', '隐私与数据'], ['/terms', '使用说明'], ['/404', '这个故事，还没找到。']]) {
    await visit(page, path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
    await expect(page.locator('main').getByRole('link', { name: /(返回.*|回到)首页/ })).toHaveAttribute('href', '/');
  }
});

for (const channel of [
  { name: '下载 Android 家长端', packageName: 'com.molly.parent', button: '#download-android-button', status: '#download-android-button-status', filename: 'mollytime-android.apk' },
  { name: '下载电视端', packageName: 'com.molly.tv', button: '#download-button', status: '#download-button-status', filename: 'mollytime-tv.apk' },
]) {
  test(`${channel.packageName}: absence and server failure permit retry`, async ({ page }) => {
    let attempts = 0;
    await page.route('**/api/client/releases/latest?*', (route) => {
      expect(new URL(route.request().url()).searchParams.get('packageName')).toBe(channel.packageName);
      attempts++;
      return route.fulfill(attempts === 1 ? { json: { release: null } } : { status: 503, body: 'unavailable' });
    });
    await visit(page, '/#download');
    const button = page.locator(channel.button);
    await button.click();
    await expect(page.locator(channel.status)).toContainText('尚未发布');
    await expect(button).toBeEnabled();
    await button.click();
    await expect(page.locator(channel.status)).toContainText('请稍后重试');
    await expect(button).toBeEnabled();
  });

  test(`${channel.packageName}: downloads latest formal APK and rejects wrong channel or URL`, async ({ page }) => {
    const path = `/api/client/releases/${channel.packageName}/7/${'a'.repeat(64)}.apk`;
    let destination = path;
    let packageName = channel.packageName;
    await page.route('**/api/client/releases/latest?*', (route) => {
      expect(new URL(route.request().url()).searchParams.get('packageName')).toBe(channel.packageName);
      return route.fulfill({ json: {
        release: { packageName, url: destination, versionName: '1.0.0', size: 1048576 },
      } });
    });
    await page.route(`**${path}`, (route) => route.fulfill({ body: 'apk-fixture', contentType: 'application/vnd.android.package-archive', headers: { 'Content-Disposition': `attachment; filename="${channel.filename}"` } }));
    await visit(page, '/#download');
    const button = page.locator(channel.button);
    const pending = page.waitForEvent('download');
    await button.click();
    expect((await pending).suggestedFilename()).toBe(channel.filename);
    await expect(page.locator(channel.status)).toContainText('v1.0.0 · 1.0 MB');
    for (const invalid of [`https://untrusted.example${path}`, path.replace(channel.packageName, `${channel.packageName}.debug`), `${path}?token=invalid`]) {
      destination = invalid;
      await button.click();
      await expect(page.locator(channel.status)).toContainText('地址无效');
      await expect(button).toBeEnabled();
    }
    packageName = `${channel.packageName}.debug`;
    destination = path;
    await button.click();
    await expect(page.locator(channel.status)).toContainText('信息不完整');
    await expect(button).toBeEnabled();
  });
}

test('Android download disables while pending without blocking the TV channel', async ({ page }) => {
  let releaseResponse: (() => void) | undefined;
  await page.route('**/api/client/releases/latest?*', async route => {
    expect(new URL(route.request().url()).searchParams.get('packageName')).toBe('com.molly.parent');
    await new Promise<void>(resolve => { releaseResponse = resolve; });
    await route.fulfill({ json: { release: null } });
  });
  await visit(page, '/');
  const button = page.locator('#download-android-button');
  await button.click();
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#download-button')).toBeEnabled();
  await expect(page.locator('#download-android-button-status')).toContainText('正在获取');
  await expect.poll(() => Boolean(releaseResponse)).toBe(true);
  releaseResponse!();
  await expect(button).toBeEnabled();
  await expect(page.locator('#download-android-button-status')).toContainText('尚未发布');
  await expect(page.locator('#download-button-status')).toBeHidden();
});

test('real recordings pause, resume and switch phone themes while preserving reduced motion', async ({ page }) => {
  await visit(page, '/');
  const phone = page.locator('.iphone-screen video');
  const recordings = page.locator('[data-demo-video]');
  await expect(recordings).toHaveCount(2);
  await expect.poll(() => phone.evaluate((video: HTMLVideoElement) => video.paused && !video.currentSrc)).toBe(true);
  await page.getByRole('button', { name: '切换深浅色主题' }).click();
  await expect.poll(() => phone.evaluate((video: HTMLVideoElement) => video.getAttribute('poster') === video.dataset.posterDark)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('.device-showcase').scrollIntoViewIfNeeded();
  await expect.poll(() => phone.evaluate((video: HTMLVideoElement) => /\/parent-dark\.(mp4|webm)$/.test(video.currentSrc) && video.currentTime > 0.1 && !video.paused)).toBe(true);
  await page.getByRole('button', { name: '暂停演示' }).click();
  await expect.poll(() => recordings.evaluateAll(videos => videos.every(video => (video as HTMLVideoElement).paused))).toBe(true);
  await page.getByRole('button', { name: '播放演示' }).click();
  await expect.poll(() => phone.evaluate((video: HTMLVideoElement) => !video.paused)).toBe(true);
  await page.getByRole('button', { name: '切换深浅色主题' }).click();
  await expect.poll(() => phone.evaluate((video: HTMLVideoElement) => video.getAttribute('poster') === video.dataset.posterLight)).toBe(true);
  await page.locator('.device-showcase').scrollIntoViewIfNeeded();
  await expect.poll(() => phone.evaluate((video: HTMLVideoElement) => /\/parent-light\.(mp4|webm)$/.test(video.currentSrc) && !video.paused)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => recordings.evaluateAll(videos => videos.every(video => (video as HTMLVideoElement).paused))).toBe(true);
  await expect(page.getByRole('button', { name: '暂停演示' })).toBeHidden();
});

test('a mobile parent can jump to a task, read a fix and move between help pages', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await visit(page, '/terms');
  await page.locator('.help-mobile-toc summary').click();
  await page.getByRole('navigation', {name:'手机本页目录'}).getByRole('link', {name:'03 添加第一段视频'}).click();
  await expect(page).toHaveURL(/#add-video$/);
  await expect(page.locator('.help-mobile-toc')).not.toHaveAttribute('open','');
  await expect(page.getByRole('heading', {name:'添加第一段视频',exact:true})).toBeInViewport();
  await expect(page.locator('#add-video')).toContainText('上传后允许孩子观看');
  await expect(page.locator('#add-video')).toContainText('长按存放视频的合集');
  await page.getByRole('button', {name:'切换深浅色主题'}).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('link', {name:'再了解隐私与数据'}).click();
  await expect(page.getByRole('heading', {level:1})).toHaveText('隐私与数据');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.locator('.help-mobile-toc summary').click();
  await page.getByRole('navigation', {name:'手机本页目录'}).getByRole('link', {name:'如何管理和删除'}).click();
  await expect(page).toHaveURL(/#manage-data$/);
  await expect(page.getByRole('heading', {name:'想管理或删除，去哪里找'})).toBeInViewport();
  await expect(page.locator('#manage-data')).toContainText('最近删除');
  for (const route of ['/terms','/privacy']) {
    await page.setViewportSize({width:320,height:740});
    await page.goto(route);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
});
