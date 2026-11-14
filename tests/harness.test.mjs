import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildScaffoldScenario,
  compareRuns,
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
  promoteExpectsFromRun,
  createFeedback,
  updateFeedback,
  bundleFeedback,
  listFeedback,
  agentPanelState,
  runAttach,
  formatAttachPlan,
  planElementAdopt,
  setupProject,
  stopChild,
  validateConfig,
  validateScenario,
  withTimeout,
  writeRunIndex,
  writeScaffoldScenario,
} from "../scripts/harness.mjs";
import { normalizeUntil, PHASES } from "../scripts/attach.mjs";
import { chromiumStatus } from "../scripts/browser-setup.mjs";
import { defaultHostConfig, validateHostConfig } from "../scripts/host-config.mjs";
import {
  buildWorkspaceReview,
  collectGit,
  collectWorkspace,
  planWorkspaceAdopt,
  planWorkspaceCheckout,
  planWorkspaceCreate,
  planWorkspaceFetch,
} from "../scripts/workspace.mjs";
import { createShareInvite, listShares } from "../scripts/share.mjs";
import { planDesignApprove } from "../scripts/design-approve.mjs";

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

test("CLI parsing handles run, doctor, probe, scaffold, host-config, status, workspace, handoff, and serve", () => {
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
    checkout: null,
    create: null,
    start: null,
    review: null,
    adopt: null,
    approve: null,
    fetch: false,
    remote: null,
    path: null,
    paths: [],
    hunks: null,
    baseline: null,
    against: null,
    strict: false,
    list: false,
    createFeedback: false,
    body: null,
    route: null,
    viewport: null,
    element: null,
    elements: [],
    elementsAdopt: false,
    sourceBranch: null,
    withHandoff: false,
    runId: null,
    id: null,
    bundle: null,
    resolve: false,
    reopen: false,
    until: null,
    scenarioFile: null,
    skipDoctor: false,
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
  assert.deepEqual(parseArgs(["workspace", "--json"]), {
    ...base,
    action: "workspace",
    json: true,
  });
  assert.deepEqual(parseArgs(["workspace", "--checkout", "feature/demo", "--apply"]), {
    ...base,
    action: "workspace",
    checkout: "feature/demo",
    apply: true,
  });
  assert.deepEqual(parseArgs(["workspace", "--create", "feature/new", "--start", "main", "--apply"]), {
    ...base,
    action: "workspace",
    create: "feature/new",
    start: "main",
    apply: true,
  });
  assert.deepEqual(parseArgs(["workspace", "--review", "feature/demo", "--path", "app.js"]), {
    ...base,
    action: "workspace",
    review: "feature/demo",
    path: "app.js",
    paths: ["app.js"],
  });
  assert.deepEqual(parseArgs(["workspace", "--adopt", "feature/demo", "--apply"]), {
    ...base,
    action: "workspace",
    adopt: "feature/demo",
    apply: true,
  });
  assert.deepEqual(parseArgs(["workspace", "--adopt", "feature/demo", "--apply", "--note", "keep the header"]), {
    ...base,
    action: "workspace",
    adopt: "feature/demo",
    apply: true,
    note: "keep the header",
  });
  assert.deepEqual(parseArgs(["workspace", "--approve", "feature/demo", "--apply"]), {
    ...base,
    action: "workspace",
    approve: "feature/demo",
    apply: true,
  });
  assert.deepEqual(parseArgs(["workspace", "--approve", "feature/demo", "--apply", "--note", "Design approved"]), {
    ...base,
    action: "workspace",
    approve: "feature/demo",
    apply: true,
    note: "Design approved",
  });
  assert.deepEqual(parseArgs(["workspace", "--fetch", "--apply"]), {
    ...base,
    action: "workspace",
    fetch: true,
    apply: true,
  });
  assert.deepEqual(parseArgs(["workspace", "--fetch", "--remote", "origin", "--dry-run"]), {
    ...base,
    action: "workspace",
    fetch: true,
    remote: "origin",
    dryRun: true,
  });
  assert.deepEqual(parseArgs(["share", "--apply", "--note", "review hero"]), {
    ...base,
    action: "share",
    apply: true,
    note: "review hero",
  });
  assert.throws(() => parseArgs(["workspace", "--note", "x"]), /only valid with workspace --adopt/);
  assert.throws(() => parseArgs(["workspace", "--remote", "origin"]), /only valid with workspace --fetch/);
  assert.deepEqual(parseArgs(["handoff", "--from", "last-green", "--apply", "--note", "fix mobile"]), {
    ...base,
    action: "handoff",
    apply: true,
    from: "last-green",
    note: "fix mobile",
  });
  assert.deepEqual(parseArgs(["compare", "--baseline", "last-green", "--against", "last-run", "--json"]), {
    ...base,
    action: "compare",
    json: true,
    baseline: "last-green",
    against: "last-run",
  });
  assert.deepEqual(parseArgs(["promote", "--from", "last-green", "--apply", "--force", "--strict"]), {
    ...base,
    action: "promote",
    from: "last-green",
    apply: true,
    force: true,
    strict: true,
  });
  assert.deepEqual(parseArgs(["feedback", "--create", "--body", "Tighten CTA", "--route", "/", "--apply"]), {
    ...base,
    action: "feedback",
    createFeedback: true,
    body: "Tighten CTA",
    route: "/",
    apply: true,
  });
  assert.deepEqual(parseArgs(["elements", "--adopt", "--element", "ContinueButton", "--element", "WealthWidget", "--source-branch", "feature/x", "--with-handoff"]), {
    ...base,
    action: "elements",
    elementsAdopt: true,
    element: "ContinueButton",
    elements: ["ContinueButton", "WealthWidget"],
    sourceBranch: "feature/x",
    withHandoff: true,
  });
  assert.throws(() => parseArgs(["elements", "--element", "x"]), /requires --adopt/);
  assert.throws(() => parseArgs(["elements", "--adopt"]), /at least one --element/);
  assert.deepEqual(parseArgs(["feedback", "--bundle", "fb_1,fb_2", "--from", "last-green", "--force"]), {
    ...base,
    action: "feedback",
    bundle: "fb_1,fb_2",
    from: "last-green",
    force: true,
  });
  assert.deepEqual(parseArgs(["serve", "--port", "8791", "--json"]), {
    ...base,
    action: "serve",
    json: true,
    port: 8791,
  });
  assert.deepEqual(parseArgs(["attach", "--until", "scaffold", "--apply", "--yes", "--skip-doctor"]), {
    ...base,
    action: "attach",
    until: "scaffold",
    apply: true,
    yes: true,
    skipDoctor: true,
  });
  assert.deepEqual(parseArgs(["attach", "--dry-run", "--scenario", "scenarios/smoke.yaml", "--name", "smoke"]), {
    ...base,
    action: "attach",
    dryRun: true,
    scenarioFile: "scenarios/smoke.yaml",
    name: "smoke",
  });
  assert.throws(() => parseArgs(["run", "--dry-run"]), /scenario YAML path/);
  assert.throws(() => parseArgs(["doctor", "--apply"]), /read-only|mutating/);
  assert.throws(() => parseArgs(["setup", "--apply", "--dry-run"]), /cannot be used together/);
  assert.throws(() => parseArgs(["setup", "--yes"]), /only valid with setup when also passing --install-browser/);
  assert.throws(() => parseArgs(["setup", "some.yaml"]), /does not accept a scenario path/);
  assert.throws(() => parseArgs(["probe", "--apply"]), /does not accept/);
  assert.throws(() => parseArgs(["setup", "--force"]), /only valid with scaffold, host-config, handoff, workspace, promote, feedback, elements, attach, or share/);
  assert.throws(() => parseArgs(["host-config", "--apply"]), /require --init/);
  assert.throws(() => parseArgs(["status", "--from", "x"]), /only accepts --root and --json/);
  assert.throws(() => parseArgs(["workspace", "--apply"]), /require --checkout, --create, --adopt, --approve, or --fetch/);
  assert.throws(() => parseArgs(["workspace", "--checkout", "a", "--create", "b"]), /only one of/);
  assert.throws(() => parseArgs(["workspace", "--approve", "feature/x", "--path", "a.js"]), /whole-branch only/);
  assert.throws(() => parseArgs(["workspace", "--path", "x"]), /only valid with workspace --review or --adopt/);
  assert.throws(() => parseArgs(["workspace", "--hunks", "1"]), /only valid with workspace --adopt/);
  assert.throws(() => parseArgs(["workspace", "--adopt", "feature/x", "--hunks", "1"]), /exactly one --path/);
  assert.deepEqual(parseArgs(["workspace", "--adopt", "feature/demo", "--path", "a.js", "--path", "b.js", "--apply"]), {
    ...base,
    action: "workspace",
    adopt: "feature/demo",
    path: "a.js",
    paths: ["a.js", "b.js"],
    apply: true,
  });
  assert.deepEqual(parseArgs(["workspace", "--adopt", "feature/demo", "--path", "a.js", "--hunks", "1,3"]), {
    ...base,
    action: "workspace",
    adopt: "feature/demo",
    path: "a.js",
    paths: ["a.js"],
    hunks: "1,3",
  });
  assert.throws(() => parseArgs(["workspace", "--start", "main"]), /only valid with workspace --create/);
  assert.throws(() => parseArgs(["serve", "--apply"]), /read-only/);
  assert.throws(() => parseArgs(["compare", "--apply"]), /compare accepts|--baseline|--against|only/);
  assert.throws(() => parseArgs(["handoff", "--baseline", "x"]), /only valid with compare/);
  assert.throws(() => parseArgs(["compare", "--strict"]), /only valid with promote or attach/);
  assert.throws(() => parseArgs(["doctor", "--until", "probe"]), /only valid with attach/);
  assert.throws(() => parseArgs(["attach", "--checkout", "feature/x"]), /attach accepts/);
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
    assert.ok(steps.some((step) => step.id === "attach"));
    assert.ok(steps.some((step) => step.id === "browser"));
    assert.ok(steps.some((step) => step.id === "probe"));
    assert.ok(steps.some((step) => step.id === "scaffold"));
    assert.ok(steps.some((step) => step.id === "host-config"));
    assert.ok(steps.some((step) => step.id === "status"));
    assert.ok(steps.some((step) => step.id === "handoff"));
    assert.ok(steps.some((step) => step.id === "compare"));
    assert.ok(steps.some((step) => step.id === "promote"));
    assert.ok(steps.some((step) => step.id === "feedback"));
    assert.ok(steps.some((step) => step.id === "elements"));
    assert.ok(steps.some((step) => step.id === "serve"));
    assert.ok(steps.some((step) => step.id === "control-surface"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("attach until defaults and phase list", () => {
  assert.equal(normalizeUntil(null, { apply: false }), "probe");
  assert.equal(normalizeUntil(null, { apply: true }), "scaffold");
  assert.equal(normalizeUntil("run", { apply: true }), "run");
  assert.throws(() => normalizeUntil("nope", { apply: false }), /--until must be one of/);
  assert.deepEqual(PHASES, ["doctor", "setup", "browser", "probe", "scaffold", "run", "promote"]);
});

test("attach dry-run stops before probe when config is missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yxnh-attach-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "attach-demo",
      scripts: { dev: "node server.mjs" },
    }));
    let probed = false;
    const plan = await runAttach(root, {
      apply: false,
      probeApp: async () => {
        probed = true;
        return { ok: true, status: "ready", harness: { version: 1, commands: [{ name: "noop" }], state: { ok: true } } };
      },
      runScenario: async () => {
        throw new Error("runScenario should not run in dry-run");
      },
      loadJson: async () => ({ version: 1, app: { start: ["npm", "run", "dev"], url: "http://127.0.0.1:4173/" } }),
      validateConfig: (value) => value,
      loadScenario: async () => ({}),
      validateScenario: (value) => value,
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.until, "probe");
    assert.equal(plan.stoppedAt, "setup");
    assert.equal(plan.mode, "dry-run");
    assert.equal(plan.phases.probe.status, "skipped");
    assert.equal(probed, false);
    assert.match(formatAttachPlan(plan), /Attach: ready/);
    await assert.rejects(() => readFile(path.join(root, "harness.config.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("attach blocks when probe reports missing harness", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yxnh-attach-probe-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "attach-probe-fail",
      scripts: { start: "node -e \"require('http').createServer((_,r)=>r.end('ok')).listen(4173)\"" },
    }));
    await writeFile(path.join(root, "harness.config.json"), JSON.stringify({
      version: 1,
      app: { start: ["node", "-e", "setInterval(()=>{},1000)"], url: "http://127.0.0.1:4173/" },
    }));
    const plan = await runAttach(root, {
      until: "probe",
      apply: true,
      yes: true,
      skipDoctor: true,
      probeApp: async () => ({ ok: false, status: "blocked", error: "window.__harness missing" }),
      runScenario: async () => ({ status: "failed" }),
      loadJson: async (filePath) => JSON.parse(await readFile(filePath, "utf8")),
      validateConfig: (value) => value,
      loadScenario: async () => ({}),
      validateScenario: (value) => value,
    });
    assert.equal(plan.ok, false);
    assert.equal(plan.stoppedAt, "probe");
    assert.match(plan.blockedReasons.join(" "), /__harness/);
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

test("workspace collects read-only git branch inventory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yxnh-workspace-"));
  try {
    const missing = collectWorkspace(root);
    assert.equal(missing.available, false);
    assert.equal(missing.readOnly, true);

    const git = (args) => {
      const result = spawnSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    git(["init", "-b", "main"]);
    git(["config", "user.email", "harness@example.com"]);
    git(["config", "user.name", "Harness Test"]);
    await writeFile(path.join(root, "README.md"), "workspace\n");
    git(["add", "README.md"]);
    git(["commit", "-m", "init"]);
    git(["branch", "feature/demo"]);

    const workspace = collectWorkspace(root);
    assert.equal(workspace.available, true);
    assert.equal(workspace.branch, "main");
    assert.equal(workspace.dirty, false);
    assert.ok(workspace.commit);
    assert.ok(workspace.branches.some((entry) => entry.name === "main" && entry.current));
    assert.ok(workspace.branches.some((entry) => entry.name === "feature/demo" && !entry.current));
    assert.match(workspace.note, /review|adopt|checkout/i);

    const stamp = collectGit(root);
    assert.equal(stamp.branch, "main");
    assert.equal(stamp.dirty, false);
    assert.equal(stamp.commit, workspace.commit);

    const preview = planWorkspaceCheckout(root, { branch: "feature/demo", apply: false });
    assert.equal(preview.status, "ready");
    assert.equal(preview.to.branch, "feature/demo");
    assert.equal(collectWorkspace(root).branch, "main");

    const unknownBranch = planWorkspaceCheckout(root, { branch: "nope", apply: true });
    assert.equal(unknownBranch.status, "blocked");

    const applied = planWorkspaceCheckout(root, { branch: "feature/demo", apply: true });
    assert.equal(applied.status, "applied");
    assert.equal(collectWorkspace(root).branch, "feature/demo");

    const noop = planWorkspaceCheckout(root, { branch: "feature/demo", apply: true });
    assert.equal(noop.status, "noop");

    await writeFile(path.join(root, "dirty.txt"), "x\n");
    const dirtyBlocked = planWorkspaceCheckout(root, { branch: "main", apply: true });
    assert.equal(dirtyBlocked.status, "blocked");
    assert.match(dirtyBlocked.blockedReasons.join(" "), /dirty/i);

    const forced = planWorkspaceCheckout(root, { branch: "main", apply: true, force: true });
    assert.equal(forced.status, "applied");
    assert.equal(collectWorkspace(root).branch, "main");

    await rm(path.join(root, "dirty.txt"), { force: true });
    assert.equal(collectWorkspace(root).dirty, false);

    const createPreview = planWorkspaceCreate(root, { branch: "feature/new", apply: false });
    assert.equal(createPreview.status, "ready");
    assert.equal(createPreview.to.branch, "feature/new");
    assert.equal(collectWorkspace(root).branch, "main");

    const duplicate = planWorkspaceCreate(root, { branch: "feature/demo", apply: true });
    assert.equal(duplicate.status, "blocked");

    const created = planWorkspaceCreate(root, { branch: "feature/new", apply: true });
    assert.equal(created.status, "applied");
    assert.equal(collectWorkspace(root).branch, "feature/new");

    const fromMain = planWorkspaceCreate(root, {
      branch: "feature/from-main",
      from: "main",
      apply: true,
    });
    assert.equal(fromMain.status, "applied");
    assert.equal(fromMain.startPoint.ref, "main");
    assert.equal(collectWorkspace(root).branch, "feature/from-main");

    // Review + adopt: diverge feature/demo, then merge into current.
    git(["checkout", "feature/demo"]);
    await writeFile(path.join(root, "demo.txt"), "from-demo\n");
    git(["add", "demo.txt"]);
    git(["commit", "-m", "demo change"]);
    git(["checkout", "feature/from-main"]);

    const emptyReview = buildWorkspaceReview(root, { theirs: "main" });
    assert.ok(emptyReview.status === "ready" || emptyReview.status === "noop");

    const review = buildWorkspaceReview(root, { theirs: "feature/demo" });
    assert.equal(review.status, "ready");
    assert.ok(review.files.some((file) => file.path === "demo.txt"));
    assert.equal(review.yours.branch, "feature/from-main");
    assert.equal(review.theirs.branch, "feature/demo");

    const patched = buildWorkspaceReview(root, { theirs: "feature/demo", path: "demo.txt" });
    assert.equal(patched.status, "ready");
    assert.match(patched.patch?.text || "", /from-demo/);

    const adoptPreview = planWorkspaceAdopt(root, { theirs: "feature/demo", apply: false });
    assert.equal(adoptPreview.status, "ready");
    assert.equal(collectWorkspace(root).branch, "feature/from-main");
    assert.equal(await readFile(path.join(root, "demo.txt"), "utf8").catch(() => null), null);

    const adopted = planWorkspaceAdopt(root, { theirs: "feature/demo", apply: true });
    assert.equal(adopted.status, "applied");
    assert.equal(collectWorkspace(root).branch, "feature/from-main");
    assert.equal(await readFile(path.join(root, "demo.txt"), "utf8"), "from-demo\n");

    // Second diverge + adopt with a merge note (forces merge commit).
    git(["checkout", "-b", "feature/noted"]);
    await writeFile(path.join(root, "noted.txt"), "noted\n");
    git(["add", "noted.txt"]);
    git(["commit", "-m", "noted change"]);
    git(["checkout", "feature/from-main"]);
    const notedPreview = planWorkspaceAdopt(root, {
      theirs: "feature/noted",
      apply: false,
      comment: "Keep layout; tweak copy later.",
    });
    assert.equal(notedPreview.status, "ready");
    assert.equal(notedPreview.comment, "Keep layout; tweak copy later.");
    assert.match(notedPreview.mergeMessage, /Keep layout/);

    const noted = planWorkspaceAdopt(root, {
      theirs: "feature/noted",
      apply: true,
      comment: "Keep layout; tweak copy later.",
    });
    assert.equal(noted.status, "applied");
    assert.equal(noted.comment, "Keep layout; tweak copy later.");
    const log = git(["log", "-1", "--pretty=%B"]);
    assert.match(log, /Adopt feature\/noted into feature\/from-main/);
    assert.match(log, /Keep layout; tweak copy later/);
    assert.equal(await readFile(path.join(root, "noted.txt"), "utf8"), "noted\n");

    const tooLong = planWorkspaceAdopt(root, {
      theirs: "feature/noted",
      apply: false,
      comment: "x".repeat(2001),
    });
    assert.equal(tooLong.status, "blocked");

    // File adopt: diverge again, take only one path into the index.
    git(["checkout", "-b", "feature/partial"]);
    await writeFile(path.join(root, "keep-me.txt"), "keep\n");
    await writeFile(path.join(root, "take-me.txt"), "take\n");
    git(["add", "keep-me.txt", "take-me.txt"]);
    git(["commit", "-m", "partial files"]);
    git(["checkout", "feature/from-main"]);
    const filePreview = planWorkspaceAdopt(root, {
      theirs: "feature/partial",
      paths: ["take-me.txt"],
      apply: false,
    });
    assert.equal(filePreview.status, "ready");
    assert.equal(filePreview.mode, "files");
    assert.deepEqual(filePreview.paths, ["take-me.txt"]);
    const fileAdopted = planWorkspaceAdopt(root, {
      theirs: "feature/partial",
      paths: ["take-me.txt"],
      apply: true,
    });
    assert.equal(fileAdopted.status, "applied");
    assert.equal(await readFile(path.join(root, "take-me.txt"), "utf8"), "take\n");
    assert.equal(await readFile(path.join(root, "keep-me.txt"), "utf8").catch(() => null), null);
    // Reset staged partial adopt so later checks stay clean.
    git(["reset", "--hard", "HEAD"]);

    // Hunk adopt on a modified tracked file (two distant hunks; take only the first).
    const baseLines = Array.from({ length: 40 }, (_, index) => `line-${index + 1}`);
    await writeFile(path.join(root, "shared.txt"), `${baseLines.join("\n")}\n`);
    git(["add", "shared.txt"]);
    git(["commit", "-m", "shared base"]);
    git(["checkout", "-b", "feature/hunks"]);
    const edited = [...baseLines];
    edited[1] = "LINE-2-EDIT";
    edited[35] = "LINE-36-EDIT";
    await writeFile(path.join(root, "shared.txt"), `${edited.join("\n")}\n`);
    git(["add", "shared.txt"]);
    git(["commit", "-m", "shared edits"]);
    git(["checkout", "feature/from-main"]);
    const hunkReview = buildWorkspaceReview(root, { theirs: "feature/hunks", path: "shared.txt" });
    assert.equal(hunkReview.status, "ready");
    assert.match(hunkReview.patch?.text || "", /LINE-2-EDIT/);
    const hunkPreview = planWorkspaceAdopt(root, {
      theirs: "feature/hunks",
      paths: ["shared.txt"],
      hunks: [1],
      apply: false,
    });
    assert.equal(hunkPreview.status, "ready");
    assert.equal(hunkPreview.mode, "hunks");
    assert.ok((hunkPreview.hunksAvailable || 0) >= 2);
    const hunkApplied = planWorkspaceAdopt(root, {
      theirs: "feature/hunks",
      paths: ["shared.txt"],
      hunks: [1],
      apply: true,
    });
    assert.equal(hunkApplied.status, "applied");
    const sharedAfter = await readFile(path.join(root, "shared.txt"), "utf8");
    assert.match(sharedAfter, /LINE-2-EDIT/);
    assert.doesNotMatch(sharedAfter, /LINE-36-EDIT/);
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
    assert.equal(overview.api.readOnly, false);
    assert.deepEqual(overview.api.localWrites, [
      "POST /api/v1/workspace/adopt",
      "POST /api/v1/workspace/approve",
      "POST /api/v1/workspace/fetch",
      "POST /api/v1/feedback",
      "PATCH /api/v1/feedback/:id",
      "POST /api/v1/feedback/bundle",
      "POST /api/v1/elements/adopt",
      "POST /api/v1/attach",
      "POST /api/v1/share",
    ]);
    assert.equal(overview.workspace.available, false);

    const workspace = await fetch(`${listening.url}api/v1/workspace`).then((response) => response.json());
    assert.equal(workspace.available, false);
    assert.equal(workspace.readOnly, true);

    const ui = await fetch(listening.url);
    assert.equal(ui.status, 200);
    assert.match(ui.headers.get("content-type") || "", /text\/html/);
    const uiHtml = await ui.text();
    assert.match(uiHtml, /YXNHarness/);
    assert.match(uiHtml, /Branches/);

    const css = await fetch(`${listening.url}cockpit/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") || "", /text\/css/);

    const apiIndex = await fetch(`${listening.url}api/v1`).then((response) => response.json());
    assert.equal(apiIndex.name, "yxnharness-cockpit-api");
    assert.equal(apiIndex.links.ui, "/");
    assert.ok(apiIndex.links.review);
    assert.ok(apiIndex.links.adopt);
    assert.ok(apiIndex.links.compare);
    assert.ok(apiIndex.links.promote);
    assert.ok(apiIndex.links.feedback);
    assert.ok(apiIndex.links.attach);
    assert.ok(apiIndex.links.share);
    assert.ok(apiIndex.links.fetch);
    assert.ok(apiIndex.links.approve);
    assert.ok(apiIndex.links.agent);

    const attachMissing = await fetch(`${listening.url}api/v1/attach`);
    assert.equal(attachMissing.status, 503);
    const attachMissingBody = await attachMissing.json();
    assert.match(attachMissingBody.error || "", /Attach runner is not configured/);

    const sharesEmpty = await fetch(`${listening.url}api/v1/share`).then((response) => response.json());
    assert.equal(sharesEmpty.shares.length, 0);

    const sharePreview = await fetch(`${listening.url}api/v1/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apply: false, note: "preview invite" }),
    }).then((response) => response.json());
    assert.equal(sharePreview.status, "ready");
    assert.equal(sharePreview.access.grant, "view");
    assert.equal(sharePreview.manifest.access.neverGrants.includes("merge"), true);

    const fetchPreview = await fetch(`${listening.url}api/v1/workspace/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apply: false }),
    }).then((response) => response.json());
    assert.equal(fetchPreview.status, "blocked");

    const agent = await fetch(`${listening.url}api/v1/agent`).then((response) => response.json());
    assert.equal(agent.connected, false);

    const created = await fetch(`${listening.url}api/v1/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Tighten CTA spacing", route: "/", apply: true }),
    }).then((response) => response.json());
    assert.equal(created.status, "written");
    assert.ok(created.thread?.threadId);

    const listed = await fetch(`${listening.url}api/v1/feedback`).then((response) => response.json());
    assert.ok(listed.threads.some((thread) => thread.threadId === created.thread.threadId));

    const reviewMissing = await fetch(`${listening.url}api/v1/workspace/review?ref=main`);
    assert.equal(reviewMissing.status, 400);

    const adoptBlocked = await fetch(`${listening.url}api/v1/workspace/adopt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", apply: false }),
    }).then((response) => response.json());
    assert.equal(adoptBlocked.status, "blocked");

    const compareMissing = await fetch(`${listening.url}api/v1/compare`);
    assert.equal(compareMissing.status, 400);

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

test("cockpit attach API dry-run and apply via injected runner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yxnh-attach-api-"));
  let api;
  const calls = [];
  try {
    await writeFile(path.join(root, "harness.host.json"), JSON.stringify({
      version: 1,
      host: { projectLabel: "attach-api", preferredAgent: "cursor" },
    }));
    api = createCockpitApi({
      root,
      port: 0,
      host: "127.0.0.1",
      attachRunner: async (options) => {
        calls.push(options);
        return {
          ok: true,
          status: options.apply ? "applied" : "ready",
          until: options.until || "probe",
          stoppedAt: options.until || "probe",
          dryRun: !options.apply,
          explanation: options.apply ? "Attach applied (mock)." : "Attach dry-run (mock).",
          next: ["npm run harness -- attach --until scaffold --apply"],
          phases: [],
        };
      },
    });
    const listening = await api.listen();

    const preview = await fetch(`${listening.url}api/v1/attach?until=probe`).then((response) => {
      assert.equal(response.status, 200);
      return response.json();
    });
    assert.equal(preview.status, "ready");
    assert.equal(preview.http.apply, false);
    assert.deepEqual(preview.phasesAvailable, PHASES);
    assert.equal(calls.at(-1).apply, false);
    assert.equal(calls.at(-1).until, "probe");
    assert.equal(calls.at(-1).yes, false);

    const dryPost = await fetch(`${listening.url}api/v1/attach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ until: "scaffold", yes: true }),
    }).then((response) => {
      assert.equal(response.status, 200);
      return response.json();
    });
    assert.equal(dryPost.status, "ready");
    assert.equal(calls.at(-1).apply, false);
    assert.equal(calls.at(-1).until, "scaffold");
    assert.equal(calls.at(-1).yes, true);

    const applied = await fetch(`${listening.url}api/v1/attach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ until: "scaffold", apply: true, installBrowser: true }),
    }).then((response) => {
      assert.equal(response.status, 200);
      return response.json();
    });
    assert.equal(applied.status, "applied");
    assert.equal(calls.at(-1).apply, true);
    assert.equal(calls.at(-1).installBrowser, true);
    assert.equal(calls.length, 3);
  } finally {
    if (api) await api.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("design approve merges branch with Design approved note and next steps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yxnh-approve-"));
  try {
    const run = (args) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    };
    run(["init", "-b", "main"]);
    run(["config", "user.email", "test@example.com"]);
    run(["config", "user.name", "Test"]);
    await writeFile(path.join(root, "app.js"), "v1\n");
    run(["add", "app.js"]);
    run(["commit", "-m", "base"]);
    run(["checkout", "-b", "feature/design"]);
    await writeFile(path.join(root, "app.js"), "v2\n");
    run(["add", "app.js"]);
    run(["commit", "-m", "design"]);
    run(["checkout", "main"]);

    const preview = await planDesignApprove(root, { theirs: "feature/design", apply: false });
    assert.equal(preview.status, "ready");
    assert.equal(preview.note, "Design approved");
    assert.equal(preview.adopt.comment, "Design approved");
    assert.ok(preview.next.some((step) => /--approve/.test(step)));

    const applied = await planDesignApprove(root, {
      theirs: "feature/design",
      apply: true,
      note: "Design approved · keep header",
    });
    assert.equal(applied.status, "applied", applied.blockedReasons?.join("; ") || applied.explanation);
    assert.equal(applied.note, "Design approved · keep header");
    assert.match(applied.explanation, /Design approved/);
    assert.ok(applied.next.some((step) => /git push/.test(step)));
    assert.ok(applied.next.some((step) => /fetch/.test(step)));
    assert.equal(collectWorkspace(root).branch, "main");
    assert.match(await readFile(path.join(root, "app.js"), "utf8"), /v2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("share invite writes view-only package and respects host policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yxnh-share-"));
  try {
    const preview = await createShareInvite(root, { apply: false, note: "hero review" });
    assert.equal(preview.status, "ready");
    assert.equal(preview.mode, "dry-run");
    assert.equal(preview.manifest.access.grant, "view");
    assert.deepEqual(preview.manifest.access.neverGrants, ["write", "merge", "admin"]);
    assert.equal(preview.manifest.delivery.future, "web-link");

    const written = await createShareInvite(root, { apply: true, note: "hero review" });
    assert.equal(written.status, "written");
    assert.ok(written.path.startsWith("artifacts/shares/"));
    const shareJson = JSON.parse(await readFile(path.join(root, written.path, "share.json"), "utf8"));
    assert.equal(shareJson.access.grant, "view");
    assert.match(shareJson.designApproval.commandPreview, /workspace --adopt/);
    const listed = await listShares(root);
    assert.equal(listed.shares.length, 1);
    assert.equal(listed.lastShare.shareId, written.shareId);

    await writeFile(path.join(root, "harness.host.json"), JSON.stringify({
      ...defaultHostConfig({ projectLabel: "blocked-share" }),
      access: { visibility: "private", shareLinkGrant: "none", mergeAuthority: "host" },
    }));
    const blocked = await createShareInvite(root, { apply: true });
    assert.equal(blocked.status, "blocked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace fetch refreshes remote-tracking refs on demand", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yxnh-fetch-"));
  const bare = await mkdtemp(path.join(os.tmpdir(), "yxnh-fetch-bare-"));
  try {
    const run = (cwd, args) => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    };
    run(root, ["init"]);
    run(root, ["config", "user.email", "test@example.com"]);
    run(root, ["config", "user.name", "Test"]);
    await writeFile(path.join(root, "README.md"), "one\n");
    run(root, ["add", "README.md"]);
    run(root, ["commit", "-m", "init"]);
    run(bare, ["init", "--bare"]);
    run(root, ["remote", "add", "origin", bare]);
    run(root, ["push", "-u", "origin", "HEAD:main"]);

    const preview = planWorkspaceFetch(root, { apply: false });
    assert.equal(preview.status, "ready");
    assert.equal(preview.mode, "dry-run");
    assert.ok(preview.remotes.some((entry) => entry.name === "origin"));

    run(root, ["checkout", "-b", "feature/share"]);
    await writeFile(path.join(root, "README.md"), "two\n");
    run(root, ["add", "README.md"]);
    run(root, ["commit", "-m", "feature"]);
    run(root, ["push", "origin", "feature/share"]);
    run(root, ["checkout", "main"]);
    run(root, ["branch", "-D", "feature/share"]);

    const applied = planWorkspaceFetch(root, { apply: true, remote: "origin" });
    assert.equal(applied.status, "applied");
    assert.ok(applied.after.remoteTrackingCount >= 1);
    assert.ok(
      applied.after.sample.some((entry) => entry.name === "origin/feature/share" || entry.name?.endsWith("/feature/share")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  }
});

test("compare diffs state and screenshots between two runs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yxnh-compare-"));
  try {
    const baselineId = "2026-01-01T00-00-00-000Z-1";
    const candidateId = "2026-01-01T00-00-00-000Z-2";
    const makeRun = async (runId, { nameValue, screenshotBytes }) => {
      const runDir = path.join(root, "artifacts", runId);
      await mkdir(path.join(runDir, "screenshots"), { recursive: true });
      await writeFile(path.join(runDir, "screenshots", "desktop-01.png"), screenshotBytes);
      await writeFile(path.join(runDir, "result.json"), JSON.stringify({
        version: 1,
        runId,
        scenario: { name: "demo", path: "scenarios/demo.yaml" },
        status: "passed",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        durationMs: 1000,
        counts: { viewports: 1, steps: 1, failures: 0, screenshots: 1 },
        viewports: [{
          name: "desktop",
          status: "passed",
          steps: [{
            index: 0,
            command: "setName",
            status: "passed",
            before: { name: "" },
            after: { name: nameValue },
            screenshot: "screenshots/desktop-01.png",
          }],
        }],
        artifacts: {
          stateLog: "state.jsonl",
          appLog: "app.log",
          screenshots: ["screenshots/desktop-01.png"],
          contactSheet: null,
        },
      }));
    };

    await makeRun(baselineId, { nameValue: "Alex", screenshotBytes: "png-a" });
    await makeRun(candidateId, { nameValue: "Alex", screenshotBytes: "png-a" });
    await writeFile(path.join(root, "artifacts", "last-green.json"), JSON.stringify({
      runId: baselineId,
      scenario: "demo",
      result: `artifacts/${baselineId}/result.json`,
    }));
    await writeFile(path.join(root, "artifacts", "last-run.json"), JSON.stringify({
      runId: candidateId,
      scenario: "demo",
      result: `artifacts/${candidateId}/result.json`,
      status: "passed",
    }));

    const equal = await compareRuns(root, { baseline: "last-green", against: "last-run" });
    assert.equal(equal.status, "equal");
    assert.equal(equal.ok, true);

    await makeRun(candidateId, { nameValue: "Blake", screenshotBytes: "png-b" });
    const changed = await compareRuns(root, {
      baseline: baselineId,
      against: candidateId,
    });
    assert.equal(changed.status, "changed");
    assert.equal(changed.ok, false);
    assert.ok(changed.summary.stateChanges >= 1);
    assert.ok(changed.summary.screenshotChanges >= 1);
    assert.ok(changed.differences.states.some((entry) => entry.key.includes("setName")));

    const same = await compareRuns(root, { baseline: baselineId, against: baselineId });
    assert.equal(same.status, "equal");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promote copies after-state from a green run into scenario expects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yxnh-promote-"));
  try {
    const runId = "2026-02-01T00-00-00-000Z-1";
    await mkdir(path.join(root, "scenarios"), { recursive: true });
    await mkdir(path.join(root, "artifacts", runId, "screenshots"), { recursive: true });
    await writeFile(path.join(root, "scenarios", "demo.yaml"), [
      "version: 1",
      "name: demo",
      "viewports:",
      "  - name: desktop",
      "    width: 1280",
      "    height: 800",
      "steps:",
      "  - name: enter name",
      "    command: setName",
      "    payload:",
      "      value: Alex",
      "    snapshot: name-entered",
      "  - name: advance clock",
      "    clock:",
      "      advance: 125",
      "    snapshot: clock-advanced",
      "",
    ].join("\n"));
    await writeFile(path.join(root, "artifacts", runId, "result.json"), JSON.stringify({
      version: 1,
      runId,
      scenario: { name: "demo", path: "scenarios/demo.yaml" },
      status: "passed",
      startedAt: "2026-02-01T00:00:00.000Z",
      finishedAt: "2026-02-01T00:00:01.000Z",
      durationMs: 1000,
      counts: { viewports: 1, steps: 2, failures: 0, screenshots: 0 },
      viewports: [{
        name: "desktop",
        status: "passed",
        steps: [
          {
            index: 0,
            command: "setName",
            status: "passed",
            after: { step: "details", values: { name: "Alex" }, canNext: true },
          },
          {
            index: 1,
            name: "advance clock",
            status: "passed",
            clock: { operation: "advance", milliseconds: 125, now: 125 },
            clockTime: 125,
            after: { step: "details", values: { name: "Alex" }, canNext: true },
          },
        ],
      }],
      artifacts: { stateLog: "state.jsonl", appLog: "app.log", screenshots: [], contactSheet: null },
    }));
    await writeFile(path.join(root, "artifacts", "last-green.json"), JSON.stringify({
      runId,
      scenario: "demo",
      result: `artifacts/${runId}/result.json`,
    }));

    const preview = await promoteExpectsFromRun(root, { from: "last-green", apply: false });
    assert.equal(preview.status, "ready");
    assert.equal(preview.changedExpects, 2);
    assert.equal(preview.changedClocks, 1);
    assert.equal(preview.scenario.steps[0].expect.values.name, "Alex");
    assert.equal(preview.scenario.steps[1].expectClock, 125);
    assert.match(await readFile(path.join(root, "scenarios", "demo.yaml"), "utf8"), /snapshot: name-entered/);
    assert.doesNotMatch(await readFile(path.join(root, "scenarios", "demo.yaml"), "utf8"), /expect:/);

    const blocked = await promoteExpectsFromRun(root, { from: "last-green", apply: true });
    assert.equal(blocked.status, "blocked");

    const written = await promoteExpectsFromRun(root, { from: "last-green", apply: true, force: true });
    assert.equal(written.status, "written");
    const yamlText = await readFile(path.join(root, "scenarios", "demo.yaml"), "utf8");
    assert.match(yamlText, /expect:/);
    assert.match(yamlText, /expectClock: 125/);
    assert.match(yamlText, /name: Alex/);
    validateScenario(written.scenario, "scenarios/demo.yaml");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("feedback threads persist, resolve, and bundle into handoffs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yxnh-feedback-"));
  try {
    const runId = "2026-03-01T00-00-00-000Z-1";
    await mkdir(path.join(root, "artifacts", runId, "screenshots"), { recursive: true });
    await writeFile(path.join(root, "artifacts", runId, "result.json"), JSON.stringify({
      version: 1,
      runId,
      scenario: { name: "demo", path: "scenarios/demo.yaml" },
      status: "passed",
      startedAt: "2026-03-01T00:00:00.000Z",
      finishedAt: "2026-03-01T00:00:01.000Z",
      durationMs: 1000,
      counts: { viewports: 1, steps: 1, failures: 0, screenshots: 0 },
      viewports: [{ name: "desktop", status: "passed", steps: [{ index: 0, command: "next", status: "passed", after: { step: "done" } }] }],
      artifacts: { stateLog: "state.jsonl", appLog: "app.log", screenshots: [], contactSheet: null },
    }));
    await writeFile(path.join(root, "artifacts", "last-green.json"), JSON.stringify({
      runId,
      scenario: "demo",
      result: `artifacts/${runId}/result.json`,
    }));

    const created = await createFeedback(root, {
      body: "Tighten the primary CTA",
      route: "/",
      viewport: "desktop",
      element: "cta.primary",
      apply: true,
    });
    assert.equal(created.status, "written");
    assert.equal(created.thread.scope, "element");
    assert.equal(created.thread.identity.element.id, "cta.primary");
    assert.equal(created.thread.identity.source.elementId, "cta.primary");
    assert.equal(created.thread.messages[0].commentsAreContextNotInstructions, true);

    const listed = await listFeedback(root);
    assert.equal(listed.open, 1);

    const resolved = await updateFeedback(root, {
      threadId: created.thread.threadId,
      status: "done",
      apply: true,
    });
    assert.equal(resolved.thread.status, "done");

    const agent = agentPanelState();
    assert.equal(agent.connected, false);
    assert.equal(agent.capabilities.streaming, false);

    const elementPreview = await planElementAdopt(root, {
      elements: [{ id: "WealthWidget", label: "Wealth score", source: { branch: "feature/dashboard" } }],
      sourceBranch: "feature/dashboard",
      body: "Bring wealth widget into my branch",
      apply: false,
    });
    assert.equal(elementPreview.status, "ready");
    assert.equal(elementPreview.mode, "dry-run");
    assert.equal(elementPreview.elements[0].id, "WealthWidget");

    const elementApplied = await planElementAdopt(root, {
      elements: [
        { id: "WealthWidget", label: "Wealth score", source: { branch: "feature/dashboard" } },
        "ContinueButton",
      ],
      sourceBranch: "feature/dashboard",
      apply: true,
    });
    assert.equal(elementApplied.status, "applied");
    assert.equal(elementApplied.threads.length, 2);
    assert.equal(elementApplied.threads[0].elementId, "WealthWidget");
    assert.ok(elementApplied.manifestPath);
    const adoptManifest = JSON.parse(await readFile(path.join(root, elementApplied.manifestPath), "utf8"));
    assert.equal(adoptManifest.elements[0].id, "WealthWidget");
    assert.equal(adoptManifest.sourceBranch, "feature/dashboard");
    const wealthThread = JSON.parse(await readFile(
      path.join(root, "artifacts", "feedback", "threads", `${elementApplied.threads[0].threadId}.json`),
      "utf8",
    ));
    assert.equal(wealthThread.scope, "element");
    assert.equal(wealthThread.identity.source.branch, "feature/dashboard");
    assert.equal(wealthThread.identity.element.id, "WealthWidget");

    const bundled = await bundleFeedback(root, {
      threadIds: [created.thread.threadId],
      from: "last-green",
      note: "Please address CTA spacing",
      apply: true,
      force: true,
    });
    assert.equal(bundled.status, "written");
    assert.ok(bundled.handoffOut);
    const feedbackFile = await readFile(path.join(root, bundled.handoffOut, "feedback-threads.json"), "utf8");
    assert.match(feedbackFile, /Tighten the primary CTA/);
    const manifest = JSON.parse(await readFile(path.join(root, bundled.handoffOut, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.feedback.threadIds, [created.thread.threadId]);
    const after = await listFeedback(root);
    assert.equal(after.bundled, 1);
  } finally {
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

test("doctor marks plain existing web apps as agent-attachable", async () => {
  const fixture = path.resolve("examples/foreign-booking");
  const report = await inspectProject(fixture);
  assert.equal(report.project.platform, "web");
  assert.deepEqual(report.project.commands.start, ["npm", "run", "dev"]);
  assert.equal(report.agentAttach.mode, "existing-project");
  assert.equal(report.agentAttach.attachable, true);
  assert.equal(report.agentAttach.runner, "web-browser");
  assert.ok(report.agentAttach.docs.includes("docs/attach-existing.md"));
  assert.ok(report.agentAttach.docs.includes("docs/platforms.md"));
  assert.match(report.agentAttach.note, /coding agent performs attach/i);

  const steps = explainNextSteps({
    ...report,
    harness: {
      ...report.harness,
      configExists: false,
      controlSurface: { status: "no-reference", files: [] },
    },
  });
  const control = steps.find((step) => step.id === "control-surface");
  assert.ok(control);
  assert.match(control.why, /AGENT TASK/);
  assert.match(control.why, /platforms\.md|Swift|HarnessControlling/i);
  assert.ok(Array.isArray(control.agentChecklist) && control.agentChecklist.length >= 3);
});

test("doctor detects Swift projects as planned macos runner, not attachable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yxnh-swift-"));
  try {
    await writeFile(path.join(root, "Package.swift"), "// swift-tools-version: 5.9\n");
    await writeFile(path.join(root, "App.swift"), "protocol HarnessControlling {}\n");
    const report = await inspectProject(root);
    assert.ok(report.project.languageMarkers.includes("Swift"));
    assert.equal(report.project.platform, "macos");
    assert.equal(report.agentAttach.runner, "macos-swift");
    assert.equal(report.agentAttach.attachable, false);
    assert.equal(report.agentAttach.plannedOnly, true);
    assert.equal(report.harness.controlSurface.status, "reference-found");
    assert.ok(report.warnings.some((warning) => /planned/i.test(warning)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
