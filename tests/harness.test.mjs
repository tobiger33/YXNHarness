import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildScaffoldScenario,
  createCockpitApi,
  createHandoffPackage,
  ensureChromium,
  explainNextSteps,
  initHostConfig,
  inspectProject,
  isJsonValue,
  loadHostConfig,
  matchesExpected,
  parseArgs,
  setupProject,
  stopChild,
  validateConfig,
  validateScenario,
  withTimeout,
  writeRunIndex,
  writeScaffoldScenario,
} from "../scripts/harness.mjs";
import { chromiumStatus } from "../scripts/browser-setup.mjs";
import { defaultHostConfig, validateHostConfig } from "../scripts/host-config.mjs";

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

test("CLI parsing handles run, doctor, probe, scaffold, host-config, status, handoff, and serve", () => {
  const base = {
    dryRun: false,
    apply: false,
    json: false,
    installBrowser: false,
    yes: false,
    force: false,
    init: false,
    name: null,
    out: null,
    from: null,
    note: null,
    port: null,
  };
  assert.deepEqual(parseArgs(["--help"]), { help: true });
  assert.deepEqual(parseArgs(["run", "scenarios/demo.yaml", "--dry-run", "--root", "/tmp/app"]), {
    ...base,
    action: "run",
    dryRun: true,
    scenario: "scenarios/demo.yaml",
    root: "/tmp/app",
  });
  assert.deepEqual(parseArgs(["doctor", "--root", "/tmp/app", "--json"]), {
    ...base,
    action: "doctor",
    json: true,
    root: "/tmp/app",
  });
  assert.deepEqual(parseArgs(["setup", "--root", "/tmp/app", "--apply"]), {
    ...base,
    action: "setup",
    apply: true,
    root: "/tmp/app",
  });
  assert.deepEqual(parseArgs(["setup", "--install-browser", "--yes"]), {
    ...base,
    action: "setup",
    installBrowser: true,
    yes: true,
  });
  assert.deepEqual(parseArgs(["probe", "--json", "--yes"]), {
    ...base,
    action: "probe",
    json: true,
    yes: true,
  });
  assert.deepEqual(parseArgs(["scaffold", "--apply", "--name", "smoke", "--out", "scenarios/smoke.yaml"]), {
    ...base,
    action: "scaffold",
    apply: true,
    name: "smoke",
    out: "scenarios/smoke.yaml",
  });
  assert.deepEqual(parseArgs(["host-config", "--init", "--apply"]), {
    ...base,
    action: "host-config",
    apply: true,
    init: true,
  });
  assert.deepEqual(parseArgs(["status", "--json"]), {
    ...base,
    action: "status",
    json: true,
  });
  assert.deepEqual(parseArgs(["handoff", "--from", "last-green", "--apply", "--note", "fix mobile"]), {
    ...base,
    action: "handoff",
    apply: true,
    from: "last-green",
    note: "fix mobile",
  });
  assert.deepEqual(parseArgs(["serve", "--port", "8791", "--json"]), {
    ...base,
    action: "serve",
    json: true,
    port: 8791,
  });
  assert.throws(() => parseArgs(["run", "--dry-run"]), /scenario YAML path/);
  assert.throws(() => parseArgs(["doctor", "--apply"]), /read-only|mutating/);
  assert.throws(() => parseArgs(["setup", "--apply", "--dry-run"]), /cannot be used together/);
  assert.throws(() => parseArgs(["setup", "--yes"]), /only valid with setup when also passing --install-browser/);
  assert.throws(() => parseArgs(["setup", "some.yaml"]), /does not accept a scenario path/);
  assert.throws(() => parseArgs(["probe", "--apply"]), /does not accept/);
  assert.throws(() => parseArgs(["setup", "--force"]), /only valid with scaffold, host-config, or handoff/);
  assert.throws(() => parseArgs(["host-config", "--apply"]), /require --init/);
  assert.throws(() => parseArgs(["status", "--from", "x"]), /only accepts --root and --json/);
  assert.throws(() => parseArgs(["serve", "--apply"]), /read-only/);
  assert.throws(() => parseArgs(["run", "demo.yaml", "--unknown"]), /Unknown option/);
});

