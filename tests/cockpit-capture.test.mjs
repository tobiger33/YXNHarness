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
    await page.waitForFunction(() => document.querySelector("#active-branch")?.textContent !== "…" && document.querySelector("#project-name")?.textContent !== "workspace");
    await page.locator("#workspace-brand[aria-busy=false]").waitFor();
    const available = await page.evaluate(() => typeof globalThis.CropTarget?.fromElement === "function" && typeof globalThis.ImageCapture === "function" && Boolean(navigator.mediaDevices?.getDisplayMedia));
    const project = await page.locator("#demo-preview").boundingBox();
    await page.evaluate(() => { document.title = "YXN-Capture-Test-8810"; });
    await page.locator("#capture").click();
    await Promise.race([
      page.locator(".attachment-preview").waitFor({ timeout: 15000 }),
      page.locator("#notice").waitFor({ state: "visible", timeout: 15000 }),
    ]);
    const captured = await page.locator(".attachment-preview").count() > 0;
    if (!captured) {
      const text = await page.locator("#notice").innerText();
      assert.match(text, /Project-only capture|project Preview|Select the current browser tab|No project image|No cropped project image|cropping|unavailable|Not supported|capture failed|Permission|denied/i);
      t.diagnostic(`Native region capture unavailable (API present: ${available}); no whole-workspace fallback. Testing dimension forwarding with an uploaded image.`);
      const data = await page.evaluate(() => { const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 16; return canvas.toDataURL("image/png").split(",")[1]; });
      await page.locator("#attachment-picker").setInputFiles({ name: "dimensions-fixture.png", mimeType: "image/png", buffer: Buffer.from(data, "base64") });
      await page.locator(".attachment-preview").waitFor();
    } else t.diagnostic("Actual native project crop captured; testing stored viewport and agent context.");
    const image = await page.locator(".attachment-preview img").evaluate(async (element) => {
      await element.decode();
      return { width: element.naturalWidth, height: element.naturalHeight };
    });
    if (captured) assert.ok(Math.abs(image.width / image.height - project.width / project.height) < 0.02, "image aspect ratio must match the project, not the workbench window");
    await page.locator(".attachment-preview").click();
    await page.locator("#attachment-viewer[open]").waitFor();
    assert.equal(await page.locator("#attachment-viewer img").evaluate((element) => element.naturalWidth), image.width);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#capture").isEnabled(), true);
    await page.reload();
    await page.locator(".attachment-preview").waitFor();
    const stored = await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open("yxnharness.attachments.v1", 1);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction("drafts").objectStore("drafts").getAll();
        read.onsuccess = () => { const item = read.result[0]; window.__captureTestRecord = item; resolve({ width: item.width, height: item.height, capture: item.capture }); db.close(); };
        read.onerror = () => reject(read.error);
      };
      request.onerror = () => reject(request.error);
    }));
    if (captured) {
      assert.ok(stored.capture.viewport.width > 0);
      assert.ok(stored.capture.viewport.height > 0);
      assert.equal(stored.capture.viewport.unit, "css-px");
      assert.ok(stored.capture.devicePixelRatio > 0);
    } else assert.equal(stored.capture, null);
    await page.locator('[data-mode="external"]').click();
    await page.locator("#chat-input").fill("Refine this project layout.");
    await page.locator(".send").click();
    const external = await page.getByRole("textbox", { name: "External agent task", exact: true }).inputValue();
    assert.ok(external.includes(`${image.width} × ${image.height} px`));
    if (captured) assert.ok(external.includes(`${stored.capture.viewport.width} × ${stored.capture.viewport.height} CSS px`));
    else assert.ok(external.includes("viewport unknown"));
    // Restore the same persisted draft after External consumes it, then exercise feedback.
    await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open("yxnharness.attachments.v1", 1);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction("drafts", "readwrite");
        transaction.objectStore("drafts").put(window.__captureTestRecord);
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
      request.onerror = () => reject(request.error);
    }));
    await page.reload();
    await page.locator(".attachment-preview").waitFor();
    let feedback = null;
    await page.route("**/api/v1/feedback", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      feedback = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"thread":{"threadId":"resolution-test"}}' });
    });
    await page.locator('[data-mode="connected"]').click();
    await page.locator("#chat-input").fill("Keep the screenshot dimensions with this feedback.");
    await page.locator(".send").click();
    await page.getByText("Saved feedback", { exact: true }).waitFor();
    assert.equal(feedback.appState.screenshotAttachments[0].image.width, image.width);
    if (captured) assert.equal(feedback.appState.screenshotAttachments[0].viewport.width, stored.capture.viewport.width);
    else assert.equal(feedback.appState.screenshotAttachments[0].viewport, null);
    assert.equal(feedback.appState.screenshotAttachments[0].localOnly, false);
    assert.ok(feedback.attachmentIds.includes(feedback.appState.screenshotAttachments[0].id));
    assert.equal("blob" in feedback.appState.screenshotAttachments[0], false);
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
  }
});
