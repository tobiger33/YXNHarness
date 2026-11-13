import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath = path.join(root, "examples", "minimal", "server.mjs");

test("the example keeps its normal UI functional when the harness is not opted in", {
  skip: process.env.SKIP_BROWSER === "1" ? "SKIP_BROWSER=1" : false,
}, async () => {
  assert.ok(existsSync(chromium.executablePath()),
    "Chromium is missing. Install it with: npx playwright install chromium");
  const child = spawn(process.execPath, [serverPath], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { output += chunk; });

  let browser;
  try {
    const deadline = Date.now() + 10000;
    let url;
    while (Date.now() < deadline) {
      const match = output.match(/listening at (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match) {
        url = match[1];
        break;
      }
      if (child.exitCode !== null) throw new Error(`example server exited with ${child.exitCode}: ${output}`);
      await delay(50);
    }
    assert.ok(url, `example server did not start: ${output}`);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(url, { waitUntil: "networkidle" });
    assert.equal(await page.evaluate(() => Object.hasOwn(window, "__harness")), false);
    await page.getByLabel("Your name").fill("Avery");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByText("You're all set, Avery.").waitFor();
    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("heading", { name: "Welcome" }).waitFor();
    assert.equal(await page.evaluate(() => Object.hasOwn(window, "__harness")), false);
    await page.close();
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, delay(3000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
  }
});
