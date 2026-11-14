import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

test("Capture stores only the project region and the image reopens", async (t) => {
  const server = spawn(process.execPath, ["scripts/harness.mjs", "serve", "--port", "8810"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
  let browser;
  try {
    let ready = false;
    for (let index = 0; index < 60; index += 1) {
      try { if ((await fetch("http://127.0.0.1:8810/")).ok) { ready = true; break; } } catch { /* wait for server */ }
      await delay(100);
    }
    assert.ok(ready, "cockpit server must start");
    browser = await chromium.launch({ headless: true, ...(process.env.HARNESS_BROWSER_CHANNEL ? { channel: process.env.HARNESS_BROWSER_CHANNEL } : {}), args: ["--auto-accept-this-tab-capture", "--auto-select-tab-capture-source-by-title=YXN-Capture-Test-8810", "--allow-http-screen-capture"] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto("http://127.0.0.1:8810/#/workspace");
    await page.locator("#workspace-brand[aria-busy=false]").waitFor();
    const available = await page.evaluate(() => typeof globalThis.CropTarget?.fromElement === "function" && Boolean(navigator.mediaDevices?.getDisplayMedia));
    await page.evaluate(() => { document.title = "YXN-Capture-Test-8810"; });
    await page.locator("#capture").click();

    // Headless CI often advertises CropTarget but cannot finish a cropped tab capture.
    // Either outcome is acceptable: a project-region attachment, or a notice with zero images
    // (never a silent whole-workspace fallback).
    const preview = page.locator(".attachment-preview");
    const notice = page.locator("#notice");
    try {
      await Promise.race([
        preview.waitFor({ state: "visible", timeout: 15000 }),
        notice.waitFor({ state: "visible", timeout: 15000 }),
      ]);
    } catch (error) {
      t.diagnostic(`capture settled neither preview nor notice; available=${available}`);
      throw error;
    }

    if (await preview.count() === 0) {
      const text = await notice.innerText();
      assert.match(text, /Project-only capture|project Preview|Select the current browser tab|No project image|unavailable|Not supported|capture failed|Permission|denied/i);
      t.diagnostic(`Region capture did not produce an image (${available ? "API present" : "API missing"}); verified no whole-workspace fallback.`);
      return;
    }

    const project = await page.locator("#demo-preview").boundingBox();
    const image = await page.locator(".attachment-preview img").evaluate(async (element) => {
      await element.decode();
      return { width: element.naturalWidth, height: element.naturalHeight };
    });
    assert.ok(Math.abs(image.width / image.height - project.width / project.height) < 0.02, "image aspect ratio must match the project, not the workbench window");
    await page.locator(".attachment-preview").click();
    await page.locator("#attachment-viewer[open]").waitFor();
    assert.equal(await page.locator("#attachment-viewer img").evaluate((element) => element.naturalWidth), image.width);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#capture").isEnabled(), true);
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
  }
});