test("browser ensure requires host consent before installing", () => {
  const status = chromiumStatus();
  if (status.installed) {
    const ready = ensureChromium(process.cwd(), { yes: false });
    assert.equal(ready.ok, true);
    assert.equal(ready.action, "noop");
  } else {
    const blocked = ensureChromium(process.cwd(), { yes: false });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, "consent-required");
    assert.match(blocked.askUser, /May I install Chromium/);
    assert.match(blocked.resumeWith, /--install-browser --yes/);
  }
});

test("doctor next steps explain the host/agent workflow", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yxnh-next-steps-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "sample-app",
      scripts: { dev: "vite" },
      devDependencies: { vite: "6.0.0" },
    }));
    const report = await inspectProject(root);
    const steps = explainNextSteps(report);
    assert.equal(steps[0].id, "config");
    assert.ok(steps.some((step) => step.id === "browser"));
    assert.ok(steps.some((step) => step.id === "probe"));
    assert.ok(steps.some((step) => step.id === "scaffold"));
    assert.ok(steps.some((step) => step.id === "host-config"));
    assert.ok(steps.some((step) => step.id === "status"));
    assert.ok(steps.some((step) => step.id === "handoff"));
    assert.ok(steps.some((step) => step.id === "serve"));
    assert.ok(steps.some((step) => step.id === "control-surface"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host config defaults are private and never grant write via share links", async () => {
  const config = validateHostConfig(defaultHostConfig({ projectLabel: "demo" }));
  assert.equal(config.access.visibility, "private");
  assert.equal(config.access.mergeAuthority, "host");
  assert.equal(config.access.shareLinkGrant, "view");
  assert.equal(config.consent.requireExplicitYes, true);

  const root = await mkdtemp(path.join(os.tmpdir(), "yxnh-host-config-"));
  try {
    const preview = await initHostConfig(root, { apply: false });
    assert.equal(preview.status, "ready");
    await assert.rejects(readFile(path.join(root, "harness.host.json")));

    const written = await initHostConfig(root, { apply: true });
    assert.equal(written.status, "written");
    const loaded = await loadHostConfig(root);
    assert.equal(loaded.exists, true);
    assert.equal(loaded.config.host.projectLabel, path.basename(root));

    const blocked = await initHostConfig(root, { apply: true });
    assert.equal(blocked.status, "blocked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run index summarizes artifact directories and pointers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yxnh-run-index-"));
  try {
    const runId = "2026-01-01T00-00-00-000Z-1";
    const runDir = path.join(root, "artifacts", runId);
    await mkdir(path.join(runDir, "screenshots"), { recursive: true });
    await writeFile(path.join(runDir, "result.json"), JSON.stringify({
      version: 1,
      runId,
      scenario: { name: "demo", path: "scenarios/demo.yaml" },
      status: "passed",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
      counts: { viewports: 1, steps: 1, failures: 0, screenshots: 1 },
      artifacts: {
        stateLog: "state.jsonl",
        appLog: "app.log",
        screenshots: ["screenshots/a.png"],
        contactSheet: "contact-sheet.png",
      },
    }));
    await writeFile(path.join(root, "artifacts", "last-run.json"), JSON.stringify({
      runId,
      scenario: "demo",
      result: `artifacts/${runId}/result.json`,
      status: "passed",
    }));
    await writeFile(path.join(root, "artifacts", "last-green.json"), JSON.stringify({
      runId,
      scenario: "demo",
      result: `artifacts/${runId}/result.json`,
    }));

    const index = await writeRunIndex(root);
    assert.equal(index.summary.runCount, 1);
    assert.equal(index.summary.passed, 1);
    assert.equal(index.runs[0].scenario, "demo");
    assert.equal(index.pointers.lastRun.runId, runId);
    assert.match(await readFile(path.join(root, "artifacts", "index.json"), "utf8"), /"runCount": 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cockpit API serves host, runs, and artifacts on loopback only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yxnh-cockpit-api-"));
  let api;
  try {
    await writeFile(path.join(root, "harness.host.json"), JSON.stringify(defaultHostConfig({ projectLabel: "api-demo" }), null, 2));
    const runId = "2026-03-01T00-00-00-000Z-3";
    const runDir = path.join(root, "artifacts", runId);
    await mkdir(path.join(runDir, "screenshots"), { recursive: true });
    await writeFile(path.join(runDir, "result.json"), JSON.stringify({
      version: 1,
      runId,
      scenario: { name: "demo", path: "scenarios/demo.yaml" },
      status: "passed",
      startedAt: "2026-03-01T00:00:00.000Z",
      finishedAt: "2026-03-01T00:00:01.000Z",
      durationMs: 1000,
      counts: { viewports: 1, steps: 1, failures: 0, screenshots: 1 },
      artifacts: {
        stateLog: "state.jsonl",
        appLog: "app.log",
        screenshots: ["screenshots/a.png"],
        contactSheet: "contact-sheet.png",
      },
    }));
    await writeFile(path.join(runDir, "contact-sheet.png"), "png-bytes");
    await writeFile(path.join(root, "artifacts", "last-green.json"), JSON.stringify({
      runId,
      scenario: "demo",
      result: `artifacts/${runId}/result.json`,
    }));
    await mkdir(path.join(root, "artifacts", "handoffs"), { recursive: true });

    api = createCockpitApi({ root, port: 0, host: "127.0.0.1" });
    const listening = await api.listen();
    const overview = await fetch(`${listening.url}api/v1/overview`).then((response) => response.json());
    assert.equal(overview.host.config.host.projectLabel, "api-demo");
    assert.equal(overview.index.summary.runCount, 1);
    assert.equal(overview.api.readOnly, true);

    const ui = await fetch(listening.url);
    assert.equal(ui.status, 200);
    assert.match(ui.headers.get("content-type") || "", /text\/html/);
    assert.match(await ui.text(), /YXNHarness/);

    const css = await fetch(`${listening.url}cockpit/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") || "", /text\/css/);

    const apiIndex = await fetch(`${listening.url}api/v1`).then((response) => response.json());
    assert.equal(apiIndex.name, "yxnharness-cockpit-api");
    assert.equal(apiIndex.links.ui, "/");

    const run = await fetch(`${listening.url}api/v1/runs/${encodeURIComponent(runId)}`).then((response) => response.json());
    assert.equal(run.result.status, "passed");

    const artifact = await fetch(`${listening.url}api/v1/artifacts/${encodeURIComponent(runId)}/contact-sheet.png`);
    assert.equal(artifact.status, 200);
    assert.equal(await artifact.text(), "png-bytes");

    const forbidden = await fetch(`${listening.url}api/v1/artifacts/%2e%2e/%2e%2e/package.json`);
    assert.ok([403, 404].includes(forbidden.status), `expected blocked artifact escape, got ${forbidden.status}`);

    const uiEscape = await fetch(`${listening.url}cockpit/%2e%2e/package.json`);
    assert.ok([403, 404].includes(uiEscape.status), `expected blocked UI escape, got ${uiEscape.status}`);

    const post = await fetch(`${listening.url}api/v1/overview`, { method: "POST" });
    assert.equal(post.status, 405);
  } finally {
    if (api) await api.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("handoff packages a run as deliberate agent context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yxnh-handoff-"));
  try {
    const runId = "2026-01-02T00-00-00-000Z-9";
    const runDir = path.join(root, "artifacts", runId);
    await mkdir(path.join(runDir, "screenshots"), { recursive: true });
    await writeFile(path.join(runDir, "result.json"), JSON.stringify({
      version: 1,
      runId,
      scenario: { name: "demo", path: "scenarios/demo.yaml" },
      status: "passed",
      startedAt: "2026-01-02T00:00:00.000Z",
      finishedAt: "2026-01-02T00:00:01.000Z",
      durationMs: 1000,
      counts: { viewports: 1, steps: 1, failures: 0, screenshots: 1 },
      artifacts: {
        stateLog: "state.jsonl",
        appLog: "app.log",
        screenshots: ["screenshots/a.png"],
        contactSheet: "contact-sheet.png",
      },
    }));
    await writeFile(path.join(runDir, "state.jsonl"), `${JSON.stringify({ phase: "initial" })}\n`);
    await writeFile(path.join(runDir, "contact-sheet.png"), "png");
    await writeFile(path.join(runDir, "screenshots", "a.png"), "png");
    await writeFile(path.join(root, "artifacts", "last-green.json"), JSON.stringify({
      runId,
      scenario: "demo",
      result: `artifacts/${runId}/result.json`,
    }));
    await writeFile(path.join(root, "harness.host.json"), JSON.stringify(defaultHostConfig({ projectLabel: "demo" }), null, 2));

    const preview = await createHandoffPackage(root, { from: "last-green", apply: false, note: "check mobile" });
    assert.equal(preview.status, "ready");
    assert.equal(preview.manifest.guidance.commentsAreContextNotInstructions, true);
    assert.match(preview.manifest.note, /check mobile/);
    await assert.rejects(readFile(path.join(root, "artifacts", "handoffs", `handoff-${runId}`, "manifest.json")));

    const written = await createHandoffPackage(root, { from: "last-green", apply: true, note: "check mobile" });
    assert.equal(written.status, "written");
    const manifest = JSON.parse(await readFile(path.join(root, "artifacts", "handoffs", `handoff-${runId}`, "manifest.json"), "utf8"));
    assert.equal(manifest.source.runId, runId);
    assert.match(await readFile(path.join(root, "artifacts", "handoffs", `handoff-${runId}`, "AGENT_README.md"), "utf8"), /context/i);
    assert.equal(JSON.parse(await readFile(path.join(root, "artifacts", "last-handoff.json"), "utf8")).runId, runId);

    const blocked = await createHandoffPackage(root, { from: "last-green", apply: true });
    assert.equal(blocked.status, "blocked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scaffold builds a reviewable draft scenario from probed commands", async () => {
  const scenario = buildScaffoldScenario({
    name: "smoke",
    projectName: "demo",
    initialState: { step: "details" },
    commands: [
      {
        name: "setName",
        description: "Set the name",
        payloadSchema: {
          type: "object",
          required: ["value"],
          properties: { value: { type: "string" } },
        },
      },
      { name: "next", payloadSchema: { type: "null" } },
      { name: "noop" },
    ],
  });
  assert.equal(scenario.steps.length, 3);
  assert.equal(scenario.steps[0].payload.value, "example");
  assert.equal(scenario.steps[1].payload, null);
  assert.equal(scenario.steps[2].payload, undefined);
  validateScenario(scenario, "scaffold-test.yaml");

  const root = await mkdtemp(path.join(os.tmpdir(), "yxnh-scaffold-"));
  try {
    const preview = await writeScaffoldScenario(root, scenario, { apply: false });
    assert.equal(preview.status, "ready");
    assert.match(preview.yaml, /command: setName/);
    await assert.rejects(readFile(path.join(root, "scenarios", "smoke.yaml")));

    const written = await writeScaffoldScenario(root, scenario, { apply: true });
    assert.equal(written.status, "written");
    assert.match(await readFile(path.join(root, "scenarios", "smoke.yaml"), "utf8"), /snapshot: 01-setname/);

    const blocked = await writeScaffoldScenario(root, scenario, { apply: true });
    assert.equal(blocked.status, "blocked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
