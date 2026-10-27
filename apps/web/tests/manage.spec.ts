import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/manage/");
  await page.getByLabel("账号", { exact: true }).fill("parent@example.test");
  await page.getByLabel("密码", { exact: true }).fill("parent-e2e");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "概览", exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "管理导航" }).getByRole("link", { name: "资源库", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "资源库", exact: true }),
  ).toBeVisible();
}

test("real upload, parent preview and resource publication", async ({
  page,
}) => {
  // Public HTTP pages do not expose WebCrypto; exercise the compatibility path
  // against the real API's fingerprint and chunk SHA-256 validation.
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, 'subtle', { get: () => undefined });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const folder = mkdtempSync(join(tmpdir(), "mollytime-upload-"));
  const file = join(folder, "自然小故事.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0xc8a464:s=320x180:d=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-y",
    file,
  ]);
  try {
    await login(page);
    expect(await page.evaluate(() => crypto.subtle)).toBeUndefined();
    await page.getByRole('button', { name: '添加内容', exact: true }).click();
    await page.getByRole('menuitem', { name: '上传视频', exact: true }).click();
    await page.getByLabel("选择上传视频", { exact: true }).setInputFiles(file);
    await expect(page.getByRole("dialog", { name: "上传资源", exact: true })).not.toBeVisible();
    const tasks = page.getByRole("dialog", { name: "上传任务", exact: true });
    await expect(tasks).toBeVisible();
    await tasks.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(tasks).not.toBeVisible();
    await expect.poll(async () => {
      const response = await page.request.get('/api/manage/uploads?page=1&pageSize=20');
      const data = await response.json();
      return data.items.find((item: { filename: string; status: string }) => item.filename === '自然小故事.mp4')?.status;
    }, { timeout: 20000 }).toBe('ready');
    await expect(page.getByRole("button", { name: "上传任务", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "未整理", exact: true }).click();
    await page.getByRole("button", { name: "自然小故事", exact: true }).click();
    await expect(
      page.getByText("预览不计入家庭观看时长，也不修改电视续播位置。"),
    ).toBeVisible();
    await expect(page.locator("video")).toHaveAttribute("src", /mediaId=/);
    await page.getByRole("dialog", { name: "家长预览 · 自然小故事", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "更多操作 自然小故事", exact: true }).click();
    await page.getByRole("menuitem", { name: "上架", exact: true }).click();
    await page.getByRole("button", { name: "更多操作 自然小故事", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "下架", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "返回全部文件夹", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "未整理", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "../../artifacts/parent-resources.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    rmSync(folder, { recursive: true });
  }
});

test("parents group existing folders without uploading videos again", async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: '添加内容', exact: true }).click();
  await page.getByRole('menuitem', { name: '新建文件夹', exact: true }).click();
  const folderName = page.getByRole('textbox', { name: '文件夹名称', exact: true });
  await folderName.fill('小动物学习');
  await folderName.press('Enter');
  const from = (await page.getByRole('button', { name: '打开 未整理', exact: true }).boundingBox())!;
  const to = (await page.getByRole('button', { name: '打开 小动物学习', exact: true }).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await expect(page.locator('.is-drop-target')).toBeVisible();
  await page.mouse.up();
  await expect(page.getByRole('button', { name: '未整理', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '小动物学习', exact: true }).click();
  await page.getByRole('button', { name: '未整理', exact: true }).click();
  await expect(page.getByRole('button', { name: '自然小故事', exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "添加内容", exact: true }),
  ).toBeVisible();
});

test("real device telemetry, reports, child management and mobile layout", async ({
  page,
}) => {
  await login(page);
  const auth = await (
    await page.request.post("/api/auth/login", {
      headers: { "X-Molly-Client": "tv-shell/2" },
      data: { username: "parent@example.test", password: "parent-e2e" },
    })
  ).json();
  const parentSession = await (await page.request.get("/api/manage/auth/session")).json();
  await page.request.patch(`/api/manage/devices/${auth.deviceId}`, {
    headers: { "X-CSRF-Token": parentSession.csrfToken },
    data: { name: "观看记录测试电视" },
  });
  const headers = { Authorization: `Bearer ${auth.accessToken}` };
  const session = await (
    await page.request.post("/api/playback/sessions", {
      headers,
      data: { episodeId: "episode", childId: "child" },
    })
  ).json();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const data = {
    seq: 0,
    startMs: 0,
    endMs: 1000,
    playedMs: 1000,
    positionMs: 1000,
  };
  expect(
    (
      await page.request.post(
        `/api/playback/sessions/${session.sessionId}/events`,
        { headers, data },
      )
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.post(
        `/api/playback/sessions/${session.sessionId}/events`,
        { headers, data },
      )
    ).ok(),
  ).toBe(true);
  await page.getByRole("navigation").getByRole("link", { name: "概览", exact: true }).click();
  await page.getByRole("button", { name: "查看明细", exact: true }).click();
  await page.getByRole("dialog", { name: "观看记录" }).getByText("播放明细", { exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "观看记录" }).getByText("Hello", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "../../artifacts/parent-watch-report.png",
    fullPage: true,
  });
  await page.getByRole("dialog", { name: "观看记录" }).getByRole("button", { name: "关闭", exact: true }).click();
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "家庭设置" })
    .click();
  await page.getByLabel("儿童名称").fill("小豆");
  await page.getByRole("button", { name: "添加儿童" }).click();
  await expect(page.getByText("小豆", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "../../artifacts/parent-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.locator(".device-row").filter({ hasText: "观看记录测试电视" }).getByRole("button", { name: "取消配对", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await expect(page.locator(".device-row").filter({ hasText: "观看记录测试电视" })).toHaveCount(0);
  expect((await page.request.get("/api/home", { headers })).status()).toBe(401);
});

