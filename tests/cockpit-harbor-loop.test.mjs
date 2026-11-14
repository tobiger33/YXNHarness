import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function waitForServer(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(url)).ok) return; } catch { /* retry startup */ }
    await delay(100);
  }
  throw new Error(`Server did not become ready: ${url}`);
}

test("Harbor Desk live Select proposes Preview/Accept through workspace-edit", async () => {
  const cwd = new URL("..", import.meta.url).pathname;
  const stylesPath = path.join(cwd, "examples", "foreign-booking", "styles.css");
  const before = await readFile(stylesPath, "utf8");
  const cockpit = spawn(process.execPath, ["scripts/harness.mjs", "serve", "--port", "8812"], { cwd, stdio: "ignore" });
  const application = spawn(process.execPath, ["examples/foreign-booking/server.mjs"], {
    cwd,
    env: { ...process.env, PORT: "4191" },
    stdio: "ignore",
  });
  let browser;
  try {
    await Promise.all([waitForServer("http://127.0.0.1:8812/"), waitForServer("http://127.0.0.1:4191/")]);
    browser = await chromium.launch({
      headless: true,
      ...(process.env.HARNESS_BROWSER_CHANNEL ? { channel: process.env.HARNESS_BROWSER_CHANNEL } : {}),
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto("http://127.0.0.1:8812/#/workspace");
    await page.locator("#workspace-brand[aria-busy=false]").waitFor();
    assert.match(await page.locator("#task-subtitle").innerText(), /Connected|workspace-edit|Workspace/i);

    await page.locator("#open-preview").click();
    await page.locator("#connect-preview-dialog input").fill("http://127.0.0.1:4191/");
    await page.getByRole("button", { name: "Open preview", exact: true }).click();
    await page.getByText("Live inspector ready — Select is available.", { exact: true }).waitFor();

    const app = page.frameLocator("#live-preview");
    await app.locator("#city").fill("Lisbon");
    await app.locator("#nights").fill("3");
    await page.locator("#select-tool").click();
    await app.locator("#to-review").click();
    await page.locator("#element-actions").waitFor();
    await page.locator("#selection-comment").click();
    await page.locator("#chat-input").fill("Make the Confirm CTA clearer with a stronger accent.");
    await page.locator(".send").click();

    const card = page.locator(".agent-response .proposal-card").last();
    await card.locator(".proposal-edit").first().waitFor();
    assert.match(await card.locator(".proposal-edit-path").first().innerText(), /styles\.css/);
    await card.locator("[data-proposal-preview]").click();
    await card.locator("[data-proposal-accept]").click();
    await card.getByText("Applied", { exact: true }).waitFor({ timeout: 15000 });
    const after = await readFile(stylesPath, "utf8");
    assert.notEqual(after, before, "Accept must write the Harbor Desk style proposal");
  } finally {
    if (browser) await browser.close();
    cockpit.kill("SIGTERM");
    application.kill("SIGTERM");
    try {
      const current = await readFile(stylesPath, "utf8");
      if (current !== before) await writeFile(stylesPath, before);
    } catch { /* best-effort restore */ }
  }
});
