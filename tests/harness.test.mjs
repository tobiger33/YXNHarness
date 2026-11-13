import assert from "node:assert/strict";
import test from "node:test";
import {
  isJsonValue,
  matchesExpected,
  parseArgs,
  validateConfig,
  validateScenario,
} from "../scripts/harness.mjs";

test("scenario validation accepts the supported data model", () => {
  const scenario = validateScenario({
    version: 1,
    name: "test-flow",
    viewports: [{ name: "mobile", width: 390, height: 844 }],
    steps: [{ command: "next", payload: null, expect: { step: "complete" }, snapshot: "done" }],
  }, "test.yaml");
  assert.equal(scenario.name, "test-flow");
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
});

test("configuration requires an argument-array start command and valid HTTP URL", () => {
  const config = validateConfig({
    version: 1,
    app: { start: ["node", "server.mjs"], url: "http://127.0.0.1:4173/" },
  });
  assert.equal(config.app.startupTimeoutMs, 15000);
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

test("CLI parsing requires one scenario and only supported flags", () => {
  assert.deepEqual(parseArgs(["--help"]), { help: true });
  assert.deepEqual(parseArgs(["run", "scenarios/demo.yaml", "--dry-run", "--root", "/tmp/app"]), {
    action: "run",
    dryRun: true,
    scenario: "scenarios/demo.yaml",
    root: "/tmp/app",
  });
  assert.throws(() => parseArgs(["run", "--dry-run"]), /scenario YAML path/);
  assert.throws(() => parseArgs(["run", "demo.yaml", "--unknown"]), /Unknown option/);
});
