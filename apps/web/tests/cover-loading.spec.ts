import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

for (const mobile of [false, true]) {
  for (const failed of [false, true]) {
    test(`${mobile ? 'mobile' : 'desktop'} cover hides the folder while loading and ${failed ? 'restores it on failure' : 'shows decoded artwork'}`, async ({ page }) => {
      await page.setViewportSize({ width: mobile ? 390 : 1440, height: 1000 });
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      const picture = execFileSync('../server/.venv/bin/python', ['-c',
        'import io,sys; from PIL import Image; b=io.BytesIO(); Image.new("RGB",(64,36),"blue").save(b,"PNG"); sys.stdout.buffer.write(b.getvalue())']);
      await page.route('**/api/items/series/image?*', async route => {
        await pending;
        await route.fulfill(failed ? { status: 404 } : { contentType: 'image/png', body: picture });
      });
      try {
        await page.goto('/manage/#/library');
        await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
        await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
        await page.getByRole('button', { name: '登录', exact: true }).click();
        const cover = page.getByRole('button', { name: '打开 英语启蒙', exact: true });
        await expect(cover).toBeVisible();
        const image = cover.locator('img');
        const fallback = cover.locator(mobile ? ':scope > svg' : '.desktop-fallback-icon');
        await expect(fallback).toHaveCSS('visibility', 'hidden');
        await expect(image).toHaveCSS('opacity', '0');
        const before = await cover.boundingBox();
        if (!mobile) expect(await cover.evaluate(el => getComputedStyle(el, '::before').display)).toBe('none');
        release();
        if (failed) {
          await expect(image).toHaveAttribute('data-error', 'true');
          await expect(fallback).toHaveCSS('visibility', 'visible');
        } else {
          await expect(image).toHaveAttribute('data-loaded', 'true');
          await expect(image).toHaveCSS('opacity', '1');
          await expect(fallback).toHaveCSS('visibility', 'hidden');
        }
        const after = await cover.boundingBox();
        expect(after!.width).toBe(before!.width);
        expect(after!.height).toBe(before!.height);
      } finally {
        release();
      }
    });
  }
}
