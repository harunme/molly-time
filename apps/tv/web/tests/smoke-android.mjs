// Opt-in smoke test for a connected debug WebView. Does not run with pnpm test.
import { _android, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const smoke = (name) => process.env[`MOLLYTIME_${name}`] ?? process.env[`MOLLY_${name}`];
const adb = resolve('../../../.local/android-sdk/platform-tools/adb');
const [device] = await _android.devices();
if (!device) throw new Error('Connect an Android TV emulator first');
const webview = await device.webView({ pkg: 'com.molly.tv.debug' });
const page = await webview.page();
// Recover if a previous interrupted smoke run left the native player on top.
function nativePlayerOnTop() { return execFileSync(adb, ['-e', 'shell', 'dumpsys', 'activity', 'activities'], { encoding: 'utf8' })
  .split('\n').some((line) => /topResumedActivity|mResumedActivity/.test(line) && line.includes('PlaybackActivity')); }
function nativePlaying() {
  const log = execFileSync(adb, ['-e', 'logcat', '-d', '-s', 'MollyTimePlayback:D', '*:S'], { encoding: 'utf8' });
  return [...log.matchAll(/isPlaying=(true|false)/g)].at(-1)?.[1];
}
async function setNativePaused(paused) {
  const target = paused ? 'false' : 'true';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (nativePlaying() === target) return;
    execFileSync(adb, ['-e', 'shell', 'input', 'keyevent', '62']);
    await page.waitForTimeout(500);
  }
  expect(nativePlaying()).toBe(target);
}
for (let attempt = 0; attempt < 3 && nativePlayerOnTop(); attempt++) {
  execFileSync(adb, ['-e', 'shell', 'input', 'keyevent', '4']);
  await page.waitForTimeout(300);
}
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  if (await page.getByRole('button', { name: '绑定家庭媒体库' }).isVisible()) {
    await page.getByRole('button', { name: '绑定家庭媒体库' }).click();
    console.log('请用手机扫描电视二维码并确认绑定；等待最多十分钟。');
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 600000 });
  }
  await page.evaluate(() => { for (let i = 0; i < 8 && window.mollyBack?.(); i++) {} });
  await expect(page.locator('.poster').first()).toBeVisible({ timeout: 20000 });
  if (smoke('SMOKE_CHILD')) {
    await page.locator('[data-focus="children"]').click();
    await page.locator('[data-focus^="child-"]').filter({ hasText: smoke('SMOKE_CHILD') }).click();
    await expect(page.locator('.poster').first()).toBeVisible({ timeout: 20000 });
  }
  console.log('Native device pairing and real catalog: OK');
  await page.screenshot({ path: '../../../artifacts/tv-webview-home.png' });
  await page.getByRole('button', { name: /L1开口动画/ }).click();
  await expect(page.locator('.season').first()).toBeVisible();
  await page.getByRole('button', { name: /古力小超人/ }).click();
  await expect(page.locator('.poster').first()).toBeVisible();
  const first = page.locator('.poster').filter({ hasText: 'Hello' }).first();
  const focusKey = await first.getAttribute('data-focus');
  await first.click();
  await expect.poll(() => execFileSync(adb, ['-e', 'shell', 'dumpsys', 'activity', 'activities'], { encoding: 'utf8' })
    .split('\n').some((line) => /topResumedActivity|mResumedActivity/.test(line) && line.includes('PlaybackActivity')),
    { timeout: 20000 }).toBe(true);
  console.log('Webpage to native player: OK');
  if (smoke('SMOKE_PAUSE') === '1') {
    await expect.poll(nativePlaying, { timeout: 20000 }).toBe('true');
  }
  // Allow the real decoder to produce frames, then retain a visual playback artifact.
  await page.waitForTimeout(6000);
  writeFileSync('../../../artifacts/tv-native-playback.png', await device.screenshot());
  if (smoke('SMOKE_PAUSE') === '1') {
    // SPACE is the player's keyboard toggle; system media keys may be intercepted by the TV OS.
    await setNativePaused(true);
    await page.waitForTimeout(4000);
    expect(nativePlaying()).toBe('false');
    writeFileSync('../../../artifacts/tv-native-paused.png', await device.screenshot());
    await setNativePaused(false);
    await page.waitForTimeout(3000);
    console.log('Native pause/resume interval exercised: OK');
  }
  for (let attempt = 0; attempt < 3 && nativePlayerOnTop(); attempt++) {
    execFileSync(adb, ['-e', 'shell', 'input', 'keyevent', '4']);
    await page.waitForTimeout(300);
  }
  await expect(page.locator(`[data-focus="${focusKey}"]`)).toBeFocused({ timeout: 10000 });
  console.log('Native player return and focus restoration: OK');
  const rejected = await page.evaluate(() => new Promise((resolve) => {
    const old = window.MollyBridge.onmessage;
    window.MollyBridge.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id === 'smoke-policy') { window.MollyBridge.onmessage = old; resolve(!!data.error); }
      else old(event);
    };
    window.MollyBridge.postMessage(JSON.stringify({ id: 'smoke-policy', method: 'request',
      args: { method: 'GET', path: '/api/auth/login?redirect=https://untrusted.test' } }));
  }));
  expect(rejected).toBe(true);
  console.log('Native API path allowlist: OK');
  expect(errors).toEqual([]);
} finally { await device.close(); }
