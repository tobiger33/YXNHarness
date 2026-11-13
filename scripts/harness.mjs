#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import Ajv from "ajv";
import yaml from "js-yaml";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const scenarioSchema = require("../schema/scenario.schema.json");

const INSTALL_BROWSER_MESSAGE = "Chromium is missing. Install it with: npx playwright install chromium";
const JSON_SCHEMA_VALIDATOR = new Ajv({ strict: false, allErrors: true });
const SCENARIO_VALIDATOR = new Ajv({ strict: false, allErrors: true }).compile(scenarioSchema);
const SAFE_INHERITED_ENV = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM",
  "SystemRoot", "WINDIR", "PATHEXT", "ComSpec",
];

function parseArgs(argv) {
  const [action, ...rest] = argv;
  if (action === "--help" || action === "-h") return { help: true };
  if (action !== "run") {
    throw new Error('Usage: npm run harness -- run <scenario.yaml> [--root path] [--dry-run]\n       npm run harness -- --help');
  }

  const options = { action, dryRun: false };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--root") {
      const root = rest[index + 1];
      if (!root || root.startsWith("--")) throw new Error("--root requires a directory path.");
      options.root = root;
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option "${argument}".`);
    } else if (!options.scenario) {
      options.scenario = argument;
    } else {
      throw new Error(`Unexpected argument "${argument}".`);
    }
  }

  if (!options.scenario) throw new Error("A scenario YAML path is required.");
  return options;
}

function assert(condition, message) {
  if (!condition) throw new TypeError(`harness: ${message}`);
}

function validateScenario(scenario, scenarioPath) {
  assert(scenario && typeof scenario === "object" && !Array.isArray(scenario), `${scenarioPath} must contain a YAML object.`);
  assert(SCENARIO_VALIDATOR(scenario), `invalid scenario "${scenarioPath}": ${JSON.stringify(SCENARIO_VALIDATOR.errors)}`);
  assert(typeof scenario.name === "string" && scenario.name.trim(), "scenario needs a non-empty name.");
  assert(Array.isArray(scenario.viewports) && scenario.viewports.length > 0, "scenario needs at least one viewport.");
  assert(scenario.viewports.length <= 16, "scenario may define at most 16 viewports.");
  assert(Array.isArray(scenario.steps) && scenario.steps.length > 0, "scenario needs at least one step.");
  assert(scenario.steps.length <= 100, "scenario may define at most 100 steps.");

  const viewportNames = new Set();
  for (const [index, viewport] of scenario.viewports.entries()) {
    assert(viewport && typeof viewport === "object" && !Array.isArray(viewport), `viewports[${index}] must be an object.`);
    assert(typeof viewport.name === "string" && viewport.name.trim(), `viewports[${index}] needs a name.`);
    assert(!viewportNames.has(viewport.name), `duplicate viewport name "${viewport.name}".`);
    viewportNames.add(viewport.name);
    for (const dimension of ["width", "height"]) {
      assert(Number.isInteger(viewport[dimension]) && viewport[dimension] >= 1 && viewport[dimension] <= 4096,
        `viewport "${viewport.name}" ${dimension} must be an integer from 1 to 4096.`);
    }
  }

  for (const [index, step] of scenario.steps.entries()) {
    assert(step && typeof step === "object" && !Array.isArray(step), `steps[${index}] must be an object.`);
    assert(typeof step.command === "string" && step.command.trim(), `steps[${index}] needs a command name.`);
    assert(step.payload === undefined || isJsonValue(step.payload), `steps[${index}] payload must be JSON-compatible.`);
    assert(step.expect === undefined || isJsonObject(step.expect), `steps[${index}] expect must be an object.`);
    if (step.snapshot !== undefined) {
      assert(typeof step.snapshot === "string" && step.snapshot.trim(), `steps[${index}] snapshot must be a non-empty string.`);
    }
  }
  return scenario;
}

function validateConfig(config) {
  assert(config && typeof config === "object" && !Array.isArray(config), "harness.config.json must contain an object.");
  assert(config.version === 1, "harness.config.json version must be 1.");
  assert(config.app && typeof config.app === "object", "harness.config.json needs an app object.");
  assert(Array.isArray(config.app.start) && config.app.start.length > 0 &&
    config.app.start.every((part) => typeof part === "string" && part.length > 0),
  "app.start must be a non-empty array of command arguments.");
  assert(typeof config.app.url === "string", "app.url must be a URL string.");
  const appUrl = new URL(config.app.url);
  assert(["http:", "https:"].includes(appUrl.protocol), "app.url must use HTTP or HTTPS.");
  assert(["localhost", "127.0.0.1", "[::1]"].includes(appUrl.hostname),
    "local runner app.url must use localhost or a loopback IP address.");
  assert(Number.isInteger(config.app.startupTimeoutMs ?? 15000) &&
    (config.app.startupTimeoutMs ?? 15000) >= 1000 &&
    (config.app.startupTimeoutMs ?? 15000) <= 120000,
  "app.startupTimeoutMs must be between 1000 and 120000.");
  const inheritEnv = config.app.inheritEnv ?? [];
  assert(Array.isArray(inheritEnv) && inheritEnv.every((name) =>
    typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].includes(name)),
  "app.inheritEnv must contain valid variable names and may not override runtime injection variables.");
  assert(new Set(inheritEnv).size === inheritEnv.length, "app.inheritEnv may not contain duplicate names.");
  return {
    ...config,
    app: {
      ...config.app,
      url: appUrl.href,
      startupTimeoutMs: config.app.startupTimeoutMs ?? 15000,
      inheritEnv,
    },
  };
}

function isJsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object") return false;

  const active = new Set();
  function visit(item) {
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (!item || typeof item !== "object" || active.has(item)) return false;
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) return false;
    active.add(item);
    const values = Array.isArray(item) ? item : Object.values(item);
    const valid = values.every(visit);
    active.delete(item);
    return valid;
  }
  return visit(value);
}

function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && isJsonValue(value);
}

function matchesExpected(actual, expected, location = "state") {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
      return `${location} expected an object, received ${JSON.stringify(actual)}.`;
    }
    for (const [key, value] of Object.entries(expected)) {
      const error = matchesExpected(actual[key], value, `${location}.${key}`);
      if (error) return error;
    }
    return null;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(expected)) {
      return `${location} expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`;
    }
    return null;
  }
  if (!Object.is(actual, expected)) {
    return `${location} expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`;
  }
  return null;
}

function safeSlug(value) {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug.slice(0, 64) || "snapshot";
}

async function loadJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`could not read ${label} "${filePath}": ${error.message}`);
  }
}

async function loadScenario(filePath) {
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`could not read scenario "${filePath}": ${error.message}`);
  }
  let scenario;
  try {
    scenario = yaml.load(contents, { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    throw new Error(`invalid scenario YAML "${filePath}": ${error.message}`);
  }
  return validateScenario(scenario, filePath);
}

async function waitForApp(url, timeoutMs, child, logPath) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`app process exited with code ${child.exitCode}; see ${logPath}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await delay(250);
  }
  throw new Error(`app did not become ready at ${url} within ${timeoutMs}ms (${lastError}); see ${logPath}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const didExit = await Promise.race([
    exited.then(() => true),
    delay(3000).then(() => false),
  ]);
  if (!didExit && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

function serializeHarnessState(state, label) {
  let serialized;
  try {
    serialized = JSON.stringify(state);
  } catch (error) {
    throw new Error(`${label} is not JSON-serializable: ${error.message}`);
  }
  if (typeof serialized !== "string") throw new Error(`${label} did not return a JSON value.`);
  return JSON.parse(serialized);
}

function getAppEnvironment(config) {
  const environment = {};
  for (const name of [...SAFE_INHERITED_ENV, ...config.app.inheritEnv]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

async function installEventCapture(page) {
  await page.evaluate(() => {
    window.__harnessRunEvents = [];
    for (const eventName of ["statechange", "animationend", "error"]) {
      window.__harness.on(eventName, (event) => {
        let detail;
        try {
          detail = JSON.parse(JSON.stringify(event.detail ?? null));
        } catch (error) {
          detail = { serializationError: error.message };
        }
        window.__harnessRunEvents.push({ event: eventName, detail, at: window.__harness.clock.now() });
      });
    }
  });
}

async function getCapturedEvents(page) {
  return page.evaluate(() => {
    const events = window.__harnessRunEvents || [];
    window.__harnessRunEvents = [];
    return events;
  });
}

async function createContactSheet(browser, capturePaths, runDirectory) {
  const cardData = await Promise.all(capturePaths.map(async (capture) => ({
    label: `${capture.viewport} · ${capture.snapshot}`,
    data: (await readFile(path.join(runDirectory, capture.path))).toString("base64"),
  })));
  const columns = Math.min(2, Math.max(1, cardData.length));
  const width = columns * 560;
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  const cards = cardData.map(({ label, data }) => (
    `<article><h2>${escapeHtml(label)}</h2><img src="data:image/png;base64,${data}" alt="${escapeHtml(label)}"></article>`
  )).join("");
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;padding:16px;background:#edf1f7;color:#172033;font:14px/1.4 system-ui,sans-serif}
    main{display:grid;grid-template-columns:repeat(${columns},minmax(0,1fr));gap:16px}
    article{min-width:0;padding:12px;border:1px solid #dfe5ee;border-radius:12px;background:white}
    h2{margin:0 0 8px;font-size:14px}img{display:block;width:100%;height:auto;border:1px solid #e6e9ef}
  </style><main>${cards}</main>`);
  await page.locator("img").evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
  await page.locator("main").screenshot({ path: path.join(runDirectory, "contact-sheet.png"), fullPage: true });
  await page.close();
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

