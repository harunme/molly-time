import { expect, test, type Page } from "@playwright/test";

async function login(page: Page, user: string) {
  await page.getByLabel("账号", { exact: true }).fill(`${user}@example.test`);
  await page.getByLabel("密码", { exact: true }).fill(`${user}-e2e`);
  await page.getByRole("button", { name: /^登录(?:并领取)?$/ }).click();
}

test("share collection, login through link, receive draft and publish independently", async ({ page, browser }) => {
  await page.goto("/manage/");
  await login(page, "parent");
  await page.getByRole("navigation", { name: "管理导航" }).getByRole("link", { name: "资源库", exact: true }).click();
  await page.getByRole("button", { name: "更多操作 英语启蒙" }).click();
  await page.getByRole("menuitem", { name: "分享内容" }).click();
  const dialog = page.getByRole("dialog", { name: "分享 · 英语启蒙" });
  await expect(dialog.getByText(/3 个视频/)).toBeVisible();
  await dialog.getByRole("button", { name: "生成分享", exact: true }).click();
  const url = await dialog.getByLabel("分享链接").inputValue();
  await expect(dialog.getByLabel("分享口令")).toHaveValue(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await page.screenshot({ path: test.info().outputPath("share-dialog.png") });

  const context = await browser.newContext();
  try {
    const receiving = await context.newPage();
    await receiving.goto(url);
    await expect(receiving.getByRole("heading", { name: "英语启蒙", exact: true })).toBeVisible();
    await expect(receiving.getByLabel("密码", { exact: true })).toHaveCount(0);
    await expect(receiving.getByRole("navigation", { name: "管理导航" })).toHaveCount(0);
    await receiving.getByRole("button", { name: "加入我的内容库" }).click();
    const loginDialog = receiving.getByRole("dialog", { name: "登录领取" });
    await expect(loginDialog).toBeVisible();
    await expect(receiving).toHaveURL(url);
    await login(receiving, "receiver");
    await expect(loginDialog).toHaveCount(0);
    await expect(receiving.getByText("已加入我的内容库，发布后可在电视上观看。")).toBeVisible();
    await expect(receiving).toHaveURL(url);
    await expect(receiving.getByRole("navigation", { name: "管理导航" })).toHaveCount(0);
    await receiving.setViewportSize({ width: 390, height: 844 });
    await receiving.screenshot({ path: test.info().outputPath("share-receive-mobile.png") });
    expect(await receiving.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const folderId = await receiving.evaluate(async () => {
      const folders = await (await fetch("/api/manage/resources")).json();
      return folders.find((item: { name: string }) => item.name === "英语启蒙").id as string;
    });
    const videos = await receiving.request.get(`/api/manage/folders/${folderId}/videos`);
    expect((await videos.json()).every((item: { status: string }) => item.status === "draft")).toBe(true);
    await receiving.reload();
    await expect(receiving.getByText("你的家庭已领取此分享，无需重复加入。")).toBeVisible();
    // Publish the collection and its episodes using the same authenticated APIs as the UI.
    const published = await receiving.evaluate(async () => {
      const session = await (await fetch("/api/manage/auth/session")).json();
      const folders = await (await fetch("/api/manage/resources")).json();
      const folder = folders.find((item: { name: string }) => item.name === "英语启蒙");
      const episodes = await (await fetch(`/api/manage/folders/${folder.id}/videos`)).json();
      const headers = { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken };
      for (const id of [folder.id, ...episodes.map((ep: { id: string }) => ep.id)]) {
        const response = await fetch(`/api/manage/resources/${id}/publish`, { method: "POST", headers });
        if (!response.ok) return false;
      }
      return true;
    });
    expect(published).toBe(true);
    await receiving.goto(`/manage/#/library/${folderId}`);
    await receiving.getByRole("button", { name: "第 1 季", exact: true }).click();
    await receiving.getByRole("button", { name: "更多操作 Hello" }).click();
    await expect(receiving.getByRole("menuitem", { name: "分享内容" })).toHaveCount(0);
    await receiving.getByRole("menuitem", { name: "预览视频" }).click();
    await expect(receiving.getByRole("dialog", { name: "家长预览 · Hello" }).locator("video")).toHaveAttribute("src", /mediaId=/);
  } finally { await context.close(); }
});

test("single video share links work without any claim entry in the library", async ({ page, browser }) => {
  await page.goto("/manage/");
  await login(page, "parent");
  await page.getByRole("navigation", { name: "管理导航" }).getByRole("link", { name: "资源库", exact: true }).click();
  await page.getByRole("button", { name: "英语启蒙", exact: true }).click();
  await page.getByRole("button", { name: "第 1 季", exact: true }).click();
  await page.getByRole("button", { name: "更多操作 Hello" }).click();
  await page.getByRole("menuitem", { name: "分享内容" }).click();
  const dialog = page.getByRole("dialog", { name: "分享 · Hello" });
  await dialog.getByRole("button", { name: "生成分享", exact: true }).click();
  const url = await dialog.getByLabel("分享链接").inputValue();
  const context = await browser.newContext();
  try {
    const receiving = await context.newPage();
    await receiving.goto("/manage/");
    await login(receiving, "receiver");
    await receiving.getByRole("navigation", { name: "管理导航" }).getByRole("link", { name: "资源库", exact: true }).click();
    await expect(receiving.getByRole("button", { name: "领取分享", exact: true })).toHaveCount(0);
    await receiving.goto('/manage/#/share');
    await expect(receiving).toHaveURL(/#\/library$/);
    await receiving.goto(url);
    await expect(receiving.getByRole("heading", { name: "Hello", exact: true })).toBeVisible();
    await expect(receiving.getByRole("button", { name: "加入我的内容库" })).toBeDisabled();
    await receiving.getByRole("combobox", { name: "接收合集" }).click();
    await receiving.getByRole("option", { name: "我的收藏", exact: true }).click();
    await receiving.getByRole("button", { name: "加入我的内容库" }).click();
    await expect(receiving.getByText("已加入我的内容库，发布后可在电视上观看。")).toBeVisible();
    await receiving.goto("/manage/#/library");
    await receiving.getByRole("button", { name: "我的收藏", exact: true }).click();
    await expect(receiving.getByRole("button", { name: "Hello", exact: true })).toBeVisible();
  } finally { await context.close(); }
});


test("public share shows artwork, descriptions and video catalog on desktop and mobile", async ({ page }) => {
  const data = { id: "visual-share", name: "一起探索奇妙世界", type: "Series", videoCount: 3,
    sizeBytes: 27053260, expiresAt: "2026-10-21T10:58:45Z", imageId: "collection-cover",
    overview: "从太空到大自然，把孩子的好奇心带进每一次家庭放映。", durationMs: 1080000,
    claimedResourceId: null, claimedDeleted: false, claimedFolderId: null, ownShare: false,
    items: ["出发，去太空", "森林里的新朋友", "小小探险家"].map((name, index) => ({
      id: `video-${index}`, parentId: "root", type: "Episode", name,
      imageId: `cover-${index}`, runtimeMs: 360000, overview: "一起发现身边的大世界。",
    })) };
  await page.route("**/api/shares/preview", (route) => route.fulfill({ json: data }));
  await page.route("**/api/shares/images/**", (route) => route.fulfill({
    path: "../site/src/assets/images/children-cartoons.jpg", contentType: "image/jpeg",
  }));
  await page.goto("/manage/#/share/ABCDEFGH2345");
  await expect(page.getByRole("heading", { name: data.name, exact: true })).toBeVisible();
  await expect(page.locator(".share-video")).toHaveCount(3);
  await expect(page.locator(".share-hero-art img")).toBeVisible();
  await expect.poll(() => page.locator(".share-hero-art img").evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: "../../artifacts/share-landing-desktop.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "../../artifacts/share-landing-mobile.png", fullPage: true, animations: "disabled" });
  await page.route("**/api/shares/images/**", (route) => route.fulfill({ status: 404 }));
  await page.reload();
  await expect(page.locator(".share-hero-art")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "加入我的内容库" })).toBeEnabled();
});


test("share login errors and cancellation keep the visitor on the public overview", async ({ page }) => {
  await page.route("**/api/shares/preview", (route) => route.fulfill({ json: {
    id: "login-share", name: "登录测试", type: "Series", videoCount: 1, sizeBytes: 1024,
    expiresAt: "2026-10-21T10:58:45Z", items: [{ id: "one", parentId: null, type: "Episode", name: "视频" }],
    claimedResourceId: null, claimedDeleted: false, claimedFolderId: null, ownShare: false,
  } }));
  await page.goto("/manage/#/share/ABCDEFGH2345");
  const join = page.getByRole("button", { name: "加入我的内容库", exact: true });
  await join.click();
  const dialog = page.getByRole("dialog", { name: "登录领取", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("账号", { exact: true }).fill("receiver@example.test");
  await dialog.getByLabel("密码", { exact: true }).fill("wrong-password");
  await dialog.getByRole("button", { name: "登录并领取", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("账号密码错误");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/#\/share\/ABCDEFGH2345$/);
  await expect(page.getByRole("heading", { name: "登录测试", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "管理导航" })).toHaveCount(0);
  await expect(join).toBeEnabled();
});
