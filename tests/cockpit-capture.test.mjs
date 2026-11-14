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
    if (!available) {
      await page.locator("#capture").click();
      assert.equal(await page.locator(".attachment-preview").count(), 0);
      assert.match(await page.locator("#notice").innerText(), /Project-only capture is unavailable/);
      t.diagnostic("Region Capture unavailable: verified no whole-workspace fallback.");
      return;
    }
    await page.evaluate(() => { document.title = "YXN-Capture-Test-8810"; });
    const project = await page.locator("#demo-preview").boundingBox();
    await page.locator("#capture").click();
    try { await page.locator(".attachment-preview").waitFor({ timeout: 15000 }); }
    catch (error) { t.diagnostic(await page.locator("#notice").innerText()); throw error; }
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