async function compareWithLastGreen(root, scenarioName) {
  const pointerPath = path.join(root, "artifacts", "last-green.json");
  try {
    const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
    const resultPath = path.resolve(root, pointer.result);
    const relativeResultPath = path.relative(root, resultPath);
    assert(!relativeResultPath.startsWith(`..${path.sep}`) && relativeResultPath !== "..",
      "last-green result path must stay inside the project root.");
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    return {
      runId: pointer.runId,
      scenario: pointer.scenario,
      result: pointer.result,
      sameScenario: pointer.scenario === scenarioName,
      status: result.status,
      durationMs: result.durationMs,
      counts: result.counts,
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`could not read last-green run pointer "${pointerPath}": ${error.message}`);
  }
}

async function writeLastGreen(root, runId, scenarioName, resultPath) {
  const artifactsDirectory = path.join(root, "artifacts");
  const temporaryPath = path.join(artifactsDirectory, `.last-green-${runId}.tmp`);
  const pointerPath = path.join(artifactsDirectory, "last-green.json");
  await writeFile(temporaryPath, `${JSON.stringify({ runId, scenario: scenarioName, result: resultPath }, null, 2)}\n`);
  await rename(temporaryPath, pointerPath);
}

async function writeLastRun(root, runId, scenarioName, resultPath, status) {
  const artifactsDirectory = path.join(root, "artifacts");
  const temporaryPath = path.join(artifactsDirectory, `.last-run-${runId}.tmp`);
  const pointerPath = path.join(artifactsDirectory, "last-run.json");
  await writeFile(temporaryPath, `${JSON.stringify({ runId, scenario: scenarioName, result: resultPath, status }, null, 2)}\n`);
  await rename(temporaryPath, pointerPath);
}

