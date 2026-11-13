import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import process from "node:process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { runScenario } from "../scripts/harness.mjs";

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

test("a non-resolving app command times out and aborts the viewport", {
  skip: process.env.SKIP_BROWSER === "1" ? "SKIP_BROWSER=1" : false,
}, async () => {
  assert.ok(existsSync(chromium.executablePath()),
    "Chromium is missing. Install it with: npx playwright install chromium");
  const root = await mkdtemp(path.join(os.tmpdir(), "yxnh-command-timeout-"));
  const serverPath = path.join(root, "server.mjs");
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

  const appHtml = `<!doctype html><meta charset="utf-8"><script>
    const clock = { time: 0, pause() {}, resume() {}, advance(ms) { this.time += ms; return { time: this.time }; }, seek(ms) { this.time = ms; return { time: this.time }; }, now() { return this.time; } };
    fetch("/stream").catch(() => {});
    window.__harness = {
      version: 1,
      state: () => ({ ready: true }),
      commands: () => [{ name: "hang", payloadSchema: { type: "null" } }],
      command: () => new Promise(() => {}),
      on() {},
      off() {},
      clock
    };
  </script>`;
  await writeFile(serverPath, [
    'import { createServer } from "node:http";',
    `const html = ${JSON.stringify(appHtml)};`,
    `createServer((request, response) => { if (request.url === "/stream") { response.writeHead(200, { "content-type": "text/event-stream" }); return; } response.writeHead(200, { "content-type": "text/html" }); response.end(html); }).listen(${port}, "127.0.0.1");`,
  ].join("\n"));

  const previousExitCode = process.exitCode;
  try {
    const result = await runScenario({
      root,
      scenarioPath: path.join(root, "timeout.yaml"),
      config: {
        version: 1,
        app: {
          start: [process.execPath, serverPath],
          url: `http://127.0.0.1:${port}/`,
          startupTimeoutMs: 5000,
          navigationTimeoutMs: 5000,
          commandTimeoutMs: 1000,
          inheritEnv: [],
        },
      },
      scenario: {
        name: "command-timeout",
        viewports: [{ name: "smoke", width: 390, height: 844 }],
        steps: [{ command: "hang" }, { command: "hang" }],
      },
    });
    assert.equal(result.status, "failed");
    assert.equal(result.viewports[0].steps.length, 1);
    assert.match(result.viewports[0].steps[0].error, /command "hang" timed out after 1000ms/);
  } finally {
    process.exitCode = previousExitCode;
    await rm(root, { recursive: true, force: true });
  }
});