test("TV four-digit pairing survives parent login and requires explicit mobile confirmation", async ({
  page,
  browser,
}) => {
  const tvOrigin = `http://127.0.0.1:${process.env.MOLLYTIME_E2E_PORT || "8098"}`;
  const tvContext = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  });
  const tv = await tvContext.newPage();
  try {
    await tv.goto(`${tvOrigin}/tv/`);
    await expect(tv.locator(".pairing-code")).toBeVisible();
    const code = await tv.locator(".pairing-code").innerText();
    await expect(tv.getByLabel("密码")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/manage/?pair=");
    await page.getByLabel("账号", { exact: true }).fill("parent@example.test");
    await page.getByLabel("密码", { exact: true }).fill("parent-e2e");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "绑定电视", exact: true }),
    ).toBeVisible();
    expect(code).toMatch(/^[0-9]{4}$/);
    const codeInput = page.getByLabel("电视配对码");
    await expect(codeInput).toHaveAttribute("inputmode", "numeric");
    await codeInput.fill(code);
    await page.getByRole("button", { name: "查看电视" }).click();
    await expect(page.locator(".pairing-summary")).toContainText(code);
    await expect(tv.getByRole("heading", { name: "用手机绑定电视" })).toBeVisible();
    await page.getByLabel("电视名称").fill("客厅电视");
    await page.screenshot({
      path: "../../artifacts/parent-pairing-mobile.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const issued = tv.waitForResponse(
      async (response) =>
        response.url().endsWith("/api/auth/pairing/poll") &&
        response.status() === 200 &&
        (await response.json()).status === "authorized",
    );
    await page.getByRole("button", { name: "确认绑定这台电视" }).click();
    await expect(
      page.getByRole("heading", { name: "已确认绑定" }),
    ).toBeVisible();
    let auth = (await (await issued).json()).auth;
    await expect(tv.getByRole("dialog")).toHaveCount(0, { timeout: 10000 });
    await expect(tv.locator(".poster").first()).toBeVisible();
    await tv.reload();
    await expect(tv.locator(".poster").first()).toBeVisible();
    await expect(
      tv.getByRole("heading", { name: "用手机绑定电视" }),
    ).toHaveCount(0);
    await tv.getByRole("button", { name: "打开设置", exact: true }).click();
    await tv.getByRole("button", { name: "重新配对", exact: true }).click();
    await tv.getByRole("button", { name: "取消", exact: true }).click();
    await tv.getByRole("button", { name: "返回媒体库" }).click();
    await expect(tv.locator(".poster").first()).toBeVisible();
    await tv.getByRole("button", { name: "打开设置", exact: true }).click();
    await tv.getByRole("button", { name: "重新配对", exact: true }).click();
    await tv.getByRole("button", { name: "确认重新配对" }).click();
    await expect(tv.locator(".pairing-code")).toBeVisible();
    expect(
      (
        await tv.request.get(`${tvOrigin}/api/home`, {
          headers: { Authorization: `Bearer ${auth.accessToken}` },
        })
      ).status(),
    ).toBe(401);
    const nextCode = await tv.locator(".pairing-code").innerText();
    expect(nextCode).not.toBe(code);
    await page.goto("/manage/?pair=" + encodeURIComponent(nextCode));
    await page.getByLabel("电视名称").fill("客厅电视重新配对");
    const reissued = tv.waitForResponse(
      async (response) =>
        response.url().endsWith("/api/auth/pairing/poll") &&
        response.status() === 200 &&
        (await response.json()).status === "authorized",
    );
    await page.getByRole("button", { name: "确认绑定这台电视" }).click();
    auth = (await (await reissued).json()).auth;
    await expect(tv.getByRole("dialog")).toHaveCount(0, { timeout: 10000 });
    await expect(tv.locator(".poster").first()).toBeVisible();
    await tv.screenshot({ path: "../../artifacts/tv-pairing-home.png" });
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await expect(
      page.locator(".watch-control-device").filter({ hasText: "客厅电视重新配对" }),
    ).toBeVisible();
    await page.locator(".watch-control-device").filter({ hasText: "客厅电视重新配对" })
      .getByRole("button", { name: "客厅电视重新配对的更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "取消配对", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await expect(
      page.locator(".watch-control-device").filter({ hasText: "客厅电视重新配对" }),
    ).toHaveCount(0);
    expect(
      (
        await tv.request.get(`${tvOrigin}/api/home`, {
          headers: { Authorization: `Bearer ${auth.accessToken}` },
        })
      ).status(),
    ).toBe(401);
    await tv.reload();
    await expect(
      tv.getByRole("heading", { name: "用手机绑定电视" }),
    ).toBeVisible();
    expect(
      await tv.evaluate(() => localStorage.getItem("mollytime.tv.binding.v1")),
    ).toBeNull();
  } finally {
    await tvContext.close();
  }
});

