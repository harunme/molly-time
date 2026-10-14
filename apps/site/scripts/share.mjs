// Run with the local site on port 4321 to refresh the checked-in social preview.
import { chromium } from '@playwright/test';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('http://127.0.0.1:4321/');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: new URL('../public/site/share.png', import.meta.url).pathname });
  await page.screenshot({ path: new URL('../src/assets/images/share.png', import.meta.url).pathname });
} finally { await browser.close(); }
