import { expect, test } from '@playwright/test';

for (const width of [390, 1440]) {
  test(`TV management owns its navigation while family tabs retain keyboard support at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/manage/#/family/watching');
    await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
    await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/#\/devices$/);
    await expect(page.getByRole('heading', { name: '我的电视', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '家长视频提醒', exact: true })).toBeVisible();
    await expect(page.getByLabel('默认字幕', { exact: true })).toBeVisible();
    await expect(page.getByRole('tablist', { name: '家庭设置分类' })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('button', { name: '绑定电视', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`my-televisions-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const navigation = page.getByRole('navigation', { name: '管理导航' });
    await navigation.getByRole('link', { name: '家庭设置', exact: true }).click();
    await expect(page).toHaveURL(/#\/family\/general$/);
    const tabs = page.getByRole('tablist', { name: '家庭设置分类' });
    await expect(tabs.getByRole('tab')).toHaveCount(2);
    await expect(page.getByRole('heading', { name: '家长视频提醒', exact: true })).toHaveCount(0);
    await tabs.getByRole('tab', { name: '家庭信息', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: '账号安全', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: '修改密码', exact: true })).toBeVisible();
    await tabs.getByRole('tab', { name: '家庭信息', exact: true }).click();
    await expect(page.getByLabel('家庭名称', { exact: true })).toBeVisible();
    await navigation.getByRole('link', { name: '我的电视', exact: true }).click();
    await expect(page).toHaveURL(/#\/devices$/);
    await page.goBack();
    await expect(page).toHaveURL(/#\/family\/general$/);
  });
}
