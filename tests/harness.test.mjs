import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  inspectProject,
  isJsonValue,
  matchesExpected,
  parseArgs,
  setupProject,
  stopChild,
  validateConfig,
  validateScenario,
  withTimeout,
} from "../scripts/harness.mjs";

test("scenario validation accepts the supported data model", () => {
  const scenario = validateScenario({
    version: 1,
    name: "test-flow",
    viewports: [{ name: "mobile", width: 390, height: 844 }],
    steps: [{ command: "next", payload: null, expect: { step: "complete" }, snapshot: "done" }],
  }, "test.yaml");
  assert.equal(scenario.name, "test-flow");
  assert.equal(validateScenario({
    version: 1,
    name: "clock-flow",
    viewports: [{ name: "mobile", width: 390, height: 844 }],
    steps: [{ clock: { advance: 125 }, expectClock: 125 }],
  }, "clock.yaml").steps[0].clock.advance, 125);
});

test("scenario validation rejects malformed viewports, steps, and executable values", () => {
  assert.throws(() => validateScenario({
    version: 1,
    name: "x",
    viewports: [],
    steps: [{ command: "go" }],
  }, "x.yaml"), /invalid scenario/);
  assert.throws(() => validateScenario({
    version: 1,
    name: "x",
    viewports: [{ name: "x", width: 390, height: 844 }],
    steps: [{ command: "go", payload: new Date() }],
  }, "x.yaml"), /JSON-compatible/);
  assert.throws(() => validateScenario({
    version: 1,
    name: "x",
    viewports: [{ name: "x", width: 390, height: 844 }],
    steps: [{ command: "go", expect: ["not", "an", "object"] }],
  }, "x.yaml"), /must be object/);
  assert.throws(() => validateScenario({
    version: 1,
    name: "x",
    viewports: [{ name: "x", width: 390, height: 844 }],
    steps: [{ command: "go", clock: { seek: 1 } }],
  }, "x.yaml"), /invalid scenario/);
  assert.throws(() => validateScenario({
    version: 1,
    name: "x",
    viewports: [{ name: "x", width: 390, height: 844 }],
    steps: [{ clock: { advance: -1 } }],
  }, "x.yaml"), /invalid scenario/);
});

test("configuration requires an argument-array start command and valid HTTP URL", () => {
  const config = validateConfig({
    version: 1,
    app: { start: ["node", "server.mjs"], url: "http://127.0.0.1:4173/" },
  });
  assert.equal(config.app.startupTimeoutMs, 15000);
  assert.equal(config.app.navigationTimeoutMs, 30000);
  assert.equal(config.app.commandTimeoutMs, 10000);
  assert.throws(() => validateConfig({
    version: 1,
    app: { start: "node server.mjs", url: "http://127.0.0.1:4173" },
  }), /array of command arguments/);
  assert.throws(() => validateConfig({
    version: 1,
    app: { start: ["node", "server.mjs"], url: "file:///tmp/index.html" },
  }), /HTTP or HTTPS/);
  assert.throws(() => validateConfig({
    version: 1,
    app: { start: ["node", "server.mjs"], url: "https://example.com/" },
  }), /loopback/);
  assert.throws(() => validateConfig({
    version: 1,
    app: { start: ["node", "server.mjs"], url: "http://localhost:4173", inheritEnv: ["NODE_OPTIONS"] },
  }), /may not override runtime injection/);
  assert.throws(() => validateConfig({
    version: 1,
    app: {
      start: ["node", "server.mjs"],
      url: "http://127.0.0.1:4173",
      commandTimeoutMs: 100,
    },
  }), /commandTimeoutMs/);
});

test("harness operations time out with a clear error", async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 10, "test command"), /test command timed out after 10ms/);
  assert.equal(await withTimeout(Promise.resolve("done"), 100, "test command"), "done");
});

