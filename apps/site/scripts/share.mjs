// Run with the local site on port 4321 to refresh the checked-in social preview.
import { chromium } from '@playwright/test';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, colorScheme: 'light' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('http://127.0.0.1:4321/?preview=share');
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.story-garden img').evaluate((image) => image.decode());
  // Compose the same hero for the 1200×630 sharing canvas with only the brand mark in the navigation.
  await page.addStyleTag({ content: '.landing-header{width:auto;left:32px;right:auto;top:24px;margin:0;padding:0;border:0;border-radius:0;background:transparent;backdrop-filter:none}[data-landing-theme]{display:none}.landing-hero{padding:24px 24px 16px;min-height:630px;height:630px}.story-garden{height:280px;flex-shrink:0;margin-top:0}' });
  await page.screenshot({ path: new URL('../public/site/share.png', import.meta.url).pathname });
  await page.screenshot({ path: new URL('../src/assets/images/share.png', import.meta.url).pathname });
} finally { await browser.close(); }
