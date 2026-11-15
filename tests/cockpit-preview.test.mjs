import {isolatedWorkspace} from "./support/workspace.mjs";
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

test("preview preserves native multi-page navigation and only selects on explicit request", async (t) => {
  const cwd = new URL("..", import.meta.url).pathname;
  const isolated = await isolatedWorkspace(t);
  const cockpit = spawn(process.execPath, ["scripts/harness.mjs", "serve", "--root", isolated, "--port", "8808"], { cwd, stdio: "ignore" });
  const application = spawn(process.execPath, [`${isolated}/examples/foreign-booking/server.mjs`], { cwd, env: { ...process.env, PORT: "4189" }, stdio: "ignore" });
  let browser;
  try {
    await Promise.all([waitForServer("http://127.0.0.1:8808/"), waitForServer("http://127.0.0.1:4189/")]);
    browser = await chromium.launch({ headless: true, ...(process.env.HARNESS_BROWSER_CHANNEL ? { channel: process.env.HARNESS_BROWSER_CHANNEL } : {}) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto("http://127.0.0.1:8808/#/workspace");
    await page.locator("#workspace-brand[aria-busy=false]").waitFor();
    await page.locator("#chat-input").fill("Draft survives reload.");
    await page.reload();
    await page.locator("#workspace-brand[aria-busy=false]").waitFor();
    assert.equal(await page.locator("#chat-input").inputValue(),"Draft survives reload.");
    await page.locator("#chat-input").fill("");
    assert.equal(await page.locator("#interact-tool").getAttribute("aria-pressed"), "true");
    await page.locator("#select-tool").click();
    const surface = await page.locator("#app-preview").boundingBox();
    await page.mouse.move(surface.x + 10, surface.y + 100);
    await page.mouse.down();
    await delay(400);
    await page.mouse.up();
    assert.equal(await page.locator("#selection-context").isVisible(), false, "blank space must not fall back to a layout container");
    const rail = await page.locator(".sidebar").boundingBox();
    await page.mouse.move(rail.x + 20, rail.y + 160);
    await page.mouse.down();
    await page.mouse.move(surface.x + 100, surface.y + 100, { steps: 5 });
    await page.mouse.up();
    assert.equal(await page.locator("#selection-context").isVisible(), false, "outside starts must not select project elements");
    await page.mouse.move(surface.x + 10, surface.y + 100);
    await page.mouse.down();
    await page.mouse.move(rail.x + 20, rail.y + 160, { steps: 5 });
    await page.mouse.up();
    assert.equal(await page.locator("#selection-context").isVisible(), false, "outside release must cancel selection");
    const heading = await page.locator('[data-demo-element="OnboardingHeading"]').boundingBox();
    await page.mouse.move(heading.x + 10, heading.y + 10);
    await page.mouse.down();
    await delay(400);
    await page.mouse.up();
    assert.equal((await page.locator('[data-demo-element="OnboardingHeading"]').boundingBox()).y, heading.y, "holding must not shift the canvas");
    await page.locator("#selection-summary summary").click();
    assert.equal(await page.locator("#selection-context-name").innerText(), "OnboardingHeading");
    await page.locator('[data-demo-element="FuturePlanningCard"]').click();
    assert.equal(await page.locator("#selection-context-name").innerText(), "2 elements");
    assert.match(await page.locator("#selection-context-elements").innerText(), /FuturePlanningCard/);
    assert.equal(await page.locator('input[value="overview"]').isChecked(), true, "selection must not change the radio choice");
    await page.locator("#selection-context-clear").click();
    await page.keyboard.press("Escape");
    // Explicit Interact — Escape alone can race on CI and leave Select armed,
    // so Continue would select instead of navigating to details.
    await page.locator("#interact-tool").click();
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
    assert.equal(await page.locator("#draft-change-count").innerText(), "1 Änderung");
    assert.equal(await page.locator('[data-demo-step="details"]').isVisible(), true);
    await page.locator("#element-actions").waitFor();
    await page.locator("#selection-comment").click();
    assert.equal(await page.locator("#chat-input").inputValue(), "Keep my instructions.");
    await page.locator("#selection-summary summary").click();
    assert.match(await page.locator("#selection-context-route").innerText(), /\/details/);
    assert.equal(await page.locator("#interact-tool").getAttribute("aria-pressed"), "true");
    if (!(await page.locator("#selection-summary").getAttribute("open")) && !(await page.locator("#selection-context-name").isVisible())) await page.locator("#selection-summary summary").click();
    await page.locator("#selection-context-name").click();
    await page.locator("#element-detail-dialog[open]").waitFor();
    assert.equal(await page.locator(".element-detail-preview button").isVisible(), true);
    await page.getByRole("textbox", { name: "Element comment", exact: true }).fill("Reduce the button's vertical padding.");
    await page.getByRole("button", { name: "Kommentar speichern", exact: true }).click();
    assert.equal(await page.locator("#chat-input").inputValue(), "Keep my instructions.");
    if (!(await page.locator("#selection-summary").getAttribute("open")) && !(await page.locator("#selection-context-name").isVisible())) await page.locator("#selection-summary summary").click();
    await page.locator("#selection-context-name").click();
    assert.equal(await page.getByRole("textbox", { name: "Element comment", exact: true }).inputValue(), "Reduce the button's vertical padding.");
    await page.keyboard.press("Escape");
    await page.locator('[data-demo-element="SubmitButton"]').click();
    await page.locator('[data-demo-step="complete"]').waitFor();
    assert.equal(await page.locator("#demo-complete-name").innerText(), "Alex");
    assert.equal(await page.locator("#chat-input").evaluate((element) => getComputedStyle(element).outlineStyle), "none");

    await page.locator("#select-tool").click();
    const title = await page.locator('[data-demo-element="CompleteHeading"]').boundingBox();
    const description = await page.locator('[data-demo-element="CompleteDescription"]').boundingBox();
    await page.mouse.move(title.x - 4, title.y - 4);
    await page.mouse.down();
    await page.mouse.move(description.x + description.width + 4, description.y + description.height + 4, { steps: 8 });
    await page.mouse.up();
    assert.equal(await page.locator("#selection-context-name").innerText(), "3 elements");
    assert.match(await page.locator("#selection-context-elements").innerText(), /SubmitButton \(\/details\)/);
    assert.match(await page.locator("#selection-context-elements").innerText(), /CompleteHeading/);
    assert.match(await page.locator("#selection-context-elements").innerText(), /CompleteDescription/);
    await page.keyboard.press("Escape");

    await page.locator("#open-preview").click();
    // Prefills from harness.config.json when no saved preview URL exists (async fetch).
    await page.waitForFunction(() => /127\.0\.0\.1:4173\/?$/.test(document.querySelector("#connect-preview-dialog input")?.value || ""));
    await page.locator("#connect-preview-dialog input").fill("http://127.0.0.1:4189/");
    await page.getByRole("button", { name: "Open preview", exact: true }).click();
    await page.getByText("Live inspector ready — Select is available.", { exact: true }).waitFor();
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

    // Live Harbor Desk Select → toolbar → Kommentieren (no host DOM anchor required).
    if (await page.locator("#selection-context-clear").isVisible()) {
      await page.locator("#selection-context-clear").click();
    }
    await app.locator("#city").fill("Lisbon");
    await app.locator("#nights").fill("2");
    await page.locator("#select-tool").click();
    assert.equal(await page.locator("#select-tool").getAttribute("aria-pressed"), "true");
    await app.locator("#to-review").click();
    await page.locator("#selection-summary summary").click();
    await page.locator("#selection-context-name").waitFor();
    assert.match(await page.locator("#selection-context-name").innerText(), /Review/);
    assert.match(await page.locator("#selection-context-route").innerText(), /\/search/);
    await page.locator("#element-actions").waitFor();
    assert.equal(await page.locator("#element-actions").isVisible(), true, "live Select must show Kommentieren/Übernehmen");
    await page.locator("#selection-comment").click();
    assert.equal(await page.locator("#interact-tool").getAttribute("aria-pressed"), "true");
    assert.match(await page.locator("#selection-context-intent").innerText(), /Kommentieren/);
  } finally {
    if (browser) await browser.close();
    cockpit.kill("SIGTERM");
    application.kill("SIGTERM");
  }
});
