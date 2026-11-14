import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

async function waitForServer(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(url)).ok) return; } catch { /* retry startup */ }
    await delay(100);
  }
  throw new Error(`Server did not become ready: ${url}`);
}

test("preview preserves native multi-page navigation and only selects on explicit request", async () => {
  const cwd = new URL("..", import.meta.url).pathname;
  const cockpit = spawn(process.execPath, ["scripts/harness.mjs", "serve", "--port", "8808"], { cwd, stdio: "ignore" });
  const application = spawn(process.execPath, ["examples/foreign-booking/server.mjs"], { cwd, env: { ...process.env, PORT: "4189" }, stdio: "ignore" });
  let browser;
  try {
    await Promise.all([waitForServer("http://127.0.0.1:8808/"), waitForServer("http://127.0.0.1:4189/")]);
    browser = await chromium.launch({ headless: true, ...(process.env.HARNESS_BROWSER_CHANNEL ? { channel: process.env.HARNESS_BROWSER_CHANNEL } : {}) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto("http://127.0.0.1:8808/#/workspace");
    await page.locator("#workspace-brand[aria-busy=false]").waitFor();
    assert.equal(await page.locator("#interact-tool").getAttribute("aria-pressed"), "true");
    await page.locator("#inspect-target").click();
    await page.locator('[data-demo-step="details"]').waitFor();
    assert.equal(await page.locator("#context-chips .chip").count(), 0);
    await page.locator('[data-demo-element="SubmitButton"]').click();
    assert.equal(await page.locator('[data-demo-step="details"]').isVisible(), true, "empty form must remain invalid");
    await page.locator("#demo-name").fill("Alex");
    await page.locator("#demo-email").fill("alex@example.com");
    await page.locator("#chat-input").fill("Keep my instructions.");
    await page.locator("#select-tool").click();
    await page.locator('[data-demo-element="SubmitButton"]').click();
    assert.match(await page.locator("#context-chips").innerText(), /SubmitButton/);
    assert.equal(await page.locator('[data-demo-step="details"]').isVisible(), true);
    await page.locator("#element-actions").waitFor();
    await page.locator("#selection-comment").click();
    assert.equal(await page.locator("#chat-input").inputValue(), "Keep my instructions.");
    assert.match(await page.locator("#selection-context-route").innerText(), /\/details/);
    assert.equal(await page.locator("#interact-tool").getAttribute("aria-pressed"), "true");
    await page.keyboard.press("Escape");
    await page.locator('[data-demo-element="SubmitButton"]').click();
    await page.locator('[data-demo-step="complete"]').waitFor();
    assert.equal(await page.locator("#demo-complete-name").innerText(), "Alex");

    await page.locator("#open-preview").click();
    await page.locator("#connect-preview-dialog input").fill("http://127.0.0.1:4189/");
    await page.getByRole("button", { name: "Open preview", exact: true }).click();
    const app = page.frameLocator("#live-preview");
    await app.locator("#city").fill("Lisbon");
    await app.locator("#nights").fill("3");
    const context = await page.locator("#context-chips").innerText();
    await app.locator("#to-review").click();
    await app.locator("#review").waitFor();
    assert.match(await app.locator("#summary").innerText(), /3 nights in Lisbon/);
    await app.locator("#back-search").click();
    assert.equal(await app.locator("#city").inputValue(), "Lisbon");
    await app.locator("#to-review").click();
    await app.locator("#to-confirm").click();
    await app.locator("#done").waitFor();
    await page.locator("#workspace-brand").click();
    await page.locator(".repository-open").first().click();
    await page.locator(".workspace").waitFor();
    assert.equal(await app.locator("#done").isVisible(), true, "home navigation must preserve the app");
    assert.equal(await page.locator("#context-chips").innerText(), context, "app clicks must not select context");
    await app.locator("#reset").click();
    await app.locator("#search").waitFor();
  } finally {
    if (browser) await browser.close();
    cockpit.kill("SIGTERM");
    application.kill("SIGTERM");
  }
});