test("stopChild terminates a detached app process and its child process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yxnh-process-tree-"));
  const childPidPath = path.join(root, "child.pid");
  const source = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const child = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
    'process.on("SIGTERM", () => {});',
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const parent = spawn(process.execPath, ["-e", source], {
    detached: true,
    stdio: "ignore",
  });
  let childPid;
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        childPid = Number(await readFile(childPidPath, "utf8"));
        break;
      } catch {
        await delay(20);
      }
    }
    assert.ok(Number.isInteger(childPid) && childPid > 0, "test child process did not start");
    await stopChild(parent, { graceMs: 100, forceGraceMs: 2000 });

    const childDeadline = Date.now() + 2000;
    let childAlive = true;
    while (Date.now() < childDeadline) {
      try {
        process.kill(childPid, 0);
        await delay(25);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
        childAlive = false;
        break;
      }
    }
    assert.equal(childAlive, false, "child process remained alive after stopping the app process tree");
  } finally {
    await stopChild(parent);
    if (childPid) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("expectations compare nested state as a partial JSON object", () => {
  assert.equal(matchesExpected(
    { step: "complete", values: { name: "Alex", extra: true } },
    { step: "complete", values: { name: "Alex" } },
  ), null);
  assert.match(matchesExpected({ step: "details" }, { step: "complete" }), /state\.step expected/);
});

test("JSON values reject non-finite numbers and executable object types", () => {
  assert.equal(isJsonValue({ values: ["x", 1, null] }), true);
  assert.equal(isJsonValue(Number.NaN), false);
  assert.equal(isJsonValue(new Date()), false);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(isJsonValue(cyclic), false);
});

test("CLI parsing handles run, doctor, and safe setup modes", () => {
  assert.deepEqual(parseArgs(["--help"]), { help: true });
  assert.deepEqual(parseArgs(["run", "scenarios/demo.yaml", "--dry-run", "--root", "/tmp/app"]), {
    action: "run",
    dryRun: true,
    apply: false,
    json: false,
    scenario: "scenarios/demo.yaml",
    root: "/tmp/app",
  });
  assert.deepEqual(parseArgs(["doctor", "--root", "/tmp/app", "--json"]), {
    action: "doctor",
    dryRun: false,
    apply: false,
    json: true,
    root: "/tmp/app",
  });
  assert.deepEqual(parseArgs(["setup", "--root", "/tmp/app", "--apply"]), {
    action: "setup",
    dryRun: false,
    apply: true,
    json: false,
    root: "/tmp/app",
  });
  assert.throws(() => parseArgs(["run", "--dry-run"]), /scenario YAML path/);
  assert.throws(() => parseArgs(["doctor", "--apply"]), /read-only/);
  assert.throws(() => parseArgs(["setup", "--apply", "--dry-run"]), /cannot be used together/);
  assert.throws(() => parseArgs(["setup", "some.yaml"]), /does not accept a scenario path/);
  assert.throws(() => parseArgs(["run", "demo.yaml", "--unknown"]), /Unknown option/);
});

test("doctor detects web project facts and setup previews or safely writes configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yxnh-doctor-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "sample-app",
      packageManager: "npm@10.0.0",
      scripts: { dev: "vite", test: "vitest", build: "vite build" },
      dependencies: { react: "19.0.0" },
      devDependencies: { vite: "6.0.0" },
    }));
    await writeFile(path.join(root, "package-lock.json"), "{}");
    await writeFile(path.join(root, "index.html"), "<div id=\"root\"></div>");
    await writeFile(path.join(root, "src/main.tsx"), "window.__HARNESS_ENABLED__ = true;");

    const report = await inspectProject(root);
    assert.deepEqual(report.project.commands.start, ["npm", "run", "dev"]);
    assert.deepEqual(report.project.frameworks.map(({ name }) => name), ["Vite", "React"]);
    assert.deepEqual(report.project.entrypoints, ["index.html", "src/main.tsx"]);
    assert.equal(report.harness.controlSurface.status, "reference-found");

    const preview = await setupProject(root);
    assert.equal(preview.status, "ready");
    assert.deepEqual(preview.writes, ["harness.config.json"]);
    assert.match(preview.requiredAgentWork[0], /verify the full documented control contract/);
    await assert.rejects(readFile(path.join(root, "harness.config.json")));

    const applied = await setupProject(root, { apply: true });
    assert.equal(applied.status, "configured");
    assert.deepEqual(JSON.parse(await readFile(path.join(root, "harness.config.json"), "utf8")), {
      version: 1,
      app: {
        start: ["npm", "run", "dev"],
        url: "http://127.0.0.1:5173/",
        startupTimeoutMs: 20000,
      },
    });

    const configContents = await readFile(path.join(root, "harness.config.json"), "utf8");
    const existing = await setupProject(root, { apply: true });
    assert.equal(existing.status, "already-configured");
    assert.equal(await readFile(path.join(root, "harness.config.json"), "utf8"), configContents);

    await writeFile(path.join(root, "harness.config.json"), '{"preserve":true}\n');
    const invalid = await setupProject(root, { apply: true });
    assert.equal(invalid.status, "blocked");
    assert.equal(await readFile(path.join(root, "harness.config.json"), "utf8"), '{"preserve":true}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor does not count test fixtures as an app control surface", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yxnh-doctor-test-only-"));
  try {
    await mkdir(path.join(root, "tests"));
    await writeFile(path.join(root, "tests", "fixture.test.js"), "window.__harness = {};");
    const report = await inspectProject(root);
    assert.equal(report.harness.controlSurface.status, "no-reference");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setup blocks unsupported projects instead of inventing an app command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yxnh-doctor-blocked-"));
  try {
    await writeFile(path.join(root, "pyproject.toml"), "[project]\nname = 'sample'\n");
    const plan = await setupProject(root, { apply: true });
    assert.equal(plan.status, "blocked");
    assert.deepEqual(plan.writes, []);
    await assert.rejects(readFile(path.join(root, "harness.config.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
