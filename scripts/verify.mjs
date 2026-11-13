import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const installMessage = "Chromium is missing. Install it with: npx playwright install chromium";

function run(label, args, environment = process.env) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: environment,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}.`);
}

function runExpectingFailure(label, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 1) throw new Error(`${label} returned ${result.status}; expected exit code 1.`);
}

try {
  const skipBrowser = process.env.SKIP_BROWSER === "1";
  if (!skipBrowser && !existsSync(chromium.executablePath())) {
    throw new Error(`${installMessage} (or set SKIP_BROWSER=1 to run unit tests only).`);
  }
  run("unit tests", ["--test"]);
  if (skipBrowser) {
    console.log("Browser scenario checks skipped because SKIP_BROWSER=1.");
  } else {
    run("minimal scenario", [
      path.join(root, "scripts", "harness.mjs"),
      "run",
      "scenarios/minimal.yaml",
    ]);
    const pointer = JSON.parse(await readFile(path.join(root, "artifacts", "last-run.json"), "utf8"));
    const result = JSON.parse(await readFile(path.join(root, pointer.result), "utf8"));
    if (result.status !== "passed" || result.counts.viewports !== 2 ||
        result.counts.steps !== 10 || result.counts.screenshots !== 10) {
      throw new Error(`minimal scenario produced an unexpected result: ${JSON.stringify(result.counts)}`);
    }
    const stateChangeEvents = result.viewports.flatMap((viewport) => viewport.steps)
      .reduce((count, step) => count + step.events.filter((event) => event.event === "statechange").length, 0);
    if (stateChangeEvents !== 6) {
      throw new Error(`minimal scenario recorded ${stateChangeEvents} statechange events; expected 6.`);
    }
    const clockTimes = result.viewports.flatMap((viewport) => viewport.steps)
      .filter((step) => step.clock)
      .map((step) => step.clockTime);
    if (JSON.stringify(clockTimes) !== JSON.stringify([125, 40, 125, 40])) {
      throw new Error(`clock actions produced unexpected times: ${JSON.stringify(clockTimes)}`);
    }

    const firstRunDirectory = path.dirname(path.join(root, pointer.result));
    const firstScreenshotPaths = result.artifacts.screenshots.map((screenshot) =>
      path.join(firstRunDirectory, screenshot));
    run("repeat minimal scenario for deterministic-frame check", [
      path.join(root, "scripts", "harness.mjs"),
      "run",
      "scenarios/minimal.yaml",
    ]);
    const repeatedPointer = JSON.parse(await readFile(path.join(root, "artifacts", "last-run.json"), "utf8"));
    const repeatedResult = JSON.parse(await readFile(path.join(root, repeatedPointer.result), "utf8"));
    if (repeatedResult.status !== "passed" ||
        repeatedResult.artifacts.screenshots.length !== firstScreenshotPaths.length) {
      throw new Error("repeated scenario did not produce the same successful screenshot set.");
    }
    const repeatedRunDirectory = path.dirname(path.join(root, repeatedPointer.result));
    for (const [index, screenshot] of repeatedResult.artifacts.screenshots.entries()) {
      const firstFrame = await readFile(firstScreenshotPaths[index]);
      const repeatedFrame = await readFile(path.join(repeatedRunDirectory, screenshot));
      if (!firstFrame.equals(repeatedFrame)) {
        throw new Error(`deterministic frame check failed for ${screenshot}.`);
      }
    }
    console.log(`Scenario artifacts verified: ${result.counts.viewports} viewports, ${result.counts.steps} steps, ${stateChangeEvents} statechange events; repeated frames were byte-identical.`);

    const failingScenarioPath = path.join(root, "artifacts", ".verify-expectation-failure.yaml");
    await writeFile(failingScenarioPath, [
      "version: 1",
      "name: verify-expectation-failure",
      "viewports:",
      "  - name: smoke",
      "    width: 390",
      "    height: 844",
      "steps:",
      "  - command: setName",
      "    payload:",
      "      value: Alex",
      "  - command: next",
      "    expect:",
      "      step: details",
      "    snapshot: failed-expectation",
      "",
    ].join("\n"));
    try {
      runExpectingFailure("expectation failure check", [
        path.join(root, "scripts", "harness.mjs"),
        "run",
        path.relative(root, failingScenarioPath),
      ]);
      const failedPointer = JSON.parse(await readFile(path.join(root, "artifacts", "last-run.json"), "utf8"));
      const failedResult = JSON.parse(await readFile(path.join(root, failedPointer.result), "utf8"));
      if (failedPointer.status !== "failed" || failedResult.status !== "failed" ||
          !failedResult.viewports[0].steps[1].error?.includes("Expectation failed") ||
          !failedResult.viewports[0].steps[1].screenshot) {
        throw new Error("expectation failure did not produce the required failed result and screenshot.");
      }
      console.log("Expectation failure verified: non-zero exit, failed result, and captured screenshot.");
    } finally {
      await unlink(failingScenarioPath);
    }
  }
} catch (error) {
  console.error(`verify: ${error.message}`);
  process.exitCode = 1;
}