async function executeViewport({ browser, config, scenario, viewport, root, runDirectory, log, captures }) {
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(`console error: ${message.text()}`);
  });

  const viewportResult = {
    name: viewport.name,
    width: viewport.width,
    height: viewport.height,
    status: "passed",
    steps: [],
    errors: [],
  };
  try {
    const appUrl = new URL(config.app.url);
    appUrl.searchParams.set("harness", "1");
    await page.goto(appUrl.href, { waitUntil: "networkidle", timeout: 30000 });
    const contract = await page.evaluate(() => {
      if (!window.__harness) throw new Error("App did not expose window.__harness after ?harness=1.");
      if (window.__harness.version !== 1) throw new Error(`Unsupported control contract version ${window.__harness.version}.`);
      if (typeof window.__harness.state !== "function" ||
          typeof window.__harness.commands !== "function" ||
          typeof window.__harness.command !== "function" ||
          typeof window.__harness.on !== "function" ||
          typeof window.__harness.off !== "function") {
        throw new Error("Harness control API does not satisfy the required methods.");
      }
      const clockMethods = ["pause", "resume", "advance", "seek", "now"];
      if (!window.__harness.clock ||
          clockMethods.some((method) => typeof window.__harness.clock[method] !== "function")) {
        throw new Error("Harness control API has an incomplete clock.");
      }
      const commands = window.__harness.commands();
      if (!Array.isArray(commands)) throw new Error("commands() must return an array.");
      const state = window.__harness.state();
      const encodedState = JSON.stringify(state);
      if (typeof encodedState !== "string") throw new Error("state() must return a JSON value.");
      return { commands, state: JSON.parse(encodedState) };
    });
    const commandMap = new Map();
    for (const [index, descriptor] of contract.commands.entries()) {
      assert(descriptor && typeof descriptor.name === "string" && descriptor.name.trim(),
        `commands()[${index}] needs a name.`);
      assert(!commandMap.has(descriptor.name), `commands() contains duplicate "${descriptor.name}".`);
      if (descriptor.payloadSchema !== undefined) {
        try {
          commandMap.set(descriptor.name, {
            descriptor,
            validate: JSON_SCHEMA_VALIDATOR.compile(descriptor.payloadSchema),
          });
        } catch (error) {
          throw new Error(`Invalid payload schema for command "${descriptor.name}": ${error.message}`);
        }
      } else {
        commandMap.set(descriptor.name, { descriptor, validate: null });
      }
    }

    await installEventCapture(page);
    await page.evaluate(() => window.__harness.clock.pause());
    await log({
      at: new Date().toISOString(),
      viewport: viewport.name,
      phase: "initial",
      state: contract.state,
      commands: contract.commands.map(({ name }) => name),
    });

    for (const [stepIndex, step] of scenario.steps.entries()) {
      const stepResult = { index: stepIndex, name: step.name || step.command, command: step.command, status: "passed" };
      try {
        const command = commandMap.get(step.command);
        if (!command) {
          const names = Array.from(commandMap.keys());
          throw new Error(`Unknown command "${step.command}". Available commands: ${names.join(", ") || "(none)"}.`);
        }
        if (command.validate) {
          const payload = step.payload === undefined ? null : step.payload;
          if (!command.validate(payload)) {
            throw new Error(`Invalid payload for "${step.command}": ${JSON.stringify(command.validate.errors)}`);
          }
        } else if (step.payload !== undefined) {
          throw new Error(`Command "${step.command}" does not advertise a payload schema; scenario payload is not allowed.`);
        }

        const before = serializeHarnessState(await page.evaluate(() => window.__harness.state()), "state()");
        const commandResult = await page.evaluate(
          async ({ name, payload }) => window.__harness.command(name, payload),
          { name: step.command, payload: step.payload },
        );
        if (!commandResult || typeof commandResult.ok !== "boolean") {
          throw new Error(`Command "${step.command}" must return an { ok } result.`);
        }
        if (!commandResult.ok) {
          throw new Error(`Command "${step.command}" failed: ${commandResult.error?.code || "error"}: ${commandResult.error?.message || "no message"}`);
        }
        const after = serializeHarnessState(await page.evaluate(() => window.__harness.state()), "state()");
        stepResult.before = before;
        stepResult.after = after;
        stepResult.commandResult = serializeHarnessState(commandResult, `result of "${step.command}"`);
        await log({
          at: new Date().toISOString(),
          viewport: viewport.name,
          phase: "command",
          step: stepIndex,
          command: step.command,
          before,
          after,
          result: stepResult.commandResult,
        });

        stepResult.events = await getCapturedEvents(page);

        if (step.snapshot) {
          const captureName = `${safeSlug(viewport.name)}-${String(stepIndex + 1).padStart(2, "0")}-${safeSlug(step.snapshot)}.png`;
          const capturePath = path.join(runDirectory, "screenshots", captureName);
          await page.screenshot({ path: capturePath, fullPage: true, animations: "disabled" });
          const relativeCapturePath = path.relative(runDirectory, capturePath);
          captures.push({ viewport: viewport.name, snapshot: step.snapshot, path: relativeCapturePath });
          stepResult.screenshot = relativeCapturePath;
        }
        if (step.expect) {
          const mismatch = matchesExpected(after, step.expect);
          if (mismatch) throw new Error(`Expectation failed: ${mismatch}`);
        }
      } catch (error) {
        stepResult.status = "failed";
        stepResult.error = error.message;
        viewportResult.status = "failed";
        viewportResult.errors.push(`step ${stepIndex + 1} "${stepResult.name}": ${error.message}`);
        stepResult.events = await getCapturedEvents(page).catch(() => []);
      }
      viewportResult.steps.push(stepResult);
      await log({
        at: new Date().toISOString(),
        viewport: viewport.name,
        phase: "step-complete",
        step: stepIndex,
        status: stepResult.status,
        ...(stepResult.error ? { error: stepResult.error } : {}),
        events: stepResult.events,
      });
    }
    if (pageErrors.length) {
      viewportResult.status = "failed";
      viewportResult.errors.push(...pageErrors);
    }
  } catch (error) {
    viewportResult.status = "failed";
    viewportResult.errors.push(error.message);
  } finally {
    await page.close();
  }
  return viewportResult;
}