test("OSS upload resumes existing parts and sends video bytes only to the signed destination", async ({
  page,
}) => {
  await login(page);
  const buffer = Buffer.from("direct upload bytes");
  const row = {
    id: "oss-test",
    itemId: "episode",
    filename: "direct.mp4",
    size: buffer.length,
    offset: 0,
    status: "uploading",
    fingerprint: "",
    kind: "video",
    error: "",
    transport: "oss",
    partSize: 8,
  };
  const parts: number[] = [],
    received: Buffer[] = [];
  let completed = false;
  await page.route("**/api/manage/uploads", async (route) => {
    if (route.request().method() === "POST") {
      const input = route.request().postDataJSON();
      await route.fulfill({ json: { ...row, fingerprint: input.fingerprint } });
    } else await route.fulfill({ json: [] });
  });
  await page.route("**/api/manage/uploads/oss-test**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/parts"))
      await route.fulfill({
        json: { partSize: 8, parts: [{ number: 1, size: 8 }] },
      });
    else if (path.endsWith("/part-url")) {
      const body = route.request().postDataJSON();
      parts.push(body.number);
      await route.fulfill({
        json: {
          url: `https://oss-upload.example/part/${body.number}`,
          headers: {
            "Content-MD5": body.md5,
            "Content-Type": "application/octet-stream",
          },
        },
      });
    } else if (path.endsWith("/complete")) {
      completed = true;
      await route.fulfill({ json: { ...row, status: "processing" } });
    } else if (path.endsWith("/chunks"))
      throw new Error("OSS bytes must not be proxied by Molly");
    else await route.fulfill({ json: row });
  });
  await page.route("https://oss-upload.example/**", async (route) => {
    if (route.request().method() === "PUT") {
      expect(route.request().headers()["authorization"]).toBeUndefined();
      expect(route.request().headers()["cookie"]).toBeUndefined();
      expect(route.request().headers()["content-md5"]).toMatch(
        /^[A-Za-z0-9+/]{22}==$/,
      );
      received.push(route.request().postDataBuffer()!);
    }
    await route.fulfill({
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": new URL(page.url()).origin,
        "Access-Control-Allow-Methods": "PUT, OPTIONS",
        "Access-Control-Allow-Headers": "content-md5,content-type",
      },
    });
  });
  await page.evaluate(
    async ({ values }) => {
      const { enqueue } = await import("/manage/src/uploads.ts");
      await enqueue(
        new File([new Uint8Array(values)], "direct.mp4", { type: "video/mp4" }),
        "episode",
        "video",
      );
    },
    { values: Array.from(buffer) },
  );
  await expect.poll(() => completed).toBe(true);
  expect(parts).toEqual([2, 3]);
  expect(Buffer.concat(received)).toEqual(buffer.subarray(8));
});

