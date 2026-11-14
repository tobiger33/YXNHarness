import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

async function waitForServer(url, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // retry
    }
    await delay(125);
  }
  throw new Error(`Server did not become ready: ${url}`);
}

test("cockpit panel splitters resize, reset, and restore from localStorage", async () => {
  const port = 8799;
  const child = spawn("node", ["scripts/harness.mjs", "serve", "--port", String(port)], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let browser;
  try {
    await waitForServer(`http://127.0.0.1:${port}/`);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/#/workspace`, { waitUntil: "networkidle" });

    const left = page.locator(".splitter-left");
    await assert.equal(await left.isVisible(), true);
    const box = await left.boundingBox();
    assert.ok(box, "left splitter should have a hit box");
    assert.ok(box.height > 100, `splitter height should fill the stage, got ${box.height}`);
    assert.ok(box.width >= 8, `splitter width should be usable, got ${box.width}`);

    const before = await page.evaluate(() => getComputedStyle(document.querySelector(".workspace")).getPropertyValue("--left-width").trim());
    await left.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    const afterKeys = await page.evaluate(() => getComputedStyle(document.querySelector(".workspace")).getPropertyValue("--left-width").trim());
    assert.notEqual(afterKeys, before, "ArrowRight should widen the left panel");

    await left.dblclick();
    const reset = await page.evaluate(() => getComputedStyle(document.querySelector(".workspace")).getPropertyValue("--left-width").trim());
    assert.equal(reset, "175px");

    // Drag wider.
    const start = await left.boundingBox();
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + 80, start.y + start.height / 2, { steps: 8 });
    await page.mouse.up();
    const dragged = await page.evaluate(() => getComputedStyle(document.querySelector(".workspace")).getPropertyValue("--left-width").trim());
    assert.notEqual(dragged, "175px", "drag should change left width");

    const stored = await page.evaluate(() => localStorage.getItem("yxnharness.cockpit.layout.v1"));
    assert.ok(stored, "layout should persist");
    const parsed = JSON.parse(stored);
    assert.equal(parsed.leftWidth, Number.parseInt(dragged, 10));

    await page.reload({ waitUntil: "networkidle" });
    const restored = await page.evaluate(() => getComputedStyle(document.querySelector(".workspace")).getPropertyValue("--left-width").trim());
    assert.equal(restored, dragged);
  } finally {
    if (browser) await browser.close();
    child.kill("SIGTERM");
  }
});