async function runScenario({ root, scenarioPath, scenario, config }) {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const runDirectory = path.join(root, "artifacts", runId);
  await mkdir(path.join(runDirectory, "screenshots"), { recursive: true });
  const previousGreen = await compareWithLastGreen(root, scenario.name);
  const stateLogPath = path.join(runDirectory, "state.jsonl");
  const stateLog = createWriteStream(stateLogPath, { flags: "a" });
  const log = (entry) => new Promise((resolve, reject) => {
    stateLog.write(`${JSON.stringify(entry)}\n`, (error) => error ? reject(error) : resolve());
  });
  const captures = [];
  const result = {
    version: 1,
    runId,
    scenario: { name: scenario.name, path: path.relative(root, scenarioPath) },
    startedAt: new Date().toISOString(),
    status: "running",
    comparison: { lastGreen: previousGreen },
    viewports: [],
    artifacts: {
      stateLog: "state.jsonl",
      appLog: "app.log",
      screenshots: [],
      contactSheet: null,
    },
  };

  let child;
  let browser;
  const appLogPath = path.join(runDirectory, "app.log");
  const appLog = createWriteStream(appLogPath);
  try {
    const command = config.app.start[0];
    const args = config.app.start.slice(1);
    console.log(`Starting app: ${[command, ...args].join(" ")}`);
    child = spawn(command, args, {
      cwd: root,
      env: getAppEnvironment(config),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    child.stdout.pipe(appLog, { end: false });
    child.stderr.pipe(appLog, { end: false });
    await waitForApp(config.app.url, config.app.startupTimeoutMs, child, path.relative(root, appLogPath));

    if (!existsSync(chromium.executablePath())) throw new Error(INSTALL_BROWSER_MESSAGE);
    browser = await chromium.launch({ headless: true });
    for (const viewport of scenario.viewports) {
      const viewportResult = await executeViewport({
        browser, config, scenario, viewport, root, runDirectory, log, captures,
      });
      result.viewports.push(viewportResult);
    }

    result.artifacts.screenshots = captures.map((capture) => capture.path);
    if (captures.length) {
      await createContactSheet(browser, captures, runDirectory);
      result.artifacts.contactSheet = "contact-sheet.png";
    }
    result.status = result.viewports.every((viewport) => viewport.status === "passed") ? "passed" : "failed";
  } catch (error) {
    result.status = "failed";
    result.error = error.message;
  } finally {
    if (browser) await browser.close();
    if (child) await stopChild(child);
    await new Promise((resolve, reject) => {
      appLog.end((error) => error ? reject(error) : resolve());
    });
    await new Promise((resolve, reject) => {
      stateLog.end((error) => error ? reject(error) : resolve());
    });
  }

  result.finishedAt = new Date().toISOString();
  result.durationMs = Date.parse(result.finishedAt) - Date.parse(result.startedAt);
  result.counts = {
    viewports: result.viewports.length,
    steps: result.viewports.reduce((total, viewport) => total + viewport.steps.length, 0),
    failures: result.viewports.reduce((total, viewport) => total + viewport.errors.length, 0) +
      (result.error ? 1 : 0),
    screenshots: result.artifacts.screenshots.length,
  };
  await writeFile(path.join(runDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  const resultPath = path.relative(root, path.join(runDirectory, "result.json"));
  await writeLastRun(root, runId, scenario.name, resultPath, result.status);
  if (result.status === "passed") {
    await writeLastGreen(root, runId, scenario.name, resultPath);
  }
  console.log(`Scenario ${scenario.name}: ${result.status} (${result.counts.steps} steps, ${result.counts.failures} failures)`);
  console.log(`Artifacts: ${path.relative(root, runDirectory)}`);
  if (result.artifacts.contactSheet) console.log(`Contact sheet: ${path.relative(root, path.join(runDirectory, result.artifacts.contactSheet))}`);
  if (result.status !== "passed") process.exitCode = 1;
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("Usage: npm run harness -- run <scenario.yaml> [--root path] [--dry-run]");
    console.log("Runs a local app scenario through its opt-in window.__harness API.");
    return null;
  }
  const root = path.resolve(options.root || process.cwd());
  const configPath = path.join(root, "harness.config.json");
  const scenarioPath = path.resolve(root, options.scenario);
  const relativeScenario = path.relative(root, scenarioPath);
  assert(relativeScenario && !relativeScenario.startsWith(`..${path.sep}`) && relativeScenario !== "..",
    "scenario must be inside the project root.");
  const config = validateConfig(await loadJson(configPath, "harness config"));
  const scenario = await loadScenario(scenarioPath);

  if (options.dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      scenario: scenario.name,
      app: { start: config.app.start, url: config.app.url, startupTimeoutMs: config.app.startupTimeoutMs },
      inheritedEnvironmentNames: [...new Set([...SAFE_INHERITED_ENV, ...config.app.inheritEnv])],
      viewports: scenario.viewports,
      steps: scenario.steps.map(({ name, command, payload, expect, snapshot }) => ({
        name: name || command,
        command,
        ...(payload === undefined ? {} : { payload }),
        ...(expect === undefined ? {} : { expect }),
        ...(snapshot === undefined ? {} : { snapshot }),
      })),
    }, null, 2));
    return null;
  }

  return runScenario({ root, scenarioPath, scenario, config });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export {
  isJsonValue,
  matchesExpected,
  parseArgs,
  runScenario,
  validateConfig,
  validateScenario,
};