test("browser TV resolves an authenticated video and reports playback without the native bridge", async ({
  page,
  browser,
}) => {
  await login(page);
  const auth = await (
    await page.request.post("/api/auth/login", {
      headers: { "X-Molly-Client": "tv-shell/2" },
      data: { username: "parent@example.test", password: "parent-e2e" },
    })
  ).json();
  const context = await browser.newContext();
  const tv = await context.newPage();
  try {
    await tv.addInitScript(
      (binding) =>
        localStorage.setItem(
          "mollytime.tv.binding.v1",
          JSON.stringify(binding),
        ),
      {
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        deviceId: auth.deviceId,
        childId: "child",
      },
    );
    await tv.goto("http://127.0.0.1:8098/tv/");
    await tv.locator('[data-focus="series-series"]').click();
    const resolved = tv.waitForResponse(
      (r) =>
        r.url().includes("/api/episodes/browser-episode/playback") &&
        r.status() === 200,
    );
    await tv.locator('[data-focus="episode-browser-episode"]').click();
    const info = await (await resolved).json();
    expect(info.mediaId).toBe("browser-media");
    await expect(tv.getByRole("dialog", { name: "视频播放" })).toBeVisible();
    await expect(tv.locator("video")).toHaveAttribute(
      "src",
      /\/api\/episodes\/browser-episode\/play\?.*token=/,
    );
    const capabilities = await tv
      .locator("video")
      .evaluate((v) => ({
        webm: (v as HTMLVideoElement).canPlayType("video/webm"),
        error: (v as HTMLVideoElement).error?.code,
      }));
    const mediaResponse = await tv.request.get(
      (await tv.locator("video").getAttribute("src")) || "",
    );
    expect(mediaResponse.status(), JSON.stringify(capabilities)).toBe(200);
    expect(capabilities.webm).not.toBe("");
    await tv.locator("video").evaluate((v) => (v as HTMLVideoElement).play());
    await expect
      .poll(async () =>
        tv
          .locator("video")
          .evaluateAll((videos) =>
            videos.some((v) => (v as HTMLVideoElement).currentTime > 0),
          ),
      )
      .toBe(true);
    await expect(
      tv.getByRole("button", { name: "选集", exact: true }),
    ).toHaveCount(0);
    const progress = tv.waitForResponse(
      (r) =>
        /playback\/sessions\/.+\/events/.test(r.url()) &&
        r.request().postDataJSON()?.stopped,
    );
    await tv.keyboard.press("Escape");
    expect((await progress).status()).toBe(200);
    await expect(tv.getByRole("dialog", { name: "视频播放" })).toHaveCount(0);
    await expect(
      tv.locator('[data-focus="episode-browser-episode"]'),
    ).toBeFocused();
    const headers = { Authorization: `Bearer ${auth.accessToken}` };
    const saved = await (
      await tv.request.get(
        "http://127.0.0.1:8098/api/episodes/browser-episode/progress?childId=child",
        { headers },
      )
    ).json();
    expect(saved.positionMs).toBeGreaterThan(0);
    expect(saved.completed).toBe(false);
    await tv.locator('[data-focus="episode-browser-episode"]').click();
    await expect
      .poll(() =>
        tv
          .locator("video")
          .evaluateAll(
            (videos, savedMs) =>
              videos.some(
                (v) => (v as HTMLVideoElement).currentTime >= savedMs / 1000,
              ),
            saved.positionMs,
          ),
      )
      .toBe(true);
    const finished = tv.waitForResponse(
      (r) =>
        /playback\/sessions\/.+\/events/.test(r.url()) &&
        r.request().postDataJSON()?.stopped &&
        r.request().postDataJSON()?.completed,
    );
    await tv.locator("video").evaluate((v) => {
      (v as HTMLVideoElement).currentTime =
        (v as HTMLVideoElement).duration - 0.2;
    });
    expect((await finished).status()).toBe(200);
    await expect(tv.locator("video")).toHaveAttribute("src", /mediaId=browser-next-media/);
    await tv.getByRole("button", { name: "返回视频列表" }).click();
    await expect(tv.getByRole("dialog", { name: "视频播放" })).toHaveCount(0);
    await expect(tv.getByRole("dialog", { name: "选择剧集" })).toHaveCount(0);
    await expect(
      tv.locator('[data-focus="episode-browser-episode"]'),
    ).toBeFocused();
    await expect(tv.locator("video")).toHaveCount(0);
    const ended = await (
      await tv.request.get(
        "http://127.0.0.1:8098/api/episodes/browser-episode/progress?childId=child",
        { headers },
      )
    ).json();
    expect(ended.completed).toBe(true);
    // Reopening a completed video starts it again instead of advancing to another video.
    await tv.locator('[data-focus="episode-browser-episode"]').click();
    await expect
      .poll(() =>
        tv
          .locator("video")
          .evaluateAll((videos) =>
            videos.some(
              (v) =>
                !(v as HTMLVideoElement).paused &&
                (v as HTMLVideoElement).currentTime < 2,
            ),
          ),
      )
      .toBe(true);
    await tv.getByRole("button", { name: "返回视频列表", exact: true }).click();
    await expect(
      tv.locator('[data-focus="episode-browser-episode"]'),
    ).toBeFocused();
  } finally {
    await context.close();
  }
});
